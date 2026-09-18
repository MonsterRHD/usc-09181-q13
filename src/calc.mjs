// 流动性缺口计算引擎：纯函数，不触碰存储与网络。
//
// 输入：情景版本的参数（基准币、起始日、 horizon、范围）+ 调整项（冻结/撤额/汇率冲击/汇率覆盖）
//       + 基线数据集（账户余额、到期债务、承诺额度、汇率假设）。
// 输出：按 日期 × 国家 × 币种 的逐日头寸与缺口，每一行都带 trace
//       （来源输入记录 id、命中的调整项、汇率来源、公式说明），
//       并附带参与计算的输入快照，保证结果可回放、可审计、不依赖数据集的后续变化。

import { addDays, round2 } from './util.mjs';

export const FORMULAS = Object.freeze([
  'opening[d] = closing[d-1]；首日 opening = Σ 可用账户余额（冻结账户不计入）',
  'debtOut[d] = Σ 到期日等于 d 的债务（原币）',
  'creditAvailable[d] = Σ 当日有效且未撤销的承诺额度 (limit - drawn)',
  'closing[d] = opening[d] - debtOut[d]',
  'shortfall[d] = max(0, -closing[d])',
  'fundingGap[d] = max(0, shortfall[d] - creditAvailable[d])',
  'valueBase = value × fxRate(currency, d)；当日无汇率时向前滚动沿用最近可用汇率；fx-override 直接指定当日汇率（终态，不再叠加冲击），fx-shock 按 (1+pct) 顺序叠乘',
]);

// 把版本上的调整项整理成便于查找的索引
function indexAdjustments(adjustments) {
  const idx = {
    frozenAccounts: new Map(), // accountId -> adjId
    revokedLines: new Map(), // creditLineId -> adjId
    fxOverrides: new Map(), // `${ccy}|${date}` -> { rate, adjId }
    fxShocks: [], // [{ currency, pct, adjId }]
  };
  for (const adj of adjustments || []) {
    if (adj.type === 'freeze-account') idx.frozenAccounts.set(adj.accountId, adj.id);
    else if (adj.type === 'revoke-credit-line') idx.revokedLines.set(adj.creditLineId, adj.id);
    else if (adj.type === 'fx-override') idx.fxOverrides.set(`${adj.currency}|${adj.date}`, { rate: adj.rate, adjId: adj.id });
    else if (adj.type === 'fx-shock') idx.fxShocks.push({ currency: adj.currency, pct: adj.pct, adjId: adj.id });
  }
  return idx;
}

export function computeVersion({ scenario, version, datasets }) {
  const params = version.params;
  const base = params.baseCurrency;
  const scope = params.scope || {};
  const adj = indexAdjustments(version.adjustments);
  const warnings = [];

  const inScope = (row) =>
    (!scope.countries || scope.countries.includes(row.country)) &&
    (!scope.currencies || scope.currencies.includes(row.currency));

  // 输入快照：只保留进入计算口径的记录，结果可追溯且不受数据集后续变更影响
  const balances = datasets.balances.filter(inScope);
  const debts = datasets.debts.filter(inScope);
  const creditLines = datasets.creditLines.filter(inScope);
  const fxRows = datasets.fx.filter(
    (r) => r.base === base && (!scope.currencies || scope.currencies.includes(r.quote)),
  );

  // ---- 按 国家×币种 分组聚合期初余额、逐日债务与额度 ----
  const groups = new Map();
  const groupOf = (country, currency) => {
    const key = `${country}|${currency}`;
    if (!groups.has(key)) {
      groups.set(key, {
        country,
        currency,
        opening: 0,
        balanceIds: [],
        frozen: 0,
        frozenIds: [],
        debtsByDate: new Map(), // date -> { amount, ids }
        lines: [],
        adjustmentIds: new Set(),
      });
    }
    return groups.get(key);
  };

  for (const b of balances) {
    const g = groupOf(b.country, b.currency);
    const frozenByAdj = adj.frozenAccounts.has(b.id);
    if (b.frozen === true || frozenByAdj) {
      g.frozen += b.amount;
      g.frozenIds.push(b.id);
      if (frozenByAdj) g.adjustmentIds.add(adj.frozenAccounts.get(b.id));
    } else {
      g.opening += b.amount;
      g.balanceIds.push(b.id);
    }
  }
  for (const d of debts) {
    const g = groupOf(d.country, d.currency);
    if (!g.debtsByDate.has(d.maturityDate)) g.debtsByDate.set(d.maturityDate, { amount: 0, ids: [] });
    const e = g.debtsByDate.get(d.maturityDate);
    e.amount += d.amount;
    e.ids.push(d.id);
  }
  for (const cl of creditLines) {
    groupOf(cl.country, cl.currency).lines.push(cl);
  }

  // ---- 汇率解析：覆盖 > 当日精确 > 向前滚动 > 向后回填 > 缺失 ----
  const fxIndex = new Map(); // quote -> 按日期升序的行
  for (const r of fxRows) {
    if (!fxIndex.has(r.quote)) fxIndex.set(r.quote, []);
    fxIndex.get(r.quote).push(r);
  }
  for (const rows of fxIndex.values()) rows.sort((a, b) => (a.date < b.date ? -1 : 1));

  const rateCache = new Map();
  const resolveRate = (currency, date) => {
    if (currency === base) return { rate: 1, source: 'identity', fxId: null, shocks: [] };
    const cacheKey = `${currency}|${date}`;
    if (rateCache.has(cacheKey)) return rateCache.get(cacheKey);

    let resolved = null;
    const override = adj.fxOverrides.get(cacheKey);
    if (override) {
      resolved = { rate: override.rate, source: 'override', fxId: null, overrideAdjId: override.adjId };
    } else {
      const rows = fxIndex.get(currency) || [];
      const exact = rows.find((r) => r.date === date);
      if (exact) {
        resolved = { rate: exact.rate, source: 'exact', fxId: exact.id };
      } else {
        const earlier = [...rows].reverse().find((r) => r.date < date);
        if (earlier) resolved = { rate: earlier.rate, source: 'rolled-forward', fxId: earlier.id, rolledFrom: earlier.date };
        else {
          const later = rows.find((r) => r.date > date);
          if (later) resolved = { rate: later.rate, source: 'backfilled', fxId: later.id, rolledFrom: later.date };
        }
      }
    }
    if (!resolved) {
      rateCache.set(cacheKey, null);
      return null;
    }
    // 汇率冲击假设按顺序叠乘 (1 + pct)；fx-override 是显式指定的终态汇率，不再叠加冲击
    const shocks = resolved.source === 'override' ? [] : adj.fxShocks.filter((s) => s.currency === currency);
    let rate = resolved.rate;
    for (const s of shocks) rate *= 1 + s.pct;
    const out = { ...resolved, rate, shocks: shocks.map((s) => s.adjId) };
    rateCache.set(cacheKey, out);
    return out;
  };

  // ---- 逐日滚动计算 ----
  const dates = Array.from({ length: params.horizonDays }, (_, i) => addDays(params.startDate, i));
  const days = dates.map((date) => ({
    date,
    lines: [],
    totals: { closingBase: 0, shortfallBase: 0, fundingGapBase: 0, debtOutBase: 0, creditAvailableBase: 0, unconverted: [] },
  }));
  const missingFxCurrencies = new Set();

  for (const g of groups.values()) {
    let prevClosing = g.opening;
    dates.forEach((date, i) => {
      const day = days[i];
      const debtEntry = g.debtsByDate.get(date);
      const debtOut = debtEntry ? debtEntry.amount : 0;

      let creditAvailable = 0;
      const creditIds = [];
      const creditNotes = [];
      for (const cl of g.lines) {
        const revokedByAdj = adj.revokedLines.has(cl.id);
        const revoked = cl.status === 'revoked' || revokedByAdj;
        if (revoked) {
          creditNotes.push({ id: cl.id, status: 'revoked' });
          if (revokedByAdj) g.adjustmentIds.add(adj.revokedLines.get(cl.id));
          continue;
        }
        if (cl.expiryDate < date) {
          creditNotes.push({ id: cl.id, status: 'expired' });
          continue;
        }
        creditAvailable += Math.max(0, cl.limit - (cl.drawn || 0));
        creditIds.push(cl.id);
      }

      const opening = prevClosing;
      const closing = opening - debtOut;
      const shortfall = Math.max(0, -closing);
      const fundingGap = Math.max(0, shortfall - creditAvailable);

      const fx = resolveRate(g.currency, date);
      const toBase = (v) => (fx ? round2(v * fx.rate) : null);
      if (!fx && !missingFxCurrencies.has(g.currency)) {
        missingFxCurrencies.add(g.currency);
        warnings.push({
          type: 'fx-missing',
          currency: g.currency,
          date,
          message: `缺少 ${g.currency}→${base} 的汇率假设，${g.currency} 头寸未计入基准币种合计（详见当日 unconverted）`,
        });
      }
      if (fx && fx.source === 'backfilled' && !warnings.some((w) => w.type === 'fx-backfilled' && w.currency === g.currency)) {
        warnings.push({
          type: 'fx-backfilled',
          currency: g.currency,
          date,
          message: `${g.currency} 在 ${date} 之前无汇率假设，已回填使用 ${fx.rolledFrom} 的汇率`,
        });
      }

      const line = {
        date,
        country: g.country,
        currency: g.currency,
        opening: round2(opening),
        debtOut: round2(debtOut),
        creditAvailable: round2(creditAvailable),
        closing: round2(closing),
        shortfall: round2(shortfall),
        fundingGap: round2(fundingGap),
        fxRate: fx ? round2(fx.rate * 1000000) / 1000000 : null,
        fxSource: fx ? fx.source : 'missing',
        ...(fx && fx.rolledFrom ? { fxRolledFrom: fx.rolledFrom } : {}),
        openingBase: toBase(opening),
        debtOutBase: toBase(debtOut),
        creditAvailableBase: toBase(creditAvailable),
        closingBase: toBase(closing),
        shortfallBase: toBase(shortfall),
        fundingGapBase: toBase(fundingGap),
        trace: {
          balanceIds: g.balanceIds,
          frozenBalanceIds: g.frozenIds,
          debtIds: debtEntry ? debtEntry.ids : [],
          creditLineIds: creditIds,
          creditNotes,
          fxId: fx ? fx.fxId : null,
          adjustmentIds: [...g.adjustmentIds, ...(fx ? fx.shocks : []), ...(fx && fx.overrideAdjId ? [fx.overrideAdjId] : [])],
          formula: 'closing=opening-debtOut; shortfall=max(0,-closing); fundingGap=max(0,shortfall-creditAvailable); base=value×fxRate',
        },
      };
      day.lines.push(line);

      if (fx) {
        day.totals.closingBase += line.closingBase;
        day.totals.shortfallBase += line.shortfallBase;
        day.totals.fundingGapBase += line.fundingGapBase;
        day.totals.debtOutBase += line.debtOutBase;
        day.totals.creditAvailableBase += line.creditAvailableBase;
      } else {
        day.totals.unconverted.push({
          country: g.country,
          currency: g.currency,
          closing: line.closing,
          fundingGap: line.fundingGap,
        });
      }
      prevClosing = closing;
    });
  }

  for (const day of days) {
    day.totals.closingBase = round2(day.totals.closingBase);
    day.totals.shortfallBase = round2(day.totals.shortfallBase);
    day.totals.fundingGapBase = round2(day.totals.fundingGapBase);
    day.totals.debtOutBase = round2(day.totals.debtOutBase);
    day.totals.creditAvailableBase = round2(day.totals.creditAvailableBase);
  }

  // ---- 汇总指标 ----
  let maxGap = null;
  let firstGapDate = null;
  let worstClosing = null;
  for (const day of days) {
    if (day.totals.fundingGapBase > 0) {
      if (!firstGapDate) firstGapDate = day.date;
      if (!maxGap || day.totals.fundingGapBase > maxGap.amount) maxGap = { date: day.date, amount: day.totals.fundingGapBase };
    }
    if (!worstClosing || day.totals.closingBase < worstClosing.amount) worstClosing = { date: day.date, amount: day.totals.closingBase };
  }

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    versionNo: version.versionNo,
    generatedAt: new Date().toISOString(),
    params: structuredClone(params),
    formulas: FORMULAS,
    days,
    warnings,
    summary: {
      baseCurrency: base,
      maxFundingGapBase: maxGap,
      firstFundingGapDate: firstGapDate,
      worstClosingBase: worstClosing,
      countries: [...new Set([...groups.values()].map((g) => g.country))].sort(),
      currencies: [...new Set([...groups.values()].map((g) => g.currency))].sort(),
    },
    // 输入快照深拷贝：数据集后续变更（如撤销额度）不得回写已产生的结果
    inputSnapshot: {
      balances: structuredClone(balances),
      debts: structuredClone(debts),
      creditLines: structuredClone(creditLines),
      fx: structuredClone(fxRows),
    },
  };
}
