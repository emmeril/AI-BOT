'use strict';
const fs = require('fs');

async function get(endpoint, parameters) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch('https://fapi.binance.com/fapi/v1/' + endpoint + '?' + new URLSearchParams(parameters),
        { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('Binance public HTTP ' + response.status);
      return await response.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

async function main() {
  const oldPath = 'backtest-data/micro-scalper/1000bonk-usdt-usdt-1m-2026-09-01-2026-11-01.json';
  const rows = JSON.parse(fs.readFileSync(oldPath));
  const start = Number(rows.at(-1)[0]) + 60_000;
  const server = await get('time', {});
  const end = Math.floor(Number(server.serverTime) / 60_000) * 60_000;
  let cursor = start;
  let downloaded = 0;
  while (cursor < end) {
    const batch = await get('klines', { symbol: '1000BONKUSDT', interval: '1m', startTime: cursor, endTime: end - 1, limit: 1500 });
    if (!batch.length || Number(batch[0][0]) !== cursor) throw new Error('Missing candle during download');
    rows.push(...batch);
    downloaded += batch.length;
    cursor = Number(batch.at(-1)[0]) + 60_000;
  }
  const funding = [];
  cursor = Date.parse('2026-09-18T00:00:00Z');
  while (cursor < end) {
    const batch = await get('fundingRate', { symbol: '1000BONKUSDT', startTime: cursor, endTime: end - 1, limit: 1000 });
    if (!batch.length) break;
    funding.push(...batch);
    cursor = Number(batch.at(-1).fundingTime) + 1;
  }
  fs.mkdirSync('backtest-data/ma-exit-research', { recursive: true });
  fs.writeFileSync('backtest-data/ma-exit-research/bonk-1m.json', JSON.stringify(rows));
  fs.writeFileSync('backtest-data/ma-exit-research/bonk-funding.json', JSON.stringify(funding));
  console.log(JSON.stringify({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), downloaded,
    totalCandles: rows.length, fundingEvents: funding.length }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
