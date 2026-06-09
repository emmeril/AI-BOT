require('dotenv').config();
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

// ------------------------------
//  Configuration Manager
// ------------------------------
class Config {
  static get(key, fallback) {
    const value = process.env[key];
    return value === undefined || value === '' ? fallback : value;
  }

  static number(key, fallback) {
    const parsed = Number(Config.get(key, fallback));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  static boolean(key, fallback = true) {
    const value = process.env[key];
    if (value === undefined || value === '') return fallback;
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    throw new Error(`${key} must be a boolean value`);
  }

  static isTrue(key) {
    return Config.boolean(key, false);
  }

  static list(key, fallback) {
    return String(Config.get(key, fallback))
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
}

// ------------------------------
//  Constants
// ------------------------------
const SYMBOLS = Config.list('SYMBOLS', 'BTC/USDT');
const EXCHANGE_MODE = Config.get('EXCHANGE_MODE', Config.boolean('EXCHANGE_DEMO', false) ? 'demo' : 'live').toLowerCase();
const VALID_EXCHANGE_MODES = new Set(['live', 'demo', 'testnet']);
const VALID_GRID_MODES = new Set(['ARITHMETIC', 'GEOMETRIC']);
const MINUTE_MS = 60 * 1000;
const INTERVAL_MINUTES = Config.number('INTERVAL_MINUTES', 1);
const INTERVAL_MS = INTERVAL_MINUTES * MINUTE_MS;

const GRID_COUNT = Config.number('GRID_COUNT', 10);
const GRID_MODE = Config.get('GRID_MODE', 'ARITHMETIC').toUpperCase();
const GRID_LOWER_PRICE = Config.number('GRID_LOWER_PRICE', 0);
const GRID_UPPER_PRICE = Config.number('GRID_UPPER_PRICE', 0);
const GRID_RANGE_PCT = Config.number('GRID_RANGE_PCT', 5);
const GRID_TRAILING_RANGE_ENABLED = Config.boolean('GRID_TRAILING_RANGE_ENABLED', false);
const GRID_TRAILING_UP_ENABLED = Config.boolean(
  'GRID_TRAILING_UP_ENABLED',
  Config.boolean('GRID_DYNAMIC_RANGE', GRID_TRAILING_RANGE_ENABLED)
);
const GRID_TRAILING_UP_COOLDOWN_MS = Math.max(Config.number('GRID_TRAILING_UP_COOLDOWN_MINUTES', 0), 0) * MINUTE_MS;
const GRID_TRAILING_DOWN_ENABLED = Config.boolean('GRID_TRAILING_DOWN_ENABLED', GRID_TRAILING_RANGE_ENABLED);
const GRID_TRAILING_DOWN_COOLDOWN_MS = Math.max(
  Config.number('GRID_TRAILING_DOWN_COOLDOWN_MINUTES', Config.number('GRID_TRAILING_UP_COOLDOWN_MINUTES', 0)),
  0
) * MINUTE_MS;
const GRID_ORDER_SIZE_USDT = Config.number('GRID_ORDER_SIZE_USDT', Config.number('ORDER_SIZE_USDT', 20));
const GRID_TOTAL_INVESTMENT_USDT = Config.number('GRID_TOTAL_INVESTMENT_USDT', 0);
const GRID_MAX_ACTIVE_BUY_ORDERS = Config.number('GRID_MAX_ACTIVE_BUY_ORDERS', 5);
const GRID_MAX_ACTIVE_SELL_ORDERS = Config.number('GRID_MAX_ACTIVE_SELL_ORDERS', 5);
const GRID_RECREATE_ON_START = Config.boolean('GRID_RECREATE_ON_START', false);
const GRID_CANCEL_OUT_OF_RANGE = Config.boolean('GRID_CANCEL_OUT_OF_RANGE', true);
const GRID_REFILL_ON_FILLED = Config.boolean('GRID_REFILL_ON_FILLED', true);
const GRID_MIN_PROFIT_PCT = Config.number('GRID_MIN_PROFIT_PCT', 0.4) / 100;
const GRID_STATE_FILE = Config.get('GRID_STATE_FILE', 'grid-state-spot.json');
const GRID_STATE_PATH = path.resolve(process.cwd(), GRID_STATE_FILE);
const BOT_LOCK_FILE = Config.get('BOT_LOCK_FILE', `${GRID_STATE_FILE}.lock`);
const BOT_LOCK_PATH = path.resolve(process.cwd(), BOT_LOCK_FILE);

const AI_VALIDATION_ENABLED = Config.boolean('AI_VALIDATION_ENABLED', false);
const AI_VALIDATION_TIMEFRAME = Config.get('AI_VALIDATION_TIMEFRAME', '15m');
const AI_VALIDATION_LOOKBACK = Config.number('AI_VALIDATION_LOOKBACK', 80);
const AI_VALIDATION_CACHE_TTL_MS = Config.number('AI_VALIDATION_CACHE_TTL_MS', Math.max(INTERVAL_MS * 3, MINUTE_MS));
const AI_VALIDATION_MIN_INTERVAL_MS = Config.number('AI_VALIDATION_MIN_INTERVAL_MS', MINUTE_MS);
const AI_VALIDATION_BACKOFF_MS = Config.number('AI_VALIDATION_BACKOFF_MS', 10 * MINUTE_MS);
const AI_VALIDATION_PRICE_BUCKET_PCT = Config.number('AI_VALIDATION_PRICE_BUCKET_PCT', 0.25);
const AI_VALIDATION_RETRIES = Config.number('AI_VALIDATION_RETRIES', 2);
const AI_MIN_CONFIDENCE = Config.number('AI_MIN_CONFIDENCE', 70); // Conservative: reject low-confidence decisions
const AI_STRONG_CONFIDENCE = Config.number('AI_STRONG_CONFIDENCE', 85); // High-confidence threshold for aggressive trading
const GEMINI_MODEL = Config.get('GEMINI_MODEL', 'gemini-2.0-flash-lite');

const STOP_LOSS_PRICE = Config.number('GRID_STOP_LOSS_PRICE', 0);
const TAKE_PROFIT_PRICE = Config.number('GRID_TAKE_PROFIT_PRICE', 0);
const KILL_SWITCH_ENABLED = Config.boolean('KILL_SWITCH_ENABLED', false);
const STOP_TRADING = Config.isTrue('STOP_TRADING');
const KILL_SWITCH_FILE = Config.get('KILL_SWITCH_FILE', 'bot-paused.flag');
const KILL_SWITCH_PATH = path.resolve(process.cwd(), KILL_SWITCH_FILE);

const FONNTE_ENABLED = Config.boolean('FONNTE_ENABLED', false);
const FONNTE_TOKEN = Config.get('FONNTE_TOKEN', '');
const FONNTE_TARGET = Config.get('FONNTE_TARGET', '');
const FONNTE_API_URL = Config.get('FONNTE_API_URL', 'https://api.fonnte.com/send');
const FONNTE_COUNTRY_CODE = Config.get('FONNTE_COUNTRY_CODE', '62');
const FONNTE_TIMEOUT_MS = Config.number('FONNTE_TIMEOUT_MS', 10_000);

const MAX_PROCESSED_TRADE_IDS = 2000;
const TRADE_FETCH_LIMIT = 100;
const CIRCUIT_BREAKER_MAX_ERRORS = 5;
const CIRCUIT_BREAKER_PAUSE_MS = 15 * MINUTE_MS;

// ------------------------------
//  Utility Functions
// ------------------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function retry(fn, retries = 3, delay = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(delay * attempt);
    }
  }
}

function killSwitchActive() {
  if (STOP_TRADING) return true;
  if (!KILL_SWITCH_ENABLED) return false;
  try {
    return fs.existsSync(KILL_SWITCH_PATH);
  } catch {
    return false;
  }
}

function roundNumber(value, digits = 8) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberOrZero(value) {
  return Number(value) || 0;
}

function hasManualGridRange() {
  return GRID_LOWER_PRICE > 0 && GRID_UPPER_PRICE > 0;
}

function scopedTradeId(symbol, id) {
  return `${symbol}|${id}`;
}

function validateRuntimeConfiguration() {
  const errors = [];
  const requirePositive = (name, value) => {
    if (!(value > 0)) errors.push(`${name} must be greater than 0`);
  };
  const requireNonNegative = (name, value) => {
    if (!(value >= 0)) errors.push(`${name} must be 0 or greater`);
  };
  const requireInteger = (name, value, minimum = 0) => {
    if (!Number.isInteger(value) || value < minimum) {
      errors.push(`${name} must be an integer of at least ${minimum}`);
    }
  };

  if (!SYMBOLS.length) errors.push('SYMBOLS must contain at least one symbol');
  if (!VALID_EXCHANGE_MODES.has(EXCHANGE_MODE)) {
    errors.push(`EXCHANGE_MODE must be one of: ${[...VALID_EXCHANGE_MODES].join(', ')}`);
  }
  if (!VALID_GRID_MODES.has(GRID_MODE)) {
    errors.push('GRID_MODE must be ARITHMETIC or GEOMETRIC');
  }

  requirePositive('INTERVAL_MINUTES', INTERVAL_MINUTES);
  requireInteger('GRID_COUNT', GRID_COUNT, 2);
  requireNonNegative('GRID_TOTAL_INVESTMENT_USDT', GRID_TOTAL_INVESTMENT_USDT);
  requirePositive(
    GRID_TOTAL_INVESTMENT_USDT > 0 ? 'GRID_TOTAL_INVESTMENT_USDT' : 'GRID_ORDER_SIZE_USDT',
    GRID_TOTAL_INVESTMENT_USDT > 0 ? GRID_TOTAL_INVESTMENT_USDT : GRID_ORDER_SIZE_USDT
  );
  requireInteger('GRID_MAX_ACTIVE_BUY_ORDERS', GRID_MAX_ACTIVE_BUY_ORDERS);
  requireInteger('GRID_MAX_ACTIVE_SELL_ORDERS', GRID_MAX_ACTIVE_SELL_ORDERS);
  requireNonNegative('GRID_MIN_PROFIT_PCT', GRID_MIN_PROFIT_PCT);
  requireInteger('AI_VALIDATION_RETRIES', AI_VALIDATION_RETRIES);
  requirePositive('FONNTE_TIMEOUT_MS', FONNTE_TIMEOUT_MS);

  const hasLower = GRID_LOWER_PRICE > 0;
  const hasUpper = GRID_UPPER_PRICE > 0;
  if (!hasLower && !hasUpper) requirePositive('GRID_RANGE_PCT', GRID_RANGE_PCT);
  if (hasLower !== hasUpper) {
    errors.push('GRID_LOWER_PRICE and GRID_UPPER_PRICE must both be set or both be 0');
  } else if (hasLower && GRID_LOWER_PRICE >= GRID_UPPER_PRICE) {
    errors.push('GRID_LOWER_PRICE must be lower than GRID_UPPER_PRICE');
  }

  if (!process.env.EXCHANGE_API_KEY || !process.env.EXCHANGE_SECRET) {
    errors.push('EXCHANGE_API_KEY and EXCHANGE_SECRET are required');
  }
  if (AI_VALIDATION_ENABLED && !process.env.GEMINI_API_KEY) {
    errors.push('GEMINI_API_KEY is required when AI_VALIDATION_ENABLED=true');
  }
  if (FONNTE_ENABLED && (!FONNTE_TOKEN || !FONNTE_TARGET)) {
    errors.push('FONNTE_TOKEN and FONNTE_TARGET are required when FONNTE_ENABLED=true');
  }

  if (errors.length) {
    throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }
}

// ------------------------------
//  Single Process Lock
// ------------------------------
class ProcessLock {
  constructor(lockPath) {
    this.lockPath = lockPath;
    this.fd = null;
    this.ownerToken = null;
  }

  processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  readOwner() {
    const raw = fs.readFileSync(this.lockPath, 'utf8').trim();
    try {
      const parsed = JSON.parse(raw);
      return {
        pid: Number(parsed.pid),
        token: typeof parsed.token === 'string' ? parsed.token : null,
      };
    } catch {
      return { pid: Number(raw), token: null };
    }
  }

  ownsLock() {
    if (!this.ownerToken) return false;
    try {
      const owner = this.readOwner();
      return owner.pid === process.pid && owner.token === this.ownerToken;
    } catch {
      return false;
    }
  }

  acquire() {
    try {
      this.fd = fs.openSync(this.lockPath, 'wx');
      this.ownerToken = crypto.randomUUID();
      fs.writeFileSync(this.fd, JSON.stringify({
        pid: process.pid,
        token: this.ownerToken,
        acquiredAt: new Date().toISOString(),
      }));
      fs.fsyncSync(this.fd);
      if (!this.ownsLock()) {
        fs.closeSync(this.fd);
        this.fd = null;
        this.ownerToken = null;
        throw new Error(`Lost bot lock during acquisition: ${this.lockPath}`);
      }
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = this.readOwner();
      if (this.processIsAlive(owner.pid)) {
        throw new Error(`Bot already running with PID ${owner.pid}. Lock: ${this.lockPath}`);
      }
      // Never auto-delete stale locks: checking an owner and unlinking its
      // file cannot be made atomic with plain filesystem APIs.
      throw new Error(
        `Stale bot lock found for PID ${owner.pid || 'unknown'}. ` +
        `Verify no bot is running, then remove: ${this.lockPath}`
      );
    }
  }

  release() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
      if (this.ownsLock()) {
        fs.unlinkSync(this.lockPath);
      } else {
        console.warn('[LOCK] Not releasing a lock with a different ownership token');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[LOCK] Failed to release:', err.message);
    } finally {
      this.fd = null;
      this.ownerToken = null;
    }
  }
}

// ------------------------------
//  Exchange Singleton
// ------------------------------
class ExchangeManager {
  static instance = null;

  static getInstance() {
    if (!this.instance) {
      if (!VALID_EXCHANGE_MODES.has(EXCHANGE_MODE)) {
        throw new Error(`EXCHANGE_MODE invalid: ${EXCHANGE_MODE}. Use live, demo, or testnet.`);
      }
      this.instance = new ccxt.binance({
        apiKey: process.env.EXCHANGE_API_KEY,
        secret: process.env.EXCHANGE_SECRET,
        enableRateLimit: true,
        options: {
          defaultType: 'spot',
          fetchMarkets: { types: ['spot'] },
          fetchMargins: false,
          adjustForTimeDifference: true,
          recvWindow: 10000,
          fetchCurrencies: false,
        },
      });
      if (EXCHANGE_MODE === 'testnet') {
        this.instance.setSandboxMode(true);
      } else if (EXCHANGE_MODE === 'demo') {
        this.instance.options.enableDemoTrading = true;
        this.instance.urls.api.public = this.instance.urls.demo.public;
        this.instance.urls.api.private = this.instance.urls.demo.private;
        this.instance.urls.api.v1 = this.instance.urls.demo.v1;
      }
    }
    return this.instance;
  }
}

// ------------------------------
//  Persistent Grid State
// ------------------------------
class GridState {
  constructor() {
    this.data = this.load();
  }

  static createEmpty() {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      symbols: {},
      processedTradeIds: [],
      totals: { filledBuys: 0, filledSells: 0, realizedGridProfit: 0 },
    };
  }

  static normalize(data) {
    const normalized = isPlainObject(data) ? data : {};
    normalized.version = numberOrZero(normalized.version) || 1;
    normalized.updatedAt = normalized.updatedAt || new Date().toISOString();
    normalized.symbols = isPlainObject(normalized.symbols) ? normalized.symbols : {};
    normalized.processedTradeIds = Array.isArray(normalized.processedTradeIds)
      ? normalized.processedTradeIds.map(String).slice(-MAX_PROCESSED_TRADE_IDS)
      : [];
    normalized.totals = isPlainObject(normalized.totals) ? normalized.totals : {};
    normalized.totals.filledBuys = numberOrZero(normalized.totals.filledBuys);
    normalized.totals.filledSells = numberOrZero(normalized.totals.filledSells);
    normalized.totals.realizedGridProfit = numberOrZero(normalized.totals.realizedGridProfit);
    return normalized;
  }

  load() {
    try {
      if (fs.existsSync(GRID_STATE_PATH)) {
        return GridState.normalize(JSON.parse(fs.readFileSync(GRID_STATE_PATH, 'utf8')));
      }
    } catch (err) {
      console.warn('[STATE] Failed to read grid state, starting fresh:', err.message);
    }
    return GridState.createEmpty();
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    const tempPath = `${GRID_STATE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2));
    fs.renameSync(tempPath, GRID_STATE_PATH);
  }

  getSymbol(symbol) {
    const existing = this.data.symbols[symbol];
    if (!isPlainObject(existing)) {
      this.data.symbols[symbol] = {
        createdAt: new Date().toISOString(),
        config: {},
        orders: {},
        lastBuyByLevel: {},
        realizedGridProfit: 0,
      };
    }
    const sym = this.data.symbols[symbol];
    sym.config = isPlainObject(sym.config) ? sym.config : {};
    sym.orders = isPlainObject(sym.orders) ? sym.orders : {};
    sym.lastBuyByLevel = isPlainObject(sym.lastBuyByLevel) ? sym.lastBuyByLevel : {};
    sym.realizedGridProfit = numberOrZero(sym.realizedGridProfit);
    return sym;
  }

  rememberOrder(symbol, order, meta) {
    const sym = this.getSymbol(symbol);
    sym.orders[String(order.id)] = {
      id: String(order.id),
      side: order.side,
      levelIndex: meta.levelIndex,
      price: Number(order.price),
      amount: Number(order.amount),
      createdAt: new Date().toISOString(),
    };
    this.save();
  }

  forgetOrder(symbol, orderId) {
    const sym = this.getSymbol(symbol);
    delete sym.orders[String(orderId)];
    this.save();
  }

  processedTrade(symbol, id) {
    const scopedId = scopedTradeId(symbol, id);
    const legacyId = String(id);
    return this.data.processedTradeIds.includes(scopedId) ||
      this.data.processedTradeIds.includes(legacyId);
  }

  markProcessedTrade(symbol, id) {
    const scopedId = scopedTradeId(symbol, id);
    if (this.processedTrade(symbol, id)) return false;
    this.data.processedTradeIds.push(scopedId);
    this.data.processedTradeIds = this.data.processedTradeIds.slice(-MAX_PROCESSED_TRADE_IDS);
    this.save();
    return true;
  }
}

// ------------------------------
//  Gemini Grid Validation
// ------------------------------
class AIGridValidator {
  static cache = new Map();
  static lastDecisionBySymbol = new Map();
  static rateLimitedUntil = 0;

  constructor(exchange) {
    this.exchange = exchange;
    this.model = null;
    if (AI_VALIDATION_ENABLED) {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('AI_VALIDATION_ENABLED=true membutuhkan GEMINI_API_KEY.');
      }
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      this.model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    }
  }

  static allow(reason = 'AI validation disabled') {
    return { allowTrading: true, allowBuy: true, allowSell: true, confidence: 100, reason };
  }

  static block(reason, confidence = 0) {
    return { allowTrading: false, allowBuy: false, allowSell: false, confidence, reason };
  }

  blockAndRemember(symbol, cacheKey, reason, confidence = 0) {
    const decision = AIGridValidator.block(reason, confidence);
    this.setCached(cacheKey, decision);
    this.rememberDecision(symbol, decision);
    return decision;
  }

  applyConfidenceRules(decision) {
    /**
     * Apply strict confidence-based rules to override unsafe decisions
     * - Confidence < 50: Auto-block everything (extreme uncertainty)
     * - Confidence 50-69: Allow only if model was VERY explicit
     * - Confidence 70-84: Allow normally
     * - Confidence 85+: Allow aggressively
     */
    const conf = decision.confidence;
    
    if (conf < 50) {
      // Extreme uncertainty - block all trading
      decision.allowTrading = false;
      decision.allowBuy = false;
      decision.allowSell = false;
      decision.reason = `Auto-blocked: confidence too low (${conf}%) - extreme uncertainty`;
    } else if (conf < 70) {
      // Weak confidence - only allow if explicitly enabled
      if (!decision.allowTrading) decision.allowBuy = decision.allowSell = false;
    }
    // 70-100: Trust the decision as-is
    
    return decision;
  }

  cacheKey(symbol, currentPrice, levels) {
    const bucket = Math.floor(Date.now() / AI_VALIDATION_CACHE_TTL_MS);
    const rangeKey = `${roundNumber(levels[0])}-${roundNumber(levels[levels.length - 1])}`;
    const priceBucket = this.priceBucket(currentPrice, levels);
    return `${symbol}|${AI_VALIDATION_TIMEFRAME}|${bucket}|${priceBucket}|${rangeKey}`;
  }

  priceBucket(currentPrice, levels) {
    const lower = Number(levels[0]);
    const upper = Number(levels[levels.length - 1]);
    const gridStepPct = lower > 0 && levels.length > 1
      ? Math.abs((Number(levels[1]) - lower) / lower) * 100
      : AI_VALIDATION_PRICE_BUCKET_PCT;
    const bucketPct = Math.max(AI_VALIDATION_PRICE_BUCKET_PCT, gridStepPct / 2, 0.01);
    const bucketSize = currentPrice * (bucketPct / 100);
    const bucketedPrice = bucketSize > 0 ? Math.round(currentPrice / bucketSize) * bucketSize : currentPrice;
    const position = upper > lower ? Math.round(((currentPrice - lower) / (upper - lower)) * GRID_COUNT) : 0;
    return `${roundNumber(bucketedPrice)}|pos=${position}`;
  }

  getCached(key) {
    const entry = AIGridValidator.cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    if (entry) AIGridValidator.cache.delete(key);
    return null;
  }

  setCached(key, value) {
    AIGridValidator.cache.set(key, { value, expiresAt: Date.now() + AI_VALIDATION_CACHE_TTL_MS });
  }

  getLastDecision(symbol, allowStale = false) {
    const entry = AIGridValidator.lastDecisionBySymbol.get(symbol);
    if (!entry) return null;
    const age = Date.now() - entry.at;
    if (allowStale || age < AI_VALIDATION_CACHE_TTL_MS) return entry;
    return null;
  }

  rememberDecision(symbol, decision) {
    AIGridValidator.lastDecisionBySymbol.set(symbol, { value: decision, at: Date.now() });
  }

  isRateLimitError(err) {
    const message = String(err?.message || err || '').toLowerCase();
    return err?.status === 429 ||
      err?.code === 429 ||
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('quota') ||
      message.includes('resource_exhausted');
  }

  summarizeCandles(ohlcv) {
    if (!ohlcv.length) return {};
    const closes = ohlcv.map(c => Number(c[4]));
    const highs = ohlcv.map(c => Number(c[2]));
    const lows = ohlcv.map(c => Number(c[3]));
    const volumes = ohlcv.map(c => Number(c[5]));
    const first = closes[0];
    const last = closes[closes.length - 1];
    const high = Math.max(...highs);
    const low = Math.min(...lows);
    const avgVolume = volumes.reduce((sum, value) => sum + value, 0) / volumes.length;
    const recentVolume = volumes.slice(-10).reduce((sum, value) => sum + value, 0) / Math.min(10, volumes.length);
    return {
      firstClose: roundNumber(first),
      lastClose: roundNumber(last),
      changePct: roundNumber(((last - first) / first) * 100, 4),
      high: roundNumber(high),
      low: roundNumber(low),
      rangePct: roundNumber(((high - low) / last) * 100, 4),
      avgVolume: roundNumber(avgVolume, 4),
      recentVolume: roundNumber(recentVolume, 4),
    };
  }

  buildPrompt(symbol, context, candleSummary) {
    const {
      currentPrice,
      lower,
      upper,
      levels,
      trailingUpJustShifted = false,
      trailingDownJustShifted = false,
    } = context;
    const distLowerPct = ((currentPrice - lower) / currentPrice) * 100;
    const distUpperPct = ((upper - currentPrice) / currentPrice) * 100;
    
    // Analyze market regime from candle summary
    const { changePct = 0, rangePct = 0, recentVolume = 0, avgVolume = 0 } = candleSummary;
    const volumeRatio = avgVolume > 0 ? recentVolume / avgVolume : 1;
    const isExtreme = rangePct > 8;
    const isLowVolume = volumeRatio < 0.5;
    const isStrongTrend = Math.abs(changePct) > 5;
    const trend = changePct > 0 ? 'UPTREND' : changePct < 0 ? 'DOWNTREND' : 'RANGING';
    
    return `
You validate whether a Binance spot grid bot may place new orders in a ${trend} market.

Return ONLY valid JSON (no markdown, no explanation):
{
  "allowTrading": true/false,
  "allowBuy": true/false,
  "allowSell": true/false,
  "confidence": 0-100,
  "reason": "specific reason (max 100 chars)"
}

DECISION FRAMEWORK:
1. VOLATILITY FILTER (rangePct = ${rangePct.toFixed(2)}%):
   - Block if rangePct > 8% (extreme volatility = unsafe grid)
   - Use caution if rangePct > 5% (elevated volatility)
   
2. VOLUME FILTER (volume ratio = ${volumeRatio.toFixed(2)}x):
   - Block if recent volume < 50% of average (liquidity warning)
   - Green flag if volume increasing

3. TREND ANALYSIS (change = ${changePct.toFixed(2)}%):
   - STRONG TREND: |changePct| > 5% = directional pressure
     * In UPTREND: allowSell = false (protect upside)
     * In DOWNTREND: allowBuy = false (protect capital)
   - RANGING: |changePct| < 2% = grid optimal

4. PRICE POSITION:
   - Distance to Lower: ${distLowerPct.toFixed(1)}%
   - Distance to Upper: ${distUpperPct.toFixed(1)}%
   - If price near bound (< 5% away): evaluate trend before allowing that direction

5. TRAILING SHIFTS:
   - Trailing Up Just Shifted: ${trailingUpJustShifted} (breakout happened, still validate)
   - Trailing Down Just Shifted: ${trailingDownJustShifted} (breakdown happened, still validate)
   - DO NOT auto-block; assess new market regime after shift

SCORING CONFIDENCE:
- 85-100: Clear ranging, good volume, balanced position → STRONG
- 70-84: Slight trend but manageable, acceptable volume → MEDIUM
- 50-69: Mixed signals, some concern but acceptable → WEAK
- < 50: Extreme conditions, unclear signals → BLOCK

CONTEXT:
Symbol: ${symbol}
Current Price: ${currentPrice}
Grid Range: ${roundNumber(lower)} → ${roundNumber(upper)}
Grid Levels: ${levels.length} levels | Mode: ${GRID_MODE}
Timeframe: ${AI_VALIDATION_TIMEFRAME}
Trend: ${trend} | Volatility: ${isExtreme ? 'EXTREME' : rangePct > 5 ? 'HIGH' : 'NORMAL'}
Volume: ${isLowVolume ? 'LOW (⚠)' : 'NORMAL'}

Be conservative. Grid strategies suffer in trending/volatile markets. Protect capital first.
`;
  }

  parseResponse(text) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object in Gemini response');
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const confidence = Number(parsed.confidence);
    
    // Validate response structure
    const allowTrading = parsed.allowTrading === true;
    const allowBuy = parsed.allowBuy === true;
    const allowSell = parsed.allowSell === true;
    const confVal = Number.isFinite(confidence) ? confidence : 0;
    
    // Enforce strict rules based on confidence
    let finalAllow = allowTrading;
    let finalBuy = allowBuy;
    let finalSell = allowSell;
    
    // CONFIDENCE < 50: Block everything (extreme uncertainty)
    if (confVal < 50) {
      finalAllow = false;
      finalBuy = false;
      finalSell = false;
    }
    // CONFIDENCE 50-69: Allow partial (only if model explicitly says yes)
    else if (confVal < 70) {
      // Keep as-is, trust model but with caution
    }
    
    return {
      allowTrading: finalAllow,
      allowBuy: finalBuy,
      allowSell: finalSell,
      confidence: confVal,
      reason: String(parsed.reason || 'no reason').slice(0, 200),
      rawResponse: { allowTrading, allowBuy, allowSell }, // Store original for logging
    };
  }

  async validate(symbol, context, options = {}) {
    if (!AI_VALIDATION_ENABLED) return AIGridValidator.allow();

    const { ignoreMinInterval = false } = options;
    const cacheKey = this.cacheKey(symbol, context.currentPrice, context.levels);
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const lastDecision = this.getLastDecision(symbol);
    if (!ignoreMinInterval && lastDecision && Date.now() - lastDecision.at < AI_VALIDATION_MIN_INTERVAL_MS) {
      return lastDecision.value;
    }

    if (AIGridValidator.rateLimitedUntil > Date.now()) {
      const stale = this.getLastDecision(symbol, true);
      if (stale) return stale.value;
      return AIGridValidator.block('AI validation skipped: Gemini rate-limit backoff active');
    }

    try {
      const ohlcv = await retry(
        () => this.exchange.fetchOHLCV(symbol, AI_VALIDATION_TIMEFRAME, undefined, AI_VALIDATION_LOOKBACK),
        Math.max(AI_VALIDATION_RETRIES, 1)
      );
      const prompt = this.buildPrompt(symbol, context, this.summarizeCandles(ohlcv));
      for (let attempt = 1; attempt <= AI_VALIDATION_RETRIES + 1; attempt++) {
        try {
          const result = await this.model.generateContent(prompt);
          const decision = this.parseResponse(result.response.text());
          
          // Apply strict confidence-based rules
          this.applyConfidenceRules(decision);
          
          if (decision.confidence < AI_MIN_CONFIDENCE) {
            return this.blockAndRemember(
              symbol,
              cacheKey,
              `Low AI confidence: ${decision.reason}`,
              decision.confidence
            );
          }
          this.setCached(cacheKey, decision);
          this.rememberDecision(symbol, decision);
          return decision;
        } catch (err) {
          if (this.isRateLimitError(err)) {
            AIGridValidator.rateLimitedUntil = Date.now() + AI_VALIDATION_BACKOFF_MS;
            const stale = this.getLastDecision(symbol, true);
            if (stale) return stale.value;
            throw err;
          }
          if (attempt > AI_VALIDATION_RETRIES) throw err;
          await sleep(1000 * attempt);
        }
      }
    } catch (err) {
      const reason = this.isRateLimitError(err)
        ? `AI validation rate-limited; paused Gemini calls for ${Math.round(AI_VALIDATION_BACKOFF_MS / MINUTE_MS)}m`
        : `AI validation failed: ${err.message}`;
      if (this.isRateLimitError(err)) {
        AIGridValidator.rateLimitedUntil = Date.now() + AI_VALIDATION_BACKOFF_MS;
      }
      return this.blockAndRemember(symbol, cacheKey, reason);
    }

    return AIGridValidator.block('AI validation unavailable');
  }
}

// ------------------------------
//  Binance-Style Spot Grid Engine
// ------------------------------
class SpotGridEngine {
  constructor() {
    this.exchange = ExchangeManager.getInstance();
    this.aiValidator = new AIGridValidator(this.exchange);
    this.state = new GridState();
    this.isRunning = false;
    this.symbolLocks = new Map();
    this.pendingOrderLevels = new Set();
    this.circuitBreaker = { errors: 0, pausedUntil: 0 };
  }

  async init() {
    await retry(() => this.exchange.loadMarkets());
    for (const symbol of SYMBOLS) {
      try {
        this.ensureMarket(symbol);
        if (GRID_RECREATE_ON_START) await this.cancelGridOrders(symbol, 'recreate-on-start');
        await this.reconcileSymbol(symbol);
      } catch (err) {
        console.error(`[INIT] ${symbol}`, err);
        this.recordError();
      }
    }
  }

  ensureMarket(symbol) {
    if (!this.exchange.markets[symbol]) {
      throw new Error(`Symbol ${symbol} tidak ditemukan di Binance spot market.`);
    }
  }

  circuitAllows() {
    return this.circuitBreaker.pausedUntil <= Date.now();
  }

  recordError() {
    this.circuitBreaker.errors++;
    if (this.circuitBreaker.errors >= CIRCUIT_BREAKER_MAX_ERRORS) {
      this.circuitBreaker.pausedUntil = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
      this.circuitBreaker.errors = 0;
      console.warn(`[CIRCUIT] Too many errors. Paused ${CIRCUIT_BREAKER_PAUSE_MS / MINUTE_MS}m.`);
    }
  }

  recordSuccess() {
    this.circuitBreaker.errors = 0;
  }

  getOrderSizeUsdt() {
    if (GRID_TOTAL_INVESTMENT_USDT > 0) {
      return GRID_TOTAL_INVESTMENT_USDT / Math.max(GRID_COUNT, 1);
    }
    return GRID_ORDER_SIZE_USDT;
  }

  buildRange(symbol, currentPrice) {
    const symState = this.state.getSymbol(symbol);
    const manualRange = hasManualGridRange();
    const lower = manualRange
      ? GRID_LOWER_PRICE
      : Number(symState.config.lower || currentPrice * (1 - GRID_RANGE_PCT / 100));
    const upper = manualRange
      ? GRID_UPPER_PRICE
      : Number(symState.config.upper || currentPrice * (1 + GRID_RANGE_PCT / 100));
    if (lower <= 0 || upper <= 0 || lower >= upper) {
      throw new Error(`Range grid invalid. lower=${lower}, upper=${upper}`);
    }
    symState.config = {
      mode: GRID_MODE,
      count: GRID_COUNT,
      lower,
      upper,
      autoRange: !manualRange,
      orderSizeUsdt: this.getOrderSizeUsdt(),
    };
    this.state.save();
    return { lower, upper };
  }

  getTrailingUpState(symbol) {
    const symState = this.state.getSymbol(symbol);
    if (!symState.trailingUp) {
      symState.trailingUp = {
        shifts: 0,
        lastShiftAt: null,
      };
    }
    return symState.trailingUp;
  }

  getTrailingDownState(symbol) {
    const symState = this.state.getSymbol(symbol);
    if (!symState.trailingDown) {
      symState.trailingDown = {
        shifts: 0,
        lastShiftAt: null,
      };
    }
    return symState.trailingDown;
  }

  getTrailingUpTrigger(lower, upper) {
    if (GRID_MODE === 'GEOMETRIC') {
      const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
      return upper * ratio;
    }
    return upper + ((upper - lower) / GRID_COUNT);
  }

  getTrailingDownTrigger(lower, upper) {
    if (GRID_MODE === 'GEOMETRIC') {
      const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
      return lower / ratio;
    }
    return lower - ((upper - lower) / GRID_COUNT);
  }

  shiftStoredLevelIndexes(symbol, offset) {
    const symState = this.state.getSymbol(symbol);
    for (const order of Object.values(symState.orders)) {
      order.levelIndex = Number(order.levelIndex) + offset;
    }

    const shiftedBuys = {};
    for (const [levelIndex, buy] of Object.entries(symState.lastBuyByLevel)) {
      shiftedBuys[Number(levelIndex) + offset] = buy;
    }
    symState.lastBuyByLevel = shiftedBuys;
  }

  calculateTrailingShift(currentPrice, lower, upper, direction) {
    if (GRID_MODE === 'GEOMETRIC') {
      const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
      if (!(ratio > 1)) return null;
      if (direction === 'up') {
        if (currentPrice < upper * ratio) return null;
        const steps = Math.max(1, Math.floor(Math.log(currentPrice / upper) / Math.log(ratio)));
        return {
          steps,
          lower: lower * Math.pow(ratio, steps),
          upper: upper * Math.pow(ratio, steps),
        };
      }
      if (currentPrice > lower / ratio) return null;
      const steps = Math.max(1, Math.floor(Math.log(lower / currentPrice) / Math.log(ratio)));
      return {
        steps,
        lower: lower / Math.pow(ratio, steps),
        upper: upper / Math.pow(ratio, steps),
      };
    }

    const stepSize = (upper - lower) / GRID_COUNT;
    if (!(stepSize > 0)) return null;
    if (direction === 'up') {
      if (currentPrice < upper + stepSize) return null;
      const steps = Math.max(1, Math.floor((currentPrice - upper) / stepSize));
      return {
        steps,
        lower: lower + (stepSize * steps),
        upper: upper + (stepSize * steps),
      };
    }
    if (currentPrice > lower - stepSize) return null;
    const steps = Math.max(1, Math.floor((lower - currentPrice) / stepSize));
    return {
      steps,
      lower: lower - (stepSize * steps),
      upper: upper - (stepSize * steps),
    };
  }

  async applyTrailingRangeShift(symbol, lower, upper, shift, direction) {
    const symState = this.state.getSymbol(symbol);
    const trailingState = direction === 'up'
      ? this.getTrailingUpState(symbol)
      : this.getTrailingDownState(symbol);
    symState.config.lower = shift.lower;
    symState.config.upper = shift.upper;
    this.shiftStoredLevelIndexes(symbol, direction === 'up' ? -shift.steps : shift.steps);
    trailingState.shifts += shift.steps;
    trailingState.lastShiftAt = new Date().toISOString();
    this.state.save();

    const label = direction === 'up' ? 'UP' : 'DOWN';
    console.log(
      `[TRAILING ${label}] ${symbol} shifted ${shift.steps} grid(s): ` +
      `${roundNumber(lower)}-${roundNumber(upper)} -> ${roundNumber(shift.lower)}-${roundNumber(shift.upper)}`
    );
    await this.sendAlert(
      `[GRID TRAILING ${label}] ${symbol} shifted ${shift.steps} grid(s) to ` +
      `${roundNumber(shift.lower)}-${roundNumber(shift.upper)}`
    );
    return { lower: shift.lower, upper: shift.upper };
  }

  async maybeTrailUpRange(symbol, currentPrice, lower, upper) {
    if (!GRID_TRAILING_UP_ENABLED || hasManualGridRange()) return null;

    const trailingState = this.getTrailingUpState(symbol);
    const lastShiftAt = Date.parse(trailingState.lastShiftAt || 0);
    if (GRID_TRAILING_UP_COOLDOWN_MS > Date.now() - lastShiftAt) return null;

    const shift = this.calculateTrailingShift(currentPrice, lower, upper, 'up');
    if (!shift) return null;
    return this.applyTrailingRangeShift(symbol, lower, upper, shift, 'up');
  }

  async maybeTrailDownRange(symbol, currentPrice, lower, upper) {
    if (!GRID_TRAILING_DOWN_ENABLED || hasManualGridRange()) return null;

    const trailingState = this.getTrailingDownState(symbol);
    const lastShiftAt = Date.parse(trailingState.lastShiftAt || 0);
    if (GRID_TRAILING_DOWN_COOLDOWN_MS > Date.now() - lastShiftAt) return null;

    const shift = this.calculateTrailingShift(currentPrice, lower, upper, 'down');
    if (!shift) return null;
    return this.applyTrailingRangeShift(symbol, lower, upper, shift, 'down');
  }

  buildLevels(lower, upper) {
    if (GRID_COUNT < 2) throw new Error('GRID_COUNT minimal 2.');
    if (GRID_MODE === 'GEOMETRIC') {
      const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
      const levels = Array.from({ length: GRID_COUNT + 1 }, (_, i) => lower * Math.pow(ratio, i));
      // Clamp boundaries to exact values to prevent floating-point accumulation errors
      levels[0] = lower;
      levels[GRID_COUNT] = upper;
      return levels;
    }
    const step = (upper - lower) / GRID_COUNT;
    const levels = Array.from({ length: GRID_COUNT + 1 }, (_, i) => lower + step * i);
    // Clamp boundaries to exact values to prevent floating-point accumulation errors
    levels[0] = lower;
    levels[GRID_COUNT] = upper;
    return levels;
  }

  getLevelIndex(levels, price) {
    return levels.reduce((closestIndex, level, index) => {
      const currentDistance = Math.abs(level - price);
      const closestDistance = Math.abs(levels[closestIndex] - price);
      return currentDistance < closestDistance ? index : closestIndex;
    }, 0);
  }

  getNearestLevels(levels, currentPrice, side, limit) {
    const isBuy = side === 'buy';
    return levels
      .map((price, index) => ({ price, index }))
      .filter(level => isBuy ? level.price < currentPrice : level.price > currentPrice)
      .sort((a, b) => isBuy ? b.price - a.price : a.price - b.price)
      .slice(0, limit);
  }

  async fetchContext(symbol) {
    const [ticker, openOrders, balance] = await Promise.all([
      retry(() => this.exchange.fetchTicker(symbol)),
      retry(() => this.exchange.fetchOpenOrders(symbol)),
      retry(() => this.exchange.fetchBalance()),
    ]);
    const currentPrice = Number(ticker.last);
    const { lower, upper } = this.buildRange(symbol, currentPrice);
    const levels = this.buildLevels(lower, upper);
    return { ticker, currentPrice, openOrders, balance, lower, upper, levels };
  }

  getManagedOpenOrders(symbol, openOrders) {
    const symState = this.state.getSymbol(symbol);
    const managedIds = new Set(Object.keys(symState.orders));
    const managed = [];
    for (const order of openOrders) {
      const orderId = String(order.id);
      const levelIndex = this.getBotOrderLevel(order);
      if (!managedIds.has(orderId) && levelIndex !== null) {
        this.state.rememberOrder(symbol, order, { levelIndex });
        managedIds.add(orderId);
        console.warn(`[RECOVER] ${symbol} adopted order ${orderId} level=${levelIndex}`);
      }
      if (managedIds.has(orderId)) managed.push(order);
    }
    return managed;
  }

  getOrderClientId(order) {
    return String(order.clientOrderId || order.info?.clientOrderId || order.info?.origClientOrderId || '');
  }

  getBotOrderLevel(order) {
    const match = this.getOrderClientId(order).match(/^grid-[a-z0-9]+-[bs]-(\d+)-/i);
    return match ? Number(match[1]) : null;
  }

  makeClientOrderId(symbol, side, levelIndex) {
    const market = symbol.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return `grid-${market}-${side[0]}-${levelIndex}-${nonce}`.slice(0, 36);
  }

  async cancelGridOrders(symbol, reason) {
    const openOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    const managed = this.getManagedOpenOrders(symbol, openOrders);
    for (const order of managed) {
      await retry(() => this.exchange.cancelOrder(order.id, symbol));
      this.state.forgetOrder(symbol, order.id);
      console.log(`[CANCEL] ${symbol} ${order.side} ${order.id} | ${reason}`);
    }
  }

  async cancelOrder(symbol, order, reason) {
    await retry(() => this.exchange.cancelOrder(order.id, symbol));
    this.state.forgetOrder(symbol, order.id);
    console.log(`[CANCEL] ${symbol} ${order.side} ${order.id} | ${reason}`);
  }

  async placeLimit(symbol, side, levelIndex, price, amount) {
    const pendingKey = `${symbol}|${side}|${levelIndex}`;
    if (this.pendingOrderLevels.has(pendingKey)) {
      console.warn(`[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} | placement already in progress`);
      return null;
    }

    this.pendingOrderLevels.add(pendingKey);
    const clientOrderId = this.makeClientOrderId(symbol, side, levelIndex);
    let precisePrice = null;
    let preciseAmount = null;
    try {
      precisePrice = this.exchange.priceToPrecision(symbol, price);
      preciseAmount = this.exchange.amountToPrecision(symbol, amount);
      
      // Verify precision didn't push prices way too far from intended level
      // Allow up to 0.5% adjustment to handle floating-point accumulation in grid levels
      // Exchange precision often helps correct floating-point errors at boundaries
      const preciseNum = Number(precisePrice);
      const priceNum = Number(price);
      const priceDiffPct = Math.abs(preciseNum - priceNum) / priceNum * 100;
      if (priceDiffPct > 0.5) {
        console.warn(
          `[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} price=${price} -> ${precisePrice} | precision adjustment too large (${priceDiffPct.toFixed(4)}%)`
        );
        return null;
      }
      
      // A network timeout after submission is ambiguous. Retrying here can create
      // a second live order, so let the next reconciliation recover safely.
      const order = await this.exchange.createLimitOrder(
        symbol,
        side,
        preciseAmount,
        precisePrice,
        { newClientOrderId: clientOrderId }
      );
      this.state.rememberOrder(symbol, order, { levelIndex });
      console.log(`[GRID] ${symbol} ${side.toUpperCase()} level=${levelIndex} amount=${preciseAmount} price=${precisePrice}`);
      return order;
    } catch (err) {
      if (this.isInsufficientFundsError(err)) {
        console.warn(
          `[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} amount=${preciseAmount} price=${precisePrice} | insufficient balance`
        );
        return null;
      }
      if (this.isInvalidOrderAmountError(err)) {
        console.warn(
          `[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} amount=${amount} | invalid order amount: ${err.message}`
        );
        return null;
      }
      throw err;
    } finally {
      this.pendingOrderLevels.delete(pendingKey);
    }
  }

  isInsufficientFundsError(err) {
    const message = String(err?.message || err || '').toLowerCase();
    return err instanceof ccxt.InsufficientFunds ||
      err?.name === 'InsufficientFunds' ||
      message.includes('insufficient balance') ||
      message.includes('insufficient funds');
  }

  isInvalidOrderAmountError(err) {
    const message = String(err?.message || err || '').toLowerCase();
    return err instanceof ccxt.InvalidOrder ||
      err?.name === 'InvalidOrder' ||
      (message.includes('amount') && (
        message.includes('minimum amount') ||
        message.includes('precision') ||
        message.includes('must be greater')
      ));
  }

  getBaseFree(balance, symbol) {
    return Number(balance?.free?.[this.getBaseAsset(symbol)] || 0);
  }

  getQuoteFree(balance, symbol) {
    return Number(balance?.free?.[this.getQuoteAsset(symbol)] || 0);
  }

  getBaseAsset(symbol) {
    return symbol.split('/')[0];
  }

  getQuoteAsset(symbol) {
    return symbol.split('/')[1].split(':')[0];
  }

  getTradeFeeCurrency(trade) {
    return String(trade.fee?.currency || trade.info?.commissionAsset || '').toUpperCase();
  }

  getTradeFeeCost(trade) {
    return Number(trade.fee?.cost || trade.info?.commission || 0);
  }

  amountAfterBuyFee(symbol, trade) {
    const amount = Number(trade.amount);
    const feeCost = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const base = this.getBaseAsset(symbol).toUpperCase();
    if (feeCurrency === base) return Math.max(0, amount - feeCost);
    return amount;
  }

  estimateGridProfit(symbol, buy, sellTrade) {
    if (!buy) return { profit: 0, externalFees: [] };

    const base = this.getBaseAsset(symbol).toUpperCase();
    const quote = this.getQuoteAsset(symbol).toUpperCase();
    const sellPrice = Number(sellTrade.price);
    const sellAmount = Number(sellTrade.amount);
    const buyPrice = Number(buy.price);
    const buyAmount = Number(buy.amount);
    const buyFee = Number(buy.fee || 0);
    const buyFeeCurrency = String(buy.feeCurrency || '').toUpperCase();
    const sellFee = this.getTradeFeeCost(sellTrade);
    const sellFeeCurrency = this.getTradeFeeCurrency(sellTrade);

    let profit = (sellPrice * sellAmount) - (buyPrice * buyAmount);
    const externalFees = [];

    if (buyFeeCurrency === quote) {
      profit -= buyFee;
    } else if (buyFeeCurrency && buyFeeCurrency !== base) {
      externalFees.push(`${buyFee} ${buyFeeCurrency}`);
    }

    if (sellFeeCurrency === quote) {
      profit -= sellFee;
    } else if (sellFeeCurrency === base) {
      profit -= sellFee * sellPrice;
    } else if (sellFeeCurrency) {
      externalFees.push(`${sellFee} ${sellFeeCurrency}`);
    }

    return { profit, externalFees };
  }

  amountForBuy(symbol, price) {
    const market = this.exchange.markets[symbol];
    const minCost = Number(market?.limits?.cost?.min || 0);
    const notional = Math.max(this.getOrderSizeUsdt(), minCost);
    return notional / price;
  }

  amountForTrackedSell(symbol, sellLevelIndex) {
    const symState = this.state.getSymbol(symbol);
    const buy = symState.lastBuyByLevel[sellLevelIndex - 1];
    if (!buy) return 0;
    return Math.max(0, Number(buy.sellableAmount ?? buy.amount) || 0);
  }

  isOrderInsideRange(order, lower, upper) {
    const price = Number(order.price);
    // Use relative tolerance for floating-point precision handling
    // For boundary prices, use larger tolerance to prevent edge-case cancellations
    const rangeSize = upper - lower;
    // 0.05% of range + relative tolerance on the price itself (0.001%)
    const relativeEpsilon = Math.max(rangeSize * 0.0005, price * 0.00001);
    return price >= lower - relativeEpsilon && price <= upper + relativeEpsilon;
  }

  isOrderCloseToPriceLevel(orderPrice, levels) {
    const price = Number(orderPrice);
    // Check if order price is within 0.01% of any grid level
    // This ensures orders placed at grid prices aren't cancelled due to precision errors
    for (const level of levels) {
      const tolerance = Math.max(level * 0.0001, 1e-10);
      if (Math.abs(price - level) <= tolerance) {
        return true;
      }
    }
    return false;
  }

  getTradeId(trade) {
    return String(trade.id || `${trade.order}-${trade.timestamp}`);
  }

  forgetOrderIfClosed(symState, trade, openOrderIds) {
    if (!openOrderIds.has(String(trade.order))) {
      delete symState.orders[String(trade.order)];
    }
  }

  async handleBuyFill(symbol, levels, aiDecision, symState, trade, orderMeta, openOrderIds) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const levelIndex = Number(orderMeta.levelIndex);
    const fee = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const sellableAmount = this.amountAfterBuyFee(symbol, trade);

    symState.lastBuyByLevel[levelIndex] = { price, amount, sellableAmount, fee, feeCurrency, at: trade.datetime };
    this.state.data.totals.filledBuys++;
    this.forgetOrderIfClosed(symState, trade, openOrderIds);
    this.state.markProcessedTrade(symbol, this.getTradeId(trade));

    await this.sendAlert(`[GRID BUY] ${symbol} amount=${amount} @ ${price} | sellable=${sellableAmount}`);

    if (!GRID_REFILL_ON_FILLED || !aiDecision.allowTrading || !aiDecision.allowSell || levelIndex + 1 >= levels.length) {
      return;
    }

    const sellPrice = levels[levelIndex + 1];
    if ((sellPrice - price) / price < GRID_MIN_PROFIT_PCT) return;
    if (sellableAmount > 0) {
      await this.placeLimit(symbol, 'sell', levelIndex + 1, sellPrice, sellableAmount);
      return;
    }
    console.warn(`[SKIP] ${symbol} SELL refill level=${levelIndex + 1} | sellable amount is zero after buy fee`);
  }

  async handleSellFill(symbol, levels, aiDecision, symState, trade, orderMeta, openOrderIds) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const levelIndex = Number(orderMeta.levelIndex);
    const buyLevelIndex = symState.lastBuyByLevel[levelIndex - 1] ? levelIndex - 1 : levelIndex;
    const buy = symState.lastBuyByLevel[buyLevelIndex];
    const profitEstimate = this.estimateGridProfit(symbol, buy, trade);
    const estimatedProfit = profitEstimate.profit;

    symState.realizedGridProfit += estimatedProfit;
    this.state.data.totals.realizedGridProfit += estimatedProfit;
    this.state.data.totals.filledSells++;
    this.forgetOrderIfClosed(symState, trade, openOrderIds);

    if (buy) {
      const remainingAmount = Number(buy.sellableAmount ?? buy.amount) - amount;
      if (remainingAmount > 0) {
        buy.sellableAmount = remainingAmount;
      } else {
        delete symState.lastBuyByLevel[buyLevelIndex];
      }
    }

    this.state.markProcessedTrade(symbol, this.getTradeId(trade));

    const externalFeeText = profitEstimate.externalFees.length
      ? ` | external fees=${profitEstimate.externalFees.join(', ')}`
      : '';
    await this.sendAlert(
      `[GRID SELL] ${symbol} amount=${amount} @ ${price} | est profit=${estimatedProfit.toFixed(4)} USDT${externalFeeText}`
    );

    if (GRID_REFILL_ON_FILLED && aiDecision.allowTrading && aiDecision.allowBuy && levelIndex - 1 >= 0) {
      await this.placeLimit(symbol, 'buy', levelIndex - 1, levels[levelIndex - 1], amount);
    }
  }

  async handleFilledTrades(symbol, levels, aiDecision) {
    const symState = this.state.getSymbol(symbol);
    const [trades, openOrders] = await Promise.all([
      retry(() => this.exchange.fetchMyTrades(symbol, undefined, TRADE_FETCH_LIMIT)),
      retry(() => this.exchange.fetchOpenOrders(symbol)),
    ]);
    const openOrderIds = new Set(openOrders.map(order => String(order.id)));
    for (const trade of trades.sort((a, b) => a.timestamp - b.timestamp)) {
      const id = this.getTradeId(trade);
      if (this.state.processedTrade(symbol, id)) continue;
      if (!symState.orders[String(trade.order)]) {
        this.state.markProcessedTrade(symbol, id);
        continue;
      }

      const orderMeta = symState.orders[String(trade.order)];
      const side = String(trade.side).toLowerCase();

      if (side === 'buy') {
        await this.handleBuyFill(symbol, levels, aiDecision, symState, trade, orderMeta, openOrderIds);
        continue;
      }

      if (side === 'sell') {
        await this.handleSellFill(symbol, levels, aiDecision, symState, trade, orderMeta, openOrderIds);
        continue;
      }

      this.forgetOrderIfClosed(symState, trade, openOrderIds);
      this.state.markProcessedTrade(symbol, id);
    }
  }

  async enforceRangeExits(symbol, currentPrice) {
    if (STOP_LOSS_PRICE > 0 && currentPrice <= STOP_LOSS_PRICE) {
      await this.cancelGridOrders(symbol, `stop-loss ${STOP_LOSS_PRICE}`);
      await this.sendAlert(`[GRID STOP] ${symbol} price=${currentPrice} <= ${STOP_LOSS_PRICE}`);
      return false;
    }
    if (TAKE_PROFIT_PRICE > 0 && currentPrice >= TAKE_PROFIT_PRICE) {
      await this.cancelGridOrders(symbol, `take-profit ${TAKE_PROFIT_PRICE}`);
      await this.sendAlert(`[GRID TAKE PROFIT] ${symbol} price=${currentPrice} >= ${TAKE_PROFIT_PRICE}`);
      return false;
    }
    return true;
  }

  async withSymbolLock(symbol, fn) {
    const previous = this.symbolLocks.get(symbol) || Promise.resolve();
    let release;
    const current = new Promise(resolve => {
      release = resolve;
    });
    this.symbolLocks.set(symbol, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.symbolLocks.get(symbol) === current) {
        this.symbolLocks.delete(symbol);
      }
    }
  }

  async reconcileSymbol(symbol) {
    return this.withSymbolLock(symbol, () => this.reconcileSymbolUnlocked(symbol));
  }

  async reconcileSymbolUnlocked(symbol) {
    let context = await this.fetchContext(symbol);
    let { currentPrice, balance, lower, upper, levels } = context;
    const canContinue = await this.enforceRangeExits(symbol, currentPrice);
    if (!canContinue) return;

    const trailedUp = await this.maybeTrailUpRange(symbol, currentPrice, lower, upper);
    let trailedDown = null;
    if (trailedUp) {
      context = await this.fetchContext(symbol);
      context.trailingUpJustShifted = true;
      ({ currentPrice, balance, lower, upper, levels } = context);
    } else {
      trailedDown = await this.maybeTrailDownRange(symbol, currentPrice, lower, upper);
      if (trailedDown) {
        context = await this.fetchContext(symbol);
        context.trailingDownJustShifted = true;
        ({ currentPrice, balance, lower, upper, levels } = context);
      }
    }

    const trailed = Boolean(trailedUp || trailedDown);
    const aiDecision = await this.aiValidator.validate(symbol, context, { ignoreMinInterval: trailed });
    if (AI_VALIDATION_ENABLED) {
      console.log(
        `[AI] ${symbol}${trailedUp ? ' trailing-up' : ''}${trailedDown ? ' trailing-down' : ''} allow=${aiDecision.allowTrading} ` +
        `buy=${aiDecision.allowBuy} sell=${aiDecision.allowSell} ` +
        `confidence=${aiDecision.confidence} | ${aiDecision.reason}`
      );
    }

    await this.handleFilledTrades(symbol, levels, aiDecision);

    const freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    let managedOrders = this.getManagedOpenOrders(symbol, freshOpenOrders);

    if (GRID_CANCEL_OUT_OF_RANGE) {
      for (const order of managedOrders) {
        // Check if order is in range, or very close to a valid grid level (grid orders shouldn't be cancelled)
        const isValidGridOrder = this.isOrderCloseToPriceLevel(order.price, levels);
        if (!this.isOrderInsideRange(order, lower, upper) && !isValidGridOrder) {
          await this.cancelOrder(symbol, order, `outside range ${roundNumber(lower)}-${roundNumber(upper)}`);
        }
      }
      const refreshed = await retry(() => this.exchange.fetchOpenOrders(symbol));
      managedOrders = this.getManagedOpenOrders(symbol, refreshed);
    }

    const activeBuyLevels = new Set();
    const activeSellLevels = new Set();
    for (const order of managedOrders) {
      const index = this.getLevelIndex(levels, Number(order.price));
      if (order.side === 'buy') activeBuyLevels.add(index);
      if (order.side === 'sell') activeSellLevels.add(index);
    }
    const recentlyPlacedCutoff = Date.now() - Math.max(INTERVAL_MS * 2, MINUTE_MS);
    for (const order of Object.values(this.state.getSymbol(symbol).orders)) {
      if (Date.parse(order.createdAt) < recentlyPlacedCutoff) continue;
      if (order.side === 'buy') activeBuyLevels.add(Number(order.levelIndex));
      if (order.side === 'sell') activeSellLevels.add(Number(order.levelIndex));
    }

    const below = this.getNearestLevels(levels, currentPrice, 'buy', GRID_MAX_ACTIVE_BUY_ORDERS);
    const above = this.getNearestLevels(levels, currentPrice, 'sell', GRID_MAX_ACTIVE_SELL_ORDERS);

    let quoteFree = this.getQuoteFree(balance, symbol);
    let baseFree = this.getBaseFree(balance, symbol);

    for (const level of below) {
      if (!aiDecision.allowTrading || !aiDecision.allowBuy) break;
      if (activeBuyLevels.has(level.index)) continue;
      const amount = this.amountForBuy(symbol, level.price);
      const cost = amount * level.price;
      if (quoteFree < cost) break;
      const order = await this.placeLimit(symbol, 'buy', level.index, level.price, amount);
      if (!order) break;
      quoteFree -= cost;
    }

    for (const level of above) {
      if (!aiDecision.allowTrading || !aiDecision.allowSell) break;
      if (activeSellLevels.has(level.index)) continue;
      const trackedAmount = this.amountForTrackedSell(symbol, level.index);
      if (!(trackedAmount > 0)) continue;
      const amount = Math.min(trackedAmount, baseFree);
      if (!(amount > 0)) break;
      const order = await this.placeLimit(symbol, 'sell', level.index, level.price, amount);
      if (!order) break;
      baseFree -= amount;
    }

    console.log(
      `[SYNC] ${symbol} price=${roundNumber(currentPrice)} range=${roundNumber(lower)}-${roundNumber(upper)} ` +
      `orders=${managedOrders.length} estProfit=${roundNumber(this.state.getSymbol(symbol).realizedGridProfit, 4)}`
    );
  }

  async executeCycle() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      if (!this.circuitAllows() || killSwitchActive()) return;
      for (const symbol of SYMBOLS) {
        await this.reconcileSymbol(symbol);
      }
      this.recordSuccess();
    } catch (err) {
      console.error('[CYCLE]', err);
      this.recordError();
    } finally {
      this.isRunning = false;
    }
  }

  async sendAlert(message) {
    if (!FONNTE_ENABLED || !FONNTE_TOKEN || !FONNTE_TARGET) return;
    try {
      const form = new URLSearchParams({
        target: FONNTE_TARGET,
        message,
        countryCode: FONNTE_COUNTRY_CODE,
      }).toString();
      await new Promise((resolve, reject) => {
        const req = https.request(FONNTE_API_URL, {
          method: 'POST',
          headers: {
            Authorization: FONNTE_TOKEN,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(form),
          },
          timeout: FONNTE_TIMEOUT_MS,
        }, response => {
          response.resume();
          response.once('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              resolve();
              return;
            }
            reject(new Error(`Fonnte returned HTTP ${response.statusCode}`));
          });
        });
        req.once('timeout', () => req.destroy(new Error(`Fonnte request timed out after ${FONNTE_TIMEOUT_MS}ms`)));
        req.once('error', reject);
        req.end(form);
      });
    } catch (err) {
      console.warn('[ALERT] Failed:', err.message);
    }
  }

  async start() {
    console.log(`
[SPOT GRID BOT STARTED]
Mode: ${EXCHANGE_MODE.toUpperCase()}
Symbols: ${SYMBOLS.join(', ')}
Grid Mode: ${GRID_MODE}
Grid Count: ${GRID_COUNT}
Order Size: ${this.getOrderSizeUsdt()} USDT/grid
Range: ${GRID_LOWER_PRICE && GRID_UPPER_PRICE ? `${GRID_LOWER_PRICE}-${GRID_UPPER_PRICE}` : `auto +/-${GRID_RANGE_PCT}%`}
Trailing Range: ${GRID_TRAILING_RANGE_ENABLED ? 'ON (auto up/down)' : 'OFF'}
Trailing Up: ${GRID_TRAILING_UP_ENABLED ? `ON (range-follow trigger, cooldown=${GRID_TRAILING_UP_COOLDOWN_MS / MINUTE_MS}m)` : 'OFF'}
Trailing Down: ${GRID_TRAILING_DOWN_ENABLED ? `ON (range-follow trigger, cooldown=${GRID_TRAILING_DOWN_COOLDOWN_MS / MINUTE_MS}m)` : 'OFF'}
Max Active Orders: buy=${GRID_MAX_ACTIVE_BUY_ORDERS}, sell=${GRID_MAX_ACTIVE_SELL_ORDERS}
Recreate On Start: ${GRID_RECREATE_ON_START ? 'ON' : 'OFF'}
AI Validation: ${AI_VALIDATION_ENABLED ? `ON (${GEMINI_MODEL})` : 'OFF'}
`);
    await this.init();
    while (true) {
      await sleep(INTERVAL_MS);
      await this.executeCycle();
    }
  }
}

async function bootstrap() {
  validateRuntimeConfiguration();
  const lock = new ProcessLock(BOT_LOCK_PATH);
  lock.acquire();
  const shutdown = signal => {
    console.log(`[SHUTDOWN] ${signal}`);
    lock.release();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('exit', () => lock.release());

  try {
    const engine = new SpotGridEngine();
    await engine.start();
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  bootstrap().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  AIGridValidator,
  Config,
  GridState,
  ProcessLock,
  SpotGridEngine,
  bootstrap,
  validateRuntimeConfiguration,
};
