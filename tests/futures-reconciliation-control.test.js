const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STOP_TRADING = 'true';
process.env.GRID_MODE = 'ARITHMETIC';
process.env.GRID_COUNT = '4';
process.env.GRID_STATE_FILE = '/dev/null/grid-state-futures.json';

const { FuturesGridEngine, GridState } = require('../futures-grid');

test('futures state persistence errors propagate to the trading cycle', async () => {
  const state = new GridState();
  await assert.rejects(state.save(), /ENOTDIR|not a directory/i);
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
