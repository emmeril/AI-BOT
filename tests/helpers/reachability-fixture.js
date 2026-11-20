'use strict';

const { KIND, FEATURE_NAMES } = require('../../src/predictive/reachability');
const { SCHEMA, NAMES } = require('../../src/predictive/direction-features');

function reachabilityFixture(horizon = 60, directionModelId = 'frozen-60-model', exitModelId = 'frozen-exit-60-model', threshold = 1.2) {
  const weights = Array.from({ length: 3 }, () => Array(FEATURE_NAMES.length + 1).fill(0));
  weights[1][0] = -20;
  weights[2][0] = 40 * threshold;
  weights[2][FEATURE_NAMES.indexOf('targetDistanceScaled') + 1] = -40;
  return { kind: KIND, objective: 'TP_BEFORE_SL_WITHIN_HORIZON', featureSchema: SCHEMA,
    symbol: 'DOGEUSDT', approvedForTrading: false, horizon, minimumTpProbability: 0.5,
    modelId: 'frozen-reach-' + horizon + '-model', directionModelId, exitModelId,
    featureNames: [...FEATURE_NAMES], calibration: { x: [0, 1], y: [0, 1] },
    classifier: { kind: 'softmax-baseline-v1', mean: Array(FEATURE_NAMES.length).fill(0),
      std: Array(FEATURE_NAMES.length).fill(1), weights } };
}

function contextFeatures() {
  const x = Array(NAMES.length).fill(0);
  x[NAMES.indexOf('volatility60')] = 0.001;
  return x;
}

function setReachThreshold(model, threshold) { model.classifier.weights[2][0] = 40 * threshold; }

function adaptiveReachabilityFixture(horizon = 60, directionModelId = 'frozen-60-model', exitModelId = 'frozen-exit-60-model', probabilities = [0.2, 0.6, 0.2]) {
  const model = reachabilityFixture(horizon, directionModelId, exitModelId);
  model.kind = require('../../src/predictive/reachability').ADAPTIVE_KIND;
  model.stopPolicyId = require('../../src/predictive/stop-candidates').STOP_POLICY_ID;
  model.selectionObjective = 'EXPECTED_NET_AFTER_COSTS';
  model.nonTpTemperature = 1; model.stopGapPenaltyScaled = 0;
  delete model.minimumTpProbability;
  model.classifier.weights.forEach((row, i) => { row.fill(0); row[0] = Math.log(probabilities[i]); });
  model.timeoutRegressor = { mean: Array(FEATURE_NAMES.length).fill(0), std: Array(FEATURE_NAMES.length).fill(1),
    weights: Array(FEATURE_NAMES.length + 1).fill(0) };
  return model;
}

module.exports = { reachabilityFixture, adaptiveReachabilityFixture, contextFeatures, setReachThreshold };
