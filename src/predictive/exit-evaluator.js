'use strict';

const { NOTIONAL_USDT, simulationSizing, accountExitOutcome } = require('./shadow-sizing');

function scoreExitPlan(forecast, candles, referenceIndex) {
  const plan = forecast.exitPlan;
  if (plan?.status !== 'ESTIMATED') return null;
  const start = referenceIndex ?? candles.findIndex(c => c.closeTime === forecast.candleCloseTime);
  if (!Number.isInteger(start) || start < 0 || candles[start]?.closeTime !== forecast.candleCloseTime || !candles[start + forecast.horizon] ||
      candles[start + forecast.horizon].closeTime !== forecast.targetCloseTime) return null;
  const long = plan.side === 'LONG', direction = long ? 1 : -1;
  const fee = plan.costAssumptions.feePctPerSide / 100;
  const slip = plan.costAssumptions.slippagePctPerSide / 100;
  const first = candles[start + 1];
  const entry = first.open * (1 + direction * slip);
  if (long ? entry >= plan.takeProfit || entry <= plan.stopLoss : entry <= plan.takeProfit || entry >= plan.stopLoss) {
    return accountExitOutcome({ result: 'SKIPPED_ENTRY_GAP', simulatedOnly: true,
      entryPrice: entry, simulatedNetPct: null }, plan);
  }
  let exit = candles[start + forecast.horizon].close, result = 'TIMEOUT', ambiguous = false;
  let exitCloseTime = forecast.targetCloseTime;
  for (let i = start + 1; i <= start + forecast.horizon; i++) {
    const c = candles[i];
    if (c.closeTime !== forecast.candleCloseTime + (i - start) * 60000) return null;
    const stopGap = long ? c.open <= plan.stopLoss : c.open >= plan.stopLoss;
    const targetGap = long ? c.open >= plan.takeProfit : c.open <= plan.takeProfit;
    const stop = long ? c.low <= plan.stopLoss : c.high >= plan.stopLoss;
    const target = long ? c.high >= plan.takeProfit : c.low <= plan.takeProfit;
    if (stopGap || targetGap || stop || target) exitCloseTime = c.closeTime;
    if (stopGap) { exit = c.open; result = 'SL_GAP'; break; }
    if (targetGap) { exit = plan.takeProfit; result = 'TP'; break; }
    if (stop) { exit = plan.stopLoss; result = 'SL'; ambiguous = target; break; }
    if (target) { exit = plan.takeProfit; result = 'TP'; break; }
  }
  const exitFill = exit * (1 - direction * slip);
  return accountExitOutcome({ result, ambiguous, exitCloseTime, simulatedOnly: true, entryPrice: entry, exitPrice: exitFill,
    simulatedNetPct: (direction * (exitFill / entry - 1) - fee * (1 + exitFill / entry)) * 100 }, plan);
}

function exitSummary(records) {
  const planned = records.filter(r => r.exitPlan?.status === 'ESTIMATED');
  const evaluated = planned.filter(r => r.exitOutcome);
  const simulated = evaluated.filter(r => Number.isFinite(r.exitOutcome.simulatedNetPct));
  const netUsdt = simulated.map(r => r.exitOutcome.simulatedNetPct / 100 * NOTIONAL_USDT);
  const wins = netUsdt.filter(value => value > 0).length;
  const losses = netUsdt.filter(value => value < 0).length;
  const total = netUsdt.reduce((sum, value) => sum + value, 0);
  return { ...simulationSizing(), planned: planned.length, evaluated: evaluated.length, pending: planned.length - evaluated.length,
    results: evaluated.reduce((counts, r) => {
      counts[r.exitOutcome.result] = (counts[r.exitOutcome.result] || 0) + 1; return counts;
    }, {}), meanSimulatedNetPctPerForecast: simulated.length ?
      simulated.reduce((sum, r) => sum + r.exitOutcome.simulatedNetPct, 0) / simulated.length : null,
    simulatedTrades: simulated.length, netWins: wins, netLosses: losses,
    breakeven: simulated.length - wins - losses,
    netWinRate: simulated.length ? wins / simulated.length : null,
    totalSimulatedNetUsdt: total, meanSimulatedNetUsdtPerTrade: simulated.length ? total / simulated.length : null,
    aggregateScope: 'RETAINED_INDEPENDENT_FORECASTS',
    simulatedOnly: true, overlappingForecastsAreNotAPortfolio: true };
}

function scoreCandidateExits(forecast, candles) {
  let updates = 0;
  for (const candidate of forecast.exitPlan?.candidates || []) {
    if (candidate.outcome || candidate.validTarget === false) continue;
    const plan = { ...candidate, status: 'ESTIMATED', side: forecast.exitPlan.side,
      costAssumptions: forecast.exitPlan.costAssumptions };
    const outcome = scoreExitPlan({ ...forecast, exitPlan: plan }, candles);
    if (!outcome) continue;
    candidate.outcome = { result: outcome.result, simulatedNetPct: outcome.simulatedNetPct,
      simulatedNetUsdt: outcome.simulatedNetUsdt, exitCloseTime: outcome.exitCloseTime,
      selected: forecast.exitPlan.status === 'ESTIMATED' && candidate.stopId === forecast.exitPlan.stopId &&
        candidate.level === forecast.exitPlan.selectedTarget };
    updates++;
  }
  return updates;
}

function candidateSummary(records) {
  const candidates = records.flatMap(r => r.exitPlan?.candidates || []);
  const completed = candidates.filter(c => Number.isFinite(c.outcome?.simulatedNetPct));
  const summarize = rows => ({ candidates: rows.length,
    netWinRate: rows.length ? rows.filter(c => c.outcome.simulatedNetPct > 0).length / rows.length : null,
    totalNetUsdtAt100: rows.reduce((sum, c) => sum + c.outcome.simulatedNetPct, 0) });
  return { scope: 'COUNTERFACTUAL_CANDIDATES_NOT_A_PORTFOLIO', usedForLiveGate: false,
    planned: candidates.length, completed: completed.length,
    selected: summarize(completed.filter(c => c.outcome.selected)),
    rejected: summarize(completed.filter(c => !c.outcome.selected)),
    byStop: Object.fromEntries([...new Set(completed.map(c => c.stopId))].map(id =>
      [id, summarize(completed.filter(c => c.stopId === id))])) };
}

function sequentialExitRecords(records) {
  const selected = [], ordered = records.filter(r => r.exitPlan?.status === 'ESTIMATED')
    .sort((a, b) => a.candleCloseTime - b.candleCloseTime);
  let blockedUntil = -Infinity;
  for (const record of ordered) {
    if (record.candleCloseTime < blockedUntil) continue;
    const out = record.exitOutcome;
    if (out?.result === 'SKIPPED_ENTRY_GAP') continue;
    selected.push(record);
    blockedUntil = out?.exitCloseTime ?? record.targetCloseTime;
  }
  return selected;
}

module.exports = { scoreExitPlan, exitSummary, scoreCandidateExits, candidateSummary, sequentialExitRecords };
