const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FibonacciDirectionAnalyzer,
  analyzeTimeframe,
  aggregateTimeframes,
} = require('../src/fibonacci-direction-analyzer');
const { FibonacciRangeAdvisor } = require('../src/fibonacci-range-advisor');

function trendingCandles(direction = 1, count = 100, timeframeMs = 60_000) {
  return Array.from({ length: count }, (_, index) => {
    const trend = direction * index * 0.35;
    const wave = Math.sin(index * Math.PI / 5) * 2;
    const close = 100 + trend + wave;
    const open = close - direction * 0.15;
    return [index * timeframeMs, open, Math.max(open, close) + 0.8, Math.min(open, close) - 0.8, close, 1000];
  });
}

test('deterministic analyzer classifies higher-high/higher-low trend as bullish', () => {
  const result = analyzeTimeframe(trendingCandles(1), '1h');

  assert.ok(result);
  assert.equal(result.direction, 'BULLISH');
  assert.ok(result.score >= 2);
  assert.ok(result.reasons.includes('HH_HL'));
});

test('deterministic analyzer classifies lower-high/lower-low trend as bearish', () => {
  const result = analyzeTimeframe(trendingCandles(-1), '1h');

  assert.ok(result);
  assert.equal(result.direction, 'BEARISH');
  assert.ok(result.score <= -2);
  assert.ok(result.reasons.includes('LH_LL'));
});

test('higher timeframes receive more weight in aggregate direction', () => {
  const aggregate = aggregateTimeframes([
    { timeframe: '15m', direction: 'BEARISH', score: -3 },
    { timeframe: '1h', direction: 'BULLISH', score: 3 },
    { timeframe: '4h', direction: 'BULLISH', score: 3 },
  ]);

  assert.equal(aggregate.direction, 'BULLISH');
  assert.ok(aggregate.score > 0.25);
  assert.ok(aggregate.confidence >= 0.65);
});

test('analyzer caches each timeframe until another candle closes', async () => {
  const minute = 60_000;
  const candles = trendingCandles(1, 101, minute);
  let calls = 0;
  const exchange = {
    timeframes: { '1m': '1m' },
    fetchOHLCV: async () => {
      calls++;
      return candles;
    },
  };
  const analyzer = new FibonacciDirectionAnalyzer(exchange, {
    enabled: true,
    timeframes: ['1m'],
    minimumTimeframes: 1,
    candleCloseBufferMs: 0,
  });
  const now = 101 * minute;

  const first = await analyzer.getAnalysis('BTC/USDT:USDT', now);
  const second = await analyzer.getAnalysis('BTC/USDT:USDT', now + 30_000);

  assert.ok(first);
  assert.strictEqual(second, first);
  assert.equal(calls, 1);
});

test('direction bias requires consecutive closed-candle confirmations', async () => {
  const minute = 60_000;
  let candleCount = 101;
  const exchange = {
    timeframes: { '1m': '1m' },
    fetchOHLCV: async () => trendingCandles(1, candleCount, minute),
  };
  const analyzer = new FibonacciDirectionAnalyzer(exchange, {
    enabled: true,
    timeframes: ['1m'],
    minimumTimeframes: 1,
    confirmations: 2,
    candleCloseBufferMs: 0,
  });

  const first = await analyzer.getAnalysis('BTC/USDT:USDT', 101 * minute);
  candleCount = 102;
  const second = await analyzer.getAnalysis('BTC/USDT:USDT', 102 * minute);

  assert.equal(first.direction, 'BULLISH');
  assert.equal(first.confirmedDirection, 'RANGING');
  assert.equal(first.confirmationCount, 1);
  assert.equal(second.direction, 'BULLISH');
  assert.equal(second.confirmedDirection, 'BULLISH');
  assert.equal(second.confirmationCount, 2);
});

test('bullish direction keeps Fibonacci prices and allocates more levels above current price', () => {
  const advisor = new FibonacciRangeAdvisor({
    priceToPrecision: (_symbol, price) => Number(price).toFixed(8),
  }, {
    enabled: true,
    levelCount: 21,
    minimumStepRatio: 1.0025025,
    minRangeWidthPct: 6,
    maxDistancePct: 25,
    clusterTolerancePct: 0.15,
    directionLevelBiasPct: 10,
  });
  const definitions = [
    ['1m', 90, 110], ['3m', 89, 111], ['5m', 88, 112], ['15m', 87, 113],
    ['30m', 86, 114], ['1h', 85, 115], ['2h', 84, 116], ['4h', 83, 117],
    ['6h', 82, 118], ['8h', 81, 119], ['12h', 80, 120], ['1d', 79, 121],
    ['3d', 78, 122], ['1w', 77, 123],
  ];
  const candles = definitions.map(([timeframe, low, high]) => ({
    timeframe,
    timestamp: 0,
    low,
    high,
    open: low,
    close: high,
  }));

  const suggestion = advisor.buildSuggestion('BTC/USDT:USDT', 100, candles, { direction: 'BULLISH' });

  assert.ok(suggestion);
  assert.equal(suggestion.direction, 'BULLISH');
  assert.equal(suggestion.levelDistribution.support, 8);
  assert.equal(suggestion.levelDistribution.resistance, 13);
  assert.equal(suggestion.levels.filter(price => price < 100).length, 8);
  assert.equal(suggestion.levels.filter(price => price > 100).length, 13);
});
