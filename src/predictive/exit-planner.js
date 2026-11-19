'use strict';

const { SCHEMA, NAMES } = require('./direction-features');
const { predictTreeMargins, validateBoostedClassifier } = require('./boosted-classifier');

const KIND = 'predictive-excursion-quantiles-v1';
const QUANTILES = Object.freeze([0.25, 0.5, 0.75]);
const VOL_INDEX = NAMES.indexOf('volatility60');

function excursionScale(features, horizon) {
  if (!Array.isArray(features) || features.length !== NAMES.length || !features.every(Number.isFinite) ||
      !Number.isInteger(horizon) || horizon < 1 || horizon > 1440) throw new Error('Invalid excursion features');
  return Math.max(0.01, features[VOL_INDEX] * Math.sqrt(horizon) * 100);
}

function excursionLabels(rows, candles, horizon) {
  return rows.filter(row => row.index + horizon < candles.length).map(row => {
    let high = row.close, low = row.close;
    for (let i = row.index + 1; i <= row.index + horizon; i++) {
      const candle = candles[i];
      if (candle.closeTime !== row.time + (i - row.index) * 60000) throw new Error('Non-contiguous excursion labels');
      high = Math.max(high, candle.high); low = Math.min(low, candle.low);
    }
    return { time: row.time, targetCloseTime: row.time + horizon * 60000,
      upPct: (high / row.close - 1) * 100, downPct: (1 - low / row.close) * 100 };
  });
}

function validateExitModel(model, symbol, directionModelId) {
  if (model?.kind !== KIND || model.objective !== 'FUTURE_PRICE_EXCURSIONS' ||
      model.symbol !== symbol || model.featureSchema !== SCHEMA ||
      model.reference !== 'SIGNAL_CANDLE_CLOSE' || model.directionModelId !== directionModelId ||
      !Number.isInteger(model.horizon) || model.horizon < 1 || model.horizon > 1440 ||
      !model.modelId || model.approvedForTrading !== false ||
      JSON.stringify(model.quantiles) !== JSON.stringify(QUANTILES)) throw new Error('Incompatible exit model');
  for (const side of ['up', 'down']) {
    const estimator = model.estimators?.[side];
    if (!estimator || !Array.isArray(estimator.offsets) || estimator.offsets.length !== 3 ||
        !estimator.offsets.every(Number.isFinite)) throw new Error('Invalid excursion estimator');
    const regressor = estimator.regressor;
    if (regressor?.kind === 'boosted-quantile-trees-v1') {
      validateBoostedClassifier(regressor);
      if (regressor.featureCount !== NAMES.length) throw new Error('Invalid excursion dimensions');
    } else if (regressor?.kind !== 'quantile-constant-v1' || !Array.isArray(regressor.values) ||
        regressor.values.length !== 3 || !regressor.values.every(Number.isFinite)) {
      throw new Error('Invalid excursion regressor');
    }
  }
  return model;
}

function estimateExcursions(model, features) {
  validateExitModel(model, model.symbol, model.directionModelId);
  const scalePct = excursionScale(features, model.horizon);
  const result = { scalePct };
  for (const side of ['up', 'down']) {
    const estimator = model.estimators[side];
    const values = estimator.regressor.kind === 'quantile-constant-v1' ? estimator.regressor.values :
      predictTreeMargins(estimator.regressor, features);
    result[side] = values.map((value, i) => Math.max(0, value + estimator.offsets[i]) * scalePct)
      .sort((a, b) => a - b);
  }
  return result;
}

function roundPrice(price, tickSize, mode) {
  if (!tickSize) return price;
  if (!Number.isFinite(tickSize) || tickSize <= 0) throw new Error('Invalid price tick');
  const units = price / tickSize;
  const rounded = mode === 'FLOOR' ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9);
  return Number((rounded * tickSize).toPrecision(14));
}

function planExit(forecast, model, features, options = {}) {
  const base = { exitModelId: model?.modelId || null, directionModelId: forecast.modelId,
    indicative: true, executionAllowed: false };
  if (forecast.status !== 'FORECAST') return { ...base, status: 'UNAVAILABLE', reason: 'NO_FRESH_DIRECTION' };
  if (!['UP', 'DOWN'].includes(forecast.direction)) return { ...base, status: 'NOT_APPLICABLE', reason: 'NO_DIRECTIONAL_BIAS' };
  if (!model) return { ...base, status: 'UNAVAILABLE', reason: 'EXIT_MODEL_UNAVAILABLE' };
  validateExitModel(model, forecast.symbol, forecast.modelId);
  if (model.horizon !== forecast.horizon || !(forecast.referencePrice > 0)) throw new Error('Exit forecast mismatch');
  const estimates = estimateExcursions(model, features);
  const long = forecast.direction === 'UP';
  const targetMovePct = estimates[long ? 'up' : 'down'][1];
  const stopMovePct = estimates[long ? 'down' : 'up'][2];
  if (!(targetMovePct > 0 && stopMovePct > 0)) return { ...base, status: 'UNAVAILABLE', reason: 'NON_POSITIVE_EXCURSION_ESTIMATE', estimates };
  const entryReference = forecast.referencePrice;
  const takeProfit = roundPrice(entryReference * (1 + (long ? 1 : -1) * targetMovePct / 100),
    options.tickSize, long ? 'FLOOR' : 'CEIL');
  const stopLoss = roundPrice(entryReference * (1 - (long ? 1 : -1) * stopMovePct / 100),
    options.tickSize, long ? 'FLOOR' : 'CEIL');
  if (!(takeProfit > 0 && stopLoss > 0 && (long ? takeProfit > entryReference && stopLoss < entryReference :
    takeProfit < entryReference && stopLoss > entryReference))) {
    return { ...base, status: 'UNAVAILABLE', reason: 'ESTIMATE_BELOW_PRICE_TICK', estimates };
  }
  const targetPct = Math.abs(takeProfit / entryReference - 1) * 100;
  const stopPct = Math.abs(stopLoss / entryReference - 1) * 100;
  const feePct = Number(options.feePct ?? 0.05), slippagePct = Number(options.slippagePct ?? 0.02);
  if (![feePct, slippagePct].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid exit cost assumptions');
  const roundTripCostsPct = 2 * (feePct + slippagePct);
  return { ...base, status: 'ESTIMATED', side: long ? 'LONG' : 'SHORT',
    entryReference, referenceBasis: 'SIGNAL_CANDLE_CLOSE', referenceTime: forecast.candleCloseTime,
    expiresAt: forecast.targetCloseTime, horizon: forecast.horizon, takeProfit, stopLoss,
    targetPct, stopPct, rewardRisk: targetPct / stopPct,
    targetQuantile: 0.5, stopQuantile: 0.75, estimates,
    priceTick: options.tickSize || null, tickRoundingApplied: Boolean(options.tickSize),
    costAssumptions: { feePctPerSide: feePct, slippagePctPerSide: slippagePct },
    estimatedNetRewardRisk: (targetPct - roundTripCostsPct) / (stopPct + roundTripCostsPct),
    coversEstimatedCosts: targetPct > roundTripCostsPct,
    method: 'HISTORICAL_EXCURSION_QUANTILES' };
}

module.exports = { KIND, QUANTILES, excursionScale, excursionLabels, validateExitModel,
  estimateExcursions, roundPrice, planExit };
