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

test('SHORT entry grid can be switched to exit-only independently', () => {
  const active = buildShortEnvironment({});
  assert.equal(active.FUTURES_ENTRY_ENABLED, 'true');

  const exitOnly = buildShortEnvironment({ SHORT_FUTURES_ENTRY_ENABLED: 'false' });
  assert.equal(exitOnly.FUTURES_ENTRY_ENABLED, 'false');
});

test('SHORT dynamic exposure accepts a side-specific allocation', () => {
  const inherited = buildShortEnvironment({
    FUTURES_DYNAMIC_EXPOSURE_ENABLED: 'true',
    FUTURES_DYNAMIC_EXPOSURE_SIDE_PCT: '35',
  });
  assert.equal(inherited.FUTURES_DYNAMIC_EXPOSURE_ENABLED, 'true');
  assert.equal(inherited.FUTURES_DYNAMIC_EXPOSURE_SIDE_PCT, '35');

  const overridden = buildShortEnvironment({
    FUTURES_DYNAMIC_EXPOSURE_ENABLED: 'true',
    FUTURES_DYNAMIC_EXPOSURE_SIDE_PCT: '35',
    SHORT_FUTURES_DYNAMIC_EXPOSURE_SIDE_PCT: '10',
  });
  assert.equal(overridden.FUTURES_DYNAMIC_EXPOSURE_ENABLED, 'true');
  assert.equal(overridden.FUTURES_DYNAMIC_EXPOSURE_SIDE_PCT, '10');
});

test('SHORT automatic ramp accepts side-specific controls', () => {
  const environment = buildShortEnvironment({
    SHORT_FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_ENABLED: 'true',
    SHORT_FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_START_PCT: '10',
    SHORT_FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_STEP_PCT: '5',
    SHORT_FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_RESERVED_MARGIN_PCT: '30',
    SHORT_FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_CONFIRMATIONS: '3',
  });
  assert.equal(environment.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_ENABLED, 'true');
  assert.equal(environment.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_START_PCT, '10');
  assert.equal(environment.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_STEP_PCT, '5');
  assert.equal(environment.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_RESERVED_MARGIN_PCT, '30');
  assert.equal(environment.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_CONFIRMATIONS, '3');
});

test('SHORT inherits reversal inventory controls and accepts side-specific overrides', () => {
  const inherited = buildShortEnvironment({
    REVERSAL_INVENTORY_ENABLED: 'true',
    REVERSAL_STALE_HOURS: '24',
  });
  assert.equal(inherited.REVERSAL_INVENTORY_ENABLED, 'true');
  assert.equal(inherited.REVERSAL_STALE_HOURS, '24');

  const overridden = buildShortEnvironment({
    REVERSAL_INVENTORY_ENABLED: 'true',
    REVERSAL_STALE_HOURS: '24',
    SHORT_REVERSAL_INVENTORY_ENABLED: 'false',
    SHORT_REVERSAL_STALE_HOURS: '36',
  });
  assert.equal(overridden.REVERSAL_INVENTORY_ENABLED, 'false');
  assert.equal(overridden.REVERSAL_STALE_HOURS, '36');
});
