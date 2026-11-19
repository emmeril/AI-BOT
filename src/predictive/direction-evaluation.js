'use strict';

const { CLASSES, KEYS, trainDirection, predictDirection, temperatureScale } = require('./direction-model');

function splitDirectionRows(rows, horizon) {
  if (rows.length < 500) throw new Error('Need at least 500 direction observations');
  const first = Math.floor(rows.length * 0.6), second = Math.floor(rows.length * 0.8);
  const train = rows.slice(0, first - horizon);
  const validation = rows.slice(first, second - horizon);
  const holdout = rows.slice(second);
  if (train.length < 100 || validation.length < 30 || holdout.length < 30) {
    throw new Error('Insufficient direction data after horizon purge');
  }
  return { train, validation, holdout, boundaries: {
    validationStart: rows[first].time, holdoutStart: rows[second].time, purgeBars: horizon,
  } };
}

function classPriors(rows) {
  const counts = [0, 0, 0];
  for (const row of rows) counts[row.label]++;
  return Object.fromEntries(KEYS.map((key, i) => [key, (counts[i] + 1) / (rows.length + 3)]));
}

function classificationMetrics(probabilities, rows) {
  if (!rows.length || probabilities.length !== rows.length) throw new Error('Invalid evaluation data');
  const confusion = Array.from({ length: 3 }, () => [0, 0, 0]);
  let correct = 0, brier = 0, logLoss = 0, confidence = 0;
  for (let i = 0; i < rows.length; i++) {
    const values = KEYS.map(key => probabilities[i][key]);
    const predicted = values.indexOf(Math.max(...values));
    const actual = rows[i].label;
    correct += Number(actual === predicted);
    confusion[actual][predicted]++;
    confidence += values[predicted];
    logLoss -= Math.log(Math.max(1e-15, values[actual]));
    brier += values.reduce((sum, value, j) => sum + (value - Number(j === actual)) ** 2, 0);
  }
  const present = confusion.filter(row => row.reduce((sum, count) => sum + count, 0));
  const recall = confusion.map((row, i) => {
    const count = row.reduce((sum, value) => sum + value, 0);
    return count ? row[i] / count : null;
  });
  return { samples: rows.length, accuracy: correct / rows.length,
    balancedAccuracy: recall.reduce((sum, value) => sum + (value || 0), 0) / present.length,
    brier: brier / rows.length, logLoss: logLoss / rows.length,
    meanConfidence: confidence / rows.length, classes: CLASSES, confusion,
    actualCounts: Object.fromEntries(CLASSES.map((name, i) =>
      [name, confusion[i].reduce((sum, count) => sum + count, 0)])) };
}

function trainAndEvaluateDirection(rows, horizon, options = {}) {
  const split = splitDirectionRows(rows, horizon);
  const model = trainDirection(split.train, horizon, options);
  const rawValidation = split.validation.map(row => predictDirection(model, row.x));
  const temperatures = [0.75, 1, 1.5, 2, 3].map(temperature => ({ temperature,
    logLoss: classificationMetrics(rawValidation.map(p => temperatureScale(p, temperature)),
      split.validation).logLoss }));
  const selected = [...temperatures].sort((a, b) => a.logLoss - b.logLoss ||
    Math.abs(a.temperature - 1) - Math.abs(b.temperature - 1))[0];
  model.temperature = selected.temperature;
  const prior = classPriors(split.train);
  const evaluate = subset => ({
    model: classificationMetrics(subset.map(row => predictDirection(model, row.x)), subset),
    baseline: classificationMetrics(subset.map(() => prior), subset),
  });
  const validation = evaluate(split.validation);
  const holdout = evaluate(split.holdout);
  model.validationOutperformsBaseline = validation.model.logLoss < validation.baseline.logLoss;
  return { model, report: { objective: 'PRICE_DIRECTION', horizon,
    labelDefinition: 'Future candle close compared with signal candle close; equal close is UNCHANGED',
    samples: { total: rows.length, training: split.train.length,
      validation: split.validation.length, holdout: split.holdout.length },
    boundaries: split.boundaries, calibration: { selectedOn: 'VALIDATION_ONLY',
      selectedTemperature: selected.temperature, candidates: temperatures },
    baseline: { description: 'Constant training class frequencies with Laplace smoothing', probabilities: prior },
    validation, holdout, approvedForTrading: false,
    limitations: ['Linear softmax baseline using nine completed-candle features',
      'Single chronological 60/20/20 split, not rolling walk-forward',
      'Validation temperature scaling does not guarantee future calibration',
      'Overlapping forecast horizons are correlated',
      'Direction accuracy is separate from entry, exit, costs and profitability'],
  } };
}

module.exports = { splitDirectionRows, classPriors, classificationMetrics, trainAndEvaluateDirection };
