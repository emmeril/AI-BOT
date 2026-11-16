'use strict';
const fs = require('fs');
const { buildScalperConfig } = require('../src/scalper/config');
const { simulateExitMethod } = require('../src/ma-exit-research');
const { preparePureCrossHistory, selectPureCrossPrices } = require('../src/pure-cross-selection');

function main() {
  require('dotenv').config({ path: '.env.futures', quiet: true });
  const source = JSON.parse(fs.readFileSync('backtest-results/pure-cross-selection.json'));
  const rows = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-1m.json'));
  const funding = JSON.parse(fs.readFileSync('backtest-data/ma-exit-research/bonk-funding.json'));
  const prepared = preparePureCrossHistory(rows, buildScalperConfig(process.env));
  const tested = [];
  for (const candidate of source.survivors.filter(item => item.passed)) {
    const evaluation = {};
    for (const period of ['selection13d', 'comparison30d', 'november']) {
      const baseline = simulateExitMethod(prepared, candidate.method,
        { ...source.periods[period], funding, priceSelector: selectPureCrossPrices, recordTrades: true });
      const stress = simulateExitMethod(prepared, candidate.method,
        { ...source.periods[period], funding, priceSelector: selectPureCrossPrices, slippageRate: 0.0004 });
      const highFees = simulateExitMethod(prepared, candidate.method,
        { ...source.periods[period], funding, priceSelector: selectPureCrossPrices, feeRate: 0.0006 });
      const positions = [...baseline.tradeDetails, ...baseline.openPositions];
      const riskPcts = positions.map(position => position.initialRisk / position.entry * 100).sort((a,b) => a-b);
      let maximumAdversePct = 0;
      const origin = Number(rows[0][0]);
      for (const position of positions) {
        const begin = Math.max(0, Math.round((position.entryTimestamp - origin) / 60_000));
        const finish = Math.min(rows.length, Math.ceil(((position.exitTimestamp || source.periods[period].end) - origin) / 60_000));
        for (let i = begin; i < finish; i++) {
          const adverse = position.direction > 0 ? (position.entry - Number(rows[i][3])) / position.entry
            : (Number(rows[i][2]) - position.entry) / position.entry;
          maximumAdversePct = Math.max(maximumAdversePct, adverse * 100);
        }
      }
      evaluation[period] = { baseline, stress, highFees, risk: { medianStopPct: riskPcts[Math.floor(riskPcts.length/2)],
        maxStopPct: riskPcts.at(-1), maximumAdversePct, stopsOver4Pct: riskPcts.filter(value => value > 4).length } };
    }
    const neighbors = [];
    for (const [targetDelta, stopDelta] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const neighbor = { ...candidate.method, targetIndex: candidate.method.targetIndex + targetDelta, stopIndex: candidate.method.stopIndex + stopDelta };
      if (neighbor.targetIndex < 0 || neighbor.stopIndex < 0) continue;
      const results = {};
      for (const name of ['comparison30d', 'november']) results[name] = simulateExitMethod(prepared, neighbor,
        { ...source.periods[name], funding, priceSelector: selectPureCrossPrices }).netPnl;
      neighbors.push({ targetIndex: neighbor.targetIndex, stopIndex: neighbor.stopIndex, results });
    }
    tested.push({ method: candidate.method, evaluation, neighbors,
      stressPassed: Object.values(evaluation).every(item => item.stress.netPnl > 0 && item.highFees.netPnl > 0) });
  }
  const report = { generatedAt: new Date().toISOString(), tested,
    note: 'Exploratory post-selection audit, all periods reused; not an independent fresh holdout. Maximum adverse movement from full 1m candle is conservative and may include movement after an intrabar exit.' };
  fs.writeFileSync('backtest-results/pure-cross-selection-audit.json', JSON.stringify(report, null, 2));
  const lines = ['# Audit kandidat TP/SL murni cross historis', '',
    'Empat kandidat profit pada tiga periode dasar. Kandidat dipilih setelah melihat periode pembanding; hasil ini eksploratif, bukan validasi independen atau jaminan TP.', '',
    '| Kandidat | Periode | Net dasar | Net slippage 0,04% | Net fee 0,06% | Stop median | Stop maksimum |',
    '|---|---|---:|---:|---:|---:|---:|'];
  for (const item of tested) for (const [period, result] of Object.entries(item.evaluation)) lines.push(
    `| ${item.method.id} | ${period} | ${result.baseline.netPnl.toFixed(4)} | ${result.stress.netPnl.toFixed(4)} | ${result.highFees.netPnl.toFixed(4)} | ${result.risk.medianStopPct.toFixed(2)}% | ${result.risk.maxStopPct.toFixed(2)}% |`);
  lines.push('', '## Sensitivitas urutan cross', '');
  for (const item of tested) {
    lines.push(`- ${item.method.id}: ${JSON.stringify(item.neighbors)}`);
  }
  lines.push('', 'Harga TP/SL tepat harga cross historis. Tidak ada ATR, buffer, trailing atau timeout. Persentase stop di atas hanya statistik jarak, bukan aturan stop persentase. Notional 100 USDT normal/25 USDT countertrend; fee dasar 0,05%, slippage dasar 0,02% per sisi, funding dimasukkan. PnL termasuk posisi terbuka pada close terakhir dan estimasi biaya keluar.', '',
    'Jarak SL yang jauh berisiko melampaui likuidasi akun berleverage; simulator ini tidak memodelkan margin/likuidasi. Data OHLC dapat memasukkan gerak harga setelah exit intrabar dalam statistik maksimum adverse, sehingga angka tersebut konservatif. Eksperimen ini belum diterapkan ke trading live.', '');
  fs.writeFileSync('backtest-results/pure-cross-selection-audit.md', lines.join('\n'));
  console.log(JSON.stringify(tested.map(item => ({ method: item.method.id, stressPassed: item.stressPassed,
    periods: Object.fromEntries(Object.entries(item.evaluation).map(([p,x])=>[p,{net:x.baseline.netPnl,realized:x.baseline.realizedNetPnl,
      open:x.baseline.openNetPnl,stress:x.stress.netPnl,fees:x.highFees.netPnl,maxStopPct:x.risk.maxStopPct,mae:x.risk.maximumAdversePct}])) }))));
}

if (require.main === module) main();
