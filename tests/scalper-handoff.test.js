const test = require('node:test');
const assert = require('node:assert/strict');
const { canActivateHandoff, protectionPrices } = require('../src/scalper-handoff');
const {
  FuturesScalperEngine,
  buildConfig,
  positionForSide,
  targetNotional,
} = require('../src/futures-scalper-engine');

test('handoff activates only after all legacy positions and orders are gone', () => {
  assert.equal(canActivateHandoff({ positions: [], regularOrders: [], algoOrders: [] }), true);
  assert.equal(canActivateHandoff({ positions: [{ contracts: 1 }], regularOrders: [], algoOrders: [] }), false);
  assert.equal(canActivateHandoff({ positions: [], regularOrders: [{ id: '1' }], algoOrders: [] }), false);
});

test('SHORT protection places profit below entry and stop above entry', () => {
  assert.deepEqual(protectionPrices(100, { takeProfitPct: 2.5, stopLossPct: 1 }), {
    takeProfit: 97.5,
    stopLoss: 101,
  });
});

test('LONG protection places profit above entry and stop below entry', () => {
  assert.deepEqual(protectionPrices(100, { side: 'LONG', takeProfitPct: 2.5, stopLossPct: 1 }), {
    takeProfit: 102.5,
    stopLoss: 99,
  });
});

test('live config matches the selected walk-forward strategy', () => {
  const config = buildConfig({ SYMBOLS: 'A,B,C' });
  assert.equal(config.strategy.emaFast, 8);
  assert.equal(config.strategy.emaSlow, 21);
  assert.equal(config.strategy.entryMode, 'VOLUME_DELTA_REVERSAL');
  assert.equal(config.strategy.takeProfitPct, 2);
  assert.equal(config.strategy.stopLossPct, 1);
  assert.equal(config.strategy.maxHoldMinutes, 240);
  assert.equal(config.allocationPct, 70);
  assert.deepEqual(config.allocations, { LONG: 35, SHORT: 35 });
  assert.deepEqual(config.activeSides, ['LONG']);
});

test('directional live config enables both independently selected sides', () => {
  const config = buildConfig({
    SYMBOLS: 'A,B,C',
    SCALPER_LONG_ENABLED: 'true',
    SCALPER_SHORT_ENABLED: 'true',
    SCALPER_LONG_ALLOCATION_PCT: '35',
    SCALPER_SHORT_ALLOCATION_PCT: '35',
    SCALPER_TIMEFRAME: '15m',
  });
  assert.deepEqual(config.activeSides, ['LONG', 'SHORT']);
  assert.equal(config.timeframe, '15m');
  assert.equal(config.strategies.LONG.flowWindow, 1);
  assert.equal(config.strategies.LONG.momentumWindow, 16);
  assert.equal(config.strategies.SHORT.flowWindow, 4);
  assert.equal(config.strategies.SHORT.momentumWindow, 4);
  assert.equal(config.strategies.LONG.maxHoldMinutes, 240);
});

test('position lookup respects Hedge Mode side', () => {
  const positions = [
    { symbol: 'DOGE/USDT:USDT', side: 'long', contracts: 10 },
    { symbol: 'DOGE/USDT:USDT', side: 'short', contracts: 20 },
  ];
  assert.equal(positionForSide(positions, 'DOGE/USDT:USDT', 'SHORT').contracts, 20);
});

test('70 percent margin allocation is leveraged and divided equally across three pairs', () => {
  assert.equal(Number(targetNotional(100, 70, 5, 3).toFixed(6)), 116.666667);
});

test('LONG protection never cancels SHORT protection and uses sell exits', async () => {
  const canceled = [];
  const created = [];
  const exchange = {
    market: () => ({ id: 'DOGEUSDT' }),
    fapiPrivateGetOpenAlgoOrders: async () => [
      { algoId: 'long-stop', clientAlgoId: 'scalp-l-sl-old', positionSide: 'LONG' },
      { algoId: 'short-stop', clientAlgoId: 'scalp-s-sl-old', positionSide: 'SHORT' },
    ],
    fapiPrivateDeleteAlgoOrder: async order => canceled.push(order.algoId),
    priceToPrecision: (_symbol, price) => String(price),
    createOrder: async (...args) => {
      created.push(args);
      return { id: `algo-${created.length}` };
    },
  };
  const engine = new FuturesScalperEngine({
    exchange,
    environment: {
      SYMBOLS: 'DOGE/USDT:USDT',
      SCALPER_STATE_FILE: `/tmp/ai-bot-scalper-test-${process.pid}.json`,
    },
  });

  await engine.placeProtections('DOGE/USDT:USDT', { entryPrice: 100 }, 'LONG');

  assert.deepEqual(canceled, ['long-stop']);
  assert.equal(created.length, 2);
  assert.equal(created[0][2], 'sell');
  assert.equal(created[0][5].positionSide, 'LONG');
  assert.equal(created[0][5].stopLossPrice, '99');
  assert.equal(created[1][5].takeProfitPrice, '102');
});
