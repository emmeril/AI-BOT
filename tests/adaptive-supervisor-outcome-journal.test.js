const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AdaptiveSupervisorOutcomeJournal,
} = require('../src/adaptive-supervisor-outcome-journal');

function decision(overrides = {}) {
  return {
    evaluated: true,
    mode: 'LIVE',
    symbol: 'TEST/USDT:USDT',
    signalId: '15m:1000|1h:1000|4h:1000|gemini:10:BEARISH:0.8',
    generatedAt: '2026-01-01T00:00:00.000Z',
    profile: 'BEARISH',
    rawProfile: 'BEARISH',
    previousProfile: 'SIDEWAYS',
    changed: true,
    candidateProfile: 'BEARISH',
    candidateCount: 3,
    confirmationsRequired: 3,
    cooldownElapsed: true,
    exposurePct: 70,
    decisionSource: 'GEMINI',
    deterministicProfile: 'SIDEWAYS',
    riskStateMachineMode: 'SHADOW',
    riskState: 'NORMAL',
    riskTargetState: 'CAUTION',
    riskStateChanged: false,
    riskReasons: ['high_exposure_with_bearish_direction'],
    riskObserved: { exposurePct: 70 },
    gemini: {
      accepted: true,
      profile: 'BEARISH',
      confidence: 0.8,
      scorecard: { marketRegime: 'BEARISH', riskScore: 70 },
    },
    reasons: ['gemini_bearish'],
    recommendation: {
      buyWeight: { upper: 0.5, middle: 1, lower: 1.5 },
      spacingMultiplier: 1.2,
    },
    ...overrides,
  };
}

function context() {
  return {
    currentPrice: 100,
    investmentLimitUsdt: 150,
    analysis: {
      direction: 'BEARISH',
      confirmedDirection: 'BEARISH',
      score: -0.6,
      confidence: 0.8,
      alignment: 0.7,
      timeframes: {
        '4h': { direction: 'BEARISH', score: -0.8, lastClosedAt: 1000 },
      },
    },
  };
}

function fixture(t, horizonsMs = [100, 200]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-outcome-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    enabled: true,
    mode: 'SHADOW',
    logPath: path.join(directory, 'journal.jsonl'),
    statePath: path.join(directory, 'state.json'),
    horizonsMs,
  };
  return { options, journal: new AdaptiveSupervisorOutcomeJournal(options) };
}

test('outcome journal records the final Supervisor conclusion and applied action', async t => {
  const { options, journal } = fixture(t);
  assert.equal(await journal.recordDecision(decision(), context(), 1000), true);
  assert.equal(await journal.recordDecision(decision(), context(), 1000), false);

  const first = await journal.observePrice('TEST/USDT:USDT', 110, 1100);
  assert.equal(first.length, 1);
  assert.equal(first[0].returnPct, 10);
  assert.equal(first[0].finalProfile, 'BEARISH');
  assert.equal(journal.pendingCount(), 1);

  const second = await journal.observePrice('TEST/USDT:USDT', 90, 1200);
  assert.equal(second.length, 1);
  assert.equal(second[0].returnPct, -10);
  assert.equal(journal.pendingCount(), 0);

  const lines = fs.readFileSync(options.logPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(line => line.type), [
    'SUPERVISOR_DECISION', 'SUPERVISOR_OUTCOME', 'SUPERVISOR_OUTCOME',
  ]);
  assert.equal(lines[0].fibonacci.confirmedDirection, 'BEARISH');
  assert.equal(lines[0].gemini.scorecard.riskScore, 70);
  assert.equal(lines[0].supervisor.profile, 'BEARISH');
  assert.equal(lines[0].risk.targetState, 'CAUTION');
  assert.equal(lines[0].action.applied, true);
  assert.equal(lines[0].action.investmentLimitUsdt, 150);
});

test('outcome journal restores pending Supervisor decisions after restart', async t => {
  const { options, journal } = fixture(t);
  await journal.recordDecision(decision(), context(), 1000);
  await journal.observePrice('TEST/USDT:USDT', 105, 1100);

  const restored = new AdaptiveSupervisorOutcomeJournal(options);
  assert.equal(restored.pendingCount(), 1);
  const outcomes = await restored.observePrice('TEST/USDT:USDT', 120, 1200);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].returnPct, 20);
  assert.equal(restored.pendingCount(), 0);
});

test('outcome journal ignores duplicate evaluations, invalid prices, and disabled mode', async t => {
  const { options, journal } = fixture(t);
  assert.equal(await journal.recordDecision(decision({ evaluated: false }), context(), 1000), false);
  assert.equal(await journal.recordDecision(decision(), { ...context(), currentPrice: 0 }, 1000), false);
  const disabled = new AdaptiveSupervisorOutcomeJournal({ ...options, enabled: false });
  assert.equal(await disabled.recordDecision(decision(), context(), 1000), false);
  assert.equal(journal.pendingCount(), 0);
});
