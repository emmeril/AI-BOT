#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { prepareExitResearch, candidateMethods, simulateExitMethod } = require('../src/ma-exit-research');

function main() {
  require('dotenv').config({ path: '.env.futures', quiet: true });
  const config = buildScalperConfig(process.env);
  const rows = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-1m.json'));
  const funding = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-funding.json'));
  const periods = {
    selection13d: { start: Date.parse('2026-09-19T02:35:00Z'), end: Date.parse('2026-10-02T02:35:00Z') },
    validation30d: { start: Date.parse('2026-10-02T02:35:00Z'), end: Date.parse('2026-11-01T02:35:00Z') },
    newerData: { start: Date.parse('2026-11-01T02:35:00Z'), end: Number(rows.at(-1)[0]) + 60_000 },
  };
  console.log('[PREPARE] Features from closed candles only');
  const prepared = prepareExitResearch(rows, config);
  const methods = candidateMethods();
  const selection = [];
  for (const method of methods) {
    const result = simulateExitMethod(prepared, method, { ...periods.selection13d, funding });
    const score = result.trades >= 30 ? result.netPnl - 0.5 * result.maxDrawdown : -Infinity;
    selection.push({ method, score, result });
    if (selection.length % 40 === 0) console.log(`[SEARCH] ${selection.length}/${methods.length}`);
  }
  selection.sort((a, b) => b.score - a.score);
  const familyWinners = {};
  for (const entry of selection) familyWinners[entry.method.family] ??= entry;
  const selected = selection.find(entry => entry.method.family !== 'original' && Number.isFinite(entry.score));
  if (!selected) throw new Error('No candidate with at least 30 closed selection trades');
  fs.mkdirSync('backtest-results', { recursive: true });
  const frozen = { frozenAt: new Date().toISOString(), selectionPeriod: periods.selection13d,
    supportCrossPairs: [[7, 25], [7, 99], [25, 99]],
    criterion: 'net PnL including open positions minus 0.5 times mark-to-market drawdown; minimum 30 closed trades',
    candidateCount: methods.length, selectedMethod: selected.method,
    familyWinners: Object.fromEntries(Object.entries(familyWinners).map(([family, entry]) => [family, entry.method])) };
  fs.writeFileSync('backtest-results/ma-exit-research-frozen.json', JSON.stringify(frozen, null, 2));
  console.log('[FROZEN] ' + JSON.stringify(selected.method));
  const evaluation = {};
  for (const [family, entry] of Object.entries(familyWinners)) {
    evaluation[family] = { method: entry.method, selection13d: entry.result };
    for (const name of ['validation30d', 'newerData']) {
      evaluation[family][name] = simulateExitMethod(prepared, entry.method, { ...periods[name], funding, recordTrades: true });
    }
    console.log(JSON.stringify({ family, method: entry.method.id, train: entry.result.netPnl,
      validation: evaluation[family].validation30d.netPnl, newer: evaluation[family].newerData.netPnl }));
  }
  const stress = {};
  for (const name of ['validation30d', 'newerData']) {
    stress[name] = simulateExitMethod(prepared, selected.method, { ...periods[name], funding, slippageRate: 0.0004 });
  }
  const winner = evaluation[selected.method.family];
  const passed = selected.result.netPnl > 0 && winner.validation30d.netPnl > 0 && winner.newerData.netPnl > 0 &&
    winner.validation30d.trades >= 30 && winner.newerData.trades >= 15 &&
    stress.validation30d.netPnl > 0 && stress.newerData.netPnl > 0;
  const report = { generatedAt: new Date().toISOString(), frozen, periods, evaluation, stress, passed,
    configuration: { symbol: '1000BONKUSDT', normalNotional: 100, countertrendNotional: 25,
      supportCrossPairs: [[7, 25], [7, 99], [25, 99]],
      feeRatePerSide: 0.0005, slippageRatePerSide: 0.0002, stressSlippagePerSide: 0.0004,
      stopBoundsExceptOriginal: '0.15% minimum, 1.8% maximum; fixed candidates explicitly enumerated',
      riskReward: 'ATR/swing/cross/zones reward ratios calculated after estimated fees and exit slippage',
      fundingEvents: funding.length }, selection };
  const lines = ['# Pencarian metode TP/SL MA7/25/99', '',
    `Kandidat: ${methods.length}. Pair: 1000BONKUSDT. Notional normal 100 USDT, countertrend 25 USDT. Konfigurasi live tidak berubah.`, '',
    'Entry sama: cross MA7/MA25 1m selesai, konteks MA99 1m/15m/1h/4h, satu posisi per sisi. Sumber support/resisten sudah dikoreksi menjadi cross MA7/25, MA7/99, dan MA25/99. Tidak ada timeout, exit cross berlawanan, cooldown, averaging, atau rescue. Metode stop/target dapat menahan entry bila level tidak valid atau jarak stop melebihi 1,8%.', '',
    'Seleksi hanya pada 13 hari awal: skor = total PnL termasuk posisi terbuka − 0,5 × drawdown mark-to-market; minimal 30 trade tertutup. Pemenang global dan per keluarga dibekukan sebelum pengujian periode berikutnya. Periode pembanding dan data setelah 1 November telah dipakai dalam riset sebelumnya; pengujian setelah koreksi MA99 bukan holdout baru. Hasil sebelum koreksi diarsipkan di pre-ma99-correction.', '',
    `Pilihan seleksi: ${JSON.stringify(selected.method)}. Lulus pemeriksaan seluruh periode dan biaya lebih tinggi: ${passed ? 'YA' : 'TIDAK'}.`, '',
    '| Keluarga | Metode terpilih dari train | PnL train 13 hari | PnL validasi 30 hari | PnL data terbaru | Trade validasi / terbaru |',
    '|---|---|---:|---:|---:|---:|'];
  for (const [family, item] of Object.entries(evaluation)) lines.push(`| ${family} | ${item.method.id} | ${item.selection13d.netPnl.toFixed(4)} | ${item.validation30d.netPnl.toFixed(4)} | ${item.newerData.netPnl.toFixed(4)} | ${item.validation30d.trades} / ${item.newerData.trades} |`);
  lines.push('', '## Periode UTC', '', ...Object.entries(periods).map(([name, period]) => `- ${name}: ${new Date(period.start).toISOString()} sampai ${new Date(period.end).toISOString()} (akhir eksklusif).`), '',
    '## Asumsi dan batas', '',
    'Fee 0,05% dan slippage 0,02% per sisi; stress slippage 0,04% per sisi. Funding historis Binance dijadwalkan pada menit event dan dibebankan hanya ke posisi yang sudah masuk sebelum menit tersebut. PnL menyertakan posisi tersisa pada close terakhir dan estimasi biaya keluar; tidak ditutup paksa. Drawdown dihitung dari equity mark-to-market setiap menit. SL didahulukan jika TP dan SL tersentuh dalam candle sama. Stop gap diisi pada open candle.', '',
    'Fixed: jarak TP/SL persentase. ATR: stop dari ATR 1m/15m, TP kelipatan risiko bersih. Swing: stop di luar ekstrem 5/10/20/50 candle 1m ditambah buffer ATR. Cross/zones: stop level cross atau zona terkonfirmasi, TP level lawan atau kelipatan risiko bersih. Metode ATR/swing/cross/zones memakai minimum stop 0,15% dan maksimum 1,8%.', '',
    'PnL bukan ROI wallet. Tidak ada compounding, margin/liquidation engine, order-book queue, tick rounding, minimum notional, delay polling, atau beda trigger mark-price versus contract-price. Cap jarak stop bukan jaminan terhadap likuidasi. Banyak kandidat meningkatkan risiko overfitting; hasil seleksi positif saja tidak cukup.', '',
    `Stress pilihan seleksi: validasi ${stress.validation30d.netPnl.toFixed(4)} USDT; data terbaru ${stress.newerData.netPnl.toFixed(4)} USDT.`, '');
  fs.writeFileSync('backtest-results/ma-exit-research.json', JSON.stringify(report, (_key, value) =>
    typeof value === 'number' && !Number.isFinite(value) ? String(value) : value, 2));
  fs.writeFileSync('backtest-results/ma-exit-research.md', lines.join('\n'));
  console.log('[RESULT] ' + JSON.stringify({ selected: selected.method, passed,
    validation: winner.validation30d.netPnl, newer: winner.newerData.netPnl,
    stress: { validation: stress.validation30d.netPnl, newer: stress.newerData.netPnl } }));
}

if (require.main === module) main();
