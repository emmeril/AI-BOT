#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester } = require('../src/full-grid-backtester');
const { aggregate, fetchFundingRates } = require('./backtest-full-grid-pnl');
const {
  buildAnalysisMap,
  cachedRows,
  combined,
  round,
} = require('./backtest-exit-targets');
const { evaluateVolumeDeltaEntry } = require('../src/volume-delta-analyzer');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const REFERENCE_PATH = path.resolve('backtest-results/scalping-volume-delta-backtest.json');
const FUNDING_DIRECTORY = path.resolve('backtest-data/funding');
const RESULTS_DIRECTORY = path.resolve('backtest-results');
const STRATEGIES = Object.freeze([
  {
    key: 'direction_gated',
    label: 'Fibonacci direction gate + Volume Delta',
    longEntryDirection: 'BULLISH',
    shortEntryDirection: 'BEARISH',
    longThresholdPct: 10,
    shortThresholdPct: 2.5,
  },
  {
    key: 'direct_grid',
    label: 'Direct Fibonacci grid + Volume Delta only',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    longThresholdPct: 10,
    shortThresholdPct: 2.5,
  },
  {
    key: 'direct_confirmed',
    label: 'Direct Fibonacci grid + same-side Volume Delta',
    longEntryDirection: 'ALWAYS',
    shortEntryDirection: 'ALWAYS',
    longThresholdPct: 0,
    shortThresholdPct: 0,
  },
]);

function aggregateScope(scope, symbols, baseOptions) {
  scope.aggregate = {};
  for (const strategy of STRATEGIES) {
    const LONG = aggregate(
      symbols.map(symbol => scope.perSymbol[symbol].LONG[strategy.key]),
      baseOptions.LONG
    );
    const SHORT = aggregate(
      symbols.map(symbol => scope.perSymbol[symbol].SHORT[strategy.key]),
      baseOptions.SHORT
    );
    scope.aggregate[strategy.key] = { LONG, SHORT, combined: combined(LONG, SHORT) };
  }
}

function comparison(scope, candidateKey) {
  const baseline = scope.aggregate.direction_gated.combined;
  const candidate = scope.aggregate[candidateKey].combined;
  return {
    pnlDelta: round(candidate.netLiquidationPnl - baseline.netLiquidationPnl),
    pnlDeltaPct: round((candidate.netLiquidationPnl / baseline.netLiquidationPnl - 1) * 100, 3),
    drawdownDelta: round(
      candidate.sumOfPerSymbolMaximumDrawdowns - baseline.sumOfPerSymbolMaximumDrawdowns
    ),
    drawdownRatio: round(
      candidate.sumOfPerSymbolMaximumDrawdowns / baseline.sumOfPerSymbolMaximumDrawdowns,
      3
    ),
    cycleDelta: candidate.gridCycles - baseline.gridCycles,
    inventoryDelta: round(candidate.finalInventoryNotional - baseline.finalInventoryNotional),
  };
}

function validate(report, candidateKey) {
  const trainingCurrent = report.train.aggregate.direction_gated.combined;
  const trainingDirect = report.train.aggregate[candidateKey].combined;
  const oosCurrent = report.outOfSample.aggregate.direction_gated.combined;
  const oosDirect = report.outOfSample.aggregate[candidateKey].combined;
  return trainingDirect.netLiquidationPnl > trainingCurrent.netLiquidationPnl &&
    oosDirect.netLiquidationPnl > oosCurrent.netLiquidationPnl &&
    oosDirect.sumOfPerSymbolMaximumDrawdowns <=
      oosCurrent.sumOfPerSymbolMaximumDrawdowns * 1.25 &&
    oosDirect.finalInventoryNotional <= oosCurrent.finalInventoryNotional * 2 + 5 &&
    oosDirect.gridCycles >= oosCurrent.gridCycles * 0.75
    ? 'PASS' : 'FAIL';
}

function renderMarkdown(report) {
  const lines = [
    '# Direct Fibonacci Grid + Volume Delta Backtest', '',
    `Period: ${report.period.start} to ${report.period.end}`, '',
    `Train/test split: ${report.period.splitAt}`, '',
    '| Scope | Strategy | Combined PnL | LONG | SHORT | Realized | Sum max DD | Cycles | Final inventory |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scopeName of ['full', 'train', 'outOfSample']) {
    for (const strategy of STRATEGIES) {
      const item = report[scopeName].aggregate[strategy.key];
      lines.push(`| ${scopeName} | ${strategy.label} | ${item.combined.netLiquidationPnl} | ${item.LONG.netLiquidationPnl} | ${item.SHORT.netLiquidationPnl} | ${item.combined.realizedCashPnl} | ${item.combined.sumOfPerSymbolMaximumDrawdowns} | ${item.combined.gridCycles} | ${item.combined.finalInventoryNotional} |`);
    }
  }
  lines.push('', '## Validation', '',
    `- Opposition-guard direct grid: ${report.validation.direct_grid}.`,
    `- Same-side-confirmed direct grid: ${report.validation.direct_confirmed}.`,
    `- Opposition-guard full-period PnL delta: ${report.comparison.direct_grid.full.pnlDelta} USDT (${report.comparison.direct_grid.full.pnlDeltaPct}%).`,
    `- Same-side-confirmed full-period PnL delta: ${report.comparison.direct_confirmed.full.pnlDelta} USDT (${report.comparison.direct_confirmed.full.pnlDeltaPct}%).`,
    '', '## Rules', '',
    '- Both strategies use the same multi-timeframe Fibonacci ranges and levels.',
    '- The baseline uses LONG 3x5m/10% and SHORT 12x5m/2.5% opposition guards; the strict direct variant requires same-side delta.',
    '- Both use the nearest fee-adjusted profitable Fibonacci exit level.',
    '- Order size and per-symbol exposure match live: LONG 5 USDT, SHORT 6 USDT, maximum 22 USDT per pair.',
    '- Direct grid removes only the BULLISH LONG / BEARISH SHORT entry-direction gate.',
    '- The first 45 days are training and the final 45 days are untouched out-of-sample validation.',
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
  const scopes = {
    full: { start, end, perSymbol: {} },
    train: { start, end: splitAt, perSymbol: {} },
    outOfSample: { start: splitAt, end, perSymbol: {} },
  };
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  try {
    for (const symbol of symbols) {
      console.log(`[DIRECT GRID] ${symbol}`);
      const rawRows = cachedRows(symbol, start, end);
      const rows = rawRows.map(row => row.slice(0, 6).map(Number));
      const fundingRates = await fetchFundingRates(
        exchange, symbol, start, end, FUNDING_DIRECTORY
      );
      const minimumNotional = Number(exchange.market(symbol)?.limits?.cost?.min) || 5;
      const volumeDeltaMaps = {
        LONG: buildAnalysisMap(rawRows, 3),
        SHORT: buildAnalysisMap(rawRows, 12),
      };
      const simulators = {};
      let sharedPreparedSeriesCache = null;
      let sharedDirectionAggregateCache = null;
      for (const side of ['LONG', 'SHORT']) {
        simulators[side] = {};
        for (const strategy of STRATEGIES) {
          const options = {
            ...reference.configuration[side],
            minimumNotional,
            orderSizeUsdt: side === 'SHORT' ? 6 : 5,
            maxExposureUsdt: 22,
            exitTargetLevelOffset: 0,
            longEntryDirection: strategy.longEntryDirection,
            shortEntryDirection: strategy.shortEntryDirection,
          };
          const simulator = new FullGridBacktester(exchange, options);
          if (sharedPreparedSeriesCache) {
            simulator.preparedSeriesCache = sharedPreparedSeriesCache;
            simulator.directionAggregateCache = sharedDirectionAggregateCache;
          } else {
            sharedPreparedSeriesCache = simulator.preparedSeriesCache;
            sharedDirectionAggregateCache = simulator.directionAggregateCache;
          }
          simulators[side][strategy.key] = { simulator, options };
        }
      }
      for (const scope of Object.values(scopes)) {
        scope.perSymbol[symbol] = { LONG: {}, SHORT: {} };
        for (const side of ['LONG', 'SHORT']) {
          for (const strategy of STRATEGIES) {
            const { simulator } = simulators[side][strategy.key];
            scope.perSymbol[symbol][side][strategy.key] = simulator.simulate({
              symbol,
              rows,
              fundingRates,
              start: scope.start,
              end: scope.end,
              adaptive: false,
              entryDecisionProvider: ({ timestamp }) => evaluateVolumeDeltaEntry(
                volumeDeltaMaps[side].get(timestamp),
                side,
                {
                  oppositionThresholdPct: side === 'SHORT'
                    ? strategy.shortThresholdPct
                    : strategy.longThresholdPct,
                  failClosed: false,
                }
              ),
              variant: `${side.toLowerCase()}-${strategy.key}`,
            });
          }
        }
      }
    }
  } finally {
    await exchange.close();
  }
  for (const scope of Object.values(scopes)) {
    aggregateScope(scope, symbols, reference.configuration);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    period: reference.period,
    symbols,
    strategies: STRATEGIES,
    ...scopes,
  };
  report.comparison = {
    direct_grid: {
      full: comparison(report.full, 'direct_grid'),
      train: comparison(report.train, 'direct_grid'),
      outOfSample: comparison(report.outOfSample, 'direct_grid'),
    },
    direct_confirmed: {
      full: comparison(report.full, 'direct_confirmed'),
      train: comparison(report.train, 'direct_confirmed'),
      outOfSample: comparison(report.outOfSample, 'direct_confirmed'),
    },
  };
  report.validation = {
    direct_grid: validate(report, 'direct_grid'),
    direct_confirmed: validate(report, 'direct_confirmed'),
  };
  fs.mkdirSync(RESULTS_DIRECTORY, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIRECTORY, 'fibonacci-volume-delta-direct-backtest.json'),
    JSON.stringify(report, null, 2)
  );
  fs.writeFileSync(
    path.join(RESULTS_DIRECTORY, 'fibonacci-volume-delta-direct-backtest.md'),
    renderMarkdown(report)
  );
  console.log(renderMarkdown(report));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[DIRECT GRID] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { STRATEGIES, comparison, validate };
