#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester, DEFAULT_OPTIONS } = require('../src/full-grid-backtester');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const DAY_MS = 86_400_000;
const DEFAULT_SYMBOLS = [
  '1000SHIB/USDT:USDT',
  '1000PEPE/USDT:USDT',
  '1000BONK/USDT:USDT',
  'PENGU/USDT:USDT',
  'JUP/USDT:USDT',
];

function safeName(symbol) {
  return symbol.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function parseDate(value, fallback) {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function loadCachedRows(cacheDirectory, symbol) {
  const prefix = `${safeName(symbol)}-15m-`;
  const candidates = fs.readdirSync(cacheDirectory)
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
  if (!candidates.length) throw new Error(`No cached 15m data for ${symbol} in ${cacheDirectory}`);
  return JSON.parse(fs.readFileSync(path.join(cacheDirectory, candidates.at(-1)), 'utf8'));
}

async function fetchFundingRates(exchange, symbol, since, until, cacheDirectory) {
  const cachePath = path.join(
    cacheDirectory,
    `${safeName(symbol)}-funding-${new Date(since).toISOString().slice(0, 10)}-${new Date(until).toISOString().slice(0, 10)}.json`
  );
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const records = new Map();
  let cursor = since;
  try {
    while (cursor < until) {
      const batch = await exchange.fetchFundingRateHistory(symbol, cursor, 1000);
      if (!Array.isArray(batch) || !batch.length) break;
      for (const item of batch) {
        const timestamp = Number(item.timestamp);
        const rate = Number(item.fundingRate);
        if (timestamp >= since && timestamp < until && Number.isFinite(rate)) {
          records.set(timestamp, { timestamp, rate });
        }
      }
      const lastTimestamp = Number(batch.at(-1)?.timestamp);
      if (!Number.isFinite(lastTimestamp) || lastTimestamp < cursor) break;
      cursor = lastTimestamp + 1;
      if (batch.length < 2) break;
    }
  } catch (error) {
    console.warn(`[FUNDING] ${symbol}: ${error.message}; continuing without uncached funding data`);
  }
  const result = [...records.values()].sort((left, right) => left.timestamp - right.timestamp);
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(result));
  return result;
}

function sum(items, key) {
  return items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
}

function aggregate(results, options) {
  const capitalNotional = options.totalInvestment * results.length;
  const initialMargin = capitalNotional / options.leverage;
  const net = sum(results, 'netLiquidationPnl');
  return {
    symbols: results.length,
    netLiquidationPnl: round(net),
    realizedCashPnl: round(sum(results, 'realizedCashPnl')),
    grossGridProfit: round(sum(results, 'grossGridProfit')),
    fundingPnl: round(sum(results, 'fundingPnl')),
    fees: round(sum(results, 'fees')),
    returnOnNotionalPct: round(net / capitalNotional * 100, 3),
    returnOnInitialMarginPct: round(net / initialMargin * 100, 3),
    sumOfPerSymbolMaximumDrawdowns: round(sum(results, 'maximumDrawdown')),
    buyFills: sum(results, 'buyFills'),
    sellFills: sum(results, 'sellFills'),
    gridCycles: sum(results, 'gridCycles'),
    rangeResets: sum(results, 'rangeResets'),
    finalInventoryNotional: round(sum(results, 'finalInventoryNotional')),
  };
}

function comparison(baseline, adaptive) {
  return {
    netPnlDelta: round(adaptive.netLiquidationPnl - baseline.netLiquidationPnl),
    netPnlDeltaPct: baseline.netLiquidationPnl
      ? round((adaptive.netLiquidationPnl / baseline.netLiquidationPnl - 1) * 100, 2)
      : null,
    feeDelta: round(adaptive.fees - baseline.fees),
    fundingDelta: round(adaptive.fundingPnl - baseline.fundingPnl),
    drawdownDelta: round(adaptive.sumOfPerSymbolMaximumDrawdowns - baseline.sumOfPerSymbolMaximumDrawdowns),
    cycleDelta: adaptive.gridCycles - baseline.gridCycles,
  };
}

function format(value, suffix = '') {
  return value === null || value === undefined ? 'n/a' : `${value}${suffix}`;
}

function renderMarkdown(report) {
  const lines = [
    '# Full-grid PnL Backtest',
    '',
    `Period: ${report.period.start} to ${report.period.end}`,
    '',
    `Symbols: ${report.symbols.join(', ')}`,
    '',
    '| Scope | Variant | Net liquidation PnL | Return / notional | Return / 5x margin | Fees | Funding | Grid cycles | Sum max DD |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scope of ['full', 'outOfSample']) {
    for (const variant of ['baseline', 'adaptive']) {
      const item = report[scope].aggregate[variant];
      lines.push(
        `| ${scope === 'full' ? 'Full period' : 'Out-of-sample'} | ${variant} | ` +
        `${format(item.netLiquidationPnl, ' USDT')} | ${format(item.returnOnNotionalPct, '%')} | ` +
        `${format(item.returnOnInitialMarginPct, '%')} | ${format(item.fees, ' USDT')} | ` +
        `${format(item.fundingPnl, ' USDT')} | ${item.gridCycles} | ` +
        `${format(item.sumOfPerSymbolMaximumDrawdowns, ' USDT')} |`
      );
    }
  }
  lines.push(
    '',
    '## Adaptive versus baseline',
    '',
    `- Full-period net PnL difference: ${report.full.comparison.netPnlDelta} USDT.`,
    `- Out-of-sample net PnL difference: ${report.outOfSample.comparison.netPnlDelta} USDT.`,
    `- Out-of-sample drawdown difference: ${report.outOfSample.comparison.drawdownDelta} USDT (negative is better).`,
    '',
    '## Full-period per symbol',
    '',
    '| Symbol | Baseline net | Adaptive net | Delta | Baseline cycles | Adaptive cycles | Baseline max DD | Adaptive max DD |',
    '|---|---:|---:|---:|---:|---:|---:|---:|'
  );
  for (const symbol of report.symbols) {
    const baseline = report.full.perSymbol[symbol].baseline;
    const adaptive = report.full.perSymbol[symbol].adaptive;
    lines.push(
      `| ${symbol} | ${baseline.netLiquidationPnl} | ${adaptive.netLiquidationPnl} | ` +
      `${round(adaptive.netLiquidationPnl - baseline.netLiquidationPnl)} | ${baseline.gridCycles} | ` +
      `${adaptive.gridCycles} | ${baseline.maximumDrawdown} | ${adaptive.maximumDrawdown} |`
    );
  }
  lines.push('', '## Assumptions and limitations', '');
  for (const assumption of report.assumptions) lines.push(`- ${assumption}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const symbols = (process.env.BACKTEST_SYMBOLS || process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  const dataDirectory = path.resolve(process.cwd(), 'backtest-data', 'fibonacci-direction');
  const fundingDirectory = path.resolve(process.cwd(), 'backtest-data', 'funding');
  const resultsDirectory = path.resolve(process.cwd(), 'backtest-results');
  const cachedRows = Object.fromEntries(symbols.map(symbol => [symbol, loadCachedRows(dataDirectory, symbol)]));
  const commonAvailableEnd = Math.min(...symbols.map(symbol =>
    Number(cachedRows[symbol].at(-1)?.[0]) + 15 * 60_000
  ));
  const end = parseDate(process.env.BACKTEST_END, Math.min(Date.now(), commonAvailableEnd));
  const start = parseDate(process.env.BACKTEST_START, end - 365 * DAY_MS);
  if (!(start < end)) throw new Error('BACKTEST_START must be before BACKTEST_END');
  const splitAt = start + Math.floor((end - start) / 2);
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  const options = {
    ...DEFAULT_OPTIONS,
    gridCount: Number(process.env.GRID_COUNT) || 27,
    totalInvestment: Number(process.env.GRID_TOTAL_INVESTMENT_USDT) || 150,
    leverage: Number(process.env.LEVERAGE) || 5,
    maxActiveBuyOrders: Number(process.env.GRID_MAX_ACTIVE_BUY_ORDERS) || 20,
    maxRefills: Number(process.env.GRID_MAX_REFILLS) || 2,
    makerFeeRate: Number(process.env.BINANCE_FUTURES_MAKER_FEE_RATE) || 0.0002,
    minimumNetProfitPct: Number(process.env.GRID_MIN_NET_PROFIT_PCT) || 0.05,
  };
  const full = { perSymbol: {} };
  const outOfSample = { perSymbol: {} };

  try {
    for (const symbol of symbols) {
      const rows = cachedRows[symbol];
      const availableStart = Number(rows[0]?.[0]);
      const availableEnd = Number(rows.at(-1)?.[0]) + 15 * 60_000;
      if (availableStart > start || availableEnd < end) {
        throw new Error(`${symbol} cache does not cover requested period`);
      }
      console.log(`[BACKTEST] ${symbol}: loading funding and simulating ${rows.length} candles`);
      const funding = await fetchFundingRates(exchange, symbol, start, end, fundingDirectory);
      const minimumNotional = Number(exchange.market(symbol)?.limits?.cost?.min) || 5;
      const simulator = new FullGridBacktester(exchange, { ...options, minimumNotional });
      full.perSymbol[symbol] = {
        baseline: simulator.simulate({ symbol, rows, fundingRates: funding, start, end, adaptive: false }),
        adaptive: simulator.simulate({ symbol, rows, fundingRates: funding, start, end, adaptive: true }),
      };
      outOfSample.perSymbol[symbol] = {
        baseline: simulator.simulate({ symbol, rows, fundingRates: funding, start: splitAt, end, adaptive: false }),
        adaptive: simulator.simulate({ symbol, rows, fundingRates: funding, start: splitAt, end, adaptive: true }),
      };
      console.log(
        `[BACKTEST] ${symbol}: baseline=${full.perSymbol[symbol].baseline.netLiquidationPnl} ` +
        `adaptive=${full.perSymbol[symbol].adaptive.netLiquidationPnl} USDT`
      );
    }
  } finally {
    await exchange.close();
  }

  for (const scope of [full, outOfSample]) {
    scope.aggregate = {
      baseline: aggregate(symbols.map(symbol => scope.perSymbol[symbol].baseline), options),
      adaptive: aggregate(symbols.map(symbol => scope.perSymbol[symbol].adaptive), options),
    };
    scope.comparison = comparison(scope.aggregate.baseline, scope.aggregate.adaptive);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    period: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), splitAt: new Date(splitAt).toISOString() },
    symbols,
    configuration: options,
    assumptions: [
      '15-minute OHLC candles drive fills; a counter-order created after a fill cannot fill inside the same candle.',
      'Fibonacci ranges use closed 15m, 30m, 1h, 4h, 1d, and resampled 1w candles. The live 5m input is omitted because the cache is 15m.',
      'Range candidates are evaluated every 120 minutes or immediately after price exits the active range, matching the configured rebuild cooldown at candle resolution.',
      'Every simulated order is assumed to receive a maker fill when its price is touched; queue position, slippage, latency, and rejected post-only orders are unavailable.',
      'Both entry and exit maker fees, historical funding, minimum notional, exposure caps, two refills, range resets, and final mark-to-market liquidation are included.',
      'Existing inventory survives range resets and receives a newly profitable exit target. Exact live aggregation/partial-fill sequencing cannot be reconstructed from OHLC data.',
      'Liquidation and maintenance-margin tiers are not simulated. Return on 5x margin is informational, not a liquidation-safe equity model.',
      'The adaptive variant applies reserve, zone sizing, and spacing recommendations; the baseline keeps equal sizing and standard spacing.',
    ],
    full,
    outOfSample,
  };
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const jsonPath = path.join(resultsDirectory, 'full-grid-pnl-backtest.json');
  const markdownPath = path.join(resultsDirectory, 'full-grid-pnl-backtest.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(report));
  console.log(renderMarkdown(report));
  console.log(`[BACKTEST] JSON: ${jsonPath}`);
  console.log(`[BACKTEST] Markdown: ${markdownPath}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[BACKTEST] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  aggregate,
  comparison,
  fetchFundingRates,
  loadCachedRows,
  renderMarkdown,
};
