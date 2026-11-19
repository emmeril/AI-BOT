#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeKlines, buildFeatureRows, FEATURE_NAMES } = require('../src/predictive/features');
const { directionRows } = require('../src/predictive/direction-model');
const { trainAndEvaluateDirection } = require('../src/predictive/direction-evaluation');

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/train-predictive.js <SYMBOL-1m-Nd.json> [output-dir]');
  const output = path.resolve(process.argv[3] || 'predictive-results');
  if (process.argv[4]) throw new Error('TP/SL training profiles are retired; training predicts price direction');
  const symbol = /^([A-Z0-9]{6,20})-1m-\d+d\.json$/.exec(path.basename(file))?.[1] ||
    process.env.PREDICTIVE_SYMBOL;
  if (!/^[A-Z0-9]{6,20}$/.test(symbol || '')) throw new Error('Specify a valid PREDICTIVE_SYMBOL');
  const candles = normalizeKlines(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
  const features = buildFeatureRows(candles);
  const trainingRunId = new Date().toISOString();
  const trainingData = { file: path.resolve(file), candles: candles.length,
    start: candles[0]?.time, end: candles.at(-1)?.closeTime };
  fs.mkdirSync(output, { recursive: true });
  const reports = {};
  for (const horizon of [15, 30, 60]) {
    const result = trainAndEvaluateDirection(directionRows(features, candles, horizon), horizon);
    const model = { ...result.model, featureNames: FEATURE_NAMES,
      symbol, trainedAt: new Date().toISOString(), trainingRunId, trainingData };
    model.modelId = 'direction-' + horizon + '-' + trainingRunId;
    const report = { ...result.report, symbol, modelId: model.modelId, trainingRunId, trainingData };
    fs.writeFileSync(path.join(output, 'model-' + horizon + 'm.json'),
      JSON.stringify(model, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'report-' + horizon + 'm.json'),
      JSON.stringify(report, null, 2) + '\n');
    reports[horizon] = { temperature: model.temperature,
      validation: report.validation, holdout: report.holdout };
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ objective: 'PRICE_DIRECTION',
    symbol, trainingRunId, trainingData, horizons: [15, 30, 60] }, null, 2) + '\n');
  console.log(JSON.stringify({ output, objective: 'PRICE_DIRECTION', reports,
    liveTradingEnabled: false }, null, 2));
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { main };
