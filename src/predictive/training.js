'use strict';

const { labeledRows } = require('./labels');
const { fitAndSelect, evaluateHoldout } = require('./v2-evaluation');
const { settings, rewardRisk } = require('./trade-simulator');

const PROFILES = Object.freeze({
  default: [{ targetPct: 0.9, stopPct: 0.3 }],
  'doge-shadow': [
    { targetPct: 0.9, stopPct: 0.3 },
    { targetPct: 0.75, stopPct: 0.25 },
    { targetPct: 0.6, stopPct: 0.18 },
  ],
});

function trainHorizon(features, candles, horizon, profile = 'default') {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error('Unknown predictive profile: ' + profile);
  const candidates = PROFILES[profile].map(parameters => {
    const config = settings({ horizon, ...parameters });
    if (['LONG', 'SHORT'].some(side => rewardRisk(side, config).ratio < config.minNetRewardRisk)) {
      throw new Error('Training profile fails minimum net reward/risk');
    }
    const samples = labeledRows(features, candles, config);
    return { samples, result: fitAndSelect(samples, config) };
  });
  const viable = candidates.filter(candidate => candidate.result.model.threshold !== null);
  viable.sort((a, b) => b.result.report.validation.netPctNotional -
    a.result.report.validation.netPctNotional);
  const chosen = viable[0] || candidates[0];
  // Holdout is evaluated once, after parameters and threshold are frozen on validation.
  const result = evaluateHoldout(chosen.result, chosen.samples);
  result.report.labeledSamples = chosen.samples.length;
  result.report.parameterSearch = { profile, selectedOn: 'VALIDATION_ONLY',
    candidates: candidates.map(candidate => ({ config: candidate.result.model.config,
      selection: candidate.result.report.selection, validation: candidate.result.report.validation,
      validationMetrics: candidate.result.report.validationMetrics })),
    selectedConfig: chosen.result.model.threshold === null ? null : chosen.result.model.config,
  };
  return result;
}

module.exports = { PROFILES, trainHorizon };
