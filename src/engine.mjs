// 压力计算引擎：纯函数，不修改传入的 inputs（基线保护的前提）。
// 输入：某情景版本的 inputs（余额/到期债务/承诺额度/汇率假设/冲击假设）。
// 输出：按 (国家, 币种, 日期) 的逐日滚动结果，每格带 lineage（公式 + 引用的输入 id）。

export const FORMULAS = {
  closing: 'closing = opening - debtDue + drawdown - locked',
  gap: 'gap = max(0, -closing)',
  gapInReporting: 'gapInReporting = gap * fxRate(当日含冲击汇率)',
  drawdown: 'drawdown = min(max(0, debtDue - max(0, opening)), 当日可用额度剩余), 融资窗口关闭时为 0',
};

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const r6 = (x) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;

export function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 稳定序列化（键排序），用于输入快照哈希，保证同一输入永远得到同一哈希。
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function computeStress(rawInputs, opts) {
  const { baseDate, horizonDays = 14, reportingCurrency } = opts;
  // 深拷贝快照，引擎内部任何归一化都不触碰调用方对象。
  const inputs = structuredClone(rawInputs);
  const balances = inputs.balances ?? [];
  const debts = inputs.debts ?? [];
  const facilities = inputs.facilities ?? [];
  const fxRates = inputs.fxRates ?? [];
  const shocks = inputs.shocks ?? {};
  const fxShocks = shocks.fx ?? [];
  const frozenAccounts = shocks.frozenAccounts ?? [];
  const revokedFacilities = new Set(shocks.revokedFacilities ?? []);
  const closures = shocks.financingClosed ?? [];

  const dates = Array.from({ length: horizonDays }, (_, i) => addDays(baseDate, i));
  const lastDate = dates[dates.length - 1];

  // 以 (国家, 币种) 为资金桶，来源涵盖三类输入。
  const buckets = new Map();
  const ensure = (country, currency) => {
    const k = `${country}|${currency}`;
    if (!buckets.has(k)) buckets.set(k, { country, currency });
    return buckets.get(k);
  };
  for (const b of balances) ensure(b.country, b.currency);
  for (const d of debts) ensure(d.country, d.currency);
  for (const f of facilities) ensure(f.country, f.currency);

  // 汇率假设按币种排序，便于"取不晚于当日的最近一条"（部分日期缺失时向前沿用并打标）。
  const fxByCurrency = new Map();
  for (const r of fxRates) {
    if (!fxByCurrency.has(r.currency)) fxByCurrency.set(r.currency, []);
    fxByCurrency.get(r.currency).push(r);
  }
  for (const arr of fxByCurrency.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));

  function resolveFx(currency, date) {
    if (currency === reportingCurrency) return { rate: 1, stale: false, missing: false, sourceIds: [] };
    const arr = fxByCurrency.get(currency);
    if (!arr || arr.length === 0) return { rate: null, stale: false, missing: true, sourceIds: [] };
    let chosen = null;
    for (const r of arr) {
      if (r.date <= date) chosen = r;
      else break;
    }
    if (!chosen) return { rate: null, stale: false, missing: true, sourceIds: [] };
    return { rate: chosen.rate, stale: chosen.date < date, missing: false, sourceIds: [chosen.id] };
  }

  // 极端汇率回放：fromDate 起全部生效的 pct 跳变做乘法叠加。
  function applyFxShocks(currency, date, baseRate) {
    if (baseRate == null) return { rate: null, applied: [] };
    let rate = baseRate;
    const applied = [];
    for (const s of fxShocks) {
      if (s.currency === currency && date >= s.fromDate) {
        rate *= 1 + s.pct;
        applied.push(s.id);
      }
    }
    return { rate: r6(rate), applied };
  }

  const isWindowClosed = (country, currency, date) =>
    closures.some(
      (c) =>
        (!c.country || c.country === country) &&
        (!c.currency || c.currency === currency) &&
        date >= (c.fromDate ?? baseDate),
    );

  const cells = [];
  const totals = new Map(
    dates.map((d) => [d, { date: d, gapInReporting: 0, incomplete: false, unconvertible: [] }]),
  );

  for (const { country, currency } of buckets.values()) {
    const bBalances = balances.filter((b) => b.country === country && b.currency === currency);
    const bDebts = debts.filter((d) => d.country === country && d.currency === currency);
    const bFacilities = facilities.filter((f) => f.country === country && f.currency === currency);
    const activeFacilities = bFacilities.filter((f) => !revokedFacilities.has(f.id));
    const revokedHere = bFacilities.filter((f) => revokedFacilities.has(f.id));

    // 承诺额度随提取递减（revolving 剩余额度），按 id 排序保证分配确定性。
    const facState = activeFacilities
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((f) => ({ f, remaining: f.limit }));

    const freeze = frozenAccounts.find(
      (z) =>
        z.country === country &&
        z.currency === currency &&
        (!z.account || bBalances.some((b) => b.account === z.account)),
    );
    const frozenPool = freeze
      ? freeze.account
        ? bBalances.filter((b) => b.account === freeze.account)
        : bBalances
      : [];
    const frozenAmount = r2(frozenPool.reduce((s, b) => s + b.amount, 0));
    const freezeFrom = freeze ? (freeze.fromDate ?? baseDate) : null;
    // 冻结生效日落在窗口内时，在该日一次性锁定；早于基期则基期首日锁定。
    const lockDay = freeze ? (freezeFrom < baseDate ? baseDate : freezeFrom) : null;

    let prevClosing = r2(bBalances.reduce((s, b) => s + b.amount, 0));

    for (const date of dates) {
      const inputIds = [];
      const dataGaps = [];
      const opening = prevClosing;
      if (bBalances.length > 0) inputIds.push(...bBalances.map((b) => b.id));
      else dataGaps.push('no_balance_records_assumed_zero');

      const dueItems = bDebts.filter((d) => d.dueDate === date);
      const debtDue = r2(dueItems.reduce((s, d) => s + d.amount, 0));
      inputIds.push(...dueItems.map((d) => d.id));

      const availableToday = facState.filter((s) => s.f.start <= date && date <= s.f.end);
      const facilityAvailable = r2(availableToday.reduce((s, x) => s + x.remaining, 0));
      inputIds.push(...availableToday.map((s) => s.f.id));
      inputIds.push(...revokedHere.map((f) => f.id));

      const locked = lockDay === date ? frozenAmount : 0;
      if (freeze) inputIds.push(freeze.id);

      const need = Math.max(0, r2(debtDue - Math.max(0, opening)));
      const windowClosed = isWindowClosed(country, currency, date);
      let drawdown = 0;
      if (!windowClosed && need > 0) {
        let left = Math.min(need, facilityAvailable);
        for (const s of availableToday) {
          if (left <= 0) break;
          const take = Math.min(s.remaining, left);
          s.remaining = r2(s.remaining - take);
          left = r2(left - take);
          drawdown = r2(drawdown + take);
        }
      }

      const closing = r2(opening - debtDue + drawdown - locked);
      const gap = r2(Math.max(0, -closing));

      const fx = resolveFx(currency, date);
      inputIds.push(...fx.sourceIds);
      const shocked = applyFxShocks(currency, date, fx.rate);
      const gapInReporting = shocked.rate == null ? null : r2(gap * shocked.rate);
      if (fx.missing) dataGaps.push('fx_rate_missing');
      else if (fx.stale) dataGaps.push('fx_rate_carried_forward');

      const cell = {
        country,
        currency,
        date,
        opening,
        debtDue,
        facilityAvailable,
        drawdown,
        locked,
        windowClosed,
        closing,
        gap,
        fxRate: shocked.rate,
        gapInReporting,
        dataGaps,
        lineage: {
          formulas: FORMULAS,
          inputs: [...new Set(inputIds)],
          shocksApplied: shocked.applied,
        },
      };
      cells.push(cell);

      const t = totals.get(date);
      if (gapInReporting == null) {
        t.incomplete = true;
        if (gap > 0) t.unconvertible.push(`${country}/${currency}`);
      } else {
        t.gapInReporting = r2(t.gapInReporting + gapInReporting);
      }
      if (dataGaps.length > 0) t.incomplete = true;

      prevClosing = closing; // 跨日滚动：今日收盘即明日开盘
    }
  }

  const dailyTotals = dates.map((d) => {
    const t = totals.get(d);
    return {
      date: d,
      gapInReporting: r2(t.gapInReporting),
      incomplete: t.incomplete,
      unconvertible: t.unconvertible,
    };
  });
  const worst = dailyTotals.reduce(
    (acc, t) => (t.gapInReporting > acc.gapInReporting ? t : acc),
    { date: null, gapInReporting: 0 },
  );

  return {
    meta: {
      baseDate,
      horizonDays,
      reportingCurrency,
      window: { from: dates[0], to: lastDate },
      formulas: FORMULAS,
    },
    cells,
    dailyTotals,
    summary: {
      maxDailyGapInReporting: worst.gapInReporting,
      maxGapDate: worst.date,
      currencies: [...new Set(cells.map((c) => c.currency))],
      countries: [...new Set(cells.map((c) => c.country))],
    },
  };
}
