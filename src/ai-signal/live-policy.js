'use strict';

const fs = require('fs');

function denied(reason, decision = null) {
  return { allow: false, available: Boolean(decision), reason, decision };
}

function evaluateLiveEntry(state, symbol, side, options = {}) {
  if (state?.mode !== 'LIVE_ENTRY') return denied('AI signal feed is not in LIVE_ENTRY mode');
  const decision = state.latestBySymbol?.[symbol];
  if (!decision) return denied(`no AI decision for ${symbol}`);
  if (decision.source !== 'ANTIGRAVITY_OAUTH' || decision.error) {
    return denied('latest AI decision is not a valid OAuth result', decision);
  }
  const confidence = Number(decision.confidence);
  const minimumConfidence = Number(options.minimumConfidence) || 65;
  if (!Number.isFinite(confidence) || confidence < minimumConfidence) {
    return denied(`AI confidence is below ${minimumConfidence}%`, decision);
  }
  const generatedAt = Date.parse(decision.generatedAt);
  const now = Number(options.now) || Date.now();
  const horizonMs = Number(decision.horizonMinutes) * 60_000;
  const maximumAgeMs = Math.min(
    Number(options.maximumAgeMs) || 4 * 60 * 60_000,
    Number.isFinite(horizonMs) && horizonMs > 0 ? horizonMs : 0
  );
  const ageMs = now - generatedAt;
  if (!Number.isFinite(generatedAt) || maximumAgeMs <= 0 || ageMs < -60_000 || ageMs > maximumAgeMs) {
    return denied('AI decision is missing, future-dated, or expired', decision);
  }
  const action = String(decision.action || '').toUpperCase();
  if (action !== side) return denied(`AI action is ${action || 'invalid'}, not ${side}`, decision);
  return { allow: true, available: true, reason: `AI ${action} ${confidence}%`, decision };
}

function readLiveEntry(filePath, symbol, side, options = {}) {
  try {
    return evaluateLiveEntry(JSON.parse(fs.readFileSync(filePath, 'utf8')), symbol, side, options);
  } catch (error) {
    return denied(`AI signal state unavailable: ${error.message}`);
  }
}

function applyLiveEntryPolicy(signal, liveDecision, enabled) {
  if (!enabled) return { ...signal, entrySource: 'VOLUME_DELTA' };
  return {
    ...signal,
    deterministicAllow: Boolean(signal.allow),
    allow: Boolean(liveDecision?.allow),
    entrySource: 'ANTIGRAVITY_OAUTH',
    aiDecision: liveDecision || denied('AI decision unavailable'),
  };
}

module.exports = {
  applyLiveEntryPolicy,
  evaluateLiveEntry,
  readLiveEntry,
};
