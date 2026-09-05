const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STOP_TRADING = 'true';
process.env.GRID_MODE = 'ARITHMETIC';
process.env.GRID_COUNT = '4';
process.env.GRID_STATE_FILE = '/dev/null/grid-state-futures.json';

const { FuturesGridEngine, GridState } = require('../futures-grid');

test('futures state persistence errors propagate to the trading cycle', async () => {
  const state = Object.create(GridState.prototype);
  state.data = GridState.createEmpty();
  await assert.rejects(state.save(), /ENOTDIR|not a directory/i);
});

test('futures refuses startup when the state path is unreadable', () => {
  assert.throws(() => new GridState(), /Cannot load grid state/);
});

test('futures state normalizes per-symbol fill counters', () => {
  const state = Object.create(GridState.prototype);
  state.data = GridState.normalize({
    symbols: { 'BTC/USDT:USDT': { filledBuys: '4', filledSells: null } },
  });

  const symbol = state.getSymbol('BTC/USDT:USDT');

  assert.equal(symbol.filledBuys, 4);
  assert.equal(symbol.filledSells, 0);
});

test('STOP_TRADING still allows futures executeCycle to reconcile symbols', async () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  let reconciled = 0;
  engine.isRunning = false;
  engine.circuitBreaker = { errors: 0, pausedUntil: 0 };
  engine.circuitAllows = () => true;
  engine.reconcileSymbol = async () => { reconciled++; };

  await engine.executeCycle();

  assert.ok(reconciled > 0);
  assert.equal(engine.isRunning, false);
});

test('initial futures trade reconciliation omits zero since watermark', async () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  const calls = [];
  engine.exchange = {
    fetchMyTrades: async (_symbol, since) => {
      calls.push(since);
      return since === undefined ? [{ id: 'fill-1', timestamp: 12345 }] : [];
    },
  };

  const result = await engine.fetchNewTrades('BTC/USDT:USDT', { lastTradeTimestamp: 0 });

  assert.deepEqual(calls, [undefined]);
  assert.equal(result.trades.length, 1);
});

test('futures fill recovery fetches the closed order when trade metadata lacks client order id', async () => {
  const symState = { orders: {}, lastTradeTimestamp: 0 };
  const engine = Object.create(FuturesGridEngine.prototype);
  let recoveredLevel = null;
  engine.exchange = {
    fetchOpenOrders: async () => [],
    fetchOrder: async (orderId, symbol) => {
      assert.equal(orderId, 'closed-order-1');
      assert.equal(symbol, 'BTC/USDT:USDT');
      return { clientOrderId: 'grid-btcusdt-b-9-r0-recovery' };
    },
  };
  engine.state = {
    getSymbol: () => symState,
    processedTrade: () => false,
    save: async () => {},
  };
  engine.fetchNewTrades = async () => ({
    trades: [{ id: 'fill-1', order: 'closed-order-1', timestamp: 12345, side: 'buy', info: {} }],
    holdWatermark: false,
  });
  engine.getQuoteAsset = () => 'USDT';
  engine.getBaseAsset = () => 'BTC';
  engine.cacheFeeTokenPrice = async () => {};
  engine.handleBuyFill = async (_symbol, _levels, _state, _trade, orderMeta) => {
    recoveredLevel = orderMeta.levelIndex;
  };
  engine.syncManagedOrdersWithExchange = async () => {};

  await engine.handleFilledTrades('BTC/USDT:USDT', [90, 100, 110], []);

  assert.equal(recoveredLevel, 9);
  assert.equal(symState.lastTradeTimestamp, 12345);
});

test('paused futures reconciliation syncs fills and funding without fetching range context', async () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  let handledFills = false;
  let handledFunding = false;
  engine.exchange = {
    fetchOpenOrders: async () => [{ id: 'open-1' }],
    fetchTicker: async () => {
      throw new Error('paused reconciliation should not fetch ticker');
    },
  };
  engine.handleFilledTrades = async (symbol, levels, openOrders) => {
    assert.equal(symbol, 'BTC/USDT:USDT');
    assert.deepEqual(levels, []);
    assert.deepEqual(openOrders, [{ id: 'open-1' }]);
    handledFills = true;
  };
  engine.syncFundingHistory = async symbol => {
    assert.equal(symbol, 'BTC/USDT:USDT');
    handledFunding = true;
  };

  await engine.reconcileSymbolUnlocked('BTC/USDT:USDT');

  assert.equal(handledFills, true);
  assert.equal(handledFunding, true);
});

test('futures trade pagination hold does not advance the watermark', async () => {
  const timestamp = 12345;
  const trades = Array.from({ length: 100 }, (_, index) => ({
    id: `t${index}`,
    order: `o${index}`,
    timestamp,
    side: 'buy',
  }));
  let saves = 0;
  const symState = { orders: {}, lastTradeTimestamp: timestamp };
  const engine = Object.create(FuturesGridEngine.prototype);
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

  await engine.handleFilledTrades('BTC/USDT:USDT', [90, 100, 110]);

  assert.equal(symState.lastTradeTimestamp, timestamp);
  assert.equal(saves, 0);
});

test('multiple fills from one closed futures order retain order metadata for the full batch', async () => {
  const symState = {
    orders: { order1: { side: 'buy', levelIndex: 2, refillCount: 1 } },
    lastTradeTimestamp: 0,
  };
  const seenLevels = [];
  const engine = Object.create(FuturesGridEngine.prototype);
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

  await engine.handleFilledTrades('BTC/USDT:USDT', [90, 100, 110]);

  assert.deepEqual(seenLevels, [2, 2]);
});

test('futures keeps a missing closed order until its delayed fill is reconciled', async () => {
  const symState = {
    orders: { 'closed-1': { id: 'closed-1', side: 'buy', levelIndex: 2 } },
  };
  let saves = 0;
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.exchange = {
    fetchOrder: async () => ({ id: 'closed-1', status: 'closed', filled: 1 }),
  };
  engine.state = { save: async () => { saves++; } };

  await engine.syncManagedOrdersWithExchange('BTC/USDT:USDT', symState, new Set());

  assert.ok(symState.orders['closed-1']);
  assert.equal(saves, 0);
});

test('futures removes a missing explicitly canceled order', async () => {
  const symState = {
    orders: { 'canceled-1': { id: 'canceled-1', side: 'buy', levelIndex: 2 } },
  };
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.exchange = {
    fetchOrder: async () => ({ id: 'canceled-1', status: 'canceled' }),
  };
  engine.state = { save: async () => {} };

  await engine.syncManagedOrdersWithExchange('BTC/USDT:USDT', symState, new Set());

  assert.equal(symState.orders['canceled-1'], undefined);
});

test('invalid futures target range preserves LONG cost basis and live orders', async () => {
  const trackedBuy = {
    price: 100,
    amount: 1,
    sellableAmount: 1,
    totalCostQuote: 100,
    totalFeeQuote: 0,
  };
  const symbolState = {
    config: { lower: 90, upper: 110 },
    orders: { 'buy-1': { id: 'buy-1', side: 'buy', levelIndex: 1 } },
    lastBuyByLevel: { 1: trackedBuy },
    refillCountByLevel: { 1: 0 },
    rangeTransition: null,
  };
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.exchange = {
    markets: { 'BTC/USDT:USDT': { precision: { price: 1 } } },
    priceToPrecision: () => '100',
  };
  engine.state = {
    getSymbol: () => symbolState,
    save: async () => {},
  };
  let cancelled = false;
  engine.cancelGridOrders = async () => {
    cancelled = true;
    return { failed: [] };
  };

  await assert.rejects(
    engine.remapStateAfterRangeReset('BTC/USDT:USDT', 90, 110, 99, 101),
    /range-reset rejected before order cancellation/
  );

  assert.equal(cancelled, false);
  assert.strictEqual(symbolState.lastBuyByLevel[1], trackedBuy);
  assert.ok(symbolState.orders['buy-1']);
  assert.equal(symbolState.rangeTransition, null);
});

test('futures range reset reconciles pending fills before cancelling old orders', async () => {
  const events = [];
  const engine = Object.create(FuturesGridEngine.prototype);
  const symbolState = {
    config: { lower: 90, upper: 110 },
    orders: { 'sell-1': { id: 'sell-1', side: 'sell', levelIndex: 2 } },
    lastBuyByLevel: { 1: { price: 100, amount: 1, sellableAmount: 1 } },
    refillCountByLevel: { 1: 0 },
    rangeTransition: null,
  };
  engine.exchange = { fetchMyTrades: async () => [], fetchOpenOrders: async () => [] };
  engine.state = { getSymbol: () => symbolState, save: async () => {} };
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
  engine.formatFuturesNumber = value => String(value);
  engine.formatFuturesTelegramMessage = title => title;
  engine.sendAlert = async () => {};

  await engine.remapStateAfterRangeReset('BTC/USDT:USDT', 90, 110, 80, 120);

  assert.deepEqual(events, ['fills', 'cancel', 'fills']);
});

test('futures sends an unreconciled alert when a SELL fill has no buy record', async () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  const symState = { orders: {}, lastBuyByLevel: {} };
  let alert = '';
  let processed = '';
  engine.state = {
    markProcessedTradeLocal: (_symbol, id) => { processed = id; },
    save: async () => {},
  };
  engine.sendAlert = async message => { alert = message; };
  engine.formatFuturesTelegramMessage = title => title;
  engine.formatFuturesNumber = String;

  await engine.handleSellFill(
    'BTC/USDT:USDT',
    [],
    symState,
    { id: 'sell-1', order: 'order-1', price: 101, amount: 1 },
    { levelIndex: 2, sourceBuyLevelIndex: 1 },
    new Set()
  );

  assert.equal(alert, 'FUTURES SELL FILLED - UNRECONCILED');
  assert.equal(processed, 'sell-1');
});
