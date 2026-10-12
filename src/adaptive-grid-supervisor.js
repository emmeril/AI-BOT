const PROFILES = Object.freeze({
  BULLISH: 'BULLISH',
  SIDEWAYS: 'SIDEWAYS',
  BEARISH: 'BEARISH',
  RISK_OFF: 'RISK_OFF',
});

const RISK_STATES = Object.freeze({
  NORMAL: 'NORMAL',
  CAUTION: 'CAUTION',
  RISK_OFF: 'RISK_OFF',
});

const PROFILE_RECOMMENDATIONS = Object.freeze({
  BULLISH: Object.freeze({
    buyWeight: Object.freeze({ upper: 1, middle: 1, lower: 1 }),
    spacingMultiplier: 0.95,
  }),
  SIDEWAYS: Object.freeze({
    buyWeight: Object.freeze({ upper: 1, middle: 1, lower: 1 }),
    spacingMultiplier: 1,
  }),
  BEARISH: Object.freeze({
    buyWeight: Object.freeze({ upper: 0.5, middle: 1, lower: 1.5 }),
    spacingMultiplier: 1.2,
  }),
  RISK_OFF: Object.freeze({
    buyWeight: Object.freeze({ upper: 0.25, middle: 0.5, lower: 1.25 }),
    spacingMultiplier: 1.4,
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
  };
}

function recommendationForRiskState(state, marketRecommendation) {
  const recommendation = marketRecommendation || recommendationFor(PROFILES.SIDEWAYS);
  if (state === RISK_STATES.RISK_OFF) {
    return {
      buyWeight: { upper: 0, middle: 0, lower: 0 },
      spacingMultiplier: Math.max(1.4, Number(recommendation.spacingMultiplier) || 1),
    };
  }
  if (state === RISK_STATES.CAUTION) {
    return {
      buyWeight: {
        upper: Math.min(0.25, Number(recommendation.buyWeight?.upper) || 0),
        middle: Math.min(0.5, Number(recommendation.buyWeight?.middle) || 0),
        lower: Math.min(1, Number(recommendation.buyWeight?.lower) || 0),
      },
      spacingMultiplier: Math.max(1.4, Number(recommendation.spacingMultiplier) || 1),
    };
  }
  return {
    buyWeight: { ...recommendation.buyWeight },
    spacingMultiplier: recommendation.spacingMultiplier,
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

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function assessRiskState(analysis, exposureRatio, riskContext = {}, options = {}) {
  const features = marketFeatures(analysis);
  const minimumConfidence = Number(options.minimumConfidence) || 0.65;
  const cautionExposureRatio = Number(options.cautionExposureRatio) || 0.75;
  const riskExposureRatio = Number(options.riskStateExposureRatio ?? options.riskExposureRatio) || 0.9;
  const lossWarningPct = Math.abs(Number(options.lossWarningPct) || 5);
  const lossRiskOffPct = Math.abs(Number(options.lossRiskOffPct) || 10);
  const liquidationWarningPct = Math.abs(Number(options.liquidationWarningPct) || 12);
  const liquidationCriticalPct = Math.abs(Number(options.liquidationCriticalPct) || 8);
  const unrealizedPnlPct = finiteNumber(riskContext.unrealizedPnlPct);
  const liquidationDistancePct = finiteNumber(riskContext.liquidationDistancePct);
  const marginCallActive = Boolean(riskContext.marginCallActive);
  const confirmedBearish = analysis?.confirmedDirection === PROFILES.BEARISH &&
    features.confidence >= minimumConfidence;
  const marketStress = confirmedBearish && features.aggregateScore <= -0.55 &&
    (features.recentMoveAtr <= -1.5 || features.volatilityRatio >= 1.35);
  const cautionReasons = [];
  const riskOffReasons = [];

  if (confirmedBearish && Number.isFinite(exposureRatio) && exposureRatio >= cautionExposureRatio) {
    cautionReasons.push('high_exposure_with_bearish_direction');
  }
  if (unrealizedPnlPct !== null && unrealizedPnlPct <= -lossWarningPct) {
    cautionReasons.push('unrealized_loss_warning');
  }
  if (liquidationDistancePct !== null && liquidationDistancePct <= liquidationWarningPct) {
    cautionReasons.push('liquidation_distance_warning');
  }

  if (marginCallActive) riskOffReasons.push('margin_call');
  if (unrealizedPnlPct !== null && unrealizedPnlPct <= -lossRiskOffPct) {
    riskOffReasons.push('unrealized_loss_critical');
  }
  if (liquidationDistancePct !== null && liquidationDistancePct <= liquidationCriticalPct) {
    riskOffReasons.push('liquidation_distance_critical');
  }
  if (marketStress && Number.isFinite(exposureRatio) && exposureRatio >= riskExposureRatio) {
    riskOffReasons.push('high_exposure_with_bearish_stress');
  }

  const targetState = riskOffReasons.length
    ? RISK_STATES.RISK_OFF
    : cautionReasons.length
      ? RISK_STATES.CAUTION
      : RISK_STATES.NORMAL;
  return {
    targetState,
    reasons: riskOffReasons.length ? riskOffReasons : cautionReasons,
    observed: {
      exposurePct: round(Number(exposureRatio) * 100, 2),
      unrealizedPnlPct: round(unrealizedPnlPct, 4),
      liquidationDistancePct: round(liquidationDistancePct, 4),
      marginCallActive,
      confirmedBearish,
      marketStress,
    },
  };
}

class RiskStateMachine {
  constructor(options = {}) {
    this.options = {
      cautionConfirmations: 2,
      recoveryConfirmations: 3,
      ...options,
    };
    this.states = new Map();
  }

  getState(symbol) {
    if (!this.states.has(symbol)) {
      this.states.set(symbol, {
        activeState: RISK_STATES.NORMAL,
        candidateState: RISK_STATES.NORMAL,
        candidateCount: 0,
        changedAt: 0,
        lastSignalId: null,
        lastDecision: null,
      });
    }
    return this.states.get(symbol);
  }

  evaluate(symbol, { analysis, exposureRatio = 0, riskContext = {}, now = Date.now(), signalId } = {}) {
    const state = this.getState(symbol);
    const resolvedSignalId = String(signalId || analysis?.generatedAt || now);
    if (state.lastSignalId === resolvedSignalId && state.lastDecision) {
      return { ...state.lastDecision, evaluated: false };
    }

    const assessment = assessRiskState(analysis, exposureRatio, riskContext, this.options);
    if (state.candidateState === assessment.targetState) state.candidateCount += 1;
    else {
      state.candidateState = assessment.targetState;
      state.candidateCount = 1;
    }

    const previousState = state.activeState;
    if (assessment.targetState === RISK_STATES.RISK_OFF) {
      state.activeState = RISK_STATES.RISK_OFF;
    } else if (state.activeState === RISK_STATES.RISK_OFF) {
      const required = Math.max(1, Number(this.options.recoveryConfirmations) || 3);
      if (state.candidateCount >= required) state.activeState = RISK_STATES.CAUTION;
    } else if (state.activeState === RISK_STATES.CAUTION) {
      if (assessment.targetState === RISK_STATES.NORMAL) {
        const required = Math.max(1, Number(this.options.recoveryConfirmations) || 3);
        if (state.candidateCount >= required) state.activeState = RISK_STATES.NORMAL;
      }
    } else if (assessment.targetState === RISK_STATES.CAUTION) {
      const required = Math.max(1, Number(this.options.cautionConfirmations) || 2);
      if (state.candidateCount >= required) state.activeState = RISK_STATES.CAUTION;
    }

    const changed = previousState !== state.activeState;
    if (changed) {
      state.changedAt = now;
      state.candidateState = state.activeState;
      state.candidateCount = 0;
    }
    const decision = {
      evaluated: true,
      state: state.activeState,
      targetState: assessment.targetState,
      previousState,
      changed,
      changedAt: state.changedAt ? new Date(state.changedAt).toISOString() : null,
      candidateState: state.candidateState,
      candidateCount: state.candidateCount,
      reasons: assessment.reasons,
      observed: assessment.observed,
    };
    state.lastSignalId = resolvedSignalId;
    state.lastDecision = decision;
    return decision;
  }
}

function classifyProfile(analysis, exposureRatio, options = {}) {
  const minimumConfidence = Number(options.minimumConfidence) || 0.65;
  const riskExposureRatio = Number(options.riskExposureRatio) || 0.9;
  const features = marketFeatures(analysis);
  const confirmedDirection = analysis?.confirmedDirection || 'RANGING';
  const confidencePasses = features.confidence >= minimumConfidence;
  const reasons = [];

  if (!options.skipLegacySafety && Number.isFinite(exposureRatio) && exposureRatio >= riskExposureRatio) {
    reasons.push(`exposure_${round(exposureRatio * 100, 1)}pct`);
    return { profile: PROFILES.RISK_OFF, reasons, features };
  }

  const sharpBearishMove = features.recentMoveAtr <= -1.5;
  const volatilityExpansion = features.volatilityRatio >= 1.35;
  const strongAggregateBearish = features.aggregateScore <= -0.55;
  if (!options.skipLegacySafety && confirmedDirection === 'BEARISH' && confidencePasses && strongAggregateBearish &&
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
      learning: {
        policyVersion: options.learningPolicy?.version || 'default-v1',
        usedGemini: false,
        reason: 'deterministic_safety',
      },
    };
  }
  const acceptedProfiles = options.skipLegacySafety
    ? [PROFILES.BULLISH, PROFILES.SIDEWAYS, PROFILES.BEARISH]
    : Object.values(PROFILES);
  if (!monitorDecision?.accepted || !acceptedProfiles.includes(monitorDecision.profile)) {
    return {
      ...deterministic,
      source: 'DETERMINISTIC',
      deterministicProfile: deterministic.profile,
      learning: {
        policyVersion: options.learningPolicy?.version || 'default-v1',
        usedGemini: false,
        reason: 'gemini_unavailable_or_rejected',
      },
    };
  }
  const learningPolicy = options.learningPolicy || {};
  const alignment = monitorDecision.profile === deterministic.profile ? 'ALIGNED' : 'CONFLICT';
  const configuredThreshold = alignment === 'ALIGNED'
    ? Number(learningPolicy.alignedMinConfidence ?? 0.6)
    : Number(learningPolicy.conflictMinConfidence ?? 0.6);
  const learnedThreshold = Number.isFinite(configuredThreshold) ? configuredThreshold : 0.6;
  const monitorConfidence = Number(monitorDecision.confidence);
  if (!Number.isFinite(monitorConfidence) || monitorConfidence < learnedThreshold) {
    return {
      ...deterministic,
      reasons: [...deterministic.reasons, `gemini_below_${alignment.toLowerCase()}_threshold`],
      source: 'LEARNING_POLICY',
      deterministicProfile: deterministic.profile,
      learning: {
        policyVersion: learningPolicy.version || 'default-v1',
        alignment,
        threshold: round(learnedThreshold),
        confidence: round(monitorConfidence),
        usedGemini: false,
        reason: 'confidence_below_learned_threshold',
      },
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
    learning: {
      policyVersion: learningPolicy.version || 'default-v1',
      alignment,
      threshold: round(learnedThreshold),
      confidence: round(monitorConfidence),
      usedGemini: true,
      reason: 'confidence_passed_learned_threshold',
    },
  };
}

class AdaptiveGridSupervisor {
  constructor(options = {}) {
    this.options = {
      minimumConfidence: 0.65,
      profileConfirmations: 3,
      cooldownMs: 120 * 60 * 1000,
      riskExposureRatio: 0.9,
      riskStateMachineEnabled: false,
      riskStateMachineMode: 'SHADOW',
      mode: 'SHADOW',
      ...options,
    };
    this.riskStateMachine = new RiskStateMachine(this.options);
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

  evaluate(symbol, {
    analysis,
    exposureRatio = 0,
    riskContext = {},
    now = Date.now(),
    signalId,
    monitorDecision = null,
    learningPolicy = null,
  } = {}) {
    if (!analysis) return null;
    const state = this.getState(symbol);
    const resolvedSignalId = String(signalId || analysis.generatedAt || now);
    if (state.lastSignalId === resolvedSignalId && state.lastDecision) {
      return { ...state.lastDecision, evaluated: false };
    }

    const riskStateMachineEnabled = Boolean(this.options.riskStateMachineEnabled);
    const riskStateMachineMode = String(this.options.riskStateMachineMode || 'SHADOW').toUpperCase();
    const riskDecision = riskStateMachineEnabled
      ? this.riskStateMachine.evaluate(symbol, {
        analysis,
        exposureRatio,
        riskContext,
        now,
        signalId: resolvedSignalId,
      })
      : null;
    const classified = classificationWithMonitor(
      analysis,
      exposureRatio,
      {
        ...this.options,
        skipLegacySafety: riskStateMachineEnabled && riskStateMachineMode === 'LIVE',
        learningPolicy,
      },
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

    const marketRecommendation = recommendationFor(state.activeProfile);
    const recommendation = riskStateMachineEnabled && riskStateMachineMode === 'LIVE'
      ? recommendationForRiskState(riskDecision.state, marketRecommendation)
      : marketRecommendation;
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
      learning: classified.learning || null,
      riskStateMachineMode: riskStateMachineEnabled ? riskStateMachineMode : 'OFF',
      riskState: riskDecision?.state || null,
      riskTargetState: riskDecision?.targetState || null,
      riskStateChanged: Boolean(riskDecision?.changed),
      riskReasons: riskDecision?.reasons || [],
      riskObserved: riskDecision?.observed || null,
      gemini: monitorDecision ? {
        accepted: Boolean(monitorDecision.accepted),
        profile: monitorDecision.profile || null,
        confidence: monitorDecision.confidence === null || monitorDecision.confidence === undefined
          ? null
          : round(Number(monitorDecision.confidence)),
        reasoning: monitorDecision.reasoning || '',
        riskFactors: monitorDecision.riskFactors || [],
        scorecard: monitorDecision.scorecard || null,
        model: monitorDecision.model || null,
        generatedAt: monitorDecision.generatedAt || null,
        stale: Boolean(monitorDecision.stale),
        staleAgeMs: Number(monitorDecision.staleAgeMs) || 0,
        error: monitorDecision.error || null,
      } : null,
      reasons: classified.reasons,
      features: Object.fromEntries(
        Object.entries(classified.features).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])
      ),
      recommendation,
    };
    state.lastSignalId = resolvedSignalId;
    state.lastDecision = decision;
    return decision;
  }
}

module.exports = {
  PROFILES,
  RISK_STATES,
  PROFILE_RECOMMENDATIONS,
  AdaptiveGridSupervisor,
  RiskStateMachine,
  assessRiskState,
  classifyProfile,
  classificationWithMonitor,
  marketFeatures,
  recommendationFor,
  recommendationForRiskState,
  zoneForRank,
  selectSpacedBuyLevels,
  buildAdaptiveBuyPlan,
};
