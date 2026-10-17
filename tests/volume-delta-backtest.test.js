const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VARIANTS,
  selectSideOnTraining,
} = require('../scripts/backtest-volume-delta');

test('side-specific selection excludes baseline and candidates with higher training drawdown', () => {
  const aggregate = {
    baseline: {
      LONG: { netLiquidationPnl: 10, sumOfPerSymbolMaximumDrawdowns: 5 },
      SHORT: { netLiquidationPnl: -5, sumOfPerSymbolMaximumDrawdowns: 20 },
    },
  };
  for (const variant of VARIANTS.slice(1)) {
    aggregate[variant.key] = {
      LONG: { netLiquidationPnl: -1, sumOfPerSymbolMaximumDrawdowns: 1 },
      SHORT: { netLiquidationPnl: -1, sumOfPerSymbolMaximumDrawdowns: 1 },
    };
  }
  aggregate[VARIANTS[1].key].LONG = {
    netLiquidationPnl: 4,
    sumOfPerSymbolMaximumDrawdowns: 4,
  };
  aggregate[VARIANTS[2].key].LONG = {
    netLiquidationPnl: 8,
    sumOfPerSymbolMaximumDrawdowns: 6,
  };
  assert.equal(selectSideOnTraining({ aggregate }, 'LONG'), VARIANTS[1].key);
});
