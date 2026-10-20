const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateEmaTrendEntry } = require('../src/ema-trend-entry-filter');

function analysis(ema20, ema50) {
  return { timeframes: { '5m': { ema20, ema50 } } };
}

test('EMA trend aligns LONG with EMA20 above EMA50', () => {
  assert.equal(evaluateEmaTrendEntry(analysis(105, 100), 'LONG').allow, true);
  assert.equal(evaluateEmaTrendEntry(analysis(95, 100), 'LONG').allow, false);
});

test('EMA trend aligns SHORT with EMA20 below EMA50', () => {
  assert.equal(evaluateEmaTrendEntry(analysis(95, 100), 'SHORT').allow, true);
  assert.equal(evaluateEmaTrendEntry(analysis(105, 100), 'SHORT').allow, false);
});

test('EMA trend fails closed when the timeframe analysis is unavailable', () => {
  const closed = evaluateEmaTrendEntry(null, 'LONG', { failClosed: true });
  const open = evaluateEmaTrendEntry(null, 'LONG', { failClosed: false });
  assert.equal(closed.allow, false);
  assert.equal(closed.available, false);
  assert.equal(open.allow, true);
});
