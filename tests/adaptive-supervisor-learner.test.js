const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_POLICY,
  AdaptiveSupervisorLearner,
  buildEpisodes,
  buildLearningReport,
  buildPolicyCandidate,
} = require('../src/adaptive-supervisor-learner');

function eventPair(index, overrides = {}) {
  const observedAtMs = index * 3 * 60 * 60 * 1000;
  const key = `TEST:${index}`;
  const decision = {
    type: 'SUPERVISOR_DECISION',
    key,
    symbol: overrides.symbol || 'TEST/USDT:USDT',
    observedAtMs,
    recordedAt: new Date(observedAtMs).toISOString(),
    supervisor: {
      profile: overrides.finalProfile || 'BULLISH',
      deterministicProfile: overrides.deterministicProfile || 'BEARISH',
      decisionSource: overrides.decisionSource || 'GEMINI',
    },
    gemini: overrides.gemini === null ? null : {
      accepted: true,
      profile: overrides.geminiProfile || 'BULLISH',
      confidence: overrides.geminiConfidence ?? 0.65,
    },
  };
  const outcome = {
    type: 'SUPERVISOR_OUTCOME',
    key,
    symbol: decision.symbol,
    horizonHours: overrides.horizonHours || 4,
    returnPct: overrides.returnPct ?? -1,
  };
  return [decision, outcome];
}

function learningEvents(count = 40) {
  return Array.from({ length: count }, (_, index) => eventPair(index)).flat();
}

test('learning report groups repeated decisions into market episodes', () => {
  const [firstDecision, firstOutcome] = eventPair(1);
  const [repeatDecision, repeatOutcome] = eventPair(2);
  repeatDecision.observedAtMs = firstDecision.observedAtMs + 30 * 60 * 1000;
  repeatDecision.recordedAt = new Date(repeatDecision.observedAtMs).toISOString();
  repeatDecision.key = 'TEST:repeat';
  repeatOutcome.key = repeatDecision.key;
  const events = [firstDecision, firstOutcome, repeatDecision, repeatOutcome];

  const episodes = buildEpisodes(events, { horizonHours: 4, episodeGapMinutes: 120 });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].sampleCount, 2);

  const report = buildLearningReport(events, { horizons: [4], episodeGapMinutes: 120, now: 1 });
  assert.equal(report.horizons['4h'].episodes, 1);
  assert.equal(report.horizons['4h'].byAlignment.CONFLICT.total, 1);
});

test('policy candidate raises conflict confidence when deterministic profiles validate better', () => {
  const candidate = buildPolicyCandidate(learningEvents(), DEFAULT_POLICY, {
    minimumEpisodes: 30,
    validationRatio: 0.3,
    minimumValidationAccuracy: 0.55,
    minimumImprovement: 0.03,
    horizonHours: 4,
  });

  assert.equal(candidate.eligible, true);
  assert.equal(candidate.policy.alignedMinConfidence, 0.6);
  assert.equal(candidate.policy.conflictMinConfidence, 0.7);
  assert.equal(candidate.validation.active.accuracy, 0);
  assert.equal(candidate.validation.candidate.accuracy, 1);
});

test('automatic learner promotes only an eligible bounded policy', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-learning-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, 'journal.jsonl');
  const reportPath = path.join(directory, 'report.json');
  const candidatePath = path.join(directory, 'candidate.json');
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(journalPath, `${learningEvents().map(JSON.stringify).join('\n')}\n`);
  const learner = new AdaptiveSupervisorLearner({
    enabled: true,
    autoApply: true,
    minimumEpisodes: 30,
    journalPath,
    reportPath,
    candidatePath,
    policyPath,
    logger: { log() {}, warn() {} },
  });

  const result = await learner.run(1_000_000);
  assert.equal(result.promoted, true);
  assert.equal(learner.getActivePolicy().source, 'AUTO_LEARNING');
  assert.equal(learner.getActivePolicy().conflictMinConfidence, 0.7);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).horizons['4h'].episodes, 40);
  assert.equal(JSON.parse(fs.readFileSync(candidatePath, 'utf8')).eligible, true);
  assert.equal(JSON.parse(fs.readFileSync(policyPath, 'utf8')).conflictMinConfidence, 0.7);
});

test('learner waits without changing policy while completed episodes are insufficient', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-learning-wait-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, 'journal.jsonl');
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(journalPath, `${learningEvents(5).map(JSON.stringify).join('\n')}\n`);
  const learner = new AdaptiveSupervisorLearner({
    enabled: true,
    autoApply: true,
    minimumEpisodes: 30,
    journalPath,
    reportPath: path.join(directory, 'report.json'),
    candidatePath: path.join(directory, 'candidate.json'),
    policyPath,
    logger: { log() {}, warn() {} },
  });

  const result = await learner.run(1_000_000);
  assert.equal(result.promoted, false);
  assert.equal(result.candidate.status, 'WAITING_FOR_SAMPLES');
  assert.equal(fs.existsSync(policyPath), false);
  assert.deepEqual(learner.getActivePolicy(), DEFAULT_POLICY);
});
