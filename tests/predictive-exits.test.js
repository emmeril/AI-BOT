'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { KIND, excursionScale, excursionLabels, estimateExcursions, planExit } = require('../src/predictive/exit-planner');
const { SCHEMA, NAMES } = require('../src/predictive/direction-features');
const { predictTreeMargins, predictBoosted } = require('../src/predictive/boosted-classifier');
const { scoreExitPlan, exitSummary } = require('../src/predictive/exit-evaluator');
const { scorePendingDirection } = require('../src/predictive/direction-forward');
const { loadExitModels, fetchPriceTick } = require('../scripts/start-predictive-shadow');
const { loadState, saveState } = require('../scripts/start-predictive-shadow');
const { accountExitOutcome, normalizeFixedSizing } = require('../src/predictive/shadow-sizing');
const { reachabilityFixture, setReachThreshold } = require('./helpers/reachability-fixture');

function features(volatility = 0) {
  const x = Array(NAMES.length).fill(0);
  x[NAMES.indexOf('volatility60')] = volatility;
  return x;
}

function exitModel(horizon = 15) {
  return { kind: KIND, objective: 'FUTURE_PRICE_EXCURSIONS', symbol: 'DOGEUSDT', horizon,
    reference: 'SIGNAL_CANDLE_CLOSE', featureSchema: SCHEMA, quantiles: [0.25, 0.5, 0.75],
    directionModelId: 'direction-' + horizon, modelId: 'exit-' + horizon, trainingRunId: 'exit-run',
    approvedForTrading: false, estimators: {
      up: { regressor: { kind: 'quantile-constant-v1', values: [10, 20, 40] }, offsets: [0, 0, 0] },
      down: { regressor: { kind: 'quantile-constant-v1', values: [10, 30, 50] }, offsets: [0, 0, 0] },
    } };
}

function forecast(direction = 'UP') {
  return { id: 'test', objective: 'PRICE_DIRECTION', status: 'FORECAST', symbol: 'DOGEUSDT',
    modelId: 'direction-15', horizon: 15, direction, confidence: 0.49,
    probabilities: { up: 0.49, down: 0.48, unchanged: 0.03 },
    candleCloseTime: 59999, targetCloseTime: 959999, referencePrice: 100 };
}

function candles(count = 20) {
  return Array.from({ length: count }, (_, i) => ({
    time: i * 60000, closeTime: i * 60000 + 59999,
    open: 100, high: 100.01, low: 99.99, close: 100,
  }));
}

test('excursion labels measure the next horizon high and low without using the signal candle extremes', () => {
  const data = candles();
  data[0].high = 10000; data[0].low = 0.01;
  data[1].high = 101; data[3].low = 98; data[16].high = 120;
  const [label] = excursionLabels([{ index: 0, time: 59999, close: 100 }], data, 15);
  assert.ok(Math.abs(label.upPct - 1) < 1e-10);
  assert.ok(Math.abs(label.downPct - 2) < 1e-10);
  assert.equal(label.targetCloseTime, 959999);
});

test('exit estimates adapt to current volatility and preserve ordered nonnegative quantiles', () => {
  const m = exitModel();
  const low = estimateExcursions(m, features(0.0001));
  const high = estimateExcursions(m, features(0.0002));
  assert.ok(high.up[1] > low.up[1]);
  assert.ok(high.down[2] > low.down[2]);
  m.estimators.up.offsets = [-50, 20, -20];
  const crossed = estimateExcursions(m, features());
  assert.ok(crossed.up.every((value, i) => value >= 0 && (!i || value >= crossed.up[i - 1])));
  assert.throws(() => excursionScale([1], 15), /Invalid/);
});

test('direction determines LONG or SHORT plans while direction probabilities remain untouched', () => {
  const original = forecast();
  const copy = structuredClone(original);
  const long = planExit(original, exitModel(), features());
  const short = planExit(forecast('DOWN'), exitModel(), features());
  assert.deepEqual(original, copy);
  assert.equal(long.status, 'ESTIMATED');
  assert.equal(long.side, 'LONG');
  assert.ok(long.takeProfit > 100 && long.stopLoss < 100);
  assert.equal(short.side, 'SHORT');
  assert.ok(short.takeProfit < 100 && short.stopLoss > 100);
  assert.equal(long.targetQuantile, 0.5);
  assert.equal(long.stopQuantile, 0.75);
  assert.equal(long.executionAllowed, false);
  assert.equal(long.notionalUsdt, 100);
  assert.equal(long.sizing, 'FIXED_NOTIONAL');
  assert.equal(long.compounding, false);
  assert.equal(long.expiresAt, original.targetCloseTime);
});

test('tick rounding brings targets toward entry and stops away from entry', () => {
  const long = planExit(forecast(), exitModel(), features(), { tickSize: 0.3 });
  const short = planExit(forecast('DOWN'), exitModel(), features(), { tickSize: 0.3 });
  assert.equal(long.takeProfit, 100.2);
  assert.equal(long.stopLoss, 99.3);
  assert.equal(short.takeProfit, 99.9);
  assert.equal(short.stopLoss, 100.5);
  assert.equal(long.tickRoundingApplied, true);
  assert.equal(planExit(forecast(), exitModel(), features(), { tickSize: 10 }).reason, 'ESTIMATE_BELOW_PRICE_TICK');
});

test('poor cost coverage does not suppress price direction or invent a larger target', () => {
  const plan = planExit(forecast(), exitModel(), features(), { feePct: 1, slippagePct: 1 });
  assert.equal(plan.status, 'ESTIMATED');
  assert.equal(plan.coversEstimatedCosts, false);
  assert.ok(plan.estimatedNetRewardRisk < 0);
  assert.equal(plan.takeProfit, planExit(forecast(), exitModel(), features()).takeProfit);
});

test('intrahorizon target support uses the median stop without changing direction or imposing q75', () => {
  const f = forecast();
  const original = structuredClone(f);
  const model = exitModel(), x = features(0.001);
  model.estimators.up.regressor.values = [0.1, 0.2, 0.4];
  model.estimators.down.regressor.values = [0.1, 0.3, 0.5];
  const reachability = reachabilityFixture(15, f.modelId, model.modelId, 0.01);
  const missing = planExit(f, exitModel(), features(), { tickSize: 0.01, targetLevels: true });
  assert.equal(missing.reason, 'REACHABILITY_MODEL_UNAVAILABLE');
  const options = { tickSize: 0.01, targetLevels: true, reachabilityModel: reachability };
  const blocked = planExit(f, model, x, options);
  assert.equal(blocked.reason, 'TP1_BEFORE_SL_NOT_SUPPORTED');
  assert.deepEqual(f, original);
  setReachThreshold(reachability, 3);
  const plan = planExit(f, model, x, options);
  assert.equal(plan.status, 'ESTIMATED');
  assert.equal(plan.stopQuantile, 0.5);
  assert.ok(plan.takeProfit > plan.modelRangeQ75);
  assert.ok(plan.probabilityTpBeforeSl > 0.5);
  assert.ok(plan.estimatedNetRewardRisk >= 2 - 1e-9);
  assert.equal(plan.notionalUsdt, 100);
  assert.deepEqual(f, original);
  const scale = excursionScale(x, 15), entryFill = f.referencePrice * 1.0002;
  const distances = plan.targetLevels.map(t => Math.abs(t.takeProfit / entryFill - 1) * 100 / scale);
  setReachThreshold(reachability, (distances[0] + distances[1]) / 2);
  const tp1 = planExit(f, model, x, options);
  assert.equal(tp1.selectedTarget, 'TP1');
  assert.equal(tp1.takeProfit, tp1.takeProfit1);
  assert.ok(tp1.estimatedNetRewardRisk >= 1 - 1e-9);
  setReachThreshold(reachability, 3);
  model.estimators.up.regressor.values = [0, 0, 0];
  assert.equal(planExit(f, model, x, options).status, 'ESTIMATED');
});

test('non-directional, stale or mismatched forecasts cannot produce executable plans', () => {
  assert.equal(planExit(forecast('UNCHANGED'), exitModel(), features()).status, 'NOT_APPLICABLE');
  assert.equal(planExit(forecast('UNCERTAIN'), exitModel(), features()).status, 'NOT_APPLICABLE');
  assert.equal(planExit({ ...forecast(), status: 'UNAVAILABLE' }, exitModel(), features()).status, 'UNAVAILABLE');
  assert.equal(planExit(forecast(), null, features()).reason, 'EXIT_MODEL_UNAVAILABLE');
  assert.throws(() => planExit({ ...forecast(), modelId: 'different' }, exitModel(), features()), /Incompatible/);
  assert.throws(() => planExit(forecast(), { ...exitModel(), symbol: 'BTCUSDT' }, features()), /Incompatible/);
});

test('exit scoring waits for the horizon, gives ambiguous touches to SL, and remains idempotent', () => {
  const f = forecast(), data = candles();
  f.exitPlan = planExit(f, exitModel(), features(), { feePct: 0, slippagePct: 0 });
  data[1].high = 101; data[1].low = 99;
  assert.equal(scoreExitPlan(f, data.slice(0, 15)), null);
  const result = scoreExitPlan(f, data);
  assert.equal(result.result, 'SL');
  assert.equal(result.ambiguous, true);
  assert.ok(result.simulatedNetPct < 0);
  assert.equal(scorePendingDirection([f], data).length, 1);
  assert.equal(scorePendingDirection([f], data).length, 0);
  assert.equal(exitSummary([f]).results.SL, 1);
  assert.equal(f.outcome.actualDirection, 'UNCHANGED');
});

test('entry gaps are skipped and later stop gaps fill at the adverse candle open', () => {
  const f = forecast(), data = candles();
  f.exitPlan = planExit(f, exitModel(), features(), { feePct: 0, slippagePct: 0 });
  data[1].open = 101;
  const skipped = scoreExitPlan(f, data);
  assert.equal(skipped.result, 'SKIPPED_ENTRY_GAP');
  assert.equal(skipped.executedNotionalUsdt, 0);
  assert.equal(skipped.quantity, 0);
  assert.equal(skipped.simulatedNetUsdt, null);
  data[1].open = 100;
  data[2] = { ...data[2], open: 98, high: 98.01, low: 97.99, close: 98 };
  const result = scoreExitPlan(f, data);
  assert.equal(result.result, 'SL_GAP');
  assert.equal(result.exitPrice, 98);
  assert.equal(scoreExitPlan(f, data.filter((_, i) => i !== 7)), null);
});

test('each completed shadow trade uses fixed 100 USDT even after previous wins or losses', () => {
  const plan = { side: 'LONG', costAssumptions: { feePctPerSide: 0 } };
  const results = [201, 196, 204].map(exitPrice => accountExitOutcome({
    result: 'TIMEOUT', entryPrice: 200, exitPrice,
    simulatedNetPct: (exitPrice / 200 - 1) * 100,
  }, plan));
  for (const result of results) {
    assert.equal(result.executedNotionalUsdt, 100);
    assert.equal(result.quantity, 0.5);
    assert.equal(result.compounding, false);
    assert.ok(Math.abs(result.grossPnlUsdt - result.simulatedNetUsdt) < 1e-10);
  }
  const cheaper = accountExitOutcome({ result: 'TP', entryPrice: 50, exitPrice: 51, simulatedNetPct: 2 }, plan);
  assert.equal(cheaper.executedNotionalUsdt, 100);
  assert.equal(cheaper.quantity, 2);
  assert.equal(cheaper.simulatedNetUsdt, 2);
});

test('100 USDT monetary outcomes reconcile with original net percentages after fees', () => {
  const f = forecast(), data = candles();
  f.exitPlan = planExit(f, exitModel(), features());
  data[1].high = 101;
  const result = scoreExitPlan(f, data);
  assert.equal(result.executedNotionalUsdt, 100);
  assert.equal(result.entryPrice * result.quantity, 100);
  assert.ok(result.feesUsdt > 0);
  assert.ok(Math.abs(result.grossPnlUsdt - result.feesUsdt - result.simulatedNetUsdt) < 1e-10);
  assert.ok(Math.abs(result.simulatedNetUsdt - result.simulatedNetPct) < 1e-10);
});

test('legacy completed outcomes gain fixed sizing without changing prices, percentages or counts', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'predictive-fixed-sizing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = forecast(), data = candles();
  f.exitPlan = planExit(f, exitModel(), features());
  data[1].high = 101;
  const completed = scoreExitPlan(f, data);
  f.exitOutcome = { result: completed.result, entryPrice: completed.entryPrice,
    exitPrice: completed.exitPrice, simulatedNetPct: completed.simulatedNetPct, simulatedOnly: true };
  delete f.exitPlan.notionalUsdt; delete f.exitPlan.sizing; delete f.exitPlan.compounding;
  const original = structuredClone(f);
  const file = path.join(directory, 'state.json');
  saveState(file, { version: 2, objective: 'PRICE_DIRECTION', records: [f] });
  const state = loadState(file, 'DOGEUSDT');
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].exitPlan.notionalUsdt, 100);
  assert.equal(state.records[0].exitOutcome.simulatedNetPct, original.exitOutcome.simulatedNetPct);
  assert.equal(state.records[0].exitOutcome.entryPrice, original.exitOutcome.entryPrice);
  assert.equal(state.records[0].exitOutcome.exitPrice, original.exitOutcome.exitPrice);
  assert.equal(state.simulationSizing.compounding, false);
  const once = structuredClone(state);
  normalizeFixedSizing(state.records);
  assert.deepEqual(state, once);
  saveState(file, state);
  assert.deepEqual(loadState(file, 'DOGEUSDT'), state);
});

test('fixed-notional summaries separate accumulated USDT results from order sizing and skipped entries', () => {
  const records = [1, -2, 0].map(simulatedNetPct => ({ exitPlan: { status: 'ESTIMATED' },
    exitOutcome: { result: 'TIMEOUT', simulatedNetPct } }));
  records.push({ exitPlan: { status: 'ESTIMATED' },
    exitOutcome: { result: 'SKIPPED_ENTRY_GAP', simulatedNetPct: null } });
  const summary = exitSummary(records);
  assert.equal(summary.notionalUsdtPerTrade, 100);
  assert.equal(summary.compounding, false);
  assert.equal(summary.simulatedTrades, 3);
  assert.equal(summary.netWins, 1);
  assert.equal(summary.netLosses, 1);
  assert.equal(summary.breakeven, 1);
  assert.equal(summary.netWinRate, 1 / 3);
  assert.equal(summary.totalSimulatedNetUsdt, -1);
  assert.equal(summary.meanSimulatedNetUsdtPerTrade, -1 / 3);
  assert.equal(summary.overlappingForecastsAreNotAPortfolio, true);
});

test('quantile tree outputs are excursions, and cannot be interpreted as direction probabilities', () => {
  const regressor = { kind: 'boosted-quantile-trees-v1', featureCount: NAMES.length,
    baseMargins: [0.5, 0.5, 0.5], trees: [0, 1, 2].map(i => ({
      classIndex: i, left: [-1], right: [-1], feature: [0], values: [i + 0.5],
    })) };
  assert.deepEqual(predictTreeMargins(regressor, features()), [1, 2, 3]);
  assert.throws(() => predictBoosted(regressor, features()), /Expected a direction classifier/);
});

test('exit bundle loading binds to frozen direction IDs and public metadata supplies tick size', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'predictive-exit-loader-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    objective: 'FUTURE_PRICE_EXCURSIONS', symbol: 'DOGEUSDT', completed: true, trainingRunId: 'exit-run',
  }));
  const models = [15, 30, 60].map(horizon => ({ horizon, modelId: 'direction-' + horizon }));
  for (const h of [15, 30, 60]) fs.writeFileSync(path.join(directory, `exit-model-${h}m.json`), JSON.stringify(exitModel(h)));
  assert.equal(loadExitModels(directory, 'DOGEUSDT', models).size, 3);
  assert.throws(() => loadExitModels(directory, 'DOGEUSDT', [{ horizon: 15, modelId: 'other' }]), /Incompatible/);
  const tick = await fetchPriceTick({ fapiPublicGetExchangeInfo: async () => ({ symbols: [{ symbol: 'DOGEUSDT',
    filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.000010' }] }] }) }, 'DOGEUSDT');
  assert.equal(tick, 0.00001);
  await assert.rejects(fetchPriceTick({ fapiPublicGetExchangeInfo: async () => ({ symbols: [] }) }, 'DOGEUSDT'), /unavailable/);
});

test('Python quantile regression exports reproduce untransformed JavaScript margins', t => {
  const python = path.resolve('.venv-predictive/bin/python');
  if (!fs.existsSync(python)) { t.skip('Install requirements-predictive.txt for Python parity integration'); return; }
  const code = [
    'import importlib.util,json,numpy as np,xgboost as xgb',
    's=importlib.util.spec_from_file_location("r","scripts/research-predictive-direction.py")',
    'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
    'x=np.arange(120,dtype=np.float32).reshape(40,3)/40;y=np.sin(x[:,0])+2',
    'b=xgb.train({"objective":"reg:quantileerror","quantile_alpha":[0.25,0.5,0.75],"tree_method":"hist","base_score":0.5,"max_depth":2,"nthread":2},xgb.DMatrix(x,label=y,nthread=2),num_boost_round=5)',
    'c=m.export_classifier(b,3);c["kind"]="boosted-quantile-trees-v1"',
    'print(json.dumps({"c":c,"x":x.tolist(),"p":b.predict(xgb.DMatrix(x,nthread=2)).tolist()}))',
  ].join('\n');
  const result = spawnSync(python, ['-c', code], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, OPENBLAS_NUM_THREADS: '2' } });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  data.x.forEach((x, i) => predictTreeMargins(data.c, x).forEach((value, j) =>
    assert.ok(Math.abs(value - data.p[i][j]) < 1e-6)));
});
