'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { requestAntigravity } = require('../ai-signal/antigravity-client');
const { AI_REVIEW_POLICY_ID, candidateFingerprint, forecastReviewExpiry, reviewableForecast,
  decisionRejection, buildReviewSnapshot } = require('./ai-review-policy');

function loadAiReviewState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || state.policyId !== AI_REVIEW_POLICY_ID || !Array.isArray(state.reviews)) {
      throw new Error('Invalid predictive AI review state');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, policyId: AI_REVIEW_POLICY_ID, reviews: [] };
    throw error;
  }
}

function saveAiReviewState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

class PredictiveAiReviewService {
  constructor({ config, environment = {}, provider, now = Date.now, isCurrent = () => true,
    state, save, onUpdate = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
    this.config = config;
    this.now = now;
    this.isCurrent = isCurrent;
    this.onUpdate = onUpdate;
    this.schedule = schedule;
    this.cancel = cancel;
    this.state = state || loadAiReviewState(config.stateFile);
    this.save = save || (() => saveAiReviewState(config.stateFile, this.state));
    this.provider = provider || ((snapshots, options) => requestAntigravity(snapshots,
      { ...options, environment, binary: config.binary, model: config.model, effort: config.effort,
        minimumConfidence: config.minimumConfidence, timeoutMs: config.timeoutMs,
        strictDeadline: true, purpose: 'PREDICTIVE_ENTRY_REVIEW', liveEnabled: true }));
    this.job = null;
    this.stopped = false;
    for (const row of this.state.reviews) {
      if (row.status === 'PENDING') Object.assign(row, { status: 'UNAVAILABLE',
        reason: 'AI_REVIEW_WORKER_RESTARTED', completedAt: this.now() });
    }
    if (config.enabled) this.persist();
  }

  persist() {
    this.state.updatedAt = this.now();
    this.state.enabled = this.config.enabled;
    this.state.model = this.config.model;
    this.state.effort = this.config.effort;
    this.state.failureMode = this.config.failureMode;
    this.state.positionExitPolicy = this.config.positionExitPolicy;
    this.state.configId = this.config.configId;
    this.state.timeoutMs = this.config.timeoutMs;
    this.state.reviews = this.state.reviews.slice(-this.config.historyLimit);
    this.save();
  }

  publish(review) {
    this.persist();
    this.onUpdate({ reviewId: review.id, forecastId: review.forecastId, status: review.status,
      reason: review.reason, model: review.model, durationMs: review.completedAt == null ? null : review.completedAt - review.requestedAt,
      decision: review.decision || null });
  }

  consider(forecast, candles) {
    if (this.stopped || !this.config.enabled || !reviewableForecast(forecast, this.now())) {
      return { started: false, reason: 'AI_REVIEW_NOT_NEEDED' };
    }
    const fingerprint = candidateFingerprint(forecast);
    if (this.state.reviews.some(row => row.forecastId === forecast.id &&
        row.candidateFingerprint === fingerprint && row.configId === this.config.configId)) {
      return { started: false, reason: 'AI_REVIEW_ALREADY_REQUESTED' };
    }
    if (this.job) return { started: false, reason: 'AI_REVIEW_BUSY' };
    const frozen = structuredClone(forecast);
    const requestedAt = this.now();
    const review = { id: `${AI_REVIEW_POLICY_ID}:${forecast.id}:${fingerprint.slice(0, 16)}:${requestedAt}`,
      policyId: AI_REVIEW_POLICY_ID, configId: this.config.configId, model: this.config.model, effort: this.config.effort,
      forecastId: forecast.id, candidateFingerprint: fingerprint, requestedAt,
      expiresAt: forecastReviewExpiry(forecast), status: 'PENDING', reason: 'AI_REVIEW_PENDING' };
    this.state.reviews.push(review);
    try { review.snapshot = buildReviewSnapshot(frozen, candles, requestedAt, this.config); }
    catch (error) {
      Object.assign(review, { status: 'UNAVAILABLE', reason: 'AI_REVIEW_INVALID_MARKET_DATA',
        completedAt: this.now(), diagnostic: String(error.message).slice(0, 200) });
      this.publish(review);
      return { started: false, reason: review.reason };
    }
    this.publish(review);
    const controller = new AbortController();
    const job = { controller, promise: null };
    this.job = job;
    job.promise = this.run(frozen, review, controller).catch(error => {
      Object.assign(review, { status: 'UNAVAILABLE', reason: 'AI_REVIEW_SAVE_FAILED' });
      this.onUpdate({ forecastId: review.forecastId, status: review.status, reason: review.reason,
        diagnostic: String(error.message).slice(0, 200) });
    }).finally(() => { if (this.job === job) this.job = null; });
    return { started: true, reviewId: review.id, reason: 'AI_REVIEW_PENDING' };
  }

  async run(forecast, review, controller) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = this.schedule(() => {
        const error = new Error('AI review exceeded the response deadline');
        error.code = 'AI_REVIEW_TIMEOUT';
        reject(error);
        controller.abort();
      }, this.config.timeoutMs);
      timer?.unref?.();
    });
    let removeAbort;
    const cancelled = new Promise((_, reject) => {
      const listener = () => {
        const error = new Error('AI review cancelled');
        error.code = 'AI_REVIEW_CANCELLED';
        reject(error);
      };
      controller.signal.addEventListener('abort', listener, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', listener);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.provider([review.snapshot], { signal: controller.signal })), deadline, cancelled,
      ]);
      review.completedAt = this.now();
      if (this.stopped || controller.signal.aborted) {
        Object.assign(review, { status: 'UNAVAILABLE', reason: 'AI_REVIEW_CANCELLED' });
      } else if (review.completedAt - review.requestedAt > this.config.timeoutMs || review.completedAt >= review.expiresAt) {
        Object.assign(review, { status: 'UNAVAILABLE', reason: 'AI_REVIEW_TIMEOUT' });
      } else if (!this.isCurrent(forecast) || candidateFingerprint(forecast) !== review.candidateFingerprint) {
        Object.assign(review, { status: 'UNAVAILABLE', reason: 'AI_REVIEW_SUPERSEDED' });
      } else {
        const decision = Array.isArray(result?.decisions) && result.decisions.length === 1 ? result.decisions[0] : null;
        const reason = decisionRejection(decision, forecast, this.config);
        Object.assign(review, { status: reason ? 'REJECTED' : 'APPROVED', reason: reason || 'AI_REVIEW_APPROVED',
          decision: decision ? structuredClone(decision) : null, metadata: result?.metadata || null });
      }
    } catch (error) {
      const timedOut = this.now() - review.requestedAt >= this.config.timeoutMs || error.code === 'AI_REVIEW_TIMEOUT';
      Object.assign(review, { completedAt: this.now(), status: 'UNAVAILABLE',
        reason: timedOut ? 'AI_REVIEW_TIMEOUT' : this.stopped ? 'AI_REVIEW_CANCELLED' : 'AI_REVIEW_PROVIDER_ERROR' });
    } finally {
      this.cancel(timer);
      removeAbort?.();
    }
    this.publish(review);
  }

  async idle() { if (this.job) await this.job.promise; }

  async stop() {
    this.stopped = true;
    this.job?.controller.abort();
    await this.idle();
  }
}

module.exports = { PredictiveAiReviewService, loadAiReviewState, saveAiReviewState };
