const test = require('node:test');
const assert = require('node:assert/strict');
const {
  marketAmountText,
  marketPrice,
  marketPriceText,
  normalizeOrder,
  precisionDigits,
} = require('../src/dashboard-server');
const { positionMetrics } = require('../src/futures-dashboard-server');

test('futures dashboard uses position margin and excludes open-order margin from ROI', () => {
  const result = positionMetrics({
    contracts: 2982,
    notional: '15.93130518',
    entryPrice: '0.005281',
    markPrice: '0.00534249',
    unrealizedPnl: '0.18336318',
    initialMargin: '13.68235164',
    info: { positionInitialMargin: '3.18626104', openOrderInitialMargin: '10.49609060' },
  }, 5, 0.00314958);

  assert.equal(result.positionMargin, 3.18626104);
  assert.equal(result.openPositionFees, 0.00314958);
  assert.ok(Math.abs(result.roiPct - 5.754) < 0.01);
});

test('dashboard market price follows Binance symbol precision', () => {
  const engine = {
    exchange: {
      priceToPrecision: (_symbol, value) => Number(value).toFixed(2),
      amountToPrecision: (_symbol, value) => Number(value).toFixed(4),
    },
  };

  assert.equal(marketPrice(engine, 'BTC/USDT', 65432.127), 65432.13);
  assert.equal(marketPriceText(engine, 'BTC/USDT', 65432.1), '65432.10');
  assert.equal(precisionDigits('65432.10'), 2);
  assert.equal(precisionDigits('2'), 0);
  assert.equal(marketAmountText(engine, 'BTC/USDT', 0.12), '0.1200');
});

test('dashboard order normalization uses exchange data and tracked grid level', () => {
  const engine = {
    getBotOrderLevel: () => null,
    exchange: {
      priceToPrecision: (_symbol, value) => Number(value).toFixed(2),
      amountToPrecision: (_symbol, value) => Number(value).toFixed(4),
    },
  };
  const result = normalizeOrder(engine, 'BTC/USDT', {
    id: 42,
    side: 'BUY',
    price: '100.50',
    amount: '0.2',
    filled: '0.05',
    remaining: '0.15',
    timestamp: 1234,
  }, { levelIndex: 3 });

  assert.deepEqual(result, {
    id: '42',
    symbol: 'BTC/USDT',
    side: 'buy',
    price: 100.5,
    priceText: '100.50',
    amount: 0.2,
    amountText: '0.2000',
    filled: 0.05,
    remaining: 0.15,
    remainingText: '0.1500',
    level: 3,
    timestamp: 1234,
  });
});
