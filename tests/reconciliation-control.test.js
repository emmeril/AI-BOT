const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STOP_TRADING = 'true';
process.env.GRID_MODE = 'ARITHMETIC';
process.env.GRID_COUNT = '10';

const { SpotGridEngine } = require('../index');

test('trade pagination hold keeps lastTradeTimestamp unchanged in caller', async () => {
  const timestamp = 12345;
  const trades = Array.from({ length: 100 }, (_, index) => ({
    id: `t${index}`,
    order: `o${index}`,
    timestamp,
    side: 'rebate',
    info: { clientOrderId: `grid-btcusdt-b-1-${index}` },
  }));
  let saves = 0;
  const symState = {
    orders: {},
    lastTradeTimestamp: timestamp,
  };
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    fetchMyTrades: async () => trades,
    fetchOpenOrders: async () => [],
  };
  engine.state = {
    getSymbol: () => symState,
    processedTrade: () => true,
    save: async () => { saves++; },
  };
  engine.getQuoteAsset = () => 'USDT';
  engine.getBaseAsset = () => 'BTC';
  engine.cacheFeeTokenPrice = async () => {};

  await engine.handleFilledTrades('BTC/USDT', [90, 100, 110]);

  assert.equal(symState.lastTradeTimestamp, timestamp);
  assert.equal(saves, 0);
});

test('STOP_TRADING still allows executeCycle to reconcile symbols', async () => {
  const engine = Object.create(SpotGridEngine.prototype);
  let reconciled = 0;
  engine.isRunning = false;
  engine.circuitBreaker = { errors: 0, pausedUntil: 0 };
  engine.circuitAllows = () => true;
  engine.reconcileSymbol = async () => {
    reconciled++;
  };

  await engine.executeCycle();

  assert.ok(reconciled > 0);
  assert.equal(engine.isRunning, false);
});

test('paused symbol reconciliation handles fills without fetching range context', async () => {
  const engine = Object.create(SpotGridEngine.prototype);
  let handled = false;
  engine.exchange = {
    fetchOpenOrders: async () => [{ id: 'open-1' }],
    fetchTicker: async () => {
      throw new Error('paused reconciliation should not fetch ticker');
    },
  };
  engine.handleFilledTrades = async (symbol, levels, openOrders) => {
    assert.equal(symbol, 'BTC/USDT');
    assert.deepEqual(levels, []);
    assert.deepEqual(openOrders, [{ id: 'open-1' }]);
    handled = true;
  };

  await engine.reconcileSymbolUnlocked('BTC/USDT');

  assert.equal(handled, true);
});

test('multiple fills from one closed spot order retain order metadata for the full batch', async () => {
  const symState = {
    orders: { order1: { side: 'buy', levelIndex: 2, refillCount: 1 } },
    lastTradeTimestamp: 0,
  };
  const seenLevels = [];
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    fetchMyTrades: async () => [
      { id: 't1', order: 'order1', timestamp: 1, side: 'buy' },
      { id: 't2', order: 'order1', timestamp: 2, side: 'buy' },
    ],
    fetchOpenOrders: async () => [],
  };
  engine.state = {
    getSymbol: () => symState,
    processedTrade: () => false,
    save: async () => {},
  };
  engine.getQuoteAsset = () => 'USDT';
  engine.getBaseAsset = () => 'BTC';
  engine.cacheFeeTokenPrice = async () => {};
  engine.handleBuyFill = async (_symbol, _levels, state, trade, meta) => {
    seenLevels.push(meta.levelIndex);
    delete state.orders[String(trade.order)];
  };
  engine.syncManagedOrdersWithExchange = async () => {};

  await engine.handleFilledTrades('BTC/USDT', [90, 100, 110]);

  assert.deepEqual(seenLevels, [2, 2]);
});

test('spot keeps a missing closed order until its delayed fill is reconciled', async () => {
  const symState = {
    orders: { 'closed-1': { id: 'closed-1', side: 'buy', levelIndex: 2 } },
  };
  let saves = 0;
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    fetchOrder: async () => ({ id: 'closed-1', status: 'closed', filled: 1 }),
  };
  engine.state = { save: async () => { saves++; } };

  await engine.syncManagedOrdersWithExchange('BTC/USDT', symState, new Set());

  assert.ok(symState.orders['closed-1']);
  assert.equal(saves, 0);
});

test('spot removes a missing explicitly canceled order', async () => {
  const symState = {
    orders: { 'canceled-1': { id: 'canceled-1', side: 'buy', levelIndex: 2 } },
  };
  const engine = Object.create(SpotGridEngine.prototype);
  engine.exchange = {
    fetchOrder: async () => ({ id: 'canceled-1', status: 'canceled' }),
  };
  engine.state = { save: async () => {} };

  await engine.syncManagedOrdersWithExchange('BTC/USDT', symState, new Set());

  assert.equal(symState.orders['canceled-1'], undefined);
});

test('spot range reset reconciles pending fills before cancelling old orders', async () => {
  const events = [];
  const engine = Object.create(SpotGridEngine.prototype);
  const symState = {
    config: { lower: 90, upper: 110 },
    orders: { 'sell-1': { id: 'sell-1', side: 'sell', levelIndex: 2 } },
    lastBuyByLevel: { 1: { price: 100, amount: 1, sellableAmount: 1 } },
    refillCountByLevel: { 1: 0 },
    rangeTransition: null,
  };
  engine.exchange = { fetchMyTrades: async () => [], fetchOpenOrders: async () => [] };
  engine.state = { getSymbol: () => symState, save: async () => {} };
  engine.buildLevels = () => [90, 100, 110];
  engine.assertLevelsAreDistinct = () => {};
  engine.cancelGridOrders = async () => { events.push('cancel'); return { failed: [] }; };
  engine.handleFilledTrades = async (_symbol, levels, openOrders) => {
    assert.deepEqual(levels, []);
    assert.deepEqual(openOrders, []);
    events.push('fills');
  };
  engine.getLevelIndex = () => 1;
  engine.mergeBuyRecords = (existing, incoming) => existing || incoming;
  engine.effectiveRangeBoundsEqual = () => false;
  engine.formatPrice = value => String(value);
  engine.sendAlert = async () => {};
  engine.formatTelegramMessage = title => title;

  await engine.remapStateAfterRangeReset('BTC/USDT', 90, 110, 80, 120);

  assert.deepEqual(events, ['fills', 'cancel', 'fills']);
});

test('spot sends an unreconciled alert when a SELL fill has no buy record', async () => {
  const engine = Object.create(SpotGridEngine.prototype);
  const symState = { orders: {}, lastBuyByLevel: {} };
  let alert = '';
  engine.state = {
    markProcessedTradeLocal: () => { throw new Error('unreconciled sell must not be marked processed'); },
    save: async () => {},
  };
  engine.sendAlert = async message => { alert = message; };
  engine.formatTelegramMessage = title => title;
  engine.formatPrice = String;
  engine.formatAmount = String;

  await engine.handleSellFill(
    'BTC/USDT',
    [],
    symState,
    { id: 'sell-1', order: 'order-1', price: 101, amount: 1 },
    { levelIndex: 2, sourceBuyLevelIndex: 1 },
    new Set()
  );

  assert.equal(alert, 'SPOT SELL FILLED - UNRECONCILED');
  assert.ok(symState.unreconciledSells['sell-1']);
});

test('spot retries an unreconciled sell with the active grid levels', async () => {
  const engine = Object.create(SpotGridEngine.prototype);
  const symState = {
    orders: {},
    unreconciledSells: {
      'sell-1': {
        trade: { id: 'sell-1', order: 'order-1', timestamp: 1, price: 110, amount: 1, side: 'sell' },
        orderMeta: { levelIndex: 2, sourceBuyLevelIndex: 1, refillCount: 0 },
      },
    },
  };
  let seenLevels;
  engine.handleSellFill = async (_symbol, levels) => { seenLevels = levels; delete symState.unreconciledSells['sell-1']; };

  await engine.retryUnreconciledSells('BTC/USDT', [90, 100, 110], symState, new Set());

  assert.deepEqual(seenLevels, [90, 100, 110]);
  assert.deepEqual(symState.unreconciledSells, {});
});
