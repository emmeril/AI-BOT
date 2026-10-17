const { roundNumber } = require('./utils');

const FIFTEEN_MINUTES_MS = 15 * 60_000;

function normalizeRawKline(raw) {
  if (!Array.isArray(raw) || raw.length < 10) return null;
  const timestamp = Number(raw[0]);
  const open = Number(raw[1]);
  const high = Number(raw[2]);
  const low = Number(raw[3]);
  const close = Number(raw[4]);
  const volume = Number(raw[5]);
  const closeTime = Number(raw[6]);
  const takerBuyVolume = Number(raw[9]);
  if (![timestamp, open, high, low, close, volume, closeTime, takerBuyVolume].every(Number.isFinite) ||
      !(high >= low) || !(low > 0) || !(volume >= 0) || takerBuyVolume < 0 || takerBuyVolume > volume) {
    return null;
  }
  return { timestamp, open, high, low, close, volume, closeTime, takerBuyVolume };
}

function analyzeVolumeDelta(candleInput, options = {}) {
  const lookbackCandles = Math.max(1, Math.floor(Number(options.lookbackCandles) || 16));
  const candles = candleInput.map(normalizeRawKline).filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (candles.length < lookbackCandles) return null;
  const window = candles.slice(-lookbackCandles);
  const totalVolume = window.reduce((sum, candle) => sum + candle.volume, 0);
  const takerBuyVolume = window.reduce((sum, candle) => sum + candle.takerBuyVolume, 0);
  if (!(totalVolume > 0)) return null;
  const takerSellVolume = Math.max(0, totalVolume - takerBuyVolume);
  const delta = takerBuyVolume - takerSellVolume;
  return {
    lookbackCandles,
    timestamp: window.at(-1).timestamp,
    closeTime: window.at(-1).closeTime,
    totalVolume: roundNumber(totalVolume, 8),
    takerBuyVolume: roundNumber(takerBuyVolume, 8),
    takerSellVolume: roundNumber(takerSellVolume, 8),
    delta: roundNumber(delta, 8),
    deltaRatio: roundNumber(delta / totalVolume, 6),
    buyShare: roundNumber(takerBuyVolume / totalVolume, 6),
  };
}

function evaluateVolumeDeltaEntry(analysis, positionSide, options = {}) {
  if (!analysis || !Number.isFinite(Number(analysis.deltaRatio))) {
    return { allow: options.failClosed !== true, available: false, reason: 'volume_delta_unavailable' };
  }
  const oppositionThresholdPct = Math.max(0, Number(options.oppositionThresholdPct) || 0);
  const deltaRatio = Number(analysis.deltaRatio);
  const side = String(positionSide || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const signedDeltaRatio = side === 'SHORT' ? -deltaRatio : deltaRatio;
  const minimumSignedRatio = -oppositionThresholdPct / 100;
  return {
    allow: signedDeltaRatio >= minimumSignedRatio,
    available: true,
    side,
    deltaRatio,
    signedDeltaRatio: roundNumber(signedDeltaRatio, 6),
    oppositionThresholdPct,
    reason: signedDeltaRatio >= minimumSignedRatio ? 'within_threshold' : 'opposing_delta',
  };
}

class VolumeDeltaAnalyzer {
  constructor(exchange, options = {}) {
    this.exchange = exchange;
    this.options = {
      enabled: false,
      timeframe: '15m',
      timeframeMs: FIFTEEN_MINUTES_MS,
      lookbackCandles: 16,
      candleCloseBufferMs: 5000,
      ...options,
    };
    this.cache = new Map();
  }

  async analyze(symbol, now = Date.now()) {
    if (!this.options.enabled) return null;
    const cached = this.cache.get(symbol);
    if (cached && cached.refreshAfter > now) return cached.analysis;
    const request = this.exchange.fapiPublicGetKlines || this.exchange.fapiPublic_get_klines;
    if (typeof request !== 'function') throw new Error('Binance USD-M raw kline endpoint is unavailable');
    const market = this.exchange.market(symbol);
    const limit = Math.min(1500, Math.max(this.options.lookbackCandles + 2, 20));
    const rawRows = await request.call(this.exchange, {
      symbol: market.id,
      interval: this.options.timeframe,
      limit,
    });
    const closedBefore = now - this.options.candleCloseBufferMs;
    const closedRows = rawRows.filter(row => Number(row?.[6]) <= closedBefore);
    const analysis = analyzeVolumeDelta(closedRows, this.options);
    const timeframeMs = this.options.timeframeMs;
    const refreshAfter = Math.floor(closedBefore / timeframeMs) * timeframeMs +
      timeframeMs + this.options.candleCloseBufferMs;
    this.cache.set(symbol, { analysis, refreshAfter });
    return analysis;
  }
}

module.exports = {
  FIFTEEN_MINUTES_MS,
  VolumeDeltaAnalyzer,
  analyzeVolumeDelta,
  evaluateVolumeDeltaEntry,
  normalizeRawKline,
};
