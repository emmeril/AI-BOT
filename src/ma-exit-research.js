'use strict';

const { aggregateCandles } = require('./ma-cross-backtester');
const { TIMEFRAMES, maSnapshot, evaluateMaCross } = require('./ma-cross-strategy');
const { buildCrossZones, selectZoneProtection } = require('./confirmed-cross-zones');

function atr(rows, period = 14) {
  if (rows.length < period + 1) return 0;
  let sum = 0;
  for (let i = rows.length - period; i < rows.length; i++) {
    sum += Math.max(Number(rows[i][2]) - Number(rows[i][3]), Math.abs(Number(rows[i][2]) - Number(rows[i - 1][4])),
      Math.abs(Number(rows[i][3]) - Number(rows[i - 1][4])));
  }
  return sum / period;
}

function prepareExitResearch(rows, config) {
  for (let i = 1; i < rows.length; i++) if (Number(rows[i][0]) - Number(rows[i - 1][0]) !== 60_000) throw new Error('Noncontiguous 1m history');
  const higher = {};
  const pointers = { '15m': 0, '1h': 0, '4h': 0 };
  const zoneCache = {};
  for (const tf of Object.keys(pointers)) higher[tf] = aggregateCandles(rows, TIMEFRAMES[tf]);
  const events = new Map();
  for (let index = 100; index < rows.length; index++) {
    const indicator = maSnapshot(rows.slice(index - 100, index));
    const up = indicator.previousMa7 <= indicator.previousMa25 && indicator.ma7 > indicator.ma25;
    const down = indicator.previousMa7 >= indicator.previousMa25 && indicator.ma7 < indicator.ma25;
    if (!up && !down) continue;
    const now = Number(rows[index][0]);
    const side = up ? 'LONG' : 'SHORT';
    const history = { '1m': rows.slice(Math.max(0, index - 500), index) };
    const sets = {};
    for (const tf of Object.keys(pointers)) {
      while (pointers[tf] < higher[tf].length && Number(higher[tf][pointers[tf]][6]) < now) pointers[tf]++;
      history[tf] = higher[tf].slice(Math.max(0, pointers[tf] - 500), pointers[tf]);
      if (zoneCache[tf]?.pointer !== pointers[tf]) zoneCache[tf] = { pointer: pointers[tf], value: buildCrossZones(history[tf], tf, now) };
      sets[tf] = zoneCache[tf].value;
    }
    const base = evaluateMaCross(history, side, { ...config.strategies[side], crossSelection: null }, now);
    if (!base.available) continue;
    const swings = {};
    for (const length of [5, 10, 20, 50]) {
      const window = rows.slice(index - length, index);
      swings[length] = { low: Math.min(...window.map(row => Number(row[3]))), high: Math.max(...window.map(row => Number(row[2]))) };
    }
    events.set(index, { side, signalClose: base.candle.close, rawLevels: base.supportResistance,
      zones: selectZoneProtection(base.candle.close, side, sets, true),
      size: base.risk.sizeMultiplier, countertrend: base.countertrend,
      atr1m: atr(history['1m']), atr15m: atr(history['15m']), swings });
  }
  return { rows, events };
}

function candidateMethods() {
  const methods = [{ id: 'original-cross', family: 'original' }];
  for (const stopPct of [0.15, 0.25, 0.4, 0.6, 0.9, 1.2, 1.8]) {
    for (const targetPct of [0.2, 0.35, 0.5, 0.8, 1.2, 1.8, 2.5, 3]) {
      methods.push({ id: `fixed-${stopPct}-${targetPct}`, family: 'fixed', stopPct, targetPct });
    }
  }
  const rewards = [0.75, 1, 1.5, 2, 3];
  for (const timeframe of ['1m', '15m']) {
    for (const multiple of timeframe === '1m' ? [1, 2, 3, 4, 6] : [0.25, 0.5, 0.75, 1, 1.5]) {
      for (const reward of rewards) methods.push({ id: `atr-${timeframe}-${multiple}-${reward}`, family: 'atr', timeframe, multiple, reward });
    }
  }
  for (const length of [5, 10, 20, 50]) for (const buffer of [0, 0.25, 0.5, 1]) {
    for (const reward of rewards) methods.push({ id: `swing-${length}-${buffer}-${reward}`, family: 'swing', length, buffer, reward });
  }
  for (const family of ['cross', 'zones']) for (const buffer of [0, 0.25, 0.5, 1]) {
    for (const reward of [null, ...rewards]) methods.push({ id: `${family}-${buffer}-${reward ?? 'level'}`, family, buffer, reward });
  }
  return methods;
}

function exitPrices(event, entry, method, costs = {}) {
  if (event.countertrend && method.countertrendReward !== undefined) method = { ...method, reward: method.countertrendReward };
  const direction = event.side === 'LONG' ? 1 : -1;
  const fee = costs.feeRate ?? 0.0005;
  const slip = costs.slippageRate ?? 0.0002;
  let stop;
  let target;
  if (method.family === 'original') {
    const support = Number(event.rawLevels.support?.price);
    const resistance = Number(event.rawLevels.resistance?.price);
    if (!(support < event.signalClose && resistance > event.signalClose)) return null;
    stop = direction > 0 ? support : resistance;
    target = direction > 0 ? resistance : support;
  } else if (method.family === 'fixed') {
    stop = entry * (1 - direction * method.stopPct / 100);
    target = entry * (1 + direction * method.targetPct / 100);
  } else {
    let distance;
    if (method.family === 'atr') distance = (method.timeframe === '1m' ? event.atr1m : event.atr15m) * method.multiple;
    if (method.family === 'swing') {
      const level = direction > 0 ? event.swings[method.length].low : event.swings[method.length].high;
      distance = direction * (entry - level) + method.buffer * event.atr1m;
    }
    if (method.family === 'cross' || method.family === 'zones') {
      const levels = method.family === 'cross' ? event.rawLevels : event.zones;
      const level = Number(direction > 0 ? levels.support?.price : levels.resistance?.price);
      if (!(level > 0)) return null;
      distance = direction * (entry - level) + method.buffer * event.atr1m;
      if (method.reward === null) {
        target = Number(direction > 0 ? levels.resistance?.price : levels.support?.price) - direction * method.buffer * event.atr1m;
      }
    }
    if (!(distance > 0)) return null;
    // Research stop bounds constrain leverage risk; never widen beyond 1.8%.
    distance = Math.max(distance, entry * 0.0015);
    if (distance / entry > 0.018) return null;
    stop = entry - direction * distance;
    if (method.reward !== null) {
      const netRisk = distance + entry * (2 * fee + slip);
      const netReward = method.reward * netRisk;
      // Solve target after exit slippage and both fees for the requested net reward.
      target = (entry * (direction + fee) + netReward) / ((direction - fee) * (1 - direction * slip));
    }
  }
  if (!(stop > 0 && target > 0 && direction * (entry - stop) > 0 && direction * (target - entry) > 0)) return null;
  return { stop, target };
}

function simulateExitMethod(prepared, method, options) {
  const { start, end, feeRate = 0.0005, slippageRate = 0.0002, funding = [], recordTrades = false } = options;
  const positions = { LONG: null, SHORT: null };
  let realized = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let wins = 0;
  let count = 0;
  let profits = 0;
  let losses = 0;
  let fees = 0;
  let fundingTotal = 0;
  let fundingIndex = 0;
  const trades = [];
  function value(position, price) {
    const exit = price * (1 - position.direction * slippageRate);
    const commission = position.quantity * (position.entry + exit) * feeRate;
    return { net: position.direction * position.quantity * (exit - position.entry) - commission + position.funding,
      commission };
  }
  function close(side, price, timestamp, reason) {
    const position = positions[side];
    const result = value(position, price);
    realized += result.net;
    fees += result.commission;
    count++;
    if (result.net > 0) { wins++; profits += result.net; } else losses -= result.net;
    if (recordTrades) trades.push({ ...position, side, exitTimestamp: timestamp, rawExitPrice: price, reason, netPnl: result.net, fees: result.commission });
    positions[side] = null;
  }
  let lastClose = 0;
  for (let index = 0; index < prepared.rows.length; index++) {
    const row = prepared.rows[index];
    const timestamp = Number(row[0]);
    if (timestamp < start) continue;
    if (timestamp >= end) break;
    const open = Number(row[1]);
    lastClose = Number(row[4]);
    while (fundingIndex < funding.length && Math.floor(Number(funding[fundingIndex].fundingTime) / 60_000) * 60_000 <= timestamp) {
      const event = funding[fundingIndex++];
      const fundingMinute = Math.floor(Number(event.fundingTime) / 60_000) * 60_000;
      for (const position of Object.values(positions)) if (position && position.entryTimestamp < fundingMinute) {
        const payment = -position.direction * position.quantity * Number(event.markPrice || open) * Number(event.fundingRate);
        position.funding += payment;
        fundingTotal += payment;
      }
    }
    for (const side of ['LONG', 'SHORT']) {
      const position = positions[side];
      if (position && position.direction * (open - position.stop) <= 0) close(side, open, timestamp, 'STOP_LOSS_GAP');
    }
    const event = prepared.events.get(index);
    if (event && !positions[event.side]) {
      const direction = event.side === 'LONG' ? 1 : -1;
      const entry = open * (1 + direction * slippageRate);
      const levels = (options.priceSelector || exitPrices)(event, entry, method, { feeRate, slippageRate });
      if (levels) positions[event.side] = { ...levels, direction, entry, entryTimestamp: timestamp,
        initialRisk: direction * (entry - levels.stop), peak: entry,
        levelSources: levels.sources || (method.family === 'original' ? { support: event.rawLevels.support, resistance: event.rawLevels.resistance } : null),
        quantity: 100 * event.size / entry, countertrend: event.countertrend, funding: 0 };
    }
    for (const side of ['LONG', 'SHORT']) {
      const position = positions[side];
      if (!position) continue;
      const stop = position.direction > 0 ? Number(row[3]) <= position.stop : Number(row[2]) >= position.stop;
      const take = position.direction > 0 ? Number(row[2]) >= position.target : Number(row[3]) <= position.target;
      if (stop) close(side, position.stop, timestamp + 60_000, 'STOP_LOSS');
      else if (take) close(side, position.target, timestamp + 60_000, 'TAKE_PROFIT');
      else if (method.management) {
        const favorable = position.direction > 0 ? Number(row[2]) : Number(row[3]);
        position.peak = position.direction > 0 ? Math.max(position.peak, favorable) : Math.min(position.peak, favorable);
        const excursion = position.direction * (position.peak - position.entry) / position.initialRisk;
        let nextStop = position.stop;
        if (method.management.breakevenR !== undefined && excursion >= method.management.breakevenR) {
          const breakEven = (position.entry * (position.direction + feeRate) - position.funding / position.quantity) /
            ((position.direction - feeRate) * (1 - position.direction * slippageRate));
          nextStop = position.direction > 0 ? Math.max(nextStop, breakEven) : Math.min(nextStop, breakEven);
        }
        if (method.management.trailR !== undefined && excursion >= method.management.armR) {
          const trailing = position.peak - position.direction * position.initialRisk * method.management.trailR;
          nextStop = position.direction > 0 ? Math.max(nextStop, trailing) : Math.min(nextStop, trailing);
        }
        // Information from this candle changes the stop only for the next candle.
        position.stop = nextStop;
      }
    }
    const equity = realized + Object.values(positions).reduce((sum, position) => sum + (position ? value(position, lastClose).net : 0), 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const openPositions = Object.entries(positions).filter(([, position]) => position).map(([side, position]) => ({ ...position, side, estimatedNetPnl: value(position, lastClose).net }));
  const openNet = openPositions.reduce((sum, position) => sum + position.estimatedNetPnl, 0);
  return { netPnl: realized + openNet, realizedNetPnl: realized, openNetPnl: openNet, openPositions,
    trades: count, wins, winRate: count ? wins / count : 0, profitFactor: losses ? profits / losses : profits ? Infinity : 0,
    maxDrawdown, fees, funding: fundingTotal, averageWin: wins ? profits / wins : 0,
    averageLoss: count > wins ? -losses / (count - wins) : 0, tradeDetails: trades };
}

module.exports = { atr, prepareExitResearch, candidateMethods, exitPrices, simulateExitMethod };
