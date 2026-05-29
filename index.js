// ======================================================
// SMART BINANCE AI FUTURES BOT
// FULL SMART VERSION
// MTF + AI + ANTI WHIPSAW + STOP MARKET
// ======================================================
require("dotenv").config();
const ccxt = require("ccxt");
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ======================================================
// CONFIG
// ======================================================
const DEFAULT_MEME_SYMBOLS =
  "DOGE/USDT:USDT,1000SHIB/USDT:USDT,1000PEPE/USDT:USDT,1000FLOKI/USDT:USDT,1000BONK/USDT:USDT";
const SYMBOL_INPUT =
  process.env.SYMBOLS ||
  process.env.MEME_SYMBOLS ||
  process.env.SYMBOL ||
  DEFAULT_MEME_SYMBOLS;
const SYMBOLS = SYMBOL_INPUT
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SCAN_SYMBOLS =
  SYMBOLS.length > 0 ? SYMBOLS : DEFAULT_MEME_SYMBOLS.split(",");
const MAX_OPEN_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS || 1);
const LEVERAGE = Number(process.env.LEVERAGE || 10);
const ORDER_SIZE_USDT = Number(process.env.ORDER_SIZE_USDT || 5);
const TIMEFRAME = process.env.TIMEFRAME || "5m";
const HTF_TIMEFRAME = process.env.HTF_TIMEFRAME || "15m";
const LOOKBACK_CANDLES = Number(process.env.LOOKBACK_CANDLES || 200);
const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || 5);
const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;

// ======================================================
// EMERGENCY CONTROL
// ======================================================
const KILL_SWITCH_ENABLED = process.env.KILL_SWITCH_ENABLED !== "false";
const STOP_TRADING = process.env.STOP_TRADING === "true";
const KILL_SWITCH_FILE = process.env.KILL_SWITCH_FILE || "bot-paused.flag";
const KILL_SWITCH_PATH = path.resolve(process.cwd(), KILL_SWITCH_FILE);
const ORDER_RECOVERY_ENABLED = process.env.ORDER_RECOVERY_ENABLED !== "false";

// ======================================================
// PROFIT TRACKER
// ======================================================
const PROFIT_TRACKER_ENABLED = process.env.PROFIT_TRACKER_ENABLED !== "false";
const PROFIT_TRACKER_FILE =
  process.env.PROFIT_TRACKER_FILE || "profit-ledger.json";
const PROFIT_SYNC_LIMIT = Number(process.env.PROFIT_SYNC_LIMIT || 100);
const PROFIT_LEDGER_PATH = path.resolve(process.cwd(), PROFIT_TRACKER_FILE);
const RISK_STATE_FILE = process.env.RISK_STATE_FILE || "risk-state.json";
const RISK_STATE_PATH = path.resolve(process.cwd(), RISK_STATE_FILE);

// ======================================================
// RISK
// ======================================================
const MAX_FUNDING_RATE = Number(process.env.MAX_FUNDING_RATE || 0.1) / 100;
const MIN_RR = Number(process.env.MIN_RR || 1.5);
const RISK_PER_TRADE_PCT = Number(process.env.RISK_PER_TRADE_PCT || 1) / 100;
const MAX_DAILY_LOSS_PCT = Number(process.env.MAX_DAILY_LOSS_PCT || 3) / 100;
const MAX_DAILY_LOSS_USDT = Number(process.env.MAX_DAILY_LOSS_USDT || 0);
const MAX_CONSECUTIVE_LOSSES = Number(
  process.env.MAX_CONSECUTIVE_LOSSES || 3,
);
const MAX_POSITION_NOTIONAL_USDT = Number(
  process.env.MAX_POSITION_NOTIONAL_USDT || ORDER_SIZE_USDT * LEVERAGE,
);

// ======================================================
// ATR
// ======================================================
const ATR_TP_MULTIPLIER = Number(process.env.ATR_TP_MULTIPLIER || 1.8);

// ======================================================
// TRAILING
// ======================================================
const TRAILING_CALLBACK_MIN = Number(process.env.TRAILING_CALLBACK_MIN || 0.3);
const TRAILING_CALLBACK_MAX = Number(process.env.TRAILING_CALLBACK_MAX || 1.5);

// ======================================================
// PARTIAL TP
// ======================================================
const TP1_PERCENT = Number(process.env.TP1_PERCENT || 30);
const TP2_PERCENT = Number(process.env.TP2_PERCENT || 40);
const TP1_RR = Number(process.env.TP1_RR || 1.0);
const TP2_RR = Number(process.env.TP2_RR || 2.0);

// ======================================================
// FILTER
// ======================================================
const REQUIRED_CONFIRMATION = Number(process.env.REQUIRED_CONFIRMATION || 2);
const SIDEWAYS_EMA_GAP = Number(process.env.SIDEWAYS_EMA_GAP || 0.04);
const REVERSAL_COOLDOWN_MINUTES = Number(
  process.env.REVERSAL_COOLDOWN_MINUTES || 10,
);
const LONG_ONLY = process.env.LONG_ONLY !== "false";
const REGIME_FILTER_ENABLED = process.env.REGIME_FILTER_ENABLED !== "false";
const ALLOWED_MARKET_REGIMES = (
  process.env.ALLOWED_MARKET_REGIMES || "TRENDING_UP,TRENDING_DOWN"
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const MAX_ATR_PCT = Number(process.env.MAX_ATR_PCT || 2.5) / 100;
const MIN_ATR_PCT = Number(process.env.MIN_ATR_PCT || 0.15) / 100;
const MIN_VOLUME_CHANGE_FOR_TREND = Number(
  process.env.MIN_VOLUME_CHANGE_FOR_TREND || -20,
);
const SYMBOL_COOLDOWN_ENABLED =
  process.env.SYMBOL_COOLDOWN_ENABLED !== "false";
const SYMBOL_COOLDOWN_MINUTES = Number(
  process.env.SYMBOL_COOLDOWN_MINUTES || 30,
);
const SYMBOL_ERROR_COOLDOWN_MINUTES = Number(
  process.env.SYMBOL_ERROR_COOLDOWN_MINUTES || 5,
);
const SCAN_ROTATION_BATCH_SIZE = Math.max(
  1,
  Number(process.env.SCAN_ROTATION_BATCH_SIZE || 2),
);
const ROTATING_SCAN_ENABLED = SCAN_ROTATION_BATCH_SIZE < SCAN_SYMBOLS.length;
const EFFECTIVE_REQUIRED_CONFIRMATION = ROTATING_SCAN_ENABLED
  ? 1
  : REQUIRED_CONFIRMATION;

// ======================================================
// AI
// ======================================================
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash-lite";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
});
const AI_FILTER_ENABLED = process.env.AI_FILTER_ENABLED !== "false";
const MIN_AI_CONFIDENCE = Number(process.env.MIN_AI_CONFIDENCE || 65);
const ALLOWED_AI_STRENGTHS = (
  process.env.ALLOWED_AI_STRENGTHS || "MEDIUM,STRONG,EXTREME"
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const AI_RESPONSE_RETRIES = Number(process.env.AI_RESPONSE_RETRIES || 2);
const AI_EXPLAIN_LOG_ENABLED =
  process.env.AI_EXPLAIN_LOG_ENABLED !== "false";
const AI_EXPLAIN_LOG_FILE =
  process.env.AI_EXPLAIN_LOG_FILE || "ai-explain-log.jsonl";
const AI_EXPLAIN_LOG_MAX_LINES = Number(
  process.env.AI_EXPLAIN_LOG_MAX_LINES || 5000,
);
const AI_EXPLAIN_LOG_PATH = path.resolve(process.cwd(), AI_EXPLAIN_LOG_FILE);

// ======================================================
// CIRCUIT BREAKER
// ======================================================
const CIRCUIT_BREAKER_ENABLED =
  process.env.CIRCUIT_BREAKER_ENABLED !== "false";
const CIRCUIT_BREAKER_MAX_ERRORS = Number(
  process.env.CIRCUIT_BREAKER_MAX_ERRORS || 5,
);
const CIRCUIT_BREAKER_PAUSE_MINUTES = Number(
  process.env.CIRCUIT_BREAKER_PAUSE_MINUTES || 15,
);

// ======================================================
// EXCHANGE
// ======================================================
const exchange = new ccxt.binance({
  apiKey: process.env.EXCHANGE_API_KEY,
  secret: process.env.EXCHANGE_SECRET,
  enableRateLimit: true,
  options: {
    defaultType: "future",
  },
});
if (process.env.EXCHANGE_DEMO === "true") {
  exchange.enable_demo_trading(true);
  console.log("[DEMO] Futures demo mode enabled");
}

// ======================================================
// GLOBAL
// ======================================================
let isTrading = false;
let signalStateBySymbol = {};
let lastPositionChangeTime = 0;
let profitLedger = loadProfitLedger();
let riskState = loadRiskState();
let circuitBreakerState = {
  consecutiveErrors: 0,
  pausedUntil: 0,
  lastError: null,
};

// ======================================================
// UTILS
// ======================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const last = i === retries - 1;
      console.warn(`[WARN] Retry ${i + 1}/${retries}:`, err.message);
      if (last) throw err;
      await sleep(delay);
    }
  }
}

function getNextCandleDelay() {
  const now = Date.now();
  const next = Math.ceil(now / INTERVAL_MS) * INTERVAL_MS;
  return next - now;
}

function killSwitchActive() {
  if (!KILL_SWITCH_ENABLED) return false;
  if (STOP_TRADING) {
    console.warn("[KILL] STOP_TRADING=true, new entries are disabled");
    return true;
  }
  if (fs.existsSync(KILL_SWITCH_PATH)) {
    console.warn(
      `[KILL] ${KILL_SWITCH_FILE} exists, new entries are disabled`,
    );
    return true;
  }
  return false;
}

function roundNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(digits));
}

function snapshotForExplainLog(snapshot) {
  if (!snapshot) return null;
  return {
    price: roundNumber(snapshot.price, 10),
    fundingRate: roundNumber(snapshot.fundingRate, 8),
    trend: snapshot.trend,
    ema20: roundNumber(snapshot.ema20, 10),
    ema50: roundNumber(snapshot.ema50, 10),
    ema20Slope: roundNumber(snapshot.ema20Slope, 10),
    ema50Slope: roundNumber(snapshot.ema50Slope, 10),
    emaGap: roundNumber(snapshot.emaGap, 4),
    rsi: roundNumber(snapshot.rsi, 2),
    atr: roundNumber(snapshot.atr, 10),
    volumeChange: roundNumber(snapshot.volumeChange, 2),
  };
}

function pruneAIExplainLogIfNeeded() {
  if (!AI_EXPLAIN_LOG_MAX_LINES || AI_EXPLAIN_LOG_MAX_LINES <= 0) return;
  if (!fs.existsSync(AI_EXPLAIN_LOG_PATH)) return;
  const lines = fs
    .readFileSync(AI_EXPLAIN_LOG_PATH, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length <= AI_EXPLAIN_LOG_MAX_LINES) return;
  fs.writeFileSync(
    AI_EXPLAIN_LOG_PATH,
    `${lines.slice(-AI_EXPLAIN_LOG_MAX_LINES).join("\n")}\n`,
  );
}

function logAIExplainDecision(event) {
  if (!AI_EXPLAIN_LOG_ENABLED) return;
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      bot: "smart-binance-ai-futures-bot",
      timeframe: TIMEFRAME,
      htfTimeframe: HTF_TIMEFRAME,
      longOnly: LONG_ONLY,
      minAiConfidence: MIN_AI_CONFIDENCE,
      allowedAiStrengths: ALLOWED_AI_STRENGTHS,
      minRR: MIN_RR,
      ...event,
      snapshot: snapshotForExplainLog(event.snapshot),
      htfSnapshot: snapshotForExplainLog(event.htfSnapshot),
    };
    fs.appendFileSync(AI_EXPLAIN_LOG_PATH, `${JSON.stringify(entry)}\n`);
    pruneAIExplainLogIfNeeded();
  } catch (err) {
    console.warn(`[WARN] Failed to write AI explain log: ${err.message}`);
  }
}

function createEmptyProfitLedger() {
  const now = new Date().toISOString();
  return {
    symbol: SCAN_SYMBOLS.join(","),
    startedAt: now,
    updatedAt: now,
    lastTradeTimestamp: Date.now(),
    processedTradeIds: [],
    totals: {
      grossRealizedPnl: 0,
      fees: 0,
      netProfit: 0,
      tradeCount: 0,
      profitEvents: 0,
      lossEvents: 0,
    },
    recentTrades: [],
  };
}

function normalizeProfitLedger(ledger) {
  const empty = createEmptyProfitLedger();
  return {
    ...empty,
    ...ledger,
    symbol: ledger.symbol || SCAN_SYMBOLS.join(","),
    processedTradeIds: Array.isArray(ledger.processedTradeIds)
      ? ledger.processedTradeIds
      : [],
    totals: {
      ...empty.totals,
      ...(ledger.totals || {}),
    },
    recentTrades: Array.isArray(ledger.recentTrades) ? ledger.recentTrades : [],
  };
}

function loadProfitLedger() {
  if (!fs.existsSync(PROFIT_LEDGER_PATH)) return createEmptyProfitLedger();
  try {
    const raw = fs.readFileSync(PROFIT_LEDGER_PATH, "utf8");
    return normalizeProfitLedger(JSON.parse(raw));
  } catch (err) {
    console.warn("[WARN] Profit ledger reset:", err.message);
    return createEmptyProfitLedger();
  }
}

function saveProfitLedger() {
  profitLedger.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROFIT_LEDGER_PATH, JSON.stringify(profitLedger, null, 2));
}

function tradeIdOf(trade) {
  return String(
    trade.id ||
      trade.info?.id ||
      `${trade.timestamp}-${trade.order}-${trade.side}-${trade.amount}-${trade.price}`,
  );
}

function numberFromTrade(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function getRealizedPnl(trade) {
  return numberFromTrade(
    trade.info?.realizedPnl || trade.info?.realizedProfit || trade.realizedPnl,
  );
}

function getTradeFee(trade) {
  const feeCost = numberFromTrade(trade.fee?.cost);
  if (feeCost > 0) return feeCost;
  return Math.abs(numberFromTrade(trade.info?.commission));
}

function applyTradeToProfitLedger(trade) {
  const id = tradeIdOf(trade);
  if (profitLedger.processedTradeIds.includes(id)) {
    return false;
  }
  const realizedPnl = getRealizedPnl(trade);
  const fee = getTradeFee(trade);
  const netProfit = realizedPnl - fee;
  profitLedger.processedTradeIds.push(id);
  profitLedger.processedTradeIds = profitLedger.processedTradeIds.slice(-1000);
  profitLedger.lastTradeTimestamp = Math.max(
    Number(profitLedger.lastTradeTimestamp || 0),
    Number(trade.timestamp || 0),
  );
  profitLedger.totals.grossRealizedPnl += realizedPnl;
  profitLedger.totals.fees += fee;
  profitLedger.totals.netProfit += netProfit;
  profitLedger.totals.tradeCount++;
  if (netProfit > 0) profitLedger.totals.profitEvents++;
  if (netProfit < 0) profitLedger.totals.lossEvents++;
  profitLedger.recentTrades.unshift({
    id,
    symbol: trade.symbol,
    time:
      trade.datetime || new Date(trade.timestamp || Date.now()).toISOString(),
    side: trade.side,
    price: numberFromTrade(trade.price),
    amount: numberFromTrade(trade.amount),
    realizedPnl,
    fee,
    netProfit,
    order: trade.order || trade.info?.orderId,
  });
  profitLedger.recentTrades = profitLedger.recentTrades.slice(0, 30);
  return true;
}

function logProfitSummary(newTrades = 0) {
  const totals = profitLedger.totals;
  console.log(`
[PROFIT] Summary

New trades synced:
${newTrades}

Gross realized PnL:
${totals.grossRealizedPnl.toFixed(6)} USDT

Fees:
${totals.fees.toFixed(6)} USDT

TOTAL NET PROFIT:
${totals.netProfit.toFixed(6)} USDT

Profit/loss events:
${totals.profitEvents}/${totals.lossEvents}
`);
}

function getUtcDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createEmptyRiskState() {
  const now = new Date().toISOString();
  return {
    dayKey: null,
    dayStartEquity: 0,
    dailyNetPnL: 0,
    consecutiveLosses: 0,
    processedTradeIds: [],
    symbolCooldowns: {},
    scanRotationIndex: 0,
    lastSyncedAt: 0,
    updatedAt: now,
  };
}

function normalizeRiskState(state) {
  const empty = createEmptyRiskState();
  return {
    ...empty,
    ...state,
    processedTradeIds: Array.isArray(state?.processedTradeIds)
      ? state.processedTradeIds
      : [],
    symbolCooldowns:
      state?.symbolCooldowns && typeof state.symbolCooldowns === "object"
        ? state.symbolCooldowns
        : {},
    scanRotationIndex: Number.isFinite(Number(state?.scanRotationIndex))
      ? Math.max(0, Number(state.scanRotationIndex))
      : 0,
  };
}

function loadRiskState() {
  if (!fs.existsSync(RISK_STATE_PATH)) {
    return createEmptyRiskState();
  }
  try {
    const raw = fs.readFileSync(RISK_STATE_PATH, "utf8");
    return normalizeRiskState(JSON.parse(raw));
  } catch (err) {
    console.warn("[WARN] Risk state reset:", err.message);
    return createEmptyRiskState();
  }
}

function saveRiskState() {
  riskState.updatedAt = new Date().toISOString();
  fs.writeFileSync(RISK_STATE_PATH, JSON.stringify(riskState, null, 2));
}

function setSymbolCooldown(symbol, minutes, reason) {
  if (!SYMBOL_COOLDOWN_ENABLED || minutes <= 0 || !symbol) return;
  riskState.symbolCooldowns = riskState.symbolCooldowns || {};
  const until = Date.now() + minutes * 60 * 1000;
  riskState.symbolCooldowns[symbol] = {
    until,
    reason,
    updatedAt: new Date().toISOString(),
  };
  console.warn(
    `[COOLDOWN] ${symbol} paused for ${minutes}m: ${reason}`,
  );
}

function cleanupSymbolCooldowns() {
  if (!riskState.symbolCooldowns) return false;
  const now = Date.now();
  let changed = false;
  for (const [symbol, cooldown] of Object.entries(riskState.symbolCooldowns)) {
    if (!cooldown?.until || Number(cooldown.until) <= now) {
      delete riskState.symbolCooldowns[symbol];
      changed = true;
    }
  }
  return changed;
}

function getRotatedScanSymbols() {
  if (!Array.isArray(SCAN_SYMBOLS) || SCAN_SYMBOLS.length === 0) return [];
  const total = SCAN_SYMBOLS.length;
  const batchSize = Math.min(SCAN_ROTATION_BATCH_SIZE, total);
  const start = riskState.scanRotationIndex % total;
  const rotated = [];
  for (let i = 0; i < batchSize; i++) {
    rotated.push(SCAN_SYMBOLS[(start + i) % total]);
  }
  riskState.scanRotationIndex = (start + batchSize) % total;
  return rotated;
}

function symbolCooldownAllowsTrading(symbol) {
  if (!SYMBOL_COOLDOWN_ENABLED) return true;
  const cooldown = riskState.symbolCooldowns?.[symbol];
  if (!cooldown) return true;
  const remainingMs = Number(cooldown.until || 0) - Date.now();
  if (remainingMs <= 0) {
    delete riskState.symbolCooldowns[symbol];
    saveRiskState();
    return true;
  }
  const remainingMinutes = Math.ceil(remainingMs / 60000);
  console.log(
    `[COOLDOWN] ${symbol} skipped for ${remainingMinutes}m: ${cooldown.reason}`,
  );
  return false;
}

async function getAccountEquity() {
  const balance = await retry(() => exchange.fetchBalance());
  return Number(balance?.USDT?.total || balance?.USDT?.free || 0);
}

function isRealizedTrade(trade) {
  const realizedPnl = getRealizedPnl(trade);
  return Math.abs(realizedPnl) > 0.0000001;
}

function applyTradeToRiskState(trade) {
  const id = tradeIdOf(trade);
  if (riskState.processedTradeIds.includes(id)) {
    return false;
  }

  const realizedPnl = getRealizedPnl(trade);
  const fee = getTradeFee(trade);
  const netProfit = realizedPnl - fee;

  riskState.processedTradeIds.push(id);
  riskState.processedTradeIds = riskState.processedTradeIds.slice(-1000);
  riskState.lastSyncedAt = Math.max(
    Number(riskState.lastSyncedAt || 0),
    Number(trade.timestamp || 0),
  );
  riskState.dailyNetPnL += netProfit;

  if (isRealizedTrade(trade)) {
    if (netProfit < 0) {
      riskState.consecutiveLosses += 1;
      setSymbolCooldown(
        trade.symbol,
        SYMBOL_COOLDOWN_MINUTES,
        `realized loss ${netProfit.toFixed(6)} USDT`,
      );
    } else if (netProfit > 0) {
      riskState.consecutiveLosses = 0;
    }
  }

  return true;
}

function getDailyLossLimit() {
  if (riskState.dayStartEquity <= 0) {
    return MAX_DAILY_LOSS_USDT > 0 ? MAX_DAILY_LOSS_USDT : Infinity;
  }
  const percentLimit = riskState.dayStartEquity * MAX_DAILY_LOSS_PCT;
  if (MAX_DAILY_LOSS_USDT > 0) {
    return Math.min(percentLimit, MAX_DAILY_LOSS_USDT);
  }
  return percentLimit;
}

function resetDailyRiskState(dayKey, equity) {
  riskState = {
    ...createEmptyRiskState(),
    dayKey,
    dayStartEquity: equity,
  };
  saveRiskState();
}

function ensureDailyRiskState(dayKey, equity) {
  if (riskState.dayKey !== dayKey) {
    resetDailyRiskState(dayKey, equity);
    return;
  }
  if (!riskState.dayStartEquity && equity > 0) {
    riskState.dayStartEquity = equity;
    saveRiskState();
  }
}

async function syncRiskState() {
  try {
    const equity = await getAccountEquity();
    const dayKey = getUtcDayKey();
    ensureDailyRiskState(dayKey, equity);

    const dayStart = new Date(`${dayKey}T00:00:00.000Z`).getTime();
    const since = Math.max(
      dayStart,
      Number(riskState.lastSyncedAt || 0) > 0
        ? Number(riskState.lastSyncedAt) - 1
        : dayStart,
    );

    let newTrades = 0;
    for (const symbol of SCAN_SYMBOLS) {
      let sortedTrades = [];
      try {
        const trades = await retry(() =>
          exchange.fetchMyTrades(symbol, since, PROFIT_SYNC_LIMIT),
        );
        sortedTrades = trades
          .filter((trade) => !trade.symbol || trade.symbol === symbol)
          .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      } catch (err) {
        console.warn(`${symbol} risk trade sync skipped: ${err.message}`);
        continue;
      }

      for (const trade of sortedTrades) {
        if (applyTradeToRiskState(trade)) {
          newTrades++;
        }
      }
    }

    if (newTrades > 0) {
      saveRiskState();
    }

    console.log(`
[RISK] Summary

Day equity start:
${riskState.dayStartEquity.toFixed(2)} USDT

Daily net PnL:
${riskState.dailyNetPnL.toFixed(2)} USDT

Consecutive losses:
${riskState.consecutiveLosses}
`);
  } catch (err) {
    console.warn("[WARN] Risk sync skipped:", err.message);
  }
}

function riskGateAllowsTrading() {
  if (cleanupSymbolCooldowns()) {
    saveRiskState();
  }

  const dailyLossLimit = getDailyLossLimit();
  if (dailyLossLimit > 0 && riskState.dailyNetPnL <= -dailyLossLimit) {
    console.warn(
      `[BLOCK] Daily loss limit reached: ${riskState.dailyNetPnL.toFixed(2)} / -${dailyLossLimit.toFixed(2)} USDT`,
    );
    return false;
  }

  if (
    MAX_CONSECUTIVE_LOSSES > 0 &&
    riskState.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES
  ) {
    console.warn(
      `[BLOCK] Consecutive loss limit reached: ${riskState.consecutiveLosses}/${MAX_CONSECUTIVE_LOSSES}`,
    );
    return false;
  }

  return true;
}

function circuitBreakerAllowsTrading() {
  if (!CIRCUIT_BREAKER_ENABLED) return true;
  const remainingMs = circuitBreakerState.pausedUntil - Date.now();
  if (remainingMs <= 0) return true;

  const remainingMinutes = Math.ceil(remainingMs / 60000);
  console.warn(
    `[CIRCUIT] Trading paused for ${remainingMinutes}m after ${circuitBreakerState.consecutiveErrors} consecutive errors. Last error: ${circuitBreakerState.lastError}`,
  );
  return false;
}

function recordCircuitBreakerSuccess() {
  if (!CIRCUIT_BREAKER_ENABLED) return;
  if (circuitBreakerState.consecutiveErrors > 0) {
    console.log("[CIRCUIT] Error streak cleared");
  }
  circuitBreakerState.consecutiveErrors = 0;
  circuitBreakerState.lastError = null;
}

function recordCircuitBreakerError(source, err) {
  if (!CIRCUIT_BREAKER_ENABLED) return;
  circuitBreakerState.consecutiveErrors += 1;
  circuitBreakerState.lastError = `${source}: ${err?.message || err}`;

  console.warn(
    `[CIRCUIT] Error ${circuitBreakerState.consecutiveErrors}/${CIRCUIT_BREAKER_MAX_ERRORS} from ${source}: ${err?.message || err}`,
  );

  if (circuitBreakerState.consecutiveErrors >= CIRCUIT_BREAKER_MAX_ERRORS) {
    circuitBreakerState.pausedUntil =
      Date.now() + CIRCUIT_BREAKER_PAUSE_MINUTES * 60 * 1000;
    console.warn(
      `[CIRCUIT] Trading paused for ${CIRCUIT_BREAKER_PAUSE_MINUTES}m`,
    );
  }
}

async function syncProfitLedger() {
  if (!PROFIT_TRACKER_ENABLED) return;
  try {
    const since = profitLedger.lastTradeTimestamp
      ? profitLedger.lastTradeTimestamp - 1
      : undefined;
    let newTrades = 0;
    for (const symbol of SCAN_SYMBOLS) {
      let sortedTrades = [];
      try {
        const trades = await retry(() =>
          exchange.fetchMyTrades(symbol, since, PROFIT_SYNC_LIMIT),
        );
        sortedTrades = trades
          .filter((trade) => !trade.symbol || trade.symbol === symbol)
          .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      } catch (err) {
        console.warn(`${symbol} profit trade sync skipped: ${err.message}`);
        continue;
      }
      for (const trade of sortedTrades) {
        if (applyTradeToProfitLedger(trade)) {
          newTrades++;
        }
      }
    }
    if (newTrades > 0) saveProfitLedger();
    logProfitSummary(newTrades);
  } catch (err) {
    console.warn("[WARN] Profit sync skipped:", err.message);
  }
}

// ======================================================
// MARKET
// ======================================================
async function getMarketContext(symbol) {
  const [ticker, funding] = await Promise.all([
    retry(() => exchange.fetchTicker(symbol)),
    retry(() => exchange.fetchFundingRate(symbol)),
  ]);
  return {
    price: Number(ticker.last),
    fundingRate: Number(funding.fundingRate || 0),
  };
}

// ======================================================
// INDICATORS
// ======================================================
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(closes, period = 14) {
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateATR(ohlcv) {
  let trs = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const prevClose = ohlcv[i - 1][4];
    const high = ohlcv[i][2];
    const low = ohlcv[i][3];
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ======================================================
// SNAPSHOT
// ======================================================
async function getMarketSnapshot(symbol, context, timeframe = TIMEFRAME) {
  const ohlcv = await retry(() =>
    exchange.fetchOHLCV(symbol, timeframe, undefined, LOOKBACK_CANDLES),
  );
  const closes = ohlcv.map((c) => c[4]);
  const ema20 = calculateEMA(closes.slice(-20), 20);
  const ema50 = calculateEMA(closes.slice(-50), 50);
  const prevEma20 = calculateEMA(closes.slice(-21, -1), 20);
  const prevEma50 = calculateEMA(closes.slice(-51, -1), 50);
  const ema20Slope = ema20 - prevEma20;
  const ema50Slope = ema50 - prevEma50;
  const rsi = calculateRSI(closes.slice(-15));
  const atr = calculateATR(ohlcv.slice(-15));
  const latestVolume = ohlcv[ohlcv.length - 1][5];
  const prevVolume = ohlcv[ohlcv.length - 2][5];
  const volumeChange = ((latestVolume - prevVolume) / prevVolume) * 100;
  const trend =
    ema20 > ema50 ? "UPTREND" : ema20 < ema50 ? "DOWNTREND" : "SIDEWAYS";
  const emaGap = (Math.abs(ema20 - ema50) / context.price) * 100;
  return {
    price: context.price,
    fundingRate: context.fundingRate,
    ema20,
    ema50,
    ema20Slope,
    ema50Slope,
    emaGap,
    rsi,
    atr,
    volumeChange,
    trend,
  };
}

// ======================================================
// MARKET REGIME
// ======================================================
function detectMarketRegime(snapshot, htfSnapshot) {
  const atrPct = snapshot.price > 0 ? snapshot.atr / snapshot.price : 0;
  const bullishAlignment =
    snapshot.trend === "UPTREND" &&
    htfSnapshot.trend === "UPTREND" &&
    snapshot.ema20Slope > 0 &&
    htfSnapshot.ema20Slope > 0 &&
    snapshot.volumeChange >= MIN_VOLUME_CHANGE_FOR_TREND;
  const bearishAlignment =
    snapshot.trend === "DOWNTREND" &&
    htfSnapshot.trend === "DOWNTREND" &&
    snapshot.ema20Slope < 0 &&
    htfSnapshot.ema20Slope < 0 &&
    snapshot.volumeChange >= MIN_VOLUME_CHANGE_FOR_TREND;
  const sideways =
    snapshot.emaGap < SIDEWAYS_EMA_GAP ||
    (Math.abs(snapshot.ema20Slope) < snapshot.atr * 0.02 &&
      Math.abs(snapshot.ema50Slope) < snapshot.atr * 0.02 &&
      Math.abs(htfSnapshot.ema20Slope) < htfSnapshot.atr * 0.02) ||
    (snapshot.rsi >= 45 && snapshot.rsi <= 55 && atrPct < MIN_ATR_PCT);
  const volatile = atrPct >= MAX_ATR_PCT;

  if (sideways) {
    return {
      regime: "CHOPPY",
      allow: false,
      reason: "Market is ranging or too weak for trend execution.",
      atrPct,
    };
  }

  if (volatile && !bullishAlignment && !bearishAlignment) {
    return {
      regime: "HIGH_VOLATILITY",
      allow: false,
      reason: "ATR is elevated without clean directional alignment.",
      atrPct,
    };
  }

  if (bullishAlignment) {
    return {
      regime: "TRENDING_UP",
      allow: true,
      reason: "Higher timeframe and momentum are aligned bullishly.",
      atrPct,
    };
  }

  if (bearishAlignment) {
    return {
      regime: "TRENDING_DOWN",
      allow: true,
      reason: "Higher timeframe and momentum are aligned bearishly.",
      atrPct,
    };
  }

  return {
    regime: volatile ? "VOLATILE_MIXED" : "MIXED",
    allow: false,
    reason: "Trend structure is not clean enough for execution.",
    atrPct,
  };
}

function regimeFilterSafe(regimeInfo) {
  if (!REGIME_FILTER_ENABLED) return true;
  if (!regimeInfo.allow) {
    console.warn(`[WARN] Regime blocked: ${regimeInfo.regime}`);
    return false;
  }
  if (
    ALLOWED_MARKET_REGIMES.length > 0 &&
    !ALLOWED_MARKET_REGIMES.includes(regimeInfo.regime)
  ) {
    console.warn(`[WARN] Regime not allowed: ${regimeInfo.regime}`);
    return false;
  }
  return true;
}

// ======================================================
// AI SIGNAL
// ======================================================
function createHoldAISignal(reason) {
  return {
    signal: "HOLD",
    strength: "WEAK",
    confidence: 0,
    tradeAllowed: false,
    reason,
  };
}

function extractJsonObject(text) {
  const cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI response does not contain a JSON object");
  }
  return cleaned.slice(start, end + 1);
}

function normalizeAIStrength(value) {
  const strength = String(value || "WEAK").trim().toUpperCase();
  const aliases = {
    LOW: "WEAK",
    MILD: "WEAK",
    MODERATE: "MEDIUM",
    HIGH: "STRONG",
    VERY_HIGH: "EXTREME",
    VERYHIGH: "EXTREME",
  };
  return aliases[strength] || strength;
}

function normalizeAISignal(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("AI response is not an object");
  }

  const signal = String(raw.signal || "").trim().toUpperCase();
  const strength = normalizeAIStrength(raw.strength);
  const confidence = Number(raw.confidence);
  const tradeAllowed =
    typeof raw.tradeAllowed === "boolean"
      ? raw.tradeAllowed
      : signal !== "HOLD";
  const reason = String(raw.reason || "No reason provided.").trim();

  if (!["LONG", "SHORT", "HOLD"].includes(signal)) {
    throw new Error(`Invalid AI signal: ${raw.signal}`);
  }
  if (!["WEAK", "MEDIUM", "STRONG", "EXTREME"].includes(strength)) {
    throw new Error(`Invalid AI strength: ${raw.strength}`);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new Error(`Invalid AI confidence: ${raw.confidence}`);
  }

  return {
    signal,
    strength,
    confidence,
    tradeAllowed,
    reason: reason.slice(0, 500),
  };
}

function parseAISignal(text) {
  return normalizeAISignal(JSON.parse(extractJsonObject(text)));
}

async function getAISignal(symbol, snapshot, htfSnapshot, regimeInfo) {
  const allowedSignals = LONG_ONLY ? "LONG, HOLD" : "LONG, SHORT, HOLD";
  const prompt = `
You are a professional crypto futures trader AI.

Your job is to determine:

- LONG
- SHORT
- HOLD

RULES:

- Prioritize HOLD during sideways markets.
- Do NOT reverse positions too easily.
- Avoid fake breakouts.
- Avoid overtrading.
- Use higher timeframe as main trend filter.
- Only give ${LONG_ONLY ? "LONG" : "LONG or SHORT"} if probability is high.
- Ignore weak momentum setups.
- Allowed output signals: ${allowedSignals}
- Allowed output strengths: WEAK, MEDIUM, STRONG, EXTREME
- Use WEAK instead of LOW.
- Market regime: ${regimeInfo.regime}
- Regime guidance: ${regimeInfo.reason}

MARKET DATA:

SYMBOL:
${symbol}

PRICE:
${snapshot.price}

LOW TF TREND:
${snapshot.trend}

HIGH TF TREND:
${htfSnapshot.trend}

EMA20:
${snapshot.ema20}

EMA50:
${snapshot.ema50}

EMA20 SLOPE:
${snapshot.ema20Slope}

EMA50 SLOPE:
${snapshot.ema50Slope}

EMA GAP:
${snapshot.emaGap}

RSI:
${snapshot.rsi}

ATR:
${snapshot.atr}

VOLUME CHANGE:
${snapshot.volumeChange}

FUNDING RATE:
${snapshot.fundingRate}

RETURN JSON ONLY:

{
  "signal":"LONG",
  "strength":"MEDIUM",
  "confidence":75,
  "tradeAllowed":true,
  "reason":"Strong bullish trend confirmation."
}
`;
  let lastError = null;
  for (let attempt = 1; attempt <= AI_RESPONSE_RETRIES + 1; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      return parseAISignal(text);
    } catch (err) {
      lastError = err;
      console.warn(
        `[WARN] AI response invalid for ${symbol} (${attempt}/${AI_RESPONSE_RETRIES + 1}): ${err.message}`,
      );
      if (attempt <= AI_RESPONSE_RETRIES) {
        await sleep(1000 * attempt);
      }
    }
  }

  recordCircuitBreakerError(
    `AI response for ${symbol}`,
    lastError || new Error("unknown AI response error"),
  );

  return createHoldAISignal(
    `AI response fallback to HOLD: ${lastError?.message || "unknown error"}`,
  );
}

// ======================================================
// POSITION
// ======================================================
async function getCurrentPosition(symbol) {
  const positions = await retry(() => exchange.fetchPositions([symbol]));
  const pos = positions.find(
    (p) => p.symbol === symbol && Number(p.contracts) > 0,
  );
  if (!pos) return null;
  return {
    side: pos.side,
    symbol: pos.symbol,
    contracts: Number(pos.contracts),
    entryPrice: Number(pos.entryPrice),
  };
}

async function getOpenPositions() {
  const openPositions = [];
  for (const symbol of SCAN_SYMBOLS) {
    try {
      const position = await getCurrentPosition(symbol);
      if (position) openPositions.push(position);
    } catch (err) {
      console.warn(`${symbol} position check skipped: ${err.message}`);
    }
  }
  return openPositions;
}

// ======================================================
// BALANCE
// ======================================================
async function getAvailableBalance() {
  const balance = await retry(() => exchange.fetchBalance());
  return Number(balance?.USDT?.free || 0);
}

// ======================================================
// CONTRACTS
// ======================================================
async function calculateContracts(symbol, price, stopDistance) {
  const market = exchange.markets[symbol];
  const targetNotional = ORDER_SIZE_USDT * LEVERAGE;
  const maxNotional = Math.min(targetNotional, MAX_POSITION_NOTIONAL_USDT);
  const minCost = market?.limits?.cost?.min || 5;
  const minAmount = market?.limits?.amount?.min || 0;
  const finalNotional = Math.max(minCost, maxNotional);
  const finalContracts = Math.max(finalNotional / price, minAmount);
  return Number(exchange.amountToPrecision(symbol, finalContracts));
}

function calculateRequiredMargin(amount, price) {
  return (amount * price) / LEVERAGE;
}

// ======================================================
// RR
// ======================================================
function calculateRR(signal, entry, tp, sl) {
  if (signal === "LONG") {
    return (tp - entry) / (entry - sl);
  }
  return (entry - tp) / (sl - entry);
}

// ======================================================
// TP SL
// ======================================================
function calculateDynamicTPSL(signal, entry, atr, strength = "WEAK") {
  let tpMultiplier = ATR_TP_MULTIPLIER;

  if (strength === "STRONG") tpMultiplier = 2.5;
  if (strength === "EXTREME") tpMultiplier = 3;

  let slMultiplier = 1.5;

  if (strength === "MEDIUM") slMultiplier = 1.8;
  if (strength === "STRONG") slMultiplier = 2.2;
  if (strength === "EXTREME") slMultiplier = 2.5;

  let tp;
  let sl;

  if (signal === "LONG") {
    tp = entry + atr * tpMultiplier;
    sl = entry - atr * slMultiplier;
  } else {
    tp = entry - atr * tpMultiplier;
    sl = entry + atr * slMultiplier;
  }

  return {
    tp,
    sl,
  };
}

// ======================================================
// CALLBACK
// ======================================================
function calculateCallbackRate(atr, price) {
  let callback = (atr / price) * 100;
  if (callback < TRAILING_CALLBACK_MIN) {
    callback = TRAILING_CALLBACK_MIN;
  }
  if (callback > TRAILING_CALLBACK_MAX) {
    callback = TRAILING_CALLBACK_MAX;
  }
  return Number(callback.toFixed(1));
}

// ======================================================
// FUNDING FILTER
// ======================================================
function fundingSafe(signal, fundingRate) {
  if (signal === "LONG" && fundingRate > MAX_FUNDING_RATE) {
    return false;
  }
  if (signal === "SHORT" && fundingRate < -MAX_FUNDING_RATE) {
    return false;
  }
  return true;
}

// ======================================================
// AI FILTER
// ======================================================
function aiFilterSafe(ai) {
  if (!AI_FILTER_ENABLED) return true;
  const strength = String(ai.strength || "").toUpperCase();
  const confidence = Number(ai.confidence || 0);
  const tradeAllowed = ai.tradeAllowed !== false;
  if (!tradeAllowed) {
    console.warn("[WARN] AI filter blocked: tradeAllowed=false");
    return false;
  }
  if (!ALLOWED_AI_STRENGTHS.includes(strength)) {
    console.warn(`[WARN] AI filter blocked: strength ${strength || "UNKNOWN"}`);
    return false;
  }
  if (confidence < MIN_AI_CONFIDENCE) {
    console.warn(
      `[WARN] AI filter blocked: confidence ${confidence}/${MIN_AI_CONFIDENCE}`,
    );
    return false;
  }
  return true;
}

// ======================================================
// CANCEL
// ======================================================
async function cancelAllOrders(symbol) {
  try {
    const orders = await retry(() => exchange.fetchOpenOrders(symbol));
    for (const o of orders) {
      try {
        await retry(() => exchange.cancelOrder(o.id, symbol));
        console.log(`[CANCEL] Order ${o.id}`);
      } catch (err) {
        console.error(err.message);
      }
    }
  } catch (err) {
    console.error(err.message);
  }
}

function normalizeOrderType(order) {
  return String(order.type || order.info?.type || "").toUpperCase();
}

function normalizeOrderSide(order) {
  return String(order.side || order.info?.side || "").toLowerCase();
}

function isReduceOnlyOrder(order) {
  return (
    order.reduceOnly === true ||
    order.info?.reduceOnly === true ||
    String(order.info?.reduceOnly || "").toLowerCase() === "true" ||
    order.info?.closePosition === true ||
    String(order.info?.closePosition || "").toLowerCase() === "true"
  );
}

function isProtectionOrderForPosition(order, position) {
  const closeSide = position.side === "long" ? "sell" : "buy";
  const type = normalizeOrderType(order);
  return (
    normalizeOrderSide(order) === closeSide &&
    isReduceOnlyOrder(order) &&
    ["STOP_MARKET", "TAKE_PROFIT_MARKET", "TRAILING_STOP_MARKET"].includes(type)
  );
}

function summarizeProtectionOrders(orders, position) {
  const protectionOrders = orders.filter((order) =>
    isProtectionOrderForPosition(order, position),
  );
  const typeCounts = protectionOrders.reduce(
    (counts, order) => {
      const type = normalizeOrderType(order);
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    },
    {},
  );

  return {
    protectionOrders,
    hasStopLoss: (typeCounts.STOP_MARKET || 0) >= 1,
    takeProfitCount: typeCounts.TAKE_PROFIT_MARKET || 0,
    hasTrailingStop: (typeCounts.TRAILING_STOP_MARKET || 0) >= 1,
  };
}

async function recoverPositionProtection(symbol, position) {
  if (!ORDER_RECOVERY_ENABLED || !position) return;

  const orders = await retry(() => exchange.fetchOpenOrders(symbol));
  const summary = summarizeProtectionOrders(orders, position);
  const complete =
    summary.hasStopLoss &&
    summary.takeProfitCount >= 2 &&
    summary.hasTrailingStop;

  if (complete) {
    console.log(
      `[RECOVERY] ${symbol} protection OK: SL=1 TP=${summary.takeProfitCount} trailing=1`,
    );
    return;
  }

  console.warn(`
[RECOVERY] ${symbol} protection incomplete
Stop loss:
${summary.hasStopLoss ? "OK" : "MISSING"}
Take profits:
${summary.takeProfitCount}/2
Trailing:
${summary.hasTrailingStop ? "OK" : "MISSING"}

Rebuilding protection orders...
`);

  await cancelAllOrders(symbol);
  const context = await getMarketContext(symbol);
  const snapshot = await getMarketSnapshot(symbol, context, TIMEFRAME);
  const slPrice =
    position.side === "long"
      ? position.entryPrice - snapshot.atr
      : position.entryPrice + snapshot.atr;

  await createStopLossOrder(symbol, position, slPrice);
  await createPartialTPs(symbol, position, position.entryPrice, snapshot.atr);
  console.log(`[RECOVERY] ${symbol} protection rebuilt`);
}

async function recoverOpenPositionsProtection(openPositions) {
  if (!ORDER_RECOVERY_ENABLED) return;
  for (const position of openPositions) {
    try {
      await recoverPositionProtection(position.symbol, position);
    } catch (err) {
      console.warn(
        `[RECOVERY] ${position.symbol} skipped: ${err.message}`,
      );
      recordCircuitBreakerError(`recovery ${position.symbol}`, err);
    }
  }
}

// ======================================================
// OPEN POSITION
// ======================================================
async function openPosition(symbol, signal, context, stopDistance) {
  await retry(() => exchange.setLeverage(LEVERAGE, symbol));
  const side = signal === "LONG" ? "buy" : "sell";
  const amount = await calculateContracts(symbol, context.price, stopDistance);
  const notional = amount * context.price;
  const requiredMargin = calculateRequiredMargin(amount, context.price);
  const balance = await getAvailableBalance();
  if (balance < requiredMargin) {
    console.warn(
      `[BLOCK] Balance insufficient: free ${balance.toFixed(4)} USDT, required margin ${requiredMargin.toFixed(4)} USDT`,
    );
    return null;
  }
  console.log(`
[OPEN] ${signal}

Contracts:
${amount}
Notional:
${notional.toFixed(4)} USDT
Required margin:
${requiredMargin.toFixed(4)} USDT
`);
  const order = await retry(() =>
    exchange.createMarketOrder(symbol, side, amount),
  );
  console.log(`
[OK] Order:
${order.id}
`);
  lastPositionChangeTime = Date.now();
  await sleep(3000);
  return await getCurrentPosition(symbol);
}

// ======================================================
// CLOSE POSITION
// ======================================================
async function closePosition(symbol, position) {
  const side = position.side === "long" ? "sell" : "buy";
  await retry(() =>
    exchange.createMarketOrder(symbol, side, position.contracts, {
      reduceOnly: true,
    }),
  );
  await cancelAllOrders(symbol);
  console.log("[CLOSE] Position closed");
}

// ======================================================
// STOP LOSS MARKET (NEW)
// ======================================================
async function createStopLossOrder(symbol, position, slPrice) {
  const side = position.side === "long" ? "sell" : "buy";
  const stopPrice = exchange.priceToPrecision(symbol, slPrice);
  console.log(`
[SL] Create stop loss market
Side: ${side}
Mode: close remaining position
Stop trigger: ${stopPrice}
`);
  await retry(() =>
    exchange.createOrder(symbol, "STOP_MARKET", side, undefined, undefined, {
      stopPrice: stopPrice,
      closePosition: true,
      workingType: "MARK_PRICE",
    }),
  );
  console.log("[OK] Stop loss order active");
}

// ======================================================
// PARTIAL TP
// ======================================================
async function createPartialTPs(symbol, position, entryPrice, atr) {
  const side = position.side === "long" ? "sell" : "buy";
  const isLong = position.side === "long";
  const totalContracts = position.contracts;
  const tp1Qty = Number(
    exchange.amountToPrecision(symbol, totalContracts * (TP1_PERCENT / 100)),
  );
  const tp2Qty = Number(
    exchange.amountToPrecision(symbol, totalContracts * (TP2_PERCENT / 100)),
  );
  const runnerQty = Number(
    exchange.amountToPrecision(symbol, totalContracts - tp1Qty - tp2Qty),
  );
  let tp1Price;
  let tp2Price;
  if (isLong) {
    tp1Price = entryPrice + atr * TP1_RR;
    tp2Price = entryPrice + atr * TP2_RR;
  } else {
    tp1Price = entryPrice - atr * TP1_RR;
    tp2Price = entryPrice - atr * TP2_RR;
  }
  tp1Price = Number(exchange.priceToPrecision(symbol, tp1Price));
  tp2Price = Number(exchange.priceToPrecision(symbol, tp2Price));
  console.log(`
[TP] TP1:
${tp1Price}

[TP] TP2:
${tp2Price}
`);
  if (tp1Qty > 0) {
    await retry(() =>
      exchange.createOrder(
        symbol,
        "TAKE_PROFIT_MARKET",
        side,
        tp1Qty,
        undefined,
        {
          stopPrice: tp1Price,
          reduceOnly: true,
          workingType: "MARK_PRICE",
        },
      ),
    );
    console.log(
      `[OK] TP1 created:
${tp1Qty}`,
    );
  }
  if (tp2Qty > 0) {
    await retry(() =>
      exchange.createOrder(
        symbol,
        "TAKE_PROFIT_MARKET",
        side,
        tp2Qty,
        undefined,
        {
          stopPrice: tp2Price,
          reduceOnly: true,
          workingType: "MARK_PRICE",
        },
      ),
    );
    console.log(
      `[OK] TP2 created:
${tp2Qty}`,
    );
  }
  if (runnerQty > 0) {
    const callbackRate = calculateCallbackRate(atr, entryPrice);
    await retry(() =>
      exchange.createOrder(
        symbol,
        "TRAILING_STOP_MARKET",
        side,
        runnerQty,
        undefined,
        {
          callbackRate,
          reduceOnly: true,
          workingType: "MARK_PRICE",
        },
      ),
    );
    console.log(`
[TRAILING] Runner trailing active

Qty:
${runnerQty}

Callback:
${callbackRate}%
`);
  }
}

// ======================================================
// TRADING
// ======================================================
function updateSignalConfirmation(symbol, signal, strength) {
  const state = signalStateBySymbol[symbol] || {
    lastSignal: null,
    confirmCount: 0,
  };
  if (state.lastSignal === signal) {
    state.confirmCount += 1;
  } else {
    state.lastSignal = signal;
    state.confirmCount = 1;
  }
  signalStateBySymbol[symbol] = state;

  const confirmed =
    state.confirmCount >= EFFECTIVE_REQUIRED_CONFIRMATION ||
    strength === "STRONG" ||
    strength === "EXTREME";
  return {
    count: state.confirmCount,
    confirmed,
  };
}

function scoreCandidate(ai, rr, regimeInfo) {
  const strength = String(ai.strength || "").toUpperCase();
  const strengthBonus = {
    MEDIUM: 5,
    STRONG: 15,
    EXTREME: 25,
  }[strength] || 0;
  const confidence = Number(ai.confidence || 0);
  const rrBonus = Math.min(rr, 3) * 10;
  const trendBonus = regimeInfo.allow ? 10 : 0;
  return confidence + strengthBonus + rrBonus + trendBonus;
}

async function analyzeSymbol(symbol) {
  try {
    console.log(`
========== SCAN ${symbol} ==========
`);
    if (!symbolCooldownAllowsTrading(symbol)) {
      return null;
    }

    const context = await getMarketContext(symbol);
    const snapshot = await getMarketSnapshot(symbol, context, TIMEFRAME);
    const htfSnapshot = await getMarketSnapshot(symbol, context, HTF_TIMEFRAME);
    const regimeInfo = detectMarketRegime(snapshot, htfSnapshot);
    const logScanDecision = (event) =>
      logAIExplainDecision({
        symbol,
        snapshot,
        htfSnapshot,
        regimeInfo,
        ...event,
      });

    if (snapshot.emaGap < SIDEWAYS_EMA_GAP) {
      console.log(`${symbol} skipped: sideways market`);
      logScanDecision({
        outcome: "REJECTED_BEFORE_AI",
        stage: "sideways_filter",
        rejectReason: "EMA gap below sideways threshold.",
      });
      return null;
    }

    if (!regimeFilterSafe(regimeInfo)) {
      console.log(`${symbol} skipped: ${regimeInfo.reason}`);
      logScanDecision({
        outcome: "REJECTED_BEFORE_AI",
        stage: "regime_filter",
        rejectReason: regimeInfo.reason,
      });
      return null;
    }

    console.log(`Asking Gemini for ${symbol}...`);
    const ai = await getAISignal(symbol, snapshot, htfSnapshot, regimeInfo);
    console.log(ai);

    const signal = ai.signal?.toUpperCase();
    const aiStrength = String(ai.strength || "").toUpperCase();
    if (!["LONG", "SHORT", "HOLD"].includes(signal)) {
      console.warn(`${symbol} skipped: invalid AI signal`);
      logScanDecision({
        outcome: "REJECTED_AFTER_AI",
        stage: "ai_signal_validation",
        ai,
        rejectReason: "Invalid AI signal.",
      });
      return null;
    }
    if (signal === "HOLD") {
      console.log(`${symbol} skipped: HOLD`);
      logScanDecision({
        outcome: "REJECTED_AFTER_AI",
        stage: "ai_hold",
        ai,
        rejectReason: ai.reason || "AI returned HOLD.",
      });
      return null;
    }
    if (LONG_ONLY && signal === "SHORT") {
      console.log(`${symbol} skipped: SHORT ignored in LONG ONLY mode`);
      logScanDecision({
        outcome: "REJECTED_AFTER_AI",
        stage: "long_only_filter",
        ai,
        rejectReason: "AI returned SHORT while LONG_ONLY mode is active.",
      });
      return null;
    }
    if (!aiFilterSafe(ai)) {
      console.log(`${symbol} skipped: AI filter`);
      logScanDecision({
        outcome: "REJECTED_AFTER_AI",
        stage: "ai_filter",
        ai,
        rejectReason: "AI did not pass confidence, strength, or tradeAllowed filter.",
      });
      return null;
    }

    const confirmation = updateSignalConfirmation(symbol, signal, aiStrength);
    console.log(`
SIGNAL CONFIRM ${symbol}:
${confirmation.count}/${EFFECTIVE_REQUIRED_CONFIRMATION}
`);
    if (!confirmation.confirmed) {
      console.log(`${symbol} skipped: signal not confirmed`);
      logScanDecision({
        outcome: "REJECTED_AFTER_AI",
        stage: "signal_confirmation",
        ai,
        confirmation,
        rejectReason: "Signal did not reach required confirmation count.",
      });
      return null;
    }

    if (!fundingSafe(signal, context.fundingRate)) {
      console.warn(`${symbol} skipped: funding unsafe`);
      logScanDecision({
        outcome: "REJECTED_AFTER_AI",
        stage: "funding_filter",
        ai,
        confirmation,
        rejectReason: "Funding rate is unsafe for the AI signal direction.",
      });
      return null;
    }

    const dynamicTPSL = calculateDynamicTPSL(
      signal,
      context.price,
      snapshot.atr,
      aiStrength,
    );
    const rr = calculateRR(
      signal,
      context.price,
      dynamicTPSL.tp,
      dynamicTPSL.sl,
    );
    console.log(`${symbol} RR: ${rr.toFixed(2)}`);
    if (rr < MIN_RR) {
      console.warn(`${symbol} skipped: RR too low`);
      logScanDecision({
        outcome: "REJECTED_AFTER_AI",
        stage: "rr_filter",
        ai,
        confirmation,
        rr: roundNumber(rr, 4),
        tp: roundNumber(dynamicTPSL.tp, 10),
        sl: roundNumber(dynamicTPSL.sl, 10),
        rejectReason: "Risk/reward is below MIN_RR.",
      });
      return null;
    }

    const score = scoreCandidate(ai, rr, regimeInfo);
    logScanDecision({
      outcome: "CANDIDATE_ACCEPTED",
      stage: "candidate_score",
      ai,
      confirmation,
      rr: roundNumber(rr, 4),
      tp: roundNumber(dynamicTPSL.tp, 10),
      sl: roundNumber(dynamicTPSL.sl, 10),
      score: roundNumber(score, 2),
      acceptReason: "AI signal passed filters and became a trade candidate.",
    });

    return {
      symbol,
      signal,
      ai,
      aiStrength,
      context,
      snapshot,
      htfSnapshot,
      regimeInfo,
      rr,
      score,
    };
  } catch (err) {
    console.warn(`${symbol} scan skipped: ${err.message}`);
    recordCircuitBreakerError(`scan ${symbol}`, err);
    setSymbolCooldown(symbol, SYMBOL_ERROR_COOLDOWN_MINUTES, "scan error");
    saveRiskState();
    return null;
  }
}

async function tradingCycle() {
  if (isTrading) {
    console.log("[WAIT] Previous cycle running");
    return;
  }
  isTrading = true;
  const circuitErrorsAtStart = circuitBreakerState.consecutiveErrors;
  let circuitAllowedThisCycle = false;
  try {
    console.log(`
========== ${new Date().toISOString()} ==========
`);
    if (!circuitBreakerAllowsTrading()) {
      return;
    }
    circuitAllowedThisCycle = true;
    await syncProfitLedger();
    await syncRiskState();
    const openPositions = await getOpenPositions();
    console.log("OPEN POSITIONS:", openPositions.length ? openPositions : "NONE");
    await recoverOpenPositionsProtection(openPositions);
    if (killSwitchActive()) {
      console.log("[KILL] Cycle stopped before scanning new entries");
      return;
    }
    if (!riskGateAllowsTrading()) {
      return;
    }
    const candidates = [];
    const symbolsToScan = getRotatedScanSymbols();
    console.log(
      `[SCAN] Rotating batch ${symbolsToScan.join(", ")} (${symbolsToScan.length}/${SCAN_SYMBOLS.length})`,
    );
    saveRiskState();
    for (const symbol of symbolsToScan) {
      const candidate = await analyzeSymbol(symbol);
      if (candidate) candidates.push(candidate);
    }

    if (candidates.length === 0) {
      console.log("No meme coin setup passed the scanner.");
      return;
    }

    candidates.sort((a, b) => b.score - a.score);
    console.table(
      candidates.map((c) => ({
        symbol: c.symbol,
        signal: c.signal,
        confidence: c.ai.confidence,
        strength: c.aiStrength,
        rr: Number(c.rr.toFixed(2)),
        regime: c.regimeInfo.regime,
        score: Number(c.score.toFixed(2)),
      })),
    );

    const best = candidates[0];
    const { symbol, signal, context, snapshot } = best;
    const logBestDecision = (event) =>
      logAIExplainDecision({
        symbol,
        ai: best.ai,
        snapshot: best.snapshot,
        htfSnapshot: best.htfSnapshot,
        regimeInfo: best.regimeInfo,
        rr: roundNumber(best.rr, 4),
        score: roundNumber(best.score, 2),
        ...event,
      });
    logBestDecision({
      outcome: "BEST_CANDIDATE_SELECTED",
      stage: "candidate_ranking",
      acceptReason: "Highest-scoring candidate after scanning all symbols.",
    });
    const position = openPositions.find((p) => p.symbol === symbol);

    if (position && position.side === signal.toLowerCase()) {
      console.log(`${symbol} position already exists`);
      logBestDecision({
        outcome: "NOT_EXECUTED",
        stage: "existing_position",
        rejectReason: "Position already exists in the same direction.",
      });
      return;
    }

    if (!position && openPositions.length >= MAX_OPEN_POSITIONS) {
      console.log(
        `Max open positions reached: ${openPositions.length}/${MAX_OPEN_POSITIONS}`,
      );
      logBestDecision({
        outcome: "NOT_EXECUTED",
        stage: "max_open_positions",
        rejectReason: "MAX_OPEN_POSITIONS limit reached.",
      });
      return;
    }

    const cooldownMs = REVERSAL_COOLDOWN_MINUTES * 60 * 1000;
    if (position && Date.now() - lastPositionChangeTime < cooldownMs) {
      console.log(`${symbol} reversal cooldown active`);
      logBestDecision({
        outcome: "NOT_EXECUTED",
        stage: "reversal_cooldown",
        rejectReason: "Reversal cooldown is still active.",
      });
      return;
    }

    if (position) {
      await closePosition(symbol, position);
    }
    await cancelAllOrders(symbol);

    const newPos = await openPosition(symbol, signal, context, snapshot.atr);
    if (!newPos) {
      logBestDecision({
        outcome: "NOT_EXECUTED",
        stage: "open_position",
        rejectReason: "Exchange did not return an opened position.",
      });
      return;
    }

    const actualEntry = newPos.entryPrice;
    const slPrice =
      signal === "LONG"
        ? actualEntry - snapshot.atr
        : actualEntry + snapshot.atr;
    await createStopLossOrder(symbol, newPos, slPrice);
    await createPartialTPs(symbol, newPos, actualEntry, snapshot.atr);
    logBestDecision({
      outcome: "EXECUTED",
      stage: "order_opened",
      position: {
        side: newPos.side,
        contracts: roundNumber(newPos.contracts, 8),
        entryPrice: roundNumber(actualEntry, 10),
      },
      sl: roundNumber(slPrice, 10),
      acceptReason: "Market order opened and protection orders were created.",
    });
  } catch (err) {
    console.error("[ERROR] Trading error:", err.message);
    recordCircuitBreakerError("trading cycle", err);
  } finally {
    if (
      circuitAllowedThisCycle &&
      circuitBreakerState.consecutiveErrors === circuitErrorsAtStart
    ) {
      recordCircuitBreakerSuccess();
    }
    isTrading = false;
  }
}

// ======================================================
// MAIN
// ======================================================
async function main() {
  console.log(`
[START] Smart AI Futures Bot

SCAN SYMBOLS:
${SCAN_SYMBOLS.join(", ")}
MAX OPEN POSITIONS:
${MAX_OPEN_POSITIONS}
LEVERAGE:
${LEVERAGE}x
ORDER:
${ORDER_SIZE_USDT} USDT
TIMEFRAME:
${TIMEFRAME}
HTF:
${HTF_TIMEFRAME}
SCAN ROTATION BATCH:
${SCAN_ROTATION_BATCH_SIZE}
MODEL:
${GEMINI_MODEL}
KILL SWITCH:
${KILL_SWITCH_ENABLED ? `enabled (${KILL_SWITCH_FILE})` : "disabled"}
ORDER RECOVERY:
${ORDER_RECOVERY_ENABLED ? "enabled" : "disabled"}
`);
  await retry(() => exchange.loadMarkets());
  await syncProfitLedger();
  while (true) {
    try {
      const delay = getNextCandleDelay();
      console.log(`
[WAIT] Waiting next candle:
${Math.floor(delay / 1000)}s
`);
      await sleep(delay);
      await tradingCycle();
    } catch (err) {
      console.error(err);
      await sleep(5000);
    }
  }
}
main().catch(console.error);
