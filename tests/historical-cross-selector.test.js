'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { historicalProtection } = require('../src/ma-cross-strategy');
const { selectHistoricalCrossPrices, annotateCrossRetests } = require('../src/historical-cross-selector');
const { buildScalperConfig } = require('../src/scalper/config');

function level(price, timeframe, count) {
  return { price, timeframe, timestamp: 1, supportRetests: count, resistanceRetests: count, pair: 'MA7/MA99' };
}
const levels = [level(102, '1m', 99), level(99, '1m', 99),
  level(105, '4h', 1), level(110, '4h', 2), level(115, '4h', 3),
  level(99, '4h', 1), level(95, '4h', 2), level(90, '4h', 3)];

test('restored default selects retested cross candidates instead of the closest price', () => {
  const strategy = buildScalperConfig({}).strategies.LONG;
  assert.deepEqual(strategy.crossSelection, { priority: 'higherFirst', rank: 'retests', minimumRetests: 1,
    targetIndex: 2, stopIndex: 1, requireNetTarget: true });
  const selected = selectHistoricalCrossPrices({ side: 'LONG', levels }, 100, strategy.crossSelection);
  assert.equal(selected.target, 105);
  assert.equal(selected.stop, 95);
  assert.equal(selected.sources.target.timeframe, '4h');
  const protection = historicalProtection(100, 'LONG', { levels, selection: strategy.crossSelection }, strategy);
  assert.equal(protection.takeProfitPrice, 105);
  assert.equal(protection.stopLossPrice, 95);
  assert.equal(protection.support.supportRetests, 2);
});

test('short selection is symmetric and missing qualified points cannot fall back to closest', () => {
  const strategy = buildScalperConfig({}).strategies.SHORT;
  const selected = selectHistoricalCrossPrices({ side: 'SHORT', levels }, 100, strategy.crossSelection);
  assert.equal(selected.target, 99);
  assert.equal(selected.stop, 110);
  const inadequate = levels.map(point => ({ ...point, supportRetests: 0, resistanceRetests: 0 }));
  assert.equal(selectHistoricalCrossPrices({ side: 'SHORT', levels: inadequate }, 100, strategy.crossSelection), null);
  assert.equal(historicalProtection(100, 'SHORT', { levels: inadequate, selection: strategy.crossSelection }, strategy).valid, false);
});

test('a broken cross loses the retest confirmation on that side', () => {
  const rows = [[0,105,106,104,105], [60_000,105,106,99,104], [120_000,104,105,97,98]];
  const point = { price: 100, timestamp: 0, timeframe: '1m', pair: 'MA25/MA99' };
  assert.equal(annotateCrossRetests(rows.slice(0,2), [point])[0].supportRetests, 1);
  assert.equal(annotateCrossRetests(rows, [point])[0].supportRetests, 0);
});
