require("dotenv").config();
const ccxt = require("ccxt");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ------------------------------
//  Configuration
// ------------------------------

const DEFAULT_SYMBOLS = "BTC/USDT:USDT,ETH/USDT:USDT,DOGE/USDT:USDT";
const SYMBOLS = envList("SYMBOLS", DEFAULT_SYMBOLS);
const MAX_OPEN_POSITIONS = envNumber("MAX_OPEN_POSITIONS", 2);
const LEVERAGE = envNumber("LEVERAGE", 10);
const ORDER_SIZE_USDT = envNumber("ORDER_SIZE_USDT", 10);
const TIMEFRAME = envValue("TIMEFRAME", "15m");
const LOOKBACK_CANDLES = envNumber("LOOKBACK_CANDLES", 200);
const INTERVAL_MINUTES = envNumber("INTERVAL_MINUTES", 5);
const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;
const AI_SIGNAL_CACHE_ENABLED = envBoolean("AI_SIGNAL_CACHE_ENABLED", true);
const AI_SIGNAL_CACHE_TTL_MS = envNumber(
  "AI_SIGNAL_CACHE_TTL_MS",
  Math.max(INTERVAL_MS * 3, 60 * 1000)
);

const SR_WINDOW_SIZE = envNumber("SR_WINDOW_SIZE", 5);
const SR_LEVEL_TOLERANCE = envNumber("SR_LEVEL_TOLERANCE", 0.005);
const PRICE_PROXIMITY_THRESHOLD = envNumber("PRICE_PROXIMITY_THRESHOLD", 0.005);

const GEMINI_MODEL = envValue("GEMINI_MODEL", "gemini-1.5-flash-lite");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
const MIN_AI_CONFIDENCE = envNumber("MIN_AI_CONFIDENCE", 65);
const ALLOWED_AI_STRENGTHS = envList("ALLOWED_AI_STRENGTHS", "MEDIUM,STRONG,EXTREME").map(s => s.toUpperCase());
const AI_RESPONSE_RETRIES = envNumber("AI_RESPONSE_RETRIES", 2);

const MAX_FUNDING_RATE = envNumber("MAX_FUNDING_RATE", 0.1) / 100;
const MIN_RR = envNumber("MIN_RR", 1.5);
const RISK_PER_TRADE_PCT = envNumber("RISK_PER_TRADE_PCT", 1) / 100;
const MAX_DAILY_LOSS_PCT = envNumber("MAX_DAILY_LOSS_PCT", 3) / 100;
const MAX_DAILY_LOSS_USDT = envNumber("MAX_DAILY_LOSS_USDT", 0);
const MAX_CONSECUTIVE_LOSSES = envNumber("MAX_CONSECUTIVE_LOSSES", 3);
const ATR_TP_MULTIPLIER = envNumber("ATR_TP_MULTIPLIER", 1.8);
const ATR_SL_MULTIPLIER = envNumber("ATR_SL_MULTIPLIER", 1.5);
const UNREALIZED_PROFIT_CLOSE_ENABLED = envBoolean("UNREALIZED_PROFIT_CLOSE_ENABLED", true);
const UNREALIZED_PROFIT_CLOSE_MIN_USDT = envNumber("UNREALIZED_PROFIT_CLOSE_MIN_USDT", 0);
const UNREALIZED_PROFIT_CLOSE_MIN_PCT = envNumber("UNREALIZED_PROFIT_CLOSE_MIN_PCT", 0);
const UNREALIZED_PROFIT_MONITOR_INTERVAL_MS = Math.max(250, envNumber("UNREALIZED_PROFIT_MONITOR_INTERVAL_MS", 1000));
const LONG_ONLY = envBoolean("LONG_ONLY");
const REVERSAL_COOLDOWN_MINUTES = envNumber("REVERSAL_COOLDOWN_MINUTES", 10);
const SYMBOL_COOLDOWN_ENABLED = envBoolean("SYMBOL_COOLDOWN_ENABLED");
const SYMBOL_COOLDOWN_MINUTES = envNumber("SYMBOL_COOLDOWN_MINUTES", 30);
const SYMBOL_ERROR_COOLDOWN_MINUTES = envNumber("SYMBOL_ERROR_COOLDOWN_MINUTES", 5);
const KILL_SWITCH_ENABLED = envBoolean("KILL_SWITCH_ENABLED");
const STOP_TRADING = envTrue("STOP_TRADING");
const KILL_SWITCH_FILE = envValue("KILL_SWITCH_FILE", "bot-paused.flag");
const KILL_SWITCH_PATH = resolveProjectPath(KILL_SWITCH_FILE);

const PROFIT_TRACKER_ENABLED = envBoolean("PROFIT_TRACKER_ENABLED");
const PROFIT_TRACKER_FILE = envValue("PROFIT_TRACKER_FILE", "profit-ledger-sr.json");
const PROFIT_LEDGER_PATH = resolveProjectPath(PROFIT_TRACKER_FILE);
const RISK_STATE_FILE = envValue("RISK_STATE_FILE", "risk-state-sr.json");
const RISK_STATE_PATH = resolveProjectPath(RISK_STATE_FILE);

const FONNTE_ENABLED = envBoolean("FONNTE_ENABLED");
const FONNTE_TOKEN = envValue("FONNTE_TOKEN", "");
const FONNTE_TARGET = envValue("FONNTE_TARGET", "");
const FONNTE_API_URL = envValue("FONNTE_API_URL", "https://api.fonnte.com/send");
const FONNTE_COUNTRY_CODE = envValue("FONNTE_COUNTRY_CODE", "62");

// ---------- LEARNING MEMORY ----------
const LEARNING_MEMORY_ENABLED = envBoolean("LEARNING_MEMORY_ENABLED", true);
const LEARNING_MEMORY_FILE = envValue("LEARNING_MEMORY_FILE", "learning-memory-sr.json");
const LEARNING_MEMORY_PATH = resolveProjectPath(LEARNING_MEMORY_FILE);
const LEARNING_MEMORY_MIN_TRADES = envNumber("LEARNING_MEMORY_MIN_TRADES", 5);
const LEARNING_MEMORY_BAD_WIN_RATE = envNumber("LEARNING_MEMORY_BAD_WIN_RATE", 40); // percent
const LEARNING_MEMORY_CONFIDENCE_PENALTY = envNumber("LEARNING_MEMORY_CONFIDENCE_PENALTY", 0.6);

// ------------------------------
//  Helper Functions
// ------------------------------

function envValue(key, fallback) {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function envNumber(key, fallback) {
  const parsed = Number(envValue(key, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(key, fallback = true) {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  return value !== "false";
}

function envTrue(key) {
  return process.env[key] === "true";
}

function envList(key, fallback) {
  return String(envValue(key, fallback))
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function parseTimeframeToMs(timeframe) {
  const text = String(timeframe || "").trim().toLowerCase();
  const match = text.match(/^(\d+)(m|h|d|w)$/);
  if (!match) return INTERVAL_MS;
  const value = Number(match[1]);
  const unit = match[2];
  const unitMs = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  }[unit];
  return value * unitMs;
}

function resolveProjectPath(fileName) {
  return path.resolve(process.cwd(), fileName);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function roundNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(digits));
}

function isCacheEntryValid(entry) {
  return Boolean(entry && entry.expiresAt > Date.now());
}

function pruneCacheEntries(cache, maxEntries) {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

function cleanupAiSignalCache() {
  if (!AI_SIGNAL_CACHE_ENABLED) {
    aiSignalCache.clear();
    return;
  }
  pruneCacheEntries(aiSignalCache, 500);
}

function getAiSignalCacheKey(symbol, ohlcv) {
  const candleTimestamp = ohlcv?.[ohlcv.length - 1]?.[0] || 0;
  const timeframeMs = parseTimeframeToMs(TIMEFRAME);
  const candleBucket = candleTimestamp ? Math.floor(candleTimestamp / timeframeMs) : 0;
  return [symbol, TIMEFRAME, candleBucket, LONG_ONLY ? "LONG_ONLY" : "BOTH"].join("|");
}

function getCachedAISignal(cacheKey) {
  if (!AI_SIGNAL_CACHE_ENABLED) return null;
  const entry = aiSignalCache.get(cacheKey);
  if (!isCacheEntryValid(entry)) {
    if (entry) aiSignalCache.delete(cacheKey);
    return null;
  }
  return entry.value;
}

function setCachedAISignal(cacheKey, value, ttlMs = AI_SIGNAL_CACHE_TTL_MS) {
  if (!AI_SIGNAL_CACHE_ENABLED) return;
  aiSignalCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  pruneCacheEntries(aiSignalCache, 500);
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

// ------------------------------
//  Exchange Setup
// ------------------------------

const exchange = new ccxt.binance({
  apiKey: process.env.EXCHANGE_API_KEY,
  secret: process.env.EXCHANGE_SECRET,
  enableRateLimit: true,
  options: { defaultType: "future" },
});

if (process.env.EXCHANGE_DEMO === "true") {
  exchange.enable_demo_trading(true);
  console.log("[DEMO] Futures demo mode enabled");
}

// ------------------------------
//  Global State
// ------------------------------

let isTrading = false;
let lastPositionChangeTime = 0;
let profitLedger = loadProfitLedger();
let riskState = loadRiskState();
let aiSignalCache = new Map();
let circuitBreakerState = { consecutiveErrors: 0, pausedUntil: 0, lastError: null };
let fonnteAlertWarningShown = false;

// Learning memory state
let learningMemory = null;
// pendingTradeSetups: key = `${symbol}_${side}` (side uppercase LONG/SHORT)
let pendingTradeSetups = new Map();
// pendingPositionPnL: key = `${symbol}_${side}` -> { netProfitSum, strength, rr, recorded, lastUpdate }
let pendingPositionPnL = new Map();

// ------------------------------
//  Kill Switch
// ------------------------------

function killSwitchActive() {
  if (!KILL_SWITCH_ENABLED) return false;
  if (STOP_TRADING) {
    console.warn("[KILL] STOP_TRADING=true, new entries disabled");
    return true;
  }
  if (fs.existsSync(KILL_SWITCH_PATH)) {
    console.warn(`[KILL] ${KILL_SWITCH_FILE} exists, new entries disabled`);
    return true;
  }
  return false;
}

function getNextCandleDelay() {
  const now = Date.now();
  const next = Math.ceil(now / INTERVAL_MS) * INTERVAL_MS;
  return next - now;
}

// ------------------------------
//  Alerts (Fonnte)
// ------------------------------

function shouldSendFonnteAlerts() {
  return Boolean(FONNTE_ENABLED && FONNTE_TOKEN && FONNTE_TARGET);
}

async function postFormUrlEncoded(urlString, formBody, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const request = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: {
          Authorization: token,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(formBody),
        },
      },
      response => {
        let data = "";
        response.on("data", chunk => (data += chunk));
        response.on("end", () => resolve({ statusCode: response.statusCode || 0, body: data }));
      }
    );
    request.on("error", reject);
    request.write(formBody);
    request.end();
  });
}

async function sendFonnteAlert(message) {
  if (!shouldSendFonnteAlerts()) {
    if (FONNTE_ENABLED && !fonnteAlertWarningShown) {
      fonnteAlertWarningShown = true;
      console.warn("[FONNTE] Alert skipped: set FONNTE_TOKEN and FONNTE_TARGET");
    }
    return false;
  }
  try {
    const formBody = new URLSearchParams({
      target: FONNTE_TARGET,
      message,
      countryCode: String(FONNTE_COUNTRY_CODE),
    }).toString();
    const response = await postFormUrlEncoded(FONNTE_API_URL, formBody, FONNTE_TOKEN);
    let payload = null;
    try {
      payload = JSON.parse(response.body);
    } catch {
      // ignore
    }
    const success =
      response.statusCode >= 200 &&
      response.statusCode < 300 &&
      (payload?.status !== false && payload?.Status !== false);
    if (!success) console.warn(`[FONNTE] Alert failed: ${response.statusCode} ${response.body}`);
    else console.log("[FONNTE] Trade alert sent");
    return success;
  } catch (err) {
    console.warn(`[FONNTE] Alert error: ${err.message}`);
    return false;
  }
}

function formatTradeOpenAlert({ symbol, signal, entryPrice, contracts, slPrice, tpPrice, rr, confidence, strength }) {
  return [
    "[TRADE OPEN]",
    `Symbol: ${symbol}`,
    `Side: ${signal}`,
    `Entry: ${roundNumber(entryPrice, 10)}`,
    `Contracts: ${roundNumber(contracts, 8)}`,
    `SL: ${roundNumber(slPrice, 10)}`,
    `TP: ${roundNumber(tpPrice, 10)}`,
    `RR: ${roundNumber(rr, 2)}`,
    `Confidence: ${confidence ?? "-"}`,
    `Strength: ${strength || "-"}`,
  ].join("\n");
}

// ------------------------------
//  Profit Ledger
// ------------------------------

function createEmptyProfitLedger() {
  const now = new Date().toISOString();
  return {
    symbol: SYMBOLS.join(","),
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
    processedTradeIds: Array.isArray(ledger?.processedTradeIds) ? ledger.processedTradeIds : [],
    totals: { ...empty.totals, ...(ledger?.totals || {}) },
    recentTrades: Array.isArray(ledger?.recentTrades) ? ledger.recentTrades : [],
  };
}

function loadProfitLedger() {
  if (!PROFIT_TRACKER_ENABLED) return createEmptyProfitLedger();
  try {
    if (fs.existsSync(PROFIT_LEDGER_PATH)) {
      const data = JSON.parse(fs.readFileSync(PROFIT_LEDGER_PATH, "utf8"));
      return normalizeProfitLedger(data);
    }
  } catch (err) {
    console.warn("[WARN] Profit ledger reset:", err.message);
  }
  return createEmptyProfitLedger();
}

function saveProfitLedger() {
  if (!PROFIT_TRACKER_ENABLED) return;
  profitLedger.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROFIT_LEDGER_PATH, JSON.stringify(profitLedger, null, 2));
}

function tradeIdOf(trade) {
  return String(trade.id || trade.info?.id || `${trade.timestamp}-${trade.order}-${trade.side}-${trade.amount}-${trade.price}`);
}

function numberFromTrade(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getRealizedPnl(trade) {
  return numberFromTrade(trade.info?.realizedPnl || trade.info?.realizedProfit || trade.realizedPnl);
}

function getTradeFee(trade) {
  const feeCost = numberFromTrade(trade.fee?.cost);
  if (feeCost > 0) return feeCost;
  return Math.abs(numberFromTrade(trade.info?.commission));
}

async function syncTradesForSymbols({ since, onTrade, errorLabel }) {
  let newTrades = 0;
  for (const symbol of SYMBOLS) {
    try {
      const trades = await retry(() => exchange.fetchMyTrades(symbol, since, 100));
      const sorted = trades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      for (const trade of sorted) {
        if (await onTrade(trade)) newTrades++;
      }
    } catch (err) {
      console.warn(`${symbol} ${errorLabel} sync error: ${err.message}`);
    }
  }
  return newTrades;
}

function applyTradeToProfitLedger(trade) {
  const id = tradeIdOf(trade);
  if (profitLedger.processedTradeIds.includes(id)) return false;
  const realizedPnl = getRealizedPnl(trade);
  const fee = getTradeFee(trade);
  const netProfit = realizedPnl - fee;
  profitLedger.processedTradeIds.push(id);
  profitLedger.processedTradeIds = profitLedger.processedTradeIds.slice(-1000);
  profitLedger.lastTradeTimestamp = Math.max(profitLedger.lastTradeTimestamp || 0, trade.timestamp || 0);
  profitLedger.totals.grossRealizedPnl += realizedPnl;
  profitLedger.totals.fees += fee;
  profitLedger.totals.netProfit += netProfit;
  profitLedger.totals.tradeCount++;
  if (netProfit > 0) profitLedger.totals.profitEvents++;
  if (netProfit < 0) profitLedger.totals.lossEvents++;
  profitLedger.recentTrades.unshift({
    id,
    symbol: trade.symbol,
    time: trade.datetime || new Date(trade.timestamp).toISOString(),
    side: trade.side,
    price: numberFromTrade(trade.price),
    amount: numberFromTrade(trade.amount),
    realizedPnl,
    fee,
    netProfit,
  });
  profitLedger.recentTrades = profitLedger.recentTrades.slice(0, 30);
  return true;
}

async function syncProfitLedger() {
  if (!PROFIT_TRACKER_ENABLED) return;
  try {
    const since = profitLedger.lastTradeTimestamp ? profitLedger.lastTradeTimestamp - 1 : undefined;
    const newTrades = await syncTradesForSymbols({ since, onTrade: applyTradeToProfitLedger, errorLabel: "profit" });
    if (newTrades > 0) saveProfitLedger();
    console.log(`[PROFIT] Synced ${newTrades} trades. Net profit: ${profitLedger.totals.netProfit.toFixed(6)} USDT`);
  } catch (err) {
    console.warn("[WARN] Profit sync:", err.message);
  }
}

// ------------------------------
//  Risk State (cooldown, daily PnL, consecutive losses)
// ------------------------------

function createEmptyRiskState() {
  return {
    dayKey: null,
    dayStartEquity: 0,
    dailyNetPnL: 0,
    consecutiveLosses: 0,
    processedTradeIds: [],
    symbolCooldowns: {},
    lastSyncedAt: 0,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRiskState(state) {
  const empty = createEmptyRiskState();
  return {
    ...empty,
    ...state,
    processedTradeIds: Array.isArray(state?.processedTradeIds) ? state.processedTradeIds : [],
    symbolCooldowns: state?.symbolCooldowns && typeof state.symbolCooldowns === "object" ? state.symbolCooldowns : {},
  };
}

function loadRiskState() {
  try {
    if (fs.existsSync(RISK_STATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(RISK_STATE_PATH, "utf8"));
      return normalizeRiskState(data);
    }
  } catch (err) {
    console.warn("[WARN] Risk state reset:", err.message);
  }
  return createEmptyRiskState();
}

function saveRiskState() {
  riskState.updatedAt = new Date().toISOString();
  fs.writeFileSync(RISK_STATE_PATH, JSON.stringify(riskState, null, 2));
}

async function getAccountEquity() {
  const balance = await retry(() => exchange.fetchBalance());
  return Number(balance?.USDT?.total || balance?.USDT?.free || 0);
}

function isRealizedTrade(trade) {
  return Math.abs(getRealizedPnl(trade)) > 0.0000001;
}

// ---------- LEARNING MEMORY IMPLEMENTATION ----------
function getRRRange(rr) {
  if (rr < 1.5) return "<1.5";
  if (rr < 2) return "1.5-2";
  return ">2";
}

function createEmptyLearningMemory() {
  return {
    version: 1,
    stats: {
      bySymbolSide: {},
      bySymbolStrength: {},
      byRRRange: {},
    },
    lastUpdated: new Date().toISOString(),
  };
}

function loadLearningMemory() {
  if (!LEARNING_MEMORY_ENABLED) return createEmptyLearningMemory();
  try {
    if (fs.existsSync(LEARNING_MEMORY_PATH)) {
      const data = JSON.parse(fs.readFileSync(LEARNING_MEMORY_PATH, "utf8"));
      if (!data.stats) data.stats = createEmptyLearningMemory().stats;
      if (!data.stats.bySymbolSide) data.stats.bySymbolSide = {};
      if (!data.stats.bySymbolStrength) data.stats.bySymbolStrength = {};
      if (!data.stats.byRRRange) data.stats.byRRRange = {};
      return data;
    }
  } catch (err) {
    console.warn("[MEMORY] Failed to load, starting fresh:", err.message);
  }
  return createEmptyLearningMemory();
}

function saveLearningMemory() {
  if (!LEARNING_MEMORY_ENABLED) return;
  learningMemory.lastUpdated = new Date().toISOString();
  fs.writeFileSync(LEARNING_MEMORY_PATH, JSON.stringify(learningMemory, null, 2));
}

function updateMemoryCategory(categoryType, key, isWin, pnl) {
  const category = learningMemory.stats[categoryType];
  if (!category) {
    console.error(`[MEMORY] Unknown category type: ${categoryType}`);
    return;
  }
  if (!category[key]) {
    category[key] = { wins: 0, losses: 0, totalPnl: 0 };
  }
  const entry = category[key];
  if (isWin) entry.wins++;
  else entry.losses++;
  entry.totalPnl += pnl;
}

function recordTradeOutcome(symbol, side, netProfit, strength, rr) {
  if (!LEARNING_MEMORY_ENABLED) return;
  
  const isWin = netProfit > 0;
  const pnl = netProfit;

  const symbolSideKey = `${symbol}_${side.toUpperCase()}`;
  updateMemoryCategory("bySymbolSide", symbolSideKey, isWin, pnl);

  const symbolStrengthKey = `${symbol}_${strength}`;
  updateMemoryCategory("bySymbolStrength", symbolStrengthKey, isWin, pnl);

  const rrRange = getRRRange(rr);
  updateMemoryCategory("byRRRange", rrRange, isWin, pnl);

  saveLearningMemory();
  console.log(`[MEMORY] Recorded ${isWin ? "WIN" : "LOSS"} for ${symbol} ${side} | strength=${strength} | RR=${rrRange} | PnL=${pnl.toFixed(2)}`);
}

function getWinRate(categoryStats) {
  if (!categoryStats) return null;
  const total = categoryStats.wins + categoryStats.losses;
  if (total === 0) return null;
  return (categoryStats.wins / total) * 100;
}

function adjustConfidenceWithMemory(symbol, signal, strength, rr, originalConfidence) {
  if (!LEARNING_MEMORY_ENABLED) return originalConfidence;

  const symbolSideKey = `${symbol}_${signal.toUpperCase()}`;
  const symbolStrengthKey = `${symbol}_${strength}`;
  const rrRange = getRRRange(rr);

  let worstWinRate = 100;
  let worstCategory = null;

  const checkCategory = (key, categoryType) => {
    const cat = learningMemory.stats[categoryType]?.[key];
    if (!cat) return;
    const total = cat.wins + cat.losses;
    if (total >= LEARNING_MEMORY_MIN_TRADES) {
      const wr = getWinRate(cat);
      if (wr !== null && wr < worstWinRate) {
        worstWinRate = wr;
        worstCategory = `${categoryType}.${key}`;
      }
    }
  };

  checkCategory(symbolSideKey, "bySymbolSide");
  checkCategory(symbolStrengthKey, "bySymbolStrength");
  checkCategory(rrRange, "byRRRange");

  if (worstCategory && worstWinRate < LEARNING_MEMORY_BAD_WIN_RATE) {
    const penalty = LEARNING_MEMORY_CONFIDENCE_PENALTY;
    const newConf = Math.floor(originalConfidence * penalty);
    console.log(`[MEMORY] Penalty applied: win rate ${worstWinRate.toFixed(1)}% in ${worstCategory} → confidence ${originalConfidence} → ${newConf}`);
    return newConf;
  }

  return originalConfidence;
}

// ------------------------------
//  Risk State Trade Processing (without per‑fill side effects)
// ------------------------------

async function applyTradeToRiskState(trade) {
  const id = tradeIdOf(trade);
  if (riskState.processedTradeIds.includes(id)) return false;
  
  const realizedPnl = getRealizedPnl(trade);
  const fee = getTradeFee(trade);
  const netProfit = realizedPnl - fee;
  
  riskState.processedTradeIds.push(id);
  riskState.processedTradeIds = riskState.processedTradeIds.slice(-1000);
  riskState.lastSyncedAt = Math.max(riskState.lastSyncedAt || 0, trade.timestamp || 0);
  riskState.dailyNetPnL += netProfit;
  saveRiskState();   // persist after each trade for durability
  
  const symbol = trade.symbol;
  const realizedTrade = isRealizedTrade(trade);
  // Realized PnL is reported on the closing fill. A sell closes a LONG,
  // while a buy closes a SHORT, so use the inverse of the fill side for
  // position-level learning-memory keys.
  const side = realizedTrade
    ? trade.side === "sell" ? "LONG" : "SHORT"
    : trade.side === "buy" ? "LONG" : "SHORT";
  const posKey = `${symbol}_${side}`;
  
  if (realizedTrade) {
    if (!pendingPositionPnL.has(posKey)) {
      const setup = pendingTradeSetups.get(posKey);
      pendingPositionPnL.set(posKey, {
        netProfitSum: 0,
        strength: setup?.strength || null,
        rr: setup?.rr || null,
        recorded: false,
        lastUpdate: Date.now()
      });
    }
    const acc = pendingPositionPnL.get(posKey);
    acc.netProfitSum += netProfit;
    acc.lastUpdate = Date.now();
  }
  return true;
}

// ------------------------------
//  Position Finalization (once per position)
// ------------------------------

async function finalizeClosedPosition(symbol, side, netProfitTotal, strength, rr) {
  // Update risk state: consecutive losses & cooldown
  if (netProfitTotal < 0) {
    riskState.consecutiveLosses++;
    if (SYMBOL_COOLDOWN_ENABLED) {
      setSymbolCooldown(symbol, SYMBOL_COOLDOWN_MINUTES, `loss ${netProfitTotal.toFixed(2)} USDT`);
    }
  } else if (netProfitTotal > 0) {
    riskState.consecutiveLosses = 0;
  }
  saveRiskState();

  // Learning memory
  if (LEARNING_MEMORY_ENABLED && strength && rr) {
    recordTradeOutcome(symbol, side, netProfitTotal, strength, rr);
  }

  // Send one close alert per position
  await sendFonnteAlert(`[POSITION CLOSED] ${symbol} ${side} | Net PnL: ${netProfitTotal.toFixed(2)} USDT`);
}

async function finalizeAnyClosedPositions() {
  const openPositions = await getOpenPositions();
  const openKeys = new Set(openPositions.map(p => `${p.symbol}_${p.side.toUpperCase()}`));

  for (const [posKey, acc] of pendingPositionPnL.entries()) {
    if (acc.recorded) continue;
    if (!openKeys.has(posKey)) {
      const [symbol, side] = posKey.split('_');
      const setup = pendingTradeSetups.get(posKey);
      await finalizeClosedPosition(symbol, side, acc.netProfitSum, setup?.strength, setup?.rr);
      acc.recorded = true;
      pendingTradeSetups.delete(posKey);
      pendingPositionPnL.delete(posKey);
    }
  }
}

function getDailyLossLimit() {
  if (riskState.dayStartEquity <= 0) return MAX_DAILY_LOSS_USDT > 0 ? MAX_DAILY_LOSS_USDT : Infinity;
  const percentLimit = riskState.dayStartEquity * MAX_DAILY_LOSS_PCT;
  if (MAX_DAILY_LOSS_USDT > 0) return Math.min(percentLimit, MAX_DAILY_LOSS_USDT);
  return percentLimit;
}

function resetDailyRiskState(dayKey, equity) {
  riskState = { ...createEmptyRiskState(), dayKey, dayStartEquity: equity };
  saveRiskState();
}

function ensureDailyRiskState(dayKey, equity) {
  if (riskState.dayKey !== dayKey) {
    resetDailyRiskState(dayKey, equity);
  } else if (!riskState.dayStartEquity && equity > 0) {
    riskState.dayStartEquity = equity;
    saveRiskState();
  }
}

async function syncRiskState() {
  try {
    const equity = await getAccountEquity();
    const dayKey = new Date().toISOString().slice(0, 10);
    ensureDailyRiskState(dayKey, equity);
    const dayStart = new Date(`${dayKey}T00:00:00.000Z`).getTime();
    const since = Math.max(dayStart, (riskState.lastSyncedAt || 0) > 0 ? riskState.lastSyncedAt - 1 : dayStart);
    const newTrades = await syncTradesForSymbols({ since, onTrade: applyTradeToRiskState, errorLabel: "risk" });
    if (newTrades > 0) saveRiskState();
    console.log(`[RISK] Daily PnL: ${riskState.dailyNetPnL.toFixed(2)} USDT, consecutive losses: ${riskState.consecutiveLosses}`);
  } catch (err) {
    console.warn("[WARN] Risk sync:", err.message);
  }
}

function riskGateAllowsTrading() {
  const dailyLossLimit = getDailyLossLimit();
  if (dailyLossLimit > 0 && riskState.dailyNetPnL <= -dailyLossLimit) {
    console.warn(`[BLOCK] Daily loss limit -${dailyLossLimit.toFixed(2)} USDT reached`);
    return false;
  }
  if (MAX_CONSECUTIVE_LOSSES > 0 && riskState.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    console.warn(`[BLOCK] Consecutive losses ${riskState.consecutiveLosses}/${MAX_CONSECUTIVE_LOSSES}`);
    return false;
  }
  return true;
}

function setSymbolCooldown(symbol, minutes, reason) {
  if (!SYMBOL_COOLDOWN_ENABLED || minutes <= 0) return;
  riskState.symbolCooldowns[symbol] = {
    until: Date.now() + minutes * 60 * 1000,
    reason,
    updatedAt: new Date().toISOString(),
  };
  console.warn(`[COOLDOWN] ${symbol} paused ${minutes}m: ${reason}`);
  saveRiskState();
}

function symbolCooldownAllowsTrading(symbol) {
  if (!SYMBOL_COOLDOWN_ENABLED) return true;
  const cd = riskState.symbolCooldowns?.[symbol];
  if (!cd) return true;
  if (cd.until <= Date.now()) {
    delete riskState.symbolCooldowns[symbol];
    saveRiskState();
    return true;
  }
  console.log(`[COOLDOWN] ${symbol} skipped for ${Math.ceil((cd.until - Date.now()) / 60000)}m: ${cd.reason}`);
  return false;
}

function cleanupSymbolCooldowns() {
  if (!riskState.symbolCooldowns) return false;
  let changed = false;
  const now = Date.now();
  for (const [sym, cd] of Object.entries(riskState.symbolCooldowns)) {
    if (cd.until <= now) {
      delete riskState.symbolCooldowns[sym];
      changed = true;
    }
  }
  if (changed) saveRiskState();
  return changed;
}

// ------------------------------
//  Circuit Breaker
// ------------------------------

function circuitBreakerAllowsTrading() {
  if (circuitBreakerState.pausedUntil <= Date.now()) return true;
  console.warn(`[CIRCUIT] Paused for ${Math.ceil((circuitBreakerState.pausedUntil - Date.now()) / 60000)}m`);
  return false;
}

function recordCircuitBreakerError(source, err) {
  circuitBreakerState.consecutiveErrors++;
  circuitBreakerState.lastError = `${source}: ${err?.message || err}`;
  if (circuitBreakerState.consecutiveErrors >= 5) {
    circuitBreakerState.pausedUntil = Date.now() + 15 * 60 * 1000;
    console.warn("[CIRCUIT] Trading paused 15m");
  }
}

function recordCircuitBreakerSuccess() {
  if (circuitBreakerState.consecutiveErrors > 0) console.log("[CIRCUIT] Error streak cleared");
  circuitBreakerState.consecutiveErrors = 0;
  circuitBreakerState.lastError = null;
}

// ------------------------------
//  Support & Resistance Detection
// ------------------------------

function detectSwingPoints(ohlcv, windowSize) {
  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const swingHighs = [];
  const swingLows = [];

  for (let i = windowSize; i < ohlcv.length - windowSize; i++) {
    let isHigh = true;
    for (let j = 1; j <= windowSize; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      swingHighs.push({ price: highs[i], index: i, timestamp: ohlcv[i][0] });
    }

    let isLow = true;
    for (let j = 1; j <= windowSize; j++) {
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      swingLows.push({ price: lows[i], index: i, timestamp: ohlcv[i][0] });
    }
  }

  return { swingHighs, swingLows };
}

function clusterLevels(points, tolerance) {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prevPrice = currentCluster[currentCluster.length - 1].price;
    if ((sorted[i].price - prevPrice) / prevPrice <= tolerance) {
      currentCluster.push(sorted[i]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [sorted[i]];
    }
  }
  clusters.push(currentCluster);

  return clusters
    .map(cl => ({
      price: cl.reduce((sum, p) => sum + p.price, 0) / cl.length,
      points: cl,
      strength: cl.length,
    }))
    .sort((a, b) => b.strength - a.strength);
}

function getSupportResistanceLevels(ohlcv, windowSize = SR_WINDOW_SIZE, tolerance = SR_LEVEL_TOLERANCE) {
  const { swingHighs, swingLows } = detectSwingPoints(ohlcv, windowSize);
  const resistanceClusters = clusterLevels(swingHighs, tolerance);
  const supportClusters = clusterLevels(swingLows, tolerance);
  return {
    support: supportClusters.map(c => ({ price: c.price, strength: c.strength })),
    resistance: resistanceClusters.map(c => ({ price: c.price, strength: c.strength })),
  };
}

// ------------------------------
//  AI Prompt & Signal
// ------------------------------

function createHoldAISignal(reason) {
  return { signal: "HOLD", strength: "WEAK", confidence: 0, tradeAllowed: false, reason };
}

function extractJsonObject(text) {
  const cleaned = String(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object");
  return cleaned.slice(start, end + 1);
}

function normalizeAIStrength(value) {
  const s = String(value).trim().toUpperCase();
  const map = {
    LOW: "WEAK",
    MILD: "WEAK",
    MODERATE: "MEDIUM",
    HIGH: "STRONG",
    VERY_HIGH: "EXTREME",
    VERYHIGH: "EXTREME",
  };
  return map[s] || s;
}

function normalizeAISignal(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid AI response");
  const signal = String(raw.signal || "").trim().toUpperCase();
  const strength = normalizeAIStrength(raw.strength);
  const confidence = Number(raw.confidence);
  const tradeAllowed = typeof raw.tradeAllowed === "boolean" ? raw.tradeAllowed : signal !== "HOLD";
  const reason = String(raw.reason || "").slice(0, 500);
  if (!["LONG", "SHORT", "HOLD"].includes(signal)) throw new Error(`Invalid signal: ${signal}`);
  if (!["WEAK", "MEDIUM", "STRONG", "EXTREME"].includes(strength))
    throw new Error(`Invalid strength: ${strength}`);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100)
    throw new Error(`Invalid confidence: ${confidence}`);
  return { signal, strength, confidence, tradeAllowed, reason };
}

function parseAISignal(text) {
  return normalizeAISignal(JSON.parse(extractJsonObject(text)));
}

function buildSRPrompt({
  symbol,
  currentPrice,
  nearestSupport,
  nearestResistance,
  supportStrength,
  resistanceStrength,
  volumeTrend,
  shortTrend,
  longOnly,
}) {
  const allowedSignals = longOnly ? "LONG, HOLD" : "LONG, SHORT, HOLD";
  const directionHint = longOnly ? "LONG only" : "LONG or SHORT";
  return `
You are a professional crypto futures trader AI. Analyze support/resistance levels and decide LONG, SHORT, or HOLD.

Rules:
- LONG when price is near a strong support level and shows bullish reversal signals.
- SHORT when price is near a strong resistance level and shows bearish reversal signals.
- HOLD when price is in the middle of levels, levels are weak, or momentum unclear.
- Do not trade against the nearest key level.
- Volume trend: increasing volume near a level increases confidence.
- Short-term trend (5-period EMA slope) should align with trade direction.

Data:
Symbol: ${symbol}
Current price: ${currentPrice}
Nearest support: ${nearestSupport?.price ?? "none"} (strength: ${nearestSupport?.strength ?? 0})
Nearest resistance: ${nearestResistance?.price ?? "none"} (strength: ${nearestResistance?.strength ?? 0})
Price distance to support: ${nearestSupport ? ((currentPrice - nearestSupport.price) / currentPrice * 100).toFixed(2) : "N/A"}%
Price distance to resistance: ${nearestResistance ? ((nearestResistance.price - currentPrice) / currentPrice * 100).toFixed(2) : "N/A"}%
Volume trend (last 5 candles): ${volumeTrend} (positive = increasing)
Short trend (EMA5 slope): ${shortTrend} (positive = bullish)

Allowed signals: ${allowedSignals}
Strengths: WEAK, MEDIUM, STRONG, EXTREME
Direction preference: ${directionHint}

Return JSON:
{
  "signal": "LONG/SHORT/HOLD",
  "strength": "WEAK/MEDIUM/STRONG/EXTREME",
  "confidence": 0-100,
  "tradeAllowed": true/false,
  "reason": "brief explanation"
}`;
}

function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

async function getAISignal(symbol, currentPrice, supportLevels, resistanceLevels, ohlcv) {
  const cacheKey = getAiSignalCacheKey(symbol, ohlcv);
  const cachedSignal = getCachedAISignal(cacheKey);
  if (cachedSignal) {
    console.log(`[AI CACHE] Hit for ${symbol}`);
    return cachedSignal;
  }

  const supportsBelow = supportLevels.filter(s => s.price < currentPrice).sort((a, b) => b.price - a.price);
  const resistancesAbove = resistanceLevels.filter(r => r.price > currentPrice).sort((a, b) => a.price - b.price);
  const nearestSupport = supportsBelow[0] || null;
  const nearestResistance = resistancesAbove[0] || null;

  const volumes = ohlcv.map(c => c[5]);
  const recentVolAvg = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const prevVolAvg = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
  const volumeTrend = recentVolAvg > prevVolAvg ? "increasing" : "decreasing";

  const closes = ohlcv.map(c => c[4]);
  const ema5 = calculateEMA(closes.slice(-20), 5);
  const prevEma5 = calculateEMA(closes.slice(-21, -1), 5);
  const shortTrend = ema5 > prevEma5 ? "bullish" : "bearish";

  const prompt = buildSRPrompt({
    symbol,
    currentPrice,
    nearestSupport,
    nearestResistance,
    supportStrength: nearestSupport?.strength || 0,
    resistanceStrength: nearestResistance?.strength || 0,
    volumeTrend,
    shortTrend,
    longOnly: LONG_ONLY,
  });

  for (let attempt = 1; attempt <= AI_RESPONSE_RETRIES + 1; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const signal = parseAISignal(text);
      setCachedAISignal(cacheKey, signal);
      return signal;
    } catch (err) {
      console.warn(`[AI] Attempt ${attempt} failed for ${symbol}: ${err.message}`);
      if (attempt <= AI_RESPONSE_RETRIES) await sleep(1000 * attempt);
    }
  }
  recordCircuitBreakerError(`AI ${symbol}`, new Error("AI response failed"));
  const fallbackSignal = createHoldAISignal("AI fallback to HOLD");
  setCachedAISignal(cacheKey, fallbackSignal, Math.min(AI_SIGNAL_CACHE_TTL_MS, 60 * 1000));
  return fallbackSignal;
}

// ------------------------------
//  Risk & Order Management (TP/SL)
// ------------------------------

async function getAvailableBalance() {
  const balance = await retry(() => exchange.fetchBalance());
  return Number(balance?.USDT?.free || 0);
}

async function calculateContracts(symbol, price) {
  const market = exchange.markets[symbol];
  const targetNotional = ORDER_SIZE_USDT * LEVERAGE;
  const minCost = market?.limits?.cost?.min || 5;
  const finalNotional = Math.max(minCost, targetNotional);
  const contracts = finalNotional / price;
  return Number(exchange.amountToPrecision(symbol, contracts));
}

function calculateRequiredMargin(amount, price) {
  return (amount * price) / LEVERAGE;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positionNumber(position, keys) {
  for (const key of keys) {
    const value = key.startsWith("info.") ? position.info?.[key.slice(5)] : position[key];
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

async function getCurrentPosition(symbol) {
  const positions = await retry(() => exchange.fetchPositions([symbol]));
  const pos = positions.find(p => p.symbol === symbol && Number(p.contracts) > 0);
  if (!pos) return null;
  const contracts = Number(pos.contracts);
  const entryPrice = Number(pos.entryPrice);
  const markPrice = positionNumber(pos, ["markPrice", "info.markPrice"]);
  const notional = positionNumber(pos, ["notional", "info.notional", "info.positionInitialMargin"]);
  return {
    side: pos.side,
    symbol: pos.symbol,
    contracts,
    entryPrice,
    markPrice,
    notional: notional === null ? contracts * (markPrice || entryPrice) : Math.abs(notional),
    unrealizedPnl: positionNumber(pos, ["unrealizedPnl", "unrealisedPnl", "info.unRealizedProfit"]),
  };
}

async function getOpenPositions() {
  const open = [];
  for (const sym of SYMBOLS) {
    try {
      const pos = await getCurrentPosition(sym);
      if (pos) open.push(pos);
    } catch (err) {
      console.warn(`${sym} position check: ${err.message}`);
    }
  }
  return open;
}

function getPositionUnrealizedProfitPct(position) {
  if (!Number.isFinite(position.unrealizedPnl) || !Number.isFinite(position.notional) || position.notional <= 0) return null;
  return (position.unrealizedPnl / position.notional) * 100;
}

function shouldCloseForUnrealizedProfit(position) {
  if (!UNREALIZED_PROFIT_CLOSE_ENABLED) return false;
  if (!Number.isFinite(position.unrealizedPnl)) return false;
  if (position.unrealizedPnl <= UNREALIZED_PROFIT_CLOSE_MIN_USDT) return false;

  const profitPct = getPositionUnrealizedProfitPct(position);
  if (UNREALIZED_PROFIT_CLOSE_MIN_PCT > 0 && (profitPct === null || profitPct < UNREALIZED_PROFIT_CLOSE_MIN_PCT)) return false;

  return true;
}

async function closePositionsWithUnrealizedProfit(openPositions, closeOptions = {}) {
  if (!UNREALIZED_PROFIT_CLOSE_ENABLED) return 0;

  let closedCount = 0;
  for (const position of openPositions) {
    if (!shouldCloseForUnrealizedProfit(position)) continue;

    const profitPct = getPositionUnrealizedProfitPct(position);
    const pctLabel = profitPct === null ? "n/a" : `${profitPct.toFixed(4)}%`;
    console.log(
      `[TP] ${position.symbol} ${position.side.toUpperCase()} unrealized profit ${position.unrealizedPnl.toFixed(6)} USDT (${pctLabel}) -> closing position`
    );
    await closePosition(position.symbol, position, closeOptions);
    closedCount++;
  }

  if (closedCount > 0) await syncProfitLedger();
  return closedCount;
}

async function cancelAllOrders(symbol) {
  try {
    const orders = await retry(() => exchange.fetchOpenOrders(symbol));
    for (const o of orders) await retry(() => exchange.cancelOrder(o.id, symbol));
  } catch (err) {
    console.error(err.message);
  }
}

async function openPosition(symbol, signal, price, setupData) {
  await retry(() => exchange.setLeverage(LEVERAGE, symbol));
  const side = signal === "LONG" ? "buy" : "sell";
  const amount = await calculateContracts(symbol, price);
  const requiredMargin = calculateRequiredMargin(amount, price);
  const balance = await getAvailableBalance();
  if (balance < requiredMargin) {
    console.warn(`[BLOCK] Insufficient balance: need ${requiredMargin.toFixed(4)} USDT`);
    return null;
  }
  console.log(`[OPEN] ${signal} ${symbol} | contracts: ${amount} | margin: ${requiredMargin.toFixed(4)}`);
  const order = await retry(() => exchange.createMarketOrder(symbol, side, amount));
  
  // Save setup for learning memory
  if (setupData && LEARNING_MEMORY_ENABLED) {
    const posKey = `${symbol}_${signal}`;
    pendingTradeSetups.set(posKey, {
      ...setupData,
      symbol,
      signal,
      entryPrice: price,
      timestamp: Date.now(),
    });
  }

  lastPositionChangeTime = Date.now();
  await sleep(3000);
  return await getCurrentPosition(symbol);
}

async function closePosition(symbol, position, options = {}) {
  const settleDelayMs = options.settleDelayMs ?? 2000;
  const side = position.side === "long" ? "sell" : "buy";
  await retry(() => exchange.createMarketOrder(symbol, side, position.contracts, { reduceOnly: true }));
  await cancelAllOrders(symbol);
  console.log("[CLOSE] Position closed manually");
  if (settleDelayMs > 0) await sleep(settleDelayMs);
  await syncRiskState(); // update PnL immediately
  // The finalization will be picked up by finalizeAnyClosedPositions in the next cycle
}

async function createStopLossAndTakeProfit(symbol, position, slPrice, tpPrice) {
  await cancelAllOrders(symbol);

  const isLong = position.side === "long";
  const slSide = isLong ? "sell" : "buy";
  const tpSide = isLong ? "sell" : "buy";
  const quantity = position.contracts;

  const slStopPrice = exchange.priceToPrecision(symbol, slPrice);
  await retry(() =>
    exchange.createOrder(symbol, "STOP_MARKET", slSide, quantity, undefined, {
      stopPrice: slStopPrice,
      reduceOnly: true,
      workingType: "MARK_PRICE",
    })
  );
  console.log(`[SL] Stop loss placed at ${slStopPrice} (${slSide})`);

  if (UNREALIZED_PROFIT_CLOSE_ENABLED) {
    console.log(
      `[TP] Exchange take-profit skipped; ${symbol} will close when unrealized PnL is profitable`
    );
    return;
  }

  const tpStopPrice = exchange.priceToPrecision(symbol, tpPrice);
  await retry(() =>
    exchange.createOrder(symbol, "TAKE_PROFIT_MARKET", tpSide, quantity, undefined, {
      stopPrice: tpStopPrice,
      reduceOnly: true,
      workingType: "MARK_PRICE",
    })
  );
  console.log(`[TP] Take profit placed at ${tpStopPrice} (${tpSide})`);
}

// Fixed calculateRR with division by zero guard
function calculateRR(signal, entry, tp, sl) {
  if (signal === "LONG") {
    const risk = entry - sl;
    if (risk <= 0) return 0;
    return (tp - entry) / risk;
  } else {
    const risk = sl - entry;
    if (risk <= 0) return 0;
    return (entry - tp) / risk;
  }
}

function fundingSafe(signal, fundingRate) {
  if (signal === "LONG" && fundingRate > MAX_FUNDING_RATE) return false;
  if (signal === "SHORT" && fundingRate < -MAX_FUNDING_RATE) return false;
  return true;
}

function calculateATR(ohlcv, period = 14) {
  if (!Array.isArray(ohlcv) || ohlcv.length <= period) return null;
  const trs = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const prevClose = ohlcv[i - 1][4];
    const high = ohlcv[i][2];
    const low = ohlcv[i][3];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  const recentTrs = trs.slice(-period);
  if (recentTrs.length < period) return null;
  return recentTrs.reduce((a, b) => a + b, 0) / recentTrs.length;
}

// ------------------------------
//  Analyze Symbol (TP/SL based on S/R + ATR fallback)
// ------------------------------

async function analyzeSymbol(symbol) {
  try {
    console.log(`\n========== SCAN ${symbol} ==========`);
    if (!symbolCooldownAllowsTrading(symbol)) return null;

    const [ticker, funding, ohlcv] = await Promise.all([
      retry(() => exchange.fetchTicker(symbol)),
      retry(() => exchange.fetchFundingRate(symbol)),
      retry(() => exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, LOOKBACK_CANDLES)),
    ]);

    const currentPrice = ticker.last;
    const fundingRate = funding.fundingRate || 0;

    const { support, resistance } = getSupportResistanceLevels(ohlcv, SR_WINDOW_SIZE, SR_LEVEL_TOLERANCE);
    if (!support.length && !resistance.length) {
      console.log(`${symbol} no S/R levels found`);
      return null;
    }

    const supportsBelow = support.filter(s => s.price < currentPrice).sort((a, b) => b.price - a.price);
    const resistancesAbove = resistance.filter(r => r.price > currentPrice).sort((a, b) => a.price - b.price);
    const nearestSupport = supportsBelow[0] || null;
    const nearestResistance = resistancesAbove[0] || null;

    let distanceToSupport = Infinity;
    let distanceToResistance = Infinity;
    if (nearestSupport) distanceToSupport = (currentPrice - nearestSupport.price) / currentPrice;
    if (nearestResistance) distanceToResistance = (nearestResistance.price - currentPrice) / currentPrice;

    if (distanceToSupport > PRICE_PROXIMITY_THRESHOLD && distanceToResistance > PRICE_PROXIMITY_THRESHOLD) {
      console.log(
        `${symbol} price not near any S/R level (dist to S: ${(distanceToSupport * 100).toFixed(2)}%, to R: ${(distanceToResistance * 100).toFixed(2)}%) > threshold ${(PRICE_PROXIMITY_THRESHOLD * 100).toFixed(2)}% -> skip AI`
      );
      return null;
    }
    console.log(
      `${symbol} price near level: ${distanceToSupport <= PRICE_PROXIMITY_THRESHOLD ? "SUPPORT" : "RESISTANCE"} (dist ${(Math.min(distanceToSupport, distanceToResistance) * 100).toFixed(2)}%)`
    );

    let ai = await getAISignal(symbol, currentPrice, support, resistance, ohlcv);
    const originalConfidence = ai.confidence;

    console.log("[AI]", ai);

    const signal = ai.signal;
    if (signal === "HOLD" || (LONG_ONLY && signal === "SHORT")) {
      console.log(`${symbol} skipped: ${signal}`);
      return null;
    }
    if (!ai.tradeAllowed) {
      console.log(`${symbol} tradeAllowed false`);
      return null;
    }

    if (!ALLOWED_AI_STRENGTHS.includes(ai.strength)) {
      console.log(`${symbol} strength ${ai.strength} not allowed`);
      return null;
    }
    if (!fundingSafe(signal, fundingRate)) {
      console.log(`${symbol} funding unsafe`);
      return null;
    }

    const atr = calculateATR(ohlcv.slice(-20), 14);
    if (!atr || atr <= 0) {
      console.log(`${symbol} invalid ATR`);
      return null;
    }
    const buffer = currentPrice * 0.002;
    let slPrice, tpPrice;
    let usedSR = false;
    let slPercent, tpPercent;

    if (signal === "LONG") {
      if (nearestSupport) {
        slPrice = nearestSupport.price - buffer;
        usedSR = true;
      } else {
        slPrice = currentPrice - atr * ATR_SL_MULTIPLIER;
      }
      if (nearestResistance) {
        tpPrice = nearestResistance.price;
        usedSR = true;
      } else {
        tpPrice = currentPrice + atr * ATR_TP_MULTIPLIER;
      }

      if (slPrice >= currentPrice) slPrice = currentPrice - atr * ATR_SL_MULTIPLIER;
      if (tpPrice <= currentPrice) tpPrice = currentPrice + atr * ATR_TP_MULTIPLIER;

      slPercent = (currentPrice - slPrice) / currentPrice;
      tpPercent = (tpPrice - currentPrice) / currentPrice;
    } else {
      if (nearestResistance) {
        slPrice = nearestResistance.price + buffer;
        usedSR = true;
      } else {
        slPrice = currentPrice + atr * ATR_SL_MULTIPLIER;
      }
      if (nearestSupport) {
        tpPrice = nearestSupport.price;
        usedSR = true;
      } else {
        tpPrice = currentPrice - atr * ATR_TP_MULTIPLIER;
      }

      if (slPrice <= currentPrice) slPrice = currentPrice + atr * ATR_SL_MULTIPLIER;
      if (tpPrice >= currentPrice) tpPrice = currentPrice - atr * ATR_TP_MULTIPLIER;

      slPercent = (slPrice - currentPrice) / currentPrice;
      tpPercent = (currentPrice - tpPrice) / currentPrice;
    }

    const rr = calculateRR(signal, currentPrice, tpPrice, slPrice);
    if (rr < MIN_RR) {
      console.log(`${symbol} RR ${rr.toFixed(2)} < ${MIN_RR} (${usedSR ? "S/R based" : "ATR fallback"})`);
      return null;
    }

    if (ai.signal !== "HOLD") {
      const adjustedConfidence = adjustConfidenceWithMemory(
        symbol,
        ai.signal,
        ai.strength,
        rr,
        originalConfidence
      );
      ai = { ...ai, confidence: adjustedConfidence };
    }

    if (ai.confidence < MIN_AI_CONFIDENCE) {
      console.log(`${symbol} low confidence ${ai.confidence} (original ${originalConfidence})`);
      return null;
    }

    console.log(`${symbol} → TP/SL based on ${usedSR ? "S/R levels" : "ATR"} (RR=${rr.toFixed(2)})`);

    return {
      symbol,
      signal,
      ai,
      currentPrice,
      atr,
      slPrice,
      tpPrice,
      rr,
      confidence: ai.confidence,
      strength: ai.strength,
      reason: ai.reason,
      usedSR,
      slPercent,
      tpPercent,
    };
  } catch (err) {
    console.warn(`${symbol} error: ${err.message}`);
    recordCircuitBreakerError(`scan ${symbol}`, err);
    setSymbolCooldown(symbol, SYMBOL_ERROR_COOLDOWN_MINUTES, "scan error");
    saveRiskState();
    return null;
  }
}

// ------------------------------
//  Main Trading Cycle
// ------------------------------

async function tradingCycle() {
  if (isTrading) {
    console.log("[WAIT] Previous cycle still running");
    return;
  }
  isTrading = true;
  const errorsAtStart = circuitBreakerState.consecutiveErrors;
  let circuitAllowed = false;
  try {
    console.log(`\n========== ${new Date().toISOString()} ==========`);
    if (!circuitBreakerAllowsTrading()) return;
    circuitAllowed = true;
    await syncProfitLedger();
    await syncRiskState();

    // Finalize any positions that were closed externally (by SL/TP) since last cycle
    await finalizeAnyClosedPositions();

    cleanupAiSignalCache();
    cleanupSymbolCooldowns();

    const openPositions = await getOpenPositions();
    console.log("Open positions:", openPositions.length ? openPositions.map(p => `${p.symbol} ${p.side}`).join(", ") : "none");

    const closedByUnrealizedProfit = await closePositionsWithUnrealizedProfit(openPositions, { settleDelayMs: 0 });
    if (closedByUnrealizedProfit > 0) {
      console.log(`[TP] Closed ${closedByUnrealizedProfit} profitable position(s); waiting until next cycle before new entries`);
      return;
    }

    if (killSwitchActive()) {
      console.log("[KILL] Cycle stopped");
      return;
    }
    if (!riskGateAllowsTrading()) return;

    const candidates = [];
    for (const sym of SYMBOLS) {
      const cand = await analyzeSymbol(sym);
      if (cand) candidates.push(cand);
    }
    if (candidates.length === 0) {
      console.log("No valid setup");
      return;
    }

    const weightMap = { WEAK: 1, MEDIUM: 2, STRONG: 3, EXTREME: 4 };
    candidates.sort((a, b) => {
      return b.confidence * (weightMap[b.strength] || 1) - a.confidence * (weightMap[a.strength] || 1);
    });
    const best = candidates[0];
    console.log(`[BEST] ${best.symbol} ${best.signal} | conf ${best.confidence} ${best.strength} | RR ${best.rr.toFixed(2)}`);

    const existing = openPositions.find(p => p.symbol === best.symbol);
    if (existing && existing.side === best.signal.toLowerCase()) {
      console.log(`${best.symbol} position already exists`);
      return;
    }
    if (!existing && openPositions.length >= MAX_OPEN_POSITIONS) {
      console.log(`Max open positions reached (${MAX_OPEN_POSITIONS})`);
      return;
    }

    const cooldownMs = REVERSAL_COOLDOWN_MINUTES * 60 * 1000;
    if (existing && Date.now() - lastPositionChangeTime < cooldownMs) {
      console.log(`${best.symbol} reversal cooldown`);
      return;
    }

    if (existing) await closePosition(best.symbol, existing);
    await cancelAllOrders(best.symbol);

    const setupData = {
      signal: best.signal,
      strength: best.strength,
      confidence: best.confidence,
      rr: best.rr,
    };

    const newPos = await openPosition(best.symbol, best.signal, best.currentPrice, setupData);
    if (!newPos) return;

    const actualEntry = newPos.entryPrice;
    let actualSL, actualTP;

    if (best.usedSR) {
      if (best.signal === "LONG") {
        actualSL = actualEntry * (1 - best.slPercent);
        actualTP = actualEntry * (1 + best.tpPercent);
      } else {
        actualSL = actualEntry * (1 + best.slPercent);
        actualTP = actualEntry * (1 - best.tpPercent);
      }
    } else {
      if (best.signal === "LONG") {
        actualSL = actualEntry - best.atr * ATR_SL_MULTIPLIER;
        actualTP = actualEntry + best.atr * ATR_TP_MULTIPLIER;
      } else {
        actualSL = actualEntry + best.atr * ATR_SL_MULTIPLIER;
        actualTP = actualEntry - best.atr * ATR_TP_MULTIPLIER;
      }
    }

    if (best.signal === "LONG") {
      if (actualSL >= actualEntry) actualSL = actualEntry - best.atr * ATR_SL_MULTIPLIER;
      if (actualTP <= actualEntry) actualTP = actualEntry + best.atr * ATR_TP_MULTIPLIER;
    } else {
      if (actualSL <= actualEntry) actualSL = actualEntry + best.atr * ATR_SL_MULTIPLIER;
      if (actualTP >= actualEntry) actualTP = actualEntry - best.atr * ATR_TP_MULTIPLIER;
    }

    const actualRR = calculateRR(best.signal, actualEntry, actualTP, actualSL);
    console.log(`[ADAPT] Entry=${actualEntry}, usedSR=${best.usedSR}, RR=${actualRR.toFixed(2)}`);

    await createStopLossAndTakeProfit(best.symbol, newPos, actualSL, actualTP);

    await sendFonnteAlert(
      formatTradeOpenAlert({
        symbol: best.symbol,
        signal: best.signal,
        entryPrice: actualEntry,
        contracts: newPos.contracts,
        slPrice: actualSL,
        tpPrice: actualTP,
        rr: actualRR,
        confidence: best.confidence,
        strength: best.strength,
      })
    );
  } catch (err) {
    console.error("[ERROR] Trading cycle:", err.message);
    recordCircuitBreakerError("trading cycle", err);
  } finally {
    if (circuitAllowed && circuitBreakerState.consecutiveErrors === errorsAtStart) recordCircuitBreakerSuccess();
    isTrading = false;
  }
}


async function waitForNextCycleWatchingUnrealizedProfit(delayMs) {
  if (!UNREALIZED_PROFIT_CLOSE_ENABLED) {
    await sleep(delayMs);
    return;
  }

  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await sleep(Math.min(UNREALIZED_PROFIT_MONITOR_INTERVAL_MS, remainingMs));

    if (isTrading) continue;

    try {
      const openPositions = await getOpenPositions();
      const closedCount = await closePositionsWithUnrealizedProfit(openPositions, { settleDelayMs: 0 });
      if (closedCount > 0) {
        console.log(`[TP] Closed ${closedCount} profitable position(s) immediately during wait`);
      }
    } catch (err) {
      console.warn(`[TP] Unrealized profit monitor skipped: ${err.message}`);
    }
  }
}

// ------------------------------
//  Main Loop
// ------------------------------

async function main() {
  console.log(`
[START]
SYMBOLS: ${SYMBOLS.join(", ")}
TIMEFRAME: ${TIMEFRAME}
LEVERAGE: ${LEVERAGE}x
ORDER SIZE: ${ORDER_SIZE_USDT} USDT
MAX POSITIONS: ${MAX_OPEN_POSITIONS}
LONG ONLY: ${LONG_ONLY}
SR_WINDOW: ${SR_WINDOW_SIZE}, TOLERANCE: ${SR_LEVEL_TOLERANCE * 100}%
MIN_AI_CONFIDENCE: ${MIN_AI_CONFIDENCE}
ALLOWED_STRENGTHS: ${ALLOWED_AI_STRENGTHS.join(", ")}
UNREALIZED TP MONITOR: ${UNREALIZED_PROFIT_CLOSE_ENABLED ? `${UNREALIZED_PROFIT_MONITOR_INTERVAL_MS}ms` : "OFF"}
LEARNING MEMORY: ${LEARNING_MEMORY_ENABLED ? "ON" : "OFF"} (min trades ${LEARNING_MEMORY_MIN_TRADES}, bad WR ${LEARNING_MEMORY_BAD_WIN_RATE}%, penalty ${LEARNING_MEMORY_CONFIDENCE_PENALTY})
`);

  learningMemory = loadLearningMemory();
  console.log("[MEMORY] Loaded", Object.keys(learningMemory.stats.bySymbolSide).length, "symbol-side records");

  await retry(() => exchange.loadMarkets());
  await syncProfitLedger();
  while (true) {
    try {
      const delay = getNextCandleDelay();
      console.log(`\n[WAIT] Next cycle in ${Math.floor(delay / 1000)}s`);
      await waitForNextCycleWatchingUnrealizedProfit(delay);
      await tradingCycle();
    } catch (err) {
      console.error(err);
      await sleep(5000);
    }
  }
}

main().catch(console.error);
