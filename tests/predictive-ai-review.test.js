'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AI_REVIEW_POLICY_ID, buildAiReviewConfig, candidateFingerprint, forecastReviewExpiry,
  assessAiReview, buildReviewSnapshot } = require('../src/predictive/ai-review-policy');
const { PredictiveAiReviewService, loadAiReviewState, saveAiReviewState } = require('../src/predictive/ai-review-service');

const START = Date.UTC(2026, 10, 20, 4, 0, 30);

function forecast() {
  const reference = START - 30001;
  return { id: 'DOGEUSDT:direction:60:example', symbol: 'DOGEUSDT', horizon: 60,
    objective: 'PRICE_DIRECTION', status: 'FORECAST', modelId: 'direction-model', direction: 'UP',
    candleCloseTime: reference, createdAt: new Date(START - 10000).toISOString(),
    targetCloseTime: reference + 3600000, referencePrice: 0.05912,
    probabilities: { up: 0.55, down: 0.4, unchanged: 0.05 },
    exitPlan: { status: 'ESTIMATED', directionModelId: 'direction-model', exitModelId: 'exit-model',
      reachabilityModelId: 'reachability-model', riskPolicyId: 'ADAPTIVE_NET_EXPECTANCY_TP1_TP2_V5',
      side: 'LONG', stopId: 'Q50', takeProfit: 0.06012, stopLoss: 0.05862,
      takeProfit1: 0.05972, takeProfit2: 0.06012, selectedTarget: 'TP2', expectedNetPct: 0.1,
      estimatedNetRewardRisk: 2, expiresAt: reference + 3600000, contextFeatures: [1, 2, 3],
      costAssumptions: { feePctPerSide: 0.05, slippagePctPerSide: 0.02 } } };
}

function candles(f = forecast()) {
  return Array.from({ length: 241 }, (_, i) => {
    const closeTime = f.candleCloseTime - (240 - i) * 60000;
    const close = Number((0.059 + i * 0.0000005).toFixed(8));
    return { time: closeTime - 59999, closeTime, open: close - 0.0000001,
      high: close + 0.000002, low: close - 0.000002, close, quoteVolume: 1000 + i, takerBuyQuote: 600 + i * 0.6 };
  });
}

function decision(overrides = {}) {
  return { symbol: 'DOGEUSDT', action: 'LONG', requestedAction: 'LONG', confidence: 80,
    horizonMinutes: 60, risk: 'MEDIUM', reasonCodes: ['TREND'], reason: 'Candidate supported.', ...overrides };
}

function config(extra = {}) { return buildAiReviewConfig({ PREDICTIVE_AI_REVIEW_ENABLED: 'true', ...extra }); }

function approvedState(f = forecast(), c = config()) {
  return { version: 1, policyId: AI_REVIEW_POLICY_ID, enabled: true, configId: c.configId, model: c.model,
    reviews: [{ id: 'review-id', policyId: AI_REVIEW_POLICY_ID, configId: c.configId, model: c.model,
      forecastId: f.id, candidateFingerprint: candidateFingerprint(f), requestedAt: START,
      completedAt: START + 1000, expiresAt: forecastReviewExpiry(f), status: 'APPROVED', decision: decision() }] };
}

function serviceFixture(t, options = {}) {
  const context = { now: START, calls: 0, saves: [], updates: [], current: true, timeout: null };
  const c = config(), state = { version: 1, policyId: AI_REVIEW_POLICY_ID, reviews: [] };
  const service = new PredictiveAiReviewService({ config: c, state, now: () => context.now,
    isCurrent: () => context.current,
    provider: async (...args) => {
      context.calls++;
      return options.provider ? options.provider(...args) : { decisions: [decision()] };
    },
    save: () => context.saves.push(structuredClone(state)), onUpdate: row => context.updates.push(row),
    schedule: callback => { context.timeout = callback; return 1; }, cancel: () => {},
  });
  t.after(() => service.stop());
  return { context, service, state, config: c };
}

test('AI review configuration keeps a hard 30 second maximum and is opt-in', () => {
  assert.equal(buildAiReviewConfig().enabled, false);
  assert.equal(config().timeoutMs, 30000);
  assert.equal(config().model, 'gemini-3.8-flash-high');
  assert.equal(config().effort, 'high');
  assert.equal(config().failureMode, 'BLOCK');
  assert.equal(config().positionExitPolicy, 'PREDICTION_REVERSAL');
  assert.notEqual(config({ PREDICTIVE_LIVE_MAX_OPEN_POSITIONS: '2' }).configId, config().configId);
  assert.notEqual(config({ PREDICTIVE_LIVE_POSITION_EXIT_POLICY: 'HORIZON' }).configId, config().configId);
  assert.notEqual(config({ PREDICTIVE_AI_REVIEW_FAILURE_MODE: 'PRIMARY_FALLBACK' }).configId, config().configId);
  assert.throws(() => config({ PREDICTIVE_AI_REVIEW_FAILURE_MODE: 'ALLOW_ALL' }), /Invalid/);
  assert.throws(() => config({ PREDICTIVE_AI_REVIEW_TIMEOUT_MS: '30001' }), /Invalid/);
  assert.throws(() => config({ PREDICTIVE_AI_REVIEW_MIN_CONFIDENCE: '101' }), /Invalid/);
  assert.throws(() => config({ PREDICTIVE_AI_REVIEW_MAX_AGE_MS: '120001' }), /Invalid/);
});

test('AI market context uses completed causal windows and ignores future extremes', () => {
  const f = forecast(), bars = candles(f);
  const expected = buildReviewSnapshot(f, bars, START);
  const future = { ...bars.at(-1), closeTime: f.candleCloseTime + 60000, high: 100000, low: 0 };
  assert.deepEqual(buildReviewSnapshot(f, [...bars, future], START), expected);
  assert.deepEqual(expected.windows.map(w => w.minutes), [5, 15, 60, 240]);
  assert.equal(expected.recentClosedCandles.length, 15);
  assert.ok(expected.windows.every(w => w.returnPct > 0 && w.takerFlowImbalance > 0));
  assert.equal(expected.candidate.liveSizing.targetNotionalUsdt, 50);
  assert.equal(expected.candidate.positionExitPolicy, 'PREDICTION_REVERSAL');
  assert.equal(buildReviewSnapshot(f, bars, START, { maxOpenPositions: 2 }).candidate.liveSizing.maxOpenPositions, 2);
  assert.equal(buildReviewSnapshot(f, bars, START, { positionExitPolicy: 'HORIZON' }).candidate.positionExitPolicy, 'HORIZON');
  assert.throws(() => buildReviewSnapshot(f, bars.slice(1), START), /241 contiguous/);
  bars[10].closeTime++;
  assert.throws(() => buildReviewSnapshot(f, bars, START), /241 contiguous/);
});

test('AI acceptance requires the exact candidate, model configuration and a fresh completed response', () => {
  const f = forecast(), c = config(), state = approvedState(f, c);
  assert.equal(assessAiReview(f, state, c, START + 1000).approved, true);
  for (const mutate of [
    value => { value.id = 'another-forecast'; }, value => { value.modelId = 'another-model'; },
    value => { value.exitPlan.stopLoss -= 0.00001; }, value => { value.exitPlan.takeProfit += 0.00001; },
    value => { value.exitPlan.contextFeatures[0]++; }, value => { value.probabilities.up += 0.01; },
    value => { value.exitPlan.costAssumptions.feePctPerSide += 0.01; },
  ]) {
    const changed = structuredClone(f); mutate(changed);
    assert.equal(assessAiReview(changed, state, c, START + 1000).approved, false);
  }
  const other = config({ PREDICTIVE_AI_REVIEW_MODEL: 'another-model' });
  assert.equal(assessAiReview(f, state, other, START + 1000).approved, false);
  assert.equal(assessAiReview(f, state, c, START + 62000).reason, 'AI_REVIEW_EXPIRED');
  assert.equal(assessAiReview(f, state, c, START + 90000).approved, false);
});

test('HOLD, conflict, low confidence, high risk and a wrong horizon cannot approve an entry', () => {
  for (const change of [
    { action: 'HOLD' }, { action: 'SHORT' }, { confidence: 64 }, { risk: 'HIGH' },
    { horizonMinutes: 240 }, { symbol: 'BTCUSDT' }, { confidence: NaN },
  ]) {
    const f = forecast(), c = config(), state = approvedState(f, c);
    Object.assign(state.reviews[0].decision, change);
    assert.equal(assessAiReview(f, state, c, START + 1000).approved, false);
  }
});

test('a later rejection cannot fall back to an earlier approval for the same candidate', () => {
  const f = forecast(), c = config(), state = approvedState(f, c);
  state.reviews.push({ ...structuredClone(state.reviews[0]), requestedAt: START + 2000,
    status: 'REJECTED', reason: 'AI_REVIEW_HOLD' });
  assert.equal(assessAiReview(f, state, c, START + 3000).reason, 'AI_REVIEW_HOLD');
});

test('postdated, over-deadline and extended expiry responses are rejected', () => {
  for (const mutate of [
    row => { row.requestedAt = START + 2000; },
    row => { row.completedAt = START + 30001; },
    row => { row.expiresAt += 1000; },
    row => { row.completedAt = START + 2000; },
  ]) {
    const f = forecast(), c = config(), state = approvedState(f, c);
    mutate(state.reviews[0]);
    assert.equal(assessAiReview(f, state, c, START + 1000).approved, false);
  }
});

test('primary fallback uses the baseline on provider failure without claiming AI approval', () => {
  const f = forecast(), c = config({ PREDICTIVE_AI_REVIEW_FAILURE_MODE: 'PRIMARY_FALLBACK' });
  const state = approvedState(f, c);
  Object.assign(state.reviews[0], { status: 'UNAVAILABLE', reason: 'AI_REVIEW_PROVIDER_ERROR' });
  const result = assessAiReview(f, state, c, START + 1000);
  assert.equal(result.approved, true);
  assert.equal(result.aiApproved, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'AI_REVIEW_PRIMARY_FALLBACK');
  assert.equal(result.failureReason, 'AI_REVIEW_PROVIDER_ERROR');
  assert.equal(result.candidateFingerprint, candidateFingerprint(f));
  assert.equal(state.reviews[0].status, 'UNAVAILABLE');
});

test('primary fallback allows a review to finish before treating a missing or pending result as unavailable', () => {
  const f = forecast(), c = config({ PREDICTIVE_AI_REVIEW_FAILURE_MODE: 'PRIMARY_FALLBACK' });
  const missingDeadline = Date.parse(f.createdAt) + c.timeoutMs;
  for (const state of [null, { invalid: true }, { ...approvedState(f, c), reviews: [] },
    { ...approvedState(f, c), reviews: [null] }]) {
    assert.equal(assessAiReview(f, state, c, missingDeadline - 1).approved, false);
    assert.equal(assessAiReview(f, state, c, missingDeadline).fallback, true);
  }
  const state = approvedState(f, c);
  Object.assign(state.reviews[0], { status: 'PENDING', reason: 'AI_REVIEW_PENDING' });
  assert.equal(assessAiReview(f, state, c, START + 29999).approved, false);
  assert.equal(assessAiReview(f, state, c, START + 30000).fallback, true);
  Object.assign(state.reviews[0], { status: 'UNAVAILABLE', reason: 'AI_REVIEW_TIMEOUT' });
  assert.equal(assessAiReview(f, state, c, START + 29999).approved, false);
  assert.equal(assessAiReview(f, state, c, START + 30000).fallback, true);
});

test('primary fallback keeps actual AI rejections and invalid market input blocked', () => {
  const f = forecast(), c = config({ PREDICTIVE_AI_REVIEW_FAILURE_MODE: 'PRIMARY_FALLBACK' });
  for (const reason of ['AI_REVIEW_HOLD', 'AI_REVIEW_DIRECTION_CONFLICT', 'AI_REVIEW_HIGH_RISK', 'AI_REVIEW_LOW_CONFIDENCE']) {
    const state = approvedState(f, c);
    Object.assign(state.reviews[0], { status: 'REJECTED', reason });
    for (const now of [START + 1000, START + 62000]) {
      assert.equal(assessAiReview(f, state, c, now).approved, false);
      assert.equal(assessAiReview(f, state, c, now).reason, reason);
    }
  }
  const state = approvedState(f, c);
  Object.assign(state.reviews[0], { status: 'UNAVAILABLE', reason: 'AI_REVIEW_INVALID_MARKET_DATA' });
  assert.equal(assessAiReview(f, state, c, START + 30000).approved, false);
});

test('primary fallback cannot revive stale, unprofitable or incompatible primary forecasts', () => {
  const c = config({ PREDICTIVE_AI_REVIEW_FAILURE_MODE: 'PRIMARY_FALLBACK' });
  for (const mutate of [
    f => { f.exitPlan.expectedNetPct = 0; }, f => { f.exitPlan.expectedNetPct = -0.1; },
    f => { f.horizon = 15; }, f => { f.exitPlan.status = 'UNAVAILABLE'; },
    f => { f.createdAt = new Date(START - 130000).toISOString(); },
  ]) {
    const f = forecast(); mutate(f);
    assert.equal(assessAiReview(f, null, c, START + 30000).reason, 'AI_REVIEW_INELIGIBLE_FORECAST');
  }
});

test('primary fallback discards malformed or expired AI output without reusing it as approval', () => {
  const f = forecast(), c = config({ PREDICTIVE_AI_REVIEW_FAILURE_MODE: 'PRIMARY_FALLBACK' });
  for (const reason of ['AI_REVIEW_INVALID_RESPONSE', 'AI_REVIEW_WRONG_SYMBOL_OR_HORIZON']) {
    const state = approvedState(f, c);
    Object.assign(state.reviews[0], { status: 'REJECTED', reason, decision: null });
    assert.equal(assessAiReview(f, state, c, START + 1000).fallback, true);
  }
  const result = assessAiReview(f, approvedState(f, c), c, START + 62000);
  assert.equal(result.aiApproved, false);
  assert.equal(result.failureReason, 'AI_REVIEW_EXPIRED');
});

test('AI service returns immediately while a provider request is pending and deduplicates it', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { service, context, state, config: c } = serviceFixture(t, { provider: () => pending });
  const f = forecast();
  assert.equal(service.consider(f, candles(f)).started, true);
  assert.equal(state.reviews[0].status, 'PENDING');
  assert.equal(service.consider(f, candles(f)).reason, 'AI_REVIEW_ALREADY_REQUESTED');
  const other = { ...f, id: 'different-forecast' };
  assert.equal(service.consider(other, candles(f)).reason, 'AI_REVIEW_BUSY');
  await Promise.resolve();
  assert.equal(context.calls, 1);
  context.now += 1000;
  finish({ decisions: [decision()] });
  await service.idle();
  assert.equal(state.reviews[0].status, 'APPROVED');
  assert.equal(assessAiReview(f, state, c, context.now).approved, true);
  assert.equal(service.consider(f, candles(f)).started, false);
});

test('unprofitable, non-60-minute and stale forecasts never invoke the AI provider', async t => {
  const { service, context, state } = serviceFixture(t);
  for (const mutate of [
    f => { f.exitPlan.expectedNetPct = 0; }, f => { f.exitPlan.status = 'UNAVAILABLE'; },
    f => { f.horizon = 15; }, f => { f.createdAt = new Date(START - 130000).toISOString(); },
  ]) {
    const f = forecast(); mutate(f);
    assert.equal(service.consider(f, candles()).started, false);
  }
  await Promise.resolve();
  assert.equal(context.calls, 0);
  assert.equal(state.reviews.length, 0);
});

test('provider timeout aborts the request and a late success cannot overwrite its rejection', async t => {
  let finish, signal;
  const pending = new Promise(resolve => { finish = resolve; });
  const { service, context, state } = serviceFixture(t, { provider: (_snapshots, options) => {
    signal = options.signal; return pending;
  } });
  service.consider(forecast(), candles());
  await Promise.resolve();
  context.now += 30000;
  context.timeout();
  await service.idle();
  assert.equal(signal.aborted, true);
  assert.equal(state.reviews[0].reason, 'AI_REVIEW_TIMEOUT');
  finish({ decisions: [decision()] });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.reviews[0].status, 'UNAVAILABLE');
});

test('late completion and a superseded forecast cannot publish an approval', async t => {
  for (const late of [false, true]) {
    const { service, context, state } = serviceFixture(t, { provider: async () => {
      if (late) context.now += 30001;
      else context.current = false;
      return { decisions: [decision()] };
    } });
    service.consider(forecast(), candles());
    await service.idle();
    assert.equal(state.reviews[0].status, 'UNAVAILABLE');
    assert.equal(state.reviews[0].reason, late ? 'AI_REVIEW_TIMEOUT' : 'AI_REVIEW_SUPERSEDED');
  }
});

test('provider failure and shutdown are recorded without approving the candidate', async t => {
  const first = serviceFixture(t, { provider: async () => { throw new Error('Provider unavailable'); } });
  first.service.consider(forecast(), candles());
  await first.service.idle();
  assert.equal(first.state.reviews[0].reason, 'AI_REVIEW_PROVIDER_ERROR');
  const second = serviceFixture(t, { provider: () => new Promise(() => {}) });
  second.service.consider(forecast(), candles());
  await second.service.stop();
  assert.equal(second.state.reviews[0].reason, 'AI_REVIEW_CANCELLED');
});

test('review state is saved privately and a restart invalidates incomplete requests', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predictive-ai-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = config({ PREDICTIVE_AI_REVIEW_STATE_FILE: path.join(dir, 'reviews.json') });
  const state = approvedState(forecast(), c);
  state.reviews[0].status = 'PENDING';
  saveAiReviewState(c.stateFile, state);
  assert.equal(fs.statSync(c.stateFile).mode & 0o777, 0o600);
  const service = new PredictiveAiReviewService({ config: c, now: () => START + 1000 });
  t.after(() => service.stop());
  assert.equal(loadAiReviewState(c.stateFile).reviews[0].reason, 'AI_REVIEW_WORKER_RESTARTED');
  assert.equal(assessAiReview(forecast(), loadAiReviewState(c.stateFile), c, START + 1000).approved, false);
});
