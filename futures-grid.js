require('dotenv').config();
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { FibonacciRangeAdvisor } = require('./src/fibonacci-range-advisor');
const {
  FibonacciDirectionAnalyzer,
  resolveAppliedDirection,
} = require('./src/fibonacci-direction-analyzer');
const {
  PROFILES,
  RISK_STATES,
  AdaptiveGridSupervisor,
  buildAdaptiveBuyPlan,
  recommendationFor,
  recommendationForRiskState,
} = require('./src/adaptive-grid-supervisor');
const { AdaptiveSupervisorOutcomeJournal } = require('./src/adaptive-supervisor-outcome-journal');
const { BinanceFuturesUserStream } = require('./src/binance-futures-user-stream');
const { startFuturesDashboardServer } = require('./src/futures-dashboard-server');
const {
  deferUnreconciledSell,
  remapDelayedSellOrderMeta,
  retryUnreconciledSells,
} = require('./src/unreconciled-fills');
const { syncIncome, incomeMetrics } = require('./src/futures-income');
const { exposureBySymbol } = require('./src/futures-exposure');
const { displayNumber, signedUsdt, sellOverview, sellFillMessage } = require('./src/futures-display');
const { CrossProcessMutex } = require('./src/cross-process-mutex');
const {
  VolumeDeltaAnalyzer,
  evaluateVolumeDeltaEntry,
} = require('./src/volume-delta-analyzer');
const futuresTelegramCommandPath = path.resolve(process.cwd(), 'futures-telegram-command.json');

// Tracks, per async call chain, which symbols' locks are currently held by
// an ancestor call. Used by withSymbolLock() to detect true re-entrancy
// (a lock holder calling back into withSymbolLock for the same symbol from
// within its own execution) and fail fast instead of deadlocking. This is
// distinct from ordinary queueing, where a second *unrelated* call for the
// same symbol arrives while the first is still running — that call has no
// entry in this store (it didn't descend from the holder's call chain) and
// is legitimately queued via the promise chain instead.
const symbolLockContext = new AsyncLocalStorage();

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
    const value = process.env[key];
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed)) {
      throw new Error(`${key} must be a numeric value`);
    }
    return parsed;
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
const SYMBOLS = Config.list('SYMBOLS', 'BTC/USDT:USDT');
const EXCHANGE_MODE = (() => {
  const mode = Config.get('EXCHANGE_MODE', 'testnet').toLowerCase();
  if (mode === 'demo') return 'testnet';
  return mode;
})();
const VALID_EXCHANGE_MODES = new Set(['live', 'testnet']);
const VALID_GRID_MODES = new Set(['ARITHMETIC', 'GEOMETRIC']);
const MINUTE_MS = 60 * 1000;

// ------------------------------
//  Futures-specific Configuration
// ------------------------------
// USD-M perpetual futures (linear, USDT-margined) via ccxt's binanceusdm.
// SYMBOLS should use ccxt's unified futures symbol format, e.g. "BTC/USDT:USDT".
// Binance references:
// https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order
// https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information
const LEVERAGE = Config.number('LEVERAGE', 5);
const VALID_MARGIN_MODES = new Set(['ISOLATED', 'CROSSED']);
const MARGIN_MODE = Config.get('MARGIN_MODE', 'ISOLATED').toUpperCase();
// Each process owns exactly one Hedge Mode side. Running LONG and SHORT as
// separate processes keeps their state, locks, and order reconciliation
// isolated while Binance keeps both positions open on the same symbol.
const POSITION_SIDE = Config.get('FUTURES_POSITION_SIDE', 'LONG').toUpperCase();
const ENTRY_SIDE = POSITION_SIDE === 'SHORT' ? 'sell' : 'buy';
const EXIT_SIDE = POSITION_SIDE === 'SHORT' ? 'buy' : 'sell';
const ORDER_ID_PREFIX = POSITION_SIDE === 'SHORT' ? 'sgrid' : 'grid';
const FUTURES_SHORT_ENTRY_DIRECTION = Config.get(
  'FUTURES_SHORT_ENTRY_DIRECTION', 'BEARISH'
).toUpperCase();
const FUTURES_MUTUAL_EXCLUSION_ENABLED = Config.boolean('FUTURES_MUTUAL_EXCLUSION_ENABLED', false);
const FUTURES_MUTUAL_ENTRY_LOCK_PATH = path.resolve(
  process.cwd(), Config.get('FUTURES_MUTUAL_ENTRY_LOCK_FILE', 'futures-mutual-entry')
);
const FUTURES_MUTUAL_ENTRY_LOCK_TIMEOUT_MS = Math.max(
  Config.number('FUTURES_MUTUAL_ENTRY_LOCK_TIMEOUT_MS', 30000), 1
);
const VOLUME_DELTA_ENTRY_FILTER_ENABLED = Config.boolean('VOLUME_DELTA_ENTRY_FILTER_ENABLED', false);
const VOLUME_DELTA_ENTRY_FILTER_MODE = Config.get('VOLUME_DELTA_ENTRY_FILTER_MODE', 'SHADOW').toUpperCase();
const VOLUME_DELTA_LOOKBACK_CANDLES = Math.max(
  1, Math.floor(Config.number('VOLUME_DELTA_LOOKBACK_CANDLES', 4))
);
const VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT = Math.max(
  0, Config.number('VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT', 5)
);
const VOLUME_DELTA_FAIL_CLOSED = Config.boolean('VOLUME_DELTA_FAIL_CLOSED', false);
const INTERVAL_MINUTES = Config.number('INTERVAL_MINUTES', 1);
const INTERVAL_MS = INTERVAL_MINUTES * MINUTE_MS;
const FUTURES_USER_STREAM_ENABLED = Config.boolean('FUTURES_USER_STREAM_ENABLED', true);
const FUTURES_USER_STREAM_RECONCILE_DEBOUNCE_MS = Math.max(
  Config.number('FUTURES_USER_STREAM_RECONCILE_DEBOUNCE_MS', 750), 0
);
const FUTURES_USER_STREAM_KEEPALIVE_MS = Math.max(
  Config.number('FUTURES_USER_STREAM_KEEPALIVE_MINUTES', 45), 1
) * MINUTE_MS;
const FUTURES_USER_STREAM_RECONNECT_MAX_MS = Math.max(
  Config.number('FUTURES_USER_STREAM_RECONNECT_MAX_SECONDS', 30), 1
) * 1000;
const FUTURES_USER_STREAM_WS_URL = Config.get(
  'FUTURES_USER_STREAM_WS_URL',
  EXCHANGE_MODE === 'testnet'
    ? 'wss://demo-fstream.binance.com/ws'
    : 'wss://fstream.binance.com/ws'
);
const TELEGRAM_COMMAND_POLL_INTERVAL_MS = Math.max(
  Config.number('FUTURES_TELEGRAM_COMMAND_POLL_INTERVAL_SECONDS', 2),
  1
) * 1000;
const FUNDING_SYNC_INTERVAL_MS = Math.max(Config.number('FUNDING_SYNC_INTERVAL_MINUTES', 60), 1) * MINUTE_MS;

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
const FUTURES_MAX_SYMBOL_EXPOSURE_USDT = Config.number('FUTURES_MAX_SYMBOL_EXPOSURE_USDT', GRID_TOTAL_INVESTMENT_USDT || GRID_ORDER_SIZE_USDT * GRID_COUNT);
const FUTURES_MAX_TOTAL_EXPOSURE_USDT = Config.number('FUTURES_MAX_TOTAL_EXPOSURE_USDT', FUTURES_MAX_SYMBOL_EXPOSURE_USDT * SYMBOLS.length);
const GRID_MAX_ACTIVE_BUY_ORDERS = Config.number('GRID_MAX_ACTIVE_BUY_ORDERS', 5);
const GRID_MAX_ACTIVE_SELL_ORDERS = Config.number('GRID_MAX_ACTIVE_SELL_ORDERS', 5);
const GRID_RECREATE_ON_START = Config.boolean('GRID_RECREATE_ON_START', false);
const GRID_CANCEL_OUT_OF_RANGE = Config.boolean('GRID_CANCEL_OUT_OF_RANGE', true);
const GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MS = Math.max(
  Config.number('GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MINUTES', Math.max(INTERVAL_MINUTES * 3, 2)),
  0
) * MINUTE_MS;
const GRID_REFILL_ON_FILLED = Config.boolean('GRID_REFILL_ON_FILLED', true);
const GRID_MAX_REFILLS = Config.number('GRID_MAX_REFILLS', 2);
const GRID_AGGREGATED_EXIT_LADDER_ENABLED = Config.boolean('GRID_AGGREGATED_EXIT_LADDER_ENABLED', false);
const GRID_AGGREGATED_EXIT_LADDER_MAX_ORDERS = Config.number('GRID_AGGREGATED_EXIT_LADDER_MAX_ORDERS', 7);
const GRID_AGGREGATED_EXIT_LADDER_SYMBOLS = Config.list('GRID_AGGREGATED_EXIT_LADDER_SYMBOLS', '');
const GRID_STATE_FILE = Config.get('GRID_STATE_FILE', 'grid-state-futures.json');
const GRID_STATE_PATH = path.resolve(process.cwd(), GRID_STATE_FILE);
const BOT_LOCK_FILE = Config.get('BOT_LOCK_FILE', `${GRID_STATE_FILE}.lock`);
const BOT_LOCK_PATH = path.resolve(process.cwd(), BOT_LOCK_FILE);
const BOT_LOCK_STALE_GRACE_MS = Math.max(Config.number('BOT_LOCK_STALE_GRACE_MS', 2000), 0);
const GRID_POST_ONLY = Config.boolean('GRID_POST_ONLY', true);
const GRID_PRICE_PRECISION_MAX_DEVIATION_PCT = Config.number('GRID_PRICE_PRECISION_MAX_DEVIATION_PCT', 0.05);
// Futures maker fee is charged on both entry and exit. Keep the spacing guard
// configurable so it can match the account's Binance VIP/BNB fee tier.
const BINANCE_FUTURES_MAKER_FEE_RATE = Config.number('BINANCE_FUTURES_MAKER_FEE_RATE', 0.0002);
const GRID_MIN_NET_PROFIT_PCT = Config.number('GRID_MIN_NET_PROFIT_PCT', 0.05);
const FUTURES_SELL_ENTRY_FLOOR_ENABLED = Config.boolean('FUTURES_SELL_ENTRY_FLOOR_ENABLED', true);

const FIBONACCI_RANGE_ADVISOR_ENABLED = Config.boolean('FIBONACCI_RANGE_ADVISOR_ENABLED', false);
const FIBONACCI_RANGE_ADVISOR_TIMEFRAMES = Config.list('FIBONACCI_RANGE_ADVISOR_TIMEFRAMES', 'all');
const FIBONACCI_RANGE_ADVISOR_RATIOS = Config.list(
  'FIBONACCI_RANGE_ADVISOR_RATIOS',
  '0,0.236,0.382,0.5,0.618,0.786,1,1.272,1.618,2,2.618'
).map(Number);
const FIBONACCI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS = Math.max(
  Config.number('FIBONACCI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_SECONDS', 5), 0
) * 1000;
const FIBONACCI_RANGE_ADVISOR_CLUSTER_TOLERANCE_PCT = Config.number('FIBONACCI_RANGE_ADVISOR_CLUSTER_TOLERANCE_PCT', 0.15);
const FIBONACCI_RANGE_ADVISOR_MIN_CLUSTER_SCORE = Config.number('FIBONACCI_RANGE_ADVISOR_MIN_CLUSTER_SCORE', 1);
const FIBONACCI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT = Config.number('FIBONACCI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT', 6);
const FIBONACCI_RANGE_ADVISOR_MAX_DISTANCE_PCT = Config.number('FIBONACCI_RANGE_ADVISOR_MAX_DISTANCE_PCT', 25);
const FIBONACCI_RANGE_ADVISOR_REBUILD_THRESHOLD_PCT = Config.number('FIBONACCI_RANGE_ADVISOR_REBUILD_THRESHOLD_PCT', 0.5);
const FIBONACCI_RANGE_ADVISOR_REBUILD_COOLDOWN_MS = Math.max(
  Config.number('FIBONACCI_RANGE_ADVISOR_REBUILD_COOLDOWN_MINUTES', 15), 0
) * MINUTE_MS;
const FIBONACCI_RANGE_ADVISOR_APPLY_ON = Config.get('FIBONACCI_RANGE_ADVISOR_APPLY_ON', 'AUTO_RANGE_ONLY').toUpperCase();
const FIBONACCI_RANGE_ADVISOR_ALLOW_TRAILING = Config.boolean('FIBONACCI_RANGE_ADVISOR_ALLOW_TRAILING', false);
const FIBONACCI_RANGE_ADVISOR_STATE_FILE = Config.get('FIBONACCI_RANGE_ADVISOR_STATE_FILE', 'fibonacci-range-advisor-futures.json');
const FIBONACCI_RANGE_ADVISOR_STATE_PATH = path.resolve(process.cwd(), FIBONACCI_RANGE_ADVISOR_STATE_FILE);

// Deterministic direction classifier for Futures. It never places/closes an
// order itself; LEVEL_BIAS mode only changes how many selected Fibonacci
// confluence levels sit below versus above current price. REPORT_ONLY is inert.
const FIBONACCI_DIRECTION_ANALYZER_ENABLED = Config.boolean('FIBONACCI_DIRECTION_ANALYZER_ENABLED', false);
const FIBONACCI_DIRECTION_TIMEFRAMES = Config.list('FIBONACCI_DIRECTION_TIMEFRAMES', '15m,1h,4h');
const FIBONACCI_DIRECTION_CANDLE_LIMIT = Config.number('FIBONACCI_DIRECTION_CANDLE_LIMIT', 100);
const FIBONACCI_DIRECTION_PIVOT_LOOKBACK = Config.number('FIBONACCI_DIRECTION_PIVOT_LOOKBACK', 2);
const FIBONACCI_DIRECTION_MIN_TIMEFRAMES = Config.number('FIBONACCI_DIRECTION_MIN_TIMEFRAMES', 2);
const FIBONACCI_DIRECTION_CONFIRMATIONS = Config.number('FIBONACCI_DIRECTION_CONFIRMATIONS', 2);
const FIBONACCI_DIRECTION_MIN_CONFIDENCE = Config.number('FIBONACCI_DIRECTION_MIN_CONFIDENCE', 0.65);
const FIBONACCI_DIRECTION_LEVEL_BIAS_PCT = Config.number('FIBONACCI_DIRECTION_LEVEL_BIAS_PCT', 10);
const FIBONACCI_DIRECTION_APPLY_MODE = Config.get('FIBONACCI_DIRECTION_APPLY_MODE', 'REPORT_ONLY').toUpperCase();
const FIBONACCI_DIRECTION_STRATEGY = Config.get('FIBONACCI_DIRECTION_STRATEGY', 'TREND').toUpperCase();
const FIBONACCI_DIRECTION_EMA_SLOPE_ATR_THRESHOLD = Config.number(
  'FIBONACCI_DIRECTION_EMA_SLOPE_ATR_THRESHOLD', 1
);

// SHADOW only records decisions. LIVE applies them to future BUY placement;
// existing inventory and every SELL exit remain under the normal grid rules.
const ADAPTIVE_GRID_SUPERVISOR_ENABLED = Config.boolean('ADAPTIVE_GRID_SUPERVISOR_ENABLED', false);
const ADAPTIVE_GRID_SUPERVISOR_MODE = Config.get('ADAPTIVE_GRID_SUPERVISOR_MODE', 'SHADOW').toUpperCase();
const ADAPTIVE_GRID_SUPERVISOR_PROFILE_CONFIRMATIONS = Config.number(
  'ADAPTIVE_GRID_SUPERVISOR_PROFILE_CONFIRMATIONS', 3
);
const ADAPTIVE_GRID_SUPERVISOR_COOLDOWN_MS = Math.max(
  Config.number('ADAPTIVE_GRID_SUPERVISOR_COOLDOWN_MINUTES', 120), 0
) * MINUTE_MS;
const ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT = Config.number(
  'ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT', 90
);
const ADAPTIVE_GRID_SUPERVISOR_LOG_PATH = path.resolve(
  process.cwd(), Config.get('ADAPTIVE_GRID_SUPERVISOR_LOG_FILE', 'adaptive-grid-shadow.jsonl')
);
const ADAPTIVE_RISK_STATE_MACHINE_ENABLED = Config.boolean('ADAPTIVE_RISK_STATE_MACHINE_ENABLED', false);
const ADAPTIVE_RISK_STATE_MACHINE_MODE = Config.get('ADAPTIVE_RISK_STATE_MACHINE_MODE', 'SHADOW').toUpperCase();
const ADAPTIVE_RISK_STATE_MACHINE_CAUTION_EXPOSURE_PCT = Config.number(
  'ADAPTIVE_RISK_STATE_MACHINE_CAUTION_EXPOSURE_PCT', 75
);
const ADAPTIVE_RISK_STATE_MACHINE_RISK_EXPOSURE_PCT = Config.number(
  'ADAPTIVE_RISK_STATE_MACHINE_RISK_EXPOSURE_PCT', 90
);
const ADAPTIVE_RISK_STATE_MACHINE_LOSS_WARNING_PCT = Config.number(
  'ADAPTIVE_RISK_STATE_MACHINE_LOSS_WARNING_PCT', 5
);
const ADAPTIVE_RISK_STATE_MACHINE_LOSS_RISK_OFF_PCT = Config.number(
  'ADAPTIVE_RISK_STATE_MACHINE_LOSS_RISK_OFF_PCT', 10
);
const ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_WARNING_PCT = Config.number(
  'ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_WARNING_PCT', 12
);
const ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_CRITICAL_PCT = Config.number(
  'ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_CRITICAL_PCT', 8
);
const ADAPTIVE_RISK_STATE_MACHINE_CAUTION_CONFIRMATIONS = Config.number(
  'ADAPTIVE_RISK_STATE_MACHINE_CAUTION_CONFIRMATIONS', 2
);
const ADAPTIVE_RISK_STATE_MACHINE_RECOVERY_CONFIRMATIONS = Config.number(
  'ADAPTIVE_RISK_STATE_MACHINE_RECOVERY_CONFIRMATIONS', 3
);
const ADAPTIVE_RISK_STATE_MACHINE_MARGIN_CALL_HOLD_MS = Math.max(
  Config.number('ADAPTIVE_RISK_STATE_MACHINE_MARGIN_CALL_HOLD_MINUTES', 60), 1
) * MINUTE_MS;

const ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_ENABLED = Config.boolean(
  'ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_ENABLED', false
);
const ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_MODE = Config.get(
  'ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_MODE', 'SHADOW'
).toUpperCase();
const ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_LOG_FILE = Config.get(
  'ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_LOG_FILE', 'adaptive-supervisor-outcomes.jsonl'
);
const ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_STATE_FILE = Config.get(
  'ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_STATE_FILE', 'adaptive-supervisor-outcomes-state.json'
);
// In the futures bot these legacy variable names represent position ROI
// percentages, not market prices. Zero disables the corresponding exit.
const STOP_LOSS_ROI_PCT = Config.number('GRID_STOP_LOSS_PRICE', -100);
const TAKE_PROFIT_ROI_PCT = Config.number('GRID_TAKE_PROFIT_PRICE', 100);
const KILL_SWITCH_ENABLED = Config.boolean('KILL_SWITCH_ENABLED', false);
const STOP_TRADING = Config.isTrue('STOP_TRADING');
const KILL_SWITCH_FILE = Config.get('KILL_SWITCH_FILE', 'bot-paused.flag');
const KILL_SWITCH_PATH = path.resolve(process.cwd(), KILL_SWITCH_FILE);

const TELEGRAM_ENABLED = Config.boolean('TELEGRAM_ENABLED', false);
const TELEGRAM_BOT_TOKEN = Config.get('TELEGRAM_BOT_TOKEN', '');
const TELEGRAM_CHAT_ID = Config.get('TELEGRAM_CHAT_ID', '');
const TELEGRAM_API_URL = Config.get('TELEGRAM_API_URL', 'https://api.telegram.org');
const TELEGRAM_TIMEOUT_MS = Config.number('TELEGRAM_TIMEOUT_MS', 10_000);
const FUTURES_TELEGRAM_COMMAND_PROCESSING_ENABLED = Config.boolean(
  'FUTURES_TELEGRAM_COMMAND_PROCESSING_ENABLED', POSITION_SIDE === 'LONG'
);

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

function tradeFetchResult(trades, holdWatermark = false) {
  return { trades, holdWatermark };
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
  requirePositive('FUTURES_MAX_SYMBOL_EXPOSURE_USDT', FUTURES_MAX_SYMBOL_EXPOSURE_USDT);
  requirePositive('FUTURES_MAX_TOTAL_EXPOSURE_USDT', FUTURES_MAX_TOTAL_EXPOSURE_USDT);
  requirePositive(
    GRID_TOTAL_INVESTMENT_USDT > 0 ? 'GRID_TOTAL_INVESTMENT_USDT' : 'GRID_ORDER_SIZE_USDT',
    GRID_TOTAL_INVESTMENT_USDT > 0 ? GRID_TOTAL_INVESTMENT_USDT : GRID_ORDER_SIZE_USDT
  );
  requireInteger('GRID_MAX_ACTIVE_BUY_ORDERS', GRID_MAX_ACTIVE_BUY_ORDERS);
  requireInteger('GRID_MAX_ACTIVE_SELL_ORDERS', GRID_MAX_ACTIVE_SELL_ORDERS);
  requireInteger('GRID_MAX_REFILLS', GRID_MAX_REFILLS, 0);
  requireInteger('GRID_AGGREGATED_EXIT_LADDER_MAX_ORDERS', GRID_AGGREGATED_EXIT_LADDER_MAX_ORDERS, 2);
  requireNonNegative('BOT_LOCK_STALE_GRACE_MS', BOT_LOCK_STALE_GRACE_MS);
  requireNonNegative('FUTURES_USER_STREAM_RECONCILE_DEBOUNCE_MS', FUTURES_USER_STREAM_RECONCILE_DEBOUNCE_MS);
  requirePositive('FUTURES_USER_STREAM_KEEPALIVE_MINUTES', FUTURES_USER_STREAM_KEEPALIVE_MS);
  requirePositive('FUTURES_USER_STREAM_RECONNECT_MAX_SECONDS', FUTURES_USER_STREAM_RECONNECT_MAX_MS);
  requirePositive('TELEGRAM_TIMEOUT_MS', TELEGRAM_TIMEOUT_MS);
  requirePositive('LEVERAGE', LEVERAGE);
  requireNonNegative('BINANCE_FUTURES_MAKER_FEE_RATE', BINANCE_FUTURES_MAKER_FEE_RATE);
  requireNonNegative('GRID_MIN_NET_PROFIT_PCT', GRID_MIN_NET_PROFIT_PCT);
  if (FIBONACCI_DIRECTION_ANALYZER_ENABLED && !FIBONACCI_RANGE_ADVISOR_ENABLED) {
    errors.push('FIBONACCI_DIRECTION_ANALYZER_ENABLED requires FIBONACCI_RANGE_ADVISOR_ENABLED=true');
  }
  if (ADAPTIVE_GRID_SUPERVISOR_ENABLED) {
    if (!FIBONACCI_DIRECTION_ANALYZER_ENABLED) {
      errors.push('ADAPTIVE_GRID_SUPERVISOR_ENABLED requires FIBONACCI_DIRECTION_ANALYZER_ENABLED=true');
    }
    if (!['SHADOW', 'LIVE'].includes(ADAPTIVE_GRID_SUPERVISOR_MODE)) {
      errors.push('ADAPTIVE_GRID_SUPERVISOR_MODE must be SHADOW or LIVE');
    }
    if (ADAPTIVE_GRID_SUPERVISOR_MODE === 'LIVE' && !(GRID_TOTAL_INVESTMENT_USDT > 0)) {
      errors.push('ADAPTIVE_GRID_SUPERVISOR_MODE=LIVE requires GRID_TOTAL_INVESTMENT_USDT greater than 0');
    }
    requireInteger(
      'ADAPTIVE_GRID_SUPERVISOR_PROFILE_CONFIRMATIONS',
      ADAPTIVE_GRID_SUPERVISOR_PROFILE_CONFIRMATIONS,
      1
    );
    if (!(ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT > 0 &&
        ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT <= 100)) {
      errors.push('ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT must be greater than 0 and at most 100');
    }
  }
  if (ADAPTIVE_RISK_STATE_MACHINE_ENABLED) {
    if (!ADAPTIVE_GRID_SUPERVISOR_ENABLED) {
      errors.push('ADAPTIVE_RISK_STATE_MACHINE_ENABLED requires ADAPTIVE_GRID_SUPERVISOR_ENABLED=true');
    }
    if (!['SHADOW', 'LIVE'].includes(ADAPTIVE_RISK_STATE_MACHINE_MODE)) {
      errors.push('ADAPTIVE_RISK_STATE_MACHINE_MODE must be SHADOW or LIVE');
    }
    if (ADAPTIVE_RISK_STATE_MACHINE_MODE === 'LIVE' && ADAPTIVE_GRID_SUPERVISOR_MODE !== 'LIVE') {
      errors.push('ADAPTIVE_RISK_STATE_MACHINE_MODE=LIVE requires ADAPTIVE_GRID_SUPERVISOR_MODE=LIVE');
    }
    if (!(ADAPTIVE_RISK_STATE_MACHINE_CAUTION_EXPOSURE_PCT > 0 &&
        ADAPTIVE_RISK_STATE_MACHINE_CAUTION_EXPOSURE_PCT <= 100)) {
      errors.push('ADAPTIVE_RISK_STATE_MACHINE_CAUTION_EXPOSURE_PCT must be greater than 0 and at most 100');
    }
    if (!(ADAPTIVE_RISK_STATE_MACHINE_RISK_EXPOSURE_PCT >= ADAPTIVE_RISK_STATE_MACHINE_CAUTION_EXPOSURE_PCT &&
        ADAPTIVE_RISK_STATE_MACHINE_RISK_EXPOSURE_PCT <= 100)) {
      errors.push('ADAPTIVE_RISK_STATE_MACHINE_RISK_EXPOSURE_PCT must be at least the caution threshold and at most 100');
    }
    requirePositive('ADAPTIVE_RISK_STATE_MACHINE_LOSS_WARNING_PCT', ADAPTIVE_RISK_STATE_MACHINE_LOSS_WARNING_PCT);
    if (!(ADAPTIVE_RISK_STATE_MACHINE_LOSS_RISK_OFF_PCT > ADAPTIVE_RISK_STATE_MACHINE_LOSS_WARNING_PCT)) {
      errors.push('ADAPTIVE_RISK_STATE_MACHINE_LOSS_RISK_OFF_PCT must exceed the loss warning threshold');
    }
    requirePositive(
      'ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_CRITICAL_PCT',
      ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_CRITICAL_PCT
    );
    if (!(ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_WARNING_PCT >
        ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_CRITICAL_PCT)) {
      errors.push('ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_WARNING_PCT must exceed the critical threshold');
    }
    requireInteger(
      'ADAPTIVE_RISK_STATE_MACHINE_CAUTION_CONFIRMATIONS',
      ADAPTIVE_RISK_STATE_MACHINE_CAUTION_CONFIRMATIONS,
      1
    );
    requireInteger(
      'ADAPTIVE_RISK_STATE_MACHINE_RECOVERY_CONFIRMATIONS',
      ADAPTIVE_RISK_STATE_MACHINE_RECOVERY_CONFIRMATIONS,
      1
    );
    requirePositive(
      'ADAPTIVE_RISK_STATE_MACHINE_MARGIN_CALL_HOLD_MINUTES',
      ADAPTIVE_RISK_STATE_MACHINE_MARGIN_CALL_HOLD_MS
    );
  }
  if (FIBONACCI_RANGE_ADVISOR_ENABLED) {
    if (!FIBONACCI_RANGE_ADVISOR_TIMEFRAMES.length) errors.push('FIBONACCI_RANGE_ADVISOR_TIMEFRAMES must not be empty');
    if (!FIBONACCI_RANGE_ADVISOR_RATIOS.length ||
        FIBONACCI_RANGE_ADVISOR_RATIOS.some(value => !Number.isFinite(value) || value < 0)) {
      errors.push('FIBONACCI_RANGE_ADVISOR_RATIOS must contain non-negative numbers');
    }
    if (!['AUTO_RANGE_ONLY', 'ALWAYS'].includes(FIBONACCI_RANGE_ADVISOR_APPLY_ON)) {
      errors.push('FIBONACCI_RANGE_ADVISOR_APPLY_ON must be AUTO_RANGE_ONLY or ALWAYS');
    }
    if (FIBONACCI_DIRECTION_ANALYZER_ENABLED) {
      if (!FIBONACCI_DIRECTION_TIMEFRAMES.length) errors.push('FIBONACCI_DIRECTION_TIMEFRAMES must not be empty');
      requireInteger('FIBONACCI_DIRECTION_CANDLE_LIMIT', FIBONACCI_DIRECTION_CANDLE_LIMIT, 55);
      requireInteger('FIBONACCI_DIRECTION_PIVOT_LOOKBACK', FIBONACCI_DIRECTION_PIVOT_LOOKBACK, 1);
      requireInteger('FIBONACCI_DIRECTION_MIN_TIMEFRAMES', FIBONACCI_DIRECTION_MIN_TIMEFRAMES, 1);
      requireInteger('FIBONACCI_DIRECTION_CONFIRMATIONS', FIBONACCI_DIRECTION_CONFIRMATIONS, 1);
      if (!(FIBONACCI_DIRECTION_MIN_CONFIDENCE >= 0 && FIBONACCI_DIRECTION_MIN_CONFIDENCE <= 1)) {
        errors.push('FIBONACCI_DIRECTION_MIN_CONFIDENCE must be between 0 and 1');
      }
      if (!(FIBONACCI_DIRECTION_LEVEL_BIAS_PCT >= 0 && FIBONACCI_DIRECTION_LEVEL_BIAS_PCT <= 40)) {
        errors.push('FIBONACCI_DIRECTION_LEVEL_BIAS_PCT must be between 0 and 40');
      }
      if (!['REPORT_ONLY', 'LEVEL_BIAS'].includes(FIBONACCI_DIRECTION_APPLY_MODE)) {
        errors.push('FIBONACCI_DIRECTION_APPLY_MODE must be REPORT_ONLY or LEVEL_BIAS');
      }
      if (!['TREND', 'EMA_SLOPE_MEAN_REVERSION'].includes(FIBONACCI_DIRECTION_STRATEGY)) {
        errors.push('FIBONACCI_DIRECTION_STRATEGY must be TREND or EMA_SLOPE_MEAN_REVERSION');
      }
      if (!(FIBONACCI_DIRECTION_EMA_SLOPE_ATR_THRESHOLD > 0)) {
        errors.push('FIBONACCI_DIRECTION_EMA_SLOPE_ATR_THRESHOLD must be greater than 0');
      }
    }
  }
  if (STOP_LOSS_ROI_PCT > 0) errors.push('GRID_STOP_LOSS_PRICE must be negative or 0 for futures ROI');
  if (TAKE_PROFIT_ROI_PCT < 0) errors.push('GRID_TAKE_PROFIT_PRICE must be positive or 0 for futures ROI');
  if (!Number.isInteger(LEVERAGE)) errors.push('LEVERAGE must be an integer');
  if (LEVERAGE > 125) errors.push('LEVERAGE must not exceed Binance USD-M maximum of 125');
  if (!VALID_MARGIN_MODES.has(MARGIN_MODE)) {
    errors.push(`MARGIN_MODE must be one of: ${[...VALID_MARGIN_MODES].join(', ')}`);
  }
  if (!['LONG', 'SHORT'].includes(POSITION_SIDE)) {
    errors.push('FUTURES_POSITION_SIDE must be LONG or SHORT');
  }
  if (!['ALWAYS', 'BEARISH'].includes(FUTURES_SHORT_ENTRY_DIRECTION)) {
    errors.push('FUTURES_SHORT_ENTRY_DIRECTION must be ALWAYS or BEARISH');
  }
  if (!['SHADOW', 'LIVE'].includes(VOLUME_DELTA_ENTRY_FILTER_MODE)) {
    errors.push('VOLUME_DELTA_ENTRY_FILTER_MODE must be SHADOW or LIVE');
  }
  requireInteger('VOLUME_DELTA_LOOKBACK_CANDLES', VOLUME_DELTA_LOOKBACK_CANDLES, 1);
  requireNonNegative('VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT', VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT);

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
  if (TELEGRAM_ENABLED && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
    errors.push('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when TELEGRAM_ENABLED=true');
  }
  if (ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_ENABLED) {
    if (!ADAPTIVE_GRID_SUPERVISOR_ENABLED) {
      errors.push('ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_ENABLED requires ADAPTIVE_GRID_SUPERVISOR_ENABLED=true');
    }
    if (ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_MODE !== 'SHADOW') {
      errors.push('ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_MODE currently supports SHADOW only');
    }
    if (!ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_LOG_FILE) {
      errors.push('ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_LOG_FILE must not be empty');
    }
    if (!ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_STATE_FILE) {
      errors.push('ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_STATE_FILE must not be empty');
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
    console.warn(`[LOCK] Found stale lock for PID ${owner.pid}; waiting ${BOT_LOCK_STALE_GRACE_MS}ms before cleanup`);
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
    try {
      fs.unlinkSync(this.lockPath);
      console.warn(`[LOCK] Removed stale lock for inactive PID ${owner.pid}: ${this.lockPath}`);
      return true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return true;
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
// Binance retired the old futures testnet (testnet.binancefuture.com) and
// ccxt's binanceusdm.setSandboxMode() no longer works for it. Its replacement
// is "Binance Demo Trading", reachable at demo-fapi.binance.com /
// demo-fstream.binance.com, which requires API keys generated specifically
// from the Demo Trading panel on the Binance Futures site (NOT your live
// keys, and NOT the old testnet.binancefuture.com keys - those won't work
// here). If ccxt's built-in sandbox switch is unavailable, we patch the
// exchange's own URL map instead of hardcoding ccxt-version-specific key
// names, so this keeps working even if ccxt's internal url structure changes.
function pointBinanceUsdmToDemoTrading(exchange) {
  const rewrite = url => typeof url === 'string'
    ? url
        .replace('https://fapi.binance.com', 'https://demo-fapi.binance.com')
        .replace('wss://fstream.binance.com', 'wss://demo-fstream.binance.com')
        .replace('wss://fstream-auth.binance.com', 'wss://demo-fstream.binance.com')
    : url;
  const api = exchange.urls?.api;
  if (typeof api === 'string') {
    exchange.urls.api = rewrite(api);
  } else if (api && typeof api === 'object') {
    for (const key of Object.keys(api)) {
      api[key] = rewrite(api[key]);
    }
  }
  if (exchange.urls?.ws) {
    exchange.urls.ws = rewrite(exchange.urls.ws);
  }
}

class ExchangeManager {
  static instance = null;

  static getInstance() {
    if (!this.instance) {
      if (!VALID_EXCHANGE_MODES.has(EXCHANGE_MODE)) {
        throw new Error(`EXCHANGE_MODE invalid: ${EXCHANGE_MODE}. Use live or testnet.`);
      }
      // binanceusdm = Binance USDⓈ-M (linear, USDT/BUSD-margined) perpetual &
      // delivery futures. Using the dedicated subclass (rather than
      // ccxt.binance with options.defaultType='future') avoids ambiguity
      // between spot/margin/future/delivery market resolution.
      this.instance = new ccxt.binanceusdm({
        apiKey: process.env.EXCHANGE_API_KEY,
        secret: process.env.EXCHANGE_SECRET,
        enableRateLimit: true,
        options: {
          defaultType: 'future',
          adjustForTimeDifference: true,
          recvWindow: 10000,
          // loadMarkets() otherwise also calls fetchCurrencies(), which for
          // binance hits a SPOT (sapi) endpoint - not part of the futures
          // Demo Trading domain, and not something a futures-only API key
          // can authenticate against anyway. We don't need currency/network
          // metadata for grid trading, so skip it entirely.
          fetchCurrencies: false,
        },
      });
      if (EXCHANGE_MODE === 'testnet') {
        // IMPORTANT: do NOT call this.instance.setSandboxMode(true) here.
        // For binanceusdm that call does not throw immediately - it just
        // quietly sets the internal this.options['sandboxMode'] flag to
        // true. The actual NotSupported error only surfaces later, on every
        // subsequent API call, inside binance's sign() (which now refuses
        // to sign fapi/dapi requests once that flag is set). So a
        // try/catch around setSandboxMode() alone can never catch it, and
        // every real request would fail afterwards. Instead we skip it
        // entirely and manually point at Binance's replacement - Demo
        // Trading (demo-fapi.binance.com) - while explicitly keeping the
        // sandboxMode flag falsy so binance.js's sign() guard never fires.
        console.log(
          '[FUTURES] EXCHANGE_MODE=testnet: using Binance Demo Trading endpoints ' +
          '(demo-fapi.binance.com) - ccxt sandbox mode is not supported for futures anymore. ' +
          'EXCHANGE_API_KEY/EXCHANGE_SECRET must be keys generated from Binance Futures\' "Demo Trading" panel.'
        );
        this.instance.options['sandboxMode'] = false;
        this.instance.options['test'] = false;
        pointBinanceUsdmToDemoTrading(this.instance);
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
    this.processedFundingIdSet = new Set(this.data.processedFundingIds);
  }

  static createEmpty() {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      symbols: {},
      processedTradeIds: [],
      processedFundingIds: [],
      totals: { filledBuys: 0, filledSells: 0, realizedGridProfit: 0, realizedExitProfit: 0, fundingProfit: 0, tradingFees: 0 },
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
    normalized.processedFundingIds = Array.isArray(normalized.processedFundingIds)
      ? normalized.processedFundingIds.map(String).slice(-MAX_PROCESSED_TRADE_IDS)
      : [];
    normalized.totals = isPlainObject(normalized.totals) ? normalized.totals : {};
    normalized.totals.filledBuys = numberOrZero(normalized.totals.filledBuys);
    normalized.totals.filledSells = numberOrZero(normalized.totals.filledSells);
    normalized.totals.realizedGridProfit = numberOrZero(normalized.totals.realizedGridProfit);
    normalized.totals.realizedExitProfit = numberOrZero(normalized.totals.realizedExitProfit);
    normalized.totals.fundingProfit = numberOrZero(normalized.totals.fundingProfit);
    normalized.totals.tradingFees = numberOrZero(normalized.totals.tradingFees);
    return normalized;
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(GRID_STATE_PATH, 'utf8'));
      if (!isPlainObject(data) || !isPlainObject(data.symbols)) {
        throw new Error('Invalid state structure');
      }
      return GridState.normalize(data);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`Cannot load grid state ${GRID_STATE_PATH}: ${err.message}`, { cause: err });
      }
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
        refillCountByLevel: {},
        filledBuys: 0,
        filledSells: 0,
        realizedGridProfit: 0,
        realizedExitProfit: 0,
        fundingProfit: 0,
        tradingFees: 0,
        lastTradeTimestamp: 0,
        lastFundingTimestamp: 0,
        trailingUp: { shifts: 0, lastShiftAt: null },
        trailingDown: { shifts: 0, lastShiftAt: null },
        rangeTransition: null,
        unreconciledSells: {},
        remappedSellSources: {},
      };
    }
    const sym = this.data.symbols[symbol];
    sym.config = isPlainObject(sym.config) ? sym.config : {};
    sym.orders = isPlainObject(sym.orders) ? sym.orders : {};
    sym.lastBuyByLevel = isPlainObject(sym.lastBuyByLevel) ? sym.lastBuyByLevel : {};
    sym.refillCountByLevel = isPlainObject(sym.refillCountByLevel) ? sym.refillCountByLevel : {};
    sym.filledBuys = numberOrZero(sym.filledBuys);
    sym.filledSells = numberOrZero(sym.filledSells);
    sym.realizedGridProfit = numberOrZero(sym.realizedGridProfit);
    sym.realizedExitProfit = numberOrZero(sym.realizedExitProfit);
    sym.fundingProfit = numberOrZero(sym.fundingProfit);
    sym.tradingFees = numberOrZero(sym.tradingFees);
    sym.lastTradeTimestamp = numberOrZero(sym.lastTradeTimestamp);
    sym.lastFundingTimestamp = numberOrZero(sym.lastFundingTimestamp);
    if (!sym.trailingUp) sym.trailingUp = { shifts: 0, lastShiftAt: null };
    if (!sym.trailingDown) sym.trailingDown = { shifts: 0, lastShiftAt: null };
    // Marker for an in-flight range reset/trailing shift: set (and persisted)
    // BEFORE any exchange orders are cancelled, cleared only once the local
    // remap has been fully computed and persisted in the same save(). If the
    // process crashes/restarts between those two points, this survives on
    // disk so the transition can be resumed against the SAME target range
    // instead of silently leaving cancelled-on-exchange orders paired with
    // stale local config/lastBuyByLevel. See resumeInterruptedRangeTransition().
    if (sym.rangeTransition === undefined) sym.rangeTransition = null;
    if (!isPlainObject(sym.unreconciledSells)) sym.unreconciledSells = {};
    if (!isPlainObject(sym.remappedSellSources)) sym.remappedSellSources = {};
    return sym;
  }

  async rememberOrder(symbol, order, meta) {
    const sym = this.getSymbol(symbol);
    sym.orders[String(order.id)] = {
      id: String(order.id),
      side: order.side,
      levelIndex: meta.levelIndex,
      refillCount: Number(meta.refillCount) || 0,
      sourceBuyLevelIndex: meta.sourceBuyLevelIndex ?? null,
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
    // NOTE: previously this also checked the legacy, unscoped `String(id)`
    // for backward compatibility with old state files. That was removed:
    // if two different symbols happen to share a numeric trade id and one
    // was ever stored as a legacy (unscoped) id, the other symbol's genuine
    // trade would be wrongly treated as already-processed and silently
    // skipped (missed fill -> stale P&L / buy records). All trades written
    // by this version use the scoped id; any legacy ids left over in an old
    // state file are simply ignored now rather than trusted.
    return this.processedTradeIdSet.has(scopedId);
  }

  // Mutates in-memory state only - does NOT persist. Callers that also touch
  // other parts of symState (buy records, profit totals, order bookkeeping)
  // in the same handler should call this, make all their other mutations,
  // and then call save() exactly once at the end. This is what closes the
  // double-processing hole: previously a trade could be persisted as
  // "processed" via its own separate save() while a sibling mutation from
  // the same fill (e.g. the buy record) had not yet been written, or vice
  // versa, so a crash in between made the fill look unprocessed again on
  // the next cycle even though part of its effect was already applied.
  markProcessedTradeLocal(symbol, id) {
    this.ensureProcessedTradeIndex();
    const scopedId = scopedTradeId(symbol, id);
    if (this.processedTrade(symbol, id)) return false;
    this.data.processedTradeIds.push(scopedId);
    this.processedTradeIdSet.add(scopedId);
    this.data.processedTradeIds = this.data.processedTradeIds.slice(-MAX_PROCESSED_TRADE_IDS);
    if (this.data.processedTradeIds.length >= MAX_PROCESSED_TRADE_IDS) {
      this.rebuildProcessedTradeIndex();
    }
    return true;
  }

  // Convenience wrapper for call sites that have no other pending mutation
  // to batch with - mutates and immediately persists by itself.
  async markProcessedTrade(symbol, id) {
    const changed = this.markProcessedTradeLocal(symbol, id);
    if (changed) await this.save();
    return changed;
  }

  processedFunding(symbol, id) {
    if (!this.processedFundingIdSet) {
      this.processedFundingIdSet = new Set(this.data.processedFundingIds || []);
    }
    return this.processedFundingIdSet.has(scopedTradeId(symbol, id));
  }

  markProcessedFundingLocal(symbol, id) {
    if (this.processedFunding(symbol, id)) return false;
    const scopedId = scopedTradeId(symbol, id);
    this.data.processedFundingIds.push(scopedId);
    this.processedFundingIdSet.add(scopedId);
    this.data.processedFundingIds = this.data.processedFundingIds.slice(-MAX_PROCESSED_TRADE_IDS);
    if (this.data.processedFundingIds.length >= MAX_PROCESSED_TRADE_IDS) {
      this.processedFundingIdSet = new Set(this.data.processedFundingIds);
    }
    return true;
  }
}

// ------------------------------
//  Binance-Style Futures (USDⓈ-M) Grid Engine
// ------------------------------

class FuturesGridEngine {
  constructor() {
    this.exchange = ExchangeManager.getInstance();
    this.state = new GridState();
    this.isRunning = false;
    this.symbolLocks = new Map();
    this.pendingOrderLevels = new Set();
    this.rangeResetSymbols = new Set();
    this.roiExitedSymbols = new Set();
    this.roiExitReasons = new Map();
    this.roiExitAlertedSymbols = new Set();
    this.roiCloseOrders = new Map();
    this.lastFundingSyncAt = new Map();
    this.exposureLimits = { symbol: FUTURES_MAX_SYMBOL_EXPOSURE_USDT, total: FUTURES_MAX_TOTAL_EXPOSURE_USDT };
    this.telegramCommandTimer = null;
    this.telegramCommandProcessing = false;
    this.userStreamReconcileTimers = new Map();
    this.userStreamSymbolMap = new Map();
    this.marginCallUntil = new Map();
    this.circuitBreaker = { errors: 0, pausedUntil: 0 };
    // for stuck investment warning deduplication
    this.stuckInvestmentWarned = new Set();
    this.sellTargetWarnings = new Set();
    this.adaptiveMinimumWarnings = new Set();
    this.adaptiveGridDecisions = new Map();
    this.lastFibonacciDirectionLog = new Map();
    this.appliedFibonacciDirections = new Map();
    this.lastVolumeDeltaLog = new Map();
    this.mutualExclusionEnabled = FUTURES_MUTUAL_EXCLUSION_ENABLED;
    this.mutualEntryMutex = new CrossProcessMutex(FUTURES_MUTUAL_ENTRY_LOCK_PATH, {
      timeoutMs: FUTURES_MUTUAL_ENTRY_LOCK_TIMEOUT_MS,
    });
    this.volumeDeltaAnalyzer = new VolumeDeltaAnalyzer(this.exchange, {
      enabled: VOLUME_DELTA_ENTRY_FILTER_ENABLED,
      lookbackCandles: VOLUME_DELTA_LOOKBACK_CANDLES,
      candleCloseBufferMs: FIBONACCI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS,
    });
    this.adaptiveSupervisorOutcomeJournal = new AdaptiveSupervisorOutcomeJournal({
      enabled: ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_ENABLED,
      mode: ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_MODE,
      logPath: ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_LOG_FILE,
      statePath: ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_STATE_FILE,
    });
    this.futuresUserStream = new BinanceFuturesUserStream({
      exchange: this.exchange,
      enabled: FUTURES_USER_STREAM_ENABLED,
      wsBaseUrl: FUTURES_USER_STREAM_WS_URL,
      keepaliveMs: FUTURES_USER_STREAM_KEEPALIVE_MS,
      reconnectMaxMs: FUTURES_USER_STREAM_RECONNECT_MAX_MS,
      onEvent: event => this.handleUserStreamEvent(event),
    });
    const targetNetRate = GRID_MIN_NET_PROFIT_PCT / 100;
    const minimumStepRatio = (1 + targetNetRate + BINANCE_FUTURES_MAKER_FEE_RATE) /
      (1 - BINANCE_FUTURES_MAKER_FEE_RATE);
    this.fibonacciRangeAdvisor = new FibonacciRangeAdvisor(this.exchange, {
      enabled: FIBONACCI_RANGE_ADVISOR_ENABLED,
      timeframes: FIBONACCI_RANGE_ADVISOR_TIMEFRAMES,
      ratios: FIBONACCI_RANGE_ADVISOR_RATIOS,
      candleCloseBufferMs: FIBONACCI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS,
      clusterTolerancePct: FIBONACCI_RANGE_ADVISOR_CLUSTER_TOLERANCE_PCT,
      minClusterScore: FIBONACCI_RANGE_ADVISOR_MIN_CLUSTER_SCORE,
      minRangeWidthPct: FIBONACCI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT,
      maxDistancePct: FIBONACCI_RANGE_ADVISOR_MAX_DISTANCE_PCT,
      rebuildThresholdPct: FIBONACCI_RANGE_ADVISOR_REBUILD_THRESHOLD_PCT,
      rebuildCooldownMs: FIBONACCI_RANGE_ADVISOR_REBUILD_COOLDOWN_MS,
      levelCount: GRID_COUNT + 1,
      minimumStepRatio,
      directionLevelBiasPct: FIBONACCI_DIRECTION_LEVEL_BIAS_PCT,
      statePath: FIBONACCI_RANGE_ADVISOR_STATE_PATH,
    });
    this.fibonacciDirectionAnalyzer = new FibonacciDirectionAnalyzer(this.exchange, {
      enabled: FIBONACCI_DIRECTION_ANALYZER_ENABLED,
      timeframes: FIBONACCI_DIRECTION_TIMEFRAMES,
      candleLimit: FIBONACCI_DIRECTION_CANDLE_LIMIT,
      candleCloseBufferMs: FIBONACCI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS,
      pivotLookback: FIBONACCI_DIRECTION_PIVOT_LOOKBACK,
      minimumTimeframes: FIBONACCI_DIRECTION_MIN_TIMEFRAMES,
      confirmations: FIBONACCI_DIRECTION_CONFIRMATIONS,
    });
    this.adaptiveGridSupervisor = new AdaptiveGridSupervisor({
      minimumConfidence: FIBONACCI_DIRECTION_MIN_CONFIDENCE,
      profileConfirmations: ADAPTIVE_GRID_SUPERVISOR_PROFILE_CONFIRMATIONS,
      cooldownMs: ADAPTIVE_GRID_SUPERVISOR_COOLDOWN_MS,
      riskExposureRatio: ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT / 100,
      riskStateMachineEnabled: ADAPTIVE_RISK_STATE_MACHINE_ENABLED,
      riskStateMachineMode: ADAPTIVE_RISK_STATE_MACHINE_MODE,
      cautionExposureRatio: ADAPTIVE_RISK_STATE_MACHINE_CAUTION_EXPOSURE_PCT / 100,
      riskStateExposureRatio: ADAPTIVE_RISK_STATE_MACHINE_RISK_EXPOSURE_PCT / 100,
      lossWarningPct: ADAPTIVE_RISK_STATE_MACHINE_LOSS_WARNING_PCT,
      lossRiskOffPct: ADAPTIVE_RISK_STATE_MACHINE_LOSS_RISK_OFF_PCT,
      liquidationWarningPct: ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_WARNING_PCT,
      liquidationCriticalPct: ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_CRITICAL_PCT,
      cautionConfirmations: ADAPTIVE_RISK_STATE_MACHINE_CAUTION_CONFIRMATIONS,
      recoveryConfirmations: ADAPTIVE_RISK_STATE_MACHINE_RECOVERY_CONFIRMATIONS,
      mode: ADAPTIVE_GRID_SUPERVISOR_MODE,
    });
  }

  async init() {
    await retry(() => this.exchange.loadMarkets());
    this.userStreamSymbolMap = new Map(SYMBOLS.map(symbol => [
      String(this.exchange.markets[symbol]?.id || '').toUpperCase(),
      symbol,
    ]).filter(([marketId]) => marketId));
    await this.setupHedgeMode();
    for (const symbol of SYMBOLS) {
      try {
        this.ensureMarket(symbol);
        this.warnIfPerGridSizeBelowMinCost(symbol);
        await this.setupSymbolLeverageAndMargin(symbol);
        if (GRID_RECREATE_ON_START) await this.cancelGridOrders(symbol, 'recreate-on-start');
        await this.reconcileSymbol(symbol);
      } catch (err) {
        console.error(`[INIT] ${symbol}`, err);
        this.recordError();
      }
    }
  }

  // Enables Hedge Mode (dual-side position) on the account, if not already
  // enabled. Binance returns an error ("No need to change position side")
  // when it's already set, which is treated as success rather than a fatal
  // startup error. Every order this engine sends carries an explicit
  // positionSide, which Binance only accepts in Hedge Mode — if the account
  // is actually in One-Way Mode, every single order would be rejected and
  // the bot would spin forever without placing anything. Since that failure
  // mode can go unnoticed if logs aren't watched, we abort startup instead
  // of merely warning.
  async setupHedgeMode() {
    if (!this.exchange.setPositionMode) return;
    try {
      await retry(() => this.exchange.setPositionMode(true));
      console.log('[FUTURES] Hedge mode (dual-side position) enabled.');
    } catch (err) {
      const message = String(err?.message || '').toLowerCase();
      if (message.includes('no need to change') || message.includes('-4059')) {
        console.log('[FUTURES] Hedge mode already enabled.');
        return;
      }
      throw new Error(
        `Hedge mode required but could not be enabled: ${err.message}. ` +
        `Refusing to start, since orders are sent with positionSide=${POSITION_SIDE} ` +
        `and would be rejected by Binance if the account is in one-way mode.`
      );
    }
  }

  // Sets margin mode (isolated/crossed) and leverage for a symbol. Both calls
  // fail harmlessly with an "already set" style error when nothing changes,
  // which we treat as success so re-starting the bot doesn't error out.
  async setupSymbolLeverageAndMargin(symbol) {
    if (this.exchange.setMarginMode) {
      try {
        await retry(() => this.exchange.setMarginMode(MARGIN_MODE.toLowerCase(), symbol));
      } catch (err) {
        const message = String(err?.message || '').toLowerCase();
        if (!message.includes('no need to change') && !message.includes('-4046')) {
          throw new Error(`Could not set margin mode ${MARGIN_MODE} for ${symbol}: ${err.message}`, { cause: err });
        }
      }
    }
    if (this.exchange.setLeverage) {
      try {
        await retry(() => this.exchange.setLeverage(LEVERAGE, symbol));
      } catch (err) {
        throw new Error(`Could not set leverage ${LEVERAGE}x for ${symbol}: ${err.message}`, { cause: err });
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
    const market = this.exchange.markets[symbol];
    if (!market) {
      throw new Error(
        `Symbol ${symbol} not found on Binance USDⓈ-M futures market. ` +
        `Use ccxt's unified futures format, e.g. "BTC/USDT:USDT".`
      );
    }
    if (market.linear === false || market.swap === false) {
      console.warn(
        `[CONFIG] ${symbol} does not look like a linear USDⓈ-M perpetual market ` +
        `(type=${market.type}). This bot is designed for USDT-margined perpetuals.`
      );
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

  canPlaceNewOrders() {
    return !killSwitchActive();
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

  buildAdaptiveRiskContext(symbol, currentPrice, now = Date.now()) {
    const position = this.latestPositions?.get(symbol);
    const contracts = Math.abs(numberOrZero(position?.contracts ?? position?.info?.positionAmt));
    const entryPrice = numberOrZero(position?.entryPrice ?? position?.info?.entryPrice);
    const markPrice = numberOrZero(position?.markPrice ?? position?.info?.markPrice) || numberOrZero(currentPrice);
    const liquidationPrice = numberOrZero(position?.liquidationPrice ?? position?.info?.liquidationPrice);
    const unrealizedPnl = numberOrZero(position?.unrealizedPnl ?? position?.info?.unRealizedProfit);
    const entryNotional = contracts * entryPrice;
    const unrealizedPnlPct = entryNotional > 0 ? (unrealizedPnl / entryNotional) * 100 : null;
    const liquidationDistancePct = markPrice > 0 && liquidationPrice > 0
      ? Math.max(0, ((markPrice - liquidationPrice) / markPrice) * 100)
      : null;
    const marginCallUntil = Number(this.marginCallUntil?.get(symbol)) || 0;
    if (marginCallUntil > 0 && marginCallUntil <= now) this.marginCallUntil.delete(symbol);
    return {
      unrealizedPnlPct,
      liquidationDistancePct,
      marginCallActive: marginCallUntil > now,
    };
  }

  async evaluateAdaptiveSupervisor(symbol, analysis, currentPrice = null) {
    try {
      this.adaptiveSupervisorOutcomeJournal?.observePrice(symbol, currentPrice)
        .catch(error => {
          console.warn(`[ADAPTIVE-OUTCOME] ${symbol} outcome update failed: ${error.message}`);
        });
      const exposureRatio = GRID_TOTAL_INVESTMENT_USDT > 0
        ? this.getAllocatedInvestmentUsdt(symbol) / GRID_TOTAL_INVESTMENT_USDT
        : 0;
      const marketSignalId = Object.values(analysis.timeframes || {})
        .map(timeframe => `${timeframe.timeframe}:${timeframe.lastClosedAt}`)
        .sort()
        .join('|') || analysis.generatedAt;
      const riskContext = this.buildAdaptiveRiskContext(symbol, currentPrice);
      const lossBand = riskContext.unrealizedPnlPct !== null &&
        riskContext.unrealizedPnlPct <= -ADAPTIVE_RISK_STATE_MACHINE_LOSS_RISK_OFF_PCT
        ? 'critical'
        : riskContext.unrealizedPnlPct !== null &&
          riskContext.unrealizedPnlPct <= -ADAPTIVE_RISK_STATE_MACHINE_LOSS_WARNING_PCT
          ? 'warning'
          : 'normal';
      const liquidationBand = riskContext.liquidationDistancePct !== null &&
        riskContext.liquidationDistancePct <= ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_CRITICAL_PCT
        ? 'critical'
        : riskContext.liquidationDistancePct !== null &&
          riskContext.liquidationDistancePct <= ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_WARNING_PCT
          ? 'warning'
          : 'normal';
      const riskSignal = ADAPTIVE_RISK_STATE_MACHINE_ENABLED && ADAPTIVE_RISK_STATE_MACHINE_MODE === 'LIVE'
        ? `|risk:${lossBand}:${liquidationBand}:${riskContext.marginCallActive ? 'margin-call' : 'clear'}`
        : '';
      const signalId = `${marketSignalId}${riskSignal}`;
      const decision = this.adaptiveGridSupervisor.evaluate(symbol, {
        analysis,
        exposureRatio,
        riskContext,
        signalId,
      });
      if (!decision) return null;
      this.adaptiveGridDecisions.set(symbol, decision);
      if (!decision.evaluated) return decision;
      try {
        await this.adaptiveSupervisorOutcomeJournal?.recordDecision(decision, {
          currentPrice,
          analysis,
          investmentLimitUsdt: GRID_TOTAL_INVESTMENT_USDT,
        });
      } catch (error) {
        console.warn(`[ADAPTIVE-OUTCOME] ${symbol} decision write failed: ${error.message}`);
      }
      const weights = decision.recommendation.buyWeight;
      const label = ADAPTIVE_GRID_SUPERVISOR_MODE === 'LIVE' ? 'ADAPTIVE-LIVE' : 'ADAPTIVE-SHADOW';
      console.log(
        `[${label}] ${symbol} profile=${decision.profile} raw=${decision.rawProfile} source=${decision.decisionSource} ` +
        `changed=${decision.changed} exposure=${decision.exposurePct}% ` +
        `${decision.riskState ? `risk=${decision.riskState}->${decision.riskTargetState} ` : ''}` +
        `buy-weight=${weights.upper}/${weights.middle}/${weights.lower} ` +
        `spacing=${decision.recommendation.spacingMultiplier} investment-cap=${GRID_TOTAL_INVESTMENT_USDT}USDT ` +
        `reasons=${decision.reasons.join(',')} ` +
        `${decision.riskReasons?.length ? `risk-reasons=${decision.riskReasons.join(',')}` : ''}`
      );
      await fs.promises.appendFile(
        ADAPTIVE_GRID_SUPERVISOR_LOG_PATH,
        `${JSON.stringify(decision)}\n`,
        'utf8'
      );
      if (ADAPTIVE_RISK_STATE_MACHINE_MODE === 'LIVE' && decision.riskState === RISK_STATES.RISK_OFF) {
        await this.cancelManagedBuyOrders(symbol, `risk-state ${decision.riskReasons.join(',') || 'RISK_OFF'}`);
      }
      return decision;
    } catch (err) {
      console.warn(`[ADAPTIVE-${ADAPTIVE_GRID_SUPERVISOR_MODE}] ${symbol} evaluation failed: ${err.message}`);
      return null;
    }
  }

  getAdaptiveRecommendation(symbol) {
    if (!ADAPTIVE_GRID_SUPERVISOR_ENABLED || ADAPTIVE_GRID_SUPERVISOR_MODE !== 'LIVE') return null;
    if (ADAPTIVE_RISK_STATE_MACHINE_ENABLED && ADAPTIVE_RISK_STATE_MACHINE_MODE === 'LIVE') {
      const decision = this.adaptiveGridDecisions?.get(symbol);
      if (decision?.recommendation) {
        return {
          ...decision.recommendation,
          profile: decision.profile,
          riskState: decision.riskState,
        };
      }
      return {
        ...recommendationForRiskState(RISK_STATES.RISK_OFF, recommendationFor(PROFILES.SIDEWAYS)),
        profile: PROFILES.SIDEWAYS,
        riskState: RISK_STATES.RISK_OFF,
      };
    }
    const allocated = this.getAllocatedInvestmentUsdt(symbol);
    const exposureRatio = GRID_TOTAL_INVESTMENT_USDT > 0 ? allocated / GRID_TOTAL_INVESTMENT_USDT : 0;
    if (exposureRatio >= ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT / 100) {
      return { ...recommendationFor(PROFILES.RISK_OFF), profile: PROFILES.RISK_OFF };
    }
    const decision = this.adaptiveGridDecisions?.get(symbol);
    if (decision?.recommendation) {
      return { ...decision.recommendation, profile: decision.profile };
    }
    return { ...recommendationFor(PROFILES.RISK_OFF), profile: PROFILES.RISK_OFF };
  }

  getBuyPlacementLevels(symbol, levels, currentPrice, limit = GRID_MAX_ACTIVE_BUY_ORDERS) {
    const candidates = this.getNearestLevels(levels, currentPrice, 'buy', levels.length);
    const recommendation = this.getAdaptiveRecommendation(symbol);
    if (!recommendation) return candidates.slice(0, limit);
    if (recommendation.riskState === RISK_STATES.RISK_OFF) return [];
    return buildAdaptiveBuyPlan(candidates, recommendation, limit);
  }

  // Completes a range reset/trailing shift that a previous process
  // instance started (and persisted a marker for, BEFORE cancelling any
  // exchange orders) but never finished. Exchange orders for the old range
  // may already be gone; cancelGridOrders() below is a harmless no-op for
  // any that already are, and will retry any that turn out not to be.
  // Re-running the same function that was interrupted, with the exact
  // bounds recorded in the marker, keeps this a single code path with the
  // normal reset/shift logic rather than a separate parallel recovery path.
  async resumeInterruptedRangeTransition(symbol, transition) {
    console.warn(
      `[RANGE] ${symbol} resuming ${transition.kind === 'trail' ? 'trailing shift' : 'range reset'} ` +
      `interrupted by a previous restart: ${roundNumber(transition.oldLower)}-${roundNumber(transition.oldUpper)} -> ` +
      `${roundNumber(transition.newLower)}-${roundNumber(transition.newUpper)}`
    );
    if (transition.kind === 'trail') {
      const shift = { lower: transition.newLower, upper: transition.newUpper, steps: transition.steps };
      return await this.applyTrailingRangeShift(
        symbol, transition.oldLower, transition.oldUpper, shift, transition.direction
      );
    }
    await this.remapStateAfterRangeReset(
      symbol, transition.oldLower, transition.oldUpper, transition.newLower, transition.newUpper, transition.levels
    );
    const symState = this.state.getSymbol(symbol);
    symState.config = {
      ...symState.config,
      lower: transition.newLower,
      upper: transition.newUpper,
      autoRange: symState.config.autoRange !== false,
    };
    await this.state.save();
    return { lower: transition.newLower, upper: transition.newUpper, levels: transition.levels || null };
  }

  async buildRange(symbol, currentPrice) {
    const symState = this.state.getSymbol(symbol);

    // If a previous cycle crashed/restarted after orders were already
    // cancelled on the exchange for a range reset/trailing shift but before
    // the local remap finished being persisted, finish that SAME transition
    // now instead of computing a brand-new range from the current price.
    // Recomputing fresh here would risk landing on a different range than
    // the one orders were actually cancelled for, leaving lastBuyByLevel
    // permanently mismatched against reality.
    if (symState.rangeTransition) {
      return await this.resumeInterruptedRangeTransition(symbol, symState.rangeTransition);
    }

    const manualRange = hasManualGridRange();
    let storedLower = Number(symState.config.lower) || 0;
    let storedUpper = Number(symState.config.upper) || 0;
    // Captured BEFORE storedLower/storedUpper get zeroed out below, so we
    // still know what the previous range was if a reset happens.
    const previousLower = storedLower;
    const previousUpper = storedUpper;
    const storedAdvisorLevels = symState.config.rangeAdvisor?.levels || symState.config.aiAdvisor?.levels;
    const previousLevels = Array.isArray(storedAdvisorLevels) ? storedAdvisorLevels.map(Number) : null;

    if (!manualRange && storedLower > 0 && storedUpper > 0) {
      const stale = this.isStoredRangeStale(symbol, currentPrice, storedLower, storedUpper);
      if (stale) {
        if (GRID_STALE_RANGE_AUTO_RESET) {
          console.warn(`[RANGE] ${symbol} auto-resetting stale range around current price (GRID_STALE_RANGE_AUTO_RESET=true).`);
          storedLower = 0;
          storedUpper = 0;
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

    const fibonacciAllowed = FIBONACCI_RANGE_ADVISOR_ENABLED &&
      (FIBONACCI_RANGE_ADVISOR_APPLY_ON === 'ALWAYS' || !manualRange);
    let fibonacciDirection = null;
    let appliedDirection = 'RANGING';
    if ((fibonacciAllowed || ADAPTIVE_GRID_SUPERVISOR_ENABLED) && FIBONACCI_DIRECTION_ANALYZER_ENABLED) {
      fibonacciDirection = await this.fibonacciDirectionAnalyzer.getAnalysis(symbol);
      if (fibonacciAllowed && FIBONACCI_DIRECTION_APPLY_MODE === 'LEVEL_BIAS') {
        appliedDirection = resolveAppliedDirection(fibonacciDirection, {
          strategy: FIBONACCI_DIRECTION_STRATEGY,
          minimumConfidence: FIBONACCI_DIRECTION_MIN_CONFIDENCE,
          emaSlopeAtrThreshold: FIBONACCI_DIRECTION_EMA_SLOPE_ATR_THRESHOLD,
        });
      }
      if (fibonacciDirection) {
        const logKey = `${fibonacciDirection.generatedAt}:${appliedDirection}`;
        if (this.lastFibonacciDirectionLog.get(symbol) !== logKey) {
          console.log(
            `[FIB-DIRECTION] ${symbol} direction=${fibonacciDirection.direction} ` +
            `score=${fibonacciDirection.score} confidence=${fibonacciDirection.confidence} ` +
            `alignment=${fibonacciDirection.alignment} confirmation=${fibonacciDirection.confirmationCount}/` +
            `${fibonacciDirection.confirmationsRequired} strategy=${FIBONACCI_DIRECTION_STRATEGY} ` +
            `applied=${appliedDirection}`
          );
          this.lastFibonacciDirectionLog.set(symbol, logKey);
        }
      }
      if (ADAPTIVE_GRID_SUPERVISOR_ENABLED && fibonacciDirection) {
        await this.evaluateAdaptiveSupervisor(symbol, fibonacciDirection, currentPrice);
      }
    }
    this.appliedFibonacciDirections.set(symbol, appliedDirection);
    const rangeSuggestion = fibonacciAllowed
      ? await this.fibonacciRangeAdvisor.getSuggestion(symbol, currentPrice, Date.now(), {
        direction: appliedDirection,
      })
      : null;
    const fallbackLower = (resetAutoRange ? 0 : storedLower) || currentPrice * (1 - GRID_RANGE_PCT / 100);
    const fallbackUpper = (resetAutoRange ? 0 : storedUpper) || currentPrice * (1 + GRID_RANGE_PCT / 100);
    const lower = manualRange
      ? (rangeSuggestion ? rangeSuggestion.lower : GRID_LOWER_PRICE)
      : (rangeSuggestion ? rangeSuggestion.lower : fallbackLower);
    const upper = manualRange
      ? (rangeSuggestion ? rangeSuggestion.upper : GRID_UPPER_PRICE)
      : (rangeSuggestion ? rangeSuggestion.upper : fallbackUpper);
    if (lower <= 0 || upper <= 0 || lower >= upper) {
      throw new Error(`Invalid grid range. lower=${lower}, upper=${upper}`);
    }
    const advisorLevels = this.getAdvisorGridLevels(
      symbol, rangeSuggestion, lower, upper, currentPrice
    );

    // Unlike a trailing shift (which is a parallel translation of the same
    // grid, handled by applyTrailingRangeShift's offset-based remap), a
    // stale-range auto-reset, GRID_RESET_RANGE_ON_START, or a fresh Fibonacci
    // range suggestion can all produce a brand-new lower/upper with
    // no fixed relationship to the old one. If we simply swap symState.config
    // without reconciling, any open managed orders and accumulated
    // lastBuyByLevel records stay indexed against the OLD grid's level
    // numbering while levels[] is rebuilt from the NEW range — silently
    // desyncing buy/sell pairing, P&L, and refill prices. Reconcile BEFORE
    // the new range is persisted. Note: this deliberately does NOT gate on
    // `rangeWasReset` — any actual change to lower/upper (whatever the
    // cause) needs the same remap, since the level-index-to-price mapping
    // has no guaranteed relationship to the previous cycle's mapping.
    const effectiveGridChanged = previousLower > 0 && previousUpper > 0 &&
      !this.effectiveGridLevelsEqual(
        symbol, previousLower, previousUpper, previousLevels, lower, upper, advisorLevels
      );
    if (effectiveGridChanged) {
      await this.remapStateAfterRangeReset(
        symbol, previousLower, previousUpper, lower, upper, advisorLevels
      );
    }

    const advisorState = rangeSuggestion ? {
      source: 'FIBONACCI',
      confidence: rangeSuggestion.confidence,
      confluenceScore: rangeSuggestion.confluenceScore,
      timeframeCount: rangeSuggestion.timeframeCount,
      direction: fibonacciDirection?.direction || rangeSuggestion.direction,
      directionApplied: appliedDirection,
      directionApplyMode: FIBONACCI_DIRECTION_APPLY_MODE,
      directionStrategy: FIBONACCI_DIRECTION_STRATEGY,
      directionScore: fibonacciDirection?.score,
      directionConfidence: fibonacciDirection?.confidence,
      directionAlignment: fibonacciDirection?.alignment,
      directionConfirmationCount: fibonacciDirection?.confirmationCount,
      directionConfirmationsRequired: fibonacciDirection?.confirmationsRequired,
      directionTimeframes: fibonacciDirection
        ? Object.fromEntries(Object.entries(fibonacciDirection.timeframes).map(([timeframe, value]) => [timeframe, {
          direction: value.direction,
          score: value.score,
          reasons: value.reasons,
        }]))
        : undefined,
      levelDistribution: rangeSuggestion.levelDistribution,
      marketCondition: rangeSuggestion.marketCondition,
      reasoning: rangeSuggestion.reasoning,
      levels: advisorLevels || undefined,
      appliedAt: new Date().toISOString(),
    } : undefined;

    symState.config = {
      mode: GRID_MODE,
      count: GRID_COUNT,
      lower,
      upper,
      autoRange: !manualRange,
      orderSizeUsdt: this.getOrderSizeUsdt(),
      rangeAdvisor: advisorState,
      volumeDeltaEntryGuard: symState.config.volumeDeltaEntryGuard,
    };
    if (resetAutoRange) {
      if (!this.rangeResetSymbols) this.rangeResetSymbols = new Set();
      this.rangeResetSymbols.add(symbol);
    }
    await this.state.save();
    return { lower, upper, levels: advisorLevels };
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
  async remapStateAfterRangeReset(symbol, oldLower, oldUpper, newLower, newUpper, newLevelsOverride = null) {
    const symState = this.state.getSymbol(symbol);

    // Validate the target grid before cancelling live orders. If precision
    // collapses the new range, keep both the current orders and the tracked
    // LONG cost basis intact so the position remains manageable.
    let newLevels;
    try {
      newLevels = Array.isArray(newLevelsOverride)
        ? this.getUsableCustomLevels(symbol, newLevelsOverride, newLower, newUpper, 'range transition')
        : this.buildLevels(newLower, newUpper, symbol);
      if (!newLevels) throw new Error('custom range levels are invalid');
    } catch (err) {
      if (symState.rangeTransition?.kind === 'reset' &&
          symState.rangeTransition.newLower === newLower &&
          symState.rangeTransition.newUpper === newUpper) {
        symState.rangeTransition = null;
        await this.state.save();
      }
      throw new Error(
        `[RANGE] ${symbol} range-reset rejected before order cancellation: ${err.message}`
      );
    }

    // Reconcile fills against the old level mapping before cancelling or
    // remapping orders, so a SELL cannot lose its cost basis or alert.
    await this.reconcilePendingFillsBeforeRangeTransition(symbol, 'reset');

    // Persist the transition BEFORE the irreversible step (cancelling live
    // orders on the exchange). If the process dies anywhere after this point
    // and before the marker is cleared below, resumeInterruptedRangeTransition()
    // will find it on the next cycle and finish remapping onto this exact
    // oldLower/oldUpper -> newLower/newUpper pair, instead of buildRange
    // computing a fresh (possibly different) range while orders that were
    // already cancelled sit unaccounted for against stale local state.
    if (!symState.rangeTransition || symState.rangeTransition.kind !== 'reset' ||
        symState.rangeTransition.newLower !== newLower || symState.rangeTransition.newUpper !== newUpper) {
      symState.rangeTransition = {
        kind: 'reset', oldLower, oldUpper, newLower, newUpper,
        levels: newLevelsOverride || undefined,
      };
      await this.state.save();
    }

    const cancelResult = await this.cancelGridOrders(symbol, 'range-reset');
    if (cancelResult.failed.length > 0) {
      const failedIds = cancelResult.failed.map(f => f.id).join(', ');
      // Abort the remap entirely: some orders are still live on the
      // exchange. If we clear local state below anyway, those orders become
      // "ghost" orders — when getManagedOpenOrders() recovers them later via
      // clientOrderId, the embedded old level index may no longer be valid
      // against the new grid (different bounds/level count), corrupting
      // level tracking and P&L. Bail out and let the caller retry the reset
      // on the next cycle once all orders are confirmed cancelled.
      throw new Error(
        `[RANGE] ${symbol} range-reset aborted: ${cancelResult.failed.length} order cancellation(s) ` +
        `failed (ids: ${failedIds}). Will retry reset next cycle once all orders are cancelled.`
      );
    }
    await this.reconcilePendingFillsBeforeRangeTransition(symbol, 'reset post-cancel');
    const staleOrders = Object.entries(symState.orders);
    if (Object.keys(symState.orders).length > 0) {
      console.warn(
        `[RANGE] ${symbol} had ${Object.keys(symState.orders).length} managed order(s) after cancellation; clearing stale local metadata`
      );
      symState.orders = {};
    }

    const oldEntries = Object.entries(symState.lastBuyByLevel);
    if (oldEntries.length === 0) {
      symState.refillCountByLevel = {};
      symState.rangeTransition = null;
      await this.state.save();
      return;
    }

    const remapped = {};
    const sourceLevelRemap = {};
    for (const [oldIdx, buy] of oldEntries) {
      const fillPrice = Number(buy.price) || 0;
      if (!(fillPrice > 0)) continue;
      const newIdx = this.getLevelIndex(newLevels, fillPrice);
      sourceLevelRemap[oldIdx] = newIdx;
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
    symState.remappedSellSources ||= {};
    for (const remap of Object.values(symState.remappedSellSources)) {
      const nextSource = sourceLevelRemap[remap.sourceBuyLevelIndex];
      if (Number.isInteger(nextSource)) remap.sourceBuyLevelIndex = nextSource;
    }
    for (const [orderId, order] of staleOrders) {
      if (String(order?.side).toLowerCase() !== EXIT_SIDE) continue;
      const nextSource = sourceLevelRemap[order.sourceBuyLevelIndex];
      if (!Number.isInteger(nextSource)) continue;
      symState.remappedSellSources[orderId] = {
        sourceBuyLevelIndex: nextSource,
        remappedAt: new Date().toISOString(),
      };
    }
    symState.lastBuyByLevel = remapped;
    symState.refillCountByLevel = Object.fromEntries(
      Object.entries(remapped).map(([levelIndex, buy]) => [
        levelIndex,
        Math.max(0, Number(buy.refillCount) || 0),
      ])
    );
    symState.rangeTransition = null;
    await this.state.save();

    console.log(
      `[RANGE] ${symbol} range reset: remapped ${oldEntries.length} buy record(s) onto new grid ` +
      `${roundNumber(newLower)}-${roundNumber(newUpper)}`
    );
    await this.sendAlert(this.formatFuturesTelegramMessage('FUTURES RANGE RESET', [
      ['Symbol', symbol],
      ['Old Range', `${roundNumber(oldLower)} - ${roundNumber(oldUpper)}`],
      ['New Range', `${roundNumber(newLower)} - ${roundNumber(newUpper)}`],
      ['Remapped Buys', oldEntries.length],
    ]));
  }

  async reconcilePendingFillsBeforeRangeTransition(symbol, kind = 'reset') {
    if (!this.exchange?.fetchMyTrades || !this.exchange?.fetchOpenOrders) return;
    const openOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    await this.handleFilledTrades(symbol, [], openOrders);
    console.log(`[RANGE] ${symbol} reconciled pending fills before ${kind} transition`);
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

    const shiftedRefillCounts = {};
    for (const [levelIndex, count] of Object.entries(symState.refillCountByLevel || {})) {
      shiftedRefillCounts[this.clampBuyLevelIndex(Number(levelIndex) + offset)] = count;
    }
    symState.refillCountByLevel = shiftedRefillCounts;
  }

  shiftStoredOrderIndexes(symState, offset) {
    const shiftedOrders = {};
    for (const [orderId, order] of Object.entries(symState.orders)) {
      const shiftedIndex = Number(order.levelIndex) + offset;
      const clampedIndex = this.clampBuyLevelIndex(shiftedIndex);
      if (clampedIndex !== shiftedIndex) {
        // Without clamping, an order's levelIndex could land outside
        // [0, GRID_COUNT-1]. That breaks every lookup keyed on levelIndex:
        // reconcileSymbolUnlocked's active buy/source-level lookups wouldn't
        // recognize the order (risking a duplicate), handleSellFill's
        // `levelIndex - 1` buy lookup could
        // go negative and silently skip profit accounting, and
        // handleBuyFill's `levelIndex + 1` sell-refill lookup could target
        // a non-existent level. Clamping keeps the index valid; this order
        // is pinned to the boundary grid level, so its bookkeeping stays
        // internally consistent even though its live exchange price sits
        // just past that level's nominal price after the shift.
        console.warn(
          `[TRAILING] Order ${orderId} (${order.side}) level index ${shiftedIndex} out of range ` +
          `[0, ${GRID_COUNT - 1}] after shift; clamping to boundary level ${clampedIndex}.`
        );
      }
      shiftedOrders[orderId] = {
        ...order,
        levelIndex: clampedIndex,
        ...(order.sourceBuyLevelIndex !== null && order.sourceBuyLevelIndex !== undefined &&
          Number.isInteger(Number(order.sourceBuyLevelIndex))
          ? { sourceBuyLevelIndex: this.clampBuyLevelIndex(Number(order.sourceBuyLevelIndex) + offset) }
          : {}),
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
      refillCount: Math.max(
        Number(existing.refillCount) || 0,
        Number(incoming.refillCount) || 0
      ),
      at: Date.parse(incoming.at || 0) > Date.parse(existing.at || 0) ? incoming.at : existing.at,
      aggregated: aggregatedAcrossLevels || existing.aggregated === true || incoming.aggregated === true,
    };
  }

  buildAggregatedExitLadderPlan(
    symbol, levels, buyLevelIndex, buy,
    { occupiedBuyLevels = new Set(), minimumPrice = -Infinity } = {}
  ) {
    if (!GRID_AGGREGATED_EXIT_LADDER_ENABLED || buy?.aggregated !== true) return null;
    const sourceLevel = Number(buyLevelIndex);
    const totalSellable = Math.max(0, Number(buy.sellableAmount ?? buy.amount) || 0);
    if (!Number.isInteger(sourceLevel) || !(totalSellable > 0)) return null;

    const preciseTotal = Number(this.exchange.amountToPrecision(symbol, totalSellable));
    const tolerance = Math.max(1e-12, totalSellable * 1e-12);
    if (!(preciseTotal > 0) || Math.abs(preciseTotal - totalSellable) > tolerance) return null;

    const candidates = [];
    for (let targetLevelIndex = sourceLevel + 1; targetLevelIndex < levels.length; targetLevelIndex++) {
      const stagedSourceLevel = targetLevelIndex - 1;
      if (stagedSourceLevel !== sourceLevel && occupiedBuyLevels.has(stagedSourceLevel)) continue;
      const sellPrice = Number(levels[targetLevelIndex]);
      if (!(sellPrice > minimumPrice) || !this.isTrackedSellProfitable(symbol, buy, sellPrice)) continue;
      candidates.push({ sourceBuyLevelIndex: stagedSourceLevel, sellLevelIndex: targetLevelIndex, sellPrice });
    }

    const maxParts = Math.min(GRID_AGGREGATED_EXIT_LADDER_MAX_ORDERS, candidates.length);
    const minCost = this.getMinCost(symbol);
    for (let partCount = maxParts; partCount >= 2; partCount--) {
      const weightTotal = partCount * (partCount + 1) / 2;
      const amounts = [];
      let allocated = 0;
      for (let index = 0; index < partCount; index++) {
        const rawAmount = index === partCount - 1
          ? preciseTotal - allocated
          : preciseTotal * (partCount - index) / weightTotal;
        const amount = Number(this.exchange.amountToPrecision(symbol, rawAmount));
        amounts.push(amount);
        allocated += amount;
      }

      const difference = preciseTotal - allocated;
      if (Math.abs(difference) > tolerance) {
        amounts[0] = Number(this.exchange.amountToPrecision(symbol, amounts[0] + difference));
      }
      const plannedTotal = amounts.reduce((sum, amount) => sum + amount, 0);
      if (Math.abs(plannedTotal - preciseTotal) > tolerance || amounts.some(amount => !(amount > 0))) continue;

      const plan = candidates.slice(0, partCount).map((candidate, index) => ({
        ...candidate,
        amount: amounts[index],
      }));
      const valid = plan.every(part => {
        try {
          return this.getPreciseOrderNumbers(symbol, part.sellPrice, part.amount).notional >= minCost - 1e-8;
        } catch {
          return false;
        }
      });
      if (valid) return plan;
    }
    return null;
  }

  stageAggregatedExitLadders(symbol, levels, currentPrice, symState, additionalOccupiedBuyLevels = new Set()) {
    if (!GRID_AGGREGATED_EXIT_LADDER_ENABLED) return 0;
    if (GRID_AGGREGATED_EXIT_LADDER_SYMBOLS.length &&
        !GRID_AGGREGATED_EXIT_LADDER_SYMBOLS.includes(symbol)) return 0;
    const occupiedBuyLevels = new Set(Object.keys(symState.lastBuyByLevel || {}).map(Number));
    for (const levelIndex of additionalOccupiedBuyLevels) occupiedBuyLevels.add(Number(levelIndex));
    const entries = Object.entries(symState.lastBuyByLevel || {});
    let stagedCount = 0;

    for (const [rawBuyLevelIndex, buy] of entries) {
      const buyLevelIndex = Number(rawBuyLevelIndex);
      if (buy?.aggregated !== true || additionalOccupiedBuyLevels.has(buyLevelIndex) ||
          this.getActiveSellOrderForBuyLevel(symState, buyLevelIndex)) continue;
      const plan = this.buildAggregatedExitLadderPlan(symbol, levels, buyLevelIndex, buy, {
        occupiedBuyLevels,
        minimumPrice: Math.max(currentPrice, this.getPositionEntryFloor(symbol)),
      });
      if (!plan) continue;

      const totalSellable = Number(buy.sellableAmount ?? buy.amount) || 0;
      const totalAmount = Number(buy.amount) || totalSellable;
      const totalCostQuote = Number(buy.totalCostQuote) || 0;
      const totalFeeQuote = Number(buy.totalFeeQuote) || 0;
      const group = buy.stagedExitGroup || `${Date.now().toString(36)}-${buyLevelIndex}`;
      let allocatedAmount = 0;
      let allocatedCost = 0;
      let allocatedFee = 0;

      delete symState.lastBuyByLevel[buyLevelIndex];
      delete symState.refillCountByLevel[buyLevelIndex];
      occupiedBuyLevels.delete(buyLevelIndex);

      plan.forEach((part, index) => {
        const isLast = index === plan.length - 1;
        const ratio = part.amount / totalSellable;
        const childAmount = isLast ? totalAmount - allocatedAmount : totalAmount * ratio;
        const childCost = isLast ? totalCostQuote - allocatedCost : totalCostQuote * ratio;
        const childFee = isLast ? totalFeeQuote - allocatedFee : totalFeeQuote * ratio;
        allocatedAmount += childAmount;
        allocatedCost += childCost;
        allocatedFee += childFee;
        symState.lastBuyByLevel[part.sourceBuyLevelIndex] = {
          ...buy,
          amount: childAmount,
          sellableAmount: part.amount,
          totalCostQuote: childCost,
          totalFeeQuote: childFee,
          aggregated: false,
          stagedExitChild: true,
          stagedExitGroup: group,
          stagedExitPart: index + 1,
          stagedExitParts: plan.length,
          stagedExitTargetLevel: part.sellLevelIndex,
        };
        symState.refillCountByLevel[part.sourceBuyLevelIndex] = Math.max(0, Number(buy.refillCount) || 0);
        occupiedBuyLevels.add(part.sourceBuyLevelIndex);
      });

      stagedCount++;
      console.log(
        `[EXIT-LADDER] ${symbol} split aggregated BUY source=${buyLevelIndex} amount=${totalSellable} ` +
        `into ${plan.length} staged exits: ` +
        plan.map(part => `L${part.sellLevelIndex}:${part.amount}`).join(', ')
      );
    }
    return stagedCount;
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
    const symStateForMarker = this.state.getSymbol(symbol);
    await this.reconcilePendingFillsBeforeRangeTransition(symbol, `trailing-${direction}`);
    // Persist BEFORE the irreversible step (cancelling live orders), same
    // rationale as remapStateAfterRangeReset: survives a crash so the shift
    // can be resumed onto this exact target range instead of left half-done.
    const t = symStateForMarker.rangeTransition;
    if (!t || t.kind !== 'trail' || t.newLower !== shift.lower || t.newUpper !== shift.upper) {
      symStateForMarker.rangeTransition = {
        kind: 'trail', direction, oldLower: lower, oldUpper: upper,
        newLower: shift.lower, newUpper: shift.upper, steps: shift.steps,
      };
      await this.state.save();
    }

    const cancelResult = await this.cancelGridOrders(symbol, `trailing-${direction}`);
    if (cancelResult.failed.length > 0) {
      const failedIds = cancelResult.failed.map(f => f.id).join(', ');
      // Abort the shift entirely: some orders are still live on the exchange
      // at OLD-range prices. If we shifted local state anyway, those orders'
      // levelIndex would now point at NEW-grid levels that don't match their
      // actual price -- if one later fills, profit calc pairs it with the
      // wrong buy record, corrupting P&L. Mirrors remapStateAfterRangeReset's
      // strictness: bail out and let the caller retry next cycle once all
      // orders are confirmed cancelled.
      throw new Error(
        `[TRAILING] ${symbol} trailing-${direction} shift aborted: ${cancelResult.failed.length} order ` +
        `cancellation(s) failed (ids: ${failedIds}). Will retry shift next cycle once all orders are cancelled.`
      );
    }
    await this.reconcilePendingFillsBeforeRangeTransition(symbol, `trailing-${direction} post-cancel`);

    const symState = this.state.getSymbol(symbol);
    const trailingState = direction === 'up'
      ? this.getTrailingUpState(symbol)
      : this.getTrailingDownState(symbol);
    const offset = direction === 'up' ? -shift.steps : shift.steps;

    // cancelGridOrders() already called state.forgetOrder() for every order
    // it cancelled above, so symState.orders should normally be empty here.
    // This is a defensive fallback for any order that ended up in local
    // state without being picked up as "managed" by getManagedOpenOrders --
    // shiftStoredOrderIndexes() clamps its levelIndex to stay valid.
    const storedOrderCount = Object.keys(symState.orders).length;
    if (storedOrderCount > 0) {
      console.warn(
        `[TRAILING] ${symbol} had ${storedOrderCount} unexpected leftover order(s) in local state after ` +
        `full cancellation; shifting (and clamping) their local metadata defensively`
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
    symState.refillCountByLevel = Object.fromEntries(
      Object.entries(cleanedBuys).map(([levelIndex, buy]) => [
        levelIndex,
        Math.max(0, Number(buy.refillCount) || 0),
      ])
    );
    trailingState.shifts += shift.steps;
    trailingState.lastShiftAt = new Date().toISOString();
    symState.rangeTransition = null;
    await this.state.save();

    console.log(
      `[TRAILING ${direction.toUpperCase()}] ${symbol} shifted ${shift.steps} grid(s): ` +
      `${roundNumber(lower)}-${roundNumber(upper)} -> ${roundNumber(shift.lower)}-${roundNumber(shift.upper)}`
    );
    await this.sendAlert(this.formatFuturesTelegramMessage(`FUTURES TRAILING ${direction.toUpperCase()}`, [
      ['Symbol', symbol],
      ['Shift', `${shift.steps} grid(s)`],
      ['New Range', `${roundNumber(shift.lower)} - ${roundNumber(shift.upper)}`],
    ]));

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
    if (symbol) {
      this.assertLevelsAreDistinct(symbol, levels, lower, upper);
      this.assertLevelsMeetMinimumProfit(symbol, levels);
    }
    return levels;
  }

  getAdvisorGridLevels(symbol, suggestion, lower, upper, currentPrice) {
    if (!suggestion) return null;
    const suggestedLevels = suggestion.levels
      ? this.getUsableCustomLevels(symbol, suggestion.levels, lower, upper, 'multi-timeframe Fibonacci')
      : null;
    if (suggestedLevels) return suggestedLevels;
    const adaptive = this.buildAdaptiveGridLevels(lower, upper, currentPrice);
    return this.getUsableCustomLevels(symbol, adaptive, lower, upper, 'adaptive Fibonacci');
  }

  buildAdaptiveGridLevels(lower, upper, currentPrice) {
    if (!(currentPrice > lower && currentPrice < upper)) return this.buildLevels(lower, upper);
    const lowerIntervals = Math.max(1, Math.min(
      GRID_COUNT - 1,
      Math.round(GRID_COUNT * (currentPrice - lower) / (upper - lower))
    ));
    const upperIntervals = GRID_COUNT - lowerIntervals;
    const levels = [];
    for (let i = 0; i <= lowerIntervals; i++) {
      const progress = i / lowerIntervals;
      levels.push(currentPrice - (currentPrice - lower) * Math.pow(1 - progress, 2));
    }
    for (let i = 1; i <= upperIntervals; i++) {
      const progress = i / upperIntervals;
      levels.push(currentPrice + (upper - currentPrice) * Math.pow(progress, 2));
    }
    levels[0] = lower;
    levels[levels.length - 1] = upper;
    return levels.map(level => roundNumber(level, 8));
  }

  getUsableCustomLevels(symbol, levels, lower, upper, source = 'custom') {
    if (!Array.isArray(levels) || levels.length !== GRID_COUNT + 1) return null;
    const normalized = levels.map(Number);
    if (normalized.some(level => !(level > 0) || !Number.isFinite(level))) return null;
    for (let i = 1; i < normalized.length; i++) {
      if (!(normalized[i] > normalized[i - 1])) return null;
    }
    const tolerance = Math.max((upper - lower) * 0.0001, upper * 1e-8, 1e-12);
    if (Math.abs(normalized[0] - lower) > tolerance ||
        Math.abs(normalized[normalized.length - 1] - upper) > tolerance) return null;
    normalized[0] = lower;
    normalized[normalized.length - 1] = upper;
    try {
      this.assertLevelsAreDistinct(symbol, normalized, lower, upper);
      this.assertLevelsMeetMinimumProfit(symbol, normalized);
    } catch (err) {
      console.warn(`[GRID] ${symbol} ignoring ${source} levels: ${err.message}`);
      return null;
    }
    return normalized;
  }

  getComparablePrice(symbol, price) {
    try { return String(this.exchange.priceToPrecision(symbol, price)); } catch { return String(roundNumber(price, 8)); }
  }

  effectiveGridLevelsEqual(symbol, oldLower, oldUpper, oldLevels, newLower, newUpper, newLevels) {
    try {
      const oldEffective = (Array.isArray(oldLevels) ? oldLevels : this.buildLevels(oldLower, oldUpper))
        .map(level => this.getComparablePrice(symbol, level));
      const newEffective = (Array.isArray(newLevels) ? newLevels : this.buildLevels(newLower, newUpper))
        .map(level => this.getComparablePrice(symbol, level));
      return oldEffective.length === newEffective.length && oldEffective.every((level, i) => level === newEffective[i]);
    } catch { return false; }
  }

  assertLevelsMeetMinimumProfit(symbol, levels) {
    const targetNetRate = GRID_MIN_NET_PROFIT_PCT / 100;
    const minimumRatio = (1 + targetNetRate + BINANCE_FUTURES_MAKER_FEE_RATE) /
      (1 - BINANCE_FUTURES_MAKER_FEE_RATE);
    const rounded = levels.map(level => {
      try { return Number(this.exchange.priceToPrecision(symbol, level)); } catch { return Number(level); }
    });
    for (let i = 1; i < rounded.length; i++) {
      if (rounded[i] / rounded[i - 1] + 1e-12 < minimumRatio) {
        throw new Error(
          `${symbol} grid step ${i - 1}->${i} does not cover futures fees plus ` +
          `GRID_MIN_NET_PROFIT_PCT=${GRID_MIN_NET_PROFIT_PCT}`
        );
      }
    }
  }

  getMinimumProfitableSellPrice(buy) {
    const amount = Number(buy?.sellableAmount ?? buy?.amount) || 0;
    const cost = (Number(buy?.totalCostQuote) || 0) + (Number(buy?.totalFeeQuote) || 0);
    if (!(amount > 0) || !(cost > 0)) return Infinity;
    return (cost / amount) * (1 + GRID_MIN_NET_PROFIT_PCT / 100) /
      (1 - BINANCE_FUTURES_MAKER_FEE_RATE);
  }

  isTrackedSellProfitable(symbol, buy, sellPrice) {
    let precise = Number(sellPrice);
    try { precise = Number(this.exchange.priceToPrecision(symbol, sellPrice)); } catch {}
    return precise + 1e-12 >= this.getMinimumProfitableSellPrice(buy);
  }

  getPositionEntryFloor(symbol) {
    if (!FUTURES_SELL_ENTRY_FLOOR_ENABLED) return 0;
    const position = this.latestPositions?.get(symbol);
    return Math.max(0, numberOrZero(position?.entryPrice ?? position?.info?.entryPrice));
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
    const [ticker, openOrders, balance, positions] = await Promise.all([
      retry(() => this.exchange.fetchTicker(symbol)),
      retry(() => this.exchange.fetchOpenOrders(symbol)),
      retry(() => this.exchange.fetchBalance()),
      retry(() => this.exchange.fetchPositions([symbol])),
    ]);
    const currentPrice = Number(ticker.last);
    if (!this.latestPositions) this.latestPositions = new Map();
    this.latestPositions.set(symbol, this.getActivePosition(positions, symbol));
    const range = await this.buildRange(symbol, currentPrice);
    const { lower, upper } = range;
    const levels = Array.isArray(range.levels)
      ? range.levels
      : this.buildLevels(lower, upper, symbol);
    return { ticker, currentPrice, openOrders, balance, positions, lower, upper, levels };
  }

  async getManagedOpenOrders(symbol, openOrders) {
    const symState = this.state.getSymbol(symbol);
    const managedIds = new Set(Object.keys(symState.orders));
    const managed = [];
    for (const order of openOrders) {
      const orderId = String(order.id);
      const orderMeta = this.getBotOrderMeta(order);
      if (!managedIds.has(orderId) && orderMeta) {
        await this.state.rememberOrder(symbol, order, orderMeta);
        managedIds.add(orderId);
        console.warn(
          `[RECOVER] ${symbol} adopted order ${orderId} level=${orderMeta.levelIndex} ` +
          `refill=${orderMeta.refillCount}`
        );
      }
      if (managedIds.has(orderId)) managed.push(order);
    }
    return managed;
  }

  getOrderClientId(order) {
    return String(order.clientOrderId || order.info?.clientOrderId || order.info?.origClientOrderId || '');
  }

  getOrderPositionSide(order) {
    const explicitSide = String(
      order.positionSide || order.info?.positionSide || order.info?.ps || ''
    ).toUpperCase();
    if (explicitSide === 'LONG' || explicitSide === 'SHORT') return explicitSide;
    const clientOrderId = this.getOrderClientId(order);
    if (clientOrderId.startsWith('sgrid-')) return 'SHORT';
    if (clientOrderId.startsWith('grid-')) return 'LONG';
    return '';
  }

  getAppliedFibonacciDirection(symbol) {
    const current = this.appliedFibonacciDirections?.get(symbol);
    if (current) return current;
    const persisted = this.state?.getSymbol?.(symbol)?.config?.rangeAdvisor?.directionApplied;
    return persisted || 'RANGING';
  }

  isEntrySidePreferred(symbol) {
    const direction = this.getAppliedFibonacciDirection(symbol);
    const shortPreferred = FUTURES_SHORT_ENTRY_DIRECTION === 'ALWAYS' ||
      direction === FUTURES_SHORT_ENTRY_DIRECTION;
    if (!this.mutualExclusionEnabled) {
      return POSITION_SIDE === 'LONG' || shortPreferred;
    }
    return POSITION_SIDE === 'SHORT' ? shortPreferred : !shortPreferred;
  }

  async getVolumeDeltaEntryDecision(symbol) {
    if (!VOLUME_DELTA_ENTRY_FILTER_ENABLED) return { allow: true, available: false, disabled: true };
    let analysis = null;
    let failure = null;
    try {
      analysis = await this.volumeDeltaAnalyzer.analyze(symbol);
    } catch (error) {
      failure = error;
    }
    const decision = evaluateVolumeDeltaEntry(analysis, POSITION_SIDE, {
      oppositionThresholdPct: VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT,
      failClosed: VOLUME_DELTA_FAIL_CLOSED,
    });
    const effectiveAllow = VOLUME_DELTA_ENTRY_FILTER_MODE !== 'LIVE' || decision.allow;
    const symState = this.state.getSymbol(symbol);
    const previousSnapshot = symState.config.volumeDeltaEntryGuard;
    const nextSnapshot = {
      enabled: true,
      mode: VOLUME_DELTA_ENTRY_FILTER_MODE,
      positionSide: POSITION_SIDE,
      timeframe: this.volumeDeltaAnalyzer.options.timeframe,
      lookbackCandles: VOLUME_DELTA_LOOKBACK_CANDLES,
      windowMinutes: Math.round(
        (this.volumeDeltaAnalyzer.options.timeframeMs * VOLUME_DELTA_LOOKBACK_CANDLES) / 60_000
      ),
      oppositionThresholdPct: VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT,
      failClosed: VOLUME_DELTA_FAIL_CLOSED,
      available: decision.available,
      allow: effectiveAllow,
      reason: decision.reason,
      deltaRatio: Number.isFinite(decision.deltaRatio) ? decision.deltaRatio : null,
      candleTimestamp: analysis?.timestamp || null,
      candleCloseTime: analysis?.closeTime || null,
      error: failure?.message || null,
    };
    const snapshotChanged = !previousSnapshot || Object.entries(nextSnapshot)
      .some(([key, value]) => previousSnapshot[key] !== value);
    if (snapshotChanged) {
      nextSnapshot.evaluatedAt = new Date().toISOString();
      symState.config.volumeDeltaEntryGuard = nextSnapshot;
      try {
        await this.state.save();
      } catch (error) {
        if (previousSnapshot === undefined) delete symState.config.volumeDeltaEntryGuard;
        else symState.config.volumeDeltaEntryGuard = previousSnapshot;
        console.warn(`[VOLUME-DELTA] ${symbol} could not persist dashboard snapshot: ${error.message}`);
      }
    }
    const logKey = [analysis?.timestamp || 'unavailable', decision.allow, failure?.message || ''].join('|');
    if (this.lastVolumeDeltaLog.get(symbol) !== logKey) {
      const deltaPct = Number.isFinite(decision.deltaRatio)
        ? `${roundNumber(decision.deltaRatio * 100, 3)}%`
        : 'unavailable';
      const action = effectiveAllow ? 'allow' : 'block';
      console.log(
        `[VOLUME-DELTA] ${symbol} ${POSITION_SIDE} mode=${VOLUME_DELTA_ENTRY_FILTER_MODE} ` +
        `delta=${deltaPct} threshold=${VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT}% action=${action}` +
        (failure ? ` error=${failure.message}` : '')
      );
      this.lastVolumeDeltaLog.set(symbol, logKey);
    }
    return { ...decision, allow: effectiveAllow, analysis, failure };
  }

  async findOppositeSideConflict(symbol) {
    const oppositePositionSide = POSITION_SIDE === 'SHORT' ? 'LONG' : 'SHORT';
    const oppositeEntrySide = oppositePositionSide === 'SHORT' ? 'sell' : 'buy';
    const [positions, openOrders] = await Promise.all([
      retry(() => this.exchange.fetchPositions([symbol])),
      retry(() => this.exchange.fetchOpenOrders(symbol)),
    ]);
    const position = positions.find(item => {
      const itemSymbol = item.symbol || item.info?.symbol;
      const itemSide = String(item.side || item.positionSide || item.info?.positionSide || '').toUpperCase();
      const contracts = Math.abs(Number(item.contracts ?? item.info?.positionAmt) || 0);
      return itemSymbol === symbol && itemSide === oppositePositionSide && contracts > 0;
    });
    if (position) return `${oppositePositionSide} position is still open`;

    const entryOrder = openOrders.find(order => {
      const side = String(order.side).toLowerCase();
      return this.getOrderPositionSide(order) === oppositePositionSide &&
        side === oppositeEntrySide && this.getOpenOrderRemainingAmount(order) > 0;
    });
    if (entryOrder) return `${oppositePositionSide} entry order ${entryOrder.id} is still open`;
    return null;
  }

  getBotOrderLevel(order) {
    return this.getBotOrderMeta(order)?.levelIndex ?? null;
  }

  getBotOrderMeta(order) {
    const clientOrderId = this.getOrderClientId(order);
    const pattern = POSITION_SIDE === 'SHORT'
      ? /^sgrid-[a-z0-9]+-([bs])-(\d+)(?:-e(\d+))?-(?:r(\d+)-)?/
      : /^grid-[a-z0-9]+-([bs])-(\d+)(?:-[be](\d+))?-(?:r(\d+)-)?/;
    const match = clientOrderId.match(pattern);
    if (!match) return null;
    const meta = {
      side: match[1] === 'b' ? 'buy' : 'sell',
      levelIndex: Number(match[2]),
      refillCount: Number(match[4]) || 0,
    };
    if (match[3] !== undefined) meta.sourceBuyLevelIndex = Number(match[3]);
    return meta;
  }

  makeClientOrderId(symbol, side, levelIndex, refillCount = 0, sourceBuyLevelIndex = null) {
    const market = symbol.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const source = side === EXIT_SIDE && sourceBuyLevelIndex !== null &&
      sourceBuyLevelIndex !== undefined && Number.isInteger(Number(sourceBuyLevelIndex))
      ? `-e${Number(sourceBuyLevelIndex)}`
      : '';
    return `${ORDER_ID_PREFIX}-${market}-${side[0]}-${levelIndex}${source}-r${refillCount}-${nonce}`.slice(0, 36);
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

  async cancelManagedBuyOrders(symbol, reason) {
    const result = { cancelled: [], failed: [] };
    if (!this.exchange?.fetchOpenOrders || !this.exchange?.cancelOrder) return result;
    const openOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    const managed = await this.getManagedOpenOrders(symbol, openOrders);
    for (const order of managed) {
      if (String(order.side).toLowerCase() !== 'buy') continue;
      try {
        await retry(() => this.exchange.cancelOrder(order.id, symbol));
        await this.state.forgetOrder(symbol, order.id);
        result.cancelled.push(String(order.id));
        console.log(`[CANCEL] ${symbol} buy ${order.id} | ${reason}; SELL exits preserved`);
      } catch (err) {
        result.failed.push({ id: String(order.id), error: err });
        console.warn(`[CANCEL] Failed to cancel ${symbol} BUY order ${order.id}: ${err.message}`);
      }
    }
    return result;
  }

  async cancelManagedEntryOrders(symbol, managedOrders, reason) {
    let changed = false;
    for (const order of managedOrders) {
      if (String(order.side).toLowerCase() !== ENTRY_SIDE) continue;
      try {
        await this.cancelOrder(symbol, order, `${reason}; ${EXIT_SIDE.toUpperCase()} exits preserved`);
        changed = true;
      } catch (err) {
        console.warn(
          `[MUTUAL] ${symbol} could not cancel ${ENTRY_SIDE.toUpperCase()} entry ${order.id}: ` +
          `${err.message}; ${EXIT_SIDE.toUpperCase()} exit reconciliation continues`
        );
      }
    }
    return changed;
  }

  async cancelOrder(symbol, order, reason) {
    if (!this.exchange?.cancelOrder) return;
    await retry(() => this.exchange.cancelOrder(order.id, symbol));
    await this.state.forgetOrder(symbol, order.id);
    console.log(`[CANCEL] ${symbol} ${order.side} ${order.id} | ${reason}`);
  }

  async createFuturesLimitOrder(
    symbol, side, amount, price, levelIndex, refillCount = 0, sourceBuyLevelIndex = null
  ) {
    const clientOrderId = this.makeClientOrderId(
      symbol, side, levelIndex, refillCount, sourceBuyLevelIndex
    );
    // Binance rejects reduceOnly in Hedge Mode. positionSide makes BUY/SELL
    // unambiguous: LONG opens with BUY and exits with SELL; SHORT is reversed.
    const orderParams = { newClientOrderId: clientOrderId, positionSide: POSITION_SIDE };
    if (GRID_POST_ONLY) {
      orderParams.postOnly = true;
    }
    // CCXT maps postOnly to Binance timeInForce=GTX. If Binance rejects an
    // immediately-marketable maker order, keep the rejection: silently
    // retrying without GTX would change the configured maker-only behavior.
    const submit = () => this.exchange.createLimitOrder(
      symbol,
      side,
      amount,
      price,
      orderParams
    );
    if (side !== ENTRY_SIDE) return submit();
    if (!this.isEntrySidePreferred(symbol)) {
      console.warn(
        `[MUTUAL] ${symbol} ${ENTRY_SIDE.toUpperCase()} entry blocked: ` +
        `${POSITION_SIDE} does not own direction ${this.getAppliedFibonacciDirection(symbol)}`
      );
      return null;
    }

    const verifyAndSubmit = () => this.withExposureLock(async () => {
      if (this.mutualExclusionEnabled) {
        let conflict;
        try {
          conflict = await this.findOppositeSideConflict(symbol);
        } catch (err) {
          console.warn(
            `[MUTUAL] ${symbol} ${ENTRY_SIDE.toUpperCase()} entry blocked: ` +
            `cannot verify opposite side (${err.message})`
          );
          return null;
        }
        if (conflict) {
          console.warn(`[MUTUAL] ${symbol} ${ENTRY_SIDE.toUpperCase()} entry blocked: ${conflict}`);
          return null;
        }
      }

      if (!this.exposureLimits) return submit();
      let exposure;
      try { exposure = await this.fetchExposure(); } catch (err) {
        console.warn(`[EXPOSURE] ${symbol} ${ENTRY_SIDE.toUpperCase()} blocked: cannot verify exposure (${err.message})`);
        return null;
      }
      const cost = Number(amount) * Number(price);
      if (exposure.values[symbol] + cost > this.exposureLimits.symbol + 1e-8 ||
          exposure.total + cost > this.exposureLimits.total + 1e-8) {
        console.warn(`[EXPOSURE] ${symbol} ${ENTRY_SIDE.toUpperCase()} blocked: symbol=${exposure.values[symbol]} total=${exposure.total} new=${cost}`);
        return null;
      }
      return submit();
    });

    if (!this.mutualExclusionEnabled) return verifyAndSubmit();
    try {
      return await this.mutualEntryMutex.run(symbol, verifyAndSubmit);
    } catch (err) {
      if (!err.crossProcessMutexAcquire) throw err;
      console.warn(
        `[MUTUAL] ${symbol} ${ENTRY_SIDE.toUpperCase()} entry blocked: ` +
        `cannot acquire cross-worker lock (${err.message})`
      );
      return null;
    }
  }

  async withExposureLock(fn) {
    const previous = this.exposureQueue || Promise.resolve();
    let release;
    this.exposureQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  async fetchExposure() {
    const groups = await Promise.all(SYMBOLS.map(symbol => this.exchange.fetchOpenOrders(symbol)));
    const orders = groups.flatMap((group, index) => group.map(order => ({ ...order, symbol: order.symbol || SYMBOLS[index] })));
    // Reading positions after orders conservatively counts fills during the snapshot twice.
    const positions = await this.exchange.fetchPositions(SYMBOLS);
    const exposure = exposureBySymbol(SYMBOLS, positions, orders, POSITION_SIDE);
    return { ...exposure, orders };
  }

  async trimExcessBuys(symbol) {
    if (!this.exposureLimits) return;
    await this.withExposureLock(async () => {
      let exposure = await this.fetchExposure();
      const managed = await this.getManagedOpenOrders(symbol, exposure.orders.filter(order => order.symbol === symbol));
      const buys = managed.filter(order => order.side === 'buy').sort((a, b) => Number(a.price) - Number(b.price));
      for (const order of buys) {
        if (exposure.values[symbol] <= this.exposureLimits.symbol + 1e-8 && exposure.total <= this.exposureLimits.total + 1e-8) break;
        await this.cancelOrder(symbol, order, 'exposure cap; preserve SELL exits');
        exposure = await this.fetchExposure();
      }
    });
  }

  async syncAccountIncome(symbol) {
    if (!this.exchange.fapiPrivateGetIncome) return;
    const sym = this.state.getSymbol(symbol);
    if (sym.accountIncome?.syncedAt && Date.now() - sym.accountIncome.syncedAt < 300000) return;
    try {
      sym.accountIncome = await syncIncome(this.exchange, sym.accountIncome, symbol, sym.createdAt);
      await this.state.save();
    } catch (err) {
      console.warn(`[ACCOUNTING] ${symbol} income unavailable: ${err.message}`);
    }
  }

  async placeLimit(
    symbol, side, levelIndex, price, amount,
    { refillCount = 0, sourceBuyLevelIndex = null } = {}
  ) {
    const pendingKey = `${symbol}|${side}|${levelIndex}|${sourceBuyLevelIndex ?? ''}`;
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

      if (side === EXIT_SIDE) {
        const entryFloor = this.getPositionEntryFloor(symbol);
        const violatesEntryGuard = POSITION_SIDE === 'LONG'
          ? entryFloor > 0 && preciseNum + 1e-12 < entryFloor
          : entryFloor > 0 && preciseNum - 1e-12 > entryFloor;
        if (violatesEntryGuard) {
          console.warn(
            `[SKIP] ${symbol} ${side.toUpperCase()} exit level=${levelIndex} price=${preciseNum} ` +
            `${POSITION_SIDE === 'LONG' ? 'below' : 'above'} position average entry ${entryFloor}`
          );
          return null;
        }
      }
      const minCost = this.getMinCost(symbol);
      if (minCost > 0 && notional < minCost - 1e-8) {
        console.warn(`[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} | notional ${notional.toFixed(8)} below min ${minCost}, skipping order (dust)`);
        return null;
      }

      if (!(preciseAmountNum > 0) || !(preciseNum > 0)) {
        console.warn(`[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} | amount or price rounded to zero`);
        return null;
      }

      const order = await this.createFuturesLimitOrder(
        symbol, side, preciseAmount, precisePrice, levelIndex, refillCount, sourceBuyLevelIndex
      );
      if (!order) return null;
      await this.state.rememberOrder(symbol, order, { levelIndex, refillCount, sourceBuyLevelIndex });
      const sourceLabel = side === 'sell' && sourceBuyLevelIndex !== null
        ? ` sourceBuy=${sourceBuyLevelIndex}`
        : '';
      console.log(`[GRID] ${symbol} ${side.toUpperCase()} level=${levelIndex}${sourceLabel} refill=${refillCount} amount=${preciseAmount} price=${precisePrice}${GRID_POST_ONLY ? ' (postOnly)' : ''}`);
      return order;
    } catch (err) {
      if (this.isMaxOpenOrdersError(err)) {
        if (side === ENTRY_SIDE) {
          console.warn(
            `[SKIP] ${symbol} ${ENTRY_SIDE.toUpperCase()} level=${levelIndex} | exchange open-order limit reached; ` +
            `preserving capacity for ${EXIT_SIDE.toUpperCase()} exits`
          );
          return null;
        }
        throw err;
      }
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

  isMaxOpenOrdersError(err) {
    const message = String(err?.message || err || '').toLowerCase();
    return String(err?.code || '') === '-2025' ||
      message.includes('-2025') ||
      message.includes('max open order') ||
      message.includes('maximum open order') ||
      message.includes('too many open orders');
  }

  getOpenOrderRemainingAmount(order) {
    const remaining = Number(order?.remaining);
    if (Number.isFinite(remaining) && remaining >= 0) return remaining;
    const amount = Math.max(0, Number(order?.amount) || 0);
    const filled = Math.max(0, Number(order?.filled) || 0);
    return Math.max(0, amount - filled);
  }

  getReservedSellAmount(openOrders) {
    return (openOrders || []).reduce((total, order) => {
      if (String(order?.side).toLowerCase() !== 'sell') return total;
      return total + this.getOpenOrderRemainingAmount(order);
    }, 0);
  }

  async cancelFarthestBuyForExit(symbol, referencePrice) {
    const openOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    const managed = await this.getManagedOpenOrders(symbol, openOrders);
    const candidate = managed
      .filter(order => String(order.side).toLowerCase() === 'buy')
      .sort((a, b) =>
        Math.abs(Number(b.price) - referencePrice) - Math.abs(Number(a.price) - referencePrice)
      )[0];
    if (!candidate) return false;
    await this.cancelOrder(symbol, candidate, 'free exchange order slot for priority SELL exit');
    return true;
  }

  async placeExitLimit(
    symbol, levelIndex, price, amount,
    { refillCount = 0, sourceBuyLevelIndex, referencePrice = price } = {}
  ) {
    const symState = this.state.getSymbol(symbol);
    const activeSellCount = this.countActiveOrders(symState, 'sell');
    if (activeSellCount >= GRID_MAX_ACTIVE_SELL_ORDERS) {
      console.warn(
        `[EXIT-PRIORITY] ${symbol} placing SELL sourceBuy=${sourceBuyLevelIndex} above configured ` +
        `soft threshold ${GRID_MAX_ACTIVE_SELL_ORDERS}`
      );
    }
    const options = { refillCount, sourceBuyLevelIndex };
    try {
      return await this.placeLimit(symbol, 'sell', levelIndex, price, amount, options);
    } catch (err) {
      if (!this.isMaxOpenOrdersError(err)) throw err;
      const freedSlot = await this.cancelFarthestBuyForExit(symbol, Number(referencePrice));
      if (!freedSlot) {
        throw new Error(
          `${symbol} priority SELL sourceBuy=${sourceBuyLevelIndex} could not be placed: ` +
          `exchange open-order limit reached and no managed BUY could be cancelled`,
          { cause: err }
        );
      }
      console.warn(
        `[EXIT-PRIORITY] ${symbol} retrying SELL sourceBuy=${sourceBuyLevelIndex} after cancelling a BUY`
      );
      return await this.placeLimit(symbol, 'sell', levelIndex, price, amount, options);
    }
  }

  async placeShortExitLimit(
    symbol, levelIndex, price, amount,
    { refillCount = 0, sourceEntryLevelIndex, referencePrice = price } = {}
  ) {
    const symState = this.state.getSymbol(symbol);
    if (this.countActiveOrders(symState, EXIT_SIDE) >= GRID_MAX_ACTIVE_SELL_ORDERS) {
      console.warn(
        `[EXIT-PRIORITY] ${symbol} placing SHORT BUY exit sourceEntry=${sourceEntryLevelIndex} ` +
        `above soft threshold ${GRID_MAX_ACTIVE_SELL_ORDERS}`
      );
    }
    const options = { refillCount, sourceBuyLevelIndex: sourceEntryLevelIndex };
    try {
      return await this.placeLimit(symbol, EXIT_SIDE, levelIndex, price, amount, options);
    } catch (err) {
      if (!this.isMaxOpenOrdersError(err)) throw err;
      const freedSlot = await this.cancelFarthestShortEntryForExit(symbol, Number(referencePrice));
      if (!freedSlot) throw err;
      return this.placeLimit(symbol, EXIT_SIDE, levelIndex, price, amount, options);
    }
  }

  async cancelFarthestShortEntryForExit(symbol, referencePrice) {
    const openOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    const managed = await this.getManagedOpenOrders(symbol, openOrders);
    const candidate = managed
      .filter(order => String(order.side).toLowerCase() === ENTRY_SIDE)
      .sort((a, b) =>
        Math.abs(Number(b.price) - referencePrice) - Math.abs(Number(a.price) - referencePrice)
      )[0];
    if (!candidate) return false;
    await this.cancelOrder(symbol, candidate, 'free exchange order slot for priority SHORT BUY exit');
    return true;
  }

  // Free margin available to open new positions, in the symbol's quote/margin
  // asset (USDT for USDⓈ-M futures). This replaces spot's "quote free
  // balance" - buying on margin doesn't spend the full notional up front,
  // only notional / LEVERAGE of it.
  getQuoteFree(balance, symbol) {
    return Number(balance?.free?.[this.getQuoteAsset(symbol)] || 0);
  }

  // Amount available to close on the configured Hedge Mode side.
  getBaseFree(positions, symbol) {
    const position = this.getActivePosition(positions, symbol);
    return Math.abs(Number(position?.contracts) || 0);
  }

  getActivePosition(positions, symbol) {
    return (positions || []).find(p =>
      p.symbol === symbol && (
        String(p.side || '').toUpperCase() === POSITION_SIDE ||
        String(p.info?.positionSide || '').toUpperCase() === POSITION_SIDE
      ) && Math.abs(Number(p.contracts) || 0) > 0
    );
  }

  getActiveLongPosition(positions, symbol) {
    return this.getActivePosition(positions, symbol);
  }

  getPositionRoiPct(position) {
    const exchangePercentage = Number(position?.percentage);
    if (Number.isFinite(exchangePercentage)) return exchangePercentage;

    const unrealizedPnl = Number(position?.unrealizedPnl ?? position?.info?.unRealizedProfit);
    const initialMargin = Number(position?.initialMargin ?? position?.info?.positionInitialMargin);
    if (!Number.isFinite(unrealizedPnl) || !(initialMargin > 0)) return null;
    return (unrealizedPnl / initialMargin) * 100;
  }

  async closeActiveLongPosition(symbol, reason) {
    const positions = await retry(() => this.exchange.fetchPositions([symbol]));
    const positionAmount = this.getBaseFree(positions, symbol);
    if (positionAmount <= 0) {
      this.roiCloseOrders?.delete(symbol);
      console.log(`[EXIT] ${symbol} has no active ${POSITION_SIDE} position | ${reason}`);
      return null;
    }

    const pendingClose = this.roiCloseOrders?.get(symbol);
    if (pendingClose) {
      let status = 'unknown';
      let filledAmount = 0;
      if (this.exchange.fetchOrder && pendingClose.id) {
        try {
          const remote = await retry(() => this.exchange.fetchOrder(pendingClose.id, symbol));
          status = String(remote?.status || remote?.info?.status || '').toLowerCase() || 'unknown';
          filledAmount = Number(remote?.filled ?? remote?.info?.executedQty) || 0;
        } catch (err) {
          throw new Error(`${symbol} could not verify pending ${POSITION_SIDE} close order ${pendingClose.id}: ${err.message}`, { cause: err });
        }
      }
      if (['open', 'new', 'partially_filled', 'pending', 'unknown'].includes(status)) {
        throw new Error(`${symbol} ${POSITION_SIDE} close order ${pendingClose.id || 'unknown'} is still pending; refusing duplicate exit`);
      }
      if (status === 'closed' && pendingClose.amount > 0 && filledAmount >= pendingClose.amount - 1e-8) {
        throw new Error(
          `${symbol} ${POSITION_SIDE} close order ${pendingClose.id || 'unknown'} was fully filled but the position is still reported active; refusing duplicate exit`
        );
      }
      this.roiCloseOrders.delete(symbol);
    }

    const preciseAmount = Number(this.exchange.amountToPrecision(symbol, positionAmount));
    if (!Number.isFinite(preciseAmount) || preciseAmount <= 0) {
      throw new Error(`Cannot close ${symbol} ${POSITION_SIDE}: invalid precise amount for position ${positionAmount}`);
    }

    const order = await retry(() => this.exchange.createOrder(
      symbol,
      'market',
      EXIT_SIDE,
      preciseAmount,
      undefined,
      {
        positionSide: POSITION_SIDE,
        newClientOrderId: this.makeClientOrderId(symbol, EXIT_SIDE, 'exit'),
      }
    ));
    if (!this.roiCloseOrders) this.roiCloseOrders = new Map();
    this.roiCloseOrders.set(symbol, {
      id: order?.id ? String(order.id) : null,
      amount: preciseAmount,
    });

    let remainingAmount = positionAmount;
    for (let attempt = 0; attempt < 5; attempt++) {
      const remainingPositions = await retry(() => this.exchange.fetchPositions([symbol]));
      remainingAmount = this.getBaseFree(remainingPositions, symbol);
      if (remainingAmount <= 0) break;
      if (attempt < 4) await sleep(250);
    }
    if (remainingAmount > 0) {
      throw new Error(
        `${symbol} ${POSITION_SIDE} close order ${order?.id || 'unknown'} left ${remainingAmount} contracts active`
      );
    }

    this.roiCloseOrders.delete(symbol);
    const symState = this.state.getSymbol(symbol);
    symState.lastBuyByLevel = {};
    await this.state.save();

    console.log(`[EXIT] ${symbol} closed ${POSITION_SIDE} ${preciseAmount} contracts at market | ${reason}`);
    return order;
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
        // Binance may remove a filled order from openOrders before the fill
        // appears in fetchMyTrades.  Do not replace that level prematurely:
        // only explicit cancellation/rejection is safe to forget here.
        let remote;
        try {
          remote = this.exchange.fetchOrder
            ? await retry(() => this.exchange.fetchOrder(orderId, symbol))
            : null;
        } catch (err) {
          console.warn(`[SYNC-STATE] ${symbol} keeping missing order ${orderId}: ${err.message}`);
          continue;
        }
        const status = String(remote?.status || remote?.info?.status || '').toLowerCase();
        const explicitlyCancelled = new Set(['canceled', 'cancelled', 'expired', 'rejected']).has(status);
        if (!explicitlyCancelled) {
          console.warn(
            `[SYNC-STATE] ${symbol} keeping missing order ${orderId} for fill reconciliation ` +
            `(status=${status || 'unknown'})`
          );
          continue;
        }
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
    const refillCount = Math.max(0, Number(orderMeta.refillCount) || 0);
    const feeCost = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const base = this.getBaseAsset(symbol);
    const quote = this.getQuoteAsset(symbol);
    const sellableAmount = this.amountAfterBuyFee(symbol, trade);
    const costQuote = price * amount;
    const feeQuote = this.feeToQuote(feeCost, feeCurrency, price, base, quote);
    symState.refillCountByLevel ||= {};

    symState.lastBuyByLevel[levelIndex] = this.mergeBuyRecords(
      symState.lastBuyByLevel[levelIndex],
      {
        price,
        amount,
        sellableAmount,
        totalCostQuote: costQuote,
        totalFeeQuote: feeQuote,
        refillCount,
        at: trade.datetime,
      }
    );
    symState.refillCountByLevel[levelIndex] = refillCount;
    symState.filledBuys = numberOrZero(symState.filledBuys) + 1;
    this.state.data.totals.filledBuys++;
    symState.tradingFees += feeQuote;
    this.state.data.totals.tradingFees += feeQuote;
    this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
    // All mutations for this fill are applied in-memory first and persisted
    // together in ONE save(). If the process crashes anywhere above this
    // line, none of it was written and the fill is reprocessed cleanly next
    // cycle; if it crashes anywhere below, all of it was written and the
    // trade is correctly marked processed. There is no window where the buy
    // record/order bookkeeping is saved but the trade is not (or vice
    // versa), which is what previously allowed a crash to cause double
    // counting of the same fill.
    this.state.markProcessedTradeLocal(symbol, this.getTradeId(trade));
    await this.state.save();
    await this.sendAlert([
      `[BUY] ${symbol}`,
      `${displayNumber(amount, 8)} @ ${displayNumber(price, 8)}`,
      `Fee: ${signedUsdt(feeQuote)}`,
    ].join('\n'));
    if (!GRID_REFILL_ON_FILLED || !this.canPlaceNewOrders() || !levels.length) return;
    const trackedBuy = symState.lastBuyByLevel[levelIndex];
    const totalSellable = Math.max(0, Number(trackedBuy?.sellableAmount ?? trackedBuy?.amount) || 0);
    if (!(totalSellable > 0)) {
      console.warn(`[SKIP] ${symbol} SELL sourceBuy=${levelIndex} | sellable amount zero after fee`);
      return;
    }

    await this.syncManagedOrdersWithExchange(symbol, symState, openOrderIds);
    const existingOrder = this.getActiveSellOrderForBuyLevel(symState, levelIndex);
    const target = this.findSellTargetForBuy(symbol, levels, levelIndex, trackedBuy, {
      amount: totalSellable,
    });
    if (!target) {
      this.warnNoSellTarget(symbol, levelIndex, levels, trackedBuy, totalSellable);
      return;
    }
    this.clearSellTargetWarning(symbol, levelIndex);

    if (existingOrder) {
      const existingAmount = Number(existingOrder?.amount || 0);
      const { preciseAmount: preciseTotalSellable } = this.getPreciseOrderNumbers(
        symbol, target.sellPrice, totalSellable
      );
      const preciseTotalNum = Number(preciseTotalSellable);
      if (Number(existingOrder.levelIndex) !== target.sellLevelIndex || preciseTotalNum > existingAmount + 1e-8) {
        console.log(
          `[UPDATE] ${symbol} SELL sourceBuy=${levelIndex} level=${existingOrder.levelIndex}->${target.sellLevelIndex} ` +
          `amount=${existingAmount}->${preciseTotalNum}`
        );
        try {
          await this.cancelOrder(symbol, existingOrder, `sell target update sourceBuy=${levelIndex}`);
          await this.placeExitLimit(symbol, target.sellLevelIndex, target.sellPrice, totalSellable, {
            refillCount, sourceBuyLevelIndex: levelIndex, referencePrice: price,
          });
        } catch (err) {
          console.warn(`[UPDATE] ${symbol} SELL sourceBuy=${levelIndex} cancel+replace failed: ${err.message}`);
        }
      } else {
        console.warn(`[SKIP] ${symbol} SELL sourceBuy=${levelIndex} | sell order already active with sufficient amount`);
      }
      return;
    }

    await this.placeExitLimit(symbol, target.sellLevelIndex, target.sellPrice, totalSellable, {
      refillCount, sourceBuyLevelIndex: levelIndex, referencePrice: price,
    });
  }

  async handleSellFill(symbol, levels, symState, trade, orderMeta, openOrderIds) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const levelIndex = Number(orderMeta.levelIndex);
    const buyLevelIndex = this.getSellSourceBuyLevelIndex(orderMeta);
    const buy = symState.lastBuyByLevel[buyLevelIndex];
    if (!buy) {
      console.warn(`[SELL] ${symbol} level ${levelIndex} has no corresponding buy record. Skipping profit calculation.`);
      return this.deferUnreconciledSell(
        symbol, symState, trade, orderMeta,
        'Corresponding buy record was not found; accounting requires review'
      );
    }

    const base = this.getBaseAsset(symbol);
    const quote = this.getQuoteAsset(symbol);
    symState.refillCountByLevel ||= {};
    const feeCost = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const proceedsQuote = price * amount;
    const feeQuote = this.feeToQuote(feeCost, feeCurrency, price, base, quote);
    const totalBuyAmount = buy.amount;
    const sellableAtBuy = buy.sellableAmount ?? totalBuyAmount;
    if (!(sellableAtBuy > 0)) {
      console.warn(`[SELL] ${symbol} level ${levelIndex} buy record has zero sellable amount. Skipping profit calculation.`);
      return this.deferUnreconciledSell(
        symbol, symState, trade, orderMeta,
        'Tracked buy has zero sellable amount; accounting requires review'
      );
    }
    if (amount > sellableAtBuy + 1e-8) {
      return this.deferUnreconciledSell(
        symbol, symState, trade, orderMeta,
        `Sell amount ${amount} exceeds tracked sellable amount ${sellableAtBuy}`
      );
    }
    const proportion = Math.min(amount / sellableAtBuy, 1.0);
    const allocatedBuyCost = buy.totalCostQuote * proportion;
    const allocatedBuyFee = buy.totalFeeQuote * proportion;
    const profit = (proceedsQuote - feeQuote) - (allocatedBuyCost + allocatedBuyFee);
    const refillCount = Math.max(0, Number(orderMeta.refillCount ?? buy.refillCount) || 0);
    const stagedExitChild = buy.stagedExitChild === true;

    symState.realizedGridProfit += profit;
    this.state.data.totals.realizedGridProfit += profit;
    symState.tradingFees += feeQuote;
    this.state.data.totals.tradingFees += feeQuote;
    symState.filledSells = numberOrZero(symState.filledSells) + 1;
    this.state.data.totals.filledSells++;
    if (!stagedExitChild) symState.refillCountByLevel[buyLevelIndex] = refillCount;
    this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
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
      if (stagedExitChild) delete symState.refillCountByLevel[buyLevelIndex];
    }
    // Single atomic save for profit totals, buy-record update, order
    // bookkeeping, and the processed-trade marker - see handleBuyFill for
    // why this matters (no more partial-fill persistence on crash).
    const tradeId = this.getTradeId(trade);
    if (symState.unreconciledSells) delete symState.unreconciledSells[tradeId];
    this.state.markProcessedTradeLocal(symbol, tradeId);
    await this.state.save();
    await this.sendAlert(sellFillMessage({ symbol, price, amount,
      realizedPnl: trade.info?.realizedPnl ?? trade.info?.realizedProfit,
      fee: feeQuote, gridProfit: profit }));

    if (stagedExitChild) {
      console.log(
        `[EXIT-LADDER] ${symbol} staged SELL part=${buy.stagedExitPart}/${buy.stagedExitParts} ` +
        `filled amount=${amount}; immediate refill skipped`
      );
      return;
    }

    if (GRID_REFILL_ON_FILLED && this.canPlaceNewOrders() && buyLevelIndex >= 0) {
      const nextRefillCount = refillCount + 1;
      if (nextRefillCount > GRID_MAX_REFILLS) {
        console.warn(
          `[SKIP] ${symbol} BUY refill level=${buyLevelIndex} | max refill ${GRID_MAX_REFILLS} reached`
        );
        return;
      }
      const buyPrice = levels[buyLevelIndex];
      if (!(buyPrice > 0)) return;
      if (this.hasActiveOrderAtLevel(symState, 'buy', buyLevelIndex)) {
        console.warn(`[SKIP] ${symbol} BUY refill level=${buyLevelIndex} | buy order already active`);
        return;
      }
      if (this.countActiveOrders(symState, 'buy') >= GRID_MAX_ACTIVE_BUY_ORDERS) {
        console.warn(`[SKIP] ${symbol} BUY refill level=${buyLevelIndex} | active buy order limit reached`);
        return;
      }
      const recommendation = this.getAdaptiveRecommendation(symbol);
      const adaptiveLevel = recommendation
        ? this.getBuyPlacementLevels(symbol, levels, price, GRID_MAX_ACTIVE_BUY_ORDERS)
          .find(level => level.index === buyLevelIndex)
        : null;
      if (recommendation && !adaptiveLevel) {
        console.log(
          `[ADAPTIVE-LIVE] ${symbol} BUY refill level=${buyLevelIndex} skipped by ` +
          `${recommendation.profile} spacing policy`
        );
        return;
      }
      const adaptiveWeight = Number(adaptiveLevel?.weight);
      const weight = Number.isFinite(adaptiveWeight) ? adaptiveWeight : 1;
      const remainingInvestmentUsdt = this.getRemainingInvestmentUsdt(symbol);
      let amountToBuy = this.amountForBuy(symbol, buyPrice, remainingInvestmentUsdt, weight);
      let cost = amountToBuy * buyPrice;
      if (!(amountToBuy > 0)) {
        console.warn(
          `[SKIP] ${symbol} BUY refill level=${buyLevelIndex} | adaptive minimum or investment cap reached`
        );
        return;
      }
      const minCost = this.getMinCost(symbol);
      if (minCost > 0 && cost < minCost - 1e-8) {
        amountToBuy = minCost / buyPrice;
        cost = amountToBuy * buyPrice;
        if (cost < minCost - 1e-8) {
          console.warn(`[SKIP] ${symbol} BUY refill level=${buyLevelIndex} | cannot meet min notional ${minCost}`);
          return;
        }
      }
      const precise = this.getPreciseOrderNumbers(symbol, buyPrice, amountToBuy);
      if (precise.notional > remainingInvestmentUsdt + 1e-8) {
        console.warn(
          `[SKIP] ${symbol} BUY refill level=${buyLevelIndex} | rounded cost ${precise.notional.toFixed(8)} exceeds remaining investment ${roundNumber(remainingInvestmentUsdt, 8)}`
        );
        return;
      }
      await this.placeLimit(symbol, 'buy', buyLevelIndex, buyPrice, amountToBuy, {
        refillCount: nextRefillCount,
      });
    }
  }

  async handleShortEntryFill(symbol, levels, symState, trade, orderMeta, openOrderIds) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const levelIndex = Number(orderMeta.levelIndex);
    const refillCount = Math.max(0, Number(orderMeta.refillCount) || 0);
    const feeQuote = this.feeToQuote(
      this.getTradeFeeCost(trade), this.getTradeFeeCurrency(trade), price,
      this.getBaseAsset(symbol), this.getQuoteAsset(symbol)
    );
    symState.refillCountByLevel ||= {};
    symState.lastBuyByLevel[levelIndex] = this.mergeBuyRecords(
      symState.lastBuyByLevel[levelIndex],
      {
        price,
        amount,
        sellableAmount: amount,
        totalCostQuote: price * amount,
        totalFeeQuote: feeQuote,
        refillCount,
        at: trade.datetime,
      }
    );
    symState.refillCountByLevel[levelIndex] = refillCount;
    symState.filledSells = numberOrZero(symState.filledSells) + 1;
    this.state.data.totals.filledSells++;
    symState.tradingFees += feeQuote;
    this.state.data.totals.tradingFees += feeQuote;
    this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
    this.state.markProcessedTradeLocal(symbol, this.getTradeId(trade));
    await this.state.save();
    await this.sendAlert([
      `[SHORT ENTRY] ${symbol}`,
      `${displayNumber(amount, 8)} @ ${displayNumber(price, 8)}`,
      `Fee: ${signedUsdt(feeQuote)}`,
    ].join('\n'));

    if (!this.canPlaceNewOrders() || !levels.length) return;
    const trackedEntry = symState.lastBuyByLevel[levelIndex];
    const exitAmount = Math.max(0, Number(trackedEntry?.sellableAmount ?? trackedEntry?.amount) || 0);
    if (!(exitAmount > 0)) return;
    await this.syncManagedOrdersWithExchange(symbol, symState, openOrderIds);
    const existingOrder = this.getActiveShortExitForEntry(symState, levelIndex);
    const target = this.findBuyTargetForShort(symbol, levels, levelIndex, trackedEntry, {
      amount: exitAmount,
    });
    if (!target) {
      this.warnNoShortExitTarget(symbol, levelIndex, levels, trackedEntry, exitAmount);
      return;
    }
    this.clearSellTargetWarning(symbol, levelIndex);
    if (existingOrder) return;
    await this.placeShortExitLimit(
      symbol, target.buyLevelIndex, target.buyPrice, exitAmount,
      { refillCount, sourceEntryLevelIndex: levelIndex, referencePrice: price }
    );
  }

  async handleShortExitFill(symbol, levels, symState, trade, orderMeta, openOrderIds) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const exitLevelIndex = Number(orderMeta.levelIndex);
    const entryLevelIndex = this.getSellSourceBuyLevelIndex(orderMeta);
    const entry = symState.lastBuyByLevel[entryLevelIndex];
    if (!entry) {
      throw new Error(
        `${symbol} SHORT BUY exit level ${exitLevelIndex} has no entry record at level ${entryLevelIndex}`
      );
    }
    const trackedAmount = Number(entry.sellableAmount ?? entry.amount) || 0;
    if (!(trackedAmount > 0) || amount > trackedAmount + 1e-8) {
      throw new Error(
        `${symbol} SHORT BUY exit amount ${amount} exceeds tracked amount ${trackedAmount}`
      );
    }
    const feeQuote = this.feeToQuote(
      this.getTradeFeeCost(trade), this.getTradeFeeCurrency(trade), price,
      this.getBaseAsset(symbol), this.getQuoteAsset(symbol)
    );
    const proportion = Math.min(amount / trackedAmount, 1);
    const allocatedEntryProceeds = Number(entry.totalCostQuote) * proportion;
    const allocatedEntryFee = Number(entry.totalFeeQuote) * proportion;
    const profit = (allocatedEntryProceeds - allocatedEntryFee) - (price * amount + feeQuote);
    const refillCount = Math.max(0, Number(orderMeta.refillCount ?? entry.refillCount) || 0);

    symState.realizedGridProfit += profit;
    this.state.data.totals.realizedGridProfit += profit;
    symState.tradingFees += feeQuote;
    this.state.data.totals.tradingFees += feeQuote;
    symState.filledBuys = numberOrZero(symState.filledBuys) + 1;
    this.state.data.totals.filledBuys++;
    symState.refillCountByLevel ||= {};
    symState.refillCountByLevel[entryLevelIndex] = refillCount;
    this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
    const remaining = trackedAmount - amount;
    if (remaining > 1e-12) {
      const remainingRatio = remaining / trackedAmount;
      symState.lastBuyByLevel[entryLevelIndex] = {
        ...entry,
        sellableAmount: remaining,
        amount: Number(entry.amount) * remainingRatio,
        totalCostQuote: Number(entry.totalCostQuote) * remainingRatio,
        totalFeeQuote: Number(entry.totalFeeQuote) * remainingRatio,
      };
    } else {
      delete symState.lastBuyByLevel[entryLevelIndex];
    }
    this.state.markProcessedTradeLocal(symbol, this.getTradeId(trade));
    await this.state.save();
    await this.sendAlert([
      `[SHORT EXIT] ${symbol}`,
      `${displayNumber(amount, 8)} @ ${displayNumber(price, 8)}`,
      `Grid PnL: ${signedUsdt(profit)}`,
      `Fee: ${signedUsdt(feeQuote)}`,
    ].join('\n'));

    if (!GRID_REFILL_ON_FILLED || !this.canPlaceNewOrders()) return;
    const nextRefillCount = refillCount + 1;
    if (nextRefillCount > GRID_MAX_REFILLS) return;
    const entryPrice = Number(levels[entryLevelIndex]);
    if (!(entryPrice > 0) || this.hasActiveOrderAtLevel(symState, ENTRY_SIDE, entryLevelIndex)) return;
    if (this.countActiveOrders(symState, ENTRY_SIDE) >= GRID_MAX_ACTIVE_BUY_ORDERS) return;
    const remainingInvestment = this.getRemainingInvestmentUsdt(symbol);
    const refillAmount = this.amountForBuy(symbol, entryPrice, remainingInvestment, 1);
    if (!(refillAmount > 0)) return;
    await this.placeLimit(symbol, ENTRY_SIDE, entryLevelIndex, entryPrice, refillAmount, {
      refillCount: nextRefillCount,
    });
  }

  getTradeId(trade) {
    return String(trade.id || `${trade.order}-${trade.timestamp}`);
  }

  // Mutates symState.orders in memory only - no persistence. See
  // markProcessedTradeLocal() for why: handlers that make several related
  // mutations for one fill batch them all and save() once at the end.
  forgetOrderIfClosedLocal(symState, trade, openOrderIds) {
    if (!openOrderIds.has(String(trade.order))) {
      delete symState.orders[String(trade.order)];
      return true;
    }
    return false;
  }

  consumeTrackedPositionForExit(symState, exitAmount) {
    const entries = Object.entries(symState.lastBuyByLevel || {});
    const trackedAmount = entries.reduce(
      (sum, [, entry]) => sum + Math.max(0, Number(entry.sellableAmount ?? entry.amount) || 0),
      0
    );
    const amount = Math.max(0, Number(exitAmount) || 0);
    if (!(trackedAmount > 0) || !(amount > 0)) return 0;

    const consumedRatio = Math.min(amount / trackedAmount, 1);
    let allocatedEntryFee = 0;
    for (const [levelIndex, entry] of entries) {
      const entryFee = Math.max(0, Number(entry.totalFeeQuote) || 0);
      allocatedEntryFee += entryFee * consumedRatio;
      const remainingRatio = 1 - consumedRatio;
      if (remainingRatio <= 1e-12) {
        delete symState.lastBuyByLevel[levelIndex];
        continue;
      }
      symState.lastBuyByLevel[levelIndex] = {
        ...entry,
        amount: (Number(entry.amount) || 0) * remainingRatio,
        sellableAmount: (Number(entry.sellableAmount ?? entry.amount) || 0) * remainingRatio,
        totalCostQuote: (Number(entry.totalCostQuote) || 0) * remainingRatio,
        totalFeeQuote: entryFee * remainingRatio,
      };
    }
    return allocatedEntryFee;
  }

  async handleExitFill(symbol, symState, trade, openOrderIds) {
    const price = Number(trade.price);
    const base = this.getBaseAsset(symbol);
    const quote = this.getQuoteAsset(symbol);
    const feeQuote = this.feeToQuote(
      this.getTradeFeeCost(trade),
      this.getTradeFeeCurrency(trade),
      price,
      base,
      quote
    );
    const realizedPnl = Number(trade.info?.realizedPnl ?? trade.info?.realizedProfit ?? 0);
    const allocatedEntryFee = this.consumeTrackedPositionForExit(symState, trade.amount);
    const netExitProfit = realizedPnl - feeQuote - allocatedEntryFee;

    symState.realizedExitProfit += netExitProfit;
    symState.tradingFees += feeQuote;
    this.state.data.totals.realizedExitProfit += netExitProfit;
    this.state.data.totals.tradingFees += feeQuote;
    if (EXIT_SIDE === 'buy') {
      symState.filledBuys = numberOrZero(symState.filledBuys) + 1;
      this.state.data.totals.filledBuys++;
    } else {
      symState.filledSells = numberOrZero(symState.filledSells) + 1;
      this.state.data.totals.filledSells++;
    }
    this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
    this.state.markProcessedTradeLocal(symbol, this.getTradeId(trade));
    await this.state.save();
    await this.sendAlert(sellFillMessage({ symbol, price, amount: trade.amount,
      realizedPnl: trade.info?.realizedPnl ?? trade.info?.realizedProfit, fee: feeQuote }));
  }

  async syncFundingHistory(symbol, { force = false } = {}) {
    if (!this.exchange?.fetchFundingHistory) return 0;
    const now = Date.now();
    const lastSyncAt = this.lastFundingSyncAt?.get(symbol) || 0;
    if (!force && now - lastSyncAt < FUNDING_SYNC_INTERVAL_MS) return 0;
    if (!this.lastFundingSyncAt) this.lastFundingSyncAt = new Map();

    const symState = this.state.getSymbol(symbol);
    const since = symState.lastFundingTimestamp || Date.parse(symState.createdAt) || now;
    let entries;
    try {
      entries = await retry(() => this.exchange.fetchFundingHistory(symbol, since, 1000));
    } catch (err) {
      this.lastFundingSyncAt.set(symbol, now);
      console.warn(`[FUNDING] ${symbol} sync failed: ${err.message}`);
      return 0;
    }
    let fundingDelta = 0;
    let maxTimestamp = symState.lastFundingTimestamp || 0;

    for (const entry of entries || []) {
      const timestamp = Number(entry.timestamp) || 0;
      const rawIncome = Number(entry.info?.income);
      const signedAmount = Number.isFinite(rawIncome)
        ? rawIncome
        : (String(entry.direction).toLowerCase() === 'out' ? -1 : 1) * (Number(entry.amount) || 0);
      const id = String(entry.id || `${timestamp}-${signedAmount}-${entry.currency || ''}`);
      maxTimestamp = Math.max(maxTimestamp, timestamp);
      if (this.state.processedFunding(symbol, id)) continue;

      symState.fundingProfit += signedAmount;
      this.state.data.totals.fundingProfit += signedAmount;
      this.state.markProcessedFundingLocal(symbol, id);
      fundingDelta += signedAmount;
    }

    if (maxTimestamp > symState.lastFundingTimestamp) symState.lastFundingTimestamp = maxTimestamp;
    if (entries?.length) await this.state.save();
    this.lastFundingSyncAt.set(symbol, now);
    return fundingDelta;
  }

  async forgetOrderIfClosed(symState, trade, openOrderIds) {
    if (this.forgetOrderIfClosedLocal(symState, trade, openOrderIds)) {
      await this.state.save();
    }
  }

  // Fetches trades since symState.lastTradeTimestamp. By default this does
  // NOT advance/persist lastTradeTimestamp itself — that is the caller's
  // responsibility, and should only happen after the returned trades have
  // been fully and successfully processed (see handleFilledTrades). This
  // prevents permanently losing a fill if processing throws partway through:
  // if the timestamp were advanced here (before processing), a failed trade
  // would never be re-fetched on the next cycle. Pass
  // { updateTimestamp: true } to opt back into the old fetch-and-advance
  // behavior for callers that don't need this guarantee.
  async fetchNewTrades(symbol, symState, { updateTimestamp = false } = {}) {
    // Binance Futures treats `since=0` as an empty query. Omit the since
    // parameter on the first reconciliation so fills from before the bot
    // started can be recovered and attributed to their grid orders.
    const lastTradeTimestamp = Number(symState.lastTradeTimestamp) || 0;
    const since = lastTradeTimestamp > 0 ? lastTradeTimestamp : undefined;
    let allTrades = [];
    let from = since;
    let fromId = null;
    let maxIterations = 10;
    let iteration = 0;
    while (iteration < maxIterations) {
      const trades = await retry(() => fromId === null
        ? this.exchange.fetchMyTrades(symbol, from, TRADE_FETCH_LIMIT)
        : this.exchange.fetchMyTrades(symbol, undefined, TRADE_FETCH_LIMIT, { fromId }));
      if (!trades.length) break;
      allTrades = allTrades.concat(trades);
      const lastTimestamp = trades[trades.length - 1].timestamp;
      if (trades.length < TRADE_FETCH_LIMIT) break;
      const lastId = String(trades[trades.length - 1].id ?? '');
      if (/^\d+$/.test(lastId)) {
        // Binance IDs advance even when a page ends within one millisecond.
        const nextId = (BigInt(lastId) + 1n).toString();
        if (fromId !== null && BigInt(nextId) <= BigInt(fromId)) {
          throw new Error(`Trade pagination did not advance for ${symbol}`);
        }
        fromId = nextId;
        iteration++;
        await sleep(200);
        continue;
      }
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
        return tradeFetchResult(allTrades, true);
      }
      from = lastTimestamp;
      iteration++;
      await sleep(200);
    }
    if (updateTimestamp && allTrades.length) {
      const maxTs = Math.max(...allTrades.map(t => t.timestamp));
      symState.lastTradeTimestamp = maxTs;
      await this.state.save();
    }
    return tradeFetchResult(allTrades);
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
    // Note: fetchNewTrades does NOT advance symState.lastTradeTimestamp here.
    // We only do that below, after every trade below has been processed
    // without throwing — otherwise a failure partway through this batch
    // would permanently skip the unprocessed trades on the next cycle.
    const [tradeFetch, openOrders] = await Promise.all([
      this.fetchNewTrades(symbol, symState, { updateTimestamp: false }),
      preloadedOpenOrders
        ? Promise.resolve(preloadedOpenOrders)
        : retry(() => this.exchange.fetchOpenOrders(symbol)),
    ]);
    const { trades, holdWatermark } = tradeFetch;
    const openOrderIds = new Set(openOrders.map(order => String(order.id)));
    // A single closed Binance order can be represented by several trade
    // fills. Preserve its metadata for the whole batch even after the first
    // fill removes the closed order from persistent state.
    const orderMetadataById = new Map(Object.entries(symState.orders));
    for (const trade of trades.sort((a, b) => a.timestamp - b.timestamp)) {
      const id = this.getTradeId(trade);
      if (this.state.processedTrade(symbol, id)) continue;
      const tradePositionSide = String(trade.info?.positionSide || '').toUpperCase();
      if (tradePositionSide && tradePositionSide !== POSITION_SIDE) {
        this.state.markProcessedTradeLocal(symbol, id);
        continue;
      }
      const side = String(trade.side).toLowerCase();

      // Attempt to get order metadata from state, falling back to clientOrderId
      // embedded in the trade so fills are never lost across restarts.
      const tradeOrderId = String(trade.order);
      let orderMeta = orderMetadataById.get(tradeOrderId) || symState.orders[tradeOrderId];
      if (!orderMeta) {
        // clientOrderId format: grid-<market>-<s|b>-<levelIndex>-r<refillCount>-<nonce>
        const clientId = String(
          trade.info?.clientOrderId ||
          trade.info?.origClientOrderId ||
          trade.clientOrderId ||
          ''
        );
        if (!clientId && this.exchange.fetchOrder) {
          try {
            const closedOrder = await retry(() => this.exchange.fetchOrder(tradeOrderId, symbol));
            const recoveredClientId = String(
              closedOrder?.clientOrderId ||
              closedOrder?.info?.clientOrderId ||
              closedOrder?.info?.origClientOrderId ||
              ''
            );
            if (recoveredClientId) {
              trade.clientOrderId = recoveredClientId;
              trade.info = { ...(trade.info || {}), clientOrderId: recoveredClientId };
            }
          } catch (err) {
            throw new Error(`Cannot recover ${symbol} filled order ${tradeOrderId}: ${err.message}`, { cause: err });
          }
        }
        const resolvedClientId = String(
          trade.info?.clientOrderId || trade.clientOrderId || clientId
        );
        if (!resolvedClientId && side === EXIT_SIDE) {
          console.warn(
            `[MANUAL-EXIT] ${symbol} ${POSITION_SIDE} trade ${id} has no bot clientOrderId; ` +
            'recording Binance realized PnL and consuming tracked position inventory'
          );
          await this.handleExitFill(symbol, symState, trade, openOrderIds);
          continue;
        }
        if (!resolvedClientId) throw new Error(`Missing clientOrderId for ${symbol} filled order ${tradeOrderId}`);
        const recoveredMeta = this.getBotOrderMeta({ clientOrderId: resolvedClientId });
        if (recoveredMeta) {
          orderMeta = recoveredMeta;
          orderMetadataById.set(tradeOrderId, recoveredMeta);
          console.warn(
            `[RECOVER] ${symbol} reconstructed orderMeta for trade ${id} ` +
            `from clientOrderId="${resolvedClientId}" (level=${orderMeta.levelIndex}, ` +
            `side=${orderMeta.side}, refill=${orderMeta.refillCount})`
          );
        } else if (resolvedClientId.startsWith(`${ORDER_ID_PREFIX}-`) &&
            resolvedClientId.includes(`-${EXIT_SIDE[0]}-exit-`)) {
          orderMeta = { side: EXIT_SIDE, isPositionExit: true };
        } else if (side === EXIT_SIDE) {
          console.warn(
            `[MANUAL-EXIT] ${symbol} ${POSITION_SIDE} trade ${id} is not a bot order; ` +
            'recording Binance realized PnL and consuming tracked position inventory'
          );
          await this.handleExitFill(symbol, symState, trade, openOrderIds);
          continue;
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

      if (side === EXIT_SIDE && !orderMeta.isPositionExit) {
        orderMeta = this.remapDelayedSellOrderMeta(symbol, symState, trade, orderMeta);
        orderMetadataById.set(tradeOrderId, orderMeta);
      }
      if (orderMeta.isPositionExit) {
        await this.handleExitFill(symbol, symState, trade, openOrderIds);
      } else if (POSITION_SIDE === 'SHORT' && side === ENTRY_SIDE) {
        await this.handleShortEntryFill(symbol, levels, symState, trade, orderMeta, openOrderIds);
      } else if (POSITION_SIDE === 'SHORT' && side === EXIT_SIDE) {
        await this.handleShortExitFill(symbol, levels, symState, trade, orderMeta, openOrderIds);
      } else if (side === 'buy') {
        await this.handleBuyFill(symbol, levels, symState, trade, orderMeta, openOrderIds);
      } else if (side === 'sell') {
        await this.handleSellFill(symbol, levels, symState, trade, orderMeta, openOrderIds);
      } else {
        this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
        this.state.markProcessedTradeLocal(symbol, id);
        await this.state.save();
      }
    }
    if (POSITION_SIDE === 'LONG') {
      await this.retryUnreconciledSells(symbol, levels, symState, openOrderIds);
    }
    // Every trade in this batch was processed without throwing — safe to
    // advance the watermark now so these trades aren't re-fetched. If any
    // handler above had thrown, execution would never reach here, so
    // lastTradeTimestamp stays put and the same trades (including the
    // failed one) are retried next cycle; already-processed ones among them
    // are skipped via processedTrade() deduplication.
    if (trades.length && !holdWatermark) {
      const maxTs = Math.max(...trades.map(t => t.timestamp));
      if (maxTs > (symState.lastTradeTimestamp || 0)) {
        symState.lastTradeTimestamp = maxTs;
        await this.state.save();
      }
    }
    await this.syncManagedOrdersWithExchange(symbol, symState, openOrderIds);
  }

  async enforceRangeExits(symbol, _currentPrice, positions = []) {
    const activeLong = this.getActivePosition(positions, symbol);
    const exitAlreadyRequested = this.roiExitedSymbols?.has(symbol) || false;
    if (exitAlreadyRequested && !activeLong) {
      this.roiCloseOrders?.delete(symbol);
      const exit = this.roiExitReasons?.get(symbol) || {
        exitType: 'exit',
        triggerRoi: null,
      };
      const symState = this.state.getSymbol(symbol);
      if (Object.keys(symState.lastBuyByLevel || {}).length) {
        symState.lastBuyByLevel = {};
        await this.state.save();
      }
      await this.sendRoiExitAlert(symbol, exit);
      return false;
    }
    const roiPct = this.getPositionRoiPct(activeLong);
    if (!activeLong || (!exitAlreadyRequested && roiPct === null)) return true;

    const takeProfitTriggered = TAKE_PROFIT_ROI_PCT > 0 && roiPct >= TAKE_PROFIT_ROI_PCT;
    const stopLossTriggered = STOP_LOSS_ROI_PCT < 0 && roiPct <= STOP_LOSS_ROI_PCT;
    if (exitAlreadyRequested || takeProfitTriggered || stopLossTriggered) {
      if (!this.roiExitedSymbols) this.roiExitedSymbols = new Set();
      if (!this.roiExitReasons) this.roiExitReasons = new Map();
      if (!exitAlreadyRequested) {
        const exitType = takeProfitTriggered ? 'take-profit' : 'stop-loss';
        const targetRoi = takeProfitTriggered ? TAKE_PROFIT_ROI_PCT : STOP_LOSS_ROI_PCT;
        const comparator = takeProfitTriggered ? '>=' : '<=';
        this.roiExitReasons.set(symbol, {
          exitType,
          reason: `ROI ${exitType} ${roiPct.toFixed(2)}% ${comparator} ${targetRoi}%`,
          triggerRoi: roiPct,
        });
        // Lock the symbol before sending the market close. If Binance position
        // data is briefly stale, later cycles keep the grid paused while the
        // existing close order is verified instead of submitting a duplicate.
        this.roiExitedSymbols.add(symbol);
      }
      const exit = this.roiExitReasons.get(symbol) || {
        exitType: 'exit',
        reason: 'ROI exit retry',
        triggerRoi: roiPct,
      };
      const { exitType, reason, triggerRoi } = exit;
      const cancelResult = await this.cancelGridOrders(symbol, reason);
      if (cancelResult.failed.length) {
        throw new Error(`Cannot execute ${reason}: ${cancelResult.failed.length} grid order(s) failed to cancel`);
      }
      await this.closeActiveLongPosition(symbol, reason);
      await this.sendRoiExitAlert(symbol, { exitType, triggerRoi });
      return false;
    }
    return true;
  }

  async sendRoiExitAlert(symbol, { exitType = 'exit', triggerRoi = null } = {}) {
    if (!this.roiExitAlertedSymbols) this.roiExitAlertedSymbols = new Set();
    if (this.roiExitAlertedSymbols.has(symbol)) return;
    const rows = [['Symbol', symbol]];
    if (Number.isFinite(triggerRoi)) {
      rows.push(['ROI', `${this.formatFuturesNumber(triggerRoi, 2)}%`]);
    }
    rows.push(['Position', `${POSITION_SIDE} closed`]);
    await this.sendAlert(this.formatFuturesTelegramMessage(`FUTURES ${exitType.toUpperCase()}`, rows));
    this.roiExitAlertedSymbols.add(symbol);
  }

  async withSymbolLock(symbol, fn) {
    const holdingSymbols = symbolLockContext.getStore();
    if (holdingSymbols && holdingSymbols.has(symbol)) {
      // A call already descended from a withSymbolLock(symbol, ...) that
      // hasn't released yet is trying to acquire the SAME symbol's lock
      // again. Proceeding would queue behind a promise that only resolves
      // after this very call finishes -> permanent deadlock. Fail fast with
      // a clear diagnostic instead.
      throw new Error(
        `[LOCK] Reentrant withSymbolLock('${symbol}') call detected: a function that already ` +
        `holds this symbol's lock attempted to acquire it again from within its own execution. ` +
        `This would deadlock. Refactor the calling code so it does not nest withSymbolLock calls ` +
        `for the same symbol (call the *Unlocked variant directly instead of re-locking).`
      );
    }

    const previous = this.symbolLocks.get(symbol) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.symbolLocks.set(symbol, current);
    try {
      await previous;
      const nextHolding = new Set(holdingSymbols);
      nextHolding.add(symbol);
      return await symbolLockContext.run(nextHolding, () => fn());
    } finally {
      release();
      if (this.symbolLocks.get(symbol) === current) this.symbolLocks.delete(symbol);
    }
  }

  async reconcileSymbol(symbol) {
    return this.withSymbolLock(symbol, () => this.reconcileSymbolUnlocked(symbol));
  }

  async reconcileSymbolUnlocked(symbol) {
    if (POSITION_SIDE === 'SHORT') return this.reconcileShortSymbolUnlocked(symbol);
    await this.syncAccountIncome(symbol);
    if (!this.canPlaceNewOrders()) {
      const freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
      await this.handleFilledTrades(symbol, [], freshOpenOrders);
      await this.syncFundingHistory(symbol);
      if (this.exchange.fetchPositions) this.updatePositionSnapshot(symbol, await this.exchange.fetchPositions([symbol]));
      console.log(`[SYNC] ${symbol} trading paused; fills and funding reconciled but no new orders will be placed`);
      return;
    }

    let context = await this.fetchContext(symbol);
    let { currentPrice, balance, positions, lower, upper, levels } = context;
    if (!this.latestPositions) this.latestPositions = new Map();
    this.latestPositions.set(symbol, this.getActivePosition(positions, symbol));

    const canContinue = await this.enforceRangeExits(symbol, currentPrice, positions);

    let trailedUp = null;
    let trailedDown = null;
    let newContext = null;
    const fibonacciOwnsRange = this.state.getSymbol(symbol).config.rangeAdvisor?.source === 'FIBONACCI';
    const trailingAllowed = !fibonacciOwnsRange || FIBONACCI_RANGE_ADVISOR_ALLOW_TRAILING;
    if (canContinue && trailingAllowed) {
      trailedUp = await this.maybeTrailUpRange(symbol, currentPrice, lower, upper);
      if (trailedUp) {
        newContext = await this.fetchContext(symbol);
        newContext.trailingUpJustShifted = true;
        ({ currentPrice, balance, positions, lower, upper, levels } = newContext);
        this.latestPositions.set(symbol, this.getActivePosition(positions, symbol));
      } else {
        trailedDown = await this.maybeTrailDownRange(symbol, currentPrice, lower, upper);
        if (trailedDown) {
          newContext = await this.fetchContext(symbol);
          newContext.trailingDownJustShifted = true;
          ({ currentPrice, balance, positions, lower, upper, levels } = newContext);
          this.latestPositions.set(symbol, this.getActivePosition(positions, symbol));
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
    await this.handleFilledTrades(symbol, canContinue ? levels : [], freshOpenOrders);
    await this.syncFundingHistory(symbol);

    if (!canContinue) {
      if (this.exchange.fetchPositions) this.updatePositionSnapshot(symbol, await this.exchange.fetchPositions([symbol]));
      console.log(`[SYNC] ${symbol} trading halted (stop-loss/take-profit); no new orders will be placed`);
      return;
    }

    try { await this.trimExcessBuys(symbol); } catch (err) {
      console.warn(`[EXPOSURE] ${symbol} could not trim pending BUY orders: ${err.message}`);
    }

    // Re-read balances, positions and open orders after fill handling so placement loops use fresh state.
    [balance, positions, freshOpenOrders] = await Promise.all([
      retry(() => this.exchange.fetchBalance()),
      retry(() => this.exchange.fetchPositions([symbol])),
      retry(() => this.exchange.fetchOpenOrders(symbol)),
    ]);
    this.updatePositionSnapshot(symbol, positions);
    let managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);

    if (await this.cancelSellsBelowPositionEntry(symbol, managedOrders)) {
      freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
      managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
    }

    const directionEntryPreferred = this.isEntrySidePreferred(symbol);
    const volumeDeltaDecision = await this.getVolumeDeltaEntryDecision(symbol);
    const entrySidePreferred = directionEntryPreferred && volumeDeltaDecision.allow;
    if (!directionEntryPreferred) {
      const direction = this.getAppliedFibonacciDirection(symbol);
      if (await this.cancelManagedEntryOrders(
        symbol, managedOrders, `mutual ownership moved to SHORT (${direction})`
      )) {
        freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
        managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
      }
      console.log(`[MUTUAL] ${symbol} LONG entries paused; direction=${direction}`);
    } else if (!volumeDeltaDecision.allow) {
      if (await this.cancelManagedEntryOrders(
        symbol, managedOrders,
        `opposing volume delta ${roundNumber(volumeDeltaDecision.deltaRatio * 100, 3)}%`
      )) {
        freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
        managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
      }
    }

    if (GRID_CANCEL_OUT_OF_RANGE) {
      for (const order of managedOrders) {
        if (order.side === 'sell') continue;
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
    const symState = this.state.getSymbol(symbol);
    symState.refillCountByLevel ||= {};
    for (const order of managedOrders) {
      const idx = this.getLevelIndex(levels, Number(order.price));
      if (order.side === 'buy') activeBuyLevels.add(idx);
    }
    for (const order of Object.values(symState.orders)) {
      if (order.side === 'buy') activeBuyLevels.add(Number(order.levelIndex));
    }

    const stagedExitGroups = this.stageAggregatedExitLadders(
      symbol, levels, currentPrice, symState, activeBuyLevels
    );
    if (stagedExitGroups > 0) await this.state.save();

    const below = entrySidePreferred
      ? this.getBuyPlacementLevels(symbol, levels, currentPrice, GRID_MAX_ACTIVE_BUY_ORDERS)
      : [];

    let quoteFree = this.getQuoteFree(balance, symbol);
    const positionAmount = this.getBaseFree(positions, symbol);
    const reservedSellAmount = this.getReservedSellAmount(managedOrders);
    let baseFree = Math.max(0, positionAmount - reservedSellAmount);
    let remainingInvestmentUsdt = this.getRemainingInvestmentUsdt(symbol);

    for (const level of below) {
      if (this.countActiveOrders(symState, 'buy') >= GRID_MAX_ACTIVE_BUY_ORDERS) {
        console.warn(`[SKIP] ${symbol} BUY level=${level.index} | active buy order limit (${GRID_MAX_ACTIVE_BUY_ORDERS}) reached`);
        break;
      }
      if (activeBuyLevels.has(level.index)) continue;
      if (symState.lastBuyByLevel[level.index]) continue;
      const previousRefillCount = symState.refillCountByLevel[level.index];
      if (previousRefillCount !== undefined && !GRID_REFILL_ON_FILLED) continue;
      const refillCount = previousRefillCount === undefined
        ? 0
        : Math.max(0, Number(previousRefillCount) || 0) + 1;
      if (refillCount > GRID_MAX_REFILLS) continue;
      const adaptiveWeight = Number(level.weight);
      const weight = Number.isFinite(adaptiveWeight) ? adaptiveWeight : 1;
      let amount = this.amountForBuy(symbol, level.price, remainingInvestmentUsdt, weight);
      let cost = amount * level.price;
      if (!(amount > 0)) {
        const recommendation = this.getAdaptiveRecommendation(symbol);
        if (recommendation && this.getOrderSizeUsdt() * weight < this.getMinCost(symbol) - 1e-8) {
          continue;
        }
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
      // GRID_ORDER_SIZE_USDT / GRID_TOTAL_INVESTMENT_USDT are notional
      // (position value) caps, same meaning as on spot. On margin, opening
      // that notional only requires notional / LEVERAGE of free margin.
      const marginRequired = cost / LEVERAGE;
      if (quoteFree < marginRequired) break;
      const order = await this.placeLimit(symbol, 'buy', level.index, level.price, amount, { refillCount });
      if (!order) break;
      quoteFree -= marginRequired;
      remainingInvestmentUsdt = Math.max(0, remainingInvestmentUsdt - cost);
    }

    const trackedBuys = Object.entries(symState.lastBuyByLevel)
      .map(([buyLevelIndex, buy]) => ({ buyLevelIndex: Number(buyLevelIndex), buy }))
      .filter(item => Number.isInteger(item.buyLevelIndex) && item.buy)
      .sort((a, b) => {
        const aStaged = a.buy.stagedExitChild === true;
        const bStaged = b.buy.stagedExitChild === true;
        if (aStaged && bStaged) return Number(a.buy.stagedExitPart) - Number(b.buy.stagedExitPart);
        if (aStaged !== bStaged) return aStaged ? -1 : 1;
        return b.buyLevelIndex - a.buyLevelIndex;
      });

    for (const { buyLevelIndex, buy: trackedBuy } of trackedBuys) {
      if (this.getActiveSellOrderForBuyLevel(symState, buyLevelIndex)) continue;
      const trackedAmount = Math.max(0, Number(trackedBuy.sellableAmount ?? trackedBuy.amount) || 0);
      if (!(trackedAmount > 0)) continue;
      let amount = Math.min(trackedAmount, baseFree);
      if (!(amount > 0)) {
        console.warn(`[SKIP] ${symbol} SELL sourceBuy=${buyLevelIndex} | insufficient free position`);
        continue;
      }
      const target = this.findSellTargetForBuy(symbol, levels, buyLevelIndex, trackedBuy, {
        amount,
        minimumPrice: currentPrice,
      });
      if (!target) {
        this.warnNoSellTarget(symbol, buyLevelIndex, levels, trackedBuy, amount);
        continue;
      }
      this.clearSellTargetWarning(symbol, buyLevelIndex);
      const refillCount = Math.max(0, Number(trackedBuy?.refillCount) || 0);
      const order = await this.placeExitLimit(
        symbol, target.sellLevelIndex, target.sellPrice, amount,
        { refillCount, sourceBuyLevelIndex: buyLevelIndex, referencePrice: currentPrice }
      );
      if (!order) continue;
      baseFree -= amount;
    }

    console.log(
      (() => {
        const accountUnrealized = positions.reduce((sum, position) => sum + numberOrZero(position.unrealizedPnl ?? position.info?.unRealizedProfit), 0);
        const account = incomeMetrics(symState.accountIncome, accountUnrealized);
        const realizedProfit = account.realized;
        const netProfit = account.net;
        return (
      `[SYNC] ${symbol} price=${roundNumber(currentPrice)} range=${roundNumber(lower)}-${roundNumber(upper)} ` +
      `orders=${managedOrders.length} realized=${realizedProfit === null ? 'unavailable' : roundNumber(realizedProfit, 4)} gridPair=${roundNumber(symState.realizedGridProfit, 4)} ` +
      `funding=${roundNumber(account.funding, 4)} unrealized=${roundNumber(accountUnrealized, 4)} ` +
      `net=${netProfit === null ? 'unavailable' : roundNumber(netProfit, 4)} ` +
      `fees=${roundNumber(account.fees, 4)} ${this.getQuoteAsset(symbol)}`
        );
      })()
    );
  }

  async reconcileShortSymbolUnlocked(symbol) {
    await this.syncAccountIncome(symbol);
    if (!this.canPlaceNewOrders()) {
      const openOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
      await this.handleFilledTrades(symbol, [], openOrders);
      await this.syncFundingHistory(symbol);
      if (this.exchange.fetchPositions) {
        this.updatePositionSnapshot(symbol, await this.exchange.fetchPositions([symbol]));
      }
      console.log(`[SYNC] ${symbol} SHORT trading paused; fills reconciled`);
      return;
    }

    let context = await this.fetchContext(symbol);
    let { currentPrice, balance, positions, lower, upper, levels } = context;
    this.updatePositionSnapshot(symbol, positions);
    const canContinue = await this.enforceRangeExits(symbol, currentPrice, positions);

    const fibonacciOwnsRange = this.state.getSymbol(symbol).config.rangeAdvisor?.source === 'FIBONACCI';
    const trailingAllowed = !fibonacciOwnsRange || FIBONACCI_RANGE_ADVISOR_ALLOW_TRAILING;
    if (canContinue && trailingAllowed) {
      const trailedUp = await this.maybeTrailUpRange(symbol, currentPrice, lower, upper);
      const trailedDown = trailedUp
        ? null
        : await this.maybeTrailDownRange(symbol, currentPrice, lower, upper);
      if (trailedUp || trailedDown) {
        context = await this.fetchContext(symbol);
        ({ currentPrice, balance, positions, lower, upper, levels } = context);
        this.updatePositionSnapshot(symbol, positions);
      }
    }

    let freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    await this.handleFilledTrades(symbol, canContinue ? levels : [], freshOpenOrders);
    await this.syncFundingHistory(symbol);
    if (!canContinue) return;

    try { await this.trimExcessShortEntries(symbol); } catch (err) {
      console.warn(`[EXPOSURE] ${symbol} could not trim pending SHORT entries: ${err.message}`);
    }
    [balance, positions, freshOpenOrders] = await Promise.all([
      retry(() => this.exchange.fetchBalance()),
      retry(() => this.exchange.fetchPositions([symbol])),
      retry(() => this.exchange.fetchOpenOrders(symbol)),
    ]);
    this.updatePositionSnapshot(symbol, positions);
    let managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
    if (await this.cancelShortBuysAbovePositionEntry(symbol, managedOrders)) {
      freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
      managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
    }

    const directionEntryPreferred = this.isEntrySidePreferred(symbol);
    const volumeDeltaDecision = await this.getVolumeDeltaEntryDecision(symbol);
    const entrySidePreferred = directionEntryPreferred && volumeDeltaDecision.allow;
    if (!directionEntryPreferred) {
      const direction = this.getAppliedFibonacciDirection(symbol);
      if (await this.cancelManagedEntryOrders(
        symbol, managedOrders, `mutual ownership moved to LONG (${direction})`
      )) {
        freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
        managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
      }
      console.log(`[MUTUAL] ${symbol} SHORT entries paused; direction=${direction}`);
    } else if (!volumeDeltaDecision.allow) {
      if (await this.cancelManagedEntryOrders(
        symbol, managedOrders,
        `opposing volume delta ${roundNumber(volumeDeltaDecision.deltaRatio * 100, 3)}%`
      )) {
        freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
        managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
      }
    }

    if (GRID_CANCEL_OUT_OF_RANGE) {
      for (const order of managedOrders) {
        if (String(order.side).toLowerCase() !== ENTRY_SIDE) continue;
        const orderTimestamp = Number(order.timestamp) || Date.parse(order.datetime || 0) || 0;
        if (Date.now() - orderTimestamp < GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MS) continue;
        if (this.isOrderCloseToPriceLevel(order.price, levels, this.exchange.markets[symbol])) continue;
        if (!this.isOrderInsideRange(order, lower, upper)) {
          await this.cancelOrder(symbol, order, `outside SHORT range ${roundNumber(lower)}-${roundNumber(upper)}`);
        }
      }
      freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
      managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
    }

    const symState = this.state.getSymbol(symbol);
    symState.refillCountByLevel ||= {};
    const activeEntryLevels = new Set();
    for (const order of managedOrders) {
      if (String(order.side).toLowerCase() === ENTRY_SIDE) {
        activeEntryLevels.add(this.getLevelIndex(levels, Number(order.price)));
      }
    }
    for (const order of Object.values(symState.orders)) {
      if (String(order.side).toLowerCase() === ENTRY_SIDE) {
        activeEntryLevels.add(Number(order.levelIndex));
      }
    }

    const entries = entrySidePreferred
      ? this.getNearestLevels(levels, currentPrice, ENTRY_SIDE, GRID_MAX_ACTIVE_BUY_ORDERS)
      : [];
    let quoteFree = this.getQuoteFree(balance, symbol);
    let remainingInvestment = this.getRemainingInvestmentUsdt(symbol);
    for (const level of entries) {
      if (this.countActiveOrders(symState, ENTRY_SIDE) >= GRID_MAX_ACTIVE_BUY_ORDERS) break;
      if (activeEntryLevels.has(level.index) || symState.lastBuyByLevel[level.index]) continue;
      const previousRefillCount = symState.refillCountByLevel[level.index];
      if (previousRefillCount !== undefined && !GRID_REFILL_ON_FILLED) continue;
      const refillCount = previousRefillCount === undefined
        ? 0
        : Math.max(0, Number(previousRefillCount) || 0) + 1;
      if (refillCount > GRID_MAX_REFILLS) continue;
      let amount = this.amountForBuy(symbol, level.price, remainingInvestment, 1);
      if (!(amount > 0)) break;
      let precise = this.getPreciseOrderNumbers(symbol, level.price, amount);
      const minCost = this.getMinCost(symbol);
      if (minCost > 0 && precise.notional < minCost - 1e-8) {
        amount = minCost / level.price;
        precise = this.getPreciseOrderNumbers(symbol, level.price, amount);
      }
      if (precise.notional > remainingInvestment + 1e-8 ||
          quoteFree < precise.notional / LEVERAGE) break;
      const order = await this.placeLimit(
        symbol, ENTRY_SIDE, level.index, level.price, amount, { refillCount }
      );
      if (!order) break;
      quoteFree -= precise.notional / LEVERAGE;
      remainingInvestment = Math.max(0, remainingInvestment - precise.notional);
    }

    const positionAmount = this.getBaseFree(positions, symbol);
    const reservedExitAmount = managedOrders
      .filter(order => String(order.side).toLowerCase() === EXIT_SIDE)
      .reduce((sum, order) => sum + this.getOpenOrderRemainingAmount(order), 0);
    let closableAmount = Math.max(0, positionAmount - reservedExitAmount);
    const trackedEntries = Object.entries(symState.lastBuyByLevel)
      .map(([entryLevelIndex, entry]) => ({ entryLevelIndex: Number(entryLevelIndex), entry }))
      .filter(item => Number.isInteger(item.entryLevelIndex) && item.entry)
      .sort((left, right) => left.entryLevelIndex - right.entryLevelIndex);
    for (const { entryLevelIndex, entry } of trackedEntries) {
      if (this.getActiveShortExitForEntry(symState, entryLevelIndex)) continue;
      const trackedAmount = Math.max(0, Number(entry.sellableAmount ?? entry.amount) || 0);
      const amount = Math.min(trackedAmount, closableAmount);
      if (!(amount > 0)) continue;
      const target = this.findBuyTargetForShort(symbol, levels, entryLevelIndex, entry, {
        amount,
        maximumPrice: currentPrice,
      });
      if (!target) {
        this.warnNoShortExitTarget(symbol, entryLevelIndex, levels, entry, amount);
        continue;
      }
      this.clearSellTargetWarning(symbol, entryLevelIndex);
      const order = await this.placeShortExitLimit(
        symbol, target.buyLevelIndex, target.buyPrice, amount,
        {
          refillCount: Math.max(0, Number(entry.refillCount) || 0),
          sourceEntryLevelIndex: entryLevelIndex,
          referencePrice: currentPrice,
        }
      );
      if (order) closableAmount -= amount;
    }

    const activePosition = this.getActivePosition(positions, symbol);
    console.log(
      `[SYNC-SHORT] ${symbol} price=${roundNumber(currentPrice)} ` +
      `range=${roundNumber(lower)}-${roundNumber(upper)} orders=${managedOrders.length} ` +
      `position=${roundNumber(Math.abs(Number(activePosition?.contracts) || 0), 8)} ` +
      `gridPair=${roundNumber(symState.realizedGridProfit, 4)} ${this.getQuoteAsset(symbol)}`
    );
  }

  async trimExcessShortEntries(symbol) {
    if (!this.exposureLimits) return;
    await this.withExposureLock(async () => {
      let exposure = await this.fetchExposure();
      const managed = await this.getManagedOpenOrders(
        symbol, exposure.orders.filter(order => order.symbol === symbol)
      );
      const entries = managed
        .filter(order => String(order.side).toLowerCase() === ENTRY_SIDE)
        .sort((left, right) => Number(right.price) - Number(left.price));
      for (const order of entries) {
        if (exposure.values[symbol] <= this.exposureLimits.symbol + 1e-8 &&
            exposure.total <= this.exposureLimits.total + 1e-8) break;
        await this.cancelOrder(symbol, order, 'SHORT exposure cap; preserve BUY exits');
        exposure = await this.fetchExposure();
      }
    });
  }

  async cancelShortBuysAbovePositionEntry(symbol, managedOrders) {
    const entryPrice = this.getPositionEntryFloor(symbol);
    if (!(entryPrice > 0)) return 0;
    const invalid = managedOrders.filter(order =>
      String(order.side).toLowerCase() === EXIT_SIDE && Number(order.price) - 1e-12 > entryPrice
    );
    for (const order of invalid) {
      await this.cancelOrder(
        symbol, order,
        `SHORT BUY exit ${Number(order.price)} above position average entry ${entryPrice}`
      );
    }
    return invalid.length;
  }

  amountForTrackedSell(symbol, sellLevelIndex) {
    const symState = this.state.getSymbol(symbol);
    const buy = symState.lastBuyByLevel[sellLevelIndex - 1];
    if (!buy) return 0;
    return Math.max(0, Number(buy.sellableAmount ?? buy.amount) || 0);
  }

  getSellSourceBuyLevelIndex(orderMeta) {
    const explicit = Number(orderMeta?.sourceBuyLevelIndex);
    if (orderMeta?.sourceBuyLevelIndex !== null && orderMeta?.sourceBuyLevelIndex !== undefined &&
        Number.isInteger(explicit)) return explicit;
    return Number(orderMeta?.levelIndex) - 1;
  }

  updatePositionSnapshot(symbol, positions) {
    if (!this.latestPositions) this.latestPositions = new Map();
    if (!this.latestAccountUnrealized) this.latestAccountUnrealized = new Map();
    this.latestPositions.set(symbol, this.getActivePosition(positions, symbol));
    this.latestAccountUnrealized.set(symbol, positions.filter(p => p.symbol === symbol)
      .reduce((sum, p) => sum + numberOrZero(p.unrealizedPnl ?? p.info?.unRealizedProfit), 0));
  }

  async cancelSellsBelowPositionEntry(symbol, managedOrders) {
    const entryFloor = this.getPositionEntryFloor(symbol);
    if (!(entryFloor > 0)) return 0;
    const belowEntry = (managedOrders || []).filter(order =>
      String(order?.side).toLowerCase() === 'sell' &&
      Number(order?.price) + 1e-12 < entryFloor
    );
    for (const order of belowEntry) {
      await this.cancelOrder(
        symbol,
        order,
        `SELL price ${Number(order.price)} below position average entry ${entryFloor}`
      );
    }
    return belowEntry.length;
  }

  getActiveSellOrderForBuyLevel(symState, buyLevelIndex) {
    return Object.values(symState.orders || {}).find(order =>
      String(order.side).toLowerCase() === 'sell' &&
      this.getSellSourceBuyLevelIndex(order) === Number(buyLevelIndex)
    ) || null;
  }

  findSellTargetForBuy(
    symbol, levels, buyLevelIndex, trackedBuy,
    { amount = null, minimumPrice = -Infinity } = {}
  ) {
    const sourceLevel = Number(buyLevelIndex);
    if (!Number.isInteger(sourceLevel) || sourceLevel < 0 || !levels.length) return null;
    const sellableAmount = Math.max(0, Number(amount ?? trackedBuy?.sellableAmount ?? trackedBuy?.amount) || 0);
    if (!(sellableAmount > 0)) return null;
    const effectiveMinimumPrice = Math.max(minimumPrice, this.getPositionEntryFloor(symbol));
    const minCost = this.getMinCost(symbol);
    for (let sellLevelIndex = sourceLevel + 1; sellLevelIndex < levels.length; sellLevelIndex++) {
      const sellPrice = Number(levels[sellLevelIndex]);
      if (!(sellPrice > effectiveMinimumPrice) || !this.isTrackedSellProfitable(symbol, trackedBuy, sellPrice)) continue;
      let precise;
      try { precise = this.getPreciseOrderNumbers(symbol, sellPrice, sellableAmount); } catch { continue; }
      if (!(Number(precise.amountNum ?? precise.preciseAmount) > 0)) continue;
      if (minCost > 0 && precise.notional < minCost - 1e-8) continue;
      return {
        buyLevelIndex: sourceLevel,
        sellLevelIndex,
        sellPrice,
        amount: Number(precise.amountNum ?? precise.preciseAmount),
        notional: precise.notional,
      };
    }
    const tick = this.getMarketTickSize(symbol);
    if (!(tick > 0)) return null;
    const preciseAmount = Number(this.exchange.amountToPrecision(symbol, sellableAmount));
    if (!(preciseAmount > 0)) return null;
    const minimum = Math.max(this.getMinimumProfitableSellPrice(trackedBuy),
      minCost / preciseAmount, Number(levels[levels.length - 1]) + tick,
      Number.isFinite(effectiveMinimumPrice) ? effectiveMinimumPrice + tick : 0);
    const sellPrice = Number(this.exchange.priceToPrecision(symbol, Math.ceil(minimum / tick) * tick + tick));
    if (!Number.isFinite(sellPrice) || !this.isTrackedSellProfitable(symbol, trackedBuy, sellPrice)) return null;
    const precise = this.getPreciseOrderNumbers(symbol, sellPrice, preciseAmount);
    if (precise.notional < minCost || sellPrice <= effectiveMinimumPrice) return null;
    return { buyLevelIndex: sourceLevel, sellLevelIndex: levels.length - 1, sellPrice,
      amount: preciseAmount, notional: precise.notional, outsideGrid: true };
  }

  warnNoSellTarget(symbol, buyLevelIndex, levels, trackedBuy, amount) {
    const key = `${symbol}|${buyLevelIndex}`;
    if (this.sellTargetWarnings.has(key)) return;
    this.sellTargetWarnings.add(key);
    const highestPrice = Number(levels[levels.length - 1]) || 0;
    let highestNotional = 0;
    try { highestNotional = this.getPreciseOrderNumbers(symbol, highestPrice, amount).notional; } catch {}
    console.warn(
      `[SKIP] ${symbol} SELL sourceBuy=${buyLevelIndex} | no higher grid level satisfies ` +
      `profit/min-notional constraints (minPrice=${this.getMinimumProfitableSellPrice(trackedBuy)}, ` +
      `highestLevel=${highestPrice}, highestNotional=${roundNumber(highestNotional, 8)}, ` +
      `minNotional=${this.getMinCost(symbol)}); keeping buy record`
    );
  }

  clearSellTargetWarning(symbol, buyLevelIndex) {
    this.sellTargetWarnings.delete(`${symbol}|${buyLevelIndex}`);
  }

  getMaximumProfitableShortExitPrice(entry) {
    const amount = Number(entry?.sellableAmount ?? entry?.amount) || 0;
    const proceeds = Number(entry?.totalCostQuote) || 0;
    const entryFee = Number(entry?.totalFeeQuote) || 0;
    if (!(amount > 0) || !(proceeds > entryFee)) return 0;
    const targetProfit = proceeds * GRID_MIN_NET_PROFIT_PCT / 100;
    return (proceeds - entryFee - targetProfit) /
      (amount * (1 + BINANCE_FUTURES_MAKER_FEE_RATE));
  }

  isTrackedShortExitProfitable(symbol, entry, buyPrice) {
    let precise = Number(buyPrice);
    try { precise = Number(this.exchange.priceToPrecision(symbol, buyPrice)); } catch {}
    return precise > 0 && precise <= this.getMaximumProfitableShortExitPrice(entry) + 1e-12;
  }

  getActiveShortExitForEntry(symState, entryLevelIndex) {
    return Object.values(symState.orders || {}).find(order =>
      String(order.side).toLowerCase() === EXIT_SIDE &&
      this.getSellSourceBuyLevelIndex(order) === Number(entryLevelIndex)
    ) || null;
  }

  findBuyTargetForShort(
    symbol, levels, entryLevelIndex, trackedEntry,
    { amount = null, maximumPrice = Infinity } = {}
  ) {
    const sourceLevel = Number(entryLevelIndex);
    if (!Number.isInteger(sourceLevel) || sourceLevel < 0 || !levels.length) return null;
    const exitAmount = Math.max(0, Number(
      amount ?? trackedEntry?.sellableAmount ?? trackedEntry?.amount
    ) || 0);
    if (!(exitAmount > 0)) return null;
    const positionEntry = this.getPositionEntryFloor(symbol);
    const effectiveMaximum = Math.min(
      maximumPrice,
      positionEntry > 0 ? positionEntry : Infinity,
      this.getMaximumProfitableShortExitPrice(trackedEntry)
    );
    const minCost = this.getMinCost(symbol);
    for (let buyLevelIndex = sourceLevel - 1; buyLevelIndex >= 0; buyLevelIndex--) {
      const buyPrice = Number(levels[buyLevelIndex]);
      if (!(buyPrice < effectiveMaximum) ||
          !this.isTrackedShortExitProfitable(symbol, trackedEntry, buyPrice)) continue;
      let precise;
      try { precise = this.getPreciseOrderNumbers(symbol, buyPrice, exitAmount); } catch { continue; }
      if (!(Number(precise.amountNum ?? precise.preciseAmount) > 0)) continue;
      if (minCost > 0 && precise.notional < minCost - 1e-8) continue;
      return {
        entryLevelIndex: sourceLevel,
        buyLevelIndex,
        buyPrice,
        amount: Number(precise.amountNum ?? precise.preciseAmount),
        notional: precise.notional,
      };
    }
    const tick = this.getMarketTickSize(symbol);
    const preciseAmount = Number(this.exchange.amountToPrecision(symbol, exitAmount));
    if (!(tick > 0) || !(preciseAmount > 0) || !Number.isFinite(effectiveMaximum)) return null;
    const rawPrice = Math.min(Number(levels[0]) - tick, effectiveMaximum - tick);
    const buyPrice = Number(this.exchange.priceToPrecision(symbol, Math.floor(rawPrice / tick) * tick));
    if (!(buyPrice > 0) || !this.isTrackedShortExitProfitable(symbol, trackedEntry, buyPrice)) return null;
    const precise = this.getPreciseOrderNumbers(symbol, buyPrice, preciseAmount);
    if (minCost > 0 && precise.notional < minCost - 1e-8) return null;
    return {
      entryLevelIndex: sourceLevel,
      buyLevelIndex: 0,
      buyPrice,
      amount: preciseAmount,
      notional: precise.notional,
      outsideGrid: true,
    };
  }

  warnNoShortExitTarget(symbol, entryLevelIndex, levels, trackedEntry, amount) {
    const key = `${symbol}|${entryLevelIndex}`;
    if (this.sellTargetWarnings.has(key)) return;
    this.sellTargetWarnings.add(key);
    console.warn(
      `[SKIP] ${symbol} SHORT BUY exit sourceEntry=${entryLevelIndex} | no lower level satisfies ` +
      `profit/min-notional constraints (maxPrice=${this.getMaximumProfitableShortExitPrice(trackedEntry)}, ` +
      `lowestLevel=${Number(levels[0]) || 0}, amount=${amount}, minNotional=${this.getMinCost(symbol)})`
    );
  }

  getAllocatedInvestmentUsdt(symbol) {
    if (!(GRID_TOTAL_INVESTMENT_USDT > 0)) return 0;
    const symState = this.state.getSymbol(symbol);
    let allocated = 0;

    // Sum cost of all filled buys tracked in lastBuyByLevel.
    for (const buy of Object.values(symState.lastBuyByLevel)) {
      allocated += Number(buy.totalCostQuote) || 0;
    }

    // Pending opening orders count toward the configured side's notional cap.
    for (const order of Object.values(symState.orders)) {
      if (String(order.side).toLowerCase() !== ENTRY_SIDE) continue;
      allocated += (Number(order.amount) || 0) * (Number(order.price) || 0);
    }

    return allocated;
  }

  getRemainingInvestmentUsdt(symbol) {
    if (!(GRID_TOTAL_INVESTMENT_USDT > 0)) return Infinity;
    return Math.max(0, GRID_TOTAL_INVESTMENT_USDT - this.getAllocatedInvestmentUsdt(symbol));
  }

  amountForBuy(
    symbol,
    price,
    availableInvestmentUsdt = this.getRemainingInvestmentUsdt(symbol),
    weight = 1
  ) {
    const minCost = this.getMinCost(symbol);
    const recommendation = this.getAdaptiveRecommendation(symbol);
    const weightedTarget = this.getOrderSizeUsdt() * (recommendation ? Math.max(0, Number(weight) || 0) : 1);
    if (recommendation && minCost > 0 && weightedTarget < minCost - 1e-8) {
      const warningKey = `${symbol}|${recommendation.profile}|${weight}`;
      if (!this.adaptiveMinimumWarnings?.has(warningKey)) {
        this.adaptiveMinimumWarnings?.add(warningKey);
        console.log(
          `[ADAPTIVE-LIVE] ${symbol} skipping ${weight}x ${ENTRY_SIDE.toUpperCase()} weight: target ` +
          `${roundNumber(weightedTarget, 8)} USDT is below minimum notional ${minCost} USDT`
        );
      }
      return 0;
    }
    const targetNotional = recommendation ? weightedTarget : Math.max(weightedTarget, minCost);
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
      `new ${ENTRY_SIDE.toUpperCase()} orders until an exit adds funds back. Consider lowering GRID_COUNT, raising ` +
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
    const precisionPrice = Number(market?.precision?.price);
    const tickSize = precisionPrice > 0
      ? (precisionPrice >= 1 ? Math.pow(10, -precisionPrice) : precisionPrice)
      : 0.00001;
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

  resolveUserStreamSymbol(marketId) {
    return this.userStreamSymbolMap.get(String(marketId || '').toUpperCase()) || null;
  }

  scheduleUserStreamReconcile(symbol, event) {
    const existing = this.userStreamReconcileTimers.get(symbol);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.userStreamReconcileTimers.delete(symbol);
      this.reconcileSymbol(symbol).catch(error => {
        console.warn(`[USER-STREAM] ${symbol} reconciliation failed: ${error.message}`);
        this.recordError();
      });
    }, FUTURES_USER_STREAM_RECONCILE_DEBOUNCE_MS);
    timer.unref?.();
    this.userStreamReconcileTimers.set(symbol, timer);
    const order = event?.o || {};
    console.log(
      `[USER-STREAM] ${symbol} execution=${order.x || 'TRADE'} status=${order.X || 'unknown'} ` +
      `order=${order.i ?? 'unknown'} trade=${order.t ?? 'unknown'}; reconciliation queued`
    );
  }

  async handleUserStreamEvent(event) {
    if (event?.e === 'ORDER_TRADE_UPDATE') {
      const executionType = String(event.o?.x || '').toUpperCase();
      if (!['TRADE', 'CALCULATED'].includes(executionType)) return;
      const symbol = this.resolveUserStreamSymbol(event.o?.s);
      if (symbol) this.scheduleUserStreamReconcile(symbol, event);
      return;
    }
    if (event?.e !== 'MARGIN_CALL') return;
    const positions = Array.isArray(event.p) ? event.p : [];
    this.marginCallUntil ||= new Map();
    const holdUntil = Date.now() + ADAPTIVE_RISK_STATE_MACHINE_MARGIN_CALL_HOLD_MS;
    const details = positions.map(position => {
      const configuredSymbol = this.resolveUserStreamSymbol(position.s);
      const symbol = configuredSymbol || position.s || 'unknown';
      if (configuredSymbol) {
        this.marginCallUntil.set(configuredSymbol, holdUntil);
        this.scheduleUserStreamReconcile(configuredSymbol, {
          o: { x: 'MARGIN_CALL', X: 'warning', i: 'account', t: event.E || Date.now() },
        });
      }
      return `${symbol} maintMargin=${position.mm ?? 'unknown'} unrealized=${position.up ?? 'unknown'}`;
    });
    const message = ['[FUTURES MARGIN CALL]', '', ...details].join('\n');
    console.warn(message.replace(/\n/g, ' | '));
    await this.sendAlert(message);
  }

  async startUserStream() {
    if (!FUTURES_USER_STREAM_ENABLED) return;
    try {
      await this.futuresUserStream.start();
    } catch (error) {
      console.warn(`[USER-STREAM] Disabled after startup failure: ${error.message}`);
    }
  }

  stopAuxiliaryServices() {
    this.futuresUserStream?.stop();
    for (const timer of this.userStreamReconcileTimers.values()) clearTimeout(timer);
    this.userStreamReconcileTimers.clear();
  }

  async executeCycle() {
    if (this.isRunning) return;
    this.isRunning = true;
    let hadError = false;
    try {
      if (!this.circuitAllows()) return;
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

  formatFuturesNumber(value, digits = 4) {
    return numberOrZero(value).toFixed(digits);
  }

  formatFuturesTelegramMessage(title, rows = []) {
    const body = rows
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([label, value]) => `${label}: ${value}`);
    return [`[${title}]`, '', ...body].join('\n');
  }

  async sendAlert(message) {
    if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
      const body = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      await new Promise((resolve, reject) => {
        const req = https.request(`${TELEGRAM_API_URL}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: TELEGRAM_TIMEOUT_MS,
        }, response => {
          let data = '';
          response.on('data', chunk => { data += chunk; });
          response.once('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) resolve();
            else reject(new Error(`Telegram returned HTTP ${response.statusCode}: ${data}`));
          });
        });
        req.once('timeout', () => req.destroy(new Error(`Telegram request timed out after ${TELEGRAM_TIMEOUT_MS}ms`)));
        req.once('error', reject);
        req.end(body);
      });
    } catch (err) {
      console.warn('[ALERT] Failed:', err.message);
    }
  }

  buildTelegramStatusMessage() {
    const lines = [
      '[Ringkasan futures]',
      `${EXCHANGE_MODE.toUpperCase()} | ${LEVERAGE}x | ${MARGIN_MODE}`,
    ];
    for (const symbol of SYMBOLS) {
      const symState = this.state.getSymbol(symbol);
      const position = this.latestPositions?.get(symbol);
      const positionKnown = this.latestPositions?.has(symbol) || false;
      const unrealized = numberOrZero(position?.unrealizedPnl);
      const account = incomeMetrics(symState.accountIncome, this.latestAccountUnrealized?.get(symbol) ?? unrealized);
      const exits = sellOverview(symState.orders, position);
      lines.push(
        '', `${symbol}`,
        `PnL: ${signedUsdt(positionKnown ? account.net : null)} | Realisasi: ${signedUsdt(account.realized)}`,
        `Posisi: ${!positionKnown ? 'belum tersedia' : position ? `LONG ${displayNumber(position.contracts, 8)} | Entry ${displayNumber(position.entryPrice, 8)} | Mark ${displayNumber(position.markPrice ?? position.info?.markPrice, 8)}` : 'tidak ada'}`,
        `SELL: ${exits.nearestPrice === null ? 'belum ada' : displayNumber(exits.nearestPrice, 8)+' ('+exits.nearestLabel.toLowerCase()+')'}`
      );
    }
    return lines.join('\n');
  }

  async processFuturesTelegramCommand() {
    if (this.telegramCommandProcessing) return;
    this.telegramCommandProcessing = true;
    try {
      let command;
      try {
        command = JSON.parse(await fs.promises.readFile(futuresTelegramCommandPath, 'utf8'));
        await fs.promises.unlink(futuresTelegramCommandPath);
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn('[TELEGRAM] Could not read futures command:', err.message);
        return;
      }
      const name = String(command?.command || '').toLowerCase();
      if (name === '/futures_status') {
        await this.sendAlert(this.buildTelegramStatusMessage());
        return;
      }
      if (name === '/futures_orders') {
        const lines = ['[FUTURES ORDERS]'];
        for (const symbol of SYMBOLS) {
          const orders = await retry(() => this.exchange.fetchOpenOrders(symbol));
          const buys = orders.filter(order => String(order.side).toLowerCase() === 'buy');
          const sells = orders.filter(order => String(order.side).toLowerCase() === 'sell');
          lines.push('', `-- ${symbol} --`, `Active: ${buys.length} buy / ${sells.length} sell`);
          if (!orders.length) lines.push('No active orders');
          for (const order of orders) {
            lines.push(
              `${String(order.side).toUpperCase()} | L${this.getBotOrderLevel(order) ?? '?'} | ` +
              `${this.formatFuturesNumber(order.amount, 8)} @ ${this.formatFuturesNumber(order.price, 8)}`
            );
          }
        }
        await this.sendAlert(lines.join('\n').slice(0, 3900));
        return;
      }
      if (name === '/futures_pause' || name === '/futures_resume') {
        if (name === '/futures_pause') {
          await fs.promises.writeFile(KILL_SWITCH_PATH, `paused by telegram at ${new Date().toISOString()}\n`);
          await this.sendAlert(this.formatFuturesTelegramMessage('FUTURES PAUSED', [
            ['File', KILL_SWITCH_FILE],
            ['Trading', 'new orders paused'],
          ]));
        } else {
          try { await fs.promises.unlink(KILL_SWITCH_PATH); } catch (err) { if (err.code !== 'ENOENT') throw err; }
          await this.sendAlert(this.formatFuturesTelegramMessage('FUTURES RESUMED', [
            ['File', `${KILL_SWITCH_FILE} removed`],
            ['Trading', 'active'],
          ]));
        }
        return;
      }
      if (name === '/futures_help') {
        await this.sendAlert([
          '[FUTURES COMMANDS]',
          '',
          '/futures_status - futures summary',
          '/futures_orders - active futures orders',
          '/futures_pause - pause new futures orders',
          '/futures_resume - resume futures orders',
          '/futures_help - command list',
        ].join('\n'));
      }
    } finally {
      this.telegramCommandProcessing = false;
    }
  }

  startTelegramCommandProcessing() {
    if (
      this.telegramCommandTimer ||
      !FUTURES_TELEGRAM_COMMAND_PROCESSING_ENABLED ||
      !TELEGRAM_ENABLED ||
      !TELEGRAM_BOT_TOKEN ||
      !TELEGRAM_CHAT_ID
    ) return;
    const poll = () => this.processFuturesTelegramCommand().catch(err => {
      console.warn('[TELEGRAM] Futures command processing failed:', err.message);
    });
    this.telegramCommandTimer = setInterval(poll, TELEGRAM_COMMAND_POLL_INTERVAL_MS);
    this.telegramCommandTimer.unref?.();
    poll();
    console.log(`[TELEGRAM] Futures command queue polling every ${TELEGRAM_COMMAND_POLL_INTERVAL_MS / 1000}s`);
  }

  async start() {
    console.log(`
[FUTURES GRID BOT STARTED]
Mode: ${EXCHANGE_MODE.toUpperCase()}
Market: USDⓈ-M Perpetual Futures (binanceusdm)
Symbols: ${SYMBOLS.join(', ')}
Leverage: ${LEVERAGE}x
Margin Mode: ${MARGIN_MODE}
Position Mode: HEDGE (trading ${POSITION_SIDE} side only)
Mutual Side Exclusion: ${FUTURES_MUTUAL_EXCLUSION_ENABLED
      ? `ON (Fibonacci ownership; cross-worker lock timeout=${FUTURES_MUTUAL_ENTRY_LOCK_TIMEOUT_MS}ms)`
      : 'OFF'}
Telegram Alerts: ${TELEGRAM_ENABLED ? 'ON' : 'OFF'}
Telegram Command Processing: ${FUTURES_TELEGRAM_COMMAND_PROCESSING_ENABLED ? 'ON' : 'OFF'}
Volume Delta Entry Guard: ${VOLUME_DELTA_ENTRY_FILTER_ENABLED
      ? `ON (${VOLUME_DELTA_ENTRY_FILTER_MODE}; ${VOLUME_DELTA_LOOKBACK_CANDLES}x15m; opposition>${VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT}%; fail-${VOLUME_DELTA_FAIL_CLOSED ? 'closed' : 'open'})`
      : 'OFF'}
Grid Mode: ${GRID_MODE}
Grid Count: ${GRID_COUNT}
Order Size: ${this.getOrderSizeUsdt()} USDT/grid
Range: ${GRID_LOWER_PRICE && GRID_UPPER_PRICE ? `${GRID_LOWER_PRICE}-${GRID_UPPER_PRICE}` : `auto +/-${GRID_RANGE_PCT}%`}
Trailing Range: ${GRID_TRAILING_RANGE_ENABLED ? 'ON (auto up/down)' : 'OFF'}
Trailing Up: ${GRID_TRAILING_UP_ENABLED ? `ON (range-follow trigger, cooldown=${GRID_TRAILING_UP_COOLDOWN_MS / MINUTE_MS}m)` : 'OFF'}
Trailing Down: ${GRID_TRAILING_DOWN_ENABLED ? `ON (range-follow trigger, cooldown=${GRID_TRAILING_DOWN_COOLDOWN_MS / MINUTE_MS}m)` : 'OFF'}
Active Order Policy: ${ENTRY_SIDE} entry hard-limit=${GRID_MAX_ACTIVE_BUY_ORDERS}, ${EXIT_SIDE} exit soft-warning=${GRID_MAX_ACTIVE_SELL_ORDERS}
Exposure caps (${POSITION_SIDE} position + pending ${ENTRY_SIDE.toUpperCase()}): symbol=${FUTURES_MAX_SYMBOL_EXPOSURE_USDT} USDT, total=${FUTURES_MAX_TOTAL_EXPOSURE_USDT} USDT
Max Refills Per Level: ${GRID_MAX_REFILLS}
Aggregated Exit Ladder: ${GRID_AGGREGATED_EXIT_LADDER_ENABLED
      ? `ON (max ${GRID_AGGREGATED_EXIT_LADDER_MAX_ORDERS} orders; symbols=${GRID_AGGREGATED_EXIT_LADDER_SYMBOLS.join(',') || 'all'})`
      : 'OFF'}
Recreate On Start: ${GRID_RECREATE_ON_START ? 'ON' : 'OFF'}
Post Only (Maker): ${GRID_POST_ONLY ? 'ON' : 'OFF'}
Binance User Data WebSocket: ${FUTURES_USER_STREAM_ENABLED
      ? `ON (fill debounce=${FUTURES_USER_STREAM_RECONCILE_DEBOUNCE_MS}ms, REST reconciliation retained)`
      : 'OFF'}
Multi-timeframe Fibonacci: ${FIBONACCI_RANGE_ADVISOR_ENABLED
      ? `ON (timeframes=${FIBONACCI_RANGE_ADVISOR_TIMEFRAMES.join(',')}, min-range-width=${FIBONACCI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT}%, trailing=${FIBONACCI_RANGE_ADVISOR_ALLOW_TRAILING ? 'allowed' : 'paused while active'})`
      : 'OFF'}
Fibonacci Direction (deterministic): ${FIBONACCI_DIRECTION_ANALYZER_ENABLED
      ? `ON (mode=${FIBONACCI_DIRECTION_APPLY_MODE}, strategy=${FIBONACCI_DIRECTION_STRATEGY}, timeframes=${FIBONACCI_DIRECTION_TIMEFRAMES.join(',')}, confirmations=${FIBONACCI_DIRECTION_CONFIRMATIONS}, min-confidence=${FIBONACCI_DIRECTION_MIN_CONFIDENCE}, ema-slope-threshold=${FIBONACCI_DIRECTION_EMA_SLOPE_ATR_THRESHOLD}, level-bias=${FIBONACCI_DIRECTION_LEVEL_BIAS_PCT}%)`
      : 'OFF'}
Adaptive Grid Supervisor: ${ADAPTIVE_GRID_SUPERVISOR_ENABLED
      ? `ON (${ADAPTIVE_GRID_SUPERVISOR_MODE}; profile-confirmations=${ADAPTIVE_GRID_SUPERVISOR_PROFILE_CONFIRMATIONS}, cooldown=${ADAPTIVE_GRID_SUPERVISOR_COOLDOWN_MS / MINUTE_MS}m)`
      : 'OFF'}
Adaptive Risk State Machine: ${ADAPTIVE_RISK_STATE_MACHINE_ENABLED
      ? `ON (${ADAPTIVE_RISK_STATE_MACHINE_MODE}; caution-exposure=${ADAPTIVE_RISK_STATE_MACHINE_CAUTION_EXPOSURE_PCT}%, risk-exposure=${ADAPTIVE_RISK_STATE_MACHINE_RISK_EXPOSURE_PCT}%, loss=${ADAPTIVE_RISK_STATE_MACHINE_LOSS_WARNING_PCT}/${ADAPTIVE_RISK_STATE_MACHINE_LOSS_RISK_OFF_PCT}%, liquidation=${ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_WARNING_PCT}/${ADAPTIVE_RISK_STATE_MACHINE_LIQUIDATION_CRITICAL_PCT}%)`
      : 'OFF'}
Adaptive Supervisor Outcome Journal: ${ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_ENABLED
      ? `ON (${ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_MODE}; outcomes=4h/24h; observation only)`
      : 'OFF'}
`);
    await this.init();
    await this.startUserStream();
    startFuturesDashboardServer(this);
    this.startTelegramCommandProcessing();
    while (true) {
      await sleep(INTERVAL_MS);
      await this.executeCycle();
    }
  }
}

Object.assign(FuturesGridEngine.prototype, {
  deferUnreconciledSell,
  remapDelayedSellOrderMeta,
  retryUnreconciledSells,
});

async function bootstrap() {
  validateRuntimeConfiguration();

  // Remove any *.tmp files left behind by a previous crashed process before
  // acquiring the lock so they don't interfere with new atomic writes.
  await AtomicFileWriter.cleanupStaleTempFiles(GRID_STATE_PATH);

  const lock = new ProcessLock(BOT_LOCK_PATH);
  lock.acquire();
  let engine = null;
  const shutdown = signal => {
    console.log(`[SHUTDOWN] ${signal}`);
    engine?.stopAuxiliaryServices();
    lock.release();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('exit', () => lock.release());

  try {
    engine = new FuturesGridEngine();
    await engine.start();
  } finally {
    engine?.stopAuxiliaryServices();
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
  FuturesGridEngine,
  AdaptiveSupervisorOutcomeJournal,
  FibonacciDirectionAnalyzer,
  AdaptiveGridSupervisor,
  bootstrap,
  validateRuntimeConfiguration,
};
