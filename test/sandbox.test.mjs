// 验收测试：覆盖委员会投产前核对清单 ——
// 缺口计算、汇率跳变/账户冻结/融资窗口关闭、跨日滚动、部分数据缺失、
// 情景复制与基线保护、并发编辑、撤销额度、版本与权限、提醒与导出版本标注、崩溃恢复。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { recoverStore } from '../src/domain.mjs';
import { createApp } from '../src/app.mjs';

const START = '2026-09-18'; // 与业务当天一致，horizon 14 天 → 2026-09-18 ~ 2026-10-01

async function boot(dir) {
  const dataDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-'));
  const store = Store.load(dataDir);
  const recovery = recoverStore(store);
  const server = createServer(createApp(store));
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  return {
    dir: dataDir,
    store,
    recovery,
    server,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function api(base, method, p, { body, role = 'admin', user = 'tester' } = {}) {
  const headers = {};
  if (user) headers['x-user-id'] = user;
  if (role) headers['x-role'] = role;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

// 标准基线数据：CN/CNY 100万；US/USD 20万；HK/USD 5万；
// 债务：CNY 30万@09-20、USD 40万@09-21、USD 10万@09-23；
// 额度：CNY 50万（09-28 到期）、USD 10万已用 2万（09-23 到期）；
// 汇率：USD→CNY 09-17=7.10、09-19=7.20（其余日期检验跨日滚动）。
async function seed(base) {
  const bal = await api(base, 'POST', '/api/datasets/balances', {
    body: { rows: [
      { country: 'CN', currency: 'CNY', amount: 1000000, asOfDate: START },
      { country: 'US', currency: 'USD', amount: 200000, asOfDate: START },
      { country: 'HK', currency: 'USD', amount: 50000, asOfDate: START },
    ] },
  });
  const debts = await api(base, 'POST', '/api/datasets/debts', {
    body: { rows: [
      { country: 'CN', currency: 'CNY', amount: 300000, maturityDate: '2026-09-20' },
      { country: 'US', currency: 'USD', amount: 400000, maturityDate: '2026-09-21' },
      { country: 'US', currency: 'USD', amount: 100000, maturityDate: '2026-09-23' },
    ] },
  });
  const lines = await api(base, 'POST', '/api/datasets/credit-lines', {
    body: { rows: [
      { country: 'CN', currency: 'CNY', limit: 500000, drawn: 0, expiryDate: '2026-09-28' },
      { country: 'US', currency: 'USD', limit: 100000, drawn: 20000, expiryDate: '2026-09-23' },
    ] },
  });
  const fx = await api(base, 'POST', '/api/datasets/fx', {
    body: { rows: [
      { base: 'CNY', quote: 'USD', date: '2026-09-17', rate: 7.1 },
      { base: 'CNY', quote: 'USD', date: '2026-09-19', rate: 7.2 },
    ] },
  });
  for (const [name, r] of Object.entries({ bal, debts, lines, fx })) {
    assert.equal(r.status, 200, `导入 ${name} 失败：${JSON.stringify(r.data)}`);
    assert.equal(r.data.rejected.length, 0, `导入 ${name} 存在拒绝行`);
  }
  return {
    balances: bal.data.imported,
    debts: debts.data.imported,
    lines: lines.data.imported,
    fx: fx.data.imported,
  };
}

async function makeScenario(base, adjustments = [], extra = {}) {
  const r = await api(base, 'POST', '/api/scenarios', {
    body: { name: '两周压力沙盘', baseCurrency: 'CNY', startDate: START, horizonDays: 14, adjustments, ...extra },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

async function calculate(base, scId, versionNo = 1) {
  const r = await api(base, 'POST', `/api/scenarios/${scId}/versions/${versionNo}/calculate`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.job.status, 'done');
  return r.data;
}

async function getResult(base, scId, versionNo = 1, query = '') {
  const r = await api(base, 'GET', `/api/scenarios/${scId}/versions/${versionNo}/result${query}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

const lineAt = (result, date, country, currency) =>
  result.days.find((d) => d.date === date)?.lines.find((l) => l.country === country && l.currency === currency);
const dayAt = (result, date) => result.days.find((d) => d.date === date);

async function withApp(fn) {
  const ctx = await boot();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- 基础计算

test('基线计算：逐日缺口、跨日汇率滚动、合计均正确', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base);
    await calculate(base, sc.id);
    const result = await getResult(base, sc.id);

    assert.equal(result.days.length, 14);
    assert.equal(result.params.baseCurrency, 'CNY');

    // 汇率：09-18 向前滚动沿用 09-17 的 7.10；09-19 精确命中 7.20；09-20 起滚动沿用 7.20
    const d0us = lineAt(result, '2026-09-18', 'US', 'USD');
    assert.equal(d0us.fxRate, 7.1);
    assert.equal(d0us.fxSource, 'rolled-forward');
    assert.equal(d0us.fxRolledFrom, '2026-09-17');
    assert.equal(lineAt(result, '2026-09-19', 'US', 'USD').fxSource, 'exact');
    const d2us = lineAt(result, '2026-09-20', 'US', 'USD');
    assert.equal(d2us.fxRate, 7.2);
    assert.equal(d2us.fxSource, 'rolled-forward');
    assert.equal(d2us.fxRolledFrom, '2026-09-19');

    // 跨日滚动：头寸逐日结转
    const d3us = lineAt(result, '2026-09-21', 'US', 'USD');
    assert.equal(d3us.opening, 200000);
    assert.equal(d3us.debtOut, 400000);
    assert.equal(d3us.closing, -200000);
    assert.equal(d3us.shortfall, 200000);
    assert.equal(d3us.creditAvailable, 80000); // 10万额度 - 已用2万，09-23 才到期
    assert.equal(d3us.fundingGap, 120000);
    assert.equal(d3us.fundingGapBase, 864000); // 12万 × 7.2

    // 09-23 第二笔债务到期后累计头寸 -30万；09-24 额度到期，缺口全额暴露
    assert.equal(lineAt(result, '2026-09-23', 'US', 'USD').fundingGap, 220000);
    const d6us = lineAt(result, '2026-09-24', 'US', 'USD');
    assert.equal(d6us.creditAvailable, 0);
    assert.equal(d6us.fundingGap, 300000);
    assert.equal(d6us.fundingGapBase, 2160000);

    // CNY 一侧无缺口；首日基准币合计
    assert.equal(lineAt(result, '2026-09-20', 'CN', 'CNY').closing, 700000);
    assert.equal(dayAt(result, '2026-09-18').totals.closingBase, 2775000); // 100万 + 20万×7.1 + 5万×7.1
    assert.equal(dayAt(result, '2026-09-21').totals.fundingGapBase, 864000);
    assert.equal(dayAt(result, '2026-09-24').totals.fundingGapBase, 2160000);

    assert.deepEqual(result.summary.maxFundingGapBase, { date: '2026-09-24', amount: 2160000 });
    assert.equal(result.summary.firstFundingGapDate, '2026-09-21');
  });
});

test('结果可追溯：每行都能追到输入记录、汇率来源与公式', async () => {
  await withApp(async ({ base }) => {
    const data = await seed(base);
    const sc = await makeScenario(base);
    await calculate(base, sc.id);
    const result = await getResult(base, sc.id);

    const line = lineAt(result, '2026-09-21', 'US', 'USD');
    assert.deepEqual(line.trace.debtIds, [data.debts[1].id]);
    assert.deepEqual(line.trace.creditLineIds, [data.lines[1].id]);
    assert.deepEqual(line.trace.balanceIds, [data.balances[1].id]);
    assert.equal(line.trace.fxId, data.fx[1].id);
    assert.ok(line.trace.formula.includes('fundingGap'));

    assert.ok(result.formulas.length >= 5);
    // 输入快照：即使数据集之后被修改，结果引用的输入仍可回放
    assert.equal(result.inputSnapshot.balances.length, 3);
    assert.equal(result.inputSnapshot.debts.length, 3);
    assert.equal(result.inputSnapshot.creditLines.length, 2);
    assert.equal(result.inputSnapshot.fx.length, 2);
  });
});

// ---------------------------------------------------------------- 压力假设

test('汇率跳变（冲击 + 覆盖）改变折算结果并留痕', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base, [
      { type: 'fx-shock', currency: 'USD', pct: 0.1 },
      { type: 'fx-override', currency: 'USD', date: '2026-09-20', rate: 8.0 },
    ]);
    await calculate(base, sc.id);
    const result = await getResult(base, sc.id);

    assert.equal(lineAt(result, '2026-09-19', 'US', 'USD').fxRate, 7.92); // 7.2 × 1.1
    const overridden = lineAt(result, '2026-09-20', 'US', 'USD');
    assert.equal(overridden.fxRate, 8.0); // 覆盖优先于冲击
    assert.equal(overridden.fxSource, 'override');
    assert.ok(overridden.trace.adjustmentIds.length >= 1);
  });
});

test('海外账户冻结：冻结余额不计入可用头寸', async () => {
  await withApp(async ({ base }) => {
    const data = await seed(base);
    const sc = await makeScenario(base, [{ type: 'freeze-account', accountId: data.balances[2].id }]);
    await calculate(base, sc.id);
    const result = await getResult(base, sc.id);

    const hk = lineAt(result, '2026-09-18', 'HK', 'USD');
    assert.equal(hk.opening, 0);
    assert.deepEqual(hk.trace.frozenBalanceIds, [data.balances[2].id]);
    // 首日合计只剩 CN + US
    assert.equal(dayAt(result, '2026-09-18').totals.closingBase, 2420000); // 100万 + 20万×7.1
  });
});

test('融资窗口关闭：情景内撤销额度后缺口全额暴露', async () => {
  await withApp(async ({ base }) => {
    const data = await seed(base);
    const sc = await makeScenario(base, [{ type: 'revoke-credit-line', creditLineId: data.lines[1].id }]);
    await calculate(base, sc.id);
    const result = await getResult(base, sc.id);

    const d3us = lineAt(result, '2026-09-21', 'US', 'USD');
    assert.equal(d3us.creditAvailable, 0);
    assert.equal(d3us.fundingGap, 200000);
    assert.ok(d3us.trace.creditNotes.some((n) => n.id === data.lines[1].id && n.status === 'revoked'));
  });
});

test('部分数据缺失：缺汇率币种单列示警，不污染合计也不中断计算', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    await api(base, 'POST', '/api/datasets/balances', {
      body: { rows: [{ country: 'DE', currency: 'EUR', amount: 100000, asOfDate: START }] },
    });
    const sc = await makeScenario(base);
    await calculate(base, sc.id);
    const result = await getResult(base, sc.id);

    assert.ok(result.warnings.some((w) => w.type === 'fx-missing' && w.currency === 'EUR'));
    const eur = lineAt(result, '2026-09-18', 'DE', 'EUR');
    assert.equal(eur.fxRate, null);
    assert.equal(eur.fxSource, 'missing');
    assert.equal(eur.closingBase, null);
    // 合计与无 EUR 时完全一致，缺失币种在 unconverted 中单列
    assert.equal(dayAt(result, '2026-09-18').totals.closingBase, 2775000);
    assert.deepEqual(dayAt(result, '2026-09-18').totals.unconverted, [
      { country: 'DE', currency: 'EUR', closing: 100000, fundingGap: 0 },
    ]);
  });
});

test('导入容错：无效行进入 rejected，有效行正常入库', async () => {
  await withApp(async ({ base }) => {
    const r = await api(base, 'POST', '/api/datasets/balances', {
      body: { rows: [
        { country: 'CN', currency: 'CNY', amount: 100 },
        { country: 'CN', currency: 'CN', amount: 5 }, // 非法币种
        { country: 'US', currency: 'USD', amount: 'abc' }, // 非法金额
      ] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.imported.length, 1);
    assert.equal(r.data.rejected.length, 2);
    assert.match(r.data.rejected[0].reason, /币种/);
  });
});

// ---------------------------------------------------------------- 版本与基线保护

test('发布后修改必须形成新版本，原基线不可破坏', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base);
    await calculate(base, sc.id);
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'approver', user: 'appr1', body: {} });
    const pub = await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'publisher', user: 'pub1' });
    assert.equal(pub.status, 200);
    assert.equal(pub.data.state, 'published');

    // 直接改已发布版本 → 409，并提示派生新版本
    const blocked = await api(base, 'PUT', `/api/scenarios/${sc.id}/versions/1/params`, {
      body: { baseRevision: pub.data.revision, horizonDays: 7 },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.reason, 'version-immutable');

    // 派生 v2 草稿并修改
    const v2 = await api(base, 'POST', `/api/scenarios/${sc.id}/versions`, { body: {} });
    assert.equal(v2.status, 201);
    assert.equal(v2.data.versionNo, 2);
    assert.equal(v2.data.state, 'draft');
    const edited = await api(base, 'PUT', `/api/scenarios/${sc.id}/versions/2/params`, {
      body: { baseRevision: 0, horizonDays: 7 },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.revision, 1);

    // v1 结果保持 14 天 horizon 与原始数字
    const v1 = await getResult(base, sc.id, 1);
    assert.equal(v1.days.length, 14);
    assert.equal(dayAt(v1, '2026-09-21').totals.fundingGapBase, 864000);

    // 已有草稿时不允许再开新草稿
    const dup = await api(base, 'POST', `/api/scenarios/${sc.id}/versions`, { body: {} });
    assert.equal(dup.status, 409);
  });
});

test('情景复制不破坏原情景，副本可独立修订', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base, [{ type: 'fx-shock', currency: 'USD', pct: 0.2 }]);
    await calculate(base, sc.id);
    const before = (await api(base, 'GET', `/api/scenarios/${sc.id}`)).data;

    const copy = await api(base, 'POST', `/api/scenarios/${sc.id}/copy`, { body: {} });
    assert.equal(copy.status, 201);
    assert.notEqual(copy.data.id, sc.id);
    assert.equal(copy.data.versions[0].adjustmentCount, 1);
    assert.equal(copy.data.versions[0].state, 'draft');

    // 清空副本的调整项并计算，原情景与其结果不受影响
    const cleared = await api(base, 'PUT', `/api/scenarios/${copy.data.id}/versions/1/adjustments`, {
      body: { baseRevision: 0, adjustments: [] },
    });
    assert.equal(cleared.status, 200);
    await calculate(base, copy.data.id);
    const copyResult = await getResult(base, copy.data.id);
    assert.equal(lineAt(copyResult, '2026-09-19', 'US', 'USD').fxRate, 7.2); // 副本无冲击

    const after = (await api(base, 'GET', `/api/scenarios/${sc.id}`)).data;
    assert.deepEqual(after, before);
    const originResult = await getResult(base, sc.id);
    assert.equal(lineAt(originResult, '2026-09-19', 'US', 'USD').fxRate, 8.64); // 原情景仍带 20% 冲击
  });
});

test('数据集级撤销额度只影响新计算，已发布报告因快照保持不变', async () => {
  await withApp(async ({ base }) => {
    const data = await seed(base);
    const sc = await makeScenario(base);
    await calculate(base, sc.id);
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'approver', user: 'appr1', body: {} });
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'publisher', user: 'pub1' });

    const revoke = await api(base, 'POST', `/api/datasets/credit-lines/${data.lines[1].id}/revoke`);
    assert.equal(revoke.status, 200);
    assert.equal(revoke.data.status, 'revoked');

    // 新版本重新计算 → 额度为 0
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions`, { body: {} });
    await calculate(base, sc.id, 2);
    const v2 = await getResult(base, sc.id, 2);
    assert.equal(lineAt(v2, '2026-09-21', 'US', 'USD').creditAvailable, 0);
    assert.equal(lineAt(v2, '2026-09-21', 'US', 'USD').fundingGap, 200000);

    // 已发布 v1 的报告与输入快照仍是撤销前的状态
    const v1 = await getResult(base, sc.id, 1);
    assert.equal(lineAt(v1, '2026-09-21', 'US', 'USD').creditAvailable, 80000);
    assert.equal(v1.inputSnapshot.creditLines.find((c) => c.id === data.lines[1].id).status, 'committed');
  });
});

// ---------------------------------------------------------------- 并发与权限

test('并发编辑同一情景：乐观锁保证只有一个修改成功', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base);
    const [r1, r2] = await Promise.all([
      api(base, 'PUT', `/api/scenarios/${sc.id}/versions/1/params`, { user: 'u1', body: { baseRevision: 0, horizonDays: 10 } }),
      api(base, 'PUT', `/api/scenarios/${sc.id}/versions/1/params`, { user: 'u2', body: { baseRevision: 0, horizonDays: 7 } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = [r1, r2].find((r) => r.status === 409);
    assert.equal(loser.data.currentRevision, 1);

    // 缺 baseRevision 直接拒绝
    const noRev = await api(base, 'PUT', `/api/scenarios/${sc.id}/versions/1/params`, { body: { horizonDays: 5 } });
    assert.equal(noRev.status, 400);
  });
});

test('角色权限：只有授权角色可审批与发布', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base);
    await calculate(base, sc.id);

    // 未认证 / 未知角色
    assert.equal((await api(base, 'GET', '/api/scenarios', { user: null, role: null })).status, 401);
    assert.equal((await api(base, 'GET', '/api/scenarios', { role: 'root' })).status, 403);

    // viewer 只读
    assert.equal((await api(base, 'GET', `/api/scenarios/${sc.id}`, { role: 'viewer' })).status, 200);
    assert.equal((await api(base, 'POST', '/api/datasets/balances', { role: 'viewer', body: { rows: [] } })).status, 403);

    // analyst 不能审批也不能发布；approver 不能发布；publisher 不能审批
    assert.equal((await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'analyst', body: {} })).status, 403);
    assert.equal((await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'analyst' })).status, 403);
    assert.equal((await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'approver', user: 'appr1' })).status, 403);
    assert.equal((await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'publisher', user: 'pub1', body: {} })).status, 403);

    // 未审批不能发布；审批后发布成功；重复审批被拒
    assert.equal((await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'publisher', user: 'pub1' })).status, 409);
    assert.equal((await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'approver', user: 'appr1', body: { comment: '数字已核对' } })).status, 200);
    assert.equal((await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'approver', user: 'appr1', body: {} })).status, 409);
    const pub = await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'publisher', user: 'pub1' });
    assert.equal(pub.status, 200);
    assert.equal(pub.data.publishedBy, 'pub1');
  });
});

test('计算过期不能发布，需重新计算', async () => {
  await withApp(async ({ base }) => {
    const data = await seed(base);
    const sc = await makeScenario(base);
    await calculate(base, sc.id);
    // 计算后又修改输入 → revision 前进，计算结果变陈旧
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/adjustments`, {
      body: { baseRevision: 0, adjustment: { type: 'revoke-credit-line', creditLineId: data.lines[1].id } },
    });
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'approver', user: 'appr1', body: {} });
    const stale = await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'publisher', user: 'pub1' });
    assert.equal(stale.status, 409);
    assert.match(stale.data.message, /过期/);

    await calculate(base, sc.id);
    const ok = await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'publisher', user: 'pub1' });
    assert.equal(ok.status, 200);
  });
});

// ---------------------------------------------------------------- 提醒与导出

test('提醒与导出均标注采用的版本', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base);
    await calculate(base, sc.id);

    const rem = await api(base, 'GET', `/api/scenarios/${sc.id}/versions/1/reminders`, { role: 'viewer' });
    assert.equal(rem.status, 200);
    assert.equal(rem.data.version.versionNo, 1);
    const gap = rem.data.reminders.find((r) => r.type === 'funding-gap' && r.date === '2026-09-21');
    assert.equal(gap.amountBase, 864000);
    assert.equal(gap.versionNo, 1);
    assert.ok(rem.data.reminders.some((r) => r.type === 'debt-maturity' && r.date === '2026-09-20'));
    assert.ok(rem.data.reminders.some((r) => r.type === 'credit-expiry'));

    // 导出 JSON / CSV 都带版本标识
    const expJson = await api(base, 'GET', `/api/scenarios/${sc.id}/versions/1/export?format=json`);
    assert.equal(expJson.data.meta.versionNo, 1);
    assert.equal(expJson.data.meta.versionState, 'draft');
    const expCsv = await api(base, 'GET', `/api/scenarios/${sc.id}/versions/1/export?format=csv`);
    assert.match(expCsv.data, /version=v1/);
    assert.match(expCsv.data, /date,country,currency,opening/);

    // 全局提醒只汇总已发布版本
    assert.equal((await api(base, 'GET', '/api/reminders')).data.reminders.length, 0);
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'approver', user: 'appr1', body: {} });
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'publisher', user: 'pub1' });
    const published = await api(base, 'GET', '/api/reminders');
    assert.ok(published.data.reminders.length > 0);
    assert.ok(published.data.reminders.every((r) => r.versionNo === 1 && r.versionState === 'published'));
  });
});

test('结果可按国家、币种、日期过滤，合计随过滤重算', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base);
    await calculate(base, sc.id);

    const usOnly = await getResult(base, sc.id, 1, '?country=US&currency=USD');
    assert.ok(usOnly.days.every((d) => d.lines.every((l) => l.country === 'US')));
    assert.equal(dayAt(usOnly, '2026-09-18').totals.closingBase, 1420000); // 仅 US 头寸

    const window = await getResult(base, sc.id, 1, '?from=2026-09-21&to=2026-09-22');
    assert.equal(window.days.length, 2);

    // 情景范围：只看 CNY
    const scoped = await makeScenario(base, [], { scope: { currencies: ['CNY'] } });
    await calculate(base, scoped.id);
    const scopedResult = await getResult(base, scoped.id);
    assert.deepEqual(scopedResult.summary.currencies, ['CNY']);
  });
});

// ---------------------------------------------------------------- 恢复

test('应用恢复后：未完成计算续跑完成，已发布报告可恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-recovery-'));
  const first = await boot(dir);
  await seed(first.base);
  const sc = await makeScenario(first.base);
  await calculate(first.base, sc.id);
  await api(first.base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'approver', user: 'appr1', body: {} });
  await api(first.base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'publisher', user: 'pub1' });

  // 另一个情景只入队不计算，模拟崩溃时卡在队列里的任务
  const sc2 = await makeScenario(first.base, [], { name: '崩溃前未算完' });
  await first.close();

  // 直接改写落盘文件：注入一个 queued 任务（进程在计算前崩溃）
  const file = path.join(dir, 'store.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.jobs.push({
    id: 'JOB-9001', type: 'calc', scenarioId: sc2.id, versionNo: 1, revision: 0,
    status: 'queued', enqueuedBy: 'tester', enqueuedAt: new Date().toISOString(),
    startedAt: null, finishedAt: null, error: null,
  });
  fs.writeFileSync(file, JSON.stringify(state));

  // 重启：恢复例程应重跑 queued 任务，已发布报告原样可用
  const store = Store.load(dir);
  const report = recoverStore(store);
  assert.deepEqual(report.recoveredJobs, ['JOB-9001']);
  assert.deepEqual(report.publishedReports, [`${sc.id}#v1`]);
  assert.equal(store.state.jobs.find((j) => j.id === 'JOB-9001').status, 'done');
  const sc2after = store.state.scenarios.find((s) => s.id === sc2.id);
  assert.equal(sc2after.versions[0].calc.status, 'done');

  const second = await boot(dir);
  assert.deepEqual(second.recovery.recoveredJobs, []); // 第二次启动无遗留任务
  const v1 = await getResult(second.base, sc.id, 1);
  assert.equal(dayAt(v1, '2026-09-21').totals.fundingGapBase, 864000);
  const v2 = await getResult(second.base, sc2.id, 1);
  assert.equal(v2.days.length, 14);
  await second.close();
});

test('异步计算任务可通过任务列表跟踪', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base);
    const r = await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/calculate?async=1`);
    assert.equal(r.status, 202);
    const jobId = r.data.job.id;
    // 轮询直到完成
    let job;
    for (let i = 0; i < 50; i++) {
      job = (await api(base, 'GET', `/api/jobs/${jobId}`)).data;
      if (job.status === 'done') break;
      await new Promise((r2) => setTimeout(r2, 20));
    }
    assert.equal(job.status, 'done');
    const result = await getResult(base, sc.id);
    assert.equal(result.days.length, 14);
  });
});

test('审计日志记录关键操作', async () => {
  await withApp(async ({ base }) => {
    await seed(base);
    const sc = await makeScenario(base);
    await calculate(base, sc.id);
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/approve`, { role: 'approver', user: 'appr1', body: {} });
    await api(base, 'POST', `/api/scenarios/${sc.id}/versions/1/publish`, { role: 'publisher', user: 'pub1' });

    const audit = (await api(base, 'GET', '/api/audit', { role: 'viewer' })).data.audit;
    const actions = audit.map((a) => a.action);
    for (const expected of ['dataset.import', 'scenario.create', 'calc.enqueue', 'scenario.version.approve', 'scenario.version.publish']) {
      assert.ok(actions.includes(expected), `审计缺少 ${expected}`);
    }
    const pub = audit.find((a) => a.action === 'scenario.version.publish');
    assert.equal(pub.user, 'pub1');
    assert.equal(pub.role, 'publisher');
  });
});
