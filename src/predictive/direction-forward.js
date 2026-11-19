'use strict';

const { KEYS, CLASSES, validateDirectionModel, predictDirection,
  mostLikelyDirection } = require('./direction-model');
const { scoreExitPlan, exitSummary } = require('./exit-evaluator');

function forecastDirection(model, feature, symbol, now = Date.now()) {
  validateDirectionModel(model, symbol);
  const base = { id: symbol + ':direction:' + model.horizon + ':' + feature?.time + ':' + model.modelId,
    objective: 'PRICE_DIRECTION', modelId: model.modelId, symbol, horizon: model.horizon,
    candleCloseTime: feature?.time ?? null, referencePrice: feature?.close ?? null,
    targetCloseTime: Number.isFinite(feature?.time) ? feature.time + model.horizon * 60000 : null,
    createdAt: new Date(now).toISOString(), mode: 'SHADOW_ONLY', tradeExecutionEnabled: false };
  if (!Number.isFinite(feature?.time) || !Number.isFinite(feature?.close) || feature.close <= 0 ||
      feature.time > now || now - feature.time > 120000) {
    return { ...base, status: 'UNAVAILABLE', direction: null, reason: 'STALE_OR_INVALID_MARKET_DATA' };
  }
  const probabilities = predictDirection(model, feature.x);
  return { ...base, status: 'FORECAST', ...mostLikelyDirection(probabilities), probabilities,
    validationOutperformsBaseline: model.validationOutperformsBaseline,
    reason: 'PRICE_DIRECTION_FORECAST' };
}

function scoreDirection(prediction, candles) {
  if (prediction.objective !== 'PRICE_DIRECTION' || prediction.status !== 'FORECAST' ||
      !Number.isInteger(prediction.horizon) || prediction.horizon < 1) return null;
  const index = candles.findIndex(row => row.closeTime === prediction.candleCloseTime);
  const future = index >= 0 ? candles[index + prediction.horizon] : null;
  if (!future || future.closeTime !== prediction.targetCloseTime) return null;
  const label = future.close > prediction.referencePrice ? 2 :
    future.close < prediction.referencePrice ? 0 : 1;
  const values = KEYS.map(key => prediction.probabilities[key]);
  return { actualDirection: CLASSES[label], actualClose: future.close,
    actualReturnPct: (future.close / prediction.referencePrice - 1) * 100,
    completedAt: new Date(future.closeTime).toISOString(),
    correct: prediction.direction === CLASSES[label],
    brier: values.reduce((sum, value, i) => sum + (value - Number(i === label)) ** 2, 0),
    logLoss: -Math.log(Math.max(1e-15, values[label])), observedOnly: true };
}

function scorePendingDirection(records, candles) {
  const updates = [];
  for (const record of records) {
    let updated = false;
    if (!record.outcome) {
      const outcome = scoreDirection(record, candles);
      if (outcome) { record.outcome = outcome; updated = true; }
    }
    if (!record.exitOutcome && record.exitPlan?.status === 'ESTIMATED') {
      const outcome = scoreExitPlan(record, candles);
      if (outcome) { record.exitOutcome = outcome; updated = true; }
    }
    if (updated) updates.push(record.outcome || record.exitOutcome);
  }
  return updates;
}

function directionSummary(records) {
  const forecasts = records.filter(row => row.status === 'FORECAST');
  const evaluated = forecasts.filter(row => row.outcome);
  const metrics = rows => ({ samples: rows.length,
    accuracy: rows.length ? rows.filter(row => row.outcome.correct).length / rows.length : null,
    brier: rows.length ? rows.reduce((sum, row) => sum + row.outcome.brier, 0) / rows.length : null,
    logLoss: rows.length ? rows.reduce((sum, row) => sum + row.outcome.logLoss, 0) / rows.length : null });
  return { objective: 'PRICE_DIRECTION', forecasts: forecasts.length,
    unavailable: records.length - forecasts.length, evaluated: evaluated.length,
    pending: forecasts.length - evaluated.length, metrics: metrics(evaluated),
    byHorizon: Object.fromEntries([15, 30, 60].map(horizon =>
      [horizon, { ...metrics(evaluated.filter(row => row.horizon === horizon)),
        exitPlans: exitSummary(records.filter(row => row.horizon === horizon)) }])),
    exitPlans: exitSummary(records),
    mode: 'SHADOW_ONLY', tradeExecutionEnabled: false };
}

module.exports = { forecastDirection, scoreDirection, scorePendingDirection, directionSummary };
