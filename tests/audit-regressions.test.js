const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

Object.assign(process.env, {
  STOP_TRADING: 'false', KILL_SWITCH_ENABLED: 'false',
  GRID_REFILL_ON_FILLED: 'true', GRID_MAX_REFILLS: '2',
  GRID_STATE_FILE: '/tmp/ai-bot-audit-test-state.json',
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_AUTH_ENABLED: 'false',
  FUTURES_DASHBOARD_ENABLED: 'true', FUTURES_DASHBOARD_AUTH_ENABLED: 'false',
});
const spot = require('../index');
const futures = require('../futures-grid');
const { startDashboardServer } = require('../src/dashboard-server');
const { startFuturesDashboardServer } = require('../src/futures-dashboard-server');

for (const [name, Engine, State] of [
  ['spot', spot.SpotGridEngine, spot.GridState],
  ['futures', futures.FuturesGridEngine, futures.GridState],
]) {
  test(`${name}: pagination includes all fills across a timestamp boundary`, async () => {
    const engine = Object.create(Engine.prototype);
    const rows = Array.from({ length: 202 }, (_, i) => ({
      id: String(9007199254740993n + BigInt(i)),
      timestamp: i === 0 ? 100 : i === 201 ? 102 : 101,
    }));
    engine.exchange = {
      fetchMyTrades: async (_symbol, since, limit, params) => rows.filter(row =>
        params?.fromId ? BigInt(row.id) >= BigInt(params.fromId) : row.timestamp >= since
      ).slice(0, limit),
    };
    const result = await engine.fetchNewTrades('BTC/USDT', { lastTradeTimestamp: 100 });
    assert.deepEqual(result.trades.map(row => row.id), rows.map(row => row.id));
  });

  test(`${name}: corrupted or unreadable state aborts startup`, t => {
    for (const value of ['{', 'null', '{}', '[]']) {
      const mock = t.mock.method(fs, 'readFileSync', () => value);
      assert.throws(() => new State(), /Cannot load grid state/);
      mock.mock.restore();
    }
    const mock = t.mock.method(fs, 'readFileSync', () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    assert.throws(() => new State(), /Cannot load grid state/);
    mock.mock.restore();
    t.mock.method(fs, 'readFileSync', () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    assert.deepEqual(new State().data.symbols, {});
  });

  test(`${name}: halted reconciliation disables fill refills`, async () => {
    const engine = Object.create(Engine.prototype);
    engine.exchange = { fetchOpenOrders: async () => [] };
    engine.state = { getSymbol: () => ({ config: {} }) };
    engine.fetchContext = async () => ({ levels: [100, 110], positions: [] });
    engine.enforceRangeExits = async () => false;
    engine.syncFundingHistory = async () => {};
    let reconciled = false;
    engine.handleFilledTrades = async (_symbol, levels) => {
      reconciled = true;
      assert.deepEqual(levels, []);
    };
    await engine.reconcileSymbolUnlocked('BTC/USDT');
    assert.equal(reconciled, true);
  });

  test(`${name}: decimal-place price precision is converted to tick size`, () => {
    const engine = Object.create(Engine.prototype);
    const market = { precision: { price: 2 } };
    assert.equal(engine.isOrderCloseToPriceLevel(100.01, [100], market), true);
    assert.equal(engine.isOrderCloseToPriceLevel(100.5, [100], market), false);
  });

  test(`${name}: recover a closed order before processing its fill`, async () => {
    const engine = Object.create(Engine.prototype);
    const symbolState = { orders: {}, lastTradeTimestamp: 0 };
    let handled = 0;
    let processed = 0;
    engine.state = {
      getSymbol: () => symbolState, processedTrade: () => false,
      markProcessedTrade: async () => { processed++; }, save: async () => {},
    };
    engine.exchange = {
      fetchMyTrades: async () => [{ id: '1', order: 'order1', side: 'buy', timestamp: 100 }],
      fetchOrder: async () => ({ clientOrderId: 'grid-btcusdt-b-1-r0-abc' }),
    };
    engine.cacheFeeTokenPrice = async () => {};
    engine.syncManagedOrdersWithExchange = async () => {};
    engine.handleBuyFill = async (_symbol, _levels, _state, _trade, meta) => {
      assert.equal(meta.levelIndex, 1);
      handled++;
    };
    await engine.handleFilledTrades('BTC/USDT', [], []);
    assert.equal(handled, 1);
    assert.equal(processed, 0);
    symbolState.lastTradeTimestamp = 0;
    engine.exchange.fetchOrder = async () => ({});
    await assert.rejects(engine.handleFilledTrades('BTC/USDT', [], []), /Missing clientOrderId/);
    assert.equal(symbolState.lastTradeTimestamp, 0);
    assert.equal(processed, 0);
  });
}

for (const start of [startDashboardServer, startFuturesDashboardServer]) {
  test(`${start.name}: malformed URL returns 400 without an unhandled rejection`, async t => {
    let handler;
    t.mock.method(http, 'createServer', callback => {
      handler = callback;
      return { on() {}, once() {}, listen() {} };
    });
    start({});
    let status;
    let body;
    const response = { writeHead(code) { status = code; }, end(value) { body = value; } };
    await handler({ method: 'GET', url: 'http://[', headers: { host: '[' } }, response);
    assert.equal(status, 400);
    assert.deepEqual(JSON.parse(body), { error: 'Invalid request URL' });
    await handler({ method: 'GET', url: '/missing', headers: { host: '[' } }, response);
    assert.equal(status, 404);
  });
}
