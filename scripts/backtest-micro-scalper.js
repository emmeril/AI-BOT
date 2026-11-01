#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { simulate, summarizeTrades } = require('../src/micro-scalper-strategy');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 30;
const WARMUP_MINUTES = 180;
const DATA_DIRECTORY = path.resolve('backtest-data/micro-scalper');
const RESULT_DIRECTORY = path.resolve('backtest-results');
const SYMBOLS = String(process.env.SYMBOLS || '1000SHIB/USDT:USDT,1000BONK/USDT:USDT,DOGE/USDT:USDT')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const FEE_RATE = 0.0005;
const SLIPPAGE_RATE = Number(process.env.MICRO_SCALPER_BACKTEST_SLIPPAGE_RATE || 0.0002);
const NOTIONAL = Number(process.env.MICRO_SCALPER_BACKTEST_NOTIONAL || 100);

function safeName(symbol) {
  return symbol.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function rounded(value, digits = 6) {
  if (value === Infinity) return 'Infinity';
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function displayMetric(summary) {
  return {
    ...summary,
    winRate: rounded(summary.winRate * 100, 2),
    netPnl: rounded(summary.netPnl),
    grossProfit: rounded(summary.grossProfit),
    grossLoss: rounded(summary.grossLoss),
    profitFactor: rounded(summary.profitFactor, 3),
    maxDrawdown: rounded(summary.maxDrawdown),
    tradesPerDay: rounded(summary.tradesPerDay, 3),
    averageHoldBars: rounded(summary.averageHoldBars, 2),
  };
}

async function fetchKlines(exchange, symbol, since, until) {
  fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
  const cachePath = path.join(
    DATA_DIRECTORY,
    `${safeName(symbol)}-1m-${new Date(since).toISOString().slice(0, 10)}-${new Date(until).toISOString().slice(0, 10)}.json`
  );
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'));

  const market = exchange.market(symbol);
  const rows = new Map();
  let cursor = since;
  while (cursor < until) {
    let batch;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        batch = await exchange.fapiPublicGetKlines({
          symbol: market.id,
          interval: '1m',
          startTime: cursor,
          endTime: until - 1,
          limit: 1500,
        });
        break;
      } catch (error) {
        if (attempt === 5) throw error;
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
    cursor = lastTimestamp + MINUTE_MS;
    process.stdout.write(
      `\r[DATA] ${symbol} ${Math.min(100, (cursor - since) / (until - since) * 100).toFixed(1)}%`
    );
  }
  process.stdout.write('\n');
  const result = [...rows.values()].sort((left, right) => Number(left[0]) - Number(right[0]));
  fs.writeFileSync(cachePath, JSON.stringify(result));
  return result;
}

function candidateConfigurations() {
  const candidates = [];
  for (const minTrendPct of [0.1, 0.2, 0.3, 0.5]) {
    for (const momentumWindow of [15, 30, 60]) {
      for (const [takeProfitPct, stopLossPct] of [[1, 0.5], [1.5, 0.75], [2, 1], [2.5, 1]]) {
        for (const maxHoldBars of [60, 120, 240, 480]) {
          candidates.push({
            side: 'SHORT',
            entryMode: 'CONTINUATION',
            useFlowFilter: false,
            flowWindow: 10,
            flowThreshold: 0,
            emaFast: 20,
            emaSlow: 50,
            momentumWindow,
            atrPeriod: 14,
            minAtrPct: 0.03,
            maxAtrPct: 2,
            minTrendPct,
            takeProfitPct,
            stopLossPct,
            maxHoldBars,
            cooldownBars: 30,
            feeRate: FEE_RATE,
            slippageRate: SLIPPAGE_RATE,
            notional: NOTIONAL,
          });
        }
      }
    }
  }
  return candidates;
}

function runScope(dataBySymbol, config, start, end) {
  const perSymbol = {};
  const allTrades = [];
  for (const symbol of SYMBOLS) {
    const result = simulate(dataBySymbol[symbol], { ...config, start, end });
    perSymbol[symbol] = displayMetric(result.summary);
    allTrades.push(...result.trades.map(trade => ({ ...trade, symbol })));
  }
  return {
    aggregate: displayMetric(summarizeTrades(allTrades, start, end)),
    perSymbol,
    trades: allTrades,
  };
}

function candidateScore(summary) {
  if (summary.trades < 30 || summary.netPnl <= 0 || summary.profitFactor <= 1) return -Infinity;
  return summary.netPnl - summary.maxDrawdown;
}

function stripTrades(scope) {
  return { aggregate: scope.aggregate, perSymbol: scope.perSymbol };
}

function markdown(report) {
  const selected = report.selected;
  const lines = [
    '# Micro-scalper 30-day walk-forward backtest',
    '',
    `Period: ${report.period.start} to ${report.period.end}`,
    '',
    '## Method',
    '',
    '- One-minute Binance USD-M klines; SHORT only.',
    '- Signal: strong bearish EMA20/50 regime + momentum + ATR volatility filter.',
    '- One position per pair. No grid, averaging, rescue, or martingale.',
    '- Entry is delayed until the next candle open after a completed signal candle.',
    `- Costs: ${(report.assumptions.takerFeeRate * 100).toFixed(3)}% taker fee per side and ${(report.assumptions.slippageRate * 100).toFixed(3)}% slippage per side.`,
    '- If TP and SL occur inside the same one-minute candle, the stop is counted first.',
    '- The first 15 days select parameters; the final 15 days remain untouched validation data.',
    '',
    '## Selected parameters',
    '',
    '```json',
    JSON.stringify(selected.config, null, 2),
    '```',
    '',
    `Deployment gate: **${selected.passedDeploymentGate ? 'PASS' : 'FAIL'}**`,
    '',
    '| Scope | Net PnL (USDT) | Trades | Trades/day | Win rate | Profit factor | Max DD |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [label, scope] of [
    ['Training', selected.train],
    ['Out-of-sample', selected.outOfSample],
    ['Full 30 days', selected.full],
  ]) {
    const metric = scope.aggregate;
    lines.push(
      `| ${label} | ${metric.netPnl} | ${metric.trades} | ${metric.tradesPerDay} | ${metric.winRate}% | ${metric.profitFactor} | ${metric.maxDrawdown} |`
    );
  }
  lines.push('', '## Out-of-sample by pair', '', '| Pair | Net PnL | Trades | Profit factor | Max DD |', '|---|---:|---:|---:|---:|');
  for (const [symbol, metric] of Object.entries(selected.outOfSample.perSymbol)) {
    lines.push(`| ${symbol} | ${metric.netPnl} | ${metric.trades} | ${metric.profitFactor} | ${metric.maxDrawdown} |`);
  }
  lines.push('', `Selection score (training only): ${selected.trainingScore}`, '');
  return `${lines.join('\n')}\n`;
}

async function main() {
  if (!SYMBOLS.length) throw new Error('No symbols configured');
  const end = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const start = end - HISTORY_DAYS * DAY_MS;
  const split = start + 15 * DAY_MS;
  const fetchStart = start - WARMUP_MINUTES * MINUTE_MS;
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  const dataBySymbol = {};
  for (const symbol of SYMBOLS) {
    if (!exchange.markets[symbol]) throw new Error(`Unknown Binance USD-M symbol: ${symbol}`);
    dataBySymbol[symbol] = await fetchKlines(exchange, symbol, fetchStart, end);
    const expected = HISTORY_DAYS * 1440;
    const inPeriod = dataBySymbol[symbol].filter(row => Number(row[0]) >= start && Number(row[0]) < end).length;
    if (inPeriod < expected * 0.98) {
      throw new Error(`${symbol} has only ${inPeriod}/${expected} expected one-minute candles`);
    }
  }

  const candidates = candidateConfigurations();
  let selected = null;
  let fallback = null;
  for (let index = 0; index < candidates.length; index++) {
    const config = candidates[index];
    const train = runScope(dataBySymbol, config, start, split);
    const score = candidateScore(train.aggregate);
    if (!selected || score > selected.trainingScore) selected = { config, train, trainingScore: score };
    const fallbackScore = train.aggregate.netPnl - train.aggregate.maxDrawdown;
    if (!fallback || fallbackScore > fallback.trainingScore) {
      fallback = { config, train, trainingScore: fallbackScore };
    }
    if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
      process.stdout.write(`\r[SEARCH] ${index + 1}/${candidates.length}`);
    }
  }
  process.stdout.write('\n');
  const trainingPassedGate = Boolean(selected && Number.isFinite(selected.trainingScore));
  if (!trainingPassedGate) selected = fallback;
  if (!selected) throw new Error('No backtest candidate was evaluated');

  selected.outOfSample = runScope(dataBySymbol, selected.config, split, end);
  selected.full = runScope(dataBySymbol, selected.config, start, end);
  const positivePairs = Object.values(selected.outOfSample.perSymbol).filter(metric => metric.netPnl > 0).length;
  selected.passedDeploymentGate = trainingPassedGate &&
    selected.outOfSample.aggregate.netPnl > 0 &&
    selected.outOfSample.aggregate.profitFactor > 1 &&
    selected.outOfSample.aggregate.trades >= 30 &&
    positivePairs >= Math.ceil(SYMBOLS.length * 2 / 3);

  const report = {
    generatedAt: new Date().toISOString(),
    period: {
      start: new Date(start).toISOString(),
      split: new Date(split).toISOString(),
      end: new Date(end).toISOString(),
      historyDays: HISTORY_DAYS,
    },
    symbols: SYMBOLS,
    assumptions: {
      timeframe: '1m',
      takerFeeRate: FEE_RATE,
      slippageRate: SLIPPAGE_RATE,
      fixedNotionalPerTrade: NOTIONAL,
      candidateCount: candidates.length,
    },
    selected: {
      config: selected.config,
      trainingScore: rounded(selected.trainingScore),
      trainingPassedGate,
      passedDeploymentGate: selected.passedDeploymentGate,
      train: stripTrades(selected.train),
      outOfSample: stripTrades(selected.outOfSample),
      full: stripTrades(selected.full),
    },
  };

  fs.mkdirSync(RESULT_DIRECTORY, { recursive: true });
  const jsonPath = path.join(RESULT_DIRECTORY, 'micro-scalper-30d.json');
  const markdownPath = path.join(RESULT_DIRECTORY, 'micro-scalper-30d.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, markdown(report));
  console.log(`[RESULT] ${markdownPath}`);
  console.log(JSON.stringify(report.selected, null, 2));
  if (!selected.passedDeploymentGate) process.exitCode = 2;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
