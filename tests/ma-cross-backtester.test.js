'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateCandles, simulateMaCross } = require('../src/ma-cross-backtester');
const { buildScalperConfig } = require('../src/scalper/config');

function row(index, open = 100, high = 100, low = 100, close = 100) {
  return [index * 60_000, open, high, low, close, 10, (index + 1) * 60_000 - 1];
}

function configWithoutSelection(environment = {}) {
  const config = buildScalperConfig(environment);
  for (const strategy of Object.values(config.strategies)) strategy.crossSelection = null;
  return config;
}

test('higher timeframe aggregation excludes incomplete boundary candles', () => {
  const source = Array.from({ length: 45 }, (_, i) => row(i + 1));
  const result = aggregateCandles(source, 900_000);
  assert.equal(result.length, 2);
  assert.equal(result[0][0], 15 * 60_000);
  assert.equal(result[1][6], 45 * 60_000 - 1);
});

test('backtest enters after closed cross, uses countertrend sizing, and counts stop first', () => {
  const data = Array.from({ length: 25_020 }, (_, i) => row(i));
  const history = [60, 100, 60, 100, 100, 140, 100, 140].flatMap(price => Array(30).fill(price));
  history.forEach((price, i) => { data[24_600 + i] = row(24_600 + i, price, price, price, price); });
  data[25_010] = row(25_010, 100, 101, 100, 101);
  data[25_011] = row(25_011, 100, 200, 1, 100);
  const config = configWithoutSelection();
  const options = { start: 25_000 * 60_000, end: 25_020 * 60_000, feeRate: 0.0005, slippageRate: 0.0002 };
  const result = simulateMaCross(data, config, options);
  const first = result.trades[0];
  assert.equal(result.signals.unavailable, 0);
  assert.equal(first.entryTimestamp, 25_011 * 60_000);
  assert.equal(first.rawEntryPrice, 100);
  assert.equal(first.entryPrice, 100.02);
  assert.equal(first.side, 'LONG');
  assert.equal(first.countertrend, true);
  assert.equal(first.notional, 25);
  assert.equal(first.reason, 'STOP_LOSS');
  assert.equal(first.takeProfit, first.resistance.price);
  assert.equal(first.stopLoss, first.support.price);
  assert.ok(first.fees > 0);
  assert.ok(first.netPnl < first.grossPnl);
  const truncated = simulateMaCross(data.slice(0, 25_012), config, { ...options, end: 25_012 * 60_000 });
  assert.deepEqual(truncated.trades[0], first);
});

test('data gaps are rejected instead of silently extending a candle', () => {
  assert.throws(() => simulateMaCross([row(0), row(2)], configWithoutSelection(),
    { start: 0, end: 180_000 }), /missing 1m candle/);
});

test('positions survive old hold limits and opposing crosses until historical TP/SL', () => {
  const data = Array.from({ length: 25_080 }, (_, i) => row(i));
  const history = [60, 100, 60, 100, 100, 140, 100, 140].flatMap(price => Array(30).fill(price));
  history.forEach((price, i) => { data[24_600 + i] = row(24_600 + i, price, price, price, price); });
  data[25_010] = row(25_010, 100, 101, 100, 101);
  for (let index = 25_011; index < data.length; index++) data[index] = row(index, 100.5, 100.5, 100.5, 100.5);
  const config = configWithoutSelection({ SCALPER_MAX_HOLD_MINUTES: '1', SCALPER_COUNTERTREND_MAX_HOLD_MINUTES: '1', SCALPER_COOLDOWN_MINUTES: '999' });
  const result = simulateMaCross(data, config, { start: 25_000 * 60_000, end: 25_080 * 60_000 });
  assert.ok(result.signals.totalCrosses >= 2);
  const long = result.openPositions.find(position => position.side === 'LONG');
  assert.ok(long);
  assert.equal(long.entryTimestamp, 25_011 * 60_000);
  assert.ok(Number.isFinite(long.estimatedNetPnl));
  assert.ok(result.trades.every(trade => ['TAKE_PROFIT', 'STOP_LOSS', 'STOP_LOSS_GAP'].includes(trade.reason)));
  assert.equal(config.strategy.maxHoldMinutes, null);
  assert.equal(config.strategy.cooldownMinutes, 0);
});
