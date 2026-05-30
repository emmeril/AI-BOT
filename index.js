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
// Configuration Management
// ======================================================
class Config {
  static get env() {
    return {
      // Symbols and scanning
      symbols: Config._parseSymbols(),
      maxOpenPositions: Config._number("MAX_OPEN_POSITIONS", 1),
      leverage: Config._number("LEVERAGE", 10),
      orderSizeUsdt: Config._number("ORDER_SIZE_USDT", 5),
      timeframe: Config._string("TIMEFRAME", "5m"),
      htfTimeframe: Config._string("HTF_TIMEFRAME", "15m"),
      lookbackCandles: Config._number("LOOKBACK_CANDLES", 200),
      intervalMinutes: Config._number("INTERVAL_MINUTES", 5),
      scanRotationBatchSize: Math.max(1, Config._number("SCAN_ROTATION_BATCH_SIZE", 2)),
      
      // Caching
      marketSnapshotCacheEnabled: Config._bool("MARKET_SNAPSHOT_CACHE_ENABLED", true),
      aiSignalCacheEnabled: Config._bool("AI_SIGNAL_CACHE_ENABLED", true),
      cacheMaxEntries: Math.max(1, Config._number("CACHE_MAX_ENTRIES", 500)),
      
      // Emergency controls
      killSwitchEnabled: Config._bool("KILL_SWITCH_ENABLED", true),
      stopTrading: Config._true("STOP_TRADING"),
      killSwitchFile: Config._string("KILL_SWITCH_FILE", "bot-paused.flag"),
      
      // Profit tracking
      profitTrackerEnabled: Config._bool("PROFIT_TRACKER_ENABLED", true),
      profitTrackerFile: Config._string("PROFIT_TRACKER_FILE", "profit-ledger.json"),
      profitSyncLimit: Config._number("PROFIT_SYNC_LIMIT", 100),
      riskStateFile: Config._string("RISK_STATE_FILE", "risk-state.json"),
      
      // Risk parameters
      maxFundingRate: Config._number("MAX_FUNDING_RATE", 0.1) / 100,
      minRR: Config._number("MIN_RR", 1.5),
      riskPerTradePct: Config._number("RISK_PER_TRADE_PCT", 1) / 100,
      maxDailyLossPct: Config._number("MAX_DAILY_LOSS_PCT", 3) / 100,
      maxDailyLossUsdt: Config._number("MAX_DAILY_LOSS_USDT", 0),
      maxConsecutiveLosses: Config._number("MAX_CONSECUTIVE_LOSSES", 3),
      maxPositionNotionalUsdt: Config._number("MAX_POSITION_NOTIONAL_USDT", 0),
      
      // ATR and trailing
      atrTpMultiplier: Config._number("ATR_TP_MULTIPLIER", 1.8),
      trailingCallbackMin: Config._number("TRAILING_CALLBACK_MIN", 0.3),
      trailingCallbackMax: Config._number("TRAILING_CALLBACK_MAX", 1.5),
      
      // Partial TP
      tp1Percent: Config._number("TP1_PERCENT", 30),
      tp2Percent: Config._number("TP2_PERCENT", 40),
      tp1RR: Config._number("TP1_RR", 1.0),
      tp2RR: Config._number("TP2_RR", 2.0),
      
      // Filters
      requiredConfirmation: Config._number("REQUIRED_CONFIRMATION", 2),
      sidewaysEmaGap: Config._number("SIDEWAYS_EMA_GAP", 0.04),
      reversalCooldownMinutes: Config._number("REVERSAL_COOLDOWN_MINUTES", 10),
      longOnly: Config._bool("LONG_ONLY", false),
      regimeFilterEnabled: Config._bool("REGIME_FILTER_ENABLED", true),
      allowedMarketRegimes: Config._list("ALLOWED_MARKET_REGIMES", "TRENDING_UP,TRENDING_DOWN").map(r => r.toUpperCase()),
      maxAtrPct: Config._number("MAX_ATR_PCT", 2.5) / 100,
      minAtrPct: Config._number("MIN_ATR_PCT", 0.15) / 100,
      minVolumeChangeForTrend: Config._number("MIN_VOLUME_CHANGE_FOR_TREND", -30),
      symbolCooldownEnabled: Config._bool("SYMBOL_COOLDOWN_ENABLED", true),
      symbolCooldownMinutes: Config._number("SYMBOL_COOLDOWN_MINUTES", 30),
      symbolErrorCooldownMinutes: Config._number("SYMBOL_ERROR_COOLDOWN_MINUTES", 5),
      
      // AI
      geminiModel: Config._string("GEMINI_MODEL", "gemini-1.5-flash-lite"),
      geminiApiKey: process.env.GEMINI_API_KEY,
      aiFilterEnabled: Config._bool("AI_FILTER_ENABLED", true),
      minAiConfidence: Config._number("MIN_AI_CONFIDENCE", 65),
      allowedAiStrengths: Config._list("ALLOWED_AI_STRENGTHS", "MEDIUM,STRONG,EXTREME").map(s => s.toUpperCase()),
      aiResponseRetries: Config._number("AI_RESPONSE_RETRIES", 2),
      aiExplainLogEnabled: Config._bool("AI_EXPLAIN_LOG_ENABLED", false),
      aiExplainLogFile: Config._string("AI_EXPLAIN_LOG_FILE", "ai-explain-log.jsonl"),
      aiExplainLogMaxLines: Config._number("AI_EXPLAIN_LOG_MAX_LINES", 5000),
      
      // Circuit breaker
      circuitBreakerEnabled: Config._bool("CIRCUIT_BREAKER_ENABLED", true),
      circuitBreakerMaxErrors: Config._number("CIRCUIT_BREAKER_MAX_ERRORS", 5),
      circuitBreakerPauseMinutes: Config._number("CIRCUIT_BREAKER_PAUSE_MINUTES", 15),
      
      // Fonnte alerts
      fonnteEnabled: Config._bool("FONNTE_ENABLED", false),
      fonnteToken: Config._string("FONNTE_TOKEN", ""),
      fonnteTarget: Config._string("FONNTE_TARGET", ""),
      fonnteApiUrl: Config._string("FONNTE_API_URL", "https://api.fonnte.com/send"),
      fonnteCountryCode: Config._string("FONNTE_COUNTRY_CODE", "62"),
    };
  }
  
  static _string(key, fallback) {
    const value = process.env[key];
    return value === undefined || value === "" ? fallback : value;
  }
  
  static _number(key, fallback) {
    const parsed = Number(Config._string(key, fallback));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  
  static _bool(key, fallback = true) {
    const value = process.env[key];
    if (value === undefined || value === "") return fallback;
    return value !== "false";
  }
  
  static _true(key) {
    return process.env[key] === "true";
  }
  
  static _list(key, fallback) {
    return Config._string(key, fallback).split(",").map(s => s.trim()).filter(Boolean);
  }
  
  static _parseSymbols() {
    const memeDefault = "DOGE/USDT:USDT,1000SHIB/USDT:USDT,1000PEPE/USDT:USDT,1000FLOKI/USDT:USDT,1000BONK/USDT:USDT";
    const symbolInput = Config._string("SYMBOLS", Config._string("MEME_SYMBOLS", Config._string("SYMBOL", memeDefault)));
    return Config._list("SYMBOLS", symbolInput);
  }
  
  static get rotatingScanEnabled() {
    return Config.env.scanRotationBatchSize < Config.env.symbols.length;
  }
  
  static get effectiveRequiredConfirmation() {
    return Config.rotatingScanEnabled ? 1 : Config.env.requiredConfirmation;
  }
}

// ======================================================
// Utility Functions
// ======================================================
class Utils {
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  static roundNumber(value, digits = 6) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Number(num.toFixed(digits));
  }
  
  static clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  
  static async retry(fn, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === retries - 1) throw err;
        console.warn(`[WARN] Retry ${i + 1}/${retries}:`, err.message);
        await Utils.sleep(delay);
      }
    }
  }
  
  static parseTimeframeToMs(timeframe) {
    const text = String(timeframe || "").trim().toLowerCase();
    const match = text.match(/^(\d+)(m|h|d|w)$/);
    if (!match) return Config.env.intervalMinutes * 60 * 1000;
    const value = Number(match[1]);
    const unit = match[2];
    const unitMs = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 }[unit];
    return value * unitMs;
  }
  
  static getNextCandleDelay(intervalMs) {
    const now = Date.now();
    const next = Math.ceil(now / intervalMs) * intervalMs;
    return next - now;
  }
  
  static getUtcDayKey(timestamp = Date.now()) {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
  
  static classifyVolumeChange(volumeChange) {
    const value = Number(volumeChange);
    if (!Number.isFinite(value)) return "UNKNOWN";
    if (value <= -80) return "SEVERE_DRY_UP";
    if (value <= -40) return "HEAVY_DRY_UP";
    if (value < 15) return "NEUTRAL";
    if (value < 50) return "SUPPORTIVE";
    return "SURGE";
  }
  
  static loadJsonFile(filePath, fallbackFactory, warningLabel) {
    if (!fs.existsSync(filePath)) return fallbackFactory();
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      console.warn(`[WARN] ${warningLabel} reset:`, err.message);
      return fallbackFactory();
    }
  }
}

// ======================================================
// Exchange Client
// ======================================================
class ExchangeClient {
  constructor() {
    this.exchange = new ccxt.binance({
      apiKey: process.env.EXCHANGE_API_KEY,
      secret: process.env.EXCHANGE_SECRET,
      enableRateLimit: true,
      options: { defaultType: "future" }
    });
    if (process.env.EXCHANGE_DEMO === "true") {
      this.exchange.enable_demo_trading(true);
      console.log("[DEMO] Futures demo mode enabled");
    }
  }
  
  async loadMarkets() {
    await Utils.retry(() => this.exchange.loadMarkets());
  }
  
  async fetchTicker(symbol) {
    return Utils.retry(() => this.exchange.fetchTicker(symbol));
  }
  
  async fetchFundingRate(symbol) {
    return Utils.retry(() => this.exchange.fetchFundingRate(symbol));
  }
  
  async fetchOHLCV(symbol, timeframe, since, limit) {
    return Utils.retry(() => this.exchange.fetchOHLCV(symbol, timeframe, since, limit));
  }
  
  async fetchBalance() {
    return Utils.retry(() => this.exchange.fetchBalance());
  }
  
  async fetchPositions(symbols) {
    return Utils.retry(() => this.exchange.fetchPositions(symbols));
  }
  
  async fetchMyTrades(symbol, since, limit) {
    return Utils.retry(() => this.exchange.fetchMyTrades(symbol, since, limit));
  }
  
  async setLeverage(leverage, symbol) {
    return Utils.retry(() => this.exchange.setLeverage(leverage, symbol));
  }
  
  async createMarketOrder(symbol, side, amount, params = {}) {
    return Utils.retry(() => this.exchange.createMarketOrder(symbol, side, amount, params));
  }
  
  async createOrder(symbol, type, side, amount, price, params) {
    return Utils.retry(() => this.exchange.createOrder(symbol, type, side, amount, price, params));
  }
  
  async cancelOrder(id, symbol) {
    return Utils.retry(() => this.exchange.cancelOrder(id, symbol));
  }
  
  async fetchOpenOrders(symbol) {
    return Utils.retry(() => this.exchange.fetchOpenOrders(symbol));
  }
  
  amountToPrecision(symbol, amount) {
    return this.exchange.amountToPrecision(symbol, amount);
  }
  
  priceToPrecision(symbol, price) {
    return this.exchange.priceToPrecision(symbol, price);
  }
  
  getMarket(symbol) {
    return this.exchange.markets[symbol];
  }
}

// ======================================================
// Indicator Calculator
// ======================================================
class IndicatorCalculator {
  static calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }
  
  static calculateRSI(closes, period = 14) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  }
  
  static calculateATR(ohlcv) {
    const trs = [];
    for (let i = 1; i < ohlcv.length; i++) {
      const prevClose = ohlcv[i - 1][4];
      const high = ohlcv[i][2];
      const low = ohlcv[i][3];
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }
}

// ======================================================
// Market Data Service with Caching
// ======================================================
class MarketDataService {
  constructor(exchangeClient) {
    this.exchange = exchangeClient;
    this.snapshotCache = new Map();
    this.aiSignalCache = new Map();
  }
  
  async getMarketContext(symbol) {
    const [ticker, funding] = await Promise.all([
      this.exchange.fetchTicker(symbol),
      this.exchange.fetchFundingRate(symbol)
    ]);
    return {
      price: Number(ticker.last),
      fundingRate: Number(funding.fundingRate || 0)
    };
  }
  
  async getMarketSnapshot(symbol, context, timeframe = Config.env.timeframe) {
    const cacheKey = `${symbol}|${timeframe}|${Config.env.lookbackCandles}`;
    if (Config.env.marketSnapshotCacheEnabled) {
      const cached = this.snapshotCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { ...cached.snapshot, price: context.price, fundingRate: context.fundingRate };
      }
    }
    
    const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, Config.env.lookbackCandles);
    const closes = ohlcv.map(c => c[4]);
    const latestCandle = ohlcv[ohlcv.length - 1] || [];
    const candleTimestamp = Number(latestCandle[0] || 0);
    const timeframeMs = Utils.parseTimeframeToMs(timeframe);
    const expiresAt = candleTimestamp > 0 ? candleTimestamp + timeframeMs : Date.now() + timeframeMs;
    
    const ema20 = IndicatorCalculator.calculateEMA(closes.slice(-20), 20);
    const ema50 = IndicatorCalculator.calculateEMA(closes.slice(-50), 50);
    const prevEma20 = IndicatorCalculator.calculateEMA(closes.slice(-21, -1), 20);
    const prevEma50 = IndicatorCalculator.calculateEMA(closes.slice(-51, -1), 50);
    const ema20Slope = ema20 - prevEma20;
    const ema50Slope = ema50 - prevEma50;
    const rsi = IndicatorCalculator.calculateRSI(closes.slice(-15));
    const atr = IndicatorCalculator.calculateATR(ohlcv.slice(-15));
    const latestVolume = ohlcv[ohlcv.length - 1][5];
    const prevVolume = ohlcv[ohlcv.length - 2][5];
    const volumeChange = prevVolume ? ((latestVolume - prevVolume) / prevVolume) * 100 : 0;
    const trend = ema20 > ema50 ? "UPTREND" : ema20 < ema50 ? "DOWNTREND" : "SIDEWAYS";
    const emaGap = (Math.abs(ema20 - ema50) / context.price) * 100;
    
    const baseSnapshot = { candleTimestamp, expiresAt, ema20, ema50, ema20Slope, ema50Slope, emaGap, rsi, atr, volumeChange, trend };
    const snapshot = { price: context.price, fundingRate: context.fundingRate, ...baseSnapshot };
    
    if (Config.env.marketSnapshotCacheEnabled) {
      this.snapshotCache.set(cacheKey, { snapshot: baseSnapshot, expiresAt });
      this._pruneCache(this.snapshotCache);
    }
    return snapshot;
  }
  
  _pruneCache(cache) {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
      if (!entry?.expiresAt || entry.expiresAt <= now) cache.delete(key);
    }
    while (cache.size > Config.env.cacheMaxEntries) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
  }
  
  cacheAISignal(key, signal, expiresAt) {
    if (Config.env.aiSignalCacheEnabled) {
      this.aiSignalCache.set(key, { signal, expiresAt });
      this._pruneCache(this.aiSignalCache);
    }
  }
  
  getCachedAISignal(key) {
    if (!Config.env.aiSignalCacheEnabled) return null;
    const cached = this.aiSignalCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.signal;
    return null;
  }
}

// ======================================================
// Risk Manager
// ======================================================
class RiskManager {
  constructor(exchangeClient) {
    this.exchange = exchangeClient;
    this.riskState = this._loadRiskState();
    this.profitLedger = this._loadProfitLedger();
  }
  
  _loadRiskState() {
    const emptyState = () => ({
      dayKey: null,
      dayStartEquity: 0,
      dailyNetPnL: 0,
      consecutiveLosses: 0,
      processedTradeIds: [],
      symbolCooldowns: {},
      scanRotationIndex: 0,
      lastSyncedAt: 0,
      updatedAt: new Date().toISOString()
    });
    const state = Utils.loadJsonFile(Config.env.riskStateFile, emptyState, "Risk state");
    return { ...emptyState(), ...state, processedTradeIds: state.processedTradeIds || [], symbolCooldowns: state.symbolCooldowns || {} };
  }
  
  _loadProfitLedger() {
    const emptyLedger = () => ({
      symbol: Config.env.symbols.join(","),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastTradeTimestamp: Date.now(),
      processedTradeIds: [],
      totals: { grossRealizedPnl: 0, fees: 0, netProfit: 0, tradeCount: 0, profitEvents: 0, lossEvents: 0 },
      recentTrades: []
    });
    const ledger = Utils.loadJsonFile(Config.env.profitTrackerFile, emptyLedger, "Profit ledger");
    return { ...emptyLedger(), ...ledger, processedTradeIds: ledger.processedTradeIds || [], totals: { ...emptyLedger().totals, ...ledger.totals }, recentTrades: ledger.recentTrades || [] };
  }
  
  saveRiskState() {
    this.riskState.updatedAt = new Date().toISOString();
    fs.writeFileSync(Config.env.riskStateFile, JSON.stringify(this.riskState, null, 2));
  }
  
  saveProfitLedger() {
    this.profitLedger.updatedAt = new Date().toISOString();
    fs.writeFileSync(Config.env.profitTrackerFile, JSON.stringify(this.profitLedger, null, 2));
  }
  
  async syncRiskAndProfit() {
    await this._syncTrades(this._applyTradeToRisk.bind(this), "risk");
    if (Config.env.profitTrackerEnabled) {
      await this._syncTrades(this._applyTradeToProfit.bind(this), "profit");
      this._logProfitSummary();
    }
  }
  
  async _syncTrades(applyFn, label) {
    let since = label === "risk" ? this.riskState.lastSyncedAt : this.profitLedger.lastTradeTimestamp;
    if (since) since = since - 1;
    let newCount = 0;
    for (const symbol of Config.env.symbols) {
      try {
        const trades = await this.exchange.fetchMyTrades(symbol, since, Config.env.profitSyncLimit);
        const sorted = trades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        for (const trade of sorted) {
          if (await applyFn(trade)) newCount++;
        }
      } catch (err) {
        console.warn(`${symbol} ${label} sync skipped: ${err.message}`);
      }
    }
    if (newCount > 0) {
      if (label === "risk") this.saveRiskState();
      else this.saveProfitLedger();
    }
    return newCount;
  }
  
  async _applyTradeToRisk(trade) {
    const id = this._tradeId(trade);
    if (this.riskState.processedTradeIds.includes(id)) return false;
    const realizedPnl = this._getRealizedPnl(trade);
    const fee = this._getTradeFee(trade);
    const netProfit = realizedPnl - fee;
    this.riskState.processedTradeIds.push(id);
    this.riskState.processedTradeIds = this.riskState.processedTradeIds.slice(-1000);
    this.riskState.lastSyncedAt = Math.max(this.riskState.lastSyncedAt || 0, trade.timestamp || 0);
    this.riskState.dailyNetPnL += netProfit;
    if (Math.abs(realizedPnl) > 1e-7) {
      if (netProfit < 0) {
        this.riskState.consecutiveLosses++;
        this.setSymbolCooldown(trade.symbol, Config.env.symbolCooldownMinutes, `loss ${netProfit.toFixed(6)} USDT`);
      } else if (netProfit > 0) {
        this.riskState.consecutiveLosses = 0;
      }
      await this._sendTradeCloseAlert(trade, realizedPnl, fee, netProfit);
    }
    return true;
  }
  
  _applyTradeToProfit(trade) {
    const id = this._tradeId(trade);
    if (this.profitLedger.processedTradeIds.includes(id)) return false;
    const realizedPnl = this._getRealizedPnl(trade);
    const fee = this._getTradeFee(trade);
    const netProfit = realizedPnl - fee;
    this.profitLedger.processedTradeIds.push(id);
    this.profitLedger.processedTradeIds = this.profitLedger.processedTradeIds.slice(-1000);
    this.profitLedger.lastTradeTimestamp = Math.max(this.profitLedger.lastTradeTimestamp || 0, trade.timestamp || 0);
    this.profitLedger.totals.grossRealizedPnl += realizedPnl;
    this.profitLedger.totals.fees += fee;
    this.profitLedger.totals.netProfit += netProfit;
    this.profitLedger.totals.tradeCount++;
    if (netProfit > 0) this.profitLedger.totals.profitEvents++;
    if (netProfit < 0) this.profitLedger.totals.lossEvents++;
    this.profitLedger.recentTrades.unshift({
      id, symbol: trade.symbol, time: trade.datetime || new Date(trade.timestamp).toISOString(),
      side: trade.side, price: this._numberFromTrade(trade.price), amount: this._numberFromTrade(trade.amount),
      realizedPnl, fee, netProfit, order: trade.order || trade.info?.orderId
    });
    this.profitLedger.recentTrades = this.profitLedger.recentTrades.slice(0, 30);
    return true;
  }
  
  _tradeId(trade) {
    return String(trade.id || trade.info?.id || `${trade.timestamp}-${trade.order}-${trade.side}-${trade.amount}-${trade.price}`);
  }
  
  _getRealizedPnl(trade) {
    return this._numberFromTrade(trade.info?.realizedPnl || trade.info?.realizedProfit || trade.realizedPnl);
  }
  
  _getTradeFee(trade) {
    const feeCost = this._numberFromTrade(trade.fee?.cost);
    if (feeCost > 0) return feeCost;
    return Math.abs(this._numberFromTrade(trade.info?.commission));
  }
  
  _numberFromTrade(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }
  
  async _sendTradeCloseAlert(trade, realizedPnl, fee, netProfit) {
    const message = [
      "[TRADE CLOSE]",
      `Symbol: ${trade.symbol || "-"}`,
      `Side: ${String(trade.side || "-").toUpperCase()}`,
      `Time: ${trade.datetime || new Date(trade.timestamp).toISOString()}`,
      `Realized PnL: ${Utils.roundNumber(realizedPnl, 6)} USDT`,
      `Fee: ${Utils.roundNumber(fee, 6)} USDT`,
      `Net Profit: ${Utils.roundNumber(netProfit, 6)} USDT`
    ].join("\n");
    await FonnteAlert.send(message);
  }
  
  _logProfitSummary() {
    const t = this.profitLedger.totals;
    console.log(`\n[PROFIT] Summary\nNew trades synced: -\nGross PnL: ${t.grossRealizedPnl.toFixed(6)} USDT\nFees: ${t.fees.toFixed(6)} USDT\nNet Profit: ${t.netProfit.toFixed(6)} USDT\nW/L: ${t.profitEvents}/${t.lossEvents}\n`);
  }
  
  async getAccountEquity() {
    const balance = await this.exchange.fetchBalance();
    return Number(balance?.USDT?.total || balance?.USDT?.free || 0);
  }
  
  async ensureDailyRiskState() {
    const equity = await this.getAccountEquity();
    const dayKey = Utils.getUtcDayKey();
    if (this.riskState.dayKey !== dayKey) {
      this.riskState = {
        dayKey, dayStartEquity: equity, dailyNetPnL: 0, consecutiveLosses: 0,
        processedTradeIds: [], symbolCooldowns: {}, scanRotationIndex: 0, lastSyncedAt: 0,
        updatedAt: new Date().toISOString()
      };
      this.saveRiskState();
    } else if (!this.riskState.dayStartEquity && equity > 0) {
      this.riskState.dayStartEquity = equity;
      this.saveRiskState();
    }
  }
  
  getDailyLossLimit() {
    if (this.riskState.dayStartEquity <= 0) return Config.env.maxDailyLossUsdt > 0 ? Config.env.maxDailyLossUsdt : Infinity;
    const percentLimit = this.riskState.dayStartEquity * Config.env.maxDailyLossPct;
    if (Config.env.maxDailyLossUsdt > 0) return Math.min(percentLimit, Config.env.maxDailyLossUsdt);
    return percentLimit;
  }
  
  riskGateAllowsTrading() {
    this._cleanupCooldowns();
    const dailyLossLimit = this.getDailyLossLimit();
    if (dailyLossLimit > 0 && this.riskState.dailyNetPnL <= -dailyLossLimit) {
      console.warn(`[BLOCK] Daily loss limit: ${this.riskState.dailyNetPnL.toFixed(2)} / -${dailyLossLimit.toFixed(2)} USDT`);
      return false;
    }
    if (Config.env.maxConsecutiveLosses > 0 && this.riskState.consecutiveLosses >= Config.env.maxConsecutiveLosses) {
      console.warn(`[BLOCK] Consecutive losses: ${this.riskState.consecutiveLosses}/${Config.env.maxConsecutiveLosses}`);
      return false;
    }
    return true;
  }
  
  _cleanupCooldowns() {
    let changed = false;
    const now = Date.now();
    for (const [sym, cd] of Object.entries(this.riskState.symbolCooldowns)) {
      if (!cd?.until || Number(cd.until) <= now) {
        delete this.riskState.symbolCooldowns[sym];
        changed = true;
      }
    }
    if (changed) this.saveRiskState();
  }
  
  setSymbolCooldown(symbol, minutes, reason) {
    if (!Config.env.symbolCooldownEnabled || minutes <= 0) return;
    this.riskState.symbolCooldowns[symbol] = { until: Date.now() + minutes * 60000, reason, updatedAt: new Date().toISOString() };
    console.warn(`[COOLDOWN] ${symbol} paused for ${minutes}m: ${reason}`);
    this.saveRiskState();
  }
  
  symbolCooldownAllowsTrading(symbol) {
    if (!Config.env.symbolCooldownEnabled) return true;
    const cd = this.riskState.symbolCooldowns?.[symbol];
    if (!cd) return true;
    if (Date.now() > cd.until) {
      delete this.riskState.symbolCooldowns[symbol];
      this.saveRiskState();
      return true;
    }
    const remaining = Math.ceil((cd.until - Date.now()) / 60000);
    console.log(`[COOLDOWN] ${symbol} skipped for ${remaining}m: ${cd.reason}`);
    return false;
  }
  
  getRotatedScanSymbols() {
    const total = Config.env.symbols.length;
    const batchSize = Math.min(Config.env.scanRotationBatchSize, total);
    const start = this.riskState.scanRotationIndex % total;
    const rotated = [];
    for (let i = 0; i < batchSize; i++) rotated.push(Config.env.symbols[(start + i) % total]);
    this.riskState.scanRotationIndex = (start + batchSize) % total;
    return rotated;
  }
}

// ======================================================
// Circuit Breaker
// ======================================================
class CircuitBreaker {
  constructor() {
    this.consecutiveErrors = 0;
    this.pausedUntil = 0;
    this.lastError = null;
  }
  
  allowsTrading() {
    if (!Config.env.circuitBreakerEnabled) return true;
    if (Date.now() >= this.pausedUntil) return true;
    const remaining = Math.ceil((this.pausedUntil - Date.now()) / 60000);
    console.warn(`[CIRCUIT] Paused for ${remaining}m after ${this.consecutiveErrors} errors. Last: ${this.lastError}`);
    return false;
  }
  
  recordSuccess() {
    if (!Config.env.circuitBreakerEnabled) return;
    if (this.consecutiveErrors > 0) console.log("[CIRCUIT] Error streak cleared");
    this.consecutiveErrors = 0;
    this.lastError = null;
  }
  
  recordError(source, err) {
    if (!Config.env.circuitBreakerEnabled) return;
    this.consecutiveErrors++;
    this.lastError = `${source}: ${err?.message || err}`;
    console.warn(`[CIRCUIT] Error ${this.consecutiveErrors}/${Config.env.circuitBreakerMaxErrors} from ${source}: ${err?.message || err}`);
    if (this.consecutiveErrors >= Config.env.circuitBreakerMaxErrors) {
      this.pausedUntil = Date.now() + Config.env.circuitBreakerPauseMinutes * 60000;
      console.warn(`[CIRCUIT] Paused for ${Config.env.circuitBreakerPauseMinutes}m`);
    }
  }
}

// ======================================================
// Fonnte Alert
// ======================================================
class FonnteAlert {
  static async send(message) {
    if (!Config.env.fonnteEnabled || !Config.env.fonnteToken || !Config.env.fonnteTarget) return false;
    try {
      const formBody = new URLSearchParams({
        target: Config.env.fonnteTarget,
        message,
        countryCode: String(Config.env.fonnteCountryCode)
      }).toString();
      const response = await this._post(Config.env.fonnteApiUrl, formBody);
      let payload = null;
      try { payload = JSON.parse(response.body); } catch {}
      const ok = response.statusCode >= 200 && response.statusCode < 300 && payload?.status !== false && payload?.Status !== false;
      if (!ok) console.warn(`[FONNTE] Failed (${response.statusCode}): ${response.body || "empty"}`);
      else console.log("[FONNTE] Alert sent");
      return ok;
    } catch (err) {
      console.warn(`[FONNTE] Error: ${err.message}`);
      return false;
    }
  }
  
  static _post(urlString, formBody) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const req = https.request({
        method: "POST", hostname: url.hostname, port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: { Authorization: Config.env.fonnteToken, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(formBody) }
      }, res => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: data }));
      });
      req.on("error", reject);
      req.write(formBody);
      req.end();
    });
  }
}

// ======================================================
// AI Signal Generator
// ======================================================
class AISignalGenerator {
  constructor(marketData) {
    this.marketData = marketData;
    const genAI = new GoogleGenerativeAI(Config.env.geminiApiKey);
    this.model = genAI.getGenerativeModel({ model: Config.env.geminiModel });
  }
  
  async getSignal(symbol, snapshot, htfSnapshot, regimeInfo) {
    const promptKey = crypto.createHash("sha256").update(JSON.stringify({
      symbol, longOnly: Config.env.longOnly, snapshot, htfSnapshot, regimeInfo
    })).digest("hex");
    const cached = this.marketData.getCachedAISignal(promptKey);
    if (cached) {
      console.log(`[CACHE] AI hit ${symbol}`);
      return cached;
    }
    
    const prompt = this._buildPrompt(symbol, snapshot, htfSnapshot, regimeInfo);
    let lastError = null;
    for (let attempt = 1; attempt <= Config.env.aiResponseRetries + 1; attempt++) {
      try {
        const result = await this.model.generateContent(prompt);
        const text = result.response.text();
        const signal = this._parseSignal(text);
        const expiresAt = Math.min(snapshot?.expiresAt || Date.now(), htfSnapshot?.expiresAt || Date.now());
        this.marketData.cacheAISignal(promptKey, signal, expiresAt);
        return signal;
      } catch (err) {
        lastError = err;
        console.warn(`[WARN] AI invalid for ${symbol} (${attempt}/${Config.env.aiResponseRetries+1}): ${err.message}`);
        if (attempt <= Config.env.aiResponseRetries) await Utils.sleep(1000 * attempt);
      }
    }
    return { signal: "HOLD", strength: "WEAK", confidence: 0, tradeAllowed: false, reason: `Fallback: ${lastError?.message}` };
  }
  
  _buildPrompt(symbol, snapshot, htfSnapshot, regimeInfo) {
    const allowedSignals = Config.env.longOnly ? "LONG, HOLD" : "LONG, SHORT, HOLD";
    const volumeContext = Utils.classifyVolumeChange(snapshot.volumeChange);
    return `You are a professional crypto futures trader AI.
RULES: Prioritize HOLD during sideways. Do NOT reverse easily. Avoid fake breakouts. Use higher timeframe as filter.
Allowed signals: ${allowedSignals}. Strengths: WEAK, MEDIUM, STRONG, EXTREME (use WEAK not LOW).
Market regime: ${regimeInfo.regime} (${regimeInfo.reason}). Volume: ${volumeContext}.
SYMBOL: ${symbol}
PRICE: ${snapshot.price}
LOW TF TREND: ${snapshot.trend}
HIGH TF TREND: ${htfSnapshot.trend}
EMA20: ${snapshot.ema20}, EMA50: ${snapshot.ema50}
EMA20 SLOPE: ${snapshot.ema20Slope}, EMA50 SLOPE: ${snapshot.ema50Slope}
EMA GAP: ${snapshot.emaGap}%%, RSI: ${snapshot.rsi}, ATR: ${snapshot.atr}
VOLUME CHANGE: ${snapshot.volumeChange}%%, FUNDING: ${snapshot.fundingRate}
Return JSON: { "signal":"LONG/SHORT/HOLD", "strength":"WEAK/MEDIUM/STRONG/EXTREME", "confidence":0-100, "tradeAllowed":true/false, "reason":"..." }`;
  }
  
  _parseSignal(text) {
    const cleaned = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON object");
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const signal = String(parsed.signal || "").toUpperCase();
    const strength = String(parsed.strength || "WEAK").toUpperCase();
    const allowedStrengths = ["WEAK", "MEDIUM", "STRONG", "EXTREME"];
    if (!["LONG", "SHORT", "HOLD"].includes(signal)) throw new Error("Invalid signal");
    if (!allowedStrengths.includes(strength)) throw new Error("Invalid strength");
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error("Invalid confidence");
    return {
      signal, strength, confidence, tradeAllowed: parsed.tradeAllowed !== false,
      reason: String(parsed.reason || "").slice(0, 500)
    };
  }
}

// ======================================================
// Order Manager
// ======================================================
class OrderManager {
  constructor(exchangeClient) {
    this.exchange = exchangeClient;
    this.lastPositionChangeTime = 0;
  }
  
  async calculateContracts(symbol, price) {
    const market = this.exchange.getMarket(symbol);
    const targetNotional = Config.env.orderSizeUsdt * Config.env.leverage;
    const maxNotional = Config.env.maxPositionNotionalUsdt > 0 ? Math.min(targetNotional, Config.env.maxPositionNotionalUsdt) : targetNotional;
    const minCost = market?.limits?.cost?.min || 5;
    const minAmount = market?.limits?.amount?.min || 0;
    const finalNotional = Math.max(minCost, maxNotional);
    const contracts = Math.max(finalNotional / price, minAmount);
    return Number(this.exchange.amountToPrecision(symbol, contracts));
  }
  
  calculateRequiredMargin(amount, price) {
    return (amount * price) / Config.env.leverage;
  }
  
  async getCurrentPosition(symbol) {
    const positions = await this.exchange.fetchPositions([symbol]);
    const pos = positions.find(p => p.symbol === symbol && Number(p.contracts) > 0);
    if (!pos) return null;
    return { side: pos.side, symbol: pos.symbol, contracts: Number(pos.contracts), entryPrice: Number(pos.entryPrice) };
  }
  
  async getOpenPositions(symbols) {
    const open = [];
    for (const sym of symbols) {
      try {
        const pos = await this.getCurrentPosition(sym);
        if (pos) open.push(pos);
      } catch (err) {
        console.warn(`${sym} position check skipped: ${err.message}`);
      }
    }
    return open;
  }
  
  async openPosition(symbol, signal, price) {
    await this.exchange.setLeverage(Config.env.leverage, symbol);
    const side = signal === "LONG" ? "buy" : "sell";
    const amount = await this.calculateContracts(symbol, price);
    const requiredMargin = this.calculateRequiredMargin(amount, price);
    const balance = await this._getAvailableBalance();
    if (balance < requiredMargin) {
      console.warn(`[BLOCK] Insufficient balance: free ${balance.toFixed(4)} USDT, need ${requiredMargin.toFixed(4)}`);
      return null;
    }
    console.log(`\n[OPEN] ${signal}\nContracts: ${amount}\nNotional: ${(amount*price).toFixed(4)} USDT\nRequired margin: ${requiredMargin.toFixed(4)} USDT`);
    const order = await this.exchange.createMarketOrder(symbol, side, amount);
    console.log(`[OK] Order: ${order.id}`);
    this.lastPositionChangeTime = Date.now();
    await Utils.sleep(3000);
    return this.getCurrentPosition(symbol);
  }
  
  async closePosition(symbol, position) {
    const side = position.side === "long" ? "sell" : "buy";
    await this.exchange.createMarketOrder(symbol, side, position.contracts, { reduceOnly: true });
    await this.cancelAllOrders(symbol);
    console.log("[CLOSE] Position closed");
  }
  
  async cancelAllOrders(symbol) {
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol);
      for (const o of orders) {
        await this.exchange.cancelOrder(o.id, symbol);
        console.log(`[CANCEL] Order ${o.id}`);
      }
    } catch (err) { console.error(err.message); }
  }
  
  async createStopLossOrder(symbol, position, slPrice) {
    const side = position.side === "long" ? "sell" : "buy";
    const stopPrice = this.exchange.priceToPrecision(symbol, slPrice);
    console.log(`\n[SL] Stop loss market | Side: ${side} | Trigger: ${stopPrice}`);
    await this.exchange.createOrder(symbol, "STOP_MARKET", side, undefined, undefined, {
      stopPrice, closePosition: true, workingType: "MARK_PRICE"
    });
    console.log("[OK] Stop loss active");
  }
  
  async createPartialTPs(symbol, position, entryPrice, atr) {
    const side = position.side === "long" ? "sell" : "buy";
    const isLong = position.side === "long";
    const total = position.contracts;
    const tp1Qty = Number(this.exchange.amountToPrecision(symbol, total * Config.env.tp1Percent / 100));
    const tp2Qty = Number(this.exchange.amountToPrecision(symbol, total * Config.env.tp2Percent / 100));
    const runnerQty = Number(this.exchange.amountToPrecision(symbol, total - tp1Qty - tp2Qty));
    let tp1Price, tp2Price;
    if (isLong) {
      tp1Price = entryPrice + atr * Config.env.tp1RR;
      tp2Price = entryPrice + atr * Config.env.tp2RR;
    } else {
      tp1Price = entryPrice - atr * Config.env.tp1RR;
      tp2Price = entryPrice - atr * Config.env.tp2RR;
    }
    tp1Price = Number(this.exchange.priceToPrecision(symbol, tp1Price));
    tp2Price = Number(this.exchange.priceToPrecision(symbol, tp2Price));
    console.log(`\n[TP] TP1: ${tp1Price}\n[TP] TP2: ${tp2Price}`);
    if (tp1Qty > 0) {
      await this.exchange.createOrder(symbol, "TAKE_PROFIT_MARKET", side, tp1Qty, undefined, { stopPrice: tp1Price, reduceOnly: true, workingType: "MARK_PRICE" });
      console.log(`[OK] TP1 created: ${tp1Qty}`);
    }
    if (tp2Qty > 0) {
      await this.exchange.createOrder(symbol, "TAKE_PROFIT_MARKET", side, tp2Qty, undefined, { stopPrice: tp2Price, reduceOnly: true, workingType: "MARK_PRICE" });
      console.log(`[OK] TP2 created: ${tp2Qty}`);
    }
    if (runnerQty > 0) {
      const callbackRate = Utils.clamp((atr / entryPrice) * 100, Config.env.trailingCallbackMin, Config.env.trailingCallbackMax);
      await this.exchange.createOrder(symbol, "TRAILING_STOP_MARKET", side, runnerQty, undefined, { callbackRate, reduceOnly: true, workingType: "MARK_PRICE" });
      console.log(`\n[TRAILING] Runner ${runnerQty} | Callback: ${callbackRate}%`);
    }
  }
  
  async _getAvailableBalance() {
    const balance = await this.exchange.fetchBalance();
    return Number(balance?.USDT?.free || 0);
  }
  
  canReverse(position, now) {
    const cooldownMs = Config.env.reversalCooldownMinutes * 60 * 1000;
    return !position || (now - this.lastPositionChangeTime) >= cooldownMs;
  }
}

// ======================================================
// Market Regime Filter
// ======================================================
class MarketRegimeFilter {
  static detect(snapshot, htfSnapshot) {
    const atrPct = snapshot.price > 0 ? snapshot.atr / snapshot.price : 0;
    const bullish = snapshot.trend === "UPTREND" && htfSnapshot.trend === "UPTREND" &&
      snapshot.ema20Slope > 0 && htfSnapshot.ema20Slope > 0 &&
      snapshot.volumeChange >= Config.env.minVolumeChangeForTrend;
    const bearish = snapshot.trend === "DOWNTREND" && htfSnapshot.trend === "DOWNTREND" &&
      snapshot.ema20Slope < 0 && htfSnapshot.ema20Slope < 0 &&
      snapshot.volumeChange >= Config.env.minVolumeChangeForTrend;
    const sideways = snapshot.emaGap < Config.env.sidewaysEmaGap ||
      (Math.abs(snapshot.ema20Slope) < snapshot.atr * 0.02 && Math.abs(snapshot.ema50Slope) < snapshot.atr * 0.02) ||
      (snapshot.rsi >= 45 && snapshot.rsi <= 55 && atrPct < Config.env.minAtrPct);
    const volatile = atrPct >= Config.env.maxAtrPct;
    
    if (sideways) return { regime: "CHOPPY", allow: false, reason: "Ranging market", atrPct };
    if (volatile && !bullish && !bearish) return { regime: "HIGH_VOLATILITY", allow: false, reason: "Volatile without direction", atrPct };
    if (bullish) return { regime: "TRENDING_UP", allow: true, reason: "Bullish alignment", atrPct };
    if (bearish) return { regime: "TRENDING_DOWN", allow: true, reason: "Bearish alignment", atrPct };
    return { regime: "MIXED", allow: false, reason: "No clean trend", atrPct };
  }
  
  static isAllowed(regimeInfo) {
    if (!Config.env.regimeFilterEnabled) return true;
    if (!regimeInfo.allow) {
      console.warn(`[REGIME] Blocked: ${regimeInfo.regime}`);
      return false;
    }
    if (Config.env.allowedMarketRegimes.length > 0 && !Config.env.allowedMarketRegimes.includes(regimeInfo.regime)) {
      console.warn(`[REGIME] Not allowed: ${regimeInfo.regime}`);
      return false;
    }
    return true;
  }
}

// ======================================================
// Signal Confirmation Tracker
// ======================================================
class SignalTracker {
  constructor() {
    this.state = new Map(); // symbol -> { lastSignal, confirmCount }
  }
  
  update(symbol, signal, strength) {
    const entry = this.state.get(symbol) || { lastSignal: null, confirmCount: 0 };
    if (entry.lastSignal === signal) entry.confirmCount++;
    else { entry.lastSignal = signal; entry.confirmCount = 1; }
    this.state.set(symbol, entry);
    const confirmed = entry.confirmCount >= Config.effectiveRequiredConfirmation || strength === "STRONG" || strength === "EXTREME";
    return { count: entry.confirmCount, confirmed };
  }
}

// ======================================================
// Kill Switch
// ======================================================
class KillSwitch {
  static isActive() {
    if (!Config.env.killSwitchEnabled) return false;
    if (Config.env.stopTrading) {
      console.warn("[KILL] STOP_TRADING=true");
      return true;
    }
    const flagPath = path.resolve(process.cwd(), Config.env.killSwitchFile);
    if (fs.existsSync(flagPath)) {
      console.warn(`[KILL] ${Config.env.killSwitchFile} exists`);
      return true;
    }
    return false;
  }
}

// ======================================================
// Main Trading Bot
// ======================================================
class SmartTradingBot {
  constructor() {
    this.exchangeClient = new ExchangeClient();
    this.marketData = new MarketDataService(this.exchangeClient);
    this.riskManager = new RiskManager(this.exchangeClient);
    this.orderManager = new OrderManager(this.exchangeClient);
    this.circuitBreaker = new CircuitBreaker();
    this.aiGenerator = new AISignalGenerator(this.marketData);
    this.signalTracker = new SignalTracker();
    this.isTrading = false;
  }
  
  async start() {
    console.log(`
[START] Smart AI Futures Bot
Symbols: ${Config.env.symbols.join(", ")}
Max positions: ${Config.env.maxOpenPositions}
Leverage: ${Config.env.leverage}x
Order size: ${Config.env.orderSizeUsdt} USDT
Timeframes: ${Config.env.timeframe} / ${Config.env.htfTimeframe}
Rotation batch: ${Config.env.scanRotationBatchSize}
Model: ${Config.env.geminiModel}
Fonnte: ${Config.env.fonnteEnabled && Config.env.fonnteToken && Config.env.fonnteTarget ? "enabled" : "disabled"}
`);
    await this.exchangeClient.loadMarkets();
    await this.riskManager.syncRiskAndProfit();
    const intervalMs = Config.env.intervalMinutes * 60 * 1000;
    while (true) {
      try {
        const delay = Utils.getNextCandleDelay(intervalMs);
        console.log(`\n[WAIT] Next candle in ${Math.floor(delay/1000)}s`);
        await Utils.sleep(delay);
        await this.tradingCycle();
      } catch (err) {
        console.error(err);
        await Utils.sleep(5000);
      }
    }
  }
  
  async tradingCycle() {
    if (this.isTrading) { console.log("[WAIT] Previous cycle running"); return; }
    this.isTrading = true;
    const errorsAtStart = this.circuitBreaker.consecutiveErrors;
    let circuitAllowed = false;
    try {
      console.log(`\n========== ${new Date().toISOString()} ==========`);
      if (!this.circuitBreaker.allowsTrading()) return;
      circuitAllowed = true;
      await this.riskManager.syncRiskAndProfit();
      await this.riskManager.ensureDailyRiskState();
      const openPositions = await this.orderManager.getOpenPositions(Config.env.symbols);
      console.log("Open positions:", openPositions.length ? openPositions : "NONE");
      if (KillSwitch.isActive()) { console.log("[KILL] Cycle stopped"); return; }
      if (!this.riskManager.riskGateAllowsTrading()) return;
      
      const symbolsToScan = this.riskManager.getRotatedScanSymbols();
      console.log(`[SCAN] Batch: ${symbolsToScan.join(", ")} (${symbolsToScan.length}/${Config.env.symbols.length})`);
      const candidates = [];
      for (const symbol of symbolsToScan) {
        const cand = await this.analyzeSymbol(symbol);
        if (cand) candidates.push(cand);
      }
      if (candidates.length === 0) { console.log("No candidates"); return; }
      
      candidates.sort((a,b) => b.score - a.score);
      console.table(candidates.map(c => ({
        symbol: c.symbol, signal: c.signal, conf: c.ai.confidence,
        strength: c.aiStrength, rr: c.rr.toFixed(2), regime: c.regimeInfo.regime, score: c.score.toFixed(2)
      })));
      const best = candidates[0];
      await this.executeBestCandidate(best, openPositions);
    } catch (err) {
      console.error("[ERROR] Trading cycle:", err.message);
      this.circuitBreaker.recordError("trading cycle", err);
    } finally {
      if (circuitAllowed && this.circuitBreaker.consecutiveErrors === errorsAtStart) this.circuitBreaker.recordSuccess();
      this.isTrading = false;
    }
  }
  
  async analyzeSymbol(symbol) {
    try {
      console.log(`\n========== SCAN ${symbol} ==========`);
      if (!this.riskManager.symbolCooldownAllowsTrading(symbol)) return null;
      const context = await this.marketData.getMarketContext(symbol);
      const snapshot = await this.marketData.getMarketSnapshot(symbol, context, Config.env.timeframe);
      const htfSnapshot = await this.marketData.getMarketSnapshot(symbol, context, Config.env.htfTimeframe);
      const regimeInfo = MarketRegimeFilter.detect(snapshot, htfSnapshot);
      
      if (snapshot.emaGap < Config.env.sidewaysEmaGap) {
        console.log(`${symbol} skipped: sideways (EMA gap ${snapshot.emaGap.toFixed(2)}%)`);
        return null;
      }
      if (!MarketRegimeFilter.isAllowed(regimeInfo)) {
        console.log(`${symbol} skipped: ${regimeInfo.reason}`);
        return null;
      }
      
      console.log(`Asking Gemini for ${symbol}...`);
      const ai = await this.aiGenerator.getSignal(symbol, snapshot, htfSnapshot, regimeInfo);
      console.log(ai);
      const signal = ai.signal;
      if (signal === "HOLD") { console.log(`${symbol} HOLD`); return null; }
      if (Config.env.longOnly && signal === "SHORT") { console.log(`${symbol} SHORT ignored in LONG ONLY`); return null; }
      if (!this._aiFilterSafe(ai)) { console.log(`${symbol} AI filter failed`); return null; }
      
      const confirmation = this.signalTracker.update(symbol, signal, ai.strength);
      console.log(`Signal confirm: ${confirmation.count}/${Config.effectiveRequiredConfirmation}`);
      if (!confirmation.confirmed) { console.log(`${symbol} not confirmed`); return null; }
      
      const fundingSafe = (signal === "LONG" && context.fundingRate <= Config.env.maxFundingRate) ||
                          (signal === "SHORT" && context.fundingRate >= -Config.env.maxFundingRate);
      if (!fundingSafe) { console.warn(`${symbol} funding unsafe: ${context.fundingRate}`); return null; }
      
      const { tp, sl } = this._dynamicTPSL(signal, context.price, snapshot.atr, ai.strength);
      const rr = this._calculateRR(signal, context.price, tp, sl);
      console.log(`${symbol} RR: ${rr.toFixed(2)}`);
      if (rr < Config.env.minRR) { console.warn(`${symbol} RR too low`); return null; }
      
      const score = this._scoreCandidate(ai, rr, regimeInfo);
      return { symbol, signal, ai, aiStrength: ai.strength, context, snapshot, htfSnapshot, regimeInfo, rr, score, tp, sl };
    } catch (err) {
      console.warn(`${symbol} scan error: ${err.message}`);
      this.circuitBreaker.recordError(`scan ${symbol}`, err);
      this.riskManager.setSymbolCooldown(symbol, Config.env.symbolErrorCooldownMinutes, "scan error");
      return null;
    }
  }
  
  async executeBestCandidate(best, openPositions) {
    const { symbol, signal, context, snapshot, ai, rr, tp, sl, aiStrength } = best;
    const position = openPositions.find(p => p.symbol === symbol);
    if (position && position.side === signal.toLowerCase()) {
      console.log(`${symbol} position already exists`);
      return;
    }
    if (!position && openPositions.length >= Config.env.maxOpenPositions) {
      console.log(`Max positions reached: ${openPositions.length}/${Config.env.maxOpenPositions}`);
      return;
    }
    if (!this.orderManager.canReverse(position, Date.now())) {
      console.log(`${symbol} reversal cooldown active`);
      return;
    }
    
    if (position) await this.orderManager.closePosition(symbol, position);
    await this.orderManager.cancelAllOrders(symbol);
    const newPos = await this.orderManager.openPosition(symbol, signal, context.price);
    if (!newPos) return;
    
    const actualEntry = newPos.entryPrice;
    const slPrice = signal === "LONG" ? actualEntry - snapshot.atr : actualEntry + snapshot.atr;
    await this.orderManager.createStopLossOrder(symbol, newPos, slPrice);
    await this.orderManager.createPartialTPs(symbol, newPos, actualEntry, snapshot.atr);
    await FonnteAlert.send(this._formatOpenAlert({
      symbol, signal, entryPrice: actualEntry, contracts: newPos.contracts,
      slPrice, tpPrice: tp, rr, confidence: ai.confidence, strength: aiStrength
    }));
  }
  
  _dynamicTPSL(signal, entry, atr, strength) {
    const tpMult = { STRONG: 2.5, EXTREME: 3 }[strength] || Config.env.atrTpMultiplier;
    const slMult = { MEDIUM: 1.8, STRONG: 2.2, EXTREME: 2.5 }[strength] || 1.5;
    const dir = signal === "LONG" ? 1 : -1;
    return { tp: entry + dir * atr * tpMult, sl: entry - dir * atr * slMult };
  }
  
  _calculateRR(signal, entry, tp, sl) {
    if (signal === "LONG") return (tp - entry) / (entry - sl);
    return (entry - tp) / (sl - entry);
  }
  
  _scoreCandidate(ai, rr, regimeInfo) {
    const strengthBonus = { MEDIUM: 5, STRONG: 15, EXTREME: 25 }[ai.strength] || 0;
    const rrBonus = Math.min(rr, 3) * 10;
    const trendBonus = regimeInfo.allow ? 10 : 0;
    return ai.confidence + strengthBonus + rrBonus + trendBonus;
  }
  
  _aiFilterSafe(ai) {
    if (!Config.env.aiFilterEnabled) return true;
    if (!ai.tradeAllowed) return false;
    if (!Config.env.allowedAiStrengths.includes(ai.strength)) return false;
    if (ai.confidence < Config.env.minAiConfidence) return false;
    return true;
  }
  
  _formatOpenAlert({ symbol, signal, entryPrice, contracts, slPrice, tpPrice, rr, confidence, strength }) {
    return [
      "[TRADE OPEN]", `Symbol: ${symbol}`, `Side: ${signal}`,
      `Entry: ${Utils.roundNumber(entryPrice, 10)}`, `Contracts: ${Utils.roundNumber(contracts, 8)}`,
      `SL: ${Utils.roundNumber(slPrice, 10)}`, `TP: ${Utils.roundNumber(tpPrice, 10)}`,
      `RR: ${Utils.roundNumber(rr, 2)}`, `Confidence: ${confidence ?? "-"}`, `Strength: ${strength || "-"}`
    ].join("\n");
  }
}

// ======================================================
// Run the bot
// ======================================================
const bot = new SmartTradingBot();
bot.start().catch(console.error);
