'use strict';

const { buildLiveConfig, buildEntryPlan, selectLiveForecast, positionDirectionReview } = require('./live-policy');

function simulatePositionPolicy({ candles, frames, gates, market, reachabilityModel, funding = [],
  from, to, policy, initialWalletUsdt = 10.8, makeEntryPlan }) {
  if (!['HORIZON', 'PREDICTION_REVERSAL'].includes(policy) || !(initialWalletUsdt > 0) ||
      !Number.isFinite(from) || !Number.isFinite(to) || to <= from || frames.length !== candles.length) {
    throw new Error('Invalid position backtest configuration');
  }
  const config = buildLiveConfig({ PREDICTIVE_LIVE_POSITION_EXIT_POLICY: policy });
  const feeRate = 0.0005, slipRate = 0.0002;
  const trades = [], equity = [], skipped = {};
  let wallet = initialWalletUsdt, position = null, pendingEntry = null, pendingExit = null;
  let peak = initialWalletUsdt, maxDrawdown = 0, sessionPause = null, lastBar = null;
  let fundingIndex = 0, fundingPnl = 0, entryFees = 0, exitFees = 0;
  const fundingRows = [...funding].sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime));
  const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
  const markEquity = price => {
    if (!position) return wallet;
    const exit = price * (1 - position.sign * slipRate);
    return wallet + position.sign * position.quantity * (exit - position.entryPrice) - position.quantity * exit * feeRate;
  };
  const close = (rawPrice, time, reason, ambiguous = false) => {
    const p = position, exitPrice = rawPrice * (1 - p.sign * slipRate);
    const fee = p.quantity * exitPrice * feeRate;
    const gross = p.sign * p.quantity * (exitPrice - p.entryPrice);
    wallet += gross - fee; exitFees += fee;
    trades.push({ side: p.plan.side, forecastId: p.plan.forecastId, entryTime: p.entryTime, exitTime: time,
      holdMinutes: (time - p.entryTime) / 60000, entryPrice: p.entryPrice, exitPrice,
      quantity: p.quantity, entryNotionalUsdt: p.quantity * p.entryPrice,
      takeProfit: p.plan.takeProfit, stopLoss: p.plan.stopLoss, selectedTarget: p.plan.selectedTarget,
      entryExpectedNetPct: p.entryExpectedNetPct, reason, ambiguous,
      grossPnlUsdt: gross, entryFeeUsdt: p.entryFee, exitFeeUsdt: fee, fundingPnlUsdt: p.funding,
      netPnlUsdt: gross - p.entryFee - fee + p.funding,
      exitForecastId: pendingExit?.forecastId || null, walletAfterUsdt: wallet });
    position = null; pendingExit = null;
  };
  const protection = (bar, gapsOnly) => {
    if (!position) return;
    const p = position, long = p.sign === 1;
    if (long ? bar.open <= p.plan.stopLoss : bar.open >= p.plan.stopLoss) {
      close(bar.open, bar.time, 'SL_GAP'); return;
    }
    if (long ? bar.open >= p.plan.takeProfit : bar.open <= p.plan.takeProfit) {
      close(p.plan.takeProfit, bar.time, 'TP_GAP'); return;
    }
    if (gapsOnly) return;
    const stop = long ? bar.low <= p.plan.stopLoss : bar.high >= p.plan.stopLoss;
    const target = long ? bar.high >= p.plan.takeProfit : bar.low <= p.plan.takeProfit;
    if (stop) close(p.plan.stopLoss, bar.closeTime, 'SL', target);
    else if (target) close(p.plan.takeProfit, bar.closeTime, 'TP');
  };
  const entryFactory = makeEntryPlan || ((forecast, bar) => buildEntryPlan(config, forecast, market,
    { time: bar.time, bidPrice: bar.open, askPrice: bar.open }, wallet, true, bar.time, reachabilityModel));

  for (let index = 0; index < candles.length; index++) {
    const bar = candles[index];
    if (bar.closeTime < from || bar.closeTime > to) continue;
    lastBar = bar;
    while (fundingIndex < fundingRows.length && Number(fundingRows[fundingIndex].fundingTime) <= bar.time) {
      const event = fundingRows[fundingIndex++];
      if (!position || Number(event.fundingTime) < from) continue;
      const fundingPrice = Number(event.markPrice) > 0 ? Number(event.markPrice) : bar.open;
      const payment = -position.sign * position.quantity * fundingPrice * Number(event.fundingRate);
      if (!Number.isFinite(payment)) throw new Error('Invalid funding record');
      wallet += payment; position.funding += payment; fundingPnl += payment;
    }
    protection(bar, true);
    if (position && pendingExit) close(bar.open, bar.time, pendingExit.reason);
    if (!position && pendingEntry && !sessionPause) {
      const forecast = pendingEntry;
      pendingEntry = null;
      if (initialWalletUsdt - wallet >= config.sessionLossBudgetUsdt) {
        sessionPause = { time: bar.time, walletUsdt: wallet, reason: 'SESSION_LOSS_BUDGET_REACHED' };
      } else if (wallet < config.marginUsdt + config.feeReserveUsdt) skip('INSUFFICIENT_FREE_USDT');
      else {
        try {
          if (!makeEntryPlan) selectLiveForecast({ objective: 'PRICE_DIRECTION', records: [forecast] }, config,
            forecast.modelId, bar.time, reachabilityModel.modelId);
          const plan = entryFactory(forecast, bar);
          if (!(plan.quantity > 0) || !(plan.estimatedEntry > 0) || plan.quantity * plan.estimatedEntry > 50 + 1e-8) {
            throw new Error('INVALID_POSITION_SIZE');
          }
          const entryFee = plan.quantity * plan.estimatedEntry * feeRate;
          wallet -= entryFee; entryFees += entryFee;
          position = { plan, entryTime: bar.time, entryPrice: plan.estimatedEntry, quantity: plan.quantity,
            sign: plan.side === 'LONG' ? 1 : -1, entryFee, funding: 0,
            entryExpectedNetPct: forecast.exitPlan.expectedNetPct };
        } catch (error) { skip(error.reason || error.message); }
      }
    }
    protection(bar, false);
    const forecast = frames[index]?.forecast;
    if (position) {
      if (policy === 'HORIZON' && bar.closeTime >= position.plan.expiresAt) {
        pendingExit = { reason: 'HORIZON_EXPIRED', forecastId: forecast?.id || null };
      } else if (policy === 'PREDICTION_REVERSAL') {
        const review = positionDirectionReview({ objective: 'PRICE_DIRECTION', records: forecast ? [forecast] : [] },
          config, position.plan, position.plan.modelId, bar.closeTime + 1);
        if (review.close) pendingExit = { reason: 'PREDICTION_REVERSED', forecastId: review.forecastId };
      }
    } else if (!sessionPause) {
      if (initialWalletUsdt - wallet >= config.sessionLossBudgetUsdt) {
        sessionPause = { time: bar.closeTime, walletUsdt: wallet, reason: 'SESSION_LOSS_BUDGET_REACHED' };
      } else if (gates && gates[index]?.matchesUserCriteria !== true) skip('FORWARD_CRITERIA_NOT_MET');
      else if (forecast?.status === 'FORECAST' && ['UP', 'DOWN'].includes(forecast.direction) &&
          forecast.exitPlan?.status === 'ESTIMATED' && forecast.exitPlan.expectedNetPct > 0) pendingEntry = forecast;
      else skip('NO_POSITIVE_NET_CANDIDATE');
    }
    const value = markEquity(bar.close);
    peak = Math.max(peak, value); maxDrawdown = Math.max(maxDrawdown, peak - value);
    equity.push({ time: bar.closeTime, equityUsdt: value, walletUsdt: wallet, openPosition: Boolean(position) });
  }
  if (!lastBar) throw new Error('No candles in backtest window');
  const wins = trades.filter(t => t.netPnlUsdt > 0), losses = trades.filter(t => t.netPnlUsdt < 0);
  const gains = wins.reduce((sum, t) => sum + t.netPnlUsdt, 0);
  const lossTotal = -losses.reduce((sum, t) => sum + t.netPnlUsdt, 0);
  const closedNet = trades.reduce((sum, t) => sum + t.netPnlUsdt, 0);
  const finalEquity = markEquity(lastBar.close);
  const open = position ? { side: position.plan.side, quantity: position.quantity, entryPrice: position.entryPrice,
    entryTime: position.entryTime, markPrice: lastBar.close, takeProfit: position.plan.takeProfit,
    stopLoss: position.plan.stopLoss, netIfClosedAtEndUsdt: finalEquity - wallet - position.entryFee + position.funding } : null;
  const expectedWallet = initialWalletUsdt + closedNet + (position ? position.funding - position.entryFee : 0);
  if (Math.abs(wallet - expectedWallet) > 1e-8) throw new Error('Backtest wallet accounting does not reconcile');
  return { summary: { policy, from: new Date(Math.max(from, equity[0].time)).toISOString(),
    to: new Date(lastBar.closeTime).toISOString(), initialWalletUsdt, trades: trades.length,
    wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length : null,
    closedNetPnlUsdt: closedNet, totalEquityPnlUsdt: finalEquity - initialWalletUsdt,
    endWalletUsdt: wallet, endEquityUsdt: finalEquity, tradingFeesUsdt: entryFees + exitFees,
    fundingPnlUsdt: fundingPnl, profitFactor: lossTotal > 0 ? gains / lossTotal : gains > 0 ? null : 0,
    maxBarCloseDrawdownUsdt: maxDrawdown, averageHoldMinutes: trades.length ?
      trades.reduce((sum, t) => sum + t.holdMinutes, 0) / trades.length : null,
    maxHoldMinutes: trades.length ? Math.max(...trades.map(t => t.holdMinutes)) : null,
    exitReasons: trades.reduce((counts, t) => { counts[t.reason] = (counts[t.reason] || 0) + 1; return counts; }, {}),
    ambiguousTrades: trades.filter(t => t.ambiguous).length, sessionPause, openPositionAtEnd: open, skipped }, trades, equity };
}

module.exports = { simulatePositionPolicy };
