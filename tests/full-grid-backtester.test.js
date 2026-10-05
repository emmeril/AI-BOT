const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FullGridBacktester,
  chooseSpacedLevels,
  minimumProfitableSellPrice,
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
  assert.equal(result.accountingIdentityDelta, 0);
});

test('minimum profitable sell includes entry fee, exit fee, and requested net profit', () => {
  const price = minimumProfitableSellPrice(
    { entryCost: 100, buyFee: 0.02, quantity: 1 },
    { makerFeeRate: 0.0002, minimumNetProfitPct: 0.05 }
  );
  assert.ok(price > 100.09);
  assert.ok(price < 100.11);
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
