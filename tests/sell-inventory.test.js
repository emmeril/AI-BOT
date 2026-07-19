const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GRID_MODE = 'ARITHMETIC';
process.env.GRID_COUNT = '10';

const { SpotGridEngine } = require('../index');

test('sell placement uses only inventory tracked from prior grid buys', () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.state = {
    getSymbol: () => ({
      lastBuyByLevel: {
        4: { amount: 100, sellableAmount: 99.9 },
      },
    }),
  };

  assert.equal(engine.amountForTrackedSell('BONK/USDT', 5), 99.9);
  assert.equal(engine.amountForTrackedSell('BONK/USDT', 6), 0);
});

test('tracked sell amount falls back to buy amount for legacy state', () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.state = {
    getSymbol: () => ({
      lastBuyByLevel: {
        2: { amount: 42 },
      },
    }),
  };

  assert.equal(engine.amountForTrackedSell('BONK/USDT', 3), 42);
});

test('actual buy cost prevents a sell below fee-adjusted break-even', () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    priceToPrecision: (_symbol, price) => Number(price).toFixed(8),
  };
  const buy = {
    amount: 1,
    sellableAmount: 1,
    totalCostQuote: 100,
    totalFeeQuote: 0.1,
  };

  assert.equal(engine.isTrackedSellProfitable('TEST/USDT', buy, 100.2), false);
  assert.equal(engine.isTrackedSellProfitable('TEST/USDT', buy, 100.31), true);
});

test('placeLimit skips invalid dust amounts and clears pending level', async () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.pendingOrderLevels = new Set();
  engine.makeClientOrderId = () => 'grid-bonk-s-5-test';
  engine.exchange = {
    priceToPrecision: () => '0.000005',
    amountToPrecision: () => {
      const err = new Error('binance amount of BONK/USDT must be greater than minimum amount precision of 1');
      err.name = 'InvalidOrder';
      throw err;
    },
    createLimitOrder: () => {
      throw new Error('should not create order');
    },
  };

  const order = await engine.placeLimit('BONK/USDT', 'sell', 5, 0.000005, 0.25);

  assert.equal(order, null);
  assert.equal(engine.pendingOrderLevels.size, 0);
});

test('post-only rejection is not retried as a taker order', async () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.pendingOrderLevels = new Set();
  engine.makeClientOrderId = () => 'grid-bonk-b-4-test';
  engine.state = {
    rememberOrder: () => {
      throw new Error('should not remember failed order');
    },
  };
  engine.exchange = {
    priceToPrecision: () => '1',
    amountToPrecision: () => '20',
    createLimitOrder: async (symbol, side, amount, price, params) => {
      assert.equal(params.postOnly, true);
      throw new Error('Post only order rejected');
    },
  };

  await assert.rejects(
    () => engine.placeLimit('BONK/USDT', 'buy', 4, 1, 20),
    /Post only order rejected/
  );
  assert.equal(engine.pendingOrderLevels.size, 0);
});
