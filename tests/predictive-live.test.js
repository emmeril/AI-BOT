'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildLiveConfig, selectLiveForecast, buildEntryPlan, candidateEvidence, openPositions } = require('../src/predictive/live-policy');
const { PredictiveLiveEngine, loadLiveState, saveLiveState } = require('../src/predictive/live-engine');
const { RISK_POLICY_ID } = require('../src/predictive/net-risk-reward');
const { ADAPTIVE_POLICY_ID } = require('../src/predictive/adaptive-exits');
const { planReachableTargets } = require('../src/predictive/reachability');
const { reachabilityFixture, adaptiveReachabilityFixture, contextFeatures, setReachThreshold } = require('./helpers/reachability-fixture');
const { AI_REVIEW_POLICY_ID, candidateFingerprint, forecastReviewExpiry } = require('../src/predictive/ai-review-policy');

function forecast(now, direction = 'UP', id = 'forecast-1', adaptive = false) {
  const reference = now - 30000;
  const side = direction === 'DOWN' ? 'SHORT' : 'LONG';
  const risk = planReachableTargets(adaptive ? adaptiveReachabilityFixture() : reachabilityFixture(), contextFeatures(), { up: 0.55, down: 0.4 },
    { side, entryFill: 0.05912 * (side === 'LONG' ? 1.0002 : 0.9998),
    stopLoss: side === 'LONG' ? 0.059 : 0.05924,
    tickSize: 0.00001,
    costAssumptions: { feePctPerSide: 0.05, slippagePctPerSide: 0.02 } });
  return { id, symbol: 'DOGEUSDT', horizon: 60, objective: 'PRICE_DIRECTION', status: 'FORECAST',
    modelId: 'frozen-60-model', direction, candleCloseTime: reference,
    referencePrice: 0.05912, probabilities: { up: 0.55, down: 0.4, unchanged: 0.05 },
    createdAt: new Date(now - 10000).toISOString(), targetCloseTime: reference + 3600000,
    exitPlan: { status: 'ESTIMATED', directionModelId: 'frozen-60-model', exitModelId: 'frozen-exit-60-model',
      ...risk,
      modelRangeQ75: side === 'LONG' ? 0.0592 : 0.05904, expiresAt: reference + 3600000,
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
    PREDICTIVE_LIVE_RISK_POLICY_ID: options.adaptive ? ADAPTIVE_POLICY_ID : RISK_POLICY_ID,
    PREDICTIVE_LIVE_MODEL_FILE: modelFile, PREDICTIVE_LIVE_STATE_FILE: path.join(dir, 'state.json'),
    PREDICTIVE_LIVE_REACHABILITY_MODEL_FILE: path.join(dir, 'reachability.json'),
    PREDICTIVE_AI_REVIEW_ENABLED: options.aiReview ? 'true' : 'false',
    PREDICTIVE_AI_REVIEW_STATE_FILE: path.join(dir, 'ai-reviews.json'),
    PREDICTIVE_LIVE_EXIT_MODEL_FILE: path.join(dir, 'exit-model.json') });
  fs.writeFileSync(config.exitModelFile, JSON.stringify({ modelId: 'frozen-exit-60-model' }));
  const reachability = options.adaptive ? adaptiveReachabilityFixture() :
    reachabilityFixture(60, 'frozen-60-model', 'frozen-exit-60-model', options.reachThreshold ?? 1.2);
  reachability.directionModelHash = crypto.createHash('sha256').update(fs.readFileSync(modelFile)).digest('hex');
  reachability.exitModelHash = crypto.createHash('sha256').update(fs.readFileSync(config.exitModelFile)).digest('hex');
  fs.writeFileSync(config.reachabilityModelFile, JSON.stringify(reachability));
  const context = { now: Date.UTC(2026, 10, 19, 5), wallet: 10.8, available: 10.8,
    leverage: options.leverage ?? 10, marginType: 'ISOLATED', hedgeMode: options.hedgeMode !== false,
    positions: [], regular: [], algorithms: [], orderMap: new Map(), writes: [], saved: [], algoId: 100,
    hidePositions: false, options };
  context.evidence = Array.from({ length: 4 }, (_, i) => ({ ...forecast(context.now - 7200000 - i * (options.adaptive ? 3600000 : 60000), 'UP', 'old-' + i, options.adaptive),
    outcome: { correct: i < 3 }, exitOutcome: { simulatedNetPct: i < 3 ? 0.5 : -0.3 } }));
  context.forecasts = { objective: 'PRICE_DIRECTION', records: [forecast(context.now, options.direction, 'forecast-1', options.adaptive), ...context.evidence] };
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
    readForecasts: () => context.forecasts, readAiReviews: () => context.aiReviews,
    save: () => context.saved.push(clone(engine.state)) });
  return { context, config, exchange, engine, market, dir };
}

test('profile defaults to disabled DOGE 60m, 5 USDT margin, 10x and 50 USDT target', () => {
  const c = buildLiveConfig();
  assert.equal(c.enabled, false); assert.equal(c.horizon, 60);
  assert.equal(c.marginUsdt, 5); assert.equal(c.leverage, 10); assert.equal(c.notionalUsdt, 50);
  assert.equal(c.riskPolicyId, ADAPTIVE_POLICY_ID);
  assert.throws(() => buildLiveConfig({ PREDICTIVE_LIVE_MARGIN_USDT: '50' }), /requires/);
  assert.throws(() => buildLiveConfig({ PREDICTIVE_LIVE_HORIZON: '15' }), /requires/);
});

test('adaptive entry uses sequential forward evidence and installs one full-position target', async t => {
  const { engine, context } = fixture(t, { adaptive: true });
  const preview = await engine.preflight();
  assert.equal(preview.evidence.overlappingForecasts, false);
  assert.equal(preview.evidence.netWinRate, 0.75);
  assert.ok(preview.plan.expectedNetPct > 0);
  assert.ok(preview.plan.probabilityTpBeforeSl < 0.5);
  await engine.cycle();
  assert.equal(engine.state.tracked.plan.riskPolicyId, ADAPTIVE_POLICY_ID);
  assert.equal(engine.state.tracked.plan.selectedTarget, 'TP2');
  assert.equal(context.algorithms.length, 2);
  assert.equal(context.writes.filter(r => r.method === 'order').length, 1);
  assert.equal(context.algorithms.find(r => r.type === 'TAKE_PROFIT_MARKET').closePosition, 'true');
});

test('adaptive quote and fill checks reject nonpositive expectancy', async t => {
  const { engine, context } = fixture(t, { adaptive: true });
  engine.reachabilityModel.timeoutRegressor.weights[0] = -10;
  await assert.rejects(engine.preflight(), /NON_POSITIVE_EXPECTED_NET/);
  assert.equal(context.writes.length, 0);
});

for (const reason of ['NON_POSITIVE_EXPECTED_NET', 'NO_VALID_STOP_CANDIDATE']) {
  test('latest rejected setup waits without selecting an older profitable forecast: ' + reason, async t => {
    const { engine, context } = fixture(t, { adaptive: true });
    const latest = context.forecasts.records[0];
    context.forecasts.records.push(forecast(context.now - 10000, 'UP', 'older-profitable', true));
    latest.exitPlan.status = 'UNAVAILABLE';
    latest.exitPlan.reason = reason;
    const result = await engine.cycle();
    assert.equal(result.status, 'WAITING');
    assert.equal(result.reason, reason);
    assert.equal(context.writes.length, 0);
    assert.equal(engine.state.consumedForecastId, null);
  });
}

test('adaptive fill failure closes only the owned mocked position', async t => {
  const { engine, context } = fixture(t, { adaptive: true });
  const ensure = engine.ensureProtection.bind(engine);
  engine.ensureProtection = async snapshot => {
    engine.reachabilityModel.timeoutRegressor.weights[0] = -10;
    return ensure(snapshot);
  };
  await engine.cycle();
  await engine.cycle();
  assert.equal(context.writes.filter(r => r.method === 'order').length, 2);
  assert.equal(context.algorithms.length, 0);
  assert.equal(engine.state.closed.at(-1).reason, 'FILLED_ENTRY_NON_POSITIVE_EXPECTED_NET');
});

test('adaptive worker preserves stored protection for an earlier V4 position', async t => {
  const { engine, context } = fixture(t, { adaptive: true });
  await engine.cycle();
  const plan = engine.state.tracked.plan;
  plan.riskPolicyId = RISK_POLICY_ID;
  const original = { stop: plan.stopLoss, target: plan.takeProfit, writes: context.writes.length };
  engine.reachabilityModel.timeoutRegressor.weights[0] = -10;
  await engine.cycle();
  assert.equal(plan.stopLoss, original.stop); assert.equal(plan.takeProfit, original.target);
  assert.equal(context.writes.length, original.writes);
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
  assert.equal(engine.state.pausedReason, null);
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

test('entry waits unless direction accuracy exceeds 50% and completed net PnL is positive', async t => {
  const scenarios = [
    { name: 'direction accuracy is exactly 50%', change: records => {
      records.forEach((r, i) => { r.outcome.correct = i < 2; });
    } },
    { name: 'net PnL is exactly zero', change: records => {
      records.forEach((r, i) => { r.exitOutcome.simulatedNetPct = [1, -0.5, -0.25, -0.25][i]; });
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

test('negative completed net PnL blocks entry despite a winrate above 50%', async t => {
  const { engine, context } = fixture(t);
  context.evidence.forEach((r, i) => { r.exitOutcome.simulatedNetPct = i < 3 ? 0.1 : -1; });
  const preview = await engine.preflight();
  assert.equal(preview.evidence.directionAccuracy, 0.75);
  assert.equal(preview.evidence.netWinRate, 0.75);
  assert.ok(preview.evidence.totalShadowNetUsdtAt100Notional < 0);
  assert.equal(preview.evidence.matchesUserCriteria, false);
  assert.equal(preview.status, 'BLOCKED_BY_FORWARD_RESULTS');
  assert.equal(context.writes.length, 0);
  const result = await engine.cycle();
  assert.equal(result.reason, 'FORWARD_CRITERIA_NOT_MET');
  assert.equal(context.writes.length, 0);
  assert.equal(context.algorithms.length, 0);
});

for (const winrate of [0.25, 0.5]) test(`positive net PnL qualifies adaptive entry at ${winrate * 100}% winrate`, async t => {
  const { engine, context } = fixture(t, { adaptive: true });
  context.evidence.forEach((r, i) => { r.exitOutcome.simulatedNetPct = i < winrate * 4 ? 1 : -0.1; });
  const preview = await engine.preflight();
  assert.equal(preview.evidence.netWinRate, winrate);
  assert.ok(preview.evidence.totalShadowNetUsdtAt100Notional > 0);
  assert.equal(preview.evidence.matchesUserCriteria, true);
  assert.equal(preview.evidence.selectionCriterion, 'DIRECTION_ABOVE_50_AND_POSITIVE_NET');
  assert.equal(context.writes.length, 0);
  assert.equal((await engine.cycle()).status, 'POSITION_OPEN');
  assert.equal(context.writes.filter(row => row.method === 'order').length, 1);
});

test('legacy exit results cannot supply the winrate for the TP1/TP2 policy', async t => {
  const { engine, context, config } = fixture(t);
  context.evidence.forEach(r => { delete r.exitPlan.riskPolicyId; });
  const evidence = candidateEvidence(context.forecasts, config, 'frozen-60-model');
  assert.equal(evidence.riskPolicyId, RISK_POLICY_ID);
  assert.equal(evidence.directionAccuracy, 0.75);
  assert.equal(evidence.completedShadowTrades, 0);
  assert.equal(evidence.netWinRate, null);
  assert.equal(evidence.matchesUserCriteria, false);
  assert.equal((await engine.cycle()).reason, 'FORWARD_CRITERIA_NOT_MET');
  assert.equal(context.writes.length, 0);
});

test('entry rechecks both target levels against the current quote and projected price', async t => {
  const { engine, context } = fixture(t);
  setReachThreshold(engine.reachabilityModel, 0.3);
  await assert.rejects(engine.preflight(), /TP1_BEFORE_SL_NOT_SUPPORTED/);
  await assert.rejects(engine.cycle(), /TP1_BEFORE_SL_NOT_SUPPORTED/);
  assert.equal(context.writes.length, 0);
});

test('a filled entry that cannot support TP1 is reduced without installing an unsupported target', async t => {
  const { engine, context } = fixture(t, { fillPrice: 0.0592, reachThreshold: 0.7 });
  await engine.cycle();
  await engine.cycle();
  assert.equal(context.writes.filter(row => row.method === 'order').length, 2);
  assert.equal(context.writes.filter(row => row.method === 'algo').length, 0);
  assert.equal(engine.state.closed.at(-1).reason, 'FILLED_ENTRY_TP1_BEFORE_SL_NOT_SUPPORTED');
});

test('a TP1-only projection creates one full-position TP order with fixed sizing', async t => {
  const { engine, context } = fixture(t);
  setReachThreshold(engine.reachabilityModel, 0.8);
  await engine.cycle();
  const plan = engine.state.tracked.plan;
  assert.equal(plan.selectedTarget, 'TP1');
  assert.equal(plan.rewardMultiple, 1);
  assert.equal(plan.targetMarginUsdt, 5);
  assert.equal(plan.targetNotionalUsdt, 50);
  const tpOrders = context.writes.filter(r => r.method === 'algo' && r.params.type === 'TAKE_PROFIT_MARKET');
  assert.equal(tpOrders.length, 1);
  assert.equal(tpOrders[0].params.triggerPrice, plan.takeProfit1);
  assert.equal(tpOrders[0].params.closePosition, 'true');
  assert.equal(context.writes.filter(r => r.method === 'order').length, 1);
});

test('actual fill can select TP1 when TP2 is no longer supported', async t => {
  const { engine, context } = fixture(t, { fillPrice: 0.0592 });
  assert.equal((await engine.preflight()).plan.selectedTarget, 'TP2');
  await engine.cycle();
  assert.equal(engine.state.tracked.plan.selectedTarget, 'TP1');
  assert.ok(engine.state.tracked.plan.estimatedNetRewardRisk >= 1 - 1e-9);
  assert.equal(context.writes.filter(r => r.method === 'order').length, 1);
  assert.equal(context.algorithms.length, 2);
});

test('a supported target beyond q75 can enter while preserving estimated net 2:1', async t => {
  const { engine, context } = fixture(t);
  await engine.cycle();
  const plan = engine.state.tracked.plan;
  assert.ok(plan.takeProfit > plan.modelRangeQ75);
  assert.ok(plan.probabilityTpBeforeSl > 0.5);
  assert.ok(plan.estimatedNetRewardRisk >= 2 - 1e-9);
  assert.equal(context.writes.filter(r => r.method === 'order').length, 1);
});

test('outcomes from a different reachability model cannot qualify the current policy', async t => {
  const { engine, context, config } = fixture(t);
  context.evidence.forEach(r => { r.exitPlan.reachabilityModelId = 'other-reachability'; });
  const evidence = candidateEvidence(context.forecasts, config, 'frozen-60-model', 'frozen-reach-60-model');
  assert.equal(evidence.completedShadowTrades, 0);
  assert.equal(evidence.matchesUserCriteria, false);
  assert.equal((await engine.cycle()).reason, 'FORWARD_CRITERIA_NOT_MET');
  assert.equal(context.writes.length, 0);
});

test('forecast selection rejects reachability from a different model version', t => {
  const { context, config } = fixture(t);
  context.forecasts.records[0].exitPlan.reachabilityModelId = 'other-reachability';
  assert.throws(() => selectLiveForecast(context.forecasts, config, 'frozen-60-model',
    context.now, 'frozen-reach-60-model'), /compatible/);
});

test('legacy positions retain their saved TP and SL when the candidate engine resumes', async t => {
  const { engine, context, config, exchange } = fixture(t);
  await engine.cycle();
  const plan = engine.state.tracked.plan;
  delete plan.riskPolicyId;
  plan.takeProfit = 0.05926;
  plan.stopLoss = 0.05877;
  for (const order of context.algorithms) {
    order.triggerPrice = order.type === 'STOP_MARKET' ? plan.stopLoss : plan.takeProfit;
  }
  const count = context.writes.length;
  const resumed = new PredictiveLiveEngine({ config, exchange, state: structuredClone(engine.state),
    now: () => context.now, readForecasts: () => context.forecasts, save: () => {} });
  await resumed.cycle();
  assert.equal(resumed.state.tracked.plan.takeProfit, 0.05926);
  assert.equal(resumed.state.tracked.plan.stopLoss, 0.05877);
  assert.equal(context.writes.length, count);
});

test('audit: a pending entry blocks a newer forecast until its order is resolved', async t => {
  const { engine, context } = fixture(t, { adaptive: true });
  const plan = (await engine.preflight()).plan;
  engine.state.intent = { plan, submittedAt: context.now };
  engine.state.consumedForecastId = plan.forecastId;
  context.orderMap.set(plan.entryClientId, { orderId: 'pending-entry', status: 'NEW', executedQty: '0', avgPrice: '0' });
  context.forecasts.records.unshift(forecast(context.now + 1000, 'UP', 'newer-forecast', true));
  const result = await engine.cycle();
  assert.equal(result.status, 'ENTRY_PENDING');
  assert.equal(engine.state.intent.plan.entryClientId, plan.entryClientId);
  assert.equal(context.writes.length, 0);
});

test('audit: an inference exception after fill reduces the owned position', async t => {
  const { engine, context } = fixture(t, { adaptive: true });
  const ensure = engine.ensureProtection.bind(engine);
  engine.ensureProtection = async snapshot => {
    engine.state.tracked.plan.contextFeatures = null;
    return ensure(snapshot);
  };
  await assert.rejects(engine.cycle(), /Invalid first-passage features/);
  assert.equal(context.writes.filter(r => r.method === 'order').length, 2);
  assert.equal(context.positions.length, 0);
  await engine.cycle();
  assert.equal(engine.state.closed.at(-1).reason, 'PROTECTION_FAILURE');
});

for (const method of ['fapiPublicGetTickerBookTicker', 'fapiPrivateV3GetAccount',
  'fapiPrivateGetAccountConfig', 'fapiPrivateGetSymbolConfig', 'fapiPublicGetExchangeInfo']) {
  test('audit: horizon close continues when an entry dependency is unavailable: ' + method, async t => {
    const { engine, context, exchange } = fixture(t, { adaptive: true });
    await engine.cycle();
    exchange[method] = async () => { throw new Error('Entry dependency unavailable'); };
    engine.market = null;
    context.now = engine.state.tracked.plan.expiresAt + 1;
    await engine.cycle();
    await engine.cycle();
    assert.equal(engine.state.tracked, null);
    assert.equal(engine.state.closed.at(-1).reason, 'HORIZON_EXPIRED');
    assert.equal(context.writes.filter(r => r.method === 'order').length, 2);
  });
}

test('audit: an algo query failure after fill cannot prevent a reducing close', async t => {
  const { engine, context, exchange } = fixture(t, { adaptive: true });
  const getAlgorithms = exchange.fapiPrivateGetOpenAlgoOrders;
  exchange.fapiPrivateGetOpenAlgoOrders = async () => {
    if (context.positions.length) throw new Error('Algo service unavailable');
    return getAlgorithms();
  };
  await assert.rejects(engine.cycle(), /Algo service unavailable/);
  assert.equal(context.positions.length, 0);
  assert.equal(context.writes.filter(r => r.method === 'order').length, 2);
  await engine.cycle();
  assert.equal(engine.state.tracked, null);
});

test('audit: a pending close is queried across restart without another market close', async t => {
  const { engine, context, exchange, config } = fixture(t, { adaptive: true });
  await engine.cycle();
  exchange.fapiPrivatePostOrder = async params => {
    context.writes.push({ method: 'order', params: structuredClone(params) });
    const order = { orderId: 'pending-close', status: 'NEW', executedQty: '0', avgPrice: '0' };
    context.orderMap.set(params.newClientOrderId, order);
    return order;
  };
  context.now = engine.state.tracked.plan.expiresAt + 1;
  await engine.cycle();
  const resumed = new PredictiveLiveEngine({ config, exchange, state: structuredClone(engine.state),
    now: () => context.now, readForecasts: () => context.forecasts, save: () => {} });
  await resumed.cycle();
  await resumed.cycle();
  assert.equal(context.writes.filter(r => r.method === 'order').length, 2);
  const clientId = resumed.state.tracked.closing.clientOrderId;
  assert.ok(clientId);
  context.orderMap.set(clientId, { orderId: 'pending-close', status: 'FILLED',
    executedQty: String(resumed.state.tracked.quantity), avgPrice: '0.0591' });
  context.positions = [];
  await resumed.cycle(); await resumed.cycle();
  assert.equal(resumed.state.tracked, null);
});

test('audit: an uncertain close submission remains identified while lookup is unavailable', async t => {
  const { engine, context, exchange } = fixture(t, { adaptive: true });
  await engine.cycle();
  exchange.fapiPrivatePostOrder = async params => {
    context.writes.push({ method: 'order', params: structuredClone(params) });
    throw new Error('Close submission timeout');
  };
  exchange.fapiPrivateGetOrder = async () => { throw new Error('Close lookup unavailable'); };
  context.now = engine.state.tracked.plan.expiresAt + 1;
  await assert.rejects(engine.cycle());
  const first = engine.state.tracked.closing.clientOrderId;
  await assert.rejects(engine.cycle());
  assert.ok(first);
  assert.equal(engine.state.tracked.closing.clientOrderId, first);
  assert.equal(context.writes.filter(r => r.method === 'order').length, 2);
  assert.equal(context.algorithms.length, 2);
});

test('audit: a model version change cannot reinterpret an existing position', async t => {
  const { engine, context, exchange, config } = fixture(t, { adaptive: true });
  await engine.cycle();
  const original = structuredClone(engine.state.tracked.plan);
  const changed = JSON.parse(fs.readFileSync(config.reachabilityModelFile));
  changed.modelId = 'new-model-version';
  changed.timeoutRegressor.weights[0] = -10;
  fs.writeFileSync(config.reachabilityModelFile, JSON.stringify(changed));
  const count = context.writes.length;
  const resumed = new PredictiveLiveEngine({ config, exchange, state: structuredClone(engine.state),
    now: () => context.now, readForecasts: () => context.forecasts, save: () => {} });
  await resumed.cycle();
  assert.equal(resumed.state.tracked?.plan.takeProfit, original.takeProfit);
  assert.equal(resumed.state.tracked?.plan.stopLoss, original.stopLoss);
  assert.equal(context.writes.length, count);
});

test('audit: malformed position amounts cannot be interpreted as a flat account', () => {
  for (const value of [undefined, null, '', 'unknown', Infinity, NaN]) {
    assert.throws(() => openPositions([{ symbol: 'DOGEUSDT', positionAmt: value }]), /position amount/i);
  }
  assert.deepEqual(openPositions([{ positionAmt: '0' }]), []);
});

test('audit: a partial close waits, then retries only the unfilled remainder after expiry', async t => {
  const { engine, context, exchange } = fixture(t, { adaptive: true });
  await engine.cycle();
  const quantity = engine.state.tracked.quantity;
  let attempts = 0;
  exchange.fapiPrivatePostOrder = async params => {
    context.writes.push({ method: 'order', params: structuredClone(params) });
    const partial = attempts++ === 0;
    const order = { orderId: 'close-' + attempts, status: partial ? 'PARTIALLY_FILLED' : 'FILLED',
      executedQty: String(partial ? 200 : params.quantity), avgPrice: '0.0591' };
    context.positions = partial ? [{ ...context.positions[0], positionAmt: String(quantity - 200) }] : [];
    context.orderMap.set(params.newClientOrderId, order);
    return order;
  };
  context.now = engine.state.tracked.plan.expiresAt + 1;
  await engine.cycle();
  const first = engine.state.tracked.closing.clientOrderId;
  await engine.cycle();
  assert.equal(attempts, 1);
  context.orderMap.set(first, { orderId: 'close-1', status: 'EXPIRED', executedQty: '200', avgPrice: '0.0591' });
  await engine.cycle(); await engine.cycle();
  assert.equal(attempts, 2);
  assert.equal(context.writes.filter(r => r.method === 'order').at(-1).params.quantity, quantity - 200);
  assert.equal(engine.state.tracked, null);
});

test('audit: a timed-out close with a confirmed fill waits for stale position data to catch up', async t => {
  const { engine, context, exchange } = fixture(t, { adaptive: true });
  await engine.cycle();
  exchange.fapiPrivatePostOrder = async params => {
    context.writes.push({ method: 'order', params: structuredClone(params) });
    context.orderMap.set(params.newClientOrderId, { orderId: 'close-filled', status: 'FILLED',
      executedQty: String(params.quantity), avgPrice: '0.0591' });
    throw new Error('Close response timeout');
  };
  context.now = engine.state.tracked.plan.expiresAt + 1;
  await engine.cycle(); await engine.cycle();
  assert.equal(context.writes.filter(r => r.method === 'order').length, 2);
  assert.equal(engine.state.tracked.closeConfirmed, true);
  context.positions = [];
  await engine.cycle(); await engine.cycle();
  assert.equal(engine.state.tracked, null);
});

test('audit: legacy close intents recover their deterministic client ID before any retry', async t => {
  const { engine, context } = fixture(t, { adaptive: true });
  await engine.cycle();
  const tracked = engine.state.tracked;
  tracked.closing = { reason: 'HORIZON_EXPIRED', submittedAt: context.now };
  tracked.closeAttempts = 1;
  const clientId = `p60-x-${tracked.plan.token}-0`;
  context.orderMap.set(clientId, { orderId: 'legacy-close', status: 'FILLED',
    executedQty: String(tracked.quantity), avgPrice: '0.0591' });
  context.positions = [];
  await engine.cycle(); await engine.cycle();
  assert.equal(engine.state.tracked, null);
  assert.equal(context.writes.filter(r => r.method === 'order').length, 1);
});

test('audit: partial entry fills retain the pending order and protect newly filled quantity', async t => {
  const { engine, context } = fixture(t, { adaptive: true });
  const plan = (await engine.preflight()).plan;
  engine.state.intent = { plan, submittedAt: context.now };
  engine.state.consumedForecastId = plan.forecastId;
  context.orderMap.set(plan.entryClientId, { orderId: 'partial-entry', status: 'PARTIALLY_FILLED',
    executedQty: '200', avgPrice: '0.05912' });
  context.positions = [{ symbol: plan.symbol, positionSide: plan.positionSide, positionAmt: '200', entryPrice: '0.05912' }];
  await engine.cycle();
  assert.ok(engine.state.intent);
  assert.equal(engine.state.tracked.quantity, 200);
  assert.equal(context.algorithms.length, 2);
  context.orderMap.set(plan.entryClientId, { orderId: 'partial-entry', status: 'FILLED',
    executedQty: String(plan.quantity), avgPrice: '0.05912' });
  context.positions[0].positionAmt = String(plan.quantity);
  await engine.cycle();
  assert.equal(engine.state.intent, null);
  assert.equal(engine.state.tracked.quantity, plan.quantity);
  assert.equal(engine.state.pausedReason, null);
  assert.equal(context.writes.filter(r => r.method === 'order').length, 0);
});

test('audit: horizon expiry cancels the remaining partial entry before closing its fill', async t => {
  const { engine, context, exchange } = fixture(t, { adaptive: true });
  const plan = (await engine.preflight()).plan;
  engine.state.intent = { plan, submittedAt: context.now };
  engine.state.consumedForecastId = plan.forecastId;
  context.orderMap.set(plan.entryClientId, { orderId: 'partial-entry', status: 'PARTIALLY_FILLED',
    executedQty: '200', avgPrice: '0.05912' });
  context.positions = [{ symbol: plan.symbol, positionSide: plan.positionSide, positionAmt: '200', entryPrice: '0.05912' }];
  exchange.fapiPrivateDeleteOrder = async params => {
    context.writes.push({ method: 'cancelEntry', params: structuredClone(params) });
    const order = { ...context.orderMap.get(params.origClientOrderId), status: 'CANCELED' };
    context.orderMap.set(params.origClientOrderId, order);
    return order;
  };
  await engine.cycle();
  context.now = plan.expiresAt + 1;
  await engine.cycle(); await engine.cycle();
  assert.equal(context.writes.find(r => r.method === 'cancelEntry').params.origClientOrderId, plan.entryClientId);
  assert.ok(context.writes.findIndex(r => r.method === 'cancelEntry') < context.writes.findIndex(r => r.method === 'order'));
  assert.equal(context.writes.find(r => r.method === 'order').params.quantity, 200);
  assert.equal(engine.state.intent, null);
  assert.equal(engine.state.tracked, null);
});

test('audit: a newer unavailable forecast blocks fallback to an older valid signal', t => {
  for (const missingReference of [false, true]) {
    const { context, config } = fixture(t, { adaptive: true });
    const unavailable = { ...forecast(context.now + 1000, 'UP', 'unavailable', true), status: 'UNAVAILABLE' };
    if (missingReference) unavailable.candleCloseTime = null;
    context.forecasts.records.push(unavailable);
    assert.throws(() => selectLiveForecast(context.forecasts, config, 'frozen-60-model', context.now), /No fresh forecast/);
  }
});

test('audit: invalid market quantity bounds block entry before any order submission', async t => {
  for (const [key, value] of [['minQty', undefined], ['minQty', null], ['minQty', ' '], ['minQty', '-1'],
    ['maxQty', undefined], ['maxQty', 'Infinity']]) {
    const { engine, market, context } = fixture(t, { adaptive: true });
    market.filters.find(f => f.filterType === 'MARKET_LOT_SIZE')[key] = value;
    await assert.rejects(engine.preflight(), /Invalid exchange trading limits/);
    assert.equal(context.writes.length, 0);
  }
});

for (const code of [-2022, -2024]) {
  test('audit: an exchange rejection during a protective fill race still reconciles flat: ' + code, async t => {
    const { engine, context, exchange } = fixture(t, { adaptive: true, hedgeMode: false });
    await engine.cycle();
    exchange.fapiPrivatePostOrder = async params => {
      context.writes.push({ method: 'order', params: structuredClone(params) });
      context.positions = [];
      throw new Error('binance ' + JSON.stringify({ code, msg: 'Close rejected' }));
    };
    context.now = engine.state.tracked.plan.expiresAt + 1;
    await engine.cycle(); await engine.cycle();
    assert.equal(engine.state.tracked, null);
    assert.equal(engine.state.pausedReason, null);
    assert.equal(context.writes.filter(r => r.method === 'order').length, 2);
  });
}

function approveAi(context, config) {
  const f = context.forecasts.records[0];
  const row = { id: 'approved-ai-review', forecastId: f.id, policyId: AI_REVIEW_POLICY_ID,
    configId: config.aiReview.configId, model: config.aiReview.model,
    candidateFingerprint: candidateFingerprint(f), status: 'APPROVED', requestedAt: context.now - 5000,
    completedAt: context.now - 1000, expiresAt: forecastReviewExpiry(f),
    decision: { symbol: f.symbol, action: f.exitPlan.side, requestedAction: f.exitPlan.side,
      horizonMinutes: 60, confidence: 80, risk: 'MEDIUM', reasonCodes: ['TREND'], reason: 'Candidate supported.' } };
  context.aiReviews = { version: 1, policyId: AI_REVIEW_POLICY_ID, enabled: true,
    configId: config.aiReview.configId, model: config.aiReview.model, reviews: [row] };
  return row;
}

test('AI filter blocks live entry until an exact, fresh approval is available', async t => {
  const { engine, context, config } = fixture(t, { adaptive: true, aiReview: true });
  assert.equal((await engine.cycle()).reason, 'AI_REVIEW_UNAVAILABLE');
  assert.equal(context.writes.length, 0);
  const row = approveAi(context, config);
  row.status = 'PENDING'; row.reason = 'AI_REVIEW_PENDING';
  assert.equal((await engine.cycle()).reason, 'AI_REVIEW_PENDING');
  assert.equal(context.writes.length, 0);
  row.status = 'APPROVED';
  await engine.cycle();
  assert.equal(context.writes.filter(r => r.method === 'order').length, 1);
  assert.equal(context.algorithms.length, 2);
  assert.equal(engine.state.tracked.plan.aiReview.reviewId, row.id);
});

test('AI rejection, malformed state, opposite direction and stale approval cannot submit an entry', async t => {
  for (const change of [
    row => { row.status = 'REJECTED'; row.reason = 'AI_REVIEW_HOLD'; },
    row => { row.decision.action = 'SHORT'; },
    row => { row.decision.confidence = 64; },
    row => { row.decision.horizonMinutes = 240; },
    row => { row.candidateFingerprint = 'different-candidate'; },
    row => { row.completedAt = row.requestedAt + 30001; },
  ]) {
    const { engine, context, config } = fixture(t, { adaptive: true, aiReview: true });
    change(approveAi(context, config));
    assert.equal((await engine.cycle()).status, 'WAITING');
    assert.equal(context.writes.length, 0);
    engine.readAiReviews = () => { throw new SyntaxError('Incomplete review file'); };
    assert.equal((await engine.cycle()).reason, 'AI_REVIEW_UNAVAILABLE');
    assert.equal(context.writes.length, 0);
  }
});

test('read-only preflight reports an AI block without submitting or configuring orders', async t => {
  const { engine, context } = fixture(t, { adaptive: true, aiReview: true, enabled: false });
  const report = await engine.preflight();
  assert.equal(report.status, 'BLOCKED_BY_AI_REVIEW');
  assert.equal(report.aiReview.approved, false);
  assert.equal(report.orderExecutionEnabled, false);
  assert.equal(context.writes.length, 0);
});

test('AI approval is rechecked immediately before persisting an entry intent', async t => {
  const { engine, context, config } = fixture(t, { adaptive: true, aiReview: true });
  const row = approveAi(context, config);
  let reads = 0;
  engine.readAiReviews = () => {
    if (++reads > 1) row.status = 'REJECTED';
    return context.aiReviews;
  };
  await assert.rejects(engine.cycle(), /approval changed or expired/);
  assert.equal(engine.state.intent, null);
  assert.equal(engine.state.consumedForecastId, null);
  assert.equal(context.writes.length, 0);
});

test('AI outage or rejection after entry cannot block protective repair or horizon close', async t => {
  const { engine, context, config } = fixture(t, { adaptive: true, aiReview: true });
  approveAi(context, config);
  await engine.cycle();
  engine.readAiReviews = () => { throw new Error('AI is offline'); };
  context.algorithms = context.algorithms.filter(o => o.type !== 'STOP_MARKET');
  await engine.cycle();
  assert.equal(context.algorithms.length, 2);
  context.now = engine.state.tracked.plan.expiresAt + 1;
  await engine.cycle(); await engine.cycle();
  assert.equal(engine.state.tracked, null);
  assert.equal(context.writes.filter(r => r.method === 'order').length, 2);
  assert.equal(engine.state.closed.at(-1).reason, 'HORIZON_EXPIRED');
});

test('approval revoked while saving an unsent entry cannot leave an intent or submit an order', async t => {
  const { engine, context, config } = fixture(t, { adaptive: true, aiReview: true });
  const row = approveAi(context, config), save = engine.save;
  engine.save = () => {
    save();
    if (engine.state.intent) row.status = 'REJECTED';
  };
  await assert.rejects(engine.cycle(), /approval changed or expired/);
  assert.equal(engine.state.intent, null);
  assert.equal(engine.state.consumedForecastId, null);
  assert.equal(context.writes.length, 0);
});

test('a quote that expires while saving an entry is rejected before order submission', async t => {
  const { engine, context, config } = fixture(t, { adaptive: true, aiReview: true });
  approveAi(context, config);
  const save = engine.save;
  let advanced = false;
  engine.save = () => {
    save();
    if (engine.state.intent && !advanced) { context.now += 11000; advanced = true; }
  };
  await assert.rejects(engine.cycle(), /quote expired/);
  assert.equal(engine.state.intent, null);
  assert.equal(engine.state.consumedForecastId, null);
  assert.equal(context.writes.length, 0);
});
