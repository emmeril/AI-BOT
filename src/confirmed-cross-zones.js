'use strict';

const { historicalCrossLevels, evaluateMaCross, historicalProtection } = require('./ma-cross-strategy');

const ZONE_RULES = Object.freeze({ atrPeriod: 14, halfWidthAtr: 0.1, bufferAtr: 0.05, minimumReactions: 1 });

function buildCrossZones(rawRows, timeframe, beforeTimestamp, rules = ZONE_RULES) {
  const rows = rawRows.filter(row => Number(row[6]) < beforeTimestamp);
  if (rows.length < Math.max(26, rules.atrPeriod + 1)) return { zones: [], atr: 0 };
  const ranges = rows.slice(-rules.atrPeriod).map((row, index) => {
    const previous = rows[rows.length - rules.atrPeriod + index - 1];
    return Math.max(Number(row[2]) - Number(row[3]), Math.abs(Number(row[2]) - Number(previous[4])),
      Math.abs(Number(row[3]) - Number(previous[4])));
  });
  const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  if (!(atr > 0)) return { zones: [], atr: 0 };
  const width = atr * rules.halfWidthAtr;
  const crosses = historicalCrossLevels(rows, timeframe, beforeTimestamp).sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const cross of crosses) {
    const last = clusters.at(-1);
    if (last && cross.price - last[0].price <= 2 * width) last.push(cross);
    else clusters.push([cross]);
  }
  const zones = clusters.map(cluster => {
    const lower = cluster[0].price - width;
    const upper = cluster.at(-1).price + width;
    const createdAt = Math.max(...cluster.map(cross => cross.timestamp));
    let supportReactions = 0;
    let resistanceReactions = 0;
    let supportConfirmedAt = null;
    let resistanceConfirmedAt = null;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (Number(row[0]) <= createdAt) continue;
      const close = Number(row[4]);
      const previousClose = Number(rows[i - 1][4]);
      const touched = Number(row[3]) <= upper && Number(row[2]) >= lower;
      if (close < lower) { supportReactions = 0; supportConfirmedAt = null; }
      if (close > upper) { resistanceReactions = 0; resistanceConfirmedAt = null; }
      if (touched && previousClose > upper && close > upper) {
        supportReactions++;
        supportConfirmedAt = Number(row[6]);
      }
      if (touched && previousClose < lower && close < lower) {
        resistanceReactions++;
        resistanceConfirmedAt = Number(row[6]);
      }
    }
    return { lower, upper, createdAt, timeframe, crossCount: cluster.length,
      supportReactions, resistanceReactions, supportConfirmedAt, resistanceConfirmedAt };
  });
  return { zones, atr };
}

function selectZoneProtection(entry, side, sets, requireConfirmation = true, rules = ZONE_RULES) {
  const eligibleSupport = zone => zone.upper < entry && (!requireConfirmation || zone.supportReactions >= rules.minimumReactions);
  const eligibleResistance = zone => zone.lower > entry && (!requireConfirmation || zone.resistanceReactions >= rules.minimumReactions);
  const supports15 = sets['15m'].zones.filter(eligibleSupport).sort((a, b) => b.upper - a.upper);
  const resistances15 = sets['15m'].zones.filter(eligibleResistance).sort((a, b) => a.lower - b.lower);
  const allZones = Object.values(sets).flatMap(set => set.zones);
  const targetSupports = allZones.filter(eligibleSupport).sort((a, b) => b.upper - a.upper);
  const targetResistances = allZones.filter(eligibleResistance).sort((a, b) => a.lower - b.lower);
  const supportZone = side === 'LONG' ? supports15[0] : targetSupports[0];
  const resistanceZone = side === 'LONG' ? targetResistances[0] : resistances15[0];
  if (!supportZone || !resistanceZone) return { support: null, resistance: null, source: 'CROSS_ZONES' };
  const supportBuffer = sets[supportZone.timeframe].atr * rules.bufferAtr;
  const resistanceBuffer = sets[resistanceZone.timeframe].atr * rules.bufferAtr;
  return {
    source: 'CROSS_ZONES',
    support: { price: side === 'LONG' ? supportZone.lower - supportBuffer : supportZone.upper + supportBuffer, ...supportZone },
    resistance: { price: side === 'LONG' ? resistanceZone.lower - resistanceBuffer : resistanceZone.upper + resistanceBuffer, ...resistanceZone },
  };
}

function createZoneEvaluator({ confirmed = true, costFilter = false } = {}) {
  const cache = {};
  return function evaluate(history, side, strategy, now) {
    const base = evaluateMaCross(history, side, strategy, now);
    if (!base.available) return base;
    const sets = {};
    for (const timeframe of ['15m', '1h', '4h']) {
      const key = `${history[timeframe][0]?.[0]}:${history[timeframe].at(-1)?.[0]}`;
      if (cache[timeframe]?.key !== key) cache[timeframe] = { key,
        value: buildCrossZones(history[timeframe], timeframe, now) };
      sets[timeframe] = cache[timeframe].value;
    }
    const supportResistance = selectZoneProtection(base.candle.close, side, sets, confirmed);
    const protection = historicalProtection(base.candle.close, side, supportResistance, strategy);
    const indicator = base.indicator;
    const cross = side === 'LONG'
      ? indicator.previousMa7 <= indicator.previousMa25 && indicator.ma7 > indicator.ma25
      : indicator.previousMa7 >= indicator.previousMa25 && indicator.ma7 < indicator.ma25;
    const valid = protection.valid && (!costFilter || protection.estimatedNetReturn > 0);
    return { ...base, supportResistance, allow: cross && valid,
      risk: { ...base.risk, ...protection, valid, requirePositiveNetTarget: costFilter },
      reason: valid ? 'Experimental cross-zone target' : 'Missing zone or insufficient target after costs' };
  };
}

module.exports = { ZONE_RULES, buildCrossZones, selectZoneProtection, createZoneEvaluator };
