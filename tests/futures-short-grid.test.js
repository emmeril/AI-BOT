process.env.FUTURES_POSITION_SIDE = 'SHORT';
process.env.SYMBOLS = 'TEST/USDT:USDT';
process.env.LEVERAGE = '5';
process.env.GRID_COUNT = '10';
process.env.FUTURES_DYNAMIC_EXPOSURE_ENABLED = 'true';
process.env.FUTURES_DYNAMIC_EXPOSURE_SIDE_PCT = '45';
process.env.FUTURES_ENTRY_ENABLED = 'false';
process.env.REVERSAL_INVENTORY_ENABLED = 'true';
process.env.REVERSAL_RESCUE_MARGIN_PCT = '5';

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

test('SHORT exit-only mode blocks SELL entries but keeps BUY exits available', async () => {
  const engine = shortEngine();
  engine.entryGridEnabled = false;
  engine.exposureLimits = null;
  engine.canPlaceNewOrders = () => true;
  let submitted = 0;
  engine.exchange.createLimitOrder = async () => {
    submitted += 1;
    return { id: `order-${submitted}` };
  };

  assert.equal(await engine.createFuturesLimitOrder(symbol, 'sell', 1, 110, 2), null);
  assert.ok(await engine.createFuturesLimitOrder(symbol, 'buy', 1, 100, 1));
  assert.equal(submitted, 1);
});

test('SHORT exit-only mode has zero entry allocation but retains legacy exposure and rescue budget', async () => {
  const engine = shortEngine();
  engine.entryGridEnabled = false;
  engine.exposureLimits = { symbol: 20, total: 40 };
  engine.exposureBudgetLastCheckedAt = 0;
  engine.exposureBudgetReferenceWalletBalance = 0;
  engine.state = {
    data: {},
    save: async () => {},
  };
  engine.exchange.fetchBalance = async () => ({ total: { USDT: 100 } });
  engine.exchange.fetchOpenOrders = async () => [];
  engine.exchange.fetchPositions = async () => [{
    symbol,
    side: 'short',
    contracts: 2,
    entryPrice: 10,
    markPrice: 10,
    notional: -20,
  }];

  assert.equal(await engine.refreshExposureLimits({ force: true }), true);
  assert.deepEqual(engine.exposureLimits, { symbol: 0, total: 0 });
  assert.equal(engine.state.data.exposureBudget.status, 'EXIT_ONLY');
  assert.equal(engine.state.data.exposureBudget.sidePct, 0);
  assert.equal(engine.state.data.exposureBudget.currentExposure, 20);
  assert.equal(engine.state.data.exposureBudget.rescueMarginPct, 5);
  assert.equal(engine.state.data.exposureBudget.rescueSideCap, 25);
});

test('dynamic exposure cap determines the per-pair grid investment and order size', () => {
  const engine = shortEngine();
  engine.exposureLimits = { symbol: 300, total: 600 };
  assert.equal(engine.getInvestmentLimitUsdt(), 300);
  assert.equal(engine.getOrderSizeUsdt(), 30);

  engine.exposureLimits = { symbol: 0, total: 0 };
  assert.equal(engine.getInvestmentLimitUsdt(), 0);
  assert.equal(engine.getOrderSizeUsdt(), 0);
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

test('SHORT exit offset is symmetric and clamps at the farthest profitable level', () => {
  const engine = shortEngine();
  const entry = {
    amount: 1,
    sellableAmount: 1,
    totalCostQuote: 110,
    totalFeeQuote: 0.022,
    exitTargetLevelOffset: 1,
  };
  const target = engine.findBuyTargetForShort(symbol, [90, 100, 110], 2, entry);
  assert.equal(target.buyLevelIndex, 0);
  assert.equal(target.buyPrice, 90);
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

test('SHORT dust entries consolidate into one profitable exit above minimum notional', () => {
  const engine = shortEngine();
  engine.exchange.markets[symbol] = {
    precision: { price: 0.000001, amount: 1 },
    limits: { cost: { min: 5 } },
  };
  engine.exchange.priceToPrecision = (_symbol, value) => Number(value).toFixed(6);
  engine.exchange.amountToPrecision = (_symbol, value) => String(Math.floor(Number(value)));
  engine.latestPositions.set(symbol, {
    side: 'short', contracts: 3114, entryPrice: 0.004818642581888246,
  });
  const levels = [
    0.004762, 0.004778, 0.00479, 0.004804, 0.004818, 0.004843, 0.004856,
  ];
  const symState = {
    orders: {},
    refillCountByLevel: { 3: 0, 4: 0, 5: 0 },
    lastBuyByLevel: {
      3: {
        price: 0.004806, amount: 1041, sellableAmount: 1041,
        totalCostQuote: 5.003046, totalFeeQuote: 0.0010006, refillCount: 0,
      },
      4: {
        price: 0.004819, amount: 1038, sellableAmount: 1038,
        totalCostQuote: 5.002122, totalFeeQuote: 0.00100042, refillCount: 0,
      },
      5: {
        price: 0.004831, amount: 1035, sellableAmount: 1035,
        totalCostQuote: 5.000085, totalFeeQuote: 0.00100001, refillCount: 0,
      },
    },
  };

  for (const [levelIndex, entry] of Object.entries(symState.lastBuyByLevel)) {
    assert.equal(engine.findBuyTargetForShort(
      symbol, levels, Number(levelIndex), entry,
      { maximumPrice: 0.004844 }
    ), null);
  }

  const result = engine.consolidateShortExitDust(
    symbol, levels, 0.004844, symState, 3114
  );

  assert.deepEqual(result.sourceLevels, [3, 4, 5]);
  assert.equal(result.entryLevelIndex, 5);
  assert.equal(result.amount, 3114);
  assert.ok(result.target.notional >= 5);
  assert.deepEqual(Object.keys(symState.lastBuyByLevel), ['5']);
  assert.equal(symState.lastBuyByLevel[5].shortExitCombined, true);
  assert.equal(symState.lastBuyByLevel[5].sellableAmount, 3114);
  assert.ok(Math.abs(symState.lastBuyByLevel[5].totalCostQuote - 15.005253) < 1e-10);
  assert.ok(Math.abs(symState.lastBuyByLevel[5].totalFeeQuote - 0.00300103) < 1e-10);
});

test('SHORT dust consolidation leaves inventory with an active exit unchanged', () => {
  const engine = shortEngine();
  const first = {
    amount: 0.045, sellableAmount: 0.045,
    totalCostQuote: 4.95, totalFeeQuote: 0.001, refillCount: 0,
  };
  const second = {
    amount: 0.044, sellableAmount: 0.044,
    totalCostQuote: 4.84, totalFeeQuote: 0.001, refillCount: 0,
  };
  const symState = {
    orders: {
      active: { id: 'active', side: 'buy', levelIndex: 0, sourceBuyLevelIndex: 1 },
    },
    refillCountByLevel: { 1: 0, 2: 0 },
    lastBuyByLevel: { 1: first, 2: second },
  };

  assert.equal(engine.consolidateShortExitDust(
    symbol, [90, 100, 110], 105, symState, 0.044
  ), null);
  assert.strictEqual(symState.lastBuyByLevel[1], first);
  assert.strictEqual(symState.lastBuyByLevel[2], second);
});

test('a single SHORT dust lot combines with uncovered inventory that could exit alone', () => {
  const engine = shortEngine();
  const symState = {
    orders: {},
    refillCountByLevel: { 2: 0, 3: 0 },
    lastBuyByLevel: {
      2: {
        amount: 0.045, sellableAmount: 0.045,
        totalCostQuote: 4.95, totalFeeQuote: 0.001, refillCount: 0,
      },
      3: {
        amount: 0.06, sellableAmount: 0.06,
        totalCostQuote: 6.6, totalFeeQuote: 0.0012, refillCount: 0,
      },
    },
  };

  assert.equal(engine.findBuyTargetForShort(
    symbol, [80, 90, 100, 110], 2, symState.lastBuyByLevel[2],
    { maximumPrice: 105 }
  ), null);
  assert.ok(engine.findBuyTargetForShort(
    symbol, [80, 90, 100, 110], 3, symState.lastBuyByLevel[3],
    { maximumPrice: 105 }
  ));

  const result = engine.consolidateShortExitDust(
    symbol, [80, 90, 100, 110], 105, symState, 0.105
  );

  assert.deepEqual(result.sourceLevels, [2, 3]);
  assert.equal(result.amount, 0.105);
  assert.ok(result.target.notional >= 5);
  assert.deepEqual(Object.keys(symState.lastBuyByLevel), ['3']);
});

test('SHORT entry sizing keeps the future BUY exit above minimum notional', () => {
  const engine = shortEngine();
  engine.exchange.markets[symbol] = {
    precision: { price: 0.000001, amount: 1 },
    limits: { cost: { min: 5 } },
  };
  engine.exchange.priceToPrecision = (_symbol, value) => Number(value).toFixed(6);
  engine.exchange.amountToPrecision = (_symbol, value) => String(Math.floor(Number(value)));
  const levels = [0.004762, 0.004778, 0.00479, 0.004804, 0.004818];

  const amount = engine.getMinimumShortEntryAmountForExit(
    symbol, levels, 4, levels[4]
  );
  const exitPrice = engine.getShortExitSizingPrice(symbol, levels, 4, levels[4]);

  assert.ok(amount * exitPrice >= 5 - 1e-8);
  assert.ok(amount * levels[4] > 5);
});

test('combined SHORT exit fill preserves profit accounting and does not double-refill', async () => {
  const engine = shortEngine();
  const symState = {
    orders: {
      exit: { id: 'exit', side: 'buy', levelIndex: 1, sourceBuyLevelIndex: 2 },
    },
    lastBuyByLevel: {
      2: {
        amount: 2,
        sellableAmount: 2,
        totalCostQuote: 220,
        totalFeeQuote: 0.044,
        refillCount: 1,
        shortExitCombined: true,
        shortExitSourceLevels: [1, 2],
      },
    },
    refillCountByLevel: { 2: 1 },
    filledBuys: 0,
    filledSells: 2,
    realizedGridProfit: 0,
    tradingFees: 0,
  };
  let refillPlacements = 0;
  engine.state = {
    data: { totals: { filledBuys: 0, filledSells: 2, realizedGridProfit: 0, tradingFees: 0 } },
    markProcessedTradeLocal: () => true,
    save: async () => {},
  };
  engine.sendAlert = async () => {};
  engine.canPlaceNewOrders = () => true;
  engine.placeLimit = async () => { refillPlacements += 1; };

  await engine.handleShortExitFill(symbol, [90, 100, 110], symState, {
    id: 'combined-exit', order: 'exit', side: 'buy', price: 100, amount: 2,
    fee: { cost: 0.04, currency: 'USDT' }, info: {},
  }, { levelIndex: 1, sourceBuyLevelIndex: 2, refillCount: 1 }, new Set());

  assert.ok(Math.abs(symState.realizedGridProfit - 19.916) < 1e-9);
  assert.equal(symState.lastBuyByLevel[2], undefined);
  assert.equal(symState.filledBuys, 1);
  assert.equal(refillPlacements, 0);
});
