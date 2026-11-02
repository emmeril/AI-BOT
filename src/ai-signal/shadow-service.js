'use strict';

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { buildMarketSnapshot } = require('./market-snapshot');
const { requestAntigravity } = require('./antigravity-client');
const { shouldRequestProvider } = require('./signal-gate');
const { readBoolean, readNumber } = require('../scalper/environment');

const OUTCOME_HORIZONS_MINUTES = Object.freeze([60, 240, 1440]);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function buildShadowConfig(environment = process.env) {
  const symbols = String(environment.AI_SIGNAL_SYMBOLS || environment.SYMBOLS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const liveEnabled = readBoolean(environment, 'AI_SIGNAL_LIVE_ENABLED', false);
  return {
    enabled: readBoolean(environment, 'AI_SIGNAL_SHADOW_ENABLED', true),
    liveEnabled,
    symbols,
    timeframe: String(environment.AI_SIGNAL_TIMEFRAME || '15m'),
    intervalMs: Math.max(60_000, readNumber(environment, 'AI_SIGNAL_INTERVAL_MS', 15 * 60_000)),
    maximumRefreshMs: Math.max(
      15 * 60_000,
      readNumber(environment, 'AI_SIGNAL_MAX_REFRESH_MS', liveEnabled ? 60 * 60_000 : 4 * 60 * 60_000)
    ),
    featureConfirmationCandles: Math.max(
      1,
      Math.round(readNumber(environment, 'AI_SIGNAL_FEATURE_CONFIRMATION_CANDLES', 3))
    ),
    candleCloseBufferMs: Math.max(0, readNumber(environment, 'AI_SIGNAL_CANDLE_CLOSE_BUFFER_MS', 30_000)),
    minimumConfidence: Math.min(100, Math.max(0, readNumber(environment, 'AI_SIGNAL_MIN_CONFIDENCE', 65))),
    timeoutMs: Math.max(10_000, readNumber(environment, 'AI_SIGNAL_TIMEOUT_MS', 120_000)),
    model: String(environment.AI_SIGNAL_MODEL || 'gemini-3.8-flash-low'),
    binary: environment.AI_SIGNAL_ANTIGRAVITY_BIN || undefined,
    statePath: path.resolve(environment.AI_SIGNAL_SHADOW_STATE_FILE || 'ai-signal-shadow-state.json'),
    historyLimit: Math.max(100, readNumber(environment, 'AI_SIGNAL_HISTORY_LIMIT', 6000)),
  };
}

function emptyState(mode = 'SHADOW_ONLY') {
  return {
    version: 1,
    mode,
    updatedAt: null,
    lastCandleCloseTime: 0,
    lastProviderCallAt: 0,
    lastFeatureKey: null,
    pendingFeatureKey: null,
    pendingFeatureCount: 0,
    latestBySymbol: {},
    history: [],
  };
}

function loadShadowState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || !['SHADOW_ONLY', 'LIVE_ENTRY'].includes(parsed.mode) || !Array.isArray(parsed.history)) {
      return emptyState();
    }
    return { ...emptyState(parsed.mode), ...parsed, latestBySymbol: parsed.latestBySymbol || {} };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error(`Cannot load AI shadow state ${filePath}: ${error.message}`, { cause: error });
  }
}

function saveShadowState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function directionalReturn(action, entryPrice, exitPrice) {
  if (!(entryPrice > 0) || !(exitPrice > 0) || action === 'HOLD') return 0;
  const raw = (exitPrice / entryPrice - 1) * 100;
  return action === 'SHORT' ? -raw : raw;
}

function scoreMaturedDecisions(state, snapshots, now) {
  const bySymbol = new Map(snapshots.map(snapshot => [snapshot.symbol, snapshot]));
  for (const run of state.history) {
    const generatedAt = Date.parse(run.generatedAt);
    if (!Number.isFinite(generatedAt)) continue;
    for (const decision of run.decisions || []) {
      const snapshot = bySymbol.get(decision.symbol);
      if (!snapshot) continue;
      decision.outcomes ||= {};
      for (const horizonMinutes of OUTCOME_HORIZONS_MINUTES) {
        if (decision.outcomes[horizonMinutes] || now < generatedAt + horizonMinutes * 60_000) continue;
        decision.outcomes[horizonMinutes] = {
          evaluatedAt: new Date(now).toISOString(),
          exitPrice: snapshot.close,
          directionalReturnPct: Number(directionalReturn(
            decision.action,
            Number(decision.entryPrice),
            Number(snapshot.close)
          ).toFixed(6)),
        };
      }
    }
  }
}

function holdDecisions(snapshots, reason) {
  return snapshots.map(snapshot => ({
    symbol: snapshot.symbol,
    action: 'HOLD',
    requestedAction: 'HOLD',
    confidence: 0,
    horizonMinutes: 60,
    risk: 'HIGH',
    reasonCodes: ['INSUFFICIENT_DATA'],
    reason: String(reason || 'AI provider unavailable').slice(0, 160),
  }));
}

class AiSignalShadowService {
  constructor(options = {}) {
    this.environment = options.environment || process.env;
    this.config = buildShadowConfig(this.environment);
    this.exchange = options.exchange || new ccxt.binanceusdm({
      enableRateLimit: true,
      options: { defaultType: 'future', fetchCurrencies: false },
    });
    this.provider = options.provider || (snapshots => requestAntigravity(snapshots, {
      binary: this.config.binary,
      timeoutMs: this.config.timeoutMs,
      minimumConfidence: this.config.minimumConfidence,
      model: this.config.model,
      environment: this.environment,
      liveEnabled: this.config.liveEnabled,
    }));
    this.now = options.now || Date.now;
    this.sleep = options.sleep || sleep;
    this.state = options.state || loadShadowState(this.config.statePath);
    const requiredMode = this.config.liveEnabled ? 'LIVE_ENTRY' : 'SHADOW_ONLY';
    if (this.state.mode !== requiredMode) this.state = emptyState(requiredMode);
    this.running = false;
    this.stopping = false;
  }

  marketId(symbol) {
    return this.exchange.market(symbol).id;
  }

  async snapshot(symbol, now) {
    const rows = await this.exchange.fapiPublicGetKlines({
      symbol: this.marketId(symbol),
      interval: this.config.timeframe,
      limit: 110,
    });
    return buildMarketSnapshot(symbol, rows, { now, timeframe: this.config.timeframe });
  }

  async runOnce() {
    if (this.running) return { skipped: true, reason: 'cycle already running' };
    this.running = true;
    try {
      const now = this.now();
      const snapshots = await Promise.all(this.config.symbols.map(symbol => this.snapshot(symbol, now)));
      scoreMaturedDecisions(this.state, snapshots, now);
      const candleCloseTime = Math.min(...snapshots.map(snapshot => snapshot.candleCloseTime));
      if (candleCloseTime <= Number(this.state.lastCandleCloseTime || 0)) {
        saveShadowState(this.config.statePath, this.state);
        return { skipped: true, reason: 'closed candle already evaluated', candleCloseTime };
      }

      const gate = shouldRequestProvider(
        this.state,
        snapshots,
        now,
        this.config.maximumRefreshMs,
        this.config.featureConfirmationCandles
      );
      this.state.pendingFeatureKey = gate.pendingFeatureKey;
      this.state.pendingFeatureCount = gate.pendingFeatureCount;
      this.state.lastCandleCloseTime = candleCloseTime;
      if (!gate.allow) {
        saveShadowState(this.config.statePath, this.state);
        return { skipped: true, reason: gate.reason, candleCloseTime };
      }
      this.state.lastProviderCallAt = now;
      this.state.lastFeatureKey = gate.featureKey;

      let providerResult;
      let providerError = null;
      try {
        providerResult = await this.provider(snapshots);
      } catch (error) {
        providerError = String(error?.message || error).slice(0, 500);
        providerResult = { decisions: holdDecisions(snapshots, providerError), metadata: null };
      }

      const generatedAt = new Date(now).toISOString();
      const run = {
        id: `${candleCloseTime}-${now}`,
        mode: this.state.mode,
        generatedAt,
        candleCloseTime,
        timeframe: this.config.timeframe,
        source: providerError ? 'ANTIGRAVITY_ERROR' : 'ANTIGRAVITY_OAUTH',
        error: providerError,
        metadata: providerResult.metadata || null,
        decisions: providerResult.decisions.map(decision => {
          const snapshot = snapshots.find(item => item.symbol === decision.symbol);
          return {
            ...decision,
            entryPrice: snapshot.close,
            snapshot,
            outcomes: {},
          };
        }),
      };
      this.state.history.push(run);
      if (this.state.history.length > this.config.historyLimit) {
        this.state.history.splice(0, this.state.history.length - this.config.historyLimit);
      }
      for (const decision of run.decisions) {
        this.state.latestBySymbol[decision.symbol] = {
          ...decision,
          generatedAt,
          source: run.source,
          error: run.error,
        };
      }
      saveShadowState(this.config.statePath, this.state);
      return run;
    } finally {
      this.running = false;
    }
  }

  delayUntilNextCycle(now = this.now()) {
    const boundary = Math.floor(now / this.config.intervalMs) * this.config.intervalMs + this.config.intervalMs;
    return Math.max(1000, boundary + this.config.candleCloseBufferMs - now);
  }

  async start() {
    if (!this.config.enabled) {
      console.log('[AI SHADOW] Disabled');
      return;
    }
    if (!this.config.symbols.length) throw new Error('AI shadow worker requires SYMBOLS');
    await this.exchange.loadMarkets();
    console.log(
      `[AI SIGNAL] Started ${this.state.mode} ${this.config.timeframe} OAuth analysis for ` +
      this.config.symbols.join(', ')
    );
    while (!this.stopping) {
      try {
        const result = await this.runOnce();
        if (result.skipped) {
          console.log(`[AI SIGNAL] Skipped: ${result.reason}`);
        } else {
          const summary = result.decisions.map(item =>
            `${item.symbol}=${item.action}/${item.confidence}%`).join(' ');
          console.log(`[AI SIGNAL] ${summary}`);
        }
      } catch (error) {
        console.error(`[AI SIGNAL] Cycle failed safely: ${error.stack || error.message}`);
      }
      if (!this.stopping) await this.sleep(this.delayUntilNextCycle());
    }
  }

  stop() {
    this.stopping = true;
  }
}

module.exports = {
  AiSignalShadowService,
  OUTCOME_HORIZONS_MINUTES,
  buildShadowConfig,
  directionalReturn,
  emptyState,
  holdDecisions,
  loadShadowState,
  saveShadowState,
  scoreMaturedDecisions,
};
