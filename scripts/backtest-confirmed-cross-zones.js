#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { simulateMaCross } = require('../src/ma-cross-backtester');
const { ZONE_RULES, createZoneEvaluator } = require('../src/confirmed-cross-zones');

function main() {
  require('dotenv').config({ path: '.env.futures', quiet: true });
  const config = buildScalperConfig(process.env);
  const symbol = config.symbols[0];
  const prefix = symbol.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-1m-';
  const files = fs.readdirSync('backtest-data/micro-scalper').filter(file => file.startsWith(prefix));
  const sources = files.map(file => ({ file, rows: JSON.parse(fs.readFileSync('backtest-data/micro-scalper/' + file)) }));
  sources.sort((a, b) => b.rows.length - a.rows.length);
  if (!sources.length) throw new Error('No cached candles for ' + symbol);
  const { rows, file } = sources[0];
  const end = Number(rows.at(-1)[0]) + 60_000;
  const start = end - 30 * 86_400_000;
  const periods = { comparison30d: { start, end }, earlier13d: { start: start - 13 * 86_400_000, end: start } };
  const variants = { original: null, zonesUnconfirmed: { confirmed: false },
    zonesConfirmed: { confirmed: true }, zonesConfirmedCosts: { confirmed: true, costFilter: true } };
  const results = {};
  for (const [periodName, period] of Object.entries(periods)) {
    if (Number(rows[0][0]) > period.start - 101 * 4 * 3_600_000) throw new Error('Insufficient 4h warmup');
    results[periodName] = {};
    for (const [name, parameters] of Object.entries(variants)) {
      const simulation = simulateMaCross(rows, config, { ...period,
        evaluateSignal: parameters ? createZoneEvaluator(parameters) : undefined });
      if (simulation.signals.unavailable) throw new Error('Unavailable higher timeframe data');
      const openNet = simulation.openPositions.reduce((sum, position) => sum + position.estimatedNetPnl, 0);
      const wins = simulation.trades.filter(trade => trade.netPnl > 0);
      const losses = simulation.trades.filter(trade => trade.netPnl <= 0);
      const average = trades => trades.length ? trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length : 0;
      const result = { ...simulation, totalNetPnl: simulation.summary.netPnl + openNet,
        estimatedOpenNetPnl: openNet, tpNetLosses: simulation.trades.filter(trade => trade.reason === 'TAKE_PROFIT' && trade.netPnl <= 0).length,
        averageNetWin: average(wins), averageNetLoss: average(losses),
        fees: simulation.trades.reduce((sum, trade) => sum + trade.fees, 0) };
      results[periodName][name] = result;
      console.log(JSON.stringify({ period: periodName, variant: name, trades: result.summary.trades,
        winRate: result.summary.winRate, net: result.totalNetPnl, open: result.openPositions.length }));
    }
  }
  const report = { generatedAt: new Date().toISOString(), symbol, dataFile: file, periods, variants,
    zoneRules: ZONE_RULES, normalNotional: 100, countertrendNotional: 100 * config.strategy.countertrendSizeMultiplier,
    feeRatePerSide: 0.0005, slippageRatePerSide: 0.0002, results };
  const lines = ['# Uji zona cross historis', '', `Pair: ${symbol}. Data: ${file}.`, '',
    'Eksperimen terpisah; konfigurasi trading aktif tidak diubah. Parameter ditetapkan sebelum melihat hasil; tidak ada pencarian parameter terbaik.', '',
    'Entry cross MA7/MA25 1m, konteks MA99 1m/15m/1h/4h, notional normal 100 USDT dan countertrend 25 USDT. Fee 0,05% dan slippage 0,02% per sisi. Tidak ada timeout, exit cross berlawanan, atau cooldown.', '',
    'Zona: kelompok cross dengan rentang maksimum 0,2 ATR(14), ditambah lebar 0,1 ATR tiap sisi. Retest harus terjadi setelah cross terbaru pembentuk zona, dari luar zona dan close kembali di sisi asal. Minimal satu retest. Close menembus zona membatalkan konfirmasi sisi tersebut; reclaim lalu retest dapat mengonfirmasi ulang.', '',
    'SL di luar zona 15m ditambah buffer 0,05 ATR. TP sebelum zona lawan 15m; zona 1h/4h yang lebih dekat menjadi penghalang target. Tidak melompati penghalang dekat demi target lebih jauh. Hanya candle selesai sebelum entry dipakai. ATR dihitung dari candle yang sudah tersedia saat entry.', '',
    'Varian tanpa konfirmasi menguji kontribusi pengelompokan zona. Varian konfirmasi+biaya melewati trade jika target bersih estimasi tidak positif, dan mengecek lagi setelah slippage entry.', '',
    '| Periode UTC | Varian | Trade tertutup | Win rate net | PnL tertutup | PnL termasuk posisi terbuka | PF tertutup | DD tertutup | Posisi terbuka |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [periodName, variantsResult] of Object.entries(results)) {
    const period = periods[periodName];
    for (const [name, result] of Object.entries(variantsResult)) {
      const s = result.summary;
      lines.push(`| ${new Date(period.start).toISOString()} – ${new Date(period.end).toISOString()} | ${name} | ${s.trades} | ${(100 * s.winRate).toFixed(2)}% | ${s.netPnl.toFixed(4)} | ${result.totalNetPnl.toFixed(4)} | ${Number(s.profitFactor).toFixed(3)} | ${s.maxDrawdown.toFixed(4)} | ${result.openPositions.length} |`);
    }
  }
  const tested = results.comparison30d.zonesConfirmedCosts;
  lines.push('', `Pada varian konfirmasi+biaya 30 hari, rata-rata trade menang ${tested.averageNetWin.toFixed(4)} USDT dan trade kalah ${tested.averageNetLoss.toFixed(4)} USDT. TP yang tetap rugi setelah biaya: ${tested.tpNetLosses}.`);
  lines.push('', 'PnL dalam USDT, bukan return wallet. Posisi tersisa dinilai pada close terakhir dengan estimasi biaya keluar, tanpa dipaksa tutup. DD/PF hanya trade tertutup, bukan mark-to-market.', '',
    'Periode 13 hari adalah pembanding kronologis sebelumnya dengan posisi awal kosong; bukan klaim validasi out-of-sample formal. Tidak memakai candle masa depan. Funding, likuidasi, precision/minimum order, polling delay dan perbedaan mark-price/contract-price belum dimodelkan. SL didahulukan jika TP/SL tersentuh pada candle sama. Zona lebih lebar dapat membuat SL melampaui jarak likuidasi pada leverage tinggi; hasil ini bukan simulasi akun berleverage.', '');
  fs.mkdirSync('backtest-results', { recursive: true });
  fs.writeFileSync('backtest-results/confirmed-cross-zones.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('backtest-results/confirmed-cross-zones.md', lines.join('\n'));
}

if (require.main === module) main();
