const fs = require('fs');
const http = require('http');
const path = require('path');
const { retry, numberOrZero } = require('./utils');
const { createDashboardAuth } = require('./dashboard-auth');
const { exposureBySymbol } = require('./futures-exposure');
const { incomeMetrics } = require('./futures-income');
const { sellEntryLabel } = require('./futures-display');
const { resolveAppliedDirection } = require('./fibonacci-direction-analyzer');
const { timeframeToMs } = require('./fibonacci-range-advisor');
const {
  marketPrice,
  marketPriceText,
  marketAmountText,
  precisionDigits,
  normalizeOrder,
} = require('./dashboard-server');

const dashboardFile = path.join(__dirname, '..', 'public', 'dashboard.html');
const dashboardAssets = new Map([
  ['/dashboard.css', { file: path.join(__dirname, '..', 'public', 'dashboard.css'), type: 'text/css; charset=utf-8' }],
  ['/dashboard.js', { file: path.join(__dirname, '..', 'public', 'dashboard.js'), type: 'text/javascript; charset=utf-8' }],
  ['/fontawesome/css/fontawesome.min.css', { file: path.join(__dirname, '..', 'node_modules', '@fortawesome', 'fontawesome-free', 'css', 'fontawesome.min.css'), type: 'text/css; charset=utf-8' }],
  ['/fontawesome/css/solid.min.css', { file: path.join(__dirname, '..', 'node_modules', '@fortawesome', 'fontawesome-free', 'css', 'solid.min.css'), type: 'text/css; charset=utf-8' }],
  ['/fontawesome/webfonts/fa-solid-900.woff2', { file: path.join(__dirname, '..', 'node_modules', '@fortawesome', 'fontawesome-free', 'webfonts', 'fa-solid-900.woff2'), type: 'font/woff2' }],
]);
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);
function envBoolean(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(`${key} must be a boolean value`);
}
function envNumber(key, fallback, minimum = 0) {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${key} must be a numeric value >= ${minimum}`);
  }
  return parsed;
}

const enabled = envBoolean('FUTURES_DASHBOARD_ENABLED', true);
const host = process.env.FUTURES_DASHBOARD_HOST || '127.0.0.1';
const port = envNumber('FUTURES_DASHBOARD_PORT', 3988, 1);
if (!Number.isInteger(port) || port > 65535) throw new Error('FUTURES_DASHBOARD_PORT must be an integer between 1 and 65535');
const refreshSeconds = Math.max(envNumber('FUTURES_DASHBOARD_REFRESH_SECONDS', 5, 0), 2);
const timeframe = process.env.FUTURES_DASHBOARD_CHART_TIMEFRAME || '1m';
const chartLimit = Math.max(envNumber('FUTURES_DASHBOARD_CHART_LIMIT', 120, 0), 20);
const shortStateFile = path.resolve(
  process.env.FUTURES_DASHBOARD_SHORT_STATE_FILE || path.join(__dirname, '..', 'grid-state-futures-short.json')
);
const shortLockFile = path.resolve(
  process.env.FUTURES_DASHBOARD_SHORT_LOCK_FILE || `${shortStateFile}.lock`
);
const authEnabled = process.env.FUTURES_DASHBOARD_AUTH_ENABLED !== undefined
  ? envBoolean('FUTURES_DASHBOARD_AUTH_ENABLED', false)
  : envBoolean('DASHBOARD_AUTH_ENABLED', false);
const authUsername = process.env.FUTURES_DASHBOARD_USERNAME || process.env.DASHBOARD_USERNAME || '';
const authPassword = process.env.FUTURES_DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD || '';
const authSessionHours = Math.max(
  process.env.FUTURES_DASHBOARD_SESSION_HOURS !== undefined
    ? envNumber('FUTURES_DASHBOARD_SESSION_HOURS', 12, 0)
    : envNumber('DASHBOARD_SESSION_HOURS', 12, 0),
  1
);

function isLoopbackHost(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return normalized === 'localhost' || normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function validateDashboardExposure(bindHost, authenticationEnabled) {
  if (!isLoopbackHost(bindHost) && !authenticationEnabled) {
    throw new Error('Futures dashboard authentication is required when FUTURES_DASHBOARD_HOST is not loopback');
  }
}

function positionMetrics(position, leverage, openPositionFees = 0) {
  if (!position) return null;
  const safeLeverage = Number(leverage) > 0 ? Number(leverage) : 1;
  const contracts = numberOrZero(position.contracts);
  const notional = Math.abs(numberOrZero(position.notional ?? position.info?.notional));
  const positionMargin = numberOrZero(
    position.info?.positionInitialMargin ?? position.initialMargin ?? (notional / safeLeverage)
  );
  const unrealizedPnl = numberOrZero(position.unrealizedPnl ?? position.info?.unRealizedProfit);
  return {
    contracts,
    notional,
    entryPrice: numberOrZero(position.entryPrice),
    markPrice: numberOrZero(position.markPrice ?? position.info?.markPrice),
    liquidationPrice: numberOrZero(position.liquidationPrice ?? position.info?.liquidationPrice),
    positionMargin,
    roiPct: positionMargin > 0 ? (unrealizedPnl / positionMargin) * 100 : 0,
    unrealizedPnl,
    openPositionFees: numberOrZero(openPositionFees),
  };
}

function conservativePositionExposure(position, metrics) {
  if (!position) return 0;
  const contracts = Math.abs(numberOrZero(position.contracts));
  const contractSize = numberOrZero(position.contractSize ?? 1);
  const entryPrice = numberOrZero(position.entryPrice);
  const markPrice = numberOrZero(position.markPrice ?? position.info?.markPrice);
  if (contracts > 0 && contractSize > 0 && entryPrice > 0 && markPrice > 0) {
    return contracts * contractSize * Math.max(entryPrice, markPrice);
  }
  return numberOrZero(metrics?.notional);
}

function fibonacciFromState(symState) {
  const advisor = symState?.config?.rangeAdvisor;
  if (!advisor) return null;
  return {
    direction: advisor.direction || 'UNKNOWN',
    confirmedDirection: advisor.directionApplied || 'RANGING',
    appliedDirection: advisor.directionApplied || 'RANGING',
    strategy: advisor.directionStrategy || 'TREND',
    score: advisor.directionScore ?? null,
    confidence: advisor.directionConfidence ?? null,
    alignment: advisor.directionAlignment ?? null,
    confirmationCount: numberOrZero(advisor.directionConfirmationCount),
    confirmationsRequired: numberOrZero(advisor.directionConfirmationsRequired),
    generatedAt: advisor.appliedAt || null,
    timeframes: Object.fromEntries(Object.entries(advisor.directionTimeframes || {}).map(([key, value]) => [key, {
      direction: value?.direction || 'UNKNOWN',
      score: value?.score ?? null,
      atrPct: value?.atrPct ?? null,
      volatilityRatio: value?.volatilityRatio ?? null,
    }])),
  };
}

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

function volumeDeltaFromState(symState, positionSide) {
  const side = String(positionSide || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const prefix = side === 'SHORT' ? 'SHORT_' : '';
  const persisted = symState?.config?.volumeDeltaEntryGuard || null;
  const configuredEnabled = process.env[`${prefix}VOLUME_DELTA_ENTRY_FILTER_ENABLED`];
  const enabled = booleanValue(
    configuredEnabled === undefined ? persisted?.enabled : configuredEnabled,
    false
  );
  const configuredTimeframe = process.env[`${prefix}VOLUME_DELTA_TIMEFRAME`];
  const timeframe = String(configuredTimeframe || persisted?.timeframe || '15m');
  const configuredLookback = process.env[`${prefix}VOLUME_DELTA_LOOKBACK_CANDLES`];
  const lookbackCandles = numberOrZero(
    configuredLookback === undefined ? persisted?.lookbackCandles : configuredLookback
  );
  const configuredFailClosed = process.env[`${prefix}VOLUME_DELTA_FAIL_CLOSED`];
  const failClosed = booleanValue(
    configuredFailClosed === undefined ? persisted?.failClosed : configuredFailClosed,
    false
  );
  const available = enabled && Boolean(persisted?.available);
  return {
    enabled,
    mode: String(
      process.env[`${prefix}VOLUME_DELTA_ENTRY_FILTER_MODE`] ?? persisted?.mode ?? 'OFF'
    ).toUpperCase(),
    positionSide: side,
    timeframe,
    lookbackCandles,
    windowMinutes: configuredTimeframe !== undefined || configuredLookback !== undefined
      ? Math.round(timeframeToMs(timeframe) * lookbackCandles / 60_000)
      : numberOrZero(persisted?.windowMinutes) || lookbackCandles * 15,
    oppositionThresholdPct: numberOrZero(
      process.env[`${prefix}VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT`] ??
      persisted?.oppositionThresholdPct
    ),
    failClosed,
    available,
    allow: !enabled || (persisted?.allow ?? !failClosed),
    reason: !enabled ? 'disabled' : persisted?.reason || 'volume_delta_unavailable',
    deltaRatio: available && Number.isFinite(Number(persisted?.deltaRatio))
      ? Number(persisted.deltaRatio)
      : null,
    candleTimestamp: numberOrZero(persisted?.candleTimestamp) || null,
    candleCloseTime: numberOrZero(persisted?.candleCloseTime) || null,
    evaluatedAt: persisted?.evaluatedAt || null,
    error: persisted?.error || null,
  };
}

function emaTrendFromState(symState, positionSide) {
  const side = String(positionSide || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const prefix = side === 'SHORT' ? 'SHORT_' : '';
  const persisted = symState?.config?.emaTrendEntryGuard || null;
  const configuredEnabled = process.env[`${prefix}EMA_TREND_ENTRY_FILTER_ENABLED`];
  const enabled = booleanValue(
    configuredEnabled === undefined ? persisted?.enabled : configuredEnabled,
    false
  );
  const configuredFailClosed = process.env[`${prefix}EMA_TREND_ENTRY_FAIL_CLOSED`];
  const failClosed = booleanValue(
    configuredFailClosed === undefined ? persisted?.failClosed : configuredFailClosed,
    true
  );
  const available = enabled && Boolean(persisted?.available);
  return {
    enabled,
    mode: String(
      process.env[`${prefix}EMA_TREND_ENTRY_FILTER_MODE`] ?? persisted?.mode ?? 'OFF'
    ).toUpperCase(),
    positionSide: side,
    timeframe: String(
      process.env[`${prefix}EMA_TREND_ENTRY_TIMEFRAME`] || persisted?.timeframe || '5m'
    ),
    failClosed,
    available,
    allow: !enabled || (persisted?.allow ?? !failClosed),
    reason: !enabled ? 'disabled' : persisted?.reason || 'ema_trend_unavailable',
    trend: persisted?.trend || null,
    requiredTrend: persisted?.requiredTrend || (side === 'SHORT' ? 'BEARISH' : 'BULLISH'),
    ema20: Number.isFinite(Number(persisted?.ema20)) ? Number(persisted.ema20) : null,
    ema50: Number.isFinite(Number(persisted?.ema50)) ? Number(persisted.ema50) : null,
    evaluatedAt: persisted?.evaluatedAt || null,
  };
}

function priceMomentumFromState(symState, positionSide) {
  const side = String(positionSide || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const prefix = side === 'SHORT' ? 'SHORT_' : '';
  const persisted = symState?.config?.priceMomentumEntryGuard || null;
  const configuredEnabled = process.env[`${prefix}PRICE_MOMENTUM_ENTRY_FILTER_ENABLED`];
  const enabled = booleanValue(
    configuredEnabled === undefined ? persisted?.enabled : configuredEnabled,
    false
  );
  const timeframe = String(
    process.env[`${prefix}PRICE_MOMENTUM_TIMEFRAME`] || persisted?.timeframe || '5m'
  );
  const lookbackCandles = numberOrZero(
    process.env[`${prefix}PRICE_MOMENTUM_LOOKBACK_CANDLES`] ?? persisted?.lookbackCandles
  );
  const configuredFailClosed = process.env[`${prefix}PRICE_MOMENTUM_FAIL_CLOSED`];
  const failClosed = booleanValue(
    configuredFailClosed === undefined ? persisted?.failClosed : configuredFailClosed,
    true
  );
  const available = enabled && Boolean(persisted?.available);
  return {
    enabled,
    mode: String(
      process.env[`${prefix}PRICE_MOMENTUM_ENTRY_FILTER_MODE`] ?? persisted?.mode ?? 'OFF'
    ).toUpperCase(),
    positionSide: side,
    timeframe,
    lookbackCandles,
    windowMinutes: process.env[`${prefix}PRICE_MOMENTUM_TIMEFRAME`] !== undefined ||
      process.env[`${prefix}PRICE_MOMENTUM_LOOKBACK_CANDLES`] !== undefined
      ? Math.round(timeframeToMs(timeframe) * lookbackCandles / 60_000)
      : numberOrZero(persisted?.windowMinutes) ||
        Math.round(timeframeToMs(timeframe) * lookbackCandles / 60_000),
    deadbandPct: numberOrZero(
      process.env[`${prefix}PRICE_MOMENTUM_DEADBAND_PCT`] ?? persisted?.deadbandPct
    ),
    failClosed,
    available,
    allow: !enabled || (persisted?.allow ?? !failClosed),
    reason: !enabled ? 'disabled' : persisted?.reason || 'price_momentum_unavailable',
    direction: persisted?.direction || null,
    requiredDirection: persisted?.requiredDirection || (side === 'SHORT' ? 'BEARISH' : 'BULLISH'),
    returnRatio: available && Number.isFinite(Number(persisted?.returnRatio))
      ? Number(persisted.returnRatio)
      : null,
    candleTimestamp: numberOrZero(persisted?.candleTimestamp) || null,
    evaluatedAt: persisted?.evaluatedAt || null,
    error: persisted?.error || null,
  };
}

function reversalInventoryFromState(symState, orders, positionSide) {
  const side = String(positionSide || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const prefix = side === 'SHORT' ? 'SHORT_' : '';
  const persisted = symState?.reversalInventory || {};
  const enabled = booleanValue(
    process.env[`${prefix}REVERSAL_INVENTORY_ENABLED`],
    Boolean(persisted.initializedAt)
  );
  const applyToExisting = booleanValue(
    process.env[`${prefix}REVERSAL_APPLY_TO_EXISTING_POSITIONS`],
    false
  );
  const rescueStateOrder = Object.entries(symState?.orders || {})
    .find(([, order]) => order?.kind === 'REVERSAL_RESCUE');
  const rescueOrder = rescueStateOrder
    ? orders.find(order => String(order.id) === String(rescueStateOrder[0])) || null
    : null;
  const rescueFilled = Boolean(persisted.rescueFilled);
  const rescueUsed = Boolean(persisted.rescueUsed);
  const rescueWaitReason = persisted.rescueWaitReason || null;
  const rescueStatus = !enabled
    ? 'DISABLED'
    : rescueFilled
      ? 'FILLED'
      : rescueOrder
        ? 'PENDING'
        : ['PAIR_BUDGET_UNAVAILABLE', 'SIDE_BUDGET_EXHAUSTED'].includes(rescueWaitReason)
          ? 'WAITING_BUDGET'
          : rescueWaitReason === 'FREE_MARGIN_UNAVAILABLE'
            ? 'WAITING_BALANCE'
          : rescueWaitReason === 'BELOW_MINIMUM_ORDER'
            ? 'WAITING_MINIMUM'
            : rescueUsed
              ? 'USED'
              : 'READY';

  return {
    enabled,
    positionSide: side,
    mode: enabled ? String(persisted.mode || 'MONITORING').toUpperCase() : 'DISABLED',
    applyToExisting,
    grandfathered: enabled && Boolean(persisted.grandfathered),
    rescueUsed,
    rescueFilled,
    rescueStatus,
    rescueWaitReason,
    rescueNotional: numberOrZero(persisted.rescueNotional),
    rescueBudgetNotional: numberOrZero(persisted.rescueBudgetNotional),
    rescuePairCount: numberOrZero(persisted.rescuePairCount),
    rescuePlacedAt: persisted.rescuePlacedAt || null,
    opposingSince: persisted.opposingSince || null,
    rescueOrder: rescueOrder ? {
      side: rescueOrder.side,
      price: numberOrZero(rescueOrder.price),
      amount: numberOrZero(rescueOrder.amount),
      remaining: numberOrZero(rescueOrder.remaining),
    } : null,
  };
}

function decisionSnapshot(engine, symbol, symState, orders, position, options = {}) {
  const positionSide = String(options.positionSide || 'LONG').toUpperCase();
  const entrySide = positionSide === 'SHORT' ? 'sell' : 'buy';
  const exitSide = positionSide === 'SHORT' ? 'buy' : 'sell';
  const cachedFibonacci = positionSide === 'LONG'
    ? engine.fibonacciDirectionAnalyzer?.cache?.[symbol]?.analysis || null
    : null;
  const persistedFibonacci = fibonacciFromState(symState);
  const fibonacci = cachedFibonacci || persistedFibonacci;
  const adaptive = positionSide === 'LONG' ? engine.adaptiveGridDecisions?.get?.(symbol) || null : null;
  const exposurePrefix = positionSide === 'SHORT' ? 'SHORT_' : '';
  const configuredCap = numberOrZero(process.env.GRID_TOTAL_INVESTMENT_USDT);
  const stateCap = numberOrZero(symState?.config?.orderSizeUsdt) * numberOrZero(symState?.config?.count);
  const gridInvestmentCap = positionSide === 'LONG' ? configuredCap : stateCap;
  const hasSymbolExposureLimit = Number.isFinite(Number(options.exposureLimits?.symbol));
  const hasSideExposureLimit = Number.isFinite(Number(options.exposureLimits?.total));
  const symbolExposureCap = hasSymbolExposureLimit
    ? Math.max(0, Number(options.exposureLimits.symbol))
    : numberOrZero(process.env[`${exposurePrefix}FUTURES_MAX_SYMBOL_EXPOSURE_USDT`]) || gridInvestmentCap;
  const sideExposureCap = hasSideExposureLimit
    ? Math.max(0, Number(options.exposureLimits.total))
    : numberOrZero(process.env[`${exposurePrefix}FUTURES_MAX_TOTAL_EXPOSURE_USDT`]);
  let allocatedInvestment = 0;
  if (positionSide === 'LONG' && typeof engine.getAllocatedInvestmentUsdt === 'function') {
    try {
      allocatedInvestment = numberOrZero(engine.getAllocatedInvestmentUsdt(symbol));
    } catch {
      allocatedInvestment = 0;
    }
  }
  if (!(allocatedInvestment > 0)) {
    allocatedInvestment = Object.values(symState.lastBuyByLevel || {})
      .reduce((sum, buy) => sum + numberOrZero(buy?.totalCostQuote), 0);
    allocatedInvestment += orders
      .filter(order => order.side === entrySide)
      .reduce((sum, order) => sum + numberOrZero(order.price) * numberOrZero(order.remaining), 0);
  }
  if (Number.isFinite(Number(options.pairExposure))) {
    allocatedInvestment = Math.max(0, Number(options.pairExposure));
  }
  const exposurePct = symbolExposureCap > 0
    ? (allocatedInvestment / symbolExposureCap) * 100
    : options.entryGridEnabled === false
      ? null
      : numberOrZero(adaptive?.exposurePct);
  const minConfidence = numberOrZero(process.env.FIBONACCI_DIRECTION_MIN_CONFIDENCE || 0.65);
  const applyMode = String(process.env.FIBONACCI_DIRECTION_APPLY_MODE || 'REPORT_ONLY').toUpperCase();
  const directionStrategy = String(process.env.FIBONACCI_DIRECTION_STRATEGY || 'TREND').toUpperCase();
  const requiredEntryDirection = positionSide === 'SHORT'
    ? String(process.env.SHORT_FUTURES_SHORT_ENTRY_DIRECTION || 'BEARISH').toUpperCase()
    : String(process.env.FUTURES_LONG_ENTRY_DIRECTION || 'BULLISH').toUpperCase();
  const appliedDirection = persistedFibonacci?.appliedDirection || (applyMode === 'LEVEL_BIAS'
    ? resolveAppliedDirection(fibonacci, {
      strategy: directionStrategy,
      minimumConfidence: minConfidence,
      emaSlopeAtrThreshold: numberOrZero(
        process.env.FIBONACCI_DIRECTION_EMA_SLOPE_ATR_THRESHOLD || 1
      ),
    })
    : 'RANGING');
  const contracts = numberOrZero(position?.contracts);
  const reservedExit = orders
    .filter(order => order.side === exitSide)
    .reduce((sum, order) => sum + numberOrZero(order.remaining), 0);
  const uncovered = Math.max(0, contracts - reservedExit);
  const volumeDelta = volumeDeltaFromState(symState, positionSide);
  const emaTrend = emaTrendFromState(symState, positionSide);
  const priceMomentum = priceMomentumFromState(symState, positionSide);
  const reversalInventory = reversalInventoryFromState(symState, orders, positionSide);

  return {
    fibonacci: {
      available: Boolean(fibonacci),
      direction: fibonacci?.direction || 'UNKNOWN',
      confirmedDirection: fibonacci?.confirmedDirection || 'RANGING',
      appliedDirection,
      applyMode,
      requiredEntryDirection,
      directionGateEnabled: requiredEntryDirection !== 'ALWAYS',
      entryDirectionAllowed: requiredEntryDirection === 'ALWAYS' || appliedDirection === requiredEntryDirection,
      strategy: fibonacci?.strategy || directionStrategy,
      score: fibonacci?.score ?? null,
      confidence: fibonacci?.confidence ?? null,
      alignment: fibonacci?.alignment ?? null,
      confirmationCount: numberOrZero(fibonacci?.confirmationCount),
      confirmationsRequired: numberOrZero(fibonacci?.confirmationsRequired),
      generatedAt: fibonacci?.generatedAt || null,
      timeframes: Object.fromEntries(Object.entries(fibonacci?.timeframes || {}).map(([key, value]) => [key, {
        direction: value?.direction || 'UNKNOWN',
        score: value?.score ?? null,
        atrPct: value?.atrPct ?? null,
        volatilityRatio: value?.volatilityRatio ?? null,
      }])),
    },
    adaptive: {
      available: Boolean(adaptive),
      mode: adaptive?.mode || String(process.env.ADAPTIVE_GRID_SUPERVISOR_MODE || 'OFF').toUpperCase(),
      profile: adaptive?.profile || 'SIDEWAYS',
      rawProfile: adaptive?.rawProfile || null,
      source: adaptive?.decisionSource || 'PENDING',
      learning: adaptive?.learning || null,
      changed: Boolean(adaptive?.changed),
      candidateCount: numberOrZero(adaptive?.candidateCount),
      confirmationsRequired: numberOrZero(adaptive?.confirmationsRequired || process.env.ADAPTIVE_GRID_SUPERVISOR_PROFILE_CONFIRMATIONS),
      cooldownElapsed: adaptive?.cooldownElapsed ?? null,
      exposurePct,
      entryGridEnabled: options.entryGridEnabled !== false,
      allocatedInvestment,
      investmentCap: symbolExposureCap,
      symbolExposureCap,
      sideExposureCap,
      gridInvestmentCap,
      exposureScope: 'selected-pair',
      exposureSource: Number.isFinite(Number(options.pairExposure)) ? 'exchange-conservative' : 'state-fallback',
      exposureWarningPct: numberOrZero(process.env.ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT || 90),
      riskExposurePct: numberOrZero(process.env.ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT || 90),
      riskStateMachineMode: adaptive?.riskStateMachineMode ||
        String(process.env.ADAPTIVE_RISK_STATE_MACHINE_MODE || 'OFF').toUpperCase(),
      riskState: adaptive?.riskState || null,
      riskTargetState: adaptive?.riskTargetState || null,
      riskStateChanged: Boolean(adaptive?.riskStateChanged),
      riskReasons: Array.isArray(adaptive?.riskReasons) ? adaptive.riskReasons : [],
      riskObserved: adaptive?.riskObserved || null,
      recommendation: adaptive?.recommendation || null,
      reasons: Array.isArray(adaptive?.reasons) ? adaptive.reasons : [],
      generatedAt: adaptive?.generatedAt || null,
    },
    volumeDelta,
    emaTrend,
    priceMomentum,
    reversalInventory,
    execution: {
      gridCount: numberOrZero(symState?.config?.count || process.env.GRID_COUNT),
      buyCount: orders.filter(order => order.side === 'buy').length,
      sellCount: orders.filter(order => order.side === 'sell').length,
      entrySide,
      exitSide,
      entryCount: orders.filter(order => order.side === entrySide).length,
      exitCount: orders.filter(order => order.side === exitSide).length,
      positionContracts: contracts,
      reservedExit,
      reservedSell: positionSide === 'LONG' ? reservedExit : 0,
      uncovered,
      exitCoveragePct: contracts > 0 ? Math.min(100, (reservedExit / contracts) * 100) : null,
      sellCoveragePct: positionSide === 'LONG' && contracts > 0
        ? Math.min(100, (reservedExit / contracts) * 100)
        : null,
      lastTradeTimestamp: numberOrZero(symState.lastTradeTimestamp),
    },
  };
}

function sideOfPosition(position) {
  return String(position?.info?.positionSide || position?.side || '').toUpperCase();
}

function readJsonState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed.symbols === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function lockIsActive(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pid = Number(lock.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function emptySymbolState() {
  return { config: {}, orders: {}, lastBuyByLevel: {}, filledBuys: 0, filledSells: 0 };
}

function managedOrders(engine, symbol, exchangeOrders, symState, positionSide) {
  const managedIds = new Set(Object.keys(symState.orders || {}));
  return exchangeOrders
    .filter(order => managedIds.has(String(order.id)) || (
      positionSide === 'LONG' && engine.getBotOrderLevel(order) !== null
    ))
    .map(order => normalizeOrder(engine, symbol, order, symState.orders?.[String(order.id)]));
}

function openPositionFees(symState) {
  return Object.values(symState.lastBuyByLevel || {})
    .reduce((sum, entry) => sum + numberOrZero(entry?.totalFeeQuote), 0);
}

function sideComparison(positionSide, available, running, symState, orders, rawPosition, leverage, exchangeExposure = null) {
  const entrySide = positionSide === 'SHORT' ? 'sell' : 'buy';
  const position = positionMetrics(rawPosition, leverage, openPositionFees(symState));
  const positionExposure = conservativePositionExposure(rawPosition, position);
  const managedPendingEntryExposure = orders
    .filter(order => order.side === entrySide)
    .reduce((sum, order) => sum + numberOrZero(order.price) * numberOrZero(order.remaining), 0);
  const exposure = Number.isFinite(Number(exchangeExposure))
    ? Math.max(0, Number(exchangeExposure))
    : positionExposure + managedPendingEntryExposure;
  const pendingEntryExposure = Math.max(0, exposure - positionExposure);
  const realizedPnl = numberOrZero(symState.realizedGridProfit) + numberOrZero(symState.realizedExitProfit);
  const unrealizedPnl = numberOrZero(position?.unrealizedPnl);
  const entryFees = numberOrZero(position?.openPositionFees);
  return {
    available,
    running,
    exposure,
    positionExposure,
    pendingEntryExposure,
    strategyPnl: realizedPnl + unrealizedPnl - entryFees,
    realizedPnl,
    unrealizedPnl,
    openPositionFees: entryFees,
    positionContracts: numberOrZero(position?.contracts),
    orderCount: orders.length,
  };
}

function exposureBudgetSnapshot(positionSide, budget, fallbackLimits) {
  const source = budget && typeof budget === 'object' ? budget : null;
  return {
    available: Boolean(source),
    positionSide,
    entryGridEnabled: source?.entryGridEnabled !== false,
    status: source?.status || 'PENDING',
    deferredReason: source?.deferredReason || null,
    sidePct: numberOrZero(source?.sidePct),
    leverage: numberOrZero(source?.leverage),
    pairCount: numberOrZero(source?.pairCount),
    symbolCap: numberOrZero(source?.symbolCap ?? fallbackLimits?.symbol),
    sideCap: numberOrZero(source?.sideCap ?? fallbackLimits?.total),
    targetSideCap: numberOrZero(source?.targetSideCap ?? source?.sideCap ?? fallbackLimits?.total),
    currentExposure: numberOrZero(source?.currentExposure),
    rescueMarginPct: numberOrZero(source?.rescueMarginPct),
    rescueSymbolCap: numberOrZero(source?.rescueSymbolCap),
    rescueSideCap: numberOrZero(source?.rescueSideCap),
    lastCheckedAt: source?.lastCheckedAt || null,
    appliedAt: source?.appliedAt || null,
  };
}

function rescueBudgetSnapshot(budget, sideState) {
  const configuredMarginPct = numberOrZero(budget?.rescueMarginPct);
  const rescueStates = Object.values(sideState?.symbols || {})
    .map(symbolState => symbolState?.reversalInventory)
    .filter(reversal => reversal?.initializedAt);
  const hasUnusedRescue = rescueStates.length === 0 || rescueStates.some(reversal =>
    !reversal.rescueFilled && !reversal.rescueUsed && !reversal.rescueOrderId
  );
  const active = configuredMarginPct > 0 && (
    budget?.entryGridEnabled !== false || (
      numberOrZero(budget?.currentExposure) > 0 && hasUnusedRescue
    )
  );
  return {
    active,
    marginPct: active ? configuredMarginPct : 0,
    configuredMarginPct,
    symbolCap: active ? numberOrZero(budget?.rescueSymbolCap) : 0,
    sideCap: active ? numberOrZero(budget?.rescueSideCap) : 0,
  };
}

function exitOverview(orders, rawPosition, positionSide) {
  const exitSide = positionSide === 'SHORT' ? 'buy' : 'sell';
  const exits = orders.filter(order => order.side === exitSide && Number(order.price) > 0)
    .sort((a, b) => positionSide === 'SHORT' ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price));
  const entryPrice = Number(rawPosition?.entryPrice);
  const nearest = exits[0];
  let nearestLabel = `Belum ada order ${exitSide.toUpperCase()} aktif`;
  if (nearest && entryPrice > 0) {
    nearestLabel = positionSide === 'SHORT'
      ? (nearest.price < entryPrice ? 'Di bawah entry rata-rata' : nearest.price > entryPrice ? 'Di atas entry rata-rata' : 'Sama dengan entry rata-rata')
      : sellEntryLabel(nearest.price, entryPrice);
  }
  return { nearestPrice: nearest ? Number(nearest.price) : null, nearestLabel };
}

async function buildFuturesDashboardSnapshot(engine, requestedSymbol, requestedSide = 'LONG', options = {}) {
  const longSymbols = engine.constructor.SYMBOLS || String(process.env.SYMBOLS || '').split(',').filter(Boolean);
  const shortState = options.shortState === undefined ? readJsonState(shortStateFile) : options.shortState;
  const shortSymbols = Object.keys(shortState?.symbols || {});
  const selectedPositionSide = String(requestedSide || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const symbols = selectedPositionSide === 'SHORT' ? shortSymbols : longSymbols;
  const symbol = symbols.includes(requestedSymbol) ? requestedSymbol : symbols[0] || longSymbols[0] || shortSymbols[0];
  if (!symbol) throw new Error('No futures symbols are configured');
  const longAvailable = longSymbols.includes(symbol);
  const shortAvailable = shortSymbols.includes(symbol);
  const longState = longAvailable ? engine.state.getSymbol(symbol) : emptySymbolState();
  const selectedShortState = shortAvailable ? shortState.symbols[symbol] : emptySymbolState();
  const symState = selectedPositionSide === 'SHORT' ? selectedShortState : longState;
  const [ticker, exchangeOrders, candles, balance, positions] = await Promise.all([
    retry(() => engine.exchange.fetchTicker(symbol)),
    retry(() => engine.exchange.fetchOpenOrders(symbol)),
    retry(() => engine.exchange.fetchOHLCV(symbol, timeframe, undefined, chartLimit)),
    retry(() => engine.exchange.fetchBalance()),
    retry(() => engine.exchange.fetchPositions([symbol])),
  ]);
  const longOrders = longAvailable ? managedOrders(engine, symbol, exchangeOrders, longState, 'LONG') : [];
  const shortOrders = shortAvailable ? managedOrders(engine, symbol, exchangeOrders, selectedShortState, 'SHORT') : [];
  const orders = selectedPositionSide === 'SHORT' ? shortOrders : longOrders;
  const long = positions.find(position => sideOfPosition(position) === 'LONG' && Number(position.contracts) > 0);
  const short = positions.find(position => sideOfPosition(position) === 'SHORT' && Number(position.contracts) > 0);
  const rawPosition = selectedPositionSide === 'SHORT' ? short : long;
  const freeUsdt = numberOrZero(balance?.free?.USDT);
  const totalUsdt = numberOrZero(balance?.total?.USDT);
  const accountUnrealized = positions.filter(p => p.symbol === symbol)
    .reduce((sum, p) => sum + numberOrZero(p.unrealizedPnl ?? p.info?.unRealizedProfit), 0);
  const accountState = longAvailable ? longState : selectedShortState;
  const account = incomeMetrics(accountState.accountIncome, accountUnrealized);
  const funding = account.funding;
  const fee = account.fees;
  const trackedOpenPositionFees = openPositionFees(symState);
  const leverage = Number(process.env.LEVERAGE) || 0;
  const position = positionMetrics(rawPosition, leverage, trackedOpenPositionFees);
  for (const order of orders) {
    const isEntry = order.side === (selectedPositionSide === 'SHORT' ? 'sell' : 'buy');
    order.entryComparison = isEntry
      ? `Menambah ${selectedPositionSide}`
      : selectedPositionSide === 'SHORT'
        ? (rawPosition?.entryPrice > 0 && order.price < rawPosition.entryPrice ? 'Exit di bawah entry rata-rata' : 'Exit SHORT')
        : sellEntryLabel(order.price, rawPosition?.entryPrice);
  }
  const walletInfo = balance?.info || {};
  const walletBalance = numberOrZero(walletInfo.totalWalletBalance ?? balance?.total?.USDT);
  const availableBalance = numberOrZero(walletInfo.availableBalance ?? freeUsdt);
  const positionMargin = position ? numberOrZero(position.positionMargin) : 0;
  const openOrderMargin = numberOrZero(walletInfo.totalOpenOrderInitialMargin);
  const usedMargin = numberOrZero(walletInfo.totalInitialMargin ?? balance?.used?.USDT);
  const shortRunning = options.shortRunning ?? lockIsActive(shortLockFile);
  const selectedRunning = selectedPositionSide === 'SHORT' ? shortRunning : engine.circuitAllows();
  const longBudget = engine.state.data?.exposureBudget || null;
  const shortBudget = shortState?.exposureBudget || null;
  const primaryBudget = longBudget || shortBudget;
  const longExposureBudget = exposureBudgetSnapshot('LONG', longBudget, engine.exposureLimits);
  const shortExposureBudget = exposureBudgetSnapshot('SHORT', shortBudget, {
    symbol: process.env.SHORT_FUTURES_MAX_SYMBOL_EXPOSURE_USDT,
    total: process.env.SHORT_FUTURES_MAX_TOTAL_EXPOSURE_USDT,
  });
  const longPct = longExposureBudget.sidePct;
  const shortPct = shortExposureBudget.sidePct;
  const combinedPct = Math.min(100, longPct + shortPct);
  const longRescueBudget = rescueBudgetSnapshot(longExposureBudget, engine.state.data);
  const shortRescueBudget = rescueBudgetSnapshot(shortExposureBudget, shortState);
  const rescuePct = Math.min(100, longRescueBudget.marginPct + shortRescueBudget.marginPct);
  const legacyPct = Math.min(100, [longExposureBudget, shortExposureBudget]
    .filter(budget => budget.entryGridEnabled === false)
    .reduce((sum, budget) => sum + (
      walletBalance > 0 && budget.leverage > 0
        ? budget.currentExposure / budget.leverage / walletBalance * 100
        : 0
    ), 0));
  const bufferPct = Math.max(0, 100 - combinedPct - rescuePct - legacyPct);
  const longExchangeExposure = exposureBySymbol([symbol], positions, exchangeOrders, 'LONG').values[symbol];
  const shortExchangeExposure = exposureBySymbol([symbol], positions, exchangeOrders, 'SHORT').values[symbol];
  const longComparison = sideComparison('LONG', longAvailable, engine.circuitAllows(), longState, longOrders, long, leverage, longExchangeExposure);
  const shortComparison = sideComparison('SHORT', shortAvailable, shortRunning, selectedShortState, shortOrders, short, leverage, shortExchangeExposure);
  const selectedComparison = selectedPositionSide === 'SHORT' ? shortComparison : longComparison;
  const selectedEntryGridEnabled = selectedPositionSide === 'SHORT'
    ? selectedShortState.config?.entryGridEnabled !== false
    : longState.config?.entryGridEnabled !== false;
  const intelligence = decisionSnapshot(engine, symbol, symState, orders, position, {
    positionSide: selectedPositionSide,
    pairExposure: selectedComparison.exposure,
    entryGridEnabled: selectedEntryGridEnabled,
    exposureLimits: selectedPositionSide === 'SHORT'
      ? {
          symbol: shortState?.exposureBudget?.symbolCap,
          total: shortState?.exposureBudget?.sideCap,
        }
      : engine.exposureLimits,
  });
  const combinedStrategyPnl = longComparison.strategyPnl + shortComparison.strategyPnl;
  const combinedExposure = longComparison.exposure + shortComparison.exposure;
  return {
    generatedAt: new Date().toISOString(), refreshSeconds, dashboardAuthEnabled: authEnabled,
    source: 'Binance USDⓈ-M Futures',
    mode: process.env.EXCHANGE_MODE || 'testnet', running: selectedRunning,
    tradingEnabled: selectedRunning && engine.canPlaceNewOrders() && selectedEntryGridEnabled,
    entryGridEnabled: selectedEntryGridEnabled,
    symbols, selectedSymbol: symbol,
    positionSides: ['LONG', 'SHORT'], selectedPositionSide,
    sideAvailable: selectedPositionSide === 'SHORT' ? shortAvailable : longAvailable,
    comparison: {
      scope: 'selected-pair',
      combined: { exposure: combinedExposure, strategyPnl: combinedStrategyPnl },
      LONG: longComparison,
      SHORT: shortComparison,
    },
    exposureAllocation: {
      enabled: Boolean(primaryBudget?.enabled),
      walletBalance,
      leverage,
      sidePct: selectedPositionSide === 'SHORT' ? shortPct : longPct,
      longPct,
      shortPct,
      combinedPct,
      legacyPct,
      rescuePct,
      bufferPct,
      rebalanceThresholdPct: numberOrZero(process.env.FUTURES_DYNAMIC_EXPOSURE_REBALANCE_THRESHOLD_PCT),
      refreshMinutes: numberOrZero(process.env.FUTURES_DYNAMIC_EXPOSURE_REFRESH_MINUTES),
      LONG: longExposureBudget,
      SHORT: shortExposureBudget,
      rescue: {
        totalPct: rescuePct,
        totalCap: longRescueBudget.sideCap + shortRescueBudget.sideCap,
        LONG: longRescueBudget,
        SHORT: shortRescueBudget,
      },
    },
    market: {
      price: marketPrice(engine, symbol, ticker.last), priceText: marketPriceText(engine, symbol, ticker.last),
      priceDigits: precisionDigits(marketPriceText(engine, symbol, ticker.last)), changePercent: numberOrZero(ticker.percentage),
      high: marketPrice(engine, symbol, ticker.high), highText: marketPriceText(engine, symbol, ticker.high),
      low: marketPrice(engine, symbol, ticker.low), lowText: marketPriceText(engine, symbol, ticker.low),
      volume: numberOrZero(ticker.quoteVolume || ticker.baseVolume), timeframe,
      candles: (candles || []).map(row => ({ time: Number(row[0]), open: marketPrice(engine, symbol, row[1]), high: marketPrice(engine, symbol, row[2]), low: marketPrice(engine, symbol, row[3]), close: marketPrice(engine, symbol, row[4]), volume: Number(row[5]) })),
    },
    range: { lower: numberOrZero(symState.config?.lower), lowerText: marketPriceText(engine, symbol, symState.config?.lower), upper: numberOrZero(symState.config?.upper), upperText: marketPriceText(engine, symbol, symState.config?.upper) },
    advisor: symState.config?.rangeAdvisor || null,
    intelligence,
    orders: {
      active: orders, buyCount: orders.filter(order => order.side === 'buy').length, sellCount: orders.filter(order => order.side === 'sell').length,
      buyValue: orders.filter(order => order.side === 'buy').reduce((sum, order) => sum + order.price * order.remaining, 0),
      sellValue: orders.filter(order => order.side === 'sell').reduce((sum, order) => sum + order.price * order.remaining, 0),
    },
    profit: {
      realized: numberOrZero(symState.realizedGridProfit) + numberOrZero(symState.realizedExitProfit),
      totalRealized: null,
      gridPairProfit: numberOrZero(symState.realizedGridProfit),
      accounting: account,
      filledBuys: numberOrZero(symState.filledBuys), filledSells: numberOrZero(symState.filledSells), quoteAsset: 'USDT',
      funding, fees: numberOrZero(symState.tradingFees), openPositionFees: trackedOpenPositionFees,
      unrealizedPnl: numberOrZero(position?.unrealizedPnl), net: selectedPositionSide === 'SHORT'
        ? shortComparison.strategyPnl : longComparison.strategyPnl,
      accountNet: account.net,
    },
    futures: {
      leverage, marginMode: process.env.MARGIN_MODE || '', positionMode: 'HEDGE',
      positionSide: selectedPositionSide, freeUsdt, totalUsdt, walletBalance, availableBalance, usedMargin,
      positionMargin, openOrderMargin, position, exits: exitOverview(orders, rawPosition, selectedPositionSide),
    },
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function startFuturesDashboardServer(engine) {
  if (!enabled || engine.futuresDashboardServer) return null;
  validateDashboardExposure(host, authEnabled);
  const auth = createDashboardAuth({
    enabled: authEnabled,
    username: authUsername,
    password: authPassword,
    sessionHours: authSessionHours,
    cookieName: 'grid_futures_session',
    dashboardName: 'Dashboard Futures',
  });
  const server = http.createServer(async (request, response) => {
    try {
      let url;
      try {
        url = new URL(request.url, 'http://localhost');
      } catch {
        sendJson(response, 400, { error: 'Invalid request URL' });
        return;
      }
      if (await auth.handleRoute(request, response, url)) return;
      if (!auth.requireAuthentication(request, response, url)) return;
      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        sendJson(response, 200, await buildFuturesDashboardSnapshot(
          engine,
          url.searchParams.get('symbol'),
          url.searchParams.get('positionSide')
        ));
        return;
      }
      if (request.method === 'GET' && dashboardAssets.has(url.pathname)) {
        const asset = dashboardAssets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' });
        fs.createReadStream(asset.file).pipe(response);
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        fs.createReadStream(dashboardFile).pipe(response);
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[FUTURES DASHBOARD]', err.message);
      sendJson(response, 503, { error: 'Futures dashboard data unavailable' });
    }
  });
  server.on('error', err => console.error('[FUTURES DASHBOARD]', err.message));
  server.listen(port, host, () => {
    console.log(`[FUTURES DASHBOARD] http://${host}:${port} auth=${auth.enabled ? 'ON' : 'OFF'}`);
  });
  engine.futuresDashboardServer = server;
  return server;
}

module.exports = {
  buildFuturesDashboardSnapshot,
  decisionSnapshot,
  isLoopbackHost,
  positionMetrics,
  startFuturesDashboardServer,
  validateDashboardExposure,
};
