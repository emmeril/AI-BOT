require('dotenv').config();
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

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
const EXCHANGE_MODE = (() => {
  const mode = Config.get('EXCHANGE_MODE', Config.boolean('EXCHANGE_DEMO', false) ? 'testnet' : 'live').toLowerCase();
  if (mode === 'demo') return 'testnet';
  return mode;
})();
const VALID_EXCHANGE_MODES = new Set(['live', 'testnet']);
const VALID_GRID_MODES = new Set(['ARITHMETIC', 'GEOMETRIC']);
const MINUTE_MS = 60 * 1000;
const INTERVAL_MINUTES = Config.number('INTERVAL_MINUTES', 1);
const INTERVAL_MS = INTERVAL_MINUTES * MINUTE_MS;

const GRID_COUNT = Config.number('GRID_COUNT', 10);
const GRID_MODE = Config.get('GRID_MODE', 'ARITHMETIC').toUpperCase();
const GRID_LOWER_PRICE = Config.number('GRID_LOWER_PRICE', 0);
const GRID_UPPER_PRICE = Config.number('GRID_UPPER_PRICE', 0);
const GRID_RANGE_PCT = Config.number('GRID_RANGE_PCT', 5);
const GRID_RESET_RANGE_ON_START = Config.boolean('GRID_RESET_RANGE_ON_START', false);
const GRID_STALE_RANGE_DEVIATION_PCT = Config.number('GRID_STALE_RANGE_DEVIATION_PCT', 50);
const GRID_STALE_RANGE_AUTO_RESET = Config.boolean('GRID_STALE_RANGE_AUTO_RESET', false);
const GRID_TRAILING_RANGE_ENABLED = Config.boolean('GRID_TRAILING_RANGE_ENABLED', false);
const GRID_TRAILING_UP_ENABLED = Config.boolean('GRID_TRAILING_UP_ENABLED', GRID_TRAILING_RANGE_ENABLED);
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
const GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MS = Math.max(
  Config.number('GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MINUTES', Math.max(INTERVAL_MINUTES * 3, 2)),
  0
) * MINUTE_MS;
const GRID_REFILL_ON_FILLED = Config.boolean('GRID_REFILL_ON_FILLED', true);
const GRID_STATE_FILE = Config.get('GRID_STATE_FILE', 'grid-state-spot.json');
const GRID_STATE_PATH = path.resolve(process.cwd(), GRID_STATE_FILE);
const BOT_LOCK_FILE = Config.get('BOT_LOCK_FILE', `${GRID_STATE_FILE}.lock`);
const BOT_LOCK_PATH = path.resolve(process.cwd(), BOT_LOCK_FILE);
const BOT_LOCK_STALE_GRACE_MS = Math.max(Config.number('BOT_LOCK_STALE_GRACE_MS', 2000), 0);
const GRID_POST_ONLY = Config.boolean('GRID_POST_ONLY', true);
const GRID_PRICE_PRECISION_MAX_DEVIATION_PCT = Config.number('GRID_PRICE_PRECISION_MAX_DEVIATION_PCT', 0.05);

// ------------------------------
//  Smart Grid Range Advisor (Gemini AI)
// ------------------------------
const GEMINI_RANGE_ADVISOR_ENABLED = Config.boolean('GEMINI_RANGE_ADVISOR_ENABLED', false);
const GEMINI_API_KEY = Config.get('GEMINI_API_KEY', '');
const GEMINI_MODEL = Config.get('GEMINI_MODEL', 'gemini-2.5-flash');
const GEMINI_API_BASE_URL = Config.get(
  'GEMINI_API_BASE_URL',
  'https://generativelanguage.googleapis.com'
);
// Minimum gap between actual Gemini calls per symbol, even though the advisor is
// evaluated every cycle. Protects API quota/cost when INTERVAL_MINUTES is small.
const GEMINI_RANGE_ADVISOR_MIN_INTERVAL_MS = Math.max(
  Config.number('GEMINI_RANGE_ADVISOR_MIN_INTERVAL_MINUTES', 15),
  0
) * MINUTE_MS;
const GEMINI_RANGE_ADVISOR_TIMEFRAME = Config.get('GEMINI_RANGE_ADVISOR_TIMEFRAME', '1h');
const GEMINI_RANGE_ADVISOR_CANDLE_LIMIT = Config.number('GEMINI_RANGE_ADVISOR_CANDLE_LIMIT', 100);
const GEMINI_RANGE_ADVISOR_USE_WEB_SEARCH = Config.boolean('GEMINI_RANGE_ADVISOR_USE_WEB_SEARCH', true);
// How far the AI-recommended range is allowed to differ from the current
// auto/manual range before being applied; a safety clamp against bad output.
const GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT = Config.number('GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT', 40);
// Minimum width (as a % of current price) the AI-recommended range must span.
// Passed into the prompt as an instruction so Gemini doesn't suggest an overly
// narrow range that would cause grid levels to bunch up too tightly.
const GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT = Config.number('GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT', 2);
const GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE = Config.number('GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE', 0.55);
const GEMINI_RANGE_ADVISOR_TIMEOUT_MS = Config.number('GEMINI_RANGE_ADVISOR_TIMEOUT_MS', 20_000);
const GEMINI_RANGE_ADVISOR_APPLY_ON = Config.get('GEMINI_RANGE_ADVISOR_APPLY_ON', 'AUTO_RANGE_ONLY').toUpperCase();
const GEMINI_RANGE_ADVISOR_STATE_FILE = Config.get(
  'GEMINI_RANGE_ADVISOR_STATE_FILE',
  'gemini-range-advisor-state.json'
);
const GEMINI_RANGE_ADVISOR_STATE_PATH = path.resolve(process.cwd(), GEMINI_RANGE_ADVISOR_STATE_FILE);

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

class AtomicFileWriter {
  static queues = new Map();
  static counter = 0;

  static write(filePath, buildContents) {
    const previous = AtomicFileWriter.queues.get(filePath) || Promise.resolve();
    const sequence = ++AtomicFileWriter.counter;
    const current = previous
      .catch(() => {})
      .then(async () => {
        const tempPath = `${filePath}.${process.pid}.${sequence}.tmp`;
        try {
          await fs.promises.writeFile(tempPath, buildContents());
          await fs.promises.rename(tempPath, filePath);
        } catch (err) {
          // Best-effort cleanup of the orphaned temp file so it doesn't accumulate.
          fs.promises.unlink(tempPath).catch(() => {});
          throw err;
        }
      })
      .catch(err => {
        console.warn(`[FILE] Failed to persist ${filePath}:`, err.message);
      })
      .finally(() => {
        if (AtomicFileWriter.queues.get(filePath) === current) {
          AtomicFileWriter.queues.delete(filePath);
        }
      });
    AtomicFileWriter.queues.set(filePath, current);
    return current;
  }

  /**
   * Remove any leftover *.tmp files for the given base path that were
   * abandoned by a previous (crashed) process.  Safe to call on startup
   * before any writes begin.
   */
  static async cleanupStaleTempFiles(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    let entries;
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    const stalePattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.\\d+\\.tmp$`);
    for (const entry of entries) {
      if (!stalePattern.test(entry)) continue;
      const tmpPath = path.join(dir, entry);
      try {
        await fs.promises.unlink(tmpPath);
        console.warn(`[FILE] Removed stale temp file: ${tmpPath}`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`[FILE] Could not remove stale temp file ${tmpPath}:`, err.message);
        }
      }
    }
  }
}

// ------------------------------
//  Utility Functions
// ------------------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {}
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (timeoutId.unref) timeoutId.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

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
  requireNonNegative('BOT_LOCK_STALE_GRACE_MS', BOT_LOCK_STALE_GRACE_MS);
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
  if (FONNTE_ENABLED && (!FONNTE_TOKEN || !FONNTE_TARGET)) {
    errors.push('FONNTE_TOKEN and FONNTE_TARGET are required when FONNTE_ENABLED=true');
  }
  if (GEMINI_RANGE_ADVISOR_ENABLED) {
    if (!GEMINI_API_KEY) errors.push('GEMINI_API_KEY is required when GEMINI_RANGE_ADVISOR_ENABLED=true');
    requirePositive('GEMINI_RANGE_ADVISOR_CANDLE_LIMIT', GEMINI_RANGE_ADVISOR_CANDLE_LIMIT);
    requirePositive('GEMINI_RANGE_ADVISOR_TIMEOUT_MS', GEMINI_RANGE_ADVISOR_TIMEOUT_MS);
    if (!(GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE >= 0 && GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE <= 1)) {
      errors.push('GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE must be between 0 and 1');
    }
    if (!['AUTO_RANGE_ONLY', 'ALWAYS'].includes(GEMINI_RANGE_ADVISOR_APPLY_ON)) {
      errors.push('GEMINI_RANGE_ADVISOR_APPLY_ON must be AUTO_RANGE_ONLY or ALWAYS');
    }
  }

  if (
    GRID_TOTAL_INVESTMENT_USDT > 0 &&
    GRID_ORDER_SIZE_USDT > 0 &&
    GRID_TOTAL_INVESTMENT_USDT / Math.max(GRID_COUNT, 1) < GRID_ORDER_SIZE_USDT
  ) {
    console.warn(
      `[CONFIG] GRID_TOTAL_INVESTMENT_USDT takes precedence; effective per-grid order size is ` +
      `${roundNumber(GRID_TOTAL_INVESTMENT_USDT / Math.max(GRID_COUNT, 1), 8)} USDT, below GRID_ORDER_SIZE_USDT=${GRID_ORDER_SIZE_USDT}`
    );
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
    if (!raw) {
      return { pid: null, token: null, malformed: true };
    }
    try {
      const parsed = JSON.parse(raw);
      const pid = Number(parsed.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        return { pid: null, token: null, malformed: true };
      }
      return {
        pid,
        token: typeof parsed.token === 'string' ? parsed.token : null,
      };
    } catch {
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0) {
        return { pid, token: null };
      }
      return { pid: null, token: null, malformed: true };
    }
  }

  removeMalformedLock(owner) {
    if (!owner?.malformed) return false;
    if (owner.pid && this.processIsAlive(owner.pid)) return false;
    try {
      fs.unlinkSync(this.lockPath);
      console.warn(`[LOCK] Removed malformed stale lock ${this.lockPath}`);
      return true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return true;
    }
  }

  removeStaleLock(owner) {
    if (!owner || owner.malformed || this.processIsAlive(owner.pid)) return false;
    console.warn(`[LOCK] Found stale lock for PID ${owner.pid}; waiting ${BOT_LOCK_STALE_GRACE_MS}ms before failing closed`);
    sleepSync(BOT_LOCK_STALE_GRACE_MS);

    let latest;
    try {
      latest = this.readOwner();
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      throw err;
    }

    const sameOwner = latest.pid === owner.pid && latest.token === owner.token;
    if (!sameOwner || this.processIsAlive(latest.pid)) return false;
    throw new Error(`Stale bot lock found for PID ${owner.pid}. Remove ${this.lockPath} manually after confirming no bot is running.`);
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

  assertLockCanBeAcquired() {
    try {
      const owner = this.readOwner();
      if (this.removeMalformedLock(owner)) return true;
      if (this.removeStaleLock(owner)) return true;
      if (!this.processIsAlive(owner.pid)) return false;
      return false;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      throw err;
    }
  }

  acquire() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        this.fd = fs.openSync(this.lockPath, 'wx');
        this.ownerToken = crypto.randomUUID();
        fs.writeSync(this.fd, JSON.stringify({
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
        console.log(`[LOCK] Acquired lock ${this.lockPath} for PID ${process.pid}`);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let owner;
        try {
          owner = this.readOwner();
        } catch (readErr) {
          if (readErr.code === 'ENOENT') continue;
          throw readErr;
        }
        if (this.removeMalformedLock(owner)) continue;
        if (this.processIsAlive(owner.pid)) {
          throw new Error(`Bot already running with PID ${owner.pid}. Lock: ${this.lockPath}`);
        }
        if (this.removeStaleLock(owner)) continue;
      }
    }
    throw new Error(`Unable to acquire bot lock after repeated stale-lock cleanup: ${this.lockPath}`);
  }

  release() {
    if (this.fd === null) return;
    // Capture and clear the token BEFORE closing fd so ownsLock() can't be
    // called after the file descriptor is invalid.  We verify ownership using
    // the in-memory token directly rather than re-reading the lock file after
    // closeSync(), which would introduce a TOCTOU race.
    const tokenSnapshot = this.ownerToken;
    try {
      // Check ownership while fd is still open (file content is stable).
      const isOwner = tokenSnapshot !== null && this.ownsLock();
      fs.closeSync(this.fd);
      if (isOwner) {
        try {
          fs.unlinkSync(this.lockPath);
          console.log(`[LOCK] Released lock ${this.lockPath}`);
        } catch (err) {
          if (err.code !== 'ENOENT') console.warn('[LOCK] Failed to unlink lock file:', err.message);
        }
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
        throw new Error(`EXCHANGE_MODE invalid: ${EXCHANGE_MODE}. Use live or testnet.`);
      }
      this.instance = new ccxt.binance({
        apiKey: process.env.EXCHANGE_API_KEY,
        secret: process.env.EXCHANGE_SECRET,
        enableRateLimit: true,
        options: {
          defaultType: 'spot',
          fetchMarkets: { types: ['spot'] },
          adjustForTimeDifference: true,
          recvWindow: 10000,
        },
      });
      if (EXCHANGE_MODE === 'testnet') {
        this.instance.setSandboxMode(true);
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
    this.rebuildProcessedTradeIndex();
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

  rebuildProcessedTradeIndex() {
    this.processedTradeIdSet = new Set(this.data.processedTradeIds);
  }

  ensureProcessedTradeIndex() {
    if (
      !this.processedTradeIdSet ||
      this.processedTradeIdSet.size !== this.data.processedTradeIds.length
    ) {
      this.rebuildProcessedTradeIndex();
    }
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    return AtomicFileWriter.write(GRID_STATE_PATH, () => JSON.stringify(this.data, null, 2));
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
        lastTradeTimestamp: 0,
        trailingUp: { shifts: 0, lastShiftAt: null },
        trailingDown: { shifts: 0, lastShiftAt: null },
      };
    }
    const sym = this.data.symbols[symbol];
    sym.config = isPlainObject(sym.config) ? sym.config : {};
    sym.orders = isPlainObject(sym.orders) ? sym.orders : {};
    sym.lastBuyByLevel = isPlainObject(sym.lastBuyByLevel) ? sym.lastBuyByLevel : {};
    sym.realizedGridProfit = numberOrZero(sym.realizedGridProfit);
    sym.lastTradeTimestamp = numberOrZero(sym.lastTradeTimestamp);
    if (!sym.trailingUp) sym.trailingUp = { shifts: 0, lastShiftAt: null };
    if (!sym.trailingDown) sym.trailingDown = { shifts: 0, lastShiftAt: null };
    return sym;
  }

  async rememberOrder(symbol, order, meta) {
    const sym = this.getSymbol(symbol);
    sym.orders[String(order.id)] = {
      id: String(order.id),
      side: order.side,
      levelIndex: meta.levelIndex,
      price: Number(order.price),
      amount: Number(order.amount),
      createdAt: new Date().toISOString(),
    };
    await this.save();
  }

  async forgetOrder(symbol, orderId) {
    const sym = this.getSymbol(symbol);
    delete sym.orders[String(orderId)];
    await this.save();
  }

  processedTrade(symbol, id) {
    this.ensureProcessedTradeIndex();
    const scopedId = scopedTradeId(symbol, id);
    const legacyId = String(id);
    return this.processedTradeIdSet.has(scopedId) ||
      this.processedTradeIdSet.has(legacyId);
  }

  markProcessedTrade(symbol, id) {
    this.ensureProcessedTradeIndex();
    const scopedId = scopedTradeId(symbol, id);
    if (this.processedTrade(symbol, id)) return false;
    this.data.processedTradeIds.push(scopedId);
    this.processedTradeIdSet.add(scopedId);
    this.data.processedTradeIds = this.data.processedTradeIds.slice(-MAX_PROCESSED_TRADE_IDS);
    if (this.data.processedTradeIds.length >= MAX_PROCESSED_TRADE_IDS) {
      this.rebuildProcessedTradeIndex();
    }
    this.save();
    return true;
  }
}

// ------------------------------
//  Binance-Style Spot Grid Engine
// ------------------------------
// ------------------------------
//  Smart Grid Range Advisor (Gemini AI)
// ------------------------------
//
// Re-evaluated every cycle (cheap local checks), but only actually calls the
// Gemini API at most once per GEMINI_RANGE_ADVISOR_MIN_INTERVAL_MS per symbol,
// to avoid burning API quota/cost on tight INTERVAL_MINUTES.
//
// Pipeline per symbol:
//   1. fetchOHLCV (ccxt)              -> candle history
//   2. computeIndicators (pure JS)    -> RSI(14), ATR(14), Bollinger Bands(20,2)
//   3. Gemini API (with googleSearch grounding tool) -> { lower, upper, confidence, reasoning }
//   4. Sanity clamp vs. current price / max shift % / min confidence
//   5. Cache result; SpotGridEngine.buildRange() consumes the cached suggestion.
class TechnicalIndicators {
  static rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return roundNumber(100 - 100 / (1 + rs), 2);
  }

  static atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const [, , high, low] = candles[i];
      const prevClose = candles[i - 1][4];
      trueRanges.push(Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      ));
    }
    const lastN = trueRanges.slice(-period);
    const atr = lastN.reduce((a, b) => a + b, 0) / lastN.length;
    return roundNumber(atr, 8);
  }

  static bollinger(closes, period = 20, stdDevMultiplier = 2) {
    if (closes.length < period) return null;
    const window = closes.slice(-period);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
      middle: roundNumber(mean, 8),
      upper: roundNumber(mean + stdDevMultiplier * stdDev, 8),
      lower: roundNumber(mean - stdDevMultiplier * stdDev, 8),
      stdDev: roundNumber(stdDev, 8),
    };
  }

  static volatilityPct(candles) {
    if (!candles.length) return null;
    const closes = candles.map(c => c[4]);
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    if (low <= 0) return null;
    return roundNumber(((high - low) / low) * 100, 2);
  }
}

class GeminiRangeAdvisor {
  constructor(exchange) {
    this.exchange = exchange;
    this.cache = this.loadCache();
  }

  loadCache() {
    try {
      if (fs.existsSync(GEMINI_RANGE_ADVISOR_STATE_PATH)) {
        return JSON.parse(fs.readFileSync(GEMINI_RANGE_ADVISOR_STATE_PATH, 'utf8')) || {};
      }
    } catch (err) {
      console.warn('[GEMINI] Failed to read advisor cache, starting fresh:', err.message);
    }
    return {};
  }

  async saveCache() {
    await AtomicFileWriter.write(GEMINI_RANGE_ADVISOR_STATE_PATH, () => JSON.stringify(this.cache, null, 2));
  }

  isEnabled() {
    return GEMINI_RANGE_ADVISOR_ENABLED && Boolean(GEMINI_API_KEY);
  }

  /**
   * Returns the cached/fresh suggestion for a symbol, or null if disabled,
   * not yet due for refresh, or the last attempt failed.
   * This is cheap to call every cycle: it only triggers a real Gemini call
   * once the per-symbol cooldown has elapsed.
   */
  async getSuggestion(symbol, currentPrice) {
    if (!this.isEnabled()) return null;
    const entry = this.cache[symbol];
    const now = Date.now();
    const due = !entry || (now - (entry.fetchedAt || 0)) >= GEMINI_RANGE_ADVISOR_MIN_INTERVAL_MS;
    if (!due) return entry?.suggestion || null;

    try {
      const suggestion = await this.computeSuggestion(symbol, currentPrice);
      this.cache[symbol] = { fetchedAt: now, suggestion };
      await this.saveCache();
      return suggestion;
    } catch (err) {
      console.warn(`[GEMINI] ${symbol} range advisor failed, keeping previous suggestion:`, err.message);
      // Keep stale suggestion (if any) but stamp fetchedAt so we don't hammer
      // the API on every cycle while it's failing.
      if (entry) entry.fetchedAt = now;
      else this.cache[symbol] = { fetchedAt: now, suggestion: null, lastError: err.message };
      await this.saveCache();
      return entry?.suggestion || null;
    }
  }

  async computeSuggestion(symbol, currentPrice) {
    const candles = await retry(() => this.exchange.fetchOHLCV(
      symbol,
      GEMINI_RANGE_ADVISOR_TIMEFRAME,
      undefined,
      GEMINI_RANGE_ADVISOR_CANDLE_LIMIT
    ));
    if (!Array.isArray(candles) || candles.length < 20) {
      throw new Error(`insufficient candle history (${candles?.length || 0})`);
    }
    const closes = candles.map(c => c[4]);
    const indicators = {
      rsi14: TechnicalIndicators.rsi(closes, 14),
      atr14: TechnicalIndicators.atr(candles, 14),
      bollinger20: TechnicalIndicators.bollinger(closes, 20, 2),
      volatilityPct: TechnicalIndicators.volatilityPct(candles),
      candleCount: candles.length,
      timeframe: GEMINI_RANGE_ADVISOR_TIMEFRAME,
    };

    const raw = await this.callGemini(symbol, currentPrice, indicators);
    return this.sanitizeSuggestion(symbol, currentPrice, raw);
  }

  buildPrompt(symbol, priceOrContext, indicators = {}) {
    const context = isPlainObject(priceOrContext)
      ? priceOrContext
      : { currentPrice: priceOrContext };
    const currentPrice = Number(context.currentPrice);
    const trailingUpJustShifted = Boolean(context.trailingUpJustShifted);
    const trailingDownJustShifted = Boolean(context.trailingDownJustShifted);

    return `You are a quantitative trading assistant advising a SPOT GRID TRADING bot (buy low / sell high within a fixed price range).
Grid bots perform best when the price range tightly matches realistic near-term price action (ranging/sideways market), and perform badly if the price breaks far outside the range or if the market is strongly trending.

Symbol: ${symbol}
Current price: ${currentPrice}
Current grid range: ${context.lower ?? 'unknown'}-${context.upper ?? 'unknown'}
Timeframe analyzed: ${indicators.timeframe} (${indicators.candleCount} candles)
RSI(14): ${indicators.rsi14}
ATR(14): ${indicators.atr14}
Bollinger Bands(20,2): lower=${indicators.bollinger20?.lower}, middle=${indicators.bollinger20?.middle}, upper=${indicators.bollinger20?.upper}
Recent range volatility: ${indicators.volatilityPct}%
Trailing Up Just Shifted: ${trailingUpJustShifted}
Trailing Down Just Shifted: ${trailingDownJustShifted}

${trailingUpJustShifted ? 'Do not block solely because price is near the new upper bound immediately after a completed trailing-up shift.' : ''}
${trailingDownJustShifted ? 'Do not block solely because price is near the new lower bound immediately after a completed trailing-down shift.' : ''}

${GEMINI_RANGE_ADVISOR_USE_WEB_SEARCH
  ? 'Use Google Search to check for any very recent (last 24-48h) crypto market news or sentiment relevant to this symbol or the broader crypto market that could affect short-term volatility or trend direction.'
  : 'Do not use external search; rely only on the indicators provided.'}

Based on all of this, recommend a grid trading price range (lower and upper bound) that is appropriate for the next few hours to a day, and assess whether current conditions favor grid trading (ranging) or disfavor it (strongly trending, about to break out).

Minimum range width requirement: the recommended range MUST span at least ${GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT}% of the current price (i.e. upper - lower >= ${GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT}% * ${currentPrice}). Do not recommend a narrower range even if volatility appears very low; widen the range as needed to meet this minimum.

Respond with ONLY a single valid JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "lower": <number>,
  "upper": <number>,
  "confidence": <number between 0 and 1>,
  "marketCondition": "<RANGING|TRENDING_UP|TRENDING_DOWN|VOLATILE|UNCERTAIN>",
  "reasoning": "<short 1-2 sentence explanation>"
}`;
  }

  async callGemini(symbol, currentPrice, indicators) {
    const prompt = this.buildPrompt(symbol, currentPrice, indicators);
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    };
    if (GEMINI_RANGE_ADVISOR_USE_WEB_SEARCH) {
      body.tools = [{ googleSearch: {} }];
    }
    const payload = JSON.stringify(body);
    const url = `${GEMINI_API_BASE_URL}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const text = await withTimeout(
      new Promise((resolve, reject) => {
        const req = https.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        }, response => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { raw += chunk; });
          response.on('end', () => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(`Gemini API returned HTTP ${response.statusCode}: ${raw.slice(0, 300)}`));
              return;
            }
            try {
              const json = JSON.parse(raw);
              const parts = json?.candidates?.[0]?.content?.parts || [];
              const combined = parts.map(p => p.text || '').join('').trim();
              if (!combined) {
                reject(new Error('Gemini API returned an empty response'));
                return;
              }
              resolve(combined);
            } catch (err) {
              reject(new Error(`Failed to parse Gemini API response: ${err.message}`));
            }
          });
        });
        req.once('error', reject);
        req.end(payload);
      }),
      GEMINI_RANGE_ADVISOR_TIMEOUT_MS,
      `Gemini API call timed out after ${GEMINI_RANGE_ADVISOR_TIMEOUT_MS}ms`
    );

    const cleaned = text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(`Gemini did not return valid JSON: ${cleaned.slice(0, 200)}`);
    }
    return parsed;
  }

  sanitizeSuggestion(symbol, currentPrice, raw) {
    const lower = Number(raw?.lower);
    const upper = Number(raw?.upper);
    const confidence = Number(raw?.confidence);
    if (!(lower > 0) || !(upper > 0) || !(lower < upper)) {
      throw new Error(`Gemini returned an invalid range: lower=${raw?.lower}, upper=${raw?.upper}`);
    }
    if (!(confidence >= 0 && confidence <= 1)) {
      throw new Error(`Gemini returned an invalid confidence: ${raw?.confidence}`);
    }
    // Safety clamp: the suggested range must contain the current price and
    // must not deviate further than GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT from it,
    // so a hallucinated or out-of-date suggestion can't blow up the grid.
    const maxLower = currentPrice * (1 - GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT / 100);
    const maxUpper = currentPrice * (1 + GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT / 100);
    const clampedLower = Math.max(lower, maxLower);
    const clampedUpper = Math.min(upper, maxUpper);
    if (!(clampedLower < currentPrice && clampedUpper > currentPrice)) {
      throw new Error(
        `Gemini suggested range ${lower}-${upper} does not bracket current price ${currentPrice} after clamping`
      );
    }
    const suggestion = {
      lower: roundNumber(clampedLower, 8),
      upper: roundNumber(clampedUpper, 8),
      confidence: roundNumber(confidence, 2),
      marketCondition: typeof raw?.marketCondition === 'string' ? raw.marketCondition : 'UNCERTAIN',
      reasoning: typeof raw?.reasoning === 'string' ? raw.reasoning.slice(0, 500) : '',
      wasClamped: clampedLower !== roundNumber(lower, 8) || clampedUpper !== roundNumber(upper, 8),
    };
    console.log(
      `[GEMINI] ${symbol} suggestion: range=${suggestion.lower}-${suggestion.upper} ` +
      `confidence=${suggestion.confidence} condition=${suggestion.marketCondition}` +
      `${suggestion.wasClamped ? ' (clamped to safety bounds)' : ''} — ${suggestion.reasoning}`
    );
    return suggestion;
  }
}

const AIGridValidator = GeminiRangeAdvisor;

class SpotGridEngine {
  constructor() {
    this.exchange = ExchangeManager.getInstance();
    this.state = new GridState();
    this.isRunning = false;
    this.symbolLocks = new Map();
    this.pendingOrderLevels = new Set();
    this.rangeResetSymbols = new Set();
    this.circuitBreaker = { errors: 0, pausedUntil: 0 };
    // for stuck investment warning deduplication
    this.stuckInvestmentWarned = new Set();
    this.rangeAdvisor = new GeminiRangeAdvisor(this.exchange);
  }

  async init() {
    await retry(() => this.exchange.loadMarkets());
    for (const symbol of SYMBOLS) {
      try {
        this.ensureMarket(symbol);
        this.warnIfPerGridSizeBelowMinCost(symbol);
        if (GRID_RECREATE_ON_START) await this.cancelGridOrders(symbol, 'recreate-on-start');
        await this.reconcileSymbol(symbol);
      } catch (err) {
        console.error(`[INIT] ${symbol}`, err);
        this.recordError();
      }
    }
  }

  warnIfPerGridSizeBelowMinCost(symbol) {
    const minCost = this.getMinCost(symbol);
    if (!(minCost > 0)) return;
    const perGridSize = this.getOrderSizeUsdt();
    if (perGridSize >= minCost) return;
    console.warn(
      `[CONFIG] ${symbol} per-grid order size ${roundNumber(perGridSize, 8)} USDT is below this symbol's ` +
      `exchange minimum order cost ${minCost} USDT. Some buy levels may never be able to place an order. ` +
      `Consider lowering GRID_COUNT or raising GRID_TOTAL_INVESTMENT_USDT/GRID_ORDER_SIZE_USDT.`
    );
  }

  ensureMarket(symbol) {
    if (!this.exchange.markets[symbol]) {
      throw new Error(`Symbol ${symbol} not found on Binance spot market.`);
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

  isStoredRangeStale(symbol, currentPrice, lower, upper) {
    if (!(lower > 0) || !(upper > 0) || !(currentPrice > 0)) return false;
    if (currentPrice >= lower && currentPrice <= upper) return false;
    const distance = currentPrice < lower ? (lower - currentPrice) : (currentPrice - upper);
    const rangeSize = upper - lower;
    const deviationPct = rangeSize > 0 ? (distance / rangeSize) * 100 : Infinity;
    if (deviationPct <= GRID_STALE_RANGE_DEVIATION_PCT) return false;
    console.warn(
      `[RANGE] ${symbol} stored range ${roundNumber(lower)}-${roundNumber(upper)} is stale: ` +
      `current price ${roundNumber(currentPrice)} is ${roundNumber(deviationPct, 1)}% outside the range ` +
      `(threshold ${GRID_STALE_RANGE_DEVIATION_PCT}%).`
    );
    return true;
  }

  async buildRange(symbol, currentPrice) {
    const symState = this.state.getSymbol(symbol);
    const manualRange = hasManualGridRange();
    let storedLower = Number(symState.config.lower) || 0;
    let storedUpper = Number(symState.config.upper) || 0;
    // Captured BEFORE storedLower/storedUpper get zeroed out below, so we
    // still know what the previous range was if a reset happens.
    const previousLower = storedLower;
    const previousUpper = storedUpper;
    let rangeWasReset = false;

    if (!manualRange && storedLower > 0 && storedUpper > 0) {
      const stale = this.isStoredRangeStale(symbol, currentPrice, storedLower, storedUpper);
      if (stale) {
        if (GRID_STALE_RANGE_AUTO_RESET) {
          console.warn(`[RANGE] ${symbol} auto-resetting stale range around current price (GRID_STALE_RANGE_AUTO_RESET=true).`);
          storedLower = 0;
          storedUpper = 0;
          rangeWasReset = true;
        } else {
          console.warn(
            `[RANGE] ${symbol} keeping stale stored range because GRID_STALE_RANGE_AUTO_RESET=false. ` +
            `Set GRID_STALE_RANGE_AUTO_RESET=true to auto re-center, or set GRID_RESET_RANGE_ON_START=true, ` +
            `or clear ${GRID_STATE_FILE} manually if this range no longer reflects the market.`
          );
        }
      }
    }

    const resetAutoRange = !manualRange &&
      GRID_RESET_RANGE_ON_START &&
      !(this.rangeResetSymbols && this.rangeResetSymbols.has(symbol));
    if (resetAutoRange && previousLower > 0 && previousUpper > 0) {
      rangeWasReset = true;
    }

    // Smart Grid Range Advisor: ask Gemini for a recommended range. Only
    // considered when it's allowed to influence this symbol's range mode
    // (AUTO_RANGE_ONLY = never override a manual GRID_LOWER/UPPER_PRICE range;
    // ALWAYS = also override manual ranges) and when confidence clears the bar.
    const advisorAllowed = GEMINI_RANGE_ADVISOR_APPLY_ON === 'ALWAYS' || !manualRange;
    let aiSuggestion = null;
    if (advisorAllowed) {
      aiSuggestion = await this.rangeAdvisor.getSuggestion(symbol, currentPrice);
      if (aiSuggestion && aiSuggestion.confidence < GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE) {
        console.log(
          `[GEMINI] ${symbol} suggestion confidence ${aiSuggestion.confidence} below threshold ` +
          `${GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE}; ignoring for this cycle.`
        );
        aiSuggestion = null;
      }
    }

    const fallbackLower = (resetAutoRange ? 0 : storedLower) || currentPrice * (1 - GRID_RANGE_PCT / 100);
    const fallbackUpper = (resetAutoRange ? 0 : storedUpper) || currentPrice * (1 + GRID_RANGE_PCT / 100);
    const lower = manualRange
      ? (aiSuggestion ? aiSuggestion.lower : GRID_LOWER_PRICE)
      : (aiSuggestion ? aiSuggestion.lower : fallbackLower);
    const upper = manualRange
      ? (aiSuggestion ? aiSuggestion.upper : GRID_UPPER_PRICE)
      : (aiSuggestion ? aiSuggestion.upper : fallbackUpper);
    if (lower <= 0 || upper <= 0 || lower >= upper) {
      throw new Error(`Invalid grid range. lower=${lower}, upper=${upper}`);
    }

    // Unlike a trailing shift (which is a parallel translation of the same
    // grid, handled by applyTrailingRangeShift's offset-based remap), a
    // stale-range auto-reset or GRID_RESET_RANGE_ON_START produces a
    // brand-new lower/upper with no fixed relationship to the old one. If we
    // simply swap symState.config without reconciling, any open managed
    // orders and accumulated lastBuyByLevel records stay indexed against the
    // OLD grid's level numbering while levels[] is rebuilt from the NEW
    // range — silently desyncing buy/sell pairing, P&L, and refill prices.
    // Reconcile BEFORE the new range is persisted.
    if (rangeWasReset && previousLower > 0 && previousUpper > 0 &&
        (previousLower !== lower || previousUpper !== upper)) {
      await this.remapStateAfterRangeReset(symbol, previousLower, previousUpper, lower, upper);
    }

    symState.config = {
      mode: GRID_MODE,
      count: GRID_COUNT,
      lower,
      upper,
      autoRange: !manualRange,
      orderSizeUsdt: this.getOrderSizeUsdt(),
      aiAdvisor: aiSuggestion ? {
        confidence: aiSuggestion.confidence,
        marketCondition: aiSuggestion.marketCondition,
        reasoning: aiSuggestion.reasoning,
        appliedAt: new Date().toISOString(),
      } : undefined,
    };
    if (resetAutoRange) {
      if (!this.rangeResetSymbols) this.rangeResetSymbols = new Set();
      this.rangeResetSymbols.add(symbol);
    }
    await this.state.save();
    return { lower, upper };
  }

  /**
   * Reconciles open grid order metadata and accumulated buy records when the
   * range is RESET to a brand-new lower/upper (stale-range auto-reset or
   * GRID_RESET_RANGE_ON_START), as opposed to incrementally TRAILED.
   *
   * A trailing shift is a parallel translation of the existing grid, so
   * applyTrailingRangeShift can safely fix it up with a constant level-index
   * offset. A reset has no such fixed relationship to the old grid (the new
   * lower/upper/step can be completely different), so old level indexes are
   * meaningless against the new grid. Instead we:
   *   1. Cancel any bot-managed open orders — they were placed at OLD-range
   *      prices and no longer correspond to any level on the NEW grid. Left
   *      alone, they'd sit there until GRID_CANCEL_OUT_OF_RANGE eventually
   *      catches them (if even enabled), with state.orders meanwhile
   *      pointing at stale level indexes.
   *   2. Re-map each accumulated buy record (lastBuyByLevel) from its OLD
   *      level index to whichever NEW level its actual average fill price
   *      lands closest to, merging records that collapse onto the same new
   *      level (same weighted-average merge used by applyTrailingRangeShift)
   *      so a future sell fill still finds the correct cost basis at
   *      levelIndex - 1 on the NEW grid.
   */
  async remapStateAfterRangeReset(symbol, oldLower, oldUpper, newLower, newUpper) {
    const symState = this.state.getSymbol(symbol);

    const cancelResult = await this.cancelGridOrders(symbol, 'range-reset');
    if (cancelResult.failed.length > 0) {
      const failedIds = cancelResult.failed.map(f => f.id).join(', ');
      // Do NOT abort the remap: some orders may still be live on the
      // exchange. The next reconcile cycle's getManagedOpenOrders/
      // GRID_CANCEL_OUT_OF_RANGE will catch anything left behind.
      console.warn(
        `[RANGE] ${symbol} range-reset: ${cancelResult.failed.length} cancellation(s) failed ` +
        `(ids: ${failedIds}). Proceeding with remap; stale orders will be cleaned up in the next cycle.`
      );
    }
    if (Object.keys(symState.orders).length > 0) {
      console.warn(
        `[RANGE] ${symbol} had ${Object.keys(symState.orders).length} managed order(s) after cancellation; clearing stale local metadata`
      );
      symState.orders = {};
    }

    const oldEntries = Object.entries(symState.lastBuyByLevel);
    if (oldEntries.length === 0) {
      await this.state.save();
      return;
    }

    let newLevels;
    try {
      newLevels = this.buildLevels(newLower, newUpper, symbol);
    } catch (err) {
      // New range can't even produce distinct levels for this symbol/tick
      // size — there is no sane new level to attribute old buys to. Clear
      // them rather than keep stale data that would corrupt P&L; buildRange
      // will throw separately on the next call if the range itself stays
      // invalid, which surfaces the problem to the operator.
      console.warn(
        `[RANGE] ${symbol} could not build levels for new range ${roundNumber(newLower)}-${roundNumber(newUpper)} ` +
        `during remap (${err.message}); clearing ${oldEntries.length} buy record(s) to avoid stale P&L data.`
      );
      symState.lastBuyByLevel = {};
      await this.state.save();
      return;
    }

    const remapped = {};
    for (const [oldIdx, buy] of oldEntries) {
      const fillPrice = Number(buy.price) || 0;
      if (!(fillPrice > 0)) continue;
      const newIdx = this.getLevelIndex(newLevels, fillPrice);
      const collapsed = Boolean(remapped[newIdx]);
      remapped[newIdx] = this.mergeBuyRecords(remapped[newIdx], buy, {
        aggregatedAcrossLevels: collapsed,
      });
      console.warn(
        `[RANGE] ${symbol} remapped buy record from old level ${oldIdx} (avg price ${roundNumber(fillPrice)}) ` +
        `to new level ${newIdx} after range reset ${roundNumber(oldLower)}-${roundNumber(oldUpper)} -> ` +
        `${roundNumber(newLower)}-${roundNumber(newUpper)}`
      );
    }
    symState.lastBuyByLevel = remapped;
    await this.state.save();

    console.log(
      `[RANGE] ${symbol} range reset: remapped ${oldEntries.length} buy record(s) onto new grid ` +
      `${roundNumber(newLower)}-${roundNumber(newUpper)}`
    );
    await this.sendAlert(
      `[GRID RANGE RESET] ${symbol} range changed ${roundNumber(oldLower)}-${roundNumber(oldUpper)} -> ` +
      `${roundNumber(newLower)}-${roundNumber(newUpper)}; remapped ${oldEntries.length} buy record(s)`
    );
  }

  getTrailingUpState(symbol) {
    const symState = this.state.getSymbol(symbol);
    if (!symState.trailingUp) symState.trailingUp = { shifts: 0, lastShiftAt: null };
    return symState.trailingUp;
  }

  getTrailingDownState(symbol) {
    const symState = this.state.getSymbol(symbol);
    if (!symState.trailingDown) symState.trailingDown = { shifts: 0, lastShiftAt: null };
    return symState.trailingDown;
  }

  calculateTrailingShift(currentPrice, lower, upper, direction, symbol = null) {
    let shift;
    if (GRID_MODE === 'GEOMETRIC') {
      const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
      if (!(ratio > 1)) return null;
      if (direction === 'up') {
        if (currentPrice < this.getTrailingUpTrigger(lower, upper)) return null;
        const steps = Math.max(1, Math.floor(Math.log(currentPrice / upper) / Math.log(ratio)));
        shift = {
          steps,
          lower: lower * Math.pow(ratio, steps),
          upper: upper * Math.pow(ratio, steps),
        };
      } else {
        if (currentPrice > this.getTrailingDownTrigger(lower, upper)) return null;
        const steps = Math.max(1, Math.floor(Math.log(lower / currentPrice) / Math.log(ratio)));
        shift = {
          steps,
          lower: lower / Math.pow(ratio, steps),
          upper: upper / Math.pow(ratio, steps),
        };
      }
    } else {
      const stepSize = (upper - lower) / GRID_COUNT;
      if (!(stepSize > 0)) return null;
      if (direction === 'up') {
        if (currentPrice < this.getTrailingUpTrigger(lower, upper)) return null;
        const steps = Math.max(1, Math.floor((currentPrice - upper) / stepSize));
        shift = {
          steps,
          lower: lower + stepSize * steps,
          upper: upper + stepSize * steps,
        };
      } else {
        if (currentPrice > this.getTrailingDownTrigger(lower, upper)) return null;
        const steps = Math.max(1, Math.floor((lower - currentPrice) / stepSize));
        shift = {
          steps,
          lower: lower - stepSize * steps,
          upper: upper - stepSize * steps,
        };
      }
    }
    if (!shift) return null;
    if (symbol && !this.shiftLevelsAreUsable(symbol, shift, direction)) return null;
    return shift;
  }

  // Validates that the range resulting from a trailing shift would still
  // produce distinct grid price levels once rounded to the exchange's tick
  // size, for BOTH grid modes. Previously this guard used a raw-step
  // comparison that only ran for ARITHMETIC mode (rawStep was forced to null
  // for GEOMETRIC), so a GEOMETRIC grid could trail into a collapsed range
  // undetected here and only surface later as an uncaught error thrown by
  // buildLevels()/assertLevelsAreDistinct() during the next reconcile cycle.
  // Reusing buildLevels()/assertLevelsAreDistinct() directly (instead of a
  // hand-rolled step/tick-size comparison) also makes the check exact: it
  // mirrors precisely what will happen when the new range is actually used.
  shiftLevelsAreUsable(symbol, shift, direction) {
    try {
      this.buildLevels(shift.lower, shift.upper, symbol);
      return true;
    } catch (err) {
      console.warn(
        `[TRAILING] ${symbol} skipping ${direction} shift: resulting range ` +
        `${roundNumber(shift.lower)}-${roundNumber(shift.upper)} would produce overlapping grid levels ` +
        `after rounding to exchange tick size (${err.message}). Widen the range or lower GRID_COUNT.`
      );
      return false;
    }
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
    this.shiftStoredOrderIndexes(symState, offset);

    const shiftedBuys = {};
    for (const [levelIndex, buy] of Object.entries(symState.lastBuyByLevel)) {
      shiftedBuys[Number(levelIndex) + offset] = buy;
    }
    symState.lastBuyByLevel = shiftedBuys;
  }

  shiftStoredOrderIndexes(symState, offset) {
    const shiftedOrders = {};
    for (const [orderId, order] of Object.entries(symState.orders)) {
      shiftedOrders[orderId] = {
        ...order,
        levelIndex: Number(order.levelIndex) + offset,
      };
    }
    symState.orders = shiftedOrders;
  }

  mergeBuyRecords(existing, incoming, { aggregatedAcrossLevels = false } = {}) {
    if (!existing) {
      return aggregatedAcrossLevels ? { ...incoming, aggregated: true } : { ...incoming };
    }
    const existingAmount = Number(existing.amount) || 0;
    const incomingAmount = Number(incoming.amount) || 0;
    const amount = existingAmount + incomingAmount;
    const sellableAmount = numberOrZero(existing.sellableAmount ?? existing.amount) +
      numberOrZero(incoming.sellableAmount ?? incoming.amount);
    const totalCostQuote = (Number(existing.totalCostQuote) || 0) + (Number(incoming.totalCostQuote) || 0);
    const totalFeeQuote = (Number(existing.totalFeeQuote) || 0) + (Number(incoming.totalFeeQuote) || 0);
    return {
      ...existing,
      ...incoming,
      price: amount > 0 && totalCostQuote > 0 ? totalCostQuote / amount : Number(incoming.price ?? existing.price) || 0,
      amount,
      sellableAmount,
      totalCostQuote,
      totalFeeQuote,
      at: Date.parse(incoming.at || 0) > Date.parse(existing.at || 0) ? incoming.at : existing.at,
      aggregated: aggregatedAcrossLevels || existing.aggregated === true || incoming.aggregated === true,
    };
  }

  clampBuyLevelIndex(levelIndex) {
    return Math.max(0, Math.min(GRID_COUNT - 1, Number(levelIndex)));
  }

  hasActiveOrderAtLevel(symState, side, levelIndex) {
    return Object.values(symState.orders).some(order =>
      String(order.side).toLowerCase() === side &&
      Number(order.levelIndex) === Number(levelIndex)
    );
  }

  countActiveOrders(symState, side) {
    return Object.values(symState.orders).filter(order =>
      String(order.side).toLowerCase() === side
    ).length;
  }

  getPreciseOrderNumbers(symbol, price, amount) {
    const precisePrice = this.exchange.priceToPrecision(symbol, price);
    const preciseAmount = this.exchange.amountToPrecision(symbol, amount);
    const priceNum = Number(precisePrice);
    const amountNum = Number(preciseAmount);
    return {
      precisePrice,
      preciseAmount,
      priceNum,
      amountNum,
      notional: priceNum * amountNum,
    };
  }

  async applyTrailingRangeShift(symbol, lower, upper, shift, direction) {
    const cancelResult = await this.cancelGridOrders(symbol, `trailing-${direction}`);
    if (cancelResult.failed.length > 0) {
      const failedIds = cancelResult.failed.map(f => f.id).join(', ');
      // Do NOT abort the shift: some orders may still be live on the exchange.
      // Log clearly and continue – the next reconcile cycle will detect those
      // orders via getManagedOpenOrders (they'll be in state.orders or carry a
      // parseable clientOrderId) and either cancel them (GRID_CANCEL_OUT_OF_RANGE)
      // or adopt them at the new grid level.
      console.warn(
        `[TRAILING] ${symbol} trailing-${direction} shift: ${cancelResult.failed.length} cancellation(s) failed ` +
        `(ids: ${failedIds}). Proceeding with shift; stale orders will be cleaned up in the next cycle.`
      );
    }

    const symState = this.state.getSymbol(symbol);
    const trailingState = direction === 'up'
      ? this.getTrailingUpState(symbol)
      : this.getTrailingDownState(symbol);
    const offset = direction === 'up' ? -shift.steps : shift.steps;

    const storedOrderCount = Object.keys(symState.orders).length;
    if (storedOrderCount > 0) {
      console.warn(
        `[TRAILING] ${symbol} had ${storedOrderCount} managed order(s) after cancellation; shifting local metadata`
      );
      this.shiftStoredOrderIndexes(symState, offset);
    }

    symState.config.lower = shift.lower;
    symState.config.upper = shift.upper;

    const cleanedBuys = {};
    for (const [idx, buy] of Object.entries(symState.lastBuyByLevel)) {
      const newIdx = Number(idx) + offset;
      const exitIdx = this.clampBuyLevelIndex(newIdx);
      const collapsedAcrossLevels = exitIdx !== newIdx || Boolean(cleanedBuys[exitIdx]);
      cleanedBuys[exitIdx] = this.mergeBuyRecords(cleanedBuys[exitIdx], buy, {
        aggregatedAcrossLevels: collapsedAcrossLevels,
      });
      if (exitIdx !== newIdx) {
        console.warn(
          `[TRAILING] Keeping buy at shifted level ${newIdx} as boundary buy level ${exitIdx} after ${direction} shift. ` +
          `This level's stored price is now a weighted average across collapsed levels, not a single fill price.`
        );
      }
    }
    symState.lastBuyByLevel = cleanedBuys;
    trailingState.shifts += shift.steps;
    trailingState.lastShiftAt = new Date().toISOString();
    await this.state.save();

    console.log(
      `[TRAILING ${direction.toUpperCase()}] ${symbol} shifted ${shift.steps} grid(s): ` +
      `${roundNumber(lower)}-${roundNumber(upper)} -> ${roundNumber(shift.lower)}-${roundNumber(shift.upper)}`
    );
    await this.sendAlert(
      `[GRID TRAILING ${direction.toUpperCase()}] ${symbol} shifted ${shift.steps} grid(s) to ` +
      `${roundNumber(shift.lower)}-${roundNumber(shift.upper)}`
    );

    return { lower: shift.lower, upper: shift.upper };
  }

  async maybeTrailUpRange(symbol, currentPrice, lower, upper) {
    if (!GRID_TRAILING_UP_ENABLED || hasManualGridRange()) return null;
    const trailingState = this.getTrailingUpState(symbol);
    const lastShiftAt = Date.parse(trailingState.lastShiftAt || 0);
    if (GRID_TRAILING_UP_COOLDOWN_MS > Date.now() - lastShiftAt) return null;
    const shift = this.calculateTrailingShift(currentPrice, lower, upper, 'up', symbol);
    if (!shift) return null;
    try {
      return await this.applyTrailingRangeShift(symbol, lower, upper, shift, 'up');
    } catch (err) {
      console.error(`[TRAILING] Up shift failed for ${symbol}:`, err);
      return null;
    }
  }

  async maybeTrailDownRange(symbol, currentPrice, lower, upper) {
    if (!GRID_TRAILING_DOWN_ENABLED || hasManualGridRange()) return null;
    const trailingState = this.getTrailingDownState(symbol);
    const lastShiftAt = Date.parse(trailingState.lastShiftAt || 0);
    if (GRID_TRAILING_DOWN_COOLDOWN_MS > Date.now() - lastShiftAt) return null;
    const shift = this.calculateTrailingShift(currentPrice, lower, upper, 'down', symbol);
    if (!shift) return null;
    try {
      return await this.applyTrailingRangeShift(symbol, lower, upper, shift, 'down');
    } catch (err) {
      console.error(`[TRAILING] Down shift failed for ${symbol}:`, err);
      return null;
    }
  }

  buildLevels(lower, upper, symbol = null) {
    if (GRID_COUNT < 2) throw new Error('GRID_COUNT minimal 2.');
    let levels;
    if (GRID_MODE === 'GEOMETRIC') {
      const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
      levels = Array.from({ length: GRID_COUNT + 1 }, (_, i) => lower * Math.pow(ratio, i));
      levels[0] = lower;
      levels[GRID_COUNT] = upper;
    } else {
      const step = (upper - lower) / GRID_COUNT;
      levels = Array.from({ length: GRID_COUNT + 1 }, (_, i) => lower + step * i);
      levels[0] = lower;
      levels[GRID_COUNT] = upper;
    }
    if (symbol) this.assertLevelsAreDistinct(symbol, levels, lower, upper);
    return levels;
  }

  // Guards against grid levels collapsing onto the same exchange-rounded price.
  // This can happen when the range becomes too narrow relative to GRID_COUNT —
  // e.g. after several trailing up/down shifts, or a tight AI-suggested range —
  // causing the raw step size to fall below the exchange's price tick size.
  // Two distinct level indexes mapping to the same rounded price would otherwise
  // cause duplicate orders at an identical price, and would break getLevelIndex's
  // nearest-level matching (ties silently resolve to the lower index).
  assertLevelsAreDistinct(symbol, levels, lower, upper) {
    const tickSize = this.getMarketTickSize(symbol);
    if (!(tickSize > 0)) return;
    const rounded = levels.map(level => {
      try {
        return Number(this.exchange.priceToPrecision(symbol, level));
      } catch {
        return level;
      }
    });
    const seen = new Map();
    const collisions = [];
    rounded.forEach((price, index) => {
      if (seen.has(price)) {
        collisions.push({ a: seen.get(price), b: index, price });
      } else {
        seen.set(price, index);
      }
    });
    if (collisions.length > 0) {
      const detail = collisions
        .map(c => `level ${c.a} & ${c.b} -> ${c.price}`)
        .join(', ');
      throw new Error(
        `${symbol} grid range ${roundNumber(lower, 8)}-${roundNumber(upper, 8)} with GRID_COUNT=${GRID_COUNT} ` +
        `produces overlapping price levels after rounding to exchange tick size ${tickSize} (${detail}). ` +
        `Widen the range, lower GRID_COUNT, or use GRID_MODE=GEOMETRIC for a wide range on a low-priced asset.`
      );
    }
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
    const { lower, upper } = await this.buildRange(symbol, currentPrice);
    const levels = this.buildLevels(lower, upper, symbol);
    return { ticker, currentPrice, openOrders, balance, lower, upper, levels };
  }

  async getManagedOpenOrders(symbol, openOrders) {
    const symState = this.state.getSymbol(symbol);
    const managedIds = new Set(Object.keys(symState.orders));
    const managed = [];
    for (const order of openOrders) {
      const orderId = String(order.id);
      const levelIndex = this.getBotOrderLevel(order);
      if (!managedIds.has(orderId) && levelIndex !== null) {
        await this.state.rememberOrder(symbol, order, { levelIndex });
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
    const match = this.getOrderClientId(order).match(/^grid-[a-z0-9]+-[bs]-(\d+)-/);
    return match ? Number(match[1]) : null;
  }

  makeClientOrderId(symbol, side, levelIndex) {
    const market = symbol.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return `grid-${market}-${side[0]}-${levelIndex}-${nonce}`.slice(0, 36);
  }

  async cancelGridOrders(symbol, reason) {
    const result = { cancelled: [], failed: [] };
    if (!this.exchange?.fetchOpenOrders || !this.exchange?.cancelOrder) return result;
    const openOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    const managed = await this.getManagedOpenOrders(symbol, openOrders);
    for (const order of managed) {
      try {
        await retry(() => this.exchange.cancelOrder(order.id, symbol));
        await this.state.forgetOrder(symbol, order.id);
        result.cancelled.push(String(order.id));
        console.log(`[CANCEL] ${symbol} ${order.side} ${order.id} | ${reason}`);
      } catch (err) {
        result.failed.push({ id: String(order.id), error: err });
        console.warn(`[CANCEL] Failed to cancel ${symbol} order ${order.id}: ${err.message}`);
      }
    }
    return result;
  }

  async cancelOrder(symbol, order, reason) {
    if (!this.exchange?.cancelOrder) return;
    await retry(() => this.exchange.cancelOrder(order.id, symbol));
    await this.state.forgetOrder(symbol, order.id);
    console.log(`[CANCEL] ${symbol} ${order.side} ${order.id} | ${reason}`);
  }

  async createOrderWithFallback(symbol, side, amount, price, levelIndex) {
    const clientOrderId = this.makeClientOrderId(symbol, side, levelIndex);
    const orderParams = { newClientOrderId: clientOrderId };
    if (GRID_POST_ONLY) {
      orderParams.postOnly = true;
    }
    try {
      return await this.exchange.createLimitOrder(
        symbol,
        side,
        amount,
        price,
        orderParams
      );
    } catch (err) {
      if (GRID_POST_ONLY && err.message && err.message.includes('Post only order rejected')) {
        console.warn(`[POST-ONLY] ${symbol} ${side} level=${levelIndex} retrying without post-only flag`);
        delete orderParams.postOnly;
        return await this.exchange.createLimitOrder(
          symbol,
          side,
          amount,
          price,
          orderParams
        );
      }
      throw err;
    }
  }

  async placeLimit(symbol, side, levelIndex, price, amount) {
    const pendingKey = `${symbol}|${side}|${levelIndex}`;
    if (this.pendingOrderLevels.has(pendingKey)) {
      console.warn(`[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} | placement already in progress`);
      return null;
    }

    this.pendingOrderLevels.add(pendingKey);
    try {
      const {
        precisePrice,
        preciseAmount,
        priceNum: preciseNum,
        amountNum: preciseAmountNum,
        notional,
      } = this.getPreciseOrderNumbers(symbol, price, amount);
      const priceDiffPct = Math.abs(preciseNum - Number(price)) / Number(price) * 100;
      if (priceDiffPct > GRID_PRICE_PRECISION_MAX_DEVIATION_PCT) {
        console.warn(
          `[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} price=${price} -> ${precisePrice} | precision adjustment too large (${priceDiffPct.toFixed(4)}%)`
        );
        return null;
      }

      if (side === 'sell') {
        const minCost = this.getMinCost(symbol);
        if (minCost > 0 && notional < minCost - 1e-8) {
          console.warn(`[SKIP] ${symbol} SELL level=${levelIndex} | notional ${notional.toFixed(8)} below min ${minCost}, skipping order (dust)`);
          return null;
        }
      }

      if (!(preciseAmountNum > 0) || !(preciseNum > 0)) {
        console.warn(`[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} | amount or price rounded to zero`);
        return null;
      }

      const order = await this.createOrderWithFallback(symbol, side, preciseAmount, precisePrice, levelIndex);
      await this.state.rememberOrder(symbol, order, { levelIndex });
      console.log(`[GRID] ${symbol} ${side.toUpperCase()} level=${levelIndex} amount=${preciseAmount} price=${precisePrice}${GRID_POST_ONLY ? ' (postOnly)' : ''}`);
      return order;
    } catch (err) {
      if (this.isInsufficientFundsError(err)) {
        console.warn(
          `[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} amount=${amount} price=${price} | insufficient balance`
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
    return symbol.split('/')[0].toUpperCase();
  }

  getQuoteAsset(symbol) {
    return symbol.split('/')[1].split(':')[0].toUpperCase();
  }

  getMinCost(symbol) {
    const market = this.exchange.markets[symbol];
    return Number(market?.limits?.cost?.min || 0);
  }

  // Smallest price increment the exchange will accept/round to for this symbol.
  // Used to detect when grid levels would collapse onto the same price after
  // rounding (e.g. range too narrow for GRID_COUNT, or after several trailing
  // shifts / a tight AI-suggested range).
  getMarketTickSize(symbol) {
    const market = this.exchange?.markets?.[symbol];
    const precisionPrice = market?.precision?.price;
    if (precisionPrice && precisionPrice > 0) {
      // ccxt may express price precision either as a tick size (e.g. 0.01) or
      // as a decimal-place count (e.g. 2). Treat values >= 1 as decimal places.
      return precisionPrice >= 1 ? Math.pow(10, -precisionPrice) : precisionPrice;
    }
    const minPriceLimit = Number(market?.limits?.price?.min || 0);
    return minPriceLimit > 0 ? minPriceLimit : 0.00000001;
  }

  getTradeFeeCurrency(trade) {
    return String(trade.fee?.currency || trade.info?.commissionAsset || '').toUpperCase();
  }

  getTradeFeeCost(trade) {
    return Number(trade.fee?.cost || trade.info?.commission || 0);
  }

  feeToQuote(feeCost, feeCurrency, price, baseAsset, quoteAsset) {
    if (!feeCurrency || feeCost === 0) return 0;
    if (feeCurrency === quoteAsset) return feeCost;
    if (feeCurrency === baseAsset) return feeCost * price;
    // Third-party fee token (e.g. BNB).  We cannot convert synchronously
    // without a live price – use the cached rate if available, otherwise 0.
    // Call cacheFeeTokenPrice() asynchronously to keep rates fresh.
    const cachedRate = this.feeTokenRates?.get(feeCurrency);
    if (cachedRate > 0) {
      return feeCost * cachedRate;
    }
    console.warn(
      `[FEE] Fee currency "${feeCurrency}" is neither base (${baseAsset}) nor quote ` +
      `(${quoteAsset}). No cached rate available – recording fee as 0 ${quoteAsset}. ` +
      `Rate will be fetched in the background. Consider switching Binance fee payment ` +
      `to ${quoteAsset} for accurate P&L.`
    );
    return 0;
  }

  /**
   * Fetch and cache the USDT (quote) price for a third-party fee token such
   * as BNB.  Called once per cycle before fill processing so that
   * feeToQuote() has a fresh rate to work with.
   */
  async cacheFeeTokenPrice(feeCurrency, quoteAsset) {
    if (!feeCurrency || feeCurrency === quoteAsset) return;
    if (!this.feeTokenRates) this.feeTokenRates = new Map();
    const pair = `${feeCurrency}/${quoteAsset}`;
    try {
      if (this.exchange.markets[pair]) {
        const ticker = await retry(() => this.exchange.fetchTicker(pair));
        const rate = Number(ticker?.last);
        if (rate > 0) {
          this.feeTokenRates.set(feeCurrency, rate);
        }
      }
    } catch (err) {
      console.warn(`[FEE] Could not fetch price for ${pair}: ${err.message}`);
    }
  }

  async syncManagedOrdersWithExchange(symbol, symState, openOrderIds) {
    let cleaned = 0;
    for (const orderId of Object.keys(symState.orders)) {
      if (!openOrderIds.has(orderId)) {
        delete symState.orders[orderId];
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[SYNC-STATE] ${symbol} removed ${cleaned} stale local order(s) not found on exchange`);
      await this.state.save();
    }
  }

  async handleBuyFill(symbol, levels, symState, trade, orderMeta, openOrderIds) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const levelIndex = Number(orderMeta.levelIndex);
    const feeCost = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const base = this.getBaseAsset(symbol);
    const quote = this.getQuoteAsset(symbol);
    const sellableAmount = this.amountAfterBuyFee(symbol, trade);
    const costQuote = price * amount;
    const feeQuote = this.feeToQuote(feeCost, feeCurrency, price, base, quote);

    symState.lastBuyByLevel[levelIndex] = this.mergeBuyRecords(
      symState.lastBuyByLevel[levelIndex],
      {
        price,
        amount,
        sellableAmount,
        totalCostQuote: costQuote,
        totalFeeQuote: feeQuote,
        at: trade.datetime,
      }
    );
    this.state.data.totals.filledBuys++;
    await this.state.save();
    await this.forgetOrderIfClosed(symState, trade, openOrderIds);
    await this.state.markProcessedTrade(symbol, this.getTradeId(trade));
    await this.sendAlert(`[GRID BUY] ${symbol} amount=${amount} @ ${price} | sellable=${sellableAmount} | fee=${feeQuote.toFixed(4)} ${quote}`);
    if (!GRID_REFILL_ON_FILLED || levelIndex + 1 >= levels.length) return;
    const sellLevelIndex = levelIndex + 1;
    const sellPrice = levels[sellLevelIndex];

    const totalSellable = Math.max(0, Number(symState.lastBuyByLevel[levelIndex]?.sellableAmount ?? symState.lastBuyByLevel[levelIndex]?.amount) || 0);
    if (!(totalSellable > 0)) {
      console.warn(`[SKIP] ${symbol} SELL refill level=${sellLevelIndex} | sellable amount zero after fee`);
      return;
    }

    const minCost = this.getMinCost(symbol);
    const { notional } = this.getPreciseOrderNumbers(symbol, sellPrice, totalSellable);
    if (minCost > 0 && notional < minCost - 1e-8) {
      console.warn(
        `[SKIP] ${symbol} SELL refill level=${sellLevelIndex} | notional ${notional.toFixed(8)} below min ${minCost}, keeping buy record for later retry`
      );
      return;
    }

    await this.syncManagedOrdersWithExchange(symbol, symState, openOrderIds);

    if (this.hasActiveOrderAtLevel(symState, 'sell', sellLevelIndex)) {
      const existingOrder = Object.values(symState.orders).find(o =>
        String(o.side).toLowerCase() === 'sell' && Number(o.levelIndex) === sellLevelIndex
      );
      const existingAmount = Number(existingOrder?.amount || 0);

      const { preciseAmount: preciseTotalSellable } = this.getPreciseOrderNumbers(symbol, sellPrice, totalSellable);
      const preciseTotalNum = Number(preciseTotalSellable);

      if (existingOrder && preciseTotalNum > existingAmount + 1e-8) {
        console.log(
          `[UPDATE] ${symbol} SELL level=${sellLevelIndex} | amount update ${existingAmount} -> ${preciseTotalNum} (buy accumulated)`
        );
        try {
          await this.cancelOrder(symbol, existingOrder, `sell amount update level=${sellLevelIndex}`);
          await this.placeLimit(symbol, 'sell', sellLevelIndex, sellPrice, totalSellable);
        } catch (err) {
          console.warn(`[UPDATE] ${symbol} SELL level=${sellLevelIndex} cancel+replace failed: ${err.message}`);
        }
      } else {
        console.warn(`[SKIP] ${symbol} SELL refill level=${sellLevelIndex} | sell order already active with sufficient amount`);
      }
      return;
    }

    if (this.countActiveOrders(symState, 'sell') >= GRID_MAX_ACTIVE_SELL_ORDERS) {
      console.warn(`[SKIP] ${symbol} SELL refill level=${sellLevelIndex} | active sell order limit reached`);
      return;
    }

    await this.placeLimit(symbol, 'sell', sellLevelIndex, sellPrice, totalSellable);
  }

  async handleSellFill(symbol, levels, symState, trade, orderMeta, openOrderIds) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const levelIndex = Number(orderMeta.levelIndex);
    const buyLevelIndex = levelIndex - 1;
    const buy = symState.lastBuyByLevel[buyLevelIndex];
    if (!buy) {
      console.warn(`[SELL] ${symbol} level ${levelIndex} has no corresponding buy record. Skipping profit calculation.`);
      await this.forgetOrderIfClosed(symState, trade, openOrderIds);
      await this.state.markProcessedTrade(symbol, this.getTradeId(trade));
      return;
    }

    const base = this.getBaseAsset(symbol);
    const quote = this.getQuoteAsset(symbol);
    const feeCost = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const proceedsQuote = price * amount;
    const feeQuote = this.feeToQuote(feeCost, feeCurrency, price, base, quote);
    const totalBuyAmount = buy.amount;
    const sellableAtBuy = buy.sellableAmount ?? totalBuyAmount;
    if (!(sellableAtBuy > 0)) {
      console.warn(`[SELL] ${symbol} level ${levelIndex} buy record has zero sellable amount. Skipping profit calculation.`);
      await this.forgetOrderIfClosed(symState, trade, openOrderIds);
      await this.state.markProcessedTrade(symbol, this.getTradeId(trade));
      return;
    }
    const proportion = Math.min(amount / sellableAtBuy, 1.0);
    const allocatedBuyCost = buy.totalCostQuote * proportion;
    const allocatedBuyFee = buy.totalFeeQuote * proportion;
    const profit = (proceedsQuote - feeQuote) - (allocatedBuyCost + allocatedBuyFee);

    symState.realizedGridProfit += profit;
    this.state.data.totals.realizedGridProfit += profit;
    this.state.data.totals.filledSells++;
    await this.forgetOrderIfClosed(symState, trade, openOrderIds);
    const remainingSellable = sellableAtBuy - amount;
    if (remainingSellable > 0) {
      const newProportion = remainingSellable / sellableAtBuy;
      symState.lastBuyByLevel[buyLevelIndex] = {
        ...buy,
        sellableAmount: remainingSellable,
        totalCostQuote: buy.totalCostQuote * newProportion,
        totalFeeQuote: buy.totalFeeQuote * newProportion,
        amount: (Number(buy.amount) || 0) * newProportion,
      };
    } else {
      delete symState.lastBuyByLevel[buyLevelIndex];
    }
    await this.state.save();
    await this.state.markProcessedTrade(symbol, this.getTradeId(trade));
    await this.sendAlert(`[GRID SELL] ${symbol} amount=${amount} @ ${price} | profit=${profit.toFixed(4)} ${quote} | fee=${feeQuote.toFixed(4)} ${quote}`);

    if (GRID_REFILL_ON_FILLED && levelIndex - 1 >= 0) {
      const buyPrice = levels[levelIndex - 1];
      if (this.hasActiveOrderAtLevel(symState, 'buy', levelIndex - 1)) {
        console.warn(`[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | buy order already active`);
        return;
      }
      if (this.countActiveOrders(symState, 'buy') >= GRID_MAX_ACTIVE_BUY_ORDERS) {
        console.warn(`[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | active buy order limit reached`);
        return;
      }
      let amountToBuy = this.amountForBuy(symbol, buyPrice);
      let cost = amountToBuy * buyPrice;
      if (!(amountToBuy > 0)) {
        console.warn(`[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | investment cap reached`);
        return;
      }
      const minCost = this.getMinCost(symbol);
      if (minCost > 0 && cost < minCost - 1e-8) {
        amountToBuy = minCost / buyPrice;
        cost = amountToBuy * buyPrice;
        if (cost < minCost - 1e-8) {
          console.warn(`[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | cannot meet min notional ${minCost}`);
          return;
        }
      }
      const remainingInvestmentUsdt = this.getRemainingInvestmentUsdt(symbol);
      const precise = this.getPreciseOrderNumbers(symbol, buyPrice, amountToBuy);
      if (precise.notional > remainingInvestmentUsdt + 1e-8) {
        console.warn(
          `[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | rounded cost ${precise.notional.toFixed(8)} exceeds remaining investment ${roundNumber(remainingInvestmentUsdt, 8)}`
        );
        return;
      }
      await this.placeLimit(symbol, 'buy', levelIndex - 1, buyPrice, amountToBuy);
    }
  }

  getTradeId(trade) {
    return String(trade.id || `${trade.order}-${trade.timestamp}`);
  }

  async forgetOrderIfClosed(symState, trade, openOrderIds) {
    if (!openOrderIds.has(String(trade.order))) {
      delete symState.orders[String(trade.order)];
      await this.state.save();
    }
  }

  async fetchNewTrades(symbol, symState) {
    const since = symState.lastTradeTimestamp || 0;
    let allTrades = [];
    let from = since;
    let maxIterations = 10;
    let iteration = 0;
    while (iteration < maxIterations) {
      const trades = await retry(() => this.exchange.fetchMyTrades(symbol, from, TRADE_FETCH_LIMIT));
      if (!trades.length) break;
      allTrades = allTrades.concat(trades);
      const lastTimestamp = trades[trades.length - 1].timestamp;
      if (trades.length < TRADE_FETCH_LIMIT) break;
      if (lastTimestamp === from) {
        // A full page of trades all share the same millisecond timestamp.
        // We cannot safely advance `from` to lastTimestamp+1 because there
        // may be MORE trades at this exact timestamp on the next page that
        // the exchange hasn't returned yet.  Stop here and do NOT advance
        // lastTradeTimestamp — the next cycle will re-fetch from this same
        // timestamp.  processedTrade() deduplication ensures already-seen
        // fills are skipped without re-processing.
        console.warn(
          `[TRADES] ${symbol} pagination stopped: full page (${TRADE_FETCH_LIMIT}) of trades share ` +
          `timestamp ${lastTimestamp}. Holding lastTradeTimestamp at ${from} so unseen fills ` +
          `in this timestamp bucket are picked up on the next cycle.`
        );
        // Return what we have but DO NOT update lastTradeTimestamp.
        return allTrades;
      }
      from = lastTimestamp + 1;
      iteration++;
      await sleep(200);
    }
    if (allTrades.length) {
      const maxTs = Math.max(...allTrades.map(t => t.timestamp));
      symState.lastTradeTimestamp = maxTs;
      await this.state.save();
    }
    return allTrades;
  }

  async handleFilledTrades(symbol, levels, preloadedOpenOrders = null) {
    const symState = this.state.getSymbol(symbol);
    const quoteAsset = this.getQuoteAsset(symbol);

    // Pre-warm the fee-token rate cache so feeToQuote() can convert third-party
    // fees (e.g. BNB) for any fills encountered in this cycle.
    // BNB is the only Binance platform token used for fee discounts, but we
    // also refresh any previously seen unknown token for this symbol.
    const knownFeeTokens = new Set(['BNB']);
    if (this.feeTokenRates) {
      for (const token of this.feeTokenRates.keys()) knownFeeTokens.add(token);
    }
    await Promise.all(
      [...knownFeeTokens]
        .filter(t => t !== quoteAsset && t !== this.getBaseAsset(symbol))
        .map(t => this.cacheFeeTokenPrice(t, quoteAsset))
    );

    // Reuse caller-supplied openOrders when available to avoid an extra round-trip.
    const [trades, openOrders] = await Promise.all([
      this.fetchNewTrades(symbol, symState),
      preloadedOpenOrders
        ? Promise.resolve(preloadedOpenOrders)
        : retry(() => this.exchange.fetchOpenOrders(symbol)),
    ]);
    const openOrderIds = new Set(openOrders.map(order => String(order.id)));
    for (const trade of trades.sort((a, b) => a.timestamp - b.timestamp)) {
      const id = this.getTradeId(trade);
      if (this.state.processedTrade(symbol, id)) continue;

      // Attempt to get order metadata from state, falling back to clientOrderId
      // embedded in the trade so fills are never lost across restarts.
      let orderMeta = symState.orders[String(trade.order)];
      if (!orderMeta) {
        // clientOrderId format: grid-<market>-<s|b>-<levelIndex>-<nonce>
        const clientId = String(
          trade.info?.clientOrderId ||
          trade.info?.origClientOrderId ||
          trade.clientOrderId ||
          ''
        );
        const match = clientId.match(/^grid-[a-z0-9]+-([bs])-(\d+)-/);
        if (match) {
          const side = match[1] === 'b' ? 'buy' : 'sell';
          const levelIndex = Number(match[2]);
          orderMeta = { levelIndex, side };
          console.warn(
            `[RECOVER] ${symbol} reconstructed orderMeta for trade ${id} ` +
            `from clientOrderId="${clientId}" (level=${levelIndex}, side=${side})`
          );
        } else {
          // Cannot determine which grid level this fill belongs to; skip it
          // but mark as processed so we don't retry on every cycle.
          console.warn(
            `[SKIP] ${symbol} trade ${id}: order ${trade.order} not in state and ` +
            `no parseable clientOrderId – fill cannot be attributed to a grid level`
          );
          await this.state.markProcessedTrade(symbol, id);
          continue;
        }
      }

      const side = String(trade.side).toLowerCase();
      if (side === 'buy') {
        await this.handleBuyFill(symbol, levels, symState, trade, orderMeta, openOrderIds);
      } else if (side === 'sell') {
        await this.handleSellFill(symbol, levels, symState, trade, orderMeta, openOrderIds);
      } else {
        await this.forgetOrderIfClosed(symState, trade, openOrderIds);
        await this.state.markProcessedTrade(symbol, id);
      }
    }
    await this.syncManagedOrdersWithExchange(symbol, symState, openOrderIds);
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
    const current = new Promise(resolve => { release = resolve; });
    this.symbolLocks.set(symbol, current);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.symbolLocks.get(symbol) === current) this.symbolLocks.delete(symbol);
    }
  }

  async reconcileSymbol(symbol) {
    return this.withSymbolLock(symbol, () => this.reconcileSymbolUnlocked(symbol));
  }

  async reconcileSymbolUnlocked(symbol) {
    let context = await this.fetchContext(symbol);
    let { currentPrice, balance, lower, upper, levels } = context;

    const canContinue = await this.enforceRangeExits(symbol, currentPrice);

    let trailedUp = null;
    let trailedDown = null;
    let newContext = null;
    if (canContinue) {
      trailedUp = await this.maybeTrailUpRange(symbol, currentPrice, lower, upper);
      if (trailedUp) {
        newContext = await this.fetchContext(symbol);
        newContext.trailingUpJustShifted = true;
        ({ currentPrice, balance, lower, upper, levels } = newContext);
      } else {
        trailedDown = await this.maybeTrailDownRange(symbol, currentPrice, lower, upper);
        if (trailedDown) {
          newContext = await this.fetchContext(symbol);
          newContext.trailingDownJustShifted = true;
          ({ currentPrice, balance, lower, upper, levels } = newContext);
        }
      }
    }
    const finalContext = newContext || context;
    finalContext.trailingUpJustShifted = !!trailedUp;
    finalContext.trailingDownJustShifted = !!trailedDown;

    // Always reconcile fills that already happened on the exchange, even while trading
    // is halted by stop-loss/take-profit, so profit, sellable amount, and lastBuyByLevel
    // never go unrecorded.
    // Fetch openOrders once here and pass it into handleFilledTrades so we avoid a
    // redundant exchange round-trip (handleFilledTrades previously fetched its own copy).
    let freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    await this.handleFilledTrades(symbol, levels, freshOpenOrders);

    if (!canContinue) {
      console.log(`[SYNC] ${symbol} trading halted (stop-loss/take-profit); no new orders will be placed`);
      return;
    }

    // Re-read balances and open orders after fill handling so placement loops use fresh state.
    balance = await retry(() => this.exchange.fetchBalance());
    freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    let managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);

    if (GRID_CANCEL_OUT_OF_RANGE) {
      for (const order of managedOrders) {
        const orderTimestamp = Number(order.timestamp) || Date.parse(order.datetime || 0) || 0;
        const orderAgeMs = Date.now() - orderTimestamp;
        if (orderAgeMs < GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MS) continue;
        const isValidGridOrder = this.isOrderCloseToPriceLevel(order.price, levels, this.exchange.markets[symbol]);
        if (isValidGridOrder) continue;
        if (!this.isOrderInsideRange(order, lower, upper)) {
          await this.cancelOrder(symbol, order, `outside range ${roundNumber(lower)}-${roundNumber(upper)}`);
        }
      }
      freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
      managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
    }

    const activeBuyLevels = new Set();
    const activeSellLevels = new Set();
    const symState = this.state.getSymbol(symbol);
    for (const order of managedOrders) {
      const idx = this.getLevelIndex(levels, Number(order.price));
      if (order.side === 'buy') activeBuyLevels.add(idx);
      if (order.side === 'sell') activeSellLevels.add(idx);
    }
    for (const order of Object.values(symState.orders)) {
      if (order.side === 'buy') activeBuyLevels.add(Number(order.levelIndex));
      if (order.side === 'sell') activeSellLevels.add(Number(order.levelIndex));
    }

    const below = this.getNearestLevels(levels, currentPrice, 'buy', GRID_MAX_ACTIVE_BUY_ORDERS);
    const above = this.getNearestLevels(levels, currentPrice, 'sell', GRID_MAX_ACTIVE_SELL_ORDERS);

    let quoteFree = this.getQuoteFree(balance, symbol);
    let baseFree = this.getBaseFree(balance, symbol);
    let remainingInvestmentUsdt = this.getRemainingInvestmentUsdt(symbol);

    for (const level of below) {
      if (this.countActiveOrders(symState, 'buy') >= GRID_MAX_ACTIVE_BUY_ORDERS) {
        console.warn(`[SKIP] ${symbol} BUY level=${level.index} | active buy order limit (${GRID_MAX_ACTIVE_BUY_ORDERS}) reached`);
        break;
      }
      if (activeBuyLevels.has(level.index)) continue;
      let amount = this.amountForBuy(symbol, level.price, remainingInvestmentUsdt);
      let cost = amount * level.price;
      if (!(amount > 0)) {
        console.warn(`[SKIP] ${symbol} BUY level=${level.index} | investment cap reached`);
        break;
      }

      const minCost = this.getMinCost(symbol);
      if (minCost > 0 && cost < minCost - 1e-8) {
        const requiredAmount = minCost / level.price;
        amount = this.exchange.amountToPrecision(symbol, requiredAmount);
        cost = Number(amount) * level.price;
        if (cost < minCost - 1e-8) {
          console.warn(`[SKIP] ${symbol} BUY level=${level.index} | cannot meet min notional ${minCost}`);
          break;
        }
      }

      const precise = this.getPreciseOrderNumbers(symbol, level.price, amount);
      cost = precise.notional;
      if (cost > remainingInvestmentUsdt + 1e-8) {
        console.warn(
          `[SKIP] ${symbol} BUY level=${level.index} | rounded cost ${cost.toFixed(8)} exceeds remaining investment ${roundNumber(remainingInvestmentUsdt, 8)}`
        );
        break;
      }
      if (quoteFree < cost) break;
      const order = await this.placeLimit(symbol, 'buy', level.index, level.price, amount);
      if (!order) break;
      quoteFree -= cost;
      remainingInvestmentUsdt = Math.max(0, remainingInvestmentUsdt - cost);
    }

    for (const level of above) {
      if (this.countActiveOrders(symState, 'sell') >= GRID_MAX_ACTIVE_SELL_ORDERS) {
        console.warn(`[SKIP] ${symbol} SELL level=${level.index} | active sell order limit (${GRID_MAX_ACTIVE_SELL_ORDERS}) reached`);
        break;
      }
      if (activeSellLevels.has(level.index)) continue;
      const trackedAmount = this.amountForTrackedSell(symbol, level.index);
      if (!(trackedAmount > 0)) continue;
      let amount = Math.min(trackedAmount, baseFree);
      if (!(amount > 0)) {
        console.warn(`[SKIP] ${symbol} SELL level=${level.index} | insufficient free base, checking farther sell levels`);
        continue;
      }

      const minCost = this.getMinCost(symbol);
      const notional = amount * level.price;
      if (minCost > 0 && notional < minCost - 1e-8) {
        console.warn(`[SKIP] ${symbol} SELL level=${level.index} | notional too low (dust), keeping buy record for later retry`);
        continue;
      }

      const order = await this.placeLimit(symbol, 'sell', level.index, level.price, amount);
      if (!order) continue;
      baseFree -= amount;
    }

    console.log(
      `[SYNC] ${symbol} price=${roundNumber(currentPrice)} range=${roundNumber(lower)}-${roundNumber(upper)} ` +
      `orders=${managedOrders.length} totalProfit=${roundNumber(symState.realizedGridProfit, 4)} ${this.getQuoteAsset(symbol)}`
    );
  }

  amountForTrackedSell(symbol, sellLevelIndex) {
    const symState = this.state.getSymbol(symbol);
    const buy = symState.lastBuyByLevel[sellLevelIndex - 1];
    if (!buy) return 0;
    return Math.max(0, Number(buy.sellableAmount ?? buy.amount) || 0);
  }

  getAllocatedInvestmentUsdt(symbol) {
    if (!(GRID_TOTAL_INVESTMENT_USDT > 0)) return 0;
    const symState = this.state.getSymbol(symbol);
    let allocated = 0;

    // Sum cost of all filled buys tracked in lastBuyByLevel.
    const filledLevels = new Set();
    for (const [levelIndex, buy] of Object.entries(symState.lastBuyByLevel)) {
      allocated += Number(buy.totalCostQuote) || 0;
      filledLevels.add(Number(levelIndex));
    }

    // Sum cost of open (pending) buy orders, but ONLY for levels that do NOT
    // already have a filled buy record in lastBuyByLevel.  An order that has
    // been filled but whose state entry hasn't been cleaned up yet would
    // otherwise be double-counted against the investment cap.
    for (const order of Object.values(symState.orders)) {
      if (String(order.side).toLowerCase() !== 'buy') continue;
      if (filledLevels.has(Number(order.levelIndex))) continue; // already counted via lastBuyByLevel
      allocated += (Number(order.amount) || 0) * (Number(order.price) || 0);
    }

    return allocated;
  }

  getRemainingInvestmentUsdt(symbol) {
    if (!(GRID_TOTAL_INVESTMENT_USDT > 0)) return Infinity;
    return Math.max(0, GRID_TOTAL_INVESTMENT_USDT - this.getAllocatedInvestmentUsdt(symbol));
  }

  amountForBuy(symbol, price, availableInvestmentUsdt = this.getRemainingInvestmentUsdt(symbol)) {
    const minCost = this.getMinCost(symbol);
    const targetNotional = Math.max(this.getOrderSizeUsdt(), minCost);
    const notional = Math.min(targetNotional, availableInvestmentUsdt);
    if (minCost > 0 && notional < minCost - 1e-8) {
      this.warnIfInvestmentPermanentlyStuck(symbol, availableInvestmentUsdt, minCost);
      return 0;
    }
    if (!(notional > 0)) return 0;
    return notional / price;
  }

  warnIfInvestmentPermanentlyStuck(symbol, availableInvestmentUsdt, minCost) {
    if (!(GRID_TOTAL_INVESTMENT_USDT > 0)) return;
    if (!(availableInvestmentUsdt > 0) || availableInvestmentUsdt >= minCost) return;
    if (this.stuckInvestmentWarned.has(symbol)) return;
    this.stuckInvestmentWarned.add(symbol);
    console.warn(
      `[CONFIG] ${symbol} remaining investment ${roundNumber(availableInvestmentUsdt, 8)} USDT is below the ` +
      `exchange minimum order cost ${minCost} USDT. This leftover is PERMANENTLY stuck and cannot be used for ` +
      `new buy orders until a sell adds funds back. Consider lowering GRID_COUNT, raising ` +
      `GRID_TOTAL_INVESTMENT_USDT, or accepting fewer active buy levels.`
    );
  }

  isOrderInsideRange(order, lower, upper) {
    const price = Number(order.price);
    const rangeSize = upper - lower;
    const relativeEpsilon = Math.max(rangeSize * 0.0005, price * 0.00001);
    return price >= lower - relativeEpsilon && price <= upper + relativeEpsilon;
  }

  isOrderCloseToPriceLevel(orderPrice, levels, market) {
    const price = Number(orderPrice);
    const tickSize = market?.precision?.price || 0.00001;
    for (const level of levels) {
      if (Math.abs(price - level) <= tickSize * 1.5) return true;
    }
    return false;
  }

  amountAfterBuyFee(symbol, trade) {
    const amount = Number(trade.amount);
    const feeCost = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const base = this.getBaseAsset(symbol).toUpperCase();
    let result = amount;
    if (feeCurrency === base) result = Math.max(0, amount - feeCost);
    return result;
  }

  async executeCycle() {
    if (this.isRunning) return;
    this.isRunning = true;
    let hadError = false;
    try {
      if (!this.circuitAllows() || killSwitchActive()) return;
      for (const symbol of SYMBOLS) {
        try {
          await this.reconcileSymbol(symbol);
        } catch (err) {
          hadError = true;
          console.error(`[CYCLE] Error on ${symbol}:`, err);
          this.recordError();
        }
      }
      if (!hadError) this.recordSuccess();
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
            if (response.statusCode >= 200 && response.statusCode < 300) resolve();
            else reject(new Error(`Fonnte returned HTTP ${response.statusCode}`));
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
Post Only (Maker): ${GRID_POST_ONLY ? 'ON' : 'OFF'}
Smart Range Advisor (Gemini): ${GEMINI_RANGE_ADVISOR_ENABLED
      ? `ON (model=${GEMINI_MODEL}, min-interval=${GEMINI_RANGE_ADVISOR_MIN_INTERVAL_MS / MINUTE_MS}m, web-search=${GEMINI_RANGE_ADVISOR_USE_WEB_SEARCH ? 'ON' : 'OFF'}, min-range-width=${GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT}%, applies-to=${GEMINI_RANGE_ADVISOR_APPLY_ON})`
      : 'OFF'}
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

  // Remove any *.tmp files left behind by a previous crashed process before
  // acquiring the lock so they don't interfere with new atomic writes.
  await AtomicFileWriter.cleanupStaleTempFiles(GRID_STATE_PATH);

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
  Config,
  GridState,
  ProcessLock,
  SpotGridEngine,
  GeminiRangeAdvisor,
  AIGridValidator,
  TechnicalIndicators,
  bootstrap,
  validateRuntimeConfiguration,
};
