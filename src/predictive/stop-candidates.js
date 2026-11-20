'use strict';

const STOP_POLICY_ID = 'EXCURSION_Q25_Q50_Q75_STRUCTURE15_ATR14_V1';

function buildStopCandidates(forecast, estimates, candles, tickSize) {
  if (!(tickSize > 0) || !['UP', 'DOWN'].includes(forecast.direction)) throw new Error('Invalid stop candidate inputs');
  const long = forecast.direction === 'UP', reference = forecast.referencePrice;
  const recent = (candles || []).filter(c => c.closeTime <= forecast.candleCloseTime).slice(-16);
  if (recent.length < 16 || recent.at(-1).closeTime !== forecast.candleCloseTime ||
      recent.some((c, i) => ![c.open, c.high, c.low, c.close].every(Number.isFinite) ||
        (i && c.closeTime !== recent[i - 1].closeTime + 60000))) {
    throw new Error('Stop candidates require 16 contiguous closed candles');
  }
  const ranges = recent.slice(1).map((c, i) => Math.max(c.high - c.low,
    Math.abs(c.high - recent[i].close), Math.abs(c.low - recent[i].close)));
  const atr = ranges.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const minimumDistance = Math.max(2 * tickSize, atr * 0.5);
  const adverse = estimates[long ? 'down' : 'up'];
  const proposals = adverse.map((pct, i) => ({ stopId: ['Q25', 'Q50', 'Q75'][i],
    raw: reference * (1 - (long ? 1 : -1) * pct / 100) }));
  proposals.sort((a, b) => Number(b.stopId === 'Q50') - Number(a.stopId === 'Q50'));
  proposals.push({ stopId: 'STRUCTURE15', raw: long ?
    Math.min(...recent.slice(-15).map(c => c.low)) - atr * 0.25 :
    Math.max(...recent.slice(-15).map(c => c.high)) + atr * 0.25 });
  const seen = new Set();
  return proposals.map(({ stopId, raw }) => {
    const units = raw / tickSize;
    const stopLoss = Number(((long ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9)) * tickSize).toPrecision(14));
    const distance = (long ? 1 : -1) * (reference - stopLoss);
    const reason = !(stopLoss > 0) || distance < minimumDistance - tickSize * 1e-8 ?
      'STOP_INSIDE_NOISE_FLOOR' : seen.has(stopLoss) ? 'DUPLICATE_STOP' : null;
    if (!reason) seen.add(stopLoss);
    return { stopId, stopLoss, valid: !reason, reason, minimumDistance, atr14: atr };
  });
}

module.exports = { STOP_POLICY_ID, buildStopCandidates };
