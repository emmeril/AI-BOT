#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeKlines, buildFeatureRows, FEATURE_NAMES } = require('../src/predictive/features');
const { labeledRows } = require('../src/predictive/labels');
const { trainAndEvaluate } = require('../src/predictive/v2-evaluation');

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/train-predictive.js <klines.json> [output-dir]');
  const output = path.resolve(process.argv[3] || 'predictive-results');
  const candles = normalizeKlines(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
  const features = buildFeatureRows(candles);
  fs.mkdirSync(output, { recursive: true });
  const reports = {};
  for (const horizon of [15, 30, 60]) {
    const config = { horizon, targetPct: 0.9, stopPct: 0.3,
      feePct: 0.05, slippagePct: 0.02, minNetRewardRisk: 1.5 };
    const samples = labeledRows(features, candles, config);
    const result = trainAndEvaluate(samples, config);
    const model = { ...result.model, featureNames: FEATURE_NAMES,
      trainedAt: new Date().toISOString(), approvedForTrading: false };
    const report = { ...result.report, labeledSamples: samples.length };
    fs.writeFileSync(path.join(output, 'model-' + horizon + 'm.json'),
      JSON.stringify(model, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'report-' + horizon + 'm.json'),
      JSON.stringify(report, null, 2) + '\n');
    reports[horizon] = { selection: report.selection, validation: report.validation,
      holdout: report.holdout, approvedForTrading: false };
  }
  console.log(JSON.stringify({ output, reports, liveTradingEnabled: false }, null, 2));
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { main };
