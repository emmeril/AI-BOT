'use strict';

const path = require('path');
const { readBoolean, readNumber } = require('./environment');

function strategyForSide(environment, side) {
  const strategy = {
    side,
    entryMode: 'MA_CROSS',
    exitMode: 'HISTORICAL_CROSS',
    stopMode: 'HISTORICAL_CROSS',
    crossSelection: {
      priority: 'higherFirst', rank: 'retests', minimumRetests: 1,
      targetIndex: 2, stopIndex: 1, requireNetTarget: true,
    },
    // Percentage settings are retained for positions opened before the SR migration.
    takeProfitPct: readNumber(environment, 'SCALPER_TAKE_PROFIT_PCT', 0.35),
    stopLossPct: readNumber(environment, 'SCALPER_STOP_LOSS_PCT', 0.3),
    maxHoldMinutes: null,
    cooldownMinutes: 0,
    countertrendTakeProfitPct: readNumber(environment, 'SCALPER_COUNTERTREND_TAKE_PROFIT_PCT', 0.2),
    countertrendStopLossPct: readNumber(environment, 'SCALPER_COUNTERTREND_STOP_LOSS_PCT', 0.15),
    countertrendMaxHoldMinutes: null,
    countertrendSizeMultiplier: readNumber(environment, 'SCALPER_COUNTERTREND_SIZE_MULTIPLIER', 0.25),
  };
  for (const key of ['takeProfitPct', 'stopLossPct',
    'countertrendTakeProfitPct', 'countertrendStopLossPct']) {
    if (!(strategy[key] > 0)) throw new Error(`Invalid scalper ${key}: must be positive`);
  }
  if (!(strategy.countertrendSizeMultiplier > 0 && strategy.countertrendSizeMultiplier < 1)) {
    throw new Error('SCALPER_COUNTERTREND_SIZE_MULTIPLIER must be between 0 and 1');
  }
  if (strategy.cooldownMinutes < 0) throw new Error('Scalper cooldown must not be negative');
  return strategy;
}

function buildScalperConfig(environment = process.env) {
  const symbols = String(environment.SYMBOLS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const totalAllocationPct = readNumber(environment, 'SCALPER_ALLOCATION_PCT', 70);
  const strategies = {
    LONG: strategyForSide(environment, 'LONG'),
    SHORT: strategyForSide(environment, 'SHORT'),
  };
  const activeSides = ['LONG', 'SHORT'].filter(side =>
    readBoolean(environment, `SCALPER_${side}_ENABLED`, true));

  return {
    symbols,
    enabled: readBoolean(environment, 'SCALPER_ENABLED', true),
    tradingEnabled: readBoolean(environment, 'SCALPER_TRADING_ENABLED', true),
    intervalMs: Math.max(5000, readNumber(environment, 'SCALPER_INTERVAL_MS', 15000)),
    timeframe: '1m',
    contextTimeframes: ['15m', '1h', '4h'],
    allocationPct: totalAllocationPct,
    allocations: {
      LONG: readNumber(environment, 'SCALPER_LONG_ALLOCATION_PCT', totalAllocationPct / 2),
      SHORT: readNumber(environment, 'SCALPER_SHORT_ALLOCATION_PCT', totalAllocationPct / 2),
    },
    leverage: readNumber(environment, 'LEVERAGE', 5),
    stopTrading: readBoolean(environment, 'STOP_TRADING', false),
    killSwitchEnabled: readBoolean(environment, 'KILL_SWITCH_ENABLED', true),
    killSwitchPath: path.resolve(environment.KILL_SWITCH_FILE || 'bot-paused.flag'),
    statePath: path.resolve(environment.SCALPER_STATE_FILE || 'futures-scalper-state.json'),
    aiSignal: {
      liveEnabled: false,
      statePath: path.resolve(environment.AI_SIGNAL_SHADOW_STATE_FILE || 'ai-signal-shadow-state.json'),
      minimumConfidence: readNumber(environment, 'AI_SIGNAL_MIN_CONFIDENCE', 65),
      maximumAgeMs: readNumber(environment, 'AI_SIGNAL_MAX_AGE_MS', 4 * 60 * 60_000),
    },
    strategies,
    strategy: strategies.SHORT,
    activeSides,
  };
}

module.exports = {
  booleanValue: readBoolean,
  buildScalperConfig,
  numberValue: readNumber,
  strategyForSide,
};
