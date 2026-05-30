// ======================================================
// SR AI BOT - SUPPORT & RESISTANCE + AI VALIDATOR
//   - Detects support/resistance levels from price action
//   - AI validates the strength and direction
//   - Only trades when price near a key level with AI confirmation
//   - Simple TP/SL (no partial, no trailing)
// ======================================================
require("dotenv").config();
const ccxt = require("ccxt");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ======================================================
// Helper functions (reused from original)
// ======================================================
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
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveProjectPath(fileName) {
  return path.resolve(process.cwd(), fileName);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

// ======================================================
// CONFIGURATION
// ======================================================
const DEFAULT_SYMBOLS = "BTC/USDT:USDT,ETH/USDT:USDT,DOGE/USDT:USDT";
const SYMBOLS = envList("SYMBOLS", DEFAULT_SYMBOLS);
const MAX_OPEN_POSITIONS = envNumber("MAX_OPEN_POSITIONS", 2);
const LEVERAGE = envNumber("LEVERAGE", 10);
const ORDER_SIZE_USDT = envNumber("ORDER_SIZE_USDT", 10);
const TIMEFRAME = envValue("TIMEFRAME", "15m");
const LOOKBACK_CANDLES = envNumber("LOOKBACK_CANDLES", 200);
const INTERVAL_MINUTES = envNumber("INTERVAL_MINUTES", 5);
const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;

// SR detection parameters
const SR_WINDOW_SIZE = envNumber("SR_WINDOW_SIZE", 5);     // swing detection window
const SR_LEVEL_TOLERANCE = envNumber("SR_LEVEL_TOLERANCE", 0.005); // 0.5% tolerance for level grouping
const PRICE_PROXIMITY_THRESHOLD = envNumber("PRICE_PROXIMITY_THRESHOLD", 0.005); // 0.5% to consider near level

// [MOD] New env variable: minimum distance to support/resistance to call AI
const PRICE_PROXIMITY_FOR_AI = envNumber("PRICE_PROXIMITY_FOR_AI", 0.005); // 0.5% - if price is farther than this, skip AI

// AI
const GEMINI_MODEL = envValue("GEMINI_MODEL", "gemini-1.5-flash-lite");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
const MIN_AI_CONFIDENCE = envNumber("MIN_AI_CONFIDENCE", 65);
const ALLOWED_AI_STRENGTHS = envList("ALLOWED_AI_STRENGTHS", "MEDIUM,STRONG,EXTREME").map(s => s.toUpperCase());
const AI_RESPONSE_RETRIES = envNumber("AI_RESPONSE_RETRIES", 2);

// Risk / filters (reused)
const MAX_FUNDING_RATE = envNumber("MAX_FUNDING_RATE", 0.1) / 100;
const MIN_RR = envNumber("MIN_RR", 1.5);
const RISK_PER_TRADE_PCT = envNumber("RISK_PER_TRADE_PCT", 1) / 100;
const MAX_DAILY_LOSS_PCT = envNumber("MAX_DAILY_LOSS_PCT", 3) / 100;
const MAX_DAILY_LOSS_USDT = envNumber("MAX_DAILY_LOSS_USDT", 0);
const MAX_CONSECUTIVE_LOSSES = envNumber("MAX_CONSECUTIVE_LOSSES", 3);
const ATR_TP_MULTIPLIER = envNumber("ATR_TP_MULTIPLIER", 1.8);
const ATR_SL_MULTIPLIER = envNumber("ATR_SL_MULTIPLIER", 1.5);
const LONG_ONLY = envBoolean("LONG_ONLY");
const REVERSAL_COOLDOWN_MINUTES = envNumber("REVERSAL_COOLDOWN_MINUTES", 10);
const SYMBOL_COOLDOWN_ENABLED = envBoolean("SYMBOL_COOLDOWN_ENABLED");
const SYMBOL_COOLDOWN_MINUTES = envNumber("SYMBOL_COOLDOWN_MINUTES", 30);
const SYMBOL_ERROR_COOLDOWN_MINUTES = envNumber("SYMBOL_ERROR_COOLDOWN_MINUTES", 5);
const KILL_SWITCH_ENABLED = envBoolean("KILL_SWITCH_ENABLED");
const STOP_TRADING = envTrue("STOP_TRADING");
const KILL_SWITCH_FILE = envValue("KILL_SWITCH_FILE", "bot-paused.flag");
const KILL_SWITCH_PATH = resolveProjectPath(KILL_SWITCH_FILE);

// Profit tracker & risk state (reused logic)
const PROFIT_TRACKER_ENABLED = envBoolean("PROFIT_TRACKER_ENABLED");
const PROFIT_TRACKER_FILE = envValue("PROFIT_TRACKER_FILE", "profit-ledger-sr.json");
const PROFIT_LEDGER_PATH = resolveProjectPath(PROFIT_TRACKER_FILE);
const RISK_STATE_FILE = envValue("RISK_STATE_FILE", "risk-state-sr.json");
const RISK_STATE_PATH = resolveProjectPath(RISK_STATE_FILE);

// Alert (Fonnte)
const FONNTE_ENABLED = envBoolean("FONNTE_ENABLED");
const FONNTE_TOKEN = envValue("FONNTE_TOKEN", "");
const FONNTE_TARGET = envValue("FONNTE_TARGET", "");
const FONNTE_API_URL = envValue("FONNTE_API_URL", "https://api.fonnte.com/send");
const FONNTE_COUNTRY_CODE = envValue("FONNTE_COUNTRY_CODE", "62");

// Exchange
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

// Global state
let isTrading = false;
let lastPositionChangeTime = 0;
let profitLedger = loadProfitLedger();
let riskState = loadRiskState();
let circuitBreakerState = { consecutiveErrors: 0, pausedUntil: 0, lastError: null };
let aiSignalCache = new Map();
let fonnteAlertWarningShown = false;

// ======================================================
// Utility functions (profit, risk, alerts, kill switch)
// ======================================================
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

function shouldSendFonnteAlerts() {
  return Boolean(FONNTE_ENABLED && FONNTE_TOKEN && FONNTE_TARGET);
}

async function postFormUrlEncoded(urlString, formBody, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const request = https.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        Authorization: token,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(formBody),
      },
    }, (response) => {
      let data = "";
      response.on("data", chunk => data += chunk);
      response.on("end", () => resolve({ statusCode: response.statusCode || 0, body: data }));
    });
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
    try { payload = JSON.parse(response.body); } catch { /* ignore */ }
    const success = response.statusCode >= 200 && response.statusCode < 300 &&
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

function formatTradeCloseAlert(trade, realizedPnl, fee, netProfit) {
  return [
    "[TRADE CLOSE]",
    `Symbol: ${trade.symbol || "-"}`,
    `Side: ${String(trade.side || "-").toUpperCase()}`,
    `Time: ${trade.datetime || new Date(trade.timestamp || Date.now()).toISOString()}`,
    `Realized PnL: ${roundNumber(realizedPnl, 6)} USDT`,
    `Fee: ${roundNumber(fee, 6)} USDT`,
    `Net Profit: ${roundNumber(netProfit, 6)} USDT`,
  ].join("\n");
}

// Profit ledger (simplified, same as original)
function createEmptyProfitLedger() {
  const now = new Date().toISOString();
  return {
    symbol: SYMBOLS.join(","),
    startedAt: now,
    updatedAt: now,
    lastTradeTimestamp: Date.now(),
    processedTradeIds: [],
    totals: { grossRealizedPnl: 0, fees: 0, netProfit: 0, tradeCount: 0, profitEvents: 0, lossEvents: 0 },
    recentTrades: [],
  };
}

function normalizeProfitLedger(ledger) {
  const empty = createEmptyProfitLedger();
  return { ...empty, ...ledger, processedTradeIds: Array.isArray(ledger?.processedTradeIds) ? ledger.processedTradeIds : [], totals: { ...empty.totals, ...(ledger?.totals || {}) }, recentTrades: Array.isArray(ledger?.recentTrades) ? ledger.recentTrades : [] };
}

function loadProfitLedger() {
  if (!PROFIT_TRACKER_ENABLED) return createEmptyProfitLedger();
  try {
    if (fs.existsSync(PROFIT_LEDGER_PATH)) {
      const data = JSON.parse(fs.readFileSync(PROFIT_LEDGER_PATH, "utf8"));
      return normalizeProfitLedger(data);
    }
  } catch (err) { console.warn("[WARN] Profit ledger reset:", err.message); }
  return createEmptyProfitLedger();
}

function saveProfitLedger() {
  if (!PROFIT_TRACKER_ENABLED) return;
  profitLedger.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROFIT_LEDGER_PATH, JSON.stringify(profitLedger, null, 2));
}

function tradeIdOf(trade) { return String(trade.id || trade.info?.id || `${trade.timestamp}-${trade.order}-${trade.side}-${trade.amount}-${trade.price}`); }
function numberFromTrade(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function getRealizedPnl(trade) { return numberFromTrade(trade.info?.realizedPnl || trade.info?.realizedProfit || trade.realizedPnl); }
function getTradeFee(trade) { const feeCost = numberFromTrade(trade.fee?.cost); if (feeCost > 0) return feeCost; return Math.abs(numberFromTrade(trade.info?.commission)); }

async function syncTradesForSymbols({ since, onTrade, errorLabel }) {
  let newTrades = 0;
  for (const symbol of SYMBOLS) {
    try {
      const trades = await retry(() => exchange.fetchMyTrades(symbol, since, 100));
      const sorted = trades.sort((a,b) => (a.timestamp||0) - (b.timestamp||0));
      for (const trade of sorted) if (await onTrade(trade)) newTrades++;
    } catch (err) { console.warn(`${symbol} ${errorLabel} sync error: ${err.message}`); }
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
  profitLedger.recentTrades.unshift({ id, symbol: trade.symbol, time: trade.datetime || new Date(trade.timestamp).toISOString(), side: trade.side, price: numberFromTrade(trade.price), amount: numberFromTrade(trade.amount), realizedPnl, fee, netProfit });
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
  } catch (err) { console.warn("[WARN] Profit sync:", err.message); }
}

// Risk state (cooldown, daily PnL, consecutive losses)
function createEmptyRiskState() {
  return { dayKey: null, dayStartEquity: 0, dailyNetPnL: 0, consecutiveLosses: 0, processedTradeIds: [], symbolCooldowns: {}, lastSyncedAt: 0, updatedAt: new Date().toISOString() };
}
function normalizeRiskState(state) {
  const empty = createEmptyRiskState();
  return { ...empty, ...state, processedTradeIds: Array.isArray(state?.processedTradeIds) ? state.processedTradeIds : [], symbolCooldowns: state?.symbolCooldowns && typeof state.symbolCooldowns === "object" ? state.symbolCooldowns : {} };
}
function loadRiskState() {
  try {
    if (fs.existsSync(RISK_STATE_PATH)) return normalizeRiskState(JSON.parse(fs.readFileSync(RISK_STATE_PATH, "utf8")));
  } catch (err) { console.warn("[WARN] Risk state reset:", err.message); }
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
function isRealizedTrade(trade) { return Math.abs(getRealizedPnl(trade)) > 0.0000001; }
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
  if (isRealizedTrade(trade)) {
    if (netProfit < 0) {
      riskState.consecutiveLosses += 1;
      if (SYMBOL_COOLDOWN_ENABLED) setSymbolCooldown(trade.symbol, SYMBOL_COOLDOWN_MINUTES, `loss ${netProfit.toFixed(6)} USDT`);
    } else if (netProfit > 0) riskState.consecutiveLosses = 0;
    await sendFonnteAlert(formatTradeCloseAlert(trade, realizedPnl, fee, netProfit));
  }
  return true;
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
  if (riskState.dayKey !== dayKey) resetDailyRiskState(dayKey, equity);
  else if (!riskState.dayStartEquity && equity > 0) { riskState.dayStartEquity = equity; saveRiskState(); }
}
async function syncRiskState() {
  try {
    const equity = await getAccountEquity();
    const dayKey = new Date().toISOString().slice(0,10);
    ensureDailyRiskState(dayKey, equity);
    const dayStart = new Date(`${dayKey}T00:00:00.000Z`).getTime();
    const since = Math.max(dayStart, (riskState.lastSyncedAt || 0) > 0 ? riskState.lastSyncedAt - 1 : dayStart);
    const newTrades = await syncTradesForSymbols({ since, onTrade: applyTradeToRiskState, errorLabel: "risk" });
    if (newTrades > 0) saveRiskState();
    console.log(`[RISK] Daily PnL: ${riskState.dailyNetPnL.toFixed(2)} USDT, consecutive losses: ${riskState.consecutiveLosses}`);
  } catch (err) { console.warn("[WARN] Risk sync:", err.message); }
}
function riskGateAllowsTrading() {
  const dailyLossLimit = getDailyLossLimit();
  if (dailyLossLimit > 0 && riskState.dailyNetPnL <= -dailyLossLimit) { console.warn(`[BLOCK] Daily loss limit -${dailyLossLimit.toFixed(2)} USDT reached`); return false; }
  if (MAX_CONSECUTIVE_LOSSES > 0 && riskState.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) { console.warn(`[BLOCK] Consecutive losses ${riskState.consecutiveLosses}/${MAX_CONSECUTIVE_LOSSES}`); return false; }
  return true;
}
function setSymbolCooldown(symbol, minutes, reason) {
  if (!SYMBOL_COOLDOWN_ENABLED || minutes <= 0) return;
  riskState.symbolCooldowns[symbol] = { until: Date.now() + minutes * 60 * 1000, reason, updatedAt: new Date().toISOString() };
  console.warn(`[COOLDOWN] ${symbol} paused ${minutes}m: ${reason}`);
  saveRiskState();
}
function symbolCooldownAllowsTrading(symbol) {
  if (!SYMBOL_COOLDOWN_ENABLED) return true;
  const cd = riskState.symbolCooldowns?.[symbol];
  if (!cd) return true;
  if (cd.until <= Date.now()) { delete riskState.symbolCooldowns[symbol]; saveRiskState(); return true; }
  console.log(`[COOLDOWN] ${symbol} skipped for ${Math.ceil((cd.until - Date.now())/60000)}m: ${cd.reason}`);
  return false;
}
function cleanupSymbolCooldowns() {
  if (!riskState.symbolCooldowns) return false;
  let changed = false;
  const now = Date.now();
  for (const [sym, cd] of Object.entries(riskState.symbolCooldowns)) {
    if (cd.until <= now) { delete riskState.symbolCooldowns[sym]; changed = true; }
  }
  if (changed) saveRiskState();
  return changed;
}

// Circuit breaker
function circuitBreakerAllowsTrading() {
  if (circuitBreakerState.pausedUntil <= Date.now()) return true;
  console.warn(`[CIRCUIT] Paused for ${Math.ceil((circuitBreakerState.pausedUntil - Date.now())/60000)}m`);
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

// ======================================================
// SUPPORT & RESISTANCE DETECTION
// ======================================================
function detectSwingPoints(ohlcv, windowSize) {
  // ohlcv: array of [timestamp, open, high, low, close]
  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const swingHighs = [];
  const swingLows = [];
  for (let i = windowSize; i < ohlcv.length - windowSize; i++) {
    let isHigh = true;
    for (let j = 1; j <= windowSize; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) { isHigh = false; break; }
    }
    if (isHigh) swingHighs.push({ price: highs[i], index: i, timestamp: ohlcv[i][0] });
    let isLow = true;
    for (let j = 1; j <= windowSize; j++) {
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) { isLow = false; break; }
    }
    if (isLow) swingLows.push({ price: lows[i], index: i, timestamp: ohlcv[i][0] });
  }
  return { swingHighs, swingLows };
}

function clusterLevels(points, tolerance) {
  // points: array of {price, ...}
  if (!points.length) return [];
  const sorted = [...points].sort((a,b) => a.price - b.price);
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
  return clusters.map(cl => ({
    price: cl.reduce((sum, p) => sum + p.price, 0) / cl.length,
    points: cl,
    strength: cl.length, // more touches = stronger
  })).sort((a,b) => b.strength - a.strength);
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

// ======================================================
// AI PROMPT & SIGNAL
// ======================================================
function createHoldAISignal(reason) {
  return { signal: "HOLD", strength: "WEAK", confidence: 0, tradeAllowed: false, reason };
}

function extractJsonObject(text) {
  const cleaned = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object");
  return cleaned.slice(start, end + 1);
}
function normalizeAIStrength(value) {
  const s = String(value).trim().toUpperCase();
  const map = { LOW: "WEAK", MILD: "WEAK", MODERATE: "MEDIUM", HIGH: "STRONG", VERY_HIGH: "EXTREME", VERYHIGH: "EXTREME" };
  return map[s] || s;
}
function normalizeAISignal(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid AI response");
  const signal = String(raw.signal || "").trim().toUpperCase();
  const strength = normalizeAIStrength(raw.strength);
  const confidence = Number(raw.confidence);
  const tradeAllowed = typeof raw.tradeAllowed === "boolean" ? raw.tradeAllowed : signal !== "HOLD";
  const reason = String(raw.reason || "").slice(0, 500);
  if (!["LONG","SHORT","HOLD"].includes(signal)) throw new Error(`Invalid signal: ${signal}`);
  if (!["WEAK","MEDIUM","STRONG","EXTREME"].includes(strength)) throw new Error(`Invalid strength: ${strength}`);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error(`Invalid confidence: ${confidence}`);
  return { signal, strength, confidence, tradeAllowed, reason };
}
function parseAISignal(text) { return normalizeAISignal(JSON.parse(extractJsonObject(text))); }

function buildSRPrompt({ symbol, currentPrice, nearestSupport, nearestResistance, supportStrength, resistanceStrength, volumeTrend, shortTrend, longOnly }) {
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
Price distance to support: ${nearestSupport ? ((currentPrice - nearestSupport.price)/currentPrice * 100).toFixed(2) : "N/A"}%
Price distance to resistance: ${nearestResistance ? ((nearestResistance.price - currentPrice)/currentPrice * 100).toFixed(2) : "N/A"}%
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

async function getAISignal(symbol, currentPrice, supportLevels, resistanceLevels, ohlcv) {
  // Find nearest support (below price) and resistance (above price)
  const supportsBelow = supportLevels.filter(s => s.price < currentPrice).sort((a,b) => b.price - a.price);
  const resistancesAbove = resistanceLevels.filter(r => r.price > currentPrice).sort((a,b) => a.price - b.price);
  const nearestSupport = supportsBelow[0] || null;
  const nearestResistance = resistancesAbove[0] || null;
  
  // Simple volume trend: compare last 5 candles volume average with previous 5
  const closes = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);
  const recentVolAvg = volumes.slice(-5).reduce((a,b) => a+b,0)/5;
  const prevVolAvg = volumes.slice(-10,-5).reduce((a,b) => a+b,0)/5;
  const volumeTrend = recentVolAvg > prevVolAvg ? "increasing" : "decreasing";
  // short trend: EMA5 slope
  const ema5 = calculateEMA(closes.slice(-20), 5);
  const prevEma5 = calculateEMA(closes.slice(-21, -1), 5);
  const shortTrend = ema5 > prevEma5 ? "bullish" : "bearish";
  
  const prompt = buildSRPrompt({
    symbol, currentPrice, nearestSupport, nearestResistance,
    supportStrength: nearestSupport?.strength || 0,
    resistanceStrength: nearestResistance?.strength || 0,
    volumeTrend, shortTrend, longOnly: LONG_ONLY,
  });
  
  for (let attempt = 1; attempt <= AI_RESPONSE_RETRIES + 1; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const signal = parseAISignal(text);
      return signal;
    } catch (err) {
      console.warn(`[AI] Attempt ${attempt} failed for ${symbol}: ${err.message}`);
      if (attempt <= AI_RESPONSE_RETRIES) await sleep(1000 * attempt);
    }
  }
  recordCircuitBreakerError(`AI ${symbol}`, new Error("AI response failed"));
  return createHoldAISignal("AI fallback to HOLD");
}

// Helper EMA
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}

function calculateATR(ohlcv, period = 14) {
  let trs = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const prevClose = ohlcv[i-1][4];
    const high = ohlcv[i][2], low = ohlcv[i][3];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  return trs.slice(-period).reduce((a,b) => a + b, 0) / period;
}

// ======================================================
// RISK & ORDER MANAGEMENT (simplified TP/SL)
// ======================================================
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

function calculateRequiredMargin(amount, price) { return (amount * price) / LEVERAGE; }

async function getCurrentPosition(symbol) {
  const positions = await retry(() => exchange.fetchPositions([symbol]));
  const pos = positions.find(p => p.symbol === symbol && Number(p.contracts) > 0);
  if (!pos) return null;
  return { side: pos.side, symbol: pos.symbol, contracts: Number(pos.contracts), entryPrice: Number(pos.entryPrice) };
}

async function getOpenPositions() {
  const open = [];
  for (const sym of SYMBOLS) {
    try {
      const pos = await getCurrentPosition(sym);
      if (pos) open.push(pos);
    } catch (err) { console.warn(`${sym} position check: ${err.message}`); }
  }
  return open;
}

async function cancelAllOrders(symbol) {
  try {
    const orders = await retry(() => exchange.fetchOpenOrders(symbol));
    for (const o of orders) await retry(() => exchange.cancelOrder(o.id, symbol));
  } catch (err) { console.error(err.message); }
}

async function openPosition(symbol, signal, price) {
  await retry(() => exchange.setLeverage(LEVERAGE, symbol));
  const side = signal === "LONG" ? "buy" : "sell";
  const amount = await calculateContracts(symbol, price);
  const requiredMargin = calculateRequiredMargin(amount, price);
  const balance = await getAvailableBalance();
  if (balance < requiredMargin) { console.warn(`[BLOCK] Insufficient balance: need ${requiredMargin.toFixed(4)} USDT`); return null; }
  console.log(`[OPEN] ${signal} ${symbol} | contracts: ${amount} | margin: ${requiredMargin.toFixed(4)}`);
  const order = await retry(() => exchange.createMarketOrder(symbol, side, amount));
  lastPositionChangeTime = Date.now();
  await sleep(3000);
  return await getCurrentPosition(symbol);
}

async function closePosition(symbol, position) {
  const side = position.side === "long" ? "sell" : "buy";
  await retry(() => exchange.createMarketOrder(symbol, side, position.contracts, { reduceOnly: true }));
  await cancelAllOrders(symbol);
  console.log("[CLOSE] Position closed");
}

// NEW: Create simple stop loss and take profit orders (market-based, full quantity)
async function createStopLossAndTakeProfit(symbol, position, slPrice, tpPrice) {
  const isLong = position.side === "long";
  const slSide = isLong ? "sell" : "buy";
  const tpSide = isLong ? "sell" : "buy";
  const quantity = position.contracts;
  
  // Stop Loss (STOP_MARKET)
  const slStopPrice = exchange.priceToPrecision(symbol, slPrice);
  await retry(() => exchange.createOrder(symbol, "STOP_MARKET", slSide, quantity, undefined, {
    stopPrice: slStopPrice,
    reduceOnly: true,
    workingType: "MARK_PRICE"
  }));
  console.log(`[SL] Stop loss placed at ${slStopPrice} (${slSide})`);
  
  // Take Profit (TAKE_PROFIT_MARKET)
  const tpStopPrice = exchange.priceToPrecision(symbol, tpPrice);
  await retry(() => exchange.createOrder(symbol, "TAKE_PROFIT_MARKET", tpSide, quantity, undefined, {
    stopPrice: tpStopPrice,
    reduceOnly: true,
    workingType: "MARK_PRICE"
  }));
  console.log(`[TP] Take profit placed at ${tpStopPrice} (${tpSide})`);
}

function calculateRR(signal, entry, tp, sl) {
  if (signal === "LONG") return (tp - entry) / (entry - sl);
  return (entry - tp) / (sl - entry);
}

function fundingSafe(signal, fundingRate) {
  if (signal === "LONG" && fundingRate > MAX_FUNDING_RATE) return false;
  if (signal === "SHORT" && fundingRate < -MAX_FUNDING_RATE) return false;
  return true;
}

// ======================================================
// MAIN TRADING CYCLE
// ======================================================
async function analyzeSymbol(symbol) {
  try {
    console.log(`\n========== SCAN ${symbol} ==========`);
    if (!symbolCooldownAllowsTrading(symbol)) return null;
    
    // Fetch market data
    const [ticker, funding, ohlcv] = await Promise.all([
      retry(() => exchange.fetchTicker(symbol)),
      retry(() => exchange.fetchFundingRate(symbol)),
      retry(() => exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, LOOKBACK_CANDLES)),
    ]);
    const currentPrice = ticker.last;
    const fundingRate = funding.fundingRate || 0;
    
    // Detect support/resistance
    const { support, resistance } = getSupportResistanceLevels(ohlcv, SR_WINDOW_SIZE, SR_LEVEL_TOLERANCE);
    if (!support.length && !resistance.length) {
      console.log(`${symbol} no S/R levels found`);
      return null;
    }
    
    // [MOD] === BEGIN: PRICE PROXIMITY CHECK BEFORE AI ===
    // Find nearest support below price and nearest resistance above price
    const supportsBelow = support.filter(s => s.price < currentPrice).sort((a,b) => b.price - a.price);
    const resistancesAbove = resistance.filter(r => r.price > currentPrice).sort((a,b) => a.price - b.price);
    const nearestSupport = supportsBelow[0] || null;
    const nearestResistance = resistancesAbove[0] || null;
    
    let distanceToSupport = Infinity;
    let distanceToResistance = Infinity;
    if (nearestSupport) distanceToSupport = (currentPrice - nearestSupport.price) / currentPrice;
    if (nearestResistance) distanceToResistance = (nearestResistance.price - currentPrice) / currentPrice;
    
    const minDistanceToLevel = PRICE_PROXIMITY_FOR_AI; // e.g., 0.005 = 0.5%
    // If price is not close to any key level, skip AI entirely
    if (distanceToSupport > minDistanceToLevel && distanceToResistance > minDistanceToLevel) {
      console.log(`${symbol} price not near any S/R level (dist to S: ${(distanceToSupport*100).toFixed(2)}%, to R: ${(distanceToResistance*100).toFixed(2)}%) -> skip AI`);
      return null;
    }
    console.log(`${symbol} price near level: ${distanceToSupport <= minDistanceToLevel ? 'SUPPORT' : 'RESISTANCE'} (dist ${(Math.min(distanceToSupport, distanceToResistance)*100).toFixed(2)}%)`);
    // [MOD] === END: PRICE PROXIMITY CHECK ===
    
    // AI evaluation (only if price is near a level)
    const ai = await getAISignal(symbol, currentPrice, support, resistance, ohlcv);
    console.log("[AI]", ai);
    
    const signal = ai.signal;
    if (signal === "HOLD" || (LONG_ONLY && signal === "SHORT")) {
      console.log(`${symbol} skipped: ${signal}`);
      return null;
    }
    if (!ai.tradeAllowed) { console.log(`${symbol} tradeAllowed false`); return null; }
    if (ai.confidence < MIN_AI_CONFIDENCE) { console.log(`${symbol} low confidence ${ai.confidence}`); return null; }
    if (!ALLOWED_AI_STRENGTHS.includes(ai.strength)) { console.log(`${symbol} strength ${ai.strength} not allowed`); return null; }
    if (!fundingSafe(signal, fundingRate)) { console.log(`${symbol} funding unsafe`); return null; }
    
    // Calculate ATR for risk
    const atr = calculateATR(ohlcv.slice(-20), 14);
    const slMultiplier = ATR_SL_MULTIPLIER;
    const tpMultiplier = ATR_TP_MULTIPLIER;
    let slPrice, tpPrice;
    if (signal === "LONG") {
      slPrice = currentPrice - atr * slMultiplier;
      tpPrice = currentPrice + atr * tpMultiplier;
    } else {
      slPrice = currentPrice + atr * slMultiplier;
      tpPrice = currentPrice - atr * tpMultiplier;
    }
    const rr = calculateRR(signal, currentPrice, tpPrice, slPrice);
    if (rr < MIN_RR) { console.log(`${symbol} RR ${rr.toFixed(2)} < ${MIN_RR}`); return null; }
    
    // All filters passed
    return {
      symbol, signal, ai, currentPrice, atr, slPrice, tpPrice, rr,
      confidence: ai.confidence, strength: ai.strength, reason: ai.reason,
    };
  } catch (err) {
    console.warn(`${symbol} error: ${err.message}`);
    recordCircuitBreakerError(`scan ${symbol}`, err);
    setSymbolCooldown(symbol, SYMBOL_ERROR_COOLDOWN_MINUTES, "scan error");
    saveRiskState();
    return null;
  }
}

async function tradingCycle() {
  if (isTrading) { console.log("[WAIT] Previous cycle still running"); return; }
  isTrading = true;
  const errorsAtStart = circuitBreakerState.consecutiveErrors;
  let circuitAllowed = false;
  try {
    console.log(`\n========== ${new Date().toISOString()} ==========`);
    if (!circuitBreakerAllowsTrading()) return;
    circuitAllowed = true;
    await syncProfitLedger();
    await syncRiskState();
    cleanupSymbolCooldowns();
    
    const openPositions = await getOpenPositions();
    console.log("Open positions:", openPositions.length ? openPositions.map(p => `${p.symbol} ${p.side}`).join(", ") : "none");
    
    if (killSwitchActive()) { console.log("[KILL] Cycle stopped"); return; }
    if (!riskGateAllowsTrading()) return;
    
    // Scan all symbols
    const candidates = [];
    for (const sym of SYMBOLS) {
      const cand = await analyzeSymbol(sym);
      if (cand) candidates.push(cand);
    }
    if (candidates.length === 0) { console.log("No valid setup"); return; }
    
    // Rank by confidence * strength weight
    candidates.sort((a,b) => {
      const weight = { WEAK:1, MEDIUM:2, STRONG:3, EXTREME:4 };
      return (b.confidence * (weight[b.strength]||1)) - (a.confidence * (weight[a.strength]||1));
    });
    const best = candidates[0];
    console.log(`[BEST] ${best.symbol} ${best.signal} | conf ${best.confidence} ${best.strength} | RR ${best.rr.toFixed(2)}`);
    
    // Check if already have position in same direction
    const existing = openPositions.find(p => p.symbol === best.symbol);
    if (existing && existing.side === best.signal.toLowerCase()) {
      console.log(`${best.symbol} position already exists`);
      return;
    }
    // Max positions limit
    if (!existing && openPositions.length >= MAX_OPEN_POSITIONS) {
      console.log(`Max open positions reached (${MAX_OPEN_POSITIONS})`);
      return;
    }
    // Reversal cooldown
    const cooldownMs = REVERSAL_COOLDOWN_MINUTES * 60 * 1000;
    if (existing && Date.now() - lastPositionChangeTime < cooldownMs) {
      console.log(`${best.symbol} reversal cooldown`);
      return;
    }
    
    // Close opposite position if exists
    if (existing) await closePosition(best.symbol, existing);
    await cancelAllOrders(best.symbol);
    
    // Open new position
    const newPos = await openPosition(best.symbol, best.signal, best.currentPrice);
    if (!newPos) return;
    
    const actualEntry = newPos.entryPrice;
    // Recompute SL based on actual entry and ATR
    let actualSL, actualTP;
    if (best.signal === "LONG") {
      actualSL = actualEntry - best.atr * ATR_SL_MULTIPLIER;
      actualTP = actualEntry + best.atr * ATR_TP_MULTIPLIER;
    } else {
      actualSL = actualEntry + best.atr * ATR_SL_MULTIPLIER;
      actualTP = actualEntry - best.atr * ATR_TP_MULTIPLIER;
    }
    const actualRR = calculateRR(best.signal, actualEntry, actualTP, actualSL);
    
    // Create simple SL and TP orders (no partial, no trailing)
    await createStopLossAndTakeProfit(best.symbol, newPos, actualSL, actualTP);
    
    await sendFonnteAlert(formatTradeOpenAlert({
      symbol: best.symbol, signal: best.signal, entryPrice: actualEntry,
      contracts: newPos.contracts, slPrice: actualSL, tpPrice: actualTP,
      rr: actualRR, confidence: best.confidence, strength: best.strength,
    }));
  } catch (err) {
    console.error("[ERROR] Trading cycle:", err.message);
    recordCircuitBreakerError("trading cycle", err);
  } finally {
    if (circuitAllowed && circuitBreakerState.consecutiveErrors === errorsAtStart) recordCircuitBreakerSuccess();
    isTrading = false;
  }
}

// ======================================================
// MAIN LOOP
// ======================================================
async function main() {
  console.log(`
[START] SR + AI Bot (Simple TP/SL)
SYMBOLS: ${SYMBOLS.join(", ")}
TIMEFRAME: ${TIMEFRAME}
LEVERAGE: ${LEVERAGE}x
ORDER SIZE: ${ORDER_SIZE_USDT} USDT
MAX POSITIONS: ${MAX_OPEN_POSITIONS}
LONG ONLY: ${LONG_ONLY}
SR_WINDOW: ${SR_WINDOW_SIZE}, TOLERANCE: ${SR_LEVEL_TOLERANCE*100}%
MIN_AI_CONFIDENCE: ${MIN_AI_CONFIDENCE}
ALLOWED_STRENGTHS: ${ALLOWED_AI_STRENGTHS.join(", ")}
PRICE_PROXIMITY_FOR_AI: ${PRICE_PROXIMITY_FOR_AI * 100}%  // [MOD]
`);
  await retry(() => exchange.loadMarkets());
  await syncProfitLedger();
  while (true) {
    try {
      const delay = getNextCandleDelay();
      console.log(`\n[WAIT] Next cycle in ${Math.floor(delay/1000)}s`);
      await sleep(delay);
      await tradingCycle();
    } catch (err) {
      console.error(err);
      await sleep(5000);
    }
  }
}

main().catch(console.error);
