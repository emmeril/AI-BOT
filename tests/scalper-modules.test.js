'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { targetNotional, walletBalance } = require('../src/scalper/allocation');
const { buildScalperConfig } = require('../src/scalper/config');
const { buildDashboardView } = require('../src/scalper/dashboard-view');
const {
  algoPositionSide,
  scalperOrdersForSide,
  scalperProtectionSnapshot,
} = require('../src/scalper/order-inspection');
const { ScalperTelegramReports } = require('../src/scalper/telegram-reports');

const environment = {
  SYMBOLS: 'SHIB/USDT:USDT,BONK/USDT:USDT,DOGE/USDT:USDT',
  SCALPER_ENABLED: 'true',
  SCALPER_TRADING_ENABLED: 'true',
  SCALPER_LONG_ENABLED: 'true',
  SCALPER_SHORT_ENABLED: 'true',
  SCALPER_LONG_ALLOCATION_PCT: '35',
  SCALPER_SHORT_ALLOCATION_PCT: '35',
  SCALPER_TIMEFRAME: '15m',
  KILL_SWITCH_ENABLED: 'false',
};

test('scalper config owns all side and allocation settings', () => {
  const config = buildScalperConfig(environment);
  assert.deepEqual(config.activeSides, ['LONG', 'SHORT']);
  assert.deepEqual(config.allocations, { LONG: 35, SHORT: 35 });
  assert.equal(config.symbols.length, 3);
  assert.equal(config.strategies.LONG.momentumWindow, 16);
  assert.equal(config.strategies.SHORT.momentumWindow, 4);
  assert.equal(config.aiSignal.liveEnabled, false);
});

test('scalper config enables the validated AI entry feed explicitly', () => {
  const config = buildScalperConfig({
    ...environment,
    AI_SIGNAL_LIVE_ENABLED: 'true',
    AI_SIGNAL_MIN_CONFIDENCE: '70',
    AI_SIGNAL_MAX_AGE_MS: '3600000',
  });
  assert.equal(config.aiSignal.liveEnabled, true);
  assert.equal(config.aiSignal.minimumConfidence, 70);
  assert.equal(config.aiSignal.maximumAgeMs, 3600000);
});

test('allocation module divides leveraged wallet margin across pairs', () => {
  const wallet = walletBalance({ info: { totalWalletBalance: '100' } });
  assert.equal(wallet, 100);
  assert.equal(Number(targetNotional(wallet, 35, 5, 3).toFixed(6)), 58.333333);
});

test('order inspection identifies sides from client IDs without exchange metadata', () => {
  const orders = [
    { clientAlgoId: 'scalp-l-tp-a', orderType: 'TAKE_PROFIT_MARKET', triggerPrice: '102' },
    { clientAlgoId: 'scalp-l-sl-a', orderType: 'STOP_MARKET', triggerPrice: '99' },
    { clientAlgoId: 'scalp-s-sl-a', orderType: 'STOP_MARKET', triggerPrice: '101' },
  ];
  assert.equal(algoPositionSide(orders[0]), 'LONG');
  assert.equal(scalperOrdersForSide(orders, 'LONG').length, 2);
  assert.equal(scalperProtectionSnapshot(orders, 'LONG', true).status, 'PROTECTED');
  assert.equal(scalperProtectionSnapshot(orders, 'SHORT', true).status, 'INCOMPLETE');
});

test('dashboard view maps scalper state without legacy dashboard dependencies', () => {
  const view = buildDashboardView({
    environment,
    positionSide: 'LONG',
    symbolState: {
      handoffActive: true,
      signals: { LONG: { available: true, allow: false } },
      positions: { LONG: null },
    },
    rawPosition: null,
    algoOrderResult: { available: true, orders: [], error: null },
    longSymbols: ['SHIB/USDT:USDT', 'BONK/USDT:USDT', 'DOGE/USDT:USDT'],
    shortSymbols: ['SHIB/USDT:USDT', 'BONK/USDT:USDT', 'DOGE/USDT:USDT'],
  });
  assert.equal(view.tradingEnabled, true);
  assert.equal(view.snapshot.phase, 'READY');
  assert.equal(view.snapshot.pairCount, 3);
  assert.equal(view.snapshot.protection.status, 'NOT_REQUIRED');
  assert.deepEqual(view.displayedOrders, []);
});

test('Telegram reports render both sides and conditional protection orders', async () => {
  const algoOrders = [
    { algoId: '1', clientAlgoId: 'scalp-l-tp-a', positionSide: 'LONG', orderType: 'TAKE_PROFIT_MARKET', triggerPrice: '102', side: 'SELL' },
    { algoId: '2', clientAlgoId: 'scalp-l-sl-a', positionSide: 'LONG', orderType: 'STOP_MARKET', triggerPrice: '99', side: 'SELL' },
  ];
  const exchange = {
    fetchPositions: async () => [{
      symbol: 'SHIB/USDT:USDT',
      side: 'long',
      contracts: 10,
      entryPrice: 100,
      unrealizedPnl: 1.5,
    }],
    fetchOpenOrders: async () => [],
    market: symbol => ({ id: symbol.replace(/[^A-Z]/g, '') }),
    fapiPrivateGetOpenAlgoOrders: async () => algoOrders,
  };
  const reports = new ScalperTelegramReports({
    exchange,
    environment: { ...environment, SYMBOLS: 'SHIB/USDT:USDT' },
    stateLoader: () => ({
      symbols: {
        'SHIB/USDT:USDT': {
          handoffActive: true,
          signals: { LONG: { available: true, allow: true }, SHORT: { available: true, allow: false } },
        },
      },
    }),
  });
  const status = await reports.status();
  const orders = await reports.orders();
  assert.match(status, /Sisi: LONG \+ SHORT/);
  assert.match(status, /TP\/SL LONG: LENGKAP/);
  assert.match(orders, /LONG TAKE_PROFIT: 102/);
  assert.match(orders, /LONG STOP_LOSS: 99/);
});
