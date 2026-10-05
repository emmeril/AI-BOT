const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyConfirmation,
  directionForVariant,
  resampleCandles,
} = require('../scripts/backtest-fibonacci-direction');

test('backtest resampling only emits complete higher-timeframe candles', () => {
  const minute = 60_000;
  const rows = Array.from({ length: 5 }, (_, index) => [
    index * 15 * minute,
    100 + index,
    102 + index,
    99 + index,
    101 + index,
    10,
  ]);

  const resampled = resampleCandles(rows, 60 * minute);

  assert.deepEqual(resampled, [[0, 100, 105, 99, 104, 40]]);
});

test('backtest confirmation requires two consecutive directional readings', () => {
  const state = { candidate: 'RANGING', count: 0 };
  const aggregate = { direction: 'BULLISH' };

  assert.equal(applyConfirmation(aggregate, state), 'RANGING');
  assert.equal(applyConfirmation(aggregate, state), 'BULLISH');
  assert.equal(applyConfirmation({ direction: 'RANGING' }, state), 'RANGING');
  assert.equal(state.count, 0);
});

test('0.60 alignment rejects lower-timeframe agreement without 4h', () => {
  const aggregate = {
    confidence: 0.8,
    alignment: 4 / 9,
    timeframes: {
      '15m': { direction: 'BULLISH' },
      '1h': { direction: 'BULLISH' },
      '4h': { direction: 'RANGING' },
    },
  };

  assert.equal(
    directionForVariant({ minimumAlignment: 0.6 }, aggregate, 'BULLISH'),
    'RANGING'
  );
});

test('explicit consensus requires 4h and one lower timeframe', () => {
  const aggregate = {
    confidence: 0.8,
    alignment: 6 / 9,
    timeframes: {
      '15m': { direction: 'BULLISH' },
      '1h': { direction: 'RANGING' },
      '4h': { direction: 'BULLISH' },
    },
  };

  assert.equal(directionForVariant({ consensus: true }, aggregate, 'BULLISH'), 'BULLISH');
  aggregate.timeframes['4h'].direction = 'RANGING';
  assert.equal(directionForVariant({ consensus: true }, aggregate, 'BULLISH'), 'RANGING');
});
