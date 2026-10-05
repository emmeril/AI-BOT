'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STOP_TRADING = 'true';
process.env.GRID_MODE = 'GEOMETRIC';
process.env.GRID_COUNT = '27';
process.env.GRID_STATE_FILE = '/dev/null/grid-state-futures.json';
process.env.GRID_AGGREGATED_EXIT_LADDER_ENABLED = 'true';
process.env.GRID_AGGREGATED_EXIT_LADDER_MAX_ORDERS = '7';
process.env.GRID_AGGREGATED_EXIT_LADDER_SYMBOLS = '1000SHIB/USDT:USDT';

const { FuturesGridEngine } = require('../futures-grid');

const levels = [
  0.005572, 0.005619, 0.005648, 0.00569, 0.005706, 0.005742, 0.005766,
  0.005799, 0.005825, 0.005869, 0.005905, 0.005939, 0.00596, 0.005993,
  0.006013, 0.006039, 0.006072, 0.006085, 0.006101, 0.006119, 0.006146,
  0.006173, 0.006212, 0.006252, 0.006276, 0.006392, 0.006499, 0.006783,
];

const aggregatedBuy = {
  price: 0.005983350329087957,
  amount: 23398,
  sellableAmount: 23398,
  totalCostQuote: 139.998431,
  totalFeeQuote: 0.02799958,
  refillCount: 2,
  aggregated: true,
};

function createEngine() {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.exchange = {
    amountToPrecision: (_symbol, amount) => String(Math.floor(Number(amount))),
    priceToPrecision: (_symbol, price) => Number(price).toFixed(6),
  };
  engine.getMinCost = () => 5;
  return engine;
}

test('aggregated futures inventory is front-loaded across profitable levels above exchange minimum', () => {
  const engine = createEngine();
  const plan = engine.buildAggregatedExitLadderPlan(
    '1000SHIB/USDT:USDT', levels, 13, aggregatedBuy,
    { minimumPrice: 0.005915 }
  );

  assert.equal(plan.length, 7);
  assert.deepEqual(plan.map(part => part.sourceBuyLevelIndex), [13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(plan.map(part => part.sellLevelIndex), [14, 15, 16, 17, 18, 19, 20]);
  assert.equal(plan.reduce((sum, part) => sum + part.amount, 0), 23398);
  assert.ok(plan[0].amount > plan[plan.length - 1].amount);
  assert.ok(plan.every(part => part.amount * part.sellPrice >= 5));
});

test('staging preserves total quantity, cost, fee, and unrelated buy records', () => {
  const engine = createEngine();
  const normalBuy = {
    price: 0.005939,
    amount: 935,
    sellableAmount: 935,
    totalCostQuote: 5.552965,
    totalFeeQuote: 0.00111059,
  };
  const symState = {
    orders: {},
    lastBuyByLevel: { 11: normalBuy, 13: { ...aggregatedBuy } },
    refillCountByLevel: { 11: 2, 13: 2 },
  };

  assert.equal(engine.stageAggregatedExitLadders(
    '1000SHIB/USDT:USDT', levels, 0.005915, symState
  ), 1);

  assert.strictEqual(symState.lastBuyByLevel[11], normalBuy);
  const children = Object.values(symState.lastBuyByLevel).filter(buy => buy.stagedExitChild === true);
  assert.equal(children.length, 7);
  assert.equal(children.reduce((sum, buy) => sum + buy.sellableAmount, 0), aggregatedBuy.sellableAmount);
  assert.ok(Math.abs(children.reduce((sum, buy) => sum + buy.totalCostQuote, 0) - aggregatedBuy.totalCostQuote) < 1e-10);
  assert.ok(Math.abs(children.reduce((sum, buy) => sum + buy.totalFeeQuote, 0) - aggregatedBuy.totalFeeQuote) < 1e-10);
  assert.ok(children.every(buy => buy.aggregated === false));
});

test('aggregated inventory is not split while its existing SELL remains active', () => {
  const engine = createEngine();
  const symState = {
    orders: {
      sell: { id: 'sell', side: 'sell', levelIndex: 14, sourceBuyLevelIndex: 13 },
    },
    lastBuyByLevel: { 13: { ...aggregatedBuy } },
    refillCountByLevel: { 13: 2 },
  };

  assert.equal(engine.stageAggregatedExitLadders(
    '1000SHIB/USDT:USDT', levels, 0.005915, symState
  ), 0);
  assert.equal(symState.lastBuyByLevel[13].aggregated, true);
});

test('live symbol allowlist leaves aggregated inventory on other symbols unchanged', () => {
  const engine = createEngine();
  const symState = {
    orders: {},
    lastBuyByLevel: { 13: { ...aggregatedBuy } },
    refillCountByLevel: { 13: 2 },
  };

  assert.equal(engine.stageAggregatedExitLadders(
    '1000PEPE/USDT:USDT', levels, 0.005915, symState
  ), 0);
  assert.equal(symState.lastBuyByLevel[13].aggregated, true);
});

test('a staged SELL fill realizes its allocated cost and skips immediate refill', async () => {
  const engine = createEngine();
  const symState = {
    orders: {
      sell: { id: 'sell', side: 'sell', levelIndex: 14, sourceBuyLevelIndex: 13 },
    },
    lastBuyByLevel: {
      13: {
        price: 0.00598335,
        amount: 1000,
        sellableAmount: 1000,
        totalCostQuote: 5.98335,
        totalFeeQuote: 0.00119667,
        refillCount: 2,
        stagedExitChild: true,
        stagedExitPart: 1,
        stagedExitParts: 7,
      },
    },
    refillCountByLevel: { 13: 2 },
    realizedGridProfit: 0,
    tradingFees: 0,
    filledSells: 0,
    unreconciledSells: {},
  };
  let refillPlacements = 0;
  engine.state = {
    data: { totals: { realizedGridProfit: 0, tradingFees: 0, filledSells: 0 } },
    markProcessedTradeLocal: () => {},
    save: async () => {},
  };
  engine.sendAlert = async () => {};
  engine.placeLimit = async () => { refillPlacements++; };
  engine.canPlaceNewOrders = () => true;

  await engine.handleSellFill(
    '1000SHIB/USDT:USDT', levels, symState,
    {
      id: 'trade-1', order: 'sell', price: 0.006013, amount: 1000,
      fee: { currency: 'USDT', cost: 0.0012026 }, info: {},
    },
    { levelIndex: 14, sourceBuyLevelIndex: 13, refillCount: 2 },
    new Set()
  );

  assert.equal(symState.lastBuyByLevel[13], undefined);
  assert.equal(symState.refillCountByLevel[13], undefined);
  assert.equal(refillPlacements, 0);
  assert.ok(symState.realizedGridProfit > 0);
});
