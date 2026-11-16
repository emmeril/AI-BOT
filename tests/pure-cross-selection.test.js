'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectPureCrossPrices, preparePureCrossHistory } = require('../src/pure-cross-selection');
const { simulateExitMethod } = require('../src/ma-exit-research');
const { simulateMaCross } = require('../src/ma-cross-backtester');
const { buildScalperConfig } = require('../src/scalper/config');

const method = { priority: 'all', rank: 'distance', minimumRetests: 0, targetIndex: 0, stopIndex: 0, requireNetTarget: false };
const level = (price, timeframe = '1m', timestamp = 1, retests = 0) => ({ price, timeframe, timestamp,
  supportRetests: retests, resistanceRetests: retests, pair: 'MA7/MA99' });

test('TP/SL are exact chosen cross prices, symmetrically for long and short', () => {
  const levels = [level(80), level(90), level(110), level(120)];
  const long = selectPureCrossPrices({ side: 'LONG', levels }, 100, { ...method, targetIndex: 1, stopIndex: 1 });
  assert.equal(long.target, 120);
  assert.equal(long.stop, 80);
  const short = selectPureCrossPrices({ side: 'SHORT', levels }, 100, method);
  assert.equal(short.target, 90);
  assert.equal(short.stop, 110);
  assert.ok(levels.includes(long.sources.target));
  assert.ok(levels.includes(long.sources.stop));
});

test('cost and retest selection changes the chosen cross without moving its price', () => {
  const levels = [level(90, '1m', 1, 1), level(100.01, '1m', 2, 1), level(110, '15m', 3, 1)];
  const selected = selectPureCrossPrices({ side: 'LONG', levels }, 100, { ...method, requireNetTarget: true, minimumRetests: 1 });
  assert.equal(selected.target, 110);
  assert.equal(selected.stop, 90);
  assert.equal(selectPureCrossPrices({ side: 'LONG', levels }, 100, { ...method, minimumRetests: 2 }), null);
});

test('stop distance constraint filters historical points without fabricating a percentage stop', () => {
  const levels = [level(80), level(98.7), level(110)];
  const selected = selectPureCrossPrices({ side: 'LONG', levels }, 100, { ...method, maximumStopDistance: 0.02 });
  assert.equal(selected.stop, 98.7);
  assert.equal(selected.target, 110);
  assert.equal(selectPureCrossPrices({ side: 'LONG', levels }, 100, { ...method, maximumStopDistance: 0.01 }), null);
});

test('mirror SL uses only selected target cross and actual entry, not an opposite historical level', () => {
  const mirrored = { ...method, stopMode: 'MIRROR_TARGET' };
  const long = selectPureCrossPrices({ side: 'LONG', levels: [level(102)] }, 100, mirrored);
  assert.equal(long.target, 102);
  assert.equal(long.stop, 98);
  const short = selectPureCrossPrices({ side: 'SHORT', levels: [level(98)] }, 100, mirrored);
  assert.equal(short.target, 98);
  assert.equal(short.stop, 102);
  const shiftedFill = selectPureCrossPrices({ side: 'LONG', levels: [level(102)] }, 100.5, mirrored);
  assert.equal(shiftedFill.stop, 99);
  assert.equal(selectPureCrossPrices({ side: 'LONG', levels: [level(99)] }, 100, mirrored), null);
});

test('five-candle stop sits one exchange tick outside the finished candle range', () => {
  const structural = { ...method, stopMode: 'FIVE_CANDLE', tickSize: 0.01 };
  const range = { low: 98.2, high: 101.6 };
  const long = selectPureCrossPrices({ side: 'LONG', levels: [level(105)], entryRange5: range }, 100, structural);
  const short = selectPureCrossPrices({ side: 'SHORT', levels: [level(95)], entryRange5: range }, 100, structural);
  assert.ok(Math.abs(long.stop - 98.19) < 1e-10);
  assert.ok(Math.abs(short.stop - 101.61) < 1e-10);
  assert.equal(long.target, 105);
  assert.equal(short.target, 95);
  assert.equal(long.sources.stop.kind, 'FIVE_CANDLE');
  assert.equal(selectPureCrossPrices({ side: 'LONG', levels: [level(105)], entryRange5: range }, 98.18, structural), null);
  assert.equal(selectPureCrossPrices({ side: 'SHORT', levels: [level(95)], entryRange5: range }, 102, structural), null);
});

test('net reward/risk filter rejects an inadequate target without adjusting levels', () => {
  const structural = { ...method, stopMode: 'FIVE_CANDLE', tickSize: 0.01, minimumNetRewardRisk: 1.5 };
  const event = { side: 'LONG', levels: [level(100.5)], entryRange5: { low: 98.2, high: 101 } };
  assert.equal(selectPureCrossPrices(event, 100, structural), null);
  event.levels = [level(105)];
  const result = selectPureCrossPrices(event, 100, structural);
  assert.ok(result.netRewardRisk >= 1.5);
  assert.equal(result.target, 105);
  assert.ok(Math.abs(result.stop - 98.19) < 1e-10);
});

test('pure history preparation contains no ATR features and reproduces original entry/exit baseline', () => {
  const row = (i, price = 100) => [i * 60_000, price, price, price, price, 10, (i + 1) * 60_000 - 1];
  const rows = Array.from({ length: 25_020 }, (_, i) => row(i));
  const history = [60, 100, 60, 100, 100, 140, 100, 140].flatMap(price => Array(30).fill(price));
  history.forEach((price, i) => { rows[24_600 + i] = row(24_600 + i, price); });
  rows[25_010] = [25_010 * 60_000, 100, 101, 100, 101, 10, 25_011 * 60_000 - 1];
  rows[25_011] = [25_011 * 60_000, 100, 200, 1, 100, 10, 25_012 * 60_000 - 1];
  const config = buildScalperConfig({});
  for (const strategy of Object.values(config.strategies)) {
    strategy.exitMode = 'HISTORICAL_CROSS';
    strategy.stopMode = 'HISTORICAL_CROSS';
    strategy.crossSelection = null;
  }
  const prepared = preparePureCrossHistory(rows, config);
  const event = prepared.events.get(25_011);
  assert.ok(event);
  assert.equal(event.atr1m, undefined);
  assert.equal(event.atr15m, undefined);
  assert.equal(event.entryRange5.low, 100);
  assert.equal(event.entryRange5.high, 101);
  assert.equal(event.entryRange5.startTimestamp, 25_006 * 60_000);
  assert.equal(event.entryRange5.endTimestamp, 25_011 * 60_000 - 1);
  assert.ok(event.levels.every(level => level.timestamp < 25_010 * 60_000));
  const prefix = preparePureCrossHistory(rows.slice(0, 25_012), config);
  assert.deepEqual(prefix.events.get(25_011), event);
  const options = { start: 25_000 * 60_000, end: 25_020 * 60_000 };
  const baseline = simulateMaCross(rows, config, options);
  const replay = simulateExitMethod(prepared, { family: 'original' }, options);
  const total = baseline.summary.netPnl + baseline.openPositions.reduce((sum, p) => sum + p.estimatedNetPnl, 0);
  assert.ok(Math.abs(replay.netPnl - total) < 1e-9);
});
