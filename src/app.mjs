// HTTP 层：路由、身份识别、角色权限、请求/响应编解码。
// 角色与权限矩阵（RBAC）：
//   viewer    只读（结果、提醒、导出、审计）
//   analyst   viewer + 数据导入、情景/版本编辑、计算、撤销额度
//   approver  analyst 的读权限 + 审批
//   publisher analyst 的读权限 + 发布
//   admin     全部权限
// 身份通过请求头 x-user-id / x-role 传入（接入企业 SSO 时在此替换为令牌校验）。

import { HttpError, unauthorized, forbidden, badRequest } from './util.mjs';
import * as domain from './domain.mjs';

export const ROLES = ['viewer', 'analyst', 'approver', 'publisher', 'admin'];

const PERMS = {
  read: ['viewer', 'analyst', 'approver', 'publisher', 'admin'],
  import: ['analyst', 'admin'],
  edit: ['analyst', 'admin'],
  approve: ['approver', 'admin'],
  publish: ['publisher', 'admin'],
  revoke: ['analyst', 'admin'],
};

function compile(pattern) {
  const segs = pattern.split('/').filter(Boolean);
  return (path) => {
    const parts = path.split('/').filter(Boolean);
    if (parts.length !== segs.length) return null;
    const params = {};
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (segs[i] !== parts[i]) return null;
    }
    return params;
  };
}

const routes = [];
const route = (method, pattern, perm, handler) => routes.push({ method, match: compile(pattern), perm, handler });

const versionSummary = (v) => ({
  versionNo: v.versionNo,
  revision: v.revision,
  state: v.state,
  approvals: v.approvals,
  adjustmentCount: v.adjustments.length,
  calc: v.calc ? { status: v.calc.status, calcId: v.calc.calcId, calculatedAt: v.calc.calculatedAt, revision: v.calc.revision, stale: v.calc.revision !== v.revision } : null,
  createdBy: v.createdBy,
  createdAt: v.createdAt,
  publishedBy: v.publishedBy,
  publishedAt: v.publishedAt,
});

const scenarioSummary = (sc) => ({
  id: sc.id,
  name: sc.name,
  createdBy: sc.createdBy,
  createdAt: sc.createdAt,
  copiedFrom: sc.copiedFrom ?? null,
  publishedVersionNo: sc.publishedVersionNo,
  versions: sc.versions.map(versionSummary),
});

// ---------------------------------------------------------------- 路由注册

route('GET', '/health', null, async ({ store }) => ({
  status: 'ok',
  recovery: store.recoveryReport,
  corruptBackup: store.corruptBackup ?? null,
}));

route('POST', '/api/datasets/:kind', 'import', async ({ store, params, body, user }) =>
  domain.importRows(store, params.kind, body?.rows, user));

route('GET', '/api/datasets/:kind', 'read', async ({ store, params }) => {
  const def = { balances: 'balances', debts: 'debts', 'credit-lines': 'creditLines', fx: 'fx' }[params.kind];
  if (!def) throw badRequest(`未知数据集类型：${params.kind}`);
  return { rows: store.state.datasets[def] };
});

route('POST', '/api/datasets/credit-lines/:id/revoke', 'revoke', async ({ store, params, user }) =>
  domain.revokeCreditLine(store, params.id, user));

route('POST', '/api/scenarios', 'edit', async ({ store, body, user }) => {
  const sc = domain.createScenario(store, body ?? {}, user);
  return { httpStatus: 201, body: scenarioSummary(sc) };
});

route('GET', '/api/scenarios', 'read', async ({ store }) => ({
  scenarios: store.state.scenarios.map(scenarioSummary),
}));

route('GET', '/api/scenarios/:id', 'read', async ({ store, params }) =>
  scenarioSummary(domain.findScenario(store, params.id)));

route('POST', '/api/scenarios/:id/copy', 'edit', async ({ store, params, body, user }) => {
  const sc = domain.copyScenario(store, params.id, body ?? {}, user);
  return { httpStatus: 201, body: scenarioSummary(sc) };
});

route('POST', '/api/scenarios/:id/versions', 'edit', async ({ store, params, body, user }) => {
  const v = domain.createVersion(store, params.id, body ?? {}, user);
  return { httpStatus: 201, body: versionSummary(v) };
});

route('GET', '/api/scenarios/:id/versions/:n', 'read', async ({ store, params }) => {
  const sc = domain.findScenario(store, params.id);
  const v = domain.findVersion(sc, params.n);
  return { ...versionSummary(v), params: v.params, adjustments: v.adjustments };
});

route('PUT', '/api/scenarios/:id/versions/:n/params', 'edit', async ({ store, params, body, user }) =>
  versionSummary(domain.updateParams(store, params.id, params.n, body ?? {}, user)));

route('PUT', '/api/scenarios/:id/versions/:n/adjustments', 'edit', async ({ store, params, body, user }) =>
  versionSummary(domain.setAdjustments(store, params.id, params.n, body ?? {}, user)));

route('POST', '/api/scenarios/:id/versions/:n/adjustments', 'edit', async ({ store, params, body, user }) =>
  versionSummary(domain.addAdjustment(store, params.id, params.n, body ?? {}, user)));

route('POST', '/api/scenarios/:id/versions/:n/approve', 'approve', async ({ store, params, body, user }) =>
  versionSummary(domain.approveVersion(store, params.id, params.n, body ?? {}, user)));

route('POST', '/api/scenarios/:id/versions/:n/publish', 'publish', async ({ store, params, user }) =>
  versionSummary(domain.publishVersion(store, params.id, params.n, user)));

route('POST', '/api/scenarios/:id/versions/:n/calculate', 'edit', async ({ store, params, query, user }) => {
  const job = domain.enqueueCalculation(store, params.id, params.n, user);
  if (query.get('async') === '1') {
    setImmediate(() => domain.runJob(store, job));
    return { httpStatus: 202, body: { job } };
  }
  domain.runJob(store, job);
  const sc = domain.findScenario(store, params.id);
  const v = domain.findVersion(sc, params.n);
  return { job, calc: v.calc ? { status: v.calc.status, revision: v.calc.revision, calculatedAt: v.calc.calculatedAt } : null };
});

route('GET', '/api/scenarios/:id/versions/:n/result', 'read', async ({ store, params, query }) => {
  const { result } = domain.getCalcResult(store, params.id, params.n);
  const filters = {
    country: query.get('country') ?? undefined,
    currency: query.get('currency') ?? undefined,
    from: query.get('from') ?? undefined,
    to: query.get('to') ?? undefined,
  };
  if (Object.values(filters).every((x) => x === undefined)) return result;
  return domain.filterResult(result, filters);
});

route('GET', '/api/scenarios/:id/versions/:n/reminders', 'read', async ({ store, params }) =>
  domain.getReminders(store, params.id, params.n));

route('GET', '/api/scenarios/:id/versions/:n/export', 'read', async ({ store, params, query, user }) => {
  const format = query.get('format') === 'csv' ? 'csv' : 'json';
  const out = domain.exportVersion(store, params.id, params.n, format, user);
  return {
    raw: true,
    headers: { 'content-type': out.contentType, 'content-disposition': `attachment; filename="${out.filename}"` },
    body: typeof out.body === 'string' ? out.body : JSON.stringify(out.body, null, 2),
  };
});

route('GET', '/api/reminders', 'read', async ({ store }) => domain.getPublishedReminders(store));

route('GET', '/api/jobs', 'read', async ({ store }) => ({ jobs: store.state.jobs }));

route('GET', '/api/jobs/:id', 'read', async ({ store, params }) => {
  const job = store.state.jobs.find((j) => j.id === params.id);
  if (!job) throw badRequest(`任务不存在：${params.id}`);
  return job;
});

route('GET', '/api/audit', 'read', async ({ store }) => ({ audit: store.state.audit }));

// ---------------------------------------------------------------- 请求处理

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
}

export function createApp(store) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const matched = routes
        .map((r) => ({ r, params: r.match(url.pathname) }))
        .find((x) => x.params && x.r.method === req.method);
      if (!matched) {
        sendJson(res, 404, { error: 'not-found', message: `${req.method} ${url.pathname} 不存在` });
        return;
      }
      const { r, params } = matched;

      // 身份与权限
      let user = null;
      if (r.perm) {
        const id = req.headers['x-user-id'];
        const role = req.headers['x-role'];
        if (!id || !role) throw unauthorized();
        if (!ROLES.includes(role)) throw forbidden(`未知角色：${role}`);
        if (!PERMS[r.perm].includes(role)) throw forbidden(`角色 ${role} 无权执行该操作（需要：${PERMS[r.perm].join(' / ')}）`);
        user = { id, role };
      }

      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
      const out = await r.handler({ store, req, params, query: url.searchParams, body, user });
      if (out && out.raw) {
        res.writeHead(200, out.headers);
        res.end(out.body);
      } else if (out && out.httpStatus) {
        sendJson(res, out.httpStatus, out.body);
      } else {
        sendJson(res, 200, out ?? {});
      }
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
      } else {
        sendJson(res, 500, { error: 'internal', message: err.message });
      }
    }
  };
}
