'use strict';

const { calculateRiskTargets } = require('./net-risk-reward');
const { ADAPTIVE_KIND, PROBE_REWARDS, validateReachability, barrierFeatures,
  rawOutcomeProbabilities, calibrate } = require('./reachability');
const { STOP_POLICY_ID, buildStopCandidates } = require('./stop-candidates');

const ADAPTIVE_POLICY_ID = 'ADAPTIVE_NET_EXPECTANCY_TP1_TP2_V5';

function timeoutReturn(model, features, scalePct, lossPct, profitPct) {
  const r = model.timeoutRegressor;
  const scaled = r.weights[0] + features.reduce((sum, x, i) =>
    sum + (Math.fround(x) - r.mean[i]) / r.std[i] * r.weights[i + 1], 0);
  return Math.max(-lossPct, Math.min(profitPct, scaled * scalePct));
}

function planAdaptiveTargets(model, context, probabilities, params) {
  validateReachability(model);
  if (model.kind !== ADAPTIVE_KIND) throw new Error('Adaptive exits require a multi-stop expectancy model');
  const calculated = calculateRiskTargets(params, PROBE_REWARDS);
  const base = { ...calculated, riskPolicyId: ADAPTIVE_POLICY_ID, reachabilityModelId: model.modelId,
    stopPolicyId: STOP_POLICY_ID, rangeBasis: 'FIRST_PASSAGE_BEFORE_STOP_WITHIN_HORIZON',
    selectionRule: 'POSITIVE_EXPECTED_NET_TP2_ELSE_TP1', contextFeatures: context,
    directionProbabilities: probabilities };
  if (calculated.status === 'UNAVAILABLE') return base;
  let preceding = 1;
  const supportCurve = calculated.targetLevels.map(target => {
    if (!target.validTarget) {
      preceding = 0;
      return { ...target, probabilityTpBeforeSl: 0, probabilitySlFirst: 1, probabilityTimeout: 0,
        expectedTimeoutNetPct: 0, expectedStopNetLossPct: calculated.estimatedNetLossPct,
        expectedNetPct: -calculated.estimatedNetLossPct, supportedByExpectedValue: false, passesProbability50: false };
    }
    const x = barrierFeatures(context, probabilities, model.horizon, params.side, params.entryFill, params.stopLoss, target);
    const raw = rawOutcomeProbabilities(model, x);
    preceding = Math.min(preceding, raw[2]);
    const probabilityTpBeforeSl = calibrate(preceding, model.calibration);
    const odds = Math.log(Math.max(1e-15, raw[0]) / Math.max(1e-15, raw[1])) / model.nonTpTemperature;
    const conditionalSl = 1 / (1 + Math.exp(-odds));
    const probabilitySlFirst = (1 - probabilityTpBeforeSl) * conditionalSl;
    const probabilityTimeout = 1 - probabilityTpBeforeSl - probabilitySlFirst;
    const scalePct = modelScale(context, model.horizon);
    const expectedTimeoutNetPct = timeoutReturn(model, x, scalePct,
      calculated.estimatedNetLossPct, target.estimatedNetProfitPct);
    const expectedStopNetLossPct = calculated.estimatedNetLossPct + model.stopGapPenaltyScaled * scalePct;
    const expectedNetPct = probabilityTpBeforeSl * target.estimatedNetProfitPct -
      probabilitySlFirst * expectedStopNetLossPct + probabilityTimeout * expectedTimeoutNetPct;
    return { ...target, probabilityTpBeforeSl, probabilitySlFirst, probabilityTimeout,
      expectedTimeoutNetPct, expectedStopNetLossPct, expectedNetPct,
      supportedByExpectedValue: target.validTarget && expectedNetPct > 1e-12,
      passesProbability50: target.validTarget && probabilityTpBeforeSl > 0.5 };
  });
  const targetLevels = supportCurve.filter(t => t.rewardMultiple === 1 || t.rewardMultiple === 2);
  const selected = [...targetLevels].reverse().find(t => t.supportedByExpectedValue);
  const details = { ...base, supportCurve, targetLevels,
    takeProfit1: targetLevels[0].takeProfit, takeProfit2: targetLevels[1].takeProfit,
    predictedReachablePrice: supportCurve.filter(t => t.probabilityTpBeforeSl > 0.5).at(-1)?.takeProfit ?? null };
  return selected ? { ...details, ...selected, status: 'ESTIMATED', selectedTarget: selected.level } :
    { ...details, status: 'UNAVAILABLE', reason: 'NON_POSITIVE_EXPECTED_NET' };
}

function modelScale(context, horizon) {
  const { NAMES } = require('./direction-features');
  return Math.max(0.01, context[NAMES.indexOf('volatility60')] * Math.sqrt(horizon) * 100);
}

function chooseCandidate(candidates, mode = 'EXPECTED_NET') {
  if (!['EXPECTED_NET', 'PROBABILITY_50'].includes(mode)) throw new Error('Unknown exit selection mode');
  return candidates.filter(c => c.validTarget && (mode === 'EXPECTED_NET' ?
    c.supportedByExpectedValue : c.passesProbability50)).sort((a, b) =>
    b.rewardMultiple - a.rewardMultiple || b.expectedNetPct - a.expectedNetPct ||
    a.estimatedNetLossPct - b.estimatedNetLossPct || a.stopId.localeCompare(b.stopId))[0] || null;
}

function planAdaptiveExits(forecast, estimates, model, context, options) {
  const long = forecast.direction === 'UP';
  const costs = { feePctPerSide: Number(options.feePct ?? 0.05), slippagePctPerSide: Number(options.slippagePct ?? 0.02) };
  const stops = buildStopCandidates(forecast, estimates, options.candles, options.tickSize);
  const plans = stops.filter(s => s.valid).map(stop => ({ ...planAdaptiveTargets(model, context, forecast.probabilities,
    { side: long ? 'LONG' : 'SHORT', entryFill: forecast.referencePrice * (1 + (long ? 1 : -1) * costs.slippagePctPerSide / 100),
      stopLoss: stop.stopLoss, tickSize: options.tickSize, costAssumptions: costs }), stopId: stop.stopId }));
  const candidates = plans.flatMap(p => (p.targetLevels || []).map(t => ({ ...t, stopId: p.stopId,
    stopLoss: p.stopLoss, estimatedNetLossPct: p.estimatedNetLossPct })));
  const selected = chooseCandidate(candidates);
  const chosenPlan = plans.find(p => p.stopId === selected?.stopId) || plans[0];
  const diagnostics = { candidates, stopCandidates: stops, candidateCount: candidates.length,
    strictProbabilitySelection: chooseCandidate(candidates, 'PROBABILITY_50') };
  return selected ? { ...chosenPlan, ...selected, ...diagnostics, status: 'ESTIMATED', selectedTarget: selected.level } :
    { ...chosenPlan, ...diagnostics, riskPolicyId: ADAPTIVE_POLICY_ID, reachabilityModelId: model.modelId,
      stopPolicyId: STOP_POLICY_ID, status: 'UNAVAILABLE', reason: candidates.length ?
        'NON_POSITIVE_EXPECTED_NET' : 'NO_VALID_STOP_CANDIDATE' };
}

module.exports = { ADAPTIVE_POLICY_ID, modelScale, timeoutReturn, planAdaptiveTargets, chooseCandidate, planAdaptiveExits };
