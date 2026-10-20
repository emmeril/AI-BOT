const test = require('node:test');
const assert = require('node:assert/strict');
const { planFibonacciRegimeLevels } = require('../src/fibonacci-regime-level-planner');

function analysis(structure, adx14 = 30, atr14 = 2) {
  return { timeframes: { '15m': { structure, adx14, atr14, volatilityRatio: 1 } } };
}

test('adverse strong trend pushes the first Fibonacci entry at least one ATR away', () => {
  const candidates = [99.5, 99, 98.5, 98, 97].map((price, index) => ({ price, index }));
  const result = planFibonacciRegimeLevels(candidates, 100, 'LONG', analysis('BEARISH'));
  assert.equal(result.decision.relation, 'ADVERSE');
  assert.deepEqual(result.levels.map(level => level.price), [98]);
});

test('aligned trend keeps denser Fibonacci levels', () => {
  const candidates = [99.5, 99, 98.5, 98].map((price, index) => ({ price, index }));
  const result = planFibonacciRegimeLevels(candidates, 100, 'LONG', analysis('BULLISH'));
  assert.equal(result.decision.relation, 'ALIGNED');
  assert.deepEqual(result.levels.map(level => level.price), [99.5, 99, 98.5, 98]);
});

test('planner fails open and never invents a level', () => {
  const candidates = [{ price: 101, index: 4 }, { price: 102, index: 5 }];
  const unavailable = planFibonacciRegimeLevels(candidates, 100, 'SHORT', null);
  assert.strictEqual(unavailable.levels[0], candidates[0]);
  const fallback = planFibonacciRegimeLevels(candidates, 100, 'SHORT', analysis('BULLISH', 30, 100));
  assert.deepEqual(fallback.levels, [candidates.at(-1)]);
});

test('adverse level cap keeps the deepest final Fibonacci order', () => {
  const candidates = [99, 98, 97, 96].map((price, index) => ({ price, index }));
  const result = planFibonacciRegimeLevels(candidates, 100, 'LONG', analysis('BEARISH', 30, 1), {
    adverseAtrGap: 1,
    adverseMaxLevels: 1,
  });
  assert.deepEqual(result.levels.map(level => level.price), [96]);
});
