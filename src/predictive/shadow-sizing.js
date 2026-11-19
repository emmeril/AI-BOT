'use strict';

const NOTIONAL_USDT = 100;

function simulationSizing() {
  return { sizing: 'FIXED_NOTIONAL', notionalUsdtPerTrade: NOTIONAL_USDT, compounding: false };
}

function sizeExitPlan(plan) {
  if (plan?.status !== 'ESTIMATED') return plan;
  return { ...plan, sizing: 'FIXED_NOTIONAL', notionalUsdt: NOTIONAL_USDT, compounding: false };
}

function accountExitOutcome(outcome, plan) {
  if (!outcome) return outcome;
  const base = { ...outcome, plannedNotionalUsdt: NOTIONAL_USDT, compounding: false };
  if (outcome.result === 'SKIPPED_ENTRY_GAP') {
    return { ...base, executedNotionalUsdt: 0, quantity: 0,
      grossPnlUsdt: 0, feesUsdt: 0, simulatedNetUsdt: null };
  }
  if (!Number.isFinite(outcome.simulatedNetPct) || !(outcome.entryPrice > 0) ||
      !(outcome.exitPrice > 0) || !['LONG', 'SHORT'].includes(plan?.side)) {
    throw new Error('Invalid completed shadow trade');
  }
  const feePct = plan.costAssumptions?.feePctPerSide;
  if (!Number.isFinite(feePct) || feePct < 0) throw new Error('Invalid shadow fee assumption');
  const quantity = NOTIONAL_USDT / outcome.entryPrice;
  const ratio = outcome.exitPrice / outcome.entryPrice;
  return { ...base, executedNotionalUsdt: NOTIONAL_USDT, quantity,
    grossPnlUsdt: (plan.side === 'LONG' ? 1 : -1) * (ratio - 1) * NOTIONAL_USDT,
    feesUsdt: feePct / 100 * (1 + ratio) * NOTIONAL_USDT,
    simulatedNetUsdt: outcome.simulatedNetPct / 100 * NOTIONAL_USDT };
}

function normalizeFixedSizing(records) {
  for (const record of records) {
    if (record.exitPlan?.status !== 'ESTIMATED') continue;
    record.exitPlan = sizeExitPlan(record.exitPlan);
    if (record.exitOutcome) record.exitOutcome = accountExitOutcome(record.exitOutcome, record.exitPlan);
  }
}

module.exports = { NOTIONAL_USDT, simulationSizing, sizeExitPlan, accountExitOutcome, normalizeFixedSizing };
