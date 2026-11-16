'use strict';
const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { prepareExitResearch, simulateExitMethod } = require('../src/ma-exit-research');

function main() {
  require('dotenv').config({ path: '.env.futures', quiet: true });
  const original = JSON.parse(fs.readFileSync('backtest-results/ma-exit-research.json'));
  const prepared = prepareExitResearch(JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-1m.json')), buildScalperConfig(process.env));
  const funding = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-funding.json'));
  const candidates = [];
  for (const item of Object.values(original.evaluation).filter(item => item.method.family !== 'original')) {
    const base = item.method;
    candidates.push(base);
    for (const breakevenR of [0.5, 1, 1.5]) candidates.push({ ...base, id: `${base.id}-be-${breakevenR}`, management: { breakevenR } });
    for (const armR of [0.5, 1, 2]) for (const trailR of [0.5, 1, 1.5]) {
      candidates.push({ ...base, id: `${base.id}-trail-${armR}-${trailR}`, management: { armR, trailR } });
    }
    if (['atr', 'swing', 'cross', 'zones'].includes(base.family)) {
      for (const reward of [1, 1.5, 2, 3]) for (const countertrendReward of [0.5, 0.75, 1, 1.5]) {
        candidates.push({ ...base, reward, countertrendReward, id: `${base.id}-reward-${reward}-counter-${countertrendReward}` });
      }
    }
  }
  const search = candidates.map(method => {
    const train = simulateExitMethod(prepared, method, { ...original.periods.selection13d, funding });
    return { method, train, score: train.trades >= 30 ? train.netPnl - train.maxDrawdown * 0.5 : -Infinity };
  }).sort((a, b) => b.score - a.score);
  const selected = search[0];
  const frozen = { frozenAt: new Date().toISOString(), candidateCount: candidates.length, selected: selected.method,
    note: 'Second-stage research after earlier validation was seen; data reused, not pristine holdout. Selection uses initial 13 days only.' };
  fs.writeFileSync('backtest-results/ma-exit-management-frozen.json', JSON.stringify(frozen, null, 2));
  const tests = {};
  for (const name of ['validation30d', 'newerData']) {
    tests[name] = simulateExitMethod(prepared, selected.method, { ...original.periods[name], funding, recordTrades: true });
  }
  const report = { frozen, selection: search, tests, passed: selected.train.netPnl > 0 && tests.validation30d.netPnl > 0 && tests.newerData.netPnl > 0 };
  fs.writeFileSync('backtest-results/ma-exit-management.json', JSON.stringify(report, (_key, value) =>
    typeof value === 'number' && !Number.isFinite(value) ? String(value) : value, 2));
  const lines = ['# Uji lanjutan pengelolaan TP/SL', '',
    `Kandidat lanjutan: ${candidates.length}. Pilihan hanya berdasarkan 13 hari awal. Tahap ini dilakukan setelah hasil tahap pertama terlihat; periode pembanding dipakai ulang, bukan holdout baru.`, '',
    `Metode terpilih: ${JSON.stringify(selected.method)}.`, '',
    '| Periode | PnL termasuk posisi terbuka | Trade | Win rate | DD mark-to-market |',
    '|---|---:|---:|---:|---:|'];
  for (const [name, result] of Object.entries({ selection13d: selected.train, ...tests })) {
    lines.push(`| ${name} | ${result.netPnl.toFixed(4)} | ${result.trades} | ${(100 * result.winRate).toFixed(2)}% | ${result.maxDrawdown.toFixed(4)} |`);
  }
  lines.push('', 'Entry MA tidak berubah. Metode break-even/trailing menggunakan high/low candle selesai dan mengubah SL mulai candle berikutnya. SL tidak dilonggarkan. Break-even memperhitungkan estimasi fee, slippage keluar, dan funding yang sudah dibayar. Gap dapat tetap menghasilkan rugi.', '',
    'Funding historis dijadwalkan pada menit event; hanya posisi yang sudah masuk sebelum menit tersebut dikenakan funding. Notional normal 100 USDT, countertrend 25 USDT, fee 0,05% dan slippage 0,02% per sisi. Posisi terbuka dinilai pada close terakhir setelah estimasi biaya keluar. Tidak ada timeout. Batas simulasi sama dengan laporan pencarian awal; belum memodelkan likuidasi, precision/minimum order, atau delay eksekusi. Konfigurasi live tidak diubah.', '');
  fs.writeFileSync('backtest-results/ma-exit-management.md', lines.join('\n'));
  console.log(JSON.stringify({ candidates: candidates.length, selected: selected.method, train: selected.train.netPnl,
    validation: tests.validation30d.netPnl, newer: tests.newerData.netPnl, passed: report.passed }));
}

main();
