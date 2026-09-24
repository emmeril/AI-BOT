const DAY = 86400000;
const TYPES = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE', 'COMMISSION_REBATE', 'API_REBATE', 'FEE_RETURN', 'INSURANCE_CLEAR']);

async function syncIncome(exchange, previous, symbol, createdAt, now = Date.now()) {
  const requestedSince = Date.parse(createdAt);
  if (!Number.isFinite(requestedSince)) throw new Error('Missing accounting start date');
  const oldest = now - 89 * DAY;
  const since = previous?.since ?? Math.max(requestedSince, oldest);
  const records = { ...(previous?.records || {}) };
  const start = Math.max(since, (previous?.syncedAt || since) - 7 * DAY);
  if (start < oldest) throw new Error('Income history gap exceeds Binance retention');
  const marketId = exchange.market(symbol).id;
  for (let from = start; from <= now; from += 7 * DAY) {
    const endTime = Math.min(now, from + 7 * DAY - 1);
    let complete = false;
    for (let page = 1; page <= 100; page++) {
      const rows = await exchange.fapiPrivateGetIncome({ symbol: marketId, startTime: from, endTime, page, limit: 1000 });
      if (!Array.isArray(rows)) throw new Error('Invalid Binance income response');
      for (const row of rows) {
        if (row.symbol !== marketId || !TYPES.has(row.incomeType)) continue;
        const time = Number(row.time);
        const income = Number(row.income);
        if (!Number.isFinite(time) || !Number.isFinite(income) || row.tranId == null) {
          throw new Error('Invalid Binance income record');
        }
        if (time < since || time > now) continue;
        records[`${row.incomeType}:${row.tranId}`] = { type: row.incomeType, asset: row.asset, income, time };
      }
      if (rows.length < 1000) { complete = true; break; }
    }
    if (!complete) throw new Error('Binance income pagination limit reached');
  }
  return { since, syncedAt: now, truncated: previous?.truncated ?? requestedSince < oldest, records };
}

function incomeMetrics(ledger, unrealizedPnl = 0, now = Date.now()) {
  const records = Object.values(ledger?.records || {});
  const incomplete = !ledger || ledger.truncated || records.some(row => row.asset !== 'USDT');
  const stale = !ledger?.syncedAt || now - ledger.syncedAt > 10 * 60000;
  const sum = types => records.filter(row => row.asset === 'USDT' && types.includes(row.type))
    .reduce((total, row) => total + row.income, 0);
  const gross = sum(['REALIZED_PNL']);
  const commission = sum(['COMMISSION', 'COMMISSION_REBATE', 'API_REBATE', 'FEE_RETURN']);
  const funding = sum(['FUNDING_FEE']);
  const other = sum(['INSURANCE_CLEAR']);
  return {
    ready: !incomplete && !stale, stale, incomplete: Boolean(incomplete),
    since: ledger?.since ?? null, syncedAt: ledger?.syncedAt ?? null,
    scope: 'All Binance trades for this symbol (LONG and SHORT, including manual trades)',
    gross, fees: -commission, funding, other,
    realized: incomplete || stale ? null : gross + commission + other,
    net: incomplete || stale ? null : gross + commission + other + funding + unrealizedPnl,
  };
}

module.exports = { syncIncome, incomeMetrics };
