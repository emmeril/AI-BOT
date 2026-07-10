const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GRID_MODE = 'ARITHMETIC';
process.env.GRID_COUNT = '4';

const { GeminiRangeAdvisor, SpotGridEngine } = require('../index');

test('Gemini suggestion accepts strictly increasing custom grid levels', () => {
  const advisor = Object.create(GeminiRangeAdvisor.prototype);

  const suggestion = advisor.sanitizeSuggestion('BTC/USDT', 100, {
    lower: 90,
    upper: 110,
    levels: [90, 95, 100, 105, 110],
    confidence: 0.8,
    marketCondition: 'RANGING',
    reasoning: 'Balanced range.',
  });

  assert.deepEqual(suggestion.levels, [90, 95, 100, 105, 110]);
});

test('Gemini suggestion ignores non-sequential custom grid levels', () => {
  const advisor = Object.create(GeminiRangeAdvisor.prototype);

  const suggestion = advisor.sanitizeSuggestion('BTC/USDT', 100, {
    lower: 90,
    upper: 110,
    levels: [90, 100, 98, 105, 110],
    confidence: 0.8,
    marketCondition: 'RANGING',
    reasoning: 'Out of order.',
  });

  assert.equal(suggestion.levels, null);
});

test('engine uses valid Gemini grid levels after exchange precision validation', () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    markets: {
      'BTC/USDT': { precision: { price: 0.01 } },
    },
    priceToPrecision: (_symbol, price) => Number(price).toFixed(2),
  };

  const levels = engine.getUsableCustomLevels('BTC/USDT', [90, 96, 101, 106, 110], 90, 110, 'test');

  assert.deepEqual(levels, [90, 96, 101, 106, 110]);
});
