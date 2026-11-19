'use strict';

const { trainSoftmax, predict: predictSoftmax } = require('./model');
const { validateBoostedClassifier, predictBoosted, validateEnsemble, predictEnsemble } = require('./boosted-classifier');

const KIND = 'predictive-price-direction-v2';
const CLASSES = Object.freeze(['DOWN', 'UNCHANGED', 'UP']);
const KEYS = Object.freeze(['down', 'unchanged', 'up']);

function directionRows(features, candles, horizon) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 1440) {
    throw new Error('Invalid direction horizon');
  }
  return features.filter(row => row.index + horizon < candles.length).map(row => {
    const future = candles[row.index + horizon];
    if (future.closeTime !== row.time + horizon * 60000) {
      throw new Error('Non-contiguous direction labels');
    }
    const label = future.close > row.close ? 2 : future.close < row.close ? 0 : 1;
    return { ...row, label, actualDirection: CLASSES[label],
      targetCloseTime: future.closeTime, futureClose: future.close,
      actualReturnPct: (future.close / row.close - 1) * 100 };
  });
}

function trainDirection(rows, horizon, options = {}) {
  if (rows.length < 100) throw new Error('At least 100 direction training samples required');
  return { kind: KIND, objective: 'PRICE_DIRECTION', horizon, classes: CLASSES,
    reference: 'SIGNAL_CANDLE_CLOSE', target: 'HORIZON_CANDLE_CLOSE',
    unchangedDefinition: 'EXACTLY_EQUAL_CLOSE', approvedForTrading: false,
    temperature: 1, classifier: trainSoftmax(rows, { steps: 200, ...options }) };
}

function validateDirectionModel(model, symbol) {
  const c = model?.classifier;
  const dims = c?.mean?.length;
  if (model?.kind !== KIND || model.objective !== 'PRICE_DIRECTION' ||
      model.reference !== 'SIGNAL_CANDLE_CLOSE' || model.target !== 'HORIZON_CANDLE_CLOSE' ||
      model.unchangedDefinition !== 'EXACTLY_EQUAL_CLOSE' ||
      model.approvedForTrading !== false || !Number.isInteger(model.horizon) ||
      model.horizon < 1 || model.horizon > 1440 ||
      !(model.temperature > 0) || !Number.isFinite(model.temperature) ||
      (symbol && model.symbol !== symbol)) {
    throw new Error('Invalid or incompatible price direction model');
  }
  if (c?.kind === 'boosted-direction-trees-v1') {
    validateBoostedClassifier(c);
    return model;
  }
  if (c?.kind === 'direction-ensemble-v1') {
    validateEnsemble(c);
    return model;
  }
  if (c?.kind !== 'softmax-baseline-v1' ||
      !Array.isArray(c.mean) || !dims || !c.mean.every(Number.isFinite) ||
      !Array.isArray(c.std) || c.std.length !== dims ||
      !c.std.every(value => Number.isFinite(value) && value > 0) ||
      !Array.isArray(c.weights) || c.weights.length !== 3 ||
      !c.weights.every(w => Array.isArray(w) && w.length === dims + 1 && w.every(Number.isFinite))) {
    throw new Error('Invalid or incompatible price direction model');
  }
  return model;
}

function temperatureScale(probabilities, temperature) {
  if (!Number.isFinite(temperature) || temperature <= 0) throw new Error('Invalid temperature');
  const logits = KEYS.map(key => Math.log(Math.max(1e-15, probabilities[key])) / temperature);
  const maximum = Math.max(...logits);
  const weights = logits.map(value => Math.exp(value - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(KEYS.map((key, i) => [key, weights[i] / total]));
}

function predictDirection(model, features) {
  validateDirectionModel(model);
  if (model.classifier.kind === 'boosted-direction-trees-v1') {
    return temperatureScale(predictBoosted(model.classifier, features), model.temperature);
  }
  if (model.classifier.kind === 'direction-ensemble-v1') {
    return temperatureScale(predictEnsemble(model.classifier, features), model.temperature);
  }
  const p = predictSoftmax(model.classifier, features);
  return temperatureScale({ down: p.DOWN, unchanged: p.SIDEWAYS, up: p.UP }, model.temperature);
}

function mostLikelyDirection(probabilities) {
  const ordered = KEYS.map((key, i) => ({ direction: CLASSES[i], probability: probabilities[key] }))
    .sort((a, b) => b.probability - a.probability);
  return { direction: Math.abs(ordered[0].probability - ordered[1].probability) < 1e-12 ?
    'UNCERTAIN' : ordered[0].direction, confidence: ordered[0].probability };
}

module.exports = { KIND, CLASSES, KEYS, directionRows, trainDirection,
  validateDirectionModel, temperatureScale, predictDirection, mostLikelyDirection };
