const test = require('node:test');
const assert = require('node:assert/strict');

const { GridState, SpotGridEngine } = require('../index');

function createEngine() {
  const engine = Object.create(SpotGridEngine.prototype);
  const state = Object.create(GridState.prototype);
  state.data = GridState.createEmpty();
  state.rebuildProcessedTradeIndex();
  state.save = async () => {};

  engine.state = state;
  engine.sendAlert = async () => {};
  engine.canPlaceNewOrders = () => true;
  engine.syncManagedOrdersWithExchange = async () => {};
  engine.isTrackedSellProfitable = () => true;
  engine.getMinimumProfitableSellPrice = () => 0;
  engine.getMinCost = () => 0;
  engine.getPreciseOrderNumbers = (_symbol, price, amount) => ({
    preciseAmount: String(amount),
    notional: Number(price) * Number(amount),
  });
  engine.hasActiveOrderAtLevel = () => false;
  engine.countActiveOrders = () => 0;
  engine.amountForBuy = () => 1;
  engine.getRemainingInvestmentUsdt = () => Number.POSITIVE_INFINITY;
  engine.placements = [];
  engine.placeLimit = async (...args) => {
    engine.placements.push(args);
    return { id: `order-${engine.placements.length}` };
  };
  return engine;
}

function buyTrade(id, refillCount) {
  return {
    id: `buy-trade-${id}`,
    order: `buy-order-${id}`,
    timestamp: id,
    datetime: '2026-07-26T00:00:00.000Z',
    price: 100,
    amount: 1,
    fee: { currency: 'USDT', cost: 0 },
    refillCount,
  };
}

function sellTrade(id) {
  return {
    id: `sell-trade-${id}`,
    order: `sell-order-${id}`,
    timestamp: id,
    datetime: '2026-07-26T00:01:00.000Z',
    price: 110,
    amount: 1,
    fee: { currency: 'USDT', cost: 0 },
  };
}

test('a buy at the refill limit still gets a sell exit, then stops refilling', async () => {
  const engine = createEngine();
  const symState = engine.state.getSymbol('BTC/USDT');

  await engine.handleBuyFill(
    'BTC/USDT',
    [100, 110],
    symState,
    buyTrade(1, 2),
    { levelIndex: 0, refillCount: 2 },
    new Set()
  );

  assert.equal(engine.placements.length, 1);
  assert.equal(engine.placements[0][1], 'sell');
  assert.deepEqual(engine.placements[0][5], { refillCount: 2, sourceBuyLevelIndex: 0 });

  await engine.handleSellFill(
    'BTC/USDT',
    [100, 110],
    symState,
    sellTrade(2),
    { levelIndex: 1, refillCount: 2 },
    new Set()
  );

  assert.equal(engine.placements.length, 1);
  assert.equal(symState.refillCountByLevel[0], 2);
});

test('a completed sell creates the second and final buy refill', async () => {
  const engine = createEngine();
  const symState = engine.state.getSymbol('ETH/USDT');

  await engine.handleBuyFill(
    'ETH/USDT',
    [100, 110],
    symState,
    buyTrade(3, 1),
    { levelIndex: 0, refillCount: 1 },
    new Set()
  );
  await engine.handleSellFill(
    'ETH/USDT',
    [100, 110],
    symState,
    sellTrade(4),
    { levelIndex: 1, refillCount: 1 },
    new Set()
  );

  assert.deepEqual(engine.placements.map(args => args[1]), ['sell', 'buy']);
  assert.deepEqual(engine.placements[0][5], { refillCount: 1, sourceBuyLevelIndex: 0 });
  assert.deepEqual(engine.placements[1][5], { refillCount: 2 });
});

test('client order IDs preserve refill count and remain backward compatible', () => {
  const engine = Object.create(SpotGridEngine.prototype);
  const clientOrderId = engine.makeClientOrderId('BTC/USDT', 'buy', 3, 2);

  assert.deepEqual(engine.getBotOrderMeta({ clientOrderId }), {
    side: 'buy',
    levelIndex: 3,
    refillCount: 2,
  });
  const skippedSellId = engine.makeClientOrderId('BTC/USDT', 'sell', 12, 1, 10);
  assert.deepEqual(engine.getBotOrderMeta({ clientOrderId: skippedSellId }), {
    side: 'sell',
    levelIndex: 12,
    sourceBuyLevelIndex: 10,
    refillCount: 1,
  });
  assert.deepEqual(engine.getBotOrderMeta({ clientOrderId: 'grid-btcusdt-s-4-legacy' }), {
    side: 'sell',
    levelIndex: 4,
    refillCount: 0,
  });
});
