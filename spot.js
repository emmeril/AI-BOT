require('dotenv').config();
const ccxt = require('ccxt');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
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
    return value !== 'false';
  }

  static true(key) {
    return process.env[key] === 'true';
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
const SYMBOLS = Config.list('SYMBOLS', 'BTC/USDT,ETH/USDT,DOGE/USDT');
const MAX_OPEN_POSITIONS = Config.number('MAX_OPEN_POSITIONS', 2);
const ORDER_SIZE_USDT = Config.number('ORDER_SIZE_USDT', 20);
const TIMEFRAME = Config.get('TIMEFRAME', '15m');
const LOOKBACK_CANDLES = Config.number('LOOKBACK_CANDLES', 200);
const INTERVAL_MINUTES = Config.number('INTERVAL_MINUTES', 5);
const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;
const AI_SIGNAL_CACHE_ENABLED = Config.boolean('AI_SIGNAL_CACHE_ENABLED', true);
const AI_SIGNAL_CACHE_TTL_MS = Config.number('AI_SIGNAL_CACHE_TTL_MS', Math.max(INTERVAL_MS * 3, 60000));

const SR_WINDOW_SIZE = Config.number('SR_WINDOW_SIZE', 5);
const SR_LEVEL_TOLERANCE = Config.number('SR_LEVEL_TOLERANCE', 0.005);
const PRICE_PROXIMITY_THRESHOLD = Config.number('PRICE_PROXIMITY_THRESHOLD', 0.005);

const GEMINI_MODEL = Config.get('GEMINI_MODEL', 'gemini-1.5-flash-lite');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
const MIN_AI_CONFIDENCE = Config.number('MIN_AI_CONFIDENCE', 65);
const ALLOWED_AI_STRENGTHS = Config.list('ALLOWED_AI_STRENGTHS', 'MEDIUM,STRONG,EXTREME').map(s => s.toUpperCase());
const AI_RESPONSE_RETRIES = Config.number('AI_RESPONSE_RETRIES', 2);

const MIN_RR = Config.number('MIN_RR', 1.5);
const MAX_DAILY_LOSS_PCT = Config.number('MAX_DAILY_LOSS_PCT', 3) / 100;
const MAX_DAILY_LOSS_USDT = Config.number('MAX_DAILY_LOSS_USDT', 0);
const MAX_CONSECUTIVE_LOSSES = Config.number('MAX_CONSECUTIVE_LOSSES', 3);
const ATR_TP_MULTIPLIER = Config.number('ATR_TP_MULTIPLIER', 1.8);
const ATR_SL_MULTIPLIER = Config.number('ATR_SL_MULTIPLIER', 1.5);
const REVERSAL_COOLDOWN_MINUTES = Config.number('REVERSAL_COOLDOWN_MINUTES', 10);
const SYMBOL_COOLDOWN_ENABLED = Config.boolean('SYMBOL_COOLDOWN_ENABLED');
const SYMBOL_COOLDOWN_MINUTES = Config.number('SYMBOL_COOLDOWN_MINUTES', 30);
const SYMBOL_ERROR_COOLDOWN_MINUTES = Config.number('SYMBOL_ERROR_COOLDOWN_MINUTES', 5);
const KILL_SWITCH_ENABLED = Config.boolean('KILL_SWITCH_ENABLED');
const STOP_TRADING = Config.true('STOP_TRADING');
const KILL_SWITCH_FILE = Config.get('KILL_SWITCH_FILE', 'bot-paused.flag');
const KILL_SWITCH_PATH = path.resolve(process.cwd(), KILL_SWITCH_FILE);

const PROFIT_TRACKER_ENABLED = Config.boolean('PROFIT_TRACKER_ENABLED');
const PROFIT_TRACKER_FILE = Config.get('PROFIT_TRACKER_FILE', 'profit-ledger-spot.json');
const PROFIT_LEDGER_PATH = path.resolve(process.cwd(), PROFIT_TRACKER_FILE);
const RISK_STATE_FILE = Config.get('RISK_STATE_FILE', 'risk-state-spot.json');
const RISK_STATE_PATH = path.resolve(process.cwd(), RISK_STATE_FILE);

const FONNTE_ENABLED = Config.boolean('FONNTE_ENABLED');
const FONNTE_TOKEN = Config.get('FONNTE_TOKEN', '');
const FONNTE_TARGET = Config.get('FONNTE_TARGET', '');
const FONNTE_API_URL = Config.get('FONNTE_API_URL', 'https://api.fonnte.com/send');
const FONNTE_COUNTRY_CODE = Config.get('FONNTE_COUNTRY_CODE', '62');

const LEARNING_MEMORY_ENABLED = Config.boolean('LEARNING_MEMORY_ENABLED', true);
const LEARNING_MEMORY_FILE = Config.get('LEARNING_MEMORY_FILE', 'learning-memory-spot.json');
const LEARNING_MEMORY_PATH = path.resolve(process.cwd(), LEARNING_MEMORY_FILE);
const LEARNING_MEMORY_MIN_TRADES = Config.number('LEARNING_MEMORY_MIN_TRADES', 5);
const LEARNING_MEMORY_BAD_WIN_RATE = Config.number('LEARNING_MEMORY_BAD_WIN_RATE', 40);
const LEARNING_MEMORY_CONFIDENCE_PENALTY = Config.number('LEARNING_MEMORY_CONFIDENCE_PENALTY', 0.6);

// ------------------------------
//  Utility Functions
// ------------------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function roundNumber(value, digits = 6) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : null;
}

async function retry(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
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
  if (STOP_TRADING) return true;
  try {
    return require('fs').existsSync(KILL_SWITCH_PATH);
  } catch {
    return false;
  }
}

// ------------------------------
//  Exchange Singleton
// ------------------------------
class ExchangeManager {
  static instance = null;

  static getInstance() {
    if (!this.instance) {
      this.instance = new ccxt.binance({
        apiKey: process.env.EXCHANGE_API_KEY,
        secret: process.env.EXCHANGE_SECRET,
        enableRateLimit: true,
        options: { defaultType: 'spot' },
      });
    }
    return this.instance;
  }
}

// ------------------------------
//  Technical Indicators
// ------------------------------
class Indicators {
  static calculateATR(ohlcv, period = 14) {
    if (!ohlcv?.length || ohlcv.length <= period) return null;
    const trs = [];
    for (let i = 1; i < ohlcv.length; i++) {
      const prevClose = ohlcv[i - 1][4];
      const high = ohlcv[i][2];
      const low = ohlcv[i][3];
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    const recent = trs.slice(-period);
    if (recent.length < period) return null;
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  static calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }

  static getVolumeTrend(ohlcv) {
    const volumes = ohlcv.map(c => c[5]);
    const recentAvg = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prevAvg = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
    return recentAvg > prevAvg ? 'increasing' : 'decreasing';
  }

  static getShortTrend(ohlcv) {
    const closes = ohlcv.map(c => c[4]);
    const ema5 = this.calculateEMA(closes.slice(-20), 5);
    const prevEma5 = this.calculateEMA(closes.slice(-21, -1), 5);
    return ema5 > prevEma5 ? 'bullish' : 'bearish';
  }
}

// ------------------------------
//  Support & Resistance Detection
// ------------------------------
class SupportResistance {
  static detectSwingPoints(ohlcv, windowSize) {
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
      if (isHigh) swingHighs.push({ price: highs[i], index: i, timestamp: ohlcv[i][0] });

      let isLow = true;
      for (let j = 1; j <= windowSize; j++) {
        if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) {
          isLow = false;
          break;
        }
      }
      if (isLow) swingLows.push({ price: lows[i], index: i, timestamp: ohlcv[i][0] });
    }
    return { swingHighs, swingLows };
  }

  static clusterLevels(points, tolerance) {
    if (!points.length) return [];
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const clusters = [];
    let current = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prevPrice = current[current.length - 1].price;
      if ((sorted[i].price - prevPrice) / prevPrice <= tolerance) {
        current.push(sorted[i]);
      } else {
        clusters.push(current);
        current = [sorted[i]];
      }
    }
    clusters.push(current);
    return clusters.map(cl => ({
      price: cl.reduce((sum, p) => sum + p.price, 0) / cl.length,
      strength: cl.length,
    })).sort((a, b) => b.strength - a.strength);
  }

  static getLevels(ohlcv) {
    const { swingHighs, swingLows } = this.detectSwingPoints(ohlcv, SR_WINDOW_SIZE);
    return {
      support: this.clusterLevels(swingLows, SR_LEVEL_TOLERANCE),
      resistance: this.clusterLevels(swingHighs, SR_LEVEL_TOLERANCE),
    };
  }
}

// ------------------------------
//  AI Signal Module
// ------------------------------
class AISignalGenerator {
  static aiSignalCache = new Map();

  static getCacheKey(symbol, ohlcv) {
    const lastTs = ohlcv?.[ohlcv.length - 1]?.[0] || 0;
    const bucket = lastTs ? Math.floor(lastTs / (INTERVAL_MS)) : 0;
    return `${symbol}|${TIMEFRAME}|${bucket}|SPOT`;
  }

  static getCached(key) {
    if (!AI_SIGNAL_CACHE_ENABLED) return null;
    const entry = this.aiSignalCache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    if (entry) this.aiSignalCache.delete(key);
    return null;
  }

  static setCached(key, value, ttl = AI_SIGNAL_CACHE_TTL_MS) {
    if (!AI_SIGNAL_CACHE_ENABLED) return;
    this.aiSignalCache.set(key, { value, expiresAt: Date.now() + ttl });
  }

  static normalizeStrength(value) {
    const s = String(value).trim().toUpperCase();
    const map = { LOW: 'WEAK', MILD: 'WEAK', MODERATE: 'MEDIUM', HIGH: 'STRONG', VERY_HIGH: 'EXTREME', VERYHIGH: 'EXTREME' };
    return map[s] || s;
  }

  static parseResponse(text) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object');
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const signal = String(parsed.signal || '').trim().toUpperCase();
    if (!['LONG', 'HOLD'].includes(signal)) throw new Error(`Invalid signal: ${signal}`);
    return {
      signal,
      strength: this.normalizeStrength(parsed.strength),
      confidence: Number(parsed.confidence),
      tradeAllowed: typeof parsed.tradeAllowed === 'boolean' ? parsed.tradeAllowed : signal !== 'HOLD',
      reason: String(parsed.reason || '').slice(0, 500),
    };
  }

  static buildPrompt(symbol, price, support, resistance, ohlcv) {
    const supportsBelow = support.filter(s => s.price < price).sort((a, b) => b.price - a.price);
    const resistancesAbove = resistance.filter(r => r.price > price).sort((a, b) => a.price - b.price);
    const nearestSupport = supportsBelow[0] || null;
    const nearestResistance = resistancesAbove[0] || null;
    const volumeTrend = Indicators.getVolumeTrend(ohlcv);
    const shortTrend = Indicators.getShortTrend(ohlcv);
    return `
You are a spot trader AI. Decide LONG or HOLD based on support/resistance.

Rules:
- LONG when price near strong support with bullish reversal.
- HOLD if price middle, weak levels, or momentum unclear.
- Volume increase near support adds confidence.
- Short-term trend must be bullish for LONG.

Data:
Symbol: ${symbol}
Price: ${price}
Nearest Support: ${nearestSupport?.price ?? 'none'} (strength ${nearestSupport?.strength ?? 0})
Nearest Resistance: ${nearestResistance?.price ?? 'none'} (strength ${nearestResistance?.strength ?? 0})
Dist to Support: ${nearestSupport ? ((price - nearestSupport.price) / price * 100).toFixed(2) : 'N/A'}%
Dist to Resistance: ${nearestResistance ? ((nearestResistance.price - price) / price * 100).toFixed(2) : 'N/A'}%
Volume Trend: ${volumeTrend}
Short Trend: ${shortTrend}

Allowed: LONG, HOLD. Strength: WEAK/MEDIUM/STRONG/EXTREME.
Return JSON: {"signal":"LONG/HOLD","strength":"...","confidence":0-100,"tradeAllowed":true/false,"reason":"..."}
`;
  }

  static async getSignal(symbol, price, support, resistance, ohlcv) {
    const cacheKey = this.getCacheKey(symbol, ohlcv);
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const prompt = this.buildPrompt(symbol, price, support, resistance, ohlcv);
    for (let attempt = 1; attempt <= AI_RESPONSE_RETRIES + 1; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        const signal = this.parseResponse(result.response.text());
        this.setCached(cacheKey, signal);
        return signal;
      } catch (err) {
        if (attempt <= AI_RESPONSE_RETRIES) await sleep(1000 * attempt);
      }
    }
    const fallback = { signal: 'HOLD', strength: 'WEAK', confidence: 0, tradeAllowed: false, reason: 'AI fallback' };
    this.setCached(cacheKey, fallback, 60000);
    return fallback;
  }
}

// ------------------------------
//  Risk & State Management (Persistent)
// ------------------------------
class RiskState {
  constructor() {
    this.data = this._load();
    this.costBasis = new Map(); // in-memory FIFO for PnL
  }

  _load() {
    try {
      if (require('fs').existsSync(RISK_STATE_PATH)) {
        return JSON.parse(require('fs').readFileSync(RISK_STATE_PATH, 'utf8'));
      }
    } catch (e) {}
    return {
      dayKey: null,
      dayStartEquity: 0,
      dailyNetPnL: 0,
      consecutiveLosses: 0,
      symbolCooldowns: {},
      lastSyncedAt: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    require('fs').writeFileSync(RISK_STATE_PATH, JSON.stringify(this.data, null, 2));
  }

  get dailyLossLimit() {
    const equity = this.data.dayStartEquity || 0;
    const percentLimit = equity * MAX_DAILY_LOSS_PCT;
    if (MAX_DAILY_LOSS_USDT > 0) return Math.min(percentLimit, MAX_DAILY_LOSS_USDT);
    return percentLimit;
  }

  allowsTrading() {
    if (this.dailyLossLimit > 0 && this.data.dailyNetPnL <= -this.dailyLossLimit) return false;
    if (MAX_CONSECUTIVE_LOSSES > 0 && this.data.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) return false;
    return true;
  }

  setSymbolCooldown(symbol, minutes, reason) {
    if (!SYMBOL_COOLDOWN_ENABLED) return;
    this.data.symbolCooldowns[symbol] = { until: Date.now() + minutes * 60000, reason };
    this.save();
  }

  symbolAllows(symbol) {
    if (!SYMBOL_COOLDOWN_ENABLED) return true;
    const cd = this.data.symbolCooldowns[symbol];
    if (!cd) return true;
    if (cd.until <= Date.now()) {
      delete this.data.symbolCooldowns[symbol];
      this.save();
      return true;
    }
    return false;
  }

  updateDailyPnL(delta, isLoss) {
    this.data.dailyNetPnL += delta;
    if (isLoss) this.data.consecutiveLosses++;
    else this.data.consecutiveLosses = 0;
    this.save();
  }

  async syncEquity() {
    const exchange = ExchangeManager.getInstance();
    const balance = await retry(() => exchange.fetchBalance());
    const equity = Number(balance?.total?.USDT || 0);
    const dayKey = new Date().toISOString().slice(0, 10);
    if (this.data.dayKey !== dayKey) {
      this.data.dayKey = dayKey;
      this.data.dayStartEquity = equity;
      this.data.dailyNetPnL = 0;
      this.save();
    } else if (!this.data.dayStartEquity && equity > 0) {
      this.data.dayStartEquity = equity;
      this.save();
    }
    return equity;
  }
}

// ------------------------------
//  Profit Ledger (Spot FIFO)
// ------------------------------
class ProfitLedger {
  constructor() {
    this.data = this._load();
    this.costBasis = new Map(); // symbol -> { totalCost, totalAmount }
  }

  _load() {
    if (!PROFIT_TRACKER_ENABLED) return this._empty();
    try {
      if (require('fs').existsSync(PROFIT_LEDGER_PATH)) {
        const raw = require('fs').readFileSync(PROFIT_LEDGER_PATH, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {}
    return this._empty();
  }

  _empty() {
    return {
      symbols: SYMBOLS.join(','),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      processedTradeIds: [],
      totals: { grossRealizedPnl: 0, fees: 0, netProfit: 0, tradeCount: 0, profitEvents: 0, lossEvents: 0 },
      recentTrades: [],
    };
  }

  save() {
    if (!PROFIT_TRACKER_ENABLED) return;
    this.data.updatedAt = new Date().toISOString();
    require('fs').writeFileSync(PROFIT_LEDGER_PATH, JSON.stringify(this.data, null, 2));
  }

  updateCostBasis(symbol, amount, price, fee) {
    const cost = amount * price;
    const basis = this.costBasis.get(symbol) || { totalCost: 0, totalAmount: 0 };
    basis.totalCost += cost + fee;
    basis.totalAmount += amount;
    this.costBasis.set(symbol, basis);
  }

  computeSellPnl(symbol, amount, price, fee) {
    const basis = this.costBasis.get(symbol);
    if (!basis || basis.totalAmount <= 0) return { netProfit: 0, remainingAmount: 0 };
    const avgPrice = basis.totalCost / basis.totalAmount;
    const sellValue = amount * price;
    const costToSell = amount * avgPrice;
    const netProfit = sellValue - costToSell - fee;
    const remainingAmount = basis.totalAmount - amount;
    if (remainingAmount <= 1e-8) {
      this.costBasis.delete(symbol);
    } else {
      basis.totalCost -= costToSell;
      basis.totalAmount = remainingAmount;
      this.costBasis.set(symbol, basis);
    }
    return { netProfit, remainingAmount };
  }

  async syncFromExchange() {
    const exchange = ExchangeManager.getInstance();
    let newCount = 0;
    for (const symbol of SYMBOLS) {
      const since = this.data.lastTradeTimestamp ? this.data.lastTradeTimestamp - 1 : undefined;
      const trades = await retry(() => exchange.fetchMyTrades(symbol, since, 100));
      for (const trade of trades.sort((a, b) => a.timestamp - b.timestamp)) {
        const id = String(trade.id || trade.info?.id || `${trade.timestamp}-${trade.order}`);
        if (this.data.processedTradeIds.includes(id)) continue;
        const fee = Number(trade.fee?.cost || 0);
        const amount = Number(trade.amount);
        const price = Number(trade.price);
        if (trade.side === 'buy') {
          this.updateCostBasis(symbol, amount, price, fee);
        } else if (trade.side === 'sell') {
          const { netProfit } = this.computeSellPnl(symbol, amount, price, fee);
          this.data.totals.grossRealizedPnl += netProfit > 0 ? netProfit : 0;
          this.data.totals.netProfit += netProfit;
          this.data.totals.tradeCount++;
          if (netProfit > 0) this.data.totals.profitEvents++;
          if (netProfit < 0) this.data.totals.lossEvents++;
          this.data.recentTrades.unshift({
            id, symbol, time: trade.datetime, side: trade.side, price, amount, netProfit, fee,
          });
          this.data.recentTrades = this.data.recentTrades.slice(0, 30);
        }
        this.data.processedTradeIds.push(id);
        this.data.lastTradeTimestamp = Math.max(this.data.lastTradeTimestamp || 0, trade.timestamp);
        newCount++;
      }
    }
    if (newCount > 0) this.save();
    return newCount;
  }
}

// ------------------------------
//  Learning Memory Module
// ------------------------------
class LearningMemory {
  constructor() {
    this.data = this._load();
  }

  _load() {
    if (!LEARNING_MEMORY_ENABLED) return { stats: { bySymbolSide: {}, bySymbolStrength: {}, byRRRange: {} } };
    try {
      if (require('fs').existsSync(LEARNING_MEMORY_PATH)) {
        return JSON.parse(require('fs').readFileSync(LEARNING_MEMORY_PATH, 'utf8'));
      }
    } catch (e) {}
    return { stats: { bySymbolSide: {}, bySymbolStrength: {}, byRRRange: {} }, version: 1 };
  }

  save() {
    if (!LEARNING_MEMORY_ENABLED) return;
    require('fs').writeFileSync(LEARNING_MEMORY_PATH, JSON.stringify(this.data, null, 2));
  }

  _updateCategory(cat, key, isWin, pnl) {
    const category = this.data.stats[cat];
    if (!category[key]) category[key] = { wins: 0, losses: 0, totalPnl: 0 };
    const entry = category[key];
    if (isWin) entry.wins++;
    else entry.losses++;
    entry.totalPnl += pnl;
  }

  record(symbol, side, netProfit, strength, rr) {
    const isWin = netProfit > 0;
    const rrRange = rr < 1.5 ? '<1.5' : rr < 2 ? '1.5-2' : '>2';
    this._updateCategory('bySymbolSide', `${symbol}_${side}`, isWin, netProfit);
    this._updateCategory('bySymbolStrength', `${symbol}_${strength}`, isWin, netProfit);
    this._updateCategory('byRRRange', rrRange, isWin, netProfit);
    this.save();
  }

  getWinRate(catStats) {
    if (!catStats) return null;
    const total = catStats.wins + catStats.losses;
    return total === 0 ? null : (catStats.wins / total) * 100;
  }

  adjustConfidence(symbol, signal, strength, rr, originalConf) {
    if (!LEARNING_MEMORY_ENABLED) return originalConf;
    const keys = [
      { cat: 'bySymbolSide', key: `${symbol}_${signal}` },
      { cat: 'bySymbolStrength', key: `${symbol}_${strength}` },
      { cat: 'byRRRange', key: rr < 1.5 ? '<1.5' : rr < 2 ? '1.5-2' : '>2' },
    ];
    let worstWR = 100;
    for (const { cat, key } of keys) {
      const stats = this.data.stats[cat]?.[key];
      if (stats && (stats.wins + stats.losses) >= LEARNING_MEMORY_MIN_TRADES) {
        const wr = this.getWinRate(stats);
        if (wr !== null && wr < worstWR) worstWR = wr;
      }
    }
    if (worstWR < LEARNING_MEMORY_BAD_WIN_RATE) {
      return Math.floor(originalConf * LEARNING_MEMORY_CONFIDENCE_PENALTY);
    }
    return originalConf;
  }
}

// ------------------------------
//  Spot Trading Engine
// ------------------------------
class SpotTradingEngine {
  constructor() {
    this.exchange = ExchangeManager.getInstance();
    this.risk = new RiskState();
    this.ledger = new ProfitLedger();
    this.memory = new LearningMemory();
    this.openPositions = new Map(); // symbol -> { amount, entryPrice, tpOrderId, slOrderId }
    this.pendingSetups = new Map(); // posKey -> setup
    this.pendingPnL = new Map(); // posKey -> { netProfitSum, strength, rr, recorded }
    this.lastTradeTime = 0;
    this.isRunning = false;
    this.circuitBreaker = { errors: 0, pausedUntil: 0 };
  }

  async init() {
    await retry(() => this.exchange.loadMarkets());
    await this.risk.syncEquity();
    await this.ledger.syncFromExchange();
    await this._syncPositionsFromBalance();
  }

  async _syncPositionsFromBalance() {
    for (const symbol of SYMBOLS) {
      const base = symbol.split('/')[0];
      const balance = await retry(() => this.exchange.fetchBalance());
      const amount = Number(balance?.free?.[base] || 0);
      if (amount > 0 && !this.openPositions.has(symbol)) {
        // approximate entry: could be stored in risk state, but for simplicity we keep only amount
        this.openPositions.set(symbol, { amount, entryPrice: 0, tpOrderId: null, slOrderId: null });
      } else if (amount <= 0 && this.openPositions.has(symbol)) {
        this.openPositions.delete(symbol);
      }
    }
  }

  circuitAllows() {
    if (this.circuitBreaker.pausedUntil > Date.now()) return false;
    return true;
  }

  recordError() {
    this.circuitBreaker.errors++;
    if (this.circuitBreaker.errors >= 5) {
      this.circuitBreaker.pausedUntil = Date.now() + 15 * 60000;
      console.warn('[CIRCUIT] Paused 15m');
    }
  }

  recordSuccess() {
    this.circuitBreaker.errors = 0;
  }

  async getQuoteBalance() {
    const balance = await retry(() => this.exchange.fetchBalance());
    return Number(balance?.free?.USDT || 0);
  }

  async calculateBuyAmount(symbol, price) {
    const target = ORDER_SIZE_USDT;
    const market = this.exchange.markets[symbol];
    const minCost = market?.limits?.cost?.min || 10;
    const finalNotional = Math.max(minCost, target);
    const amount = finalNotional / price;
    return this.exchange.amountToPrecision(symbol, amount);
  }

  async placeBuy(symbol, amount) {
    const order = await retry(() => this.exchange.createMarketOrder(symbol, 'buy', amount));
    const filledAmount = Number(order.filled);
    const avgPrice = order.price || (order.cost / filledAmount);
    return { amount: filledAmount, entryPrice: avgPrice };
  }

  async placeSell(symbol, amount) {
    await retry(() => this.exchange.createMarketOrder(symbol, 'sell', amount));
  }

  async cancelAllOrders(symbol) {
    const orders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    for (const o of orders) await retry(() => this.exchange.cancelOrder(o.id, symbol));
  }

  async setTPSL(symbol, amount, entry, slPrice, tpPrice) {
    await this.cancelAllOrders(symbol);
    const tpOrder = await retry(() => this.exchange.createOrder(symbol, 'TAKE_PROFIT_LIMIT', 'sell', amount, tpPrice, { stopPrice: tpPrice }));
    const slOrder = await retry(() => this.exchange.createOrder(symbol, 'STOP_LOSS_LIMIT', 'sell', amount, slPrice * 0.999, { stopPrice: slPrice }));
    return { tpOrderId: tpOrder.id, slOrderId: slOrder.id };
  }

  async closePosition(symbol) {
    const pos = this.openPositions.get(symbol);
    if (!pos) return;
    await this.cancelAllOrders(symbol);
    await this.placeSell(symbol, pos.amount);
    this.openPositions.delete(symbol);
    await this.ledger.syncFromExchange();
  }

  async finalizeClosedPositions() {
    const openSymbols = new Set(this.openPositions.keys());
    for (const [posKey, acc] of this.pendingPnL.entries()) {
      if (acc.recorded) continue;
      const [symbol] = posKey.split('_');
      if (!openSymbols.has(symbol)) {
        const setup = this.pendingSetups.get(posKey);
        const isLoss = acc.netProfitSum < 0;
        this.risk.updateDailyPnL(acc.netProfitSum, isLoss);
        if (LEARNING_MEMORY_ENABLED && setup?.strength && setup?.rr) {
          this.memory.record(symbol, 'LONG', acc.netProfitSum, setup.strength, setup.rr);
        }
        acc.recorded = true;
        this.pendingSetups.delete(posKey);
        this.pendingPnL.delete(posKey);
        await this._sendAlert(`[CLOSED] ${symbol} LONG | PnL: ${acc.netProfitSum.toFixed(2)} USDT`);
      }
    }
  }

  async analyzeSymbol(symbol) {
    if (!this.risk.symbolAllows(symbol)) return null;
    const [ticker, ohlcv] = await Promise.all([
      retry(() => this.exchange.fetchTicker(symbol)),
      retry(() => this.exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, LOOKBACK_CANDLES)),
    ]);
    const price = ticker.last;
    const { support, resistance } = SupportResistance.getLevels(ohlcv);
    const nearestSupport = support.filter(s => s.price < price).sort((a, b) => b.price - a.price)[0];
    const nearestResistance = resistance.filter(r => r.price > price).sort((a, b) => a.price - b.price)[0];
    const distToSupport = nearestSupport ? (price - nearestSupport.price) / price : Infinity;
    const distToResist = nearestResistance ? (nearestResistance.price - price) / price : Infinity;
    if (distToSupport > PRICE_PROXIMITY_THRESHOLD && distToResist > PRICE_PROXIMITY_THRESHOLD) return null;

    let ai = await AISignalGenerator.getSignal(symbol, price, support, resistance, ohlcv);
    if (ai.signal !== 'LONG' || !ai.tradeAllowed) return null;
    if (!ALLOWED_AI_STRENGTHS.includes(ai.strength)) return null;

    const atr = Indicators.calculateATR(ohlcv.slice(-20));
    if (!atr) return null;
    const buffer = price * 0.002;
    let sl = nearestSupport ? nearestSupport.price - buffer : price - atr * ATR_SL_MULTIPLIER;
    let tp = nearestResistance ? nearestResistance.price : price + atr * ATR_TP_MULTIPLIER;
    if (sl >= price) sl = price - atr * ATR_SL_MULTIPLIER;
    if (tp <= price) tp = price + atr * ATR_TP_MULTIPLIER;
    const rr = (tp - price) / (price - sl);
    if (rr < MIN_RR) return null;

    let conf = ai.confidence;
    conf = this.memory.adjustConfidence(symbol, 'LONG', ai.strength, rr, conf);
    if (conf < MIN_AI_CONFIDENCE) return null;

    return { symbol, price, sl, tp, rr, confidence: conf, strength: ai.strength, usedSR: !!nearestSupport };
  }

  async executeCycle() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      if (!this.circuitAllows() || killSwitchActive()) return;
      await this.risk.syncEquity();
      await this.ledger.syncFromExchange();
      await this.finalizeClosedPositions();

      const open = Array.from(this.openPositions.values());
      if (open.length >= MAX_OPEN_POSITIONS) return;
      if (!this.risk.allowsTrading()) return;

      const candidates = [];
      for (const sym of SYMBOLS) {
        const cand = await this.analyzeSymbol(sym);
        if (cand) candidates.push(cand);
      }
      if (!candidates.length) return;

      candidates.sort((a, b) => (b.confidence * (b.strength === 'EXTREME' ? 4 : b.strength === 'STRONG' ? 3 : b.strength === 'MEDIUM' ? 2 : 1)) -
        (a.confidence * (a.strength === 'EXTREME' ? 4 : a.strength === 'STRONG' ? 3 : a.strength === 'MEDIUM' ? 2 : 1)));
      const best = candidates[0];
      if (this.openPositions.has(best.symbol)) return;

      const balance = await this.getQuoteBalance();
      const amount = await this.calculateBuyAmount(best.symbol, best.price);
      if (balance < amount * best.price) return;

      const { entryPrice, amount: filled } = await this.placeBuy(best.symbol, amount);
      const sl = best.usedSR ? entryPrice * (1 - (entryPrice - best.sl) / entryPrice) : entryPrice - Indicators.calculateATR(await this.exchange.fetchOHLCV(best.symbol, TIMEFRAME, undefined, 20)) * ATR_SL_MULTIPLIER;
      const tp = best.usedSR ? entryPrice * (1 + (best.tp - entryPrice) / entryPrice) : entryPrice + Indicators.calculateATR(await this.exchange.fetchOHLCV(best.symbol, TIMEFRAME, undefined, 20)) * ATR_TP_MULTIPLIER;
      const finalRR = (tp - entryPrice) / (entryPrice - sl);
      const { tpOrderId, slOrderId } = await this.setTPSL(best.symbol, filled, entryPrice, sl, tp);
      this.openPositions.set(best.symbol, { amount: filled, entryPrice, tpOrderId, slOrderId });
      const posKey = `${best.symbol}_LONG`;
      this.pendingSetups.set(posKey, { strength: best.strength, rr: finalRR });
      this.lastTradeTime = Date.now();
      await this._sendAlert(`[BUY] ${best.symbol} @ ${entryPrice} | SL=${sl} TP=${tp} RR=${finalRR.toFixed(2)}`);
    } catch (err) {
      console.error('[CYCLE]', err);
      this.recordError();
    } finally {
      this.isRunning = false;
    }
  }

  async _sendAlert(msg) {
    if (!FONNTE_ENABLED || !FONNTE_TOKEN || !FONNTE_TARGET) return;
    try {
      const form = new URLSearchParams({ target: FONNTE_TARGET, message: msg, countryCode: FONNTE_COUNTRY_CODE }).toString();
      const req = https.request(FONNTE_API_URL, { method: 'POST', headers: { Authorization: FONNTE_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' } });
      req.write(form);
      req.end();
    } catch (e) {}
  }

  async start() {
    console.log(`
[SPOT BOT STARTED]
Symbols: ${SYMBOLS.join(', ')}
Order Size: ${ORDER_SIZE_USDT} USDT
Max Positions: ${MAX_OPEN_POSITIONS}
Min RR: ${MIN_RR}
AI Confidence: ${MIN_AI_CONFIDENCE}
Learning Memory: ${LEARNING_MEMORY_ENABLED ? 'ON' : 'OFF'}
`);
    await this.init();
    while (true) {
      const delay = getNextCandleDelay();
      await sleep(delay);
      await this.executeCycle();
    }
  }
}

// ------------------------------
//  Bootstrap
// ------------------------------
(async () => {
  const engine = new SpotTradingEngine();
  await engine.start();
})().catch(console.error);
