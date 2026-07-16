const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GRID_MODE = 'ARITHMETIC';
process.env.GRID_COUNT = '10';

const { GridState, SpotGridEngine } = require('../index');

function createEngine() {
  const engine = Object.create(SpotGridEngine.prototype);
  const state = Object.create(GridState.prototype);
  state.data = GridState.createEmpty();
  state.rebuildProcessedTradeIndex();
  state.save = async () => {};

  engine.state = state;
  engine.alerts = [];
  engine.sendAlert = async message => { engine.alerts.push(message); };
  engine.canPlaceNewOrders = () => false;
  return engine;
}

test('buy fee charged in base asset is not double-counted in realized profit', async () => {
  const engine = createEngine();
  const symState = {
    orders: { buy1: { side: 'buy', levelIndex: 0 }, sell1: { side: 'sell', levelIndex: 1 } },
    lastBuyByLevel: {},
    realizedGridProfit: 0,
  };

  await engine.handleBuyFill(
    'PEPE/USDT',
    [100, 110],
    symState,
    {
      id: 'buy-trade-1',
      order: 'buy1',
      timestamp: 1,
      datetime: '2026-07-13T00:00:00.000Z',
      price: 100,
      amount: 1,
      fee: { currency: 'PEPE', cost: 0.001 },
    },
    { levelIndex: 0 },
    new Set()
  );

  assert.equal(symState.lastBuyByLevel[0].sellableAmount, 0.999);
  assert.equal(symState.lastBuyByLevel[0].totalCostQuote, 100);
  assert.equal(symState.lastBuyByLevel[0].totalFeeQuote, 0);
  assert.match(engine.alerts.at(-1), /Fee: 0 USDT \(0\.001 PEPE deducted from sellable amount\)/);

  await engine.handleSellFill(
    'PEPE/USDT',
    [100, 110],
    symState,
    {
      id: 'sell-trade-1',
      order: 'sell1',
      timestamp: 2,
      datetime: '2026-07-13T00:01:00.000Z',
      price: 110,
      amount: 0.999,
      fee: { currency: 'USDT', cost: 0 },
    },
    { levelIndex: 1 },
    new Set()
  );

  assert.equal(symState.realizedGridProfit, 9.89);
  assert.equal(engine.state.data.totals.realizedGridProfit, 9.89);
});

test('buy fee charged in quote asset remains included in realized profit', async () => {
  const engine = createEngine();
  const symState = {
    orders: { buy1: { side: 'buy', levelIndex: 0 }, sell1: { side: 'sell', levelIndex: 1 } },
    lastBuyByLevel: {},
    realizedGridProfit: 0,
  };

  await engine.handleBuyFill(
    'PEPE/USDT',
    [100, 110],
    symState,
    {
      id: 'buy-trade-1',
      order: 'buy1',
      timestamp: 1,
      datetime: '2026-07-13T00:00:00.000Z',
      price: 100,
      amount: 1,
      fee: { currency: 'USDT', cost: 0.1 },
    },
    { levelIndex: 0 },
    new Set()
  );

  assert.equal(symState.lastBuyByLevel[0].sellableAmount, 1);
  assert.equal(symState.lastBuyByLevel[0].totalFeeQuote, 0.1);
  assert.match(engine.alerts.at(-1), /Fee: 0\.1 USDT/);

  await engine.handleSellFill(
    'PEPE/USDT',
    [100, 110],
    symState,
    {
      id: 'sell-trade-1',
      order: 'sell1',
      timestamp: 2,
      datetime: '2026-07-13T00:01:00.000Z',
      price: 110,
      amount: 1,
      fee: { currency: 'USDT', cost: 0.11 },
    },
    { levelIndex: 1 },
    new Set()
  );

  assert.ok(Math.abs(symState.realizedGridProfit - 9.79) < 1e-12);
  assert.ok(Math.abs(engine.state.data.totals.realizedGridProfit - 9.79) < 1e-12);
});

test('sell fee charged in base asset consumes inventory and cost basis', async () => {
  const engine = createEngine();
  const symState = engine.state.getSymbol('PEPE/USDT');
  symState.lastBuyByLevel[0] = {
    price: 100,
    amount: 1,
    sellableAmount: 1,
    totalCostQuote: 100,
    totalFeeQuote: 0,
  };

  await engine.handleSellFill(
    'PEPE/USDT',
    [100, 110],
    symState,
    {
      id: 'sell-base-fee',
      order: 'sell-order',
      side: 'sell',
      price: 110,
      amount: 0.999,
      fee: { cost: 0.001, currency: 'PEPE' },
    },
    { levelIndex: 1 },
    new Set()
  );

  assert.equal(symState.lastBuyByLevel[0], undefined);
  assert.ok(Math.abs(symState.realizedGridProfit - 9.89) < 1e-10);
  assert.match(engine.alerts.at(-1), /Fee: 0 USDT \(0\.001 PEPE deducted from sellable amount\)/);
});
