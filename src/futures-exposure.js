function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid exposure ${name}`);
  return number;
}

function exposureBySymbol(symbols, positions, orders) {
  const values = Object.fromEntries(symbols.map(symbol => [symbol, 0]));
  for (const position of positions) {
    if (!(position.symbol in values)) continue;
    const amount = Math.abs(Number(position.contracts));
    if (!Number.isFinite(amount)) throw new Error('Invalid position quantity');
    if (!amount) continue;
    const contractSize = positive(position.contractSize ?? 1, 'contract size');
    const entry = positive(position.entryPrice, 'entry price');
    const mark = positive(position.markPrice ?? position.info?.markPrice, 'mark price');
    if (!entry || !mark) throw new Error('Missing exposure price');
    values[position.symbol] += amount * contractSize * Math.max(entry, mark);
  }
  for (const order of orders) {
    if (!(order.symbol in values) || String(order.side).toLowerCase() !== 'buy') continue;
    if (String(order.info?.positionSide).toUpperCase() === 'SHORT' || order.reduceOnly === true) continue;
    const remaining = positive(order.remaining ?? Math.max(0, Number(order.amount) - Number(order.filled || 0)), 'remaining');
    const price = positive(order.price, 'order price');
    if (remaining && !price) throw new Error('Missing pending BUY price');
    values[order.symbol] += remaining * price;
  }
  return { values, total: Object.values(values).reduce((sum, value) => sum + value, 0) };
}

module.exports = { exposureBySymbol };
