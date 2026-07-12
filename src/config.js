require('dotenv').config();
const ccxt = require('ccxt');
const path = require('path');
const { roundNumber } = require('./utils');

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
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
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
const SYMBOLS = Config.list('SYMBOLS', 'BTC/USDT');
const EXCHANGE_MODE = (() => {
  const mode = Config.get('EXCHANGE_MODE', 'testnet').toLowerCase();
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
const GEMINI_RANGE_ADVISOR_TIMEFRAME = Config.get('GEMINI_RANGE_ADVISOR_TIMEFRAME', '1h');

// Converts a ccxt-style timeframe string (e.g. '1m', '15m', '1h', '4h', '1d')
// into milliseconds. Prefers ccxt's own parser (so it stays consistent with
// however the exchange defines each unit) and falls back to a manual regex
// parser, then to 60 minutes, if that's unavailable or the string is invalid.
function timeframeToMs(timeframe) {
  const fallbackMs = 60 * MINUTE_MS;
  if (typeof timeframe !== 'string' || !timeframe.trim()) return fallbackMs;
  if (ccxt?.Exchange?.parseTimeframe) {
    try {
      const seconds = ccxt.Exchange.parseTimeframe(timeframe);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    } catch (err) {
      // fall through to manual parsing below
    }
  }
  const match = /^(\d+)([mhdwM])$/.exec(timeframe.trim());
  if (!match) {
    console.warn(
      `[CONFIG] Could not parse GEMINI_RANGE_ADVISOR_TIMEFRAME "${timeframe}"; defaulting interval sync to 60m.`
    );
    return fallbackMs;
  }
  const amount = Number(match[1]);
  const unitMs = {
    m: MINUTE_MS,
    h: 60 * MINUTE_MS,
    d: 24 * 60 * MINUTE_MS,
    w: 7 * 24 * 60 * MINUTE_MS,
    M: 30 * 24 * 60 * MINUTE_MS,
  }[match[2]];
  return amount * unitMs;
}

const GEMINI_RANGE_ADVISOR_TIMEFRAME_MS = timeframeToMs(GEMINI_RANGE_ADVISOR_TIMEFRAME);

// Small grace period after an exchange candle-close boundary before the advisor
// is allowed to fetch it, in case the exchange takes a moment to finalize/publish
// the just-closed candle. Doesn't delay by a full cycle - just a few seconds.
const GEMINI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS = Math.max(
  Config.number('GEMINI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_SECONDS', 5),
  0
) * 1000;

// Gemini is called at most once per candle close for GEMINI_RANGE_ADVISOR_TIMEFRAME
// (e.g. once an hour for '1h'), never more often - a new candle for that
// timeframe only closes once per period, so calling more often would just
// re-analyze the same OHLCV data and burn API quota for no new information.
// Change GEMINI_RANGE_ADVISOR_TIMEFRAME if you want a different call frequency.
const GEMINI_RANGE_ADVISOR_CANDLE_LIMIT = Config.number('GEMINI_RANGE_ADVISOR_CANDLE_LIMIT', 100);
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
const KILL_SWITCH_ENABLED = Config.boolean('KILL_SWITCH_ENABLED', true);
const STOP_TRADING = Config.isTrue('STOP_TRADING');
const KILL_SWITCH_FILE = Config.get('KILL_SWITCH_FILE', 'bot-paused.flag');
const KILL_SWITCH_PATH = path.resolve(process.cwd(), KILL_SWITCH_FILE);

const TELEGRAM_ENABLED = Config.boolean('TELEGRAM_ENABLED', false);
const TELEGRAM_BOT_TOKEN = Config.get('TELEGRAM_BOT_TOKEN', '');
const TELEGRAM_CHAT_ID = Config.get('TELEGRAM_CHAT_ID', '');
const TELEGRAM_API_URL = Config.get('TELEGRAM_API_URL', 'https://api.telegram.org');
const TELEGRAM_TIMEOUT_MS = Config.number('TELEGRAM_TIMEOUT_MS', 10_000);
const TELEGRAM_STATUS_REPORT_ENABLED = Config.boolean('TELEGRAM_STATUS_REPORT_ENABLED', false);
const TELEGRAM_STATUS_REPORT_INTERVAL_MS = Math.max(
  Config.number('TELEGRAM_STATUS_REPORT_INTERVAL_MINUTES', 60),
  1
) * MINUTE_MS;
const TELEGRAM_COMMANDS_ENABLED = Config.boolean('TELEGRAM_COMMANDS_ENABLED', TELEGRAM_ENABLED);
const TELEGRAM_COMMAND_POLL_INTERVAL_MS = Math.max(
  Config.number('TELEGRAM_COMMAND_POLL_INTERVAL_SECONDS', 5),
  1
) * 1000;
const TELEGRAM_COMMANDS_SKIP_OLD_UPDATES = Config.boolean('TELEGRAM_COMMANDS_SKIP_OLD_UPDATES', true);

const MAX_PROCESSED_TRADE_IDS = 2000;
const TRADE_FETCH_LIMIT = 100;
const CIRCUIT_BREAKER_MAX_ERRORS = 5;
const CIRCUIT_BREAKER_PAUSE_MS = 15 * MINUTE_MS;

function hasManualGridRange() {
  return GRID_LOWER_PRICE > 0 && GRID_UPPER_PRICE > 0;
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
  requirePositive('TELEGRAM_TIMEOUT_MS', TELEGRAM_TIMEOUT_MS);
  requirePositive('TELEGRAM_STATUS_REPORT_INTERVAL_MS', TELEGRAM_STATUS_REPORT_INTERVAL_MS);
  requirePositive('TELEGRAM_COMMAND_POLL_INTERVAL_MS', TELEGRAM_COMMAND_POLL_INTERVAL_MS);

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
  if ((TELEGRAM_STATUS_REPORT_ENABLED || TELEGRAM_COMMANDS_ENABLED) && !TELEGRAM_ENABLED) {
    errors.push('TELEGRAM_ENABLED=true is required when Telegram status reports or commands are enabled');
  }
  if (GEMINI_RANGE_ADVISOR_ENABLED) {
    if (!GEMINI_API_KEY) errors.push('GEMINI_API_KEY is required when GEMINI_RANGE_ADVISOR_ENABLED=true');
    requirePositive('GEMINI_RANGE_ADVISOR_CANDLE_LIMIT', GEMINI_RANGE_ADVISOR_CANDLE_LIMIT);
    requirePositive('GEMINI_RANGE_ADVISOR_TIMEOUT_MS', GEMINI_RANGE_ADVISOR_TIMEOUT_MS);
    requireNonNegative('GEMINI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS', GEMINI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS);
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

module.exports = {
  Config,
  SYMBOLS,
  EXCHANGE_MODE,
  VALID_EXCHANGE_MODES,
  VALID_GRID_MODES,
  MINUTE_MS,
  INTERVAL_MINUTES,
  INTERVAL_MS,
  GRID_COUNT,
  GRID_MODE,
  GRID_LOWER_PRICE,
  GRID_UPPER_PRICE,
  GRID_RANGE_PCT,
  GRID_RESET_RANGE_ON_START,
  GRID_STALE_RANGE_DEVIATION_PCT,
  GRID_STALE_RANGE_AUTO_RESET,
  GRID_TRAILING_RANGE_ENABLED,
  GRID_TRAILING_UP_ENABLED,
  GRID_TRAILING_UP_COOLDOWN_MS,
  GRID_TRAILING_DOWN_ENABLED,
  GRID_TRAILING_DOWN_COOLDOWN_MS,
  GRID_ORDER_SIZE_USDT,
  GRID_TOTAL_INVESTMENT_USDT,
  GRID_MAX_ACTIVE_BUY_ORDERS,
  GRID_MAX_ACTIVE_SELL_ORDERS,
  GRID_RECREATE_ON_START,
  GRID_CANCEL_OUT_OF_RANGE,
  GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MS,
  GRID_REFILL_ON_FILLED,
  GRID_STATE_FILE,
  GRID_STATE_PATH,
  BOT_LOCK_FILE,
  BOT_LOCK_PATH,
  BOT_LOCK_STALE_GRACE_MS,
  GRID_POST_ONLY,
  GRID_PRICE_PRECISION_MAX_DEVIATION_PCT,
  GEMINI_RANGE_ADVISOR_ENABLED,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GEMINI_API_BASE_URL,
  GEMINI_RANGE_ADVISOR_TIMEFRAME,
  GEMINI_RANGE_ADVISOR_TIMEFRAME_MS,
  GEMINI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS,
  GEMINI_RANGE_ADVISOR_CANDLE_LIMIT,
  GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT,
  GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT,
  GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE,
  GEMINI_RANGE_ADVISOR_TIMEOUT_MS,
  GEMINI_RANGE_ADVISOR_APPLY_ON,
  GEMINI_RANGE_ADVISOR_STATE_FILE,
  GEMINI_RANGE_ADVISOR_STATE_PATH,
  STOP_LOSS_PRICE,
  TAKE_PROFIT_PRICE,
  KILL_SWITCH_ENABLED,
  STOP_TRADING,
  KILL_SWITCH_FILE,
  KILL_SWITCH_PATH,
  TELEGRAM_ENABLED,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_API_URL,
  TELEGRAM_TIMEOUT_MS,
  TELEGRAM_STATUS_REPORT_ENABLED,
  TELEGRAM_STATUS_REPORT_INTERVAL_MS,
  TELEGRAM_COMMANDS_ENABLED,
  TELEGRAM_COMMAND_POLL_INTERVAL_MS,
  TELEGRAM_COMMANDS_SKIP_OLD_UPDATES,
  MAX_PROCESSED_TRADE_IDS,
  TRADE_FETCH_LIMIT,
  CIRCUIT_BREAKER_MAX_ERRORS,
  CIRCUIT_BREAKER_PAUSE_MS,
  timeframeToMs,
  hasManualGridRange,
  validateRuntimeConfiguration
};
