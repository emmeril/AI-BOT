'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLiveConfig, selectLiveForecast, buildEntryPlan, candidateEvidence } = require('../src/predictive/live-policy');
const { PredictiveLiveEngine, loadLiveState, saveLiveState } = require('../src/predictive/live-engine');

function forecast(now, direction = 'UP', id = 'forecast-1') {
  const reference = now - 30000;
  return { id, symbol: 'DOGEUSDT', horizon: 60, objective: 'PRICE_DIRECTION', status: 'FORECAST',
    modelId: 'frozen-60-model', direction, candleCloseTime: reference,
    createdAt: new Date(now - 10000).toISOString(), targetCloseTime: reference + 3600000,
    exitPlan: { status: 'ESTIMATED', directionModelId: 'frozen-60-model', exitModelId: 'frozen-exit-60-model',
      side: direction === 'UP' ? 'LONG' : 'SHORT',
      takeProfit: direction === 'UP' ? 0.061 : 0.057,
      stopLoss: direction === 'UP' ? 0.057 : 0.061, expiresAt: reference + 3600000,
      notionalUsdt: 100, executionAllowed: false } };
}

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predictive-live-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modelFile = path.join(dir, 'model.json');
  fs.writeFileSync(modelFile, JSON.stringify({ kind: 'predictive-price-direction-v2', objective: 'PRICE_DIRECTION',
    symbol: 'DOGEUSDT', horizon: 60, modelId: 'frozen-60-model', reference: 'SIGNAL_CANDLE_CLOSE',
    target: 'HORIZON_CANDLE_CLOSE', unchangedDefinition: 'EXACTLY_EQUAL_CLOSE',
    approvedForTrading: false, temperature: 1, classifier: { kind: 'softmax-baseline-v1',
      mean: [0], std: [1], weights: [[0, 0], [0, 0], [0, 0]] } }));
  const config = buildLiveConfig({ PREDICTIVE_LIVE_ENABLED: options.enabled === false ? 'false' : 'true',
    PREDICTIVE_LIVE_MODEL_FILE: modelFile, PREDICTIVE_LIVE_STATE_FILE: path.join(dir, 'state.json') });
  const context = { now: Date.UTC(2026, 10, 19, 5), wallet: 10.8, available: 10.8,
    leverage: options.leverage ?? 10, marginType: 'ISOLATED', hedgeMode: options.hedgeMode !== false,
    positions: [], regular: [], algorithms: [], orderMap: new Map(), writes: [], saved: [], algoId: 100,
    hidePositions: false, options };
  context.evidence = Array.from({ length: 4 }, (_, i) => ({ ...forecast(context.now - 7200000 - i * 60000, 'UP', 'old-' + i),
    outcome: { correct: i < 3 }, exitOutcome: { simulatedNetPct: i < 3 ? 0.5 : -0.3 } }));
  context.forecasts = { objective: 'PRICE_DIRECTION', records: [forecast(context.now, options.direction), ...context.evidence] };
  const market = { symbol: 'DOGEUSDT', status: 'TRADING', filters: [
    { filterType: 'MARKET_LOT_SIZE', stepSize: '1', minQty: '1', maxQty: '30000000' },
    { filterType: 'PRICE_FILTER', tickSize: '0.00001' }, { filterType: 'MIN_NOTIONAL', notional: '5' },
  ] };
  const clone = value => structuredClone(value);
  const exchange = {
    fapiPublicGetExchangeInfo: async () => ({ symbols: [clone(market)] }),
    fapiPrivateV3GetAccount: async () => ({ availableBalance: String(context.available), totalWalletBalance: String(context.wallet) }),
    fapiPrivateGetAccountConfig: async () => ({ canTrade: true, multiAssetsMargin: false, dualSidePosition: context.hedgeMode }),
    fapiPrivateV3GetPositionRisk: async () => context.hidePositions ? [] : clone(context.positions),
    fapiPrivateGetOpenOrders: async () => clone(context.regular),
    fapiPrivateGetOpenAlgoOrders: async () => clone(context.algorithms),
    fapiPrivateGetSymbolConfig: async () => [{ symbol: 'DOGEUSDT', leverage: String(context.leverage),
      marginType: context.marginType, isAutoAddMargin: false }],
    fapiPublicGetTickerBookTicker: async () => ({ symbol: 'DOGEUSDT', bidPrice: '0.05911', askPrice: '0.05912', time: context.now }),
    fapiPrivatePostLeverage: async params => { context.writes.push({ method: 'leverage', params }); context.leverage = params.leverage; return params; },
    fapiPrivatePostMarginType: async params => { context.writes.push({ method: 'margin', params }); context.marginType = params.marginType; return params; },
    fapiPrivatePostOrder: async params => {
      context.writes.push({ method: 'order', params: clone(params), savedIntent: clone(engine.state.intent) });
      if (params.newClientOrderId.startsWith('p60-x-')) {
        context.positions = [];
        return { orderId: 'close-order', status: 'FILLED', executedQty: String(params.quantity), avgPrice: '0.0591' };
      }
      const avgPrice = options.fillPrice || 0.05912;
      const signed = params.positionSide === 'SHORT' || (params.positionSide === 'BOTH' && params.side === 'SELL') ? -1 : 1;
      context.positions = [{ symbol: 'DOGEUSDT', positionSide: params.positionSide,
        positionAmt: String(signed * params.quantity), entryPrice: String(avgPrice) }];
      const order = { orderId: 'entry-order', status: 'FILLED', executedQty: String(params.quantity), avgPrice: String(avgPrice) };
      context.orderMap.set(params.newClientOrderId, order);
      if (options.entryTimeout) throw new Error('Request timeout');
      return order;
    },
    fapiPrivateGetOrder: async params => {
      if (options.lookupUnavailable) throw new Error('Query unavailable');
      if (!context.orderMap.has(params.origClientOrderId)) throw new Error('Order not found');
      return context.orderMap.get(params.origClientOrderId);
    },
    fapiPrivatePostAlgoOrder: async params => {
      context.writes.push({ method: 'algo', params: clone(params) });
      if (options.failTakeProfit && params.type === 'TAKE_PROFIT_MARKET') throw new Error('TP placement rejected');
      const order = { ...params, orderType: params.type, algoId: String(++context.algoId) };
      context.algorithms.push(order); return clone(order);
    },
    fapiPrivateDeleteAlgoOrder: async params => {
      context.writes.push({ method: 'cancelAlgo', params: clone(params) });
      context.algorithms = context.algorithms.filter(row => row.algoId !== params.algoId);
      return params;
    },
  };
  const state = loadLiveState(config.stateFile);
  state.initialWalletUsdt = context.wallet;
  let engine = new PredictiveLiveEngine({ config, exchange, state, now: () => context.now,
    readForecasts: () => context.forecasts, save: () => context.saved.push(clone(engine.state)) });
  return { context, config, exchange, engine, market, dir };
}

test('profile defaults to disabled DOGE 60m, 5 USDT margin, 10x and 50 USDT target', () => {
  const c = buildLiveConfig();
  assert.equal(c.enabled, false); assert.equal(c.horizon, 60);
  assert.equal(c.marginUsdt, 5); assert.equal(c.leverage, 10); assert.equal(c.notionalUsdt, 50);
  assert.throws(() => buildLiveConfig({ PREDICTIVE_LIVE_MARGIN_USDT: '50' }), /requires/);
  assert.throws(() => buildLiveConfig({ PREDICTIVE_LIVE_HORIZON: '15' }), /requires/);
});

test('read-only preflight never changes leverage or submits orders even when account uses 20x', async t => {
  const { engine, context } = fixture(t, { enabled: false, leverage: 20 });
  const report = await engine.preflight();
  assert.equal(report.currentLeverage, 20); assert.equal(report.requestedLeverage, 10);
  assert.equal(report.plan.targetNotionalUsdt, 50);
  assert.ok(report.plan.estimatedMarginUsdt <= 5);
  assert.equal(report.plan.compounding, false);
  assert.equal(context.writes.length, 0);
  await assert.rejects(engine.cycle(), /disabled/);
  await assert.rejects(engine.configureAccount(), /disabled/);
  assert.equal(context.writes.length, 0);
});

test('preflight blocks foreign DOGE positions and orders instead of adopting or cancelling them', async t => {
  const { engine, context } = fixture(t);
  context.positions.push({ symbol: 'DOGEUSDT', positionSide: 'LONG', positionAmt: '20' });
  await assert.rejects(engine.preflight(), /flat/);
  context.positions = []; context.regular = [{ clientOrderId: 'external' }];
  await assert.rejects(engine.preflight(), /flat/);
  context.regular = []; context.algorithms = [{ clientAlgoId: 'external' }];
  await assert.rejects(engine.preflight(), /flat/);
  assert.equal(context.writes.length, 0);
});

test('forecast selection rejects stale, other-model, non-directional and incompatible exits', t => {
  const { config, context } = fixture(t);
  const select = () => selectLiveForecast(context.forecasts, config, 'frozen-60-model', context.now);
  assert.equal(select().horizon, 60);
  context.forecasts.records[0].candleCloseTime -= 180000;
  assert.throws(select, /fresh/);
  context.forecasts.records = [forecast(context.now)]; context.forecasts.records[0].modelId = 'wrong';
  assert.throws(select, /fresh/);
  context.forecasts.records = [forecast(context.now, 'UNCHANGED')];
  assert.throws(select, /bias/);
  context.forecasts.records = [forecast(context.now)]; context.forecasts.records[0].exitPlan.side = 'SHORT';
  assert.throws(select, /compatible/);
});

test('quantity rounding caps estimated margin at 5 USDT and ignores 100 USDT shadow sizing', async t => {
  const { engine, context, config, market } = fixture(t);
  const report = await engine.preflight();
  assert.ok(Number.isInteger(report.plan.quantity));
  assert.ok(report.plan.estimatedNotionalUsdt < 50);
  assert.equal(report.plan.targetNotionalUsdt, 50);
  const book = { bidPrice: '0.05911', askPrice: '0.05912', time: context.now };
  assert.throws(() => buildEntryPlan(config, forecast(context.now), market, book, 5, true, context.now), /Insufficient/);
  assert.throws(() => buildEntryPlan(config, forecast(context.now), market, { ...book, time: context.now - 20000 }, 10.8, true, context.now), /stale/);
});

test('manual execution configuration verifies isolated margin and 10x before entry', async t => {
  const { engine, context } = fixture(t, { leverage: 20 });
  context.marginType = 'CROSSED';
  engine.state.initialWalletUsdt = null;
  await engine.configureAccount();
  assert.deepEqual(context.writes.map(row => row.method), ['margin', 'leverage']);
  assert.equal(context.leverage, 10); assert.equal(context.marginType, 'ISOLATED');
  assert.equal(engine.state.initialWalletUsdt, 10.8);
});

test('entry intent is persisted before a market order and SL is installed before TP', async t => {
  const { engine, context } = fixture(t);
  await engine.cycle();
  const entry = context.writes.find(row => row.method === 'order');
  assert.equal(entry.savedIntent.plan.entryClientId, entry.params.newClientOrderId);
  assert.equal(entry.params.positionSide, 'LONG');
  const protections = context.writes.filter(row => row.method === 'algo');
  assert.deepEqual(protections.map(row => row.params.type), ['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
  for (const row of protections) {
    assert.equal(row.params.closePosition, 'true'); assert.equal(row.params.quantity, undefined);
    assert.equal(row.params.reduceOnly, undefined); assert.equal(row.params.positionSide, 'LONG');
  }
  assert.ok(engine.state.tracked.protectedAt);
  await engine.cycle();
  assert.equal(context.writes.filter(row => row.method === 'order').length, 1);
});

test('SHORT protection sides follow Hedge Mode close-all rules', async t => {
  const { engine, context } = fixture(t, { direction: 'DOWN' });
  await engine.cycle();
  const entry = context.writes.find(row => row.method === 'order');
  assert.equal(entry.params.side, 'SELL'); assert.equal(entry.params.positionSide, 'SHORT');
  for (const row of context.writes.filter(row => row.method === 'algo')) {
    assert.equal(row.params.side, 'BUY'); assert.equal(row.params.positionSide, 'SHORT');
  }
});

test('position visibility lag cannot erase an entry intent owner or cancel confirmed protection', async t => {
  const { engine, context } = fixture(t);
  context.hidePositions = true;
  await engine.cycle();
  assert.ok(engine.state.tracked); assert.equal(context.algorithms.length, 2);
  context.now += 20000;
  await engine.cycle();
  assert.ok(engine.state.tracked);
  assert.equal(engine.state.pausedReason, 'FILLED_POSITION_NEVER_OBSERVED');
  assert.equal(context.algorithms.length, 2);
  assert.equal(context.writes.filter(row => row.method === 'cancelAlgo').length, 0);
});

test('an uncertain market entry is queried by client ID without a duplicate entry', async t => {
  const { engine, context } = fixture(t, { entryTimeout: true });
  await engine.cycle();
  await engine.cycle();
  assert.ok(engine.state.tracked);
  assert.equal(context.writes.filter(row => row.method === 'order').length, 1);
  assert.equal(context.algorithms.length, 2);
});

test('unresolved entry submission remains paused across retries', async t => {
  const { engine, context } = fixture(t, { entryTimeout: true, lookupUnavailable: true });
  await assert.rejects(engine.cycle(), /unresolved/);
  await assert.rejects(engine.cycle(), /unresolved/);
  assert.ok(engine.state.intent);
  assert.equal(context.writes.filter(row => row.method === 'order').length, 1);
});

test('TP placement failure submits a reducing safety close while preserving SL until flat confirmation', async t => {
  const { engine, context } = fixture(t, { failTakeProfit: true });
  await assert.rejects(engine.cycle(), /TP placement/);
  const orders = context.writes.filter(row => row.method === 'order');
  assert.equal(orders.length, 2);
  assert.ok(orders[1].params.newClientOrderId.startsWith('p60-x-'));
  assert.equal(orders[1].params.side, 'SELL'); assert.equal(orders[1].params.positionSide, 'LONG');
  assert.equal(context.algorithms.length, 1);
  await engine.cycle();
  assert.equal(engine.state.tracked, null);
  assert.equal(context.algorithms.length, 0);
  assert.ok(engine.state.pausedReason);
});

test('horizon expiry closes the owned position, then removes only owned conditional orders', async t => {
  const { engine, context } = fixture(t);
  await engine.cycle();
  context.algorithms.push({ algoId: 'foreign', clientAlgoId: 'external-tp' });
  context.now = engine.state.tracked.plan.expiresAt + 1;
  await engine.cycle();
  await engine.cycle();
  assert.equal(engine.state.tracked, null);
  assert.deepEqual(context.algorithms.map(row => row.algoId), ['foreign']);
  assert.equal(engine.state.closed.at(-1).reason, 'HORIZON_EXPIRED');
});

test('one-way market closes are reduce-only and cannot flip position direction', async t => {
  const { engine, context } = fixture(t, { hedgeMode: false });
  await engine.cycle();
  context.now = engine.state.tracked.plan.expiresAt + 1;
  await engine.cycle();
  const close = context.writes.filter(row => row.method === 'order').at(-1).params;
  assert.equal(close.positionSide, 'BOTH'); assert.equal(close.reduceOnly, 'true');
});

test('session loss budget stops new entries before consuming more wallet balance', async t => {
  const { engine, context } = fixture(t);
  context.wallet = 5.7;
  await engine.cycle();
  assert.equal(engine.state.pausedReason, 'SESSION_LOSS_BUDGET_REACHED');
  assert.equal(context.writes.length, 0);
});

test('changed position size blocks additional orders instead of adopting external exposure', async t => {
  const { engine, context } = fixture(t);
  await engine.cycle();
  context.positions[0].positionAmt = String(Number(context.positions[0].positionAmt) + 5);
  const count = context.writes.length;
  await assert.rejects(engine.cycle(), /externally/);
  assert.equal(engine.state.pausedReason, 'POSITION_OWNERSHIP_CHANGED');
  assert.equal(context.writes.length, count);
});

test('same forecast is never re-entered and profit does not increase fixed margin', async t => {
  const { engine, context } = fixture(t);
  await engine.cycle();
  context.positions = [];
  await engine.cycle(); await engine.cycle();
  const count = context.writes.filter(row => row.method === 'order').length;
  await engine.cycle();
  assert.equal(context.writes.filter(row => row.method === 'order').length, count);
  context.now += 60000; context.wallet = 12; context.available = 12;
  context.forecasts.records = [forecast(context.now, 'UP', 'forecast-2'), ...context.evidence];
  await engine.cycle();
  assert.equal(engine.state.tracked.plan.targetMarginUsdt, 5);
  assert.equal(engine.state.tracked.plan.targetNotionalUsdt, 50);
});

test('live runtime state survives restart with pending intent and owned protection IDs', t => {
  const { config, engine } = fixture(t);
  engine.state.intent = { plan: { entryClientId: 'p60-e-example' } };
  saveLiveState(config.stateFile, engine.state);
  assert.deepEqual(loadLiveState(config.stateFile), engine.state);
  assert.equal(fs.statSync(config.stateFile).mode & 0o777, 0o600);
});

test('entry waits unless both direction accuracy and net winrate exceed 50%', async t => {
  const scenarios = [
    { name: 'direction accuracy is exactly 50%', change: records => {
      records.forEach((r, i) => { r.outcome.correct = i < 2; });
    } },
    { name: 'net winrate is exactly 50%', change: records => {
      records.forEach((r, i) => { r.exitOutcome.simulatedNetPct = i < 2 ? 0.5 : -0.3; });
    } },
    { name: 'no evaluated directions', change: records => {
      records.forEach(r => { delete r.outcome; });
    } },
    { name: 'no completed shadow trades', change: records => {
      records.forEach(r => { delete r.exitOutcome; });
    } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async child => {
      const { engine, context, config } = fixture(child);
      scenario.change(context.evidence);
      assert.equal(candidateEvidence(context.forecasts, config, 'frozen-60-model').matchesUserCriteria, false);
      const preview = await engine.preflight();
      assert.equal(preview.status, 'BLOCKED_BY_FORWARD_RESULTS');
      assert.equal(preview.orderExecutionEnabled, false);
      const result = await engine.cycle();
      assert.equal(result.reason, 'FORWARD_CRITERIA_NOT_MET');
      assert.equal(context.writes.length, 0);
    });
  }
});

test('negative aggregate shadow PnL remains reported but does not block qualifying entry', async t => {
  const { engine, context } = fixture(t);
  context.evidence.forEach((r, i) => { r.exitOutcome.simulatedNetPct = i < 3 ? 0.1 : -1; });
  const preview = await engine.preflight();
  assert.equal(preview.evidence.directionAccuracy, 0.75);
  assert.equal(preview.evidence.netWinRate, 0.75);
  assert.ok(preview.evidence.totalShadowNetUsdtAt100Notional < 0);
  assert.equal(preview.evidence.matchesUserCriteria, true);
  assert.equal(preview.status, 'CONFIGURATION_VERIFIED_READ_ONLY');
  assert.equal(context.writes.length, 0);
  const result = await engine.cycle();
  assert.equal(result.status, 'POSITION_OPEN');
  assert.equal(context.writes.filter(row => row.method === 'order').length, 1);
  assert.equal(context.algorithms.length, 2);
});
