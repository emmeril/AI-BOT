#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester, DEFAULT_OPTIONS } = require('../src/full-grid-backtester');
const { aggregate, fetchFundingRates, loadCachedRows } = require('./backtest-full-grid-pnl');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const DAY_MS = 86_400_000;
const DEFAULT_SYMBOLS = [
  '1000SHIB/USDT:USDT',
  '1000PEPE/USDT:USDT',
  '1000BONK/USDT:USDT',
  'PENGU/USDT:USDT',
  'JUP/USDT:USDT',
];
const VARIANTS = {
  strict: { controlledHandoff: false, handoffMinimumNetProfitPct: 0 },
  buffered24h: {
    controlledHandoff: true,
    handoffMinimumNetProfitPct: 0.02,
    handoffEntryCooldownMs: 24 * 60 * 60_000,
  },
  buffered48h: {
    controlledHandoff: true,
    handoffMinimumNetProfitPct: 0.02,
    handoffEntryCooldownMs: 48 * 60 * 60_000,
  },
};

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sum(items, key) {
  return items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
}

function profileAggregate(results, options) {
  return {
    ...aggregate(results, options),
    longEntryFills: sum(results, 'longEntryFills'),
    shortEntryFills: sum(results, 'shortEntryFills'),
    handoffSignals: sum(results, 'handoffSignals'),
    handoffCompleted: sum(results, 'handoffCompleted'),
    handoffCancelled: sum(results, 'handoffCancelled'),
    handoffExitFills: sum(results, 'handoffExitFills'),
  };
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function compare(candidate, baseline) {
  return {
    netPnlDelta: round(candidate.netLiquidationPnl - baseline.netLiquidationPnl),
    drawdownDelta: round(
      candidate.sumOfPerSymbolMaximumDrawdowns - baseline.sumOfPerSymbolMaximumDrawdowns
    ),
    cycleDelta: candidate.gridCycles - baseline.gridCycles,
  };
}

function candidateIsSafe(report, variant) {
  return Object.keys(report.profiles).every(profile => ['full', 'outOfSample'].every(scope => {
    const baseline = report.results[scope][profile].aggregate.strict;
    const candidate = report.results[scope][profile].aggregate[variant];
    return candidate.sumOfPerSymbolMaximumDrawdowns <=
      baseline.sumOfPerSymbolMaximumDrawdowns + 1e-8;
  }));
}

function renderMarkdown(report) {
  const lines = [
    '# Mutual Direction Handoff Backtest',
    '',
    `Period: ${report.period.start} to ${report.period.end} (90 days)`,
    '',
    `Out-of-sample: ${report.period.splitAt} to ${report.period.end}`,
    '',
    `Selected: ${report.selection.selected || 'none'}`,
    '',
    '| Scope | Sizing | Variant | Net PnL | Sum max DD | Cycles | LONG entries | SHORT entries | Handoffs completed |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scope of ['full', 'outOfSample']) {
    for (const profile of Object.keys(report.profiles)) {
      for (const variant of Object.keys(VARIANTS)) {
        const item = report.results[scope][profile].aggregate[variant];
        lines.push(
          `| ${scope} | ${profile} | ${variant} | ${item.netLiquidationPnl} | ` +
          `${item.sumOfPerSymbolMaximumDrawdowns} | ${item.gridCycles} | ${item.longEntryFills} | ` +
          `${item.shortEntryFills} | ${item.handoffCompleted} |`
        );
      }
    }
  }
  lines.push('', '## Selection rule', '');
  lines.push(
    '- A candidate is eligible only when its sum of per-symbol maximum drawdowns does not exceed strict mutual exclusion in both sizing profiles and in both the full and out-of-sample periods.',
    '- The 24-hour cooldown is preferred when both candidates pass; the 48-hour variant is a more conservative fallback.',
    '',
    '## Limitations',
    '',
    '- Fills use 15-minute OHLC touches and assume maker execution; queue priority, slippage, latency, and rejected post-only orders are unavailable.',
    '- Fees, historical funding, exposure caps, Fibonacci direction confirmation, range resets, and final mark-to-market liquidation are included.',
    '- The two sizing profiles bracket the live LONG and SHORT configurations; capital is not dynamically resized during a side transition.',
    '- Liquidation and maintenance-margin tiers are not simulated.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

async function main() {
  const symbols = (process.env.BACKTEST_SYMBOLS || process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  const dataDirectory = path.resolve(process.cwd(), 'backtest-data', 'fibonacci-direction');
  const fundingDirectory = path.resolve(process.cwd(), 'backtest-data', 'funding');
  const resultsDirectory = path.resolve(process.cwd(), 'backtest-results');
  const cachedRows = Object.fromEntries(symbols.map(symbol => [symbol, loadCachedRows(dataDirectory, symbol)]));
  const end = Math.min(...symbols.map(symbol => Number(cachedRows[symbol].at(-1)?.[0]) + 15 * 60_000));
  const start = end - 90 * DAY_MS;
  const splitAt = end - 45 * DAY_MS;
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  const common = {
    ...DEFAULT_OPTIONS,
    leverage: numberFromEnv('LEVERAGE', 5),
    maxRefills: numberFromEnv('GRID_MAX_REFILLS', 2),
    makerFeeRate: numberFromEnv('BINANCE_FUTURES_MAKER_FEE_RATE', 0.0002),
    minimumNetProfitPct: numberFromEnv('GRID_MIN_NET_PROFIT_PCT', 0.05),
    directionMinimumConfidence: numberFromEnv('FIBONACCI_DIRECTION_MIN_CONFIDENCE', 0.65),
    directionStrategy: process.env.FIBONACCI_DIRECTION_STRATEGY || 'EMA_SLOPE_MEAN_REVERSION',
    directionEmaSlopeAtrThreshold: numberFromEnv('FIBONACCI_DIRECTION_EMA_SLOPE_ATR_THRESHOLD', 1),
    directionLevelBiasPct: numberFromEnv('FIBONACCI_DIRECTION_LEVEL_BIAS_PCT', 10),
    shortEntryDirection: 'BEARISH',
    mutualExclusion: true,
  };
  const profiles = {
    longSizing: {
      gridCount: numberFromEnv('GRID_COUNT', 27),
      totalInvestment: numberFromEnv('GRID_TOTAL_INVESTMENT_USDT', 150),
      maxActiveBuyOrders: numberFromEnv('GRID_MAX_ACTIVE_BUY_ORDERS', 20),
    },
    shortSizing: {
      gridCount: numberFromEnv('SHORT_GRID_COUNT', 10),
      totalInvestment: numberFromEnv('SHORT_GRID_TOTAL_INVESTMENT_USDT', 60),
      maxActiveBuyOrders: numberFromEnv('SHORT_GRID_MAX_ACTIVE_BUY_ORDERS', 10),
    },
  };
  const results = {
    full: Object.fromEntries(Object.keys(profiles).map(name => [name, { perSymbol: {} }])),
    outOfSample: Object.fromEntries(Object.keys(profiles).map(name => [name, { perSymbol: {} }])),
  };

  try {
    for (const symbol of symbols) {
      const rows = cachedRows[symbol];
      if (Number(rows[0]?.[0]) > start) throw new Error(`${symbol} cache does not cover 90 days`);
      const fundingRates = await fetchFundingRates(exchange, symbol, start, end, fundingDirectory);
      const minimumNotional = Number(exchange.market(symbol)?.limits?.cost?.min) || 5;
      for (const [profileName, profile] of Object.entries(profiles)) {
        const options = { ...common, ...profile, minimumNotional };
        const simulator = new FullGridBacktester(exchange, options);
        for (const [variantName, variant] of Object.entries(VARIANTS)) {
          const variantOptions = { ...options, ...variant };
          simulator.options = variantOptions;
          results.full[profileName].perSymbol[symbol] ||= {};
          results.outOfSample[profileName].perSymbol[symbol] ||= {};
          results.full[profileName].perSymbol[symbol][variantName] = simulator.simulate({
            symbol, rows, fundingRates, start, end, variant: variantName,
          });
          results.outOfSample[profileName].perSymbol[symbol][variantName] = simulator.simulate({
            symbol, rows, fundingRates, start: splitAt, end, variant: variantName,
          });
        }
      }
      console.log(`[BACKTEST] completed ${symbol}`);
    }
  } finally {
    await exchange.close();
  }

  for (const scope of Object.values(results)) {
    for (const [profileName, profileResult] of Object.entries(scope)) {
      profileResult.aggregate = {};
      profileResult.comparison = {};
      for (const variantName of Object.keys(VARIANTS)) {
        const items = symbols.map(symbol => profileResult.perSymbol[symbol][variantName]);
        profileResult.aggregate[variantName] = profileAggregate(items, { ...common, ...profiles[profileName] });
        if (variantName !== 'strict') {
          profileResult.comparison[variantName] = compare(
            profileResult.aggregate[variantName], profileResult.aggregate.strict
          );
        }
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    period: {
      start: new Date(start).toISOString(),
      splitAt: new Date(splitAt).toISOString(),
      end: new Date(end).toISOString(),
    },
    symbols,
    profiles,
    variants: VARIANTS,
    results,
    selection: { selected: null, safeCandidates: [] },
  };
  report.selection.safeCandidates = ['buffered24h', 'buffered48h']
    .filter(name => candidateIsSafe(report, name));
  report.selection.selected = report.selection.safeCandidates[0] || null;

  fs.mkdirSync(resultsDirectory, { recursive: true });
  const jsonPath = path.join(resultsDirectory, 'mutual-handoff-backtest.json');
  const markdownPath = path.join(resultsDirectory, 'mutual-handoff-backtest.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(report));
  console.log(renderMarkdown(report));
  console.log(`[BACKTEST] JSON: ${jsonPath}`);
  console.log(`[BACKTEST] Markdown: ${markdownPath}`);
  if (!report.selection.selected) process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[BACKTEST] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { VARIANTS, candidateIsSafe, renderMarkdown };
