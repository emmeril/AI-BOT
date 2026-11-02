'use strict';

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMarketSnapshot } = require('../src/ai-signal/market-snapshot');
const {
  buildPrompt,
  normalizeDecisions,
  parseEnvelope,
  requestAntigravity,
} = require('../src/ai-signal/antigravity-client');
const {
  AiSignalShadowService,
  buildShadowConfig,
  directionalReturn,
  emptyState,
  scoreMaturedDecisions,
} = require('../src/ai-signal/shadow-service');
const { featureRegimeKey, shouldRequestProvider } = require('../src/ai-signal/signal-gate');

function klines(count = 110, start = Date.UTC(2026, 0, 1), interval = 15 * 60_000) {
  return Array.from({ length: count }, (_, index) => {
    const openTime = start + index * interval;
    const close = 1 + index * 0.001;
    const quoteVolume = 1000 + index;
    return [
      openTime,
      close - 0.0005,
      close + 0.001,
      close - 0.001,
      close,
      100,
      openTime + interval - 1,
      quoteVolume,
      10,
      55,
      quoteVolume * 0.55,
    ];
  });
}

test('market snapshot uses completed candles and compact numeric features', () => {
  const rows = klines();
  const now = rows.at(-1)[6] + 1;
  const snapshot = buildMarketSnapshot('DOGE/USDT:USDT', rows, { now });
  assert.equal(snapshot.symbol, 'DOGE/USDT:USDT');
  assert.equal(snapshot.candleCloseTime, rows.at(-1)[6]);
  assert.ok(snapshot.returnsPct.h24 > 0);
  assert.ok(snapshot.emaGapPct > 0);
  assert.ok(snapshot.flowDelta.h1 > 0);
  assert.ok(snapshot.volumeRatio20 > 1);
});

test('Antigravity response is strict and low confidence fails closed to HOLD', () => {
  const decisions = normalizeDecisions({ decisions: [{
    symbol: 'DOGE/USDT:USDT',
    action: 'LONG',
    confidence: 60,
    horizonMinutes: 60,
    risk: 'MEDIUM',
    reasonCodes: ['TREND'],
    reason: 'Trend is positive but the edge is weak.',
  }] }, ['DOGE/USDT:USDT'], 65);
  assert.equal(decisions[0].requestedAction, 'LONG');
  assert.equal(decisions[0].action, 'HOLD');
  assert.throws(() => normalizeDecisions({ decisions: [] }, ['DOGE/USDT:USDT']), /exactly one/);
});

test('Antigravity prompt forbids tools and direct order control', () => {
  const prompt = buildPrompt([{ symbol: 'DOGE/USDT:USDT', close: 1 }]);
  assert.match(prompt, /observation only/);
  assert.match(prompt, /cannot place or manage orders/i);
  assert.match(prompt, /Do not use tools/);
  assert.match(prompt, /HOLD when evidence conflicts/);
});

test('live Antigravity prompt discloses automated entry use without granting order access', () => {
  const prompt = buildPrompt(
    [{ symbol: 'DOGE/USDT:USDT', close: 1 }],
    { liveEnabled: true }
  );
  assert.match(prompt, /may authorize an automated LONG or SHORT entry/);
  assert.match(prompt, /cannot place or manage orders/i);
  assert.doesNotMatch(prompt, /observation only/);
});

test('Antigravity JSON envelope parser rejects non-success status', () => {
  const parsed = parseEnvelope(JSON.stringify({
    status: 'SUCCESS',
    response: JSON.stringify({ decisions: [] }),
    conversation_id: 'test',
  }));
  assert.deepEqual(parsed.payload, { decisions: [] });
  assert.throws(() => parseEnvelope(JSON.stringify({ status: 'ERROR', error: 'quota' })), /quota/);
});

test('Antigravity parser accepts repeated schema objects and uses the final decision', () => {
  const response = `${JSON.stringify({ decisions: [{ action: 'HOLD' }] })}\n` +
    `${JSON.stringify({ decisions: [{ action: 'SHORT' }] })}\n`;
  const parsed = parseEnvelope(JSON.stringify({ status: 'SUCCESS', response }));
  assert.equal(parsed.payload.decisions[0].action, 'SHORT');
});

test('Antigravity parser prefers the official structured output field', () => {
  const parsed = parseEnvelope(JSON.stringify({
    status: 'SUCCESS',
    response: 'not-json',
    structured_output: { decisions: [{ action: 'HOLD' }] },
  }));
  assert.equal(parsed.payload.decisions[0].action, 'HOLD');
});

test('Antigravity OAuth invocation strips API credentials from its child process', async () => {
  let childOptions;
  const result = await requestAntigravity([{ symbol: 'DOGE/USDT:USDT', close: 1 }], {
    environment: {
      GEMINI_API_KEY: 'must-not-pass',
      GOOGLE_API_KEY: 'must-not-pass',
      GOOGLE_APPLICATION_CREDENTIALS: '/must/not/pass.json',
    },
    execFile: async (_binary, _args, options) => {
      childOptions = options;
      return {
        stdout: JSON.stringify({
          status: 'SUCCESS',
          response: JSON.stringify({ decisions: [{
            symbol: 'DOGE/USDT:USDT',
            action: 'HOLD',
            confidence: 70,
            horizonMinutes: 60,
            risk: 'MEDIUM',
            reasonCodes: ['CONFLICT'],
            reason: 'Signals conflict.',
          }] }),
        }),
      };
    },
  });
  assert.equal(result.decisions[0].action, 'HOLD');
  assert.equal(childOptions.env.GEMINI_API_KEY, undefined);
  assert.equal(childOptions.env.GOOGLE_API_KEY, undefined);
  assert.equal(childOptions.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});

test('forward scoring evaluates long and short directions without look-ahead', () => {
  const generatedAt = Date.UTC(2026, 0, 1);
  const state = emptyState();
  state.history.push({
    generatedAt: new Date(generatedAt).toISOString(),
    decisions: [
      { symbol: 'A', action: 'LONG', entryPrice: 100, outcomes: {} },
      { symbol: 'B', action: 'SHORT', entryPrice: 100, outcomes: {} },
    ],
  });
  scoreMaturedDecisions(state, [
    { symbol: 'A', close: 110 },
    { symbol: 'B', close: 90 },
  ], generatedAt + 60 * 60_000);
  assert.equal(state.history[0].decisions[0].outcomes[60].directionalReturnPct, 10);
  assert.equal(state.history[0].decisions[1].outcomes[60].directionalReturnPct, 10);
  assert.equal(state.history[0].decisions[0].outcomes[240], undefined);
  assert.equal(directionalReturn('HOLD', 100, 200), 0);
});

test('shadow service records provider failure as HOLD and never retries the same candle', async t => {
  const rows = klines();
  const now = rows.at(-1)[6] + 1;
  const statePath = `/tmp/ai-signal-shadow-test-${process.pid}-${Date.now()}.json`;
  t.after(() => fs.rmSync(statePath, { force: true }));
  const environment = {
    SYMBOLS: 'DOGE/USDT:USDT',
    AI_SIGNAL_SHADOW_STATE_FILE: statePath,
  };
  const exchange = {
    market: () => ({ id: 'DOGEUSDT' }),
    fapiPublicGetKlines: async () => rows,
  };
  let calls = 0;
  const service = new AiSignalShadowService({
    environment,
    exchange,
    now: () => now,
    provider: async () => {
      calls += 1;
      throw new Error('provider offline');
    },
  });
  const first = await service.runOnce();
  const second = await service.runOnce();
  assert.equal(first.source, 'ANTIGRAVITY_ERROR');
  assert.equal(first.decisions[0].action, 'HOLD');
  assert.equal(second.skipped, true);
  assert.equal(calls, 1);
});

test('shadow configuration defaults to a 15-minute independent worker', () => {
  const config = buildShadowConfig({ SYMBOLS: 'A,B' });
  assert.equal(config.intervalMs, 15 * 60_000);
  assert.equal(config.timeframe, '15m');
  assert.equal(config.model, 'gemini-3.8-flash-low');
  assert.equal(config.maximumRefreshMs, 4 * 60 * 60_000);
  assert.equal(config.featureConfirmationCandles, 3);
  assert.deepEqual(config.symbols, ['A', 'B']);
});

test('live signal mode refreshes at least hourly so one-hour decisions cannot remain stale', () => {
  const config = buildShadowConfig({ SYMBOLS: 'A', AI_SIGNAL_LIVE_ENABLED: 'true' });
  assert.equal(config.liveEnabled, true);
  assert.equal(config.maximumRefreshMs, 60 * 60_000);
});

test('feature gate checks every candle but confirms regime changes before calling AI', () => {
  const snapshots = [{
    symbol: 'DOGE/USDT:USDT',
    emaGapPct: 0.1,
    returnsPct: { h1: 0.2 },
    flowDelta: { h1: 0.1 },
    atrPct: 0.5,
  }];
  const featureKey = featureRegimeKey(snapshots);
  const state = {
    lastProviderCallAt: 1000,
    lastFeatureKey: featureKey,
    pendingFeatureKey: featureKey,
    pendingFeatureCount: 2,
  };
  assert.equal(shouldRequestProvider(state, snapshots, 2000, 4 * 60 * 60_000).allow, false);
  assert.equal(shouldRequestProvider(state, snapshots, 1000 + 4 * 60 * 60_000, 4 * 60 * 60_000).allow, true);
  const changed = [{
    ...snapshots[0],
    returnsPct: { h1: -0.2 },
    emaGapPct: -0.1,
    flowDelta: { h1: -0.1 },
  }];
  const firstChanged = shouldRequestProvider(state, changed, 2000, 4 * 60 * 60_000, 3);
  assert.equal(firstChanged.allow, false);
  const confirmedState = {
    ...state,
    pendingFeatureKey: firstChanged.pendingFeatureKey,
    pendingFeatureCount: firstChanged.pendingFeatureCount,
  };
  const secondChanged = shouldRequestProvider(
    confirmedState,
    changed,
    2000,
    4 * 60 * 60_000,
    3
  );
  assert.equal(secondChanged.allow, false);
  assert.equal(shouldRequestProvider({
    ...confirmedState,
    pendingFeatureKey: secondChanged.pendingFeatureKey,
    pendingFeatureCount: secondChanged.pendingFeatureCount,
  }, changed, 2000, 4 * 60 * 60_000, 3).allow, true);
});
