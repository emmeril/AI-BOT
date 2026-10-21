function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function walletBalanceUsdt(balance) {
  const account = balance?.info || {};
  const usdtAsset = Array.isArray(account.assets)
    ? account.assets.find(asset => String(asset?.asset || '').toUpperCase() === 'USDT')
    : null;
  const candidates = [
    account.totalWalletBalance,
    usdtAsset?.walletBalance,
    balance?.USDT?.total,
    balance?.total?.USDT,
  ];
  for (const candidate of candidates) {
    const value = finitePositive(candidate);
    if (value > 0) return value;
  }
  return 0;
}

function roundUsdt(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function exposureBudgetTarget(walletBalance, sidePct, leverage = 1, pairCount = 1) {
  const wallet = finitePositive(walletBalance);
  const percent = finitePositive(sidePct);
  const multiplier = finitePositive(leverage);
  const pairs = Number(pairCount);
  if (!(wallet > 0)) throw new Error('Wallet balance must be greater than 0');
  if (!(percent > 0 && percent <= 90)) throw new Error('Side allocation must be greater than 0 and at most 90%');
  if (!(multiplier > 0)) throw new Error('Leverage must be greater than 0');
  if (!Number.isInteger(pairs) || pairs < 1) throw new Error('Pair count must be a positive integer');
  const total = roundUsdt(wallet * percent / 100 * multiplier);
  return {
    symbol: roundUsdt(total / pairs),
    total,
  };
}

function walletChangePct(referenceWalletBalance, walletBalance) {
  const reference = finitePositive(referenceWalletBalance);
  const current = finitePositive(walletBalance);
  if (!(reference > 0) || !(current > 0)) return Infinity;
  return Math.abs(current - reference) / reference * 100;
}

function decideExposureBudget({
  walletBalance,
  sidePct,
  leverage = 1,
  pairCount = 1,
  referencePairCount = pairCount,
  referenceLeverage = leverage,
  referenceSidePct = sidePct,
  currentLimits,
  referenceWalletBalance,
  rebalanceThresholdPct,
  currentExposure = 0,
}) {
  const target = exposureBudgetTarget(walletBalance, sidePct, leverage, pairCount);
  const changePct = walletChangePct(referenceWalletBalance, walletBalance);
  const threshold = Math.max(0, Number(rebalanceThresholdPct) || 0);
  const pairCountChanged = Number(referencePairCount) !== Number(pairCount);
  const leverageChanged = Number(referenceLeverage) !== Number(leverage);
  const sidePctChanged = Number(referenceSidePct) !== Number(sidePct);
  if (!pairCountChanged && !leverageChanged && !sidePctChanged && changePct < threshold) {
    return { action: 'UNCHANGED', target, changePct, limits: currentLimits };
  }

  const currentTotal = finitePositive(currentLimits?.total);
  if (!leverageChanged && !sidePctChanged && target.total > currentTotal && finitePositive(currentExposure) > 0) {
    return {
      action: 'DEFERRED',
      target,
      changePct,
      limits: { ...currentLimits, symbol: Math.min(target.symbol, currentTotal) },
    };
  }

  return { action: 'APPLIED', target, changePct, limits: target };
}

module.exports = {
  decideExposureBudget,
  exposureBudgetTarget,
  walletBalanceUsdt,
  walletChangePct,
};
