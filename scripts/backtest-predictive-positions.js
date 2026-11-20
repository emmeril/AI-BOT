#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const { normalizeKlines, FEATURE_NAMES } = require('../src/predictive/features');
const { buildDirectionFeatures, SCHEMA } = require('../src/predictive/direction-features');
const { validateDirectionModel } = require('../src/predictive/direction-model');
const { forecastDirection, scoreDirection } = require('../src/predictive/direction-forward');
const { validateExitModel, planExit } = require('../src/predictive/exit-planner');
const { validateReachability } = require('../src/predictive/reachability');
const { scoreExitPlan } = require('../src/predictive/exit-evaluator');
const { buildLiveConfig, candidateEvidence } = require('../src/predictive/live-policy');
const { simulatePositionPolicy } = require('../src/predictive/position-backtester');

function causalGates(candles, frames, truths, window, config, directionModelId, reachabilityModelId, seed = []) {
  const records = [], pending = [], gates = new Array(candles.length);
  for (const row of seed) {
    if (Date.parse(row.createdAt) > window.from || row.candleCloseTime > window.from) continue;
    const record = { ...row, outcome: null, exitOutcome: null, exitPlan: null };
    records.push(record);
    pending.push({ record, truth: { direction: row.outcome, exit: null } });
  }
  pending.sort((a, b) => a.record.targetCloseTime - b.record.targetCloseTime);
  let cursor = 0;
  for (let i = 0; i < candles.length; i++) {
    const time = candles[i].closeTime;
    if (time < window.from || time > window.to || !frames[i]) continue;
    const record = { ...frames[i].forecast, outcome: null, exitOutcome: null };
    records.push(record); pending.push({ record, truth: truths[i] });
    if (records.length > 2000) records.splice(0, records.length - 2000);
    while (cursor < pending.length && pending[cursor].record.targetCloseTime <= time) {
      const completed = pending[cursor++];
      completed.record.outcome = completed.truth?.direction || null;
      completed.record.exitOutcome = completed.truth?.exit || null;
    }
    gates[i] = candidateEvidence({ records }, config, directionModelId, reachabilityModelId);
  }
  return gates;
}

function writeCsv(file, rows) {
  if (!rows.length) { fs.writeFileSync(file, '', { mode: 0o600 }); return; }
  const columns = Object.keys(rows[0]);
  const cell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  fs.writeFileSync(file, [columns.map(cell).join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\n') + '\n', { mode: 0o600 });
}

async function main(directory) {
  if (!directory) throw new Error('Usage: backtest-predictive-positions.js <prepared-input-directory>');
  const dir = path.resolve(directory), read = file => JSON.parse(fs.readFileSync(path.join(dir, file)));
  const manifest = read('input-manifest.json');
  if (fs.existsSync(path.join(dir, 'summary.json'))) throw new Error('Use a new output directory; a completed backtest already exists');
  const direction = read('models/direction.json'), exit = read('models/exit.json'), reachability = read('models/reachability.json');
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
  validateDirectionModel(direction, 'DOGEUSDT'); validateExitModel(exit, 'DOGEUSDT', direction.modelId);
  validateReachability(reachability, 'DOGEUSDT', direction.modelId, exit.modelId);
  if (digest('models/direction.json') !== exit.directionModelHash || digest('models/direction.json') !== reachability.directionModelHash ||
      digest('models/exit.json') !== reachability.exitModelHash) throw new Error('Frozen model hashes do not match');
  const candles = normalizeKlines(read('candles.json')), market = read('market.json'), funding = read('funding.json');
  const features = buildDirectionFeatures(candles), frames = new Array(candles.length), truths = new Array(candles.length);
  const tick = Number(market.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize);
  const keys = ['status', 'reason', 'riskPolicyId', 'reachabilityModelId', 'directionModelId', 'exitModelId',
    'side', 'stopId', 'stopLoss', 'takeProfit', 'takeProfit1', 'takeProfit2', 'selectedTarget', 'expectedNetPct',
    'contextFeatures', 'directionProbabilities', 'expiresAt', 'costAssumptions', 'priceTick', 'modelRangeQ75'];
  let eligible = 0, evaluated = 0;
  for (const row of features) {
    if (row.time < manifest.auditStart) continue;
    const x = direction.featureSchema === SCHEMA ? row.x : row.x.slice(0, FEATURE_NAMES.length);
    const forecast = forecastDirection(direction, { time: row.time, close: row.close, x }, 'DOGEUSDT', row.time + 1);
    const estimated = planExit(forecast, exit, row.x, { targetLevels: true, tickSize: tick,
      candles: candles.slice(row.index - 15, row.index + 1), reachabilityModel: reachability });
    forecast.exitPlan = Object.fromEntries(keys.filter(k => estimated[k] !== undefined).map(k => [k, estimated[k]]));
    frames[row.index] = { forecast };
    truths[row.index] = { direction: scoreDirection(forecast, candles), exit: scoreExitPlan(forecast, candles, row.index) };
    eligible += Number(estimated.status === 'ESTIMATED'); evaluated++;
    if (evaluated % 500 === 0) {
      console.log(JSON.stringify({ stage: 'MODEL_REPLAY', candles: evaluated, positiveNetCandidates: eligible }));
      await yieldTurn();
    }
  }
  const seedFile = path.join(dir, 'direction-seed.json');
  const seed = fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile)) : [];
  const config = buildLiveConfig();
  const report = { createdAt: new Date().toISOString(), symbol: 'DOGEUSDT', executionEnabled: false,
    frozenModels: manifest.models, dataEnd: new Date(manifest.endCloseTime).toISOString(),
    settings: { initialWalletUsdt: 10.8, marginUsdt: 5, leverage: 10, targetNotionalUsdt: 50,
      maxPositions: 1, compounding: false, sessionLossEntryPauseUsdt: 5,
      costs: { feePctPerSide: 0.05, slippagePctPerSide: 0.02, fundingIncluded: true },
      causalForwardGate: true, directionSeedObservations: seed.length, historicalGeminiDecisions: 'NOT_RECONSTRUCTED' },
    assumptions: [
      'All predictors use completed candles; signals execute at the next one-minute candle open',
      'An exited position can produce the next entry only after another completed candle',
      'Bid/ask spread is not recorded; slippage is the execution-cost proxy',
      'SL wins if TP and SL are both touched in one candle; stop gaps fill at the open; target gaps use the target',
      'Open trades at the end remain open; equity includes an estimated exit fee and slippage',
      'Drawdown uses candle-close marked equity; liquidation, outages and intraminute latency are not replayed',
      'Gemini filtering is excluded; this evaluates the primary method and its outage fallback',
      'Historical audit data were previously inspected; subsequent-model data are a retrospective replay of the new holding rule',
      'Historical market filters use the captured current DOGE exchange metadata',
      'Forward eligibility retains approximately 2000 one-hour forecasts, matching the shared 6000-record three-horizon worker limit',
    ], windows: [] };
  for (const window of manifest.windows) {
    const gates = causalGates(candles, frames, truths, window, config, direction.modelId, reachability.modelId,
      window.id === 'POST_FREEZE_REPLAY' ? seed : []);
    const firstPass = gates.findIndex(g => g?.matchesUserCriteria);
    const result = { ...window, fromIso: new Date(window.from).toISOString(), toIso: new Date(window.to).toISOString(),
      firstForwardGatePassAt: firstPass >= 0 ? new Date(candles[firstPass].closeTime).toISOString() : null,
      finalForwardEvidence: gates.filter(Boolean).at(-1), strategies: {} };
    for (const policy of ['HORIZON', 'PREDICTION_REVERSAL']) {
      const replay = simulatePositionPolicy({ candles, frames, gates, market, reachabilityModel: reachability,
        funding, from: window.from, to: window.to, policy });
      result.strategies[policy] = replay.summary;
      const prefix = window.id.toLowerCase() + '-' + policy.toLowerCase();
      writeCsv(path.join(dir, prefix + '-trades.csv'), replay.trades);
      writeCsv(path.join(dir, prefix + '-equity.csv'), replay.equity);
      fs.writeFileSync(path.join(dir, prefix + '.json'), JSON.stringify(replay, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ stage: 'PORTFOLIO_REPLAY', window: window.id, ...replay.summary }));
    }
    report.windows.push(result);
  }
  report.activeModelsUnchanged = Object.values(manifest.models).every(m =>
    crypto.createHash('sha256').update(fs.readFileSync(m.source)).digest('hex') === m.sha256);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ stage: 'COMPLETE', output: path.join(dir, 'summary.json'), activeModelsUnchanged: report.activeModelsUnchanged }));
  return report;
}

if (require.main === module) main(process.argv[2]).catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { causalGates, main };
