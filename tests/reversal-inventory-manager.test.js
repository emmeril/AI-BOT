'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.REVERSAL_INVENTORY_ENABLED = 'true';
process.env.PRICE_MOMENTUM_ENTRY_FILTER_ENABLED = 'true';
process.env.PRICE_MOMENTUM_ENTRY_FILTER_MODE = 'LIVE';
process.env.REVERSAL_RESCUE_MARGIN_PCT = '5';
process.env.REVERSAL_STALE_HOURS = '24';
process.env.REVERSAL_PROFIT_RESERVE_USDT = '0.05';
process.env.REVERSAL_MAX_EXIT_FRACTION = '1';
process.env.REVERSAL_APPLY_TO_EXISTING_POSITIONS = 'false';
const {
  buildProfitBankExit,
  momentumState,
  nearestAdverseLevel,
  nearestFavorableLevel,
  realizedProfitBank,
  rescueBudgetPerPair,
  reversalAgeHours,
  trackedInventorySummary,
} = require('../src/reversal-inventory-manager');
const { FuturesGridEngine } = require('../futures-grid');

test('momentum ownership is mirrored for LONG and SHORT', () => {
  assert.equal(momentumState({ available: true, direction: 'BULLISH' }, 'LONG'), 'ALIGNED');
  assert.equal(momentumState({ available: true, direction: 'BEARISH' }, 'LONG'), 'OPPOSING');
  assert.equal(momentumState({ available: true, direction: 'BEARISH' }, 'SHORT'), 'ALIGNED');
  assert.equal(momentumState({ available: true, direction: 'BULLISH' }, 'SHORT'), 'OPPOSING');
  assert.equal(momentumState({ available: false, direction: 'BEARISH' }, 'LONG'), 'UNKNOWN');
});

test('rescue and unwind select the nearest Fibonacci level on the correct side', () => {
  const levels = [90, 95, 100, 105, 110];
  assert.deepEqual(nearestAdverseLevel(levels, 102, 'LONG'), { index: 2, price: 100 });
  assert.deepEqual(nearestFavorableLevel(levels, 102, 'LONG'), { index: 3, price: 105 });
  assert.deepEqual(nearestAdverseLevel(levels, 102, 'SHORT'), { index: 3, price: 105 });
  assert.deepEqual(nearestFavorableLevel(levels, 102, 'SHORT'), { index: 2, price: 100 });
});

test('tracked inventory and profit bank use net realized state with a reserve', () => {
  const inventory = trackedInventorySummary({
    1: { sellableAmount: 2, totalCostQuote: 200, totalFeeQuote: 0.04 },
    2: { amount: 1, totalCostQuote: 110, totalFeeQuote: 0.02 },
  });
  assert.deepEqual(inventory, { amount: 3, costQuote: 310, entryFeeQuote: 0.06 });
  assert.ok(Math.abs(realizedProfitBank({
    realizedGridProfit: 2,
    realizedExitProfit: -0.4,
    fundingProfit: 0.1,
  }, 0.05) - 1.65) < 1e-12);
});

test('profit-bank exit shrinks a losing LONG close to the funded fraction', () => {
  const plan = buildProfitBankExit({
    positionSide: 'LONG',
    inventory: { amount: 2, costQuote: 220, entryFeeQuote: 0.04 },
    positionAmount: 2,
    exitPrice: 100,
    availableProfit: 5,
    makerFeeRate: 0.0002,
    maximumFraction: 1,
  });
  assert.ok(plan.fraction > 0.24 && plan.fraction < 0.25);
  assert.ok(Math.abs(plan.profitUsed - 5) < 1e-10);
  assert.ok(Math.abs(plan.estimatedNetPnl + 5) < 1e-10);
});

test('profit-bank exit allows a full profitable SHORT close without consuming bank', () => {
  const plan = buildProfitBankExit({
    positionSide: 'SHORT',
    inventory: { amount: 2, costQuote: 220, entryFeeQuote: 0.04 },
    positionAmount: 2,
    exitPrice: 100,
    availableProfit: 0,
    makerFeeRate: 0.0002,
    maximumFraction: 1,
  });
  assert.equal(plan.fraction, 1);
  assert.equal(plan.amount, 2);
  assert.equal(plan.profitUsed, 0);
  assert.ok(plan.estimatedNetPnl > 19);
});

test('opposing age is measured from the persisted transition timestamp', () => {
  const now = Date.parse('2026-10-21T12:00:00.000Z');
  assert.equal(reversalAgeHours('2026-10-20T12:00:00.000Z', now), 24);
  assert.equal(reversalAgeHours(null, now), 0);
});

test('rescue budget is divided equally across configured pairs', () => {
  const input = { walletBalance: 100, marginPct: 5, leverage: 5 };
  assert.equal(rescueBudgetPerPair({ ...input, pairCount: 1 }), 25);
  assert.equal(rescueBudgetPerPair({ ...input, pairCount: 2 }), 12.5);
  assert.equal(rescueBudgetPerPair({ ...input, pairCount: 5 }), 5);
});

test('reversal client order IDs recover rescue and profit-bank metadata', () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  const rescueId = engine.makeReversalClientOrderId('BTC/USDT:USDT', 'buy', 'REVERSAL_RESCUE', 3);
  const bankId = engine.makeReversalClientOrderId('BTC/USDT:USDT', 'sell', 'REVERSAL_BANK_EXIT');
  const rescue = engine.getBotOrderMeta({ clientOrderId: rescueId });
  const bank = engine.getBotOrderMeta({ clientOrderId: bankId });
  assert.equal(rescue.kind, 'REVERSAL_RESCUE');
  assert.equal(rescue.levelIndex, 3);
  assert.equal(rescue.isReversalRescue, true);
  assert.equal(bank.kind, 'REVERSAL_BANK_EXIT');
  assert.equal(bank.isPositionExit, true);
});

function reversalEngine(symState) {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.state = {
    save: async () => {},
    getSymbol: () => symState,
  };
  engine.sendAlert = async () => {};
  engine.getMinCost = () => 5;
  engine.getMinAmount = () => 0;
  engine.getQuoteAsset = () => 'USDT';
  return engine;
}

test('first activation grandfathers an already-open position', async () => {
  const symState = { orders: {}, lastBuyByLevel: {}, reversalInventory: {} };
  const engine = reversalEngine(symState);
  let placements = 0;
  engine.placeReversalLimitOrder = async () => { placements++; };

  const result = await engine.manageReversalInventory({
    symbol: 'TEST/USDT:USDT',
    symState,
    priceMomentumDecision: { available: true, direction: 'BEARISH' },
    currentPrice: 102,
    levels: [95, 100, 105],
    balance: { free: { USDT: 10 }, total: { USDT: 100 } },
    positions: [{ symbol: 'TEST/USDT:USDT', side: 'long', contracts: 1, unrealizedPnl: -2 }],
    managedOrders: [],
    now: Date.parse('2026-10-21T00:00:00.000Z'),
  });

  assert.equal(result.grandfathered, true);
  assert.equal(symState.reversalInventory.grandfathered, true);
  assert.equal(placements, 0);
});

test('an opposing transition places only one wallet-sized rescue', async () => {
  const symState = {
    orders: {},
    lastBuyByLevel: { 1: { sellableAmount: 1, totalCostQuote: 105, totalFeeQuote: 0.02 } },
    reversalInventory: {
      initializedAt: '2026-10-20T00:00:00.000Z',
      mode: 'MONITORING',
      grandfathered: false,
      rescueUsed: false,
    },
  };
  const engine = reversalEngine(symState);
  const placements = [];
  engine.placeReversalLimitOrder = async (...args) => {
    placements.push(args);
    const order = { id: 'rescue-1', amount: args[4], price: args[3] };
    symState.orders[order.id] = { ...order, kind: 'REVERSAL_RESCUE' };
    return order;
  };
  const input = {
    symbol: 'TEST/USDT:USDT',
    symState,
    priceMomentumDecision: { available: true, direction: 'BEARISH' },
    currentPrice: 102,
    levels: [95, 100, 105],
    balance: { free: { USDT: 10 }, total: { USDT: 100 } },
    positions: [{ symbol: 'TEST/USDT:USDT', side: 'long', contracts: 1, unrealizedPnl: -2 }],
    managedOrders: [],
    now: Date.parse('2026-10-21T00:00:00.000Z'),
  };

  await engine.manageReversalInventory(input);
  await engine.manageReversalInventory({ ...input, now: input.now + 60_000 });

  assert.equal(placements.length, 1);
  assert.equal(placements[0][3], 100);
  assert.equal(placements[0][5], 'REVERSAL_RESCUE');
  assert.ok(Math.abs(placements[0][4] - 0.25) < 1e-12);
  assert.equal(symState.reversalInventory.rescueUsed, false);
  assert.equal(symState.reversalInventory.rescueFilled, false);
});

test('an unfilled canceled rescue restores its slot and may be placed again', async () => {
  const symState = {
    orders: {},
    lastBuyByLevel: {},
    reversalInventory: {
      initializedAt: '2026-10-20T00:00:00.000Z',
      opposingSince: '2026-10-21T00:00:00.000Z',
      mode: 'RESCUE', grandfathered: false,
      rescueUsed: true, rescueFilled: false, rescueNotional: 20,
    },
  };
  const engine = reversalEngine(symState);
  let placements = 0;
  engine.placeReversalLimitOrder = async (...args) => {
    placements++;
    const order = { id: 'rescue-retry', amount: args[4], price: args[3] };
    symState.orders[order.id] = { ...order, kind: 'REVERSAL_RESCUE' };
    return order;
  };

  await engine.manageReversalInventory({
    symbol: 'TEST/USDT:USDT', symState,
    priceMomentumDecision: { available: true, direction: 'BEARISH' },
    currentPrice: 102, levels: [95, 100, 105],
    balance: { free: { USDT: 10 }, total: { USDT: 100 } },
    positions: [{ symbol: 'TEST/USDT:USDT', side: 'long', contracts: 1, unrealizedPnl: -2 }],
    managedOrders: [], now: Date.parse('2026-10-21T00:05:00.000Z'),
  });

  assert.equal(placements, 1);
  assert.equal(symState.reversalInventory.rescueUsed, false);
  assert.equal(symState.reversalInventory.rescueFilled, false);
  assert.equal(symState.reversalInventory.rescueOrderId, 'rescue-retry');
  assert.ok(symState.reversalInventory.lastRescueResetAt);
});

test('a rescue on another pair does not consume this pair rescue budget', async () => {
  const symState = {
    orders: {}, lastBuyByLevel: {},
    reversalInventory: {
      initializedAt: '2026-10-20T00:00:00.000Z',
      opposingSince: '2026-10-21T00:00:00.000Z',
      mode: 'RESCUE', grandfathered: false, rescueUsed: false,
    },
  };
  const engine = reversalEngine(symState);
  engine.state.data = { symbols: {
    TEST: symState,
    OTHER: { reversalInventory: { rescueFilled: true, rescueNotional: 25 } },
  } };
  const placements = [];
  engine.placeReversalLimitOrder = async (...args) => {
    placements.push(args);
    return { id: 'pair-rescue', amount: args[4], price: args[3] };
  };

  await engine.manageReversalInventory({
    symbol: 'TEST', symState,
    priceMomentumDecision: { available: true, direction: 'BEARISH' },
    currentPrice: 102, levels: [95, 100, 105],
    balance: { free: { USDT: 10 }, total: { USDT: 100 } },
    positions: [{ symbol: 'TEST', side: 'long', contracts: 1, unrealizedPnl: -2 }],
    managedOrders: [], now: Date.parse('2026-10-21T00:05:00.000Z'),
  });

  assert.equal(placements.length, 1);
  assert.ok(Math.abs(placements[0][4] * placements[0][3] - 25) < 1e-12);
  assert.equal(symState.reversalInventory.rescueWaitReason, null);
});

test('a per-pair rescue budget below exchange minimum waits without placing an order', async () => {
  const symState = {
    orders: {}, lastBuyByLevel: {},
    reversalInventory: {
      initializedAt: '2026-10-20T00:00:00.000Z',
      opposingSince: '2026-10-21T00:00:00.000Z',
      mode: 'RESCUE', grandfathered: false, rescueUsed: false,
    },
  };
  const engine = reversalEngine(symState);
  engine.getMinCost = () => 0;
  engine.getMinAmount = () => 1;
  engine.state.data = { symbols: {
    TEST: symState,
    OTHER: { reversalInventory: { rescueFilled: true, rescueNotional: 24.95 } },
  } };
  let placements = 0;
  engine.placeReversalLimitOrder = async () => { placements++; };

  await engine.manageReversalInventory({
    symbol: 'TEST', symState,
    priceMomentumDecision: { available: true, direction: 'BEARISH' },
    currentPrice: 102, levels: [95, 100, 105],
    balance: { free: { USDT: 10 }, total: { USDT: 100 } },
    positions: [{ symbol: 'TEST', side: 'long', contracts: 1, unrealizedPnl: -2 }],
    managedOrders: [], now: Date.parse('2026-10-21T00:05:00.000Z'),
  });

  assert.equal(placements, 0);
  assert.equal(symState.reversalInventory.rescueWaitReason, 'BELOW_MINIMUM_ORDER');
});

test('stale opposing inventory places a profit-funded partial Fibonacci exit', async () => {
  const symState = {
    orders: { normal: { id: 'normal', side: 'sell', kind: null } },
    lastBuyByLevel: {
      1: { sellableAmount: 2, totalCostQuote: 220, totalFeeQuote: 0.04 },
    },
    realizedGridProfit: 5.05,
    realizedExitProfit: 0,
    fundingProfit: 0,
    reversalInventory: {
      initializedAt: '2026-10-19T00:00:00.000Z',
      opposingSince: '2026-10-20T00:00:00.000Z',
      mode: 'RESCUE',
      grandfathered: false,
      rescueUsed: true,
    },
  };
  const engine = reversalEngine(symState);
  let cancelled = false;
  const placements = [];
  engine.cancelReversalOrder = async () => false;
  engine.cancelOrdersForProfitBankExit = async () => { cancelled = true; };
  engine.placeReversalLimitOrder = async (...args) => {
    placements.push(args);
    return { id: 'bank-1', amount: args[4], price: args[3] };
  };
  engine.exchange = { amountToPrecision: (_symbol, amount) => amount.toFixed(4) };

  const result = await engine.manageReversalInventory({
    symbol: 'TEST/USDT:USDT',
    symState,
    priceMomentumDecision: { available: true, direction: 'BEARISH' },
    currentPrice: 102,
    levels: [95, 100, 105],
    balance: { free: { USDT: 10 }, total: { USDT: 100 } },
    positions: [{ symbol: 'TEST/USDT:USDT', side: 'long', contracts: 2, unrealizedPnl: -10 }],
    managedOrders: [{ id: 'normal', side: 'sell', price: 115 }],
    now: Date.parse('2026-10-21T01:00:00.000Z'),
  });

  const placement = placements[0];
  assert.equal(cancelled, true);
  assert.equal(result.exclusive, true);
  assert.equal(placements.length, 1);
  assert.equal(placement[2], 2);
  assert.equal(placement[3], 105);
  assert.equal(placement[5], 'REVERSAL_BANK_EXIT');
  assert.ok(placement[4] > 0 && placement[4] < 2);
  assert.equal(symState.reversalInventory.bankExitOrderId, 'bank-1');
});
