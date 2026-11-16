'use strict';
const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { simulateExitMethod } = require('../src/ma-exit-research');
const { preparePureCrossHistory, selectPureCrossPrices } = require('../src/pure-cross-selection');

require('dotenv').config({ path: '.env.futures', quiet: true });
const report = JSON.parse(fs.readFileSync('backtest-results/pure-cross-selection.json'));
const rows = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-1m.json'));
const funding = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-funding.json'));
const prepared = preparePureCrossHistory(rows, buildScalperConfig(process.env));
const results = [];
for (const item of report.survivors.filter(item => item.passed)) for (const maximumStopDistance of [0.01, 0.02, 0.03]) {
  const method = { ...item.method, maximumStopDistance };
  const evaluation = {};
  for (const [name, period] of Object.entries(report.periods)) evaluation[name] = simulateExitMethod(prepared, method,
    { ...period, funding, priceSelector: selectPureCrossPrices });
  results.push({ method, evaluation, passed: Object.values(evaluation).every(result => result.netPnl > 0) });
}
fs.writeFileSync('backtest-results/pure-cross-stop-distance-audit.json', JSON.stringify({ results,
  explanation: 'Distance limits only reject too-distant historical crosses; all TP/SL prices remain exact past cross prices. No percentage stop is fabricated. These bounds do not model or guarantee avoidance of liquidation.' }, null, 2));
const lines = ['# Audit jarak SL kandidat murni cross', '',
  'Batas jarak 1/2/3% hanya menyaring kandidat cross terlalu jauh; harga SL tetap harga cross historis, bukan entry dikurangi persentase. Filter ini eksperimen risiko, belum diterapkan ke live dan bukan simulasi margin/likuidasi.', '',
  '| Kandidat | Batas jarak SL | PnL seleksi | PnL 30 hari | PnL November | Positif ketiganya |',
  '|---|---:|---:|---:|---:|---|'];
for (const item of results) lines.push(`| ${item.method.id} | ${100 * item.method.maximumStopDistance}% | ${item.evaluation.selection13d.netPnl.toFixed(4)} | ${item.evaluation.comparison30d.netPnl.toFixed(4)} | ${item.evaluation.november.netPnl.toFixed(4)} | ${item.passed ? 'Ya' : 'Tidak'} |`);
lines.push('', 'Fee, slippage, funding dan penilaian posisi terbuka sama dengan laporan utama. Seluruh periode dipakai ulang; audit bersifat eksploratif.', '');
fs.writeFileSync('backtest-results/pure-cross-stop-distance-audit.md', lines.join('\n'));
console.log(JSON.stringify(results.map(item => ({ method: item.method.id, maxStopDistance: item.method.maximumStopDistance,
  train: item.evaluation.selection13d.netPnl, comparison: item.evaluation.comparison30d.netPnl, november: item.evaluation.november.netPnl, passed: item.passed }))));
