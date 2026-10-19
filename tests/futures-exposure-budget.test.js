const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decideExposureBudget,
  exposureBudgetTarget,
  walletBalanceUsdt,
  walletChangePct,
} = require('../src/futures-exposure-budget');

test('45 percent budget keeps a 10 percent combined buffer and caps each symbol', () => {
  assert.deepEqual(exposureBudgetTarget(92.62192843, 45, 22), {
    symbol: 22,
    total: 41.68,
  });
  assert.deepEqual(exposureBudgetTarget(20, 45, 22), {
    symbol: 9,
    total: 9,
  });
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
    symbolCeiling: 22,
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
    symbolCeiling: 22,
    currentLimits: { symbol: 22, total: 45 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
    currentExposure: 44,
  });
  assert.equal(reduction.action, 'APPLIED');
  assert.deepEqual(reduction.limits, { symbol: 22, total: 36 });

  const increase = decideExposureBudget({
    walletBalance: 120,
    sidePct: 45,
    symbolCeiling: 22,
    currentLimits: { symbol: 22, total: 45 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
    currentExposure: 5,
  });
  assert.equal(increase.action, 'DEFERRED');
  assert.deepEqual(increase.limits, { symbol: 22, total: 45 });

  const flat = decideExposureBudget({
    walletBalance: 120,
    sidePct: 45,
    symbolCeiling: 22,
    currentLimits: { symbol: 22, total: 45 },
    referenceWalletBalance: 100,
    rebalanceThresholdPct: 10,
    currentExposure: 0,
  });
  assert.equal(flat.action, 'APPLIED');
  assert.deepEqual(flat.limits, { symbol: 22, total: 54 });
});
