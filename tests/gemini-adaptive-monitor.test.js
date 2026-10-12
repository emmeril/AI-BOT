const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GeminiRequestQueue,
  GeminiAdaptiveMonitor,
  buildPrompt,
  isTransientGeminiError,
  normalizeDecision,
} = require('../src/gemini-adaptive-monitor');

test('Gemini monitor validates and accepts a confident structured classification', () => {
  const decision = normalizeDecision({
    profile: 'bearish',
    confidence: 0.81,
    reasoning: 'Momentum is weakening across timeframes.',
    riskFactors: ['weak momentum', 'higher volatility'],
    marketRegime: 'BEARISH',
    riskScore: 78,
    buyIntensity: 0.35,
    spacingMultiplier: 1.3,
    validForMinutes: 15,
    invalidationSignals: ['4h trend turns bullish'],
  }, { minimumConfidence: 0.6 });

  assert.equal(decision.profile, 'BEARISH');
  assert.equal(decision.accepted, true);
  assert.deepEqual(decision.riskFactors, ['weak momentum', 'higher volatility']);
  assert.deepEqual(decision.scorecard, {
    marketRegime: 'BEARISH',
    riskScore: 78,
    buyIntensity: 0.35,
    spacingMultiplier: 1.3,
    validForMinutes: 15,
    invalidationSignals: ['4h trend turns bullish'],
    source: 'GEMINI',
  });
});

test('Gemini monitor rejects malformed or low-confidence output', () => {
  assert.throws(() => normalizeDecision({ profile: 'BUY_NOW', confidence: 1 }), /invalid Gemini profile/);
  assert.equal(normalizeDecision({
    profile: 'SIDEWAYS', confidence: 0.4, reasoning: '', riskFactors: [],
  }, { minimumConfidence: 0.6 }).accepted, false);
  assert.throws(() => normalizeDecision({
    profile: 'BEARISH', confidence: 0.8, riskScore: 101,
  }), /invalid Gemini riskScore/);
  assert.throws(() => normalizeDecision({
    profile: 'BEARISH', confidence: 0.8, marketRegime: 'BULLISH',
  }), /conflicts with profile/);
  assert.doesNotThrow(() => normalizeDecision({
    profile: 'RISK_OFF', confidence: 0.8, marketRegime: 'SIDEWAYS',
  }));
});

test('Gemini monitor supplies conservative scorecard defaults for legacy provider responses', () => {
  const decision = normalizeDecision({
    profile: 'RISK_OFF', confidence: 0.9, reasoning: 'risk', riskFactors: [],
  });
  assert.equal(decision.scorecard.marketRegime, 'RISK_OFF');
  assert.equal(decision.scorecard.riskScore, 90);
  assert.equal(decision.scorecard.buyIntensity, 0.25);
  assert.equal(decision.scorecard.source, 'PROFILE_DEFAULT');
});

test('Gemini monitor calls its provider once per interval and caches failures', async () => {
  let calls = 0;
  const monitor = new GeminiAdaptiveMonitor({
    enabled: true,
    apiKey: 'test-key',
    intervalMs: 1000,
    maxAttempts: 1,
    minimumRequestIntervalMs: 0,
    requestJitterMs: 0,
    provider: async () => {
      calls += 1;
      throw new Error('temporary outage');
    },
  });

  const first = await monitor.refresh('TEST', {}, 1000);
  const cached = await monitor.refresh('TEST', {}, 1500);
  assert.equal(calls, 1);
  assert.equal(first.source, 'GEMINI_ERROR');
  assert.equal(cached.decisionId, first.decisionId);

  await monitor.refresh('TEST', {}, 2000);
  assert.equal(calls, 2);
});

test('Gemini queue serializes requests from different symbols', async () => {
  let active = 0;
  let maximumActive = 0;
  const monitor = new GeminiAdaptiveMonitor({
    enabled: true,
    apiKey: 'test-key',
    intervalMs: 1000,
    maxAttempts: 1,
    minimumRequestIntervalMs: 1,
    requestJitterMs: 0,
    provider: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 3));
      active -= 1;
      return { profile: 'SIDEWAYS', confidence: 0.8, reasoning: 'ok', riskFactors: [] };
    },
  });

  await Promise.all([
    monitor.refresh('A', {}, 1000),
    monitor.refresh('B', {}, 1000),
    monitor.refresh('C', {}, 1000),
  ]);

  assert.equal(maximumActive, 1);
});

test('Gemini monitor retries transient errors and not permanent HTTP errors', async () => {
  let transientCalls = 0;
  const transientMonitor = new GeminiAdaptiveMonitor({
    enabled: true,
    apiKey: 'test-key',
    maxAttempts: 3,
    minimumRequestIntervalMs: 0,
    requestJitterMs: 0,
    retryBaseDelayMs: 0,
    provider: async () => {
      transientCalls += 1;
      if (transientCalls < 3) {
        const error = new Error('temporarily unavailable');
        error.statusCode = 503;
        throw error;
      }
      return { profile: 'BEARISH', confidence: 0.8, reasoning: 'ok', riskFactors: [] };
    },
  });
  const recovered = await transientMonitor.refresh('A', {}, 1000);
  assert.equal(transientCalls, 3);
  assert.equal(recovered.source, 'GEMINI');
  assert.equal(recovered.attempts, 3);

  let permanentCalls = 0;
  const permanentMonitor = new GeminiAdaptiveMonitor({
    enabled: true,
    apiKey: 'test-key',
    maxAttempts: 3,
    minimumRequestIntervalMs: 0,
    requestJitterMs: 0,
    provider: async () => {
      permanentCalls += 1;
      const error = new Error('bad request');
      error.statusCode = 400;
      throw error;
    },
  });
  const rejected = await permanentMonitor.refresh('B', {}, 1000);
  assert.equal(permanentCalls, 1);
  assert.equal(rejected.source, 'GEMINI_ERROR');
});

test('Gemini monitor changes project key when daily quota is exhausted', async () => {
  const calls = [];
  const monitor = new GeminiAdaptiveMonitor({
    enabled: true,
    apiKeys: ['account-a', 'account-b'],
    maxAttempts: 3,
    minimumRequestIntervalMs: 0,
    requestJitterMs: 0,
    provider: async input => {
      calls.push(input.apiKey);
      if (input.apiKey === 'account-a') {
        const error = new Error('daily quota exhausted');
        error.statusCode = 429;
        error.dailyQuotaExceeded = true;
        error.retryAfterMs = 60_000;
        throw error;
      }
      return { profile: 'SIDEWAYS', confidence: 0.8, reasoning: 'ok', riskFactors: [] };
    },
  });

  const decision = await monitor.refresh('A', {}, 1000);
  assert.deepEqual(calls, ['account-a', 'account-b']);
  assert.equal(decision.source, 'GEMINI');
  assert.equal(decision.attempts, 1);
});

test('Gemini monitor uses the last accepted decision during a temporary outage', async () => {
  let shouldFail = false;
  const monitor = new GeminiAdaptiveMonitor({
    enabled: true,
    apiKey: 'test-key',
    intervalMs: 1000,
    maxAttempts: 1,
    minimumRequestIntervalMs: 0,
    requestJitterMs: 0,
    staleTtlMs: 10_000,
    provider: async () => {
      if (shouldFail) {
        const error = new Error('service unavailable');
        error.statusCode = 503;
        throw error;
      }
      return { profile: 'BEARISH', confidence: 0.8, reasoning: 'accepted', riskFactors: ['trend'] };
    },
  });

  const fresh = await monitor.refresh('A', {}, 1000);
  shouldFail = true;
  const stale = await monitor.refresh('A', {}, 2000);

  assert.equal(fresh.source, 'GEMINI');
  assert.equal(stale.source, 'GEMINI_STALE');
  assert.equal(stale.profile, 'BEARISH');
  assert.equal(stale.accepted, true);
  assert.equal(stale.staleAgeMs, 1000);
  assert.match(stale.error, /unavailable/);
});

test('Gemini transient-error detection covers rate limits, server errors and timeouts', () => {
  assert.equal(isTransientGeminiError({ statusCode: 429 }), true);
  assert.equal(isTransientGeminiError({ statusCode: 429, dailyQuotaExceeded: true }), false);
  assert.equal(isTransientGeminiError({ statusCode: 503 }), true);
  assert.equal(isTransientGeminiError(new Error('request timed out')), true);
  assert.equal(isTransientGeminiError({ statusCode: 400 }), false);
});

test('Gemini request queue preserves FIFO order', async () => {
  const order = [];
  const queue = new GeminiRequestQueue({ minimumIntervalMs: 0, jitterMs: 0 });
  await Promise.all([
    queue.enqueue(async () => order.push('first')),
    queue.enqueue(async () => order.push('second')),
  ]);
  assert.deepEqual(order, ['first', 'second']);
});

test('Gemini prompt contains monitoring context and forbids direct order control', () => {
  const prompt = buildPrompt('TEST/USDT:USDT', {
    leverage: 5,
    marginMode: 'ISOLATED',
    gridCount: 27,
    currentPrice: 1,
    exposureRatio: 0.5,
    allocatedUsdt: 75,
    investmentLimitUsdt: 150,
    analysis: { confirmedDirection: 'BEARISH', timeframes: {} },
  });

  assert.match(prompt, /LONG_ONLY/);
  assert.match(prompt, /Existing SELL exits are never changed/);
  assert.match(prompt, /"exposurePct":50/);
  assert.match(prompt, /riskScore: 0 means low risk and 100 means extreme risk/);
  assert.match(prompt, /cannot control orders directly/);
});
