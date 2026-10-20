const {
  analyzeTimeframe,
  aggregateTimeframes,
  resolveAppliedDirection,
} = require('./fibonacci-direction-analyzer');
const { FibonacciRangeAdvisor, timeframeToMs } = require('./fibonacci-range-advisor');
const {
  AdaptiveGridSupervisor,
  selectSpacedBuyLevels,
  zoneForRank,
} = require('./adaptive-grid-supervisor');
const {
  applyConfirmation,
  completedIndex,
  resampleCandles,
} = require('../scripts/backtest-fibonacci-direction');

const MINUTE_MS = 60_000;
const RANGE_TIMEFRAMES = ['15m', '30m', '1h', '4h', '1d', '1w'];
const DIRECTION_TIMEFRAMES = ['15m', '1h', '4h'];

const DEFAULT_OPTIONS = Object.freeze({
  baseTimeframe: '15m',
  rangeTimeframes: RANGE_TIMEFRAMES,
  directionTimeframes: DIRECTION_TIMEFRAMES,
  gridCount: 27,
  totalInvestment: 150,
  orderSizeUsdt: null,
  maxExposureUsdt: null,
  leverage: 5,
  maxActiveBuyOrders: 20,
  maxRefills: 2,
  makerFeeRate: 0.0002,
  minimumNetProfitPct: 0.05,
  exitTargetLevelOffset: 0,
  exitTargetFurthest: false,
  minimumNotional: 5,
  positionSide: 'LONG',
  longEntryDirection: 'ALWAYS',
  shortEntryDirection: 'ALWAYS',
  mutualExclusion: false,
  controlledHandoff: false,
  handoffMinimumNetProfitPct: 0,
  handoffEntryCooldownMs: 0,
  handoffRescueNotionalUsdt: 0,
  handoffProfitBankExitEnabled: false,
  handoffProfitBankActivationMs: 0,
  handoffProfitBankExitFraction: 1,
  handoffProfitBankReserveUsdt: 0,
  candleLimit: 100,
  rangeWidthPct: 20,
  rangeMinimumWidthPct: 6,
  rangeMaximumDistancePct: 25,
  rangeRebuildThresholdPct: 2,
  rangeRebuildCooldownMs: 120 * MINUTE_MS,
  directionMinimumConfidence: 0.65,
  directionStrategy: 'TREND',
  directionEmaSlopeAtrThreshold: 1,
  directionLevelBiasPct: 10,
  riskCautionExposureRatio: 0.75,
  riskExposureRatio: 0.9,
  riskLossWarningPct: 5,
  riskLossRiskOffPct: 10,
  riskCautionConfirmations: 2,
  riskRecoveryConfirmations: 3,
});

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function geometricLevels(lower, upper, count) {
  if (!(lower > 0) || !(upper > lower) || count < 2) return [];
  const ratio = Math.pow(upper / lower, 1 / (count - 1));
  return Array.from({ length: count }, (_, index) => lower * Math.pow(ratio, index));
}

function minimumProfitableSellPrice(lot, options) {
  const costWithEntryFee = lot.entryCost + lot.buyFee;
  return (costWithEntryFee / lot.quantity) * (1 + options.minimumNetProfitPct / 100) /
    (1 - options.makerFeeRate);
}

function maximumProfitableShortBuyPrice(lot, options) {
  const netEntryProceeds = lot.entryCost - lot.buyFee;
  const targetProfit = lot.entryCost * options.minimumNetProfitPct / 100;
  return (netEntryProceeds - targetProfit) / lot.quantity / (1 + options.makerFeeRate);
}

function selectProfitableExitLevel(levels, boundary, positionSide, options = {}) {
  const short = String(positionSide || '').toUpperCase() === 'SHORT';
  const candidates = short
    ? [...levels].reverse().filter(level => level < boundary - 1e-12)
    : levels.filter(level => level > boundary + 1e-12);
  if (!candidates.length) return null;
  if (options.exitTargetFurthest) return candidates.at(-1);
  const offset = Math.max(0, Math.floor(Number(options.exitTargetLevelOffset) || 0));
  return candidates[Math.min(offset, candidates.length - 1)];
}

function chooseSpacedLevels(candidates, multiplier) {
  return selectSpacedBuyLevels(candidates, multiplier);
}

function entryDirectionAllows(positionSide, appliedDirection, options = {}) {
  const short = String(positionSide || '').toUpperCase() === 'SHORT';
  const required = String(
    short ? options.shortEntryDirection : options.longEntryDirection
  ).toUpperCase() || 'ALWAYS';
  return required === 'ALWAYS' || appliedDirection === required;
}

function latestClosedCandles(series, indices, timeframes = RANGE_TIMEFRAMES) {
  const result = [];
  for (const timeframe of timeframes) {
    const index = indices[timeframe];
    const row = series[timeframe]?.[index];
    if (!row) continue;
    result.push({
      timeframe,
      timeframeMs: timeframeToMs(timeframe),
      timestamp: row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
    });
  }
  return result;
}

function getMarketNumber(exchange, method, symbol, value) {
  try {
    const result = Number(exchange?.[method]?.(symbol, value));
    return Number.isFinite(result) ? result : Number(value);
  } catch {
    return Number(value);
  }
}

function createMetrics() {
  return {
    buyFills: 0,
    sellFills: 0,
    longEntryFills: 0,
    shortEntryFills: 0,
    handoffSignals: 0,
    handoffCompleted: 0,
    handoffCancelled: 0,
    handoffExitFills: 0,
    handoffRescueOrders: 0,
    handoffRescueFills: 0,
    handoffProfitBankOrders: 0,
    handoffProfitBankFills: 0,
    handoffProfitBankFullExits: 0,
    handoffProfitBankPartialExits: 0,
    handoffProfitBankExitNotional: 0,
    handoffProfitBankRealizedPnl: 0,
    blockedEntrySamples: 0,
    gridCycles: 0,
    rangeResets: 0,
    skippedBelowMinimum: 0,
    skippedByReserve: 0,
    grossGridProfit: 0,
    buyFees: 0,
    sellFees: 0,
    fundingPnl: 0,
    cashPnl: 0,
    maxInventoryNotional: 0,
    maxPendingBuyNotional: 0,
    maxInventoryAgeHours: 0,
    inventoryNotionalHours: 0,
    staleInventoryNotionalHours: 0,
    exposureSamples: 0,
    exposureAbove90Samples: 0,
    profileSamples: { BULLISH: 0, SIDEWAYS: 0, BEARISH: 0, RISK_OFF: 0 },
    riskStateSamples: { NORMAL: 0, CAUTION: 0, RISK_OFF: 0 },
  };
}

class FullGridBacktester {
  constructor(exchange, options = {}) {
    this.exchange = exchange;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.rangeSuggestionCache = new Map();
    this.preparedSeriesCache = new WeakMap();
    this.directionAggregateCache = new Map();
  }

  prepareSeries(rows, baseTimeframe, timeframes) {
    const baseTimeframeMs = timeframeToMs(baseTimeframe);
    if (!(baseTimeframeMs > 0)) throw new Error(`Unsupported base timeframe: ${baseTimeframe}`);
    const cacheKey = `${baseTimeframe}|${timeframes.join(',')}`;
    const cached = this.preparedSeriesCache.get(rows)?.get(cacheKey);
    if (cached) return cached;
    const series = {};
    for (const timeframe of timeframes) {
      const timeframeMs = timeframeToMs(timeframe);
      if (!(timeframeMs >= baseTimeframeMs) || timeframeMs % baseTimeframeMs !== 0) {
        throw new Error(`${timeframe} cannot be built from ${baseTimeframe} candles`);
      }
      series[timeframe] = timeframe === baseTimeframe
        ? rows
        : resampleCandles(rows, timeframeMs, baseTimeframeMs);
    }
    const rowCache = this.preparedSeriesCache.get(rows) || new Map();
    rowCache.set(cacheKey, series);
    this.preparedSeriesCache.set(rows, rowCache);
    return series;
  }

  createRangeAdvisor(timeframes = RANGE_TIMEFRAMES) {
    const options = this.options;
    const minimumStepRatio = (1 + options.minimumNetProfitPct / 100 + options.makerFeeRate) /
      (1 - options.makerFeeRate);
    return new FibonacciRangeAdvisor(this.exchange, {
      enabled: true,
      timeframes,
      ratios: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618],
      candleCloseBufferMs: 5000,
      clusterTolerancePct: 0.15,
      minClusterScore: 1,
      minRangeWidthPct: options.rangeMinimumWidthPct,
      maxDistancePct: options.rangeMaximumDistancePct,
      rebuildThresholdPct: options.rangeRebuildThresholdPct,
      rebuildCooldownMs: options.rangeRebuildCooldownMs,
      levelCount: options.gridCount + 1,
      minimumStepRatio,
      directionLevelBiasPct: options.directionLevelBiasPct,
      statePath: '',
    });
  }

  simulate({
    symbol,
    rows,
    fundingRates = [],
    start,
    end,
    adaptive = false,
    riskStateMachine = false,
    monitorDecisionProvider = null,
    learningPolicyProvider = null,
    entryDecisionProvider = null,
    entryLevelPlanProvider = null,
    positionSideProvider = null,
    variant = null,
  }) {
    const options = this.options;
    const configuredPositionSide = String(options.positionSide).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const mutualExclusion = Boolean(options.mutualExclusion);
    const adaptiveEnabled = adaptive || riskStateMachine;
    const baseTimeframe = String(options.baseTimeframe || '15m');
    const baseTimeframeMs = timeframeToMs(baseTimeframe);
    if (!(baseTimeframeMs > 0)) throw new Error(`Unsupported base timeframe: ${baseTimeframe}`);
    const rangeTimeframes = [...new Set(options.rangeTimeframes || RANGE_TIMEFRAMES)];
    const directionTimeframes = [...new Set(options.directionTimeframes || DIRECTION_TIMEFRAMES)];
    const requiredTimeframes = [...new Set([...rangeTimeframes, ...directionTimeframes])];
    const series = this.prepareSeries(rows, baseTimeframe, requiredTimeframes);
    const rangeAdvisor = this.createRangeAdvisor(rangeTimeframes);
    const supervisor = new AdaptiveGridSupervisor({
      minimumConfidence: options.directionMinimumConfidence,
      profileConfirmations: 3,
      cooldownMs: 120 * MINUTE_MS,
      riskExposureRatio: options.riskExposureRatio,
      riskStateMachineEnabled: riskStateMachine,
      riskStateMachineMode: 'LIVE',
      cautionExposureRatio: options.riskCautionExposureRatio,
      riskStateExposureRatio: options.riskExposureRatio,
      lossWarningPct: options.riskLossWarningPct,
      lossRiskOffPct: options.riskLossRiskOffPct,
      cautionConfirmations: options.riskCautionConfirmations,
      recoveryConfirmations: options.riskRecoveryConfirmations,
    });
    const directionConfirmation = { candidate: 'RANGING', count: 0 };
    const indices = Object.fromEntries(requiredTimeframes.map(timeframe => [timeframe, -1]));
    const metrics = createMetrics();
    metrics.entryFilterBlockedSamples = 0;
    metrics.directionBlockedSamples = 0;
    const lots = [];
    const pendingBuys = new Map();
    const slotFillCounts = new Map();
    let activeSuggestion = null;
    let lastRangeAppliedAt = 0;
    let rangeGeneration = 0;
    let lastAnalysis = null;
    let lastDecision = null;
    let lastSuggestionComputedAt = 0;
    let fundingIndex = 0;
    let peakEquity = options.totalInvestment / options.leverage;
    let maximumDrawdown = 0;
    let firstEvaluationAt = null;
    let lastClose = null;
    let activePositionSide = mutualExclusion ? 'LONG' : configuredPositionSide;
    let handoffTargetSide = null;
    let lastHandoffCompletedAt = -Infinity;
    let handoffRescueUsed = false;
    let handoffStartedAt = null;
    let handoffProfitBankOrder = null;

    const funding = [...fundingRates]
      .map(item => ({ timestamp: Number(item.timestamp), rate: Number(item.rate) }))
      .filter(item => Number.isFinite(item.timestamp) && Number.isFinite(item.rate))
      .sort((left, right) => left.timestamp - right.timestamp);

    const inventoryEntryNotional = () => lots.reduce((sum, lot) => sum + lot.entryCost, 0);
    const pendingNotional = () => [...pendingBuys.values()].reduce((sum, order) => sum + order.notional, 0);
    const exposureNotional = () => inventoryEntryNotional() + pendingNotional();
    const positionQuantity = () => lots.reduce((sum, lot) => sum + lot.quantity, 0);
    const sideIsShort = side => side === 'SHORT';
    const inventoryMarketNotional = price => lots.reduce((sum, lot) => sum + lot.quantity * price, 0);
    const inventoryUnrealized = price => lots.reduce((sum, lot) => {
      const marketNotional = lot.quantity * price;
      const pricePnl = sideIsShort(lot.positionSide)
        ? lot.entryCost - marketNotional
        : marketNotional - lot.entryCost;
      return sum + pricePnl - marketNotional * options.makerFeeRate;
    }, 0);
    const openPositionNetPnl = price => lots.reduce((sum, lot) => {
      const marketNotional = lot.quantity * price;
      const pricePnl = sideIsShort(lot.positionSide)
        ? lot.entryCost - marketNotional
        : marketNotional - lot.entryCost;
      return sum + pricePnl - lot.buyFee - marketNotional * options.makerFeeRate;
    }, 0);

    const scheduleHandoffProfitBankExit = (currentPrice, now) => {
      if (!options.handoffProfitBankExitEnabled || !handoffTargetSide || !lots.length ||
          !activeSuggestion?.levels?.length || handoffProfitBankOrder) return;
      const activationMs = Math.max(0, Number(options.handoffProfitBankActivationMs) || 0);
      if (!Number.isFinite(handoffStartedAt) || now - handoffStartedAt < activationMs) return;
      const short = sideIsShort(activePositionSide);
      const candidatePrice = activeSuggestion.levels
        .filter(price => short ? price < currentPrice : price > currentPrice)
        .sort((left, right) => short ? right - left : left - right)[0];
      if (!(candidatePrice > 0)) return;
      handoffProfitBankOrder = {
        generation: rangeGeneration,
        positionSide: activePositionSide,
        price: getMarketNumber(this.exchange, 'priceToPrecision', symbol, candidatePrice),
        placedAt: now,
      };
      metrics.handoffProfitBankOrders++;
    };

    const executeHandoffProfitBankExit = (timestamp, high, low) => {
      const order = handoffProfitBankOrder;
      if (!order || order.generation !== rangeGeneration || order.placedAt > timestamp) return;
      const short = sideIsShort(order.positionSide);
      const touched = short ? low - 1e-12 <= order.price : high + 1e-12 >= order.price;
      if (!touched) return;
      const exitLots = lots.filter(lot => lot.handoff && lot.positionSide === order.positionSide);
      handoffProfitBankOrder = null;
      if (!exitLots.length) return;

      const fullQuantity = exitLots.reduce((sum, lot) => sum + lot.quantity, 0);
      const fullEntryCost = exitLots.reduce((sum, lot) => sum + lot.entryCost, 0);
      const fullExitNotional = fullQuantity * order.price;
      const fullGrossPnl = short
        ? fullEntryCost - fullExitNotional
        : fullExitNotional - fullEntryCost;
      const fullExitFee = fullExitNotional * options.makerFeeRate;
      const fullCashDelta = fullGrossPnl - fullExitFee;
      const reserve = Math.max(0, Number(options.handoffProfitBankReserveUsdt) || 0);
      const configuredFraction = Math.min(
        1,
        Math.max(0, Number(options.handoffProfitBankExitFraction) || 0)
      );
      let fraction = configuredFraction;
      if (fullCashDelta < 0) {
        const spendableProfit = Math.max(0, metrics.cashPnl - reserve);
        fraction = Math.min(fraction, spendableProfit / -fullCashDelta);
      }
      if (!(fraction > 0)) return;

      const exitNotional = fullExitNotional * fraction;
      if (exitNotional + 1e-8 < options.minimumNotional) return;
      const remainingNotional = fullExitNotional - exitNotional;
      if (remainingNotional > 1e-8 && remainingNotional < options.minimumNotional) {
        const fullExitAffordable = metrics.cashPnl + fullCashDelta >= reserve - 1e-12;
        if (fullExitAffordable) fraction = 1;
        else fraction = Math.max(0, 1 - options.minimumNotional / fullExitNotional);
      }
      if (!(fraction > 0)) return;

      let grossPnl = 0;
      let closedNotional = 0;
      for (let index = lots.length - 1; index >= 0; index--) {
        const lot = lots[index];
        if (!lot.handoff || lot.positionSide !== order.positionSide) continue;
        const closedQuantity = lot.quantity * fraction;
        const closedEntryCost = lot.entryCost * fraction;
        const lotExitNotional = closedQuantity * order.price;
        grossPnl += short
          ? closedEntryCost - lotExitNotional
          : lotExitNotional - closedEntryCost;
        closedNotional += lotExitNotional;
        if (fraction >= 1 - 1e-12) {
          lots.splice(index, 1);
        } else {
          const remainingFraction = 1 - fraction;
          lot.quantity *= remainingFraction;
          lot.entryCost *= remainingFraction;
          lot.buyFee *= remainingFraction;
          lot.sellTarget = null;
          lot.sellPlacedAt = Infinity;
        }
      }
      const exitFee = closedNotional * options.makerFeeRate;
      const cashDelta = grossPnl - exitFee;
      metrics.grossGridProfit += grossPnl;
      metrics.sellFees += exitFee;
      metrics.cashPnl += cashDelta;
      metrics.sellFills++;
      metrics.gridCycles++;
      metrics.handoffExitFills++;
      metrics.handoffProfitBankFills++;
      metrics.handoffProfitBankExitNotional += closedNotional;
      metrics.handoffProfitBankRealizedPnl += cashDelta;
      if (fraction >= 1 - 1e-12) metrics.handoffProfitBankFullExits++;
      else metrics.handoffProfitBankPartialExits++;
    };

    const profitablePriceOptions = lot => lot.handoff
      ? { ...options, minimumNetProfitPct: options.handoffMinimumNetProfitPct }
      : options;

    const updateSellTargets = currentPrice => {
      if (!activeSuggestion?.levels?.length) return;
      for (const lot of lots) {
        if (lot.sellTarget && lot.sellPlacedAt < lot.lastRangeResetAt) lot.sellTarget = null;
        if (lot.sellTarget) continue;
        let target;
        const targetOptions = profitablePriceOptions(lot);
        const short = sideIsShort(lot.positionSide);
        const handoffLots = lot.handoff
          ? lots.filter(item => item.handoff && item.positionSide === lot.positionSide)
          : [lot];
        const profitBasis = handoffLots.length === 1 ? lot : {
          entryCost: handoffLots.reduce((sum, item) => sum + item.entryCost, 0),
          buyFee: handoffLots.reduce((sum, item) => sum + item.buyFee, 0),
          quantity: handoffLots.reduce((sum, item) => sum + item.quantity, 0),
        };
        if (short) {
          const maximum = Math.min(
            maximumProfitableShortBuyPrice(profitBasis, targetOptions), currentPrice
          );
          target = lot.handoff
            ? maximum - Math.max(maximum * 1e-8, 1e-12)
            : selectProfitableExitLevel(activeSuggestion.levels, maximum, 'SHORT', options);
          if (!target) target = maximum - Math.max(maximum * 1e-8, 1e-12);
        } else {
          const minimum = Math.max(
            minimumProfitableSellPrice(profitBasis, targetOptions), currentPrice
          );
          target = lot.handoff
            ? minimum + Math.max(minimum * 1e-8, 1e-12)
            : selectProfitableExitLevel(activeSuggestion.levels, minimum, 'LONG', options);
          if (!target) target = minimum + Math.max(minimum * 1e-8, 1e-12);
        }
        target = getMarketNumber(this.exchange, 'priceToPrecision', symbol, target);
        const profitable = short
          ? target < maximumProfitableShortBuyPrice(profitBasis, targetOptions) && target < currentPrice
          : target > minimumProfitableSellPrice(profitBasis, targetOptions) && target > currentPrice;
        if (profitable) {
          lot.sellTarget = target;
          lot.sellPlacedAt = lot.lastUpdatedAt;
        }
      }
    };

    const preferredPositionSide = appliedDirection => {
      const requiredShortDirection = String(options.shortEntryDirection || 'ALWAYS').toUpperCase();
      if (requiredShortDirection === 'ALWAYS') return 'SHORT';
      return appliedDirection === requiredShortDirection ? 'SHORT' : 'LONG';
    };

    const placeHandoffRescue = (currentPrice, now) => {
      const rescueNotional = Number(options.handoffRescueNotionalUsdt) || 0;
      if (!(rescueNotional > 0) || handoffRescueUsed || !lots.length ||
          !activeSuggestion?.levels?.length || openPositionNetPnl(currentPrice) >= 0) return;
      const short = sideIsShort(activePositionSide);
      const occupied = new Set(lots.map(lot => lot.levelIndex));
      const candidate = activeSuggestion.levels
        .map((price, levelIndex) => ({ price, levelIndex }))
        .filter(item => (short ? item.price > currentPrice : item.price < currentPrice) &&
          !occupied.has(item.levelIndex) && !pendingBuys.has(item.levelIndex))
        .sort((left, right) => short ? left.price - right.price : right.price - left.price)[0];
      if (!candidate) return;
      const configuredCap = Number(options.maxExposureUsdt) > 0
        ? Number(options.maxExposureUsdt)
        : options.totalInvestment;
      const available = Math.max(0, configuredCap + rescueNotional - exposureNotional());
      const targetNotional = Math.min(rescueNotional, available);
      if (targetNotional + 1e-12 < options.minimumNotional) return;
      const price = getMarketNumber(this.exchange, 'priceToPrecision', symbol, candidate.price);
      const quantity = getMarketNumber(
        this.exchange, 'amountToPrecision', symbol, targetNotional / price
      );
      const notional = price * quantity;
      if (!(quantity > 0) || notional + 1e-8 < options.minimumNotional) return;
      pendingBuys.set(candidate.levelIndex, {
        generation: rangeGeneration,
        levelIndex: candidate.levelIndex,
        price,
        quantity,
        notional,
        placedAt: now,
        refillCount: 0,
        positionSide: activePositionSide,
        handoffRescue: true,
      });
      handoffRescueUsed = true;
      metrics.handoffRescueOrders++;
    };

    const updateMutualOwnership = (appliedDirection, now, currentPrice, context) => {
      if (!mutualExclusion) return;
      const providedSide = typeof positionSideProvider === 'function'
        ? String(positionSideProvider(context) || '').toUpperCase()
        : '';
      const preferred = ['LONG', 'SHORT'].includes(providedSide)
        ? providedSide
        : preferredPositionSide(appliedDirection);
      if (!lots.length) {
        if (activePositionSide !== preferred) {
          pendingBuys.clear();
          slotFillCounts.clear();
          activePositionSide = preferred;
          if (handoffTargetSide) {
            metrics.handoffCompleted++;
            lastHandoffCompletedAt = now;
          }
        }
        handoffTargetSide = null;
        handoffRescueUsed = false;
        handoffStartedAt = null;
        handoffProfitBankOrder = null;
        return;
      }
      if (preferred === activePositionSide) {
        if (handoffTargetSide) {
          metrics.handoffCancelled++;
          handoffTargetSide = null;
          handoffStartedAt = null;
          handoffProfitBankOrder = null;
          for (const [levelIndex, order] of pendingBuys) {
            if (order.handoffRescue) pendingBuys.delete(levelIndex);
          }
          for (const lot of lots) {
            lot.handoff = false;
            lot.sellTarget = null;
          }
        }
        return;
      }
      for (const [levelIndex, order] of pendingBuys) {
        if (!order.handoffRescue) pendingBuys.delete(levelIndex);
      }
      if (handoffTargetSide !== preferred) {
        metrics.handoffSignals++;
        handoffStartedAt = now;
        handoffProfitBankOrder = null;
      }
      handoffTargetSide = preferred;
      if (options.controlledHandoff) {
        for (const lot of lots) {
          if (!lot.handoff) lot.sellTarget = null;
          lot.handoff = true;
        }
        placeHandoffRescue(currentPrice, now);
      }
    };

    const rebuildRange = (suggestion, now, currentPrice) => {
      activeSuggestion = suggestion;
      lastRangeAppliedAt = now;
      rangeGeneration++;
      pendingBuys.clear();
      handoffProfitBankOrder = null;
      slotFillCounts.clear();
      for (const lot of lots) {
        let nearestIndex = 0;
        let nearestDistance = Infinity;
        suggestion.levels.forEach((level, index) => {
          const distance = Math.abs(level - lot.entryPrice);
          if (distance < nearestDistance) {
            nearestIndex = index;
            nearestDistance = distance;
          }
        });
        lot.levelIndex = nearestIndex;
        lot.generation = rangeGeneration;
        lot.sellTarget = null;
        lot.lastRangeResetAt = now;
        lot.lastUpdatedAt = now;
      }
      updateSellTargets(currentPrice);
      metrics.rangeResets++;
    };

    const placeBuyOrders = (currentPrice, now, appliedDirection, entryDecision = null) => {
      if (!activeSuggestion?.levels?.length) return;
      if (entryDecision?.allow === false) {
        if (entryDecision.cancelPending !== false) pendingBuys.clear();
        metrics.entryFilterBlockedSamples++;
        return;
      }
      if (mutualExclusion && handoffTargetSide) {
        metrics.blockedEntrySamples++;
        return;
      }
      if (mutualExclusion && now - lastHandoffCompletedAt < options.handoffEntryCooldownMs) {
        metrics.blockedEntrySamples++;
        return;
      }
      const short = sideIsShort(activePositionSide);
      if (!entryDirectionAllows(activePositionSide, appliedDirection, options)) {
        pendingBuys.clear();
        metrics.directionBlockedSamples++;
        return;
      }
      const recommendation = adaptiveEnabled && lastDecision
        ? lastDecision.recommendation
        : { buyWeight: { upper: 1, middle: 1, lower: 1 }, spacingMultiplier: 1 };
      const cap = Number(options.maxExposureUsdt) > 0
        ? Number(options.maxExposureUsdt)
        : options.totalInvestment;
      const occupied = new Set(lots.filter(lot => lot.generation === rangeGeneration).map(lot => lot.levelIndex));
      const candidates = activeSuggestion.levels
        .map((price, levelIndex) => ({ price, levelIndex }))
        .filter(item => (short ? item.price > currentPrice : item.price < currentPrice) &&
          !occupied.has(item.levelIndex) && !pendingBuys.has(item.levelIndex))
        .sort((left, right) => short ? left.price - right.price : right.price - left.price);
      let plannedCandidates = candidates;
      if (typeof entryLevelPlanProvider === 'function' && candidates.length) {
        const planned = entryLevelPlanProvider({
          symbol,
          timestamp: now,
          currentPrice,
          positionSide: activePositionSide,
          direction: appliedDirection,
          analysis: lastAnalysis,
          candidates: [...candidates],
        });
        const allowedIndexes = new Set(candidates.map(candidate => candidate.levelIndex));
        if (Array.isArray(planned)) {
          const seen = new Set();
          plannedCandidates = planned.filter(candidate => {
            const index = Number(candidate?.levelIndex);
            if (!allowedIndexes.has(index) || seen.has(index)) return false;
            seen.add(index);
            return true;
          });
          if (!plannedCandidates.length) plannedCandidates = [candidates.at(-1)];
        }
      }
      const spaced = chooseSpacedLevels(plannedCandidates, recommendation.spacingMultiplier)
        .slice(0, options.maxActiveBuyOrders);
      const count = spaced.length;
      for (let rank = 0; rank < count; rank++) {
        const candidate = spaced[rank];
        const fills = slotFillCounts.get(candidate.levelIndex) || 0;
        if (fills > options.maxRefills) continue;
        const zone = zoneForRank(rank + 1, count);
        const weight = Number(recommendation.buyWeight[zone]) || 0;
        const baseOrderNotional = Number(options.orderSizeUsdt) > 0
          ? Number(options.orderSizeUsdt)
          : options.totalInvestment / options.gridCount;
        const targetNotional = baseOrderNotional * weight;
        if (targetNotional + 1e-12 < options.minimumNotional) {
          metrics.skippedBelowMinimum++;
          continue;
        }
        const price = getMarketNumber(this.exchange, 'priceToPrecision', symbol, candidate.price);
        const rawQuantity = targetNotional / price;
        const quantity = getMarketNumber(this.exchange, 'amountToPrecision', symbol, rawQuantity);
        const notional = price * quantity;
        if (!(quantity > 0) || notional + 1e-8 < options.minimumNotional) {
          metrics.skippedBelowMinimum++;
          continue;
        }
        if (exposureNotional() + notional > cap + 1e-8) {
          metrics.skippedByReserve++;
          continue;
        }
        pendingBuys.set(candidate.levelIndex, {
          generation: rangeGeneration,
          levelIndex: candidate.levelIndex,
          price,
          quantity,
          notional,
          placedAt: now,
          refillCount: fills,
          positionSide: activePositionSide,
        });
      }
    };

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const candle = rows[rowIndex];
      const [timestamp, open, high, low, close] = candle;
      const evaluationTime = timestamp + baseTimeframeMs;
      if (evaluationTime < start) continue;
      if (timestamp >= end) break;
      lastClose = close;

      while (fundingIndex < funding.length && funding[fundingIndex].timestamp < timestamp) fundingIndex++;
      while (fundingIndex < funding.length && funding[fundingIndex].timestamp < timestamp + baseTimeframeMs) {
        const event = funding[fundingIndex];
        if (event.timestamp >= timestamp) {
          const pnl = lots.reduce((sum, lot) => {
            const direction = sideIsShort(lot.positionSide) ? 1 : -1;
            return sum + direction * lot.quantity * open * event.rate;
          }, 0);
          metrics.fundingPnl += pnl;
          metrics.cashPnl += pnl;
        }
        fundingIndex++;
      }

      for (let index = lots.length - 1; index >= 0; index--) {
        const lot = lots[index];
        const short = sideIsShort(lot.positionSide);
        const exitTouched = short
          ? low - 1e-12 <= lot.sellTarget
          : high + 1e-12 >= lot.sellTarget;
        if (!(lot.sellTarget > 0) || lot.sellPlacedAt > timestamp || !exitTouched) continue;
        const proceeds = lot.quantity * lot.sellTarget;
        const sellFee = proceeds * options.makerFeeRate;
        const grossProfit = short ? lot.entryCost - proceeds : proceeds - lot.entryCost;
        metrics.grossGridProfit += grossProfit;
        metrics.sellFees += sellFee;
        metrics.cashPnl += grossProfit - sellFee;
        metrics.sellFills++;
        if (lot.handoff) metrics.handoffExitFills++;
        metrics.gridCycles++;
        slotFillCounts.set(lot.levelIndex, (slotFillCounts.get(lot.levelIndex) || 0) + 1);
        lots.splice(index, 1);
      }

      executeHandoffProfitBankExit(timestamp, high, low);

      for (const [levelIndex, order] of [...pendingBuys.entries()]) {
        const short = sideIsShort(order.positionSide);
        const entryTouched = short ? high + 1e-12 >= order.price : low - 1e-12 <= order.price;
        if (order.generation !== rangeGeneration || order.placedAt > timestamp || !entryTouched) continue;
        const buyFee = order.notional * options.makerFeeRate;
        metrics.buyFees += buyFee;
        metrics.cashPnl -= buyFee;
        metrics.buyFills++;
        if (short) metrics.shortEntryFills++;
        else metrics.longEntryFills++;
        if (order.handoffRescue) {
          metrics.handoffRescueFills++;
          for (const lot of lots) {
            lot.handoff = true;
            lot.sellTarget = null;
          }
        }
        lots.push({
          generation: rangeGeneration,
          levelIndex,
          entryPrice: order.price,
          entryCost: order.notional,
          quantity: order.quantity,
          buyFee,
          sellTarget: null,
          sellPlacedAt: Infinity,
          lastRangeResetAt: order.placedAt,
          lastUpdatedAt: evaluationTime,
          entryFilledAt: evaluationTime,
          positionSide: order.positionSide,
          handoff: Boolean(order.handoffRescue),
        });
        pendingBuys.delete(levelIndex);
      }

      for (const timeframe of requiredTimeframes) {
        indices[timeframe] = completedIndex(
          series[timeframe], timeframeToMs(timeframe), evaluationTime, indices[timeframe]
        );
      }
      if (directionTimeframes.every(timeframe => indices[timeframe] + 1 >= options.candleLimit)) {
        const directionCacheKey = `${symbol}|${directionTimeframes.join(',')}|${options.candleLimit}|${evaluationTime}`;
        let aggregate = this.directionAggregateCache.get(directionCacheKey);
        if (!this.directionAggregateCache.has(directionCacheKey)) {
          const timeframeResults = directionTimeframes.map(timeframe => analyzeTimeframe(
            series[timeframe].slice(indices[timeframe] + 1 - options.candleLimit, indices[timeframe] + 1),
            timeframe
          ));
          aggregate = timeframeResults.every(Boolean) ? aggregateTimeframes(timeframeResults) : null;
          this.directionAggregateCache.set(directionCacheKey, aggregate);
        }
        if (aggregate) {
          const confirmedDirection = applyConfirmation(aggregate, directionConfirmation);
          lastAnalysis = { ...aggregate, confirmedDirection };
        }
      }

      const currentInventoryMarketNotional = inventoryMarketNotional(close);
      const configuredExposureCap = Number(options.maxExposureUsdt) > 0
        ? Number(options.maxExposureUsdt)
        : options.totalInvestment;
      const exposureRatio = (currentInventoryMarketNotional + pendingNotional()) / configuredExposureCap;
      if (lastAnalysis) {
        const entryNotional = inventoryEntryNotional();
        const estimatedExitFee = currentInventoryMarketNotional * options.makerFeeRate;
        const unrealizedPnlPct = entryNotional > 0
          ? (inventoryUnrealized(close) / entryNotional) * 100
          : null;
        lastDecision = supervisor.evaluate(symbol, {
          analysis: lastAnalysis,
          exposureRatio,
          riskContext: { unrealizedPnlPct },
          now: evaluationTime,
          signalId: timestamp,
          monitorDecision: typeof monitorDecisionProvider === 'function'
            ? monitorDecisionProvider({ symbol, timestamp: evaluationTime, analysis: lastAnalysis })
            : null,
          learningPolicy: typeof learningPolicyProvider === 'function'
            ? learningPolicyProvider({ symbol, timestamp: evaluationTime, analysis: lastAnalysis })
            : null,
        });
        metrics.profileSamples[lastDecision.profile]++;
        if (lastDecision.riskState) metrics.riskStateSamples[lastDecision.riskState]++;
        if (riskStateMachine && lastDecision.riskState === 'RISK_OFF') pendingBuys.clear();
      }

      const direction = resolveAppliedDirection(lastAnalysis, {
        strategy: options.directionStrategy,
        minimumConfidence: options.directionMinimumConfidence,
        emaSlopeAtrThreshold: options.directionEmaSlopeAtrThreshold,
      });
      const entryDecision = typeof entryDecisionProvider === 'function'
        ? entryDecisionProvider({
          symbol,
          timestamp: evaluationTime,
          rowIndex,
          rows,
          positionSide: activePositionSide,
          direction,
          analysis: lastAnalysis,
        })
        : null;
      updateMutualOwnership(direction, evaluationTime, close, {
        symbol,
        timestamp: evaluationTime,
        rowIndex,
        rows,
        currentPrice: close,
        activePositionSide,
        direction,
        analysis: lastAnalysis,
      });
      const outsideActiveRange = activeSuggestion &&
        (close <= activeSuggestion.lower || close >= activeSuggestion.upper);
      const shouldEvaluateRange = !activeSuggestion || outsideActiveRange ||
        evaluationTime - lastSuggestionComputedAt >= options.rangeRebuildCooldownMs;
      if (shouldEvaluateRange) {
        const cacheKey = `${symbol}|${timestamp}|${direction}`;
        let suggestion = this.rangeSuggestionCache.get(cacheKey);
        if (!suggestion) {
          const closedCandles = latestClosedCandles(series, indices, rangeTimeframes);
          suggestion = rangeAdvisor.buildSuggestion(symbol, close, closedCandles, { direction });
          if (!suggestion) {
            const levels = geometricLevels(
              close * (1 - options.rangeWidthPct / 100),
              close * (1 + options.rangeWidthPct / 100),
              options.gridCount + 1
            ).map(level => getMarketNumber(this.exchange, 'priceToPrecision', symbol, level));
            suggestion = { source: 'FALLBACK_GEOMETRIC', lower: levels[0], upper: levels.at(-1), levels };
          }
          this.rangeSuggestionCache.set(cacheKey, suggestion);
        }
        lastSuggestionComputedAt = evaluationTime;
        if (!activeSuggestion || rangeAdvisor.shouldAdoptSuggestion(
          activeSuggestion, suggestion, close, lastRangeAppliedAt, evaluationTime
        )) {
          rebuildRange(suggestion, evaluationTime, close);
        }
      }

      for (const lot of lots) lot.lastUpdatedAt = evaluationTime;
      updateSellTargets(close);
      placeBuyOrders(close, evaluationTime, direction, entryDecision);
      scheduleHandoffProfitBankExit(close, evaluationTime);
      const marketNotional = inventoryMarketNotional(close);
      const pending = pendingNotional();
      const oldestEntryAt = lots.length
        ? Math.min(...lots.map(lot => Number(lot.entryFilledAt) || evaluationTime))
        : evaluationTime;
      const inventoryAgeHours = lots.length
        ? Math.max(0, (evaluationTime - oldestEntryAt) / (60 * MINUTE_MS))
        : 0;
      metrics.maxInventoryNotional = Math.max(metrics.maxInventoryNotional, marketNotional);
      metrics.maxPendingBuyNotional = Math.max(metrics.maxPendingBuyNotional, pending);
      metrics.maxInventoryAgeHours = Math.max(metrics.maxInventoryAgeHours, inventoryAgeHours);
      metrics.inventoryNotionalHours += marketNotional * baseTimeframeMs / (60 * MINUTE_MS);
      if (inventoryAgeHours >= 24) {
        metrics.staleInventoryNotionalHours += marketNotional * baseTimeframeMs / (60 * MINUTE_MS);
      }
      metrics.exposureSamples++;
      if ((marketNotional + pending) / configuredExposureCap >= 0.9) metrics.exposureAbove90Samples++;

      const unrealized = inventoryUnrealized(close);
      const equity = options.totalInvestment / options.leverage + metrics.cashPnl + unrealized;
      peakEquity = Math.max(peakEquity, equity);
      maximumDrawdown = Math.max(maximumDrawdown, peakEquity - equity);
      if (!firstEvaluationAt) firstEvaluationAt = evaluationTime;
    }

    const finalMarketNotional = inventoryMarketNotional(lastClose || 0);
    const finalExitFee = finalMarketNotional * options.makerFeeRate;
    const liquidationComponent = lots.reduce((sum, lot) => {
      const marketNotional = lot.quantity * (lastClose || 0);
      return sum + (sideIsShort(lot.positionSide)
        ? lot.entryCost - marketNotional
        : marketNotional - lot.entryCost);
    }, 0);
    const netLiquidationPnl = metrics.cashPnl + liquidationComponent - finalExitFee;
    const fees = metrics.buyFees + metrics.sellFees + finalExitFee;
    const durationDays = firstEvaluationAt ? Math.max(0, (Math.min(end, rows.at(-1)[0] + baseTimeframeMs) - firstEvaluationAt) / 86_400_000) : 0;
    const finalPositionSides = [...new Set(lots.map(lot => lot.positionSide))];
    const finalOldestEntryAt = lots.length
      ? Math.min(...lots.map(lot => Number(lot.entryFilledAt) || Number(lot.lastUpdatedAt) || end))
      : null;
    const finalInventoryAgeHours = finalOldestEntryAt === null
      ? 0
      : Math.max(0, (end - finalOldestEntryAt) / (60 * MINUTE_MS));
    const finalProfitBasis = lots.length ? {
      entryCost: inventoryEntryNotional(),
      buyFee: lots.reduce((sum, lot) => sum + lot.buyFee, 0),
      quantity: positionQuantity(),
    } : null;
    const finalBreakEvenPrice = finalProfitBasis
      ? (finalPositionSides[0] === 'SHORT'
        ? maximumProfitableShortBuyPrice(finalProfitBasis, { ...options, minimumNetProfitPct: 0 })
        : minimumProfitableSellPrice(finalProfitBasis, { ...options, minimumNetProfitPct: 0 }))
      : null;
    const finalBreakEvenDistancePct = finalBreakEvenPrice && lastClose
      ? (finalPositionSides[0] === 'SHORT'
        ? Math.max(0, (lastClose - finalBreakEvenPrice) / lastClose * 100)
        : Math.max(0, (finalBreakEvenPrice - lastClose) / lastClose * 100))
      : 0;
    return {
      symbol,
      variant: variant || (riskStateMachine ? 'risk-state-machine' : adaptive ? 'adaptive' : 'baseline'),
      start: firstEvaluationAt ? new Date(firstEvaluationAt).toISOString() : null,
      end: new Date(end).toISOString(),
      durationDays: round(durationDays, 2),
      netLiquidationPnl: round(netLiquidationPnl),
      realizedCashPnl: round(metrics.cashPnl),
      grossGridProfit: round(metrics.grossGridProfit),
      fundingPnl: round(metrics.fundingPnl),
      fees: round(fees),
      buyFees: round(metrics.buyFees),
      sellFees: round(metrics.sellFees),
      estimatedFinalExitFee: round(finalExitFee),
      finalInventoryQuantity: round(positionQuantity(), 12),
      finalInventoryNotional: round(finalMarketNotional),
      finalInventoryCost: round(inventoryEntryNotional()),
      finalInventoryNetPnl: round(openPositionNetPnl(lastClose || 0)),
      finalPositionSide: finalPositionSides.length === 1 ? finalPositionSides[0] : null,
      finalInventoryAgeHours: round(finalInventoryAgeHours, 2),
      finalBreakEvenPrice: round(finalBreakEvenPrice, 12),
      finalBreakEvenDistancePct: round(finalBreakEvenDistancePct, 3),
      liquidationComponent: round(liquidationComponent),
      accountingIdentityDelta: round(
        netLiquidationPnl - (metrics.grossGridProfit + metrics.fundingPnl + liquidationComponent - fees),
        9
      ),
      returnOnNotionalPct: round(netLiquidationPnl / options.totalInvestment * 100, 3),
      returnOnInitialMarginPct: round(netLiquidationPnl / (options.totalInvestment / options.leverage) * 100, 3),
      maximumDrawdown: round(maximumDrawdown),
      maximumDrawdownOnNotionalPct: round(maximumDrawdown / options.totalInvestment * 100, 3),
      maxInventoryNotional: round(metrics.maxInventoryNotional),
      maxPendingBuyNotional: round(metrics.maxPendingBuyNotional),
      maxInventoryAgeHours: round(metrics.maxInventoryAgeHours, 2),
      inventoryNotionalHours: round(metrics.inventoryNotionalHours),
      staleInventoryNotionalHours: round(metrics.staleInventoryNotionalHours),
      exposureAbove90Pct: metrics.exposureSamples
        ? round(metrics.exposureAbove90Samples / metrics.exposureSamples * 100, 2)
        : null,
      buyFills: metrics.buyFills,
      sellFills: metrics.sellFills,
      longEntryFills: metrics.longEntryFills,
      shortEntryFills: metrics.shortEntryFills,
      handoffSignals: metrics.handoffSignals,
      handoffCompleted: metrics.handoffCompleted,
      handoffCancelled: metrics.handoffCancelled,
      handoffExitFills: metrics.handoffExitFills,
      handoffRescueOrders: metrics.handoffRescueOrders,
      handoffRescueFills: metrics.handoffRescueFills,
      handoffProfitBankOrders: metrics.handoffProfitBankOrders,
      handoffProfitBankFills: metrics.handoffProfitBankFills,
      handoffProfitBankFullExits: metrics.handoffProfitBankFullExits,
      handoffProfitBankPartialExits: metrics.handoffProfitBankPartialExits,
      handoffProfitBankExitNotional: round(metrics.handoffProfitBankExitNotional),
      handoffProfitBankRealizedPnl: round(metrics.handoffProfitBankRealizedPnl),
      blockedEntrySamples: metrics.blockedEntrySamples,
      entryFilterBlockedSamples: metrics.entryFilterBlockedSamples,
      gridCycles: metrics.gridCycles,
      rangeResets: metrics.rangeResets,
      skippedBelowMinimum: metrics.skippedBelowMinimum,
      skippedByReserve: metrics.skippedByReserve,
      profileCoveragePct: Object.fromEntries(Object.entries(metrics.profileSamples).map(([profile, count]) => [
        profile,
        metrics.exposureSamples ? round(count / metrics.exposureSamples * 100, 2) : 0,
      ])),
      riskStateCoveragePct: Object.fromEntries(Object.entries(metrics.riskStateSamples).map(([state, count]) => [
        state,
        metrics.exposureSamples ? round(count / metrics.exposureSamples * 100, 2) : 0,
      ])),
    };
  }
}

module.exports = {
  DEFAULT_OPTIONS,
  FullGridBacktester,
  chooseSpacedLevels,
  entryDirectionAllows,
  geometricLevels,
  minimumProfitableSellPrice,
  maximumProfitableShortBuyPrice,
  selectProfitableExitLevel,
  zoneForRank,
};
