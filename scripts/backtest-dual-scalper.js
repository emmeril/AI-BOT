#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { simulate, summarizeTrades } = require('../src/micro-scalper-strategy');

const dataDirectory = path.resolve('backtest-data/micro-scalper');
const resultDirectory = path.resolve('backtest-results');
const symbols = ['1000SHIB/USDT:USDT', '1000BONK/USDT:USDT', 'DOGE/USDT:USDT'];
const minuteMs = 60_000;
const dayMs = 86_400_000;
const historyDays = Math.max(2, Math.min(180, Number(process.env.DUAL_SCALPER_BACKTEST_DAYS) || 30));
const warmupMinutes = 180;

const baseConfig = {
  entryMode: 'CONTINUATION',
  useFlowFilter: false,
  flowWindow: 10,
  flowThreshold: 0,
  emaFast: 20,
  emaSlow: 50,
  momentumWindow: 15,
  atrPeriod: 14,
  minAtrPct: 0.03,
  maxAtrPct: 2,
  minTrendPct: 0.3,
  takeProfitPct: 2.5,
  stopLossPct: 1,
  maxHoldBars: 120,
  cooldownBars: 30,
  feeRate: 0.0005,
  slippageRate: 0.0002,
  notional: 35,
};

function rounded(value, digits = 6) {
  if (value === Infinity) return 'Infinity';
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function metrics(summary) {
  return {
    trades: summary.trades,
    winRate: rounded(summary.winRate * 100, 2),
    netPnl: rounded(summary.netPnl),
    profitFactor: rounded(summary.profitFactor, 3),
    maxDrawdown: rounded(summary.maxDrawdown),
    averageHoldMinutes: rounded(summary.averageHoldBars, 2),
  };
}

function safeName(symbol) {
  return symbol.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

async function fetchKlines(exchange, symbol, since, until) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const cachePath = path.join(
    dataDirectory,
    `${safeName(symbol)}-1m-${new Date(since).toISOString().slice(0, 10)}-${new Date(until).toISOString().slice(0, 10)}.json`
  );
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'));

  const rows = new Map();
  let cursor = since;
  while (cursor < until) {
    const batch = await exchange.fapiPublicGetKlines({
      symbol: exchange.market(symbol).id,
      interval: '1m',
      startTime: cursor,
      endTime: until - 1,
      limit: 1500,
    });
    if (!Array.isArray(batch) || !batch.length) break;
    for (const row of batch) {
      const timestamp = Number(row?.[0]);
      if (timestamp >= since && timestamp < until) rows.set(timestamp, row);
    }
    const lastTimestamp = Number(batch.at(-1)?.[0]);
    if (!Number.isFinite(lastTimestamp) || lastTimestamp < cursor) break;
    cursor = lastTimestamp + minuteMs;
    process.stdout.write(`\r[DATA] ${symbol} ${Math.min(100, (cursor - since) / (until - since) * 100).toFixed(1)}%`);
  }
  process.stdout.write('\n');
  const result = [...rows.values()].sort((left, right) => Number(left[0]) - Number(right[0]));
  fs.writeFileSync(cachePath, JSON.stringify(result));
  return result;
}

async function loadData(start, end) {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  const fetchStart = start - warmupMinutes * minuteMs;
  const result = {};
  for (const symbol of symbols) {
    if (!exchange.markets[symbol]) throw new Error(`Unknown Binance USD-M symbol: ${symbol}`);
    result[symbol] = await fetchKlines(exchange, symbol, fetchStart, end);
    const actual = result[symbol].filter(row => Number(row[0]) >= start && Number(row[0]) < end).length;
    const expected = historyDays * 1440;
    if (actual < expected * 0.98) throw new Error(`${symbol} has only ${actual}/${expected} expected candles`);
  }
  await exchange.close();
  return result;
}

function runScope(data, start, end) {
  const bySide = {};
  const combinedTrades = [];
  for (const side of ['LONG', 'SHORT']) {
    const trades = [];
    const byPair = {};
    for (const [symbol, rows] of Object.entries(data)) {
      const result = simulate(rows, { ...baseConfig, side, start, end });
      trades.push(...result.trades.map(trade => ({ ...trade, symbol, side })));
      byPair[symbol] = metrics(result.summary);
    }
    combinedTrades.push(...trades);
    bySide[side] = { aggregate: metrics(summarizeTrades(trades, start, end)), byPair };
  }
  return {
    combined: metrics(summarizeTrades(combinedTrades, start, end)),
    bySide,
  };
}

function markdown(report) {
  const rows = [];
  for (const [scope, result] of [
    ['First half', report.firstHalf],
    ['Most recent half', report.secondHalf],
    [`Full ${report.period.historyDays} days`, report.full],
  ]) {
    rows.push(`| ${scope} | Combined | ${result.combined.netPnl} | ${result.combined.trades} | ${result.combined.profitFactor} | ${result.combined.maxDrawdown} |`);
    for (const side of ['LONG', 'SHORT']) {
      const metric = result.bySide[side].aggregate;
      rows.push(`| ${scope} | ${side} | ${metric.netPnl} | ${metric.trades} | ${metric.profitFactor} | ${metric.maxDrawdown} |`);
    }
  }
  return `# Dual LONG + SHORT scalper backtest\n\n` +
    `Period: ${report.period.start} to ${report.period.end}\n\n` +
    `- Binance USD-M one-minute candles across three configured pairs.\n` +
    `- Independent LONG and SHORT positions in Hedge Mode; 35% notional per side and 30% buffer.\n` +
    `- PnL uses a normalized 35 USDT notional per trade on each pair; it is not an account-balance forecast.\n` +
    `- Entry occurs at the next candle open; stop is counted first when TP and SL touch in one candle.\n` +
    `- Costs include 0.05% taker fee and 0.02% slippage per side.\n` +
    `- No grid, averaging, rescue, or martingale.\n\n` +
    `| Scope | Side | Net PnL | Trades | Profit factor | Max DD |\n` +
    `|---|---|---:|---:|---:|---:|\n${rows.join('\n')}\n`;
}

async function main() {
  const end = Math.floor(Date.now() / minuteMs) * minuteMs;
  const start = end - historyDays * dayMs;
  const split = start + Math.floor(historyDays / 2) * dayMs;
  const data = await loadData(start, end);
  const report = {
    generatedAt: new Date().toISOString(),
    period: {
      start: new Date(start).toISOString(),
      split: new Date(split).toISOString(),
      end: new Date(end).toISOString(),
      historyDays,
    },
    allocation: { LONG: 35, SHORT: 35, buffer: 30 },
    config: baseConfig,
    firstHalf: runScope(data, start, split),
    secondHalf: runScope(data, split, end),
    full: runScope(data, start, end),
  };

  fs.mkdirSync(resultDirectory, { recursive: true });
  const basename = `dual-scalper-${historyDays}d`;
  fs.writeFileSync(path.join(resultDirectory, `${basename}.json`), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(resultDirectory, `${basename}.md`), markdown(report));
  console.log(JSON.stringify({
    period: report.period,
    firstHalf: report.firstHalf,
    secondHalf: report.secondHalf,
    full: report.full,
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
