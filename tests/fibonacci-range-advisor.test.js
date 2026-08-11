const test = require('node:test');
const assert = require('node:assert/strict');

const { FibonacciRangeAdvisor, timeframeToMs, ratioWeight } = require('../src/fibonacci-range-advisor');

test('Fibonacci timeframe parser supports Binance candle units', () => {
  assert.equal(timeframeToMs('1s'), 1000);
  assert.equal(timeframeToMs('15m'), 15 * 60 * 1000);
  assert.equal(timeframeToMs('4h'), 4 * 60 * 60 * 1000);
  assert.equal(timeframeToMs('1w'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(timeframeToMs('invalid'), 0);
});

test('golden ratios receive the strongest candidate weight', () => {
  assert.ok(ratioWeight(0.618) > ratioWeight(0.382));
  assert.ok(ratioWeight(1.618) > ratioWeight(1.272));
});

test('advisor ignores the still-open candle', async () => {
  const minute = 60 * 1000;
  const now = 10 * minute + 10_000;
  const exchange = {
    fetchOHLCV: async () => [
      [8 * minute, 90, 100, 89, 98, 1],
      [9 * minute, 98, 102, 97, 101, 1],
      [10 * minute, 101, 110, 100, 108, 1],
    ],
  };
  const advisor = new FibonacciRangeAdvisor(exchange, {
    enabled: true,
    candleCloseBufferMs: 5000,
  });

  const candle = await advisor.fetchLastClosedCandle('BTC/USDT', '1m', now);

  assert.equal(candle.timestamp, 9 * minute);
  assert.equal(candle.high, 102);
  assert.equal(candle.low, 97);
});

test('multi-timeframe confluence builds the requested fee-spaced SHIB grid', () => {
  const advisor = new FibonacciRangeAdvisor({
    priceToPrecision: (_symbol, price) => Number(price).toFixed(8),
  }, {
    enabled: true,
    levelCount: 21,
    minimumStepRatio: 1.0025025,
    minRangeWidthPct: 6,
    maxDistancePct: 25,
    clusterTolerancePct: 0.15,
  });
  const definitions = [
    ['1s', 0.0000122, 0.0000128],
    ['1m', 0.0000120, 0.0000132],
    ['3m', 0.0000118, 0.0000133],
    ['5m', 0.0000117, 0.0000135],
    ['15m', 0.0000115, 0.0000137],
    ['30m', 0.0000112, 0.0000139],
    ['1h', 0.0000110, 0.0000140],
    ['2h', 0.0000108, 0.0000143],
    ['4h', 0.0000102, 0.0000148],
    ['6h', 0.0000100, 0.0000150],
    ['8h', 0.0000098, 0.0000153],
    ['12h', 0.0000095, 0.0000156],
    ['1d', 0.0000090, 0.0000160],
    ['3d', 0.0000085, 0.0000170],
    ['1w', 0.0000080, 0.0000180],
  ];
  const candles = definitions.map(([timeframe, low, high]) => ({
    timeframe,
    low,
    high,
    open: low,
    close: high,
  }));

  const suggestion = advisor.buildSuggestion('SHIB/USDT', 0.0000125, candles);

  assert.ok(suggestion);
  assert.equal(suggestion.source, 'FIBONACCI');
  assert.equal(suggestion.levels.length, 21);
  assert.ok(suggestion.lower < 0.0000125);
  assert.ok(suggestion.upper > 0.0000125);
  assert.equal(suggestion.levels.filter(price => price < 0.0000125).length, 10);
  assert.equal(suggestion.levels.filter(price => price > 0.0000125).length, 11);
  assert.ok(suggestion.timeframeCount > 1);
  for (let index = 1; index < suggestion.levels.length; index++) {
    assert.ok(suggestion.levels[index] / suggestion.levels[index - 1] >= 1.0025025 - 1e-10);
  }
});

test('advisor rebuild guard honors cooldown and material level movement', () => {
  const advisor = new FibonacciRangeAdvisor({}, {
    rebuildCooldownMs: 15 * 60 * 1000,
    rebuildThresholdPct: 0.5,
  });
  const previous = { lower: 90, upper: 110, levels: [90, 95, 100, 105, 110] };
  const smallMove = { lower: 90.1, upper: 110.1, levels: [90.1, 95.1, 100.1, 105.1, 110.1] };
  const largeMove = { lower: 91, upper: 112, levels: [91, 97, 102, 107, 112] };
  const now = 60 * 60 * 1000;

  assert.equal(advisor.shouldAdoptSuggestion(previous, largeMove, 100, now - 5 * 60 * 1000, now), false);
  assert.equal(advisor.shouldAdoptSuggestion(previous, smallMove, 100, 0, now), false);
  assert.equal(advisor.shouldAdoptSuggestion(previous, largeMove, 100, 0, now), true);
  assert.equal(advisor.shouldAdoptSuggestion(previous, largeMove, 120, now - 1000, now), true);
});

test('advisor rebuild guard ignores a single noisy Fibonacci level', () => {
  const advisor = new FibonacciRangeAdvisor({}, {
    rebuildCooldownMs: 15 * 60 * 1000,
    rebuildThresholdPct: 0.5,
  });
  const previous = { lower: 90, upper: 110, levels: [90, 95, 100, 105, 110] };
  const singleLevelOutlier = { lower: 90, upper: 120, levels: [90, 95, 100, 105, 120] };
  const majorityMove = { lower: 90, upper: 112, levels: [90, 96, 101, 106, 112] };
  const now = 60 * 60 * 1000;

  assert.equal(advisor.shouldAdoptSuggestion(previous, singleLevelOutlier, 100, 0, now), false);
  assert.equal(advisor.shouldAdoptSuggestion(previous, majorityMove, 100, 0, now), true);
  assert.equal(advisor.shouldAdoptSuggestion(previous, singleLevelOutlier, 121, now - 1000, now), true);
});

test('all selects every timeframe advertised by the exchange', () => {
  const advisor = new FibonacciRangeAdvisor({
    timeframes: { '1m': '1m', '1h': '1h', '1d': '1d' },
  }, {
    timeframes: ['all'],
  });

  assert.deepEqual(advisor.resolveTimeframes(), ['1m', '1h', '1d']);
});
