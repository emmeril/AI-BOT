'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const AI_REVIEW_POLICY_ID = 'ANTIGRAVITY_PREDICTIVE_ENTRY_FILTER_V1';
const FORECAST_MAX_AGE_MS = 120000;

function buildAiReviewConfig(environment = {}) {
  const config = {
    enabled: environment.PREDICTIVE_AI_REVIEW_ENABLED === true || environment.PREDICTIVE_AI_REVIEW_ENABLED === 'true',
    model: String(environment.PREDICTIVE_AI_REVIEW_MODEL || environment.AI_SIGNAL_MODEL || 'gemini-3.8-flash-low'),
    binary: environment.PREDICTIVE_AI_REVIEW_BIN || environment.AI_SIGNAL_ANTIGRAVITY_BIN,
    timeoutMs: Number(environment.PREDICTIVE_AI_REVIEW_TIMEOUT_MS || 30000),
    minimumConfidence: Number(environment.PREDICTIVE_AI_REVIEW_MIN_CONFIDENCE ?? 65),
    maxReviewAgeMs: Number(environment.PREDICTIVE_AI_REVIEW_MAX_AGE_MS || 60000),
    stateFile: path.resolve(environment.PREDICTIVE_AI_REVIEW_STATE_FILE || 'predictive-results/DOGEUSDT-ai-entry-reviews.json'),
    historyLimit: 1000,
  };
  if (!config.model.trim() || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 30000 ||
      !Number.isInteger(config.minimumConfidence) || config.minimumConfidence < 0 || config.minimumConfidence > 100 ||
      !Number.isFinite(config.maxReviewAgeMs) || config.maxReviewAgeMs <= 0 || config.maxReviewAgeMs > FORECAST_MAX_AGE_MS) {
    throw new Error('Invalid predictive AI review configuration');
  }
  config.policyId = AI_REVIEW_POLICY_ID;
  config.configId = crypto.createHash('sha256').update(JSON.stringify({ policyId: config.policyId,
    model: config.model, timeoutMs: config.timeoutMs, minimumConfidence: config.minimumConfidence,
    maxReviewAgeMs: config.maxReviewAgeMs })).digest('hex');
  return config;
}

function candidateFingerprint(forecast) {
  const plan = forecast.exitPlan;
  return crypto.createHash('sha256').update(JSON.stringify({ id: forecast.id, symbol: forecast.symbol,
    horizon: forecast.horizon, modelId: forecast.modelId, direction: forecast.direction,
    candleCloseTime: forecast.candleCloseTime, targetCloseTime: forecast.targetCloseTime,
    createdAt: forecast.createdAt, referencePrice: forecast.referencePrice, probabilities: forecast.probabilities,
    exitPlan: plan && { status: plan.status, exitModelId: plan.exitModelId, directionModelId: plan.directionModelId,
      reachabilityModelId: plan.reachabilityModelId, riskPolicyId: plan.riskPolicyId, side: plan.side,
      stopId: plan.stopId, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, selectedTarget: plan.selectedTarget,
      takeProfit1: plan.takeProfit1, takeProfit2: plan.takeProfit2, estimatedNetRewardRisk: plan.estimatedNetRewardRisk,
      probabilityTpBeforeSl: plan.probabilityTpBeforeSl, probabilitySlFirst: plan.probabilitySlFirst,
      probabilityTimeout: plan.probabilityTimeout,
      expectedNetPct: plan.expectedNetPct, expiresAt: plan.expiresAt, costAssumptions: plan.costAssumptions,
      contextFeatures: plan.contextFeatures } })).digest('hex');
}

function forecastReviewExpiry(forecast) {
  return Math.min(forecast.candleCloseTime + FORECAST_MAX_AGE_MS,
    Date.parse(forecast.createdAt) + FORECAST_MAX_AGE_MS, forecast.targetCloseTime);
}

function reviewableForecast(forecast, now) {
  const plan = forecast?.exitPlan;
  const createdAt = Date.parse(forecast?.createdAt);
  return forecast?.symbol === 'DOGEUSDT' && forecast.horizon === 60 && forecast.status === 'FORECAST' &&
    typeof forecast.id === 'string' && Boolean(forecast.id) && ['UP', 'DOWN'].includes(forecast.direction) &&
    Number.isFinite(forecast.candleCloseTime) && forecast.candleCloseTime <= now &&
    Number.isFinite(createdAt) && createdAt <= now && createdAt >= forecast.candleCloseTime &&
    forecast.targetCloseTime === forecast.candleCloseTime + 3600000 && now < forecastReviewExpiry(forecast) &&
    plan?.status === 'ESTIMATED' && plan.side === (forecast.direction === 'UP' ? 'LONG' : 'SHORT') &&
    Number.isFinite(plan.expectedNetPct) && plan.expectedNetPct > 0 &&
    plan.directionModelId === forecast.modelId && Boolean(plan.reachabilityModelId) && Boolean(plan.exitModelId) &&
    plan.expiresAt === forecast.targetCloseTime &&
    [forecast.referencePrice, plan.takeProfit, plan.stopLoss].every(value => Number.isFinite(value) && value > 0);
}

function decisionRejection(decision, forecast, config) {
  if (!decision || !['LONG', 'SHORT', 'HOLD'].includes(decision.action) ||
      !Number.isInteger(decision.confidence) || decision.confidence < 0 || decision.confidence > 100 ||
      !['LOW', 'MEDIUM', 'HIGH'].includes(decision.risk)) return 'AI_REVIEW_INVALID_RESPONSE';
  if (decision.symbol !== forecast.symbol || decision.horizonMinutes !== 60) return 'AI_REVIEW_WRONG_SYMBOL_OR_HORIZON';
  if (decision.confidence < config.minimumConfidence) return 'AI_REVIEW_LOW_CONFIDENCE';
  if (decision.risk === 'HIGH') return 'AI_REVIEW_HIGH_RISK';
  if (decision.action === 'HOLD') return 'AI_REVIEW_HOLD';
  if (decision.action !== forecast.exitPlan.side) return 'AI_REVIEW_DIRECTION_CONFLICT';
  return null;
}

function assessAiReview(forecast, state, config, now = Date.now()) {
  const base = { enabled: config.enabled, policyId: AI_REVIEW_POLICY_ID, model: config.model };
  const reject = reason => ({ ...base, approved: false, reason });
  if (!config.enabled) return { ...base, approved: true, reason: 'AI_REVIEW_DISABLED' };
  if (!reviewableForecast(forecast, now)) return reject('AI_REVIEW_INELIGIBLE_FORECAST');
  if (state?.version !== 1 || state.policyId !== AI_REVIEW_POLICY_ID || !Array.isArray(state.reviews)) {
    return reject('AI_REVIEW_UNAVAILABLE');
  }
  if (state.enabled !== true || state.configId !== config.configId || state.model !== config.model) {
    return reject('AI_REVIEW_CONFIG_MISMATCH');
  }
  const review = state.reviews.filter(row => row.forecastId === forecast.id)
    .sort((a, b) => b.requestedAt - a.requestedAt)[0];
  if (!review) return reject('AI_REVIEW_REQUIRED');
  if (review.policyId !== AI_REVIEW_POLICY_ID || review.configId !== config.configId || review.model !== config.model ||
      review.candidateFingerprint !== candidateFingerprint(forecast)) return reject('AI_REVIEW_CANDIDATE_MISMATCH');
  if (review.status !== 'APPROVED') return { ...reject(review.reason || 'AI_REVIEW_' + review.status), reviewId: review.id };
  if (![review.requestedAt, review.completedAt, review.expiresAt].every(Number.isFinite) ||
      review.requestedAt < Date.parse(forecast.createdAt) || review.requestedAt > review.completedAt ||
      review.completedAt > now || review.completedAt - review.requestedAt > config.timeoutMs ||
      review.expiresAt !== forecastReviewExpiry(forecast) || now >= review.expiresAt ||
      now - review.completedAt > config.maxReviewAgeMs) return reject('AI_REVIEW_EXPIRED');
  const reason = decisionRejection(review.decision, forecast, config);
  if (reason) return reject(reason);
  return { ...base, approved: true, reason: 'AI_REVIEW_APPROVED', reviewId: review.id,
    forecastId: forecast.id, candidateFingerprint: review.candidateFingerprint,
    completedAt: review.completedAt, expiresAt: review.expiresAt,
    decision: structuredClone(review.decision) };
}

function buildReviewSnapshot(forecast, candles, now) {
  const rows = (candles || []).filter(c => c.closeTime <= forecast.candleCloseTime).slice(-241);
  if (rows.length < 241 || rows.at(-1).closeTime !== forecast.candleCloseTime ||
      rows.at(-1).close !== forecast.referencePrice || forecast.candleCloseTime > now ||
      rows.some((c, i) => ![c.open, c.high, c.low, c.close, c.quoteVolume, c.takerBuyQuote].every(Number.isFinite) ||
        !(c.close > 0) || (i && c.closeTime !== rows[i - 1].closeTime + 60000))) {
    throw new Error('AI review requires 241 contiguous completed candles');
  }
  const close = rows.at(-1).close;
  const windows = [5, 15, 60, 240].map(minutes => {
    const recent = rows.slice(-minutes), previous = rows.at(-minutes - 1);
    const quoteVolume = recent.reduce((sum, c) => sum + c.quoteVolume, 0);
    const buy = recent.reduce((sum, c) => sum + c.takerBuyQuote, 0);
    return { minutes, returnPct: (close / previous.close - 1) * 100,
      high: Math.max(...recent.map(c => c.high)), low: Math.min(...recent.map(c => c.low)),
      quoteVolume, takerFlowImbalance: quoteVolume > 0 ? (2 * buy - quoteVolume) / quoteVolume : 0 };
  });
  const plan = forecast.exitPlan;
  return { symbol: forecast.symbol, timeframe: '1m', candleCloseTime: forecast.candleCloseTime,
    close, reviewedAt: now, windows,
    recentClosedCandles: rows.slice(-15).map(c => ({ closeTime: c.closeTime, open: c.open,
      high: c.high, low: c.low, close: c.close, quoteVolume: c.quoteVolume, takerBuyQuote: c.takerBuyQuote })),
    candidate: { forecastId: forecast.id, side: plan.side, horizonMinutes: 60,
      referencePrice: forecast.referencePrice, expiresAt: forecast.targetCloseTime,
      directionProbabilities: forecast.probabilities, takeProfit: plan.takeProfit, stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1, takeProfit2: plan.takeProfit2, selectedTarget: plan.selectedTarget,
      expectedNetPct: plan.expectedNetPct, estimatedNetRewardRisk: plan.estimatedNetRewardRisk,
      probabilityTpBeforeSl: plan.probabilityTpBeforeSl, probabilitySlFirst: plan.probabilitySlFirst,
      probabilityTimeout: plan.probabilityTimeout, costAssumptions: plan.costAssumptions,
      riskPolicyId: plan.riskPolicyId, modelId: forecast.modelId, exitModelId: plan.exitModelId,
      reachabilityModelId: plan.reachabilityModelId,
      liveSizing: { marginUsdt: 5, leverage: 10, targetNotionalUsdt: 50, compounding: false } } };
}

module.exports = { AI_REVIEW_POLICY_ID, FORECAST_MAX_AGE_MS, buildAiReviewConfig, candidateFingerprint,
  forecastReviewExpiry, reviewableForecast, decisionRejection, assessAiReview, buildReviewSnapshot };
