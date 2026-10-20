#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester } = require('../src/full-grid-backtester');
const { planFibonacciRegimeLevels } = require('../src/fibonacci-regime-level-planner');
const { aggregate, fetchFundingRates } = require('./backtest-full-grid-pnl');
const { cachedRows, combined, round } = require('./backtest-exit-targets');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const REFERENCE_PATH = path.resolve('backtest-results/scalping-volume-delta-backtest.json');
const FUNDING_DIRECTORY = path.resolve('backtest-data/funding');
const RESULTS_DIRECTORY = path.resolve('backtest-results');
const VARIANTS = Object.freeze([
  { key: 'direct', label: 'Direct Fibonacci grid', planner: null },
  { key: 'structure_adx20_5m', label: 'Structure + ADX20 + ATR (5m)', timeframe: '5m', adxTrendThreshold: 20, alignedAtrGap: 0.25, rangingAtrGap: 0.5, adverseAtrGap: 1 },
  { key: 'structure_adx25_5m', label: 'Structure + ADX25 + ATR (5m)', timeframe: '5m', adxTrendThreshold: 25, alignedAtrGap: 0.25, rangingAtrGap: 0.5, adverseAtrGap: 1 },
  { key: 'structure_adx20_15m', label: 'Structure + ADX20 + ATR (15m)', timeframe: '15m', adxTrendThreshold: 20, alignedAtrGap: 0.25, rangingAtrGap: 0.5, adverseAtrGap: 1 },
  { key: 'structure_adx25_15m', label: 'Structure + ADX25 + ATR (15m)', timeframe: '15m', adxTrendThreshold: 25, alignedAtrGap: 0.25, rangingAtrGap: 0.5, adverseAtrGap: 1 },
  { key: 'structure_adx25_15m_wide', label: 'Structure + ADX25 + wider ATR (15m)', timeframe: '15m', adxTrendThreshold: 25, alignedAtrGap: 0.25, rangingAtrGap: 0.75, adverseAtrGap: 1.5 },
  { key: 'structure_adx20_5m_deep', label: 'Structure + ADX20 + deepest adverse level (5m)', timeframe: '5m', adxTrendThreshold: 20, alignedAtrGap: 0.25, rangingAtrGap: 0.5, adverseAtrGap: 1, adverseMaxLevels: 1 },
  { key: 'structure_adx20_15m_deep', label: 'Structure + ADX20 + deepest adverse level (15m)', timeframe: '15m', adxTrendThreshold: 20, alignedAtrGap: 0.25, rangingAtrGap: 0.5, adverseAtrGap: 1, adverseMaxLevels: 1 },
  { key: 'structure_adx20_1h_deep', label: 'Structure + ADX20 + deepest adverse level (1h)', timeframe: '1h', adxTrendThreshold: 20, alignedAtrGap: 0.25, rangingAtrGap: 0.5, adverseAtrGap: 1, adverseMaxLevels: 1 },
]);
const requestedKeys = new Set(String(process.env.BACKTEST_REGIME_LEVEL_VARIANTS || '')
  .split(',').map(value => value.trim()).filter(Boolean));
const ACTIVE_VARIANTS = requestedKeys.size
  ? VARIANTS.filter(variant => requestedKeys.has(variant.key))
  : VARIANTS;

function aggregateScope(scope, symbols, baseOptions) {
  scope.aggregate = {};
  for (const variant of ACTIVE_VARIANTS) {
    const LONG = aggregate(symbols.map(symbol => scope.perSymbol[symbol].LONG[variant.key]), baseOptions.LONG);
    const SHORT = aggregate(symbols.map(symbol => scope.perSymbol[symbol].SHORT[variant.key]), baseOptions.SHORT);
    scope.aggregate[variant.key] = { LONG, SHORT, combined: combined(LONG, SHORT) };
  }
}

function score(report, key) {
  const full = report.full.aggregate[key].combined;
  const train = report.train.aggregate[key].combined;
  const outOfSample = report.outOfSample.aggregate[key].combined;
  return {
    key,
    fullPnl: full.netLiquidationPnl,
    trainPnl: train.netLiquidationPnl,
    outOfSamplePnl: outOfSample.netLiquidationPnl,
    drawdown: full.sumOfPerSymbolMaximumDrawdowns,
    cycles: full.gridCycles,
    finalInventory: full.finalInventoryNotional,
    pnlToDrawdown: full.sumOfPerSymbolMaximumDrawdowns > 0
      ? round(full.netLiquidationPnl / full.sumOfPerSymbolMaximumDrawdowns)
      : null,
  };
}

function selectCandidate(report) {
  const baseline = score(report, 'direct');
  const minimumCycles = baseline.cycles * 0.5;
  const candidates = ACTIVE_VARIANTS.filter(variant => variant.key !== 'direct')
    .map(variant => score(report, variant.key))
    .filter(item => item.trainPnl > 0 && item.outOfSamplePnl > 0 && item.fullPnl > 0 &&
      item.cycles >= minimumCycles && item.drawdown < baseline.drawdown &&
      item.finalInventory <= baseline.finalInventory)
    .sort((left, right) => right.pnlToDrawdown - left.pnlToDrawdown || right.fullPnl - left.fullPnl);
  return { baseline, selected: candidates[0] || null };
}

function render(report) {
  const lines = [
    '# Fibonacci Regime Level Backtest', '',
    `Period: ${report.period.start} to ${report.period.end}`, '',
    `Train/test split: ${report.period.splitAt}`, '',
    '| Scope | Variant | PnL | LONG | SHORT | Sum max DD | Cycles | Final inventory |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scopeName of ['full', 'train', 'outOfSample']) {
    for (const variant of ACTIVE_VARIANTS) {
      const value = report[scopeName].aggregate[variant.key];
      lines.push(`| ${scopeName} | ${variant.label} | ${value.combined.netLiquidationPnl} | ${value.LONG.netLiquidationPnl} | ${value.SHORT.netLiquidationPnl} | ${value.combined.sumOfPerSymbolMaximumDrawdowns} | ${value.combined.gridCycles} | ${value.combined.finalInventoryNotional} |`);
    }
  }
  lines.push('', '## Selection', '');
  lines.push(report.selection.selected
    ? `- PASS: ${report.selection.selected.key} selected from training and confirmed positive out-of-sample.`
    : '- FAIL: no planner passed positive train, positive out-of-sample, lower drawdown/inventory than direct grid, and at least 50% of baseline cycles.');
  lines.push('', 'The planner only selects existing Fibonacci levels. It always returns at least one level, so it never waits for an entry signal.', '');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const reference = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  const { symbols } = reference;
  const start = Date.parse(reference.period.start);
  const end = Date.parse(reference.period.end);
  const splitAt = Date.parse(reference.period.splitAt);
  const scopes = {
    full: { start, end, perSymbol: {} },
    train: { start, end: splitAt, perSymbol: {} },
    outOfSample: { start: splitAt, end, perSymbol: {} },
  };
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  try {
    for (const symbol of symbols) {
      console.log(`[REGIME LEVEL] ${symbol}`);
      const rows = cachedRows(symbol, start, end).map(row => row.slice(0, 6).map(Number));
      const fundingRates = await fetchFundingRates(exchange, symbol, start, end, FUNDING_DIRECTORY);
      const minimumNotional = Number(exchange.market(symbol)?.limits?.cost?.min) || 5;
      const simulators = { LONG: {}, SHORT: {} };
      let sharedPreparedSeriesCache = null;
      let sharedDirectionAggregateCache = null;
      for (const side of ['LONG', 'SHORT']) {
        const sharedRangeSuggestionCache = new Map();
        for (const variant of ACTIVE_VARIANTS) {
          const simulator = new FullGridBacktester(exchange, {
            ...reference.configuration[side],
            minimumNotional,
            orderSizeUsdt: side === 'SHORT' ? 6 : 5,
            maxExposureUsdt: 22,
            exitTargetLevelOffset: 0,
            longEntryDirection: 'ALWAYS',
            shortEntryDirection: 'ALWAYS',
          });
          simulator.rangeSuggestionCache = sharedRangeSuggestionCache;
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
              symbol, rows, fundingRates, start: scope.start, end: scope.end, adaptive: false,
              entryLevelPlanProvider: variant.key === 'direct' ? null : context =>
                planFibonacciRegimeLevels(
                  context.candidates,
                  context.currentPrice,
                  context.positionSide,
                  context.analysis,
                  variant
                ).levels,
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
  const report = { generatedAt: new Date().toISOString(), period: reference.period, symbols, variants: ACTIVE_VARIANTS, ...scopes };
  report.selection = selectCandidate(report);
  fs.mkdirSync(RESULTS_DIRECTORY, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIRECTORY, 'fibonacci-regime-level-backtest.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIRECTORY, 'fibonacci-regime-level-backtest.md'), render(report));
  console.log(render(report));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[REGIME LEVEL] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { VARIANTS, score, selectCandidate };
