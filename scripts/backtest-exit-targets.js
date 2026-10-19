#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester } = require('../src/full-grid-backtester');
const { aggregate, fetchFundingRates } = require('./backtest-full-grid-pnl');
const { analyzeVolumeDelta, evaluateVolumeDeltaEntry } = require('../src/volume-delta-analyzer');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const CANDLE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const REFERENCE_PATH = path.resolve('backtest-results/scalping-volume-delta-backtest.json');
const DATA_DIRECTORY = path.resolve('backtest-data/volume-delta');
const FUNDING_DIRECTORY = path.resolve('backtest-data/funding');
const RESULTS_DIRECTORY = path.resolve('backtest-results');
const VARIANTS = Object.freeze([
  { key: 'nearest', label: 'Nearest profitable Fibonacci level', exitTargetLevelOffset: 0 },
  { key: 'second', label: 'Second profitable Fibonacci level', exitTargetLevelOffset: 1 },
  { key: 'third', label: 'Third profitable Fibonacci level', exitTargetLevelOffset: 2 },
]);

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function safeName(symbol) {
  return symbol.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function cachedRows(symbol, start, end) {
  const prefix = `${safeName(symbol)}-5m-`;
  const candidates = fs.readdirSync(DATA_DIRECTORY)
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(DATA_DIRECTORY, name), 'utf8')))
    .filter(rows => Number(rows[0]?.[0]) <= start - 21 * DAY_MS &&
      Number(rows.at(-1)?.[0]) + CANDLE_MS >= end - 60 * 60_000)
    .sort((left, right) => right.length - left.length);
  if (!candidates.length) throw new Error(`No covering 5m cache for ${symbol}`);
  return candidates[0];
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

function combined(long, short) {
  return {
    netLiquidationPnl: round(long.netLiquidationPnl + short.netLiquidationPnl),
    realizedCashPnl: round(long.realizedCashPnl + short.realizedCashPnl),
    fees: round(long.fees + short.fees),
    gridCycles: long.gridCycles + short.gridCycles,
    sumOfPerSymbolMaximumDrawdowns: round(
      long.sumOfPerSymbolMaximumDrawdowns + short.sumOfPerSymbolMaximumDrawdowns
    ),
    finalInventoryNotional: round(long.finalInventoryNotional + short.finalInventoryNotional),
  };
}

function aggregateScope(scope, symbols, longOptions, shortOptions) {
  scope.aggregate = {};
  for (const variant of VARIANTS) {
    const LONG = aggregate(symbols.map(symbol => scope.perSymbol[symbol].LONG[variant.key]), longOptions);
    const SHORT = aggregate(symbols.map(symbol => scope.perSymbol[symbol].SHORT[variant.key]), shortOptions);
    scope.aggregate[variant.key] = { LONG, SHORT, combined: combined(LONG, SHORT) };
  }
}

function chooseOnTraining(train, side) {
  const nearest = train.aggregate.nearest[side];
  const minimumCycles = nearest.gridCycles * 0.75;
  const maximumDrawdown = nearest.sumOfPerSymbolMaximumDrawdowns * 1.5;
  const maximumInventory = nearest.finalInventoryNotional * 2 + 5;
  return VARIANTS.slice(1).map(variant => ({ key: variant.key, result: train.aggregate[variant.key][side] }))
    .filter(item => item.result.netLiquidationPnl > nearest.netLiquidationPnl &&
      item.result.sumOfPerSymbolMaximumDrawdowns <= maximumDrawdown &&
      item.result.finalInventoryNotional <= maximumInventory &&
      item.result.gridCycles >= minimumCycles)
    .sort((left, right) => right.result.netLiquidationPnl - left.result.netLiquidationPnl)[0]?.key || null;
}

function selected(scope, selectedBySide) {
  const LONG = scope.aggregate[selectedBySide.LONG].LONG;
  const SHORT = scope.aggregate[selectedBySide.SHORT].SHORT;
  return { LONG, SHORT, combined: combined(LONG, SHORT) };
}

function applySelection(report) {
  const selectedBySide = {
    LONG: chooseOnTraining(report.train, 'LONG') || 'nearest',
    SHORT: chooseOnTraining(report.train, 'SHORT') || 'nearest',
  };
  const fullSelection = selected(report.full, selectedBySide);
  const outOfSampleSelection = selected(report.outOfSample, selectedBySide);
  const baseline = report.outOfSample.aggregate.nearest.combined;
  const validation = outOfSampleSelection.combined.netLiquidationPnl > baseline.netLiquidationPnl &&
    outOfSampleSelection.combined.sumOfPerSymbolMaximumDrawdowns <=
      baseline.sumOfPerSymbolMaximumDrawdowns * 1.25 &&
    outOfSampleSelection.combined.finalInventoryNotional <= baseline.finalInventoryNotional * 2 + 5 &&
    outOfSampleSelection.combined.gridCycles >= baseline.gridCycles * 0.75
    ? 'PASS' : 'FAIL';
  report.selection = {
    selectedBySide,
    validation,
    training: selected(report.train, selectedBySide),
    full: fullSelection,
    outOfSample: outOfSampleSelection,
    limits: {
      trainingSideMaxDrawdownRatio: 1.5,
      trainingSideMaxInventoryRatio: 2,
      outOfSampleCombinedMaxDrawdownRatio: 1.25,
      outOfSampleCombinedMaxInventoryRatio: 2,
      minimumCycleRatio: 0.75,
    },
  };
  return report;
}

function writeReport(report) {
  fs.mkdirSync(RESULTS_DIRECTORY, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIRECTORY, 'fibonacci-exit-target-backtest.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIRECTORY, 'fibonacci-exit-target-backtest.md'), renderMarkdown(report));
  console.log(renderMarkdown(report));
}

function renderMarkdown(report) {
  const lines = [
    '# Fibonacci Exit Target Backtest', '',
    `Period: ${report.period.start} to ${report.period.end}`, '',
    `Train/test split: ${report.period.splitAt}`, '',
    '| Scope | Exit target | Combined PnL | LONG | SHORT | Realized | Sum max DD | Cycles | Final inventory |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scopeName of ['full', 'train', 'outOfSample']) {
    for (const variant of VARIANTS) {
      const item = report[scopeName].aggregate[variant.key];
      lines.push(`| ${scopeName} | ${variant.label} | ${item.combined.netLiquidationPnl} | ${item.LONG.netLiquidationPnl} | ${item.SHORT.netLiquidationPnl} | ${item.combined.realizedCashPnl} | ${item.combined.sumOfPerSymbolMaximumDrawdowns} | ${item.combined.gridCycles} | ${item.combined.finalInventoryNotional} |`);
    }
  }
  lines.push('', '## Selected asymmetric profile', '',
    '| Scope | LONG target | SHORT target | Combined PnL | Realized | Sum max DD | Cycles | Final inventory |',
    '|---|---|---|---:|---:|---:|---:|---:|');
  for (const [scopeName, result] of [
    ['full', report.selection.full],
    ['train', report.selection.training],
    ['outOfSample', report.selection.outOfSample],
  ]) {
    lines.push(`| ${scopeName} | ${report.selection.selectedBySide.LONG} | ${report.selection.selectedBySide.SHORT} | ${result.combined.netLiquidationPnl} | ${result.combined.realizedCashPnl} | ${result.combined.sumOfPerSymbolMaximumDrawdowns} | ${result.combined.gridCycles} | ${result.combined.finalInventoryNotional} |`);
  }
  lines.push('', '## Walk-forward selection', '',
    `- LONG selected using training only: ${report.selection.selectedBySide.LONG}.`,
    `- SHORT selected using training only: ${report.selection.selectedBySide.SHORT}.`,
    `- Out-of-sample validation against nearest level: ${report.selection.validation}.`,
    '', '## Assumptions', '',
    '- Every target remains a Fibonacci grid level beyond fee-adjusted minimum profit.',
    '- Entry rules match the currently selected LONG 15m/10% and SHORT 1h/2.5% Volume Delta guards.',
    '- LONG still requires Fibonacci BULLISH and SHORT still requires Fibonacci BEARISH.',
    '- Candidate selection uses only the first 45 days; the final 45 days remain untouched validation data.',
    '- Training candidates must retain at least 75% of cycles and stay within 1.5x drawdown and 2x ending inventory; out-of-sample combined drawdown is capped at 1.25x.',
    '- Net liquidation PnL marks remaining inventory to the final candle, while realized PnL and final inventory are reported separately.',
    '- Queue position, slippage, latency, liquidation tiers, and exact intrabar ordering are not simulated.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

async function main() {
  if (process.argv.includes('--reuse-results')) {
    const reportPath = path.join(RESULTS_DIRECTORY, 'fibonacci-exit-target-backtest.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    writeReport(applySelection(report));
    return;
  }
  const reference = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  const symbols = reference.symbols;
  const start = Date.parse(reference.period.start);
  const end = Date.parse(reference.period.end);
  const splitAt = Date.parse(reference.period.splitAt);
  const baseOptions = reference.configuration;
  const scopes = {
    full: { start, end, perSymbol: {} },
    train: { start, end: splitAt, perSymbol: {} },
    outOfSample: { start: splitAt, end, perSymbol: {} },
  };
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  try {
    for (const symbol of symbols) {
      console.log(`[EXIT TARGET] ${symbol}`);
      const rawRows = cachedRows(symbol, start, end);
      const rows = rawRows.map(row => row.slice(0, 6).map(Number));
      const fundingRates = await fetchFundingRates(exchange, symbol, start, end, FUNDING_DIRECTORY);
      const minimumNotional = Number(exchange.market(symbol)?.limits?.cost?.min) || 5;
      const volumeDeltaMaps = {
        LONG: buildAnalysisMap(rawRows, 3),
        SHORT: buildAnalysisMap(rawRows, 12),
      };
      const simulators = { LONG: {}, SHORT: {} };
      let sharedPreparedSeriesCache = null;
      let sharedDirectionAggregateCache = null;
      for (const side of ['LONG', 'SHORT']) {
        for (const variant of VARIANTS) {
          const options = {
            ...baseOptions[side], minimumNotional,
            exitTargetLevelOffset: variant.exitTargetLevelOffset || 0,
            exitTargetFurthest: Boolean(variant.exitTargetFurthest),
          };
          const simulator = new FullGridBacktester(exchange, options);
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
          for (const variant of VARIANTS) {
            scope.perSymbol[symbol][side][variant.key] = simulators[side][variant.key].simulate({
              symbol, rows, fundingRates, start: scope.start, end: scope.end,
              adaptive: false,
              entryDecisionProvider: ({ timestamp }) => evaluateVolumeDeltaEntry(
                volumeDeltaMaps[side].get(timestamp), side,
                { oppositionThresholdPct: side === 'SHORT' ? 2.5 : 10, failClosed: false }
              ),
              variant: `${side.toLowerCase()}-${variant.key}`,
            });
          }
        }
      }
    }
  } finally {
    await exchange.close();
  }
  for (const scope of Object.values(scopes)) {
    aggregateScope(scope, symbols, baseOptions.LONG, baseOptions.SHORT);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    period: reference.period,
    symbols,
    variants: VARIANTS,
    ...scopes,
  };
  writeReport(applySelection(report));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[EXIT TARGET] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { VARIANTS, applySelection, chooseOnTraining };
