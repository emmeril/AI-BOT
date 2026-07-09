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
