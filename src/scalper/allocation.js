'use strict';

function walletBalance(balance) {
  const candidates = [
    balance?.info?.totalWalletBalance,
    balance?.total?.USDT,
    balance?.USDT?.total,
  ].map(Number).filter(Number.isFinite);
  return candidates.find(value => value > 0) || 0;
}

function targetNotional(wallet, allocationPct, leverage, pairCount) {
  const walletValue = Number(wallet);
  const pairs = Number(pairCount);
  if (!(walletValue > 0) || !(pairs > 0)) return 0;
  return walletValue * Number(allocationPct) / 100 * Number(leverage) / pairs;
}

module.exports = {
  targetNotional,
  walletBalance,
};
