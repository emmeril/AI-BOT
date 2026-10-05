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

function zoneForRank(rank, count) {
  if (count <= 1) return 'middle';
  const fraction = rank / count;
  if (fraction <= 1 / 3) return 'upper';
  if (fraction <= 2 / 3) return 'middle';
  return 'lower';
}

function selectSpacedBuyLevels(candidates, multiplier) {
  const descending = [...candidates].sort((left, right) => right.price - left.price);
  if (descending.length < 2 || !(multiplier > 1)) return descending;
  const ascending = [...descending].reverse();
  const logSteps = [];
  for (let index = 1; index < ascending.length; index++) {
    logSteps.push(Math.log(ascending[index].price / ascending[index - 1].price));
  }
  logSteps.sort((left, right) => left - right);
  const minimumLogStep = (logSteps[Math.floor(logSteps.length / 2)] || 0) * multiplier;
  const selected = [];
  for (const candidate of descending) {
    const previous = selected.at(-1);
    if (!previous || Math.log(previous.price / candidate.price) + 1e-12 >= minimumLogStep) {
      selected.push(candidate);
    }
  }
  return selected;
}

function buildAdaptiveBuyPlan(candidates, recommendation, limit = Infinity) {
  const selected = selectSpacedBuyLevels(candidates, recommendation?.spacingMultiplier)
    .slice(0, Math.max(0, Number(limit) || 0));
  return selected.map((candidate, index) => {
    const zone = zoneForRank(index + 1, selected.length);
    return {
      ...candidate,
      zone,
      weight: Math.max(0, Number(recommendation?.buyWeight?.[zone]) || 0),
    };
  });
}

function adaptiveInvestmentLimit(totalInvestment, recommendation) {
  const reservePct = Math.min(100, Math.max(0, Number(recommendation?.reservePct) || 0));
  return Math.max(0, Number(totalInvestment) || 0) * (1 - reservePct / 100);
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

function classificationWithMonitor(analysis, exposureRatio, options = {}, monitorDecision = null) {
  const deterministic = classifyProfile(analysis, exposureRatio, options);
  if (deterministic.profile === PROFILES.RISK_OFF) {
    return {
      ...deterministic,
      source: 'DETERMINISTIC_SAFETY',
      deterministicProfile: deterministic.profile,
    };
  }
  if (!monitorDecision?.accepted || !Object.values(PROFILES).includes(monitorDecision.profile)) {
    return {
      ...deterministic,
      source: 'DETERMINISTIC',
      deterministicProfile: deterministic.profile,
    };
  }
  return {
    profile: monitorDecision.profile,
    reasons: [
      `gemini_${monitorDecision.profile.toLowerCase()}`,
      ...(monitorDecision.riskFactors || []).map(reason => `gemini:${reason}`),
    ],
    features: deterministic.features,
    source: 'GEMINI',
    deterministicProfile: deterministic.profile,
  };
}

class AdaptiveGridSupervisor {
  constructor(options = {}) {
    this.options = {
      minimumConfidence: 0.65,
      profileConfirmations: 3,
      cooldownMs: 120 * 60 * 1000,
      riskExposureRatio: 0.9,
      mode: 'SHADOW',
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

  evaluate(symbol, { analysis, exposureRatio = 0, now = Date.now(), signalId, monitorDecision = null } = {}) {
    if (!analysis) return null;
    const state = this.getState(symbol);
    const resolvedSignalId = String(signalId || analysis.generatedAt || now);
    if (state.lastSignalId === resolvedSignalId && state.lastDecision) {
      return { ...state.lastDecision, evaluated: false };
    }

    const classified = classificationWithMonitor(
      analysis,
      exposureRatio,
      this.options,
      monitorDecision
    );
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
      mode: String(this.options.mode || 'SHADOW').toUpperCase(),
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
      decisionSource: classified.source,
      deterministicProfile: classified.deterministicProfile,
      gemini: monitorDecision ? {
        accepted: Boolean(monitorDecision.accepted),
        profile: monitorDecision.profile || null,
        confidence: monitorDecision.confidence === null || monitorDecision.confidence === undefined
          ? null
          : round(Number(monitorDecision.confidence)),
        reasoning: monitorDecision.reasoning || '',
        riskFactors: monitorDecision.riskFactors || [],
        model: monitorDecision.model || null,
        generatedAt: monitorDecision.generatedAt || null,
        error: monitorDecision.error || null,
      } : null,
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
  classificationWithMonitor,
  marketFeatures,
  recommendationFor,
  zoneForRank,
  selectSpacedBuyLevels,
  buildAdaptiveBuyPlan,
  adaptiveInvestmentLimit,
};
