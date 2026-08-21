const EPSILON = 1e-8;

function tradeFee(trade) {
  return {
    currency: String(trade?.fee?.currency || trade?.info?.commissionAsset || '').toUpperCase(),
    cost: Number(trade?.fee?.cost || trade?.info?.commission || 0),
  };
}

function replayFifoInventory(trades, baseAsset, quoteAsset) {
  const base = String(baseAsset).toUpperCase();
  const quote = String(quoteAsset).toUpperCase();
  const lots = [];

  for (const trade of [...trades].sort((a, b) => Number(a.timestamp) - Number(b.timestamp))) {
    const side = String(trade.side).toLowerCase();
    const amount = Number(trade.amount) || 0;
    const price = Number(trade.price) || 0;
    const fee = tradeFee(trade);
    if (!(amount > 0) || !(price > 0)) continue;

    if (side === 'buy') {
      const sellableAmount = amount - (fee.currency === base ? fee.cost : 0);
      const totalCostQuote = amount * price + (fee.currency === quote ? fee.cost : 0);
      if (sellableAmount > EPSILON) {
        lots.push({ sellableAmount, totalCostQuote, timestamp: Number(trade.timestamp) || 0 });
      }
      continue;
    }

    if (side !== 'sell') continue;
    let remaining = amount + (fee.currency === base ? fee.cost : 0);
    while (remaining > EPSILON && lots.length) {
      const lot = lots[0];
      const consumed = Math.min(remaining, lot.sellableAmount);
      const proportion = consumed / lot.sellableAmount;
      lot.sellableAmount -= consumed;
      lot.totalCostQuote -= lot.totalCostQuote * proportion;
      remaining -= consumed;
      if (lot.sellableAmount <= EPSILON) lots.shift();
    }
    if (remaining > EPSILON) {
      throw new Error(`Sell history exceeds reconstructed inventory by ${remaining} ${base}`);
    }
  }

  const sellableAmount = lots.reduce((sum, lot) => sum + lot.sellableAmount, 0);
  const totalCostQuote = lots.reduce((sum, lot) => sum + lot.totalCostQuote, 0);
  return {
    lots,
    sellableAmount,
    totalCostQuote,
    averagePrice: sellableAmount > 0 ? totalCostQuote / sellableAmount : 0,
  };
}

function summarizeTrackedInventory(symState) {
  return Object.values(symState?.lastBuyByLevel || {}).reduce((summary, buy) => {
    summary.sellableAmount += Number(buy?.sellableAmount ?? buy?.amount) || 0;
    summary.totalCostQuote += (Number(buy?.totalCostQuote) || 0) + (Number(buy?.totalFeeQuote) || 0);
    return summary;
  }, { sellableAmount: 0, totalCostQuote: 0 });
}

function calculateInventoryRecovery(replayed, tracked) {
  const sellableAmount = replayed.sellableAmount - tracked.sellableAmount;
  const totalCostQuote = replayed.totalCostQuote - tracked.totalCostQuote;
  if (sellableAmount < -EPSILON || totalCostQuote < -EPSILON) {
    throw new Error('Tracked inventory exceeds FIFO-reconstructed inventory; refusing automatic recovery');
  }
  return {
    sellableAmount: Math.max(0, sellableAmount),
    totalCostQuote: Math.max(0, totalCostQuote),
    averagePrice: sellableAmount > EPSILON ? totalCostQuote / sellableAmount : 0,
  };
}

module.exports = {
  EPSILON,
  replayFifoInventory,
  summarizeTrackedInventory,
  calculateInventoryRecovery,
};
