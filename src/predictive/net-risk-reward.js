'use strict';

const RISK_POLICY_ID = 'INTRAHORIZON_TP1_TP2_V4';
const REWARD_MULTIPLES = Object.freeze([1, 2]);

function calculateRiskTargets({ side, entryFill, stopLoss, tickSize, costAssumptions }, rewards = REWARD_MULTIPLES) {
  if (!['LONG', 'SHORT'].includes(side) || ![entryFill, stopLoss].every(v => Number.isFinite(v) && v > 0) ||
      ![costAssumptions?.feePctPerSide, costAssumptions?.slippagePctPerSide]
        .every(v => Number.isFinite(v) && v >= 0 && v < 100) ||
      (tickSize != null && (!Number.isFinite(tickSize) || tickSize <= 0)) ||
      !Array.isArray(rewards) || !rewards.length || !rewards.every(v => Number.isFinite(v) && v > 0)) {
    throw new Error('Invalid target calculation inputs');
  }
  const direction = side === 'LONG' ? 1 : -1;
  const base = { riskPolicyId: RISK_POLICY_ID, side, stopLoss, costAssumptions };
  if (!(direction === 1 ? stopLoss < entryFill : stopLoss > entryFill)) {
    return { ...base, status: 'UNAVAILABLE', reason: 'ENTRY_OUTSIDE_STOP_RANGE' };
  }
  const estimatedNetLossPct = -netReturnPct(side, entryFill, stopLoss, costAssumptions);
  const fee = costAssumptions.feePctPerSide / 100, slip = costAssumptions.slippagePctPerSide / 100;
  const targetLevels = rewards.map(rewardMultiple => {
    const ratio = (rewardMultiple * estimatedNetLossPct / 100 + direction + fee) / (direction - fee);
    let takeProfit = entryFill * ratio / (1 - direction * slip);
    if (tickSize) {
      const units = takeProfit / tickSize;
      takeProfit = Number(((direction === 1 ? Math.ceil(units - 1e-9) : Math.floor(units + 1e-9)) * tickSize).toPrecision(14));
    }
    const estimatedNetProfitPct = netReturnPct(side, entryFill, takeProfit, costAssumptions);
    return { level: rewardMultiple === 1 ? 'TP1' : rewardMultiple === 2 ? 'TP2' : 'R' + rewardMultiple,
      rewardMultiple, takeProfit, estimatedNetProfitPct,
      estimatedNetRewardRisk: estimatedNetProfitPct / estimatedNetLossPct,
      validTarget: Number.isFinite(takeProfit) && takeProfit > 0 &&
        estimatedNetProfitPct + 1e-10 >= rewardMultiple * estimatedNetLossPct };
  });
  return { ...base, status: 'TARGETS_CALCULATED', estimatedNetLossPct, targetLevels };
}

function netReturnPct(side, entryFill, triggerPrice, costs) {
  const direction = side === 'LONG' ? 1 : -1;
  const fee = costs.feePctPerSide / 100;
  const slip = costs.slippagePctPerSide / 100;
  const exitFill = triggerPrice * (1 - direction * slip);
  const ratio = exitFill / entryFill;
  return (direction * (ratio - 1) - fee * (1 + ratio)) * 100;
}

function planNetRiskReward({ side, entryFill, stopLoss, projectedPrice, tickSize, costAssumptions }) {
  if (!['LONG', 'SHORT'].includes(side) ||
      ![entryFill, stopLoss, projectedPrice].every(value => Number.isFinite(value) && value > 0) ||
      ![costAssumptions?.feePctPerSide, costAssumptions?.slippagePctPerSide]
        .every(value => Number.isFinite(value) && value >= 0 && value < 100) ||
      (tickSize != null && (!Number.isFinite(tickSize) || tickSize <= 0))) {
    throw new Error('Invalid net risk/reward inputs');
  }
  const long = side === 'LONG', direction = long ? 1 : -1;
  const base = { riskPolicyId: 'PRICE_SUPPORTED_TP1_TP2_V3', selectionRule: 'TP2_IF_SUPPORTED_ELSE_TP1',
    side, stopLoss, projectedPrice, projectionBasis: 'PREDICTED_HORIZON_CLOSE', costAssumptions };
  if (!(long ? stopLoss < entryFill : stopLoss > entryFill)) {
    return { ...base, status: 'UNAVAILABLE', reason: 'ENTRY_OUTSIDE_STOP_RANGE' };
  }
  const estimatedNetLossPct = -netReturnPct(side, entryFill, stopLoss, costAssumptions);
  if (!(estimatedNetLossPct > 0)) throw new Error('Stop must have a positive estimated net loss');
  const fee = costAssumptions.feePctPerSide / 100;
  const slip = costAssumptions.slippagePctPerSide / 100;
  const targetLevels = REWARD_MULTIPLES.map(rewardMultiple => {
    const ratio = (rewardMultiple * estimatedNetLossPct / 100 + direction + fee) / (direction - fee);
    const rawTarget = entryFill * ratio / (1 - direction * slip);
    let takeProfit = rawTarget;
    if (tickSize) {
      const units = rawTarget / tickSize;
      takeProfit = Number(((long ? Math.ceil(units - 1e-9) : Math.floor(units + 1e-9)) * tickSize).toPrecision(14));
    }
    const estimatedNetProfitPct = netReturnPct(side, entryFill, takeProfit, costAssumptions);
    const validTarget = Number.isFinite(takeProfit) && takeProfit > 0 &&
      estimatedNetProfitPct + 1e-10 >= rewardMultiple * estimatedNetLossPct;
    const supportedByProjection = validTarget && (long ? projectedPrice >= takeProfit - 1e-12 : projectedPrice <= takeProfit + 1e-12);
    return { level: 'TP' + rewardMultiple, rewardMultiple, takeProfit,
      estimatedNetProfitPct, estimatedNetRewardRisk: estimatedNetProfitPct / estimatedNetLossPct,
      validTarget, supportedByProjection };
  });
  const details = { ...base, estimatedNetLossPct, targetLevels,
    takeProfit1: targetLevels[0].takeProfit, takeProfit2: targetLevels[1].takeProfit };
  const selected = [...targetLevels].reverse().find(level => level.supportedByProjection);
  if (!selected) return { ...details, status: 'UNAVAILABLE',
    reason: targetLevels.some(t => t.validTarget) ? 'PROJECTED_PRICE_DOES_NOT_REACH_TP1' : 'INVALID_TP_LEVELS',
    requiredTakeProfit: targetLevels[0].takeProfit };
  return { ...details, status: 'ESTIMATED', selectedTarget: selected.level,
    rewardMultiple: selected.rewardMultiple, takeProfit: selected.takeProfit,
    estimatedNetProfitPct: selected.estimatedNetProfitPct,
    estimatedNetRewardRisk: selected.estimatedNetRewardRisk,
    projectedTargetMarginPct: direction * (projectedPrice / selected.takeProfit - 1) * 100 };
}

module.exports = { RISK_POLICY_ID, REWARD_MULTIPLES, netReturnPct, calculateRiskTargets, planNetRiskReward };
