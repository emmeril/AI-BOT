'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FuturesGridEngine } = require('../futures-grid');

function createEngine({ minCost = 1, profitableAt = 100.4 } = {}) {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.sellTargetWarnings = new Set();
  engine.exchange = {
    priceToPrecision: (_symbol, price) => Number(price).toFixed(2),
    amountToPrecision: (_symbol, amount) => Number(amount).toFixed(4),
  };
  engine.getMinCost = () => minCost;
  engine.isTrackedSellProfitable = (_symbol, _buy, price) => price >= profitableAt;
  return engine;
}

test('futures sell target skips an adjacent level below required profit', () => {
  const engine = createEngine();
  const target = engine.findSellTargetForBuy(
    'TEST/USDT:USDT',
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

test('different futures buy levels may share the same profitable sell target', () => {
  const engine = createEngine({ profitableAt: 100.5 });
  const levels = [100, 100.2, 100.5, 101];
  const first = engine.findSellTargetForBuy(
    'TEST/USDT:USDT',
    levels,
    0,
    { amount: 1, sellableAmount: 1, totalCostQuote: 100, totalFeeQuote: 0 }
  );
  const second = engine.findSellTargetForBuy(
    'TEST/USDT:USDT',
    levels,
    1,
    { amount: 1, sellableAmount: 1, totalCostQuote: 100.2, totalFeeQuote: 0 }
  );

  assert.equal(first.sellLevelIndex, 2);
  assert.equal(second.sellLevelIndex, 2);
  assert.equal(first.sellPrice, 100.5);
  assert.equal(second.sellPrice, 100.5);
});

test('same-target futures sells remain unique per source buy level', () => {
  const engine = createEngine();
  const symState = {
    orders: {
      sellA: { id: 'sellA', side: 'sell', levelIndex: 2, sourceBuyLevelIndex: 0 },
      sellB: { id: 'sellB', side: 'sell', levelIndex: 2, sourceBuyLevelIndex: 1 },
    },
  };

  assert.equal(engine.getActiveSellOrderForBuyLevel(symState, 0).id, 'sellA');
  assert.equal(engine.getActiveSellOrderForBuyLevel(symState, 1).id, 'sellB');
  assert.equal(engine.getActiveSellOrderForBuyLevel(symState, 2), null);
});

test('futures tracked SELL is placed even above the internal sell warning threshold', async () => {
  const engine = createEngine();
  const orders = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
    `sell-${index}`,
    { id: `sell-${index}`, side: 'sell', levelIndex: 2, sourceBuyLevelIndex: index + 10 },
  ]));
  engine.state = { getSymbol: () => ({ orders }) };
  let placement;
  engine.placeLimit = async (...args) => {
    placement = args;
    return { id: 'priority-sell' };
  };

  const order = await engine.placeExitLimit(
    'TEST/USDT:USDT', 2, 100.5, 1,
    { refillCount: 1, sourceBuyLevelIndex: 0, referencePrice: 100.25 }
  );

  assert.equal(order.id, 'priority-sell');
  assert.deepEqual(placement, [
    'TEST/USDT:USDT', 'sell', 2, 100.5, 1,
    { refillCount: 1, sourceBuyLevelIndex: 0 },
  ]);
});

test('futures priority SELL frees a BUY slot and retries on exchange order limit', async () => {
  const engine = createEngine();
  engine.state = { getSymbol: () => ({ orders: {} }) };
  let attempts = 0;
  engine.placeLimit = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('-2025 MAX_OPEN_ORDER_EXCEEDED'), { code: -2025 });
    return { id: 'priority-sell' };
  };
  let referencePrice;
  engine.cancelFarthestBuyForExit = async (_symbol, price) => {
    referencePrice = price;
    return true;
  };

  const order = await engine.placeExitLimit(
    'TEST/USDT:USDT', 2, 100.5, 1,
    { sourceBuyLevelIndex: 0, referencePrice: 100.25 }
  );

  assert.equal(order.id, 'priority-sell');
  assert.equal(attempts, 2);
  assert.equal(referencePrice, 100.25);
});

test('futures max-order errors are recognized before generic InvalidOrder handling', () => {
  const engine = createEngine();
  const error = Object.assign(new Error('MAX_OPEN_ORDER_EXCEEDED'), {
    name: 'InvalidOrder',
    code: -2025,
  });

  assert.equal(engine.isMaxOpenOrdersError(error), true);
  assert.equal(engine.isInvalidOrderAmountError(error), true);
});

test('futures BUY yields capacity while SELL propagates the exchange order-limit error', async () => {
  const engine = createEngine();
  engine.pendingOrderLevels = new Set();
  engine.createFuturesLimitOrder = async () => {
    throw Object.assign(new Error('-2025 MAX_OPEN_ORDER_EXCEEDED'), {
      name: 'InvalidOrder',
      code: -2025,
    });
  };

  assert.equal(await engine.placeLimit('TEST/USDT:USDT', 'buy', 0, 100, 1), null);
  await assert.rejects(
    engine.placeLimit(
      'TEST/USDT:USDT', 'sell', 1, 101, 1,
      { sourceBuyLevelIndex: 0 }
    ),
    /MAX_OPEN_ORDER_EXCEEDED/
  );
  assert.equal(engine.pendingOrderLevels.size, 0);
});

test('futures unreserved LONG amount subtracts remaining active SELL quantities', () => {
  const engine = createEngine();
  const reserved = engine.getReservedSellAmount([
    { side: 'sell', amount: 5, filled: 2, remaining: 3 },
    { side: 'sell', amount: 4, filled: 1 },
    { side: 'buy', amount: 100, remaining: 100 },
  ]);

  assert.equal(reserved, 6);
});

test('futures exit priority cancels the farthest managed BUY first', async () => {
  const engine = createEngine();
  const openOrders = [
    { id: 'near-buy', side: 'buy', price: 95 },
    { id: 'far-buy', side: 'buy', price: 70 },
    { id: 'sell', side: 'sell', price: 110 },
  ];
  engine.exchange.fetchOpenOrders = async () => openOrders;
  engine.getManagedOpenOrders = async () => openOrders;
  let cancelled;
  engine.cancelOrder = async (_symbol, order) => { cancelled = order.id; };

  assert.equal(await engine.cancelFarthestBuyForExit('TEST/USDT:USDT', 100), true);
  assert.equal(cancelled, 'far-buy');
});

test('futures client order metadata preserves explicit source buy level', () => {
  const engine = createEngine();
  const clientOrderId = engine.makeClientOrderId('BTC/USDT:USDT', 'sell', 5, 2, 1);
  const meta = engine.getBotOrderMeta({ clientOrderId });

  assert.equal(meta.side, 'sell');
  assert.equal(meta.levelIndex, 5);
  assert.equal(meta.sourceBuyLevelIndex, 1);
  assert.equal(meta.refillCount, 2);
  assert.equal(engine.getSellSourceBuyLevelIndex(meta), 1);
});

test('legacy futures sell metadata falls back to adjacent buy level', () => {
  const engine = createEngine();
  const meta = engine.getBotOrderMeta({
    clientOrderId: 'grid-btcusdtusd-s-5-r2-legacy',
  });

  assert.equal(meta.sourceBuyLevelIndex, undefined);
  assert.equal(engine.getSellSourceBuyLevelIndex(meta), 4);
});
