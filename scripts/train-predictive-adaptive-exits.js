#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { normalizeKlines } = require('../src/predictive/features');
const { forecastDirection } = require('../src/predictive/direction-forward');
const { estimateExcursions } = require('../src/predictive/exit-planner');
const { scoreExitPlan } = require('../src/predictive/exit-evaluator');
const { calculateRiskTargets } = require('../src/predictive/net-risk-reward');
const { ADAPTIVE_KIND, PROBE_REWARDS, FEATURE_NAMES, barrierFeatures, rawOutcomeProbabilities, validateReachability } = require('../src/predictive/reachability');
const { STOP_POLICY_ID, buildStopCandidates } = require('../src/predictive/stop-candidates');
const { modelScale, timeoutReturn } = require('../src/predictive/adaptive-exits');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function exitTime(f, candles, index, result) {
  if (result === 'TIMEOUT') return f.targetCloseTime;
  const long = f.exitPlan.side === 'LONG', p = f.exitPlan;
  for (let i = index + 1; i <= index + f.horizon; i++) {
    const c = candles[i];
    if (long ? c.low <= p.stopLoss || c.high >= p.takeProfit : c.high >= p.stopLoss || c.low <= p.takeProfit) return c.closeTime;
  }
  throw new Error('Missing first passage time');
}

function main() {
  const [historyFile, featureFile, directionDirectory, exitDirectory, outputDirectory] = process.argv.slice(2);
  if (!outputDirectory) throw new Error('Usage: train-predictive-adaptive-exits.js <history> <cached-features> <direction-dir> <stop-model-dir> <new-output-dir>');
  if (fs.existsSync(outputDirectory)) throw new Error('Use a new reachability model directory');
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const candles = normalizeKlines(JSON.parse(fs.readFileSync(historyFile)));
  const source = JSON.parse(fs.readFileSync(featureFile));
  if (source.symbol !== 'DOGEUSDT' || source.features?.length !== source.times?.length ||
      path.resolve(source.source) !== path.resolve(historyFile)) throw new Error('History does not match cached DOGE features');
  const index = new Map(candles.map((c, i) => [c.closeTime, i]));
  const runId = new Date().toISOString(), modelIds = {};
  for (const horizon of [15, 30, 60]) {
    const directionFile = path.join(directionDirectory, `model-${horizon}m.json`);
    const exitFile = path.join(exitDirectory, `exit-model-${horizon}m.json`);
    const direction = JSON.parse(fs.readFileSync(directionFile));
    const stopModel = JSON.parse(fs.readFileSync(exitFile));
    if (direction.modelId !== source.horizons[horizon].directionModelId ||
        digest(directionFile) !== source.horizons[horizon].directionModelHash ||
        stopModel.directionModelId !== direction.modelId) throw new Error('Frozen upstream model mismatch');
    const indices = source.times.map((time, j) => ({ time, j, i: index.get(time) }))
      .filter(r => r.time >= stopModel.splitBoundaries.holdoutStart && Number.isInteger(r.i) && r.i + horizon < candles.length);
    if (indices.length < 1000) throw new Error('Insufficient observations after upstream model fitting period');
    const boundaries = { validationStart: indices[Math.floor(indices.length * 0.6)].time,
      auditStart: indices[Math.floor(indices.length * 0.8)].time, purgeBars: horizon };
    const input = { horizon, featureSource: path.resolve(featureFile), featureNames: FEATURE_NAMES,
      featureIndices: [], extras: [], labels: [], netPcts: [], times: [], exitTimes: [], groups: [],
      stopIds: [], scales: [], estimatedLossPcts: [], estimatedProfitPcts: [],
      boundaries, upstreamTrainingEndsBefore: stopModel.splitBoundaries.holdoutStart,
      metadata: { symbol: 'DOGEUSDT', directionModelId: direction.modelId, directionModelHash: digest(directionFile),
        exitModelId: stopModel.modelId, exitModelHash: digest(exitFile), trainingRunId: runId,
        modelId: `adaptive-exits-${horizon}-${runId}` } };
    let skippedEntries = 0, stopGroup = 0;
    for (let group = 0; group < indices.length; group++) {
      const { time, j, i } = indices[group], x = source.features[j];
      const f = forecastDirection(direction, { time, close: candles[i].close, x: x.slice(0, 9) }, 'DOGEUSDT', time + 1);
      if (!['UP', 'DOWN'].includes(f.direction)) continue;
      const long = f.direction === 'UP', side = long ? 'LONG' : 'SHORT';
      const estimates = estimateExcursions(stopModel, x);
      const stops = buildStopCandidates(f, estimates, candles.slice(i - 15, i + 1), 0.00001);
      for (const { stopLoss, stopId } of stops.filter(s => s.valid)) {
        const currentGroup = stopGroup++;
        const params = { side, stopLoss, entryFill: f.referencePrice * (long ? 1.0002 : 0.9998),
          tickSize: 0.00001, costAssumptions: { feePctPerSide: 0.05, slippagePctPerSide: 0.02 } };
        const targets = calculateRiskTargets(params, PROBE_REWARDS);
        if (targets.status === 'UNAVAILABLE') continue;
        for (const target of targets.targetLevels) {
          if (!target.validTarget) continue;
          f.exitPlan = { ...params, ...target, status: 'ESTIMATED' };
          const out = scoreExitPlan(f, candles, i);
          if (!out || !Number.isFinite(out.simulatedNetPct)) { skippedEntries++; continue; }
          const vector = barrierFeatures(x, f.probabilities, horizon, side, params.entryFill, stopLoss, target);
          input.featureIndices.push(j); input.extras.push(vector.slice(x.length));
          input.labels.push(out.result === 'TP' ? 2 : out.result === 'TIMEOUT' ? 1 : 0);
          input.netPcts.push(out.simulatedNetPct); input.times.push(time);
          input.exitTimes.push(exitTime(f, candles, i, out.result)); input.groups.push(currentGroup);
          input.stopIds.push(stopId); input.scales.push(modelScale(x, horizon));
          input.estimatedLossPcts.push(targets.estimatedNetLossPct);
          input.estimatedProfitPcts.push(target.estimatedNetProfitPct);
        }
      }
    }
    input.skippedNonExecutableEntries = skippedEntries;
    const prepared = path.join(outputDirectory, `training-input-${horizon}m.json`);
    fs.writeFileSync(prepared, JSON.stringify(input), { mode: 0o600 });
    const python = process.env.PREDICTIVE_PYTHON || path.resolve('.venv-predictive/bin/python');
    const trained = spawnSync(python, [path.resolve('scripts/train-predictive-adaptive-exits.py'), prepared, outputDirectory],
      { stdio: 'inherit', timeout: 600000, env: { ...process.env, OPENBLAS_NUM_THREADS: '2' } });
    if (trained.error || trained.status !== 0) throw trained.error || new Error('First-passage training failed');
    const raw = JSON.parse(fs.readFileSync(path.join(outputDirectory, `raw-model-${horizon}m.json`)));
    const model = { ...input.metadata, kind: ADAPTIVE_KIND, objective: 'TP_BEFORE_SL_WITHIN_HORIZON',
      featureSchema: 'direction-context-v1', featureNames: FEATURE_NAMES, horizon,
      approvedForTrading: false, selectionObjective: 'EXPECTED_NET_AFTER_COSTS', stopPolicyId: STOP_POLICY_ID,
      classifier: raw.classifier, calibration: raw.calibration, splitBoundaries: boundaries,
      nonTpTemperature: raw.nonTpTemperature, timeoutRegressor: raw.timeoutRegressor,
      stopGapPenaltyScaled: raw.stopGapPenaltyScaled };
    validateReachability(model, 'DOGEUSDT', direction.modelId, stopModel.modelId);
    let parityError = 0;
    raw.parity.features.forEach((x, i) => rawOutcomeProbabilities(model, x).forEach((p, k) => {
      parityError = Math.max(parityError, Math.abs(p - raw.parity.probabilities[i][k]));
    }));
    let timeoutParityError = 0;
    raw.parity.features.forEach((x, i) => { timeoutParityError = Math.max(timeoutParityError,
      Math.abs(timeoutReturn(model, x, 1, 100, 100) - raw.parity.timeoutPredictions[i])); });
    if (parityError > 1e-5 || timeoutParityError > 1e-8 || digest(directionFile) !== model.directionModelHash || digest(exitFile) !== model.exitModelHash) {
      throw new Error('Inference parity or frozen upstream hash check failed');
    }
    modelIds[horizon] = model.modelId;
    fs.writeFileSync(path.join(outputDirectory, `model-${horizon}m.json`), JSON.stringify(model), { mode: 0o600 });
    fs.writeFileSync(path.join(outputDirectory, `report-${horizon}m.json`), JSON.stringify({ ...raw.report, parityError, timeoutParityError,
      upstreamTrainingEndsBefore: input.upstreamTrainingEndsBefore, boundaries,
      historicalPeriodPreviouslyInspected: true }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ horizon, parityError, ...raw.report.auditTrades }));
  }
  fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), JSON.stringify({ completed: true,
    objective: 'TP_BEFORE_SL_WITHIN_HORIZON', symbol: 'DOGEUSDT', trainingRunId: runId, modelIds }, null, 2), { mode: 0o600 });
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
module.exports = { exitTime, main };
