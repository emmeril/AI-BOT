const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decideExposureBudget,
  exposureBudgetTarget,
  walletBalanceUsdt,
  walletChangePct,
} = require('../src/futures-exposure-budget');

test('45 percent margin budget is multiplied by leverage and divided equally across pairs', () => {
  assert.deepEqual(exposureBudgetTarget(92.62192843, 45, 5), {
    symbol: 208.4,
    total: 208.4,
  });
  assert.deepEqual(exposureBudgetTarget(92.62192843, 45, 5, 2), {
    symbol: 104.2,
    total: 208.4,
  });
  assert.deepEqual(exposureBudgetTarget(92.62192843, 45, 5, 4), {
    symbol: 52.1,
    total: 208.4,
  });
});

test('LONG-only allocation can use more than half the wallet while retaining an upper bound', () => {
  assert.deepEqual(exposureBudgetTarget(100, 60, 5, 2), {
    symbol: 150,
    total: 300,
  });
  assert.throws(() => exposureBudgetTarget(100, 91, 5, 2), /at most 90%/);
});

test('budget rejects invalid leverage and configured pair count', () => {
  assert.throws(() => exposureBudgetTarget(100, 45, 0), /Leverage/);
  assert.throws(() => exposureBudgetTarget(100, 45, 5, 0), /Pair count/);
  assert.throws(() => exposureBudgetTarget(100, 45, 5, 1.5), /Pair count/);
});

test('wallet balance prefers realized futures wallet fields over generic totals', () => {
  assert.equal(walletBalanceUsdt({
    info: { totalWalletBalance: '92.62' },
    total: { USDT: 100 },
  }), 92.62);
  assert.equal(walletBalanceUsdt({
    info: { assets: [{ asset: 'USDT', walletBalance: '88.5' }] },
    total: { USDT: 100 },
  }), 88.5);
});

test('budget ignores sub-threshold balance movement', () => {
  const decision = decideExposureBudget({
    walletBalance: 99,
    sidePct: 45,
    leverage: 1,
    currentLimits: { symbol: 22, total: 45 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
  });
  assert.equal(walletChangePct(100, 99), 1);
  assert.equal(decision.action, 'UNCHANGED');
  assert.deepEqual(decision.limits, { symbol: 22, total: 45 });
});

test('budget applies reductions but defers increases while exposure is active', () => {
  const reduction = decideExposureBudget({
    walletBalance: 80,
    sidePct: 45,
    leverage: 1,
    currentLimits: { symbol: 22, total: 45 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
    currentExposure: 44,
  });
  assert.equal(reduction.action, 'APPLIED');
  assert.deepEqual(reduction.limits, { symbol: 36, total: 36 });

  const increase = decideExposureBudget({
    walletBalance: 120,
    sidePct: 45,
    leverage: 1,
    currentLimits: { symbol: 22, total: 45 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
    currentExposure: 5,
  });
  assert.equal(increase.action, 'DEFERRED');
  assert.deepEqual(increase.limits, { symbol: 45, total: 45 });

  const flat = decideExposureBudget({
    walletBalance: 120,
    sidePct: 45,
    leverage: 1,
    currentLimits: { symbol: 22, total: 45 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
    currentExposure: 0,
  });
  assert.equal(flat.action, 'APPLIED');
  assert.deepEqual(flat.limits, { symbol: 54, total: 54 });
});

test('budget applies the configured target when no valid wallet reference exists', () => {
  const decision = decideExposureBudget({
    walletBalance: 92.73,
    sidePct: 80,
    leverage: 5,
    pairCount: 3,
    referencePairCount: 3,
    currentLimits: { symbol: 41.68, total: 41.68 },
    referenceWalletBalance: 0,
    rebalanceThresholdPct: 1,
    currentExposure: 322.3,
  });
  assert.equal(decision.action, 'APPLIED');
  assert.deepEqual(decision.limits, { symbol: 123.64, total: 370.92 });
});

test('pair count changes rebalance immediately without waiting for wallet threshold', () => {
  const decision = decideExposureBudget({
    walletBalance: 92.62192843,
    sidePct: 45,
    leverage: 1,
    pairCount: 2,
    referencePairCount: 5,
    currentLimits: { symbol: 8.34, total: 41.68 },
    referenceWalletBalance: 92.62192843,
    rebalanceThresholdPct: 10,
    currentExposure: 0,
  });
  assert.equal(decision.action, 'APPLIED');
  assert.deepEqual(decision.limits, { symbol: 20.84, total: 41.68 });
});

test('pair cap changes immediately while an active exposure defers only a total-cap increase', () => {
  const decision = decideExposureBudget({
    walletBalance: 120,
    sidePct: 45,
    leverage: 1,
    pairCount: 4,
    referencePairCount: 2,
    currentLimits: { symbol: 22, total: 45 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
    currentExposure: 20,
  });
  assert.equal(decision.action, 'DEFERRED');
  assert.deepEqual(decision.target, { symbol: 13.5, total: 54 });
  assert.deepEqual(decision.limits, { symbol: 13.5, total: 45 });
});

test('leverage-aware model migration applies immediately with active exposure', () => {
  const decision = decideExposureBudget({
    walletBalance: 100,
    sidePct: 45,
    leverage: 5,
    referenceLeverage: null,
    pairCount: 2,
    referencePairCount: 2,
    currentLimits: { symbol: 22.5, total: 45 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
    currentExposure: 40,
  });
  assert.equal(decision.action, 'APPLIED');
  assert.deepEqual(decision.limits, { symbol: 112.5, total: 225 });
});

test('an explicit side allocation change applies immediately with active exposure', () => {
  const decision = decideExposureBudget({
    walletBalance: 100,
    sidePct: 60,
    referenceSidePct: 45,
    leverage: 5,
    referenceLeverage: 5,
    pairCount: 2,
    referencePairCount: 2,
    currentLimits: { symbol: 112.5, total: 225 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
    currentExposure: 200,
  });
  assert.equal(decision.action, 'APPLIED');
  assert.deepEqual(decision.limits, { symbol: 150, total: 300 });
});
