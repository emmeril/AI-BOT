const {
  analyzeTimeframe,
  aggregateTimeframes,
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
const BASE_TIMEFRAME_MS = 15 * MINUTE_MS;
const RANGE_TIMEFRAMES = ['15m', '30m', '1h', '4h', '1d', '1w'];
const DIRECTION_TIMEFRAMES = ['15m', '1h', '4h'];

const DEFAULT_OPTIONS = Object.freeze({
  gridCount: 27,
  totalInvestment: 150,
  leverage: 5,
  maxActiveBuyOrders: 20,
  maxRefills: 2,
  makerFeeRate: 0.0002,
  minimumNetProfitPct: 0.05,
  minimumNotional: 5,
  candleLimit: 100,
  rangeWidthPct: 20,
  rangeRebuildThresholdPct: 2,
  rangeRebuildCooldownMs: 120 * MINUTE_MS,
  directionMinimumConfidence: 0.65,
  directionLevelBiasPct: 10,
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

function chooseSpacedLevels(candidates, multiplier) {
  return selectSpacedBuyLevels(candidates, multiplier);
}

function latestClosedCandles(series, indices) {
  const result = [];
  for (const timeframe of RANGE_TIMEFRAMES) {
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
    exposureSamples: 0,
    exposureAbove90Samples: 0,
    profileSamples: { BULLISH: 0, SIDEWAYS: 0, BEARISH: 0, RISK_OFF: 0 },
  };
}

class FullGridBacktester {
  constructor(exchange, options = {}) {
    this.exchange = exchange;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.rangeSuggestionCache = new Map();
  }

  prepareSeries(rows) {
    return {
      '15m': rows,
      '30m': resampleCandles(rows, 30 * MINUTE_MS),
      '1h': resampleCandles(rows, 60 * MINUTE_MS),
      '4h': resampleCandles(rows, 4 * 60 * MINUTE_MS),
      '1d': resampleCandles(rows, 24 * 60 * MINUTE_MS),
      '1w': resampleCandles(rows, 7 * 24 * 60 * MINUTE_MS),
    };
  }

  createRangeAdvisor() {
    const options = this.options;
    const minimumStepRatio = (1 + options.minimumNetProfitPct / 100 + options.makerFeeRate) /
      (1 - options.makerFeeRate);
    return new FibonacciRangeAdvisor(this.exchange, {
      enabled: true,
      timeframes: RANGE_TIMEFRAMES,
      ratios: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618],
      candleCloseBufferMs: 5000,
      clusterTolerancePct: 0.15,
      minClusterScore: 1,
      minRangeWidthPct: 6,
      maxDistancePct: 25,
      rebuildThresholdPct: options.rangeRebuildThresholdPct,
      rebuildCooldownMs: options.rangeRebuildCooldownMs,
      levelCount: options.gridCount + 1,
      minimumStepRatio,
      directionLevelBiasPct: options.directionLevelBiasPct,
      statePath: '',
    });
  }

  simulate({ symbol, rows, fundingRates = [], start, end, adaptive = false }) {
    const options = this.options;
    const series = this.prepareSeries(rows);
    const rangeAdvisor = this.createRangeAdvisor();
    const supervisor = new AdaptiveGridSupervisor({
      minimumConfidence: options.directionMinimumConfidence,
      profileConfirmations: 3,
      cooldownMs: 120 * MINUTE_MS,
      riskExposureRatio: 0.9,
    });
    const directionConfirmation = { candidate: 'RANGING', count: 0 };
    const indices = Object.fromEntries(RANGE_TIMEFRAMES.map(timeframe => [timeframe, -1]));
    const metrics = createMetrics();
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

    const funding = [...fundingRates]
      .map(item => ({ timestamp: Number(item.timestamp), rate: Number(item.rate) }))
      .filter(item => Number.isFinite(item.timestamp) && Number.isFinite(item.rate))
      .sort((left, right) => left.timestamp - right.timestamp);

    const inventoryEntryNotional = () => lots.reduce((sum, lot) => sum + lot.entryCost, 0);
    const pendingNotional = () => [...pendingBuys.values()].reduce((sum, order) => sum + order.notional, 0);
    const exposureNotional = () => inventoryEntryNotional() + pendingNotional();
    const positionQuantity = () => lots.reduce((sum, lot) => sum + lot.quantity, 0);

    const updateSellTargets = currentPrice => {
      if (!activeSuggestion?.levels?.length) return;
      for (const lot of lots) {
        if (lot.sellTarget && lot.sellPlacedAt < lot.lastRangeResetAt) lot.sellTarget = null;
        if (lot.sellTarget) continue;
        const minimum = Math.max(minimumProfitableSellPrice(lot, options), currentPrice);
        let target = activeSuggestion.levels.find(level => level > minimum + 1e-12);
        if (!target) {
          const highest = activeSuggestion.levels.at(-1);
          const tickGuess = highest * 1e-8;
          target = minimum + Math.max(tickGuess, minimum * 1e-8);
        }
        target = getMarketNumber(this.exchange, 'priceToPrecision', symbol, target);
        if (target > minimumProfitableSellPrice(lot, options) && target > currentPrice) {
          lot.sellTarget = target;
          lot.sellPlacedAt = lot.lastUpdatedAt;
        }
      }
    };

    const rebuildRange = (suggestion, now, currentPrice) => {
      activeSuggestion = suggestion;
      lastRangeAppliedAt = now;
      rangeGeneration++;
      pendingBuys.clear();
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

    const placeBuyOrders = (currentPrice, now) => {
      if (!activeSuggestion?.levels?.length) return;
      const recommendation = adaptive && lastDecision
        ? lastDecision.recommendation
        : { buyWeight: { upper: 1, middle: 1, lower: 1 }, spacingMultiplier: 1 };
      const cap = options.totalInvestment;
      const occupied = new Set(lots.filter(lot => lot.generation === rangeGeneration).map(lot => lot.levelIndex));
      const candidates = activeSuggestion.levels
        .map((price, levelIndex) => ({ price, levelIndex }))
        .filter(item => item.price < currentPrice && !occupied.has(item.levelIndex) && !pendingBuys.has(item.levelIndex))
        .sort((left, right) => right.price - left.price);
      const spaced = chooseSpacedLevels(candidates, recommendation.spacingMultiplier)
        .slice(0, options.maxActiveBuyOrders);
      const count = spaced.length;
      for (let rank = 0; rank < count; rank++) {
        const candidate = spaced[rank];
        const fills = slotFillCounts.get(candidate.levelIndex) || 0;
        if (fills > options.maxRefills) continue;
        const zone = zoneForRank(rank + 1, count);
        const weight = Number(recommendation.buyWeight[zone]) || 0;
        const targetNotional = options.totalInvestment / options.gridCount * weight;
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
        });
      }
    };

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const candle = rows[rowIndex];
      const [timestamp, open, high, low, close] = candle;
      const evaluationTime = timestamp + BASE_TIMEFRAME_MS;
      if (evaluationTime < start) continue;
      if (timestamp >= end) break;
      lastClose = close;

      while (fundingIndex < funding.length && funding[fundingIndex].timestamp < timestamp) fundingIndex++;
      while (fundingIndex < funding.length && funding[fundingIndex].timestamp < timestamp + BASE_TIMEFRAME_MS) {
        const event = funding[fundingIndex];
        if (event.timestamp >= timestamp) {
          const pnl = -positionQuantity() * open * event.rate;
          metrics.fundingPnl += pnl;
          metrics.cashPnl += pnl;
        }
        fundingIndex++;
      }

      for (let index = lots.length - 1; index >= 0; index--) {
        const lot = lots[index];
        if (!(lot.sellTarget > 0) || lot.sellPlacedAt > timestamp || high + 1e-12 < lot.sellTarget) continue;
        const proceeds = lot.quantity * lot.sellTarget;
        const sellFee = proceeds * options.makerFeeRate;
        metrics.grossGridProfit += proceeds - lot.entryCost;
        metrics.sellFees += sellFee;
        metrics.cashPnl += proceeds - lot.entryCost - sellFee;
        metrics.sellFills++;
        metrics.gridCycles++;
        slotFillCounts.set(lot.levelIndex, (slotFillCounts.get(lot.levelIndex) || 0) + 1);
        lots.splice(index, 1);
      }

      for (const [levelIndex, order] of [...pendingBuys.entries()]) {
        if (order.generation !== rangeGeneration || order.placedAt > timestamp || low - 1e-12 > order.price) continue;
        const buyFee = order.notional * options.makerFeeRate;
        metrics.buyFees += buyFee;
        metrics.cashPnl -= buyFee;
        metrics.buyFills++;
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
        });
        pendingBuys.delete(levelIndex);
      }

      for (const timeframe of RANGE_TIMEFRAMES) {
        indices[timeframe] = completedIndex(
          series[timeframe], timeframeToMs(timeframe), evaluationTime, indices[timeframe]
        );
      }
      if (DIRECTION_TIMEFRAMES.every(timeframe => indices[timeframe] + 1 >= options.candleLimit)) {
        const timeframeResults = DIRECTION_TIMEFRAMES.map(timeframe => analyzeTimeframe(
          series[timeframe].slice(indices[timeframe] + 1 - options.candleLimit, indices[timeframe] + 1),
          timeframe
        ));
        if (timeframeResults.every(Boolean)) {
          const aggregate = aggregateTimeframes(timeframeResults);
          const confirmedDirection = applyConfirmation(aggregate, directionConfirmation);
          lastAnalysis = { ...aggregate, confirmedDirection };
        }
      }

      const inventoryMarketNotional = positionQuantity() * close;
      const exposureRatio = (inventoryMarketNotional + pendingNotional()) / options.totalInvestment;
      if (lastAnalysis) {
        lastDecision = supervisor.evaluate(symbol, {
          analysis: lastAnalysis,
          exposureRatio,
          now: evaluationTime,
          signalId: timestamp,
        });
        metrics.profileSamples[lastDecision.profile]++;
      }

      const direction = lastAnalysis?.confidence >= options.directionMinimumConfidence &&
        ['BULLISH', 'BEARISH'].includes(lastAnalysis.confirmedDirection)
        ? lastAnalysis.confirmedDirection
        : 'RANGING';
      const outsideActiveRange = activeSuggestion &&
        (close <= activeSuggestion.lower || close >= activeSuggestion.upper);
      const shouldEvaluateRange = !activeSuggestion || outsideActiveRange ||
        evaluationTime - lastSuggestionComputedAt >= options.rangeRebuildCooldownMs;
      if (shouldEvaluateRange) {
        const cacheKey = `${symbol}|${timestamp}|${direction}`;
        let suggestion = this.rangeSuggestionCache.get(cacheKey);
        if (!suggestion) {
          const closedCandles = latestClosedCandles(series, indices);
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
      placeBuyOrders(close, evaluationTime);
      const marketNotional = positionQuantity() * close;
      const pending = pendingNotional();
      metrics.maxInventoryNotional = Math.max(metrics.maxInventoryNotional, marketNotional);
      metrics.maxPendingBuyNotional = Math.max(metrics.maxPendingBuyNotional, pending);
      metrics.exposureSamples++;
      if ((marketNotional + pending) / options.totalInvestment >= 0.9) metrics.exposureAbove90Samples++;

      const estimatedExitFee = marketNotional * options.makerFeeRate;
      const unrealized = marketNotional - inventoryEntryNotional() - estimatedExitFee;
      const equity = options.totalInvestment / options.leverage + metrics.cashPnl + unrealized;
      peakEquity = Math.max(peakEquity, equity);
      maximumDrawdown = Math.max(maximumDrawdown, peakEquity - equity);
      if (!firstEvaluationAt) firstEvaluationAt = evaluationTime;
    }

    const finalMarketNotional = positionQuantity() * (lastClose || 0);
    const finalExitFee = finalMarketNotional * options.makerFeeRate;
    const liquidationComponent = finalMarketNotional - inventoryEntryNotional();
    const netLiquidationPnl = metrics.cashPnl + liquidationComponent - finalExitFee;
    const fees = metrics.buyFees + metrics.sellFees + finalExitFee;
    const durationDays = firstEvaluationAt ? Math.max(0, (Math.min(end, rows.at(-1)[0] + BASE_TIMEFRAME_MS) - firstEvaluationAt) / 86_400_000) : 0;
    return {
      symbol,
      variant: adaptive ? 'adaptive' : 'baseline',
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
      exposureAbove90Pct: metrics.exposureSamples
        ? round(metrics.exposureAbove90Samples / metrics.exposureSamples * 100, 2)
        : null,
      buyFills: metrics.buyFills,
      sellFills: metrics.sellFills,
      gridCycles: metrics.gridCycles,
      rangeResets: metrics.rangeResets,
      skippedBelowMinimum: metrics.skippedBelowMinimum,
      skippedByReserve: metrics.skippedByReserve,
      profileCoveragePct: Object.fromEntries(Object.entries(metrics.profileSamples).map(([profile, count]) => [
        profile,
        metrics.exposureSamples ? round(count / metrics.exposureSamples * 100, 2) : 0,
      ])),
    };
  }
}

module.exports = {
  DEFAULT_OPTIONS,
  FullGridBacktester,
  chooseSpacedLevels,
  geometricLevels,
  minimumProfitableSellPrice,
  zoneForRank,
};
