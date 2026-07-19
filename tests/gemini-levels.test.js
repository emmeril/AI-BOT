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

test('engine rejects Gemini levels that do not cover fees and target net profit', () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    markets: {
      'SHIB/USDT': { precision: { price: 0.00000001 } },
    },
    priceToPrecision: (_symbol, price) => Number(price).toFixed(8),
  };

  const levels = engine.getUsableCustomLevels(
    'SHIB/USDT',
    [0.00000414, 0.00000415, 0.00000416, 0.00000417, 0.00000420],
    0.00000414,
    0.00000420,
    'test'
  );

  assert.equal(levels, null);
});

test('engine builds adaptive levels from Gemini range when Gemini omits custom levels', () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    markets: {
      'BTC/USDT': { precision: { price: 0.01 } },
    },
    priceToPrecision: (_symbol, price) => Number(price).toFixed(2),
  };

  const levels = engine.getAiGridLevels('BTC/USDT', {
    lower: 90,
    upper: 110,
    levels: null,
    confidence: 0.8,
    marketCondition: 'RANGING',
    reasoning: 'Range only.',
  }, 90, 110, 100);

  assert.deepEqual(levels, [90, 97.5, 100, 102.5, 110]);
});

test('engine keeps valid Gemini levels ahead of adaptive fallback', () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    markets: {
      'BTC/USDT': { precision: { price: 0.01 } },
    },
    priceToPrecision: (_symbol, price) => Number(price).toFixed(2),
  };

  const levels = engine.getAiGridLevels('BTC/USDT', {
    lower: 90,
    upper: 110,
    levels: [90, 96, 101, 106, 110],
    confidence: 0.8,
    marketCondition: 'RANGING',
    reasoning: 'Custom levels.',
  }, 90, 110, 100);

  assert.deepEqual(levels, [90, 96, 101, 106, 110]);
});

test('Gemini prompt requires fee-adjusted grid spacing', () => {
  const advisor = Object.create(GeminiRangeAdvisor.prototype);

  const prompt = advisor.buildPrompt('BTC/USDT', 100, {
    timeframe: '1h',
    candleCount: 100,
    rsi14: 50,
    atr14: 1,
    bollinger20: { lower: 95, middle: 100, upper: 105 },
    volatilityPct: 2,
  });

  assert.match(prompt, /Binance Spot maker fee assumption: 0\.1% per side \(0\.2% buy\+sell round trip\)/);
  assert.match(prompt, /gross step percent .* >= 0\.25025%/);
  assert.match(prompt, /expected net grid profit is at least 0\.05% after Binance fees/);
});

test('engine does not range-reset when Gemini levels match the effective existing grid', async () => {
  const symbolState = {
    config: { lower: 90, upper: 110 },
    orders: {},
    lastBuyByLevel: { 1: { price: 95, amount: 1 } },
  };
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    markets: {
      'BTC/USDT': { precision: { price: 0.01 } },
    },
    priceToPrecision: (_symbol, price) => Number(price).toFixed(2),
  };
  engine.state = {
    getSymbol: () => symbolState,
    save: async () => {},
  };
  engine.rangeAdvisor = {
    getSuggestion: async () => ({
      lower: 90,
      upper: 110,
      levels: [90, 95, 100, 105, 110],
      confidence: 0.8,
      marketCondition: 'RANGING',
      reasoning: 'Same grid.',
    }),
  };
  engine.remapStateAfterRangeReset = async () => {
    throw new Error('range reset should not run for an unchanged effective grid');
  };

  const range = await engine.buildRange('BTC/USDT', 100);

  assert.deepEqual(range, { lower: 90, upper: 110, levels: [90, 95, 100, 105, 110] });
});

test('range remap alert distinguishes unchanged bounds from rebuilt levels', async () => {
  const symbolState = {
    config: { lower: 90, upper: 110 },
    orders: {},
    lastBuyByLevel: { 1: { price: 96, amount: 1 } },
    rangeTransition: null,
  };
  const alerts = [];
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    markets: {
      'BTC/USDT': { precision: { price: 0.01 } },
    },
    priceToPrecision: (_symbol, price) => Number(price).toFixed(2),
  };
  engine.state = {
    getSymbol: () => symbolState,
    save: async () => {},
  };
  engine.cancelGridOrders = async () => ({ failed: [] });
  engine.sendAlert = async message => { alerts.push(message); };

  await engine.remapStateAfterRangeReset('BTC/USDT', 90, 110, 90, 110, [90, 96, 101, 106, 110]);

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^\[Grid Levels Rebuilt\]/);
  assert.match(alerts[0], /Bounds Changed: No/);
  assert.doesNotMatch(alerts[0], /^\[Range Reset\]/);
});
