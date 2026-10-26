#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester } = require('../src/full-grid-backtester');
const { aggregate, fetchFundingRates } = require('./backtest-full-grid-pnl');
const { cachedRows, combined, round } = require('./backtest-exit-targets');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const FIVE_MINUTES_MS = 5 * 60_000;
const REFERENCE_PATH = path.resolve('backtest-results/scalping-volume-delta-backtest.json');
const FUNDING_DIRECTORY = path.resolve('backtest-data/funding');
const RESULTS_DIRECTORY = path.resolve('backtest-results');

const VARIANTS = Object.freeze([
  {
    key: 'direction_gated',
    label: 'Fibonacci direction gate',
    longEntryDirection: 'BULLISH',
    shortEntryDirection: 'BEARISH',
    decide: () => true,
  },
  {
    key: 'direct',
    label: 'No entry filter',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: () => true,
  },
  {
    key: 'rsi_45_55',
    label: 'RSI mean reversion 45/55',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT' ? indicator.rsi14 >= 55 : indicator.rsi14 <= 45,
  },
  {
    key: 'rsi_40_60',
    label: 'RSI mean reversion 40/60',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT' ? indicator.rsi14 >= 60 : indicator.rsi14 <= 40,
  },
  {
    key: 'bollinger_mid',
    label: 'Bollinger side of mean',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT' ? indicator.bollingerZ >= 0 : indicator.bollingerZ <= 0,
  },
  {
    key: 'bollinger_half_sigma',
    label: 'Bollinger half-sigma reversal',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT'
      ? indicator.bollingerZ >= 0.5
      : indicator.bollingerZ <= -0.5,
  },
  {
    key: 'ema_trend',
    label: 'EMA20/50 trend',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT'
      ? indicator.ema20 < indicator.ema50
      : indicator.ema20 > indicator.ema50,
  },
  {
    key: 'ema_pullback',
    label: 'EMA20/50 trend pullback',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT'
      ? indicator.ema20 < indicator.ema50 && indicator.close >= indicator.ema20
      : indicator.ema20 > indicator.ema50 && indicator.close <= indicator.ema20,
  },
  {
    key: 'momentum_1h',
    label: 'Price momentum 1h',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT' ? indicator.roc12 < 0 : indicator.roc12 > 0,
  },
  {
    key: 'momentum_3h',
    label: 'Price momentum 3h',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT' ? indicator.roc36 < 0 : indicator.roc36 > 0,
  },
  {
    key: 'momentum_6h',
    label: 'Price momentum 6h',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT' ? indicator.roc72 < 0 : indicator.roc72 > 0,
  },
  {
    key: 'momentum_12h',
    label: 'Price momentum 12h',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT' ? indicator.roc144 < 0 : indicator.roc144 > 0,
  },
  {
    key: 'momentum_24h',
    label: 'Price momentum 24h',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT' ? indicator.roc288 < 0 : indicator.roc288 > 0,
  },
  {
    key: 'momentum_1h_3h',
    label: 'Price momentum consensus 1h + 3h',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT'
      ? indicator.roc12 < 0 && indicator.roc36 < 0
      : indicator.roc12 > 0 && indicator.roc36 > 0,
  },
  {
    key: 'momentum_3h_12h',
    label: 'Price momentum consensus 3h + 12h',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT'
      ? indicator.roc36 < 0 && indicator.roc144 < 0
      : indicator.roc36 > 0 && indicator.roc144 > 0,
  },
  {
    key: 'donchian_mid_20',
    label: 'Donchian midpoint 100m',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT'
      ? indicator.close < indicator.donchianMid20
      : indicator.close > indicator.donchianMid20,
  },
  {
    key: 'donchian_mid_50',
    label: 'Donchian midpoint 250m',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT'
      ? indicator.close < indicator.donchianMid50
      : indicator.close > indicator.donchianMid50,
  },
  {
    key: 'donchian_mid_144',
    label: 'Donchian midpoint 12h',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => side === 'SHORT'
      ? indicator.close < indicator.donchianMid144
      : indicator.close > indicator.donchianMid144,
  },
  {
    key: 'adx_20',
    label: 'ADX ranging <=20',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: indicator => indicator.adx14 <= 20,
  },
  {
    key: 'adx_25',
    label: 'ADX ranging <=25',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: indicator => indicator.adx14 <= 25,
  },
  {
    key: 'adx_25_rsi',
    label: 'ADX<=25 + RSI 45/55',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => indicator.adx14 <= 25 &&
      (side === 'SHORT' ? indicator.rsi14 >= 55 : indicator.rsi14 <= 45),
  },
  {
    key: 'adx_25_bollinger',
    label: 'ADX<=25 + Bollinger mean side',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    decide: (indicator, side) => indicator.adx14 <= 25 &&
      (side === 'SHORT' ? indicator.bollingerZ >= 0 : indicator.bollingerZ <= 0),
  },
]);
const requestedVariantKeys = new Set(
  String(process.env.BACKTEST_ENTRY_FILTER_VARIANTS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);
const ACTIVE_VARIANTS = requestedVariantKeys.size
  ? VARIANTS.filter(variant => requestedVariantKeys.has(variant.key))
  : VARIANTS;
if (!ACTIVE_VARIANTS.length) {
  throw new Error('BACKTEST_ENTRY_FILTER_VARIANTS did not match a known strategy');
}

function emaNext(previous, value, period) {
  return previous === null ? value : previous + (value - previous) * (2 / (period + 1));
}

function buildIndicatorMap(rows) {
  const result = new Map();
  const closes = [];
  const highs = [];
  const lows = [];
  const gains = [];
  const losses = [];
  const trueRanges = [];
  const plusDm = [];
  const minusDm = [];
  const dxValues = [];
  let ema20 = null;
  let ema50 = null;

  for (let index = 0; index < rows.length; index++) {
    const timestamp = Number(rows[index][0]);
    const high = Number(rows[index][2]);
    const low = Number(rows[index][3]);
    const close = Number(rows[index][4]);
    closes.push(close);
    highs.push(high);
    lows.push(low);
    ema20 = emaNext(ema20, close, 20);
    ema50 = emaNext(ema50, close, 50);

    if (index > 0) {
      const previousHigh = Number(rows[index - 1][2]);
      const previousLow = Number(rows[index - 1][3]);
      const previousClose = Number(rows[index - 1][4]);
      const change = close - previousClose;
      gains.push(Math.max(change, 0));
      losses.push(Math.max(-change, 0));
      trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
      const upMove = high - previousHigh;
      const downMove = previousLow - low;
      plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    if (index < 288 || gains.length < 14 || trueRanges.length < 14) continue;
    const average = values => values.slice(-14).reduce((sum, value) => sum + value, 0) / 14;
    const averageGain = average(gains);
    const averageLoss = average(losses);
    const rsi14 = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
    const atr14 = average(trueRanges);
    const plusDi = atr14 > 0 ? 100 * average(plusDm) / atr14 : 0;
    const minusDi = atr14 > 0 ? 100 * average(minusDm) / atr14 : 0;
    const diTotal = plusDi + minusDi;
    dxValues.push(diTotal > 0 ? 100 * Math.abs(plusDi - minusDi) / diTotal : 0);
    if (dxValues.length < 14) continue;
    const adx14 = dxValues.slice(-14).reduce((sum, value) => sum + value, 0) / 14;
    const bollingerWindow = closes.slice(-20);
    const middle = bollingerWindow.reduce((sum, value) => sum + value, 0) / bollingerWindow.length;
    const variance = bollingerWindow.reduce((sum, value) => sum + (value - middle) ** 2, 0) /
      bollingerWindow.length;
    const standardDeviation = Math.sqrt(variance);
    const donchianMidpoint = period => {
      const windowHigh = Math.max(...highs.slice(1 - period));
      const windowLow = Math.min(...lows.slice(1 - period));
      return (windowHigh + windowLow) / 2;
    };
    result.set(timestamp + FIVE_MINUTES_MS, {
      close,
      rsi14,
      atr14,
      atrPct: atr14 / close * 100,
      adx14,
      ema20,
      ema50,
      bollingerZ: standardDeviation > 0 ? (close - middle) / standardDeviation : 0,
      roc12: close / closes[index - 12] - 1,
      roc36: close / closes[index - 36] - 1,
      roc72: close / closes[index - 72] - 1,
      roc144: close / closes[index - 144] - 1,
      roc288: close / closes[index - 288] - 1,
      donchianMid20: donchianMidpoint(20),
      donchianMid50: donchianMidpoint(50),
      donchianMid144: donchianMidpoint(144),
    });
  }
  return result;
}

function aggregateScope(scope, symbols, baseOptions) {
  scope.aggregate = {};
  for (const variant of ACTIVE_VARIANTS) {
    const LONG = aggregate(
      symbols.map(symbol => scope.perSymbol[symbol].LONG[variant.key]),
      baseOptions.LONG
    );
    const SHORT = aggregate(
      symbols.map(symbol => scope.perSymbol[symbol].SHORT[variant.key]),
      baseOptions.SHORT
    );
    scope.aggregate[variant.key] = { LONG, SHORT, combined: combined(LONG, SHORT) };
  }
}

function scoreCandidate(report, key) {
  const train = report.train.aggregate[key].combined;
  const outOfSample = report.outOfSample.aggregate[key].combined;
  const full = report.full.aggregate[key].combined;
  const stable = train.netLiquidationPnl > 0 && outOfSample.netLiquidationPnl > 0;
  const drawdownAdjusted = full.sumOfPerSymbolMaximumDrawdowns > 0
    ? full.netLiquidationPnl / full.sumOfPerSymbolMaximumDrawdowns
    : -Infinity;
  return {
    key,
    stable,
    trainPnl: train.netLiquidationPnl,
    outOfSamplePnl: outOfSample.netLiquidationPnl,
    fullPnl: full.netLiquidationPnl,
    fullDrawdown: full.sumOfPerSymbolMaximumDrawdowns,
    drawdownAdjusted: round(drawdownAdjusted),
    cycles: full.gridCycles,
    finalInventory: full.finalInventoryNotional,
  };
}

function chooseCandidate(report) {
  return ACTIVE_VARIANTS
    .filter(variant => !['direction_gated', 'direct'].includes(variant.key))
    .map(variant => scoreCandidate(report, variant.key))
    .filter(item => item.stable && item.cycles >= 50 && item.fullPnl > 0)
    .sort((left, right) => right.drawdownAdjusted - left.drawdownAdjusted ||
      right.fullPnl - left.fullPnl)[0] || null;
}

function renderMarkdown(report) {
  const lines = [
    '# Fibonacci Grid Entry Filter Backtest', '',
    `Period: ${report.period.start} to ${report.period.end}`, '',
    `Train/test split: ${report.period.splitAt}`, '',
    '| Scope | Strategy | PnL | LONG | SHORT | Sum max DD | Cycles | Final inventory |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scopeName of ['full', 'train', 'outOfSample'].filter(name => report[name])) {
    for (const variant of ACTIVE_VARIANTS) {
      const item = report[scopeName].aggregate[variant.key];
      lines.push(`| ${scopeName} | ${variant.label} | ${item.combined.netLiquidationPnl} | ${item.LONG.netLiquidationPnl} | ${item.SHORT.netLiquidationPnl} | ${item.combined.sumOfPerSymbolMaximumDrawdowns} | ${item.combined.gridCycles} | ${item.combined.finalInventoryNotional} |`);
    }
  }
  lines.push('', '## Selection', '');
  if (report.screenOnly) {
    lines.push('- Screening only. Run shortlisted variants with train and out-of-sample validation.');
  } else if (report.selection) {
    lines.push(
      `- Selected: ${report.selection.key}.`,
      `- Full PnL/DD ratio: ${report.selection.drawdownAdjusted}.`,
      `- Train PnL: ${report.selection.trainPnl} USDT.`,
      `- Out-of-sample PnL: ${report.selection.outOfSamplePnl} USDT.`
    );
  } else {
    lines.push('- No candidate passed positive train + positive out-of-sample + minimum activity.');
  }
  lines.push(
    '', '## Rules', '',
    '- Fibonacci remains the only range and grid-level generator.',
    '- Every exit uses the nearest fee-adjusted profitable Fibonacci level.',
    '- Indicators use only completed 5-minute candles and do not use Volume Delta.',
    `- Order size: LONG ${report.configuration.longOrderSizeUsdt} USDT, SHORT ${report.configuration.shortOrderSizeUsdt} USDT; per-symbol cap ${report.configuration.maxExposureUsdt} USDT.`,
    '- The first 45 days are training and the final 45 days are out-of-sample.',
    '- Queue position, slippage, latency, liquidation tiers, and exact intrabar ordering are not simulated.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

async function main() {
  const reference = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  const symbols = reference.symbols;
  const start = Date.parse(reference.period.start);
  const end = Date.parse(reference.period.end);
  const splitAt = Date.parse(reference.period.splitAt);
  const screenOnly = String(process.env.BACKTEST_SCREEN_ONLY || '').toLowerCase() === 'true';
  const requestedMaxExposure = Number(process.env.BACKTEST_MAX_EXPOSURE_USDT);
  const maxExposureUsdt = Number.isFinite(requestedMaxExposure) && requestedMaxExposure > 0
    ? requestedMaxExposure
    : 22;
  const longOrderSizeUsdt = 5;
  const shortOrderSizeUsdt = 6;
  const scopes = screenOnly
    ? { full: { start, end, perSymbol: {} } }
    : {
        full: { start, end, perSymbol: {} },
        train: { start, end: splitAt, perSymbol: {} },
        outOfSample: { start: splitAt, end, perSymbol: {} },
      };
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  const directionLevelBiasOverride = process.env.BACKTEST_DIRECTION_LEVEL_BIAS_PCT;
  await exchange.loadMarkets();
  try {
    for (const symbol of symbols) {
      console.log(`[ENTRY FILTER] ${symbol}`);
      const rawRows = cachedRows(symbol, start, end);
      const rows = rawRows.map(row => row.slice(0, 6).map(Number));
      const indicators = buildIndicatorMap(rows);
      const fundingRates = await fetchFundingRates(exchange, symbol, start, end, FUNDING_DIRECTORY);
      const minimumNotional = Number(exchange.market(symbol)?.limits?.cost?.min) || 5;
      const simulators = { LONG: {}, SHORT: {} };
      const sharedRangeSuggestionCaches = { LONG: new Map(), SHORT: new Map() };
      let sharedPreparedSeriesCache = null;
      let sharedDirectionAggregateCache = null;
      for (const side of ['LONG', 'SHORT']) {
        for (const variant of ACTIVE_VARIANTS) {
          const options = {
            ...reference.configuration[side],
            minimumNotional,
            orderSizeUsdt: side === 'SHORT' ? shortOrderSizeUsdt : longOrderSizeUsdt,
            maxExposureUsdt,
            exitTargetLevelOffset: 0,
            longEntryDirection: variant.longEntryDirection,
            shortEntryDirection: variant.shortEntryDirection,
            ...(directionLevelBiasOverride === undefined
              ? {}
              : { directionLevelBiasPct: Number(directionLevelBiasOverride) }),
          };
          const simulator = new FullGridBacktester(exchange, options);
          simulator.rangeSuggestionCache = sharedRangeSuggestionCaches[side];
          if (sharedPreparedSeriesCache) {
            simulator.preparedSeriesCache = sharedPreparedSeriesCache;
            simulator.directionAggregateCache = sharedDirectionAggregateCache;
          } else {
            sharedPreparedSeriesCache = simulator.preparedSeriesCache;
            sharedDirectionAggregateCache = simulator.directionAggregateCache;
          }
          simulators[side][variant.key] = simulator;
        }
      }
      for (const scope of Object.values(scopes)) {
        scope.perSymbol[symbol] = { LONG: {}, SHORT: {} };
        for (const side of ['LONG', 'SHORT']) {
          for (const variant of ACTIVE_VARIANTS) {
            scope.perSymbol[symbol][side][variant.key] = simulators[side][variant.key].simulate({
              symbol,
              rows,
              fundingRates,
              start: scope.start,
              end: scope.end,
              adaptive: false,
              entryDecisionProvider: ({ timestamp, analysis }) => {
                const cachedIndicator = indicators.get(timestamp);
                const exactEma = analysis?.timeframes?.['5m'];
                const indicator = cachedIndicator && exactEma
                  ? { ...cachedIndicator, ema20: exactEma.ema20, ema50: exactEma.ema50 }
                  : cachedIndicator;
                return {
                  allow: Boolean(indicator && variant.decide(indicator, side)),
                  cancelPending: true,
                };
              },
              variant: `${side.toLowerCase()}-${variant.key}`,
            });
          }
        }
      }
    }
  } finally {
    await exchange.close();
  }
  for (const scope of Object.values(scopes)) aggregateScope(scope, symbols, reference.configuration);
  const report = {
    generatedAt: new Date().toISOString(),
    period: reference.period,
    symbols,
    screenOnly,
    configuration: {
      maxExposureUsdt,
      longOrderSizeUsdt,
      shortOrderSizeUsdt,
    },
    variants: ACTIVE_VARIANTS.map(({ decide, ...variant }) => variant),
    ...scopes,
  };
  report.selection = screenOnly ? null : chooseCandidate(report);
  fs.mkdirSync(RESULTS_DIRECTORY, { recursive: true });
  const reportName = requestedVariantKeys.size
    ? `fibonacci-entry-filter-${[...requestedVariantKeys].join('-')}-backtest`
    : 'fibonacci-entry-filter-backtest';
  fs.writeFileSync(
    path.join(RESULTS_DIRECTORY, `${reportName}.json`),
    JSON.stringify(report, null, 2)
  );
  fs.writeFileSync(
    path.join(RESULTS_DIRECTORY, `${reportName}.md`),
    renderMarkdown(report)
  );
  console.log(renderMarkdown(report));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ENTRY FILTER] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { VARIANTS, buildIndicatorMap, chooseCandidate, scoreCandidate };
