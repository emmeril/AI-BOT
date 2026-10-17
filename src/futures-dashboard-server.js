const fs = require('fs');
const http = require('http');
const path = require('path');
const { retry, numberOrZero } = require('./utils');
const { createDashboardAuth } = require('./dashboard-auth');
const { incomeMetrics } = require('./futures-income');
const { sellEntryLabel } = require('./futures-display');
const { resolveAppliedDirection } = require('./fibonacci-direction-analyzer');
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
  const lookbackCandles = numberOrZero(
    persisted?.lookbackCandles ?? process.env[`${prefix}VOLUME_DELTA_LOOKBACK_CANDLES`]
  );
  const failClosed = booleanValue(
    persisted?.failClosed ?? process.env[`${prefix}VOLUME_DELTA_FAIL_CLOSED`],
    false
  );
  const available = enabled && Boolean(persisted?.available);
  return {
    enabled,
    mode: String(
      persisted?.mode ?? process.env[`${prefix}VOLUME_DELTA_ENTRY_FILTER_MODE`] ?? 'OFF'
    ).toUpperCase(),
    positionSide: side,
    timeframe: persisted?.timeframe || '15m',
    lookbackCandles,
    windowMinutes: numberOrZero(persisted?.windowMinutes) || lookbackCandles * 15,
    oppositionThresholdPct: numberOrZero(
      persisted?.oppositionThresholdPct ??
      process.env[`${prefix}VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT`]
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
  const configuredCap = numberOrZero(process.env.GRID_TOTAL_INVESTMENT_USDT);
  const stateCap = numberOrZero(symState?.config?.orderSizeUsdt) * numberOrZero(symState?.config?.count);
  const investmentCap = positionSide === 'LONG' ? configuredCap : stateCap;
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
  const exposurePct = investmentCap > 0
    ? (allocatedInvestment / investmentCap) * 100
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

  return {
    fibonacci: {
      available: Boolean(fibonacci),
      direction: fibonacci?.direction || 'UNKNOWN',
      confirmedDirection: fibonacci?.confirmedDirection || 'RANGING',
      appliedDirection,
      requiredEntryDirection,
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
      allocatedInvestment,
      investmentCap,
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

function sideComparison(positionSide, available, running, symState, orders, rawPosition, leverage) {
  const entrySide = positionSide === 'SHORT' ? 'sell' : 'buy';
  const position = positionMetrics(rawPosition, leverage, openPositionFees(symState));
  const positionExposure = numberOrZero(position?.notional);
  const pendingEntryExposure = orders
    .filter(order => order.side === entrySide)
    .reduce((sum, order) => sum + numberOrZero(order.price) * numberOrZero(order.remaining), 0);
  const realizedPnl = numberOrZero(symState.realizedGridProfit) + numberOrZero(symState.realizedExitProfit);
  const unrealizedPnl = numberOrZero(position?.unrealizedPnl);
  const entryFees = numberOrZero(position?.openPositionFees);
  return {
    available,
    running,
    exposure: positionExposure + pendingEntryExposure,
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
  const intelligence = decisionSnapshot(engine, symbol, symState, orders, position, {
    positionSide: selectedPositionSide,
  });
  const longComparison = sideComparison('LONG', longAvailable, engine.circuitAllows(), longState, longOrders, long, leverage);
  const shortComparison = sideComparison('SHORT', shortAvailable, shortRunning, selectedShortState, shortOrders, short, leverage);
  const combinedStrategyPnl = longComparison.strategyPnl + shortComparison.strategyPnl;
  const combinedExposure = longComparison.exposure + shortComparison.exposure;
  return {
    generatedAt: new Date().toISOString(), refreshSeconds, dashboardAuthEnabled: authEnabled,
    source: 'Binance USDⓈ-M Futures',
    mode: process.env.EXCHANGE_MODE || 'testnet', running: selectedRunning,
    tradingEnabled: selectedRunning && engine.canPlaceNewOrders(), symbols, selectedSymbol: symbol,
    positionSides: ['LONG', 'SHORT'], selectedPositionSide,
    sideAvailable: selectedPositionSide === 'SHORT' ? shortAvailable : longAvailable,
    comparison: {
      scope: 'selected-pair',
      combined: { exposure: combinedExposure, strategyPnl: combinedStrategyPnl },
      LONG: longComparison,
      SHORT: shortComparison,
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
