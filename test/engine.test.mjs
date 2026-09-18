// 引擎纯函数测试：缺口滚动、额度递减、冻结、撤销、窗口关闭、汇率回放、缺失数据、可追溯。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStress } from '../src/engine.mjs';

const OPTS = { baseDate: '2026-09-21', horizonDays: 3, reportingCurrency: 'USD' };
const D1 = '2026-09-21';
const D2 = '2026-09-22';
const D3 = '2026-09-23';
const at = (result, country, currency, date) =>
  result.cells.find((c) => c.country === country && c.currency === currency && c.date === date);

test('跨日滚动 + 承诺额度随提取递减，缺口在额度耗尽后出现', () => {
  const result = computeStress(
    {
      balances: [{ id: 'b1', country: 'CN', currency: 'USD', amount: 100 }],
      debts: [
        { id: 'd1', country: 'CN', currency: 'USD', amount: 150, dueDate: D2 },
        { id: 'd2', country: 'CN', currency: 'USD', amount: 80, dueDate: D3 },
      ],
      facilities: [{ id: 'f1', country: 'CN', currency: 'USD', limit: 100, start: D1, end: D3 }],
      fxRates: [],
      shocks: {},
    },
    OPTS,
  );
  const day1 = at(result, 'CN', 'USD', D1);
  const day2 = at(result, 'CN', 'USD', D2);
  const day3 = at(result, 'CN', 'USD', D3);
  assert.equal(day1.closing, 100);
  assert.equal(day2.opening, 100); // 昨日收盘 = 今日开盘
  assert.equal(day2.drawdown, 50);
  assert.equal(day2.closing, 0);
  assert.equal(day3.facilityAvailable, 50); // 额度已用掉 50
  assert.equal(day3.drawdown, 50);
  assert.equal(day3.gap, 30);
  assert.equal(result.dailyTotals.find((t) => t.date === D3).gapInReporting, 30);
});

test('海外账户冻结：冻结日锁定资金，后续日期滚动不再包含该资金', () => {
  const result = computeStress(
    {
      balances: [{ id: 'b1', country: 'CN', currency: 'USD', amount: 200 }],
      debts: [{ id: 'd1', country: 'CN', currency: 'USD', amount: 50, dueDate: D3 }],
      facilities: [],
      fxRates: [],
      shocks: { frozenAccounts: [{ id: 'z1', country: 'CN', currency: 'USD', fromDate: D2 }] },
    },
    OPTS,
  );
  assert.equal(at(result, 'CN', 'USD', D1).closing, 200);
  const day2 = at(result, 'CN', 'USD', D2);
  assert.equal(day2.locked, 200);
  assert.equal(day2.closing, 0);
  const day3 = at(result, 'CN', 'USD', D3);
  assert.equal(day3.opening, 0);
  assert.equal(day3.gap, 50);
});

test('撤销承诺额度：当日可用额度为 0，缺口完整暴露', () => {
  const result = computeStress(
    {
      balances: [{ id: 'b1', country: 'CN', currency: 'USD', amount: 100 }],
      debts: [{ id: 'd1', country: 'CN', currency: 'USD', amount: 150, dueDate: D1 }],
      facilities: [{ id: 'f1', country: 'CN', currency: 'USD', limit: 100, start: D1, end: D3 }],
      fxRates: [],
      shocks: { revokedFacilities: ['f1'] },
    },
    OPTS,
  );
  const day1 = at(result, 'CN', 'USD', D1);
  assert.equal(day1.facilityAvailable, 0);
  assert.equal(day1.drawdown, 0);
  assert.equal(day1.gap, 50);
  assert.ok(day1.lineage.inputs.includes('f1')); // 被撤销的额度也可追溯
});

test('融资窗口关闭：有额度也不予提取', () => {
  const result = computeStress(
    {
      balances: [{ id: 'b1', country: 'CN', currency: 'USD', amount: 100 }],
      debts: [{ id: 'd1', country: 'CN', currency: 'USD', amount: 150, dueDate: D1 }],
      facilities: [{ id: 'f1', country: 'CN', currency: 'USD', limit: 100, start: D1, end: D3 }],
      fxRates: [],
      shocks: { financingClosed: [{ id: 'c1' }] },
    },
    OPTS,
  );
  const day1 = at(result, 'CN', 'USD', D1);
  assert.equal(day1.windowClosed, true);
  assert.equal(day1.drawdown, 0);
  assert.equal(day1.gap, 50);
});

test('极端汇率回放：跳变自 fromDate 起生效，之前日期不受影响', () => {
  const debts = [D1, D2, D3].map((d, i) => ({
    id: `d${i}`,
    country: 'DE',
    currency: 'EUR',
    amount: 10,
    dueDate: d,
  }));
  const result = computeStress(
    {
      balances: [],
      debts,
      facilities: [],
      fxRates: [{ id: 'fx1', currency: 'EUR', date: D1, rate: 1.1 }],
      shocks: { fx: [{ id: 's1', currency: 'EUR', fromDate: D3, pct: 0.1 }] },
    },
    OPTS,
  );
  const day1 = at(result, 'DE', 'EUR', D1);
  const day3 = at(result, 'DE', 'EUR', D3);
  assert.equal(day1.fxRate, 1.1);
  assert.equal(day1.gapInReporting, 11); // 10 * 1.1
  assert.equal(day3.fxRate, 1.21); // 1.1 * 1.1
  assert.equal(day3.gap, 30);
  assert.equal(day3.gapInReporting, 36.3);
  assert.deepEqual(day3.lineage.shocksApplied, ['s1']);
});

test('部分数据缺失：缺汇率不报错，标记缺失且汇总标记不完整', () => {
  const result = computeStress(
    {
      balances: [],
      debts: [{ id: 'd1', country: 'DE', currency: 'EUR', amount: 5, dueDate: D1 }],
      facilities: [],
      fxRates: [],
      shocks: {},
    },
    OPTS,
  );
  const cell = at(result, 'DE', 'EUR', D1);
  assert.equal(cell.gap, 5);
  assert.equal(cell.gapInReporting, null);
  assert.ok(cell.dataGaps.includes('fx_rate_missing'));
  assert.ok(cell.dataGaps.includes('no_balance_records_assumed_zero'));
  const total = result.dailyTotals.find((t) => t.date === D1);
  assert.equal(total.incomplete, true);
  assert.deepEqual(total.unconvertible, ['DE/EUR']);
});

test('汇率缺失日期向前沿用最近一条并打标，当日有精确汇率则不打标', () => {
  const result = computeStress(
    {
      balances: [],
      debts: [{ id: 'd1', country: 'DE', currency: 'EUR', amount: 1, dueDate: D3 }],
      facilities: [],
      fxRates: [{ id: 'fx1', currency: 'EUR', date: D1, rate: 1.1 }],
      shocks: {},
    },
    OPTS,
  );
  assert.ok(!at(result, 'DE', 'EUR', D1).dataGaps.includes('fx_rate_carried_forward'));
  const day3 = at(result, 'DE', 'EUR', D3);
  assert.equal(day3.fxRate, 1.1);
  assert.ok(day3.dataGaps.includes('fx_rate_carried_forward'));
});

test('每个结果格可追溯到输入 id 与公式', () => {
  const result = computeStress(
    {
      balances: [{ id: 'b1', country: 'CN', currency: 'USD', amount: 100 }],
      debts: [{ id: 'd1', country: 'CN', currency: 'USD', amount: 150, dueDate: D2 }],
      facilities: [{ id: 'f1', country: 'CN', currency: 'USD', limit: 100, start: D1, end: D3 }],
      fxRates: [],
      shocks: {},
    },
    OPTS,
  );
  const cell = at(result, 'CN', 'USD', D2);
  assert.ok(cell.lineage.inputs.includes('b1'));
  assert.ok(cell.lineage.inputs.includes('d1'));
  assert.ok(cell.lineage.inputs.includes('f1'));
  assert.match(cell.lineage.formulas.closing, /opening - debtDue \+ drawdown - locked/);
  assert.match(result.meta.formulas.gap, /max\(0, -closing\)/);
});

test('计算不修改输入（基线保护）：计算前后输入序列化一致', () => {
  const inputs = {
    balances: [{ id: 'b1', country: 'CN', currency: 'USD', amount: 100 }],
    debts: [{ id: 'd1', country: 'CN', currency: 'USD', amount: 150, dueDate: D2 }],
    facilities: [{ id: 'f1', country: 'CN', currency: 'USD', limit: 100, start: D1, end: D3 }],
    fxRates: [{ id: 'fx1', currency: 'EUR', date: D1, rate: 1.1 }],
    shocks: { fx: [{ id: 's1', currency: 'EUR', fromDate: D2, pct: 0.2 }] },
  };
  const before = JSON.stringify(inputs);
  computeStress(inputs, OPTS);
  assert.equal(JSON.stringify(inputs), before);
});

test('多桶汇总：缺口按报告币种加总', () => {
  const result = computeStress(
    {
      balances: [],
      debts: [
        { id: 'd1', country: 'CN', currency: 'USD', amount: 30, dueDate: D1 },
        { id: 'd2', country: 'DE', currency: 'EUR', amount: 10, dueDate: D1 },
      ],
      facilities: [],
      fxRates: [{ id: 'fx1', currency: 'EUR', date: D1, rate: 1.1 }],
      shocks: {},
    },
    OPTS,
  );
  assert.equal(result.dailyTotals.find((t) => t.date === D1).gapInReporting, 41); // 30 + 10*1.1
  assert.equal(result.summary.maxDailyGapInReporting, 41);
  assert.equal(result.summary.maxGapDate, D1);
});
