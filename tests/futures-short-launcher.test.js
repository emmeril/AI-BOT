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
