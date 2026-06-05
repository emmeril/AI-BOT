require('dotenv').config();
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
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
const MINUTE_MS = 60 * 1000;
const INTERVAL_MINUTES = Config.number('INTERVAL_MINUTES', 1);
const INTERVAL_MS = INTERVAL_MINUTES * MINUTE_MS;

const GRID_COUNT = Config.number('GRID_COUNT', 10);
const GRID_MODE = Config.get('GRID_MODE', 'ARITHMETIC').toUpperCase();
const GRID_LOWER_PRICE = Config.number('GRID_LOWER_PRICE', 0);
const GRID_UPPER_PRICE = Config.number('GRID_UPPER_PRICE', 0);
const GRID_RANGE_PCT = Config.number('GRID_RANGE_PCT', 5);
const GRID_TRAILING_UP_ENABLED = Config.boolean('GRID_TRAILING_UP_ENABLED', Config.boolean('GRID_DYNAMIC_RANGE', false));
const GRID_TRAILING_UP_COOLDOWN_MS = Math.max(Config.number('GRID_TRAILING_UP_COOLDOWN_MINUTES', 0), 0) * MINUTE_MS;
const GRID_ORDER_SIZE_USDT = Config.number('GRID_ORDER_SIZE_USDT', Config.number('ORDER_SIZE_USDT', 20));
const GRID_TOTAL_INVESTMENT_USDT = Config.number('GRID_TOTAL_INVESTMENT_USDT', 0);
const GRID_MAX_ACTIVE_BUY_ORDERS = Config.number('GRID_MAX_ACTIVE_BUY_ORDERS', 5);
const GRID_MAX_ACTIVE_SELL_ORDERS = Config.number('GRID_MAX_ACTIVE_SELL_ORDERS', 5);
const GRID_RECREATE_ON_START = Config.boolean('GRID_RECREATE_ON_START', false);
const GRID_CANCEL_OUT_OF_RANGE = Config.boolean('GRID_CANCEL_OUT_OF_RANGE', true);
const GRID_REFILL_ON_FILLED = Config.boolean('GRID_REFILL_ON_FILLED', true);
const GRID_MIN_PROFIT_PCT = Config.number('GRID_MIN_PROFIT_PCT', 0.1) / 100;
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
const AI_MIN_CONFIDENCE = Config.number('AI_MIN_CONFIDENCE', 60);
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
  if (!['ARITHMETIC', 'GEOMETRIC'].includes(GRID_MODE)) {
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
    const normalized = data && typeof data === 'object' ? data : {};
    normalized.version = Number(normalized.version) || 1;
    normalized.updatedAt = normalized.updatedAt || new Date().toISOString();
    normalized.symbols = normalized.symbols && typeof normalized.symbols === 'object'
      ? normalized.symbols
      : {};
    normalized.processedTradeIds = Array.isArray(normalized.processedTradeIds)
      ? normalized.processedTradeIds.map(String).slice(-2000)
      : [];
    normalized.totals = normalized.totals && typeof normalized.totals === 'object'
      ? normalized.totals
      : {};
    normalized.totals.filledBuys = Number(normalized.totals.filledBuys) || 0;
    normalized.totals.filledSells = Number(normalized.totals.filledSells) || 0;
    normalized.totals.realizedGridProfit = Number(normalized.totals.realizedGridProfit) || 0;
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
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      this.data.symbols[symbol] = {
        createdAt: new Date().toISOString(),
        config: {},
        orders: {},
        lastBuyByLevel: {},
        realizedGridProfit: 0,
      };
    }
    const sym = this.data.symbols[symbol];
    sym.config = sym.config && typeof sym.config === 'object' ? sym.config : {};
    sym.orders = sym.orders && typeof sym.orders === 'object' ? sym.orders : {};
    sym.lastBuyByLevel = sym.lastBuyByLevel && typeof sym.lastBuyByLevel === 'object'
      ? sym.lastBuyByLevel
      : {};
    sym.realizedGridProfit = Number(sym.realizedGridProfit) || 0;
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
    const scopedId = `${symbol}|${id}`;
    const legacyId = String(id);
    return this.data.processedTradeIds.includes(scopedId) ||
      this.data.processedTradeIds.includes(legacyId);
  }

  markProcessedTrade(symbol, id) {
    const scopedId = `${symbol}|${id}`;
    if (this.processedTrade(symbol, id)) return false;
    this.data.processedTradeIds.push(scopedId);
    this.data.processedTradeIds = this.data.processedTradeIds.slice(-2000);
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
    const { currentPrice, lower, upper, levels, trailingUpJustShifted = false } = context;
    const distLowerPct = ((currentPrice - lower) / currentPrice) * 100;
    const distUpperPct = ((upper - currentPrice) / currentPrice) * 100;
    return `
You validate whether a Binance spot grid bot may place new orders.

Return only JSON with:
{
  "allowTrading": true/false,
  "allowBuy": true/false,
  "allowSell": true/false,
  "confidence": 0-100,
  "reason": "short reason"
}

Decision rules:
- Grid works best in ranging or mildly volatile markets.
- Block new orders when trend is strongly one-directional, price is breaking out of range, volatility is extreme, or market data is unclear.
- When Trailing Up Just Shifted is true, the previous upside breakout is expected. Do not block solely because price is near the new upper bound; still block if momentum or volatility makes new grid orders unsafe.
- allowBuy can be false if downside pressure is high.
- allowSell can be false if upside breakout pressure is high.
- Be conservative. Existing open orders are managed by the bot; you only validate new orders.

Symbol: ${symbol}
Current Price: ${currentPrice}
Grid Lower: ${lower}
Grid Upper: ${upper}
Grid Count: ${GRID_COUNT}
Grid Mode: ${GRID_MODE}
Trailing Up Enabled: ${GRID_TRAILING_UP_ENABLED}
Trailing Up Just Shifted: ${trailingUpJustShifted}
Distance to Lower: ${distLowerPct.toFixed(3)}%
Distance to Upper: ${distUpperPct.toFixed(3)}%
Nearest Levels: ${levels.map(level => roundNumber(level)).join(', ')}
Candle Timeframe: ${AI_VALIDATION_TIMEFRAME}
Candle Summary: ${JSON.stringify(candleSummary)}
`;
  }

  parseResponse(text) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object in Gemini response');
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const confidence = Number(parsed.confidence);
    return {
      allowTrading: parsed.allowTrading === true,
      allowBuy: parsed.allowBuy === true,
      allowSell: parsed.allowSell === true,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      reason: String(parsed.reason || '').slice(0, 300),
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
    if (this.circuitBreaker.errors >= 5) {
      this.circuitBreaker.pausedUntil = Date.now() + 15 * MINUTE_MS;
      this.circuitBreaker.errors = 0;
      console.warn('[CIRCUIT] Too many errors. Paused 15m.');
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
    const manualRange = GRID_LOWER_PRICE > 0 && GRID_UPPER_PRICE > 0;
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

  getTrailingUpTrigger(lower, upper) {
    if (GRID_MODE === 'GEOMETRIC') {
      const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
      return upper * ratio;
    }
    return upper + ((upper - lower) / GRID_COUNT);
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

  async maybeTrailUpRange(symbol, currentPrice, lower, upper) {
    const manualRange = GRID_LOWER_PRICE > 0 && GRID_UPPER_PRICE > 0;
    if (!GRID_TRAILING_UP_ENABLED || manualRange) return null;

    const trailingState = this.getTrailingUpState(symbol);
    const lastShiftAt = Date.parse(trailingState.lastShiftAt || 0);
    if (GRID_TRAILING_UP_COOLDOWN_MS > Date.now() - lastShiftAt) return null;

    const levels = this.buildLevels(lower, upper);
    const triggerPrice = this.getTrailingUpTrigger(lower, upper);
    if (currentPrice < triggerPrice) return null;

    const newLower = levels[1];
    const newUpper = triggerPrice;
    const symState = this.state.getSymbol(symbol);
    symState.config.lower = newLower;
    symState.config.upper = newUpper;
    this.shiftStoredLevelIndexes(symbol, -1);
    trailingState.shifts++;
    trailingState.lastShiftAt = new Date().toISOString();
    this.state.save();

    console.log(
      `[TRAILING UP] ${symbol} shifted one grid: ` +
      `${roundNumber(lower)}-${roundNumber(upper)} -> ${roundNumber(newLower)}-${roundNumber(newUpper)}`
    );
    await this.sendAlert(
      `[GRID TRAILING UP] ${symbol} shifted to ${roundNumber(newLower)}-${roundNumber(newUpper)}`
    );
    return { lower: newLower, upper: newUpper };
  }

  buildLevels(lower, upper) {
    if (GRID_COUNT < 2) throw new Error('GRID_COUNT minimal 2.');
    if (GRID_MODE === 'GEOMETRIC') {
      const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
      return Array.from({ length: GRID_COUNT + 1 }, (_, i) => lower * Math.pow(ratio, i));
    }
    const step = (upper - lower) / GRID_COUNT;
    return Array.from({ length: GRID_COUNT + 1 }, (_, i) => lower + step * i);
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
    const precisePrice = this.exchange.priceToPrecision(symbol, price);
    const preciseAmount = this.exchange.amountToPrecision(symbol, amount);
    const clientOrderId = this.makeClientOrderId(symbol, side, levelIndex);
    try {
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
    return price >= lower && price <= upper;
  }

  async handleFilledTrades(symbol, levels, aiDecision) {
    const symState = this.state.getSymbol(symbol);
    const [trades, openOrders] = await Promise.all([
      retry(() => this.exchange.fetchMyTrades(symbol, undefined, 100)),
      retry(() => this.exchange.fetchOpenOrders(symbol)),
    ]);
    const openOrderIds = new Set(openOrders.map(order => String(order.id)));
    for (const trade of trades.sort((a, b) => a.timestamp - b.timestamp)) {
      const id = String(trade.id || `${trade.order}-${trade.timestamp}`);
      if (this.state.processedTrade(symbol, id)) continue;
      if (!symState.orders[String(trade.order)]) {
        this.state.markProcessedTrade(symbol, id);
        continue;
      }

      const orderMeta = symState.orders[String(trade.order)];
      const side = String(trade.side).toLowerCase();
      const price = Number(trade.price);
      const amount = Number(trade.amount);
      const levelIndex = Number(orderMeta.levelIndex);
      const fee = this.getTradeFeeCost(trade);
      const feeCurrency = this.getTradeFeeCurrency(trade);

      if (side === 'buy') {
        const sellableAmount = this.amountAfterBuyFee(symbol, trade);
        symState.lastBuyByLevel[levelIndex] = { price, amount, sellableAmount, fee, feeCurrency, at: trade.datetime };
        this.state.data.totals.filledBuys++;
        if (!openOrderIds.has(String(trade.order))) {
          delete symState.orders[String(trade.order)];
        }
        // Persist the fill before external effects so a restart cannot place
        // the same refill order or count the same trade twice.
        this.state.markProcessedTrade(symbol, id);
        await this.sendAlert(`[GRID BUY] ${symbol} amount=${amount} @ ${price} | sellable=${sellableAmount}`);
        if (GRID_REFILL_ON_FILLED && aiDecision.allowTrading && aiDecision.allowSell && levelIndex + 1 < levels.length) {
          const sellPrice = levels[levelIndex + 1];
          if ((sellPrice - price) / price >= GRID_MIN_PROFIT_PCT) {
            if (sellableAmount > 0) {
              await this.placeLimit(symbol, 'sell', levelIndex + 1, sellPrice, sellableAmount);
            } else {
              console.warn(`[SKIP] ${symbol} SELL refill level=${levelIndex + 1} | sellable amount is zero after buy fee`);
            }
          }
        }
      }

      if (side === 'sell') {
        const buyLevelIndex = symState.lastBuyByLevel[levelIndex - 1] ? levelIndex - 1 : levelIndex;
        const buy = symState.lastBuyByLevel[buyLevelIndex];
        const profitEstimate = this.estimateGridProfit(symbol, buy, trade);
        const estimatedProfit = profitEstimate.profit;
        symState.realizedGridProfit += estimatedProfit;
        this.state.data.totals.realizedGridProfit += estimatedProfit;
        this.state.data.totals.filledSells++;
        if (!openOrderIds.has(String(trade.order))) {
          delete symState.orders[String(trade.order)];
        }
        if (buy) {
          const remainingAmount = Number(buy.sellableAmount ?? buy.amount) - amount;
          if (remainingAmount > 0) {
            buy.sellableAmount = remainingAmount;
          } else {
            delete symState.lastBuyByLevel[buyLevelIndex];
          }
        }
        this.state.markProcessedTrade(symbol, id);
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

      if (side !== 'buy' && side !== 'sell') {
        if (!openOrderIds.has(String(trade.order))) {
          delete symState.orders[String(trade.order)];
        }
        this.state.markProcessedTrade(symbol, id);
      }
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
    if (trailedUp) {
      context = await this.fetchContext(symbol);
      context.trailingUpJustShifted = true;
      ({ currentPrice, balance, lower, upper, levels } = context);
    }

    const aiDecision = await this.aiValidator.validate(symbol, context, { ignoreMinInterval: Boolean(trailedUp) });
    if (AI_VALIDATION_ENABLED) {
      console.log(
        `[AI] ${symbol}${trailedUp ? ' trailing-up' : ''} allow=${aiDecision.allowTrading} ` +
        `buy=${aiDecision.allowBuy} sell=${aiDecision.allowSell} ` +
        `confidence=${aiDecision.confidence} | ${aiDecision.reason}`
      );
    }

    await this.handleFilledTrades(symbol, levels, aiDecision);

    const freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    let managedOrders = this.getManagedOpenOrders(symbol, freshOpenOrders);

    if (GRID_CANCEL_OUT_OF_RANGE) {
      for (const order of managedOrders) {
        if (!this.isOrderInsideRange(order, lower, upper)) {
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
Trailing Up: ${GRID_TRAILING_UP_ENABLED ? `ON (one-grid trigger, cooldown=${GRID_TRAILING_UP_COOLDOWN_MS / MINUTE_MS}m)` : 'OFF'}
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
  bootstrap().catch(console.error);
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
