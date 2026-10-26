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

function stagedSideAllocation({
  walletBalance,
  leverage = 1,
  oppositeExposure = 0,
  currentSidePct,
  maximumSidePct,
  startingSidePct,
  stepPct,
  reservedMarginPct,
  promotionConfirmations = 0,
  requiredConfirmations = 1,
}) {
  const wallet = finitePositive(walletBalance);
  const multiplier = finitePositive(leverage);
  const maximum = finitePositive(maximumSidePct);
  const starting = finitePositive(startingSidePct);
  const step = finitePositive(stepPct);
  const reserved = Math.max(0, Number(reservedMarginPct) || 0);
  const required = Math.max(1, Math.floor(Number(requiredConfirmations) || 1));
  if (!(wallet > 0) || !(multiplier > 0)) throw new Error('Wallet and leverage must be positive');
  if (!(maximum > 0 && maximum <= 90)) throw new Error('Maximum side allocation must be at most 90%');
  if (!(starting > 0 && starting <= maximum)) throw new Error('Starting side allocation must not exceed maximum');
  if (!(step > 0)) throw new Error('Allocation step must be positive');
  if (!(reserved >= 0 && reserved < 100)) throw new Error('Reserved margin must be below 100%');

  const walletNotional = wallet * multiplier;
  const oppositePct = Math.max(0, Number(oppositeExposure) || 0) / walletNotional * 100;
  const rawSafePct = Math.max(0, 100 - reserved - oppositePct);
  const safeMaximumPct = Math.min(
    maximum,
    Math.floor((rawSafePct + 1e-9) / step) * step
  );
  const current = Math.max(0, Math.min(maximum, Number(currentSidePct) || starting));

  if (safeMaximumPct < current) {
    return {
      sidePct: safeMaximumPct >= starting ? safeMaximumPct : 0,
      safeMaximumPct,
      oppositePct,
      promotionConfirmations: 0,
      action: 'REDUCED',
    };
  }
  if (safeMaximumPct <= current) {
    return {
      sidePct: current,
      safeMaximumPct,
      oppositePct,
      promotionConfirmations: 0,
      action: 'UNCHANGED',
    };
  }

  const confirmations = Math.max(0, Math.floor(Number(promotionConfirmations) || 0)) + 1;
  if (confirmations < required) {
    return {
      sidePct: current,
      safeMaximumPct,
      oppositePct,
      promotionConfirmations: confirmations,
      action: 'CONFIRMING',
    };
  }
  return {
    sidePct: Math.min(safeMaximumPct, current > 0 ? current + step : starting),
    safeMaximumPct,
    oppositePct,
    promotionConfirmations: 0,
    action: 'PROMOTED',
  };
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
  const hasReferenceWallet = finitePositive(referenceWalletBalance) > 0;
  if (hasReferenceWallet && !leverageChanged && !sidePctChanged && target.total > currentTotal && finitePositive(currentExposure) > 0) {
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
  stagedSideAllocation,
  walletBalanceUsdt,
  walletChangePct,
};
