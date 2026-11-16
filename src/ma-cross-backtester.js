'use strict';

const { TIMEFRAMES, maSnapshot, evaluateMaCross, historicalProtection } = require('./ma-cross-strategy');
const { summarizeTrades } = require('./micro-scalper-strategy');

function aggregateCandles(rows, duration) {
  const result = [];
  let bucket = [];
  function flush() {
    if (bucket.length !== duration / 60_000) return;
    const first = bucket[0];
    const last = bucket.at(-1);
    if (Number(first[0]) % duration || Number(last[6]) !== Number(first[0]) + duration - 1) return;
    result.push([Number(first[0]), Number(first[1]), Math.max(...bucket.map(row => Number(row[2]))),
      Math.min(...bucket.map(row => Number(row[3]))), Number(last[4]),
      bucket.reduce((sum, row) => sum + Number(row[5]), 0), Number(last[6])]);
  }
  for (const row of rows) {
    if (bucket.length && Math.floor(Number(row[0]) / duration) !== Math.floor(Number(bucket[0][0]) / duration)) {
      flush();
      bucket = [];
    }
    bucket.push(row);
  }
  flush();
  return result;
}

function simulateMaCross(rawRows, config, options) {
  const { start, end, notional = 100, feeRate = 0.0005, slippageRate = 0.0002 } = options;
  const evaluateSignal = options.evaluateSignal || evaluateMaCross;
  const rows = rawRows.filter(row => Number(row[0]) < end);
  for (let i = 0; i < rows.length; i++) {
    if (Number(rows[i][6]) !== Number(rows[i][0]) + 59_999 ||
      (i && Number(rows[i][0]) - Number(rows[i - 1][0]) !== 60_000)) {
      throw new Error(`Invalid or missing 1m candle at index ${i}`);
    }
  }
  const data = { '1m': rows };
  const pointers = { '15m': 0, '1h': 0, '4h': 0 };
  for (const timeframe of Object.keys(pointers)) data[timeframe] = aggregateCandles(rows, TIMEFRAMES[timeframe]);
  const positions = { LONG: null, SHORT: null };
  const trades = [];
  const signals = { totalCrosses: 0, unavailable: 0, cooldownSkipped: 0, invalidLevelsOrCosts: 0, entryGapSkipped: 0 };
  function close(side, rawPrice, timestamp, reason) {
    const position = positions[side];
    const direction = side === 'LONG' ? 1 : -1;
    const exitPrice = rawPrice * (1 - direction * slippageRate);
    const grossPnl = direction * position.quantity * (exitPrice - position.entryPrice);
    const fees = position.quantity * (position.entryPrice + exitPrice) * feeRate;
    trades.push({ ...position, side, exitTimestamp: timestamp, exitPrice, rawExitPrice: rawPrice,
      reason, grossPnl, fees, netPnl: grossPnl - fees,
      barsHeld: Math.max(1, (timestamp - position.entryTimestamp) / 60_000) });
    positions[side] = null;
  }
  let firstSignalAt = null;
  for (let i = 100; i < rows.length; i++) {
    const row = rows[i];
    const timestamp = Number(row[0]);
    if (timestamp < start || timestamp >= end) continue;
    for (const timeframe of Object.keys(pointers)) {
      while (pointers[timeframe] < data[timeframe].length &&
        Number(data[timeframe][pointers[timeframe]][6]) < timestamp) pointers[timeframe]++;
    }
    const indicator = maSnapshot(rows.slice(i - 100, i));
    const cross = indicator && ((indicator.previousMa7 <= indicator.previousMa25 && indicator.ma7 > indicator.ma25) ||
      (indicator.previousMa7 >= indicator.previousMa25 && indicator.ma7 < indicator.ma25));
    let evaluated = {};
    if (cross) {
      signals.totalCrosses++;
      const history = { '1m': rows.slice(Math.max(0, i - 500), i) };
      for (const timeframe of Object.keys(pointers)) {
        history[timeframe] = data[timeframe].slice(Math.max(0, pointers[timeframe] - 500), pointers[timeframe]);
      }
      for (const side of ['LONG', 'SHORT']) evaluated[side] = evaluateSignal(history, side, config.strategies[side], timestamp);
      if (!evaluated.LONG.available) signals.unavailable++;
      else firstSignalAt ??= timestamp;
      const entrySide = indicator.ma7 > indicator.ma25 ? 'LONG' : 'SHORT';
      if (evaluated[entrySide].available && !evaluated[entrySide].risk?.valid) signals.invalidLevelsOrCosts++;
    }
    for (const side of ['LONG', 'SHORT']) {
      const direction = side === 'LONG' ? 1 : -1;
      const position = positions[side];
      const open = Number(row[1]);
      if (position) {
        const gapStop = direction * (open - position.stopLoss) <= 0;
        if (gapStop) close(side, open, timestamp, 'STOP_LOSS_GAP');
      }
      const signal = evaluated[side];
      if (!positions[side] && signal?.allow && config.activeSides.includes(side)) {
        const entryPrice = open * (1 + direction * slippageRate);
        const protection = historicalProtection(entryPrice, side, signal.supportResistance, { ...signal.risk, feeRate, slippageRate });
        if (!protection.valid || (signal.risk.requirePositiveNetTarget && protection.estimatedNetReturn <= 0)) {
          signals.entryGapSkipped++; continue;
        }
        const tradeNotional = notional * signal.risk.sizeMultiplier;
        positions[side] = {
          entryTimestamp: timestamp, entryPrice, rawEntryPrice: open,
          quantity: tradeNotional / entryPrice, notional: tradeNotional,
          risk: { ...signal.risk, ...protection }, countertrend: signal.countertrend,
          support: signal.supportResistance.support, resistance: signal.supportResistance.resistance,
          takeProfit: protection.takeProfitPrice,
          stopLoss: protection.stopLossPrice,
        };
      }
      const active = positions[side];
      if (!active) continue;
      const stopHit = side === 'LONG' ? Number(row[3]) <= active.stopLoss : Number(row[2]) >= active.stopLoss;
      const takeHit = side === 'LONG' ? Number(row[2]) >= active.takeProfit : Number(row[3]) <= active.takeProfit;
      if (stopHit) close(side, active.stopLoss, timestamp + 60_000, 'STOP_LOSS');
      else if (takeHit) close(side, active.takeProfit, timestamp + 60_000, 'TAKE_PROFIT');
    }
  }
  const last = rows.at(-1);
  const openPositions = Object.entries(positions).filter(([, position]) => position).map(([side, position]) => {
    const direction = side === 'LONG' ? 1 : -1;
    const markPrice = Number(last[4]);
    const estimatedExit = markPrice * (1 - direction * slippageRate);
    const estimatedFees = position.quantity * (position.entryPrice + estimatedExit) * feeRate;
    return { ...position, side, markPrice, estimatedFees,
      estimatedNetPnl: direction * position.quantity * (estimatedExit - position.entryPrice) - estimatedFees };
  });
  return { trades, openPositions, summary: summarizeTrades(trades, start, end), signals, firstSignalAt,
    timeframeCounts: Object.fromEntries(Object.entries(data).map(([tf, values]) => [tf, values.length])) };
}

module.exports = { aggregateCandles, simulateMaCross };
