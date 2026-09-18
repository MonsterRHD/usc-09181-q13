// 投产前核对脚本：在临时数据目录自启服务，逐项核对验收清单，全部通过才退出码 0。
// 覆盖：并发编辑、撤销额度、回放极端汇率、缺口/版本/权限核对、发布后修改形成新版本、恢复。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootApp } from '../test/helpers.mjs';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'preprod-'));
const ctx = await bootApp({ dataDir: dir });
const { call, app } = ctx;

try {
  // 基线情景：CN/USD 与 DE/EUR 两个资金桶
  const created = await call('POST', '/scenarios', {
    body: { name: '投产核对基线', baseDate: '2026-09-21', reportingCurrency: 'USD', horizonDays: 14 },
  });
  const sid = created.body.scenario.id;
  await call('PUT', `/scenarios/${sid}/versions/1/inputs`, {
    body: {
      expectedRevision: 0,
      patch: {
        balances: [
          { country: 'CN', currency: 'USD', account: 'cn-1', amount: 100 },
          { country: 'DE', currency: 'EUR', account: 'de-1', amount: 60 },
        ],
        debts: [
          { country: 'CN', currency: 'USD', amount: 150, dueDate: '2026-09-23' },
          { country: 'DE', currency: 'EUR', amount: 90, dueDate: '2026-09-24' },
        ],
        facilities: [
          { id: 'fac-cn', country: 'CN', currency: 'USD', limit: 100, start: '2026-09-21', end: '2026-10-04' },
          { id: 'fac-de', country: 'DE', currency: 'EUR', limit: 40, start: '2026-09-21', end: '2026-10-04' },
        ],
        fxRates: [{ currency: 'EUR', date: '2026-09-21', rate: 1.1 }],
      },
    },
  });

  // 1) 并发编辑同一情景：同一 revision 两路提交，必须一成一败
  const edit = () =>
    call('PUT', `/scenarios/${sid}/versions/1/inputs`, {
      body: { expectedRevision: 1, patch: { balances: [{ country: 'CN', currency: 'USD', amount: 100 }] } },
    });
  const [r1, r2] = await Promise.all([edit(), edit()]);
  check('并发编辑同一情景有且只有一个成功', [r1.status, r2.status].sort().join(',') === '200,409');

  // 2) 权限：analyst 发布被拒；publisher 经审批后发布成功
  const denyPublish = await call('POST', `/scenarios/${sid}/versions/1/publish`, { role: 'analyst' });
  check('非授权角色(analyst)发布被拒 403', denyPublish.status === 403);
  const noApproval = await call('POST', `/scenarios/${sid}/versions/1/publish`, { role: 'publisher' });
  check('未审批发布被拒 409', noApproval.status === 409);
  await call('POST', `/scenarios/${sid}/versions/1/approve`, { role: 'approver', body: { decision: 'approved' } });
  const published = await call('POST', `/scenarios/${sid}/versions/1/publish`, { role: 'publisher' });
  check('审批后授权角色(publisher)发布成功', published.status === 200);

  // 3) 发布后修改必须形成新版本
  const fork = await call('PUT', `/scenarios/${sid}/versions/1/inputs`, {
    body: {
      expectedRevision: 2,
      patch: {
        shocks: {
          fx: [{ currency: 'EUR', fromDate: '2026-09-25', pct: 0.2 }],
          revokedFacilities: ['fac-cn'],
          frozenAccounts: [],
          financingClosed: [],
        },
      },
    },
  });
  check('发布后修改自动分叉新版本 v2', fork.status === 201 && fork.body.version.versionNo === 2);
  const v1 = await call('GET', `/scenarios/${sid}/versions/1`, { role: 'viewer' });
  check('已发布基线 v1 未被污染', v1.body.version.state === 'published' && v1.body.version.inputs.shocks.revokedFacilities.length === 0);

  // 4) 撤销额度 + 回放极端汇率：核对缺口
  await call('POST', `/scenarios/${sid}/versions/2/approve`, { role: 'approver', body: { decision: 'approved' } });
  await call('POST', `/scenarios/${sid}/versions/2/publish`, { role: 'publisher' });
  await call('POST', `/scenarios/${sid}/versions/2/runs`, { body: {} });
  app.jobs.drain();
  const result = await call('GET', `/scenarios/${sid}/versions/2/result`, { role: 'viewer' });
  const cells = result.body.result.cells;
  const cn23 = cells.find((c) => c.country === 'CN' && c.date === '2026-09-23');
  check('撤销 fac-cn 后 09-23 缺口暴露 50', cn23.gap === 50 && cn23.facilityAvailable === 0, `gap=${cn23.gap}`);
  const de25 = cells.find((c) => c.country === 'DE' && c.date === '2026-09-25');
  const eurShocked = Math.abs(de25.fxRate - 1.32) < 1e-9; // 1.1 * 1.2
  check('极端汇率回放自 09-25 生效 (EUR 1.1→1.32)', eurShocked, `fx=${de25.fxRate}`);
  const de24 = cells.find((c) => c.country === 'DE' && c.date === '2026-09-24');
  check('跳变前日期汇率不受影响 (1.1)', de24.fxRate === 1.1);
  check('结果格带追溯信息', cn23.lineage.inputs.length > 0 && typeof cn23.lineage.formulas.gap === 'string');

  // 5) 导出版本标注
  const exported = await call('POST', `/scenarios/${sid}/versions/2/exports`, { body: { type: 'committee-pack' } });
  check('导出标注采用版本 v2', /v2/.test(exported.body.export.label), exported.body.export.label);

  // 6) 恢复：重启后已发布报告与未完成计算可恢复
  await call('POST', `/scenarios/${sid}/versions/2/runs`, { body: {} }); // 不 drain，留一个未完成
  await ctx.close({ cleanup: false });
  const ctx2 = await bootApp({ dataDir: dir });
  const health = await ctx2.call('GET', '/health', { role: 'viewer' });
  const v2After = await ctx2.call('GET', `/scenarios/${sid}/versions/2`, { role: 'viewer' });
  ctx2.app.jobs.drain();
  const runs = Object.values(ctx2.app.store.data.runs);
  check('重启后已发布版本可恢复', v2After.body.version.state === 'published');
  check('重启后未完成计算恢复并完成', runs.every((r) => r.status === 'completed'), `health.resumedRuns=${health.body.resumedRuns}`);
  await ctx2.close({ cleanup: false });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项核对通过`);
process.exit(failed.length === 0 ? 0 : 1);
