// API 测试：版本化、并发编辑、权限、审批-发布流、复制不破坏基线、导出/提醒标注版本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, seedScenario, SAMPLE_INPUTS } from './helpers.mjs';

test('创建情景得到 v1 草稿；输入修订推进 revision', async () => {
  const { call, close } = await bootApp();
  try {
    const created = await call('POST', '/scenarios', {
      body: { name: '基线', baseDate: '2026-09-21', reportingCurrency: 'USD' },
    });
    assert.equal(created.status, 201);
    const id = created.body.scenario.id;
    assert.equal(created.body.version.versionNo, 1);
    assert.equal(created.body.version.state, 'draft');

    const patched = await call('PUT', `/scenarios/${id}/versions/1/inputs`, {
      body: { expectedRevision: 0, patch: SAMPLE_INPUTS },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.version.revision, 1);
    assert.equal(patched.body.forked, false);
  } finally {
    await close();
  }
});

test('并发编辑同一情景：相同 expectedRevision 只有一个成功', async () => {
  const { call, close } = await bootApp();
  try {
    const { scenarioId } = await seedScenario(call, SAMPLE_INPUTS); // revision 已是 1
    const editA = () =>
      call('PUT', `/scenarios/${scenarioId}/versions/1/inputs`, {
        body: { expectedRevision: 1, patch: { balances: [{ country: 'CN', currency: 'USD', amount: 1 }] } },
      });
    const [a, b] = await Promise.all([editA(), editA()]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.error, 'revision_conflict');
  } finally {
    await close();
  }
});

test('权限矩阵：viewer 不能改、analyst 不能发布、缺用户头 401', async () => {
  const { call, close } = await bootApp();
  try {
    const { scenarioId } = await seedScenario(call, SAMPLE_INPUTS);
    const asViewer = await call('PUT', `/scenarios/${scenarioId}/versions/1/inputs`, {
      role: 'viewer',
      body: { expectedRevision: 1, patch: {} },
    });
    assert.equal(asViewer.status, 403);
    const noUser = await call('POST', `/scenarios/${scenarioId}/versions/1/publish`, { user: null });
    assert.equal(noUser.status, 401);
    const asAnalyst = await call('POST', `/scenarios/${scenarioId}/versions/1/publish`, { role: 'analyst' });
    assert.equal(asAnalyst.status, 403);
  } finally {
    await close();
  }
});

test('发布需要针对当前修订的通过审批；审批后改输入则审批失效', async () => {
  const { call, close } = await bootApp();
  try {
    const { scenarioId } = await seedScenario(call, SAMPLE_INPUTS);
    // 未审批直接发布 → 409
    const early = await call('POST', `/scenarios/${scenarioId}/versions/1/publish`, { role: 'publisher' });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, 'approval_required');

    // 审批通过（approver 角色）
    const approval = await call('POST', `/scenarios/${scenarioId}/versions/1/approve`, {
      role: 'approver',
      body: { decision: 'approved', comment: '委员会评审通过' },
    });
    assert.equal(approval.status, 201);
    assert.equal(approval.body.approval.revision, 1);

    // 审批后又改输入 → 旧审批失效，发布被拒
    await call('PUT', `/scenarios/${scenarioId}/versions/1/inputs`, {
      body: { expectedRevision: 1, patch: { balances: [{ country: 'CN', currency: 'USD', amount: 5 }] } },
    });
    const stale = await call('POST', `/scenarios/${scenarioId}/versions/1/publish`, { role: 'publisher' });
    assert.equal(stale.status, 409);

    // 重新审批当前修订后可发布
    await call('POST', `/scenarios/${scenarioId}/versions/1/approve`, {
      role: 'approver',
      body: { decision: 'approved' },
    });
    const published = await call('POST', `/scenarios/${scenarioId}/versions/1/publish`, { role: 'publisher' });
    assert.equal(published.status, 200);
    assert.equal(published.body.version.state, 'published');
  } finally {
    await close();
  }
});

test('发布后再修改自动形成新版本，已发布基线不可变', async () => {
  const { call, close } = await bootApp();
  try {
    const { scenarioId } = await seedScenario(call, SAMPLE_INPUTS);
    await call('POST', `/scenarios/${scenarioId}/versions/1/approve`, {
      role: 'approver',
      body: { decision: 'approved' },
    });
    await call('POST', `/scenarios/${scenarioId}/versions/1/publish`, { role: 'publisher' });

    // 对已发布的最新版本提交修订 → 自动分叉 v2 草稿
    const edited = await call('PUT', `/scenarios/${scenarioId}/versions/1/inputs`, {
      body: {
        expectedRevision: 1,
        patch: { shocks: { fx: [{ currency: 'EUR', fromDate: '2026-09-25', pct: 0.15 }], frozenAccounts: [], revokedFacilities: [], financingClosed: [] } },
      },
    });
    assert.equal(edited.status, 201);
    assert.equal(edited.body.forked, true);
    assert.equal(edited.body.version.versionNo, 2);
    assert.equal(edited.body.version.state, 'draft');

    // v1 仍是已发布基线，输入未被污染
    const v1 = await call('GET', `/scenarios/${scenarioId}/versions/1`);
    assert.equal(v1.body.version.state, 'published');
    assert.deepEqual(v1.body.version.inputs.shocks.fx, []);

    // 历史版本不可直接修改
    const touchHistory = await call('PUT', `/scenarios/${scenarioId}/versions/1/inputs`, {
      body: { expectedRevision: 1, patch: {} },
    });
    assert.equal(touchHistory.status, 409);
    assert.equal(touchHistory.body.error, 'version_not_latest');
  } finally {
    await close();
  }
});

test('情景复制：副本独立演进，原始基线不受影响', async () => {
  const { call, close } = await bootApp();
  try {
    const { scenarioId } = await seedScenario(call, SAMPLE_INPUTS);
    const copied = await call('POST', `/scenarios/${scenarioId}/copy`, { body: { name: '极端情形副本' } });
    assert.equal(copied.status, 201);
    const copyId = copied.body.scenario.id;
    assert.notEqual(copyId, scenarioId);
    assert.deepEqual(copied.body.version.copiedFrom, { scenarioId, versionNo: 1 });

    // 修改副本：撤销额度 + 冻结账户
    await call('PUT', `/scenarios/${copyId}/versions/1/inputs`, {
      body: {
        expectedRevision: 0,
        patch: { shocks: { revokedFacilities: ['fac-cn'], frozenAccounts: [{ country: 'DE', currency: 'EUR' }] } },
      },
    });

    // 原始情景输入保持原样
    const original = await call('GET', `/scenarios/${scenarioId}/versions/1`);
    assert.deepEqual(original.body.version.inputs.shocks.revokedFacilities, []);
    assert.deepEqual(original.body.version.inputs.shocks.frozenAccounts, []);
    assert.equal(original.body.version.inputs.balances.length, 2);
  } finally {
    await close();
  }
});

test('计算作业：请求后排队，执行后可按版本取回带追溯的结果', async () => {
  const { call, app, close } = await bootApp();
  try {
    const { scenarioId } = await seedScenario(call, SAMPLE_INPUTS);
    const runReq = await call('POST', `/scenarios/${scenarioId}/versions/1/runs`, { body: {} });
    assert.equal(runReq.status, 202);
    assert.equal(runReq.body.run.status, 'queued');

    app.jobs.drain();

    const run = await call('GET', `/runs/${runReq.body.run.id}`, { role: 'viewer' });
    assert.equal(run.body.run.status, 'completed');

    const result = await call('GET', `/scenarios/${scenarioId}/versions/1/result`);
    assert.equal(result.body.inputHash, run.body.run.inputHash);
    // 2 个资金桶 × 14 天
    assert.equal(result.body.result.cells.length, 2 * 14);
    const cn0923 = result.body.result.cells.find(
      (c) => c.country === 'CN' && c.currency === 'USD' && c.date === '2026-09-23',
    );
    assert.equal(cn0923.debtDue, 150);
    assert.ok(cn0923.lineage.inputs.length > 0);
  } finally {
    await close();
  }
});

test('导出与提醒均标注采用的版本', async () => {
  const { call, app, close } = await bootApp();
  try {
    const { scenarioId } = await seedScenario(call, SAMPLE_INPUTS);
    await call('POST', `/scenarios/${scenarioId}/versions/1/runs`, { body: {} });
    app.jobs.drain();

    const exported = await call('POST', `/scenarios/${scenarioId}/versions/1/exports`, {
      body: { type: 'committee-pack' },
    });
    assert.equal(exported.status, 201);
    assert.equal(exported.body.export.versionNo, 1);
    assert.match(exported.body.export.label, /v1/);
    assert.ok(exported.body.export.inputHash);
    assert.ok(exported.body.export.dailyTotals);

    const reminder = await call('POST', `/scenarios/${scenarioId}/versions/1/reminders`, {
      body: { message: '请委员会审阅两周缺口', audience: 'treasury-committee' },
    });
    assert.equal(reminder.status, 201);
    assert.equal(reminder.body.reminder.versionNo, 1);
    assert.match(reminder.body.reminder.label, /v1/);

    const listed = await call('GET', `/scenarios/${scenarioId}/exports`, { role: 'viewer' });
    assert.equal(listed.body.exports.length, 1);
  } finally {
    await close();
  }
});

test('审计日志记录关键动作', async () => {
  const { call, close } = await bootApp();
  try {
    const { scenarioId } = await seedScenario(call, SAMPLE_INPUTS);
    await call('POST', `/scenarios/${scenarioId}/versions/1/approve`, {
      role: 'approver',
      body: { decision: 'approved' },
    });
    await call('POST', `/scenarios/${scenarioId}/versions/1/publish`, { role: 'publisher' });
    const audit = await call('GET', `/audit?scenarioId=${scenarioId}`, { role: 'viewer' });
    const actions = audit.body.audit.map((a) => a.action);
    assert.ok(actions.includes('scenario.create'));
    assert.ok(actions.includes('version.edit'));
    assert.ok(actions.includes('version.approve'));
    assert.ok(actions.includes('version.publish'));
  } finally {
    await close();
  }
});
