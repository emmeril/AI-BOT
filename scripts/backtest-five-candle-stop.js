'use strict';
const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { simulateExitMethod } = require('../src/ma-exit-research');
const { preparePureCrossHistory, selectPureCrossPrices } = require('../src/pure-cross-selection');

async function main() {
  require('dotenv').config({ path: '.env.futures', quiet: true });
  const previous = JSON.parse(fs.readFileSync('backtest-results/cross-target-rr1.json'));
  const response = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Public exchange info HTTP ${response.status}`);
  const metadata = await response.json();
  const market = metadata.symbols.find(symbol => symbol.symbol === '1000BONKUSDT');
  const tickSize = Number(market?.filters.find(filter => filter.filterType === 'PRICE_FILTER')?.tickSize);
  if (!(tickSize > 0)) throw new Error('Missing tick size');
  const tickAsOf = new Date().toISOString();
  const rows = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-1m.json'));
  const funding = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-funding.json'));
  const prepared = preparePureCrossHistory(rows, buildScalperConfig(process.env));
  const base = previous.selectedMethod;
  const structural = { ...base, stopMode: 'FIVE_CANDLE', tickSize };
  const variants = { mirror1to1: base, fiveCandles: structural,
    fiveCandlesNetRR1_5: { ...structural, minimumNetRewardRisk: 1.5 },
    fiveCandlesNetRR2: { ...structural, minimumNetRewardRisk: 2 } };
  const results = {};
  for (const [name, method] of Object.entries(variants)) {
    results[name] = {};
    for (const [period, bounds] of Object.entries(previous.periods)) {
      const result = simulateExitMethod(prepared, method, { ...bounds, funding, priceSelector: selectPureCrossPrices, recordTrades: true });
      const all = [...result.tradeDetails, ...result.openPositions];
      const stops = all.map(position => position.initialRisk / position.entry * 100).sort((a,b) => a-b);
      const summary = { ...result, medianStopPct: stops.length ? stops[Math.floor(stops.length/2)] : null,
        maximumStopPct: stops.length ? stops.at(-1) : null };
      results[name][period] = summary;
      console.log(JSON.stringify({ variant: name, period, trades: result.trades, winRate: result.winRate,
        netPnl: result.netPnl, realized: result.realizedNetPnl, openNetPnl: result.openNetPnl, medianStopPct: summary.medianStopPct }));
    }
  }
  const report = { generatedAt: new Date().toISOString(), periods: previous.periods, variants, tickSize, tickAsOf,
    tickSource: 'Binance public fapi/v1/exchangeInfo PRICE_FILTER',
    note: 'Tick size observed now and assumed for historical replay; not a historical tick-size schedule. Target policy frozen from preceding RR1 search; no new parameter search. All periods previously used, so exploratory comparison only.', results };
  const lines = ['# TP cross historis + SL ekstrem 5 candle', '',
    `Pair 1000BONKUSDT. Tick ${tickSize}, dibaca dari Binance exchangeInfo pada ${tickAsOf}. Tick saat ini diasumsikan berlaku untuk replay historis.`, '',
    `Aturan pemilihan TP sama untuk semua varian: ${JSON.stringify(base)}. Tidak ada optimasi ulang target atau entry. SL LONG = satu tick di bawah low terendah 5 candle 1m selesai, SHORT = satu tick di atas high tertinggi. Candle cross termasuk; candle entry belum dimasukkan. ATR tidak digunakan.`, '',
    'Varian rasio memeriksa potensi imbalan/risiko bersih sesudah estimasi fee dan slippage; trade dilewati jika kurang dari 1,5 atau 2. Harga TP/SL tidak digeser untuk memenuhi rasio. Ukuran posisi tetap; stop lebih dekat tidak menaikkan notional.', '',
    '| Periode | Varian | Trade tertutup | Win rate net | PnL termasuk terbuka | PnL tertutup | Posisi terbuka | Median jarak SL | DD mark-to-market |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [name, scopes] of Object.entries(results)) for (const [period, result] of Object.entries(scopes)) lines.push(
    `| ${period} | ${name} | ${result.trades} | ${(result.winRate * 100).toFixed(2)}% | ${result.netPnl.toFixed(4)} | ${result.realizedNetPnl.toFixed(4)} | ${result.openPositions.length} | ${result.medianStopPct?.toFixed(3) ?? 'N/A'}% | ${result.maxDrawdown.toFixed(4)} |`);
  lines.push('', ...Object.entries(previous.periods).map(([name,p]) => `${name}: ${new Date(p.start).toISOString()} – ${new Date(p.end).toISOString()} UTC.`), '',
    'Notional tetap normal 100 USDT/countertrend 25 USDT. Fee taker 0,05% dan slippage 0,02% per sisi; funding historis dimasukkan. PnL dalam USDT, bukan ROI wallet. Posisi tersisa dinilai pada close terakhir dengan estimasi biaya keluar. SL didahulukan bila TP dan SL tersentuh di candle sama; gap stop diisi pada open. Tidak ada timeout atau exit cross berlawanan.', '',
    'Semua periode sudah pernah dipakai dalam riset sebelumnya; bukan holdout independen. Belum memodelkan likuidasi, minimum order/precision kuantitas, delay polling, antrean, atau perbedaan trigger mark-price dan contract-price. TP cross tetap harga interpolasi sebelum pembulatan exchange; SL mengikuti tick yang diamati sekarang. Strategi live tidak diubah.', '');
  fs.writeFileSync('backtest-results/five-candle-stop.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('backtest-results/five-candle-stop.md', lines.join('\n'));
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
