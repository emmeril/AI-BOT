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

test('SHORT enables the validated volume-delta risk overlay', () => {
  const environment = buildShortEnvironment({});
  assert.equal(environment.VOLUME_DELTA_ENTRY_FILTER_ENABLED, 'true');
  assert.equal(environment.VOLUME_DELTA_ENTRY_FILTER_MODE, 'LIVE');
  assert.equal(environment.VOLUME_DELTA_TIMEFRAME, '5m');
  assert.equal(environment.VOLUME_DELTA_LOOKBACK_CANDLES, '12');
  assert.equal(environment.VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT, '2.5');
  assert.equal(environment.VOLUME_DELTA_FAIL_CLOSED, 'false');
});
