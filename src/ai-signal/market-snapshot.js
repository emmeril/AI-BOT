'use strict';

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 6) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
}

function closedKlines(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => Array.isArray(row) && finite(row[6], Infinity) < now)
    .sort((left, right) => finite(left[0], 0) - finite(right[0], 0));
}

function percentageChange(current, previous) {
  return previous > 0 ? (current / previous - 1) * 100 : null;
}

function returnAtOffset(rows, offset) {
  if (rows.length <= offset) return null;
  return round(percentageChange(finite(rows.at(-1)?.[4], 0), finite(rows.at(-1 - offset)?.[4], 0)), 4);
}

function ema(values, period) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  let value = values[0];
  for (let index = 1; index < values.length; index++) {
    value += alpha * (values[index] - value);
  }
  return value;
}

function atrPct(rows, period = 14) {
  if (rows.length < period + 1) return null;
  const recent = rows.slice(-(period + 1));
  let total = 0;
  for (let index = 1; index < recent.length; index++) {
    const high = finite(recent[index][2], 0);
    const low = finite(recent[index][3], 0);
    const previousClose = finite(recent[index - 1][4], 0);
    total += Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  }
  const close = finite(recent.at(-1)[4], 0);
  return close > 0 ? round(total / period / close * 100, 4) : null;
}

function flowDeltaRatio(rows, window) {
  const recent = rows.slice(-window);
  let quoteVolume = 0;
  let takerBuyQuoteVolume = 0;
  for (const row of recent) {
    const close = finite(row[4], 0);
    quoteVolume += finite(row[7], finite(row[5], 0) * close);
    takerBuyQuoteVolume += finite(row[10], finite(row[9], 0) * close);
  }
  return quoteVolume > 0 ? round((2 * takerBuyQuoteVolume - quoteVolume) / quoteVolume, 5) : null;
}

function volumeRatio(rows, period = 20) {
  if (rows.length < period + 1) return null;
  const current = finite(rows.at(-1)[7], 0);
  const baseline = rows.slice(-(period + 1), -1)
    .reduce((sum, row) => sum + finite(row[7], 0), 0) / period;
  return baseline > 0 ? round(current / baseline, 4) : null;
}

function rangePosition(rows, period = 96) {
  const recent = rows.slice(-(period + 1));
  if (!recent.length) return null;
  const high = Math.max(...recent.map(row => finite(row[2], -Infinity)));
  const low = Math.min(...recent.map(row => finite(row[3], Infinity)));
  const close = finite(recent.at(-1)[4], 0);
  return high > low ? round((close - low) / (high - low), 4) : 0.5;
}

function buildMarketSnapshot(symbol, rawRows, options = {}) {
  const rows = closedKlines(rawRows, finite(options.now, Date.now()));
  if (rows.length < 97) {
    throw new Error(`${symbol} requires at least 97 closed candles, received ${rows.length}`);
  }
  const close = finite(rows.at(-1)[4], 0);
  if (!(close > 0)) throw new Error(`${symbol} has an invalid closing price`);
  const closes = rows.map(row => finite(row[4], 0));
  const emaFast = ema(closes, 8);
  const emaSlow = ema(closes, 21);

  return {
    symbol,
    timeframe: String(options.timeframe || '15m'),
    candleOpenTime: finite(rows.at(-1)[0], 0),
    candleCloseTime: finite(rows.at(-1)[6], 0),
    close: round(close, 10),
    returnsPct: {
      m15: returnAtOffset(rows, 1),
      h1: returnAtOffset(rows, 4),
      h4: returnAtOffset(rows, 16),
      h24: returnAtOffset(rows, 96),
    },
    emaGapPct: round((emaFast - emaSlow) / close * 100, 4),
    atrPct: atrPct(rows),
    flowDelta: {
      m15: flowDeltaRatio(rows, 1),
      h1: flowDeltaRatio(rows, 4),
      h4: flowDeltaRatio(rows, 16),
    },
    volumeRatio20: volumeRatio(rows),
    rangePosition24h: rangePosition(rows),
  };
}

module.exports = {
  buildMarketSnapshot,
  closedKlines,
  flowDeltaRatio,
};
