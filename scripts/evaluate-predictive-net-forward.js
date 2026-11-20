#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { normalizeKlines } = require('../src/predictive/features');
const { scoreExitPlan, sequentialExitRecords } = require('../src/predictive/exit-evaluator');
const { ADAPTIVE_POLICY_ID } = require('../src/predictive/adaptive-exits');
const { planExit } = require('../src/predictive/exit-planner');
const { STRATEGIES, strategyChoice, summarize } = require('./evaluate-predictive-adaptive-exits');

function compareForward(baseline, candidate, rawCandles, exitModel) {
  if ([baseline, candidate].some(state => state.objective !== 'PRICE_DIRECTION' || !Array.isArray(state.records))) {
    throw new Error('Expected frozen direction shadow snapshots');
  }
  const candles = normalizeKlines(rawCandles);
  const times = new Set(candles.map(c => c.closeTime));
  const eligible = candidate.records.filter(r => r.symbol === 'DOGEUSDT' && r.horizon === 60 &&
    r.exitPlan?.riskPolicyId === ADAPTIVE_POLICY_ID && times.has(r.candleCloseTime) && times.has(r.targetCloseTime))
    .sort((a, b) => a.candleCloseTime - b.candleCloseTime);
  if (!eligible.length || new Set(eligible.map(r => r.exitPlan.reachabilityModelId)).size !== 1) {
    throw new Error('Expected completed forecasts from one adaptive model');
  }
  const baselineByTime = new Map(baseline.records.filter(r => r.symbol === 'DOGEUSDT' && r.horizon === 60 &&
    r.exitPlan?.status === 'ESTIMATED' && r.exitPlan.method === 'HISTORICAL_EXCURSION_QUANTILES')
    .map(r => [r.candleCloseTime, r]));
  const common = eligible.filter(r => baselineByTime.get(r.candleCloseTime)?.modelId === r.modelId);
  const strategies = { BASELINE: eligible.map(r => ({ ...r, exitOutcome: null,
    exitPlan: planExit(r, exitModel, r.exitPlan.contextFeatures,
      { tickSize: r.exitPlan.priceTick, feePct: 0.05, slippagePct: 0.02 }) })) };
  for (const name of STRATEGIES) {
    strategies[name] = eligible.map(r => {
      const choice = strategyChoice(r.exitPlan.candidates || [], name);
      return { ...r, exitOutcome: null, exitPlan: choice ?
        { ...r.exitPlan, ...choice, status: 'ESTIMATED' } : { status: 'UNAVAILABLE' } };
    });
  }
  const report = { checkedAt: new Date().toISOString(), horizon: 60, notionalUsdt: 50, compounding: false,
    period: { from: new Date(eligible[0].candleCloseTime).toISOString(), to: new Date(eligible.at(-1).candleCloseTime).toISOString() },
    commonForecasts: eligible.length, recordedBaselineCommonTimes: common.length, riskPolicyId: ADAPTIVE_POLICY_ID,
    baseline: 'RECONSTRUCTED_FROZEN_MODEL_ON_IDENTICAL_FORECAST_TIMES_AND_SAVED_FEATURES',
    selection: 'FROZEN_POLICY_WITHOUT_REFITTING',
    costs: { feePctPerSide: 0.05, slippagePctPerSide: 0.02 },
    limitations: ['Only one position at a time; fixed notional, without compounding',
      'Funding, liquidation, latency and session-loss pauses are excluded',
      'Public candle replay can differ from previously recorded shadow outcomes',
      'A short forward period is insufficient to establish future profitability'], strategies: {} };
  for (const [name, rows] of Object.entries(strategies)) {
    for (const row of rows) row.exitOutcome = scoreExitPlan(row, candles);
    const selected = sequentialExitRecords(rows);
    if (selected.some(r => !r.exitOutcome)) throw new Error('Incomplete candle coverage for ' + name);
    report.strategies[name] = summarize(selected.filter(r => Number.isFinite(r.exitOutcome.simulatedNetPct))
      .map(r => r.exitOutcome));
  }
  return report;
}

function main() {
  const [baselineFile, candidateFile, candleFile, exitModelFile, outputFile] = process.argv.slice(2);
  if (!outputFile || fs.existsSync(outputFile)) {
    throw new Error('Usage: evaluate-predictive-net-forward.js <baseline-snapshot> <candidate-snapshot> <public-klines> <excursion-model> <new-report>');
  }
  const read = file => JSON.parse(fs.readFileSync(file));
  const report = compareForward(read(baselineFile), read(candidateFile), read(candleFile), read(exitModelFile));
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}

module.exports = { compareForward, main };
