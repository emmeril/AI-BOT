'use strict';

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
    return { result: 'SKIPPED_ENTRY_GAP', simulatedOnly: true, entryPrice: entry, simulatedNetPct: null };
  }
  let exit = candles[start + forecast.horizon].close, result = 'TIMEOUT', ambiguous = false;
  for (let i = start + 1; i <= start + forecast.horizon; i++) {
    const c = candles[i];
    if (c.closeTime !== forecast.candleCloseTime + (i - start) * 60000) return null;
    const stopGap = long ? c.open <= plan.stopLoss : c.open >= plan.stopLoss;
    const targetGap = long ? c.open >= plan.takeProfit : c.open <= plan.takeProfit;
    const stop = long ? c.low <= plan.stopLoss : c.high >= plan.stopLoss;
    const target = long ? c.high >= plan.takeProfit : c.low <= plan.takeProfit;
    if (stopGap) { exit = c.open; result = 'SL_GAP'; break; }
    if (targetGap) { exit = plan.takeProfit; result = 'TP'; break; }
    if (stop) { exit = plan.stopLoss; result = 'SL'; ambiguous = target; break; }
    if (target) { exit = plan.takeProfit; result = 'TP'; break; }
  }
  const exitFill = exit * (1 - direction * slip);
  return { result, ambiguous, simulatedOnly: true, entryPrice: entry, exitPrice: exitFill,
    simulatedNetPct: (direction * (exitFill / entry - 1) - fee * (1 + exitFill / entry)) * 100 };
}

function exitSummary(records) {
  const planned = records.filter(r => r.exitPlan?.status === 'ESTIMATED');
  const evaluated = planned.filter(r => r.exitOutcome);
  const simulated = evaluated.filter(r => Number.isFinite(r.exitOutcome.simulatedNetPct));
  return { planned: planned.length, evaluated: evaluated.length, pending: planned.length - evaluated.length,
    results: evaluated.reduce((counts, r) => {
      counts[r.exitOutcome.result] = (counts[r.exitOutcome.result] || 0) + 1; return counts;
    }, {}), meanSimulatedNetPctPerForecast: simulated.length ?
      simulated.reduce((sum, r) => sum + r.exitOutcome.simulatedNetPct, 0) / simulated.length : null,
    simulatedOnly: true, overlappingForecastsAreNotAPortfolio: true };
}

module.exports = { scoreExitPlan, exitSummary };
