'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyLiveEntryPolicy, evaluateLiveEntry } = require('../src/ai-signal/live-policy');

const now = Date.UTC(2026, 10, 2, 3, 0, 0);

function stateWith(overrides = {}) {
  return {
    mode: 'LIVE_ENTRY',
    latestBySymbol: {
      'DOGE/USDT:USDT': {
        action: 'LONG',
        confidence: 72,
        horizonMinutes: 60,
        generatedAt: new Date(now - 15 * 60_000).toISOString(),
        source: 'ANTIGRAVITY_OAUTH',
        error: null,
        ...overrides,
      },
    },
  };
}

test('live policy allows only a fresh matching OAuth decision', () => {
  const long = evaluateLiveEntry(stateWith(), 'DOGE/USDT:USDT', 'LONG', { now });
  const short = evaluateLiveEntry(stateWith(), 'DOGE/USDT:USDT', 'SHORT', { now });
  assert.equal(long.allow, true);
  assert.equal(short.allow, false);
  assert.match(short.reason, /not SHORT/);
});

test('live policy fails closed for shadow, stale, low-confidence, and provider-error states', () => {
  assert.equal(evaluateLiveEntry({ ...stateWith(), mode: 'SHADOW_ONLY' }, 'DOGE/USDT:USDT', 'LONG', { now }).allow, false);
  assert.equal(evaluateLiveEntry(stateWith({ confidence: 50 }), 'DOGE/USDT:USDT', 'LONG', { now }).allow, false);
  assert.equal(evaluateLiveEntry(stateWith({
    generatedAt: new Date(now - 61 * 60_000).toISOString(),
  }), 'DOGE/USDT:USDT', 'LONG', { now }).allow, false);
  assert.equal(evaluateLiveEntry(stateWith({
    source: 'ANTIGRAVITY_ERROR',
    error: 'quota',
  }), 'DOGE/USDT:USDT', 'LONG', { now }).allow, false);
});

test('entry policy replaces deterministic entry only when live mode is enabled', () => {
  const signal = { allow: false, exit: false };
  const live = applyLiveEntryPolicy(signal, { allow: true, decision: { action: 'LONG' } }, true);
  const disabled = applyLiveEntryPolicy(signal, null, false);
  assert.equal(live.allow, true);
  assert.equal(live.deterministicAllow, false);
  assert.equal(live.entrySource, 'ANTIGRAVITY_OAUTH');
  assert.equal(disabled.allow, false);
  assert.equal(disabled.entrySource, 'VOLUME_DELTA');
});
