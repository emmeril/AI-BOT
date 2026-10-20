'use strict';

const HOUR_MS = 60 * 60 * 1000;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function momentumState(decision, positionSide) {
  if (!decision?.available || !decision.direction) return 'UNKNOWN';
  const direction = String(decision.direction).toUpperCase();
  const required = String(positionSide).toUpperCase() === 'SHORT' ? 'BEARISH' : 'BULLISH';
  return direction === required ? 'ALIGNED' : 'OPPOSING';
}

function nearestFavorableLevel(levels, currentPrice, positionSide) {
  const current = Number(currentPrice);
  const candidates = (levels || [])
    .map((price, index) => ({ index, price: Number(price) }))
    .filter(level => Number.isFinite(level.price) && (
      String(positionSide).toUpperCase() === 'SHORT'
        ? level.price < current
        : level.price > current
    ));
  candidates.sort((left, right) => String(positionSide).toUpperCase() === 'SHORT'
    ? right.price - left.price
    : left.price - right.price);
  return candidates[0] || null;
}

function nearestAdverseLevel(levels, currentPrice, positionSide) {
  const current = Number(currentPrice);
  const candidates = (levels || [])
    .map((price, index) => ({ index, price: Number(price) }))
    .filter(level => Number.isFinite(level.price) && (
      String(positionSide).toUpperCase() === 'SHORT'
        ? level.price > current
        : level.price < current
    ));
  candidates.sort((left, right) => String(positionSide).toUpperCase() === 'SHORT'
    ? left.price - right.price
    : right.price - left.price);
  return candidates[0] || null;
}

function trackedInventorySummary(lastBuyByLevel) {
  const entries = Object.values(lastBuyByLevel || {});
  return entries.reduce((summary, entry) => {
    const amount = finiteNonNegative(entry?.sellableAmount ?? entry?.amount);
    if (!(amount > 0)) return summary;
    summary.amount += amount;
    summary.costQuote += finiteNonNegative(entry?.totalCostQuote);
    summary.entryFeeQuote += finiteNonNegative(entry?.totalFeeQuote);
    return summary;
  }, { amount: 0, costQuote: 0, entryFeeQuote: 0 });
}

function realizedProfitBank(symState, reserveUsdt = 0) {
  const realized = Number(symState?.realizedGridProfit || 0) +
    Number(symState?.realizedExitProfit || 0) +
    Number(symState?.fundingProfit || 0);
  return Math.max(0, realized - finiteNonNegative(reserveUsdt));
}

function buildProfitBankExit({
  positionSide,
  inventory,
  positionAmount,
  exitPrice,
  availableProfit,
  makerFeeRate,
  maximumFraction = 1,
}) {
  const trackedAmount = finiteNonNegative(inventory?.amount);
  const liveAmount = finiteNonNegative(positionAmount);
  const price = Number(exitPrice);
  const targetFraction = Math.min(1, finiteNonNegative(maximumFraction));
  const closeableAmount = Math.min(trackedAmount, liveAmount);
  if (!(closeableAmount > 0) || !(price > 0) || !(targetFraction > 0)) return null;

  const trackedRatio = closeableAmount / trackedAmount;
  const allocatedCost = finiteNonNegative(inventory?.costQuote) * trackedRatio;
  const allocatedEntryFee = finiteNonNegative(inventory?.entryFeeQuote) * trackedRatio;
  const exitFee = closeableAmount * price * finiteNonNegative(makerFeeRate);
  const grossPnl = String(positionSide).toUpperCase() === 'SHORT'
    ? allocatedCost - closeableAmount * price
    : closeableAmount * price - allocatedCost;
  const fullNetPnl = grossPnl - allocatedEntryFee - exitFee;
  const affordableFraction = fullNetPnl < 0
    ? Math.min(1, finiteNonNegative(availableProfit) / Math.abs(fullNetPnl))
    : 1;
  const fraction = Math.min(targetFraction, affordableFraction);
  if (!(fraction > 0)) return null;

  return {
    amount: closeableAmount * fraction,
    fraction,
    estimatedNetPnl: fullNetPnl * fraction,
    profitUsed: Math.max(0, -fullNetPnl * fraction),
    fullNetPnl,
  };
}

function reversalAgeHours(opposingSince, now = Date.now()) {
  const since = Date.parse(opposingSince || '');
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, now - since) / HOUR_MS;
}

module.exports = {
  buildProfitBankExit,
  momentumState,
  nearestAdverseLevel,
  nearestFavorableLevel,
  realizedProfitBank,
  reversalAgeHours,
  trackedInventorySummary,
};
