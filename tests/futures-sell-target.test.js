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
