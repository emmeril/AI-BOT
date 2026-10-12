const fs = require('fs');
const path = require('path');
const { AtomicFileWriter } = require('./atomic-file-writer');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HORIZONS_MS = [4 * HOUR_MS, 24 * HOUR_MS];

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function rounded(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function fibonacciSnapshot(analysis) {
  if (!analysis) return null;
  return {
    direction: analysis.direction || 'UNKNOWN',
    confirmedDirection: analysis.confirmedDirection || 'RANGING',
    score: Number.isFinite(Number(analysis.score)) ? Number(analysis.score) : null,
    confidence: Number.isFinite(Number(analysis.confidence)) ? Number(analysis.confidence) : null,
    alignment: Number.isFinite(Number(analysis.alignment)) ? Number(analysis.alignment) : null,
    generatedAt: analysis.generatedAt || null,
    timeframes: Object.fromEntries(Object.entries(analysis.timeframes || {}).map(([name, value]) => [name, {
      direction: value?.direction || 'UNKNOWN',
      score: Number.isFinite(Number(value?.score)) ? Number(value.score) : null,
      confidence: Number.isFinite(Number(value?.confidence)) ? Number(value.confidence) : null,
      atrPct: Number.isFinite(Number(value?.atrPct)) ? Number(value.atrPct) : null,
      volatilityRatio: Number.isFinite(Number(value?.volatilityRatio)) ? Number(value.volatilityRatio) : null,
      recentMoveAtr: Number.isFinite(Number(value?.recentMoveAtr)) ? Number(value.recentMoveAtr) : null,
      lastClosedAt: Number(value?.lastClosedAt) || null,
    }])),
  };
}

function supervisorSnapshot(decision) {
  return {
    mode: decision.mode,
    profile: decision.profile,
    rawProfile: decision.rawProfile,
    previousProfile: decision.previousProfile,
    changed: Boolean(decision.changed),
    candidateProfile: decision.candidateProfile,
    candidateCount: decision.candidateCount,
    confirmationsRequired: decision.confirmationsRequired,
    cooldownElapsed: Boolean(decision.cooldownElapsed),
    decisionSource: decision.decisionSource,
    deterministicProfile: decision.deterministicProfile,
    learning: decision.learning || null,
    reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
    exposurePct: decision.exposurePct,
  };
}

function riskSnapshot(decision) {
  return {
    mode: decision.riskStateMachineMode,
    state: decision.riskState,
    targetState: decision.riskTargetState,
    changed: Boolean(decision.riskStateChanged),
    reasons: Array.isArray(decision.riskReasons) ? decision.riskReasons : [],
    observed: decision.riskObserved || null,
  };
}

class AdaptiveSupervisorOutcomeJournal {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.mode = String(options.mode || 'SHADOW').toUpperCase();
    this.logPath = path.resolve(options.logPath || 'adaptive-supervisor-outcomes.jsonl');
    this.statePath = path.resolve(options.statePath || 'adaptive-supervisor-outcomes-state.json');
    this.horizonsMs = [...(options.horizonsMs || DEFAULT_HORIZONS_MS)]
      .map(Number)
      .filter(value => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
    this.maximumPending = Math.max(1, Number(options.maximumPending) || 2000);
    this.logger = options.logger || console;
    this.pending = new Map();
    this.writeQueue = Promise.resolve();
    if (this.enabled) this.loadState();
  }

  loadState() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.(`[ADAPTIVE-OUTCOME] Could not restore state: ${error.message}`);
      }
      return;
    }
    const records = Array.isArray(parsed?.pending) ? parsed.pending : [];
    for (const record of records.slice(-this.maximumPending)) {
      if (!record?.key || !record?.symbol || !finitePositive(record?.baselinePrice)) continue;
      this.pending.set(record.key, {
        ...record,
        outcomes: record.outcomes && typeof record.outcomes === 'object' ? record.outcomes : {},
      });
    }
  }

  stateContents() {
    return JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      horizonsMs: this.horizonsMs,
      pending: [...this.pending.values()],
    }, null, 2);
  }

  enqueue(operation) {
    const next = this.writeQueue.catch(() => {}).then(operation);
    this.writeQueue = next;
    return next;
  }

  async ensureDirectories() {
    const directories = new Set([path.dirname(this.logPath), path.dirname(this.statePath)]);
    await Promise.all([...directories].map(directory => fs.promises.mkdir(directory, { recursive: true })));
  }

  append(event) {
    return fs.promises.appendFile(this.logPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  persist() {
    return AtomicFileWriter.write(this.statePath, () => this.stateContents());
  }

  recordDecision(decision, context = {}, now = Date.now()) {
    if (!this.enabled || this.mode !== 'SHADOW' || !decision?.evaluated) return Promise.resolve(false);
    const baselinePrice = finitePositive(context.currentPrice);
    if (!baselinePrice || !decision.symbol || !decision.signalId) return Promise.resolve(false);
    const key = `${decision.symbol}:${decision.signalId}`;
    return this.enqueue(async () => {
      if (this.pending.has(key)) return false;
      const observedAtMs = Number(now) || Date.now();
      const record = {
        key,
        symbol: decision.symbol,
        signalId: decision.signalId,
        generatedAt: decision.generatedAt || new Date(observedAtMs).toISOString(),
        observedAtMs,
        baselinePrice,
        fibonacci: fibonacciSnapshot(context.analysis),
        gemini: decision.gemini || null,
        supervisor: supervisorSnapshot(decision),
        risk: riskSnapshot(decision),
        action: {
          applied: decision.mode === 'LIVE',
          recommendation: decision.recommendation || null,
          investmentLimitUsdt: Number(context.investmentLimitUsdt) || null,
        },
        outcomes: {},
      };
      this.pending.set(key, record);
      while (this.pending.size > this.maximumPending) {
        this.pending.delete(this.pending.keys().next().value);
      }
      await this.ensureDirectories();
      await this.append({
        type: 'SUPERVISOR_DECISION',
        journalMode: this.mode,
        recordedAt: new Date(observedAtMs).toISOString(),
        ...record,
      });
      await this.persist();
      return true;
    });
  }

  observePrice(symbol, price, now = Date.now()) {
    if (!this.enabled || this.mode !== 'SHADOW') return Promise.resolve([]);
    const observedPrice = finitePositive(price);
    if (!observedPrice) return Promise.resolve([]);
    return this.enqueue(async () => {
      const observedAtMs = Number(now) || Date.now();
      const events = [];
      let changed = false;
      for (const [key, record] of this.pending) {
        if (record.symbol !== symbol) continue;
        for (const horizonMs of this.horizonsMs) {
          const horizonKey = String(horizonMs);
          if (record.outcomes[horizonKey] || observedAtMs - record.observedAtMs < horizonMs) continue;
          const returnPct = ((observedPrice - record.baselinePrice) / record.baselinePrice) * 100;
          const outcome = {
            observedAt: new Date(observedAtMs).toISOString(),
            observedPrice,
            returnPct: rounded(returnPct),
          };
          record.outcomes[horizonKey] = outcome;
          events.push({
            type: 'SUPERVISOR_OUTCOME',
            journalMode: this.mode,
            key,
            symbol,
            signalId: record.signalId,
            finalProfile: record.supervisor.profile,
            decisionSource: record.supervisor.decisionSource,
            recommendation: record.action.recommendation,
            baselinePrice: record.baselinePrice,
            horizonHours: rounded(horizonMs / HOUR_MS, 4),
            ...outcome,
          });
          changed = true;
        }
        if (this.horizonsMs.every(horizonMs => record.outcomes[String(horizonMs)])) {
          this.pending.delete(key);
        }
      }
      if (!changed) return events;
      await this.ensureDirectories();
      for (const event of events) await this.append(event);
      await this.persist();
      return events;
    });
  }

  pendingCount() {
    return this.pending.size;
  }

  flush() {
    return this.writeQueue.catch(() => {});
  }
}

module.exports = {
  DEFAULT_HORIZONS_MS,
  AdaptiveSupervisorOutcomeJournal,
  fibonacciSnapshot,
  riskSnapshot,
  supervisorSnapshot,
};
