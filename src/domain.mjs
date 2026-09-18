// 领域逻辑：情景、版本、审批、发布、导出、提醒。
// 关键不变量：
//  - 已发布版本永不修改（发布后修改 = 自动分叉新草稿版本）；
//  - 草稿修改必须携带 expectedRevision（乐观锁，防并发编辑互相覆盖）；
//  - 发布前必须存在针对当前 revision 的"通过"审批；
//  - 导出与提醒永远标注所采用的版本。
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './auth.mjs';
import { stableStringify } from './engine.mjs';

const now = () => new Date().toISOString();
const uuid = () => randomUUID();
export const inputHashOf = (inputs) =>
  createHash('sha256').update(stableStringify(inputs)).digest('hex').slice(0, 16);

// ---------- 校验 ----------
const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const isCurrency = (s) => typeof s === 'string' && /^[A-Z]{3}$/.test(s);
const isCountry = (s) => typeof s === 'string' && /^[A-Z]{2}$/.test(s);
const isMoney = (n) => typeof n === 'number' && Number.isFinite(n);

const bad = (msg) => new HttpError(400, 'invalid_input', msg);

function normalizeInputs(patch, base = {}) {
  const inputs = structuredClone(base);
  const ensureArray = (key) => {
    if (patch[key] !== undefined) {
      if (!Array.isArray(patch[key])) throw bad(`${key} 必须是数组`);
      inputs[key] = patch[key];
    } else inputs[key] = inputs[key] ?? [];
    return inputs[key];
  };

  for (const b of ensureArray('balances')) {
    if (!isCountry(b.country)) throw bad('balances[].country 须为两位大写国家码');
    if (!isCurrency(b.currency)) throw bad('balances[].currency 须为三位大写币种');
    if (!isMoney(b.amount)) throw bad('balances[].amount 须为有限数值');
    if (b.asOf !== undefined && !isDate(b.asOf)) throw bad('balances[].asOf 日期格式须为 YYYY-MM-DD');
    b.id ??= `bal_${uuid()}`;
  }
  for (const d of ensureArray('debts')) {
    if (!isCountry(d.country)) throw bad('debts[].country 须为两位大写国家码');
    if (!isCurrency(d.currency)) throw bad('debts[].currency 须为三位大写币种');
    if (!isMoney(d.amount)) throw bad('debts[].amount 须为有限数值');
    if (!isDate(d.dueDate)) throw bad('debts[].dueDate 日期格式须为 YYYY-MM-DD');
    d.id ??= `debt_${uuid()}`;
  }
  for (const f of ensureArray('facilities')) {
    if (!isCountry(f.country)) throw bad('facilities[].country 须为两位大写国家码');
    if (!isCurrency(f.currency)) throw bad('facilities[].currency 须为三位大写币种');
    if (!isMoney(f.limit) || f.limit < 0) throw bad('facilities[].limit 须为非负数值');
    if (!isDate(f.start) || !isDate(f.end)) throw bad('facilities[].start/end 日期格式须为 YYYY-MM-DD');
    if (f.start > f.end) throw bad('facilities[].start 不能晚于 end');
    f.id ??= `fac_${uuid()}`;
  }
  for (const r of ensureArray('fxRates')) {
    if (!isCurrency(r.currency)) throw bad('fxRates[].currency 须为三位大写币种');
    if (!isDate(r.date)) throw bad('fxRates[].date 日期格式须为 YYYY-MM-DD');
    if (!isMoney(r.rate) || r.rate <= 0) throw bad('fxRates[].rate 须为正数');
    r.id ??= `fx_${uuid()}`;
  }

  // 冲击假设：极端汇率回放、账户冻结、额度撤销、融资窗口关闭。
  if (patch.shocks !== undefined) {
    if (typeof patch.shocks !== 'object' || patch.shocks === null) throw bad('shocks 必须是对象');
    inputs.shocks = patch.shocks;
  }
  inputs.shocks ??= {};
  const s = inputs.shocks;
  s.fx ??= [];
  s.frozenAccounts ??= [];
  s.revokedFacilities ??= [];
  s.financingClosed ??= [];
  for (const x of s.fx) {
    if (!isCurrency(x.currency)) throw bad('shocks.fx[].currency 须为三位大写币种');
    if (!isDate(x.fromDate)) throw bad('shocks.fx[].fromDate 日期格式须为 YYYY-MM-DD');
    if (!isMoney(x.pct) || x.pct <= -1) throw bad('shocks.fx[].pct 须为大于 -1 的数值（如 0.08 表示 +8%）');
    x.id ??= `shk_${uuid()}`;
  }
  for (const z of s.frozenAccounts) {
    if (!isCountry(z.country) || !isCurrency(z.currency)) {
      throw bad('shocks.frozenAccounts[] 须含合法 country/currency');
    }
    if (z.fromDate !== undefined && !isDate(z.fromDate)) throw bad('shocks.frozenAccounts[].fromDate 格式错误');
    z.id ??= `shk_${uuid()}`;
  }
  for (const id of s.revokedFacilities) {
    if (typeof id !== 'string') throw bad('shocks.revokedFacilities[] 须为额度 id 字符串');
  }
  for (const c of s.financingClosed) {
    if (c.country !== undefined && !isCountry(c.country)) throw bad('shocks.financingClosed[].country 格式错误');
    if (c.currency !== undefined && !isCurrency(c.currency)) throw bad('shocks.financingClosed[].currency 格式错误');
    if (c.fromDate !== undefined && !isDate(c.fromDate)) throw bad('shocks.financingClosed[].fromDate 格式错误');
    c.id ??= `shk_${uuid()}`;
  }
  return inputs;
}

const emptyInputs = () => normalizeInputs({});

// ---------- 情景与版本 ----------
export function createScenario(store, actor, body) {
  const { name, description = '', baseDate, reportingCurrency, horizonDays = 14 } = body ?? {};
  if (typeof name !== 'string' || name.trim() === '') throw bad('name 必填');
  if (!isDate(baseDate)) throw bad('baseDate 日期格式须为 YYYY-MM-DD');
  if (!isCurrency(reportingCurrency)) throw bad('reportingCurrency 须为三位大写币种');
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 62) {
    throw bad('horizonDays 须为 1..62 的整数');
  }
  const scenario = {
    id: uuid(),
    name: name.trim(),
    description,
    baseDate,
    reportingCurrency,
    horizonDays,
    createdBy: actor.user,
    createdAt: now(),
  };
  const version = {
    id: uuid(),
    scenarioId: scenario.id,
    versionNo: 1,
    state: 'draft',
    revision: 0,
    basedOnVersionId: null,
    copiedFrom: null,
    inputs: emptyInputs(),
    approvals: [],
    createdBy: actor.user,
    createdAt: now(),
    publishedBy: null,
    publishedAt: null,
  };
  store.data.scenarios[scenario.id] = scenario;
  store.data.versions[version.id] = version;
  store.audit(actor, 'scenario.create', { scenarioId: scenario.id, versionNo: 1 });
  store.save();
  return { scenario, version };
}

export function copyScenario(store, actor, scenarioId, body = {}) {
  const source = mustScenario(store, scenarioId);
  const srcVersion = store.latestVersion(scenarioId);
  // 深拷贝：新情景只引用自己的数据，原始基线不受后续任何修改影响。
  const { scenario, version } = createScenario(store, actor, {
    name: body.name ?? `${source.name}（副本）`,
    description: source.description,
    baseDate: source.baseDate,
    reportingCurrency: source.reportingCurrency,
    horizonDays: source.horizonDays,
  });
  version.inputs = structuredClone(srcVersion.inputs);
  version.copiedFrom = { scenarioId, versionNo: srcVersion.versionNo };
  store.audit(actor, 'scenario.copy', {
    scenarioId: scenario.id,
    versionNo: 1,
    detail: { from: scenarioId, fromVersionNo: srcVersion.versionNo },
  });
  store.save();
  return { scenario, version };
}

export const mustScenario = (store, id) => {
  const s = store.scenario(id);
  if (!s) throw new HttpError(404, 'not_found', `情景不存在: ${id}`);
  return s;
};

export const mustVersion = (store, scenarioId, versionNo) => {
  const v = store.versionByNo(scenarioId, versionNo);
  if (!v) throw new HttpError(404, 'not_found', `情景 ${scenarioId} 不存在版本 v${versionNo}`);
  return v;
};

// 输入修订：草稿在原地改（revision+1）；最新版本已发布则自动分叉新草稿。
export function applyInputsPatch(store, actor, scenarioId, versionNo, body) {
  mustScenario(store, scenarioId);
  const { expectedRevision, patch = {} } = body ?? {};
  if (!Number.isInteger(expectedRevision)) throw bad('expectedRevision 必填且为整数');
  const version = mustVersion(store, scenarioId, versionNo);
  const latest = store.latestVersion(scenarioId);
  if (version.id !== latest.id) {
    throw new HttpError(409, 'version_not_latest', '只能修改最新版本；历史版本不可变');
  }
  if (version.revision !== expectedRevision) {
    throw new HttpError(409, 'revision_conflict', '版本已被他人修改，请刷新后重试', {
      currentRevision: version.revision,
    });
  }

  let target = version;
  let forked = false;
  if (version.state === 'published') {
    // 发布后再修改必须形成新版本：从已发布基线分叉 v(n+1) 草稿。
    target = {
      id: uuid(),
      scenarioId,
      versionNo: version.versionNo + 1,
      state: 'draft',
      revision: 0,
      basedOnVersionId: version.id,
      copiedFrom: null,
      inputs: structuredClone(version.inputs),
      approvals: [],
      createdBy: actor.user,
      createdAt: now(),
      publishedBy: null,
      publishedAt: null,
    };
    store.data.versions[target.id] = target;
    forked = true;
  }

  target.inputs = normalizeInputs(patch, target.inputs);
  target.revision += 1;
  store.audit(actor, forked ? 'version.fork_and_edit' : 'version.edit', {
    scenarioId,
    versionNo: target.versionNo,
    detail: { fromVersionNo: forked ? version.versionNo : undefined, revision: target.revision },
  });
  store.save();
  return { version: target, forked };
}

// ---------- 审批与发布 ----------
export function approveVersion(store, actor, scenarioId, versionNo, body) {
  mustScenario(store, scenarioId);
  const { decision, comment = '' } = body ?? {};
  if (!['approved', 'rejected'].includes(decision)) throw bad('decision 须为 approved 或 rejected');
  const version = mustVersion(store, scenarioId, versionNo);
  if (version.state !== 'draft') {
    throw new HttpError(409, 'version_immutable', '已发布版本不可再审批');
  }
  // 审批绑定当前 revision：审批后再改输入，旧审批自动失效（发布时校验）。
  const approval = {
    id: uuid(),
    actor: actor.user,
    decision,
    comment,
    revision: version.revision,
    at: now(),
  };
  version.approvals.push(approval);
  store.audit(actor, 'version.approve', {
    scenarioId,
    versionNo,
    detail: { decision, revision: version.revision },
  });
  store.save();
  return approval;
}

export function publishVersion(store, actor, scenarioId, versionNo) {
  mustScenario(store, scenarioId);
  const version = mustVersion(store, scenarioId, versionNo);
  const latest = store.latestVersion(scenarioId);
  if (version.id !== latest.id) throw new HttpError(409, 'version_not_latest', '只能发布最新版本');
  if (version.state !== 'draft') throw new HttpError(409, 'version_immutable', '该版本已发布');
  const ok = version.approvals.some((a) => a.decision === 'approved' && a.revision === version.revision);
  if (!ok) {
    throw new HttpError(409, 'approval_required', '发布前需要针对当前修订的"通过"审批');
  }
  version.state = 'published';
  version.publishedBy = actor.user;
  version.publishedAt = now();
  store.audit(actor, 'version.publish', { scenarioId, versionNo });
  store.save();
  return version;
}

// ---------- 计算作业 ----------
export function requestRun(store, actor, scenarioId, versionNo) {
  const scenario = mustScenario(store, scenarioId);
  const version = mustVersion(store, scenarioId, versionNo);
  // 快照输入与情景参数：之后草稿再改也不影响本次计算的可追溯性。
  const inputSnapshot = structuredClone(version.inputs);
  const run = {
    id: uuid(),
    scenarioId,
    versionId: version.id,
    versionNo: version.versionNo,
    versionState: version.state,
    status: 'queued',
    requestedBy: actor.user,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    inputHash: inputHashOf(inputSnapshot),
    inputSnapshot,
    options: {
      baseDate: scenario.baseDate,
      horizonDays: scenario.horizonDays,
      reportingCurrency: scenario.reportingCurrency,
    },
    result: null,
  };
  store.data.runs[run.id] = run;
  store.audit(actor, 'run.request', { scenarioId, versionNo, detail: { runId: run.id } });
  store.save();
  return run;
}

// ---------- 导出与提醒（均标注采用的版本） ----------
export const versionLabel = (scenario, version) => `${scenario.name} · v${version.versionNo}`;

export function createExport(store, actor, scenarioId, versionNo, body = {}) {
  const scenario = mustScenario(store, scenarioId);
  const version = mustVersion(store, scenarioId, versionNo);
  const type = body.type ?? 'committee-pack';
  const run = store.latestCompletedRun(version.id);
  const record = {
    id: uuid(),
    scenarioId,
    versionId: version.id,
    versionNo: version.versionNo,
    versionState: version.state,
    label: versionLabel(scenario, version),
    type,
    inputHash: run?.inputHash ?? inputHashOf(version.inputs),
    runId: run?.id ?? null,
    summary: run?.result?.summary ?? null,
    dailyTotals: run?.result?.dailyTotals ?? null,
    createdBy: actor.user,
    createdAt: now(),
  };
  store.data.exports[record.id] = record;
  store.audit(actor, 'export.create', { scenarioId, versionNo, detail: { exportId: record.id, type } });
  store.save();
  return record;
}

export function createReminder(store, actor, scenarioId, versionNo, body = {}) {
  const scenario = mustScenario(store, scenarioId);
  const version = mustVersion(store, scenarioId, versionNo);
  if (typeof body.message !== 'string' || body.message.trim() === '') throw bad('message 必填');
  const record = {
    id: uuid(),
    scenarioId,
    versionId: version.id,
    versionNo: version.versionNo,
    label: versionLabel(scenario, version),
    message: body.message.trim(),
    audience: body.audience ?? 'treasury-committee',
    createdBy: actor.user,
    createdAt: now(),
  };
  store.data.reminders[record.id] = record;
  store.audit(actor, 'reminder.create', { scenarioId, versionNo, detail: { reminderId: record.id } });
  store.save();
  return record;
}
