'use strict';

function hasPosition(position) {
  return Math.abs(Number(position?.contracts ?? position?.info?.positionAmt) || 0) > 1e-12;
}

function positionForSide(positions, symbol, side) {
  return positions.find(position =>
    position.symbol === symbol &&
    String(position.side || position.info?.positionSide).toUpperCase() === side &&
    hasPosition(position)
  ) || null;
}

function canActivateHandoff({ positions = [], regularOrders = [], algoOrders = [] } = {}) {
  return !positions.some(hasPosition) && regularOrders.length === 0 && algoOrders.length === 0;
}

function protectionPrices(entryPrice, { takeProfitPct = 2.5, stopLossPct = 1, side = 'SHORT',
  protectionMode, takeProfitPrice, stopLossPrice } = {}) {
  const entry = Number(entryPrice);
  if (!(entry > 0)) throw new Error(`Invalid scalper entry price: ${entryPrice}`);
  const direction = String(side).toUpperCase() === 'LONG' ? 1 : -1;
  if (protectionMode === 'HISTORICAL_CROSS' || protectionMode === 'CROSS_TARGET_RR1') {
    const takeProfit = Number(takeProfitPrice);
    const stopLoss = protectionMode === 'CROSS_TARGET_RR1' ? 2 * entry - takeProfit : Number(stopLossPrice);
    if (!(takeProfit > 0 && stopLoss > 0 && direction * (takeProfit - entry) > 0 && direction * (entry - stopLoss) > 0)) {
      throw new Error('Historical cross TP/SL no longer bracket entry');
    }
    return { takeProfit, stopLoss };
  }
  return {
    takeProfit: entry * (100 + direction * takeProfitPct) / 100,
    stopLoss: entry * (100 - direction * stopLossPct) / 100,
  };
}

module.exports = {
  canActivateHandoff,
  hasPosition,
  positionForSide,
  protectionPrices,
};
