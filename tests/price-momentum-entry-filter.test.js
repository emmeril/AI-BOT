const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PriceMomentumAnalyzer,
  analyzePriceMomentum,
  evaluatePriceMomentumEntry,
} = require('../src/price-momentum-entry-filter');

function candles(closes, step = 300_000) {
  return closes.map((close, index) => [index * step, close, close, close, close, 1]);
}

test('price momentum compares the latest close with the exact lookback close', () => {
  const result = analyzePriceMomentum(candles([100, 101, 102, 104]), { lookbackCandles: 3 });
  assert.equal(result.direction, 'BULLISH');
  assert.equal(result.returnRatio, 0.04);
});

test('price momentum mirrors LONG and SHORT ownership', () => {
  const bullish = { returnRatio: 0.02 };
  assert.equal(evaluatePriceMomentumEntry(bullish, 'LONG').allow, true);
  assert.equal(evaluatePriceMomentumEntry(bullish, 'SHORT').allow, false);
  const bearish = { returnRatio: -0.02 };
  assert.equal(evaluatePriceMomentumEntry(bearish, 'LONG').allow, false);
  assert.equal(evaluatePriceMomentumEntry(bearish, 'SHORT').allow, true);
});

test('price momentum fails closed when requested and unavailable', () => {
  assert.equal(evaluatePriceMomentumEntry(null, 'LONG', { failClosed: true }).allow, false);
  assert.equal(evaluatePriceMomentumEntry(null, 'LONG', { failClosed: false }).allow, true);
});

test('live analyzer ignores the open candle and caches the closed result', async () => {
  let calls = 0;
  const exchange = {
    fetchOHLCV: async () => {
      calls++;
      return candles([100, 101, 102, 80]);
    },
  };
  const analyzer = new PriceMomentumAnalyzer(exchange, {
    enabled: true,
    timeframe: '5m',
    lookbackCandles: 2,
    candleCloseBufferMs: 0,
  });
  const now = 3 * 300_000;
  const first = await analyzer.analyze('TEST/USDT:USDT', now);
  const second = await analyzer.analyze('TEST/USDT:USDT', now + 1000);
  assert.equal(first.returnRatio, 0.02);
  assert.strictEqual(second, first);
  assert.equal(calls, 1);
});
