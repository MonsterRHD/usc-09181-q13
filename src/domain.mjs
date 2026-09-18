// 领域操作层：所有会改变状态的用例都收敛在这里。
// 每个操作负责：业务规则校验 → 修改状态 → 写审计 → 落盘。
// 权限校验在 HTTP 层完成（见 app.mjs），这里只保证领域不变量：
//   - 已发布版本不可变，发布后修改必须派生新版本；
//   - 每个情景至多一个草稿版本；
//   - 乐观锁：所有修改必须携带 baseRevision，不一致即冲突；
//   - 计算任务入队即落盘，崩溃后可恢复续跑。

import {
  HttpError, badRequest, conflict, notFound,
  isoDate, todayISO, nowISO, normCurrency, normCountry, num, intInRange, nonEmptyString, clone,
} from './util.mjs';
import { computeVersion } from './calc.mjs';

// ---------------------------------------------------------------- 数据集导入

const KIND_DEFS = {
  balances: {
    key: 'balances', prefix: 'BAL',
    normalize(row) {
      return {
        country: normCountry(row.country),
        currency: normCurrency(row.currency),
        amount: num(row.amount, 'amount'), // 允许负数（透支账户）
        asOfDate: row.asOfDate ? isoDate(row.asOfDate, 'asOfDate') : todayISO(),
        frozen: row.frozen === true,
      };
    },
  },
  debts: {
    key: 'debts', prefix: 'DEBT',
    normalize(row) {
      return {
        country: normCountry(row.country),
        currency: normCurrency(row.currency),
        amount: num(row.amount, 'amount', { min: 0.000001 }),
        maturityDate: isoDate(row.maturityDate, 'maturityDate'),
        counterparty: row.counterparty ? nonEmptyString(row.counterparty, 'counterparty') : null,
      };
    },
  },
  'credit-lines': {
    key: 'creditLines', prefix: 'CL',
    normalize(row) {
      const status = row.status ?? 'committed';
      if (!['committed', 'revoked'].includes(status)) throw badRequest(`status 只能是 committed/revoked，收到：${status}`);
      return {
        country: normCountry(row.country),
        currency: normCurrency(row.currency),
        limit: num(row.limit, 'limit', { min: 0 }),
        drawn: row.drawn === undefined ? 0 : num(row.drawn, 'drawn', { min: 0 }),
        expiryDate: isoDate(row.expiryDate, 'expiryDate'),
        status,
      };
    },
  },
  fx: {
    key: 'fx', prefix: 'FX',
    normalize(row) {
      const out = {
        base: normCurrency(row.base, 'base'),
        quote: normCurrency(row.quote, 'quote'),
        date: isoDate(row.date, 'date'),
        rate: num(row.rate, 'rate', { min: 0.000001 }),
      };
      if (out.base === out.quote) throw badRequest('base 与 quote 不能相同');
      return out;
    },
  },
};

export const DATASET_KINDS = Object.keys(KIND_DEFS);

// 批量导入：逐行校验，有效行入库（带 id 的行做替换式修订），无效行进入 rejected，
// 部分数据缺失/错误不会污染已有基线数据。
export function importRows(store, kind, rows, user) {
  const def = KIND_DEFS[kind];
  if (!def) throw notFound(`未知数据集类型：${kind}，可选：${DATASET_KINDS.join(', ')}`);
  if (!Array.isArray(rows) || rows.length === 0) throw badRequest('rows 必须是非空数组');
  if (rows.length > 5000) throw badRequest('单次导入不能超过 5000 行');

  const dataset = store.state.datasets[def.key];
  const imported = [];
  const rejected = [];
  rows.forEach((row, i) => {
    try {
      const value = def.normalize(row || {});
      if (row && row.id !== undefined) {
        const existing = dataset.find((r) => r.id === row.id);
        if (!existing) throw badRequest(`找不到要修订的记录 id：${row.id}`);
        Object.assign(existing, value);
        imported.push(existing);
      } else {
        const record = { id: store.nextId(def.prefix), ...value };
        dataset.push(record);
        imported.push(record);
      }
    } catch (err) {
      rejected.push({ index: i, row, reason: err.message });
    }
  });

  store.audit({ user: user.id, role: user.role, action: 'dataset.import', entity: kind, detail: { imported: imported.length, rejected: rejected.length } });
  store.save();
  return { imported, rejected };
}

// 撤销承诺额度（数据集级）：影响之后所有新计算，已产生的版本结果因持有快照而不变
export function revokeCreditLine(store, id, user) {
  const line = store.state.datasets.creditLines.find((r) => r.id === id);
  if (!line) throw notFound(`承诺额度不存在：${id}`);
  const already = line.status === 'revoked';
  line.status = 'revoked';
  line.revokedAt = nowISO();
  line.revokedBy = user.id;
  store.audit({ user: user.id, role: user.role, action: 'credit-line.revoke', entity: id, detail: { already } });
  store.save();
  return { id, status: line.status, already };
}

// ---------------------------------------------------------------- 情景与版本

function normScope(scope) {
  if (scope === undefined || scope === null) return { countries: null, currencies: null };
  if (typeof scope !== 'object') throw badRequest('scope 必须是对象');
  const normList = (list, norm, field) => {
    if (list === undefined || list === null) return null;
    if (!Array.isArray(list) || list.length === 0) throw badRequest(`${field} 必须是非空数组`);
    return [...new Set(list.map((v) => norm(v, field)))].sort();
  };
  return {
    countries: normList(scope.countries, normCountry, 'scope.countries'),
    currencies: normList(scope.currencies, normCurrency, 'scope.currencies'),
  };
}

function normParams(p) {
  return {
    baseCurrency: normCurrency(p.baseCurrency ?? 'CNY', 'baseCurrency'),
    startDate: p.startDate ? isoDate(p.startDate, 'startDate') : todayISO(),
    horizonDays: p.horizonDays === undefined ? 14 : intInRange(p.horizonDays, 'horizonDays', 1, 62),
    scope: normScope(p.scope),
  };
}

function normAdjustment(store, a) {
  if (!a || typeof a !== 'object') throw badRequest('调整项必须是对象');
  switch (a.type) {
    case 'freeze-account': {
      const id = nonEmptyString(a.accountId, 'accountId');
      if (!store.state.datasets.balances.some((b) => b.id === id)) throw badRequest(`账户余额记录不存在：${id}`);
      return { type: a.type, accountId: id };
    }
    case 'revoke-credit-line': {
      const id = nonEmptyString(a.creditLineId, 'creditLineId');
      if (!store.state.datasets.creditLines.some((c) => c.id === id)) throw badRequest(`承诺额度不存在：${id}`);
      return { type: a.type, creditLineId: id };
    }
    case 'fx-shock':
      return { type: a.type, currency: normCurrency(a.currency), pct: num(a.pct, 'pct', { min: -0.99, max: 10 }) };
    case 'fx-override':
      return { type: a.type, currency: normCurrency(a.currency), date: isoDate(a.date, 'date'), rate: num(a.rate, 'rate', { min: 0.000001 }) };
    default:
      throw badRequest(`未知调整类型：${a.type}，可选：freeze-account / revoke-credit-line / fx-shock / fx-override`);
  }
}

// 为调整项分配版本内唯一 id（复制/派生时重新分配，保证全库唯一）
function assignAdjustmentIds(store, adjustments) {
  return adjustments.map((a) => ({ ...a, id: store.nextId('ADJ') }));
}

export function findScenario(store, scenarioId) {
  const sc = store.state.scenarios.find((s) => s.id === scenarioId);
  if (!sc) throw notFound(`情景不存在：${scenarioId}`);
  return sc;
}

export function findVersion(sc, versionNo) {
  const v = sc.versions.find((x) => x.versionNo === Number(versionNo));
  if (!v) throw notFound(`情景 ${sc.id} 不存在版本 v${versionNo}`);
  return v;
}

function requireDraft(v, scenarioId) {
  if (v.state === 'published') {
    throw conflict('已发布版本不可修改，请基于该版本派生新版本', {
      reason: 'version-immutable',
      hint: `POST /api/scenarios/${scenarioId}/versions 可基于最新版本创建新草稿`,
    });
  }
}

// 乐观锁：客户端必须基于自己看到的 revision 修改，防止并发编辑互相覆盖
function checkRevision(v, baseRevision) {
  if (baseRevision === undefined || baseRevision === null) throw badRequest('缺少 baseRevision（乐观锁），请先读取版本再修改');
  if (v.revision !== Number(baseRevision)) {
    throw conflict('该版本已被他人修改，请刷新后基于最新 revision 重试', { currentRevision: v.revision });
  }
}

function touch(v, user) {
  v.revision += 1;
  v.updatedAt = nowISO();
  v.updatedBy = user.id;
}

export function createScenario(store, payload, user) {
  const name = nonEmptyString(payload.name, 'name');
  const params = normParams(payload);
  const adjustments = assignAdjustmentIds(store, (payload.adjustments || []).map((a) => normAdjustment(store, a)));
  const scenario = {
    id: store.nextId('SC'),
    name,
    createdBy: user.id,
    createdAt: nowISO(),
    publishedVersionNo: null,
    versions: [{
      versionNo: 1,
      revision: 0,
      state: 'draft',
      params,
      adjustments,
      approvals: [],
      calc: null,
      createdBy: user.id,
      createdAt: nowISO(),
      publishedBy: null,
      publishedAt: null,
    }],
  };
  store.state.scenarios.push(scenario);
  store.audit({ user: user.id, role: user.role, action: 'scenario.create', entity: scenario.id, detail: { name } });
  store.save();
  return scenario;
}

// 情景复制：完整复制指定版本的参数与调整项为全新情景的 v1 基线，原情景不受任何影响
export function copyScenario(store, scenarioId, payload, user) {
  const src = findScenario(store, scenarioId);
  const srcVersion = payload.fromVersion ? findVersion(src, payload.fromVersion) : src.versions[src.versions.length - 1];
  const copy = {
    id: store.nextId('SC'),
    name: payload.name ? nonEmptyString(payload.name, 'name') : `${src.name}（副本）`,
    createdBy: user.id,
    createdAt: nowISO(),
    copiedFrom: { scenarioId: src.id, versionNo: srcVersion.versionNo },
    publishedVersionNo: null,
    versions: [{
      versionNo: 1,
      revision: 0,
      state: 'draft',
      params: clone(srcVersion.params),
      adjustments: assignAdjustmentIds(store, clone(srcVersion.adjustments)),
      approvals: [],
      calc: null,
      createdBy: user.id,
      createdAt: nowISO(),
      publishedBy: null,
      publishedAt: null,
    }],
  };
  store.state.scenarios.push(copy);
  store.audit({ user: user.id, role: user.role, action: 'scenario.copy', entity: copy.id, detail: { from: src.id, fromVersion: srcVersion.versionNo } });
  store.save();
  return copy;
}

// 派生新版本：发布后修改的唯一入口。复制源版本的参数与调整项，审批与计算重新开始
export function createVersion(store, scenarioId, payload, user) {
  const sc = findScenario(store, scenarioId);
  if (sc.versions.some((v) => v.state === 'draft')) throw conflict('已存在未发布的草稿版本，请先发布或基于它继续修改');
  const src = payload.fromVersion ? findVersion(sc, payload.fromVersion) : sc.versions[sc.versions.length - 1];
  const v = {
    versionNo: Math.max(...sc.versions.map((x) => x.versionNo)) + 1,
    revision: 0,
    state: 'draft',
    params: clone(src.params),
    adjustments: assignAdjustmentIds(store, clone(src.adjustments)),
    approvals: [],
    calc: null,
    createdBy: user.id,
    createdAt: nowISO(),
    publishedBy: null,
    publishedAt: null,
  };
  sc.versions.push(v);
  store.audit({ user: user.id, role: user.role, action: 'scenario.version.create', entity: sc.id, detail: { versionNo: v.versionNo, fromVersion: src.versionNo } });
  store.save();
  return v;
}

export function updateParams(store, scenarioId, versionNo, payload, user) {
  const sc = findScenario(store, scenarioId);
  const v = findVersion(sc, versionNo);
  requireDraft(v, scenarioId);
  checkRevision(v, payload.baseRevision);
  v.params = normParams({ ...v.params, ...payload });
  touch(v, user);
  store.audit({ user: user.id, role: user.role, action: 'scenario.version.params', entity: sc.id, detail: { versionNo: v.versionNo, revision: v.revision } });
  store.save();
  return v;
}

// 整体替换调整项（输入修订）；已发布版本在此被拦截，只能派生新版本
export function setAdjustments(store, scenarioId, versionNo, payload, user) {
  const sc = findScenario(store, scenarioId);
  const v = findVersion(sc, versionNo);
  requireDraft(v, scenarioId);
  checkRevision(v, payload.baseRevision);
  if (!Array.isArray(payload.adjustments)) throw badRequest('adjustments 必须是数组');
  v.adjustments = assignAdjustmentIds(store, payload.adjustments.map((a) => normAdjustment(store, a)));
  touch(v, user);
  store.audit({ user: user.id, role: user.role, action: 'scenario.version.adjustments.set', entity: sc.id, detail: { versionNo: v.versionNo, count: v.adjustments.length, revision: v.revision } });
  store.save();
  return v;
}

export function addAdjustment(store, scenarioId, versionNo, payload, user) {
  const sc = findScenario(store, scenarioId);
  const v = findVersion(sc, versionNo);
  requireDraft(v, scenarioId);
  checkRevision(v, payload.baseRevision);
  const [withId] = assignAdjustmentIds(store, [normAdjustment(store, payload.adjustment ?? payload)]);
  v.adjustments.push(withId);
  touch(v, user);
  store.audit({ user: user.id, role: user.role, action: 'scenario.version.adjustments.add', entity: sc.id, detail: { versionNo: v.versionNo, adjustment: withId, revision: v.revision } });
  store.save();
  return v;
}

// ---------------------------------------------------------------- 审批与发布

export function approveVersion(store, scenarioId, versionNo, payload, user) {
  const sc = findScenario(store, scenarioId);
  const v = findVersion(sc, versionNo);
  requireDraft(v, scenarioId);
  if (v.approvals.some((a) => a.user === user.id)) throw conflict(`用户 ${user.id} 已审批过该版本`);
  v.approvals.push({ user: user.id, role: user.role, at: nowISO(), comment: payload.comment ? nonEmptyString(payload.comment, 'comment', 500) : null });
  store.audit({ user: user.id, role: user.role, action: 'scenario.version.approve', entity: sc.id, detail: { versionNo: v.versionNo } });
  store.save();
  return v;
}

// 发布：只有获授权角色可调用（HTTP 层把关）；此处保证「有审批 + 计算结果未过期」
export function publishVersion(store, scenarioId, versionNo, user) {
  const sc = findScenario(store, scenarioId);
  const v = findVersion(sc, versionNo);
  if (v.state === 'published') throw conflict(`版本 v${v.versionNo} 已是发布状态`);
  if (v.approvals.length === 0) throw conflict('发布前至少需要一条审批记录');
  if (!v.calc || v.calc.status !== 'done') throw conflict('发布前必须先完成计算');
  if (v.calc.revision !== v.revision) throw conflict('计算结果已过期（输入在计算后被修改），请重新计算后再发布');
  v.state = 'published';
  v.publishedBy = user.id;
  v.publishedAt = nowISO();
  sc.publishedVersionNo = v.versionNo;
  store.audit({ user: user.id, role: user.role, action: 'scenario.version.publish', entity: sc.id, detail: { versionNo: v.versionNo } });
  store.save();
  return v;
}

// ---------------------------------------------------------------- 计算任务与恢复

// 入队即落盘：即使进程在计算中途崩溃，恢复时也能发现未完成任务并重跑
export function enqueueCalculation(store, scenarioId, versionNo, user) {
  const sc = findScenario(store, scenarioId);
  const v = findVersion(sc, versionNo);
  const job = {
    id: store.nextId('JOB'),
    type: 'calc',
    scenarioId: sc.id,
    versionNo: v.versionNo,
    revision: v.revision,
    status: 'queued',
    enqueuedBy: user.id,
    enqueuedAt: nowISO(),
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  store.state.jobs.push(job);
  store.audit({ user: user.id, role: user.role, action: 'calc.enqueue', entity: job.id, detail: { scenarioId: sc.id, versionNo: v.versionNo, revision: v.revision } });
  store.save();
  return job;
}

export function runJob(store, job) {
  job.status = 'running';
  job.startedAt = nowISO();
  store.save();
  try {
    const sc = findScenario(store, job.scenarioId);
    const v = findVersion(sc, job.versionNo);
    const result = computeVersion({ scenario: sc, version: v, datasets: store.state.datasets });
    v.calc = { status: 'done', calcId: job.id, calculatedAt: nowISO(), revision: v.revision, result };
    job.status = 'done';
    job.finishedAt = nowISO();
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = nowISO();
  }
  store.save();
  return job;
}

// 启动恢复：重跑所有未完成的计算任务；已发布报告本就随状态落盘，无需特殊处理
export function recoverStore(store) {
  const pending = store.state.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  for (const job of pending) runJob(store, job);
  const publishedReports = [];
  for (const sc of store.state.scenarios) {
    for (const v of sc.versions) {
      if (v.state === 'published' && v.calc?.status === 'done') publishedReports.push(`${sc.id}#v${v.versionNo}`);
    }
  }
  const report = { recoveredJobs: pending.map((j) => j.id), publishedReports, recoveredAt: nowISO() };
  store.recoveryReport = report;
  if (pending.length > 0) store.save();
  return report;
}

// ---------------------------------------------------------------- 查询、提醒与导出

export function getCalcResult(store, scenarioId, versionNo) {
  const sc = findScenario(store, scenarioId);
  const v = findVersion(sc, versionNo);
  if (!v.calc || v.calc.status !== 'done') throw conflict(`版本 v${v.versionNo} 尚未完成计算，请先调用 calculate`);
  return { sc, v, result: v.calc.result };
}

// 按国家/币种/日期过滤结果视图；过滤后按行重新聚合合计，不改动存储中的原始结果
export function filterResult(result, { country, currency, from, to }) {
  const cFilter = country ? normCountry(country) : null;
  const curFilter = currency ? normCurrency(currency) : null;
  if (from) isoDate(from, 'from');
  if (to) isoDate(to, 'to');
  const days = result.days
    .filter((d) => (!from || d.date >= from) && (!to || d.date <= to))
    .map((d) => {
      const lines = d.lines.filter((l) => (!cFilter || l.country === cFilter) && (!curFilter || l.currency === curFilter));
      const totals = { closingBase: 0, shortfallBase: 0, fundingGapBase: 0, debtOutBase: 0, creditAvailableBase: 0, unconverted: [] };
      for (const l of lines) {
        if (l.closingBase === null) {
          totals.unconverted.push({ country: l.country, currency: l.currency, closing: l.closing, fundingGap: l.fundingGap });
        } else {
          totals.closingBase += l.closingBase;
          totals.shortfallBase += l.shortfallBase;
          totals.fundingGapBase += l.fundingGapBase;
          totals.debtOutBase += l.debtOutBase;
          totals.creditAvailableBase += l.creditAvailableBase;
        }
      }
      for (const k of ['closingBase', 'shortfallBase', 'fundingGapBase', 'debtOutBase', 'creditAvailableBase']) {
        totals[k] = Math.round((totals[k] + Number.EPSILON) * 100) / 100;
      }
      return { ...d, lines, totals };
    });
  return { ...result, days, filtered: { country: cFilter, currency: curFilter, from: from ?? null, to: to ?? null } };
}

// 提醒：全部基于某个具体版本的计算结果生成，并标注所采用的版本
export function getReminders(store, scenarioId, versionNo) {
  const { sc, v, result } = getCalcResult(store, scenarioId, versionNo);
  const label = versionLabel(sc, v);
  const reminders = [];
  for (const day of result.days) {
    if (day.totals.fundingGapBase > 0) {
      reminders.push({ ...label, type: 'funding-gap', date: day.date, amountBase: day.totals.fundingGapBase, currency: result.params.baseCurrency, message: `${day.date} 预计资金缺口 ${day.totals.fundingGapBase} ${result.params.baseCurrency}` });
    }
    for (const line of day.lines) {
      if (line.debtOut > 0) {
        reminders.push({ ...label, type: 'debt-maturity', date: day.date, country: line.country, currency: line.currency, amount: line.debtOut, message: `${day.date} ${line.country}/${line.currency} 有到期债务 ${line.debtOut}` });
      }
    }
  }
  const horizonEnd = result.days[result.days.length - 1]?.date;
  for (const cl of result.inputSnapshot.creditLines) {
    if (cl.expiryDate <= horizonEnd && cl.status !== 'revoked') {
      reminders.push({ ...label, type: 'credit-expiry', date: cl.expiryDate, creditLineId: cl.id, country: cl.country, currency: cl.currency, message: `承诺额度 ${cl.id}（${cl.country}/${cl.currency}）将于 ${cl.expiryDate} 到期` });
    }
  }
  for (const w of result.warnings) {
    if (w.type === 'fx-missing') reminders.push({ ...label, type: 'fx-missing', date: w.date, currency: w.currency, message: w.message });
  }
  return { version: label, reminders };
}

// 全局提醒：汇总所有情景最新已发布版本的提醒，每条都标注采用的版本
export function getPublishedReminders(store) {
  const out = [];
  for (const sc of store.state.scenarios) {
    const published = sc.versions.filter((v) => v.state === 'published' && v.calc?.status === 'done');
    if (published.length === 0) continue;
    const latest = published[published.length - 1];
    out.push(...getReminders(store, sc.id, latest.versionNo).reminders);
  }
  return { reminders: out };
}

function versionLabel(sc, v) {
  return {
    scenarioId: sc.id,
    scenarioName: sc.name,
    versionNo: v.versionNo,
    versionState: v.state,
    revision: v.revision,
    calcRevision: v.calc?.revision ?? null,
    stale: v.calc ? v.calc.revision !== v.revision : null,
    publishedAt: v.publishedAt,
  };
}

// 导出：JSON 或 CSV，头部均标注采用的版本信息
export function exportVersion(store, scenarioId, versionNo, format, user) {
  const { sc, v, result } = getCalcResult(store, scenarioId, versionNo);
  const meta = {
    ...versionLabel(sc, v),
    exportedAt: nowISO(),
    exportedBy: user.id,
    baseCurrency: result.params.baseCurrency,
  };
  store.audit({ user: user.id, role: user.role, action: 'scenario.version.export', entity: sc.id, detail: { versionNo: v.versionNo, format } });
  store.save();

  if (format === 'csv') {
    const header = [
      `# scenario=${sc.id} name=${JSON.stringify(sc.name)} version=v${v.versionNo} state=${v.state} revision=${v.revision} publishedAt=${v.publishedAt ?? '-'} exportedAt=${meta.exportedAt}`,
      'date,country,currency,opening,debtOut,creditAvailable,closing,shortfall,fundingGap,fxRate,fxSource',
    ];
    const rows = [];
    for (const day of result.days) {
      for (const l of day.lines) {
        rows.push([l.date, l.country, l.currency, l.opening, l.debtOut, l.creditAvailable, l.closing, l.shortfall, l.fundingGap, l.fxRate ?? '', l.fxSource].join(','));
      }
    }
    return { contentType: 'text/csv; charset=utf-8', filename: `${sc.id}-v${v.versionNo}.csv`, body: [...header, ...rows].join('\n') + '\n' };
  }
  return {
    contentType: 'application/json; charset=utf-8',
    filename: `${sc.id}-v${v.versionNo}.json`,
    body: { meta, params: result.params, formulas: result.formulas, summary: result.summary, warnings: result.warnings, days: result.days },
  };
}
