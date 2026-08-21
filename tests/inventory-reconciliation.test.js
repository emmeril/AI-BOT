const test = require('node:test');
const assert = require('node:assert/strict');

const {
  replayFifoInventory,
  summarizeTrackedInventory,
  calculateInventoryRecovery,
} = require('../src/inventory-reconciliation');

test('FIFO replay accounts for base buy fees and remaining cost basis', () => {
  const replayed = replayFifoInventory([
    { timestamp: 1, side: 'buy', amount: 100, price: 2, fee: { currency: 'COIN', cost: 1 } },
    { timestamp: 2, side: 'buy', amount: 50, price: 3, fee: { currency: 'USDT', cost: 0.15 } },
    { timestamp: 3, side: 'sell', amount: 110, price: 4, fee: { currency: 'USDT', cost: 0.44 } },
  ], 'COIN', 'USDT');

  assert.equal(replayed.sellableAmount, 39);
  assert.ok(Math.abs(replayed.totalCostQuote - 117.117) < 1e-9);
});

test('recovery subtracts inventory already represented in grid state', () => {
  const tracked = summarizeTrackedInventory({
    lastBuyByLevel: {
      2: { sellableAmount: 20, totalCostQuote: 50, totalFeeQuote: 1 },
    },
  });
  const recovery = calculateInventoryRecovery(
    { sellableAmount: 30, totalCostQuote: 80 },
    tracked
  );

  assert.deepEqual(recovery, { sellableAmount: 10, totalCostQuote: 29, averagePrice: 2.9 });
});

test('recovery refuses state that exceeds reconstructed inventory', () => {
  assert.throws(
    () => calculateInventoryRecovery(
      { sellableAmount: 10, totalCostQuote: 20 },
      { sellableAmount: 11, totalCostQuote: 20 }
    ),
    /Tracked inventory exceeds/
  );
});
