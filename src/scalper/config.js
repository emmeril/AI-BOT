'use strict';

const path = require('path');
const { readBoolean, readNumber } = require('./environment');

function strategyForSide(environment, side) {
  return {
    side,
    entryMode: 'VOLUME_DELTA_REVERSAL',
    useFlowFilter: true,
    flowWindow: side === 'LONG' ? 1 : 4,
    flowThreshold: 0,
    flowExitThreshold: side === 'LONG' ? 0 : -0.2,
    emaFast: 8,
    emaSlow: 21,
    momentumWindow: side === 'LONG' ? 16 : 4,
    atrPeriod: 14,
    minAtrPct: 0.03,
    maxAtrPct: 2,
    minTrendPct: 0,
    minMomentumPct: side === 'LONG' ? 3 : 2,
    takeProfitPct: readNumber(environment, 'SCALPER_TAKE_PROFIT_PCT', 2),
    stopLossPct: readNumber(environment, 'SCALPER_STOP_LOSS_PCT', 1),
    maxHoldMinutes: readNumber(environment, 'SCALPER_MAX_HOLD_MINUTES', 240),
    cooldownMinutes: readNumber(environment, 'SCALPER_COOLDOWN_MINUTES', 15),
  };
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
    readBoolean(environment, `SCALPER_${side}_ENABLED`, side === 'LONG'));

  return {
    symbols,
    enabled: readBoolean(environment, 'SCALPER_ENABLED', true),
    tradingEnabled: readBoolean(environment, 'SCALPER_TRADING_ENABLED', true),
    intervalMs: Math.max(5000, readNumber(environment, 'SCALPER_INTERVAL_MS', 15000)),
    timeframe: String(environment.SCALPER_TIMEFRAME || '15m'),
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
