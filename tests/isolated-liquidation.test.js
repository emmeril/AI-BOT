'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceMargin, liquidationPrice, isLiquidatable, settleLiquidation } = require('../src/isolated-liquidation');
const { simulateIsolatedMargin } = require('../src/isolated-margin-backtester');

const brackets = [{ notionalFloor: 0, notionalCap: 1000, maintMarginRatio: 0.01, cum: 0, initialLeverage: 75 },
  { notionalFloor: 1000, notionalCap: 1e9, maintMarginRatio: 0.02, cum: 10, initialLeverage: 50 }];
const position = direction => ({ quantity: 1, entry: 100, direction, isolatedWallet: 20 });
const row = (index, open = 100, high = open, low = open, close = open) =>
  [index * 60_000, open, high, low, close, 1, (index + 1) * 60_000 - 1];
const options = { start: 0, end: 120_000, leverage: 5, brackets, liquidationFeeRate: 0.015,
  feeRate: 0, slippageRate: 0, initialWallet: 100,
  priceSelector: event => event.side === 'LONG' ? { stop: 70, target: 140 } : { stop: 130, target: 60 } };

test('isolated liquidation uses maintenance margin, not the raw 1/leverage distance', () => {
  assert.ok(Math.abs(liquidationPrice(position(1), brackets) - 80 / 0.99) < 1e-10);
  assert.ok(Math.abs(liquidationPrice(position(-1), brackets) - 120 / 1.01) < 1e-10);
  for (const direction of [1,-1]) {
    const p = position(direction);
    const lp = liquidationPrice(p, brackets);
    assert.equal(isLiquidatable(p, lp, brackets), true);
    assert.equal(isLiquidatable(p, 100, brackets), false);
  }
});

test('maintenance tier at liquidation root is checked and cum is included', () => {
  assert.equal(maintenanceMargin(1500, brackets), 20);
  const p = { quantity: 20, entry: 100, direction: 1, isolatedWallet: 400 };
  const lp = liquidationPrice(p, brackets);
  assert.ok(Math.abs((400 + 20 * (lp - 100)) - maintenanceMargin(20 * lp, brackets)) < 1e-8);
  const crossesTier = { quantity: 10, entry: 100, direction: 1, isolatedWallet: 200 };
  assert.ok(10 * liquidationPrice(crossesTier, brackets) < 1000);
  assert.equal(liquidationPrice({ ...position(1), isolatedWallet: 100 }, brackets), null);
});

test('clearance fees are collateral-limited and bankrupt isolated debt is recorded separately', () => {
  const settlement = settleLiquidation(position(1), 80 / 0.99, 80 / 0.99, 0.015);
  assert.equal(settlement.returnedCollateral, 0);
  assert.ok(settlement.clearanceFee < settlement.assessedClearance);
  const gap = settleLiquidation(position(1), 70, 70, 0.015);
  assert.equal(gap.returnedCollateral, 0);
  assert.equal(gap.insuranceCovered, 10);
});

for (const side of ['LONG', 'SHORT']) {
  test(`${side} is liquidated before a more distant cross SL`, () => {
    const rows = [row(0), side === 'LONG' ? row(1,100,100,75,90) : row(1,100,125,100,110)];
    const result = simulateIsolatedMargin({ rows, events: new Map([[0,{ side, size: 1 }]]) }, rows, {}, options);
    assert.equal(result.liquidations, 1);
    assert.equal(result.netPnl, -20);
    assert.equal(result.tradeDetails[0].reason, 'LIQUIDATION');
    assert.equal(result.stopsBeyondLiquidation, 1);
  });
  test(`${side} protective SL closer than liquidation executes first even if the candle crosses both`, () => {
    const rows = [row(0), side === 'LONG' ? row(1,100,101,70,90) : row(1,100,130,99,110)];
    const selected = event => event.side === 'LONG' ? { stop: 90, target: 140 } : { stop: 110, target: 60 };
    const result = simulateIsolatedMargin({ rows, events: new Map([[0,{ side, size: 1 }]]) }, rows, {}, { ...options, priceSelector: selected });
    assert.equal(result.liquidations, 0);
    assert.equal(result.tradeDetails[0].reason, 'STOP_LOSS');
    assert.equal(result.netPnl, -10);
    assert.equal(result.stopsBeyondLiquidation, 0);
  });
}

test('mark price triggers liquidation even when contract price never hits that level', () => {
  const rows = [row(0), row(1)];
  const marks = [row(0), row(1,100,100,75,90)];
  const result = simulateIsolatedMargin({ rows, events: new Map([[0,{ side:'LONG', size:1 }]]) }, marks, {}, options);
  assert.equal(result.liquidations, 1);
});

test('funding shortfall debits isolated margin and moves liquidation price', () => {
  const rows = [row(0),row(1)];
  const result = simulateIsolatedMargin({ rows, events: new Map([[0,{ side:'LONG', size:1 }]]) }, rows, {}, {
    ...options, initialWallet: 20, funding: [{ fundingTime: 60_003, markPrice:100, fundingRate:0.01 }] });
  assert.equal(result.funding, -1);
  assert.equal(result.openPositions[0].isolatedWallet, 19);
  assert.equal(result.openPositions[0].marginFunding, -1);
  assert.equal(result.netPnl, -1);
  assert.ok(result.openPositions[0].liquidationPrice > liquidationPrice(position(1), brackets));
});

test('isolated hedge profits do not rescue the losing side', () => {
  const rows = [row(0),row(1),row(2,100,100,80,80)];
  const events = new Map([[0,{ side:'LONG', size:1 }],[1,{ side:'SHORT', size:1 }]]);
  const result = simulateIsolatedMargin({ rows, events }, rows, {}, { ...options, end:180_000,
    priceSelector: event => event.side === 'LONG' ? { stop:50, target:150 } : { stop:150, target:70 } });
  assert.equal(result.liquidations, 1);
  assert.equal(result.openPositions.length, 1);
  assert.equal(result.openPositions[0].side, 'SHORT');
  assert.equal(result.netPnl, 0);
});

test('a gap past both liquidation and SL is settled as liquidation', () => {
  const rows = [row(0),row(1,70,70,70,70)];
  const result = simulateIsolatedMargin({ rows, events:new Map([[0,{side:'LONG',size:1}]]) }, rows, {}, {
    ...options, priceSelector: () => ({ stop:90,target:140 }) });
  assert.equal(result.tradeDetails[0].reason, 'LIQUIDATION_GAP');
  assert.equal(result.netPnl, -20);
  assert.equal(result.insuranceCovered, 10);
});

test('missing mark history fails rather than silently substituting last price', () => {
  assert.throws(() => simulateIsolatedMargin({ rows:[row(0),row(1)], events:new Map() }, [row(0)], {}, options), /Missing aligned mark/);
});

test('insufficient free margin prevents entries', () => {
  const rows = [row(0),row(1)];
  const result = simulateIsolatedMargin({ rows, events:new Map([[0,{side:'LONG',size:1}]]) }, rows, {}, { ...options, initialWallet:10 });
  assert.equal(result.skippedMargin, 1);
  assert.equal(result.trades, 0);
  assert.equal(result.openPositions.length, 0);
});
