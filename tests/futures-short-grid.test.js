process.env.FUTURES_POSITION_SIDE = 'SHORT';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FuturesGridEngine } = require('../futures-grid');

const symbol = 'TEST/USDT:USDT';

function shortEngine() {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.mutualExclusionEnabled = false;
  engine.appliedFibonacciDirections = new Map([[symbol, 'BEARISH']]);
  engine.exchange = {
    markets: { [symbol]: { precision: { price: 0.01 }, limits: { cost: { min: 5 } } } },
    priceToPrecision: (_symbol, value) => Number(value).toFixed(2),
    amountToPrecision: (_symbol, value) => Number(value).toFixed(3),
  };
  engine.latestPositions = new Map([[symbol, { side: 'short', contracts: 1, entryPrice: 110 }]]);
  engine.sellTargetWarnings = new Set();
  return engine;
}

test('mutual ownership blocks SHORT unless direction is BEARISH and LONG exposure is clear', async () => {
  const engine = shortEngine();
  engine.mutualExclusionEnabled = true;
  engine.mutualEntryMutex = { run: (_symbol, fn) => fn() };
  engine.exposureLimits = null;
  engine.makeClientOrderId = () => 'sgrid-test-s-0-r0-test';
  let submitted = 0;
  engine.exchange.createLimitOrder = async () => {
    submitted += 1;
    return { id: 'submitted' };
  };
  engine.exchange.fetchOpenOrders = async () => [];
  engine.exchange.fetchPositions = async () => [
    { symbol, side: 'long', contracts: 1, entryPrice: 100 },
  ];

  assert.equal(await engine.createFuturesLimitOrder(symbol, 'sell', 1, 110, 0), null);
  engine.exchange.fetchPositions = async () => [];
  assert.ok(await engine.createFuturesLimitOrder(symbol, 'sell', 1, 110, 0));

  engine.appliedFibonacciDirections.set(symbol, 'RANGING');
  assert.equal(await engine.createFuturesLimitOrder(symbol, 'sell', 1, 110, 0), null);
  assert.ok(await engine.createFuturesLimitOrder(symbol, 'buy', 1, 100, 1));
  assert.equal(submitted, 2);
});

test('SHORT orders use an isolated client prefix and explicit position side', async () => {
  const engine = shortEngine();
  engine.exposureLimits = null;
  let submitted;
  engine.exchange.createLimitOrder = async (...args) => {
    submitted = args;
    return { id: 'short-entry' };
  };
  const clientOrderId = engine.makeClientOrderId(symbol, 'buy', 3, 1, 5);
  assert.match(clientOrderId, /^sgrid-/);
  assert.deepEqual(engine.getBotOrderMeta({ clientOrderId }), {
    side: 'buy', levelIndex: 3, refillCount: 1, sourceBuyLevelIndex: 5,
  });

  await engine.createFuturesLimitOrder(symbol, 'sell', 1, 110, 2);
  assert.equal(submitted[1], 'sell');
  assert.equal(submitted[4].positionSide, 'SHORT');
});

test('SHORT exit target is below entry and covers two-sided fees', () => {
  const engine = shortEngine();
  const entry = {
    amount: 1,
    sellableAmount: 1,
    totalCostQuote: 110,
    totalFeeQuote: 0.022,
  };
  const target = engine.findBuyTargetForShort(symbol, [90, 100, 110], 2, entry);
  assert.equal(target.buyLevelIndex, 1);
  assert.equal(target.buyPrice, 100);
  assert.ok(engine.isTrackedShortExitProfitable(symbol, entry, target.buyPrice));
});

test('SHORT sell entry followed by BUY exit records positive grid profit', async () => {
  const engine = shortEngine();
  const symState = {
    orders: {},
    lastBuyByLevel: {},
    refillCountByLevel: {},
    filledBuys: 0,
    filledSells: 0,
    realizedGridProfit: 0,
    tradingFees: 0,
  };
  engine.state = {
    data: { totals: { filledBuys: 0, filledSells: 0, realizedGridProfit: 0, tradingFees: 0 } },
    markProcessedTradeLocal: () => true,
    save: async () => {},
  };
  engine.canPlaceNewOrders = () => false;
  engine.sendAlert = async () => {};
  const openOrderIds = new Set();

  await engine.handleShortEntryFill(symbol, [90, 100, 110], symState, {
    id: 'entry', order: 'entry-order', side: 'sell', price: 110, amount: 1,
    fee: { cost: 0.022, currency: 'USDT' }, info: {},
  }, { levelIndex: 2, refillCount: 0 }, openOrderIds);
  await engine.handleShortExitFill(symbol, [90, 100, 110], symState, {
    id: 'exit', order: 'exit-order', side: 'buy', price: 100, amount: 1,
    fee: { cost: 0.02, currency: 'USDT' }, info: {},
  }, { levelIndex: 1, sourceBuyLevelIndex: 2, refillCount: 0 }, openOrderIds);

  assert.ok(Math.abs(symState.realizedGridProfit - 9.958) < 1e-9);
  assert.equal(symState.filledSells, 1);
  assert.equal(symState.filledBuys, 1);
  assert.deepEqual(symState.lastBuyByLevel, {});
});

test('SHORT market exit is counted as a BUY fill', async () => {
  const engine = shortEngine();
  const symState = {
    orders: {},
    lastBuyByLevel: {
      2: {
        amount: 1,
        sellableAmount: 1,
        totalCostQuote: 110,
        totalFeeQuote: 0.022,
      },
    },
    filledBuys: 0,
    filledSells: 0,
    realizedExitProfit: 0,
    tradingFees: 0,
  };
  engine.state = {
    data: { totals: { filledBuys: 0, filledSells: 0, realizedExitProfit: 0, tradingFees: 0 } },
    markProcessedTradeLocal: () => true,
    save: async () => {},
  };
  engine.sendAlert = async () => {};

  await engine.handleExitFill(symbol, symState, {
    id: 'market-exit', order: 'market-exit-order', side: 'buy', price: 100, amount: 1,
    fee: { cost: 0.02, currency: 'USDT' }, info: { realizedPnl: '10' },
  }, new Set());

  assert.equal(symState.filledBuys, 1);
  assert.equal(symState.filledSells, 0);
  assert.ok(Math.abs(symState.realizedExitProfit - 9.958) < 1e-9);
  assert.deepEqual(symState.lastBuyByLevel, {});
});
