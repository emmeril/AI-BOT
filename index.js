require('dotenv').config();
const ccxt = require('ccxt');
const fs = require('fs');
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
const SYMBOLS = Config.list('SYMBOLS', 'BTC/USDT');
const EXCHANGE_MODE = Config.get('EXCHANGE_MODE', Config.boolean('EXCHANGE_DEMO', false) ? 'demo' : 'live').toLowerCase();
const VALID_EXCHANGE_MODES = new Set(['live', 'demo', 'testnet']);
const INTERVAL_MINUTES = Config.number('INTERVAL_MINUTES', 1);
const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;

const GRID_COUNT = Config.number('GRID_COUNT', 10);
const GRID_MODE = Config.get('GRID_MODE', 'ARITHMETIC').toUpperCase();
const GRID_LOWER_PRICE = Config.number('GRID_LOWER_PRICE', 0);
const GRID_UPPER_PRICE = Config.number('GRID_UPPER_PRICE', 0);
const GRID_RANGE_PCT = Config.number('GRID_RANGE_PCT', 5);
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

const AI_VALIDATION_ENABLED = Config.boolean('AI_VALIDATION_ENABLED', false);
const AI_VALIDATION_TIMEFRAME = Config.get('AI_VALIDATION_TIMEFRAME', '15m');
const AI_VALIDATION_LOOKBACK = Config.number('AI_VALIDATION_LOOKBACK', 80);
const AI_VALIDATION_CACHE_TTL_MS = Config.number('AI_VALIDATION_CACHE_TTL_MS', Math.max(INTERVAL_MS * 3, 60000));
const AI_VALIDATION_RETRIES = Config.number('AI_VALIDATION_RETRIES', 2);
const AI_MIN_CONFIDENCE = Config.number('AI_MIN_CONFIDENCE', 60);
const GEMINI_MODEL = Config.get('GEMINI_MODEL', 'gemini-2.0-flash-lite');

const STOP_LOSS_PRICE = Config.number('GRID_STOP_LOSS_PRICE', 0);
const TAKE_PROFIT_PRICE = Config.number('GRID_TAKE_PROFIT_PRICE', 0);
const KILL_SWITCH_ENABLED = Config.boolean('KILL_SWITCH_ENABLED', false);
const STOP_TRADING = Config.true('STOP_TRADING');
const KILL_SWITCH_FILE = Config.get('KILL_SWITCH_FILE', 'bot-paused.flag');
const KILL_SWITCH_PATH = path.resolve(process.cwd(), KILL_SWITCH_FILE);

const FONNTE_ENABLED = Config.boolean('FONNTE_ENABLED', false);
const FONNTE_TOKEN = Config.get('FONNTE_TOKEN', '');
const FONNTE_TARGET = Config.get('FONNTE_TARGET', '');
const FONNTE_API_URL = Config.get('FONNTE_API_URL', 'https://api.fonnte.com/send');
const FONNTE_COUNTRY_CODE = Config.get('FONNTE_COUNTRY_CODE', '62');

// ------------------------------
//  Utility Functions
// ------------------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function retry(fn, retries = 3, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(delay * (i + 1));
    }
  }
}

function killSwitchActive() {
  if (!KILL_SWITCH_ENABLED) return false;
  if (STOP_TRADING) return true;
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

function normalizeSymbolKey(symbol) {
  return symbol.replace(/[/:]/g, '_');
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

  load() {
    try {
      if (fs.existsSync(GRID_STATE_PATH)) {
        return JSON.parse(fs.readFileSync(GRID_STATE_PATH, 'utf8'));
      }
    } catch (err) {
      console.warn('[STATE] Failed to read grid state, starting fresh:', err.message);
    }
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      symbols: {},
      processedTradeIds: [],
      totals: { filledBuys: 0, filledSells: 0, realizedGridProfit: 0 },
    };
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    fs.writeFileSync(GRID_STATE_PATH, JSON.stringify(this.data, null, 2));
  }

  getSymbol(symbol) {
    if (!this.data.symbols[symbol]) {
      this.data.symbols[symbol] = {
        createdAt: new Date().toISOString(),
        config: {},
        orders: {},
        lastBuyByLevel: {},
        realizedGridProfit: 0,
      };
    }
    return this.data.symbols[symbol];
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

  processedTrade(id) {
    return this.data.processedTradeIds.includes(String(id));
  }

  markProcessedTrade(id) {
    this.data.processedTradeIds.push(String(id));
    this.data.processedTradeIds = this.data.processedTradeIds.slice(-2000);
    this.save();
  }
}

// ------------------------------
//  Gemini Grid Validation
// ------------------------------
class AIGridValidator {
  static cache = new Map();

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

  cacheKey(symbol, currentPrice, levels) {
    const bucket = Math.floor(Date.now() / AI_VALIDATION_CACHE_TTL_MS);
    const rangeKey = `${roundNumber(levels[0])}-${roundNumber(levels[levels.length - 1])}`;
    return `${symbol}|${AI_VALIDATION_TIMEFRAME}|${bucket}|${roundNumber(currentPrice)}|${rangeKey}`;
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
    const { currentPrice, lower, upper, levels } = context;
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
- allowBuy can be false if downside pressure is high.
- allowSell can be false if upside breakout pressure is high.
- Be conservative. Existing open orders are managed by the bot; you only validate new orders.

Symbol: ${symbol}
Current Price: ${currentPrice}
Grid Lower: ${lower}
Grid Upper: ${upper}
Grid Count: ${GRID_COUNT}
Grid Mode: ${GRID_MODE}
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

  async validate(symbol, context) {
    if (!AI_VALIDATION_ENABLED) return AIGridValidator.allow();

    const cacheKey = this.cacheKey(symbol, context.currentPrice, context.levels);
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    try {
      const ohlcv = await retry(
        () => this.exchange.fetchOHLCV(symbol, AI_VALIDATION_TIMEFRAME, undefined, AI_VALIDATION_LOOKBACK),
        AI_VALIDATION_RETRIES
      );
      const prompt = this.buildPrompt(symbol, context, this.summarizeCandles(ohlcv));
      for (let attempt = 1; attempt <= AI_VALIDATION_RETRIES + 1; attempt++) {
        try {
          const result = await this.model.generateContent(prompt);
          const decision = this.parseResponse(result.response.text());
          if (decision.confidence < AI_MIN_CONFIDENCE) {
            const blocked = AIGridValidator.block(`Low AI confidence: ${decision.reason}`, decision.confidence);
            this.setCached(cacheKey, blocked);
            return blocked;
          }
          this.setCached(cacheKey, decision);
          return decision;
        } catch (err) {
          if (attempt > AI_VALIDATION_RETRIES) throw err;
          await sleep(1000 * attempt);
        }
      }
    } catch (err) {
      const blocked = AIGridValidator.block(`AI validation failed: ${err.message}`);
      this.setCached(cacheKey, blocked);
      return blocked;
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
    this.circuitBreaker = { errors: 0, pausedUntil: 0 };
  }

  async init() {
    await retry(() => this.exchange.loadMarkets());
    for (const symbol of SYMBOLS) {
      this.ensureMarket(symbol);
      if (GRID_RECREATE_ON_START) await this.cancelGridOrders(symbol, 'recreate-on-start');
      await this.reconcileSymbol(symbol);
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
      this.circuitBreaker.pausedUntil = Date.now() + 15 * 60000;
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
    let bestIndex = 0;
    let bestDistance = Infinity;
    levels.forEach((level, index) => {
      const distance = Math.abs(level - price);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
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
    return openOrders.filter(order => managedIds.has(String(order.id)));
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
    const precisePrice = this.exchange.priceToPrecision(symbol, price);
    const preciseAmount = this.exchange.amountToPrecision(symbol, amount);
    const order = await retry(() => this.exchange.createLimitOrder(symbol, side, preciseAmount, precisePrice));
    this.state.rememberOrder(symbol, order, { levelIndex });
    console.log(`[GRID] ${symbol} ${side.toUpperCase()} level=${levelIndex} amount=${preciseAmount} price=${precisePrice}`);
    return order;
  }

  getBaseFree(balance, symbol) {
    const base = symbol.split('/')[0];
    return Number(balance?.free?.[base] || 0);
  }

  getQuoteFree(balance, symbol) {
    const quote = symbol.split('/')[1].split(':')[0];
    return Number(balance?.free?.[quote] || 0);
  }

  amountForBuy(symbol, price) {
    const market = this.exchange.markets[symbol];
    const minCost = Number(market?.limits?.cost?.min || 0);
    const notional = Math.max(this.getOrderSizeUsdt(), minCost);
    return notional / price;
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
      if (this.state.processedTrade(id)) continue;
      if (!symState.orders[String(trade.order)]) {
        this.state.markProcessedTrade(id);
        continue;
      }

      const orderMeta = symState.orders[String(trade.order)];
      const side = String(trade.side).toLowerCase();
      const price = Number(trade.price);
      const amount = Number(trade.amount);
      const levelIndex = Number(orderMeta.levelIndex);
      const fee = Number(trade.fee?.cost || 0);

      if (side === 'buy') {
        symState.lastBuyByLevel[levelIndex] = { price, amount, fee, at: trade.datetime };
        this.state.data.totals.filledBuys++;
        await this._sendAlert(`[GRID BUY] ${symbol} amount=${amount} @ ${price}`);
        if (GRID_REFILL_ON_FILLED && aiDecision.allowTrading && aiDecision.allowSell && levelIndex + 1 < levels.length) {
          const sellPrice = levels[levelIndex + 1];
          if ((sellPrice - price) / price >= GRID_MIN_PROFIT_PCT) {
            await this.placeLimit(symbol, 'sell', levelIndex + 1, sellPrice, amount);
          }
        }
      }

      if (side === 'sell') {
        const buy = symState.lastBuyByLevel[levelIndex - 1] || symState.lastBuyByLevel[levelIndex];
        const estimatedProfit = buy ? (price - buy.price) * amount - fee - Number(buy.fee || 0) : 0;
        symState.realizedGridProfit += estimatedProfit;
        this.state.data.totals.realizedGridProfit += estimatedProfit;
        this.state.data.totals.filledSells++;
        await this._sendAlert(`[GRID SELL] ${symbol} amount=${amount} @ ${price} | est profit=${estimatedProfit.toFixed(4)} USDT`);
        if (GRID_REFILL_ON_FILLED && aiDecision.allowTrading && aiDecision.allowBuy && levelIndex - 1 >= 0) {
          await this.placeLimit(symbol, 'buy', levelIndex - 1, levels[levelIndex - 1], amount);
        }
      }

      if (!openOrderIds.has(String(trade.order))) {
        this.state.forgetOrder(symbol, trade.order);
      }
      this.state.markProcessedTrade(id);
    }
  }

  async enforceRangeExits(symbol, currentPrice) {
    if (STOP_LOSS_PRICE > 0 && currentPrice <= STOP_LOSS_PRICE) {
      await this.cancelGridOrders(symbol, `stop-loss ${STOP_LOSS_PRICE}`);
      await this._sendAlert(`[GRID STOP] ${symbol} price=${currentPrice} <= ${STOP_LOSS_PRICE}`);
      return false;
    }
    if (TAKE_PROFIT_PRICE > 0 && currentPrice >= TAKE_PROFIT_PRICE) {
      await this.cancelGridOrders(symbol, `take-profit ${TAKE_PROFIT_PRICE}`);
      await this._sendAlert(`[GRID TAKE PROFIT] ${symbol} price=${currentPrice} >= ${TAKE_PROFIT_PRICE}`);
      return false;
    }
    return true;
  }

  async reconcileSymbol(symbol) {
    const context = await this.fetchContext(symbol);
    const { currentPrice, openOrders, balance, lower, upper, levels } = context;
    const canContinue = await this.enforceRangeExits(symbol, currentPrice);
    if (!canContinue) return;

    const aiDecision = await this.aiValidator.validate(symbol, context);
    if (AI_VALIDATION_ENABLED) {
      console.log(
        `[AI] ${symbol} allow=${aiDecision.allowTrading} buy=${aiDecision.allowBuy} sell=${aiDecision.allowSell} ` +
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

    const below = levels
      .map((price, index) => ({ price, index }))
      .filter(level => level.price < currentPrice)
      .sort((a, b) => b.price - a.price)
      .slice(0, GRID_MAX_ACTIVE_BUY_ORDERS);

    const above = levels
      .map((price, index) => ({ price, index }))
      .filter(level => level.price > currentPrice)
      .sort((a, b) => a.price - b.price)
      .slice(0, GRID_MAX_ACTIVE_SELL_ORDERS);

    let quoteFree = this.getQuoteFree(balance, symbol);
    let baseFree = this.getBaseFree(balance, symbol);

    for (const level of below) {
      if (!aiDecision.allowTrading || !aiDecision.allowBuy) break;
      if (activeBuyLevels.has(level.index)) continue;
      const amount = this.amountForBuy(symbol, level.price);
      const cost = amount * level.price;
      if (quoteFree < cost) break;
      await this.placeLimit(symbol, 'buy', level.index, level.price, amount);
      quoteFree -= cost;
    }

    for (const level of above) {
      if (!aiDecision.allowTrading || !aiDecision.allowSell) break;
      if (activeSellLevels.has(level.index)) continue;
      const amount = this.amountForBuy(symbol, currentPrice);
      if (baseFree < amount) break;
      await this.placeLimit(symbol, 'sell', level.index, level.price, amount);
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

  async _sendAlert(msg) {
    if (!FONNTE_ENABLED || !FONNTE_TOKEN || !FONNTE_TARGET) return;
    try {
      const form = new URLSearchParams({ target: FONNTE_TARGET, message: msg, countryCode: FONNTE_COUNTRY_CODE }).toString();
      const req = https.request(FONNTE_API_URL, {
        method: 'POST',
        headers: {
          Authorization: FONNTE_TOKEN,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      req.write(form);
      req.end();
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

// ------------------------------
//  Bootstrap
// ------------------------------
(async () => {
  const engine = new SpotGridEngine();
  await engine.start();
})().catch(console.error);
