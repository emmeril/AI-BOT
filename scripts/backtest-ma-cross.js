#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { buildScalperConfig } = require('../src/scalper/config');
const { simulateMaCross } = require('../src/ma-cross-backtester');
const { summarizeTrades } = require('../src/micro-scalper-strategy');

function main() {
  dotenv.config({ path: '.env.futures', quiet: true });
  const config = buildScalperConfig(process.env);
  const directory = path.resolve('backtest-data/micro-scalper');
  const historyDays = Number(process.env.MA_BACKTEST_DAYS || 30);
  const notional = Number(process.env.MA_BACKTEST_NOTIONAL || 100);
  const assumptions = { fixedNormalNotionalUSDT: notional, countertrendNotionalUSDT: notional * config.strategy.countertrendSizeMultiplier,
    feeRatePerSide: 0.0005, slippageRatePerSide: 0.0002,
    entry: 'Next 1m candle open after completed cross; same evaluator as live engine',
    timeframeConstruction: 'UTC-aligned 15m/1h/4h aggregated from complete 1m candles; incomplete buckets discarded',
    intrabar: 'SL first when SL and TP both touched; gap stops filled at candle open',
    supportResistance: 'Ranked historical MA7/25, MA7/99 and MA25/99 crosses: higher timeframes and retests first; TP third candidate, SL second',
    crossSelection: config.strategy.crossSelection,
    exits: 'Selected historical TP/SL only; no hold timeout, opposite-cross exit, or cooldown',
    endOfPeriod: 'Remaining positions valued at last close with estimated exit costs; not forcibly closed',
    excluded: ['funding', 'liquidation', 'wallet compounding', 'exchange min order / precision', '15s polling and network delay', 'MARK_PRICE versus contract-price trigger differences'],
    parameterOptimization: false };
  const loaded = config.symbols.map(symbol => {
    const prefix = symbol.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const candidates = fs.readdirSync(directory).filter(file => file.startsWith(prefix + '-1m-'))
      .map(file => ({ file, rows: JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) }));
    candidates.sort((a, b) => b.rows.length - a.rows.length);
    if (!candidates.length) throw new Error(`No cached 1m data for ${symbol}`);
    return { symbol, ...candidates[0] };
  });
  const end = Math.min(...loaded.map(item => Number(item.rows.at(-1)[0]) + 60_000));
  const start = end - historyDays * 86_400_000;
  const split = start + Math.floor(historyDays / 2) * 86_400_000;
  const all = [];
  const openPositions = [];
  const perSymbol = {};
  function metric(trades, from = start, to = end) {
    const summary = summarizeTrades(trades, from, to);
    return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key,
      typeof value === 'number' ? Number.isFinite(value) ? Number(value.toFixed(6)) : String(value) : value]));
  }
  for (const item of loaded) {
    if (Number(item.rows[0][0]) > start - 101 * 4 * 3_600_000) throw new Error('Insufficient warmup for MA99 4h');
    const result = simulateMaCross(item.rows, config, { start, end, notional });
    if (result.signals.unavailable) throw new Error(`Missing timeframe data on ${result.signals.unavailable} crosses`);
    const trades = result.trades.map(trade => ({ ...trade, symbol: item.symbol }));
    all.push(...trades);
    openPositions.push(...result.openPositions.map(position => ({ ...position, symbol: item.symbol })));
    perSymbol[item.symbol] = { dataFile: path.join(directory, item.file), candles: result.timeframeCounts,
      signals: result.signals, metrics: metric(trades) };
    console.log(`[BACKTEST] ${item.symbol}: ${trades.length} trades; net ${metric(trades).netPnl} USDT`);
  }
  const groups = {
    all: metric(all), LONG: metric(all.filter(trade => trade.side === 'LONG')),
    SHORT: metric(all.filter(trade => trade.side === 'SHORT')),
    aligned: metric(all.filter(trade => !trade.countertrend)), countertrend: metric(all.filter(trade => trade.countertrend)),
    firstHalf: metric(all.filter(trade => trade.exitTimestamp < split), start, split),
    secondHalf: metric(all.filter(trade => trade.exitTimestamp >= split), split, end),
  };
  const report = { generatedAt: new Date().toISOString(), period: { start: new Date(start).toISOString(),
    endExclusive: new Date(end).toISOString(), historyDays }, assumptions, strategies: config.strategies,
    perSymbol, groups, totalFees: all.reduce((sum, trade) => sum + trade.fees, 0), trades: all,
    openPositions, estimatedOpenNetPnl: openPositions.reduce((sum, position) => sum + position.estimatedNetPnl, 0) };
  report.totalPnlIncludingOpen = groups.all.netPnl + report.estimatedOpenNetPnl;
  const lines = ['# Backtest MA7/25/99', '', `Periode UTC: ${report.period.start} sampai ${report.period.endExclusive} (akhir eksklusif).`, '',
    `Notional tetap: ${notional} USDT per trade normal; ${assumptions.countertrendNotionalUSDT} USDT countertrend. Tidak memakai compounding atau ROI wallet.`, '',
    'Fee taker 0,05% dan slippage 0,02% per sisi. Entry pada open candle berikutnya; hanya candle selesai. SL didahulukan jika TP/SL tersentuh dalam candle yang sama.', '',
    'MA99 4h mendapat warmup lebih dari 400 jam. Parameter sama dengan konfigurasi bot, tanpa optimasi. Pembagian dua periode adalah pemeriksaan kestabilan, bukan validasi strategi yang dipilih lewat training.', '',
    'TP dan SL memakai cross historis terpilih: prioritas timeframe 4h/1h/15m/1m dan retest, minimal satu retest; TP kandidat 3, SL kandidat 2. Kandidat dihitung ulang pada harga fill; target harus menutup estimasi biaya. Entry ditahan jika kandidat belum cukup, tanpa fallback terdekat. Tidak ada timeout, exit cross berlawanan, atau cooldown. Funding, likuidasi, compounding, batas minimum/precision order, delay polling/network, dan beda trigger mark-price versus contract-price tidak dimodelkan.', '',
    '| Kelompok | Trade | Win rate | Net USDT | Profit factor | Max DD terealisasi USDT |',
    '|---|---:|---:|---:|---:|---:|'];
  for (const [label, m] of Object.entries(groups)) lines.push(`| ${label} | ${m.trades} | ${(m.winRate * 100).toFixed(2)}% | ${m.netPnl.toFixed(4)} | ${m.profitFactor} | ${m.maxDrawdown.toFixed(4)} |`);
  lines.push('', 'Drawdown dihitung dari PnL trade tertutup, bukan mark-to-market. Win rate menghitung hasil bersih setelah biaya.', '',
    `Total fee trade tertutup: ${report.totalFees.toFixed(4)} USDT.`, '',
    `Posisi tersisa: ${openPositions.length}; estimasi PnL bersih posisi terbuka ${report.estimatedOpenNetPnl.toFixed(4)} USDT; total termasuk posisi terbuka ${report.totalPnlIncludingOpen.toFixed(4)} USDT. Posisi tersisa dinilai pada close terakhir termasuk estimasi biaya keluar, bukan ditutup oleh strategi.`, '',
    '## Data', '', ...Object.entries(perSymbol).map(([symbol, item]) => `- ${symbol}: ${item.dataFile}; ${item.candles['1m']} candle 1m; cross tanpa data lengkap: ${item.signals.unavailable}.`), '');
  fs.mkdirSync('backtest-results', { recursive: true });
  fs.writeFileSync('backtest-results/ranked-cross-default-30d.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('backtest-results/ranked-cross-default-30d.md', lines.join('\n'));
  console.log(JSON.stringify(groups, null, 2));
}

if (require.main === module) main();
