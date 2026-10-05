const PROFILES = Object.freeze({
  BULLISH: 'BULLISH',
  SIDEWAYS: 'SIDEWAYS',
  BEARISH: 'BEARISH',
  RISK_OFF: 'RISK_OFF',
});

const PROFILE_RECOMMENDATIONS = Object.freeze({
  BULLISH: Object.freeze({
    buyWeight: Object.freeze({ upper: 1, middle: 1, lower: 1 }),
    spacingMultiplier: 0.95,
    reservePct: 10,
  }),
  SIDEWAYS: Object.freeze({
    buyWeight: Object.freeze({ upper: 1, middle: 1, lower: 1 }),
    spacingMultiplier: 1,
    reservePct: 0,
  }),
  BEARISH: Object.freeze({
    buyWeight: Object.freeze({ upper: 0.5, middle: 1, lower: 1.5 }),
    spacingMultiplier: 1.2,
    reservePct: 30,
  }),
  RISK_OFF: Object.freeze({
    buyWeight: Object.freeze({ upper: 0.25, middle: 0.5, lower: 1.25 }),
    spacingMultiplier: 1.4,
    reservePct: 50,
  }),
});

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function recommendationFor(profile) {
  const source = PROFILE_RECOMMENDATIONS[profile] || PROFILE_RECOMMENDATIONS.SIDEWAYS;
  return {
    buyWeight: { ...source.buyWeight },
    spacingMultiplier: source.spacingMultiplier,
    reservePct: source.reservePct,
  };
}

function marketFeatures(analysis) {
  const short = analysis?.timeframes?.['15m'] || {};
  return {
    aggregateScore: Number(analysis?.score),
    confidence: Number(analysis?.confidence),
    shortDirection: short.direction || 'UNCERTAIN',
    shortScore: Number(short.score),
    atrPct: Number(short.atrPct),
    volatilityRatio: Number(short.volatilityRatio),
    recentMoveAtr: Number(short.recentMoveAtr),
  };
}

function classifyProfile(analysis, exposureRatio, options = {}) {
  const minimumConfidence = Number(options.minimumConfidence) || 0.65;
  const riskExposureRatio = Number(options.riskExposureRatio) || 0.9;
  const features = marketFeatures(analysis);
  const confirmedDirection = analysis?.confirmedDirection || 'RANGING';
  const confidencePasses = features.confidence >= minimumConfidence;
  const reasons = [];

  if (Number.isFinite(exposureRatio) && exposureRatio >= riskExposureRatio) {
    reasons.push(`exposure_${round(exposureRatio * 100, 1)}pct`);
    return { profile: PROFILES.RISK_OFF, reasons, features };
  }

  const sharpBearishMove = features.recentMoveAtr <= -1.5;
  const volatilityExpansion = features.volatilityRatio >= 1.35;
  const strongAggregateBearish = features.aggregateScore <= -0.55;
  if (confirmedDirection === 'BEARISH' && confidencePasses && strongAggregateBearish &&
      (sharpBearishMove || volatilityExpansion)) {
    reasons.push('confirmed_bearish', 'strong_bearish_score');
    if (sharpBearishMove) reasons.push('sharp_15m_drop');
    if (volatilityExpansion) reasons.push('volatility_expansion');
    return { profile: PROFILES.RISK_OFF, reasons, features };
  }

  if (confirmedDirection === 'BEARISH' && confidencePasses) {
    reasons.push('confirmed_bearish');
    return { profile: PROFILES.BEARISH, reasons, features };
  }
  if (confirmedDirection === 'BULLISH' && confidencePasses) {
    reasons.push('confirmed_bullish');
    return { profile: PROFILES.BULLISH, reasons, features };
  }

  reasons.push(confidencePasses ? 'no_confirmed_direction' : 'confidence_below_threshold');
  return { profile: PROFILES.SIDEWAYS, reasons, features };
}

class AdaptiveGridSupervisor {
  constructor(options = {}) {
    this.options = {
      minimumConfidence: 0.65,
      profileConfirmations: 3,
      cooldownMs: 120 * 60 * 1000,
      riskExposureRatio: 0.9,
      ...options,
    };
    this.states = new Map();
  }

  getState(symbol) {
    if (!this.states.has(symbol)) {
      this.states.set(symbol, {
        activeProfile: PROFILES.SIDEWAYS,
        candidateProfile: PROFILES.SIDEWAYS,
        candidateCount: 0,
        lastChangedAt: 0,
        lastSignalId: null,
        lastDecision: null,
      });
    }
    return this.states.get(symbol);
  }

  evaluate(symbol, { analysis, exposureRatio = 0, now = Date.now(), signalId } = {}) {
    if (!analysis) return null;
    const state = this.getState(symbol);
    const resolvedSignalId = String(signalId || analysis.generatedAt || now);
    if (state.lastSignalId === resolvedSignalId && state.lastDecision) {
      return { ...state.lastDecision, evaluated: false };
    }

    const classified = classifyProfile(analysis, exposureRatio, this.options);
    if (state.candidateProfile === classified.profile) state.candidateCount += 1;
    else {
      state.candidateProfile = classified.profile;
      state.candidateCount = 1;
    }

    const confirmationsRequired = classified.profile === PROFILES.RISK_OFF
      ? 1
      : Math.max(1, Number(this.options.profileConfirmations) || 2);
    const cooldownElapsed = now - state.lastChangedAt >= Math.max(0, Number(this.options.cooldownMs) || 0);
    const canChangeProfile = classified.profile === PROFILES.RISK_OFF || cooldownElapsed;
    const previousProfile = state.activeProfile;
    if (classified.profile !== state.activeProfile &&
        state.candidateCount >= confirmationsRequired && canChangeProfile) {
      state.activeProfile = classified.profile;
      state.lastChangedAt = now;
    }

    const decision = {
      mode: 'SHADOW',
      symbol,
      evaluated: true,
      generatedAt: new Date(now).toISOString(),
      signalId: resolvedSignalId,
      profile: state.activeProfile,
      rawProfile: classified.profile,
      previousProfile,
      changed: previousProfile !== state.activeProfile,
      candidateProfile: state.candidateProfile,
      candidateCount: state.candidateCount,
      confirmationsRequired,
      cooldownElapsed,
      exposurePct: round(Number(exposureRatio) * 100, 2),
      reasons: classified.reasons,
      features: Object.fromEntries(
        Object.entries(classified.features).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])
      ),
      recommendation: recommendationFor(state.activeProfile),
    };
    state.lastSignalId = resolvedSignalId;
    state.lastDecision = decision;
    return decision;
  }
}

module.exports = {
  PROFILES,
  PROFILE_RECOMMENDATIONS,
  AdaptiveGridSupervisor,
  classifyProfile,
  marketFeatures,
  recommendationFor,
};
