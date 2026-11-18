'use strict';

const { settings, simulateExit } = require('./trade-simulator');
const { chooseAction } = require('./v2-evaluation');

function forecast(model, feature, symbol, now = Date.now()) {
  const id = symbol + ':' + model?.horizon + ':' + feature?.time;
  const base = { id, symbol, close: feature?.close ?? null,
    candleCloseTime: feature?.time ?? null, horizon: model?.horizon ?? null,
    mode: 'SHADOW_ONLY', createdAt: new Date(now).toISOString(),
    assumptions: model?.config || null };
  if (model?.approvedForTrading !== false || !Number.isFinite(model?.threshold) ||
      !Number.isFinite(feature?.time) || feature.time > now ||
      now - feature.time > 120000) {
    return { ...base, action: 'NO_TRADE', reason: 'MODEL_UNSELECTED_OR_STALE' };
  }
  return { ...base, ...chooseAction(model, feature, {
    ...model.config, threshold: model.threshold,
  }) };
}

function scoreForecast(prediction, candles) {
  if (!prediction?.id || !Number.isInteger(prediction.horizon) ||
      !Array.isArray(candles) || !candles.length) return null;
  const index = candles.findIndex(row => row.closeTime === prediction.candleCloseTime);
  if (index < 0 || index + prediction.horizon >= candles.length) return null;
  const config = settings(prediction.assumptions || { horizon: prediction.horizon });
  const longTrade = simulateExit(candles, index, 'LONG', config);
  const shortTrade = simulateExit(candles, index, 'SHORT', config);
  if (!longTrade || !shortTrade) return null;
  const action = prediction.action;
  return { id: prediction.id, symbol: prediction.symbol, horizon: prediction.horizon,
    completedAt: new Date(candles[index + prediction.horizon].closeTime).toISOString(),
    actualClose: candles[index + prediction.horizon].close,
    longTargetHitFirst: longTrade.targetHit, shortTargetHitFirst: shortTrade.targetHit,
    action, realizedSimulatedNetPct: action === 'LONG' ? longTrade.netPct :
      action === 'SHORT' ? shortTrade.netPct : null,
    simulatedOutcome: action === 'LONG' ? longTrade.reason :
      action === 'SHORT' ? shortTrade.reason : 'NO_TRADE',
    ambiguous: action === 'LONG' ? longTrade.ambiguous :
      action === 'SHORT' ? shortTrade.ambiguous : false, simulatedOnly: true };
}

function scorePending(records, candles) {
  const updates = [];
  for (const record of records) {
    if (record.outcome) continue;
    const outcome = scoreForecast(record, candles);
    if (outcome) {
      record.outcome = outcome;
      updates.push(outcome);
    }
  }
  return updates;
}

function summary(records) {
  const completed = records.filter(row => row.outcome);
  const entered = completed.filter(row => row.action === 'LONG' || row.action === 'SHORT');
  const netPct = entered.reduce((sum, row) => sum + row.outcome.realizedSimulatedNetPct, 0);
  const positive = entered.filter(row => row.outcome.realizedSimulatedNetPct > 0);
  const losses = entered.filter(row => row.outcome.realizedSimulatedNetPct <= 0);
  const calibration = {};
  for (const side of ['longTarget', 'shortTarget']) {
    const scored = completed.filter(row => Number.isFinite(row.probabilities?.[side]));
    calibration[side] = { samples: scored.length,
      brier: scored.length ? scored.reduce((sum, row) => {
        const actual = side === 'longTarget' ?
          row.outcome.longTargetHitFirst : row.outcome.shortTargetHitFirst;
        return sum + (row.probabilities[side] - Number(actual)) ** 2;
      }, 0) / scored.length : null };
  }
  return { forecasts: records.length, evaluated: completed.length,
    pending: records.length - completed.length, simulatedTrades: entered.length,
    simulatedNetPctNotional: netPct, winRate: entered.length ? positive.length / entered.length : null,
    grossProfitPct: positive.reduce((sum, row) =>
      sum + row.outcome.realizedSimulatedNetPct, 0),
    grossLossPct: losses.reduce((sum, row) =>
      sum + row.outcome.realizedSimulatedNetPct, 0),
    calibration, mode: 'SHADOW_ONLY' };
}

module.exports = { forecast, scoreForecast, scorePending, summary };
