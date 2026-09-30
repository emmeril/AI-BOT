async function deferUnreconciledSell(symbol, symState, trade, orderMeta, reason) {
  symState.unreconciledSells ||= {};
  const id = String(this.getTradeId(trade) ?? '');
  if (!id) throw new Error(`${symbol}: cannot defer an unreconciled sell without a trade ID`);
  const firstSeen = !symState.unreconciledSells[id];
  symState.unreconciledSells[id] = {
    trade, orderMeta, reason,
    firstSeenAt: symState.unreconciledSells[id]?.firstSeenAt || new Date().toISOString(),
  };
  await this.state.save();
  if (firstSeen) {
    const title = `${typeof this.formatFuturesTelegramMessage === 'function' ? 'FUTURES' : 'SPOT'} SELL FILLED - UNRECONCILED`;
    const rows = [
      ['Symbol', symbol],
      ['Trade ID', id],
      ['Order ID', trade.order],
      ['Level', orderMeta?.levelIndex],
      ['Source Buy Level', this.getSellSourceBuyLevelIndex(orderMeta)],
      ['Reason', reason],
      ['Trading', 'new orders blocked until cost basis is reconciled'],
    ];
    const formatter = this.formatFuturesTelegramMessage || this.formatTelegramMessage;
    await this.sendAlert(formatter.call(this, title, rows));
  }
  return false;
}

function remapDelayedSellOrderMeta(symbol, symState, trade, orderMeta) {
  const orderId = String(trade?.order ?? '');
  const remap = symState.remappedSellSources?.[orderId];
  const mappedSource = Number(remap?.sourceBuyLevelIndex);
  if (!orderId || !Number.isInteger(mappedSource)) return orderMeta;

  const currentSource = this.getSellSourceBuyLevelIndex(orderMeta);
  if (currentSource !== mappedSource) {
    console.warn(
      `[RECOVER] ${symbol} delayed SELL order ${orderId} sourceBuy=${currentSource}->${mappedSource} ` +
      'after range remap'
    );
  }
  return { ...orderMeta, sourceBuyLevelIndex: mappedSource };
}

async function retryUnreconciledSells(symbol, levels, symState, openOrderIds) {
  // Buys later in the fetched batch may restore the missing cost basis.
  const pending = Object.entries(symState.unreconciledSells || {})
    .map(([id, entry]) => {
      if (!entry || typeof entry !== 'object' || !entry.trade || !entry.orderMeta) {
        throw new Error(`${symbol}: invalid unreconciled sell state for trade ${id}`);
      }
      return entry;
    })
    .sort((a, b) => Number(a.trade.timestamp) - Number(b.trade.timestamp));
  for (const { trade, orderMeta } of pending) {
    const resolvedMeta = this.remapDelayedSellOrderMeta(symbol, symState, trade, orderMeta);
    await this.handleSellFill(symbol, levels, symState, trade, resolvedMeta, openOrderIds);
  }
  const count = Object.keys(symState.unreconciledSells || {}).length;
  if (count) throw new Error(`${symbol}: ${count} unreconciled sell fill(s); holding trade watermark and new orders`);
}

function applyUnreconciledFillMethods(target) {
  Object.assign(target.prototype, {
    deferUnreconciledSell,
    remapDelayedSellOrderMeta,
    retryUnreconciledSells,
  });
}

module.exports = {
  applyUnreconciledFillMethods,
  deferUnreconciledSell,
  remapDelayedSellOrderMeta,
  retryUnreconciledSells,
};
