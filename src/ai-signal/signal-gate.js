'use strict';

function direction(value, threshold) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'N';
  if (number >= threshold) return 'L';
  if (number <= -threshold) return 'S';
  return 'N';
}

function featureRegimeKey(snapshots) {
  return snapshots.map(snapshot => {
    const votes = [
      direction(snapshot.emaGapPct, 0.05),
      direction(snapshot.returnsPct?.h1, 0.15),
      direction(snapshot.flowDelta?.h1, 0.05),
    ];
    const longVotes = votes.filter(value => value === 'L').length;
    const shortVotes = votes.filter(value => value === 'S').length;
    const regime = longVotes >= 2 ? 'L' : shortVotes >= 2 ? 'S' : 'H';
    const volatility = Number(snapshot.atrPct) > 2 ? 'V' : Number(snapshot.atrPct) < 0.05 ? 'Q' : 'C';
    return [snapshot.symbol, regime, volatility].join(':');
  }).join('|');
}

function shouldRequestProvider(state, snapshots, now, maximumRefreshMs, confirmationCandles = 2) {
  const featureKey = featureRegimeKey(snapshots);
  const lastProviderCallAt = Number(state.lastProviderCallAt) || 0;
  const pendingFeatureCount = featureKey === state.pendingFeatureKey
    ? Number(state.pendingFeatureCount || 0) + 1
    : 1;
  const result = {
    allow: false,
    reason: 'market feature regime unchanged',
    featureKey,
    pendingFeatureKey: featureKey,
    pendingFeatureCount,
  };
  if (!lastProviderCallAt) {
    return { ...result, allow: true, reason: 'initial assessment' };
  }
  if (featureKey !== state.lastFeatureKey && pendingFeatureCount >= confirmationCandles) {
    return { ...result, allow: true, reason: 'confirmed market feature regime change' };
  }
  if (now - lastProviderCallAt >= maximumRefreshMs) {
    return { ...result, allow: true, reason: 'maximum refresh interval reached' };
  }
  return result;
}

module.exports = {
  featureRegimeKey,
  shouldRequestProvider,
};
