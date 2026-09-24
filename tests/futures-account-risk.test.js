const test = require('node:test');
const assert = require('node:assert/strict');
const { syncIncome, incomeMetrics } = require('../src/futures-income');
const { exposureBySymbol } = require('../src/futures-exposure');
const { FuturesGridEngine } = require('../futures-grid');

const symbol = 'TEST/USDT:USDT';
const now = Date.now();
const row = (id, type, income, asset = 'USDT') => ({ symbol: 'TESTUSDT', tranId: id, incomeType: type, income: String(income), asset, time: now - 1000 });

test('Binance loss stays negative even if matched grid pair was profitable; fees deducted once', async () => {
  const exchange = { market: () => ({ id: 'TESTUSDT' }), fapiPrivateGetIncome: async () => [
    row(1, 'REALIZED_PNL', -3), row(2, 'COMMISSION', -0.1), row(3, 'FUNDING_FEE', -0.2),
    row(4, 'TRANSFER', 100), row(5, 'COMMISSION_REBATE', 0.01),
  ] };
  const first = await syncIncome(exchange, null, symbol, new Date(now - 10000).toISOString(), now);
  const second = await syncIncome(exchange, first, symbol, new Date(now - 10000).toISOString(), now + 1);
  assert.equal(Object.keys(second.records).length, 4);
  const metrics = incomeMetrics(second, -3, now + 1);
  assert.ok(Math.abs(metrics.realized - (-3.09)) < 1e-10);
  assert.ok(Math.abs(metrics.net - (-6.29)) < 1e-10);
});

test('income pagination retains distinct transactions at identical timestamps and type-scoped IDs', async () => {
  const calls = [];
  const exchange = { market: () => ({ id: 'TESTUSDT' }), fapiPrivateGetIncome: async params => {
    calls.push(params);
    return params.page === 1 ? Array.from({ length: 1000 }, (_, i) => row(i, 'REALIZED_PNL', 1)) : [row(0, 'COMMISSION', -1)];
  } };
  const ledger = await syncIncome(exchange, null, symbol, new Date(now - 10000).toISOString(), now);
  assert.equal(calls.length, 2);
  assert.equal(incomeMetrics(ledger, 0, now).realized, 999);
});

test('failed income sync does not advance persisted history or publish incomplete PnL', async () => {
  const previous = { since: now - 10000, syncedAt: now - 1000, records: {} };
  const exchange = { market: () => ({ id: 'TESTUSDT' }), fapiPrivateGetIncome: async () => { throw new Error('offline'); } };
  await assert.rejects(syncIncome(exchange, previous, symbol, new Date(previous.since).toISOString(), now), /offline/);
  assert.equal(previous.syncedAt, now - 1000);
  assert.equal(incomeMetrics(null, -3, now).net, null);
  assert.equal(incomeMetrics({ ...previous, truncated: true }, 0, now).net, null);
  assert.equal(incomeMetrics({ ...previous, syncedAt: now - 11 * 60000 }, 0, now).net, null);
  assert.equal(incomeMetrics({ ...previous, records: { a: { asset: 'BNB', type: 'COMMISSION', income: -1 } } }, 0, now).net, null);
});

test('exposure includes positions at entry or mark, pending remaining BUY, and both symbols', () => {
  const result = exposureBySymbol(['A', 'B'], [
    { symbol: 'A', contracts: 2, entryPrice: 100, markPrice: 80 },
    { symbol: 'B', contracts: 1, entryPrice: 50, markPrice: 60 },
  ], [
    { symbol: 'A', side: 'buy', amount: 2, filled: 1, price: 90 },
    { symbol: 'A', side: 'sell', remaining: 100, price: 110 },
    { symbol: 'B', side: 'buy', remaining: 10, price: 60, info: { positionSide: 'SHORT' } },
  ]);
  assert.deepEqual(result, { values: { A: 290, B: 60 }, total: 350 });
  assert.throws(() => exposureBySymbol(['A'], [{ symbol: 'A', contracts: 1 }], []), /exposure/);
});

function riskEngine() {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.exposureLimits = { symbol: 100, total: 150 };
  engine.makeClientOrderId = () => 'test';
  const submitted = [];
  let used = 80;
  engine.fetchExposure = async () => ({ values: { [symbol]: used }, total: used + 30 });
  engine.exchange = { createLimitOrder: async (...args) => { submitted.push(args); used += Number(args[2]) * Number(args[3]); return { id: 'ok' }; } };
  return { engine, submitted };
}

test('concurrent BUYs serialize exposure checks; SELL bypasses caps and failed risk reads', async () => {
  const { engine, submitted } = riskEngine();
  const results = await Promise.all([1, 2].map(() => engine.createFuturesLimitOrder(symbol, 'buy', 1, 15, 0)));
  assert.equal(results.filter(Boolean).length, 1);
  engine.fetchExposure = async () => { throw new Error('offline'); };
  assert.equal(await engine.createFuturesLimitOrder(symbol, 'buy', 1, 1, 0), null);
  assert.ok(await engine.createFuturesLimitOrder(symbol, 'sell', 1, 110, 1, 0, 0));
  assert.equal(submitted.length, 2);
});

test('aggregate cap blocks BUY even when individual cap has room', async () => {
  const { engine, submitted } = riskEngine();
  engine.fetchExposure = async () => ({ values: { [symbol]: 10 }, total: 149 });
  assert.equal(await engine.createFuturesLimitOrder(symbol, 'buy', 1, 2, 0), null);
  assert.equal(submitted.length, 0);
});

test('highest buy level gets a tick-rounded profitable SELL outside the grid', () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.exchange = {
    markets: { [symbol]: { precision: { price: 0.01 } } },
    priceToPrecision: (_s, n) => Number(n).toFixed(2),
    amountToPrecision: (_s, n) => Number(n).toFixed(3),
  };
  engine.getMinCost = () => 5;
  const buy = { amount: 1, totalCostQuote: 110, totalFeeQuote: 0.022 };
  const target = engine.findSellTargetForBuy(symbol, [90, 95, 100], 2, buy, { minimumPrice: 111 });
  assert.ok(target.outsideGrid);
  assert.ok(target.sellPrice > 111);
  assert.ok(engine.isTrackedSellProfitable(symbol, buy, target.sellPrice));
  assert.equal(target.buyLevelIndex, 2);
  assert.equal(engine.findSellTargetForBuy(symbol, [90, 100], 1, { ...buy, amount: 0.00001 }), null);
});

test('exposure trimming cancels only managed BUYs, lowest price first, with a fresh recheck', async () => {
  const { engine } = riskEngine();
  const orders = [
    { symbol, id: 'near', side: 'buy', price: 95 },
    { symbol, id: 'far', side: 'buy', price: 80 },
    { symbol, id: 'exit', side: 'sell', price: 120 },
    { symbol, id: 'manual', side: 'buy', price: 70 },
  ];
  const cancelled = [];
  engine.fetchExposure = async () => ({ values: { [symbol]: cancelled.length ? 90 : 170 }, total: cancelled.length ? 120 : 200, orders });
  engine.getManagedOpenOrders = async (_symbol, all) => all.filter(o => o.id !== 'manual');
  engine.cancelOrder = async (_symbol, order) => cancelled.push(order.id);
  await engine.trimExcessBuys(symbol);
  assert.deepEqual(cancelled, ['far']);
});

test('income history is split into bounded windows and older unavailable history is flagged', async () => {
  const windows = [];
  const exchange = { market: () => ({ id: 'TESTUSDT' }), fapiPrivateGetIncome: async params => { windows.push(params); return []; } };
  const ledger = await syncIncome(exchange, null, symbol, new Date(now - 100 * 86400000).toISOString(), now);
  assert.ok(windows.every(w => w.endTime - w.startTime < 7 * 86400000));
  assert.ok(ledger.truncated);
  assert.equal(incomeMetrics(ledger, 0, now).net, null);
});

test('reconciliation preserves an out-of-grid SELL while cleaning an out-of-grid BUY', async () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  const orders = [
    { id: 'exit', side: 'sell', price: 120, timestamp: 1, amount: 1, remaining: 1 },
    { id: 'buy', side: 'buy', price: 70, timestamp: 1, amount: 1, remaining: 1 },
  ];
  const state = { config: { rangeAdvisor: { source: 'FIBONACCI' } }, orders: {}, lastBuyByLevel: {} };
  const cancelled = [];
  engine.state = { getSymbol: () => state };
  engine.exchange = {
    fetchOpenOrders: async () => orders.filter(o => !cancelled.includes(o.id)),
    fetchPositions: async () => [], fetchBalance: async () => ({ free: { USDT: 0 } }),
    markets: { [symbol]: {} },
  };
  engine.canPlaceNewOrders = () => true;
  engine.fetchContext = async () => ({ currentPrice: 95, balance: {}, positions: [], lower: 90, upper: 100, levels: [90, 100] });
  engine.enforceRangeExits = async () => true;
  engine.maybeTrailUpRange = engine.maybeTrailDownRange = async () => null;
  engine.handleFilledTrades = engine.syncFundingHistory = async () => {};
  engine.getManagedOpenOrders = async (_s, all) => all;
  engine.getNearestLevels = () => [];
  engine.isOrderCloseToPriceLevel = () => false;
  engine.cancelOrder = async (_s, o) => cancelled.push(o.id);
  await engine.reconcileSymbolUnlocked(symbol);
  assert.deepEqual(cancelled, ['buy']);
});
