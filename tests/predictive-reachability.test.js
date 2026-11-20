'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { planReachableTargets, validateReachability, calibrate, FEATURE_NAMES } = require('../src/predictive/reachability');
const { scoreExitPlan } = require('../src/predictive/exit-evaluator');
const { reachabilityFixture, contextFeatures, setReachThreshold } = require('./helpers/reachability-fixture');
const { loadReachabilityModels } = require('../scripts/start-predictive-shadow');

function params(side = 'LONG') {
  return { side, entryFill: 100 * (side === 'LONG' ? 1.0002 : 0.9998),
    stopLoss: side === 'LONG' ? 99.7 : 100.3, tickSize: 0.01,
    costAssumptions: { feePctPerSide: 0.05, slippagePctPerSide: 0.02 } };
}

for (const side of ['LONG', 'SHORT']) {
  test(`${side} reaching TP then reversing before the horizon is a TP outcome`, () => {
    const model = reachabilityFixture(60, 'direction-60', 'exit-60', 10);
    const plan = planReachableTargets(model, contextFeatures(), { up: 0.55, down: 0.4 }, params(side));
    assert.equal(plan.selectedTarget, 'TP2');
    assert.equal(plan.rangeBasis, 'FIRST_PASSAGE_BEFORE_STOP_WITHIN_HORIZON');
    const bars = Array.from({ length: 61 }, (_, i) => ({ time: i * 60000, closeTime: i * 60000 + 59999,
      open: 100, high: 100.01, low: 99.99, close: 100 }));
    if (side === 'LONG') bars[2].high = plan.takeProfit;
    else bars[2].low = plan.takeProfit;
    const f = { horizon: 60, candleCloseTime: 59999, targetCloseTime: bars[60].closeTime, exitPlan: plan };
    const outcome = scoreExitPlan(f, bars);
    assert.equal(outcome.result, 'TP');
    assert.ok(outcome.simulatedNetPct > 0);
    assert.equal(bars[60].close, 100);
    if (side === 'LONG') bars[1].low = plan.stopLoss;
    else bars[1].high = plan.stopLoss;
    assert.equal(scoreExitPlan(f, bars).result, 'SL');
  });
}

test('same-candle TP and SL ambiguity remains stop-first in path labels', () => {
  const model = reachabilityFixture(1, 'direction-1', 'exit-1', 10);
  const plan = planReachableTargets(model, contextFeatures(), { up: 0.55, down: 0.4 }, params());
  const bars = [{ time: 0, closeTime: 59999, open: 100, high: 100, low: 100, close: 100 },
    { time: 60000, closeTime: 119999, open: 100, high: plan.takeProfit, low: plan.stopLoss, close: 100 }];
  const out = scoreExitPlan({ horizon: 1, candleCloseTime: 59999, targetCloseTime: 119999, exitPlan: plan }, bars);
  assert.equal(out.result, 'SL');
  assert.equal(out.ambiguous, true);
});

test('probabilities cannot increase at farther targets, even for a nonmonotone raw classifier', () => {
  const model = reachabilityFixture();
  model.classifier.weights[2].fill(0);
  model.classifier.weights[2][FEATURE_NAMES.indexOf('rewardMultiple') + 1] = 2;
  const plan = planReachableTargets(model, contextFeatures(), { up: 0.55, down: 0.4 }, params());
  const values = plan.supportCurve.map(t => t.probabilityTpBeforeSl);
  assert.ok(values.every((v, i) => i === 0 || v <= values[i - 1] + 1e-12));
  assert.ok(plan.targetLevels.every(t => Math.abs(t.probabilityTpBeforeSl + t.probabilitySlFirst + t.probabilityTimeout - 1) < 1e-9));
});

test('TP1 fallback and no-entry decisions depend on path probabilities', () => {
  const model = reachabilityFixture(60, 'direction-60', 'exit-60', 1);
  const plan = planReachableTargets(model, contextFeatures(), { up: 0.55, down: 0.4 }, params());
  assert.equal(plan.selectedTarget, 'TP1');
  setReachThreshold(model, 0.01);
  assert.equal(planReachableTargets(model, contextFeatures(), { up: 0.55, down: 0.4 }, params()).reason,
    'TP1_BEFORE_SL_NOT_SUPPORTED');
});

test('calibration uses a monotone mapping and clamps to measured endpoints', () => {
  const model = reachabilityFixture();
  model.calibration = { x: [0.2, 0.6, 0.9], y: [0.1, 0.4, 0.7] };
  assert.equal(calibrate(0, model.calibration), 0.1);
  assert.equal(calibrate(1, model.calibration), 0.7);
  assert.ok(Math.abs(calibrate(0.4, model.calibration) - 0.25) < 1e-12);
  model.calibration.y = [0.1, 0.7, 0.4];
  assert.throws(() => validateReachability(model), /Invalid/);
});

test('exactly 50% TP-before-SL probability does not qualify', () => {
  const model = reachabilityFixture();
  model.classifier.weights.forEach(row => row.fill(0));
  model.classifier.weights[1][0] = -100;
  const plan = planReachableTargets(model, contextFeatures(), { up: 0.55, down: 0.4 }, params());
  assert.equal(plan.status, 'UNAVAILABLE');
  assert.ok(plan.targetLevels.every(t => t.probabilityTpBeforeSl === 0.5));
});

test('reachability bundle verifies frozen direction and stop model hashes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reachability-bundle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const directionFile = path.join(directory, 'model-60m.json');
  const stopFile = path.join(directory, 'exit-model-60m.json');
  fs.writeFileSync(directionFile, JSON.stringify({ modelId: 'direction-60' }));
  fs.writeFileSync(stopFile, JSON.stringify({ modelId: 'exit-60' }));
  const modelDirectory = path.join(directory, 'reach');
  fs.mkdirSync(modelDirectory);
  const model = reachabilityFixture(60, 'direction-60', 'exit-60');
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  model.directionModelHash = digest(directionFile);
  model.exitModelHash = digest(stopFile);
  model.trainingRunId = 'test-run';
  fs.writeFileSync(path.join(modelDirectory, 'model-60m.json'), JSON.stringify(model));
  fs.writeFileSync(path.join(modelDirectory, 'manifest.json'), JSON.stringify({ completed: true,
    objective: 'TP_BEFORE_SL_WITHIN_HORIZON', symbol: 'DOGEUSDT', trainingRunId: 'test-run', modelIds: { 60: model.modelId } }));
  const directions = [{ horizon: 60, modelId: 'direction-60' }], exits = new Map([[60, { modelId: 'exit-60' }]]);
  const dirs = { directionDirectory: directory, exitDirectory: directory };
  assert.equal(loadReachabilityModels(modelDirectory, 'DOGEUSDT', directions, exits, dirs).get(60).modelId, model.modelId);
  fs.writeFileSync(stopFile, JSON.stringify({ modelId: 'exit-60', changed: true }));
  assert.throws(() => loadReachabilityModels(modelDirectory, 'DOGEUSDT', directions, exits, dirs), /hash mismatch/);
});
