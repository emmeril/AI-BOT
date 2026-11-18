'use strict';

const DEFAULTS = Object.freeze({
  horizon: 30,
  targetPct: 0.9,
  stopPct: 0.3,
  feePct: 0.05,
  slippagePct: 0.02,
  minNetRewardRisk: 1.5,
});

function settings(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const keys = ['horizon', 'targetPct', 'stopPct', 'feePct', 'slippagePct', 'minNetRewardRisk'];
  if (keys.some(key => !Number.isFinite(config[key])) ||
      !Number.isInteger(config.horizon) || config.horizon < 1 || config.horizon > 1440 ||
      config.targetPct <= 0 || config.stopPct <= 0 ||
      config.feePct < 0 || config.slippagePct < 0 ||
      config.minNetRewardRisk < 1) {
    throw new Error('Invalid predictive trading assumptions');
  }
  return config;
}

function netReturnPct(side, entryPrice, exitRaw, config) {
  const direction = side === 'LONG' ? 1 : -1;
  const exitFill = exitRaw * (1 - direction * config.slippagePct / 100);
  const gross = direction * (exitFill / entryPrice - 1) * 100;
  const fees = config.feePct * (1 + exitFill / entryPrice);
  return gross - fees;
}

function rewardRisk(side, options = {}) {
  const config = settings(options);
  if (side !== 'LONG' && side !== 'SHORT') throw new Error('Invalid trade side');
  const direction = side === 'LONG' ? 1 : -1;
  const entryFill = 100 * (1 + direction * config.slippagePct / 100);
  const target = entryFill * (1 + direction * config.targetPct / 100);
  const stop = entryFill * (1 - direction * config.stopPct / 100);
  const reward = netReturnPct(side, entryFill, target, config);
  const risk = -netReturnPct(side, entryFill, stop, config);
  return { rewardPct: reward, riskPct: risk,
    ratio: reward > 0 && risk > 0 ? reward / risk : 0,
    breakEvenProbability: reward > 0 && risk > 0 ? risk / (reward + risk) : 1 };
}

function simulateExit(candles, signalIndex, side, options = {}) {
  const config = settings(options);
  if (side !== 'LONG' && side !== 'SHORT') throw new Error('Invalid trade side');
  const last = signalIndex + config.horizon;
  if (!Number.isInteger(signalIndex) || signalIndex < 0 ||
      last >= candles.length || !candles[signalIndex + 1]) return null;
  const direction = side === 'LONG' ? 1 : -1;
  const rawEntry = candles[signalIndex + 1].open;
  const entryFill = rawEntry * (1 + direction * config.slippagePct / 100);
  const stop = entryFill * (1 - direction * config.stopPct / 100);
  const target = entryFill * (1 + direction * config.targetPct / 100);
  let exitRaw = candles[last].close;
  let exitIndex = last;
  let reason = 'TIMEOUT';
  let ambiguous = false;

  for (let index = signalIndex + 1; index <= last; index++) {
    const candle = candles[index];
    const stopGap = direction > 0 ? candle.open <= stop : candle.open >= stop;
    const targetGap = direction > 0 ? candle.open >= target : candle.open <= target;
    const stopHit = direction > 0 ? candle.low <= stop : candle.high >= stop;
    const targetHit = direction > 0 ? candle.high >= target : candle.low <= target;
    if (stopGap) {
      exitRaw = candle.open;
      exitIndex = index;
      reason = 'STOP_GAP';
      break;
    }
    if (targetGap) {
      exitRaw = target;
      exitIndex = index;
      reason = 'TARGET';
      break;
    }
    if (stopHit) {
      exitRaw = stop;
      exitIndex = index;
      ambiguous = targetHit;
      reason = targetHit ? 'STOP_AMBIGUOUS' : 'STOP';
      break;
    }
    if (targetHit) {
      exitRaw = target;
      exitIndex = index;
      reason = 'TARGET';
      break;
    }
  }

  return { side, entryIndex: signalIndex + 1, exitIndex,
    entryPrice: entryFill, exitPrice: exitRaw * (1 - direction * config.slippagePct / 100),
    netPct: netReturnPct(side, entryFill, exitRaw, config),
    reason, ambiguous, targetHit: reason === 'TARGET' };
}

module.exports = { DEFAULTS, settings, netReturnPct, rewardRisk, simulateExit };
