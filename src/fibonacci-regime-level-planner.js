const DEFAULT_OPTIONS = Object.freeze({
  timeframe: '15m',
  adxTrendThreshold: 20,
  alignedAtrGap: 0.25,
  rangingAtrGap: 0.5,
  adverseAtrGap: 1,
  highVolatilityRatio: 1.25,
  highVolatilityGapMultiplier: 1.25,
  adverseMaxLevels: null,
});

function relationFor(structure, positionSide) {
  if (!['BULLISH', 'BEARISH'].includes(structure)) return 'RANGING';
  const aligned = (positionSide === 'SHORT' && structure === 'BEARISH') ||
    (positionSide !== 'SHORT' && structure === 'BULLISH');
  return aligned ? 'ALIGNED' : 'ADVERSE';
}

function planFibonacciRegimeLevels(candidates, currentPrice, positionSide, analysis, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const input = Array.isArray(candidates) ? candidates.filter(candidate =>
    Number(candidate?.price) > 0
  ) : [];
  const timeframe = analysis?.timeframes?.[settings.timeframe];
  const atr = Number(timeframe?.atr14);
  const adx = Number(timeframe?.adx14);
  const structure = String(timeframe?.structure || 'RANGING').toUpperCase();
  if (!input.length || !(currentPrice > 0) || !(atr > 0) || !Number.isFinite(adx)) {
    return {
      levels: input,
      decision: { available: false, relation: 'RANGING', structure, adx, atr, minGap: 0 },
    };
  }

  const trendIsStrong = adx >= Number(settings.adxTrendThreshold);
  const relation = trendIsStrong ? relationFor(structure, String(positionSide).toUpperCase()) : 'RANGING';
  const gapAtr = relation === 'ALIGNED'
    ? Number(settings.alignedAtrGap)
    : relation === 'ADVERSE'
      ? Number(settings.adverseAtrGap)
      : Number(settings.rangingAtrGap);
  const volatilityMultiplier = Number(timeframe.volatilityRatio) >= Number(settings.highVolatilityRatio)
    ? Number(settings.highVolatilityGapMultiplier)
    : 1;
  const minGap = Math.max(0, atr * gapAtr * volatilityMultiplier);
  const selected = [];
  for (const candidate of input) {
    if (Math.abs(Number(candidate.price) - currentPrice) + 1e-12 < minGap) continue;
    if (selected.length && Math.abs(Number(candidate.price) - Number(selected.at(-1).price)) + 1e-12 < minGap) {
      continue;
    }
    selected.push(candidate);
  }
  if (!selected.length) selected.push(input.at(-1));
  const adverseMaxLevels = Math.floor(Number(settings.adverseMaxLevels));
  const levels = relation === 'ADVERSE' && adverseMaxLevels > 0
    ? selected.slice(-adverseMaxLevels)
    : selected;
  return {
    levels,
    decision: {
      available: true,
      relation,
      structure,
      adx,
      atr,
      gapAtr,
      minGap,
      volatilityMultiplier,
      inputCount: input.length,
      outputCount: levels.length,
    },
  };
}

module.exports = { DEFAULT_OPTIONS, relationFor, planFibonacciRegimeLevels };
