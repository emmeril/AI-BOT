#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester, DEFAULT_OPTIONS } = require('../src/full-grid-backtester');
const { aggregate, comparison, fetchFundingRates } = require('./backtest-full-grid-pnl');
const { analyzeVolumeDelta, evaluateVolumeDeltaEntry } = require('../src/volume-delta-analyzer');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const DAY_MS = 86_400_000;
const CANDLE_MS = 15 * 60_000;
const HISTORY_DAYS = 90;
const WARMUP_DAYS = 21;
const DEFAULT_SYMBOLS = [
  '1000SHIB/USDT:USDT',
  '1000PEPE/USDT:USDT',
  '1000BONK/USDT:USDT',
  'PENGU/USDT:USDT',
  'JUP/USDT:USDT',
];
const VARIANTS = Object.freeze([
  { key: 'baseline', label: 'No volume-delta filter' },
  { key: 'guard_1h_05', label: 'SHORT 1h opposition guard 5%', lookbackCandles: 4, thresholdPct: 5 },
  { key: 'guard_4h_025', label: 'SHORT 4h opposition guard 2.5%', lookbackCandles: 16, thresholdPct: 2.5 },
  { key: 'guard_4h_05', label: 'SHORT 4h opposition guard 5%', lookbackCandles: 16, thresholdPct: 5 },
  { key: 'guard_4h_10', label: 'SHORT 4h opposition guard 10%', lookbackCandles: 16, thresholdPct: 10 },
  { key: 'guard_8h_05', label: 'SHORT 8h opposition guard 5%', lookbackCandles: 32, thresholdPct: 5 },
  { key: 'confirm_1h', label: 'SHORT 1h same-side confirmation', lookbackCandles: 4, thresholdPct: 0 },
  { key: 'confirm_4h', label: 'SHORT 4h same-side confirmation', lookbackCandles: 16, thresholdPct: 0 },
]);

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

async function fetchRawKlines(exchange, symbol, since, until, cacheDirectory) {
  const cachePath = path.join(
    cacheDirectory,
    `${safeName(symbol)}-15m-${new Date(since).toISOString().slice(0, 10)}-${new Date(until).toISOString().slice(0, 10)}.json`
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
          interval: '15m',
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

function simulateSide({ exchange, symbol, rows, fundingRates, start, end, options, side, maps }) {
  const simulator = new FullGridBacktester(exchange, options);
  const results = {};
  for (const variant of VARIANTS) {
    if (side === 'LONG' && variant.key !== 'baseline') {
      results[variant.key] = results.baseline;
      continue;
    }
    results[variant.key] = simulator.simulate({
      symbol,
      rows,
      fundingRates,
      start,
      end,
      adaptive: side === 'LONG',
      entryDecisionProvider: side === 'SHORT'
        ? entryDecisionProvider(maps[variant.lookbackCandles], variant)
        : null,
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
  const baseline = train.aggregate.baseline.SHORT;
  const candidates = VARIANTS.slice(1).map(variant => {
    const result = train.aggregate[variant.key].SHORT;
    const pnlDelta = result.netLiquidationPnl - baseline.netLiquidationPnl;
    const drawdownDelta = result.sumOfPerSymbolMaximumDrawdowns - baseline.sumOfPerSymbolMaximumDrawdowns;
    return { key: variant.key, pnlDelta, drawdownDelta };
  }).filter(item => item.pnlDelta > 0 && item.drawdownDelta <= 0)
    .sort((left, right) => right.pnlDelta - left.pnlDelta);
  return candidates[0]?.key || null;
}

function renderMarkdown(report) {
  const lines = [
    '# Volume Delta Full-grid Backtest',
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
  lines.push(`- Selected using training data only: ${report.selection.selected || 'none'}.`);
  lines.push(`- Out-of-sample validation: ${report.selection.validation}.`);
  if (report.selection.selected) {
    const comparisonResult = report.outOfSample.comparison[report.selection.selected].SHORT;
    lines.push(
      `- SHORT out-of-sample PnL delta: ${comparisonResult.netPnlDelta} USDT.`,
      `- SHORT out-of-sample drawdown delta: ${comparisonResult.drawdownDelta} USDT (negative is better).`
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
    gridCount: envNumber('GRID_COUNT', 27),
    totalInvestment: envNumber('GRID_TOTAL_INVESTMENT_USDT', 150),
    leverage: envNumber('LEVERAGE', 5),
    maxActiveBuyOrders: envNumber('GRID_MAX_ACTIVE_BUY_ORDERS', 20),
    maxRefills: envNumber('GRID_MAX_REFILLS', 2),
    makerFeeRate: envNumber('BINANCE_FUTURES_MAKER_FEE_RATE', 0.0002),
    minimumNetProfitPct: envNumber('GRID_MIN_NET_PROFIT_PCT', 0.05),
    positionSide: 'LONG',
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
      for (const scope of Object.values(scopes)) {
        scope.perSymbol[symbol] = {
          LONG: simulateSide({ exchange, symbol, rows, fundingRates, start: scope.start, end: scope.end, options: long, side: 'LONG', maps }),
          SHORT: simulateSide({ exchange, symbol, rows, fundingRates, start: scope.start, end: scope.end, options: short, side: 'SHORT', maps }),
        };
      }
    }
  } finally {
    await exchange.close();
  }
  for (const scope of Object.values(scopes)) aggregateResults(scope, symbols, longOptions, shortOptions);
  const selected = selectOnTraining(scopes.train);
  const selectedOos = selected ? scopes.outOfSample.comparison[selected].SHORT : null;
  const baselineShortOos = scopes.outOfSample.aggregate.baseline.SHORT.netLiquidationPnl;
  const toleratedPnlReduction = Math.max(0.25, Math.abs(baselineShortOos) * 0.05);
  const validation = selectedOos &&
      selectedOos.netPnlDelta >= -toleratedPnlReduction && selectedOos.drawdownDelta < 0
    ? 'PASS'
    : 'FAIL';
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
    selection: { selected, validation },
    assumptions: [
      'Volume delta is taker buy base volume minus taker sell base volume from Binance USD-M 15m klines.',
      'Volume delta is applied only to SHORT; the LONG strategy remains unchanged.',
      'A guard cancels pending SHORT entry orders when opposing delta exceeds the threshold; exit orders are never filtered.',
      'The candidate is selected on the first 45 days and validated unchanged on the final 45 days.',
      '15m candles cannot model queue position, slippage, latency, exact intrabar ordering, or rejected post-only orders.',
      'Liquidation and maintenance-margin tiers are not simulated.',
    ],
    ...scopes,
  };
  fs.mkdirSync(resultsDirectory, { recursive: true });
  fs.writeFileSync(path.join(resultsDirectory, 'volume-delta-backtest.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(resultsDirectory, 'volume-delta-backtest.md'), renderMarkdown(report));
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
};
