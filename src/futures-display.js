function displayNumber(value, digits = 4) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return 'belum tersedia';
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: digits }).format(Number(value));
}

function signedUsdt(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'belum tersedia';
  return `${Number(value) > 0 ? '+' : ''}${displayNumber(value, 6)} USDT`;
}

function sellEntryLabel(price, entryPrice) {
  if (!(Number(entryPrice) > 0) || !(Number(price) > 0)) return 'Entry belum tersedia';
  if (Number(price) < Number(entryPrice)) return 'Di bawah entry rata-rata';
  if (Number(price) > Number(entryPrice)) return 'Di atas entry rata-rata';
  return 'Sama dengan entry rata-rata';
}

function sellOverview(orders, position) {
  const sells = Object.values(orders || {}).filter(o => o.side === 'sell' && Number(o.price) > 0)
    .sort((a, b) => Number(a.price) - Number(b.price));
  const entry = Number(position?.entryPrice);
  return {
    nearestPrice: sells.length ? Number(sells[0].price) : null,
    nearestLabel: sells.length ? sellEntryLabel(sells[0].price, entry) : 'Belum ada order SELL aktif',
    belowEntryCount: entry > 0 ? sells.filter(o => Number(o.price) < entry).length : null,
  };
}

function sellFillMessage({ symbol, price, amount, realizedPnl, fee, gridProfit }) {
  const gross = realizedPnl == null || realizedPnl === '' ? null : Number(realizedPnl);
  const valid = Number.isFinite(gross) && gross !== null;
  const net = valid ? gross - fee : null;
  return [
    `[SELL] ${symbol}`,
    `${displayNumber(amount, 8)} @ ${displayNumber(price, 8)}`,
    `PnL setelah fee: ${signedUsdt(net)} (fee: ${signedUsdt(fee)})`,
    ...(gridProfit == null ? [] : [`Grid: ${signedUsdt(gridProfit)}`]),
    ...(valid && gross < 0 ? ['Tutup di bawah entry rata-rata.'] : []),
  ].join('\n');
}

module.exports = { displayNumber, signedUsdt, sellEntryLabel, sellOverview, sellFillMessage };
