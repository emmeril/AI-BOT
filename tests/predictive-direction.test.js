'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeKlines, buildFeatureRows } = require('../src/predictive/features');
const { KIND, directionRows, validateDirectionModel, predictDirection } =
  require('../src/predictive/direction-model');
const { splitDirectionRows, trainAndEvaluateDirection } =
  require('../src/predictive/direction-evaluation');
const { forecastDirection, scoreDirection, scorePendingDirection, directionSummary } =
  require('../src/predictive/direction-forward');
const { loadState, saveState, loadModels } = require('../scripts/start-predictive-shadow');
const { currentFeatures, fetchCompletedCandles } = require('../scripts/start-predictive-shadow');
const { SCHEMA, NAMES, buildDirectionFeatures } = require('../src/predictive/direction-features');
const { predictBoosted, validateBoostedClassifier, predictEnsemble } = require('../src/predictive/boosted-classifier');
const { selectValidationCandidate, pairedDayInterval } = require('../scripts/research-predictive-direction');

function klines(count = 1000) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + Math.sin(i / 8) * 0.2;
    return [i * 60000, close, close + 0.1, close - 0.1, close, 10,
      i * 60000 + 59999, 1000, 20, 5, 500];
  });
}

function model(horizon = 15) {
  return { kind: KIND, objective: 'PRICE_DIRECTION', symbol: 'DOGEUSDT',
    reference: 'SIGNAL_CANDLE_CLOSE', target: 'HORIZON_CANDLE_CLOSE',
    unchangedDefinition: 'EXACTLY_EQUAL_CLOSE',
    horizon, approvedForTrading: false, temperature: 1, modelId: 'direction-' + horizon,
    trainingRunId: 'test-run', classifier: { kind: 'softmax-baseline-v1',
      mean: [0], std: [1], weights: [[-2, -3], [-8, 0], [2, 3]] } };
}

test('a candle that closes while the market request is in flight cannot become a forecast reference', async () => {
  const raw = klines(100);
  let now = raw.at(-1)[6] - 500;
  const exchange = { fapiPublicGetKlines: async () => {
    now = raw.at(-1)[6] + 1500;
    return raw;
  } };
  const candles = await fetchCompletedCandles(exchange, 'DOGEUSDT', () => now);
  assert.equal(candles.length, 99);
  assert.equal(candles.at(-1).closeTime, raw.at(-2)[6]);
});

test('market input waits two seconds after a candle close before using that candle', async () => {
  const raw = klines(100);
  const exchange = { fapiPublicGetKlines: async () => raw };
  const early = await fetchCompletedCandles(exchange, 'DOGEUSDT', () => raw.at(-1)[6] + 1000);
  const settled = await fetchCompletedCandles(exchange, 'DOGEUSDT', () => raw.at(-1)[6] + 2500);
  assert.equal(early.length, 99);
  assert.equal(settled.length, 100);
});

test('direction labels compare future close with reference close, including exact equality', () => {
  const candles = normalizeKlines(klines(100));
  const features = buildFeatureRows(candles);
  candles[45].close = features[0].close * 1.01;
  candles[46].close = features[1].close * 0.99;
  candles[47].close = features[2].close;
  candles[31].high = 10000;
  candles[31].low = 0.001;
  const rows = directionRows(features, candles, 15);
  assert.deepEqual(rows.slice(0, 3).map(row => row.actualDirection), ['UP', 'DOWN', 'UNCHANGED']);
  assert.equal(rows[0].actualReturnPct, (candles[45].close / features[0].close - 1) * 100);
  assert.equal(rows[0].targetCloseTime, features[0].time + 15 * 60000);
  assert.equal(rows.length, features.length - 15);
  assert.throws(() => directionRows(features, candles, 0), /Invalid direction horizon/);
});

test('direction split purges labels that overlap the next training boundary', () => {
  const candles = normalizeKlines(klines());
  const rows = directionRows(buildFeatureRows(candles), candles, 60);
  const split = splitDirectionRows(rows, 60);
  assert.ok(split.train.at(-1).targetCloseTime < split.validation[0].time);
  assert.ok(split.validation.at(-1).targetCloseTime < split.holdout[0].time);
});

test('direction probabilities sum to one and do not depend on TP/SL options', () => {
  const candles = normalizeKlines(klines());
  const rows = directionRows(buildFeatureRows(candles), candles, 15);
  const first = trainAndEvaluateDirection(rows, 15, { steps: 10 });
  const second = trainAndEvaluateDirection(rows, 15, { steps: 10, targetPct: 500, stopPct: 0.001 });
  assert.deepEqual(first, second);
  const p = predictDirection(first.model, rows.at(-1).x);
  assert.ok(Math.abs(p.up + p.down + p.unchanged - 1) < 1e-12);
  assert.ok(Object.values(p).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.equal(first.model.approvedForTrading, false);
  assert.equal(first.report.calibration.selectedOn, 'VALIDATION_ONLY');
  assert.ok(first.report.holdout.baseline.samples > 0);
  assert.equal(first.report.holdout.model.samples, first.report.holdout.baseline.samples);
});

test('holdout labels and features cannot change fitted weights or calibration', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    index: i, time: i * 60000 + 59999, x: [i % 3 - 1], label: i % 3,
  }));
  const original = trainAndEvaluateDirection(rows, 15, { steps: 40 });
  const changed = trainAndEvaluateDirection(rows.map((row, i) => i < 800 ? row :
    { ...row, label: (row.label + 1) % 3, x: [1000] }), 15, { steps: 40 });
  assert.deepEqual(original.model, changed.model);
  assert.deepEqual(original.report.calibration, changed.report.calibration);
  assert.notDeepEqual(original.report.holdout.model, changed.report.holdout.model);
});

test('fresh direction forecasts are published even with low confidence or weak validation', () => {
  const m = { ...model(), temperature: 100, validationOutperformsBaseline: false };
  const feature = { time: 59999, close: 0.15, x: [1] };
  const prediction = forecastDirection(m, feature, 'DOGEUSDT', 60001);
  assert.equal(prediction.status, 'FORECAST');
  assert.equal(prediction.direction, 'UP');
  assert.ok(prediction.confidence < 0.55);
  assert.equal(prediction.action, undefined);
  assert.equal(prediction.threshold, undefined);
  assert.equal(prediction.tradeExecutionEnabled, false);
  assert.equal(prediction.targetCloseTime, feature.time + 15 * 60000);
  assert.equal(prediction.referencePrice, 0.15);
});

test('stale data, incompatible models, invalid weights and symbol mismatches fail closed', () => {
  const feature = { time: 59999, close: 1, x: [1] };
  const stale = forecastDirection(model(), feature, 'DOGEUSDT', 180000);
  assert.equal(stale.status, 'UNAVAILABLE');
  assert.equal(stale.probabilities, undefined);
  assert.throws(() => forecastDirection(model(), feature, 'BTCUSDT', 60000), /incompatible/);
  assert.throws(() => validateDirectionModel({ ...model(), approvedForTrading: true }), /incompatible/);
  assert.throws(() => validateDirectionModel({ ...model(), kind: 'predictive-hit-first-v2' }), /incompatible/);
  const invalid = model(); invalid.classifier.std[0] = 0;
  assert.throws(() => predictDirection(invalid, [1]), /incompatible/);
});

test('forward outcomes wait for horizon close and compare actual direction without TP/SL', () => {
  const candles = normalizeKlines(klines(100));
  const feature = { time: candles[10].closeTime, close: candles[10].close, x: [1] };
  const prediction = forecastDirection(model(), feature, 'DOGEUSDT', feature.time + 1);
  candles[25].close = feature.close * 1.01;
  assert.equal(scoreDirection(prediction, candles.slice(0, 25)), null);
  const records = [prediction];
  assert.equal(scorePendingDirection(records, candles).length, 1);
  assert.equal(scorePendingDirection(records, candles).length, 0);
  assert.equal(prediction.outcome.actualDirection, 'UP');
  assert.equal(prediction.outcome.correct, true);
  assert.ok(Number.isFinite(prediction.outcome.brier));
  assert.equal(directionSummary(records).byHorizon[15].accuracy, 1);
  const gap = candles.filter((_, i) => i !== 20);
  assert.equal(scoreDirection(prediction, gap), null);
  candles[25].close = feature.close;
  assert.equal(scoreDirection(prediction, candles).actualDirection, 'UNCHANGED');
});

test('state and model loading reject legacy objectives and mixed training runs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'predictive-direction-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const state = loadState(stateFile);
  assert.equal(state.objective, 'PRICE_DIRECTION');
  saveState(stateFile, state);
  assert.deepEqual(loadState(stateFile), state);
  saveState(stateFile, { ...state, records: [{ objective: 'PRICE_DIRECTION', symbol: 'BTCUSDT' }] });
  assert.throws(() => loadState(stateFile, 'DOGEUSDT'), /Incompatible shadow state/);
  fs.writeFileSync(stateFile, JSON.stringify({ version: 2, records: [] }));
  assert.throws(() => loadState(stateFile), /Incompatible shadow state/);
  for (const h of [15, 30, 60]) fs.writeFileSync(path.join(directory, `model-${h}m.json`), JSON.stringify(model(h)));
  assert.equal(loadModels(directory, 'DOGEUSDT').length, 3);
  fs.writeFileSync(path.join(directory, 'model-60m.json'), JSON.stringify({ ...model(60), trainingRunId: 'other-run' }));
  assert.throws(() => loadModels(directory, 'DOGEUSDT'), /same completed training run/);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ promotionEligible: false }));
  assert.throws(() => loadModels(directory, 'DOGEUSDT'), /accuracy promotion checks/);
});

test('training CLI produces compatible direction models and a complete research manifest', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'predictive-direction-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, 'DOGEUSDT-1m-1d.json');
  const output = path.join(directory, 'models');
  fs.writeFileSync(dataFile, JSON.stringify(klines()));
  const result = spawnSync(process.execPath, [path.resolve('scripts/train-predictive.js'), dataFile, output],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadModels(output, 'DOGEUSDT').length, 3);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json')));
  assert.equal(manifest.objective, 'PRICE_DIRECTION');
  assert.equal(manifest.trainingData.candles, 1000);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'report-15m.json')));
  assert.equal(report.holdout.model.samples, report.holdout.baseline.samples);
  assert.equal(report.validation.model.samples, report.validation.baseline.samples);
  assert.equal(report.selection, undefined);
  assert.equal(report.validation.netPctNotional, undefined);
});

function treeClassifier() {
  return { kind: 'boosted-direction-trees-v1', featureCount: 1, baseMargins: [0.5, 0.5, 0.5],
    trees: [{ classIndex: 0, left: [1, -1, -1], right: [2, -1, -1], feature: [0, 0, 0],
      values: [0.100000002, 2, -2] },
    { classIndex: 1, left: [-1], right: [-1], feature: [0], values: [0] },
    { classIndex: 2, left: [-1], right: [-1], feature: [0], values: [1] }] };
}

test('context features use only completed history and agree between training and the live window', () => {
  const candles = normalizeKlines(klines(1400));
  const full = buildDirectionFeatures(candles);
  const prefix = buildDirectionFeatures(candles.slice(0, 1000));
  assert.deepEqual(prefix, full.filter(row => row.index < 1000));
  const live = buildDirectionFeatures(candles.slice(-1000)).at(-1);
  assert.deepEqual(live.x, full.at(-1).x);
  assert.equal(live.x.length, NAMES.length);
  assert.equal(live.time, full.at(-1).time);
  const contexts = currentFeatures([model(), { ...model(), featureSchema: SCHEMA }], candles);
  assert.equal(contexts.get('base-v1').x.length, 9);
  assert.equal(contexts.get(SCHEMA).x.length, 37);
  assert.throws(() => currentFeatures([{ ...model(), featureSchema: 'unknown' }], candles), /Unsupported/);
});

test('portable trees match float32 split equality and reject corrupt structures', () => {
  const classifier = treeClassifier();
  const equal = predictBoosted(classifier, [0.1]);
  assert.ok(Math.abs(equal.down - Math.exp(-2) / (Math.exp(-2) + 1 + Math.exp(1))) < 1e-12);
  assert.ok(predictBoosted(classifier, [0.0999]).down > 0.5);
  assert.throws(() => predictBoosted(classifier, [NaN]), /Invalid/);
  const corrupt = treeClassifier(); corrupt.trees[0].left[0] = 0;
  assert.throws(() => validateBoostedClassifier(corrupt), /Invalid/);
  const invalid = treeClassifier(); invalid.trees[0].values[1] = Infinity;
  assert.throws(() => validateBoostedClassifier(invalid), /Invalid/);
});

test('ensembles preserve normalized direction probabilities and support runtime forecasting', () => {
  const linear = model();
  const classifier = { kind: 'direction-ensemble-v1', featureCount: 1, members: [
    { weight: 0.5, temperature: 1, featureIndices: [0], classifier: linear.classifier },
    { weight: 0.5, temperature: 1, featureIndices: [0], classifier: treeClassifier() },
  ] };
  const p = predictEnsemble(classifier, [1]);
  const first = predictDirection(linear, [1]), second = predictBoosted(treeClassifier(), [1]);
  for (const key of ['up', 'down', 'unchanged']) assert.ok(Math.abs(p[key] - (first[key] + second[key]) / 2) < 1e-12);
  const forecast = forecastDirection({ ...linear, classifier }, { time: 1000, close: 1, x: [1] }, 'DOGEUSDT', 1001);
  assert.equal(forecast.status, 'FORECAST');
  assert.equal(forecast.tradeExecutionEnabled, false);
});

test('validation selection retains a stronger baseline and accepts a genuinely more accurate candidate', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ label: i % 2 ? 0 : 2 }));
  const correct = rows.map(row => row.label === 0 ? { down: 0.8, unchanged: 0.01, up: 0.19 } :
    { down: 0.19, unchanged: 0.01, up: 0.8 });
  const wrong = correct.map(p => ({ ...p, up: p.down, down: p.up }));
  assert.equal(selectValidationCandidate(correct, wrong, rows).selected.weight, 0);
  assert.ok(selectValidationCandidate(wrong, correct, rows).selected.weight > 0);
});

test('uncertainty groups correlated forecasts by day rather than treating every minute as independent', () => {
  const differences = Array.from({ length: 200 }, (_, i) => ({
    time: (i < 100 ? 0 : 86400000) + i * 60000, value: i < 100 ? 1 : -1,
  }));
  const interval = pairedDayInterval(differences);
  assert.equal(interval.days, 2);
  assert.equal(interval.lower95, -1);
  assert.equal(interval.upper95, 1);
});

test('Python XGBoost exports and JavaScript inference agree', t => {
  const python = path.resolve('.venv-predictive/bin/python');
  if (!fs.existsSync(python)) { t.skip('Install requirements-predictive.txt for Python parity integration'); return; }
  const code = [
    'import importlib.util,json,numpy as np',
    'spec=importlib.util.spec_from_file_location("research","scripts/research-predictive-direction.py")',
    'm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)',
    'x=np.arange(300,dtype=np.float32).reshape(100,3)/100',
    'y=np.arange(100,dtype=np.int32)%3;t=np.arange(100,dtype=np.int64)*60000',
    'b=m.fit(x,y,t,int(t[-1]+120000),1,{"depth":2,"rounds":10,"minChildWeight":1})',
    'print(json.dumps({"classifier":m.export_classifier(b,3),"features":x.tolist(),"p":m.predict(b,x).tolist()}))',
  ].join('\n');
  const result = spawnSync(python, ['-c', code], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, OPENBLAS_NUM_THREADS: '2' } });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  data.features.forEach((features, i) => {
    const p = predictBoosted(data.classifier, features);
    [p.down, p.unchanged, p.up].forEach((value, j) => assert.ok(Math.abs(value - data.p[i][j]) < 1e-6));
  });
});
