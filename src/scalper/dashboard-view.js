'use strict';

const fs = require('fs');
const path = require('path');
const { booleanValue } = require('./environment');
const { fetchOpenAlgoOrders, scalperProtectionSnapshot } = require('./order-inspection');

function numberOrZero(value) {
  return Number(value) || 0;
}

function pauseReason(environment = process.env, fileSystem = fs) {
  if (!booleanValue(environment.SCALPER_TRADING_ENABLED, true)) {
    return 'Trading scalper dimatikan dari konfigurasi';
  }
  if (booleanValue(environment.STOP_TRADING, false)) return 'STOP_TRADING aktif';
  if (!booleanValue(environment.KILL_SWITCH_ENABLED, true)) return null;
  const killSwitchPath = path.resolve(environment.KILL_SWITCH_FILE || 'bot-paused.flag');
  try {
    return fileSystem.existsSync(killSwitchPath) ? 'Kill switch Telegram aktif' : null;
  } catch {
    return 'Status kill switch tidak dapat diperiksa';
  }
}

async function fetchAlgoOrders(exchange, symbol) {
  if (typeof exchange.fapiPrivateGetOpenAlgoOrders !== 'function') {
    return { available: false, orders: [], error: 'API algo order tidak tersedia' };
  }
  try {
    return {
      available: true,
      orders: await fetchOpenAlgoOrders(exchange, symbol),
      error: null,
    };
  } catch (error) {
    return { available: false, orders: [], error: error.message };
  }
}

function buildDashboardView({
  environment = process.env,
  symbolState,
  positionSide,
  rawPosition,
  algoOrderResult,
  longSymbols = [],
  shortSymbols = [],
  formatPrice = value => String(value ?? ''),
  formatAmount = value => String(value ?? ''),
} = {}) {
  const selectedSide = String(positionSide || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const state = symbolState || {};
  const ordersResult = algoOrderResult || { available: false, orders: [], error: 'Belum diperiksa' };
  const handoffActive = state.handoffActive === true;
  const totalAllocationPct = numberOrZero(environment.SCALPER_ALLOCATION_PCT || 70);
  const longAllocationPct = numberOrZero(environment.SCALPER_LONG_ALLOCATION_PCT || totalAllocationPct / 2);
  const shortAllocationPct = numberOrZero(environment.SCALPER_SHORT_ALLOCATION_PCT || totalAllocationPct / 2);
  const enabled = booleanValue(environment.SCALPER_ENABLED, true);
  const sideEnabled = booleanValue(
    environment[`SCALPER_${selectedSide}_ENABLED`],
    selectedSide === 'LONG'
  );
  const stoppedBecause = pauseReason(environment);
  const tradingEnabled = enabled && handoffActive && sideEnabled && !stoppedBecause;
  const protection = scalperProtectionSnapshot(ordersResult.orders, selectedSide, Boolean(rawPosition));
  protection.available = ordersResult.available;
  protection.error = ordersResult.error;
  if (rawPosition && !ordersResult.available) {
    protection.status = 'UNKNOWN';
    protection.covered = false;
  }
  const pairCount = new Set([...longSymbols, ...shortSymbols]).size || longSymbols.length || shortSymbols.length;
  const displayedOrders = handoffActive
    ? protection.orders.map(order => ({
        id: order.id,
        side: order.side,
        price: numberOrZero(order.triggerPrice),
        priceText: formatPrice(order.triggerPrice),
        amount: numberOrZero(rawPosition?.contracts),
        amountText: formatAmount(rawPosition?.contracts),
        remaining: numberOrZero(rawPosition?.contracts),
        remainingText: formatAmount(rawPosition?.contracts),
        level: null,
        orderType: order.kind,
        entryComparison: order.kind === 'TAKE_PROFIT' ? 'Take profit scalper' : 'Stop loss scalper',
        isAlgo: true,
      }))
    : null;

  return {
    handoffActive,
    tradingEnabled,
    displayedOrders,
    snapshot: {
      enabled,
      tradingEnabled,
      configuredTradingEnabled: booleanValue(environment.SCALPER_TRADING_ENABLED, true),
      paused: Boolean(stoppedBecause),
      pauseReason: stoppedBecause,
      handoffActive,
      phase: handoffActive ? (rawPosition ? 'POSITION_ACTIVE' : 'READY') : 'LEGACY_EXIT',
      selectedSide,
      sideEnabled,
      longEnabled: booleanValue(environment.SCALPER_LONG_ENABLED, true),
      shortEnabled: booleanValue(environment.SCALPER_SHORT_ENABLED, false),
      timeframe: String(environment.SCALPER_TIMEFRAME || '15m'),
      strategy: 'VOLUME_DELTA_REVERSAL',
      pairCount,
      allocationPct: longAllocationPct + shortAllocationPct,
      longAllocationPct,
      shortAllocationPct,
      takeProfitPct: numberOrZero(environment.SCALPER_TAKE_PROFIT_PCT || 2),
      stopLossPct: numberOrZero(environment.SCALPER_STOP_LOSS_PCT || 1),
      maxHoldMinutes: numberOrZero(environment.SCALPER_MAX_HOLD_MINUTES || 240),
      trackedPosition: state.positions?.[selectedSide] || null,
      signal: state.signals?.[selectedSide] || null,
      protection,
      activatedAt: state.activatedAt || null,
      cooldownUntil: numberOrZero(state.cooldownUntil?.[selectedSide]) || null,
    },
  };
}

module.exports = {
  buildDashboardView,
  fetchAlgoOrders,
  pauseReason,
};
