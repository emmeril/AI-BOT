const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VolumeDeltaAnalyzer,
  analyzeVolumeDelta,
  evaluateVolumeDeltaEntry,
  normalizeRawKline,
} = require('../src/volume-delta-analyzer');

function kline(timestamp, volume, takerBuyVolume) {
  return [timestamp, '100', '102', '99', '101', String(volume), timestamp + 899_999, '0', 10, String(takerBuyVolume), '0', '0'];
}

test('normalizes Binance raw kline taker volume fields', () => {
  const candle = normalizeRawKline(kline(0, 100, 60));
  assert.equal(candle.volume, 100);
  assert.equal(candle.takerBuyVolume, 60);
  assert.equal(candle.closeTime, 899_999);
});

test('volume delta uses rolling taker buy minus taker sell volume', () => {
  const analysis = analyzeVolumeDelta([
    kline(0, 100, 60),
    kline(900_000, 200, 80),
  ], { lookbackCandles: 2 });
  assert.equal(analysis.takerBuyVolume, 140);
  assert.equal(analysis.takerSellVolume, 160);
  assert.equal(analysis.delta, -20);
  assert.equal(analysis.deltaRatio, -0.066667);
});

test('entry decision mirrors opposition guard for LONG and SHORT', () => {
  const analysis = { deltaRatio: -0.08 };
  assert.equal(evaluateVolumeDeltaEntry(analysis, 'LONG', { oppositionThresholdPct: 5 }).allow, false);
  assert.equal(evaluateVolumeDeltaEntry(analysis, 'SHORT', { oppositionThresholdPct: 5 }).allow, true);
  assert.equal(evaluateVolumeDeltaEntry(analysis, 'LONG', { oppositionThresholdPct: 10 }).allow, true);
});

test('live analyzer ignores the still-open candle and caches a closed result', async () => {
  let calls = 0;
  const rows = [kline(0, 100, 60), kline(900_000, 100, 40), kline(1_800_000, 100, 90)];
  const exchange = {
    market: () => ({ id: 'TESTUSDT' }),
    fapiPublicGetKlines: async () => { calls++; return rows; },
  };
  const analyzer = new VolumeDeltaAnalyzer(exchange, {
    enabled: true,
    lookbackCandles: 2,
    candleCloseBufferMs: 0,
  });
  const first = await analyzer.analyze('TEST/USDT:USDT', 1_800_000);
  const second = await analyzer.analyze('TEST/USDT:USDT', 1_800_100);
  assert.equal(first.deltaRatio, 0);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});
