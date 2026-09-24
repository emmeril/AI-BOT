const test = require('node:test');
const assert = require('node:assert/strict');
const { sellFillMessage, sellOverview, signedUsdt, sellEntryLabel } = require('../src/futures-display');

test('profitable grid pair cannot hide an actual losing Binance close in the notification', () => {
  const message = sellFillMessage({ symbol: 'TEST/USDT:USDT', price: 92, amount: 1, realizedPnl: '-3', fee: 0.1, gridProfit: 2 });
  assert.match(message, /PnL setelah fee: -3,1 USDT/);
  assert.match(message, /Grid: \+2 USDT/);
  assert.match(message, /Tutup di bawah entry rata-rata/);
});

test('unknown PnL stays unknown; zero and fee-driven loss are represented accurately', () => {
  assert.equal(signedUsdt(null), 'belum tersedia');
  assert.match(sellFillMessage({ fee: 0.1, realizedPnl: undefined }), /PnL setelah fee: belum tersedia/);
  const message = sellFillMessage({ fee: 0.1, realizedPnl: '0.05' });
  assert.match(message, /PnL setelah fee: -0,05 USDT/);
  assert.doesNotMatch(message, /Tutup di bawah entry rata-rata/);
  assert.equal(sellEntryLabel(95, 95), 'Sama dengan entry rata-rata');
  assert.equal(sellEntryLabel(92, null), 'Entry belum tersedia');
});

test('SELL summary compares actual pending targets against current average entry', () => {
  const summary = sellOverview([
    { side: 'buy', price: 80 }, { side: 'sell', price: 98 }, { side: 'sell', price: 92 },
  ], { entryPrice: 95 });
  assert.equal(summary.nearestPrice, 92);
  assert.equal(summary.belowEntryCount, 1);
  assert.equal(summary.nearestLabel, 'Di bawah entry rata-rata');
  assert.equal(sellOverview([], null).nearestPrice, null);
  assert.equal(sellOverview([], null).belowEntryCount, null);
});
