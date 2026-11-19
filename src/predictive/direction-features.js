'use strict';

const { FEATURE_NAMES, buildFeatureRows } = require('./features');

const SCHEMA = 'direction-context-v1';
const NAMES = Object.freeze([...FEATURE_NAMES,
  'return30', 'return60', 'return120', 'return240',
  'sma7Gap', 'sma25Gap', 'sma99Gap', 'rsi14', 'rsi60', 'atr14',
  'volatility60', 'volatility240', 'zscore60', 'zscore240',
  'rangePosition60', 'rangePosition240', 'flow5', 'flow15', 'flow60',
  'volume5to60', 'volume15to240', 'body', 'upperWick', 'lowerWick',
  'upFraction15', 'upFraction60', 'hourSin', 'hourCos',
]);

function windowStats(candles, index, count) {
  let sum = 0, squares = 0, returns = 0, returnSquares = 0;
  let gain = 0, loss = 0, volume = 0, buy = 0, up = 0, tr = 0;
  let high = -Infinity, low = Infinity;
  for (let j = index - count + 1; j <= index; j++) {
    const c = candles[j], previous = candles[j - 1].close;
    const r = Math.log(c.close / previous), change = c.close - previous;
    sum += c.close; squares += c.close * c.close;
    returns += r; returnSquares += r * r;
    gain += Math.max(0, change); loss += Math.max(0, -change);
    volume += c.quoteVolume; buy += c.takerBuyQuote;
    up += Number(change > 0);
    tr += Math.max(c.high - c.low, Math.abs(c.high - previous), Math.abs(c.low - previous));
    high = Math.max(high, c.high); low = Math.min(low, c.low);
  }
  const mean = sum / count;
  return { mean, deviation: Math.sqrt(Math.max(0, squares / count - mean * mean)),
    volatility: Math.sqrt(Math.max(0, returnSquares / count - (returns / count) ** 2)),
    rsi: gain + loss ? gain / (gain + loss) - 0.5 : 0,
    atr: tr / count, volume: volume / count,
    flow: volume ? (2 * buy - volume) / volume : 0,
    up: up / count - 0.5, high, low };
}

function buildDirectionFeatures(candles) {
  return buildFeatureRows(candles).filter(row => row.index >= 240).map(row => {
    const i = row.index, c = candles[i];
    const windows = Object.fromEntries([5, 7, 14, 15, 25, 60, 99, 240].map(n =>
      [n, windowStats(candles, i, n)]));
    const position = n => windows[n].high > windows[n].low ?
      (c.close - windows[n].low) / (windows[n].high - windows[n].low) - 0.5 : 0;
    const zscore = n => windows[n].deviation > 1e-12 ?
      (c.close - windows[n].mean) / windows[n].deviation : 0;
    const hour = (c.closeTime % 86400000) / 86400000 * 2 * Math.PI;
    const x = [...row.x, ...[30, 60, 120, 240].map(n => Math.log(c.close / candles[i - n].close)),
      ...[7, 25, 99].map(n => (c.close - windows[n].mean) / c.close),
      windows[14].rsi, windows[60].rsi, windows[14].atr / c.close,
      windows[60].volatility, windows[240].volatility, zscore(60), zscore(240),
      position(60), position(240), windows[5].flow, windows[15].flow, windows[60].flow,
      windows[5].volume / windows[60].volume - 1,
      windows[15].volume / windows[240].volume - 1,
      (c.close - c.open) / c.close, (c.high - Math.max(c.open, c.close)) / c.close,
      (Math.min(c.open, c.close) - c.low) / c.close,
      windows[15].up, windows[60].up, Math.sin(hour), Math.cos(hour)];
    if (x.length !== NAMES.length || !x.every(Number.isFinite)) throw new Error('Invalid direction features');
    return { ...row, x };
  });
}

module.exports = { SCHEMA, NAMES, buildDirectionFeatures };
