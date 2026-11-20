'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { simulatePositionPolicy } = require('../src/predictive/position-backtester');
const { causalGates } = require('../scripts/backtest-predictive-positions');
const { buildLiveConfig } = require('../src/predictive/live-policy');
const { ADAPTIVE_POLICY_ID } = require('../src/predictive/adaptive-exits');

function fixture(count = 70, side = 'LONG') {
  const start = Date.UTC(2026, 10, 1);
  const candles = Array.from({ length: count }, (_, i) => ({ time: start + i * 60000,
    closeTime: start + (i + 1) * 60000 - 1, open: 100, high: 100.1, low: 99.9, close: 100 }));
  const frames = candles.map((bar, i) => ({ forecast: { id: 'f-' + i, symbol: 'DOGEUSDT',
    objective: 'PRICE_DIRECTION', status: 'FORECAST', horizon: 60, modelId: 'direction',
    candleCloseTime: bar.closeTime, createdAt: new Date(bar.closeTime + 1).toISOString(),
    targetCloseTime: bar.closeTime + 3600000, direction: side === 'LONG' ? 'UP' : 'DOWN', referencePrice: 100,
    probabilities: side === 'LONG' ? { up: 0.6, down: 0.3, unchanged: 0.1 } : { up: 0.3, down: 0.6, unchanged: 0.1 },
    exitPlan: { status: i === 0 ? 'ESTIMATED' : 'UNAVAILABLE', side, expectedNetPct: 0.1,
      riskPolicyId: ADAPTIVE_POLICY_ID, reachabilityModelId: 'reachability' } } }));
  const makeEntryPlan = (f, bar) => ({ forecastId: f.id, modelId: f.modelId,
    forecastCandleCloseTime: f.candleCloseTime, forecastCreatedAt: Date.parse(f.createdAt),
    side, quantity: 0.49, estimatedEntry: bar.open * (side === 'LONG' ? 1.0002 : 0.9998),
    takeProfit: side === 'LONG' ? 110 : 90, stopLoss: side === 'LONG' ? 90 : 110,
    selectedTarget: 'TP1', expiresAt: f.targetCloseTime });
  return { candles, frames, makeEntryPlan, from: candles[0].closeTime, to: candles.at(-1).closeTime };
}

test('backtest holds aligned positions beyond 60 minutes and marks them open at the data boundary', () => {
  const inputs = fixture();
  const held = simulatePositionPolicy({ ...inputs, policy: 'PREDICTION_REVERSAL' });
  const timed = simulatePositionPolicy({ ...inputs, policy: 'HORIZON' });
  assert.equal(held.summary.trades, 0);
  assert.ok(held.summary.openPositionAtEnd);
  assert.equal(timed.summary.trades, 1);
  assert.equal(timed.trades[0].reason, 'HORIZON_EXPIRED');
  assert.equal(timed.trades[0].exitTime, inputs.candles[61].time);
  assert.ok(held.summary.totalEquityPnlUsdt < 0);
});

test('backtest executes a reversal at the next candle open without seeing future extremes', () => {
  const inputs = fixture(8);
  inputs.frames[3].forecast.direction = 'DOWN';
  inputs.frames[3].forecast.probabilities = { up: 0.3, down: 0.6, unchanged: 0.1 };
  inputs.candles[5].high = 200; inputs.candles[5].low = 1;
  const result = simulatePositionPolicy({ ...inputs, policy: 'PREDICTION_REVERSAL' });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, 'PREDICTION_REVERSED');
  assert.equal(result.trades[0].exitTime, inputs.candles[4].time);
  assert.equal(result.trades[0].exitForecastId, 'f-3');
  assert.equal(result.summary.openPositionAtEnd, null);
});

test('backtest applies SL first when the same candle touches both protective levels', () => {
  const inputs = fixture(5);
  inputs.candles[2].high = 112; inputs.candles[2].low = 88;
  const result = simulatePositionPolicy({ ...inputs, policy: 'PREDICTION_REVERSAL' });
  assert.equal(result.trades[0].reason, 'SL');
  assert.equal(result.trades[0].ambiguous, true);
  assert.ok(Math.abs(result.trades[0].exitPrice - 89.982) < 1e-10);
  assert.ok(result.trades[0].entryFeeUsdt > 0 && result.trades[0].exitFeeUsdt > 0);
});

test('funding and commissions reconcile to the wallet for both position sides', () => {
  for (const side of ['LONG', 'SHORT']) {
    const inputs = fixture(16, side);
    const reversed = inputs.frames[12].forecast;
    reversed.direction = side === 'LONG' ? 'DOWN' : 'UP';
    reversed.probabilities = side === 'LONG' ? { up: 0.3, down: 0.6, unchanged: 0.1 } : { up: 0.6, down: 0.3, unchanged: 0.1 };
    const funding = [{ fundingTime: inputs.candles[10].time, fundingRate: '0.01', markPrice: '100' }];
    const result = simulatePositionPolicy({ ...inputs, funding, policy: 'PREDICTION_REVERSAL' });
    assert.equal(result.trades.length, 1);
    assert.ok(Math.abs(result.summary.fundingPnlUsdt - (side === 'LONG' ? -0.49 : 0.49)) < 1e-10);
    assert.ok(Math.abs(result.summary.endWalletUsdt - 10.8 - result.trades[0].netPnlUsdt) < 1e-10);
    assert.equal(result.summary.openPositionAtEnd, null);
  }
});

test('forward eligibility cannot see an outcome until the full prediction horizon completes', () => {
  const inputs = fixture(63), config = buildLiveConfig();
  const window = { from: inputs.from, to: inputs.to };
  const truths = inputs.frames.map(() => null);
  truths[0] = { direction: { correct: true }, exit: { simulatedNetPct: 1, exitCloseTime: inputs.candles[5].closeTime } };
  const first = causalGates(inputs.candles, inputs.frames, truths, window, config, 'direction', 'reachability');
  truths[0] = { direction: { correct: false }, exit: { simulatedNetPct: -1, exitCloseTime: inputs.candles[5].closeTime } };
  const second = causalGates(inputs.candles, inputs.frames, truths, window, config, 'direction', 'reachability');
  assert.deepEqual(first.slice(0, 60), second.slice(0, 60));
  assert.equal(first[59].directionEvaluated, 0);
  assert.equal(first[59].completedShadowTrades, 0);
  assert.equal(first[60].matchesUserCriteria, true);
  assert.equal(second[60].matchesUserCriteria, false);
});

test('the live session loss threshold stops further entries after accumulated losses', () => {
  const inputs = fixture(12);
  for (const frame of inputs.frames) frame.forecast.exitPlan.status = 'ESTIMATED';
  for (const bar of inputs.candles) bar.low = 94;
  const makePlan = inputs.makeEntryPlan;
  inputs.makeEntryPlan = (...args) => ({ ...makePlan(...args), stopLoss: 95.1 });
  const result = simulatePositionPolicy({ ...inputs, policy: 'PREDICTION_REVERSAL' });
  assert.equal(result.trades.length, 3);
  assert.equal(result.summary.sessionPause.reason, 'SESSION_LOSS_BUDGET_REACHED');
  assert.ok(10.8 - result.summary.endWalletUsdt >= 5);
  assert.equal(result.summary.openPositionAtEnd, null);
});
