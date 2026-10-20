const { timeframeToMs } = require('./fibonacci-range-advisor');
const { roundNumber } = require('./utils');

function normalizeCandle(raw) {
  if (!Array.isArray(raw) || raw.length < 5) return null;
  const timestamp = Number(raw[0]);
  const close = Number(raw[4]);
  if (!Number.isFinite(timestamp) || !(close > 0)) return null;
  return { timestamp, close };
}

function analyzePriceMomentum(candleInput, options = {}) {
  const lookbackCandles = Math.max(1, Math.floor(Number(options.lookbackCandles) || 144));
  const candles = candleInput.map(normalizeCandle).filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (candles.length < lookbackCandles + 1) return null;
  const window = candles.slice(-(lookbackCandles + 1));
  const startPrice = window[0].close;
  const endPrice = window.at(-1).close;
  const returnRatio = endPrice / startPrice - 1;
  return {
    lookbackCandles,
    timestamp: window.at(-1).timestamp,
    startPrice: roundNumber(startPrice, 12),
    endPrice: roundNumber(endPrice, 12),
    returnRatio: roundNumber(returnRatio, 8),
    direction: returnRatio > 0 ? 'BULLISH' : returnRatio < 0 ? 'BEARISH' : 'NEUTRAL',
  };
}

function evaluatePriceMomentumEntry(analysis, positionSide, options = {}) {
  const side = String(positionSide || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const returnRatio = Number(analysis?.returnRatio);
  if (!Number.isFinite(returnRatio)) {
    return {
      allow: options.failClosed !== true,
      available: false,
      side,
      reason: 'price_momentum_unavailable',
    };
  }
  const deadbandRatio = Math.max(0, Number(options.deadbandPct) || 0) / 100;
  const direction = returnRatio > deadbandRatio
    ? 'BULLISH'
    : returnRatio < -deadbandRatio
      ? 'BEARISH'
      : 'NEUTRAL';
  const requiredDirection = side === 'SHORT' ? 'BEARISH' : 'BULLISH';
  return {
    allow: direction === requiredDirection,
    available: true,
    side,
    direction,
    requiredDirection,
    returnRatio,
    deadbandPct: deadbandRatio * 100,
    reason: direction === requiredDirection ? 'momentum_aligned' : 'momentum_opposed',
  };
}

class PriceMomentumAnalyzer {
  constructor(exchange, options = {}) {
    this.exchange = exchange;
    this.options = {
      enabled: false,
      timeframe: '5m',
      lookbackCandles: 144,
      candleCloseBufferMs: 5000,
      ...options,
    };
    this.options.timeframeMs = timeframeToMs(this.options.timeframe);
    this.cache = new Map();
  }

  async analyze(symbol, now = Date.now()) {
    if (!this.options.enabled) return null;
    const cached = this.cache.get(symbol);
    if (cached && cached.refreshAfter > now) return cached.analysis;
    const limit = Math.min(1500, Math.max(this.options.lookbackCandles + 3, 20));
    const rows = await this.exchange.fetchOHLCV(symbol, this.options.timeframe, undefined, limit);
    const closedBefore = now - this.options.candleCloseBufferMs;
    const closedRows = rows.filter(row => Number(row?.[0]) + this.options.timeframeMs <= closedBefore);
    const analysis = analyzePriceMomentum(closedRows, this.options);
    const refreshAfter = Math.floor(closedBefore / this.options.timeframeMs) * this.options.timeframeMs +
      this.options.timeframeMs + this.options.candleCloseBufferMs;
    this.cache.set(symbol, { analysis, refreshAfter });
    return analysis;
  }
}

module.exports = {
  PriceMomentumAnalyzer,
  analyzePriceMomentum,
  evaluatePriceMomentumEntry,
  normalizeCandle,
};
