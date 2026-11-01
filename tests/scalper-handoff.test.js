const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { canActivateHandoff, protectionPrices } = require('../src/scalper-handoff');
const { formatScalperMessage, scalperProtectionSnapshot } = require('../src/scalper-telegram');
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

test('Telegram kill switch pauses new scalper entries without disabling position management', () => {
  const killSwitchPath = `/tmp/ai-bot-scalper-pause-${process.pid}.flag`;
  try { fs.unlinkSync(killSwitchPath); } catch {}
  const engine = new FuturesScalperEngine({
    exchange: {},
    notifier: { send: async () => {} },
    environment: {
      SYMBOLS: 'DOGE/USDT:USDT',
      KILL_SWITCH_ENABLED: 'true',
      KILL_SWITCH_FILE: killSwitchPath,
      SCALPER_TRADING_ENABLED: 'true',
      SCALPER_STATE_FILE: `/tmp/ai-bot-scalper-pause-state-${process.pid}.json`,
    },
  });
  assert.equal(engine.canEnterNewPositions(), true);
  fs.writeFileSync(killSwitchPath, 'paused\n');
  assert.equal(engine.canEnterNewPositions(), false);
  assert.match(engine.pauseReason(), /kill switch/i);
  fs.unlinkSync(killSwitchPath);
  assert.equal(engine.canEnterNewPositions(), true);
});

test('scalper protection snapshot requires both side-specific TP and SL', () => {
  const orders = [
    { algoId: '1', clientAlgoId: 'scalp-l-tp-a', positionSide: 'LONG', orderType: 'TAKE_PROFIT_MARKET', triggerPrice: '102', side: 'SELL', closePosition: 'true' },
    { algoId: '2', clientAlgoId: 'scalp-l-sl-a', positionSide: 'LONG', orderType: 'STOP_MARKET', triggerPrice: '99', side: 'SELL', closePosition: 'true' },
    { algoId: '3', clientAlgoId: 'scalp-s-sl-a', positionSide: 'SHORT', orderType: 'STOP_MARKET', triggerPrice: '101', side: 'BUY', closePosition: 'true' },
  ];
  const long = scalperProtectionSnapshot(orders, 'LONG', true);
  const short = scalperProtectionSnapshot(orders, 'SHORT', true);
  assert.equal(long.status, 'PROTECTED');
  assert.equal(long.takeProfit.triggerPrice, 102);
  assert.equal(long.stopLoss.triggerPrice, 99);
  assert.equal(short.status, 'INCOMPLETE');
});

test('scalper Telegram messages use a readable sectioned layout', () => {
  assert.equal(formatScalperMessage('SCALPER ENTRY', [
    ['Pair', 'DOGE/USDT:USDT'],
    ['Sisi', 'LONG'],
  ]), '[SCALPER ENTRY]\n\nPair: DOGE/USDT:USDT\nSisi: LONG');
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
