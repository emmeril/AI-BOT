'use strict';

const KIND = 'predictive-hit-first-v2';

function sigmoid(value) {
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, value))));
}

function train(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length < 100) throw new Error('At least 100 training samples required');
  const dims = rows[0].x.length;
  if (!dims || !rows.every(row => row.x.length === dims && row.x.every(Number.isFinite) &&
    [0, 1].includes(row.labelLong) && [0, 1].includes(row.labelShort))) {
    throw new Error('Invalid training examples');
  }
  const mean = Array.from({ length: dims }, (_, j) =>
    rows.reduce((sum, row) => sum + row.x[j], 0) / rows.length);
  const std = mean.map((value, j) => Math.max(1e-8,
    Math.sqrt(rows.reduce((sum, row) => sum + (row.x[j] - value) ** 2, 0) / rows.length)));
  const vectors = rows.map(row => [1, ...row.x.map((value, j) =>
    Math.max(-8, Math.min(8, (value - mean[j]) / std[j])))]);
  const weights = [Array(dims + 1).fill(0), Array(dims + 1).fill(0)];
  const epochs = Number(options.epochs ?? 120);
  if (!Number.isInteger(epochs) || epochs < 1 || epochs > 1000) throw new Error('Invalid training epochs');
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradients = weights.map(row => row.map(() => 0));
    for (let i = 0; i < rows.length; i++) {
      for (let side = 0; side < 2; side++) {
        const p = sigmoid(weights[side].reduce((sum, value, j) => sum + value * vectors[i][j], 0));
        const error = p - (side === 0 ? rows[i].labelLong : rows[i].labelShort);
        for (let j = 0; j < vectors[i].length; j++) gradients[side][j] += error * vectors[i][j];
      }
    }
    for (let side = 0; side < 2; side++) {
      for (let j = 0; j < weights[side].length; j++) {
        const regularizer = j === 0 ? 0 : 0.002 * weights[side][j];
        weights[side][j] -= 0.08 * (gradients[side][j] / rows.length + regularizer);
      }
    }
  }
  return { kind: KIND, mean, std, longWeights: weights[0], shortWeights: weights[1],
    trainedSamples: rows.length };
}

function predict(model, features) {
  if (model?.kind !== KIND || !Array.isArray(features) ||
    features.length !== model.mean?.length || features.length !== model.std?.length ||
    !features.every(Number.isFinite) || ![model.longWeights, model.shortWeights].every(weights =>
      Array.isArray(weights) && weights.length === features.length + 1 && weights.every(Number.isFinite))) {
    throw new Error('Missing, invalid or incompatible predictive V2 model');
  }
  const values = [1, ...features.map((value, j) =>
    Math.max(-8, Math.min(8, (value - model.mean[j]) / model.std[j])))];
  const probability = weights => sigmoid(weights.reduce((sum, weight, j) =>
    sum + weight * values[j], 0));
  return { longTarget: probability(model.longWeights),
    shortTarget: probability(model.shortWeights) };
}

module.exports = { KIND, train, predict };
