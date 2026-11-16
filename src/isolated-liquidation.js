'use strict';

function marginBracket(notional, brackets) {
  const bracket = brackets.find(item => notional >= Number(item.notionalFloor) && notional < Number(item.notionalCap));
  if (!bracket) throw new Error(`Notional outside supplied margin brackets: ${notional}`);
  return bracket;
}

function maintenanceMargin(notional, brackets) {
  const bracket = marginBracket(notional, brackets);
  return Math.max(0, notional * Number(bracket.maintMarginRatio) - Number(bracket.cum));
}

function liquidationPrice(position, brackets) {
  const { quantity, entry, direction, isolatedWallet } = position;
  if (!(quantity > 0 && entry > 0 && [1, -1].includes(direction))) throw new Error('Invalid isolated position');
  for (const bracket of brackets) {
    const price = (direction * quantity * entry - isolatedWallet - Number(bracket.cum)) /
      (quantity * (direction - Number(bracket.maintMarginRatio)));
    const notional = quantity * price;
    if (price > 0 && notional >= Number(bracket.notionalFloor) && notional < Number(bracket.notionalCap)) return price;
  }
  if (direction === 1 && isolatedWallet >= quantity * entry) return null;
  throw new Error('Liquidation root outside supplied maintenance tiers');
}

function isLiquidatable(position, markPrice, brackets) {
  const marginEquity = position.isolatedWallet + position.direction * position.quantity * (markPrice - position.entry);
  return marginEquity <= maintenanceMargin(position.quantity * markPrice, brackets) + 1e-10;
}

function settleLiquidation(position, executionPrice, markPrice, liquidationFeeRate) {
  const grossPnl = position.direction * position.quantity * (executionPrice - position.entry);
  const remainingCollateral = position.isolatedWallet + grossPnl;
  const assessedClearance = position.quantity * markPrice * liquidationFeeRate;
  const clearanceFee = Math.min(Math.max(0, remainingCollateral), assessedClearance);
  const returnedCollateral = Math.max(0, remainingCollateral - clearanceFee);
  return { grossPnl, assessedClearance, clearanceFee, returnedCollateral,
    insuranceCovered: Math.max(0, -remainingCollateral) };
}

module.exports = { marginBracket, maintenanceMargin, liquidationPrice, isLiquidatable, settleLiquidation };
