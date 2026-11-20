'use strict';

const { SCHEMA, NAMES } = require('./direction-features');
const { calculateRiskTargets, RISK_POLICY_ID } = require('./net-risk-reward');
const { validateBoostedClassifier, predictTreeMargins } = require('./boosted-classifier');
const { predict: predictSoftmax } = require('./model');

const KIND = 'predictive-first-passage-v1';
const ADAPTIVE_KIND = 'predictive-first-passage-expectancy-v2';
const PROBE_REWARDS = Object.freeze([0.25, 0.5, 0.75, 1, 1.5, 2, 3]);
const FEATURE_NAMES = Object.freeze([...NAMES, 'positionDirection', 'directionUpProbability',
  'directionDownProbability', 'targetDistanceScaled', 'stopDistanceScaled', 'rewardMultiple']);

function validateReachability(model, symbol, directionModelId, exitModelId) {
  const c = model?.classifier, calibration = model?.calibration;
  if (![KIND, ADAPTIVE_KIND].includes(model?.kind) || model.objective !== 'TP_BEFORE_SL_WITHIN_HORIZON' ||
      model.featureSchema !== SCHEMA || model.approvedForTrading !== false || !model.modelId ||
      (model.kind === KIND && model.minimumTpProbability !== 0.5) || !Number.isInteger(model.horizon) || model.horizon < 1 ||
      model.horizon > 1440 || (symbol && model.symbol !== symbol) ||
      (directionModelId && model.directionModelId !== directionModelId) ||
      (exitModelId && model.exitModelId !== exitModelId) ||
      JSON.stringify(model.featureNames) !== JSON.stringify(FEATURE_NAMES) ||
      !Array.isArray(calibration?.x) || calibration.x.length < 2 ||
      !Array.isArray(calibration.y) || calibration.y.length !== calibration.x.length ||
      !calibration.x.every((v, i, a) => Number.isFinite(v) && v >= 0 && v <= 1 && (!i || v > a[i - 1])) ||
      !calibration.y.every((v, i, a) => Number.isFinite(v) && v >= 0 && v <= 1 && (!i || v >= a[i - 1]))) {
    throw new Error('Invalid or incompatible first-passage model');
  }
  if (model.kind === ADAPTIVE_KIND) {
    const r = model.timeoutRegressor, dims = FEATURE_NAMES.length;
    if (model.selectionObjective !== 'EXPECTED_NET_AFTER_COSTS' ||
        model.stopPolicyId !== require('./stop-candidates').STOP_POLICY_ID ||
        !(model.nonTpTemperature > 0 && Number.isFinite(model.nonTpTemperature)) ||
        !(model.stopGapPenaltyScaled >= 0 && Number.isFinite(model.stopGapPenaltyScaled)) ||
        ![r?.mean, r?.std].every(a => Array.isArray(a) && a.length === dims && a.every(Number.isFinite)) ||
        !r.std.every(v => v > 0) || !Array.isArray(r.weights) || r.weights.length !== dims + 1 ||
        !r.weights.every(Number.isFinite)) throw new Error('Invalid adaptive expectancy model');
  }
  if (c?.kind === 'boosted-first-passage-trees-v1') {
    validateBoostedClassifier(c);
    if (c.featureCount !== FEATURE_NAMES.length) throw new Error('Invalid first-passage feature dimensions');
  } else if (c?.kind !== 'softmax-baseline-v1' ||
      ![c.mean, c.std].every(a => Array.isArray(a) && a.length === FEATURE_NAMES.length && a.every(Number.isFinite)) ||
      !c.std.every(v => v > 0) || !Array.isArray(c.weights) || c.weights.length !== 3 ||
      !c.weights.every(w => Array.isArray(w) && w.length === FEATURE_NAMES.length + 1 && w.every(Number.isFinite))) {
    throw new Error('Invalid first-passage classifier');
  }
  return model;
}

function barrierFeatures(context, probabilities, horizon, side, entryFill, stopLoss, target) {
  if (!Array.isArray(context) || context.length !== NAMES.length || !context.every(Number.isFinite) ||
      ![probabilities?.up, probabilities?.down].every(v => Number.isFinite(v) && v >= 0 && v <= 1) ||
      probabilities.up + probabilities.down > 1 + 1e-9 || !['LONG', 'SHORT'].includes(side) ||
      ![entryFill, stopLoss, target.takeProfit].every(v => Number.isFinite(v) && v > 0)) {
    throw new Error('Invalid first-passage features');
  }
  const scale = Math.max(0.01, context[NAMES.indexOf('volatility60')] * Math.sqrt(horizon) * 100);
  return [...context, side === 'LONG' ? 1 : -1, probabilities.up, probabilities.down,
    Math.abs(target.takeProfit / entryFill - 1) * 100 / scale,
    Math.abs(stopLoss / entryFill - 1) * 100 / scale, target.rewardMultiple];
}

function rawOutcomeProbabilities(model, features) {
  if (model.classifier.kind === 'softmax-baseline-v1') {
    const p = predictSoftmax(model.classifier, features);
    return [p.DOWN, p.SIDEWAYS, p.UP];
  }
  const margins = predictTreeMargins(model.classifier, features);
  const max = Math.max(...margins), weights = margins.map(v => Math.exp(v - max));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map(v => v / total);
}

function calibrate(probability, calibration) {
  const { x, y } = calibration;
  if (probability <= x[0]) return y[0];
  for (let i = 1; i < x.length; i++) if (probability <= x[i]) {
    const fraction = (probability - x[i - 1]) / (x[i] - x[i - 1]);
    return y[i - 1] + fraction * (y[i] - y[i - 1]);
  }
  return y.at(-1);
}

function planReachableTargets(model, context, probabilities, params) {
  if (model?.kind === ADAPTIVE_KIND) return require('./adaptive-exits').planAdaptiveTargets(model, context, probabilities, params);
  validateReachability(model);
  const calculated = calculateRiskTargets(params, PROBE_REWARDS);
  const base = { ...calculated, reachabilityModelId: model.modelId,
    rangeBasis: 'FIRST_PASSAGE_BEFORE_STOP_WITHIN_HORIZON', selectionRule: 'TP2_IF_SUPPORTED_ELSE_TP1',
    contextFeatures: context, directionProbabilities: probabilities };
  if (calculated.status === 'UNAVAILABLE') return base;
  let precedingProbability = 1;
  const supportCurve = calculated.targetLevels.map(target => {
    if (!target.validTarget) {
      precedingProbability = 0;
      return { ...target, probabilityTpBeforeSl: 0, supportedByReachability: false };
    }
    const features = barrierFeatures(context, probabilities, model.horizon, params.side,
      params.entryFill, params.stopLoss, target);
    const raw = rawOutcomeProbabilities(model, features);
    precedingProbability = Math.min(precedingProbability, raw[2]);
    const probabilityTpBeforeSl = calibrate(precedingProbability, model.calibration);
    const remaining = raw[0] + raw[1];
    return { ...target, probabilityTpBeforeSl,
      probabilitySlFirst: (1 - probabilityTpBeforeSl) * (remaining ? raw[0] / remaining : 0.5),
      probabilityTimeout: (1 - probabilityTpBeforeSl) * (remaining ? raw[1] / remaining : 0.5),
      supportedByReachability: probabilityTpBeforeSl > model.minimumTpProbability };
  });
  const targetLevels = supportCurve.filter(t => t.rewardMultiple === 1 || t.rewardMultiple === 2);
  const selected = [...targetLevels].reverse().find(t => t.supportedByReachability);
  const supportedRange = supportCurve.filter(t => t.supportedByReachability).at(-1);
  const details = { ...base, targetLevels, supportCurve,
    takeProfit1: targetLevels[0].takeProfit, takeProfit2: targetLevels[1].takeProfit,
    predictedReachablePrice: supportedRange?.takeProfit ?? null };
  if (!selected) return { ...details, status: 'UNAVAILABLE',
    reason: 'TP1_BEFORE_SL_NOT_SUPPORTED', requiredTakeProfit: targetLevels[0].takeProfit };
  return { ...details, status: 'ESTIMATED', selectedTarget: selected.level,
    rewardMultiple: selected.rewardMultiple, takeProfit: selected.takeProfit,
    estimatedNetProfitPct: selected.estimatedNetProfitPct,
    estimatedNetRewardRisk: selected.estimatedNetRewardRisk,
    probabilityTpBeforeSl: selected.probabilityTpBeforeSl };
}

module.exports = { KIND, ADAPTIVE_KIND, PROBE_REWARDS, FEATURE_NAMES, validateReachability, barrierFeatures,
  rawOutcomeProbabilities, calibrate, planReachableTargets };
