'use strict';

const path = require('path');
const crypto = require('crypto');

const PREFIX = 'p60-';
const asBoolean = value => value === true || value === 'true';

function buildLiveConfig(environment = {}) {
  const config = {
    enabled: asBoolean(environment.PREDICTIVE_LIVE_ENABLED),
    symbol: environment.PREDICTIVE_LIVE_SYMBOL || 'DOGEUSDT',
    horizon: Number(environment.PREDICTIVE_LIVE_HORIZON || 60),
    marginUsdt: Number(environment.PREDICTIVE_LIVE_MARGIN_USDT || 5),
    leverage: Number(environment.PREDICTIVE_LIVE_LEVERAGE || 10),
    sessionLossBudgetUsdt: Number(environment.PREDICTIVE_LIVE_LOSS_BUDGET_USDT || 5),
    feeReserveUsdt: 0.1, intervalMs: 5000, maxForecastAgeMs: 120000,
    forecastFile: path.resolve(environment.PREDICTIVE_LIVE_FORECAST_FILE || 'predictive-results/DOGEUSDT-direction-shadow-v2.json'),
    stateFile: path.resolve(environment.PREDICTIVE_LIVE_STATE_FILE || 'predictive-results/DOGEUSDT-live-state.json'),
    modelFile: path.resolve(environment.PREDICTIVE_LIVE_MODEL_FILE || 'predictive-results/DOGEUSDT-direction-v2/model-60m.json'),
  };
  if (config.symbol !== 'DOGEUSDT' || config.horizon !== 60 || config.marginUsdt !== 5 || config.leverage !== 10 ||
      config.sessionLossBudgetUsdt !== 5) throw new Error('This live profile requires DOGEUSDT, horizon 60, fixed 5 USDT margin and 10x leverage');
  config.notionalUsdt = config.marginUsdt * config.leverage;
  return config;
}

function selectLiveForecast(state, config, expectedModelId, now = Date.now()) {
  if (state?.objective !== 'PRICE_DIRECTION' || !Array.isArray(state.records)) throw new Error('Invalid direction state');
  const latest = state.records.filter(r => r.symbol === config.symbol && r.horizon === config.horizon && r.status === 'FORECAST')
    .sort((a, b) => b.candleCloseTime - a.candleCloseTime)[0];
  if (!latest || latest.modelId !== expectedModelId || !Number.isFinite(latest.candleCloseTime) ||
      latest.targetCloseTime !== latest.candleCloseTime + config.horizon * 60000 ||
      latest.candleCloseTime > now || now - latest.candleCloseTime > config.maxForecastAgeMs ||
      !Number.isFinite(Date.parse(latest.createdAt)) || Date.parse(latest.createdAt) > now ||
      now - Date.parse(latest.createdAt) > config.maxForecastAgeMs) throw new Error('No fresh forecast from the selected 60 minute direction model');
  if (!['UP', 'DOWN'].includes(latest.direction)) throw new Error('Latest forecast has no directional bias');
  const plan = latest.exitPlan;
  const side = latest.direction === 'UP' ? 'LONG' : 'SHORT';
  if (plan?.status !== 'ESTIMATED' || typeof plan.exitModelId !== 'string' || !plan.exitModelId ||
      plan.directionModelId !== expectedModelId || plan.side !== side ||
      plan.expiresAt !== latest.targetCloseTime || !(plan.expiresAt > now) ||
      ![plan.takeProfit, plan.stopLoss].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Forecast has no compatible fresh exit estimate');
  }
  return latest;
}

function positionAmount(position) { return Math.abs(Number(position.positionAmt || 0)); }
function candidateEvidence(state, config, expectedModelId) {
  const records = (state.records || []).filter(r => r.symbol === config.symbol && r.horizon === config.horizon && r.modelId === expectedModelId);
  const directions = records.filter(r => r.outcome);
  const trades = records.filter(r => Number.isFinite(r.exitOutcome?.simulatedNetPct));
  const accuracy = directions.length ? directions.filter(r => r.outcome.correct).length / directions.length : null;
  const winrate = trades.length ? trades.filter(r => r.exitOutcome.simulatedNetPct > 0).length / trades.length : null;
  const net = trades.reduce((sum, r) => sum + r.exitOutcome.simulatedNetPct, 0);
  return { directionEvaluated: directions.length, directionAccuracy: accuracy,
    completedShadowTrades: trades.length, netWinRate: winrate,
    totalShadowNetUsdtAt100Notional: net, overlappingForecasts: true,
    matchesUserCriteria: accuracy > 0.5 && winrate > 0.5 };
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

function buildEntryPlan(config, forecast, market, book, availableBalance, hedgeMode, now = Date.now()) {
  if (market?.symbol !== config.symbol || market.status !== 'TRADING') throw new Error('DOGE market is not trading');
  const filters = Object.fromEntries(market.filters.map(filter => [filter.filterType, filter]));
  const lot = filters.MARKET_LOT_SIZE || filters.LOT_SIZE;
  const step = Number(lot?.stepSize), tick = Number(filters.PRICE_FILTER?.tickSize);
  const minNotional = Number(filters.MIN_NOTIONAL?.notional ?? filters.NOTIONAL?.minNotional);
  if (![step, tick, minNotional].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid exchange trading limits');
  if (!(availableBalance >= config.marginUsdt + config.feeReserveUsdt)) throw new Error('Insufficient free USDT for 5 USDT margin and fee reserve');
  const side = forecast.direction === 'UP' ? 'LONG' : 'SHORT';
  if (!Number.isFinite(Number(book.time)) || Number(book.time) > now + 2000 || now - Number(book.time) > 10000) {
    throw new Error('Order book quote is stale');
  }
  const quote = Number(side === 'LONG' ? book.askPrice : book.bidPrice);
  const estimatedEntry = quote * (side === 'LONG' ? 1.0002 : 0.9998);
  const takeProfit = Number((Math.round(forecast.exitPlan.takeProfit / tick) * tick).toPrecision(14));
  const stopLoss = Number((Math.round(forecast.exitPlan.stopLoss / tick) * tick).toPrecision(14));
  if (!insideProtection(estimatedEntry, side, { takeProfit, stopLoss })) throw new Error('Current entry is outside forecast TP/SL');
  const bid = Number(book.bidPrice), ask = Number(book.askPrice);
  if (!(bid > 0 && ask >= bid) || (ask / bid - 1) > 0.002) throw new Error('Invalid or excessive bid/ask spread');
  const sizingPrice = Math.max(quote, estimatedEntry) * 1.001;
  const quantity = Number((Math.floor(config.notionalUsdt / sizingPrice / step) * step).toPrecision(14));
  const notional = quantity * estimatedEntry;
  if (!(quantity > 0) || quantity < Number(lot.minQty) || quantity > Number(lot.maxQty) ||
      notional < minNotional || notional > config.notionalUsdt + 1e-8) throw new Error('50 USDT target violates exchange quantity or notional limits');
  const token = crypto.createHash('sha256').update(forecast.id).digest('hex').slice(0, 18);
  return { forecastId: forecast.id, modelId: forecast.modelId, exitModelId: forecast.exitPlan.exitModelId,
    symbol: config.symbol, side,
    positionSide: hedgeMode ? side : 'BOTH', orderSide: side === 'LONG' ? 'BUY' : 'SELL',
    quantity, targetMarginUsdt: config.marginUsdt, leverage: config.leverage,
    targetNotionalUsdt: config.notionalUsdt, estimatedNotionalUsdt: notional,
    estimatedMarginUsdt: notional / config.leverage, estimatedEntry,
    takeProfit, stopLoss, tick, expiresAt: forecast.targetCloseTime, token,
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

module.exports = { PREFIX, asBoolean, buildLiveConfig, selectLiveForecast, positionAmount,
  candidateEvidence, openPositions, algoOrders, ownedAlgo, insideProtection, buildEntryPlan, protectionParameters, protectionMatches };
