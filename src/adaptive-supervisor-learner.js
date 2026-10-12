const fs = require('fs');
const path = require('path');
const { AtomicFileWriter } = require('./atomic-file-writer');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_POLICY = Object.freeze({
  schemaVersion: 1,
  version: 'default-v1',
  alignedMinConfidence: 0.6,
  conflictMinConfidence: 0.6,
  source: 'DEFAULT',
});
const CONFIDENCE_GRID = Object.freeze([0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]);

function round(value, digits = 6) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
}

function validatePolicy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const aligned = Number(raw.alignedMinConfidence);
  const conflict = Number(raw.conflictMinConfidence);
  if (!(aligned >= 0.6 && aligned <= 0.9)) return null;
  if (!(conflict >= aligned && conflict <= 0.9)) return null;
  return {
    schemaVersion: 1,
    version: String(raw.version || 'unknown').slice(0, 120),
    alignedMinConfidence: round(aligned, 2),
    conflictMinConfidence: round(conflict, 2),
    source: String(raw.source || 'FILE').slice(0, 40),
    generatedAt: raw.generatedAt || null,
    evidence: raw.evidence || null,
  };
}

function parseJournal(contents) {
  if (!contents.trim()) return [];
  const events = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return events;
}

function profileCorrect(profile, returnPct, moveThresholdPct = 0.5) {
  const movement = Number(returnPct);
  if (!Number.isFinite(movement)) return null;
  if (profile === 'BULLISH') return movement >= moveThresholdPct;
  if (profile === 'BEARISH' || profile === 'RISK_OFF') return movement <= -moveThresholdPct;
  if (profile === 'SIDEWAYS') return Math.abs(movement) < moveThresholdPct;
  return null;
}

function decisionSignature(decision) {
  return [
    decision.supervisor?.profile || 'UNKNOWN',
    decision.supervisor?.decisionSource || 'UNKNOWN',
    decision.gemini?.profile || 'NO_GEMINI',
    decision.supervisor?.deterministicProfile || 'UNKNOWN',
  ].join('|');
}

function buildEpisodes(events, options = {}) {
  const horizonHours = Number(options.horizonHours) || 4;
  const episodeGapMs = (Number(options.episodeGapMinutes) || 120) * 60 * 1000;
  const moveThresholdPct = Number(options.moveThresholdPct) || 0.5;
  const decisions = new Map();
  const outcomes = new Map();
  for (const event of events) {
    if (event?.type === 'SUPERVISOR_DECISION' && event.key) decisions.set(event.key, event);
    if (event?.type === 'SUPERVISOR_OUTCOME' && event.key &&
        Math.abs(Number(event.horizonHours) - horizonHours) < 1e-6) {
      outcomes.set(event.key, event);
    }
  }
  const completed = [...decisions.values()]
    .filter(decision => outcomes.has(decision.key))
    .map(decision => ({
      decision,
      outcome: outcomes.get(decision.key),
      observedAtMs: Number(decision.observedAtMs) || Date.parse(decision.recordedAt || decision.generatedAt),
      signature: decisionSignature(decision),
    }))
    .filter(item => Number.isFinite(item.observedAtMs))
    .sort((left, right) => left.observedAtMs - right.observedAtMs);

  const activeBySymbol = new Map();
  const episodes = [];
  for (const item of completed) {
    const previous = activeBySymbol.get(item.decision.symbol);
    if (previous && previous.signature === item.signature &&
        item.observedAtMs - previous.lastObservedAtMs <= episodeGapMs) {
      previous.lastObservedAtMs = item.observedAtMs;
      previous.sampleCount += 1;
      continue;
    }
    const finalProfile = item.decision.supervisor?.profile || null;
    const deterministicProfile = item.decision.supervisor?.deterministicProfile || null;
    const geminiProfile = item.decision.gemini?.profile || null;
    const episode = {
      key: item.decision.key,
      symbol: item.decision.symbol,
      startedAt: item.decision.recordedAt || item.decision.generatedAt || null,
      observedAtMs: item.observedAtMs,
      lastObservedAtMs: item.observedAtMs,
      sampleCount: 1,
      signature: item.signature,
      finalProfile,
      deterministicProfile,
      decisionSource: item.decision.supervisor?.decisionSource || 'UNKNOWN',
      geminiAccepted: Boolean(item.decision.gemini?.accepted),
      geminiProfile,
      geminiConfidence: Number(item.decision.gemini?.confidence),
      alignment: geminiProfile && deterministicProfile
        ? (geminiProfile === deterministicProfile ? 'ALIGNED' : 'CONFLICT')
        : 'NO_GEMINI',
      returnPct: Number(item.outcome.returnPct),
      correct: profileCorrect(finalProfile, item.outcome.returnPct, moveThresholdPct),
      decision: item.decision,
    };
    episodes.push(episode);
    activeBySymbol.set(item.decision.symbol, episode);
  }
  return episodes;
}

function summarize(episodes, keyFor) {
  const groups = new Map();
  for (const episode of episodes) {
    const key = String(keyFor(episode) || 'UNKNOWN');
    const group = groups.get(key) || { total: 0, correct: 0, returnSum: 0 };
    group.total += 1;
    if (episode.correct === true) group.correct += 1;
    group.returnSum += Number.isFinite(episode.returnPct) ? episode.returnPct : 0;
    groups.set(key, group);
  }
  return Object.fromEntries([...groups].map(([key, group]) => [key, {
    total: group.total,
    correct: group.correct,
    accuracy: group.total ? round(group.correct / group.total, 4) : null,
    averageReturnPct: group.total ? round(group.returnSum / group.total, 6) : null,
  }]));
}

function buildLearningReport(events, options = {}) {
  const horizons = options.horizons || [4, 24];
  const sections = {};
  for (const horizonHours of horizons) {
    const episodes = buildEpisodes(events, { ...options, horizonHours });
    sections[`${horizonHours}h`] = {
      episodes: episodes.length,
      correct: episodes.filter(episode => episode.correct === true).length,
      accuracy: episodes.length
        ? round(episodes.filter(episode => episode.correct === true).length / episodes.length, 4)
        : null,
      byProfile: summarize(episodes, episode => episode.finalProfile),
      bySource: summarize(episodes, episode => episode.decisionSource),
      byAlignment: summarize(episodes, episode => episode.alignment),
      bySymbol: summarize(episodes, episode => episode.symbol),
    };
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date(options.now || Date.now()).toISOString(),
    scoring: {
      moveThresholdPct: Number(options.moveThresholdPct) || 0.5,
      episodeGapMinutes: Number(options.episodeGapMinutes) || 120,
      rule: 'BULLISH >= threshold, BEARISH/RISK_OFF <= -threshold, SIDEWAYS inside threshold',
    },
    horizons: sections,
  };
}

function selectedProfile(episode, policy) {
  if (episode.decisionSource === 'DETERMINISTIC_SAFETY') return episode.finalProfile;
  if (!episode.geminiAccepted || !episode.geminiProfile || !Number.isFinite(episode.geminiConfidence)) {
    return episode.deterministicProfile || episode.finalProfile;
  }
  const threshold = episode.alignment === 'ALIGNED'
    ? policy.alignedMinConfidence
    : policy.conflictMinConfidence;
  return episode.geminiConfidence >= threshold
    ? episode.geminiProfile
    : (episode.deterministicProfile || episode.finalProfile);
}

function evaluatePolicy(episodes, policy, moveThresholdPct = 0.5) {
  let correct = 0;
  for (const episode of episodes) {
    if (profileCorrect(selectedProfile(episode, policy), episode.returnPct, moveThresholdPct)) correct += 1;
  }
  return {
    total: episodes.length,
    correct,
    accuracy: episodes.length ? round(correct / episodes.length, 6) : null,
  };
}

function policyDistance(left, right) {
  return Math.abs(left.alignedMinConfidence - right.alignedMinConfidence) +
    Math.abs(left.conflictMinConfidence - right.conflictMinConfidence);
}

function buildPolicyCandidate(events, activePolicy, options = {}) {
  const minimumEpisodes = Math.max(10, Number(options.minimumEpisodes) || 30);
  const validationRatio = Number(options.validationRatio) || 0.3;
  const moveThresholdPct = Number(options.moveThresholdPct) || 0.5;
  const episodes = buildEpisodes(events, {
    horizonHours: Number(options.horizonHours) || 4,
    episodeGapMinutes: Number(options.episodeGapMinutes) || 120,
    moveThresholdPct,
  }).filter(episode => episode.geminiAccepted && episode.decisionSource !== 'DETERMINISTIC_SAFETY');
  if (episodes.length < minimumEpisodes) {
    return {
      status: 'WAITING_FOR_SAMPLES',
      eligible: false,
      episodes: episodes.length,
      minimumEpisodes,
      reasons: [`need_${minimumEpisodes - episodes.length}_more_episodes`],
    };
  }

  const validationCount = Math.max(5, Math.floor(episodes.length * validationRatio));
  const splitAt = episodes.length - validationCount;
  const training = episodes.slice(0, splitAt);
  const validation = episodes.slice(splitAt);
  let bestPolicy = activePolicy;
  let bestTraining = evaluatePolicy(training, activePolicy, moveThresholdPct);
  for (const alignedMinConfidence of CONFIDENCE_GRID) {
    for (const conflictMinConfidence of CONFIDENCE_GRID) {
      if (conflictMinConfidence < alignedMinConfidence) continue;
      const policy = { alignedMinConfidence, conflictMinConfidence };
      const score = evaluatePolicy(training, policy, moveThresholdPct);
      const better = score.accuracy > bestTraining.accuracy ||
        (score.accuracy === bestTraining.accuracy &&
          policyDistance(policy, activePolicy) < policyDistance(bestPolicy, activePolicy));
      if (better) {
        bestPolicy = policy;
        bestTraining = score;
      }
    }
  }

  const activeValidation = evaluatePolicy(validation, activePolicy, moveThresholdPct);
  const candidateValidation = evaluatePolicy(validation, bestPolicy, moveThresholdPct);
  const minimumAccuracy = Number(options.minimumValidationAccuracy) || 0.55;
  const minimumImprovement = Number(options.minimumImprovement) || 0.03;
  const improvement = candidateValidation.accuracy - activeValidation.accuracy;
  const changed = policyDistance(bestPolicy, activePolicy) > 1e-9;
  const reasons = [];
  if (!changed) reasons.push('candidate_matches_active_policy');
  if (candidateValidation.accuracy < minimumAccuracy) reasons.push('validation_accuracy_below_minimum');
  if (improvement < minimumImprovement) reasons.push('validation_improvement_below_minimum');
  return {
    status: reasons.length ? 'REJECTED' : 'ELIGIBLE',
    eligible: reasons.length === 0,
    episodes: episodes.length,
    minimumEpisodes,
    horizonHours: Number(options.horizonHours) || 4,
    training: { active: evaluatePolicy(training, activePolicy, moveThresholdPct), candidate: bestTraining },
    validation: { active: activeValidation, candidate: candidateValidation, improvement: round(improvement, 6) },
    policy: {
      alignedMinConfidence: bestPolicy.alignedMinConfidence,
      conflictMinConfidence: bestPolicy.conflictMinConfidence,
    },
    reasons,
  };
}

class AdaptiveSupervisorLearner {
  constructor(options = {}) {
    this.options = {
      enabled: false,
      autoApply: false,
      intervalMs: HOUR_MS,
      minimumEpisodes: 30,
      validationRatio: 0.3,
      minimumValidationAccuracy: 0.55,
      minimumImprovement: 0.03,
      horizonHours: 4,
      episodeGapMinutes: 120,
      moveThresholdPct: 0.5,
      journalPath: 'adaptive-supervisor-outcomes.jsonl',
      reportPath: 'adaptive-supervisor-learning-report.json',
      candidatePath: 'adaptive-supervisor-policy-candidate.json',
      policyPath: 'adaptive-supervisor-learning-policy.json',
      ...options,
    };
    this.logger = options.logger || console;
    this.activePolicy = this.loadPolicy();
    this.lastRunAt = 0;
    this.inFlight = null;
  }

  loadPolicy() {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(this.options.policyPath), 'utf8'));
      const policy = validatePolicy(parsed);
      if (!policy) throw new Error('policy values are outside allowed bounds');
      return policy;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.(`[ADAPTIVE-LEARNING] Ignoring invalid policy: ${error.message}`);
      }
      return { ...DEFAULT_POLICY };
    }
  }

  getActivePolicy() {
    return { ...this.activePolicy };
  }

  async writeJson(filePath, value) {
    const resolved = path.resolve(filePath);
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await AtomicFileWriter.write(resolved, () => `${JSON.stringify(value, null, 2)}\n`);
  }

  async run(now = Date.now()) {
    let contents = '';
    try {
      contents = await fs.promises.readFile(path.resolve(this.options.journalPath), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const events = parseJournal(contents);
    const common = {
      now,
      moveThresholdPct: this.options.moveThresholdPct,
      episodeGapMinutes: this.options.episodeGapMinutes,
    };
    const report = buildLearningReport(events, common);
    await this.writeJson(this.options.reportPath, report);
    const candidate = buildPolicyCandidate(events, this.activePolicy, {
      ...common,
      minimumEpisodes: this.options.minimumEpisodes,
      validationRatio: this.options.validationRatio,
      minimumValidationAccuracy: this.options.minimumValidationAccuracy,
      minimumImprovement: this.options.minimumImprovement,
      horizonHours: this.options.horizonHours,
    });
    const candidateDocument = {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      activePolicy: this.activePolicy,
      ...candidate,
    };
    await this.writeJson(this.options.candidatePath, candidateDocument);

    let promoted = false;
    if (candidate.eligible && this.options.autoApply) {
      const promotedPolicy = validatePolicy({
        ...candidate.policy,
        version: `learned-${new Date(now).toISOString()}`,
        source: 'AUTO_LEARNING',
        generatedAt: new Date(now).toISOString(),
        evidence: {
          episodes: candidate.episodes,
          horizonHours: candidate.horizonHours,
          validation: candidate.validation,
        },
      });
      await this.writeJson(this.options.policyPath, promotedPolicy);
      this.activePolicy = promotedPolicy;
      promoted = true;
      this.logger.log?.(
        `[ADAPTIVE-LEARNING] Promoted policy ${promotedPolicy.version}: ` +
        `aligned>=${promotedPolicy.alignedMinConfidence}, conflict>=${promotedPolicy.conflictMinConfidence}`
      );
    }
    return { report, candidate: candidateDocument, promoted, activePolicy: this.getActivePolicy() };
  }

  runIfDue(now = Date.now()) {
    if (!this.options.enabled) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight;
    if (now - this.lastRunAt < Math.max(1000, Number(this.options.intervalMs) || HOUR_MS)) {
      return Promise.resolve(null);
    }
    this.lastRunAt = now;
    this.inFlight = this.run(now)
      .catch(error => {
        this.logger.warn?.(`[ADAPTIVE-LEARNING] Run failed: ${error.message}`);
        return null;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}

module.exports = {
  CONFIDENCE_GRID,
  DEFAULT_POLICY,
  AdaptiveSupervisorLearner,
  buildEpisodes,
  buildLearningReport,
  buildPolicyCandidate,
  evaluatePolicy,
  parseJournal,
  profileCorrect,
  selectedProfile,
  validatePolicy,
};
