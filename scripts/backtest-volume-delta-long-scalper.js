#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { simulate, summarizeTrades } = require('../src/micro-scalper-strategy');

const symbols = {
  '1000SHIB/USDT:USDT': '1000shib-usdt-usdt-1m-2026-09-01-2026-11-01.json',
  '1000BONK/USDT:USDT': '1000bonk-usdt-usdt-1m-2026-09-01-2026-11-01.json',
  'DOGE/USDT:USDT': 'doge-usdt-usdt-1m-2026-09-01-2026-11-01.json',
};
const dataDirectory = path.resolve('backtest-data/micro-scalper');
const resultDirectory = path.resolve('backtest-results');
const periodSource = path.resolve(resultDirectory, 'dual-scalper-60d.json');
const minuteMs = 60_000;
const timeframeMinutes = 15;
const positionSide = String(process.env.BACKTEST_POSITION_SIDE || 'LONG').toUpperCase() === 'SHORT'
  ? 'SHORT'
  : 'LONG';

function rounded(value, digits = 6) {
  if (value === Infinity) return 'Infinity';
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function display(summary) {
  return {
    trades: summary.trades,
    winRate: rounded(summary.winRate * 100, 2),
    netPnl: rounded(summary.netPnl),
    grossProfit: rounded(summary.grossProfit),
    grossLoss: rounded(summary.grossLoss),
    profitFactor: rounded(summary.profitFactor, 3),
    maxDrawdown: rounded(summary.maxDrawdown),
    tradesPerDay: rounded(summary.tradesPerDay, 2),
    averageHoldMinutes: rounded(summary.averageHoldBars * timeframeMinutes, 2),
    reasons: summary.reasons,
  };
}

function configs() {
  const result = [];
  for (const flowWindow of [1, 2, 4]) {
    for (const flowThreshold of [0, 0.05, 0.1]) {
      for (const flowExitThreshold of [-0.2, -0.1, 0]) {
        for (const momentumWindow of [4, 16, 96]) {
          for (const minMomentumPct of [1, 2, 3]) {
            for (const [takeProfitPct, stopLossPct] of [[1, 0.75], [1.5, 1], [2, 1]]) {
              for (const maxHoldBars of [16, 48, 96]) {
                result.push({
                  side: positionSide,
                  entryMode: 'VOLUME_DELTA_REVERSAL',
                  useFlowFilter: true,
                  flowWindow,
                  flowThreshold,
                  flowExitThreshold,
                  emaFast: 8,
                  emaSlow: 21,
                  momentumWindow,
                  atrPeriod: 14,
                  minAtrPct: 0.03,
                  maxAtrPct: 2,
                  minTrendPct: 0,
                  minMomentumPct,
                  takeProfitPct,
                  stopLossPct,
                  maxHoldBars,
                  cooldownBars: 1,
                  feeRate: 0.0005,
                  slippageRate: 0.0002,
                  notional: 100,
                });
              }
            }
          }
        }
      }
    }
  }
  return result;
}

function runScope(data, config, start, end) {
  const trades = [];
  const byPair = {};
  for (const [symbol, rows] of Object.entries(data)) {
    const result = simulate(rows, { ...config, start, end });
    trades.push(...result.trades.map(trade => ({ ...trade, symbol })));
    byPair[symbol] = display(result.summary);
  }
  return { aggregate: display(summarizeTrades(trades, start, end)), byPair };
}

function score(scope) {
  const metric = scope.aggregate;
  const positivePairs = Object.values(scope.byPair).filter(pair => pair.netPnl > 0).length;
  if (metric.trades < 10 || metric.netPnl <= 0 || metric.profitFactor < 1.1 || positivePairs < 2) {
    return -Infinity;
  }
  return metric.netPnl - metric.maxDrawdown;
}

function markdown(report) {
  const rows = [
    ['Training 30d', report.training.aggregate],
    ['Out-of-sample 30d', report.outOfSample.aggregate],
    ['Full 60d', report.full.aggregate],
  ].map(([label, metric]) =>
    `| ${label} | ${metric.netPnl} | ${metric.trades} | ${metric.winRate}% | ${metric.profitFactor} | ${metric.maxDrawdown} | ${metric.averageHoldMinutes}m |`
  );
  const entryDescription = positionSide === 'LONG'
    ? 'an oversold move followed by a bullish candle and positive taker-volume delta'
    : 'an overbought move followed by a bearish candle and negative taker-volume delta';
  return `# ${positionSide}-only volume-delta scalper walk-forward backtest\n\n` +
    `Period: ${report.period.start} to ${report.period.end}\n\n` +
    `- The first 30 days select parameters; the latest 30 days are evaluated once.\n` +
    `- Fifteen-minute decisions predict a reversal over the next 24 hours.\n` +
    `- Entry: ${entryDescription}.\n` +
    `- Exit: market exit on adverse delta, exchange TP/SL, or a maximum 24-hour hold.\n` +
    `- Costs: 0.05% taker fee and 0.02% slippage per side.\n` +
    `- PnL is normalized to 100 USDT notional per trade, not an account forecast.\n\n` +
    `Deployment gate: **${report.passedDeploymentGate ? 'PASS' : 'FAIL'}**\n\n` +
    `| Scope | Net PnL | Trades | Win rate | PF | Max DD | Avg hold |\n` +
    `|---|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\n` +
    `## Selected configuration\n\n\`\`\`json\n${JSON.stringify(report.config, null, 2)}\n\`\`\`\n`;
}

const period = JSON.parse(fs.readFileSync(periodSource, 'utf8')).period;
const start = Date.parse(period.start);
const split = Date.parse(period.split);
const end = Date.parse(period.end);
function resample(rows) {
  const bucketMs = timeframeMinutes * minuteMs;
  const buckets = new Map();
  for (const row of rows) {
    const timestamp = Number(row[0]);
    const bucket = Math.floor(timestamp / bucketMs) * bucketMs;
    let aggregate = buckets.get(bucket);
    if (!aggregate) {
      aggregate = [bucket, row[1], row[2], row[3], row[4], 0, bucket + bucketMs - 1, 0, 0, 0, 0, 0, 0];
      aggregate.count = 0;
      buckets.set(bucket, aggregate);
    }
    aggregate[2] = String(Math.max(Number(aggregate[2]), Number(row[2])));
    aggregate[3] = String(Math.min(Number(aggregate[3]), Number(row[3])));
    aggregate[4] = row[4];
    aggregate[5] = String(Number(aggregate[5]) + Number(row[5]));
    aggregate[7] = String(Number(aggregate[7]) + Number(row[7]));
    aggregate[8] = Number(aggregate[8]) + Number(row[8] || 0);
    aggregate[9] = String(Number(aggregate[9]) + Number(row[9]));
    aggregate[10] = String(Number(aggregate[10]) + Number(row[10]));
    aggregate.count++;
  }
  return [...buckets.values()].filter(row => row.count === timeframeMinutes)
    .sort((left, right) => Number(left[0]) - Number(right[0]));
}

const data = Object.fromEntries(Object.entries(symbols).map(([symbol, filename]) => {
  const rows = JSON.parse(fs.readFileSync(path.join(dataDirectory, filename), 'utf8'));
  return [symbol, resample(rows.filter(row => Number(row[0]) < end))];
}));
const trainingData = Object.fromEntries(Object.entries(data).map(([symbol, rows]) => [
  symbol,
  rows.filter(row => Number(row[0]) < split),
]));

let selected = null;
let fallback = null;
const candidates = configs();
for (let index = 0; index < candidates.length; index++) {
  const config = candidates[index];
  const training = runScope(trainingData, config, start, split);
  const candidateScore = score(training);
  if (!selected || candidateScore > selected.score) selected = { config, training, score: candidateScore };
  const fallbackScore = training.aggregate.netPnl - training.aggregate.maxDrawdown;
  if (!fallback || fallbackScore > fallback.score) fallback = { config, training, score: fallbackScore };
  if ((index + 1) % 50 === 0 || index + 1 === candidates.length) {
    process.stdout.write(`\r[SEARCH] ${index + 1}/${candidates.length}`);
  }
}
process.stdout.write('\n');
const trainingGatePassed = Boolean(selected && Number.isFinite(selected.score));
if (!trainingGatePassed) selected = fallback;
if (!selected) throw new Error('No candidate was evaluated');

const outOfSampleData = Object.fromEntries(Object.entries(data).map(([symbol, rows]) => [
  symbol,
  rows.filter(row => Number(row[0]) >= split - 2 * 1440 * minuteMs),
]));
const outOfSample = runScope(outOfSampleData, selected.config, split, end);
const full = runScope(data, selected.config, start, end);
const positiveOosPairs = Object.values(outOfSample.byPair).filter(pair => pair.netPnl > 0).length;
const report = {
  generatedAt: new Date().toISOString(),
  period,
  config: selected.config,
  selectionScore: rounded(selected.score),
  training: selected.training,
  outOfSample,
  full,
  passedDeploymentGate: trainingGatePassed && outOfSample.aggregate.netPnl > 0 &&
    outOfSample.aggregate.profitFactor >= 1.05 &&
    outOfSample.aggregate.trades >= 10 &&
    positiveOosPairs >= 2,
};

const basename = `volume-delta-${positionSide.toLowerCase()}-scalper-60d`;
fs.writeFileSync(path.join(resultDirectory, `${basename}.json`), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(resultDirectory, `${basename}.md`), markdown(report));
console.log(JSON.stringify(report, null, 2));
