// ======================================================
// SMART BINANCE AI FUTURES BOT
// ======================================================

require("dotenv").config();
const ccxt = require("ccxt");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ======================================================
// CONFIGURATION (all environment variables)
// ======================================================
const config = {
  // Symbols & trading limits
  defaultMemeSymbols: "DOGE/USDT:USDT,1000SHIB/USDT:USDT,1000PEPE/USDT:USDT,1000FLOKI/USDT:USDT,1000BONK/USDT:USDT",
  get symbols() {
    const input = process.env.SYMBOLS || process.env.MEME_SYMBOLS || process.env.SYMBOL || this.defaultMemeSymbols;
    return input.split(",").map(s => s.trim()).filter(Boolean);
  },
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS) || 1,
  leverage: Number(process.env.LEVERAGE) || 10,
  orderSizeUsdt: Number(process.env.ORDER_SIZE_USDT) || 5,
  timeframe: process.env.TIMEFRAME || "5m",
  htfTimeframe: process.env.HTF_TIMEFRAME || "15m",
  lookbackCandles: Number(process.env.LOOKBACK_CANDLES) || 200,
  intervalMinutes: Number(process.env.INTERVAL_MINUTES) || 5,
  scanRotationBatchSize: Math.max(1, Number(process.env.SCAN_ROTATION_BATCH_SIZE) || 2),

  // Caching
  marketSnapshotCacheEnabled: process.env.MARKET_SNAPSHOT_CACHE_ENABLED !== "false",
  aiSignalCacheEnabled: process.env.AI_SIGNAL_CACHE_ENABLED !== "false",
  cacheMaxEntries: Math.max(1, Number(process.env.CACHE_MAX_ENTRIES) || 500),

  // Emergency controls
  killSwitchEnabled: process.env.KILL_SWITCH_ENABLED !== "false",
  stopTrading: process.env.STOP_TRADING === "true",
  killSwitchFile: process.env.KILL_SWITCH_FILE || "bot-paused.flag",

  // Profit tracking
  profitTrackerEnabled: process.env.PROFIT_TRACKER_ENABLED !== "false",
  profitTrackerFile: process.env.PROFIT_TRACKER_FILE || "profit-ledger.json",
  profitSyncLimit: Number(process.env.PROFIT_SYNC_LIMIT) || 100,

  // Risk parameters
  maxFundingRate: (Number(process.env.MAX_FUNDING_RATE) || 0.1) / 100,
  minRr: Number(process.env.MIN_RR) || 1.5,
  riskPerTradePct: (Number(process.env.RISK_PER_TRADE_PCT) || 1) / 100,
  maxDailyLossPct: (Number(process.env.MAX_DAILY_LOSS_PCT) || 3) / 100,
  maxDailyLossUsdt: Number(process.env.MAX_DAILY_LOSS_USDT) || 0,
  maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES) || 3,
  maxPositionNotionalUsdt: Number(process.env.MAX_POSITION_NOTIONAL_USDT) || (Number(process.env.ORDER_SIZE_USDT) || 5) * (Number(process.env.LEVERAGE) || 10),

  // ATR & trailing
  atrTpMultiplier: Number(process.env.ATR_TP_MULTIPLIER) || 1.8,
  trailingCallbackMin: Number(process.env.TRAILING_CALLBACK_MIN) || 0.3,
  trailingCallbackMax: Number(process.env.TRAILING_CALLBACK_MAX) || 1.5,

  // Partial TP
  tp1Percent: Number(process.env.TP1_PERCENT) || 30,
  tp2Percent: Number(process.env.TP2_PERCENT) || 40,
  tp1Rr: Number(process.env.TP1_RR) || 1.0,
  tp2Rr: Number(process.env.TP2_RR) || 2.0,

  // Filters
  requiredConfirmations: Number(process.env.REQUIRED_CONFIRMATION) || 2,
  sidewaysEmaGap: Number(process.env.SIDEWAYS_EMA_GAP) || 0.04,
  reversalCooldownMinutes: Number(process.env.REVERSAL_COOLDOWN_MINUTES) || 10,
  longOnly: process.env.LONG_ONLY !== "false",
  regimeFilterEnabled: process.env.REGIME_FILTER_ENABLED !== "false",
  allowedMarketRegimes: (process.env.ALLOWED_MARKET_REGIMES || "TRENDING_UP,TRENDING_DOWN").split(",").map(r => r.trim().toUpperCase()),
  maxAtrPct: (Number(process.env.MAX_ATR_PCT) || 2.5) / 100,
  minAtrPct: (Number(process.env.MIN_ATR_PCT) || 0.15) / 100,
  minVolumeChangeForTrend: Number(process.env.MIN_VOLUME_CHANGE_FOR_TREND) || -20,
  symbolCooldownEnabled: process.env.SYMBOL_COOLDOWN_ENABLED !== "false",
  symbolCooldownMinutes: Number(process.env.SYMBOL_COOLDOWN_MINUTES) || 30,
  symbolErrorCooldownMinutes: Number(process.env.SYMBOL_ERROR_COOLDOWN_MINUTES) || 5,

  // AI
  geminiModel: process.env.GEMINI_MODEL || "gemini-1.5-flash-lite",
  aiFilterEnabled: process.env.AI_FILTER_ENABLED !== "false",
  minAiConfidence: Number(process.env.MIN_AI_CONFIDENCE) || 65,
  allowedAiStrengths: (process.env.ALLOWED_AI_STRENGTHS || "MEDIUM,STRONG,EXTREME").split(",").map(s => s.trim().toUpperCase()),
  aiResponseRetries: Number(process.env.AI_RESPONSE_RETRIES) || 2,
  aiExplainLogEnabled: process.env.AI_EXPLAIN_LOG_ENABLED !== "false",
  aiExplainLogFile: process.env.AI_EXPLAIN_LOG_FILE || "ai-explain-log.jsonl",
  aiExplainLogMaxLines: Number(process.env.AI_EXPLAIN_LOG_MAX_LINES) || 5000,

  // Circuit breaker
  circuitBreakerEnabled: process.env.CIRCUIT_BREAKER_ENABLED !== "false",
  circuitBreakerMaxErrors: Number(process.env.CIRCUIT_BREAKER_MAX_ERRORS) || 5,
  circuitBreakerPauseMinutes: Number(process.env.CIRCUIT_BREAKER_PAUSE_MINUTES) || 15,

  // Alerts
  fonnteEnabled: process.env.FONNTE_ENABLED !== "false",
  fonnteToken: process.env.FONNTE_TOKEN || "",
  fonnteTarget: process.env.FONNTE_TARGET || "",
  fonnteApiUrl: process.env.FONNTE_API_URL || "https://api.fonnte.com/send",
  fonnteCountryCode: process.env.FONNTE_COUNTRY_CODE || "62",

  // Paths
  riskStateFile: process.env.RISK_STATE_FILE || "risk-state.json",
};

// Derived config
config.intervalMs = config.intervalMinutes * 60 * 1000;
config.scanSymbols = config.symbols;
config.rotatingScanEnabled = config.scanRotationBatchSize < config.scanSymbols.length;
config.effectiveRequiredConfirmations = config.rotatingScanEnabled ? 1 : config.requiredConfirmations;
config.killSwitchPath = path.resolve(process.cwd(), config.killSwitchFile);
config.profitLedgerPath = path.resolve(process.cwd(), config.profitTrackerFile);
config.riskStatePath = path.resolve(process.cwd(), config.riskStateFile);
config.aiExplainLogPath = path.resolve(process.cwd(), config.aiExplainLogFile);

// ======================================================
// EXCHANGE SETUP
// ======================================================
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

// ======================================================
// GLOBAL STATE
// ======================================================
let isTrading = false;
let signalStateBySymbol = {};
let lastPositionChangeTime = 0;
let marketSnapshotCache = new Map();
let aiSignalCache = new Map();
let fonnteAlertWarningShown = false;
let circuitBreakerState = {
  consecutiveErrors: 0,
  pausedUntil: 0,
  lastError: null,
};

// ======================================================
// UTILITY FUNCTIONS
// ======================================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const roundNumber = (value, digits = 6) => {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : null;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isCacheValid = (entry) => entry && entry.expiresAt > Date.now();

const pruneCache = (cache, maxEntries) => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
};

const cleanupCaches = () => {
  pruneCache(marketSnapshotCache, config.cacheMaxEntries);
  pruneCache(aiSignalCache, config.cacheMaxEntries);
};

const retry = async (fn, retries = 3, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`[WARN] Retry ${i + 1}/${retries}:`, err.message);
      await sleep(delay);
    }
  }
};

const killSwitchActive = () => {
  if (!config.killSwitchEnabled) return false;
  if (config.stopTrading) {
    console.warn("[KILL] STOP_TRADING=true, new entries disabled");
    return true;
  }
  if (fs.existsSync(config.killSwitchPath)) {
    console.warn(`[KILL] ${config.killSwitchFile} exists, new entries disabled`);
    return true;
  }
  return false;
};

const loadJsonFile = (filePath, fallbackFactory) => {
  if (!fs.existsSync(filePath)) return fallbackFactory();
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(`[WARN] Failed to load ${filePath}:`, err.message);
    return fallbackFactory();
  }
};

// ======================================================
// ALERTS (Fonnte)
// ======================================================
const shouldSendFonnteAlerts = () => config.fonnteEnabled && config.fonnteToken && config.fonnteTarget;

const postFormUrlEncoded = (urlString, formBody, token) => new Promise((resolve, reject) => {
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

const sendFonnteAlert = async (message) => {
  if (!shouldSendFonnteAlerts()) {
    if (config.fonnteEnabled && !fonnteAlertWarningShown) {
      fonnteAlertWarningShown = true;
      console.warn("[FONNTE] Alert skipped: missing FONNTE_TOKEN or FONNTE_TARGET");
    }
    return false;
  }
  try {
    const formBody = new URLSearchParams({
      target: config.fonnteTarget,
      message,
      countryCode: String(config.fonnteCountryCode),
    }).toString();
    const response = await postFormUrlEncoded(config.fonnteApiUrl, formBody, config.fonnteToken);
    let payload = null;
    try { payload = JSON.parse(response.body); } catch { /* ignore */ }
    const success = response.statusCode >= 200 && response.statusCode < 300 && payload?.status !== false && payload?.Status !== false;
    if (!success) console.warn(`[FONNTE] Alert failed (${response.statusCode}): ${response.body || "empty"}`);
    else console.log("[FONNTE] Trade alert sent");
    return success;
  } catch (err) {
    console.warn(`[FONNTE] Alert error: ${err.message}`);
    return false;
  }
};

const formatTradeOpenAlert = ({ symbol, signal, entryPrice, contracts, slPrice, tpPrice, rr, confidence, strength }) =>
  `[TRADE OPEN]\nSymbol: ${symbol}\nSide: ${signal}\nEntry: ${roundNumber(entryPrice, 10)}\nContracts: ${roundNumber(contracts, 8)}\nSL: ${roundNumber(slPrice, 10)}\nTP: ${roundNumber(tpPrice, 10)}\nRR: ${roundNumber(rr, 2)}\nConfidence: ${confidence ?? "-"}\nStrength: ${strength || "-"}`;

const formatTradeCloseAlert = (trade, realizedPnl, fee, netProfit) =>
  `[TRADE CLOSE]\nSymbol: ${trade.symbol || "-"}\nSide: ${String(trade.side || "-").toUpperCase()}\nTime: ${trade.datetime || new Date(trade.timestamp || Date.now()).toISOString()}\nRealized PnL: ${roundNumber(realizedPnl, 6)} USDT\nFee: ${roundNumber(fee, 6)} USDT\nNet Profit: ${roundNumber(netProfit, 6)} USDT`;

// ======================================================
// PROFIT LEDGER
// ======================================================
let profitLedger;

const createEmptyProfitLedger = () => ({
  symbol: config.scanSymbols.join(","),
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastTradeTimestamp: Date.now(),
  processedTradeIds: [],
  totals: { grossRealizedPnl: 0, fees: 0, netProfit: 0, tradeCount: 0, profitEvents: 0, lossEvents: 0 },
  recentTrades: [],
});

const normalizeProfitLedger = (ledger) => ({ ...createEmptyProfitLedger(), ...ledger, processedTradeIds: Array.isArray(ledger?.processedTradeIds) ? ledger.processedTradeIds : [], totals: { ...createEmptyProfitLedger().totals, ...(ledger?.totals || {}) }, recentTrades: Array.isArray(ledger?.recentTrades) ? ledger.recentTrades : [] });

const loadProfitLedger = () => normalizeProfitLedger(loadJsonFile(config.profitLedgerPath, createEmptyProfitLedger));
const saveProfitLedger = () => { profitLedger.updatedAt = new Date().toISOString(); fs.writeFileSync(config.profitLedgerPath, JSON.stringify(profitLedger, null, 2)); };

const tradeIdOf = (trade) => String(trade.id || trade.info?.id || `${trade.timestamp}-${trade.order}-${trade.side}-${trade.amount}-${trade.price}`);
const numberFromTrade = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const getRealizedPnl = (trade) => numberFromTrade(trade.info?.realizedPnl || trade.info?.realizedProfit || trade.realizedPnl);
const getTradeFee = (trade) => { const fee = numberFromTrade(trade.fee?.cost); return fee > 0 ? fee : Math.abs(numberFromTrade(trade.info?.commission)); };

const applyTradeToProfitLedger = (trade) => {
  const id = tradeIdOf(trade);
  if (profitLedger.processedTradeIds.includes(id)) return false;
  const realizedPnl = getRealizedPnl(trade);
  const fee = getTradeFee(trade);
  const netProfit = realizedPnl - fee;
  profitLedger.processedTradeIds.push(id);
  profitLedger.processedTradeIds = profitLedger.processedTradeIds.slice(-1000);
  profitLedger.lastTradeTimestamp = Math.max(Number(profitLedger.lastTradeTimestamp || 0), Number(trade.timestamp || 0));
  profitLedger.totals.grossRealizedPnl += realizedPnl;
  profitLedger.totals.fees += fee;
  profitLedger.totals.netProfit += netProfit;
  profitLedger.totals.tradeCount++;
  if (netProfit > 0) profitLedger.totals.profitEvents++;
  if (netProfit < 0) profitLedger.totals.lossEvents++;
  profitLedger.recentTrades.unshift({
    id, symbol: trade.symbol, time: trade.datetime || new Date(trade.timestamp || Date.now()).toISOString(),
    side: trade.side, price: numberFromTrade(trade.price), amount: numberFromTrade(trade.amount),
    realizedPnl, fee, netProfit, order: trade.order || trade.info?.orderId,
  });
  profitLedger.recentTrades = profitLedger.recentTrades.slice(0, 30);
  return true;
};

const syncTradesForSymbols = async ({ since, onTrade }) => {
  let newTrades = 0;
  for (const symbol of config.scanSymbols) {
    try {
      const trades = await retry(() => exchange.fetchMyTrades(symbol, since, config.profitSyncLimit));
      const sorted = trades.filter(t => !t.symbol || t.symbol === symbol).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      for (const trade of sorted) if (await onTrade(trade)) newTrades++;
    } catch (err) {
      console.warn(`${symbol} trade sync skipped: ${err.message}`);
    }
  }
  return newTrades;
};

const syncProfitLedger = async () => {
  if (!config.profitTrackerEnabled) return;
  try {
    const since = profitLedger.lastTradeTimestamp ? profitLedger.lastTradeTimestamp - 1 : undefined;
    const newTrades = await syncTradesForSymbols({ since, onTrade: applyTradeToProfitLedger });
    if (newTrades > 0) saveProfitLedger();
    const totals = profitLedger.totals;
    console.log(`\n[PROFIT] Summary\nNew trades: ${newTrades}\nGross PnL: ${totals.grossRealizedPnl.toFixed(6)} USDT\nFees: ${totals.fees.toFixed(6)} USDT\nNet Profit: ${totals.netProfit.toFixed(6)} USDT\nWin/Loss: ${totals.profitEvents}/${totals.lossEvents}\n`);
  } catch (err) {
    console.warn("[WARN] Profit sync skipped:", err.message);
  }
};

// ======================================================
// RISK STATE
// ======================================================
let riskState;

const getUtcDayKey = (timestamp = Date.now()) => new Date(timestamp).toISOString().slice(0, 10);
const createEmptyRiskState = () => ({ dayKey: null, dayStartEquity: 0, dailyNetPnL: 0, consecutiveLosses: 0, processedTradeIds: [], symbolCooldowns: {}, scanRotationIndex: 0, lastSyncedAt: 0, updatedAt: new Date().toISOString() });
const normalizeRiskState = (state) => ({ ...createEmptyRiskState(), ...state, processedTradeIds: Array.isArray(state?.processedTradeIds) ? state.processedTradeIds : [], symbolCooldowns: state?.symbolCooldowns && typeof state.symbolCooldowns === "object" ? state.symbolCooldowns : {}, scanRotationIndex: Number.isFinite(Number(state?.scanRotationIndex)) ? Math.max(0, Number(state.scanRotationIndex)) : 0 });
const loadRiskState = () => normalizeRiskState(loadJsonFile(config.riskStatePath, createEmptyRiskState));
const saveRiskState = () => { riskState.updatedAt = new Date().toISOString(); fs.writeFileSync(config.riskStatePath, JSON.stringify(riskState, null, 2)); };

const setSymbolCooldown = (symbol, minutes, reason) => {
  if (!config.symbolCooldownEnabled || minutes <= 0 || !symbol) return;
  riskState.symbolCooldowns[symbol] = { until: Date.now() + minutes * 60 * 1000, reason, updatedAt: new Date().toISOString() };
  console.warn(`[COOLDOWN] ${symbol} paused for ${minutes}m: ${reason}`);
};

const cleanupSymbolCooldowns = () => {
  let changed = false;
  const now = Date.now();
  for (const [symbol, cooldown] of Object.entries(riskState.symbolCooldowns || {})) {
    if (!cooldown?.until || Number(cooldown.until) <= now) {
      delete riskState.symbolCooldowns[symbol];
      changed = true;
    }
  }
  return changed;
};

const symbolCooldownAllowsTrading = (symbol) => {
  if (!config.symbolCooldownEnabled) return true;
  const cooldown = riskState.symbolCooldowns?.[symbol];
  if (!cooldown) return true;
  if (Number(cooldown.until) <= Date.now()) {
    delete riskState.symbolCooldowns[symbol];
    saveRiskState();
    return true;
  }
  console.log(`[COOLDOWN] ${symbol} skipped: ${cooldown.reason}`);
  return false;
};

const getRotatedScanSymbols = () => {
  if (!config.scanSymbols.length) return [];
  const total = config.scanSymbols.length;
  const batchSize = Math.min(config.scanRotationBatchSize, total);
  const start = riskState.scanRotationIndex % total;
  const rotated = [];
  for (let i = 0; i < batchSize; i++) rotated.push(config.scanSymbols[(start + i) % total]);
  riskState.scanRotationIndex = (start + batchSize) % total;
  return rotated;
};

const getAccountEquity = async () => {
  const balance = await retry(() => exchange.fetchBalance());
  return Number(balance?.USDT?.total || balance?.USDT?.free || 0);
};

const isRealizedTrade = (trade) => Math.abs(getRealizedPnl(trade)) > 0.0000001;

const applyTradeToRiskState = async (trade) => {
  const id = tradeIdOf(trade);
  if (riskState.processedTradeIds.includes(id)) return false;
  const realizedPnl = getRealizedPnl(trade);
  const fee = getTradeFee(trade);
  const netProfit = realizedPnl - fee;
  riskState.processedTradeIds.push(id);
  riskState.processedTradeIds = riskState.processedTradeIds.slice(-1000);
  riskState.lastSyncedAt = Math.max(Number(riskState.lastSyncedAt || 0), Number(trade.timestamp || 0));
  riskState.dailyNetPnL += netProfit;
  if (isRealizedTrade(trade)) {
    if (netProfit < 0) {
      riskState.consecutiveLosses += 1;
      setSymbolCooldown(trade.symbol, config.symbolCooldownMinutes, `realized loss ${netProfit.toFixed(6)} USDT`);
    } else if (netProfit > 0) {
      riskState.consecutiveLosses = 0;
    }
    await sendFonnteAlert(formatTradeCloseAlert(trade, realizedPnl, fee, netProfit));
  }
  return true;
};

const getDailyLossLimit = () => {
  if (riskState.dayStartEquity <= 0) return config.maxDailyLossUsdt > 0 ? config.maxDailyLossUsdt : Infinity;
  const percentLimit = riskState.dayStartEquity * config.maxDailyLossPct;
  return config.maxDailyLossUsdt > 0 ? Math.min(percentLimit, config.maxDailyLossUsdt) : percentLimit;
};

const resetDailyRiskState = (dayKey, equity) => { riskState = { ...createEmptyRiskState(), dayKey, dayStartEquity: equity }; saveRiskState(); };
const ensureDailyRiskState = (dayKey, equity) => {
  if (riskState.dayKey !== dayKey) resetDailyRiskState(dayKey, equity);
  else if (!riskState.dayStartEquity && equity > 0) { riskState.dayStartEquity = equity; saveRiskState(); }
};

const syncRiskState = async () => {
  try {
    const equity = await getAccountEquity();
    const dayKey = getUtcDayKey();
    ensureDailyRiskState(dayKey, equity);
    const dayStart = new Date(`${dayKey}T00:00:00.000Z`).getTime();
    const since = Math.max(dayStart, riskState.lastSyncedAt > 0 ? riskState.lastSyncedAt - 1 : dayStart);
    const newTrades = await syncTradesForSymbols({ since, onTrade: applyTradeToRiskState });
    if (newTrades > 0) saveRiskState();
    console.log(`\n[RISK] Summary\nDay equity start: ${riskState.dayStartEquity.toFixed(2)} USDT\nDaily net PnL: ${riskState.dailyNetPnL.toFixed(2)} USDT\nConsecutive losses: ${riskState.consecutiveLosses}\n`);
  } catch (err) {
    console.warn("[WARN] Risk sync skipped:", err.message);
  }
};

const riskGateAllowsTrading = () => {
  if (cleanupSymbolCooldowns()) saveRiskState();
  const dailyLossLimit = getDailyLossLimit();
  if (dailyLossLimit > 0 && riskState.dailyNetPnL <= -dailyLossLimit) {
    console.warn(`[BLOCK] Daily loss limit reached: ${riskState.dailyNetPnL.toFixed(2)} / -${dailyLossLimit.toFixed(2)} USDT`);
    return false;
  }
  if (config.maxConsecutiveLosses > 0 && riskState.consecutiveLosses >= config.maxConsecutiveLosses) {
    console.warn(`[BLOCK] Consecutive loss limit reached: ${riskState.consecutiveLosses}/${config.maxConsecutiveLosses}`);
    return false;
  }
  return true;
};

// ======================================================
// CIRCUIT BREAKER
// ======================================================
const circuitBreakerAllowsTrading = () => {
  if (!config.circuitBreakerEnabled) return true;
  const remaining = circuitBreakerState.pausedUntil - Date.now();
  if (remaining <= 0) return true;
  console.warn(`[CIRCUIT] Trading paused for ${Math.ceil(remaining / 60000)}m after ${circuitBreakerState.consecutiveErrors} errors. Last: ${circuitBreakerState.lastError}`);
  return false;
};

const recordCircuitBreakerSuccess = () => {
  if (!config.circuitBreakerEnabled) return;
  if (circuitBreakerState.consecutiveErrors > 0) console.log("[CIRCUIT] Error streak cleared");
  circuitBreakerState.consecutiveErrors = 0;
  circuitBreakerState.lastError = null;
};

const recordCircuitBreakerError = (source, err) => {
  if (!config.circuitBreakerEnabled) return;
  circuitBreakerState.consecutiveErrors += 1;
  circuitBreakerState.lastError = `${source}: ${err?.message || err}`;
  console.warn(`[CIRCUIT] Error ${circuitBreakerState.consecutiveErrors}/${config.circuitBreakerMaxErrors} from ${source}: ${err?.message || err}`);
  if (circuitBreakerState.consecutiveErrors >= config.circuitBreakerMaxErrors) {
    circuitBreakerState.pausedUntil = Date.now() + config.circuitBreakerPauseMinutes * 60 * 1000;
    console.warn(`[CIRCUIT] Trading paused for ${config.circuitBreakerPauseMinutes}m`);
  }
};

// ======================================================
// MARKET DATA & INDICATORS
// ======================================================
const parseTimeframeToMs = (timeframe) => {
  const match = String(timeframe || "").toLowerCase().match(/^(\d+)(m|h|d|w)$/);
  if (!match) return config.intervalMs;
  const value = Number(match[1]);
  const unit = match[2];
  const unitMs = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 }[unit];
  return value * unitMs;
};

const calculateEMA = (data, period) => {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
};

const calculateRSI = (closes, period = 14) => {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
};

const calculateATR = (ohlcv) => {
  const trs = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const prevClose = ohlcv[i - 1][4];
    const high = ohlcv[i][2];
    const low = ohlcv[i][3];
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
};

const getMarketContext = async (symbol) => {
  const [ticker, funding] = await Promise.all([retry(() => exchange.fetchTicker(symbol)), retry(() => exchange.fetchFundingRate(symbol))]);
  return { price: Number(ticker.last), fundingRate: Number(funding.fundingRate || 0) };
};

const getMarketSnapshot = async (symbol, context, timeframe = config.timeframe) => {
  const cacheKey = `${symbol}|${timeframe}|${config.lookbackCandles}`;
  if (config.marketSnapshotCacheEnabled) {
    const cached = marketSnapshotCache.get(cacheKey);
    if (isCacheValid(cached)) return { price: context.price, fundingRate: context.fundingRate, ...cached.snapshot };
  }
  const ohlcv = await retry(() => exchange.fetchOHLCV(symbol, timeframe, undefined, config.lookbackCandles));
  const closes = ohlcv.map(c => c[4]);
  const latestCandle = ohlcv[ohlcv.length - 1] || [];
  const candleTimestamp = Number(latestCandle[0] || 0);
  const timeframeMs = parseTimeframeToMs(timeframe);
  const expiresAt = candleTimestamp > 0 ? candleTimestamp + timeframeMs : Date.now() + timeframeMs;
  const ema20 = calculateEMA(closes.slice(-20), 20);
  const ema50 = calculateEMA(closes.slice(-50), 50);
  const prevEma20 = calculateEMA(closes.slice(-21, -1), 20);
  const prevEma50 = calculateEMA(closes.slice(-51, -1), 50);
  const snapshotBase = {
    candleTimestamp, expiresAt,
    ema20, ema50,
    ema20Slope: ema20 - prevEma20,
    ema50Slope: ema50 - prevEma50,
    emaGap: (Math.abs(ema20 - ema50) / context.price) * 100,
    rsi: calculateRSI(closes.slice(-15)),
    atr: calculateATR(ohlcv.slice(-15)),
    volumeChange: (ohlcv[ohlcv.length - 1][5] / (ohlcv[ohlcv.length - 2]?.[5] || 1) - 1) * 100,
    trend: ema20 > ema50 ? "UPTREND" : ema20 < ema50 ? "DOWNTREND" : "SIDEWAYS",
  };
  const snapshot = { price: context.price, fundingRate: context.fundingRate, ...snapshotBase };
  if (config.marketSnapshotCacheEnabled) {
    marketSnapshotCache.set(cacheKey, { snapshot: snapshotBase, expiresAt });
    cleanupCaches();
  }
  return snapshot;
};

// ======================================================
// MARKET REGIME
// ======================================================
const detectMarketRegime = (snapshot, htfSnapshot) => {
  const atrPct = snapshot.price > 0 ? snapshot.atr / snapshot.price : 0;
  const bullishAlignment = snapshot.trend === "UPTREND" && htfSnapshot.trend === "UPTREND" && snapshot.ema20Slope > 0 && htfSnapshot.ema20Slope > 0 && snapshot.volumeChange >= config.minVolumeChangeForTrend;
  const bearishAlignment = snapshot.trend === "DOWNTREND" && htfSnapshot.trend === "DOWNTREND" && snapshot.ema20Slope < 0 && htfSnapshot.ema20Slope < 0 && snapshot.volumeChange >= config.minVolumeChangeForTrend;
  const sideways = snapshot.emaGap < config.sidewaysEmaGap || (Math.abs(snapshot.ema20Slope) < snapshot.atr * 0.02 && Math.abs(snapshot.ema50Slope) < snapshot.atr * 0.02 && Math.abs(htfSnapshot.ema20Slope) < htfSnapshot.atr * 0.02) || (snapshot.rsi >= 45 && snapshot.rsi <= 55 && atrPct < config.minAtrPct);
  const volatile = atrPct >= config.maxAtrPct;
  if (sideways) return { regime: "CHOPPY", allow: false, reason: "Ranging or too weak", atrPct };
  if (volatile && !bullishAlignment && !bearishAlignment) return { regime: "HIGH_VOLATILITY", allow: false, reason: "Elevated ATR without clean direction", atrPct };
  if (bullishAlignment) return { regime: "TRENDING_UP", allow: true, reason: "Bullish alignment", atrPct };
  if (bearishAlignment) return { regime: "TRENDING_DOWN", allow: true, reason: "Bearish alignment", atrPct };
  return { regime: volatile ? "VOLATILE_MIXED" : "MIXED", allow: false, reason: "Unclean trend structure", atrPct };
};

const regimeFilterSafe = (regimeInfo) => {
  if (!config.regimeFilterEnabled) return true;
  if (!regimeInfo.allow) { console.warn(`[WARN] Regime blocked: ${regimeInfo.regime}`); return false; }
  if (config.allowedMarketRegimes.length && !config.allowedMarketRegimes.includes(regimeInfo.regime)) { console.warn(`[WARN] Regime not allowed: ${regimeInfo.regime}`); return false; }
  return true;
};

// ======================================================
// AI SIGNAL
// ======================================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: config.geminiModel });

const createHoldAISignal = (reason) => ({ signal: "HOLD", strength: "WEAK", confidence: 0, tradeAllowed: false, reason });

const extractJsonObject = (text) => {
  const cleaned = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("AI response does not contain a JSON object");
  return cleaned.slice(start, end + 1);
};

const normalizeAIStrength = (value) => {
  const strength = String(value || "WEAK").toUpperCase();
  const aliases = { LOW: "WEAK", MILD: "WEAK", MODERATE: "MEDIUM", HIGH: "STRONG", VERY_HIGH: "EXTREME", VERYHIGH: "EXTREME" };
  return aliases[strength] || strength;
};

const normalizeAISignal = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("AI response is not an object");
  const signal = String(raw.signal || "").toUpperCase();
  const strength = normalizeAIStrength(raw.strength);
  const confidence = Number(raw.confidence);
  const tradeAllowed = typeof raw.tradeAllowed === "boolean" ? raw.tradeAllowed : signal !== "HOLD";
  const reason = String(raw.reason || "").trim().slice(0, 500);
  if (!["LONG", "SHORT", "HOLD"].includes(signal)) throw new Error(`Invalid AI signal: ${raw.signal}`);
  if (!["WEAK", "MEDIUM", "STRONG", "EXTREME"].includes(strength)) throw new Error(`Invalid AI strength: ${raw.strength}`);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error(`Invalid AI confidence: ${raw.confidence}`);
  return { signal, strength, confidence, tradeAllowed, reason };
};

const parseAISignal = (text) => normalizeAISignal(JSON.parse(extractJsonObject(text)));

const buildAISignalPrompt = ({ symbol, snapshot, htfSnapshot, regimeInfo }) => {
  const allowedSignals = config.longOnly ? "LONG, HOLD" : "LONG, SHORT, HOLD";
  const allowedDirection = config.longOnly ? "LONG" : "LONG or SHORT";
  return `You are a professional crypto futures trader AI.

Your job is to determine: LONG, SHORT, or HOLD.

RULES:
- Prioritize HOLD during sideways markets.
- Do NOT reverse positions too easily.
- Avoid fake breakouts and overtrading.
- Use higher timeframe as main trend filter.
- Only give ${allowedDirection} if probability is high.
- Allowed output signals: ${allowedSignals}
- Allowed strengths: WEAK, MEDIUM, STRONG, EXTREME (use WEAK instead of LOW).
- Market regime: ${regimeInfo.regime} - ${regimeInfo.reason}

MARKET DATA:
Symbol: ${symbol}
Price: ${snapshot.price}
Low TF Trend: ${snapshot.trend}
High TF Trend: ${htfSnapshot.trend}
EMA20: ${snapshot.ema20}
EMA50: ${snapshot.ema50}
EMA20 Slope: ${snapshot.ema20Slope}
EMA50 Slope: ${snapshot.ema50Slope}
EMA Gap: ${snapshot.emaGap}
RSI: ${snapshot.rsi}
ATR: ${snapshot.atr}
Volume Change: ${snapshot.volumeChange}
Funding Rate: ${snapshot.fundingRate}

RETURN JSON ONLY:
{
  "signal": "LONG",
  "strength": "MEDIUM",
  "confidence": 75,
  "tradeAllowed": true,
  "reason": "Strong bullish trend confirmation."
}`;
};

const getAISignal = async (symbol, snapshot, htfSnapshot, regimeInfo) => {
  const promptKey = crypto.createHash("sha256").update(JSON.stringify({ symbol, longOnly: config.longOnly, snapshot, htfSnapshot, regimeInfo })).digest("hex");
  if (config.aiSignalCacheEnabled) {
    const cached = aiSignalCache.get(promptKey);
    if (isCacheValid(cached)) { console.log(`[CACHE] AI hit ${symbol}`); return cached.signal; }
  }
  const prompt = buildAISignalPrompt({ symbol, snapshot, htfSnapshot, regimeInfo });
  let lastError = null;
  for (let attempt = 1; attempt <= config.aiResponseRetries + 1; attempt++) {
    try {
      const result = await aiModel.generateContent(prompt);
      const signal = parseAISignal(result.response.text());
      const expiresAt = Math.min(Number(snapshot?.expiresAt || Date.now()), Number(htfSnapshot?.expiresAt || Date.now()));
      if (config.aiSignalCacheEnabled) { aiSignalCache.set(promptKey, { signal, expiresAt }); cleanupCaches(); }
      return signal;
    } catch (err) {
      lastError = err;
      console.warn(`[WARN] AI response invalid for ${symbol} (${attempt}/${config.aiResponseRetries + 1}): ${err.message}`);
      if (attempt <= config.aiResponseRetries) await sleep(1000 * attempt);
    }
  }
  recordCircuitBreakerError(`AI response for ${symbol}`, lastError || new Error("unknown AI response error"));
  return createHoldAISignal(`AI fallback: ${lastError?.message || "unknown error"}`);
};

const aiFilterSafe = (ai) => {
  if (!config.aiFilterEnabled) return true;
  const strength = String(ai.strength || "").toUpperCase();
  const confidence = Number(ai.confidence || 0);
  if (ai.tradeAllowed === false) { console.warn("[WARN] AI filter: tradeAllowed=false"); return false; }
  if (!config.allowedAiStrengths.includes(strength)) { console.warn(`[WARN] AI filter: strength ${strength}`); return false; }
  if (confidence < config.minAiConfidence) { console.warn(`[WARN] AI filter: confidence ${confidence}/${config.minAiConfidence}`); return false; }
  return true;
};

// ======================================================
// POSITION MANAGEMENT
// ======================================================
const getCurrentPosition = async (symbol) => {
  const positions = await retry(() => exchange.fetchPositions([symbol]));
  const pos = positions.find(p => p.symbol === symbol && Number(p.contracts) > 0);
  if (!pos) return null;
  return { side: pos.side, symbol: pos.symbol, contracts: Number(pos.contracts), entryPrice: Number(pos.entryPrice) };
};

const getOpenPositions = async () => {
  const open = [];
  for (const symbol of config.scanSymbols) {
    try {
      const pos = await getCurrentPosition(symbol);
      if (pos) open.push(pos);
    } catch (err) { console.warn(`${symbol} position check: ${err.message}`); }
  }
  return open;
};

const getAvailableBalance = async () => {
  const balance = await retry(() => exchange.fetchBalance());
  return Number(balance?.USDT?.free || 0);
};

const calculateContracts = async (symbol, price) => {
  const market = exchange.markets[symbol];
  const targetNotional = config.orderSizeUsdt * config.leverage;
  const maxNotional = Math.min(targetNotional, config.maxPositionNotionalUsdt);
  const minCost = market?.limits?.cost?.min || 5;
  const minAmount = market?.limits?.amount?.min || 0;
  const finalNotional = Math.max(minCost, maxNotional);
  const finalContracts = Math.max(finalNotional / price, minAmount);
  return Number(exchange.amountToPrecision(symbol, finalContracts));
};

const calculateRequiredMargin = (amount, price) => (amount * price) / config.leverage;

const calculateRR = (signal, entry, tp, sl) => signal === "LONG" ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);

const calculateDynamicTPSL = (signal, entry, atr, strength = "WEAK") => {
  const tpMultipliers = { STRONG: 2.5, EXTREME: 3 };
  const slMultipliers = { MEDIUM: 1.8, STRONG: 2.2, EXTREME: 2.5 };
  const normStrength = String(strength).toUpperCase();
  const tpMulti = tpMultipliers[normStrength] || config.atrTpMultiplier;
  const slMulti = slMultipliers[normStrength] || 1.5;
  const direction = signal === "LONG" ? 1 : -1;
  return { tp: entry + direction * atr * tpMulti, sl: entry - direction * atr * slMulti };
};

const calculateCallbackRate = (atr, price) => clamp((atr / price) * 100, config.trailingCallbackMin, config.trailingCallbackMax);

const fundingSafe = (signal, fundingRate) => !((signal === "LONG" && fundingRate > config.maxFundingRate) || (signal === "SHORT" && fundingRate < -config.maxFundingRate));

const cancelAllOrders = async (symbol) => {
  try {
    const orders = await retry(() => exchange.fetchOpenOrders(symbol));
    for (const o of orders) await retry(() => exchange.cancelOrder(o.id, symbol)).catch(console.error);
  } catch (err) { console.error(err.message); }
};

const openPosition = async (symbol, signal, context) => {
  await retry(() => exchange.setLeverage(config.leverage, symbol));
  const side = signal === "LONG" ? "buy" : "sell";
  const amount = await calculateContracts(symbol, context.price);
  const requiredMargin = calculateRequiredMargin(amount, context.price);
  const balance = await getAvailableBalance();
  if (balance < requiredMargin) {
    console.warn(`[BLOCK] Balance insufficient: free ${balance.toFixed(4)} USDT, required ${requiredMargin.toFixed(4)} USDT`);
    return null;
  }
  console.log(`\n[OPEN] ${signal}\nContracts: ${amount}\nNotional: ${(amount * context.price).toFixed(4)} USDT\nMargin: ${requiredMargin.toFixed(4)} USDT`);
  const order = await retry(() => exchange.createMarketOrder(symbol, side, amount));
  console.log(`[OK] Order: ${order.id}`);
  lastPositionChangeTime = Date.now();
  await sleep(3000);
  return getCurrentPosition(symbol);
};

const closePosition = async (symbol, position) => {
  const side = position.side === "long" ? "sell" : "buy";
  await retry(() => exchange.createMarketOrder(symbol, side, position.contracts, { reduceOnly: true }));
  await cancelAllOrders(symbol);
  console.log("[CLOSE] Position closed");
};

const createStopLossOrder = async (symbol, position, slPrice) => {
  const side = position.side === "long" ? "sell" : "buy";
  const stopPrice = exchange.priceToPrecision(symbol, slPrice);
  console.log(`\n[SL] Stop loss market\nSide: ${side}\nTrigger: ${stopPrice}`);
  await retry(() => exchange.createOrder(symbol, "STOP_MARKET", side, undefined, undefined, { stopPrice: stopPrice, closePosition: true, workingType: "MARK_PRICE" }));
  console.log("[OK] Stop loss active");
};

const createPartialTPs = async (symbol, position, entryPrice, atr) => {
  const side = position.side === "long" ? "sell" : "buy";
  const isLong = position.side === "long";
  const total = position.contracts;
  const tp1Qty = Number(exchange.amountToPrecision(symbol, total * (config.tp1Percent / 100)));
  const tp2Qty = Number(exchange.amountToPrecision(symbol, total * (config.tp2Percent / 100)));
  const runnerQty = Number(exchange.amountToPrecision(symbol, total - tp1Qty - tp2Qty));
  const tp1Price = Number(exchange.priceToPrecision(symbol, entryPrice + (isLong ? atr * config.tp1Rr : -atr * config.tp1Rr)));
  const tp2Price = Number(exchange.priceToPrecision(symbol, entryPrice + (isLong ? atr * config.tp2Rr : -atr * config.tp2Rr)));
  console.log(`\n[TP] TP1: ${tp1Price}\n[TP] TP2: ${tp2Price}`);
  if (tp1Qty > 0) await retry(() => exchange.createOrder(symbol, "TAKE_PROFIT_MARKET", side, tp1Qty, undefined, { stopPrice: tp1Price, reduceOnly: true, workingType: "MARK_PRICE" })).then(() => console.log(`[OK] TP1: ${tp1Qty}`));
  if (tp2Qty > 0) await retry(() => exchange.createOrder(symbol, "TAKE_PROFIT_MARKET", side, tp2Qty, undefined, { stopPrice: tp2Price, reduceOnly: true, workingType: "MARK_PRICE" })).then(() => console.log(`[OK] TP2: ${tp2Qty}`));
  if (runnerQty > 0) {
    const callbackRate = calculateCallbackRate(atr, entryPrice);
    await retry(() => exchange.createOrder(symbol, "TRAILING_STOP_MARKET", side, runnerQty, undefined, { callbackRate, reduceOnly: true, workingType: "MARK_PRICE" }));
    console.log(`\n[TRAILING] Runner: ${runnerQty} qty, callback ${callbackRate}%`);
  }
};

// ======================================================
// SIGNAL CONFIRMATION & SCORING
// ======================================================
const updateSignalConfirmation = (symbol, signal, strength) => {
  const state = signalStateBySymbol[symbol] || { lastSignal: null, confirmCount: 0 };
  if (state.lastSignal === signal) state.confirmCount += 1;
  else { state.lastSignal = signal; state.confirmCount = 1; }
  signalStateBySymbol[symbol] = state;
  const confirmed = state.confirmCount >= config.effectiveRequiredConfirmations || strength === "STRONG" || strength === "EXTREME";
  return { count: state.confirmCount, confirmed };
};

const scoreCandidate = (ai, rr, regimeInfo) => {
  const strengthBonus = { MEDIUM: 5, STRONG: 15, EXTREME: 25 }[String(ai.strength).toUpperCase()] || 0;
  return (ai.confidence || 0) + strengthBonus + Math.min(rr, 3) * 10 + (regimeInfo.allow ? 10 : 0);
};

// ======================================================
// AI EXPLAIN LOG
// ======================================================
const snapshotForExplainLog = (snapshot) => snapshot ? {
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
} : null;

const pruneAIExplainLog = () => {
  if (!config.aiExplainLogMaxLines || config.aiExplainLogMaxLines <= 0) return;
  if (!fs.existsSync(config.aiExplainLogPath)) return;
  const lines = fs.readFileSync(config.aiExplainLogPath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length > config.aiExplainLogMaxLines) fs.writeFileSync(config.aiExplainLogPath, `${lines.slice(-config.aiExplainLogMaxLines).join("\n")}\n`);
};

const logAIExplainDecision = (event) => {
  if (!config.aiExplainLogEnabled) return;
  try {
    const entry = { timestamp: new Date().toISOString(), bot: "smart-binance-ai-futures-bot", timeframe: config.timeframe, htfTimeframe: config.htfTimeframe, longOnly: config.longOnly, minAiConfidence: config.minAiConfidence, allowedAiStrengths: config.allowedAiStrengths, minRR: config.minRr, ...event, snapshot: snapshotForExplainLog(event.snapshot), htfSnapshot: snapshotForExplainLog(event.htfSnapshot) };
    fs.appendFileSync(config.aiExplainLogPath, `${JSON.stringify(entry)}\n`);
    pruneAIExplainLog();
  } catch (err) { console.warn(`[WARN] AI explain log error: ${err.message}`); }
};

// ======================================================
// TRADING CYCLE - SYMBOL ANALYSIS
// ======================================================
const analyzeSymbol = async (symbol) => {
  try {
    console.log(`\n========== SCAN ${symbol} ==========`);
    if (!symbolCooldownAllowsTrading(symbol)) return null;
    const context = await getMarketContext(symbol);
    const snapshot = await getMarketSnapshot(symbol, context, config.timeframe);
    const htfSnapshot = await getMarketSnapshot(symbol, context, config.htfTimeframe);
    const regimeInfo = detectMarketRegime(snapshot, htfSnapshot);
    const logReject = (stage, reason, extra = {}) => logAIExplainDecision({ symbol, snapshot, htfSnapshot, regimeInfo, outcome: "REJECTED_BEFORE_AI", stage, rejectReason: reason, ...extra });
    if (snapshot.emaGap < config.sidewaysEmaGap) { logReject("sideways_filter", "EMA gap below threshold"); return null; }
    if (!regimeFilterSafe(regimeInfo)) { logReject("regime_filter", regimeInfo.reason); return null; }
    console.log(`Asking Gemini for ${symbol}...`);
    const ai = await getAISignal(symbol, snapshot, htfSnapshot, regimeInfo);
    console.log(ai);
    const signal = ai.signal?.toUpperCase();
    const aiStrength = String(ai.strength).toUpperCase();
    if (!["LONG", "SHORT", "HOLD"].includes(signal)) { logAIExplainDecision({ symbol, snapshot, htfSnapshot, regimeInfo, outcome: "REJECTED_AFTER_AI", stage: "ai_signal_validation", ai, rejectReason: "Invalid AI signal" }); return null; }
    if (signal === "HOLD") { logAIExplainDecision({ symbol, snapshot, htfSnapshot, regimeInfo, outcome: "REJECTED_AFTER_AI", stage: "ai_hold", ai, rejectReason: ai.reason }); return null; }
    if (config.longOnly && signal === "SHORT") { logAIExplainDecision({ symbol, snapshot, htfSnapshot, regimeInfo, outcome: "REJECTED_AFTER_AI", stage: "long_only_filter", ai, rejectReason: "SHORT ignored in LONG_ONLY mode" }); return null; }
    if (!aiFilterSafe(ai)) { logAIExplainDecision({ symbol, snapshot, htfSnapshot, regimeInfo, outcome: "REJECTED_AFTER_AI", stage: "ai_filter", ai, rejectReason: "AI confidence/strength/tradeAllowed failed" }); return null; }
    const confirmation = updateSignalConfirmation(symbol, signal, aiStrength);
    console.log(`\nSIGNAL CONFIRM ${symbol}: ${confirmation.count}/${config.effectiveRequiredConfirmations}`);
    if (!confirmation.confirmed) { logAIExplainDecision({ symbol, snapshot, htfSnapshot, regimeInfo, outcome: "REJECTED_AFTER_AI", stage: "signal_confirmation", ai, confirmation, rejectReason: "Not enough confirmations" }); return null; }
    if (!fundingSafe(signal, context.fundingRate)) { logAIExplainDecision({ symbol, snapshot, htfSnapshot, regimeInfo, outcome: "REJECTED_AFTER_AI", stage: "funding_filter", ai, confirmation, rejectReason: "Funding rate unsafe" }); return null; }
    const dynamicTPSL = calculateDynamicTPSL(signal, context.price, snapshot.atr, aiStrength);
    const rr = calculateRR(signal, context.price, dynamicTPSL.tp, dynamicTPSL.sl);
    console.log(`${symbol} RR: ${rr.toFixed(2)}`);
    if (rr < config.minRr) { logAIExplainDecision({ symbol, snapshot, htfSnapshot, regimeInfo, outcome: "REJECTED_AFTER_AI", stage: "rr_filter", ai, confirmation, rr: roundNumber(rr, 4), rejectReason: `RR ${rr.toFixed(2)} < ${config.minRr}` }); return null; }
    const score = scoreCandidate(ai, rr, regimeInfo);
    logAIExplainDecision({ symbol, snapshot, htfSnapshot, regimeInfo, outcome: "CANDIDATE_ACCEPTED", stage: "candidate_score", ai, confirmation, rr: roundNumber(rr, 4), score: roundNumber(score, 2) });
    return { symbol, signal, ai, aiStrength, context, snapshot, htfSnapshot, regimeInfo, rr, score };
  } catch (err) {
    console.warn(`${symbol} scan error: ${err.message}`);
    recordCircuitBreakerError(`scan ${symbol}`, err);
    setSymbolCooldown(symbol, config.symbolErrorCooldownMinutes, "scan error");
    saveRiskState();
    return null;
  }
};

// ======================================================
// TRADING CYCLE - MAIN
// ======================================================
const tradingCycle = async () => {
  if (isTrading) { console.log("[WAIT] Previous cycle running"); return; }
  isTrading = true;
  const errorsAtStart = circuitBreakerState.consecutiveErrors;
  let circuitAllowed = false;
  try {
    console.log(`\n========== ${new Date().toISOString()} ==========`);
    if (!circuitBreakerAllowsTrading()) return;
    circuitAllowed = true;
    cleanupCaches();
    await syncProfitLedger();
    await syncRiskState();
    const openPositions = await getOpenPositions();
    console.log("OPEN POSITIONS:", openPositions.length ? openPositions : "NONE");
    if (killSwitchActive() || !riskGateAllowsTrading()) return;
    const symbolsToScan = getRotatedScanSymbols();
    console.log(`[SCAN] Rotating batch: ${symbolsToScan.join(", ")} (${symbolsToScan.length}/${config.scanSymbols.length})`);
    saveRiskState();
    const candidates = [];
    for (const symbol of symbolsToScan) {
      const candidate = await analyzeSymbol(symbol);
      if (candidate) candidates.push(candidate);
    }
    if (candidates.length === 0) { console.log("No candidates passed."); return; }
    candidates.sort((a, b) => b.score - a.score);
    console.table(candidates.map(c => ({ symbol: c.symbol, signal: c.signal, confidence: c.ai.confidence, strength: c.aiStrength, rr: Number(c.rr.toFixed(2)), regime: c.regimeInfo.regime, score: Number(c.score.toFixed(2)) })));
    const best = candidates[0];
    const { symbol, signal, context, snapshot } = best;
    logAIExplainDecision({ symbol, ai: best.ai, snapshot: best.snapshot, htfSnapshot: best.htfSnapshot, regimeInfo: best.regimeInfo, rr: roundNumber(best.rr, 4), score: roundNumber(best.score, 2), outcome: "BEST_CANDIDATE_SELECTED", stage: "candidate_ranking" });
    const position = openPositions.find(p => p.symbol === symbol);
    if (position && position.side === signal.toLowerCase()) { console.log(`${symbol} position already exists`); return; }
    if (!position && openPositions.length >= config.maxOpenPositions) { console.log(`Max positions: ${openPositions.length}/${config.maxOpenPositions}`); return; }
    const cooldownMs = config.reversalCooldownMinutes * 60 * 1000;
    if (position && Date.now() - lastPositionChangeTime < cooldownMs) { console.log(`${symbol} reversal cooldown active`); return; }
    if (position) await closePosition(symbol, position);
    await cancelAllOrders(symbol);
    const newPos = await openPosition(symbol, signal, context);
    if (!newPos) { logAIExplainDecision({ symbol, outcome: "NOT_EXECUTED", stage: "open_position", rejectReason: "Position not opened" }); return; }
    const actualEntry = newPos.entryPrice;
    const slPrice = signal === "LONG" ? actualEntry - snapshot.atr : actualEntry + snapshot.atr;
    const openTPSL = calculateDynamicTPSL(signal, actualEntry, snapshot.atr, best.aiStrength);
    await createStopLossOrder(symbol, newPos, slPrice);
    await createPartialTPs(symbol, newPos, actualEntry, snapshot.atr);
    await sendFonnteAlert(formatTradeOpenAlert({ symbol, signal, entryPrice: actualEntry, contracts: newPos.contracts, slPrice, tpPrice: openTPSL.tp, rr: best.rr, confidence: best.ai.confidence, strength: best.aiStrength }));
    logAIExplainDecision({ symbol, outcome: "EXECUTED", stage: "order_opened", position: { side: newPos.side, contracts: roundNumber(newPos.contracts, 8), entryPrice: roundNumber(actualEntry, 10) }, sl: roundNumber(slPrice, 10) });
  } catch (err) {
    console.error("[ERROR] Trading error:", err.message);
    recordCircuitBreakerError("trading cycle", err);
  } finally {
    if (circuitAllowed && circuitBreakerState.consecutiveErrors === errorsAtStart) recordCircuitBreakerSuccess();
    isTrading = false;
  }
};

// ======================================================
// MAIN LOOP
// ======================================================
const getNextCandleDelay = () => {
  const now = Date.now();
  const next = Math.ceil(now / config.intervalMs) * config.intervalMs;
  return next - now;
};

const main = async () => {
  console.log(`
[START] Smart AI Futures Bot
SCAN SYMBOLS: ${config.scanSymbols.join(", ")}
MAX POSITIONS: ${config.maxOpenPositions}
LEVERAGE: ${config.leverage}x
ORDER SIZE: ${config.orderSizeUsdt} USDT
TIMEFRAME: ${config.timeframe} / HTF: ${config.htfTimeframe}
SCAN BATCH: ${config.scanRotationBatchSize}
MODEL: ${config.geminiModel}
KILL SWITCH: ${config.killSwitchEnabled ? `enabled (${config.killSwitchFile})` : "disabled"}
FONNTE ALERT: ${shouldSendFonnteAlerts() ? `enabled (${config.fonnteTarget})` : config.fonnteEnabled ? "partial" : "disabled"}
`);
  await retry(() => exchange.loadMarkets());
  profitLedger = loadProfitLedger();
  riskState = loadRiskState();
  await syncProfitLedger();
  while (true) {
    try {
      const delay = getNextCandleDelay();
      console.log(`\n[WAIT] Next candle in ${Math.floor(delay / 1000)}s`);
      await sleep(delay);
      await tradingCycle();
    } catch (err) {
      console.error(err);
      await sleep(5000);
    }
  }
};

main().catch(console.error);
