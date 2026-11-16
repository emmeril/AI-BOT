'use strict';
const { aggregateCandles } = require('./ma-cross-backtester');
const { TIMEFRAMES, maSnapshot, historicalCrossLevels, evaluateMaCross } = require('./ma-cross-strategy');
const { annotateCrossRetests, selectHistoricalCrossPrices } = require('./historical-cross-selector');

function crossFacts(rawRows, timeframe, cutoff, asOf = cutoff) {
  const rows = rawRows.filter(row => Number(row[6]) < asOf);
  return annotateCrossRetests(rows, historicalCrossLevels(rows, timeframe, cutoff));
}

function preparePureCrossHistory(rows, config) {
  for (let i = 0; i < rows.length; i++) {
    if (Number(rows[i][6]) !== Number(rows[i][0]) + 59_999 ||
      (i && Number(rows[i][0]) - Number(rows[i - 1][0]) !== 60_000)) throw new Error('Missing or invalid 1m candle');
  }
  const higher = Object.fromEntries(['15m', '1h', '4h'].map(tf => [tf, aggregateCandles(rows, TIMEFRAMES[tf])]));
  const pointers = { '15m': 0, '1h': 0, '4h': 0 };
  const cache = {};
  const events = new Map();
  for (let index = 100; index < rows.length; index++) {
    const indicator = maSnapshot(rows.slice(index - 100, index));
    const up = indicator.previousMa7 <= indicator.previousMa25 && indicator.ma7 > indicator.ma25;
    const down = indicator.previousMa7 >= indicator.previousMa25 && indicator.ma7 < indicator.ma25;
    if (!up && !down) continue;
    const now = Number(rows[index][0]);
    const history = { '1m': rows.slice(Math.max(0, index - 500), index) };
    for (const tf of Object.keys(pointers)) {
      while (pointers[tf] < higher[tf].length && Number(higher[tf][pointers[tf]][6]) < now) pointers[tf]++;
      history[tf] = higher[tf].slice(Math.max(0, pointers[tf] - 500), pointers[tf]);
    }
    const side = up ? 'LONG' : 'SHORT';
    const base = evaluateMaCross(history, side, { ...config.strategies[side], crossSelection: null }, now);
    if (!base.available) continue;
    const levels = [];
    for (const tf of Object.keys(TIMEFRAMES)) {
      const key = `${history[tf][0]?.[0]}:${history[tf].at(-1)?.[0]}`;
      if (cache[tf]?.key !== key) cache[tf] = { key, levels: crossFacts(history[tf], tf, base.candleTimestamp, now) };
      levels.push(...cache[tf].levels);
    }
    const entryWindow = rows.slice(index - 5, index);
    events.set(index, { side, signalClose: base.candle.close, size: base.risk.sizeMultiplier,
      countertrend: base.countertrend, rawLevels: base.supportResistance, levels,
      entryRange5: { low: Math.min(...entryWindow.map(row => Number(row[3]))),
        high: Math.max(...entryWindow.map(row => Number(row[2]))),
        startTimestamp: Number(entryWindow[0][0]), endTimestamp: Number(entryWindow.at(-1)[6]) } });
  }
  return { rows, events };
}

function pureCrossCandidates() {
  const methods = [];
  for (const priority of ['all', '15mFirst', 'higherFirst']) for (const rank of ['distance', 'recent', 'retests']) {
    for (const minimumRetests of [0, 1, 2]) for (const targetIndex of [0, 1, 2, 4]) for (const stopIndex of [0, 1, 2]) {
      for (const requireNetTarget of [false, true]) methods.push({ priority, rank, minimumRetests, targetIndex, stopIndex, requireNetTarget,
        id: [priority, rank, minimumRetests, targetIndex, stopIndex, requireNetTarget ? 'costs' : 'raw'].join('-') });
    }
  }
  return methods;
}

function mirrorTargetCandidates() {
  const methods = [];
  for (const priority of ['all', '15mFirst', 'higherFirst']) for (const rank of ['distance', 'recent', 'retests']) {
    for (const minimumRetests of [0, 1, 2]) for (const targetIndex of [0, 1, 2, 4]) for (const requireNetTarget of [false, true]) {
      methods.push({ priority, rank, minimumRetests, targetIndex, requireNetTarget, stopMode: 'MIRROR_TARGET',
        id: [priority, rank, minimumRetests, targetIndex, requireNetTarget ? 'costs' : 'raw', 'rr1'].join('-') });
    }
  }
  return methods;
}

function selectPureCrossPrices(event, entry, method, costs = {}) {
  if (method.stopMode !== 'MIRROR_TARGET' && method.stopMode !== 'FIVE_CANDLE') {
    return selectHistoricalCrossPrices(event, entry, method, costs);
  }
  const direction = event.side === 'LONG' ? 1 : -1;
  const fee = costs.feeRate ?? 0.0005;
  const slip = costs.slippageRate ?? 0.0002;
  const priorities = method.priority === '15mFirst' ? ['15m', '1h', '4h', '1m'] : ['4h', '1h', '15m', '1m'];
  function compare(a, b, role) {
    if (method.priority !== 'all') {
      const order = priorities.indexOf(a.timeframe) - priorities.indexOf(b.timeframe);
      if (order) return order;
    }
    if (method.rank === 'recent' && a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    if (method.rank === 'retests') {
      const count = b[role] - a[role];
      if (count) return count;
    }
    return Math.abs(a.price - entry) - Math.abs(b.price - entry) || b.timestamp - a.timestamp;
  }
  const targetRole = direction > 0 ? 'resistanceRetests' : 'supportRetests';
  const stopRole = direction > 0 ? 'supportRetests' : 'resistanceRetests';
  const targetCandidates = event.levels.filter(level => direction * (level.price - entry) > 0 &&
    level[targetRole] >= method.minimumRetests && (!method.requireNetTarget ||
      direction * (level.price * (1 - direction * slip) - entry) - (entry + level.price * (1 - direction * slip)) * fee > 0))
    .sort((a, b) => compare(a, b, targetRole));
  const stopCandidates = event.levels.filter(level => direction * (entry - level.price) > 0 &&
    level[stopRole] >= method.minimumRetests &&
    (method.maximumStopDistance === undefined || Math.abs(level.price - entry) / entry <= method.maximumStopDistance))
    .sort((a, b) => compare(a, b, stopRole));
  const target = targetCandidates[method.targetIndex];
  if (method.stopMode === 'FIVE_CANDLE') {
    const range = event.entryRange5;
    const tick = Number(method.tickSize);
    if (!target || !range || !(tick > 0)) return null;
    const stop = direction > 0 ? (Math.floor(range.low / tick + 1e-8) - 1) * tick
      : (Math.ceil(range.high / tick - 1e-8) + 1) * tick;
    if (!(stop > 0 && direction * (entry - stop) > 0)) return null;
    const targetFill = target.price * (1 - direction * slip);
    const stopFill = stop * (1 - direction * slip);
    const reward = direction * (targetFill - entry) - (entry + targetFill) * fee;
    const risk = -direction * (stopFill - entry) + (entry + stopFill) * fee;
    const netRewardRisk = reward / risk;
    if (method.minimumNetRewardRisk !== undefined && !(risk > 0 && netRewardRisk >= method.minimumNetRewardRisk)) return null;
    return { stop, target: target.price, netRewardRisk,
      sources: { target, stop: { kind: 'FIVE_CANDLE', price: stop, tickSize: tick, ...range } } };
  }
  if (method.stopMode === 'MIRROR_TARGET') {
    if (!target) return null;
    const stop = 2 * entry - target.price;
    if (!(stop > 0 && direction * (entry - stop) > 0)) return null;
    return { stop, target: target.price, sources: { target, stop: { kind: 'MIRROR_TARGET', price: stop } } };
  }
  const stop = stopCandidates[method.stopIndex];
  if (!target || !stop) return null;
  return { stop: stop.price, target: target.price,
    sources: { target, stop } };
}

module.exports = { crossFacts, preparePureCrossHistory, pureCrossCandidates, mirrorTargetCandidates, selectPureCrossPrices };
