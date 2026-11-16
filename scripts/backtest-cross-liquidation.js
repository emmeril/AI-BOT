'use strict';
const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { preparePureCrossHistory, selectPureCrossPrices } = require('../src/pure-cross-selection');
const { simulateExitMethod } = require('../src/ma-exit-research');
const { simulateIsolatedMargin } = require('../src/isolated-margin-backtester');

function main() {
  require('dotenv').config({ path: '.env.futures', quiet: true });
  const config = buildScalperConfig(process.env);
  if (String(process.env.MARGIN_MODE).toUpperCase() !== 'ISOLATED') throw new Error('This replay implements isolated margin only');
  const leverage = config.leverage;
  if (leverage !== 5) throw new Error('This requested run requires LEVERAGE=5');
  const reference = JSON.parse(fs.readFileSync('backtest-results/pure-cross-selection.json'));
  const rows = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-1m.json'));
  const funding = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-funding.json'));
  const markRows = JSON.parse(fs.readFileSync('backtest-data/liquidation/1000bonk-mark-1m.json'));
  const tierSnapshot = JSON.parse(fs.readFileSync('backtest-data/liquidation/1000bonk-brackets.json'));
  const market = JSON.parse(fs.readFileSync('backtest-data/liquidation/1000bonk-market-metadata.json'));
  const brackets = tierSnapshot.data.find(item => item.symbol === '1000BONKUSDT').brackets;
  const method = config.strategies.LONG.crossSelection;
  const prepared = preparePureCrossHistory(rows, config);
  const options = { leverage, brackets, liquidationFeeRate: market.liquidationFee,
    priceSelector: selectPureCrossPrices, funding, initialWallet: 100, normalNotional: 100 };
  const results = {};
  for (const [period, bounds] of Object.entries(reference.periods)) {
    const original = simulateExitMethod(prepared, method, { ...bounds, funding, priceSelector: selectPureCrossPrices, recordTrades: true });
    const markOnly = simulateIsolatedMargin(prepared, markRows, method, { ...options, ...bounds, enableLiquidation: false });
    const liquidation = simulateIsolatedMargin(prepared, markRows, method, { ...options, ...bounds });
    const stress = simulateIsolatedMargin(prepared, markRows, method, { ...options, ...bounds, slippageRate: 0.0004 });
    const allocation = simulateIsolatedMargin(prepared, markRows, method, { ...options, ...bounds, allocationPct: config.allocations.LONG });
    results[period] = { original, markOnly, liquidation, stress, allocation };
    console.log(JSON.stringify({ period, old: original.netPnl, markOnly: markOnly.netPnl,
      liquidationNet: liquidation.netPnl, liquidations: liquidation.liquidations, trades: liquidation.trades,
      stopsBeyondLiquidation: liquidation.stopsBeyondLiquidation,
      stress: stress.netPnl, allocation: allocation.netPnl, allocationLiquidations: allocation.liquidations }));
  }
  const report = { generatedAt: new Date().toISOString(), leverage, marginMode: 'ISOLATED', method,
    periods: reference.periods, tierSnapshot, market, results,
    assumptions: {
      maintenance: 'MM = mark notional * maintenance rate - cum; liquidation when isolated equity <= MM; root checked against its tier',
      normalized: 'Initial wallet 100 USDT, fixed normal notional 100 USDT, countertrend 25 USDT; no notional compounding',
      allocation: 'Separate scenario: initial wallet 100 USDT, per-side margin allocation 35% of realized wallet, 5x leverage, countertrend multiplier 0.25',
      funding: 'Available cash pays funding first; insufficient cash debits only that position isolated margin; receipts go to available cash',
      fees: 'Entry taker fee paid from cash. Regular exits incur taker fee. Full liquidation substitutes clearance fee for regular exit fee; clearance limited to remaining collateral; negative isolated collateral covered by insurance assumption',
      liquidation: 'Each side has its own isolated wallet; no auto top-up, partial liquidation, or rescue',
      ordering: 'Open gap liquidation checked before SL; within candle nearer adverse SL/liq barrier first; adverse event before TP when order ambiguous',
      execution: 'Triggers and equity use mark OHLC. Fill estimated using contract/mark open basis, clipped into contract candle range, then adverse slippage',
      history: 'Current authenticated leverage-bracket and public liquidation-fee snapshots assumed for historical replay; historical tier schedules unavailable',
      limitations: ['one-minute OHLC event order unknown', 'constant intraminute basis approximation', 'no live margin/ADL/partial-liquidation engine',
        'no minimum order or amount precision rounding', 'no polling or exchange latency', 'all periods already used in research'],
    } };
  fs.writeFileSync('backtest-results/cross-liquidation-5x.json', JSON.stringify(report, null, 2));
  const lines = ['# TP/SL cross terpilih dengan likuidasi 5x isolated', '',
    `Leverage ${leverage}x; mode ISOLATED; metode ${JSON.stringify(method)}. Entry dan pemilihan cross tidak dioptimasi ulang.`, '',
    `Tier akun diambil ${tierSnapshot.fetchedAt}: tier pertama MMR ${(brackets[0].maintMarginRatio * 100).toFixed(2)}%, cum ${brackets[0].cum} USDT. Biaya likuidasi ${(market.liquidationFee * 100).toFixed(2)}%, metadata ${market.fetchedAt}. Snapshot sekarang diasumsikan berlaku pada periode historis; jadwal perubahan tier/fee historis tidak tersedia.`, '',
    '| Periode | Kontrak tanpa likuidasi | Mark tanpa likuidasi | Mark + likuidasi 5x | Jumlah likuidasi | Trade tertutup | SL melampaui batas likuidasi | Stress slippage | Alokasi wallet 35% per sisi |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [period, value] of Object.entries(results)) lines.push(
    `| ${period} | ${value.original.netPnl.toFixed(4)} | ${value.markOnly.netPnl.toFixed(4)} | ${value.liquidation.netPnl.toFixed(4)} | ${value.liquidation.liquidations} | ${value.liquidation.trades} | ${value.liquidation.stopsBeyondLiquidation} | ${value.stress.netPnl.toFixed(4)} | ${value.allocation.netPnl.toFixed(4)} |`);
  lines.push('', 'Satuan PnL USDT, termasuk estimasi posisi terbuka setelah biaya keluar. Tiga kolom pembanding pertama dan stress menggunakan notional normal 100 USDT, countertrend 25 USDT; wallet awal 100 USDT. Margin tiap posisi = notional/5. Skenario alokasi wallet di kolom akhir memakai wallet awal 100 USDT dan sizing ulang 35% wallet per sisi, bukan notional tetap.', '',
    '## Model', '',
    'Maintenance margin memakai tier dan cum pada notional mark. Harga likuidasi diselesaikan dari isolatedWallet + direction × quantity × (mark − entry) = maintenanceMargin. Tier pada harga hasil harus cocok; tidak memakai pendekatan 1/leverage saja. LONG dan SHORT hedge tidak saling menyelamatkan karena margin isolated terpisah.', '',
    'SL/TP dan likuidasi dipicu mark price historis. Fill eksekusi memakai estimasi basis kontrak/mark di open candle, dibatasi rentang candle kontrak, lalu slippage 0,02% per sisi. Stress memakai 0,04%. Jika SL lebih dekat daripada likuidasi pada gerak adverse, SL dieksekusi lebih dulu. Jika open melompati keduanya, likuidasi didahulukan secara konservatif. Ketika TP dan adverse sama-sama tersentuh di satu candle, adverse didahulukan.', '',
    'Funding historis dibayar dari cash tersedia; kekurangan dibebankan ke isolated margin sisi tersebut dan menggeser harga likuidasi. Tidak ada auto-add margin. Fee masuk 0,05% diambil dari cash; exit biasa membayar fee 0,05%. Pada full liquidation, clearance fee dipotong dari collateral tersisa, tidak ditambah fee exit biasa; saldo isolated negatif diasumsikan diselesaikan insurance fund. Ini pendekatan full liquidation untuk posisi kecil, bukan rekonstruksi IOC/partial-liquidation Binance.', '',
    'Posisi tersisa dinilai pada close mark terakhir setelah estimasi biaya keluar, tanpa dipaksa tutup. Drawdown dihitung mark-to-market setiap menit. Wallet yang tidak cukup menahan entry baru. Auto-top-up, ADL, partial liquidation, precision/minimum order, delay bot/exchange, dan urutan tick sebenarnya tidak dimodelkan. Semua periode sudah dipakai sebelumnya; hasil tetap eksploratif.', '',
    '## Periode UTC', '', ...Object.entries(reference.periods).map(([name,p])=>`- ${name}: ${new Date(p.start).toISOString()} sampai ${new Date(p.end).toISOString()}.`), '',
    '## Sumber', '',
    '- [Binance liquidation protocols: mark price, isolated hedge, dan clearance fee](https://www.binance.com/en/support/faq/detail/360033525271)',
    '- [Binance USD-M liquidation calculation: maintenance rate dan cumulative maintenance amount](https://www.binance.com/en/support/faq/detail/b3c689c1f50a44cabb3a84e663b81d93)',
    '- [Binance funding: saldo tersedia dahulu, lalu position margin](https://www.binance.com/en/support/faq/detail/360033525031)',
    '- Tier akun: signed read-only GET /fapi/v1/leverageBracket; mark candles: public GET /fapi/v1/markPriceKlines; liquidation fee: public GET /fapi/v1/exchangeInfo.', '',
    'Runner tidak mengirim order atau mengubah leverage di exchange. Konfigurasi lokal LEVERAGE=5 telah diperbarui sesuai instruksi pengguna.', '');
  fs.writeFileSync('backtest-results/cross-liquidation-5x.md', lines.join('\n'));
}

if (require.main === module) main();
