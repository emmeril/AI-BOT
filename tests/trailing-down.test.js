const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GRID_MODE = 'ARITHMETIC';
process.env.GRID_COUNT = '10';
process.env.GRID_TRAILING_DOWN_ENABLED = 'true';

const { AIGridValidator, SpotGridEngine } = require('../index');

test('trailing-down trigger is one arithmetic grid below lower bound', () => {
  const engine = Object.create(SpotGridEngine.prototype);

  assert.equal(engine.getTrailingDownTrigger(90, 110), 88);
});

test('trailing-down shifts stored order and buy-lot indexes together', () => {
  const symbolState = {
    orders: {
      buy: { levelIndex: 0 },
      sell: { levelIndex: 8 },
    },
    lastBuyByLevel: {
      0: { amount: 1 },
      4: { amount: 2 },
    },
  };
  const engine = Object.create(SpotGridEngine.prototype);
  engine.state = {
    getSymbol: () => symbolState,
  };

  engine.shiftStoredLevelIndexes('BTC/USDT', 1);

  assert.equal(symbolState.orders.buy.levelIndex, 1);
  assert.equal(symbolState.orders.sell.levelIndex, 9);
  assert.deepEqual(Object.keys(symbolState.lastBuyByLevel).sort(), ['1', '5']);
});

test('AI prompt treats a completed trailing-down shift as expected', () => {
  const validator = Object.create(AIGridValidator.prototype);
  const prompt = validator.buildPrompt('BTC/USDT', {
    currentPrice: 88,
    lower: 88,
    upper: 108,
    levels: [88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108],
    trailingDownJustShifted: true,
  }, {});

  assert.match(prompt, /Trailing Down Just Shifted: true/);
  assert.match(prompt, /Do not block solely because price is near the new lower bound/);
});

test('trailing-down updates auto range and shifts indexes one level up', async () => {
  const symbolState = {
    config: { lower: 90, upper: 110 },
    orders: {
      buy: { levelIndex: 0 },
    },
    lastBuyByLevel: {
      4: { amount: 2 },
    },
  };
  const engine = Object.create(SpotGridEngine.prototype);
  engine.state = {
    getSymbol: () => symbolState,
    save: () => {},
  };
  engine.sendAlert = async () => {};

  const shifted = await engine.maybeTrailDownRange('BTC/USDT', 88, 90, 110);

  assert.deepEqual(shifted, { lower: 88, upper: 108 });
  assert.equal(symbolState.config.lower, 88);
  assert.equal(symbolState.config.upper, 108);
  assert.equal(symbolState.orders.buy.levelIndex, 1);
  assert.deepEqual(Object.keys(symbolState.lastBuyByLevel), ['5']);
  assert.equal(symbolState.trailingDown.shifts, 1);
  assert.match(symbolState.trailingDown.lastShiftAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('trailing-down follows a large move by shifting multiple grids', async () => {
  const symbolState = {
    config: { lower: 90, upper: 110 },
    orders: {
      buy: { levelIndex: 2 },
    },
    lastBuyByLevel: {
      4: { amount: 2 },
    },
  };
  const engine = Object.create(SpotGridEngine.prototype);
  engine.state = {
    getSymbol: () => symbolState,
    save: () => {},
  };
  engine.sendAlert = async () => {};

  const shifted = await engine.maybeTrailDownRange('BTC/USDT', 84, 90, 110);

  assert.deepEqual(shifted, { lower: 84, upper: 104 });
  assert.equal(symbolState.config.lower, 84);
  assert.equal(symbolState.config.upper, 104);
  assert.equal(symbolState.orders.buy.levelIndex, 5);
  assert.deepEqual(Object.keys(symbolState.lastBuyByLevel), ['7']);
  assert.equal(symbolState.trailingDown.shifts, 3);
});
