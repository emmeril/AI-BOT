require("dotenv").config();

const fs = require("fs");
const ccxt = require("ccxt");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const DEFAULT_GRID = {
  minRr: [1.2, 1.5, 1.8, 2.0],
  atrTpMultiplier: [1.5, 1.8, 2.2, 2.6],
  tp1Rr: [0.8, 1.0, 1.2],
  tp2Rr: [1.6, 2.0, 2.4],
  sidewaysEmaGap: [0.03, 0.04, 0.06, 0.08],
  requiredConfirmation: [1, 2, 3],
  trailingCallbackMin: [0.3, 0.5],
  trailingCallbackMax: [1.2, 1.5, 2.0],
};

const CONFIG_KEYS = {
  symbol: "SYMBOL",
  leverage: "LEVERAGE",
  orderSizeUsdt: "ORDER_SIZE_USDT",
  timeframe: "TIMEFRAME",
  htfTimeframe: "HTF_TIMEFRAME",
  lookbackCandles: "LOOKBACK_CANDLES",
  longOnly: "LONG_ONLY",
  minRr: "MIN_RR",
  atrTpMultiplier: "ATR_TP_MULTIPLIER",
  trailingCallbackMin: "TRAILING_CALLBACK_MIN",
  trailingCallbackMax: "TRAILING_CALLBACK_MAX",
  tp1Percent: "TP1_PERCENT",
  tp2Percent: "TP2_PERCENT",
  tp1Rr: "TP1_RR",
  tp2Rr: "TP2_RR",
  requiredConfirmation: "REQUIRED_CONFIRMATION",
  sidewaysEmaGap: "SIDEWAYS_EMA_GAP",
};

function parseArgs(argv) {
  const args = {};

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (arg === "--no-ai") {
      args.noAi = true;
      continue;
    }

    if (arg === "--no-write") {
      args.noWrite = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=");
    const nextValue = argv[i + 1];
    const value =
      inlineValue ??
      (nextValue && !nextValue.startsWith("--") ? argv[++i] : "true");

    args[toCamel(rawKey)] = value;
  }

  return args;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function printHelp() {
  console.log(`
Auto tuner untuk config trading.

Usage:
  node tune.js --days 30
  node tune.js --symbol XRP/USDT:USDT --timeframe 15m --htf-timeframe 30m
  node tune.js --days 60 --top 10 --no-ai

Options:
  --symbol              Default: SYMBOL dari .env
  --timeframe           Default: TIMEFRAME dari .env
  --htf-timeframe       Default: HTF_TIMEFRAME dari .env
  --days                Jumlah hari data historis. Default: 30
  --top                 Jumlah kandidat disimpan. Default: 10
  --initial-balance     Modal simulasi USDT. Default: 1000
  --fee-rate            Fee per order side. Default: 0.0004
  --no-ai               Skip ringkasan Gemini
  --no-write            Jangan tulis tuned-config.json dan .env.tuned
`);
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanEnv(name, fallback) {
  if (process.env[name] === undefined) {
    return fallback;
  }

  return process.env[name] !== "false";
}

function parseListEnv(name, fallback, mapper = Number) {
  if (!process.env[name]) {
    return fallback;
  }

  return process.env[name]
    .split(",")
    .map((item) => mapper(item.trim()))
    .filter((item) => item !== "" && item !== null && item !== undefined);
}

function makeConfig(args) {
  return {
    symbol: args.symbol || process.env.SYMBOL || "DOGE/USDT:USDT",
    timeframe: args.timeframe || process.env.TIMEFRAME || "15m",
    htfTimeframe: args.htfTimeframe || process.env.HTF_TIMEFRAME || "30m",
    days: Number(args.days || process.env.TUNER_DAYS || 30),
    top: Number(args.top || process.env.TUNER_TOP || 10),
    initialBalance: Number(
      args.initialBalance || process.env.TUNER_INITIAL_BALANCE || 1000,
    ),
    feeRate: Number(args.feeRate || process.env.TUNER_FEE_RATE || 0.0004),
    leverage: numberEnv("LEVERAGE", 10),
    orderSizeUsdt: numberEnv("ORDER_SIZE_USDT", 100),
    lookbackCandles: numberEnv("LOOKBACK_CANDLES", 200),
    longOnly: booleanEnv("LONG_ONLY", true),
    tp1Percent: numberEnv("TP1_PERCENT", 30),
    tp2Percent: numberEnv("TP2_PERCENT", 40),
    minTrades: Number(args.minTrades || process.env.TUNER_MIN_TRADES || 8),
    noAi: Boolean(args.noAi),
    noWrite: Boolean(args.noWrite),
    grid: {
      minRr: parseListEnv("TUNER_MIN_RR", DEFAULT_GRID.minRr),
      atrTpMultiplier: parseListEnv(
        "TUNER_ATR_TP_MULTIPLIER",
        DEFAULT_GRID.atrTpMultiplier,
      ),
      tp1Rr: parseListEnv("TUNER_TP1_RR", DEFAULT_GRID.tp1Rr),
      tp2Rr: parseListEnv("TUNER_TP2_RR", DEFAULT_GRID.tp2Rr),
      sidewaysEmaGap: parseListEnv(
        "TUNER_SIDEWAYS_EMA_GAP",
        DEFAULT_GRID.sidewaysEmaGap,
      ),
      requiredConfirmation: parseListEnv(
        "TUNER_REQUIRED_CONFIRMATION",
        DEFAULT_GRID.requiredConfirmation,
        (value) => Number.parseInt(value, 10),
      ),
      trailingCallbackMin: parseListEnv(
        "TUNER_TRAILING_CALLBACK_MIN",
        DEFAULT_GRID.trailingCallbackMin,
      ),
      trailingCallbackMax: parseListEnv(
        "TUNER_TRAILING_CALLBACK_MAX",
        DEFAULT_GRID.trailingCallbackMax,
      ),
    },
  };
}

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

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  if (losses === 0) {
    return 100;
  }

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateATR(ohlcv) {
  const trs = [];

  for (let i = 1; i < ohlcv.length; i++) {
    const prevClose = ohlcv[i - 1][4];
    const high = ohlcv[i][2];
    const low = ohlcv[i][3];

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose),
      ),
    );
  }

  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function buildSnapshots(ohlcv, lookbackCandles) {
  const snapshots = new Map();
  const minCandles = Math.max(60, lookbackCandles);

  for (let i = minCandles; i < ohlcv.length; i++) {
    const window = ohlcv.slice(Math.max(0, i - lookbackCandles + 1), i + 1);
    const closes = window.map((candle) => candle[4]);
    const ema20 = calculateEMA(closes.slice(-20), 20);
    const ema50 = calculateEMA(closes.slice(-50), 50);
    const prevEma20 = calculateEMA(closes.slice(-21, -1), 20);
    const prevEma50 = calculateEMA(closes.slice(-51, -1), 50);
    const latestVolume = window[window.length - 1][5];
    const prevVolume = window[window.length - 2][5] || latestVolume;
    const price = window[window.length - 1][4];

    snapshots.set(ohlcv[i][0], {
      index: i,
      timestamp: ohlcv[i][0],
      price,
      ema20,
      ema50,
      ema20Slope: ema20 - prevEma20,
      ema50Slope: ema50 - prevEma50,
      emaGap: (Math.abs(ema20 - ema50) / price) * 100,
      rsi: calculateRSI(closes.slice(-15)),
      atr: calculateATR(window.slice(-15)),
      volumeChange:
        prevVolume === 0 ? 0 : ((latestVolume - prevVolume) / prevVolume) * 100,
      trend:
        ema20 > ema50 ? "UPTREND" : ema20 < ema50 ? "DOWNTREND" : "SIDEWAYS",
    });
  }

  return snapshots;
}

function getLatestSnapshotBefore(snapshots, timestamps, timestamp) {
  let left = 0;
  let right = timestamps.length - 1;
  let best = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);

    if (timestamps[mid] <= timestamp) {
      best = timestamps[mid];
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return best === null ? null : snapshots.get(best);
}

function getSignal(snapshot, htfSnapshot, params, longOnly) {
  if (!snapshot || !htfSnapshot || snapshot.emaGap < params.sidewaysEmaGap) {
    return "HOLD";
  }

  const longSetup =
    snapshot.trend === "UPTREND" &&
    htfSnapshot.trend === "UPTREND" &&
    snapshot.ema20Slope > 0 &&
    snapshot.ema50Slope >= 0 &&
    snapshot.rsi >= 45 &&
    snapshot.rsi <= 76 &&
    snapshot.volumeChange > -70;

  if (longSetup) {
    return "LONG";
  }

  if (longOnly) {
    return "HOLD";
  }

  const shortSetup =
    snapshot.trend === "DOWNTREND" &&
    htfSnapshot.trend === "DOWNTREND" &&
    snapshot.ema20Slope < 0 &&
    snapshot.ema50Slope <= 0 &&
    snapshot.rsi >= 24 &&
    snapshot.rsi <= 55 &&
    snapshot.volumeChange > -70;

  return shortSetup ? "SHORT" : "HOLD";
}

function calculateCallbackRate(atr, price, params) {
  const raw = (atr / price) * 100;
  return Math.min(
    params.trailingCallbackMax,
    Math.max(params.trailingCallbackMin, raw),
  );
}

function openSimulatedPosition(signal, candle, snapshot, params, config) {
  const entry = candle[1];
  const isLong = signal === "LONG";
  const tp = isLong
    ? entry + snapshot.atr * params.atrTpMultiplier
    : entry - snapshot.atr * params.atrTpMultiplier;
  const sl = isLong ? entry - snapshot.atr : entry + snapshot.atr;
  const rr = isLong ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);

  if (!Number.isFinite(rr) || rr < params.minRr) {
    return null;
  }

  const sizeUsdt = Math.min(config.orderSizeUsdt, config.initialBalance);
  const notional = sizeUsdt * config.leverage;
  const qty = notional / entry;
  const tp1Qty = qty * (config.tp1Percent / 100);
  const tp2Qty = qty * (config.tp2Percent / 100);
  const runnerQty = Math.max(0, qty - tp1Qty - tp2Qty);

  return {
    signal,
    entry,
    entryTime: candle[0],
    sl,
    tp,
    tp1: isLong
      ? entry + snapshot.atr * params.tp1Rr
      : entry - snapshot.atr * params.tp1Rr,
    tp2: isLong
      ? entry + snapshot.atr * params.tp2Rr
      : entry - snapshot.atr * params.tp2Rr,
    qty,
    remainingQty: qty,
    tp1Qty,
    tp2Qty,
    runnerQty,
    tp1Filled: false,
    tp2Filled: false,
    peak: entry,
    trough: entry,
    callbackRate: calculateCallbackRate(snapshot.atr, entry, params),
    realizedPnl: -(notional * config.feeRate),
    notional,
  };
}

function settleQty(position, qty, price, feeRate) {
  if (qty <= 0) {
    return 0;
  }

  const gross =
    position.signal === "LONG"
      ? (price - position.entry) * qty
      : (position.entry - price) * qty;
  const fee = price * qty * feeRate;

  position.remainingQty -= qty;
  return gross - fee;
}

function updatePosition(position, candle, feeRate) {
  const high = candle[2];
  const low = candle[3];
  const close = candle[4];
  const isLong = position.signal === "LONG";

  if (isLong) {
    if (low <= position.sl) {
      position.realizedPnl += settleQty(
        position,
        position.remainingQty,
        position.sl,
        feeRate,
      );
      return closeTrade(position, candle[0], position.sl, "SL");
    }

    if (!position.tp1Filled && high >= position.tp1) {
      position.realizedPnl += settleQty(
        position,
        position.tp1Qty,
        position.tp1,
        feeRate,
      );
      position.tp1Filled = true;
    }

    if (!position.tp2Filled && high >= position.tp2) {
      position.realizedPnl += settleQty(
        position,
        position.tp2Qty,
        position.tp2,
        feeRate,
      );
      position.tp2Filled = true;
    }

    position.peak = Math.max(position.peak, high);
    const trailingStop = position.peak * (1 - position.callbackRate / 100);

    if (
      position.tp1Filled &&
      position.remainingQty > 0 &&
      low <= trailingStop
    ) {
      position.realizedPnl += settleQty(
        position,
        position.remainingQty,
        trailingStop,
        feeRate,
      );
      return closeTrade(position, candle[0], trailingStop, "TRAILING");
    }

    if (high >= position.tp && position.remainingQty > 0) {
      position.realizedPnl += settleQty(
        position,
        position.remainingQty,
        position.tp,
        feeRate,
      );
      return closeTrade(position, candle[0], position.tp, "TP");
    }
  } else {
    if (high >= position.sl) {
      position.realizedPnl += settleQty(
        position,
        position.remainingQty,
        position.sl,
        feeRate,
      );
      return closeTrade(position, candle[0], position.sl, "SL");
    }

    if (!position.tp1Filled && low <= position.tp1) {
      position.realizedPnl += settleQty(
        position,
        position.tp1Qty,
        position.tp1,
        feeRate,
      );
      position.tp1Filled = true;
    }

    if (!position.tp2Filled && low <= position.tp2) {
      position.realizedPnl += settleQty(
        position,
        position.tp2Qty,
        position.tp2,
        feeRate,
      );
      position.tp2Filled = true;
    }

    position.trough = Math.min(position.trough, low);
    const trailingStop = position.trough * (1 + position.callbackRate / 100);

    if (
      position.tp1Filled &&
      position.remainingQty > 0 &&
      high >= trailingStop
    ) {
      position.realizedPnl += settleQty(
        position,
        position.remainingQty,
        trailingStop,
        feeRate,
      );
      return closeTrade(position, candle[0], trailingStop, "TRAILING");
    }

    if (low <= position.tp && position.remainingQty > 0) {
      position.realizedPnl += settleQty(
        position,
        position.remainingQty,
        position.tp,
        feeRate,
      );
      return closeTrade(position, candle[0], position.tp, "TP");
    }
  }

  if (position.remainingQty <= 0) {
    return closeTrade(position, candle[0], close, "PARTIALS_DONE");
  }

  return null;
}

function closeTrade(position, exitTime, exitPrice, reason) {
  return {
    signal: position.signal,
    entry: position.entry,
    exit: exitPrice,
    entryTime: position.entryTime,
    exitTime,
    reason,
    pnl: position.realizedPnl,
    returnPct: (position.realizedPnl / position.notional) * 100,
  };
}

function backtest(
  baseOhlcv,
  baseSnapshots,
  htfSnapshots,
  htfTimestamps,
  params,
  config,
) {
  let balance = config.initialBalance;
  let peakBalance = balance;
  let maxDrawdownPct = 0;
  let position = null;
  let lastSignal = null;
  let confirmCount = 0;
  const trades = [];

  for (let i = 0; i < baseOhlcv.length - 1; i++) {
    const candle = baseOhlcv[i];

    if (position) {
      const closed = updatePosition(position, candle, config.feeRate);

      if (closed) {
        balance += closed.pnl;
        trades.push(closed);
        position = null;
        peakBalance = Math.max(peakBalance, balance);
        maxDrawdownPct = Math.max(
          maxDrawdownPct,
          ((peakBalance - balance) / peakBalance) * 100,
        );
      }

      continue;
    }

    const snapshot = baseSnapshots.get(candle[0]);
    const htfSnapshot = getLatestSnapshotBefore(
      htfSnapshots,
      htfTimestamps,
      candle[0],
    );
    const signal = getSignal(snapshot, htfSnapshot, params, config.longOnly);

    if (signal === "HOLD") {
      confirmCount = 0;
      lastSignal = null;
      continue;
    }

    if (signal === lastSignal) {
      confirmCount++;
    } else {
      confirmCount = 1;
      lastSignal = signal;
    }

    if (confirmCount < params.requiredConfirmation) {
      continue;
    }

    const nextCandle = baseOhlcv[i + 1];
    position = openSimulatedPosition(
      signal,
      nextCandle,
      snapshot,
      params,
      config,
    );

    if (!position) {
      continue;
    }

    i++;
  }

  if (position) {
    const lastCandle = baseOhlcv[baseOhlcv.length - 1];
    position.realizedPnl += settleQty(
      position,
      position.remainingQty,
      lastCandle[4],
      config.feeRate,
    );
    const closed = closeTrade(position, lastCandle[0], lastCandle[4], "END");
    balance += closed.pnl;
    trades.push(closed);
  }

  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const netPnl = balance - config.initialBalance;
  const profitFactor =
    grossLoss === 0 ? (grossProfit > 0 ? 99 : 0) : grossProfit / grossLoss;
  const winRate = trades.length === 0 ? 0 : (wins.length / trades.length) * 100;
  const avgPnl = trades.length === 0 ? 0 : netPnl / trades.length;
  const score =
    netPnl +
    profitFactor * 20 +
    winRate * 0.6 -
    maxDrawdownPct * 3 +
    Math.min(trades.length, 80) * 0.35;

  return {
    params,
    score,
    netPnl,
    endingBalance: balance,
    returnPct: (netPnl / config.initialBalance) * 100,
    trades: trades.length,
    winRate,
    profitFactor,
    maxDrawdownPct,
    avgPnl,
    wins: wins.length,
    losses: losses.length,
  };
}

function makeParamGrid(grid) {
  const results = [];

  for (const minRr of grid.minRr)
    for (const atrTpMultiplier of grid.atrTpMultiplier)
      for (const tp1Rr of grid.tp1Rr)
        for (const tp2Rr of grid.tp2Rr)
          for (const sidewaysEmaGap of grid.sidewaysEmaGap)
            for (const requiredConfirmation of grid.requiredConfirmation)
              for (const trailingCallbackMin of grid.trailingCallbackMin)
                for (const trailingCallbackMax of grid.trailingCallbackMax) {
                  if (
                    tp2Rr <= tp1Rr ||
                    trailingCallbackMax < trailingCallbackMin
                  ) {
                    continue;
                  }

                  results.push({
                    minRr,
                    atrTpMultiplier,
                    tp1Rr,
                    tp2Rr,
                    sidewaysEmaGap,
                    requiredConfirmation,
                    trailingCallbackMin,
                    trailingCallbackMax,
                  });
                }

  return results;
}

async function fetchOhlcv(exchange, symbol, timeframe, since, until) {
  const all = [];
  let cursor = since;
  const timeframeMs = exchange.parseTimeframe(timeframe) * 1000;

  while (cursor < until) {
    const candles = await exchange.fetchOHLCV(symbol, timeframe, cursor, 1000);

    if (!candles.length) {
      break;
    }

    for (const candle of candles) {
      if (candle[0] >= since && candle[0] <= until) {
        all.push(candle);
      }
    }

    const nextCursor = candles[candles.length - 1][0] + timeframeMs;

    if (nextCursor <= cursor) {
      break;
    }

    cursor = nextCursor;
  }

  const unique = new Map(all.map((candle) => [candle[0], candle]));
  return [...unique.values()].sort((a, b) => a[0] - b[0]);
}

function writeOutputs(config, bestResults, aiReview) {
  const best = bestResults[0];
  const tuned = {
    generatedAt: new Date().toISOString(),
    symbol: config.symbol,
    timeframe: config.timeframe,
    htfTimeframe: config.htfTimeframe,
    days: config.days,
    best,
    topResults: bestResults,
    aiReview,
  };

  fs.writeFileSync("tuned-config.json", JSON.stringify(tuned, null, 2));

  const envLines = [
    "# Generated by node tune.js. Review before using live.",
    `${CONFIG_KEYS.symbol}=${config.symbol}`,
    `${CONFIG_KEYS.leverage}=${config.leverage}`,
    `${CONFIG_KEYS.orderSizeUsdt}=${config.orderSizeUsdt}`,
    `${CONFIG_KEYS.timeframe}=${config.timeframe}`,
    `${CONFIG_KEYS.htfTimeframe}=${config.htfTimeframe}`,
    `${CONFIG_KEYS.lookbackCandles}=${config.lookbackCandles}`,
    `${CONFIG_KEYS.longOnly}=${config.longOnly}`,
    `${CONFIG_KEYS.minRr}=${best.params.minRr}`,
    `${CONFIG_KEYS.atrTpMultiplier}=${best.params.atrTpMultiplier}`,
    `${CONFIG_KEYS.trailingCallbackMin}=${best.params.trailingCallbackMin}`,
    `${CONFIG_KEYS.trailingCallbackMax}=${best.params.trailingCallbackMax}`,
    `${CONFIG_KEYS.tp1Percent}=${config.tp1Percent}`,
    `${CONFIG_KEYS.tp2Percent}=${config.tp2Percent}`,
    `${CONFIG_KEYS.tp1Rr}=${best.params.tp1Rr}`,
    `${CONFIG_KEYS.tp2Rr}=${best.params.tp2Rr}`,
    `${CONFIG_KEYS.requiredConfirmation}=${best.params.requiredConfirmation}`,
    `${CONFIG_KEYS.sidewaysEmaGap}=${best.params.sidewaysEmaGap}`,
  ];

  fs.writeFileSync(".env.tuned", `${envLines.join("\n")}\n`);
}

async function askAiReview(config, bestResults) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || apiKey === "your_gemini_api_key") {
    return null;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-1.5-flash-lite",
  });

  const prompt = `
You are reviewing crypto futures strategy backtest optimization results.

Be conservative. Do not recommend live trading if the result is weak.
Explain in Indonesian.

Context:
${JSON.stringify(
  {
    symbol: config.symbol,
    timeframe: config.timeframe,
    htfTimeframe: config.htfTimeframe,
    days: config.days,
    initialBalance: config.initialBalance,
    orderSizeUsdt: config.orderSizeUsdt,
    leverage: config.leverage,
    longOnly: config.longOnly,
    topResults: bestResults,
  },
  null,
  2,
)}

Return short JSON only:
{
  "verdict": "SAFE_TO_DEMO_TEST",
  "reason": "...",
  "warnings": ["..."],
  "recommendedConfigRank": 1
}
`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response
      .text()
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(text);
  } catch (err) {
    return {
      verdict: "AI_REVIEW_FAILED",
      reason: err.message,
      warnings: ["Backtest tetap selesai, tapi ringkasan AI gagal dibuat."],
      recommendedConfigRank: 1,
    };
  }
}

function printResults(config, results, aiReview) {
  console.log("\nTop configs:\n");

  results.forEach((result, index) => {
    console.log(
      [
        `#${index + 1}`,
        `score=${result.score.toFixed(2)}`,
        `return=${result.returnPct.toFixed(2)}%`,
        `pnl=${result.netPnl.toFixed(2)} USDT`,
        `trades=${result.trades}`,
        `winrate=${result.winRate.toFixed(1)}%`,
        `pf=${result.profitFactor.toFixed(2)}`,
        `dd=${result.maxDrawdownPct.toFixed(2)}%`,
        `params=${JSON.stringify(result.params)}`,
      ].join(" | "),
    );
  });

  if (aiReview) {
    console.log("\nAI review:");
    console.log(JSON.stringify(aiReview, null, 2));
  }

  if (!config.noWrite) {
    console.log("\nSaved: tuned-config.json and .env.tuned");
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  const config = makeConfig(args);
  const exchange = new ccxt.binance({
    enableRateLimit: true,
    options: {
      defaultType: "future",
    },
  });

  const until = Date.now();
  const since = until - config.days * 24 * 60 * 60 * 1000;

  console.log(
    `Fetching ${config.symbol} ${config.timeframe}/${config.htfTimeframe} for ${config.days} days...`,
  );
  await exchange.loadMarkets();

  const [baseOhlcv, htfOhlcv] = await Promise.all([
    fetchOhlcv(exchange, config.symbol, config.timeframe, since, until),
    fetchOhlcv(exchange, config.symbol, config.htfTimeframe, since, until),
  ]);

  if (baseOhlcv.length < config.lookbackCandles + 20) {
    throw new Error(
      `Not enough ${config.timeframe} candles: ${baseOhlcv.length}`,
    );
  }

  if (htfOhlcv.length < 80) {
    throw new Error(
      `Not enough ${config.htfTimeframe} candles: ${htfOhlcv.length}`,
    );
  }

  console.log(`Candles: ${baseOhlcv.length} base, ${htfOhlcv.length} HTF`);

  const baseSnapshots = buildSnapshots(baseOhlcv, config.lookbackCandles);
  const htfSnapshots = buildSnapshots(
    htfOhlcv,
    Math.min(config.lookbackCandles, 120),
  );
  const htfTimestamps = [...htfSnapshots.keys()].sort((a, b) => a - b);
  const paramGrid = makeParamGrid(config.grid);

  console.log(`Testing ${paramGrid.length} parameter combinations...`);

  const results = paramGrid
    .map((params) =>
      backtest(
        baseOhlcv,
        baseSnapshots,
        htfSnapshots,
        htfTimestamps,
        params,
        config,
      ),
    )
    .filter((result) => result.trades >= config.minTrades)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.top);

  if (!results.length) {
    throw new Error(
      `No config reached TUNER_MIN_TRADES=${config.minTrades}. Try more days or lower --min-trades.`,
    );
  }

  const aiReview = config.noAi ? null : await askAiReview(config, results);

  if (!config.noWrite) {
    writeOutputs(config, results, aiReview);
  }

  printResults(config, results, aiReview);
}

main().catch((err) => {
  console.error("\nTuner failed:", err.message);
  process.exitCode = 1;
});
