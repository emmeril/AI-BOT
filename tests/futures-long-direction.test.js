process.env.FUTURES_POSITION_SIDE = 'LONG';
process.env.FUTURES_LONG_ENTRY_DIRECTION = 'BULLISH';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FuturesGridEngine } = require('../futures-grid');

const symbol = 'TEST/USDT:USDT';

test('LONG entry requires the applied Fibonacci direction to be BULLISH', () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.appliedFibonacciDirections = new Map([[symbol, 'BULLISH']]);

  assert.equal(engine.isEntrySidePreferred(symbol), true);

  engine.appliedFibonacciDirections.set(symbol, 'BEARISH');
  assert.equal(engine.isEntrySidePreferred(symbol), false);

  engine.appliedFibonacciDirections.set(symbol, 'RANGING');
  assert.equal(engine.isEntrySidePreferred(symbol), false);
});
