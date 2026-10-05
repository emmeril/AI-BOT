const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AdaptiveGridSupervisor,
  buildAdaptiveBuyPlan,
  classifyProfile,
  recommendationFor,
} = require('../src/adaptive-grid-supervisor');

function analysis(direction, overrides = {}) {
  return {
    confirmedDirection: direction,
    confidence: 0.8,
    score: direction === 'BEARISH' ? -0.4 : direction === 'BULLISH' ? 0.4 : 0,
    timeframes: {
      '15m': {
        direction,
        score: direction === 'BEARISH' ? -3 : direction === 'BULLISH' ? 3 : 0,
        atrPct: 1,
        volatilityRatio: 1,
        recentMoveAtr: 0,
      },
    },
    ...overrides,
  };
}

test('bearish profile keeps buys active and shifts weight toward lower levels', () => {
  const decision = classifyProfile(analysis('BEARISH'), 0.5);
  assert.equal(decision.profile, 'BEARISH');

  const supervisor = new AdaptiveGridSupervisor({ profileConfirmations: 1, cooldownMs: 0 });
  const result = supervisor.evaluate('TEST', { analysis: analysis('BEARISH'), now: 1, signalId: 'a' });
  assert.deepEqual(result.recommendation.buyWeight, { upper: 0.5, middle: 1, lower: 1.5 });
});

test('profile requires confirmation and ignores a duplicate candle signal', () => {
  const supervisor = new AdaptiveGridSupervisor({ profileConfirmations: 2, cooldownMs: 0 });
  const first = supervisor.evaluate('TEST', { analysis: analysis('BEARISH'), now: 1, signalId: 'a' });
  const duplicate = supervisor.evaluate('TEST', { analysis: analysis('BEARISH'), now: 2, signalId: 'a' });
  const second = supervisor.evaluate('TEST', { analysis: analysis('BEARISH'), now: 3, signalId: 'b' });

  assert.equal(first.profile, 'SIDEWAYS');
  assert.equal(duplicate.evaluated, false);
  assert.equal(second.profile, 'BEARISH');
  assert.equal(second.changed, true);
});

test('risk-off activates immediately for high exposure without disabling all buys', () => {
  const supervisor = new AdaptiveGridSupervisor({ profileConfirmations: 1, cooldownMs: 10_000 });
  supervisor.evaluate('TEST', {
    analysis: analysis('BULLISH'),
    exposureRatio: 0.5,
    now: 20_000,
    signalId: 'initial',
  });
  const result = supervisor.evaluate('TEST', {
    analysis: analysis('RANGING'),
    exposureRatio: 0.92,
    now: 20_001,
    signalId: 'a',
  });

  assert.equal(result.profile, 'RISK_OFF');
  assert.equal(result.recommendation.buyWeight.upper, 0.25);
  assert.equal(result.recommendation.buyWeight.lower, 1.25);
});

test('strong bearish move selects risk-off from market conditions', () => {
  const result = classifyProfile(analysis('BEARISH', {
    score: -0.7,
    timeframes: {
      '15m': {
        direction: 'BEARISH',
        score: -4,
        atrPct: 2,
        volatilityRatio: 1.5,
        recentMoveAtr: -2,
      },
    },
  }), 0.5);

  assert.equal(result.profile, 'RISK_OFF');
  assert.ok(result.reasons.includes('sharp_15m_drop'));
});

test('live decisions expose the configured execution mode', () => {
  const supervisor = new AdaptiveGridSupervisor({
    mode: 'LIVE',
    profileConfirmations: 1,
    cooldownMs: 0,
  });
  const result = supervisor.evaluate('TEST', {
    analysis: analysis('BULLISH'), now: 1, signalId: 'live',
  });
  assert.equal(result.mode, 'LIVE');
});

test('accepted Gemini monitoring drives the adaptive profile', () => {
  const supervisor = new AdaptiveGridSupervisor({ profileConfirmations: 1, cooldownMs: 0 });
  const result = supervisor.evaluate('TEST', {
    analysis: analysis('RANGING'),
    exposureRatio: 0.4,
    now: 1,
    signalId: 'gemini-1',
    monitorDecision: {
      accepted: true,
      profile: 'BEARISH',
      confidence: 0.82,
      reasoning: 'Downside pressure is broadening.',
      riskFactors: ['weak momentum'],
      model: 'gemini-test',
    },
  });

  assert.equal(result.profile, 'BEARISH');
  assert.equal(result.decisionSource, 'GEMINI');
  assert.equal(result.deterministicProfile, 'SIDEWAYS');
  assert.equal(result.gemini.confidence, 0.82);
});

test('deterministic risk guard overrides a bullish Gemini classification', () => {
  const supervisor = new AdaptiveGridSupervisor({ profileConfirmations: 1, cooldownMs: 0 });
  const result = supervisor.evaluate('TEST', {
    analysis: analysis('BULLISH'),
    exposureRatio: 0.95,
    now: 1,
    signalId: 'gemini-risk',
    monitorDecision: {
      accepted: true,
      profile: 'BULLISH',
      confidence: 0.99,
      riskFactors: [],
    },
  });

  assert.equal(result.profile, 'RISK_OFF');
  assert.equal(result.decisionSource, 'DETERMINISTIC_SAFETY');
});

test('risk-off live plan widens spacing and shifts size toward lower levels', () => {
  const recommendation = recommendationFor('RISK_OFF');
  const candidates = [100, 99, 98, 97, 96]
    .map((price, index) => ({ price, index }));
  const plan = buildAdaptiveBuyPlan(candidates, recommendation, 20);

  assert.deepEqual(plan.map(level => level.price), [100, 98, 96]);
  assert.deepEqual(plan.map(level => level.weight), [0.25, 0.5, 1.25]);
});
