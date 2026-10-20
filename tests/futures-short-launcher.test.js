const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SYMBOLS, buildShortEnvironment } = require('../scripts/start-futures-short');

test('SHORT worker inherits the shared symbol universe by default', () => {
  const symbols = 'AAA/USDT:USDT,BBB/USDT:USDT';
  const environment = buildShortEnvironment({ SYMBOLS: symbols });
  assert.equal(environment.SYMBOLS, symbols);
  assert.equal(environment.FUTURES_POSITION_SIDE, 'SHORT');
});

test('SHORT_SYMBOLS can explicitly override the shared symbol universe', () => {
  const environment = buildShortEnvironment({
    SYMBOLS: 'AAA/USDT:USDT',
    SHORT_SYMBOLS: 'BBB/USDT:USDT',
  });
  assert.equal(environment.SYMBOLS, 'BBB/USDT:USDT');
});

test('standalone SHORT defaults include every live mutual symbol', () => {
  const environment = buildShortEnvironment({});
  assert.equal(environment.SYMBOLS, DEFAULT_SYMBOLS);
  assert.match(environment.SYMBOLS, /JUP\/USDT:USDT/);
});

test('SHORT sends Telegram alerts without competing for command processing', () => {
  const environment = buildShortEnvironment({});
  assert.equal(environment.TELEGRAM_ENABLED, 'true');
  assert.equal(environment.FUTURES_TELEGRAM_COMMAND_PROCESSING_ENABLED, 'false');
});

test('SHORT uses the validated price-momentum ownership gate', () => {
  const environment = buildShortEnvironment({});
  assert.equal(environment.FUTURES_SHORT_ENTRY_DIRECTION, 'ALWAYS');
  assert.equal(environment.VOLUME_DELTA_ENTRY_FILTER_ENABLED, 'false');
  assert.equal(environment.EMA_TREND_ENTRY_FILTER_ENABLED, 'false');
  assert.equal(environment.EMA_TREND_ENTRY_FILTER_MODE, 'LIVE');
  assert.equal(environment.EMA_TREND_ENTRY_TIMEFRAME, '5m');
  assert.equal(environment.EMA_TREND_ENTRY_FAIL_CLOSED, 'true');
  assert.equal(environment.PRICE_MOMENTUM_ENTRY_FILTER_ENABLED, 'true');
  assert.equal(environment.PRICE_MOMENTUM_ENTRY_FILTER_MODE, 'LIVE');
  assert.equal(environment.PRICE_MOMENTUM_TIMEFRAME, '5m');
  assert.equal(environment.PRICE_MOMENTUM_LOOKBACK_CANDLES, '144');
  assert.equal(environment.PRICE_MOMENTUM_DEADBAND_PCT, '0');
  assert.equal(environment.PRICE_MOMENTUM_FAIL_CLOSED, 'true');
});

test('SHORT keeps the nearest profitable Fibonacci exit target', () => {
  const env = buildShortEnvironment({ GRID_EXIT_TARGET_LEVEL_OFFSET: '1' });
  assert.equal(env.GRID_EXIT_TARGET_LEVEL_OFFSET, '0');

  const overridden = buildShortEnvironment({
    GRID_EXIT_TARGET_LEVEL_OFFSET: '1',
    SHORT_GRID_EXIT_TARGET_LEVEL_OFFSET: '2',
  });
  assert.equal(overridden.GRID_EXIT_TARGET_LEVEL_OFFSET, '2');
});
