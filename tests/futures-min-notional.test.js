const test = require('node:test');
const assert = require('node:assert/strict');
const ccxt = require('ccxt');
const { FuturesGridEngine } = require('../futures-grid');

test('minimum notional amount rounds up to the exchange amount step', () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.exchange = {
    precisionMode: ccxt.TICK_SIZE,
    markets: {
      'DOGE/USDT:USDT': {
        precision: { amount: 1, price: 0.00001 },
        limits: { cost: { min: 5 } },
      },
    },
    priceToPrecision: (_symbol, value) => Number(value).toFixed(5),
    amountToPrecision: (_symbol, value) => String(Math.floor(Number(value))),
  };

  const amount = engine.getMinimumAmountForCost('DOGE/USDT:USDT', 0.08024, 5);
  const precise = engine.getPreciseOrderNumbers('DOGE/USDT:USDT', 0.08024, amount);

  assert.equal(amount, 63);
  assert.ok(precise.notional >= 5);
});
