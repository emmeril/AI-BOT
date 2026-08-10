const test = require('node:test');
const assert = require('node:assert/strict');

const { GridState, SpotGridEngine } = require('../index');

function createEngine({ minCost = 1, profitableAt = 100.4 } = {}) {
  const engine = Object.create(SpotGridEngine.prototype);
  const state = Object.create(GridState.prototype);
  state.data = GridState.createEmpty();
  state.rebuildProcessedTradeIndex();
  state.save = async () => {};
  engine.state = state;
  engine.exchange = {
    markets: { 'TEST/USDT': { limits: { cost: { min: minCost } } } },
    priceToPrecision: (_symbol, price) => Number(price).toFixed(2),
    amountToPrecision: (_symbol, amount) => Number(amount).toFixed(4),
  };
  engine.getMinCost = () => minCost;
  engine.isTrackedSellProfitable = (_symbol, _buy, price) => price >= profitableAt;
  return engine;
}

test('sell target skips an unprofitable adjacent Fibonacci level', () => {
  const engine = createEngine();
  const target = engine.findSellTargetForBuy(
    'TEST/USDT',
    [100, 100.2, 100.5, 101],
    0,
    { amount: 1, sellableAmount: 1, totalCostQuote: 100, totalFeeQuote: 0 }
  );

  assert.deepEqual(target, {
    buyLevelIndex: 0,
    sellLevelIndex: 2,
    sellPrice: 100.5,
    amount: 1,
    notional: 100.5,
  });
});

test('sell target skips a profitable level whose rounded notional is below exchange minimum', () => {
  const engine = createEngine({ minCost: 100.7 });
  const target = engine.findSellTargetForBuy(
    'TEST/USDT',
    [100, 100.5, 101],
    0,
    { amount: 1, sellableAmount: 1, totalCostQuote: 100, totalFeeQuote: 0 }
  );

  assert.equal(target.sellLevelIndex, 2);
  assert.equal(target.notional, 101);
});

test('dust without a valid notional target remains unassigned', () => {
  const engine = createEngine({ minCost: 1 });
  const target = engine.findSellTargetForBuy(
    'TEST/USDT',
    [100, 105, 110],
    0,
    { amount: 0.001, sellableAmount: 0.001, totalCostQuote: 0.1, totalFeeQuote: 0 }
  );

  assert.equal(target, null);
});

test('sell fill uses explicit source buy level and refills that level', async () => {
  const engine = createEngine({ minCost: 0 });
  engine.sendAlert = async () => {};
  engine.canPlaceNewOrders = () => true;
  engine.syncManagedOrdersWithExchange = async () => {};
  engine.hasActiveOrderAtLevel = () => false;
  engine.countActiveOrders = () => 0;
  engine.amountForBuy = () => 1;
  engine.getRemainingInvestmentUsdt = () => Infinity;
  engine.getPreciseOrderNumbers = (_symbol, price, amount) => ({
    preciseAmount: String(amount),
    amountNum: Number(amount),
    precisePrice: String(price),
    priceNum: Number(price),
    notional: Number(price) * Number(amount),
  });
  engine.placeLimit = async (...args) => {
    engine.placement = args;
    return { id: 'refill-buy' };
  };
  const symState = engine.state.getSymbol('TEST/USDT');
  symState.lastBuyByLevel[0] = {
    price: 100,
    amount: 1,
    sellableAmount: 1,
    totalCostQuote: 100,
    totalFeeQuote: 0,
    refillCount: 0,
  };

  await engine.handleSellFill(
    'TEST/USDT',
    [100, 100.2, 100.5],
    symState,
    {
      id: 'sell-trade-source',
      order: 'sell-order-source',
      timestamp: 2,
      price: 100.5,
      amount: 1,
      fee: { currency: 'USDT', cost: 0 },
    },
    { levelIndex: 2, sourceBuyLevelIndex: 0, refillCount: 0 },
    new Set()
  );

  assert.equal(engine.placement[1], 'buy');
  assert.equal(engine.placement[2], 0);
  assert.equal(engine.placement[3], 100);
  assert.deepEqual(engine.placement[5], { refillCount: 1 });
});
