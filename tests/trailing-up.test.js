const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GRID_MODE = 'ARITHMETIC';
process.env.GRID_COUNT = '10';

const { SpotGridEngine } = require('../index');

test('trailing-up trigger is one arithmetic grid above upper bound', () => {
  const engine = Object.create(SpotGridEngine.prototype);

  assert.equal(engine.getTrailingUpTrigger(90, 110), 112);
});

test('trailing-up shifts stored order and buy-lot indexes together', () => {
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

  engine.shiftStoredLevelIndexes('BTC/USDT', -1);

  assert.equal(symbolState.orders.buy.levelIndex, -1);
  assert.equal(symbolState.orders.sell.levelIndex, 7);
  assert.deepEqual(Object.keys(symbolState.lastBuyByLevel).sort(), ['-1', '3']);
});
