'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adaptiveReachabilityFixture, contextFeatures } = require('./helpers/reachability-fixture');
const { ADAPTIVE_POLICY_ID, planAdaptiveTargets, planAdaptiveExits, chooseCandidate } = require('../src/predictive/adaptive-exits');
const { buildStopCandidates } = require('../src/predictive/stop-candidates');
const { scoreCandidateExits, candidateSummary, sequentialExitRecords } = require('../src/predictive/exit-evaluator');
const { candidateEvidence, buildLiveConfig } = require('../src/predictive/live-policy');
const { validateReachability } = require('../src/predictive/reachability');

const costs = { feePctPerSide: 0.05, slippagePctPerSide: 0.02 };
function params(side = 'LONG') { return { side, entryFill: 100 * (side === 'LONG' ? 1.0002 : 0.9998),
  stopLoss: side === 'LONG' ? 99.7 : 100.3, tickSize: 0.01, costAssumptions: costs }; }
function candles() { return Array.from({ length: 16 }, (_, i) => ({ time: i * 60000,
  closeTime: i * 60000 + 59999, open: 100, high: 100.02, low: 99.98, close: 100 })); }
function forecast(direction = 'UP') { return { objective: 'PRICE_DIRECTION', status: 'FORECAST',
  symbol: 'DOGEUSDT', horizon: 60, referencePrice: 100, candleCloseTime: 959999,
  targetCloseTime: 4559999, modelId: 'frozen-60-model', direction, probabilities: { up: 0.55, down: 0.4 } }; }

for (const side of ['LONG', 'SHORT']) test(`${side} positive expectancy can support TP2 with TP probability below 50%`, () => {
  const plan = planAdaptiveTargets(adaptiveReachabilityFixture(), contextFeatures(), { up: 0.55, down: 0.4 }, params(side));
  assert.equal(plan.riskPolicyId, ADAPTIVE_POLICY_ID);
  assert.equal(plan.selectedTarget, 'TP2');
  assert.ok(plan.probabilityTpBeforeSl < 0.5);
  assert.ok(plan.expectedNetPct > 0);
  assert.ok(plan.estimatedNetRewardRisk >= 2);
  assert.ok(Math.abs(plan.probabilityTpBeforeSl + plan.probabilitySlFirst + plan.probabilityTimeout - 1) < 1e-12);
});

test('negative conditional timeout returns can reject an otherwise positive target', () => {
  const m = adaptiveReachabilityFixture();
  assert.equal(planAdaptiveTargets(m, contextFeatures(), { up: 0.55, down: 0.4 }, params()).status, 'ESTIMATED');
  m.timeoutRegressor.weights[0] = -10;
  const rejected = planAdaptiveTargets(m, contextFeatures(), { up: 0.55, down: 0.4 }, params());
  assert.equal(rejected.reason, 'NON_POSITIVE_EXPECTED_NET');
  assert.ok(rejected.targetLevels.every(t => t.expectedTimeoutNetPct === -rejected.estimatedNetLossPct));
});

test('expected SL gap costs can turn a marginal setup negative', () => {
  const m = adaptiveReachabilityFixture();
  m.stopGapPenaltyScaled = 10;
  assert.equal(planAdaptiveTargets(m, contextFeatures(), { up: 0.55, down: 0.4 }, params()).status, 'UNAVAILABLE');
});

test('nonpositive SHORT target geometry is rejected before model inference', () => {
  const plan = planAdaptiveTargets(adaptiveReachabilityFixture(), contextFeatures(), { up: 0.55, down: 0.4 },
    { ...params('SHORT'), stopLoss: 300 });
  assert.equal(plan.status, 'UNAVAILABLE');
  assert.ok(plan.targetLevels.every(t => !t.validTarget && !t.supportedByExpectedValue));
});

test('stop proposals use only closed candles and reject noise and duplicate levels', () => {
  const f = forecast(), bars = candles(), estimates = { down: [0.001, 0.1, 0.1], up: [0.001, 0.1, 0.1] };
  const expected = buildStopCandidates(f, estimates, bars, 0.01);
  const future = { ...bars.at(-1), closeTime: bars.at(-1).closeTime + 60000, low: 1, high: 1000 };
  assert.deepEqual(buildStopCandidates(f, estimates, [...bars, future], 0.01), expected);
  assert.equal(expected.find(s => s.stopId === 'Q25').reason, 'STOP_INSIDE_NOISE_FLOOR');
  assert.equal(expected.find(s => s.stopId === 'Q50').valid, true);
  assert.equal(expected.find(s => s.stopId === 'Q75').reason, 'DUPLICATE_STOP');
  assert.equal(expected.find(s => s.stopId === 'STRUCTURE15').valid, true);
  assert.throws(() => buildStopCandidates(f, estimates, bars.slice(1), 0.01), /16 contiguous/);
});

test('all valid stop/target pairs are retained when none has positive expectancy', () => {
  const m = adaptiveReachabilityFixture(60, 'frozen-60-model', 'frozen-exit-60-model', [0.8, 0.1, 0.1]);
  const plan = planAdaptiveExits(forecast(), { down: [0.1, 0.2, 0.4], up: [0.1, 0.2, 0.4] }, m,
    contextFeatures(), { candles: candles(), tickSize: 0.01 });
  assert.equal(plan.reason, 'NON_POSITIVE_EXPECTED_NET');
  assert.equal(plan.candidates.length, 8);
  assert.ok(plan.candidates.every(c => !c.supportedByExpectedValue));
});

test('TP2 preference, highest expectancy stop and TP1 fallback are deterministic', () => {
  const rows = [
    { stopId: 'Q50', validTarget: true, rewardMultiple: 1, expectedNetPct: 0.3, supportedByExpectedValue: true },
    { stopId: 'Q25', validTarget: true, rewardMultiple: 2, expectedNetPct: 0.1, supportedByExpectedValue: true },
    { stopId: 'Q75', validTarget: true, rewardMultiple: 2, expectedNetPct: 0.2, supportedByExpectedValue: true },
  ];
  assert.equal(chooseCandidate(rows).stopId, 'Q75');
  rows.slice(1).forEach(r => { r.supportedByExpectedValue = false; });
  assert.equal(chooseCandidate(rows).rewardMultiple, 1);
  assert.equal(chooseCandidate(rows, 'PROBABILITY_50'), null);
});

test('counterfactual outcomes remain separate from selected policy winrate', () => {
  const f = { ...forecast(), horizon: 1, candleCloseTime: 59999, targetCloseTime: 119999,
    exitPlan: { status: 'UNAVAILABLE', riskPolicyId: ADAPTIVE_POLICY_ID, reachabilityModelId: 'r', side: 'LONG', costAssumptions: costs,
      candidates: [{ stopId: 'Q50', level: 'TP1', takeProfit: 100.4, stopLoss: 99.7 }] } };
  const bars = [{ ...candles()[0] }, { time: 60000, closeTime: 119999, open: 100, high: 100.5, low: 99.9, close: 100.4 }];
  assert.equal(scoreCandidateExits(f, bars), 1);
  assert.ok(f.exitPlan.candidates[0].outcome.simulatedNetPct > 0);
  assert.equal(scoreCandidateExits(f, bars), 0);
  const diagnostics = candidateSummary([f]);
  assert.equal(diagnostics.rejected.candidates, 1); assert.equal(diagnostics.usedForLiveGate, false);
  f.horizon = 60; f.outcome = { correct: true };
  const evidence = candidateEvidence({ records: [f] }, buildLiveConfig(), f.modelId, 'r');
  assert.equal(evidence.completedShadowTrades, 0); assert.equal(evidence.matchesUserCriteria, false);
});

test('one-position evidence requires positive net and excludes profits from overlapping alternatives', () => {
  const rows = [1, 2, 4].map((minute, i) => ({ ...forecast(), candleCloseTime: minute * 60000,
    targetCloseTime: (minute + 60) * 60000, outcome: { correct: true },
    exitPlan: { status: 'ESTIMATED', riskPolicyId: ADAPTIVE_POLICY_ID, reachabilityModelId: 'r' },
    exitOutcome: { simulatedNetPct: i === 2 ? -1 : i === 1 ? 100 : 1, exitCloseTime: (minute + 3) * 60000 } }));
  assert.equal(sequentialExitRecords(rows).length, 2);
  const evidence = candidateEvidence({ records: rows }, buildLiveConfig(), rows[0].modelId, 'r');
  assert.equal(evidence.completedShadowTrades, 2); assert.equal(evidence.netWinRate, 0.5);
  assert.equal(evidence.totalShadowNetUsdtAt100Notional, 0);
  assert.equal(evidence.overlappingForecasts, false); assert.equal(evidence.matchesUserCriteria, false);
  rows[0].exitOutcome.simulatedNetPct = 2;
  const positive = candidateEvidence({ records: rows }, buildLiveConfig(), rows[0].modelId, 'r');
  assert.equal(positive.totalShadowNetUsdtAt100Notional, 1);
  assert.equal(positive.netWinRate, 0.5); assert.equal(positive.matchesUserCriteria, true);
  const pending = { ...rows[0], exitOutcome: undefined };
  assert.equal(sequentialExitRecords([pending, ...rows.slice(1)]).length, 1);
});

test('adaptive model validation rejects missing timeout calibration or stop policy', () => {
  const m = adaptiveReachabilityFixture();
  validateReachability(m);
  m.timeoutRegressor.weights[0] = NaN;
  assert.throws(() => validateReachability(m), /adaptive expectancy/);
});
