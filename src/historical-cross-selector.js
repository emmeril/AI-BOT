'use strict';

function annotateCrossRetests(rows, levels) {
  return levels.map(level => {
    let supportRetests = 0;
    let resistanceRetests = 0;
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index];
      if (Number(row[0]) <= level.timestamp) continue;
      const close = Number(row[4]);
      const previous = Number(rows[index - 1][4]);
      const touched = Number(row[3]) <= level.price && Number(row[2]) >= level.price;
      if (close < level.price) supportRetests = 0;
      if (close > level.price) resistanceRetests = 0;
      if (touched && previous > level.price && close > level.price) supportRetests++;
      if (touched && previous < level.price && close < level.price) resistanceRetests++;
    }
    return { ...level, supportRetests, resistanceRetests };
  });
}

function selectHistoricalCrossPrices(event, entry, method, costs = {}) {
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
    if (method.rank === 'retests' && a[role] !== b[role]) return b[role] - a[role];
    return Math.abs(a.price - entry) - Math.abs(b.price - entry) || b.timestamp - a.timestamp;
  }
  const targetRole = direction > 0 ? 'resistanceRetests' : 'supportRetests';
  const stopRole = direction > 0 ? 'supportRetests' : 'resistanceRetests';
  const targets = event.levels.filter(level => direction * (level.price - entry) > 0 &&
    level[targetRole] >= method.minimumRetests && (!method.requireNetTarget ||
      direction * (level.price * (1 - direction * slip) - entry) - (entry + level.price * (1 - direction * slip)) * fee > 0))
    .sort((a, b) => compare(a, b, targetRole));
  const stops = event.levels.filter(level => direction * (entry - level.price) > 0 &&
    level[stopRole] >= method.minimumRetests &&
    (method.maximumStopDistance === undefined || Math.abs(level.price - entry) / entry <= method.maximumStopDistance))
    .sort((a, b) => compare(a, b, stopRole));
  const target = targets[method.targetIndex];
  const stop = stops[method.stopIndex];
  if (!target || !stop) return null;
  return { stop: stop.price, target: target.price, sources: { target, stop } };
}

module.exports = { annotateCrossRetests, selectHistoricalCrossPrices };
