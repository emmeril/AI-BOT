'use strict';
const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { simulateExitMethod } = require('../src/ma-exit-research');
const { preparePureCrossHistory, pureCrossCandidates, mirrorTargetCandidates, selectPureCrossPrices } = require('../src/pure-cross-selection');

function main() {
  require('dotenv').config({ path: '.env.futures', quiet: true });
  const config = buildScalperConfig(process.env);
  const mirror = (process.env.PURE_CROSS_STOP_MODE || config.strategy.stopMode) === 'MIRROR_TARGET';
  const output = mirror ? 'cross-target-rr1' : 'pure-cross-selection';
  const rows = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-1m.json'));
  const funding = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-funding.json'));
  const periods = {
    selection13d: { start: Date.parse('2026-09-19T02:35:00Z'), end: Date.parse('2026-10-02T02:35:00Z') },
    comparison30d: { start: Date.parse('2026-10-02T02:35:00Z'), end: Date.parse('2026-11-01T02:35:00Z') },
    november: { start: Date.parse('2026-11-01T02:35:00Z'), end: Number(rows.at(-1)[0]) + 60_000 },
  };
  console.log('[PREPARE] Cross levels and completed retests; no ATR features');
  const prepared = preparePureCrossHistory(rows, config);
  const methods = mirror ? mirrorTargetCandidates() : pureCrossCandidates();
  const options = { funding, priceSelector: selectPureCrossPrices };
  const selection = [];
  for (const method of methods) {
    const result = simulateExitMethod(prepared, method, { ...periods.selection13d, ...options });
    const score = result.trades >= 30 ? result.netPnl - 0.5 * result.maxDrawdown : -Infinity;
    selection.push({ method, result, score });
    if (selection.length % 100 === 0) console.log(`[SEARCH] ${selection.length}/${methods.length}`);
  }
  selection.sort((a, b) => b.score - a.score);
  const selected = selection.find(item => Number.isFinite(item.score));
  if (!selected) throw new Error('No candidate with sufficient trade count');
  fs.mkdirSync('backtest-results', { recursive: true });
  fs.writeFileSync(`backtest-results/${output}-frozen.json`, JSON.stringify({ frozenAt: new Date().toISOString(), method: selected.method,
    selectionPeriod: periods.selection13d, criterion: 'PnL incl open minus 0.5 MTM drawdown; min 30 closed trades' }, null, 2));
  const evaluate = (method, name, recordTrades = false) => simulateExitMethod(prepared, method, { ...periods[name], ...options, recordTrades });
  const selectedResults = { selection13d: selected.result, comparison30d: evaluate(selected.method, 'comparison30d', true), november: evaluate(selected.method, 'november', true) };
  const survivors = [];
  for (const item of selection.filter(item => item.result.netPnl > 0 && item.result.trades >= 30)) {
    const comparison = evaluate(item.method, 'comparison30d');
    const november = evaluate(item.method, 'november');
    survivors.push({ method: item.method, train: item.result, comparison, november,
      passed: comparison.netPnl > 0 && november.netPnl > 0 && comparison.trades >= 30 && november.trades >= 15 });
  }
  const baseline = {};
  for (const [name, period] of Object.entries(periods)) baseline[name] = simulateExitMethod(prepared, { family: 'original' }, { ...period, funding });
  const report = { generatedAt: new Date().toISOString(), periods, candidateCount: methods.length, selectedMethod: selected.method,
    selectedResults, selection, survivors, passedCount: survivors.filter(item => item.passed).length, baseline };
  fs.writeFileSync(`backtest-results/${output}.json`, JSON.stringify(report, (_key, value) =>
    typeof value === 'number' && !Number.isFinite(value) ? String(value) : value, 2));
  const lines = ['# Pemilihan TP/SL murni harga cross historis', '',
    `Pair 1000BONKUSDT. ${methods.length} aturan pemilihan TP dari cross historis MA7/25, MA7/99, atau MA25/99 diuji. ${mirror ? 'SL = 2 × harga fill entry − TP; jarak harga TP/SL sama (1:1), SL tidak wajib titik cross.' : 'SL juga dipilih dari cross historis.'} ATR, buffer, target persentase, trailing, dan timeout tidak digunakan.`, '',
    `Sumber kandidat mencakup 1m, 15m, 1h, dan 4h. Prioritas: gabungan, 15m dahulu, atau timeframe besar dahulu. Urutan: jarak, kebaruan, atau jumlah retest. Retest: 0/1/2 minimum; urutan target 1/2/3/5. ${mirror ? 'Tidak ada pemilihan cross untuk SL.' : 'Urutan cross stop 1/2/3.'} Varian biaya melewati target yang estimasi hasil bersihnya tidak positif; harga target tidak digeser.`, '',
    'Retest harus terjadi setelah candle cross: harga menyentuh titik tersebut dari satu sisi dan close kembali di sisi asal. Close menembus titik membatalkan hitungan retest sisi tersebut. Tidak ada data masa depan. Pemilihan level dilakukan ulang pada harga fill yang sudah memasukkan slippage.', '',
    'Seleksi memakai 13 hari awal, skor PnL termasuk posisi terbuka minus 0,5 drawdown mark-to-market, minimal 30 trade tertutup. Kandidat dibekukan sebelum pemeriksaan dua periode berikutnya. Seluruh data sudah pernah digunakan dalam eksperimen lain: ini pencarian eksploratif, bukan holdout baru.', '',
    `Pilihan periode awal: ${JSON.stringify(selected.method)}. Kandidat profit pada periode awal dengan trade memadai: ${survivors.length}; yang tetap profit di kedua periode berikutnya dengan trade memadai: ${report.passedCount}.`, '',
    '| Periode | Metode | Trade tertutup | Win rate bersih | PnL termasuk terbuka | DD mark-to-market |',
    '|---|---|---:|---:|---:|---:|'];
  for (const name of Object.keys(periods)) for (const [label, result] of [['baseline', baseline[name]], ['selected', selectedResults[name]]]) {
    lines.push(`| ${name} | ${label} | ${result.trades} | ${(result.winRate * 100).toFixed(2)}% | ${result.netPnl.toFixed(4)} | ${result.maxDrawdown.toFixed(4)} |`);
  }
  lines.push('', ...Object.entries(periods).map(([name, p]) => `${name}: ${new Date(p.start).toISOString()} – ${new Date(p.end).toISOString()} UTC.`), '',
    'Notional normal 100 USDT, countertrend 25 USDT. Fee 0,05% dan slippage 0,02% per sisi; funding historis dimasukkan. PnL dalam USDT, bukan ROI wallet. Posisi belum tertutup dinilai pada close terakhir dan estimasi biaya keluar. SL didahulukan jika TP dan SL tersentuh dalam candle sama. Baseline memakai aturan lama, TP dan SL masing-masing cross terdekat. Jarak harga 1:1 bukan probabilitas menang 50% dan bukan rasio hasil bersih 1:1 sesudah biaya. Memilih cross bukan jaminan harga akan sampai.', '',
    'Tidak memodelkan likuidasi, precision/minimum order, antrean orderbook, delay polling, atau perbedaan trigger mark-price. Stop yang jauh dapat melewati jarak likuidasi akun berleverage. Konfigurasi live tidak diubah oleh riset ini.', '');
  fs.writeFileSync(`backtest-results/${output}.md`, lines.join('\n'));
  console.log(JSON.stringify({ candidates: methods.length, selected: selected.method, train: selected.result.netPnl,
    comparison: selectedResults.comparison30d.netPnl, november: selectedResults.november.netPnl,
    profitableTrain: survivors.length, passed: report.passedCount }));
}

if (require.main === module) main();
