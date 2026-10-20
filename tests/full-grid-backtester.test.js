const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FullGridBacktester,
  chooseSpacedLevels,
  entryDirectionAllows,
  maximumProfitableShortBuyPrice,
  minimumProfitableSellPrice,
  selectProfitableExitLevel,
  zoneForRank,
} = require('../src/full-grid-backtester');

const INTERVAL = 15 * 60_000;
const exchange = {
  priceToPrecision: (_symbol, value) => Number(value).toFixed(6),
  amountToPrecision: (_symbol, value) => Number(value).toFixed(8),
};

class FixedRangeBacktester extends FullGridBacktester {
  createRangeAdvisor() {
    return {
      buildSuggestion: () => ({ lower: 90, upper: 110, levels: [90, 100, 110] }),
      shouldAdoptSuggestion: previous => !previous,
    };
  }
}

function candle(index, open, high, low, close) {
  return [index * INTERVAL, open, high, low, close, 1];
}

test('a buy and its counter sell cannot fill inside the same 15m candle', () => {
  const simulator = new FixedRangeBacktester(exchange, {
    gridCount: 2,
    totalInvestment: 10,
    maxActiveBuyOrders: 2,
    candleLimit: 100,
    rangeRebuildCooldownMs: Infinity,
  });
  const rows = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 120, 80, 100),
  ];
  const result = simulator.simulate({
    symbol: 'TEST/USDT:USDT', rows, start: 0, end: 2 * INTERVAL, adaptive: false,
  });
  assert.equal(result.buyFills, 1);
  assert.equal(result.sellFills, 0);
});

test('the counter sell becomes eligible on the next candle', () => {
  const simulator = new FixedRangeBacktester(exchange, {
    gridCount: 2,
    totalInvestment: 10,
    maxActiveBuyOrders: 2,
    candleLimit: 100,
    rangeRebuildCooldownMs: Infinity,
  });
  const rows = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 120, 80, 100),
    candle(2, 100, 120, 99, 110),
  ];
  const result = simulator.simulate({
    symbol: 'TEST/USDT:USDT', rows, start: 0, end: 3 * INTERVAL, adaptive: false,
  });
  assert.equal(result.buyFills, 1);
  assert.equal(result.sellFills, 1);
  assert.ok(result.netLiquidationPnl > 0);
  assert.ok(Math.abs(result.accountingIdentityDelta) === 0);
});

test('minimum profitable sell includes entry fee, exit fee, and requested net profit', () => {
  const price = minimumProfitableSellPrice(
    { entryCost: 100, buyFee: 0.02, quantity: 1 },
    { makerFeeRate: 0.0002, minimumNetProfitPct: 0.05 }
  );
  assert.ok(price > 100.09);
  assert.ok(price < 100.11);
});

test('maximum profitable SHORT buy includes entry fee, exit fee, and requested net profit', () => {
  const price = maximumProfitableShortBuyPrice(
    { entryCost: 100, buyFee: 0.02, quantity: 1 },
    { makerFeeRate: 0.0002, minimumNetProfitPct: 0.05 }
  );
  assert.ok(price < 99.92);
  assert.ok(price > 99.9);
});

test('exit target offset skips Fibonacci levels symmetrically and clamps to the farthest level', () => {
  const levels = [90, 100, 110, 120, 130];
  assert.equal(selectProfitableExitLevel(levels, 100, 'LONG'), 110);
  assert.equal(selectProfitableExitLevel(levels, 100, 'LONG', { exitTargetLevelOffset: 1 }), 120);
  assert.equal(selectProfitableExitLevel(levels, 100, 'LONG', { exitTargetLevelOffset: 99 }), 130);
  assert.equal(selectProfitableExitLevel(levels, 120, 'SHORT'), 110);
  assert.equal(selectProfitableExitLevel(levels, 120, 'SHORT', { exitTargetLevelOffset: 1 }), 100);
  assert.equal(selectProfitableExitLevel(levels, 120, 'SHORT', { exitTargetFurthest: true }), 90);
});

test('SHORT simulation opens with SELL and closes with a lower BUY', () => {
  const simulator = new FixedRangeBacktester(exchange, {
    positionSide: 'SHORT',
    gridCount: 2,
    totalInvestment: 10,
    maxActiveBuyOrders: 2,
    candleLimit: 100,
    rangeRebuildCooldownMs: Infinity,
  });
  const rows = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 120, 99, 100),
    candle(2, 100, 101, 80, 90),
  ];
  const result = simulator.simulate({
    symbol: 'TEST/USDT:USDT', rows, start: 0, end: 3 * INTERVAL, adaptive: false,
  });
  assert.equal(result.buyFills, 1);
  assert.equal(result.sellFills, 1);
  assert.ok(result.netLiquidationPnl > 0);
  assert.ok(Math.abs(result.accountingIdentityDelta) === 0);
});

test('adaptive spacing removes adjacent levels when the requested gap is wider', () => {
  const levels = [100, 99, 98, 97, 96].map((price, levelIndex) => ({ price, levelIndex }));
  const selected = chooseSpacedLevels(levels, 1.4);
  assert.deepEqual(selected.map(item => item.price), [100, 98, 96]);
});

test('rank zones progress from upper to middle to lower', () => {
  assert.equal(zoneForRank(1, 9), 'upper');
  assert.equal(zoneForRank(5, 9), 'middle');
  assert.equal(zoneForRank(9, 9), 'lower');
});

test('entry direction gate mirrors BULLISH LONG and BEARISH SHORT', () => {
  const options = { longEntryDirection: 'BULLISH', shortEntryDirection: 'BEARISH' };
  assert.equal(entryDirectionAllows('LONG', 'BULLISH', options), true);
  assert.equal(entryDirectionAllows('LONG', 'BEARISH', options), false);
  assert.equal(entryDirectionAllows('SHORT', 'BEARISH', options), true);
  assert.equal(entryDirectionAllows('SHORT', 'BULLISH', options), false);
});

test('configurable base timeframe evaluates entry decisions after each closed candle', () => {
  const fiveMinutes = 5 * 60_000;
  const timestamps = [];
  const simulator = new FixedRangeBacktester(exchange, {
    baseTimeframe: '5m',
    rangeTimeframes: ['5m'],
    directionTimeframes: ['5m'],
    gridCount: 2,
    totalInvestment: 10,
    maxActiveBuyOrders: 2,
    candleLimit: 100,
    rangeRebuildCooldownMs: Infinity,
  });
  const rows = [
    [0, 100, 101, 99, 100, 1],
    [fiveMinutes, 100, 101, 99, 100, 1],
  ];
  simulator.simulate({
    symbol: 'TEST/USDT:USDT',
    rows,
    start: 0,
    end: 2 * fiveMinutes,
    adaptive: false,
    entryDecisionProvider: ({ timestamp }) => {
      timestamps.push(timestamp);
      return { allow: false };
    },
  });
  assert.deepEqual(timestamps, [fiveMinutes, 2 * fiveMinutes]);
});

test('configurable base timeframe rejects incompatible higher-timeframe series', () => {
  const simulator = new FullGridBacktester(exchange, {
    baseTimeframe: '15m',
    rangeTimeframes: ['5m'],
    directionTimeframes: ['15m'],
  });
  assert.throws(
    () => simulator.prepareSeries([], '15m', ['5m']),
    /5m cannot be built from 15m candles/
  );
});

test('configurable base timeframe builds complete higher-timeframe candles', () => {
  const fiveMinutes = 5 * 60_000;
  const simulator = new FullGridBacktester(exchange);
  const rows = Array.from({ length: 12 }, (_, index) => [
    index * fiveMinutes, 100, 101, 99, 100, 1,
  ]);
  const series = simulator.prepareSeries(rows, '5m', ['5m', '15m', '1h']);
  assert.equal(series['5m'].length, 12);
  assert.equal(series['15m'].length, 4);
  assert.equal(series['1h'].length, 1);
});

test('controlled handoff can place one Fibonacci rescue order and exit the enlarged position profitably', () => {
  const simulator = new FixedRangeBacktester(exchange, {
    gridCount: 2,
    totalInvestment: 10,
    orderSizeUsdt: 5,
    maxExposureUsdt: 10,
    maxActiveBuyOrders: 2,
    minimumNotional: 5,
    candleLimit: 100,
    rangeRebuildCooldownMs: Infinity,
    mutualExclusion: true,
    controlledHandoff: true,
    handoffMinimumNetProfitPct: 0.05,
    handoffRescueNotionalUsdt: 10,
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
  });
  simulator.createRangeAdvisor = () => ({
    buildSuggestion: () => ({ lower: 70, upper: 110, levels: [70, 90, 110] }),
    shouldAdoptSuggestion: previous => !previous,
  });
  const rows = [
    candle(0, 100, 101, 99, 100),
    candle(1, 90, 91, 89, 90),
    candle(2, 80, 85, 79, 80),
    candle(3, 71, 72, 69, 71),
    candle(4, 75, 80, 74, 78),
  ];
  const result = simulator.simulate({
    symbol: 'TEST/USDT:USDT',
    rows,
    start: 0,
    end: 5 * INTERVAL,
    positionSideProvider: ({ timestamp }) => timestamp >= 3 * INTERVAL ? 'SHORT' : 'LONG',
  });
  assert.equal(result.handoffRescueOrders, 1);
  assert.equal(result.handoffRescueFills, 1);
  assert.equal(result.handoffCompleted, 1);
  assert.equal(result.finalInventoryNotional, 0);
  assert.ok(result.netLiquidationPnl > 0);
});

test('stale handoff can spend realized profit to clear inventory on a Fibonacci bounce', () => {
  const simulator = new FixedRangeBacktester(exchange, {
    gridCount: 2,
    totalInvestment: 10,
    orderSizeUsdt: 5,
    maxExposureUsdt: 10,
    maxActiveBuyOrders: 2,
    minimumNotional: 5,
    candleLimit: 100,
    rangeRebuildCooldownMs: Infinity,
    mutualExclusion: true,
    controlledHandoff: true,
    handoffMinimumNetProfitPct: 0.05,
    handoffProfitBankExitEnabled: true,
    handoffProfitBankActivationMs: 0,
    handoffProfitBankExitFraction: 1,
    handoffProfitBankReserveUsdt: 0.05,
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
  });
  simulator.createRangeAdvisor = () => ({
    buildSuggestion: () => ({ lower: 70, upper: 110, levels: [70, 90, 100, 110] }),
    shouldAdoptSuggestion: previous => !previous,
  });
  const rows = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 100, 89, 90),
    candle(2, 90, 101, 90, 100),
    candle(3, 100, 100, 79, 80),
    candle(4, 80, 90, 79, 85),
  ];
  const result = simulator.simulate({
    symbol: 'TEST/USDT:USDT',
    rows,
    start: 0,
    end: 5 * INTERVAL,
    positionSideProvider: ({ timestamp }) => timestamp >= 4 * INTERVAL ? 'SHORT' : 'LONG',
  });
  assert.equal(result.handoffProfitBankOrders, 1);
  assert.equal(result.handoffProfitBankFills, 1);
  assert.equal(result.handoffProfitBankFullExits, 1);
  assert.equal(result.handoffCompleted, 1);
  assert.equal(result.finalInventoryNotional, 0);
  assert.ok(result.realizedCashPnl >= 0.05);
});

test('profit-bank handoff does not realize a loss when its reserve is unavailable', () => {
  const simulator = new FixedRangeBacktester(exchange, {
    gridCount: 2,
    totalInvestment: 10,
    orderSizeUsdt: 5,
    maxExposureUsdt: 10,
    maxActiveBuyOrders: 2,
    minimumNotional: 5,
    candleLimit: 100,
    rangeRebuildCooldownMs: Infinity,
    mutualExclusion: true,
    controlledHandoff: true,
    handoffProfitBankExitEnabled: true,
    handoffProfitBankActivationMs: 0,
    handoffProfitBankExitFraction: 1,
    handoffProfitBankReserveUsdt: 0.05,
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
  });
  simulator.createRangeAdvisor = () => ({
    buildSuggestion: () => ({ lower: 70, upper: 110, levels: [70, 90, 100, 110] }),
    shouldAdoptSuggestion: previous => !previous,
  });
  const rows = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 100, 89, 80),
    candle(2, 80, 90, 79, 85),
  ];
  const result = simulator.simulate({
    symbol: 'TEST/USDT:USDT',
    rows,
    start: 0,
    end: 3 * INTERVAL,
    positionSideProvider: ({ timestamp }) => timestamp >= 2 * INTERVAL ? 'SHORT' : 'LONG',
  });
  assert.equal(result.handoffProfitBankFills, 0);
  assert.ok(result.finalInventoryNotional > 0);
});
