#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeKlines } = require('../src/predictive/features');
const { forecastDirection } = require('../src/predictive/direction-forward');
const { planExit } = require('../src/predictive/exit-planner');
const { scoreExitPlan } = require('../src/predictive/exit-evaluator');
const { chooseCandidate, ADAPTIVE_POLICY_ID } = require('../src/predictive/adaptive-exits');
const { loadModels, loadExitModels, loadReachabilityModels } = require('./start-predictive-shadow');

const STRATEGIES = ['ADAPTIVE_EXPECTED_NET', 'ADAPTIVE_PROBABILITY_50', 'MEDIAN_EXPECTED_NET',
  'MEDIAN_PROBABILITY_50', 'MEDIAN_TP1_ALL', 'MEDIAN_TP2_ALL'];

function summarize(rows) {
  let cumulative = 0, peak = 0, drawdown = 0;
  for (const row of rows) {
    cumulative += row.simulatedNetPct * 0.5;
    peak = Math.max(peak, cumulative); drawdown = Math.max(drawdown, peak - cumulative);
  }
  return { trades: rows.length, wins: rows.filter(r => r.simulatedNetPct > 0).length,
    losses: rows.filter(r => r.simulatedNetPct < 0).length,
    netWinRate: rows.length ? rows.filter(r => r.simulatedNetPct > 0).length / rows.length : null,
    summedNetUsdtAtFixed50: cumulative, closedTradeDrawdownUsdtAtFixed50: drawdown,
    results: rows.reduce((a, r) => { a[r.result] = (a[r.result] || 0) + 1; return a; }, {}) };
}

function strategyChoice(candidates, strategy) {
  const rows = strategy.startsWith('MEDIAN') ? candidates.filter(c => c.stopId === 'Q50') : candidates;
  if (strategy.endsWith('_ALL')) return rows.find(c => c.rewardMultiple === (strategy === 'MEDIAN_TP1_ALL' ? 1 : 2));
  return chooseCandidate(rows, strategy.endsWith('PROBABILITY_50') ? 'PROBABILITY_50' : 'EXPECTED_NET');
}

function main() {
  const [historyFile, featureFile, directionDirectory, exitDirectory, reachabilityDirectory, outputFile] = process.argv.slice(2);
  if (!outputFile || fs.existsSync(outputFile)) throw new Error('Provide history, features, direction-dir, stop-dir, adaptive-dir and a new report file');
  const candles = normalizeKlines(JSON.parse(fs.readFileSync(historyFile)));
  const source = JSON.parse(fs.readFileSync(featureFile));
  if (path.resolve(source.source) !== path.resolve(historyFile)) throw new Error('Cached features belong to another history');
  const index = new Map(candles.map((c, i) => [c.closeTime, i]));
  const directions = loadModels(directionDirectory, 'DOGEUSDT');
  const exits = loadExitModels(exitDirectory, 'DOGEUSDT', directions);
  const models = loadReachabilityModels(reachabilityDirectory, 'DOGEUSDT', directions, exits, { directionDirectory, exitDirectory });
  const report = { checkedAt: new Date().toISOString(), executionEnabled: false, riskPolicyId: ADAPTIVE_POLICY_ID,
    historicalPeriodPreviouslyInspected: true, notionalUsdt: 50, compounding: false,
    costs: { feePctPerSide: 0.05, slippagePctPerSide: 0.02 },
    limitations: ['Funding, liquidation, actual latency and session-loss pauses are excluded',
      'Overlapping forecasts and candidate counterfactuals are not a portfolio',
      'Audit was not used for model fitting or calibration, but its historical period was inspected before'], horizons: {} };
  for (const direction of directions) {
    const h = direction.horizon, model = models.get(h), stop = exits.get(h);
    const collections = Object.fromEntries(STRATEGIES.map(s => [s,
      { independent: [], sequential: [], blockedUntil: -Infinity, targets: { TP1: 0, TP2: 0 }, stops: {}, folds: [[], [], []] }]));
    const counterfactual = { selected: [], rejected: [] };
    let forecasts = 0, first = null, last = null;
    const times = source.times.filter(t => t >= model.splitBoundaries.auditStart && index.get(t) + h < candles.length);
    for (let j = 0; j < source.times.length; j++) {
      const time = source.times[j], i = index.get(time);
      if (time < model.splitBoundaries.auditStart || !Number.isInteger(i) || i + h >= candles.length) continue;
      forecasts++; first ??= time; last = time;
      const f = forecastDirection(direction, { time, close: candles[i].close, x: source.features[j].slice(0, 9) }, 'DOGEUSDT', time + 1);
      const plan = planExit(f, stop, source.features[j], { targetLevels: true, tickSize: 0.00001,
        candles: candles.slice(i - 15, i + 1), reachabilityModel: model });
      const candidates = plan.candidates || [];
      const outcomes = new Map();
      for (const candidate of candidates) {
        const out = scoreExitPlan({ ...f, exitPlan: { ...candidate, status: 'ESTIMATED',
          side: f.direction === 'UP' ? 'LONG' : 'SHORT', costAssumptions: report.costs } }, candles, i);
        if (!Number.isFinite(out?.simulatedNetPct)) continue;
        outcomes.set(candidate, out);
        const selected = plan.status === 'ESTIMATED' && plan.stopId === candidate.stopId && plan.selectedTarget === candidate.level;
        counterfactual[selected ? 'selected' : 'rejected'].push(out);
      }
      for (const strategy of STRATEGIES) {
        const choice = strategyChoice(candidates, strategy), out = outcomes.get(choice), collection = collections[strategy];
        if (!out) continue;
        collection.independent.push(out);
        if (time >= collection.blockedUntil) {
          collection.sequential.push(out); collection.blockedUntil = out.exitCloseTime;
          collection.targets[choice.level]++; collection.stops[choice.stopId] = (collection.stops[choice.stopId] || 0) + 1;
          const fold = Math.min(2, Math.floor((time - times[0]) / (times.at(-1) - times[0] + 1) * 3));
          collection.folds[fold].push(out);
        }
      }
    }
    const strategies = Object.fromEntries(STRATEGIES.map(s => {
      const c = collections[s];
      return [s, { overlapping: summarize(c.independent), onePositionAtATime: summarize(c.sequential),
        selectedTargets: c.targets, selectedStops: c.stops, chronologicalAuditWindows: c.folds.map(summarize) }];
    }));
    const native = JSON.parse(fs.readFileSync(path.join(reachabilityDirectory, `report-${h}m.json`))).auditTrades;
    for (const strategy of STRATEGIES) for (const key of ['overlapping', 'onePositionAtATime']) {
      const actual = strategies[strategy][key], expected = native[strategy][key];
      if (actual.trades !== expected.trades || actual.wins !== expected.wins ||
          Math.abs(actual.summedNetUsdtAtFixed50 - expected.summedNetUsdtAtFixed50) > 1e-8) {
        throw new Error(`Runtime/native audit mismatch at ${h}m ${strategy} ${key}: ${JSON.stringify({ actual, expected })}`);
      }
    }
    report.horizons[h] = { forecasts, from: new Date(first).toISOString(), to: new Date(last).toISOString(), strategies,
      counterfactual: { usedForLiveGate: false, selected: summarize(counterfactual.selected), rejected: summarize(counterfactual.rejected) },
      runtimeMatchesNativeAudit: true };
    console.log(JSON.stringify({ horizon: h, forecasts, strategies: Object.fromEntries(STRATEGIES.map(s => [s, strategies[s].onePositionAtATime])),
      runtimeMatchesNativeAudit: true }));
  }
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), { mode: 0o600 });
}

if (require.main === module) { try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; } }
module.exports = { STRATEGIES, summarize, strategyChoice, main };
