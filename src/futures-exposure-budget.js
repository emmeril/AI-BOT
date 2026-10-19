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

function exposureBudgetTarget(walletBalance, sidePct, symbolCeiling) {
  const wallet = finitePositive(walletBalance);
  const percent = finitePositive(sidePct);
  const ceiling = finitePositive(symbolCeiling);
  if (!(wallet > 0)) throw new Error('Wallet balance must be greater than 0');
  if (!(percent > 0 && percent <= 50)) throw new Error('Side allocation must be greater than 0 and at most 50%');
  if (!(ceiling > 0)) throw new Error('Symbol exposure ceiling must be greater than 0');
  const total = roundUsdt(wallet * percent / 100);
  return {
    symbol: Math.min(ceiling, total),
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
  symbolCeiling,
  currentLimits,
  referenceWalletBalance,
  rebalanceThresholdPct,
  currentExposure = 0,
}) {
  const target = exposureBudgetTarget(walletBalance, sidePct, symbolCeiling);
  const changePct = walletChangePct(referenceWalletBalance, walletBalance);
  const threshold = Math.max(0, Number(rebalanceThresholdPct) || 0);
  if (changePct < threshold) {
    return { action: 'UNCHANGED', target, changePct, limits: currentLimits };
  }

  const currentTotal = finitePositive(currentLimits?.total);
  if (target.total > currentTotal && finitePositive(currentExposure) > 0) {
    return { action: 'DEFERRED', target, changePct, limits: currentLimits };
  }

  return { action: 'APPLIED', target, changePct, limits: target };
}

module.exports = {
  decideExposureBudget,
  exposureBudgetTarget,
  walletBalanceUsdt,
  walletChangePct,
};
