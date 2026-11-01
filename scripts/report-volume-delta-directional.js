#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const resultDirectory = path.resolve('backtest-results');
const long = JSON.parse(fs.readFileSync(path.join(resultDirectory, 'volume-delta-long-scalper-60d.json'), 'utf8'));
const short = JSON.parse(fs.readFileSync(path.join(resultDirectory, 'volume-delta-short-scalper-60d.json'), 'utf8'));

function rounded(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function combineMetrics(left, right) {
  const trades = left.trades + right.trades;
  const grossProfit = left.grossProfit + right.grossProfit;
  const grossLoss = left.grossLoss + right.grossLoss;
  const wins = left.trades * left.winRate / 100 + right.trades * right.winRate / 100;
  return {
    trades,
    winRate: trades ? rounded(wins / trades * 100, 2) : 0,
    netPnl: rounded(left.netPnl + right.netPnl),
    grossProfit: rounded(grossProfit),
    grossLoss: rounded(grossLoss),
    profitFactor: grossLoss > 0 ? rounded(grossProfit / grossLoss, 3) : grossProfit > 0 ? 'Infinity' : 0,
    conservativeDrawdownBound: rounded(left.maxDrawdown + right.maxDrawdown),
    tradesPerDay: rounded(left.tradesPerDay + right.tradesPerDay, 2),
    averageHoldMinutes: trades
      ? rounded((left.averageHoldMinutes * left.trades + right.averageHoldMinutes * right.trades) / trades, 2)
      : 0,
  };
}

function combineScope(scope) {
  const left = long[scope];
  const right = short[scope];
  const byPair = {};
  for (const symbol of Object.keys(left.byPair)) {
    byPair[symbol] = combineMetrics(left.byPair[symbol], right.byPair[symbol]);
  }
  return { aggregate: combineMetrics(left.aggregate, right.aggregate), byPair };
}

const training = combineScope('training');
const outOfSample = combineScope('outOfSample');
const full = combineScope('full');
const positiveOosPairs = Object.values(outOfSample.byPair).filter(pair => pair.netPnl > 0).length;
const report = {
  generatedAt: new Date().toISOString(),
  period: long.period,
  configs: { LONG: long.config, SHORT: short.config },
  training,
  outOfSample,
  full,
  passedDeploymentGate: training.aggregate.netPnl > 0 && training.aggregate.profitFactor > 1.1 &&
    outOfSample.aggregate.netPnl > 0 && outOfSample.aggregate.profitFactor > 1.1 &&
    outOfSample.aggregate.trades >= 30 && positiveOosPairs >= 2,
};

function row(label, metric) {
  return `| ${label} | ${metric.netPnl} | ${metric.trades} | ${metric.tradesPerDay} | ${metric.winRate}% | ${metric.profitFactor} | ${metric.conservativeDrawdownBound} | ${metric.averageHoldMinutes}m |`;
}

const markdown = `# Directional volume-delta predictor — 60-day walk-forward\n\n` +
  `Period: ${report.period.start} to ${report.period.end}\n\n` +
  `- LONG and SHORT parameters are selected independently on the first 30 days.\n` +
  `- The most recent 30 days are evaluated once as the out-of-sample period.\n` +
  `- Fifteen-minute decisions target reversals over the next four hours.\n` +
  `- Positions exit on adverse volume delta, 2% take profit, 1% stop loss, or four hours.\n` +
  `- Costs include 0.05% taker fee and 0.02% slippage per side.\n` +
  `- PnL is normalized to 100 USDT notional per trade, not an account forecast.\n` +
  `- Drawdown is reported as the conservative sum of the separate side drawdowns.\n\n` +
  `Deployment gate: **${report.passedDeploymentGate ? 'PASS' : 'FAIL'}**\n\n` +
  `| Scope | Net PnL | Trades | Trades/day | Win rate | PF | DD bound | Avg hold |\n` +
  `|---|---:|---:|---:|---:|---:|---:|---:|\n` +
  `${row('Training 30d', training.aggregate)}\n` +
  `${row('Out-of-sample 30d', outOfSample.aggregate)}\n` +
  `${row('Full 60d', full.aggregate)}\n\n` +
  `## Out-of-sample by pair\n\n` +
  `| Pair | Net PnL | Trades | PF |\n|---|---:|---:|---:|\n` +
  Object.entries(outOfSample.byPair).map(([symbol, metric]) =>
    `| ${symbol} | ${metric.netPnl} | ${metric.trades} | ${metric.profitFactor} |`
  ).join('\n') + '\n';

fs.writeFileSync(path.join(resultDirectory, 'volume-delta-directional-60d.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(resultDirectory, 'volume-delta-directional-60d.md'), markdown);
console.log(JSON.stringify(report, null, 2));
