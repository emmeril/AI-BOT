require("dotenv").config();
const ccxt = require("ccxt");
const fs = require("fs");
const path = require("path");

const DEFAULT_MEME_SYMBOLS =
  "DOGE/USDT:USDT,1000SHIB/USDT:USDT,1000PEPE/USDT:USDT,1000FLOKI/USDT:USDT,1000BONK/USDT:USDT";
const SYMBOL_INPUT =
  process.env.WFO_SYMBOLS ||
  process.env.SYMBOLS ||
  process.env.MEME_SYMBOLS ||
  process.env.SYMBOL ||
  DEFAULT_MEME_SYMBOLS;
const SYMBOLS = SYMBOL_INPUT.split(",").map((s) => s.trim()).filter(Boolean);

const TIMEFRAME = process.env.WFO_TIMEFRAME || process.env.TIMEFRAME || "15m";
const HTF_TIMEFRAME =
  process.env.WFO_HTF_TIMEFRAME || process.env.HTF_TIMEFRAME || "30m";
const LOOKBACK_CANDLES = Number(process.env.WFO_LOOKBACK_CANDLES || 2400);
const TRAIN_CANDLES = Number(process.env.WFO_TRAIN_CANDLES || 900);
const TEST_CANDLES = Number(process.env.WFO_TEST_CANDLES || 300);
const FEE_RATE = Number(process.env.WFO_FEE_RATE || 0.0008);
const INITIAL_EQUITY = Number(process.env.WFO_INITIAL_EQUITY || 1000);
const RISK_PER_TRADE_PCT =
  Number(process.env.RISK_PER_TRADE_PCT || 1) / 100;
const LONG_ONLY = process.env.LONG_ONLY !== "false";
const MIN_VOLUME_CHANGE_FOR_TREND = Number(
  process.env.MIN_VOLUME_CHANGE_FOR_TREND || -20,
);
const OUT_FILE = process.env.WFO_OUTPUT_FILE || "walk-forward-report.json";
const TUNED_ENV_FILE = process.env.WFO_TUNED_ENV_FILE || ".env.tuned";

const exchange = new ccxt.binance({
  enableRateLimit: true,
  options: { defaultType: "future" },
});

function parseNumberList(value, fallback) {
  if (!value) return fallback;
  const values = value
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v));
  return values.length ? values : fallback;
}

const GRID = {
  MIN_RR: parseNumberList(process.env.WFO_GRID_MIN_RR, [1.2, 1.5, 1.8, 2.0]),
  ATR_TP_MULTIPLIER: parseNumberList(process.env.WFO_GRID_ATR_TP, [
    1.5, 1.8, 2.2, 2.6,
  ]),
  SIDEWAYS_EMA_GAP: parseNumberList(process.env.WFO_GRID_SIDEWAYS_EMA_GAP, [
    0.03, 0.04, 0.06, 0.08,
  ]),
  REQUIRED_CONFIRMATION: parseNumberList(process.env.WFO_GRID_CONFIRMATION, [
    1, 2, 3,
  ]).map((v) => Math.max(1, Math.round(v))),
  MIN_ATR_PCT: parseNumberList(process.env.WFO_GRID_MIN_ATR_PCT, [
    0.1, 0.15, 0.25,
  ]),
  MAX_ATR_PCT: parseNumberList(process.env.WFO_GRID_MAX_ATR_PCT, [
    1.8, 2.5, 3.5,
  ]),
};

function timeframeMs(timeframe) {
  const match = String(timeframe).match(/^(\d+)([mhd])$/);
  if (!match) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const n = Number(match[1]);
  const unit = match[2];
  if (unit === "m") return n * 60 * 1000;
  if (unit === "h") return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

async function fetchOHLCV(symbol, timeframe, candles) {
  const limit = 1000;
  const ms = timeframeMs(timeframe);
  let since = Date.now() - candles * ms;
  const rows = [];

  while (rows.length < candles) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, since, limit);
    if (!batch.length) break;
    for (const row of batch) {
      if (!rows.length || row[0] > rows[rows.length - 1][0]) rows.push(row);
    }
    since = batch[batch.length - 1][0] + ms;
    if (batch.length < limit) break;
  }

  return rows.slice(-candles);
}

function calculateEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateATR(ohlcv, period = 14) {
  if (ohlcv.length <= period) return null;
  const trs = [];
  for (let i = ohlcv.length - period; i < ohlcv.length; i++) {
    const prevClose = ohlcv[i - 1][4];
    const high = ohlcv[i][2];
    const low = ohlcv[i][3];
    trs.push(
      Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)),
    );
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function findHtfIndex(htfRows, timestamp) {
  let lo = 0;
  let hi = htfRows.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (htfRows[mid][0] <= timestamp) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function buildSnapshot(rows, index, price) {
  if (index < 60) return null;
  const slice = rows.slice(0, index + 1);
  const closes = slice.map((c) => c[4]);
  const ema20 = calculateEMA(closes.slice(-20), 20);
  const ema50 = calculateEMA(closes.slice(-50), 50);
  const prevEma20 = calculateEMA(closes.slice(-21, -1), 20);
  const prevEma50 = calculateEMA(closes.slice(-51, -1), 50);
  const atr = calculateATR(slice.slice(-15), 14);
  const rsi = calculateRSI(closes.slice(-15), 14);
  if ([ema20, ema50, prevEma20, prevEma50, atr, rsi].some((v) => v === null)) {
    return null;
  }
  const latestVolume = rows[index][5];
  const prevVolume = rows[index - 1]?.[5] || latestVolume;
  const volumeChange =
    prevVolume > 0 ? ((latestVolume - prevVolume) / prevVolume) * 100 : 0;

  return {
    price,
    ema20,
    ema50,
    ema20Slope: ema20 - prevEma20,
    ema50Slope: ema50 - prevEma50,
    emaGap: (Math.abs(ema20 - ema50) / price) * 100,
    rsi,
    atr,
    volumeChange,
    trend: ema20 > ema50 ? "UPTREND" : ema20 < ema50 ? "DOWNTREND" : "SIDEWAYS",
  };
}

function detectMarketRegime(snapshot, htfSnapshot, params) {
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
    snapshot.emaGap < params.SIDEWAYS_EMA_GAP ||
    (Math.abs(snapshot.ema20Slope) < snapshot.atr * 0.02 &&
      Math.abs(snapshot.ema50Slope) < snapshot.atr * 0.02 &&
      Math.abs(htfSnapshot.ema20Slope) < htfSnapshot.atr * 0.02) ||
    (snapshot.rsi >= 45 && snapshot.rsi <= 55 && atrPct < params.MIN_ATR_PCT / 100);
  const volatile = atrPct >= params.MAX_ATR_PCT / 100;

  if (sideways) return { regime: "CHOPPY", allow: false, atrPct };
  if (volatile && !bullishAlignment && !bearishAlignment) {
    return { regime: "HIGH_VOLATILITY", allow: false, atrPct };
  }
  if (bullishAlignment) return { regime: "TRENDING_UP", allow: true, atrPct };
  if (bearishAlignment) return { regime: "TRENDING_DOWN", allow: true, atrPct };
  return { regime: volatile ? "VOLATILE_MIXED" : "MIXED", allow: false, atrPct };
}

function getSignal(snapshot, htfSnapshot, regime, params) {
  if (!regime.allow) return "HOLD";
  if (regime.atrPct < params.MIN_ATR_PCT / 100) return "HOLD";
  if (regime.atrPct > params.MAX_ATR_PCT / 100) return "HOLD";

  const longSignal =
    regime.regime === "TRENDING_UP" &&
    snapshot.rsi >= 48 &&
    snapshot.rsi <= 75 &&
    snapshot.ema20 > snapshot.ema50 &&
    htfSnapshot.ema20 > htfSnapshot.ema50;
  const shortSignal =
    regime.regime === "TRENDING_DOWN" &&
    snapshot.rsi >= 25 &&
    snapshot.rsi <= 52 &&
    snapshot.ema20 < snapshot.ema50 &&
    htfSnapshot.ema20 < htfSnapshot.ema50;

  if (longSignal) return "LONG";
  if (!LONG_ONLY && shortSignal) return "SHORT";
  return "HOLD";
}

function calculateRR(signal, entry, tp, sl) {
  if (signal === "LONG") return (tp - entry) / (entry - sl);
  return (entry - tp) / (sl - entry);
}

function simulateTrade(rows, entryIndex, signal, params, equity) {
  const entry = rows[entryIndex][4];
  const atr = calculateATR(rows.slice(0, entryIndex + 1).slice(-15), 14);
  if (!atr || atr <= 0) return null;

  const sl = signal === "LONG" ? entry - atr : entry + atr;
  const tp =
    signal === "LONG"
      ? entry + atr * params.ATR_TP_MULTIPLIER
      : entry - atr * params.ATR_TP_MULTIPLIER;
  const rr = calculateRR(signal, entry, tp, sl);
  if (rr < params.MIN_RR) return null;

  const riskAmount = equity * RISK_PER_TRADE_PCT;
  const quantity = riskAmount / Math.abs(entry - sl);
  const notional = quantity * entry;
  const fee = notional * FEE_RATE * 2;

  for (let i = entryIndex + 1; i < rows.length; i++) {
    const high = rows[i][2];
    const low = rows[i][3];
    const hitSl = signal === "LONG" ? low <= sl : high >= sl;
    const hitTp = signal === "LONG" ? high >= tp : low <= tp;
    if (!hitSl && !hitTp) continue;

    const exit = hitSl && hitTp ? sl : hitTp ? tp : sl;
    const gross =
      signal === "LONG" ? (exit - entry) * quantity : (entry - exit) * quantity;
    return {
      entryIndex,
      exitIndex: i,
      signal,
      entry,
      exit,
      rr,
      pnl: gross - fee,
    };
  }

  const exit = rows[rows.length - 1][4];
  const gross =
    signal === "LONG" ? (exit - entry) * quantity : (entry - exit) * quantity;
  return {
    entryIndex,
    exitIndex: rows.length - 1,
    signal,
    entry,
    exit,
    rr,
    pnl: gross - fee,
  };
}

function evaluateWindow(rows, htfRows, start, end, params) {
  let equity = INITIAL_EQUITY;
  let peak = equity;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let lastSignal = null;
  let confirmCount = 0;
  const trades = [];

  for (let i = Math.max(start, 80); i < end - 1; i++) {
    const price = rows[i][4];
    const htfIndex = findHtfIndex(htfRows, rows[i][0]);
    if (htfIndex < 60) continue;

    const snapshot = buildSnapshot(rows, i, price);
    const htfSnapshot = buildSnapshot(htfRows, htfIndex, htfRows[htfIndex][4]);
    if (!snapshot || !htfSnapshot) continue;

    const regime = detectMarketRegime(snapshot, htfSnapshot, params);
    const signal = getSignal(snapshot, htfSnapshot, regime, params);
    if (signal === "HOLD") {
      lastSignal = null;
      confirmCount = 0;
      continue;
    }

    if (lastSignal === signal) confirmCount += 1;
    else {
      lastSignal = signal;
      confirmCount = 1;
    }
    if (confirmCount < params.REQUIRED_CONFIRMATION) continue;

    const trade = simulateTrade(rows.slice(0, end), i, signal, params, equity);
    if (!trade) continue;
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    trades.push(trade);
    if (trade.pnl >= 0) {
      wins += 1;
      grossProfit += trade.pnl;
    } else {
      losses += 1;
      grossLoss += Math.abs(trade.pnl);
    }
    i = trade.exitIndex;
    lastSignal = null;
    confirmCount = 0;
  }

  const tradeCount = trades.length;
  const netProfit = equity - INITIAL_EQUITY;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const winRate = tradeCount ? (wins / tradeCount) * 100 : 0;
  const maxDrawdownPct = (maxDrawdown / INITIAL_EQUITY) * 100;
  const score =
    netProfit + profitFactor * 20 + winRate * 0.2 - maxDrawdownPct * 15;

  return {
    netProfit,
    netProfitPct: (netProfit / INITIAL_EQUITY) * 100,
    tradeCount,
    wins,
    losses,
    winRate,
    profitFactor,
    maxDrawdown,
    maxDrawdownPct,
    score,
  };
}

function buildParamGrid() {
  const params = [];
  for (const MIN_RR of GRID.MIN_RR) {
    for (const ATR_TP_MULTIPLIER of GRID.ATR_TP_MULTIPLIER) {
      for (const SIDEWAYS_EMA_GAP of GRID.SIDEWAYS_EMA_GAP) {
        for (const REQUIRED_CONFIRMATION of GRID.REQUIRED_CONFIRMATION) {
          for (const MIN_ATR_PCT of GRID.MIN_ATR_PCT) {
            for (const MAX_ATR_PCT of GRID.MAX_ATR_PCT) {
              if (MIN_ATR_PCT >= MAX_ATR_PCT) continue;
              params.push({
                MIN_RR,
                ATR_TP_MULTIPLIER,
                SIDEWAYS_EMA_GAP,
                REQUIRED_CONFIRMATION,
                MIN_ATR_PCT,
                MAX_ATR_PCT,
              });
            }
          }
        }
      }
    }
  }
  return params;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarizeSelectedParams(walks) {
  const selected = walks.map((w) => w.params);
  return {
    MIN_RR: median(selected.map((p) => p.MIN_RR)),
    ATR_TP_MULTIPLIER: median(selected.map((p) => p.ATR_TP_MULTIPLIER)),
    SIDEWAYS_EMA_GAP: median(selected.map((p) => p.SIDEWAYS_EMA_GAP)),
    REQUIRED_CONFIRMATION: Math.round(
      median(selected.map((p) => p.REQUIRED_CONFIRMATION)),
    ),
    MIN_ATR_PCT: median(selected.map((p) => p.MIN_ATR_PCT)),
    MAX_ATR_PCT: median(selected.map((p) => p.MAX_ATR_PCT)),
  };
}

function writeTunedEnv(params) {
  const content = [
    "# Generated by walk-forward-optimizer.js",
    `MIN_RR=${params.MIN_RR}`,
    `ATR_TP_MULTIPLIER=${params.ATR_TP_MULTIPLIER}`,
    `SIDEWAYS_EMA_GAP=${params.SIDEWAYS_EMA_GAP}`,
    `REQUIRED_CONFIRMATION=${params.REQUIRED_CONFIRMATION}`,
    `MIN_ATR_PCT=${params.MIN_ATR_PCT}`,
    `MAX_ATR_PCT=${params.MAX_ATR_PCT}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.resolve(process.cwd(), TUNED_ENV_FILE), content);
}

async function optimizeSymbol(symbol, paramGrid) {
  console.log(`[WFO] Fetching ${symbol} ${TIMEFRAME}/${HTF_TIMEFRAME} candles...`);
  const rows = await fetchOHLCV(symbol, TIMEFRAME, LOOKBACK_CANDLES);
  const htfCandles = Math.ceil(
    (LOOKBACK_CANDLES * timeframeMs(TIMEFRAME)) / timeframeMs(HTF_TIMEFRAME),
  ) + 100;
  const htfRows = await fetchOHLCV(symbol, HTF_TIMEFRAME, htfCandles);
  const walks = [];
  let start = 80;

  while (start + TRAIN_CANDLES + TEST_CANDLES <= rows.length) {
    const trainStart = start;
    const trainEnd = start + TRAIN_CANDLES;
    const testEnd = trainEnd + TEST_CANDLES;
    let best = null;

    for (const params of paramGrid) {
      const train = evaluateWindow(rows, htfRows, trainStart, trainEnd, params);
      if (train.tradeCount < 3) continue;
      if (!best || train.score > best.train.score) best = { params, train };
    }

    if (best) {
      const test = evaluateWindow(rows, htfRows, trainEnd, testEnd, best.params);
      walks.push({
        trainRange: [
          new Date(rows[trainStart][0]).toISOString(),
          new Date(rows[trainEnd - 1][0]).toISOString(),
        ],
        testRange: [
          new Date(rows[trainEnd][0]).toISOString(),
          new Date(rows[testEnd - 1][0]).toISOString(),
        ],
        params: best.params,
        train: best.train,
        test,
      });
    }

    start += TEST_CANDLES;
  }

  const aggregate = walks.reduce(
    (acc, walk) => {
      acc.netProfit += walk.test.netProfit;
      acc.tradeCount += walk.test.tradeCount;
      acc.wins += walk.test.wins;
      acc.losses += walk.test.losses;
      acc.maxDrawdownPct = Math.max(acc.maxDrawdownPct, walk.test.maxDrawdownPct);
      return acc;
    },
    { netProfit: 0, tradeCount: 0, wins: 0, losses: 0, maxDrawdownPct: 0 },
  );
  aggregate.winRate = aggregate.tradeCount
    ? (aggregate.wins / aggregate.tradeCount) * 100
    : 0;
  aggregate.netProfitPct = (aggregate.netProfit / INITIAL_EQUITY) * 100;

  return { symbol, candles: rows.length, walks, aggregate };
}

async function main() {
  console.log(`
[WFO] Walk-forward optimizer
Symbols: ${SYMBOLS.join(", ")}
TF/HTF: ${TIMEFRAME}/${HTF_TIMEFRAME}
Candles: ${LOOKBACK_CANDLES}
Train/Test: ${TRAIN_CANDLES}/${TEST_CANDLES}
`);
  await exchange.loadMarkets();
  const paramGrid = buildParamGrid();
  console.log(`[WFO] Parameter combinations: ${paramGrid.length}`);

  const symbols = [];
  for (const symbol of SYMBOLS) {
    try {
      symbols.push(await optimizeSymbol(symbol, paramGrid));
    } catch (err) {
      console.warn(`[WFO] ${symbol} skipped: ${err.message}`);
    }
  }

  const allWalks = symbols.flatMap((s) => s.walks);
  if (!allWalks.length) {
    throw new Error("No valid walk-forward windows. Increase LOOKBACK or relax grid.");
  }

  const recommended = summarizeSelectedParams(allWalks);
  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      symbols: SYMBOLS,
      timeframe: TIMEFRAME,
      htfTimeframe: HTF_TIMEFRAME,
      lookbackCandles: LOOKBACK_CANDLES,
      trainCandles: TRAIN_CANDLES,
      testCandles: TEST_CANDLES,
      feeRate: FEE_RATE,
      initialEquity: INITIAL_EQUITY,
      riskPerTradePct: RISK_PER_TRADE_PCT * 100,
      longOnly: LONG_ONLY,
      grid: GRID,
    },
    recommended,
    symbols,
  };

  fs.writeFileSync(path.resolve(process.cwd(), OUT_FILE), JSON.stringify(report, null, 2));
  writeTunedEnv(recommended);

  console.log("\n[WFO] Recommended params:");
  console.table(recommended);
  console.log("[WFO] Test aggregate by symbol:");
  console.table(
    symbols.map((s) => ({
      symbol: s.symbol,
      walks: s.walks.length,
      trades: s.aggregate.tradeCount,
      netPct: Number(s.aggregate.netProfitPct.toFixed(2)),
      winRate: Number(s.aggregate.winRate.toFixed(2)),
      maxDDPct: Number(s.aggregate.maxDrawdownPct.toFixed(2)),
    })),
  );
  console.log(`[WFO] Report saved: ${OUT_FILE}`);
  console.log(`[WFO] Tuned env saved: ${TUNED_ENV_FILE}`);
}

main().catch((err) => {
  console.error("[WFO] Failed:", err.message);
  process.exitCode = 1;
});
