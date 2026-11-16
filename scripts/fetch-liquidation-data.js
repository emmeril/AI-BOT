'use strict';
const fs = require('fs');

async function get(endpoint, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch('https://fapi.binance.com/fapi/v1/' + endpoint + '?' + new URLSearchParams(params),
        { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Public ${endpoint} HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

async function main() {
  fs.mkdirSync('backtest-data/liquidation', { recursive: true });
  const bracketFile = 'backtest-data/liquidation/1000bonk-brackets.json';
  if (!fs.existsSync(bracketFile)) {
    const crypto = require('crypto');
    const environment = require('dotenv').parse(fs.readFileSync('.env.futures'));
    const time = await get('time', {});
    const query = new URLSearchParams({ symbol: '1000BONKUSDT', timestamp: String(time.serverTime), recvWindow: '10000' }).toString();
    const signature = crypto.createHmac('sha256', environment.EXCHANGE_SECRET).update(query).digest('hex');
    const response = await fetch('https://fapi.binance.com/fapi/v1/leverageBracket?' + query + '&signature=' + signature,
      { headers: { 'X-MBX-APIKEY': environment.EXCHANGE_API_KEY }, signal: AbortSignal.timeout(20_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(`Read-only bracket endpoint HTTP ${response.status}, code ${data.code}`);
    fs.writeFileSync(bracketFile, JSON.stringify({ fetchedAt: new Date().toISOString(),
      source: 'Binance signed GET /fapi/v1/leverageBracket', data }, null, 2));
  }
  const previous = JSON.parse(fs.readFileSync('backtest-results/pure-cross-selection.json'));
  const start = previous.periods.selection13d.start;
  const end = previous.periods.november.end;
  const rows = [];
  let cursor = start;
  while (cursor < end) {
    const batch = await get('markPriceKlines', { symbol: '1000BONKUSDT', interval: '1m', startTime: cursor, endTime: end - 1, limit: 1500 });
    if (!batch.length || Number(batch[0][0]) !== cursor) throw new Error('Incomplete mark price history');
    rows.push(...batch);
    cursor = Number(batch.at(-1)[0]) + 60_000;
    if (rows.length % 15_000 === 0) console.log(`[MARK] ${rows.length} candles`);
  }
  for (let i = 0; i < rows.length; i++) {
    if (Number(rows[i][6]) !== Number(rows[i][0]) + 59_999 ||
      (i && Number(rows[i][0]) - Number(rows[i-1][0]) !== 60_000)) throw new Error('Invalid mark candle sequence');
  }
  const info = await get('exchangeInfo', {});
  const symbol = info.symbols.find(item => item.symbol === '1000BONKUSDT');
  fs.mkdirSync('backtest-data/liquidation', { recursive: true });
  fs.writeFileSync('backtest-data/liquidation/1000bonk-mark-1m.json', JSON.stringify(rows));
  fs.writeFileSync('backtest-data/liquidation/1000bonk-market-metadata.json', JSON.stringify({
    fetchedAt: new Date().toISOString(), source: 'Binance public GET /fapi/v1/exchangeInfo',
    symbol: symbol.symbol, liquidationFee: Number(symbol.liquidationFee),
    priceFilter: symbol.filters.find(filter => filter.filterType === 'PRICE_FILTER'),
    start, end, markCandles: rows.length,
  }, null, 2));
  console.log(JSON.stringify({ start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    candles: rows.length, liquidationFee: symbol.liquidationFee }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
