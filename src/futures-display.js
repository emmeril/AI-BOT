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
  const result = net === null ? 'Hasil Binance belum tersedia.'
    : net < 0 ? 'Penutupan ini tercatat rugi setelah fee SELL.'
      : net > 0 ? 'Penutupan ini tercatat untung setelah fee SELL.' : 'Hasil penutupan ini nol setelah fee SELL.';
  return [
    '[SELL futures terisi]', symbol,
    `Terjual: ${displayNumber(amount, 8)} pada harga ${displayNumber(price, 8)}`,
    '', result,
    `Hasil Binance sebelum fee: ${signedUsdt(valid ? gross : null)}`,
    `Fee SELL: ${signedUsdt(fee)}`,
    `Hasil setelah fee SELL: ${signedUsdt(net)}`,
    'Fee BUY dan funding dihitung terpisah dalam hasil total.',
    ...(gridProfit == null ? [] : ['', `Selisih pasangan grid: ${signedUsdt(gridProfit)}`, 'Ini statistik pasangan BUY-SELL, bukan hasil total akun.']),
    ...(valid && gross < 0 ? ['SELL ini menutup LONG di bawah entry rata-rata Binance saat eksekusi.'] : []),
    'SELL mengurangi posisi. Jika masih ada sisa LONG, posisinya tetap berjalan.',
  ].join('\n');
}

module.exports = { displayNumber, signedUsdt, sellEntryLabel, sellOverview, sellFillMessage };
