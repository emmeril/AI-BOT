'use strict';

const { train, predict } = require('./hit-first-model');
const { settings, rewardRisk, simulateExit } = require('./trade-simulator');

function splitChronological(samples, horizon) {
  const n = samples.length;
  if (n < 500) throw new Error('Need at least 500 labeled observations');
  const first = Math.floor(n * 0.6);
  const second = Math.floor(n * 0.8);
  const trainRows = samples.slice(0, first - horizon);
  const validation = samples.slice(first, second - horizon);
  const holdout = samples.slice(second);
  if (trainRows.length < 100 || validation.length < 30 || holdout.length < 30) {
    throw new Error('Insufficient chronological data after purge');
  }
  return { trainRows, validation, holdout,
    boundaries: { validationStart: samples[first].time, holdoutStart: samples[second].time,
      embargoBars: horizon } };
}

function metrics(model, rows) {
  const count = rows.length || 1;
  const totals = { long: { brier: 0, logLoss: 0, hits: 0 },
    short: { brier: 0, logLoss: 0, hits: 0 } };
  for (const row of rows) {
    const p = predict(model, row.x);
    for (const [side, probability, label] of [
      ['long', p.longTarget, row.labelLong], ['short', p.shortTarget, row.labelShort]]) {
      totals[side].brier += (probability - label) ** 2;
      totals[side].logLoss -= label * Math.log(Math.max(1e-12, probability)) +
        (1 - label) * Math.log(Math.max(1e-12, 1 - probability));
      totals[side].hits += label;
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([side, result]) =>
    [side, { brier: result.brier / count, logLoss: result.logLoss / count,
      baseHitRate: result.hits / count, samples: rows.length }]));
}

function chooseAction(model, feature, assumptions = {}) {
  const config = settings(assumptions);
  const threshold = Number(assumptions.threshold ?? 0.65);
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) {
    throw new Error('Invalid probability threshold');
  }
  const probabilities = predict(model, feature.x);
  const candidates = [
    { action: 'LONG', probability: probabilities.longTarget, rr: rewardRisk('LONG', config) },
    { action: 'SHORT', probability: probabilities.shortTarget, rr: rewardRisk('SHORT', config) },
  ].filter(item =>
    item.probability >= threshold &&
    item.rr.ratio >= config.minNetRewardRisk &&
    item.probability * item.rr.rewardPct - (1 - item.probability) * item.rr.riskPct > 0);
  candidates.sort((a, b) =>
    (b.probability * b.rr.rewardPct - (1 - b.probability) * b.rr.riskPct) -
    (a.probability * a.rr.rewardPct - (1 - a.probability) * a.rr.riskPct));
  const best = candidates[0];
  return { action: best?.action || 'NO_TRADE', probabilities,
    expectedNetPct: best ? best.probability * best.rr.rewardPct -
      (1 - best.probability) * best.rr.riskPct : null,
    rewardRisk: best?.rr || null,
    reason: best ? 'POSITIVE_MODELLED_EDGE' : 'INSUFFICIENT_EDGE' };
}

function simulate(model, samples, config) {
  let netPct = 0, gain = 0, loss = 0, wins = 0, peak = 0, drawdown = 0, positionUntil = -1;
  let count = 0, ambiguous = 0;
  const byOutcome = {};
  for (const sample of samples) {
    if (sample.index <= positionUntil) continue;
    const decision = chooseAction(model, sample, config);
    if (decision.action === 'NO_TRADE') continue;
    const trade = decision.action === 'LONG' ? sample.longTrade : sample.shortTrade;
    if (!trade) continue;
    count += 1;
    netPct += trade.netPct;
    if (trade.netPct > 0) { wins += 1; gain += trade.netPct; } else loss -= trade.netPct;
    peak = Math.max(peak, netPct);
    drawdown = Math.max(drawdown, peak - netPct);
    positionUntil = trade.exitIndex;
    ambiguous += Number(trade.ambiguous);
    byOutcome[trade.reason] = (byOutcome[trade.reason] || 0) + 1;
  }
  return { trades: count, winRate: count ? wins / count : null,
    netPctNotional: netPct, profitFactor: loss > 0 ? gain / loss : null,
    maxRealizedDrawdownPctNotional: drawdown, ambiguousExits: ambiguous, byOutcome };
}

function trainAndEvaluate(samples, assumptions = {}) {
  const config = settings(assumptions);
  const split = splitChronological(samples, config.horizon);
  const model = train(split.trainRows);
  const candidates = [0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map(threshold => ({
    threshold, outcome: simulate(model, split.validation, { ...config, threshold }) }));
  const viable = candidates.filter(item => item.outcome.trades >= 10);
  viable.sort((a, b) => b.outcome.netPctNotional - a.outcome.netPctNotional);
  const threshold = viable[0]?.threshold ?? null;
  const configured = { ...config, threshold: threshold ?? 0.8 };
  const validation = simulate(model, split.validation, configured);
  const holdout = simulate(model, split.holdout, configured);
  const approvedForTrading = false;
  return {
    model: { ...model, horizon: config.horizon, config,
      threshold, approvedForTrading },
    report: { horizon: config.horizon, boundaries: split.boundaries,
      trainingSamples: split.trainRows.length,
      validationMetrics: metrics(model, split.validation),
      holdoutMetrics: metrics(model, split.holdout),
      selection: { threshold, minimumValidationTrades: 10 },
      validation, holdout, approvedForTrading,
      limitations: [
        'Single 60/20/20 split, not full walk-forward optimization',
        'Open-candle gap and intrabar stops are conservative but cannot model exact fills',
        'Funding, liquidation, latency and changing fee tiers are not simulated',
        'Net PnL percentages are notional-based, not leveraged wallet returns',
        'Probabilities are uncalibrated; no live order permission',
      ] },
  };
}

module.exports = { splitChronological, metrics, chooseAction, simulate, trainAndEvaluate };
