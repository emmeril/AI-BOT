const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GeminiAdaptiveMonitor,
  buildPrompt,
  normalizeDecision,
} = require('../src/gemini-adaptive-monitor');

test('Gemini monitor validates and accepts a confident structured classification', () => {
  const decision = normalizeDecision({
    profile: 'bearish',
    confidence: 0.81,
    reasoning: 'Momentum is weakening across timeframes.',
    riskFactors: ['weak momentum', 'higher volatility'],
  }, { minimumConfidence: 0.6 });

  assert.equal(decision.profile, 'BEARISH');
  assert.equal(decision.accepted, true);
  assert.deepEqual(decision.riskFactors, ['weak momentum', 'higher volatility']);
});

test('Gemini monitor rejects malformed or low-confidence output', () => {
  assert.throws(() => normalizeDecision({ profile: 'BUY_NOW', confidence: 1 }), /invalid Gemini profile/);
  assert.equal(normalizeDecision({
    profile: 'SIDEWAYS', confidence: 0.4, reasoning: '', riskFactors: [],
  }, { minimumConfidence: 0.6 }).accepted, false);
});

test('Gemini monitor calls its provider once per interval and caches failures', async () => {
  let calls = 0;
  const monitor = new GeminiAdaptiveMonitor({
    enabled: true,
    apiKey: 'test-key',
    intervalMs: 1000,
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
});
