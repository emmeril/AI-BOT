'use strict';
const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { prepareExitResearch, simulateExitMethod } = require('../src/ma-exit-research');

function main() {
  require('dotenv').config({ path: '.env.futures', quiet: true });
  const config = buildScalperConfig(process.env);
  const rows = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-1m.json'));
  const funding = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-funding.json'));
  const periods = {
    previous13d: { start: Date.parse('2026-09-19T02:35:00Z'), end: Date.parse('2026-10-02T02:35:00Z') },
    comparison30d: { start: Date.parse('2026-10-02T02:35:00Z'), end: Date.parse('2026-11-01T02:35:00Z') },
    november: { start: Date.parse('2026-11-01T02:35:00Z'), end: Number(rows.at(-1)[0]) + 60_000 },
  };
  const variants = {
    only7_25: { supportCrossPairs: [[7, 25]] },
    crosses7_25_99: {},
    crossesAndMa99Line: { includeMa99Line: true },
  };
  const results = {};
  for (const [name, settings] of Object.entries(variants)) {
    const variantConfig = { ...config, strategies: Object.fromEntries(Object.entries(config.strategies)
      .map(([side, strategy]) => [side, { ...strategy, ...settings }])) };
    const prepared = prepareExitResearch(rows, variantConfig);
    results[name] = {};
    for (const [periodName, period] of Object.entries(periods)) {
      const result = simulateExitMethod(prepared, { family: 'original' }, { ...period, funding, recordTrades: true });
      results[name][periodName] = result;
      console.log(JSON.stringify({ variant: name, period: periodName, trades: result.trades,
        winRate: result.winRate, net: result.netPnl, open: result.openPositions.length }));
    }
  }
  const report = { generatedAt: new Date().toISOString(), symbol: '1000BONKUSDT', periods, variants, results,
    assumptions: { feeRatePerSide: 0.0005, slippageRatePerSide: 0.0002, normalNotional: 100, countertrendNotional: 25,
      fundingIncluded: true, entry: 'MA7/MA25 1m cross unchanged; MA99 remains trend context',
      sourceCorrection: 'Cross source now includes 7/25, 7/99 and 25/99; separate optional MA99-line interpretation',
      exit: 'Nearest historical bracketing TP/SL only; no timeout or opposite-cross exit',
      excluded: ['liquidation', 'precision/minimum order', 'polling delay', 'mark/contract trigger differences'] } };
  const lines = ['# Koreksi level support/resisten MA99', '',
    'Pair 1000BONKUSDT. Perbandingan sumber level, tanpa optimasi parameter. Entry tetap cross MA7/MA25 1m; konteks 15m/1h/4h, countertrend tetap boleh. MA99 menambah sumber level exit, bukan pemicu entry baru.', '',
    'only7_25: sumber lama, cross MA7/MA25 saja. crosses7_25_99: menambah cross MA7/MA99 dan MA25/MA99. crossesAndMa99Line: eksperimen tambahan memakai ketiga cross serta nilai garis MA99 terakhir dari candle selesai. Default strategi yang dikoreksi memakai ketiga cross historis; garis MA99 dinamis diuji terpisah.', '',
    '| Periode | Varian | Trade tertutup | Win rate bersih | PnL termasuk posisi terbuka USDT | Posisi terbuka |',
    '|---|---|---:|---:|---:|---:|'];
  for (const [name, scopes] of Object.entries(results)) for (const [periodName, result] of Object.entries(scopes)) {
    lines.push(`| ${periodName} | ${name} | ${result.trades} | ${(100 * result.winRate).toFixed(2)}% | ${result.netPnl.toFixed(4)} | ${result.openPositions.length} |`);
  }
  lines.push('', ...Object.entries(periods).map(([name, period]) => `${name}: ${new Date(period.start).toISOString()} sampai ${new Date(period.end).toISOString()} UTC (akhir eksklusif).`), '',
    'Fee 0,05% dan slippage 0,02% per sisi, funding historis dimasukkan. Notional normal 100 USDT/countertrend 25 USDT. PnL bukan return wallet. Posisi tersisa dinilai pada harga terakhir termasuk estimasi biaya keluar. Candle masa depan tidak dipakai. Tidak ada timeout, cooldown, atau filter profit minimum. SL didahulukan bila TP/SL tersentuh di candle sama.', '',
    'Hasil ini mengoreksi cakupan sumber level, bukan bukti profitabilitas keseluruhan ide strategi. Riset sebelumnya yang memakai cross 7/25 saja tetap disimpan terpisah; hasilnya tidak mewakili koreksi MA99 ini. Belum memodelkan likuidasi, precision/minimum order, delay polling, atau perbedaan mark-price/contract-price. Kode dan konfigurasi diperbaiki; bot live tidak dijalankan oleh runner.', '');
  fs.mkdirSync('backtest-results', { recursive: true });
  fs.writeFileSync('backtest-results/ma99-level-comparison.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('backtest-results/ma99-level-comparison.md', lines.join('\n'));
}

if (require.main === module) main();
