'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCrossZones, selectZoneProtection } = require('../src/confirmed-cross-zones');
const { historicalProtection } = require('../src/ma-cross-strategy');

const duration = 900_000;
function candle(i, close, high = close + 1, low = close - 1) {
  return [i * duration, close, high, low, close, 10, (i + 1) * duration - 1];
}

test('retest is confirmed only after its candle closes, and a later breakout invalidates it', () => {
  const rows = [80, 120, 80].flatMap(value => Array(30).fill(value)).map((value, i) => candle(i, value));
  const initial = buildCrossZones(rows, '15m', rows.length * duration);
  assert.ok(initial.zones.length > 0);
  const next = candle(90, 80, 150, 79);
  const future = [...rows, next];
  assert.deepEqual(buildCrossZones(future, '15m', 90 * duration), initial);
  const reacted = buildCrossZones(future, '15m', 91 * duration);
  assert.ok(reacted.zones.some(zone => zone.resistanceReactions > 0));
  assert.ok(reacted.zones.every(zone => zone.resistanceConfirmedAt === null || zone.resistanceConfirmedAt < 91 * duration));
  future.push(candle(91, 200, 201, 79));
  const broken = buildCrossZones(future, '15m', 92 * duration);
  assert.ok(broken.zones.filter(zone => zone.upper < 200).every(zone => zone.resistanceReactions === 0));
});

function zone(lower, upper, timeframe = '15m', confirmed = true) {
  return { lower, upper, timeframe, supportReactions: confirmed ? 1 : 0, resistanceReactions: confirmed ? 1 : 0 };
}
test('TP stops before the nearest confirmed higher timeframe obstacle and SL sits outside 15m zone', () => {
  const sets = { '15m': { atr: 1, zones: [zone(94, 95), zone(105, 106)] },
    '1h': { atr: 2, zones: [zone(102, 103, '1h')] }, '4h': { atr: 4, zones: [] } };
  const long = selectZoneProtection(100, 'LONG', sets);
  assert.equal(long.support.price, 93.95);
  assert.equal(long.resistance.price, 101.9);
  assert.equal(long.resistance.timeframe, '1h');
  const short = selectZoneProtection(100, 'SHORT', sets);
  assert.equal(short.support.price, 95.05);
  assert.equal(short.resistance.price, 106.05);
  assert.equal(historicalProtection(100, 'LONG', long).valid, true);
});
test('unconfirmed levels are not substituted for missing confirmed levels', () => {
  const sets = { '15m': { atr: 1, zones: [zone(94, 95, '15m', false), zone(105, 106, '15m', false)] },
    '1h': { atr: 2, zones: [] }, '4h': { atr: 4, zones: [] } };
  assert.equal(selectZoneProtection(100, 'LONG', sets).support, null);
  assert.ok(selectZoneProtection(100, 'LONG', sets, false).support);
});
