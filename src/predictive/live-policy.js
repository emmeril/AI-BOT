'use strict';

const path = require('path');
const crypto = require('crypto');
const { RISK_POLICY_ID } = require('./net-risk-reward');
const { planReachableTargets } = require('./reachability');
const { ADAPTIVE_POLICY_ID } = require('./adaptive-exits');
const { sequentialExitRecords } = require('./exit-evaluator');
const { buildAiReviewConfig } = require('./ai-review-policy');
const { mostLikelyDirection } = require('./direction-model');

const PREFIX = 'p60-';
const asBoolean = value => value === true || value === 'true';

function buildLiveConfig(environment = {}) {
  const config = {
    enabled: asBoolean(environment.PREDICTIVE_LIVE_ENABLED),
    symbol: environment.PREDICTIVE_LIVE_SYMBOL || 'DOGEUSDT',
    horizon: Number(environment.PREDICTIVE_LIVE_HORIZON || 60),
    positionExitPolicy: environment.PREDICTIVE_LIVE_POSITION_EXIT_POLICY || 'PREDICTION_REVERSAL',
    marginUsdt: Number(environment.PREDICTIVE_LIVE_MARGIN_USDT || 5),
    leverage: Number(environment.PREDICTIVE_LIVE_LEVERAGE || 10),
    sessionLossBudgetUsdt: Number(environment.PREDICTIVE_LIVE_LOSS_BUDGET_USDT || 5),
    feeReserveUsdt: 0.1, intervalMs: 5000, maxForecastAgeMs: 120000,
    riskPolicyId: environment.PREDICTIVE_LIVE_RISK_POLICY_ID || ADAPTIVE_POLICY_ID,
    forecastFile: path.resolve(environment.PREDICTIVE_LIVE_FORECAST_FILE || 'predictive-results/DOGEUSDT-adaptive-shadow-v5.json'),
    stateFile: path.resolve(environment.PREDICTIVE_LIVE_STATE_FILE || 'predictive-results/DOGEUSDT-live-state.json'),
    modelFile: path.resolve(environment.PREDICTIVE_LIVE_MODEL_FILE || 'predictive-results/DOGEUSDT-direction-v2/model-60m.json'),
    reachabilityModelFile: path.resolve(environment.PREDICTIVE_LIVE_REACHABILITY_MODEL_FILE ||
      'predictive-results/DOGEUSDT-adaptive-exits-v2/model-60m.json'),
    exitModelFile: path.resolve(environment.PREDICTIVE_LIVE_EXIT_MODEL_FILE ||
      'predictive-results/DOGEUSDT-exit-levels-v1/exit-model-60m.json'),
  };
  if (config.symbol !== 'DOGEUSDT' || config.horizon !== 60 || config.marginUsdt !== 5 || config.leverage !== 10 ||
      config.sessionLossBudgetUsdt !== 5) throw new Error('This live profile requires DOGEUSDT, horizon 60, fixed 5 USDT margin and 10x leverage');
  config.notionalUsdt = config.marginUsdt * config.leverage;
  if (![RISK_POLICY_ID, ADAPTIVE_POLICY_ID].includes(config.riskPolicyId)) throw new Error('Unsupported predictive exit policy');
  if (!['PREDICTION_REVERSAL', 'HORIZON'].includes(config.positionExitPolicy)) throw new Error('Unsupported position exit policy');
  config.aiReview = buildAiReviewConfig(environment);
  return config;
}

function selectLiveForecast(state, config, expectedModelId, now = Date.now(), expectedReachabilityModelId) {
  if (state?.objective !== 'PRICE_DIRECTION' || !Array.isArray(state.records)) throw new Error('Invalid direction state');
  const latest = state.records.filter(r => r.symbol === config.symbol && r.horizon === config.horizon)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.candleCloseTime - a.candleCloseTime)[0];
  if (!latest || latest.status !== 'FORECAST' || latest.modelId !== expectedModelId || !Number.isFinite(latest.candleCloseTime) ||
      latest.targetCloseTime !== latest.candleCloseTime + config.horizon * 60000 ||
      latest.candleCloseTime > now || now - latest.candleCloseTime > config.maxForecastAgeMs ||
      !Number.isFinite(Date.parse(latest.createdAt)) || Date.parse(latest.createdAt) > now ||
      now - Date.parse(latest.createdAt) > config.maxForecastAgeMs) throw new Error('No fresh forecast from the selected 60 minute direction model');
  if (!['UP', 'DOWN'].includes(latest.direction)) throw new Error('Latest forecast has no directional bias');
  const plan = latest.exitPlan;
  const side = latest.direction === 'UP' ? 'LONG' : 'SHORT';
  if (plan?.status === 'UNAVAILABLE' && plan.riskPolicyId === config.riskPolicyId &&
      (!expectedReachabilityModelId || plan.reachabilityModelId === expectedReachabilityModelId) &&
      ['NON_POSITIVE_EXPECTED_NET', 'NO_VALID_STOP_CANDIDATE'].includes(plan.reason)) {
    const error = new Error('Forecast has no compatible fresh exit estimate: ' + plan.reason);
    error.code = 'EXIT_SETUP_REJECTED';
    error.reason = plan.reason;
    throw error;
  }
  if (plan?.status !== 'ESTIMATED' || typeof plan.exitModelId !== 'string' || !plan.exitModelId ||
      plan.riskPolicyId !== config.riskPolicyId ||
      (expectedReachabilityModelId && plan.reachabilityModelId !== expectedReachabilityModelId) ||
      plan.directionModelId !== expectedModelId || plan.side !== side ||
      plan.expiresAt !== latest.targetCloseTime || !(plan.expiresAt > now) ||
      ![plan.takeProfit, plan.stopLoss].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Forecast has no compatible fresh exit estimate');
  }
  return latest;
}

function positionDirectionReview(state, config, plan, expectedModelId, now = Date.now()) {
  const hold = (reason, forecast) => ({ close: false, reason,
    forecastId: forecast?.id || null, direction: forecast?.direction || null });
  if (state?.objective !== 'PRICE_DIRECTION' || !Array.isArray(state.records)) return hold('PREDICTION_UNAVAILABLE');
  const latest = state.records.filter(row => row?.symbol === config.symbol && row.horizon === config.horizon)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.candleCloseTime - a.candleCloseTime)[0];
  const createdAt = Date.parse(latest?.createdAt);
  if (!latest || latest.objective !== 'PRICE_DIRECTION' || latest.status !== 'FORECAST' ||
      latest.modelId !== expectedModelId || plan.modelId !== expectedModelId ||
      !Number.isFinite(latest.candleCloseTime) || latest.candleCloseTime > now ||
      now - latest.candleCloseTime > config.maxForecastAgeMs || !Number.isFinite(createdAt) ||
      createdAt < latest.candleCloseTime || createdAt > now || now - createdAt > config.maxForecastAgeMs ||
      latest.targetCloseTime !== latest.candleCloseTime + config.horizon * 60000 ||
      (Number.isFinite(plan.forecastCandleCloseTime) && latest.candleCloseTime < plan.forecastCandleCloseTime) ||
      (Number.isFinite(plan.forecastCreatedAt) && createdAt < plan.forecastCreatedAt)) {
    return hold('PREDICTION_UNAVAILABLE', latest);
  }
  const probabilities = latest.probabilities;
  const values = ['up', 'down', 'unchanged'].map(key => probabilities?.[key]);
  if (!values.every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-6 ||
      mostLikelyDirection(probabilities).direction !== latest.direction) return hold('PREDICTION_UNAVAILABLE', latest);
  if (['UNCHANGED', 'UNCERTAIN'].includes(latest.direction)) return hold('PREDICTION_NEUTRAL', latest);
  if (!['UP', 'DOWN'].includes(latest.direction) || !['LONG', 'SHORT'].includes(plan.side)) {
    return hold('PREDICTION_UNAVAILABLE', latest);
  }
  const reversed = latest.direction !== (plan.side === 'LONG' ? 'UP' : 'DOWN');
  return { close: reversed, reason: reversed ? 'PREDICTION_REVERSED' : 'PREDICTION_ALIGNED',
    forecastId: latest.id, direction: latest.direction, modelId: latest.modelId,
    candleCloseTime: latest.candleCloseTime, createdAt };
}

function positionAmount(position) {
  const value = position?.positionAmt;
  if (!['string', 'number'].includes(typeof value) ||
      (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))) {
    throw new Error('Invalid position amount');
  }
  return Math.abs(Number(value));
}
function candidateEvidence(state, config, expectedModelId, expectedReachabilityModelId) {
  const records = (state.records || []).filter(r => r.symbol === config.symbol && r.horizon === config.horizon && r.modelId === expectedModelId);
  const directions = records.filter(r => r.outcome);
  const compatible = records.filter(r => r.exitPlan?.riskPolicyId === config.riskPolicyId &&
    (!expectedReachabilityModelId || r.exitPlan.reachabilityModelId === expectedReachabilityModelId));
  const eligible = config.riskPolicyId === ADAPTIVE_POLICY_ID ? sequentialExitRecords(compatible) : compatible;
  const trades = eligible.filter(r => r.exitPlan?.riskPolicyId === config.riskPolicyId &&
    (!expectedReachabilityModelId || r.exitPlan.reachabilityModelId === expectedReachabilityModelId) &&
    Number.isFinite(r.exitOutcome?.simulatedNetPct));
  const accuracy = directions.length ? directions.filter(r => r.outcome.correct).length / directions.length : null;
  const winrate = trades.length ? trades.filter(r => r.exitOutcome.simulatedNetPct > 0).length / trades.length : null;
  const net = trades.reduce((sum, r) => sum + r.exitOutcome.simulatedNetPct, 0);
  return { riskPolicyId: config.riskPolicyId, reachabilityModelId: expectedReachabilityModelId || null,
    directionEvaluated: directions.length, directionAccuracy: accuracy,
    completedShadowTrades: trades.length, netWinRate: winrate,
    totalShadowNetUsdtAt100Notional: net, overlappingForecasts: config.riskPolicyId !== ADAPTIVE_POLICY_ID,
    selectionCriterion: 'DIRECTION_ABOVE_50_AND_POSITIVE_NET',
    matchesUserCriteria: accuracy > 0.5 && trades.length > 0 && Number.isFinite(net) && net > 0 };
}
function openPositions(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid position response');
  return rows.filter(row => positionAmount(row) > 0);
}
function algoOrders(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.orders)) return response.orders;
  throw new Error('Invalid conditional order response');
}
function ownedAlgo(order) { return String(order.clientAlgoId || '').startsWith(PREFIX); }

function insideProtection(price, side, plan) {
  return Number.isFinite(price) && price > 0 && (side === 'LONG' ?
    plan.stopLoss < price && price < plan.takeProfit : plan.takeProfit < price && price < plan.stopLoss);
}

function buildEntryPlan(config, forecast, market, book, availableBalance, hedgeMode, now = Date.now(), reachabilityModel) {
  if (market?.symbol !== config.symbol || market.status !== 'TRADING') throw new Error('DOGE market is not trading');
  const filters = Object.fromEntries(market.filters.map(filter => [filter.filterType, filter]));
  const lot = filters.MARKET_LOT_SIZE || filters.LOT_SIZE;
  const step = Number(lot?.stepSize), tick = Number(filters.PRICE_FILTER?.tickSize);
  const minQty = Number(lot?.minQty), maxQty = Number(lot?.maxQty);
  const minNotional = Number(filters.MIN_NOTIONAL?.notional ?? filters.NOTIONAL?.minNotional);
  if (![step, tick, minNotional, maxQty].every(value => Number.isFinite(value) && value > 0) ||
      ![lot?.minQty, lot?.maxQty].every(value => ['string', 'number'].includes(typeof value) &&
        (typeof value !== 'string' || value.trim())) ||
      !Number.isFinite(minQty) || minQty < 0 || minQty > maxQty) throw new Error('Invalid exchange trading limits');
  if (!(availableBalance >= config.marginUsdt + config.feeReserveUsdt)) throw new Error('Insufficient free USDT for 5 USDT margin and fee reserve');
  const side = forecast.direction === 'UP' ? 'LONG' : 'SHORT';
  if (!Number.isFinite(Number(book.time)) || Number(book.time) > now + 2000 || now - Number(book.time) > 10000) {
    throw new Error('Order book quote is stale');
  }
  const quote = Number(side === 'LONG' ? book.askPrice : book.bidPrice);
  const estimatedEntry = quote * (side === 'LONG' ? 1.0002 : 0.9998);
  const stopLoss = Number((Math.round(forecast.exitPlan.stopLoss / tick) * tick).toPrecision(14));
  if (forecast.exitPlan.riskPolicyId !== config.riskPolicyId ||
      forecast.exitPlan.costAssumptions?.feePctPerSide !== 0.05 ||
      forecast.exitPlan.costAssumptions?.slippagePctPerSide !== 0.02) {
    throw new Error('Forecast must use the TP1/TP2 risk policy and current cost assumptions');
  }
  if (!reachabilityModel || forecast.exitPlan.reachabilityModelId !== reachabilityModel.modelId) {
    throw new Error('Missing or incompatible entry reachability model');
  }
  const risk = planReachableTargets(reachabilityModel, forecast.exitPlan.contextFeatures,
    forecast.exitPlan.directionProbabilities, { side, entryFill: estimatedEntry, stopLoss,
    tickSize: tick, costAssumptions: forecast.exitPlan.costAssumptions });
  if (risk.status !== 'ESTIMATED') throw new Error(risk.reason);
  const takeProfit = risk.takeProfit;
  if (!insideProtection(estimatedEntry, side, { takeProfit, stopLoss })) throw new Error('Current entry is outside forecast TP/SL');
  const bid = Number(book.bidPrice), ask = Number(book.askPrice);
  if (!(bid > 0 && ask >= bid) || (ask / bid - 1) > 0.002) throw new Error('Invalid or excessive bid/ask spread');
  const sizingPrice = Math.max(quote, estimatedEntry) * 1.001;
  const quantity = Number((Math.floor(config.notionalUsdt / sizingPrice / step) * step).toPrecision(14));
  const notional = quantity * estimatedEntry;
  if (!(quantity > 0) || quantity < minQty || quantity > maxQty ||
      notional < minNotional || notional > config.notionalUsdt + 1e-8) throw new Error('50 USDT target violates exchange quantity or notional limits');
  const token = crypto.createHash('sha256').update(forecast.id).digest('hex').slice(0, 18);
  return { forecastId: forecast.id, modelId: forecast.modelId, exitModelId: forecast.exitPlan.exitModelId,
    forecastCandleCloseTime: forecast.candleCloseTime, forecastCreatedAt: Date.parse(forecast.createdAt),
    positionExitPolicy: config.positionExitPolicy,
    stopId: forecast.exitPlan.stopId,
    symbol: config.symbol, side,
    positionSide: hedgeMode ? side : 'BOTH', orderSide: side === 'LONG' ? 'BUY' : 'SELL',
    quantity, targetMarginUsdt: config.marginUsdt, leverage: config.leverage,
    targetNotionalUsdt: config.notionalUsdt, estimatedNotionalUsdt: notional,
    estimatedMarginUsdt: notional / config.leverage, estimatedEntry,
    quoteTime: Number(book.time),
    ...risk,
    modelRangeQ75: forecast.exitPlan.modelRangeQ75, tick, expiresAt: forecast.targetCloseTime, token,
    entryClientId: `${PREFIX}e-${token}`, stopClientId: `${PREFIX}sl-${token}`,
    takeClientId: `${PREFIX}tp-${token}`, compounding: false };
}

function protectionParameters(plan, kind) {
  return { algoType: 'CONDITIONAL', symbol: plan.symbol,
    side: plan.side === 'LONG' ? 'SELL' : 'BUY', positionSide: plan.positionSide,
    type: kind === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET', closePosition: 'true',
    triggerPrice: kind === 'SL' ? plan.stopLoss : plan.takeProfit,
    workingType: 'CONTRACT_PRICE', clientAlgoId: kind === 'SL' ? plan.stopClientId : plan.takeClientId };
}

function protectionMatches(order, plan, kind) {
  const p = protectionParameters(plan, kind);
  return order.clientAlgoId === p.clientAlgoId && String(order.symbol) === plan.symbol &&
    String(order.positionSide) === plan.positionSide && String(order.side) === p.side &&
    String(order.orderType || order.type) === p.type && asBoolean(order.closePosition) &&
    String(order.workingType) === p.workingType &&
    Math.abs(Number(order.triggerPrice) - p.triggerPrice) < plan.tick / 2;
}

module.exports = { PREFIX, asBoolean, buildLiveConfig, selectLiveForecast, positionDirectionReview, positionAmount,
  candidateEvidence, openPositions, algoOrders, ownedAlgo, insideProtection, buildEntryPlan, protectionParameters, protectionMatches };
