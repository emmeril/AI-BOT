const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIndicators, entrySignal, exitSignal, simulate } = require('../src/micro-scalper-strategy');

function row(index, { open = 100, high = 100, low = 100, close = 100, quote = 1000, buy = 500 } = {}) {
  return [index * 60_000, open, high, low, close, 10, index * 60_000 + 59_999, quote, 10, buy / close, buy, 0];
}

test('entry signal requires aligned bearish flow, trend, momentum, and volatility', () => {
  const candle = { close: 99 };
  const indicator = {
    flowDeltaRatio: -0.2,
    emaFast: 99.5,
    emaSlow: 100,
    momentumRatio: -0.01,
    atrPct: 0.2,
  };
  assert.equal(entrySignal(candle, indicator, { side: 'SHORT', flowThreshold: 0.1 }), true);
  assert.equal(entrySignal(candle, { ...indicator, flowDeltaRatio: 0.2 }, { side: 'SHORT' }), false);
});

test('LONG volume-delta strategy exits as soon as completed flow turns adverse', () => {
  const candle = { close: 100 };
  const strategy = {
    side: 'LONG', entryMode: 'VOLUME_DELTA_REVERSAL', flowExitThreshold: -0.05,
  };
  assert.equal(exitSignal(candle, { flowDeltaRatio: -0.1 }, strategy), true);
  assert.equal(exitSignal(candle, { flowDeltaRatio: -0.01 }, strategy), false);
  assert.equal(exitSignal(candle, { flowDeltaRatio: 0.1 }, { ...strategy, side: 'SHORT' }), true);
  assert.equal(exitSignal(candle, { flowDeltaRatio: 0.01 }, { ...strategy, side: 'SHORT' }), false);
});

test('flow indicator uses Binance taker-buy quote volume without future candles', () => {
  const rows = [
    row(0, { close: 100, buy: 400 }),
    row(1, { close: 99.9, buy: 300 }),
    row(2, { close: 99.8, buy: 200 }),
  ];
  const { indicators } = buildIndicators(rows, {
    emaFast: 1,
    emaSlow: 2,
    flowWindow: 2,
    momentumWindow: 1,
    atrPeriod: 1,
  });
  assert.equal(Number(indicators[1].flowDeltaRatio.toFixed(2)), -0.3);
  assert.equal(Number(indicators[2].flowDeltaRatio.toFixed(2)), -0.5);
});

test('simulator enters on the next candle and charges fees and slippage', () => {
  const rows = [
    row(0, { close: 100, high: 100.1, low: 99.9, buy: 100 }),
    row(1, { open: 100, close: 99.8, high: 100, low: 99.7, buy: 100 }),
    row(2, { open: 99.8, close: 99.6, high: 99.8, low: 99.5, buy: 100 }),
    row(3, { open: 99.6, close: 99.3, high: 99.6, low: 99.2, buy: 100 }),
  ];
  const result = simulate(rows, {
    side: 'SHORT', emaFast: 2, emaSlow: 3, flowWindow: 1, flowThreshold: 0.1,
    momentumWindow: 1, atrPeriod: 1, minAtrPct: 0, maxAtrPct: 10,
    takeProfitPct: 0.2, stopLossPct: 1, maxHoldBars: 2, cooldownBars: 0,
    feeRate: 0.0005, slippageRate: 0.0002, start: 0, end: 240_000,
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTimestamp, 180_000);
  assert.equal(result.trades[0].reason, 'TAKE_PROFIT');
  assert.ok(result.trades[0].fees > 0);
  assert.ok(result.trades[0].netPnl > 0);
});

test('simulator assumes stop first if TP and SL are both inside one candle', () => {
  const rows = [
    row(0, { close: 100, high: 100.1, low: 99.9, buy: 100 }),
    row(1, { close: 99.8, high: 100, low: 99.7, buy: 100 }),
    row(2, { close: 99.6, high: 99.8, low: 99.5, buy: 100 }),
    row(3, { open: 99.6, close: 99.6, high: 101, low: 98, buy: 100 }),
  ];
  const result = simulate(rows, {
    side: 'SHORT', emaFast: 2, emaSlow: 3, flowWindow: 1, flowThreshold: 0.1,
    momentumWindow: 1, atrPeriod: 1, minAtrPct: 0, maxAtrPct: 10,
    takeProfitPct: 0.2, stopLossPct: 0.2, maxHoldBars: 2, cooldownBars: 0,
    feeRate: 0, slippageRate: 0, start: 0, end: 240_000,
  });
  assert.equal(result.trades[0].reason, 'STOP_LOSS');
  assert.ok(result.trades[0].netPnl < 0);
});
