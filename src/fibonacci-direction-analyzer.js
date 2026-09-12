const { retry, roundNumber } = require('./utils');
const { timeframeToMs } = require('./fibonacci-range-advisor');

const VALID_DIRECTIONS = new Set(['BULLISH', 'BEARISH', 'RANGING', 'UNCERTAIN']);

function normalizeCandle(raw) {
  if (Array.isArray(raw)) {
    const [timestamp, open, high, low, close, volume = 0] = raw.map(Number);
    if (![timestamp, open, high, low, close].every(Number.isFinite) || !(high > low) || !(low > 0)) return null;
    return { timestamp, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
  }
  const candle = {
    timestamp: Number(raw?.timestamp),
    open: Number(raw?.open),
    high: Number(raw?.high),
    low: Number(raw?.low),
    close: Number(raw?.close),
    volume: Number(raw?.volume || 0),
  };
  if (![candle.timestamp, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) ||
      !(candle.high > candle.low) || !(candle.low > 0)) return null;
  return candle;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const series = Array(period - 1).fill(null);
  series.push(seed);
  for (let index = period; index < values.length; index++) {
    series.push((values[index] - series[index - 1]) * multiplier + series[index - 1]);
  }
  return series;
}

function averageTrueRange(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const ranges = [];
  for (let index = 1; index < candles.length; index++) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    ));
  }
  const window = ranges.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

function findConfirmedPivots(candles, lookback = 2) {
  const highs = [];
  const lows = [];
  for (let index = lookback; index < candles.length - lookback; index++) {
    const window = candles.slice(index - lookback, index + lookback + 1);
    const candle = candles[index];
    if (window.every((candidate, offset) => offset === lookback || candle.high > candidate.high)) {
      highs.push({ index, price: candle.high, timestamp: candle.timestamp });
    }
    if (window.every((candidate, offset) => offset === lookback || candle.low < candidate.low)) {
      lows.push({ index, price: candle.low, timestamp: candle.timestamp });
    }
  }
  return { highs, lows };
}

function classifyScore(score) {
  if (score >= 2) return 'BULLISH';
  if (score <= -2) return 'BEARISH';
  if (Math.abs(score) <= 0.75) return 'RANGING';
  return 'UNCERTAIN';
}

function analyzeTimeframe(candleInput, timeframe, options = {}) {
  const pivotLookback = Math.max(1, Number(options.pivotLookback) || 2);
  const candles = candleInput.map(normalizeCandle).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < 55) return null;

  const closes = candles.map(candle => candle.close);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const atr14 = averageTrueRange(candles, 14);
  if (!(atr14 > 0) || !ema20.length || !ema50.length) return null;

  const lastIndex = candles.length - 1;
  const lastClose = closes[lastIndex];
  const lastEma20 = ema20[lastIndex];
  const lastEma50 = ema50[lastIndex];
  const slopeReferenceIndex = Math.max(19, lastIndex - 5);
  const ema20SlopeAtr = (lastEma20 - ema20[slopeReferenceIndex]) / atr14;
  const { highs, lows } = findConfirmedPivots(candles, pivotLookback);
  let score = 0;
  const reasons = [];

  if (highs.length >= 2 && lows.length >= 2) {
    const higherHigh = highs.at(-1).price > highs.at(-2).price;
    const higherLow = lows.at(-1).price > lows.at(-2).price;
    const lowerHigh = highs.at(-1).price < highs.at(-2).price;
    const lowerLow = lows.at(-1).price < lows.at(-2).price;
    if (higherHigh && higherLow) {
      score += 2;
      reasons.push('HH_HL');
    } else if (lowerHigh && lowerLow) {
      score -= 2;
      reasons.push('LH_LL');
    } else {
      if (higherHigh || higherLow) score += 0.5;
      if (lowerHigh || lowerLow) score -= 0.5;
      reasons.push('MIXED_STRUCTURE');
    }
  } else {
    reasons.push('INSUFFICIENT_PIVOTS');
  }

  const emaSeparationAtr = (lastEma20 - lastEma50) / atr14;
  if (emaSeparationAtr >= 0.1) {
    score += 1;
    reasons.push('EMA20_ABOVE_EMA50');
  } else if (emaSeparationAtr <= -0.1) {
    score -= 1;
    reasons.push('EMA20_BELOW_EMA50');
  }

  if (ema20SlopeAtr >= 0.25) {
    score += 1;
    reasons.push('EMA20_RISING');
  } else if (ema20SlopeAtr <= -0.25) {
    score -= 1;
    reasons.push('EMA20_FALLING');
  }

  const closeDistanceAtr = (lastClose - lastEma20) / atr14;
  if (closeDistanceAtr >= 0.1) score += 0.5;
  else if (closeDistanceAtr <= -0.1) score -= 0.5;

  // Directional Fibonacci confirmation uses the most recent 50-candle impulse.
  // Low-before-high is an upward impulse; high-before-low is a downward impulse.
  const impulseWindowStart = Math.max(0, candles.length - 50);
  const impulseWindow = candles.slice(impulseWindowStart);
  let highIndex = 0;
  let lowIndex = 0;
  for (let index = 1; index < impulseWindow.length; index++) {
    if (impulseWindow[index].high > impulseWindow[highIndex].high) highIndex = index;
    if (impulseWindow[index].low < impulseWindow[lowIndex].low) lowIndex = index;
  }
  const swingHigh = impulseWindow[highIndex].high;
  const swingLow = impulseWindow[lowIndex].low;
  const swingRange = swingHigh - swingLow;
  let impulse = 'NONE';
  let goldenZone = null;
  if (swingRange > 0 && lowIndex < highIndex) {
    impulse = 'UP';
    goldenZone = {
      lower: swingHigh - swingRange * 0.618,
      upper: swingHigh - swingRange * 0.5,
    };
    if (lastClose >= goldenZone.lower) {
      score += 0.5;
      reasons.push('UP_IMPULSE_ABOVE_GOLDEN_618');
    } else {
      score -= 0.5;
      reasons.push('UP_IMPULSE_LOST_GOLDEN_618');
    }
  } else if (swingRange > 0 && highIndex < lowIndex) {
    impulse = 'DOWN';
    goldenZone = {
      lower: swingLow + swingRange * 0.5,
      upper: swingLow + swingRange * 0.618,
    };
    if (lastClose <= goldenZone.upper) {
      score -= 0.5;
      reasons.push('DOWN_IMPULSE_BELOW_GOLDEN_618');
    } else {
      score += 0.5;
      reasons.push('DOWN_IMPULSE_RECLAIMED_GOLDEN_618');
    }
  }

  score = roundNumber(Math.max(-4.5, Math.min(4.5, score)), 4);
  return {
    timeframe,
    direction: classifyScore(score),
    score,
    close: lastClose,
    atr14: roundNumber(atr14, 8),
    ema20: roundNumber(lastEma20, 8),
    ema50: roundNumber(lastEma50, 8),
    ema20SlopeAtr: roundNumber(ema20SlopeAtr, 4),
    impulse,
    goldenZone: goldenZone ? {
      lower: roundNumber(goldenZone.lower, 8),
      upper: roundNumber(goldenZone.upper, 8),
    } : null,
    pivots: { highs: highs.length, lows: lows.length },
    reasons,
    candleCount: candles.length,
    lastClosedAt: candles[lastIndex].timestamp,
  };
}

function aggregateTimeframes(results) {
  const valid = results.filter(Boolean);
  if (!valid.length) return null;
  const minimumMs = Math.min(...valid.map(result => timeframeToMs(result.timeframe)).filter(value => value > 0));
  let weightedScore = 0;
  let totalWeight = 0;
  const weightedDirections = { BULLISH: 0, BEARISH: 0, RANGING: 0, UNCERTAIN: 0 };
  for (const result of valid) {
    const timeframeMs = timeframeToMs(result.timeframe);
    const weight = 1 + Math.log2(Math.max(timeframeMs / minimumMs, 1));
    weightedScore += result.score * weight;
    totalWeight += weight;
    weightedDirections[result.direction] += weight;
  }
  const normalizedScore = weightedScore / (totalWeight * 4.5);
  let direction;
  if (normalizedScore >= 0.25) direction = 'BULLISH';
  else if (normalizedScore <= -0.25) direction = 'BEARISH';
  else if (Math.abs(normalizedScore) <= 0.1) direction = 'RANGING';
  else direction = 'UNCERTAIN';

  const alignment = weightedDirections[direction] / totalWeight;
  const confidence = direction === 'RANGING'
    ? 0.5 + (1 - Math.abs(normalizedScore)) * 0.25 + alignment * 0.25
    : direction === 'UNCERTAIN'
      ? 0.5
      : 0.5 + Math.abs(normalizedScore) * 0.35 + alignment * 0.15;
  return {
    direction,
    score: roundNumber(normalizedScore, 4),
    confidence: roundNumber(Math.min(0.99, confidence), 4),
    alignment: roundNumber(alignment, 4),
    timeframeCount: valid.length,
    timeframes: Object.fromEntries(valid.map(result => [result.timeframe, result])),
  };
}

class FibonacciDirectionAnalyzer {
  constructor(exchange, options = {}) {
    this.exchange = exchange;
    this.options = {
      enabled: false,
      timeframes: ['15m', '1h', '4h'],
      candleLimit: 100,
      candleCloseBufferMs: 5000,
      pivotLookback: 2,
      minimumTimeframes: 2,
      confirmations: 2,
      ...options,
    };
    this.cache = {};
    this.warnedUnsupportedTimeframes = new Set();
  }

  isEnabled() {
    return Boolean(this.options.enabled);
  }

  resolveTimeframes() {
    const available = Object.keys(this.exchange?.timeframes || {});
    return [...new Set(this.options.timeframes.map(String).map(value => value.trim()).filter(Boolean))]
      .filter(timeframe => {
        const supported = timeframeToMs(timeframe) > 0 && (!available.length || available.includes(timeframe));
        if (!supported && !this.warnedUnsupportedTimeframes.has(timeframe)) {
          console.warn(`[FIB-DIRECTION] Ignoring unsupported timeframe: ${timeframe}`);
          this.warnedUnsupportedTimeframes.add(timeframe);
        }
        return supported;
      })
      .sort((left, right) => timeframeToMs(left) - timeframeToMs(right));
  }

  getLastClosedCandleStart(now, timeframeMs) {
    const bufferedNow = now - this.options.candleCloseBufferMs;
    return Math.floor(bufferedNow / timeframeMs) * timeframeMs - timeframeMs;
  }

  async fetchClosedCandles(symbol, timeframe, now) {
    const timeframeMs = timeframeToMs(timeframe);
    const raw = await retry(() => this.exchange.fetchOHLCV(
      symbol,
      timeframe,
      undefined,
      Math.max(55, Number(this.options.candleLimit) || 100)
    ));
    const closedBefore = now - this.options.candleCloseBufferMs;
    return (Array.isArray(raw) ? raw : [])
      .map(normalizeCandle)
      .filter(Boolean)
      .filter(candle => candle.timestamp + timeframeMs <= closedBefore)
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  async getAnalysis(symbol, now = Date.now()) {
    if (!this.isEnabled()) return null;
    const timeframes = this.resolveTimeframes();
    const entry = this.cache[symbol] || { timeframes: {}, analysis: null };
    let refreshed = false;
    for (const timeframe of timeframes) {
      const timeframeMs = timeframeToMs(timeframe);
      const targetStart = this.getLastClosedCandleStart(now, timeframeMs);
      if (Number(entry.timeframes[timeframe]?.lastClosedAt ?? -1) >= targetStart) continue;
      try {
        const candles = await this.fetchClosedCandles(symbol, timeframe, now);
        const result = analyzeTimeframe(candles, timeframe, this.options);
        if (result) {
          entry.timeframes[timeframe] = result;
          refreshed = true;
        }
      } catch (err) {
        console.warn(`[FIB-DIRECTION] ${symbol} ${timeframe} analysis failed:`, err.message);
      }
    }
    const results = timeframes.map(timeframe => entry.timeframes[timeframe]).filter(Boolean);
    if (results.length < Math.max(1, Number(this.options.minimumTimeframes) || 2)) {
      this.cache[symbol] = entry;
      return entry.analysis;
    }
    if (!refreshed && entry.analysis) return entry.analysis;
    const aggregate = aggregateTimeframes(results);
    const directionalCandidate = ['BULLISH', 'BEARISH'].includes(aggregate.direction)
      ? aggregate.direction
      : 'RANGING';
    if (directionalCandidate === 'RANGING') {
      entry.confirmation = { candidate: 'RANGING', count: 0 };
    } else if (entry.confirmation?.candidate === directionalCandidate) {
      entry.confirmation.count += 1;
    } else {
      entry.confirmation = { candidate: directionalCandidate, count: 1 };
    }
    const confirmationsRequired = Math.max(1, Number(this.options.confirmations) || 2);
    const confirmedDirection = directionalCandidate !== 'RANGING' &&
      entry.confirmation.count >= confirmationsRequired
      ? directionalCandidate
      : 'RANGING';
    entry.analysis = {
      ...aggregate,
      confirmedDirection,
      confirmationCount: entry.confirmation.count,
      confirmationsRequired,
      source: 'FIBONACCI_DIRECTION',
      generatedAt: new Date(now).toISOString(),
    };
    this.cache[symbol] = entry;
    return entry.analysis;
  }
}

module.exports = {
  VALID_DIRECTIONS,
  FibonacciDirectionAnalyzer,
  normalizeCandle,
  emaSeries,
  averageTrueRange,
  findConfirmedPivots,
  analyzeTimeframe,
  aggregateTimeframes,
};
