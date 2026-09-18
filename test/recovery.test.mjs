// 恢复测试：进程重启后，已发布报告与未完成的计算作业都能恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootApp, seedScenario, SAMPLE_INPUTS } from './helpers.mjs';

test('重启后：已发布版本/导出仍在，queued 与中断的 running 作业恢复并完成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-recovery-'));
  let scenarioId;
  let runQueuedId;
  let runInterruptedId;

  // ---- 第一次运行：发布基线、导出、排队两个计算，其中一个模拟计算中断 ----
  const app1 = await bootApp({ dataDir: dir });
  try {
    ({ scenarioId } = await seedScenario(app1.call, SAMPLE_INPUTS));
    await app1.call('POST', `/scenarios/${scenarioId}/versions/1/approve`, {
      role: 'approver',
      body: { decision: 'approved' },
    });
    const published = await app1.call('POST', `/scenarios/${scenarioId}/versions/1/publish`, {
      role: 'publisher',
    });
    assert.equal(published.body.version.state, 'published');

    await app1.call('POST', `/scenarios/${scenarioId}/versions/1/exports`, {
      body: { type: 'committee-pack' },
    });

    const r1 = await app1.call('POST', `/scenarios/${scenarioId}/versions/1/runs`, { body: {} });
    const r2 = await app1.call('POST', `/scenarios/${scenarioId}/versions/1/runs`, { body: {} });
    runQueuedId = r1.body.run.id;
    runInterruptedId = r2.body.run.id;
    // 模拟进程在计算中途崩溃：作业停在 running，落盘后进程退出。
    const interrupted = app1.app.store.data.runs[runInterruptedId];
    interrupted.status = 'running';
    interrupted.startedAt = new Date().toISOString();
    app1.app.store.save();
  } finally {
    await app1.close({ cleanup: false });
  }

  // ---- 第二次运行（同一数据目录）：验证恢复 ----
  const app2 = await bootApp({ dataDir: dir });
  try {
    const health = await app2.call('GET', '/health', { role: 'viewer' });
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.resumedRuns, 1); // 中断的 running 被重置回 queued

    // 已发布报告（版本 + 输入 + 导出）完整恢复
    const v1 = await app2.call('GET', `/scenarios/${scenarioId}/versions/1`, { role: 'viewer' });
    assert.equal(v1.body.version.state, 'published');
    assert.equal(v1.body.version.inputs.balances.length, 2);
    const exportsList = await app2.call('GET', `/scenarios/${scenarioId}/exports`, { role: 'viewer' });
    assert.equal(exportsList.body.exports.length, 1);
    assert.match(exportsList.body.exports[0].label, /v1/);

    // 两个未完成的计算都回到队列
    for (const id of [runQueuedId, runInterruptedId]) {
      const run = await app2.call('GET', `/runs/${id}`, { role: 'viewer' });
      assert.equal(run.body.run.status, 'queued');
    }

    // 恢复调度后计算完成，结果可追溯（版本号 + 输入哈希）
    app2.app.jobs.drain();
    const done = await app2.call('GET', `/runs/${runInterruptedId}`, { role: 'viewer' });
    assert.equal(done.body.run.status, 'completed');
    const result = await app2.call('GET', `/scenarios/${scenarioId}/versions/1/result`, {
      role: 'viewer',
    });
    assert.equal(result.body.result.meta.versionNo, 1);
    assert.ok(result.body.inputHash);
    assert.ok(result.body.result.cells.length > 0);
  } finally {
    await app2.close({ cleanup: false });
    rmSync(dir, { recursive: true, force: true });
  }
});
