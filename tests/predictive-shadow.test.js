'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKlines, buildFeatureRows } = require('../src/predictive/features');
const { rewardRisk, simulateExit } = require('../src/predictive/trade-simulator');
const { labeledRows } = require('../src/predictive/labels');
const { train, predict } = require('../src/predictive/hit-first-model');
const { splitChronological, chooseAction, simulate, selectThreshold, trainAndEvaluate } =
  require('../src/predictive/v2-evaluation');
const { trainHorizon } = require('../src/predictive/training');
const { forecast, scoreForecast, scorePending, summary } =
  require('../src/predictive/forward-evaluator');

function klines(count = 850) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + 0.0008 * i + Math.sin(i / 9) * 0.12;
    const open = close - Math.sin(i / 3) * 0.012;
    return [i * 60000, open, Math.max(open, close) + 0.08,
      Math.min(open, close) - 0.08, close, 100, i * 60000 + 59999,
      1000 + i / 10, 20, 50, 520 + i / 100];
  });
}

const assumptions = { horizon: 15, targetPct: 0.9, stopPct: 0.3,
  feePct: 0.05, slippagePct: 0.02, minNetRewardRisk: 1.5 };

test('feature rows use only completed historic candles', () => {
  const data = klines();
  const original = buildFeatureRows(normalizeKlines(data.slice(0, 90)));
  const changed = data.map((row, i) => i < 90 ? row : [
    row[0], row[1] * 1.2, row[2] * 1.2, row[3] * 1.2,
    row[4] * 1.2, row[5], row[6], row[7], row[8], row[9], row[10],
  ]);
  assert.deepEqual(original, buildFeatureRows(normalizeKlines(changed)).filter(row => row.index < 90));
});

test('gaps or malformed Binance candles fail closed', () => {
  const data = klines(90);
  data.splice(40, 1);
  assert.throws(() => normalizeKlines(data), /Invalid or non-contiguous/);
});

test('configured net reward/risk passes default and rejects low gross target', () => {
  assert.ok(rewardRisk('LONG', assumptions).ratio >= 1.5);
  assert.ok(rewardRisk('SHORT', assumptions).ratio >= 1.5);
  assert.ok(rewardRisk('LONG', { ...assumptions, targetPct: 0.35 }).ratio < 1.5);
});

test('simulator uses next candle open and counts ambiguous barriers as stop', () => {
  const rows = normalizeKlines(klines(110));
  rows[31] = { ...rows[31], open: rows[30].close,
    high: rows[30].close * 1.05, low: rows[30].close * 0.95 };
  const trade = simulateExit(rows, 30, 'LONG', assumptions);
  assert.equal(trade.reason, 'STOP_AMBIGUOUS');
  assert.equal(trade.targetHit, false);
  assert.equal(trade.ambiguous, true);
  assert.ok(trade.netPct < 0);
});

test('gap through stop executes at open rather than ideal stop price', () => {
  const rows = normalizeKlines(klines(110));
  const gap = rows[30].close * 0.9;
  rows[31] = { ...rows[31], open: gap, high: gap * 1.001, low: gap * 0.999 };
  rows[32] = { ...rows[32], open: gap * 0.9, high: gap * 0.901, low: gap * 0.899 };
  const trade = simulateExit(rows, 30, 'LONG', assumptions);
  assert.equal(trade.reason, 'STOP_GAP');
  assert.ok(trade.netPct < -0.3);
});

test('training labels reproduce the exact simulator per position side', () => {
  const candles = normalizeKlines(klines());
  const rows = labeledRows(buildFeatureRows(candles), candles, assumptions);
  const sample = rows[50];
  assert.equal(sample.longTrade.netPct,
    simulateExit(candles, sample.index, 'LONG', assumptions).netPct);
  assert.equal(sample.labelLong, Number(sample.longTrade.targetHit));
  assert.equal(sample.labelShort, Number(sample.shortTrade.targetHit));
});

test('chronological split purges future-label overlap', () => {
  const candles = normalizeKlines(klines());
  const rows = labeledRows(buildFeatureRows(candles), candles, assumptions);
  const split = splitChronological(rows, assumptions.horizon);
  assert.ok(split.trainRows.at(-1).index + assumptions.horizon <
    split.validation[0].index);
  assert.ok(split.validation.at(-1).index + assumptions.horizon <
    split.holdout[0].index);
});

test('two independent hit probabilities are finite and do not require summing to one', () => {
  const candles = normalizeKlines(klines());
  const rows = labeledRows(buildFeatureRows(candles), candles, assumptions);
  const model = train(rows.slice(0, 130), { epochs: 5 });
  const result = predict(model, rows[130].x);
  assert.ok(result.longTarget >= 0 && result.longTarget <= 1);
  assert.ok(result.shortTarget >= 0 && result.shortTarget <= 1);
  assert.equal(chooseAction(model, rows[130], {
    ...assumptions, threshold: 0.8, targetPct: 0.35,
  }).action, 'NO_TRADE');
});

test('holdout research reports are generated without live approval', () => {
  const candles = normalizeKlines(klines());
  const rows = labeledRows(buildFeatureRows(candles), candles, assumptions);
  const result = trainAndEvaluate(rows, assumptions);
  assert.equal(result.model.approvedForTrading, false);
  assert.equal(result.report.approvedForTrading, false);
  assert.ok(result.report.holdoutMetrics.long.samples > 0);
  assert.ok(simulate(result.model, rows.slice(-60), {
    ...assumptions, threshold: 0.9,
  }).trades >= 0);
});

test('forward evaluation waits for full horizon and does not submit orders', () => {
  const candles = normalizeKlines(klines());
  const rows = labeledRows(buildFeatureRows(candles), candles, assumptions);
  const model = { ...train(rows.slice(0, 120), { epochs: 5 }), horizon: 15,
    config: assumptions, threshold: 0.7, approvedForTrading: false };
  const feature = buildFeatureRows(candles)[60];
  const prediction = forecast(model, feature, 'BTCUSDT', feature.time + 2000);
  assert.equal(prediction.mode, 'SHADOW_ONLY');
  assert.equal(scoreForecast(prediction, candles.slice(0, feature.index + 14)), null);
  const records = [prediction];
  const updates = scorePending(records, candles);
  assert.equal(updates.length, 1);
  assert.equal(scorePending(records, candles).length, 0);
  assert.equal(summary(records).evaluated, 1);
  assert.ok(Number.isFinite(records[0].outcome.actualClose));
});

test('stale or unselected model only produces NO_TRADE', () => {
  const model = { horizon: 30, config: assumptions, threshold: null,
    approvedForTrading: false };
  const decision = forecast(model, { time: 1000, close: 100 }, 'BTCUSDT', 250000);
  assert.equal(decision.action, 'NO_TRADE');
  assert.equal(decision.mode, 'SHADOW_ONLY');
  assert.equal(decision.reason, 'STALE_MARKET_DATA');
});

test('threshold selection rejects sparse and losing validation results', () => {
  const candidate = (threshold, trades, netPctNotional) =>
    ({ threshold, outcome: { trades, netPctNotional } });
  assert.equal(selectThreshold([candidate(0.55, 9, 100)]).reason,
    'INSUFFICIENT_VALIDATION_TRADES');
  assert.equal(selectThreshold([candidate(0.55, 20, -1), candidate(0.6, 10, 0)]).reason,
    'NO_POSITIVE_VALIDATION_EDGE');
  const result = selectThreshold([candidate(0.55, 9, 100), candidate(0.6, 10, 2),
    candidate(0.65, 15, 3), candidate(0.7, 40, -2)]);
  assert.equal(result.threshold, 0.65);
  assert.equal(result.reason, 'VALIDATION_SELECTED');
});

test('holdout outcomes cannot change threshold or fitted weights', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    index, time: index * 60000, x: [index % 2 ? 1 : -1],
    labelLong: index % 2, labelShort: 1 - index % 2,
    longTrade: { exitIndex: index + 15, netPct: index % 2 ? 1 : -0.4 },
    shortTrade: { exitIndex: index + 15, netPct: index % 2 ? -0.4 : 1 },
  }));
  const original = trainAndEvaluate(rows, assumptions);
  const changed = trainAndEvaluate(rows.map((row, index) => index < 800 ? row :
    { ...row, labelLong: 1 - row.labelLong, labelShort: 1 - row.labelShort,
      longTrade: { ...row.longTrade, netPct: -10 }, shortTrade: { ...row.shortTrade, netPct: -10 } }),
  assumptions);
  assert.ok(Number.isFinite(original.model.threshold));
  assert.deepEqual(original.model, changed.model);
  assert.ok(original.report.holdout.netPctNotional > 0);
  assert.ok(changed.report.holdout.netPctNotional < 0);
  const feature = { ...rows[850], close: 100 };
  const decision = forecast(original.model, feature, 'DOGEUSDT', feature.time + 2000);
  assert.equal(decision.action, 'SHORT');
  assert.equal(decision.reason, 'POSITIVE_MODELLED_EDGE');
});

test('parameter research reports every candidate and keeps unselected models blocked', () => {
  const candles = normalizeKlines(klines());
  const result = trainHorizon(buildFeatureRows(candles), candles, 15, 'doge-shadow');
  const search = result.report.parameterSearch;
  assert.equal(search.selectedOn, 'VALIDATION_ONLY');
  assert.equal(search.candidates.length, 3);
  assert.ok(search.candidates.every(candidate => !Object.hasOwn(candidate, 'holdout')));
  assert.equal(result.model.threshold, null);
  assert.equal(result.report.validation, null);
  assert.equal(result.report.holdout, null);
  assert.equal(search.selectedConfig, null);
  assert.throws(() => trainHorizon([], [], 15, 'unknown'), /Unknown predictive profile/);
});

test('unselected models still record probabilities for forward evaluation', () => {
  const candles = normalizeKlines(klines());
  const rows = labeledRows(buildFeatureRows(candles), candles, assumptions);
  const model = { ...train(rows.slice(0, 120), { epochs: 5 }), horizon: 15,
    config: assumptions, threshold: null, approvedForTrading: false,
    modelId: 'new-doge-model', selection: { reason: 'INSUFFICIENT_VALIDATION_TRADES' } };
  const feature = rows[130];
  const prediction = forecast(model, feature, 'DOGEUSDT', feature.time + 2000);
  assert.equal(prediction.reason, 'MODEL_UNSELECTED');
  assert.equal(prediction.selectionReason, 'INSUFFICIENT_VALIDATION_TRADES');
  assert.equal(prediction.action, 'NO_TRADE');
  assert.deepEqual(prediction.probabilities, predict(model, feature.x));
  assert.notEqual(prediction.id, forecast({ ...model, modelId: 'old-doge-model' },
    feature, 'DOGEUSDT', feature.time + 2000).id);
  scorePending([prediction], candles);
  const result = summary([prediction]);
  assert.equal(result.calibration.longTarget.samples, 1);
  assert.equal(result.simulatedTrades, 0);
  assert.equal(result.reasons.MODEL_UNSELECTED, 1);
});

test('unsafe and stale models cannot produce probabilities or trade actions', () => {
  const model = { threshold: 0.55, approvedForTrading: true };
  assert.equal(forecast(model, { time: 1000 }, 'DOGEUSDT', 1001).reason, 'UNSAFE_MODEL');
  const stale = forecast({ ...model, approvedForTrading: false },
    { time: 1000 }, 'DOGEUSDT', 121001);
  assert.equal(stale.reason, 'STALE_MARKET_DATA');
  assert.equal(stale.probabilities, undefined);
});
