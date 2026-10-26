process.env.FUTURES_POSITION_SIDE = 'SHORT';
process.env.SYMBOLS = 'TEST/USDT:USDT';
process.env.LEVERAGE = '5';
process.env.FUTURES_ENTRY_ENABLED = 'true';
process.env.FUTURES_DYNAMIC_EXPOSURE_ENABLED = 'true';
process.env.FUTURES_DYNAMIC_EXPOSURE_SIDE_PCT = '35';
process.env.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_ENABLED = 'true';
process.env.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_START_PCT = '10';
process.env.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_STEP_PCT = '5';
process.env.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_RESERVED_MARGIN_PCT = '30';
process.env.FUTURES_DYNAMIC_EXPOSURE_AUTO_RAMP_CONFIRMATIONS = '3';
process.env.REVERSAL_INVENTORY_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FuturesGridEngine } = require('../futures-grid');

test('SHORT exposure promotes from 10 to 15 percent after three safe refreshes', async () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.entryGridEnabled = true;
  engine.exposureLimits = { symbol: 50, total: 50 };
  engine.exposureBudgetLastCheckedAt = 0;
  engine.exposureBudgetReferenceWalletBalance = 100;
  engine.state = {
    data: {
      exposureBudget: {
        sidePct: 10,
        pairCount: 1,
        leverage: 5,
        autoRampPromotionConfirmations: 0,
      },
    },
    save: async () => {},
  };
  engine.exchange = {
    fetchBalance: async () => ({ info: { totalWalletBalance: '100' } }),
    fetchOpenOrders: async () => [],
    fetchPositions: async () => [{
      symbol: 'TEST/USDT:USDT',
      side: 'long',
      contracts: 1,
      contractSize: 1,
      entryPrice: 275,
      markPrice: 275,
    }],
  };

  await engine.refreshExposureLimits({ force: true });
  assert.equal(engine.state.data.exposureBudget.sidePct, 10);
  assert.equal(engine.state.data.exposureBudget.autoRampPromotionConfirmations, 1);
  await engine.refreshExposureLimits({ force: true });
  assert.equal(engine.state.data.exposureBudget.sidePct, 10);
  assert.equal(engine.state.data.exposureBudget.autoRampPromotionConfirmations, 2);
  await engine.refreshExposureLimits({ force: true });
  assert.equal(engine.state.data.exposureBudget.sidePct, 15);
  assert.equal(engine.state.data.exposureBudget.autoRampAction, 'PROMOTED');
  assert.deepEqual(engine.exposureLimits, { symbol: 75, total: 75 });
});
