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

test('placeLimit skips orders below exchange notional minimum before submitting', async () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.pendingOrderLevels = new Set();
  engine.makeClientOrderId = () => 'grid-bonk-s-5-test';
  engine.exchange = {
    markets: {
      'BONK/USDT': {
        limits: { cost: { min: 5 } },
        info: { filters: [{ filterType: 'NOTIONAL', minNotional: '5' }] },
      },
    },
    priceToPrecision: () => '0.000005',
    amountToPrecision: () => '999000',
    createLimitOrder: () => {
      throw new Error('should not create order below notional minimum');
    },
  };

  const order = await engine.placeLimit('BONK/USDT', 'sell', 5, 0.000005, 999000);

  assert.equal(order, null);
  assert.equal(engine.pendingOrderLevels.size, 0);
});

test('amountForBuy includes exchange notional buffer to keep fee-reduced sells valid', () => {
  const engine = Object.create(SpotGridEngine.prototype);
  engine.getOrderSizeUsdt = () => 1;
  engine.exchange = {
    markets: {
      'BONK/USDT': {
        limits: { cost: { min: 5 } },
        info: { filters: [{ filterType: 'NOTIONAL', minNotional: '5' }] },
      },
    },
  };

  assert.equal(Math.round(engine.amountForBuy('BONK/USDT', 0.000005)), 1010000);
});
