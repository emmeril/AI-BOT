#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { prepare } = require('./prepare-direction-research');
const { SCHEMA, NAMES } = require('../src/predictive/direction-features');
const { FEATURE_NAMES } = require('../src/predictive/features');
const { predictResearchClassifier } = require('../src/predictive/boosted-classifier');
const { KEYS, predictDirection, temperatureScale } = require('../src/predictive/direction-model');
const { classificationMetrics } = require('../src/predictive/direction-evaluation');

function selectValidationCandidate(baseline, boosted, rows) {
  const candidates = [0, 0.25, 0.5, 1].map(weight => {
    const mixed = boosted.map((p, i) => Object.fromEntries(KEYS.map(key =>
      [key, weight * p[key] + (1 - weight) * baseline[i][key]])));
    const temperatures = (weight ? [0.75, 1, 1.5, 2, 3] : [1]).map(temperature => ({
      temperature, metrics: classificationMetrics(mixed.map(p => temperatureScale(p, temperature)), rows),
    })).sort((a, b) => a.metrics.logLoss - b.metrics.logLoss);
    return { weight, ...temperatures[0] };
  });
  const baselineResult = candidates[0];
  const best = [...candidates].sort((a, b) => b.metrics.accuracy - a.metrics.accuracy ||
    a.metrics.logLoss - b.metrics.logLoss)[0];
  const selected = best.metrics.accuracy >= baselineResult.metrics.accuracy + 0.002 &&
    best.metrics.logLoss <= baselineResult.metrics.logLoss + 0.002 ? best : baselineResult;
  return { selected, candidates, selectedOn: 'VALIDATION_ONLY',
    rule: 'At least 0.2 percentage point accuracy improvement; log loss deterioration at most 0.002' };
}

function pairedDayInterval(differences) {
  const blocks = new Map();
  for (const row of differences) {
    const day = Math.floor(row.time / 86400000);
    const block = blocks.get(day) || { count: 0, sum: 0 };
    block.count++; block.sum += row.value; blocks.set(day, block);
  }
  const days = [...blocks.values()];
  let seed = 173;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const samples = Array.from({ length: 2000 }, () => {
    let sum = 0, count = 0;
    for (let i = 0; i < days.length; i++) {
      const day = days[Math.floor(random() * days.length)];
      sum += day.sum; count += day.count;
    }
    return sum / count;
  }).sort((a, b) => a - b);
  return { days: days.length, method: 'Paired UTC-day block bootstrap, 2000 resamples',
    lower95: samples[49], upper95: samples[1949] };
}

function finish(input, rawDirectory, baselineDirectory, outputDirectory) {
  const data = JSON.parse(fs.readFileSync(input));
  if (data.symbol !== 'DOGEUSDT' || data.featureSchema !== SCHEMA ||
      JSON.stringify(data.featureNames) !== JSON.stringify(NAMES)) throw new Error('Incompatible research dataset');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const runId = new Date().toISOString();
  const frozen = [];
  for (const horizon of [15, 30, 60]) {
    const base = JSON.parse(fs.readFileSync(path.join(baselineDirectory, `model-${horizon}m.json`)));
    if (base.classifier.kind !== 'softmax-baseline-v1' || base.symbol !== 'DOGEUSDT') {
      throw new Error('Research comparator must be the frozen DOGE linear baseline');
    }
    const raw = JSON.parse(fs.readFileSync(path.join(rawDirectory, `classifier-${horizon}m.json`)));
    let parityMaxError = 0;
    raw.parity.features.forEach((x, i) => {
      const p = predictResearchClassifier(raw.classifier, x);
      KEYS.forEach((key, j) => {
        parityMaxError = Math.max(parityMaxError, Math.abs(p[key] - raw.parity.probabilities[i][j]));
      });
    });
    if (parityMaxError > 1e-6) throw new Error('Python/JavaScript prediction parity failed');
    const indices = data.times.map((time, i) => ({ time, i })).filter(({ time, i }) =>
      time >= data.boundaries.validationStart && time + horizon * 60000 < data.boundaries.holdoutStart &&
      data.labels[horizon][i] >= 0).map(row => row.i);
    const rows = indices.map(i => ({ label: data.labels[horizon][i] }));
    const before = indices.map(i => predictDirection(base, data.features[i].slice(0, FEATURE_NAMES.length)));
    const after = indices.map(i => predictResearchClassifier(raw.classifier, data.features[i]));
    const selection = selectValidationCandidate(before, after, rows);
    const weight = selection.selected.weight;
    let classifier = base.classifier;
    if (weight === 1) classifier = raw.classifier;
    else if (weight > 0) classifier = { kind: 'direction-ensemble-v1', featureCount: NAMES.length,
      members: [{ weight: 1 - weight, temperature: base.temperature, classifier: base.classifier,
        featureIndices: FEATURE_NAMES.map((_, i) => i) },
      { weight, temperature: 1, classifier: raw.classifier, featureIndices: NAMES.map((_, i) => i) }] };
    const model = { ...base, classifier, temperature: weight ? selection.selected.temperature : base.temperature,
      featureSchema: weight ? SCHEMA : 'base-v1', featureNames: weight ? NAMES : FEATURE_NAMES,
      modelId: `direction-research-${horizon}-${runId}`, trainingRunId: runId,
      sourceBaselineModelId: base.modelId, sourceBaselineDirectory: path.resolve(baselineDirectory),
      researchData: { source: data.source, boundaries: data.boundaries },
      validationOutperformsBaseline: selection.selected.metrics.logLoss < selection.candidates[0].metrics.logLoss };
    fs.writeFileSync(path.join(outputDirectory, `model-${horizon}m.json`), JSON.stringify(model, null, 2), { mode: 0o600 });
    frozen.push({ horizon, model, base, selection, treeSelection: raw.selection, parityMaxError });
  }
  fs.writeFileSync(path.join(outputDirectory, 'frozen-selection.json'), JSON.stringify(frozen.map(row => ({
    horizon: row.horizon, modelId: row.model.modelId, selection: row.selection,
    treeSelection: row.treeSelection, parityMaxError: row.parityMaxError,
  })), null, 2));

  const comparison = [], allDifferences = [];
  for (const entry of frozen) {
    const { horizon, model, base } = entry;
    const indices = data.times.map((time, i) => ({ time, i })).filter(({ time, i }) =>
      time >= data.boundaries.holdoutStart && data.labels[horizon][i] >= 0).map(row => row.i);
    const rows = indices.map(i => ({ label: data.labels[horizon][i] }));
    const oldP = indices.map(i => predictDirection(base, data.features[i].slice(0, FEATURE_NAMES.length)));
    const newP = indices.map(i => predictDirection(model, model.featureSchema === SCHEMA ?
      data.features[i] : data.features[i].slice(0, FEATURE_NAMES.length)));
    const baseline = classificationMetrics(oldP, rows), candidate = classificationMetrics(newP, rows);
    const differences = indices.map((index, i) => {
      const correct = p => Number(KEYS.map(key => p[key]).indexOf(Math.max(...KEYS.map(key => p[key]))) === rows[i].label);
      return { time: data.times[index], value: correct(newP[i]) - correct(oldP[i]) };
    });
    allDifferences.push(...differences);
    const result = { horizon, selectedWeight: entry.selection.selected.weight,
      baseline, candidate, accuracyDelta: candidate.accuracy - baseline.accuracy,
      pairedDayInterval: pairedDayInterval(differences) };
    comparison.push(result);
    fs.writeFileSync(path.join(outputDirectory, `report-${horizon}m.json`), JSON.stringify({
      objective: 'PRICE_DIRECTION', modelId: model.modelId,
      selection: entry.selection, temporalModelSelection: entry.treeSelection,
      audit: result, historicalAuditPreviouslyInspected: true,
      limitations: ['Historical audit overlaps the previously inspected baseline holdout; exploratory evidence only',
        'Future forward results are required to establish improvement', 'Forecasts overlap in time; daily blocks preserve within-day dependence'],
    }, null, 2));
  }
  const total = comparison.reduce((sum, row) => sum + row.baseline.samples, 0);
  const mean = (key, field) => comparison.reduce((sum, row) => sum + row[key][field] * row[key].samples, 0) / total;
  const delta = mean('candidate', 'accuracy') - mean('baseline', 'accuracy');
  const promotionEligible = delta > 0 && comparison.every(row => row.accuracyDelta >= -0.005) &&
    mean('candidate', 'logLoss') <= mean('baseline', 'logLoss') + 0.001;
  const summary = { objective: 'PRICE_DIRECTION', symbol: 'DOGEUSDT', trainingRunId: runId,
    comparison, aggregate: { baselineAccuracy: mean('baseline', 'accuracy'),
      candidateAccuracy: mean('candidate', 'accuracy'), accuracyDelta: delta,
      pairedDayInterval: pairedDayInterval(allDifferences) }, promotionEligible,
    historicalAuditPreviouslyInspected: true, futureImprovementEstablished: false };
  fs.writeFileSync(path.join(outputDirectory, 'comparison.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), JSON.stringify({ objective: 'PRICE_DIRECTION',
    symbol: 'DOGEUSDT', trainingRunId: runId, horizons: [15, 30, 60], promotionEligible,
    historicalAuditPreviouslyInspected: true, completed: true }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function main() {
  const [file, baselineDirectory, outputDirectory] = process.argv.slice(2);
  if (!outputDirectory) throw new Error('Usage: node scripts/research-predictive-direction.js <DOGE-data.json> <frozen-baseline-dir> <new-output-dir>');
  if (fs.existsSync(outputDirectory)) throw new Error('Use a new research output directory');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const input = path.join(outputDirectory, 'training-input.json');
  prepare(file, input);
  const python = path.resolve('.venv-predictive/bin/python');
  const rawDirectory = path.join(outputDirectory, 'raw');
  const run = spawnSync(python, [path.resolve('scripts/research-predictive-direction.py'), input, rawDirectory],
    { stdio: 'inherit', timeout: 600000, env: { ...process.env, OPENBLAS_NUM_THREADS: '2' } });
  if (run.error || run.status !== 0) throw run.error || new Error('Predictive research training failed');
  finish(input, rawDirectory, baselineDirectory, outputDirectory);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}

module.exports = { selectValidationCandidate, pairedDayInterval, finish };
