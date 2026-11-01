'use strict';

const DEFAULTS = Object.freeze({
  side: 'SHORT',
  flowWindow: 5,
  flowThreshold: 0.1,
  flowExitThreshold: -0.05,
  useFlowFilter: true,
  emaFast: 8,
  emaSlow: 21,
  momentumWindow: 5,
  atrPeriod: 14,
  minAtrPct: 0.08,
  maxAtrPct: 1.5,
  minTrendPct: 0,
  minMomentumPct: 0,
  takeProfitPct: 0.35,
  stopLossPct: 0.3,
  maxHoldBars: 20,
  cooldownBars: 3,
  feeRate: 0.0005,
  slippageRate: 0.0002,
  notional: 100,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeKline(row) {
  return {
    timestamp: finite(row?.[0]),
    open: finite(row?.[1]),
    high: finite(row?.[2]),
    low: finite(row?.[3]),
    close: finite(row?.[4]),
    volume: finite(row?.[5]),
    quoteVolume: finite(row?.[7]),
    takerBuyVolume: finite(row?.[9]),
    takerBuyQuoteVolume: finite(row?.[10]),
  };
}

function buildIndicators(rawRows, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const candles = rawRows.map(normalizeKline);
  const indicators = new Array(candles.length).fill(null);
  const flowQuote = [];
  const flowBuyQuote = [];
  const trueRanges = [];
  const alphaFast = 2 / (config.emaFast + 1);
  const alphaSlow = 2 / (config.emaSlow + 1);
  let emaFast = null;
  let emaSlow = null;
  let rollingQuote = 0;
  let rollingBuyQuote = 0;
  let rollingTr = 0;
  let previousEmaFast = null;

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    previousEmaFast = emaFast;
    emaFast = emaFast === null ? candle.close : emaFast + alphaFast * (candle.close - emaFast);
    emaSlow = emaSlow === null ? candle.close : emaSlow + alphaSlow * (candle.close - emaSlow);
    const quoteVolume = candle.quoteVolume > 0
      ? candle.quoteVolume
      : candle.volume * candle.close;
    const takerBuyQuote = candle.takerBuyQuoteVolume > 0
      ? candle.takerBuyQuoteVolume
      : candle.takerBuyVolume * candle.close;
    flowQuote.push(quoteVolume);
    flowBuyQuote.push(takerBuyQuote);
    rollingQuote += quoteVolume;
    rollingBuyQuote += takerBuyQuote;
    if (flowQuote.length > config.flowWindow) {
      rollingQuote -= flowQuote.shift();
      rollingBuyQuote -= flowBuyQuote.shift();
    }

    const previousClose = index > 0 ? candles[index - 1].close : candle.close;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
    trueRanges.push(trueRange);
    rollingTr += trueRange;
    if (trueRanges.length > config.atrPeriod) rollingTr -= trueRanges.shift();

    const ready = index >= Math.max(
      config.emaSlow - 1,
      config.flowWindow - 1,
      config.momentumWindow,
      config.atrPeriod
    );
    if (!ready || !(rollingQuote > 0) || !(candle.close > 0)) continue;
    indicators[index] = {
      emaFast,
      emaSlow,
      previousEmaFast,
      previousClose: index > 0 ? candles[index - 1].close : candle.close,
      flowDeltaRatio: (2 * rollingBuyQuote - rollingQuote) / rollingQuote,
      momentumRatio: candle.close / candles[index - config.momentumWindow].close - 1,
      atrPct: rollingTr / trueRanges.length / candle.close * 100,
    };
  }
  return { candles, indicators };
}

function entrySignal(candle, indicator, options = {}) {
  if (!indicator) return false;
  const config = { ...DEFAULTS, ...options };
  if (indicator.atrPct < config.minAtrPct || indicator.atrPct > config.maxAtrPct) return false;
  if (config.side === 'LONG') {
    if (config.entryMode === 'VOLUME_DELTA_REVERSAL') {
      return indicator.flowDeltaRatio >= config.flowThreshold &&
        indicator.momentumRatio * 100 <= -config.minMomentumPct &&
        candle.close < indicator.emaSlow &&
        candle.close > candle.open;
    }
    if (config.entryMode === 'VOLUME_DELTA') {
      return indicator.flowDeltaRatio >= config.flowThreshold &&
        indicator.emaFast > indicator.emaSlow &&
        (indicator.emaFast - indicator.emaSlow) / candle.close * 100 >= config.minTrendPct &&
        indicator.momentumRatio * 100 >= config.minMomentumPct &&
        candle.close > indicator.emaFast;
    }
    const baseLong = (!config.useFlowFilter || indicator.flowDeltaRatio >= config.flowThreshold) &&
      indicator.emaFast > indicator.emaSlow &&
      (indicator.emaFast - indicator.emaSlow) / candle.close * 100 >= config.minTrendPct &&
      indicator.momentumRatio > 0;
    if (!baseLong) return false;
    if (config.entryMode === 'EMA_CROSS') {
      return indicator.previousClose <= indicator.previousEmaFast && candle.close > indicator.emaFast;
    }
    if (config.entryMode === 'EMA_REJECTION') {
      return candle.low <= indicator.emaFast && candle.close > indicator.emaFast && candle.close > candle.open;
    }
    return candle.close > indicator.emaFast;
  }
  if (config.entryMode === 'VOLUME_DELTA_REVERSAL') {
    return indicator.flowDeltaRatio <= -config.flowThreshold &&
      indicator.momentumRatio * 100 >= config.minMomentumPct &&
      candle.close > indicator.emaSlow &&
      candle.close < candle.open;
  }
  if (config.entryMode === 'VOLUME_DELTA') {
    return indicator.flowDeltaRatio <= -config.flowThreshold &&
      indicator.emaFast < indicator.emaSlow &&
      (indicator.emaSlow - indicator.emaFast) / candle.close * 100 >= config.minTrendPct &&
      indicator.momentumRatio * 100 <= -config.minMomentumPct &&
      candle.close < indicator.emaFast;
  }
  const baseShort = (!config.useFlowFilter || indicator.flowDeltaRatio <= -config.flowThreshold) &&
    indicator.emaFast < indicator.emaSlow &&
    (indicator.emaSlow - indicator.emaFast) / candle.close * 100 >= config.minTrendPct &&
    indicator.momentumRatio < 0;
  if (!baseShort) return false;
  if (config.entryMode === 'EMA_CROSS') {
    return indicator.previousClose >= indicator.previousEmaFast && candle.close < indicator.emaFast;
  }
  if (config.entryMode === 'EMA_REJECTION') {
    return candle.high >= indicator.emaFast && candle.close < indicator.emaFast && candle.close < candle.open;
  }
  return candle.close < indicator.emaFast;
}

function exitSignal(candle, indicator, options = {}) {
  if (!indicator) return false;
  const config = { ...DEFAULTS, ...options };
  if (!['VOLUME_DELTA', 'VOLUME_DELTA_REVERSAL'].includes(config.entryMode)) {
    return false;
  }
  return config.side === 'LONG'
    ? indicator.flowDeltaRatio <= config.flowExitThreshold
    : indicator.flowDeltaRatio >= -config.flowExitThreshold;
}

function tradePnl(position, rawExitPrice, reason, timestamp, options) {
  const config = { ...DEFAULTS, ...options };
  const isLong = config.side === 'LONG';
  const entryPrice = position.rawEntryPrice * (isLong
    ? 1 + config.slippageRate
    : 1 - config.slippageRate);
  const exitPrice = rawExitPrice * (isLong
    ? 1 - config.slippageRate
    : 1 + config.slippageRate);
  const quantity = config.notional / entryPrice;
  const grossPnl = isLong
    ? quantity * (exitPrice - entryPrice)
    : quantity * (entryPrice - exitPrice);
  const fees = quantity * (entryPrice + exitPrice) * config.feeRate;
  return {
    entryTimestamp: position.entryTimestamp,
    exitTimestamp: timestamp,
    entryPrice,
    exitPrice,
    rawEntryPrice: position.rawEntryPrice,
    rawExitPrice,
    barsHeld: position.barsHeld,
    reason,
    grossPnl,
    fees,
    netPnl: grossPnl - fees,
  };
}

function summarizeTrades(trades, start, end) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const reasons = {};
  for (const trade of [...trades].sort((left, right) => left.exitTimestamp - right.exitTimestamp)) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.netPnl > 0) grossProfit += trade.netPnl;
    else grossLoss += -trade.netPnl;
    reasons[trade.reason] = (reasons[trade.reason] || 0) + 1;
  }
  const days = Math.max(1 / 1440, (end - start) / 86_400_000);
  return {
    trades: trades.length,
    wins: trades.filter(trade => trade.netPnl > 0).length,
    losses: trades.filter(trade => trade.netPnl <= 0).length,
    winRate: trades.length ? trades.filter(trade => trade.netPnl > 0).length / trades.length : 0,
    netPnl: equity,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdown,
    tradesPerDay: trades.length / days,
    averageHoldBars: trades.length
      ? trades.reduce((sum, trade) => sum + trade.barsHeld, 0) / trades.length
      : 0,
    reasons,
  };
}

function simulate(rawRows, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const { candles, indicators } = buildIndicators(rawRows, config);
  const start = finite(config.start, candles[0]?.timestamp);
  const end = finite(config.end, (candles.at(-1)?.timestamp || start) + 60_000);
  const trades = [];
  let position = null;
  let cooldownUntil = -1;

  for (let index = 1; index < candles.length; index++) {
    const candle = candles[index];
    if (candle.timestamp < start) continue;
    if (candle.timestamp >= end) break;

    if (!position && index > cooldownUntil && entrySignal(candles[index - 1], indicators[index - 1], config)) {
      position = {
        rawEntryPrice: candle.open,
        entryTimestamp: candle.timestamp,
        entryIndex: index,
        barsHeld: 0,
      };
    }
    if (!position) continue;

    position.barsHeld = index - position.entryIndex + 1;
    if (position.entryIndex < index && exitSignal(candles[index - 1], indicators[index - 1], config)) {
      trades.push(tradePnl(position, candle.open, 'FLOW_EXIT', candle.timestamp, config));
      position = null;
      cooldownUntil = index + config.cooldownBars;
      continue;
    }
    const isLong = config.side === 'LONG';
    const takeProfit = position.rawEntryPrice * (1 + (isLong ? 1 : -1) * config.takeProfitPct / 100);
    const stopLoss = position.rawEntryPrice * (1 + (isLong ? -1 : 1) * config.stopLossPct / 100);
    const stopHit = isLong ? candle.low <= stopLoss : candle.high >= stopLoss;
    const takeProfitHit = isLong ? candle.high >= takeProfit : candle.low <= takeProfit;
    let rawExitPrice = null;
    let reason = null;

    // With one-minute OHLC there is no reliable event order. Counting the stop
    // first when both levels trade in one candle is the conservative assumption.
    if (stopHit) {
      rawExitPrice = stopLoss;
      reason = 'STOP_LOSS';
    } else if (takeProfitHit) {
      rawExitPrice = takeProfit;
      reason = 'TAKE_PROFIT';
    } else if (position.barsHeld >= config.maxHoldBars) {
      rawExitPrice = candle.close;
      reason = 'TIMEOUT';
    }

    if (reason) {
      trades.push(tradePnl(position, rawExitPrice, reason, candle.timestamp, config));
      position = null;
      cooldownUntil = index + config.cooldownBars;
    }
  }

  if (position) {
    const last = [...candles].reverse().find(candle => candle.timestamp < end && candle.timestamp >= start);
    if (last) trades.push(tradePnl(position, last.close, 'END_OF_PERIOD', last.timestamp, config));
  }
  return { config, trades, summary: summarizeTrades(trades, start, end) };
}

module.exports = {
  DEFAULTS,
  buildIndicators,
  entrySignal,
  exitSignal,
  normalizeKline,
  simulate,
  summarizeTrades,
};
