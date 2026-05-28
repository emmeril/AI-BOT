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

const SYMBOL = process.env.SYMBOL || "DOGE/USDT:USDT";

const LEVERAGE = Number(process.env.LEVERAGE || 10);

const ORDER_SIZE_USDT = Number(process.env.ORDER_SIZE_USDT || 5);

const TIMEFRAME = process.env.TIMEFRAME || "5m";

const HTF_TIMEFRAME = process.env.HTF_TIMEFRAME || "15m";

const LOOKBACK_CANDLES = Number(process.env.LOOKBACK_CANDLES || 200);

const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || 5);

const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;

// ======================================================
// PROFIT TRACKER
// ======================================================

const PROFIT_TRACKER_ENABLED = process.env.PROFIT_TRACKER_ENABLED !== "false";

const PROFIT_TRACKER_FILE =
  process.env.PROFIT_TRACKER_FILE || "profit-ledger.json";

const PROFIT_SYNC_LIMIT = Number(process.env.PROFIT_SYNC_LIMIT || 100);

const PROFIT_LEDGER_PATH = path.resolve(process.cwd(), PROFIT_TRACKER_FILE);

// ======================================================
// RISK
// ======================================================

const MAX_FUNDING_RATE = Number(process.env.MAX_FUNDING_RATE || 0.1) / 100;

const MIN_RR = Number(process.env.MIN_RR || 1.5);

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

  console.log("🧪 DEMO FUTURES ENABLED");
}

// ======================================================
// GLOBAL
// ======================================================

let isTrading = false;

let lastSignal = null;

let signalConfirmCount = 0;

let lastPositionChangeTime = 0;

let profitLedger = loadProfitLedger();

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

      console.warn(`⚠️ Retry ${i + 1}/${retries}:`, err.message);

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

function createEmptyProfitLedger() {
  const now = new Date().toISOString();

  return {
    symbol: SYMBOL,

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
    symbol: ledger.symbol || SYMBOL,
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
    console.warn("⚠️ Profit ledger reset:", err.message);

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
💰 PROFIT SUMMARY

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

async function syncProfitLedger() {
  if (!PROFIT_TRACKER_ENABLED) return;

  try {
    const since = profitLedger.lastTradeTimestamp
      ? profitLedger.lastTradeTimestamp - 1
      : undefined;

    const trades = await retry(() =>
      exchange.fetchMyTrades(SYMBOL, since, PROFIT_SYNC_LIMIT),
    );

    const sortedTrades = trades
      .filter((trade) => !trade.symbol || trade.symbol === SYMBOL)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

    let newTrades = 0;

    for (const trade of sortedTrades) {
      if (applyTradeToProfitLedger(trade)) {
        newTrades++;
      }
    }

    if (newTrades > 0) saveProfitLedger();

    logProfitSummary(newTrades);
  } catch (err) {
    console.warn("⚠️ Profit sync skipped:", err.message);
  }
}

// ======================================================
// MARKET
// ======================================================

async function getMarketContext() {
  const [ticker, funding] = await Promise.all([
    retry(() => exchange.fetchTicker(SYMBOL)),

    retry(() => exchange.fetchFundingRate(SYMBOL)),
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

async function getMarketSnapshot(context, timeframe = TIMEFRAME) {
  const ohlcv = await retry(() =>
    exchange.fetchOHLCV(SYMBOL, timeframe, undefined, LOOKBACK_CANDLES),
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
// AI SIGNAL
// ======================================================

async function getAISignal(snapshot, htfSnapshot) {
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

MARKET DATA:

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

  const result = await model.generateContent(prompt);

  const text = result.response
    .text()
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  return JSON.parse(text);
}

// ======================================================
// POSITION
// ======================================================

async function getCurrentPosition() {
  const positions = await retry(() => exchange.fetchPositions([SYMBOL]));

  const pos = positions.find(
    (p) => p.symbol === SYMBOL && Number(p.contracts) > 0,
  );

  if (!pos) return null;

  return {
    side: pos.side,

    contracts: Number(pos.contracts),

    entryPrice: Number(pos.entryPrice),
  };
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

async function calculateContracts(usdt, price) {
  const market = exchange.markets[SYMBOL];

  const exposure = usdt * LEVERAGE;

  const contracts = exposure / price;

  const minCost = market?.limits?.cost?.min || 5;

  const minContracts = minCost / price;

  const finalContracts = contracts < minContracts ? minContracts : contracts;

  return Number(exchange.amountToPrecision(SYMBOL, finalContracts));
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

  let tp;
  let sl;

  if (signal === "LONG") {
    tp = entry + atr * tpMultiplier;

    sl = entry - atr;
  } else {
    tp = entry - atr * tpMultiplier;

    sl = entry + atr;
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
    console.warn("⚠️ AI filter blocked: tradeAllowed=false");

    return false;
  }

  if (!ALLOWED_AI_STRENGTHS.includes(strength)) {
    console.warn(`⚠️ AI filter blocked: strength ${strength || "UNKNOWN"}`);

    return false;
  }

  if (confidence < MIN_AI_CONFIDENCE) {
    console.warn(
      `⚠️ AI filter blocked: confidence ${confidence}/${MIN_AI_CONFIDENCE}`,
    );

    return false;
  }

  return true;
}

// ======================================================
// CANCEL
// ======================================================

async function cancelAllOrders() {
  try {
    const orders = await retry(() => exchange.fetchOpenOrders(SYMBOL));

    for (const o of orders) {
      try {
        await retry(() => exchange.cancelOrder(o.id, SYMBOL));

        console.log(`🗑️ Cancel ${o.id}`);
      } catch (err) {
        console.error(err.message);
      }
    }
  } catch (err) {
    console.error(err.message);
  }
}

// ======================================================
// OPEN POSITION
// ======================================================

async function openPosition(signal, context) {
  await retry(() => exchange.setLeverage(LEVERAGE, SYMBOL));

  const balance = await getAvailableBalance();

  if (balance < ORDER_SIZE_USDT) {
    console.warn("⛔ Balance insufficient");

    return null;
  }

  const side = signal === "LONG" ? "buy" : "sell";

  const amount = await calculateContracts(ORDER_SIZE_USDT, context.price);

  console.log(`
🚀 OPEN ${signal}

Contracts:
${amount}
`);

  const order = await retry(() =>
    exchange.createMarketOrder(SYMBOL, side, amount),
  );

  console.log(`
✅ ORDER:
${order.id}
`);

  lastPositionChangeTime = Date.now();

  await sleep(3000);

  return await getCurrentPosition();
}

// ======================================================
// CLOSE POSITION
// ======================================================

async function closePosition(position) {
  const side = position.side === "long" ? "sell" : "buy";

  await retry(() =>
    exchange.createMarketOrder(SYMBOL, side, position.contracts, {
      reduceOnly: true,
    }),
  );

  await cancelAllOrders();

  console.log("🔻 POSITION CLOSED");
}

// ======================================================
// STOP LOSS MARKET (NEW)
// ======================================================

async function createStopLossOrder(position, slPrice) {
  const side = position.side === "long" ? "sell" : "buy";
  const stopPrice = exchange.priceToPrecision(SYMBOL, slPrice);

  console.log(`
🛑 CREATE STOP LOSS MARKET
Side: ${side}
Mode: close remaining position
Stop trigger: ${stopPrice}
`);

  await retry(() =>
    exchange.createOrder(SYMBOL, "STOP_MARKET", side, undefined, undefined, {
      stopPrice: stopPrice,
      closePosition: true,
      workingType: "MARK_PRICE",
    }),
  );

  console.log("✅ Stop loss order aktif");
}

// ======================================================
// PARTIAL TP
// ======================================================

async function createPartialTPs(position, entryPrice, atr) {
  const side = position.side === "long" ? "sell" : "buy";

  const isLong = position.side === "long";

  const totalContracts = position.contracts;

  const tp1Qty = Number(
    exchange.amountToPrecision(SYMBOL, totalContracts * (TP1_PERCENT / 100)),
  );

  const tp2Qty = Number(
    exchange.amountToPrecision(SYMBOL, totalContracts * (TP2_PERCENT / 100)),
  );

  const runnerQty = Number(
    exchange.amountToPrecision(SYMBOL, totalContracts - tp1Qty - tp2Qty),
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

  tp1Price = Number(exchange.priceToPrecision(SYMBOL, tp1Price));

  tp2Price = Number(exchange.priceToPrecision(SYMBOL, tp2Price));

  console.log(`
🎯 TP1:
${tp1Price}

🎯 TP2:
${tp2Price}
`);

  if (tp1Qty > 0) {
    await retry(() =>
      exchange.createOrder(
        SYMBOL,
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
      `✅ TP1 CREATED:
${tp1Qty}`,
    );
  }

  if (tp2Qty > 0) {
    await retry(() =>
      exchange.createOrder(
        SYMBOL,
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
      `✅ TP2 CREATED:
${tp2Qty}`,
    );
  }

  if (runnerQty > 0) {
    const callbackRate = calculateCallbackRate(atr, entryPrice);

    await retry(() =>
      exchange.createOrder(
        SYMBOL,
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
📈 RUNNER TRAILING ACTIVE

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

async function tradingCycle() {
  if (isTrading) {
    console.log("⏳ Previous cycle running");

    return;
  }

  isTrading = true;

  try {
    console.log(`
========== ${new Date().toISOString()} ==========
`);

    await syncProfitLedger();

    const context = await getMarketContext();

    const snapshot = await getMarketSnapshot(context, TIMEFRAME);

    const htfSnapshot = await getMarketSnapshot(context, HTF_TIMEFRAME);

    // ==================================================
    // SIDEWAYS FILTER
    // ==================================================

    if (snapshot.emaGap < SIDEWAYS_EMA_GAP) {
      console.log("⚠️ Sideways market skip");

      return;
    }

    // ==================================================
    // AI
    // ==================================================

    console.log("🤖 Asking Gemini...");

    const ai = await getAISignal(snapshot, htfSnapshot);

    console.log(ai);

    const signal = ai.signal?.toUpperCase();

    const aiStrength = String(ai.strength || "").toUpperCase();

    if (!["LONG", "SHORT", "HOLD"].includes(signal)) {
      console.warn("⚠️ Invalid AI signal");

      return;
    }

    if (signal === "HOLD") {
      console.log("⏸️ HOLD");

      return;
    }

    if (LONG_ONLY && signal === "SHORT") {
      console.log("⏸️ SHORT ignored in LONG ONLY mode");

      return;
    }

    if (!aiFilterSafe(ai)) {
      return;
    }

    // ==================================================
    // CONFIRMATION
    // ==================================================

    if (signal === lastSignal) {
      signalConfirmCount++;
    } else {
      signalConfirmCount = 1;
      lastSignal = signal;
    }

    console.log(`
📈 SIGNAL CONFIRM:
${signalConfirmCount}/${REQUIRED_CONFIRMATION}
`);

    const confirmed =
      signalConfirmCount >= REQUIRED_CONFIRMATION ||
      aiStrength === "STRONG" ||
      aiStrength === "EXTREME";

    if (!confirmed) {
      console.log("⚠️ Signal not confirmed");

      return;
    }

    // ==================================================
    // FUNDING FILTER
    // ==================================================

    if (!fundingSafe(signal, context.fundingRate)) {
      console.warn("⚠️ Funding unsafe");

      return;
    }

    const position = await getCurrentPosition();

    console.log("📌 POSITION:", position || "NONE");

    // ==================================================
    // SAME POSITION
    // ==================================================

    if (position && position.side === signal.toLowerCase()) {
      console.log("📈 Position already exists");

      return;
    }

    // ==================================================
    // REVERSAL COOLDOWN
    // ==================================================

    const cooldownMs = REVERSAL_COOLDOWN_MINUTES * 60 * 1000;

    if (position && Date.now() - lastPositionChangeTime < cooldownMs) {
      console.log("⏳ Reversal cooldown active");

      return;
    }

    // ==================================================
    // RR
    // ==================================================

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

    console.log(`
📈 RR:
${rr.toFixed(2)}
`);

    if (rr < MIN_RR) {
      console.warn("⚠️ RR too low");

      return;
    }

    // ==================================================
    // CLOSE OLD POSITION
    // ==================================================

    if (position) {
      await closePosition(position);
    }

    await cancelAllOrders();

    // ==================================================
    // OPEN NEW POSITION
    // ==================================================

    const newPos = await openPosition(signal, context);

    if (!newPos) return;

    // ==================================================
    // CREATE STOP LOSS (using actual entry price)
    // ==================================================

    const actualEntry = newPos.entryPrice;
    const slPrice =
      signal === "LONG"
        ? actualEntry - snapshot.atr
        : actualEntry + snapshot.atr;

    await createStopLossOrder(newPos, slPrice);

    // ==================================================
    // CREATE PARTIAL TPS
    // ==================================================

    await createPartialTPs(newPos, actualEntry, snapshot.atr);
  } catch (err) {
    console.error("❌ Trading Error:", err.message);
  } finally {
    isTrading = false;
  }
}

// ======================================================
// MAIN
// ======================================================

async function main() {
  console.log(`
🔥 SMART AI FUTURES BOT

PAIR:
${SYMBOL}
LEVERAGE:
${LEVERAGE}x
ORDER:
${ORDER_SIZE_USDT} USDT
TIMEFRAME:
${TIMEFRAME}
HTF:
${HTF_TIMEFRAME}
MODEL:
${GEMINI_MODEL}
`);

  await retry(() => exchange.loadMarkets());

  await syncProfitLedger();

  while (true) {
    try {
      const delay = getNextCandleDelay();

      console.log(`
⏳ Waiting next candle:
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
