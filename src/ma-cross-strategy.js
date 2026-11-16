'use strict';

const { annotateCrossRetests, selectHistoricalCrossPrices } = require('./historical-cross-selector');

const TIMEFRAMES = Object.freeze({ '1m': 60_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 });
const SUPPORT_CROSS_PAIRS = Object.freeze([[7, 25], [7, 99], [25, 99]].map(pair => Object.freeze(pair)));

function historicalProtection(entryPrice, side, supportResistance, options = {}) {
  const entry = Number(entryPrice);
  if (supportResistance?.selection) {
    const selected = selectHistoricalCrossPrices({ side, levels: supportResistance.levels }, entry,
      supportResistance.selection, options);
    if (!selected) return { valid: false, reason: 'Kandidat cross historis terkonfirmasi belum cukup' };
    supportResistance = { ...supportResistance,
      support: side === 'LONG' ? selected.sources.stop : selected.sources.target,
      resistance: side === 'LONG' ? selected.sources.target : selected.sources.stop };
  }
  const support = Number(supportResistance?.support?.price);
  const resistance = Number(supportResistance?.resistance?.price);
  const direction = side === 'LONG' ? 1 : -1;
  const takeProfitPrice = side === 'LONG' ? resistance : support;
  const mirror = options.stopMode === 'MIRROR_TARGET' || options.exitMode === 'CROSS_TARGET_RR1';
  const stopLossPrice = mirror ? 2 * entry - takeProfitPrice : side === 'LONG' ? support : resistance;
  if (!(entry > 0 && takeProfitPrice > 0 && stopLossPrice > 0 &&
    direction * (takeProfitPrice - entry) > 0 && direction * (entry - stopLossPrice) > 0)) {
    return { valid: false, reason: mirror ? 'TP cross historis atau SL cermin tidak valid' : 'Support/resisten historis belum mengapit harga entry' };
  }
  const feeRate = options.feeRate ?? 0.0005;
  const slippageRate = options.slippageRate ?? 0.0002;
  const estimatedExit = takeProfitPrice * (1 - direction * slippageRate);
  const estimatedNetReturn = (direction * (estimatedExit - entry) - (entry + estimatedExit) * feeRate) / entry;
  return { valid: true, protectionMode: mirror ? 'CROSS_TARGET_RR1' : 'HISTORICAL_CROSS',
    stopMode: mirror ? 'MIRROR_TARGET' : 'HISTORICAL_CROSS', takeProfitPrice, stopLossPrice,
    support: supportResistance.support, resistance: supportResistance.resistance,
    takeProfitPct: Math.abs(takeProfitPrice / entry - 1) * 100,
    stopLossPct: Math.abs(stopLossPrice / entry - 1) * 100, estimatedNetReturn };
}

function historicalCrossLevels(rows, timeframe, beforeTimestamp, pairs = SUPPORT_CROSS_PAIRS) {
  const levels = [];
  const periods = [...new Set(pairs.flat())];
  const sums = Object.fromEntries(periods.map(period => [period, 0]));
  let previous = null;
  for (let index = 0; index < rows.length; index++) {
    const close = Number(rows[index][4]);
    if (!Number.isFinite(close) || close <= 0) return [];
    const current = {};
    for (const period of periods) {
      sums[period] += close;
      if (index >= period) sums[period] -= Number(rows[index - period][4]);
      if (index >= period - 1) current[period] = sums[period] / period;
    }
    for (const [fast, slow] of pairs) {
      if (previous?.[fast] === undefined || previous?.[slow] === undefined || current[slow] === undefined) continue;
      const difference = current[fast] - current[slow];
      const previousDifference = previous[fast] - previous[slow];
      const up = previousDifference <= 0 && difference > 0;
      const down = previousDifference >= 0 && difference < 0;
      if ((up || down) && Number(rows[index][0]) < beforeTimestamp) {
        // Interpolate each pair's intersection between two completed candles.
        const fraction = -previousDifference / (difference - previousDifference);
        levels.push({ price: previous[fast] + fraction * (current[fast] - previous[fast]),
          timestamp: Number(rows[index][0]), timeframe, cross: up ? 'UP' : 'DOWN',
          pair: `MA${fast}/MA${slow}`, fastPeriod: fast, slowPeriod: slow });
      }
    }
    previous = current;
  }
  return levels;
}

function maSnapshot(rows) {
  if (rows.length < 100) return null;
  const closes = rows.map(row => Number(row[4]));
  if (closes.some(value => !Number.isFinite(value) || value <= 0)) return null;
  const average = (period, offset = 0) => {
    const end = closes.length - offset;
    return closes.slice(end - period, end).reduce((sum, value) => sum + value, 0) / period;
  };
  const ma7 = average(7);
  const ma25 = average(25);
  const ma99 = average(99);
  return {
    ma7, ma25, ma99,
    previousMa7: average(7, 1),
    previousMa25: average(25, 1),
    trend: ma7 > ma99 && ma25 > ma99 ? 'BULLISH'
      : ma7 < ma99 && ma25 < ma99 ? 'BEARISH' : 'MIXED',
  };
}

function evaluateMaCross(rowsByTimeframe, side, strategy, now = Date.now()) {
  const snapshots = {};
  const rows = {};
  for (const [timeframe, duration] of Object.entries(TIMEFRAMES)) {
    // Anchor all higher-timeframe observations to the close of the entry candle.
    const cutoff = timeframe === '1m' ? now : Math.min(now, Number(rows['1m']?.at(-1)?.[6]) + 1);
    rows[timeframe] = (rowsByTimeframe[timeframe] || []).filter(row => Number(row[6]) < cutoff);
    const last = rows[timeframe].at(-1);
    const contiguous = rows[timeframe].slice(-100).every((row, index, tail) =>
      Number(row[6]) === Number(row[0]) + duration - 1 &&
      (index === 0 || Number(row[0]) - Number(tail[index - 1][0]) === duration));
    snapshots[timeframe] = last && now - Number(last[6]) <= duration + 30_000 && contiguous
      ? maSnapshot(rows[timeframe]) : null;
  }
  const last = rows['1m'].at(-1);
  const indicator = snapshots['1m'];
  const candle = last ? { timestamp: Number(last[0]), close: Number(last[4]) } : null;
  const levels = candle ? Object.keys(TIMEFRAMES).flatMap(timeframe =>
    historicalCrossLevels(rows[timeframe], timeframe, candle.timestamp, strategy.supportCrossPairs)) : [];
  if (strategy.includeMa99Line) {
    for (const [timeframe, snapshot] of Object.entries(snapshots)) if (snapshot) {
      levels.push({ price: snapshot.ma99, timestamp: Number(rows[timeframe].at(-1)[0]),
        timeframe, pair: 'MA99', kind: 'MA99_LINE' });
    }
  }
  let supportResistance = {
    source: strategy.includeMa99Line ? 'PREVIOUS_MA_CROSSES_AND_MA99_LINE' : 'PREVIOUS_MA_CROSSES',
    pairs: strategy.supportCrossPairs || SUPPORT_CROSS_PAIRS,
    support: levels.filter(level => level.price < candle.close).sort((a, b) => b.price - a.price)[0] || null,
    resistance: levels.filter(level => level.price > candle.close).sort((a, b) => a.price - b.price)[0] || null,
    levels,
  };
  const base = { candle, candleTimestamp: candle?.timestamp || 0, indicator,
    timeframes: snapshots, supportResistance, entrySource: 'MA_CROSS', allow: false, exit: false, available: false };
  if (!indicator) return { ...base, reason: 'Menunggu 100 candle 1m yang lengkap dan terbaru' };
  const crossUp = indicator.previousMa7 <= indicator.previousMa25 && indicator.ma7 > indicator.ma25;
  const crossDown = indicator.previousMa7 >= indicator.previousMa25 && indicator.ma7 < indicator.ma25;
  const exit = false;
  if (Object.values(snapshots).some(value => !value)) {
    return { ...base, exit, reason: 'Menunggu data MA 15m, 1h, dan 4h yang lengkap dan terbaru' };
  }
  const expected = side === 'LONG' ? 'BULLISH' : 'BEARISH';
  const countertrend = Object.values(snapshots).some(value => value.trend !== expected);
  if (strategy.crossSelection) {
    const candidates = Object.keys(TIMEFRAMES).flatMap(timeframe =>
      annotateCrossRetests(rows[timeframe], levels.filter(level => level.timeframe === timeframe)));
    const selected = selectHistoricalCrossPrices({ side, levels: candidates }, candle.close, strategy.crossSelection, strategy);
    supportResistance = { ...supportResistance, source: 'SELECTED_HISTORICAL_CROSSES',
      selection: strategy.crossSelection, levels: candidates,
      support: selected ? side === 'LONG' ? selected.sources.stop : selected.sources.target : null,
      resistance: selected ? side === 'LONG' ? selected.sources.target : selected.sources.stop : null };
  }
  const protection = historicalProtection(candle.close, side, supportResistance, strategy);
  const risk = {
    side,
    ...protection,
    maxHoldMinutes: null,
    sizeMultiplier: countertrend ? strategy.countertrendSizeMultiplier : 1,
  };
  const cross = side === 'LONG' ? crossUp : crossDown;
  const allow = cross && protection.valid;
  return { ...base, supportResistance, available: true, allow, exit, countertrend, risk,
    reason: `${cross ? protection.valid ? `Cross MA7/MA25; TP historis${protection.stopMode === 'MIRROR_TARGET' ? '; SL cermin 1:1' : '; SL historis'}` : protection.reason : 'Menunggu cross MA7/MA25'}; ${countertrend ? 'countertrend / timeframe belum searah' : 'semua timeframe searah'}` };
}

module.exports = { TIMEFRAMES, SUPPORT_CROSS_PAIRS, maSnapshot, evaluateMaCross, historicalCrossLevels, historicalProtection };
