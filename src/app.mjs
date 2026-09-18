// 应用装配：存储 + 作业队列 + 路由。createApp 供入口与测试共用（测试用临时目录与随机端口）。
import { createServer } from 'node:http';
import { Store } from './store.mjs';
import { JobRunner } from './jobs.mjs';
import { createRouter, readBody, sendJson } from './router.mjs';
import { HttpError, requireAction } from './auth.mjs';
import * as d from './domain.mjs';

const versionSummary = (v) => ({
  versionNo: v.versionNo,
  state: v.state,
  revision: v.revision,
  approvals: v.approvals.length,
  createdBy: v.createdBy,
  createdAt: v.createdAt,
  publishedBy: v.publishedBy,
  publishedAt: v.publishedAt,
  basedOnVersionId: v.basedOnVersionId,
  copiedFrom: v.copiedFrom,
});

const runView = (r) => ({
  id: r.id,
  scenarioId: r.scenarioId,
  versionNo: r.versionNo,
  versionState: r.versionState,
  status: r.status,
  inputHash: r.inputHash,
  requestedBy: r.requestedBy,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  error: r.error,
  result: r.result,
});

export function createApp({ dataDir, autoProcess = false } = {}) {
  const store = new Store(dataDir);
  const jobs = new JobRunner(store, { autoProcess });
  const resumed = jobs.recover();
  const router = createRouter();

  const actorOf = (req) => ({
    user: req.headers['x-user'] ?? null,
    role: req.headers['x-role'] ?? 'viewer',
  });

  const routes = (add) => {
    add('GET', '/health', ({ res }) =>
      sendJson(res, 200, { status: 'ok', resumedRuns: resumed, now: new Date().toISOString() }),
    );

    add('GET', '/scenarios', ({ res }) => {
      const list = Object.values(store.data.scenarios).map((s) => ({
        ...s,
        versions: store.versionsOf(s.id).map(versionSummary),
      }));
      sendJson(res, 200, { scenarios: list });
    });

    add('POST', '/scenarios', async ({ req, res, actor }) => {
      requireAction(actor, 'create');
      const body = await readBody(req);
      const { scenario, version } = d.createScenario(store, actor, body);
      sendJson(res, 201, { scenario, version: versionSummary(version) });
    });

    add('GET', '/scenarios/:id', ({ res, params }) => {
      const scenario = d.mustScenario(store, params.id);
      sendJson(res, 200, { scenario, versions: store.versionsOf(scenario.id).map(versionSummary) });
    });

    add('POST', '/scenarios/:id/copy', async ({ req, res, actor, params }) => {
      requireAction(actor, 'copy');
      const body = await readBody(req);
      const { scenario, version } = d.copyScenario(store, actor, params.id, body);
      sendJson(res, 201, { scenario, version: versionSummary(version) });
    });

    add('GET', '/scenarios/:id/versions', ({ res, params }) => {
      d.mustScenario(store, params.id);
      sendJson(res, 200, { versions: store.versionsOf(params.id).map(versionSummary) });
    });

    add('GET', '/scenarios/:id/versions/:n', ({ res, params }) => {
      d.mustScenario(store, params.id);
      const v = d.mustVersion(store, params.id, Number(params.n));
      sendJson(res, 200, { version: v });
    });

    add('PUT', '/scenarios/:id/versions/:n/inputs', async ({ req, res, actor, params }) => {
      requireAction(actor, 'edit');
      const body = await readBody(req);
      const { version, forked } = d.applyInputsPatch(store, actor, params.id, Number(params.n), body);
      sendJson(res, forked ? 201 : 200, { version, forked });
    });

    add('POST', '/scenarios/:id/versions/:n/approve', async ({ req, res, actor, params }) => {
      requireAction(actor, 'approve');
      const body = await readBody(req);
      const approval = d.approveVersion(store, actor, params.id, Number(params.n), body);
      sendJson(res, 201, { approval });
    });

    add('POST', '/scenarios/:id/versions/:n/publish', ({ res, actor, params }) => {
      requireAction(actor, 'publish');
      const version = d.publishVersion(store, actor, params.id, Number(params.n));
      sendJson(res, 200, { version: versionSummary(version) });
    });

    add('POST', '/scenarios/:id/versions/:n/runs', ({ res, actor, params }) => {
      requireAction(actor, 'run');
      const run = d.requestRun(store, actor, params.id, Number(params.n));
      sendJson(res, 202, { run: runView(run) });
    });

    add('GET', '/runs/:id', ({ res, params }) => {
      const run = store.run(params.id);
      if (!run) throw new HttpError(404, 'not_found', `作业不存在: ${params.id}`);
      sendJson(res, 200, { run: runView(run) });
    });

    add('GET', '/scenarios/:id/versions/:n/result', ({ res, params }) => {
      d.mustScenario(store, params.id);
      const v = d.mustVersion(store, params.id, Number(params.n));
      const run = store.latestCompletedRun(v.id);
      if (!run) throw new HttpError(404, 'not_found', `版本 v${params.n} 尚无已完成的计算`);
      sendJson(res, 200, { runId: run.id, inputHash: run.inputHash, result: run.result });
    });

    add('POST', '/scenarios/:id/versions/:n/exports', async ({ req, res, actor, params }) => {
      requireAction(actor, 'export');
      const body = await readBody(req);
      const record = d.createExport(store, actor, params.id, Number(params.n), body);
      sendJson(res, 201, { export: record });
    });

    add('GET', '/scenarios/:id/exports', ({ res, params }) => {
      d.mustScenario(store, params.id);
      sendJson(res, 200, { exports: store.exportsOf(params.id) });
    });

    add('POST', '/scenarios/:id/versions/:n/reminders', async ({ req, res, actor, params }) => {
      requireAction(actor, 'remind');
      const body = await readBody(req);
      const record = d.createReminder(store, actor, params.id, Number(params.n), body);
      sendJson(res, 201, { reminder: record });
    });

    add('GET', '/scenarios/:id/reminders', ({ res, params }) => {
      d.mustScenario(store, params.id);
      sendJson(res, 200, { reminders: store.remindersOf(params.id) });
    });

    add('GET', '/audit', ({ res, query }) => {
      let entries = store.data.audit;
      if (query.scenarioId) entries = entries.filter((e) => e.scenarioId === query.scenarioId);
      sendJson(res, 200, { audit: entries });
    });
  };

  routes(router.add.bind(router));

  const server = createServer(async (req, res) => {
    const actor = actorOf(req);
    try {
      await router.handle(req, res, { req, res, actor });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else {
        sendJson(res, 500, { error: 'internal', message: String(err?.message ?? err) });
      }
    }
  });

  return { server, store, jobs };
}
