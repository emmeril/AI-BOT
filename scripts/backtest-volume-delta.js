#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester, DEFAULT_OPTIONS } = require('../src/full-grid-backtester');
const { aggregate, comparison, fetchFundingRates } = require('./backtest-full-grid-pnl');
const { analyzeVolumeDelta, evaluateVolumeDeltaEntry } = require('../src/volume-delta-analyzer');
const { timeframeToMs } = require('../src/fibonacci-range-advisor');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const DAY_MS = 86_400_000;
const BASE_TIMEFRAME = String(process.env.BACKTEST_BASE_TIMEFRAME || '15m').trim();
const CANDLE_MS = timeframeToMs(BASE_TIMEFRAME);
if (!(CANDLE_MS > 0)) throw new Error(`Unsupported BACKTEST_BASE_TIMEFRAME: ${BASE_TIMEFRAME}`);
const SCALPING_MODE = process.env.BACKTEST_SCALPING_MODE === 'true';
const HISTORY_DAYS = 90;
const WARMUP_DAYS = 21;
const DEFAULT_SYMBOLS = [
  '1000SHIB/USDT:USDT',
  '1000PEPE/USDT:USDT',
  '1000BONK/USDT:USDT',
  'PENGU/USDT:USDT',
  'JUP/USDT:USDT',
];
function buildVariants() {
  if (!SCALPING_MODE) return [
    { key: 'baseline', label: 'Symmetric Fibonacci gate, no volume delta' },
    { key: 'guard_1h_025', label: 'Both sides 1h opposition guard 2.5%', lookbackCandles: 4, thresholdPct: 2.5 },
    { key: 'guard_1h_05', label: 'Both sides 1h opposition guard 5%', lookbackCandles: 4, thresholdPct: 5 },
    { key: 'guard_1h_10', label: 'Both sides 1h opposition guard 10%', lookbackCandles: 4, thresholdPct: 10 },
    { key: 'guard_4h_025', label: 'Both sides 4h opposition guard 2.5%', lookbackCandles: 16, thresholdPct: 2.5 },
    { key: 'guard_4h_05', label: 'Both sides 4h opposition guard 5%', lookbackCandles: 16, thresholdPct: 5 },
    { key: 'guard_4h_10', label: 'Both sides 4h opposition guard 10%', lookbackCandles: 16, thresholdPct: 10 },
    { key: 'guard_8h_05', label: 'Both sides 8h opposition guard 5%', lookbackCandles: 32, thresholdPct: 5 },
    { key: 'confirm_1h', label: 'Both sides 1h same-side confirmation', lookbackCandles: 4, thresholdPct: 0 },
    { key: 'confirm_4h', label: 'Both sides 4h same-side confirmation', lookbackCandles: 16, thresholdPct: 0 },
  ];
  const windows = [
    { key: '15m', label: '15m', lookbackCandles: Math.max(1, Math.round(15 * 60_000 / CANDLE_MS)) },
    { key: '30m', label: '30m', lookbackCandles: Math.max(1, Math.round(30 * 60_000 / CANDLE_MS)) },
    { key: '1h', label: '1h', lookbackCandles: Math.max(1, Math.round(60 * 60_000 / CANDLE_MS)) },
  ];
  const variants = [{ key: 'baseline', label: 'Reference only: Fibonacci gate, no volume delta' }];
  for (const window of windows) {
    for (const thresholdPct of [2.5, 5, 10]) {
      variants.push({
        key: `guard_${window.key}_${String(thresholdPct).replace('.', '')}`,
        label: `Both sides ${window.label} opposition guard ${thresholdPct}%`,
        lookbackCandles: window.lookbackCandles,
        thresholdPct,
      });
    }
    variants.push({
      key: `confirm_${window.key}`,
      label: `Both sides ${window.label} same-side confirmation`,
      lookbackCandles: window.lookbackCandles,
      thresholdPct: 0,
    });
  }
  return variants;
}

const VARIANTS = Object.freeze(buildVariants());

function safeName(symbol) {
  return symbol.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envList(name, fallback) {
  const values = String(process.env[name] || '').split(',').map(value => value.trim()).filter(Boolean);
  return values.length ? values : fallback;
}

async function fetchRawKlines(exchange, symbol, since, until, cacheDirectory) {
  const cachePath = path.join(
    cacheDirectory,
    `${safeName(symbol)}-${BASE_TIMEFRAME}-${new Date(since).toISOString().slice(0, 10)}-${new Date(until).toISOString().slice(0, 10)}.json`
  );
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const market = exchange.market(symbol);
  const rows = new Map();
  let cursor = since;
  while (cursor < until) {
    let batch;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        batch = await exchange.fapiPublicGetKlines({
          symbol: market.id,
          interval: BASE_TIMEFRAME,
          startTime: cursor,
          endTime: until - 1,
          limit: 1500,
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
    if (!Array.isArray(batch) || !batch.length) break;
    for (const row of batch) {
      const timestamp = Number(row?.[0]);
      if (timestamp >= since && timestamp < until) rows.set(timestamp, row);
    }
    const lastTimestamp = Number(batch.at(-1)?.[0]);
    if (!Number.isFinite(lastTimestamp) || lastTimestamp < cursor) break;
    cursor = lastTimestamp + CANDLE_MS;
    process.stdout.write(`\r[DATA] ${symbol} ${Math.min(100, (cursor - since) / (until - since) * 100).toFixed(1)}%`);
  }
  process.stdout.write('\n');
  const result = [...rows.values()].sort((left, right) => Number(left[0]) - Number(right[0]));
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(result));
  return result;
}

function buildAnalysisMap(rawRows, lookbackCandles) {
  const result = new Map();
  for (let index = lookbackCandles - 1; index < rawRows.length; index++) {
    const analysis = analyzeVolumeDelta(
      rawRows.slice(index + 1 - lookbackCandles, index + 1),
      { lookbackCandles }
    );
    if (analysis) result.set(Number(rawRows[index][0]) + CANDLE_MS, analysis);
  }
  return result;
}

function entryDecisionProvider(analysisMap, variant) {
  if (!variant.lookbackCandles) return null;
  return ({ timestamp, positionSide }) => evaluateVolumeDeltaEntry(
    analysisMap.get(timestamp),
    positionSide,
    { oppositionThresholdPct: variant.thresholdPct, failClosed: false }
  );
}

function simulateSide({ simulator, exchange, symbol, rows, fundingRates, start, end, options, side, maps }) {
  const runner = simulator || new FullGridBacktester(exchange, options);
  const results = {};
  for (const variant of VARIANTS) {
    results[variant.key] = runner.simulate({
      symbol,
      rows,
      fundingRates,
      start,
      end,
      adaptive: false,
      entryDecisionProvider: entryDecisionProvider(maps[variant.lookbackCandles], variant),
      variant: `${side.toLowerCase()}-${variant.key}`,
    });
  }
  return results;
}

function aggregateCombined(longAggregate, shortAggregate) {
  return {
    netLiquidationPnl: round(longAggregate.netLiquidationPnl + shortAggregate.netLiquidationPnl),
    fees: round(longAggregate.fees + shortAggregate.fees),
    fundingPnl: round(longAggregate.fundingPnl + shortAggregate.fundingPnl),
    gridCycles: longAggregate.gridCycles + shortAggregate.gridCycles,
    sumOfPerSymbolMaximumDrawdowns: round(
      longAggregate.sumOfPerSymbolMaximumDrawdowns + shortAggregate.sumOfPerSymbolMaximumDrawdowns
    ),
    entryFilterBlockedSamples:
      (longAggregate.entryFilterBlockedSamples || 0) + (shortAggregate.entryFilterBlockedSamples || 0),
  };
}

function aggregateResults(scope, symbols, longOptions, shortOptions) {
  scope.aggregate = {};
  for (const variant of VARIANTS) {
    const longResults = symbols.map(symbol => scope.perSymbol[symbol].LONG[variant.key]);
    const shortResults = symbols.map(symbol => scope.perSymbol[symbol].SHORT[variant.key]);
    const long = aggregate(longResults, longOptions);
    const short = aggregate(shortResults, shortOptions);
    long.entryFilterBlockedSamples = longResults.reduce((sum, item) => sum + item.entryFilterBlockedSamples, 0);
    short.entryFilterBlockedSamples = shortResults.reduce((sum, item) => sum + item.entryFilterBlockedSamples, 0);
    scope.aggregate[variant.key] = { LONG: long, SHORT: short, combined: aggregateCombined(long, short) };
  }
  const baseline = scope.aggregate.baseline;
  scope.comparison = Object.fromEntries(VARIANTS.slice(1).map(variant => [variant.key, {
    LONG: comparison(baseline.LONG, scope.aggregate[variant.key].LONG),
    SHORT: comparison(baseline.SHORT, scope.aggregate[variant.key].SHORT),
    combined: {
      netPnlDelta: round(scope.aggregate[variant.key].combined.netLiquidationPnl - baseline.combined.netLiquidationPnl),
      drawdownDelta: round(
        scope.aggregate[variant.key].combined.sumOfPerSymbolMaximumDrawdowns -
        baseline.combined.sumOfPerSymbolMaximumDrawdowns
      ),
      cycleDelta: scope.aggregate[variant.key].combined.gridCycles - baseline.combined.gridCycles,
    },
  }]));
}

function selectOnTraining(train) {
  const baseline = train.aggregate.baseline.combined;
  const candidates = VARIANTS.slice(1).map(variant => {
    const result = train.aggregate[variant.key].combined;
    const pnlDelta = result.netLiquidationPnl - baseline.netLiquidationPnl;
    const drawdownDelta = result.sumOfPerSymbolMaximumDrawdowns - baseline.sumOfPerSymbolMaximumDrawdowns;
    return { key: variant.key, pnlDelta, drawdownDelta };
  }).filter(item => item.pnlDelta > 0 && item.drawdownDelta <= 0)
    .sort((left, right) => right.pnlDelta - left.pnlDelta);
  return candidates[0]?.key || null;
}

function selectSideOnTraining(train, side) {
  const baseline = train.aggregate.baseline[side];
  return VARIANTS.slice(1).map(variant => ({
    key: variant.key,
    result: train.aggregate[variant.key][side],
  })).filter(item =>
    item.result.netLiquidationPnl > 0 &&
    item.result.sumOfPerSymbolMaximumDrawdowns <= baseline.sumOfPerSymbolMaximumDrawdowns
  ).sort((left, right) =>
    right.result.netLiquidationPnl - left.result.netLiquidationPnl ||
    left.result.sumOfPerSymbolMaximumDrawdowns - right.result.sumOfPerSymbolMaximumDrawdowns
  )[0]?.key || null;
}

function selectedSideCombination(scope, selectedBySide) {
  if (!selectedBySide?.LONG || !selectedBySide?.SHORT) return null;
  const long = scope.aggregate[selectedBySide.LONG].LONG;
  const short = scope.aggregate[selectedBySide.SHORT].SHORT;
  return { LONG: long, SHORT: short, combined: aggregateCombined(long, short) };
}

function renderMarkdown(report) {
  const lines = [
    SCALPING_MODE ? '# Scalping Volume Delta Full-grid Backtest' : '# Volume Delta Full-grid Backtest',
    '',
    `Period: ${report.period.start} to ${report.period.end}`,
    '',
    `Train/test split: ${report.period.splitAt}`,
    '',
    '| Scope | Variant | Combined net PnL | LONG | SHORT | Sum max DD | Grid cycles |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const scopeName of ['full', 'train', 'outOfSample']) {
    for (const variant of VARIANTS) {
      const item = report[scopeName].aggregate[variant.key];
      lines.push(
        `| ${scopeName} | ${variant.label} | ${item.combined.netLiquidationPnl} | ` +
        `${item.LONG.netLiquidationPnl} | ${item.SHORT.netLiquidationPnl} | ` +
        `${item.combined.sumOfPerSymbolMaximumDrawdowns} | ${item.combined.gridCycles} |`
      );
    }
  }
  lines.push('', '## Selection', '');
  if (SCALPING_MODE) {
    lines.push(
      '- Baseline without Volume Delta is reference-only and cannot be selected.',
      `- LONG selected using training data only: ${report.selection.selectedBySide?.LONG || 'none'}.`,
      `- SHORT selected using training data only: ${report.selection.selectedBySide?.SHORT || 'none'}.`,
      `- Out-of-sample validation: ${report.selection.validation}.`
    );
    if (report.selection.outOfSample) {
      lines.push(
        `- Combined full-period PnL: ${report.selection.full.combined.netLiquidationPnl} USDT.`,
        `- Combined out-of-sample PnL: ${report.selection.outOfSample.combined.netLiquidationPnl} USDT.`,
        `- Combined out-of-sample drawdown: ${report.selection.outOfSample.combined.sumOfPerSymbolMaximumDrawdowns} USDT.`,
        `- Combined out-of-sample cycles per day: ${report.selection.outOfSampleCyclesPerDay}.`
      );
    }
  } else {
    lines.push(`- Selected using training data only: ${report.selection.selected || 'none'}.`);
    lines.push(`- Out-of-sample validation: ${report.selection.validation}.`);
  }
  if (!SCALPING_MODE && report.selection.selected) {
    const comparisonResult = report.outOfSample.comparison[report.selection.selected].combined;
    lines.push(
      `- Combined out-of-sample PnL delta: ${comparisonResult.netPnlDelta} USDT.`,
      `- Combined out-of-sample drawdown delta: ${comparisonResult.drawdownDelta} USDT (negative is better).`
    );
  }
  lines.push('', '## Assumptions', '');
  for (const assumption of report.assumptions) lines.push(`- ${assumption}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const symbols = (process.env.BACKTEST_SYMBOLS || process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  const now = Date.now();
  const end = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  const start = end - HISTORY_DAYS * DAY_MS;
  const fetchStart = start - WARMUP_DAYS * DAY_MS;
  const splitAt = start + Math.floor((end - start) / 2);
  const dataDirectory = path.resolve('backtest-data/volume-delta');
  const fundingDirectory = path.resolve('backtest-data/funding');
  const resultsDirectory = path.resolve('backtest-results');
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  const longOptions = {
    ...DEFAULT_OPTIONS,
    baseTimeframe: BASE_TIMEFRAME,
    rangeTimeframes: envList(
      'BACKTEST_RANGE_TIMEFRAMES',
      SCALPING_MODE ? ['5m', '15m', '30m', '1h', '4h', '1d'] : DEFAULT_OPTIONS.rangeTimeframes
    ),
    directionTimeframes: envList(
      'BACKTEST_DIRECTION_TIMEFRAMES',
      SCALPING_MODE ? ['5m', '15m', '1h'] : DEFAULT_OPTIONS.directionTimeframes
    ),
    gridCount: envNumber('GRID_COUNT', 27),
    totalInvestment: envNumber('GRID_TOTAL_INVESTMENT_USDT', 150),
    leverage: envNumber('LEVERAGE', 5),
    maxActiveBuyOrders: envNumber('GRID_MAX_ACTIVE_BUY_ORDERS', 20),
    maxRefills: envNumber('GRID_MAX_REFILLS', 2),
    makerFeeRate: envNumber('BINANCE_FUTURES_MAKER_FEE_RATE', 0.0002),
    minimumNetProfitPct: envNumber('GRID_MIN_NET_PROFIT_PCT', 0.05),
    rangeWidthPct: envNumber('BACKTEST_RANGE_WIDTH_PCT', SCALPING_MODE ? 3 : DEFAULT_OPTIONS.rangeWidthPct),
    rangeMinimumWidthPct: envNumber(
      'BACKTEST_RANGE_MINIMUM_WIDTH_PCT', SCALPING_MODE ? 3 : DEFAULT_OPTIONS.rangeMinimumWidthPct
    ),
    rangeMaximumDistancePct: envNumber(
      'BACKTEST_RANGE_MAXIMUM_DISTANCE_PCT', SCALPING_MODE ? 8 : DEFAULT_OPTIONS.rangeMaximumDistancePct
    ),
    rangeRebuildThresholdPct: envNumber(
      'BACKTEST_RANGE_REBUILD_THRESHOLD_PCT', SCALPING_MODE ? 0.5 : DEFAULT_OPTIONS.rangeRebuildThresholdPct
    ),
    rangeRebuildCooldownMs: envNumber(
      'BACKTEST_RANGE_REBUILD_COOLDOWN_MINUTES', SCALPING_MODE ? 30 : 120
    ) * 60_000,
    positionSide: 'LONG',
    longEntryDirection: 'BULLISH',
    directionStrategy: String(process.env.FIBONACCI_DIRECTION_STRATEGY || 'EMA_SLOPE_MEAN_REVERSION').toUpperCase(),
    directionEmaSlopeAtrThreshold: envNumber('FIBONACCI_DIRECTION_EMA_SLOPE_ATR_THRESHOLD', 1),
  };
  const shortOptions = {
    ...longOptions,
    gridCount: envNumber('SHORT_GRID_COUNT', 10),
    totalInvestment: envNumber('SHORT_GRID_TOTAL_INVESTMENT_USDT', 60),
    maxActiveBuyOrders: envNumber('SHORT_GRID_MAX_ACTIVE_BUY_ORDERS', 10),
    positionSide: 'SHORT',
    shortEntryDirection: String(process.env.SHORT_FUTURES_SHORT_ENTRY_DIRECTION || 'BEARISH').toUpperCase(),
  };
  const scopes = {
    full: { start, end, perSymbol: {} },
    train: { start, end: splitAt, perSymbol: {} },
    outOfSample: { start: splitAt, end, perSymbol: {} },
  };
  try {
    for (const symbol of symbols) {
      console.log(`[BACKTEST] ${symbol}: loading raw taker-volume klines`);
      const rawRows = await fetchRawKlines(exchange, symbol, fetchStart, end, dataDirectory);
      const rows = rawRows.map(row => row.slice(0, 6).map(Number));
      const maps = Object.fromEntries(
        [...new Set(VARIANTS.map(variant => variant.lookbackCandles).filter(Boolean))]
          .map(lookback => [lookback, buildAnalysisMap(rawRows, lookback)])
      );
      const fundingRates = await fetchFundingRates(exchange, symbol, start, end, fundingDirectory);
      const minimumNotional = Number(exchange.market(symbol)?.limits?.cost?.min) || 5;
      const long = { ...longOptions, minimumNotional };
      const short = { ...shortOptions, minimumNotional };
      const longSimulator = new FullGridBacktester(exchange, long);
      const shortSimulator = new FullGridBacktester(exchange, short);
      shortSimulator.preparedSeriesCache = longSimulator.preparedSeriesCache;
      shortSimulator.directionAggregateCache = longSimulator.directionAggregateCache;
      for (const scope of Object.values(scopes)) {
        scope.perSymbol[symbol] = {
          LONG: simulateSide({ simulator: longSimulator, exchange, symbol, rows, fundingRates, start: scope.start, end: scope.end, options: long, side: 'LONG', maps }),
          SHORT: simulateSide({ simulator: shortSimulator, exchange, symbol, rows, fundingRates, start: scope.start, end: scope.end, options: short, side: 'SHORT', maps }),
        };
      }
    }
  } finally {
    await exchange.close();
  }
  for (const scope of Object.values(scopes)) aggregateResults(scope, symbols, longOptions, shortOptions);
  let selection;
  if (SCALPING_MODE) {
    const selectedBySide = {
      LONG: selectSideOnTraining(scopes.train, 'LONG'),
      SHORT: selectSideOnTraining(scopes.train, 'SHORT'),
    };
    const fullSelection = selectedSideCombination(scopes.full, selectedBySide);
    const oosSelection = selectedSideCombination(scopes.outOfSample, selectedBySide);
    const baselineOos = scopes.outOfSample.aggregate.baseline;
    const oosDays = (scopes.outOfSample.end - scopes.outOfSample.start) / DAY_MS;
    const minimumCyclesPerDay = envNumber('BACKTEST_MINIMUM_SCALPING_CYCLES_PER_DAY', 10);
    const outOfSampleCyclesPerDay = oosSelection
      ? round(oosSelection.combined.gridCycles / oosDays, 3)
      : 0;
    const validation = oosSelection &&
      oosSelection.LONG.netLiquidationPnl > 0 &&
      oosSelection.SHORT.netLiquidationPnl > 0 &&
      oosSelection.LONG.sumOfPerSymbolMaximumDrawdowns <= baselineOos.LONG.sumOfPerSymbolMaximumDrawdowns &&
      oosSelection.SHORT.sumOfPerSymbolMaximumDrawdowns <= baselineOos.SHORT.sumOfPerSymbolMaximumDrawdowns &&
      outOfSampleCyclesPerDay >= minimumCyclesPerDay
      ? 'PASS'
      : 'FAIL';
    selection = {
      selectedBySide,
      validation,
      minimumCyclesPerDay,
      outOfSampleCyclesPerDay,
      full: fullSelection,
      outOfSample: oosSelection,
    };
  } else {
    const selected = selectOnTraining(scopes.train);
    const selectedOos = selected ? scopes.outOfSample.comparison[selected].combined : null;
    const baselineOos = scopes.outOfSample.aggregate.baseline.combined.netLiquidationPnl;
    const toleratedPnlReduction = Math.max(0.25, Math.abs(baselineOos) * 0.05);
    const validation = selectedOos &&
        selectedOos.netPnlDelta >= -toleratedPnlReduction && selectedOos.drawdownDelta < 0
      ? 'PASS'
      : 'FAIL';
    selection = { selected, validation };
  }
  const report = {
    generatedAt: new Date().toISOString(),
    period: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      splitAt: new Date(splitAt).toISOString(),
      historyDays: HISTORY_DAYS,
      warmupDays: WARMUP_DAYS,
    },
    symbols,
    variants: VARIANTS,
    configuration: { LONG: longOptions, SHORT: shortOptions },
    selection,
    assumptions: [
      `Volume delta is taker buy base volume minus taker sell base volume from Binance USD-M ${BASE_TIMEFRAME} klines.`,
      'LONG entries require applied Fibonacci BULLISH; SHORT entries require applied Fibonacci BEARISH.',
      'Adaptive Supervisor is disabled for both sides.',
      'Every selectable candidate applies the same mirrored volume-delta rule to LONG and SHORT and cancels only opposing pending entries.',
      'Exit orders are never filtered by Fibonacci direction or volume delta.',
      'The candidate is selected on the first 45 days and validated unchanged on the final 45 days.',
      `${BASE_TIMEFRAME} candles cannot model queue position, slippage, latency, exact intrabar ordering, or rejected post-only orders.`,
      'Liquidation and maintenance-margin tiers are not simulated.',
    ],
    ...scopes,
  };
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const reportBaseName = SCALPING_MODE ? 'scalping-volume-delta-backtest' : 'volume-delta-backtest';
  fs.writeFileSync(path.join(resultsDirectory, `${reportBaseName}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(resultsDirectory, `${reportBaseName}.md`), renderMarkdown(report));
  console.log(renderMarkdown(report));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[BACKTEST] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  VARIANTS,
  buildAnalysisMap,
  entryDecisionProvider,
  selectOnTraining,
  selectSideOnTraining,
};
