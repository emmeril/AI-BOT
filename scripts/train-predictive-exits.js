#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { normalizeKlines } = require('../src/predictive/features');
const { SCHEMA, NAMES, buildDirectionFeatures } = require('../src/predictive/direction-features');
const { KIND, QUANTILES, excursionScale, excursionLabels, validateExitModel, planExit } = require('../src/predictive/exit-planner');
const { predictTreeMargins } = require('../src/predictive/boosted-classifier');
const { forecastDirection } = require('../src/predictive/direction-forward');
const { scoreExitPlan, exitSummary } = require('../src/predictive/exit-evaluator');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function prepare(file, directionDirectory, outputDirectory) {
  if (!/^DOGEUSDT-1m-\d+d\.json$/.test(path.basename(file))) throw new Error('Use DOGEUSDT candle history');
  const candles = normalizeKlines(JSON.parse(fs.readFileSync(file)));
  const rows = buildDirectionFeatures(candles);
  const horizons = {};
  for (const horizon of [15, 30, 60]) {
    const modelFile = path.join(directionDirectory, `model-${horizon}m.json`);
    const model = JSON.parse(fs.readFileSync(modelFile));
    if (model.symbol !== 'DOGEUSDT' || model.horizon !== horizon || model.classifier.kind !== 'softmax-baseline-v1') {
      throw new Error('Use the current frozen DOGE direction baseline');
    }
    const report = JSON.parse(fs.readFileSync(path.join(directionDirectory, `report-${horizon}m.json`)));
    const labels = excursionLabels(rows, candles, horizon);
    const pad = values => [...values, ...Array(rows.length - labels.length).fill(null)];
    horizons[horizon] = { boundaries: report.boundaries, directionModelId: model.modelId,
      directionModelHash: digest(modelFile), scalePct: rows.map(row => excursionScale(row.x, horizon)),
      upPct: pad(labels.map(row => row.upPct)), downPct: pad(labels.map(row => row.downPct)) };
  }
  const input = { symbol: 'DOGEUSDT', source: path.resolve(file), featureSchema: SCHEMA,
    featureNames: NAMES, features: rows.map(row => row.x), times: rows.map(row => row.time), horizons };
  fs.writeFileSync(path.join(outputDirectory, 'training-input.json'), JSON.stringify(input));
  return { input, rows, candles };
}

function finish(input, rows, candles, directionDirectory, outputDirectory) {
  const runId = new Date().toISOString(), reports = {};
  for (const horizon of [15, 30, 60]) {
    const raw = JSON.parse(fs.readFileSync(path.join(outputDirectory, `raw-exits-${horizon}m.json`)));
    let parityMaxError = 0;
    for (const side of ['up', 'down']) {
      const fixture = raw.parity[side];
      fixture.features.forEach((features, i) => predictTreeMargins(fixture.classifier, features)
        .forEach((value, j) => { parityMaxError = Math.max(parityMaxError, Math.abs(value - fixture.predictions[i][j])); }));
    }
    if (parityMaxError > 1e-5) throw new Error('Excursion model inference parity failed');
    const source = input.horizons[horizon];
    const modelFile = path.join(directionDirectory, `model-${horizon}m.json`);
    if (digest(modelFile) !== source.directionModelHash) throw new Error('Direction baseline changed during exit training');
    const directionModel = JSON.parse(fs.readFileSync(modelFile));
    const model = { kind: KIND, objective: 'FUTURE_PRICE_EXCURSIONS', symbol: input.symbol,
      horizon, reference: 'SIGNAL_CANDLE_CLOSE', featureSchema: SCHEMA, featureNames: NAMES,
      quantiles: QUANTILES, estimators: raw.estimators, approvedForTrading: false,
      directionModelId: source.directionModelId, directionModelHash: source.directionModelHash,
      modelId: `exit-quantiles-${horizon}-${runId}`, trainingRunId: runId, source: input.source,
      splitBoundaries: source.boundaries, targetQuantile: 0.5, stopQuantile: 0.75 };
    validateExitModel(model, input.symbol, directionModel.modelId);
    const evaluated = [];
    for (const row of rows) {
      if (row.time < source.boundaries.holdoutStart || row.index + horizon >= candles.length) continue;
      const direction = forecastDirection(directionModel, { ...row, x: row.x.slice(0, 9) }, input.symbol, row.time + 1);
      direction.exitPlan = planExit(direction, model, row.x);
      direction.exitOutcome = scoreExitPlan(direction, candles, row.index);
      evaluated.push(direction);
    }
    const report = { objective: model.objective, modelId: model.modelId, directionModelId: model.directionModelId,
      horizon, targetQuantile: 0.5, stopQuantile: 0.75, parityMaxError, estimators: raw.report,
      historicalShadowSimulation: exitSummary(evaluated), simulationPriceRounding: 'UNROUNDED_REFERENCE_LEVELS',
      historicalHoldoutPreviouslyInspected: true,
      limitations: ['Quantile coverage is not probability of TP before SL',
        'Levels reference the signal close; simulated entries use next open with slippage',
        'Overlapping forecast simulations are not a portfolio',
        'Fees and slippage are assumptions; funding, liquidation and exact exchange fills are not modeled'] };
    fs.writeFileSync(path.join(outputDirectory, `exit-model-${horizon}m.json`), JSON.stringify(model, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(outputDirectory, `exit-report-${horizon}m.json`), JSON.stringify(report, null, 2));
    reports[horizon] = report;
  }
  fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), JSON.stringify({ objective: 'FUTURE_PRICE_EXCURSIONS',
    symbol: input.symbol, trainingRunId: runId, directionModelIds: Object.values(input.horizons).map(h => h.directionModelId),
    horizons: [15, 30, 60], completed: true }, null, 2));
  console.log(JSON.stringify({ outputDirectory, reports }, null, 2));
}

function main() {
  const [file, directionDirectory, outputDirectory] = process.argv.slice(2);
  if (!outputDirectory) throw new Error('Usage: node scripts/train-predictive-exits.js <DOGE-history.json> <direction-model-dir> <new-exit-model-dir>');
  if (fs.existsSync(outputDirectory)) throw new Error('Use a new exit model directory');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const { input, rows, candles } = prepare(file, directionDirectory, outputDirectory);
  const run = spawnSync(path.resolve('.venv-predictive/bin/python'),
    [path.resolve('scripts/train-predictive-exits.py'), path.join(outputDirectory, 'training-input.json'), outputDirectory],
    { stdio: 'inherit', timeout: 600000, env: { ...process.env, OPENBLAS_NUM_THREADS: '2' } });
  if (run.error || run.status !== 0) throw run.error || new Error('Exit model training failed');
  finish(input, rows, candles, directionDirectory, outputDirectory);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}

module.exports = { prepare, finish };
