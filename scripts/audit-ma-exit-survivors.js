'use strict';
const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { prepareExitResearch, simulateExitMethod } = require('../src/ma-exit-research');

require('dotenv').config({ path: '.env.futures', quiet: true });
const primary = JSON.parse(fs.readFileSync('backtest-results/ma-exit-research.json'));
const management = JSON.parse(fs.readFileSync('backtest-results/ma-exit-management.json'));
const candidates = new Map();
for (const entry of [...primary.selection.map(item => ({ method: item.method, train: item.result })), ...management.selection]) {
  if (entry.train.netPnl > 0 && entry.train.trades >= 30) candidates.set(JSON.stringify(entry.method), entry);
}
const prepared = prepareExitResearch(JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-1m.json')), buildScalperConfig(process.env));
const funding = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-funding.json'));
const results = [];
for (const entry of candidates.values()) {
  const validation = simulateExitMethod(prepared, entry.method, { ...primary.periods.validation30d, funding });
  const newer = simulateExitMethod(prepared, entry.method, { ...primary.periods.newerData, funding });
  results.push({ method: entry.method, train: entry.train, validation, newer,
    passed: validation.netPnl > 0 && newer.netPnl > 0 && validation.trades >= 30 && newer.trades >= 15 });
}
results.sort((a, b) => Math.min(b.validation.netPnl, b.newer.netPnl) - Math.min(a.validation.netPnl, a.newer.netPnl));
const report = { generatedAt: new Date().toISOString(), tested: results.length,
  passed: results.filter(item => item.passed).length,
  note: 'Exploratory audit of every profitable training candidate; validation and newer periods are reused. No fresh independent holdout remains.', results };
fs.writeFileSync('backtest-results/ma-exit-survivor-audit.json', JSON.stringify(report, null, 2));
const lines = ['# Audit semua kandidat TP/SL yang profit pada seleksi', '',
  `Dari 235 kombinasi awal dan 129 varian lanjutan, ${results.length} kandidat unik profit pada seleksi dengan minimal 30 trade. Semuanya diuji pada kedua periode berikutnya. Lulus keduanya dengan jumlah trade memadai: ${report.passed}.`, '',
  'Audit ini eksploratif setelah periode pembanding terlihat; bukan validasi independen baru. Tidak menambah kandidat atau mengubah entry. PnL sudah termasuk funding dan estimasi posisi terbuka.', '',
  '| Metode | Train 13 hari | Validasi 30 hari | Data 1–16 Nov | Lulus |', '|---|---:|---:|---:|---|'];
for (const item of results) lines.push(`| ${item.method.id} | ${item.train.netPnl.toFixed(4)} | ${item.validation.netPnl.toFixed(4)} | ${item.newer.netPnl.toFixed(4)} | ${item.passed ? 'Ya' : 'Tidak'} |`);
lines.push('', 'Satuan USDT pada notional normal 100 USDT dan countertrend 25 USDT. Batas simulasi mengikuti laporan pencarian TP/SL; tidak memodelkan likuidasi akun. Konfigurasi live tidak diubah.', '');
fs.writeFileSync('backtest-results/ma-exit-survivor-audit.md', lines.join('\n'));
console.log(JSON.stringify({ tested: report.tested, passed: report.passed, bestByWorstPeriod: results.slice(0,3).map(item =>
  ({ method: item.method.id, train: item.train.netPnl, validation: item.validation.netPnl, newer: item.newer.netPnl })) }));
