'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exitPrices, prepareExitResearch, simulateExitMethod } = require('../src/ma-exit-research');
const { simulateMaCross } = require('../src/ma-cross-backtester');
const { buildScalperConfig } = require('../src/scalper/config');

test('net reward targets include both fees and exit slippage for LONG and SHORT', () => {
  for (const side of ['LONG', 'SHORT']) {
    const direction = side === 'LONG' ? 1 : -1;
    const levels = exitPrices({ side, atr1m: 1 }, 100, { family: 'atr', timeframe: '1m', multiple: 1, reward: 2 });
    const exit = levels.target * (1 - direction * 0.0002);
    const net = direction * (exit - 100) - (100 + exit) * 0.0005;
    assert.ok(Math.abs(net - 2 * (1 + 100 * 0.0012)) < 1e-9);
    assert.ok(direction * (100 - levels.stop) > 0);
  }
  assert.equal(exitPrices({ side: 'LONG', atr1m: 5 }, 100, { family: 'atr', timeframe: '1m', multiple: 1, reward: 1 }), null);
});

test('funding is charged to existing positions at minute-aligned event before a gap stop', () => {
  const row = (i, open) => [i * 60_000, open, open, open, open, 10, (i + 1) * 60_000 - 1];
  const prepared = { rows: [row(0, 100), row(1, 90)], events: new Map([[0, { side: 'LONG', size: 1 }]]) };
  const result = simulateExitMethod(prepared, { family: 'fixed', stopPct: 1, targetPct: 2 }, {
    start: 0, end: 120_000, feeRate: 0, slippageRate: 0,
    funding: [{ fundingTime: 60_003, markPrice: 100, fundingRate: 0.01 }], recordTrades: true });
  assert.equal(result.funding, -1);
  assert.equal(result.realizedNetPnl, -11);
  assert.equal(result.tradeDetails[0].reason, 'STOP_LOSS_GAP');
});

test('optimized replay reproduces original simulator and prepared features do not use future candles', () => {
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
  const options = { start: 25_000 * 60_000, end: 25_020 * 60_000 };
  const prepared = prepareExitResearch(rows, config);
  const original = simulateMaCross(rows, config, options);
  const fast = simulateExitMethod(prepared, { family: 'original' }, options);
  const expected = original.summary.netPnl + original.openPositions.reduce((sum, position) => sum + position.estimatedNetPnl, 0);
  assert.equal(fast.trades, original.trades.length);
  assert.ok(Math.abs(fast.netPnl - expected) < 1e-8);
  const prefix = prepareExitResearch(rows.slice(0, 25_012), config);
  assert.deepEqual(prefix.events.get(25_011), prepared.events.get(25_011));
});

test('a trailing stop derived from a candle cannot execute inside that same candle', () => {
  for (const side of ['LONG', 'SHORT']) {
    const rows = side === 'LONG'
      ? [[0, 100, 100, 100, 100, 0, 59_999], [60_000, 100, 102, 99.5, 100, 0, 119_999], [120_000, 100, 100, 100, 100, 0, 179_999]]
      : [[0, 100, 100, 100, 100, 0, 59_999], [60_000, 100, 100.5, 98, 100, 0, 119_999], [120_000, 100, 100, 100, 100, 0, 179_999]];
    const result = simulateExitMethod({ rows, events: new Map([[0, { side, size: 1 }]]) },
      { family: 'fixed', stopPct: 1, targetPct: 10, management: { armR: 1, trailR: 1 } },
      { start: 0, end: 180_000, feeRate: 0, slippageRate: 0, recordTrades: true });
    assert.equal(result.tradeDetails.length, 1);
    assert.equal(result.tradeDetails[0].exitTimestamp, 120_000);
    assert.equal(result.tradeDetails[0].reason, 'STOP_LOSS_GAP');
    assert.equal(result.netPnl, 0);
  }
});
