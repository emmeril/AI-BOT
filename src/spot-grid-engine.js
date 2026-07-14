const ccxt = require('ccxt');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const {
  SYMBOLS,
  EXCHANGE_MODE,
  MINUTE_MS,
  INTERVAL_MS,
  GRID_COUNT,
  GRID_MODE,
  GRID_LOWER_PRICE,
  GRID_UPPER_PRICE,
  GRID_RANGE_PCT,
  GRID_RESET_RANGE_ON_START,
  GRID_STALE_RANGE_DEVIATION_PCT,
  GRID_STALE_RANGE_AUTO_RESET,
  GRID_TRAILING_RANGE_ENABLED,
  GRID_TRAILING_UP_ENABLED,
  GRID_TRAILING_UP_COOLDOWN_MS,
  GRID_TRAILING_DOWN_ENABLED,
  GRID_TRAILING_DOWN_COOLDOWN_MS,
  GRID_ORDER_SIZE_USDT,
  GRID_TOTAL_INVESTMENT_USDT,
  GRID_MAX_ACTIVE_BUY_ORDERS,
  GRID_MAX_ACTIVE_SELL_ORDERS,
  GRID_RECREATE_ON_START,
  GRID_CANCEL_OUT_OF_RANGE,
  GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MS,
  GRID_REFILL_ON_FILLED,
  GRID_STATE_FILE,
  GRID_POST_ONLY,
  GRID_PRICE_PRECISION_MAX_DEVIATION_PCT,
  GEMINI_RANGE_ADVISOR_ENABLED,
  GEMINI_MODEL,
  GEMINI_RANGE_ADVISOR_TIMEFRAME,
  GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT,
  GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE,
  GEMINI_RANGE_ADVISOR_APPLY_ON,
  STOP_LOSS_PRICE,
  TAKE_PROFIT_PRICE,
  KILL_SWITCH_ENABLED,
  STOP_TRADING,
  KILL_SWITCH_FILE,
  KILL_SWITCH_PATH,
  TELEGRAM_ENABLED,
  TRADE_FETCH_LIMIT,
  CIRCUIT_BREAKER_MAX_ERRORS,
  CIRCUIT_BREAKER_PAUSE_MS,
  hasManualGridRange
} = require('./config');
const { ExchangeManager } = require('./exchange-manager');
const { GridState } = require('./grid-state');
const { GeminiRangeAdvisor } = require('./gemini-range-advisor');
const { applyTelegramMethods } = require('./telegram-controller');
const { applyTrailingRangeMethods } = require('./trailing-range');
const { applyOrderExecutionMethods } = require('./order-execution');
const { sleep, retry, roundNumber, numberOrZero } = require('./utils');

const symbolLockContext = new AsyncLocalStorage();

function killSwitchActive() {
  if (STOP_TRADING) return true;
  if (!KILL_SWITCH_ENABLED) return false;
  try {
    return fs.existsSync(KILL_SWITCH_PATH);
  } catch {
    return false;
  }
}

function tradeFetchResult(trades, holdWatermark = false) {
  return { trades, holdWatermark };
}

class SpotGridEngine {
  constructor() {
    this.exchange = ExchangeManager.getInstance();
    this.state = new GridState();
    this.isRunning = false;
    this.symbolLocks = new Map();
    this.pendingOrderLevels = new Set();
    this.rangeResetSymbols = new Set();
    this.circuitBreaker = { errors: 0, pausedUntil: 0 };
    this.telegramUpdateOffset = null;
    this.telegramPolling = false;
    this.telegramStatusReporting = false;
    this.telegramCommandTimer = null;
    this.telegramStatusTimer = null;
    // for stuck investment warning deduplication
    this.stuckInvestmentWarned = new Set();
    this.rangeAdvisor = new GeminiRangeAdvisor(this.exchange);
  }

  async init() {
    await retry(() => this.exchange.loadMarkets());
    for (const symbol of SYMBOLS) {
      try {
        this.ensureMarket(symbol);
        this.warnIfPerGridSizeBelowMinCost(symbol);
        if (GRID_RECREATE_ON_START) await this.cancelGridOrders(symbol, 'recreate-on-start');
        await this.reconcileSymbol(symbol);
      } catch (err) {
        console.error(`[INIT] ${symbol}`, err);
        this.recordError();
      }
    }
  }

  warnIfPerGridSizeBelowMinCost(symbol) {
    const minCost = this.getMinCost(symbol);
    if (!(minCost > 0)) return;
    const perGridSize = this.getOrderSizeUsdt();
    if (perGridSize >= minCost) return;
    console.warn(
      `[CONFIG] ${symbol} per-grid order size ${roundNumber(perGridSize, 8)} USDT is below this symbol's ` +
      `exchange minimum order cost ${minCost} USDT. Some buy levels may never be able to place an order. ` +
      `Consider lowering GRID_COUNT or raising GRID_TOTAL_INVESTMENT_USDT/GRID_ORDER_SIZE_USDT.`
    );
  }

  ensureMarket(symbol) {
    if (!this.exchange.markets[symbol]) {
      throw new Error(`Symbol ${symbol} not found on Binance spot market.`);
    }
  }

  circuitAllows() {
    return this.circuitBreaker.pausedUntil <= Date.now();
  }

  recordError() {
    this.circuitBreaker.errors++;
    if (this.circuitBreaker.errors >= CIRCUIT_BREAKER_MAX_ERRORS) {
      this.circuitBreaker.pausedUntil = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
      this.circuitBreaker.errors = 0;
      console.warn(`[CIRCUIT] Too many errors. Paused ${CIRCUIT_BREAKER_PAUSE_MS / MINUTE_MS}m.`);
    }
  }

  recordSuccess() {
    this.circuitBreaker.errors = 0;
  }

  canPlaceNewOrders() {
    return !killSwitchActive();
  }

  getOrderSizeUsdt() {
    if (GRID_TOTAL_INVESTMENT_USDT > 0) {
      return GRID_TOTAL_INVESTMENT_USDT / Math.max(GRID_COUNT, 1);
    }
    return GRID_ORDER_SIZE_USDT;
  }

  isStoredRangeStale(symbol, currentPrice, lower, upper) {
    if (!(lower > 0) || !(upper > 0) || !(currentPrice > 0)) return false;
    if (currentPrice >= lower && currentPrice <= upper) return false;
    const distance = currentPrice < lower ? (lower - currentPrice) : (currentPrice - upper);
    const rangeSize = upper - lower;
    const deviationPct = rangeSize > 0 ? (distance / rangeSize) * 100 : Infinity;
    if (deviationPct <= GRID_STALE_RANGE_DEVIATION_PCT) return false;
    console.warn(
      `[RANGE] ${symbol} stored range ${roundNumber(lower)}-${roundNumber(upper)} is stale: ` +
      `current price ${roundNumber(currentPrice)} is ${roundNumber(deviationPct, 1)}% outside the range ` +
      `(threshold ${GRID_STALE_RANGE_DEVIATION_PCT}%).`
    );
    return true;
  }

  // Completes a range reset/trailing shift that a previous process
  // instance started (and persisted a marker for, BEFORE cancelling any
  // exchange orders) but never finished. Exchange orders for the old range
  // may already be gone; cancelGridOrders() below is a harmless no-op for
  // any that already are, and will retry any that turn out not to be.
  // Re-running the same function that was interrupted, with the exact
  // bounds recorded in the marker, keeps this a single code path with the
  // normal reset/shift logic rather than a separate parallel recovery path.
  async resumeInterruptedRangeTransition(symbol, transition) {
    console.warn(
      `[RANGE] ${symbol} resuming ${transition.kind === 'trail' ? 'trailing shift' : 'range reset'} ` +
      `interrupted by a previous restart: ${roundNumber(transition.oldLower)}-${roundNumber(transition.oldUpper)} -> ` +
      `${roundNumber(transition.newLower)}-${roundNumber(transition.newUpper)}`
    );
    if (transition.kind === 'trail') {
      const shift = { lower: transition.newLower, upper: transition.newUpper, steps: transition.steps };
      return await this.applyTrailingRangeShift(
        symbol, transition.oldLower, transition.oldUpper, shift, transition.direction
      );
    }
    await this.remapStateAfterRangeReset(
      symbol, transition.oldLower, transition.oldUpper, transition.newLower, transition.newUpper, transition.levels
    );
    const symState = this.state.getSymbol(symbol);
    symState.config = {
      ...symState.config,
      lower: transition.newLower,
      upper: transition.newUpper,
      autoRange: symState.config.autoRange !== false,
    };
    await this.state.save();
    return { lower: transition.newLower, upper: transition.newUpper, levels: transition.levels || null };
  }

  async buildRange(symbol, currentPrice) {
    const symState = this.state.getSymbol(symbol);

    // If a previous cycle crashed/restarted after orders were already
    // cancelled on the exchange for a range reset/trailing shift but before
    // the local remap finished being persisted, finish that SAME transition
    // now instead of computing a brand-new range from the current price.
    // Recomputing fresh here would risk landing on a different range than
    // the one orders were actually cancelled for, leaving lastBuyByLevel
    // permanently mismatched against reality.
    if (symState.rangeTransition) {
      return await this.resumeInterruptedRangeTransition(symbol, symState.rangeTransition);
    }

    const manualRange = hasManualGridRange();
    let storedLower = Number(symState.config.lower) || 0;
    let storedUpper = Number(symState.config.upper) || 0;
    // Captured BEFORE storedLower/storedUpper get zeroed out below, so we
    // still know what the previous range was if a reset happens.
    const previousLower = storedLower;
    const previousUpper = storedUpper;
    const previousLevels = Array.isArray(symState.config.aiAdvisor?.levels)
      ? symState.config.aiAdvisor.levels.map(Number)
      : null;

    if (!manualRange && storedLower > 0 && storedUpper > 0) {
      const stale = this.isStoredRangeStale(symbol, currentPrice, storedLower, storedUpper);
      if (stale) {
        if (GRID_STALE_RANGE_AUTO_RESET) {
          console.warn(`[RANGE] ${symbol} auto-resetting stale range around current price (GRID_STALE_RANGE_AUTO_RESET=true).`);
          storedLower = 0;
          storedUpper = 0;
        } else {
          console.warn(
            `[RANGE] ${symbol} keeping stale stored range because GRID_STALE_RANGE_AUTO_RESET=false. ` +
            `Set GRID_STALE_RANGE_AUTO_RESET=true to auto re-center, or set GRID_RESET_RANGE_ON_START=true, ` +
            `or clear ${GRID_STATE_FILE} manually if this range no longer reflects the market.`
          );
        }
      }
    }

    const resetAutoRange = !manualRange &&
      GRID_RESET_RANGE_ON_START &&
      !(this.rangeResetSymbols && this.rangeResetSymbols.has(symbol));

    // Smart Grid Range Advisor: ask Gemini for a recommended range. Only
    // considered when it's allowed to influence this symbol's range mode
    // (AUTO_RANGE_ONLY = never override a manual GRID_LOWER/UPPER_PRICE range;
    // ALWAYS = also override manual ranges) and when confidence clears the bar.
    const advisorAllowed = GEMINI_RANGE_ADVISOR_APPLY_ON === 'ALWAYS' || !manualRange;
    let aiSuggestion = null;
    if (advisorAllowed) {
      aiSuggestion = await this.rangeAdvisor.getSuggestion(symbol, currentPrice);
      if (aiSuggestion && aiSuggestion.confidence < GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE) {
        console.log(
          `[GEMINI] ${symbol} suggestion confidence ${aiSuggestion.confidence} below threshold ` +
          `${GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE}; ignoring for this cycle.`
        );
        aiSuggestion = null;
      }
    }

    const fallbackLower = (resetAutoRange ? 0 : storedLower) || currentPrice * (1 - GRID_RANGE_PCT / 100);
    const fallbackUpper = (resetAutoRange ? 0 : storedUpper) || currentPrice * (1 + GRID_RANGE_PCT / 100);
    const lower = manualRange
      ? (aiSuggestion ? aiSuggestion.lower : GRID_LOWER_PRICE)
      : (aiSuggestion ? aiSuggestion.lower : fallbackLower);
    const upper = manualRange
      ? (aiSuggestion ? aiSuggestion.upper : GRID_UPPER_PRICE)
      : (aiSuggestion ? aiSuggestion.upper : fallbackUpper);
    if (lower <= 0 || upper <= 0 || lower >= upper) {
      throw new Error(`Invalid grid range. lower=${lower}, upper=${upper}`);
    }

    const aiLevels = this.getAiGridLevels(symbol, aiSuggestion, lower, upper, currentPrice);

    // Unlike a trailing shift (which is a parallel translation of the same
    // grid, handled by applyTrailingRangeShift's offset-based remap), a
    // stale-range auto-reset, GRID_RESET_RANGE_ON_START, or a fresh Gemini
    // range-advisor suggestion can all produce a brand-new lower/upper with
    // no fixed relationship to the old one. If we simply swap symState.config
    // without reconciling, any open managed orders and accumulated
    // lastBuyByLevel records stay indexed against the OLD grid's level
    // numbering while levels[] is rebuilt from the NEW range - silently
    // desyncing buy/sell pairing, P&L, and refill prices. Reconcile BEFORE
    // the new range is persisted. Note: this deliberately does NOT gate on
    // `rangeWasReset` - any actual change to lower/upper (whatever the
    // cause) needs the same remap, since the level-index-to-price mapping
    // has no guaranteed relationship to the previous cycle's mapping.
    const effectiveGridChanged = previousLower > 0 && previousUpper > 0 &&
      !this.effectiveGridLevelsEqual(symbol, previousLower, previousUpper, previousLevels, lower, upper, aiLevels);
    if (effectiveGridChanged) {
      await this.remapStateAfterRangeReset(symbol, previousLower, previousUpper, lower, upper, aiLevels);
    }

    symState.config = {
      mode: GRID_MODE,
      count: GRID_COUNT,
      lower,
      upper,
      autoRange: !manualRange,
      orderSizeUsdt: this.getOrderSizeUsdt(),
      aiAdvisor: aiSuggestion ? {
        confidence: aiSuggestion.confidence,
        marketCondition: aiSuggestion.marketCondition,
        reasoning: aiSuggestion.reasoning,
        levels: aiLevels || undefined,
        appliedAt: new Date().toISOString(),
      } : undefined,
    };
    if (resetAutoRange) {
      if (!this.rangeResetSymbols) this.rangeResetSymbols = new Set();
      this.rangeResetSymbols.add(symbol);
    }
    await this.state.save();
    return { lower, upper, levels: aiLevels };
  }

  /**
   * Reconciles open grid order metadata and accumulated buy records when the
   * range is RESET to a brand-new lower/upper (stale-range auto-reset or
   * GRID_RESET_RANGE_ON_START), as opposed to incrementally TRAILED.
   *
   * A trailing shift is a parallel translation of the existing grid, so
   * applyTrailingRangeShift can safely fix it up with a constant level-index
   * offset. A reset has no such fixed relationship to the old grid (the new
   * lower/upper/step can be completely different), so old level indexes are
   * meaningless against the new grid. Instead we:
   *   1. Cancel any bot-managed open orders - they were placed at OLD-range
   *      prices and no longer correspond to any level on the NEW grid. Left
   *      alone, they'd sit there until GRID_CANCEL_OUT_OF_RANGE eventually
   *      catches them (if even enabled), with state.orders meanwhile
   *      pointing at stale level indexes.
   *   2. Re-map each accumulated buy record (lastBuyByLevel) from its OLD
   *      level index to whichever NEW level its actual average fill price
   *      lands closest to, merging records that collapse onto the same new
   *      level (same weighted-average merge used by applyTrailingRangeShift)
   *      so a future sell fill still finds the correct cost basis at
   *      levelIndex - 1 on the NEW grid.
   */
  async remapStateAfterRangeReset(symbol, oldLower, oldUpper, newLower, newUpper, newLevelsOverride = null) {
    const symState = this.state.getSymbol(symbol);

    // Persist the transition BEFORE the irreversible step (cancelling live
    // orders on the exchange). If the process dies anywhere after this point
    // and before the marker is cleared below, resumeInterruptedRangeTransition()
    // will find it on the next cycle and finish remapping onto this exact
    // oldLower/oldUpper -> newLower/newUpper pair, instead of buildRange
    // computing a fresh (possibly different) range while orders that were
    // already cancelled sit unaccounted for against stale local state.
    if (!symState.rangeTransition || symState.rangeTransition.kind !== 'reset' ||
        symState.rangeTransition.newLower !== newLower || symState.rangeTransition.newUpper !== newUpper) {
      symState.rangeTransition = { kind: 'reset', oldLower, oldUpper, newLower, newUpper, levels: newLevelsOverride || undefined };
      await this.state.save();
    }

    const cancelResult = await this.cancelGridOrders(symbol, 'range-reset');
    if (cancelResult.failed.length > 0) {
      const failedIds = cancelResult.failed.map(f => f.id).join(', ');
      // Abort the remap entirely: some orders are still live on the
      // exchange. If we clear local state below anyway, those orders become
      // "ghost" orders - when getManagedOpenOrders() recovers them later via
      // clientOrderId, the embedded old level index may no longer be valid
      // against the new grid (different bounds/level count), corrupting
      // level tracking and P&L. Bail out and let the caller retry the reset
      // on the next cycle once all orders are confirmed cancelled.
      throw new Error(
        `[RANGE] ${symbol} range-reset aborted: ${cancelResult.failed.length} order cancellation(s) ` +
        `failed (ids: ${failedIds}). Will retry reset next cycle once all orders are cancelled.`
      );
    }
    if (Object.keys(symState.orders).length > 0) {
      console.warn(
        `[RANGE] ${symbol} had ${Object.keys(symState.orders).length} managed order(s) after cancellation; clearing stale local metadata`
      );
      symState.orders = {};
    }

    const oldEntries = Object.entries(symState.lastBuyByLevel);
    if (oldEntries.length === 0) {
      symState.rangeTransition = null;
      await this.state.save();
      return;
    }

    let newLevels;
    try {
      newLevels = newLevelsOverride || this.buildLevels(newLower, newUpper, symbol);
    } catch (err) {
      // New range can't even produce distinct levels for this symbol/tick
      // size - there is no sane new level to attribute old buys to. Clear
      // them rather than keep stale data that would corrupt P&L; buildRange
      // will throw separately on the next call if the range itself stays
      // invalid, which surfaces the problem to the operator.
      console.warn(
        `[RANGE] ${symbol} could not build levels for new range ${roundNumber(newLower)}-${roundNumber(newUpper)} ` +
        `during remap (${err.message}); clearing ${oldEntries.length} buy record(s) to avoid stale P&L data.`
      );
      symState.lastBuyByLevel = {};
      symState.rangeTransition = null;
      await this.state.save();
      return;
    }

    const remapped = {};
    for (const [oldIdx, buy] of oldEntries) {
      const fillPrice = Number(buy.price) || 0;
      if (!(fillPrice > 0)) continue;
      const newIdx = this.getLevelIndex(newLevels, fillPrice);
      const collapsed = Boolean(remapped[newIdx]);
      remapped[newIdx] = this.mergeBuyRecords(remapped[newIdx], buy, {
        aggregatedAcrossLevels: collapsed,
      });
      console.warn(
        `[RANGE] ${symbol} remapped buy record from old level ${oldIdx} (avg price ${roundNumber(fillPrice)}) ` +
        `to new level ${newIdx} after range reset ${roundNumber(oldLower)}-${roundNumber(oldUpper)} -> ` +
        `${roundNumber(newLower)}-${roundNumber(newUpper)}`
      );
    }
    symState.lastBuyByLevel = remapped;
    symState.rangeTransition = null;
    await this.state.save();

    console.log(
      `[RANGE] ${symbol} range reset: remapped ${oldEntries.length} buy record(s) onto new grid ` +
      `${roundNumber(newLower)}-${roundNumber(newUpper)}`
    );
    const boundsChanged = !this.effectiveRangeBoundsEqual(symbol, oldLower, oldUpper, newLower, newUpper);
    await this.sendAlert(this.formatTelegramMessage(boundsChanged ? 'Range Reset' : 'Grid Levels Rebuilt', [
      ['Symbol', symbol],
      ['Old', `${this.formatPrice(oldLower)} - ${this.formatPrice(oldUpper)}`],
      ['New', `${this.formatPrice(newLower)} - ${this.formatPrice(newUpper)}`],
      ['Bounds Changed', boundsChanged ? 'Yes' : 'No'],
      ['Remapped Buys', oldEntries.length],
    ]));
  }

  buildLevels(lower, upper, symbol = null) {
    if (GRID_COUNT < 2) throw new Error('GRID_COUNT minimal 2.');
    let levels;
    if (GRID_MODE === 'GEOMETRIC') {
      const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
      levels = Array.from({ length: GRID_COUNT + 1 }, (_, i) => lower * Math.pow(ratio, i));
      levels[0] = lower;
      levels[GRID_COUNT] = upper;
    } else {
      const step = (upper - lower) / GRID_COUNT;
      levels = Array.from({ length: GRID_COUNT + 1 }, (_, i) => lower + step * i);
      levels[0] = lower;
      levels[GRID_COUNT] = upper;
    }
    if (symbol) this.assertLevelsAreDistinct(symbol, levels, lower, upper);
    return levels;
  }

  getAiGridLevels(symbol, aiSuggestion, lower, upper, currentPrice) {
    if (!aiSuggestion) return null;
    const geminiLevels = aiSuggestion.levels
      ? this.getUsableCustomLevels(symbol, aiSuggestion.levels, lower, upper, 'Gemini')
      : null;
    if (geminiLevels) return geminiLevels;

    const adaptiveLevels = this.buildAdaptiveGridLevels(lower, upper, currentPrice);
    const usableAdaptiveLevels = this.getUsableCustomLevels(symbol, adaptiveLevels, lower, upper, 'adaptive-AI-range');
    if (usableAdaptiveLevels) {
      console.log(`[GRID] ${symbol} using adaptive levels from Gemini range around current price ${roundNumber(currentPrice)}`);
    }
    return usableAdaptiveLevels;
  }

  buildAdaptiveGridLevels(lower, upper, currentPrice) {
    if (GRID_COUNT < 2) throw new Error('GRID_COUNT minimal 2.');
    if (!(lower > 0) || !(upper > lower) || !(currentPrice > lower && currentPrice < upper)) {
      return this.buildLevels(lower, upper);
    }

    const range = upper - lower;
    const lowerShare = (currentPrice - lower) / range;
    const lowerIntervals = Math.max(1, Math.min(GRID_COUNT - 1, Math.round(GRID_COUNT * lowerShare)));
    const upperIntervals = GRID_COUNT - lowerIntervals;
    const concentration = 2;
    const levels = [];

    for (let i = 0; i <= lowerIntervals; i++) {
      const progress = i / lowerIntervals;
      levels.push(currentPrice - (currentPrice - lower) * Math.pow(1 - progress, concentration));
    }
    for (let i = 1; i <= upperIntervals; i++) {
      const progress = i / upperIntervals;
      levels.push(currentPrice + (upper - currentPrice) * Math.pow(progress, concentration));
    }

    levels[0] = lower;
    levels[levels.length - 1] = upper;
    return levels.map(level => roundNumber(level, 8));
  }

  getUsableCustomLevels(symbol, levels, lower, upper, source = 'custom') {
    if (!Array.isArray(levels)) return null;
    if (levels.length !== GRID_COUNT + 1) {
      console.warn(`[GRID] ${symbol} ignoring ${source} levels: expected ${GRID_COUNT + 1}, got ${levels.length}`);
      return null;
    }
    const normalized = levels.map(Number);
    if (normalized.some(level => !(level > 0) || !Number.isFinite(level))) {
      console.warn(`[GRID] ${symbol} ignoring ${source} levels: contains invalid price`);
      return null;
    }
    for (let i = 1; i < normalized.length; i++) {
      if (!(normalized[i] > normalized[i - 1])) {
        console.warn(`[GRID] ${symbol} ignoring ${source} levels: levels must be strictly increasing at index ${i}`);
        return null;
      }
    }
    const endpointTolerance = Math.max((upper - lower) * 0.0001, upper * 1e-8, 1e-12);
    if (Math.abs(normalized[0] - lower) > endpointTolerance ||
        Math.abs(normalized[normalized.length - 1] - upper) > endpointTolerance) {
      console.warn(`[GRID] ${symbol} ignoring ${source} levels: endpoints do not match range ${roundNumber(lower)}-${roundNumber(upper)}`);
      return null;
    }
    normalized[0] = lower;
    normalized[normalized.length - 1] = upper;
    try {
      this.assertLevelsAreDistinct(symbol, normalized, lower, upper);
    } catch (err) {
      console.warn(`[GRID] ${symbol} ignoring ${source} levels: ${err.message}`);
      return null;
    }
    return normalized;
  }

  levelArraysEqual(a, b) {
    if (!Array.isArray(a) && !Array.isArray(b)) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Number(a[i]) !== Number(b[i])) return false;
    }
    return true;
  }

  getEffectiveGridLevels(symbol, lower, upper, customLevels = null) {
    const levels = Array.isArray(customLevels)
      ? customLevels.map(Number)
      : this.buildLevels(lower, upper, symbol);
    return levels.map(level => this.getComparablePrice(symbol, level));
  }

  getComparablePrice(symbol, price) {
    try {
      return String(this.exchange.priceToPrecision(symbol, price));
    } catch {
      return String(roundNumber(price, 8));
    }
  }

  effectiveGridLevelsEqual(symbol, oldLower, oldUpper, oldLevels, newLower, newUpper, newLevels) {
    let oldEffective;
    let newEffective;
    try {
      oldEffective = this.getEffectiveGridLevels(symbol, oldLower, oldUpper, oldLevels);
      newEffective = this.getEffectiveGridLevels(symbol, newLower, newUpper, newLevels);
    } catch {
      return false;
    }
    if (oldEffective.length !== newEffective.length) return false;
    for (let i = 0; i < oldEffective.length; i++) {
      if (oldEffective[i] !== newEffective[i]) return false;
    }
    return true;
  }

  effectiveRangeBoundsEqual(symbol, oldLower, oldUpper, newLower, newUpper) {
    return this.getComparablePrice(symbol, oldLower) === this.getComparablePrice(symbol, newLower) &&
      this.getComparablePrice(symbol, oldUpper) === this.getComparablePrice(symbol, newUpper);
  }

  // Guards against grid levels collapsing onto the same exchange-rounded price.
  // This can happen when the range becomes too narrow relative to GRID_COUNT -
  // e.g. after several trailing up/down shifts, or a tight AI-suggested range -
  // causing the raw step size to fall below the exchange's price tick size.
  // Two distinct level indexes mapping to the same rounded price would otherwise
  // cause duplicate orders at an identical price, and would break getLevelIndex's
  // nearest-level matching (ties silently resolve to the lower index).
  assertLevelsAreDistinct(symbol, levels, lower, upper) {
    const tickSize = this.getMarketTickSize(symbol);
    if (!(tickSize > 0)) return;
    const rounded = levels.map(level => {
      try {
        return Number(this.exchange.priceToPrecision(symbol, level));
      } catch {
        return level;
      }
    });
    const seen = new Map();
    const collisions = [];
    rounded.forEach((price, index) => {
      if (seen.has(price)) {
        collisions.push({ a: seen.get(price), b: index, price });
      } else {
        seen.set(price, index);
      }
    });
    if (collisions.length > 0) {
      const detail = collisions
        .map(c => `level ${c.a} & ${c.b} -> ${c.price}`)
        .join(', ');
      throw new Error(
        `${symbol} grid range ${roundNumber(lower, 8)}-${roundNumber(upper, 8)} with GRID_COUNT=${GRID_COUNT} ` +
        `produces overlapping price levels after rounding to exchange tick size ${tickSize} (${detail}). ` +
        `Widen the range, lower GRID_COUNT, or use GRID_MODE=GEOMETRIC for a wide range on a low-priced asset.`
      );
    }
  }

  getLevelIndex(levels, price) {
    return levels.reduce((closestIndex, level, index) => {
      const currentDistance = Math.abs(level - price);
      const closestDistance = Math.abs(levels[closestIndex] - price);
      return currentDistance < closestDistance ? index : closestIndex;
    }, 0);
  }

  getNearestLevels(levels, currentPrice, side, limit) {
    const isBuy = side === 'buy';
    return levels
      .map((price, index) => ({ price, index }))
      .filter(level => isBuy ? level.price < currentPrice : level.price > currentPrice)
      .sort((a, b) => isBuy ? b.price - a.price : a.price - b.price)
      .slice(0, limit);
  }

  getBaseFree(balance, symbol) {
    return Number(balance?.free?.[this.getBaseAsset(symbol)] || 0);
  }

  getQuoteFree(balance, symbol) {
    return Number(balance?.free?.[this.getQuoteAsset(symbol)] || 0);
  }

  getBaseAsset(symbol) {
    return symbol.split('/')[0].toUpperCase();
  }

  getQuoteAsset(symbol) {
    return symbol.split('/')[1].split(':')[0].toUpperCase();
  }

  getMinCost(symbol) {
    const market = this.exchange.markets[symbol];
    return Number(market?.limits?.cost?.min || 0);
  }

  // Smallest price increment the exchange will accept/round to for this symbol.
  // Used to detect when grid levels would collapse onto the same price after
  // rounding (e.g. range too narrow for GRID_COUNT, or after several trailing
  // shifts / a tight AI-suggested range).
  getMarketTickSize(symbol) {
    const market = this.exchange?.markets?.[symbol];
    const precisionPrice = market?.precision?.price;
    if (precisionPrice && precisionPrice > 0) {
      // ccxt may express price precision either as a tick size (e.g. 0.01) or
      // as a decimal-place count (e.g. 2). Treat values >= 1 as decimal places.
      return precisionPrice >= 1 ? Math.pow(10, -precisionPrice) : precisionPrice;
    }
    const minPriceLimit = Number(market?.limits?.price?.min || 0);
    return minPriceLimit > 0 ? minPriceLimit : 0.00000001;
  }

  getTradeFeeCurrency(trade) {
    return String(trade.fee?.currency || trade.info?.commissionAsset || '').toUpperCase();
  }

  getTradeFeeCost(trade) {
    return Number(trade.fee?.cost || trade.info?.commission || 0);
  }

  feeToQuote(feeCost, feeCurrency, price, baseAsset, quoteAsset) {
    if (!feeCurrency || feeCost === 0) return 0;
    if (feeCurrency === quoteAsset) return feeCost;
    if (feeCurrency === baseAsset) return feeCost * price;
    // Third-party fee token (e.g. BNB).  We cannot convert synchronously
    // without a live price - use the cached rate if available, otherwise 0.
    // Call cacheFeeTokenPrice() asynchronously to keep rates fresh.
    const cachedRate = this.feeTokenRates?.get(feeCurrency);
    if (cachedRate > 0) {
      return feeCost * cachedRate;
    }
    console.warn(
      `[FEE] Fee currency "${feeCurrency}" is neither base (${baseAsset}) nor quote ` +
      `(${quoteAsset}). No cached rate available - recording fee as 0 ${quoteAsset}. ` +
      `Rate will be fetched in the background. Consider switching Binance fee payment ` +
      `to ${quoteAsset} for accurate P&L.`
    );
    return 0;
  }

  formatTradeFeeDisplay(feeQuote, feeCost, feeCurrency, baseAsset, quoteAsset) {
    const quoteText = `${this.formatMoney(feeQuote)} ${quoteAsset}`;
    if (!(feeCost > 0) || !feeCurrency || feeCurrency === quoteAsset) return quoteText;
    const rawText = `${this.formatAmount(feeCost)} ${feeCurrency}`;
    if (feeQuote > 0) return `${quoteText} (${rawText})`;
    if (feeCurrency === baseAsset) return `${quoteText} (${rawText} deducted from sellable amount)`;
    return `${quoteText} (${rawText}, conversion unavailable)`;
  }

  /**
   * Fetch and cache the USDT (quote) price for a third-party fee token such
   * as BNB.  Called once per cycle before fill processing so that
   * feeToQuote() has a fresh rate to work with.
   */
  async cacheFeeTokenPrice(feeCurrency, quoteAsset) {
    if (!feeCurrency || feeCurrency === quoteAsset) return;
    if (!this.feeTokenRates) this.feeTokenRates = new Map();
    const pair = `${feeCurrency}/${quoteAsset}`;
    try {
      if (this.exchange.markets[pair]) {
        const ticker = await retry(() => this.exchange.fetchTicker(pair));
        const rate = Number(ticker?.last);
        if (rate > 0) {
          this.feeTokenRates.set(feeCurrency, rate);
        }
      }
    } catch (err) {
      console.warn(`[FEE] Could not fetch price for ${pair}: ${err.message}`);
    }
  }

  async syncManagedOrdersWithExchange(symbol, symState, openOrderIds) {
    let cleaned = 0;
    for (const orderId of Object.keys(symState.orders)) {
      if (!openOrderIds.has(orderId)) {
        delete symState.orders[orderId];
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[SYNC-STATE] ${symbol} removed ${cleaned} stale local order(s) not found on exchange`);
      await this.state.save();
    }
  }

  async handleBuyFill(symbol, levels, symState, trade, orderMeta, openOrderIds) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const levelIndex = Number(orderMeta.levelIndex);
    const feeCost = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const base = this.getBaseAsset(symbol);
    const quote = this.getQuoteAsset(symbol);
    const sellableAmount = this.amountAfterBuyFee(symbol, trade);
    const costQuote = price * amount;
    // If the buy fee is charged in base asset, it already reduces the
    // sellable inventory below. Counting it again as quote cost would double
    // charge the fee in realized P&L.
    const feeQuote = feeCurrency === base ? 0 : this.feeToQuote(feeCost, feeCurrency, price, base, quote);

    symState.lastBuyByLevel[levelIndex] = this.mergeBuyRecords(
      symState.lastBuyByLevel[levelIndex],
      {
        price,
        amount,
        sellableAmount,
        totalCostQuote: costQuote,
        totalFeeQuote: feeQuote,
        at: trade.datetime,
      }
    );
    this.state.data.totals.filledBuys++;
    this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
    // All mutations for this fill are applied in-memory first and persisted
    // together in ONE save(). If the process crashes anywhere above this
    // line, none of it was written and the fill is reprocessed cleanly next
    // cycle; if it crashes anywhere below, all of it was written and the
    // trade is correctly marked processed. There is no window where the buy
    // record/order bookkeeping is saved but the trade is not (or vice
    // versa), which is what previously allowed a crash to cause double
    // counting of the same fill.
    this.state.markProcessedTradeLocal(symbol, this.getTradeId(trade));
    await this.state.save();
    await this.sendAlert(this.formatTelegramMessage('Buy Filled', [
      ['Symbol', symbol],
      ['Level', levelIndex],
      ['Price', this.formatPrice(price)],
      ['Amount', this.formatAmount(amount)],
      ['Sellable', this.formatAmount(sellableAmount)],
      ['Fee', this.formatTradeFeeDisplay(feeQuote, feeCost, feeCurrency, base, quote)],
    ]));
    if (!GRID_REFILL_ON_FILLED || !this.canPlaceNewOrders() || levelIndex + 1 >= levels.length) return;
    const sellLevelIndex = levelIndex + 1;
    const sellPrice = levels[sellLevelIndex];

    const totalSellable = Math.max(0, Number(symState.lastBuyByLevel[levelIndex]?.sellableAmount ?? symState.lastBuyByLevel[levelIndex]?.amount) || 0);
    if (!(totalSellable > 0)) {
      console.warn(`[SKIP] ${symbol} SELL refill level=${sellLevelIndex} | sellable amount zero after fee`);
      return;
    }

    const minCost = this.getMinCost(symbol);
    const { notional } = this.getPreciseOrderNumbers(symbol, sellPrice, totalSellable);
    if (minCost > 0 && notional < minCost - 1e-8) {
      console.warn(
        `[SKIP] ${symbol} SELL refill level=${sellLevelIndex} | notional ${notional.toFixed(8)} below min ${minCost}, keeping buy record for later retry`
      );
      return;
    }

    await this.syncManagedOrdersWithExchange(symbol, symState, openOrderIds);

    if (this.hasActiveOrderAtLevel(symState, 'sell', sellLevelIndex)) {
      const existingOrder = Object.values(symState.orders).find(o =>
        String(o.side).toLowerCase() === 'sell' && Number(o.levelIndex) === sellLevelIndex
      );
      const existingAmount = Number(existingOrder?.amount || 0);

      const { preciseAmount: preciseTotalSellable } = this.getPreciseOrderNumbers(symbol, sellPrice, totalSellable);
      const preciseTotalNum = Number(preciseTotalSellable);

      if (existingOrder && preciseTotalNum > existingAmount + 1e-8) {
        console.log(
          `[UPDATE] ${symbol} SELL level=${sellLevelIndex} | amount update ${existingAmount} -> ${preciseTotalNum} (buy accumulated)`
        );
        try {
          await this.cancelOrder(symbol, existingOrder, `sell amount update level=${sellLevelIndex}`);
          await this.placeLimit(symbol, 'sell', sellLevelIndex, sellPrice, totalSellable);
        } catch (err) {
          console.warn(`[UPDATE] ${symbol} SELL level=${sellLevelIndex} cancel+replace failed: ${err.message}`);
        }
      } else {
        console.warn(`[SKIP] ${symbol} SELL refill level=${sellLevelIndex} | sell order already active with sufficient amount`);
      }
      return;
    }

    if (this.countActiveOrders(symState, 'sell') >= GRID_MAX_ACTIVE_SELL_ORDERS) {
      console.warn(`[SKIP] ${symbol} SELL refill level=${sellLevelIndex} | active sell order limit reached`);
      return;
    }

    await this.placeLimit(symbol, 'sell', sellLevelIndex, sellPrice, totalSellable);
  }

  async handleSellFill(symbol, levels, symState, trade, orderMeta, openOrderIds) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const levelIndex = Number(orderMeta.levelIndex);
    const buyLevelIndex = levelIndex - 1;
    const buy = symState.lastBuyByLevel[buyLevelIndex];
    if (!buy) {
      console.warn(`[SELL] ${symbol} level ${levelIndex} has no corresponding buy record. Skipping profit calculation.`);
      this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
      this.state.markProcessedTradeLocal(symbol, this.getTradeId(trade));
      await this.state.save();
      return;
    }

    const base = this.getBaseAsset(symbol);
    const quote = this.getQuoteAsset(symbol);
    const feeCost = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const proceedsQuote = price * amount;
    const feeQuote = this.feeToQuote(feeCost, feeCurrency, price, base, quote);
    const totalBuyAmount = buy.amount;
    const sellableAtBuy = buy.sellableAmount ?? totalBuyAmount;
    if (!(sellableAtBuy > 0)) {
      console.warn(`[SELL] ${symbol} level ${levelIndex} buy record has zero sellable amount. Skipping profit calculation.`);
      this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
      this.state.markProcessedTradeLocal(symbol, this.getTradeId(trade));
      await this.state.save();
      return;
    }
    const proportion = Math.min(amount / sellableAtBuy, 1.0);
    const allocatedBuyCost = buy.totalCostQuote * proportion;
    const allocatedBuyFee = buy.totalFeeQuote * proportion;
    const profit = (proceedsQuote - feeQuote) - (allocatedBuyCost + allocatedBuyFee);

    symState.realizedGridProfit += profit;
    this.state.data.totals.realizedGridProfit += profit;
    this.state.data.totals.filledSells++;
    this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
    const remainingSellable = sellableAtBuy - amount;
    if (remainingSellable > 0) {
      const newProportion = remainingSellable / sellableAtBuy;
      symState.lastBuyByLevel[buyLevelIndex] = {
        ...buy,
        sellableAmount: remainingSellable,
        totalCostQuote: buy.totalCostQuote * newProportion,
        totalFeeQuote: buy.totalFeeQuote * newProportion,
        amount: (Number(buy.amount) || 0) * newProportion,
      };
    } else {
      delete symState.lastBuyByLevel[buyLevelIndex];
    }
    // Single atomic save for profit totals, buy-record update, order
    // bookkeeping, and the processed-trade marker - see handleBuyFill for
    // why this matters (no more partial-fill persistence on crash).
    this.state.markProcessedTradeLocal(symbol, this.getTradeId(trade));
    await this.state.save();
    await this.sendAlert(this.formatTelegramMessage('Sell Filled', [
      ['Symbol', symbol],
      ['Level', levelIndex],
      ['Price', this.formatPrice(price)],
      ['Amount', this.formatAmount(amount)],
      ['Profit', `${this.formatMoney(profit)} ${quote}`],
      ['Fee', this.formatTradeFeeDisplay(feeQuote, feeCost, feeCurrency, base, quote)],
    ]));

    if (GRID_REFILL_ON_FILLED && this.canPlaceNewOrders() && levelIndex - 1 >= 0) {
      const buyPrice = levels[levelIndex - 1];
      if (this.hasActiveOrderAtLevel(symState, 'buy', levelIndex - 1)) {
        console.warn(`[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | buy order already active`);
        return;
      }
      if (this.countActiveOrders(symState, 'buy') >= GRID_MAX_ACTIVE_BUY_ORDERS) {
        console.warn(`[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | active buy order limit reached`);
        return;
      }
      let amountToBuy = this.amountForBuy(symbol, buyPrice);
      let cost = amountToBuy * buyPrice;
      if (!(amountToBuy > 0)) {
        console.warn(`[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | investment cap reached`);
        return;
      }
      const minCost = this.getMinCost(symbol);
      if (minCost > 0 && cost < minCost - 1e-8) {
        amountToBuy = minCost / buyPrice;
        cost = amountToBuy * buyPrice;
        if (cost < minCost - 1e-8) {
          console.warn(`[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | cannot meet min notional ${minCost}`);
          return;
        }
      }
      const remainingInvestmentUsdt = this.getRemainingInvestmentUsdt(symbol);
      const precise = this.getPreciseOrderNumbers(symbol, buyPrice, amountToBuy);
      if (precise.notional > remainingInvestmentUsdt + 1e-8) {
        console.warn(
          `[SKIP] ${symbol} BUY refill level=${levelIndex - 1} | rounded cost ${precise.notional.toFixed(8)} exceeds remaining investment ${roundNumber(remainingInvestmentUsdt, 8)}`
        );
        return;
      }
      await this.placeLimit(symbol, 'buy', levelIndex - 1, buyPrice, amountToBuy);
    }
  }

  getTradeId(trade) {
    return String(trade.id || `${trade.order}-${trade.timestamp}`);
  }

  // Mutates symState.orders in memory only - no persistence. See
  // markProcessedTradeLocal() for why: handlers that make several related
  // mutations for one fill batch them all and save() once at the end.
  forgetOrderIfClosedLocal(symState, trade, openOrderIds) {
    if (!openOrderIds.has(String(trade.order))) {
      delete symState.orders[String(trade.order)];
      return true;
    }
    return false;
  }

  async forgetOrderIfClosed(symState, trade, openOrderIds) {
    if (this.forgetOrderIfClosedLocal(symState, trade, openOrderIds)) {
      await this.state.save();
    }
  }

  // Fetches trades since symState.lastTradeTimestamp. By default this does
  // NOT advance/persist lastTradeTimestamp itself - that is the caller's
  // responsibility, and should only happen after the returned trades have
  // been fully and successfully processed (see handleFilledTrades). This
  // prevents permanently losing a fill if processing throws partway through:
  // if the timestamp were advanced here (before processing), a failed trade
  // would never be re-fetched on the next cycle. Pass
  // { updateTimestamp: true } to opt back into the old fetch-and-advance
  // behavior for callers that don't need this guarantee.
  async fetchNewTrades(symbol, symState, { updateTimestamp = false } = {}) {
    const since = symState.lastTradeTimestamp || 0;
    let allTrades = [];
    let from = since;
    let maxIterations = 10;
    let iteration = 0;
    while (iteration < maxIterations) {
      const trades = await retry(() => this.exchange.fetchMyTrades(symbol, from, TRADE_FETCH_LIMIT));
      if (!trades.length) break;
      allTrades = allTrades.concat(trades);
      const lastTimestamp = trades[trades.length - 1].timestamp;
      if (trades.length < TRADE_FETCH_LIMIT) break;
      if (lastTimestamp === from) {
        // A full page of trades all share the same millisecond timestamp.
        // We cannot safely advance `from` to lastTimestamp+1 because there
        // may be MORE trades at this exact timestamp on the next page that
        // the exchange hasn't returned yet.  Stop here and do NOT advance
        // lastTradeTimestamp - the next cycle will re-fetch from this same
        // timestamp.  processedTrade() deduplication ensures already-seen
        // fills are skipped without re-processing.
        console.warn(
          `[TRADES] ${symbol} pagination stopped: full page (${TRADE_FETCH_LIMIT}) of trades share ` +
          `timestamp ${lastTimestamp}. Holding lastTradeTimestamp at ${from} so unseen fills ` +
          `in this timestamp bucket are picked up on the next cycle.`
        );
        // Return what we have but DO NOT update lastTradeTimestamp.
        return tradeFetchResult(allTrades, true);
      }
      from = lastTimestamp + 1;
      iteration++;
      await sleep(200);
    }
    if (updateTimestamp && allTrades.length) {
      const maxTs = Math.max(...allTrades.map(t => t.timestamp));
      symState.lastTradeTimestamp = maxTs;
      await this.state.save();
    }
    return tradeFetchResult(allTrades);
  }

  async handleFilledTrades(symbol, levels, preloadedOpenOrders = null) {
    const symState = this.state.getSymbol(symbol);
    const quoteAsset = this.getQuoteAsset(symbol);

    // Pre-warm the fee-token rate cache so feeToQuote() can convert third-party
    // fees (e.g. BNB) for any fills encountered in this cycle.
    // BNB is the only Binance platform token used for fee discounts, but we
    // also refresh any previously seen unknown token for this symbol.
    const knownFeeTokens = new Set(['BNB']);
    if (this.feeTokenRates) {
      for (const token of this.feeTokenRates.keys()) knownFeeTokens.add(token);
    }
    await Promise.all(
      [...knownFeeTokens]
        .filter(t => t !== quoteAsset && t !== this.getBaseAsset(symbol))
        .map(t => this.cacheFeeTokenPrice(t, quoteAsset))
    );

    // Reuse caller-supplied openOrders when available to avoid an extra round-trip.
    // Note: fetchNewTrades does NOT advance symState.lastTradeTimestamp here.
    // We only do that below, after every trade below has been processed
    // without throwing - otherwise a failure partway through this batch
    // would permanently skip the unprocessed trades on the next cycle.
    const [tradeFetch, openOrders] = await Promise.all([
      this.fetchNewTrades(symbol, symState, { updateTimestamp: false }),
      preloadedOpenOrders
        ? Promise.resolve(preloadedOpenOrders)
        : retry(() => this.exchange.fetchOpenOrders(symbol)),
    ]);
    const { trades, holdWatermark } = tradeFetch;
    const openOrderIds = new Set(openOrders.map(order => String(order.id)));
    for (const trade of trades.sort((a, b) => a.timestamp - b.timestamp)) {
      const id = this.getTradeId(trade);
      if (this.state.processedTrade(symbol, id)) continue;

      // Attempt to get order metadata from state, falling back to clientOrderId
      // embedded in the trade so fills are never lost across restarts.
      let orderMeta = symState.orders[String(trade.order)];
      if (!orderMeta) {
        // clientOrderId format: grid-<market>-<s|b>-<levelIndex>-<nonce>
        const clientId = String(
          trade.info?.clientOrderId ||
          trade.info?.origClientOrderId ||
          trade.clientOrderId ||
          ''
        );
        const match = clientId.match(/^grid-[a-z0-9]+-([bs])-(\d+)-/);
        if (match) {
          const side = match[1] === 'b' ? 'buy' : 'sell';
          const levelIndex = Number(match[2]);
          orderMeta = { levelIndex, side };
          console.warn(
            `[RECOVER] ${symbol} reconstructed orderMeta for trade ${id} ` +
            `from clientOrderId="${clientId}" (level=${levelIndex}, side=${side})`
          );
        } else {
          // Cannot determine which grid level this fill belongs to; skip it
          // but mark as processed so we don't retry on every cycle.
          console.warn(
            `[SKIP] ${symbol} trade ${id}: order ${trade.order} not in state and ` +
            `no parseable clientOrderId - fill cannot be attributed to a grid level`
          );
          await this.state.markProcessedTrade(symbol, id);
          continue;
        }
      }

      const side = String(trade.side).toLowerCase();
      if (side === 'buy') {
        await this.handleBuyFill(symbol, levels, symState, trade, orderMeta, openOrderIds);
      } else if (side === 'sell') {
        await this.handleSellFill(symbol, levels, symState, trade, orderMeta, openOrderIds);
      } else {
        this.forgetOrderIfClosedLocal(symState, trade, openOrderIds);
        this.state.markProcessedTradeLocal(symbol, id);
        await this.state.save();
      }
    }
    // Every trade in this batch was processed without throwing - safe to
    // advance the watermark now so these trades aren't re-fetched. If any
    // handler above had thrown, execution would never reach here, so
    // lastTradeTimestamp stays put and the same trades (including the
    // failed one) are retried next cycle; already-processed ones among them
    // are skipped via processedTrade() deduplication.
    if (trades.length && !holdWatermark) {
      const maxTs = Math.max(...trades.map(t => t.timestamp));
      if (maxTs > (symState.lastTradeTimestamp || 0)) {
        symState.lastTradeTimestamp = maxTs;
        await this.state.save();
      }
    }
    await this.syncManagedOrdersWithExchange(symbol, symState, openOrderIds);
  }

  async enforceRangeExits(symbol, currentPrice) {
    if (STOP_LOSS_PRICE > 0 && currentPrice <= STOP_LOSS_PRICE) {
      await this.cancelGridOrders(symbol, `stop-loss ${STOP_LOSS_PRICE}`);
      await this.sendAlert(this.formatTelegramMessage('Stop Loss', [
        ['Symbol', symbol],
        ['Price', this.formatPrice(currentPrice)],
        ['Stop', this.formatPrice(STOP_LOSS_PRICE)],
        ['Action', 'grid orders cancelled'],
      ]));
      return false;
    }
    if (TAKE_PROFIT_PRICE > 0 && currentPrice >= TAKE_PROFIT_PRICE) {
      await this.cancelGridOrders(symbol, `take-profit ${TAKE_PROFIT_PRICE}`);
      await this.sendAlert(this.formatTelegramMessage('Take Profit', [
        ['Symbol', symbol],
        ['Price', this.formatPrice(currentPrice)],
        ['Target', this.formatPrice(TAKE_PROFIT_PRICE)],
        ['Action', 'grid orders cancelled'],
      ]));
      return false;
    }
    return true;
  }

  async withSymbolLock(symbol, fn) {
    const holdingSymbols = symbolLockContext.getStore();
    if (holdingSymbols && holdingSymbols.has(symbol)) {
      // A call already descended from a withSymbolLock(symbol, ...) that
      // hasn't released yet is trying to acquire the SAME symbol's lock
      // again. Proceeding would queue behind a promise that only resolves
      // after this very call finishes -> permanent deadlock. Fail fast with
      // a clear diagnostic instead.
      throw new Error(
        `[LOCK] Reentrant withSymbolLock('${symbol}') call detected: a function that already ` +
        `holds this symbol's lock attempted to acquire it again from within its own execution. ` +
        `This would deadlock. Refactor the calling code so it does not nest withSymbolLock calls ` +
        `for the same symbol (call the *Unlocked variant directly instead of re-locking).`
      );
    }

    const previous = this.symbolLocks.get(symbol) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.symbolLocks.set(symbol, current);
    try {
      await previous;
      const nextHolding = new Set(holdingSymbols);
      nextHolding.add(symbol);
      return await symbolLockContext.run(nextHolding, () => fn());
    } finally {
      release();
      if (this.symbolLocks.get(symbol) === current) this.symbolLocks.delete(symbol);
    }
  }

  async reconcileSymbol(symbol) {
    return this.withSymbolLock(symbol, () => this.reconcileSymbolUnlocked(symbol));
  }

  async reconcileSymbolUnlocked(symbol) {
    if (!this.canPlaceNewOrders()) {
      const freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
      await this.handleFilledTrades(symbol, [], freshOpenOrders);
      console.log(`[SYNC] ${symbol} trading paused; fills reconciled but no new orders will be placed`);
      return;
    }

    let context = await this.fetchContext(symbol);
    let { currentPrice, balance, lower, upper, levels } = context;

    const canContinue = await this.enforceRangeExits(symbol, currentPrice);

    let trailedUp = null;
    let trailedDown = null;
    let newContext = null;
    if (canContinue && this.canPlaceNewOrders()) {
      trailedUp = await this.maybeTrailUpRange(symbol, currentPrice, lower, upper);
      if (trailedUp) {
        newContext = await this.fetchContext(symbol);
        newContext.trailingUpJustShifted = true;
        ({ currentPrice, balance, lower, upper, levels } = newContext);
      } else {
        trailedDown = await this.maybeTrailDownRange(symbol, currentPrice, lower, upper);
        if (trailedDown) {
          newContext = await this.fetchContext(symbol);
          newContext.trailingDownJustShifted = true;
          ({ currentPrice, balance, lower, upper, levels } = newContext);
        }
      }
    }
    const finalContext = newContext || context;
    finalContext.trailingUpJustShifted = !!trailedUp;
    finalContext.trailingDownJustShifted = !!trailedDown;

    // Always reconcile fills that already happened on the exchange, even while trading
    // is halted by stop-loss/take-profit, so profit, sellable amount, and lastBuyByLevel
    // never go unrecorded.
    // Fetch openOrders once here and pass it into handleFilledTrades so we avoid a
    // redundant exchange round-trip (handleFilledTrades previously fetched its own copy).
    let freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    await this.handleFilledTrades(symbol, levels, freshOpenOrders);

    if (!canContinue) {
      console.log(`[SYNC] ${symbol} trading halted (stop-loss/take-profit); no new orders will be placed`);
      return;
    }

    // Re-read balances and open orders after fill handling so placement loops use fresh state.
    balance = await retry(() => this.exchange.fetchBalance());
    freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
    let managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);

    if (GRID_CANCEL_OUT_OF_RANGE) {
      for (const order of managedOrders) {
        const orderTimestamp = Number(order.timestamp) || Date.parse(order.datetime || 0) || 0;
        const orderAgeMs = Date.now() - orderTimestamp;
        if (orderAgeMs < GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MS) continue;
        const isValidGridOrder = this.isOrderCloseToPriceLevel(order.price, levels, this.exchange.markets[symbol]);
        if (isValidGridOrder) continue;
        if (!this.isOrderInsideRange(order, lower, upper)) {
          await this.cancelOrder(symbol, order, `outside range ${roundNumber(lower)}-${roundNumber(upper)}`);
        }
      }
      freshOpenOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
      managedOrders = await this.getManagedOpenOrders(symbol, freshOpenOrders);
    }

    const activeBuyLevels = new Set();
    const activeSellLevels = new Set();
    const symState = this.state.getSymbol(symbol);
    for (const order of managedOrders) {
      const idx = this.getLevelIndex(levels, Number(order.price));
      if (order.side === 'buy') activeBuyLevels.add(idx);
      if (order.side === 'sell') activeSellLevels.add(idx);
    }
    for (const order of Object.values(symState.orders)) {
      if (order.side === 'buy') activeBuyLevels.add(Number(order.levelIndex));
      if (order.side === 'sell') activeSellLevels.add(Number(order.levelIndex));
    }

    const below = this.getNearestLevels(levels, currentPrice, 'buy', GRID_MAX_ACTIVE_BUY_ORDERS);
    const above = this.getNearestLevels(levels, currentPrice, 'sell', GRID_MAX_ACTIVE_SELL_ORDERS);

    let quoteFree = this.getQuoteFree(balance, symbol);
    let baseFree = this.getBaseFree(balance, symbol);
    let remainingInvestmentUsdt = this.getRemainingInvestmentUsdt(symbol);

    for (const level of below) {
      if (this.countActiveOrders(symState, 'buy') >= GRID_MAX_ACTIVE_BUY_ORDERS) {
        console.warn(`[SKIP] ${symbol} BUY level=${level.index} | active buy order limit (${GRID_MAX_ACTIVE_BUY_ORDERS}) reached`);
        break;
      }
      if (activeBuyLevels.has(level.index)) continue;
      let amount = this.amountForBuy(symbol, level.price, remainingInvestmentUsdt);
      let cost = amount * level.price;
      if (!(amount > 0)) {
        console.warn(`[SKIP] ${symbol} BUY level=${level.index} | investment cap reached`);
        break;
      }

      const minCost = this.getMinCost(symbol);
      if (minCost > 0 && cost < minCost - 1e-8) {
        const requiredAmount = minCost / level.price;
        amount = this.exchange.amountToPrecision(symbol, requiredAmount);
        cost = Number(amount) * level.price;
        if (cost < minCost - 1e-8) {
          console.warn(`[SKIP] ${symbol} BUY level=${level.index} | cannot meet min notional ${minCost}`);
          break;
        }
      }

      const precise = this.getPreciseOrderNumbers(symbol, level.price, amount);
      cost = precise.notional;
      if (cost > remainingInvestmentUsdt + 1e-8) {
        console.warn(
          `[SKIP] ${symbol} BUY level=${level.index} | rounded cost ${cost.toFixed(8)} exceeds remaining investment ${roundNumber(remainingInvestmentUsdt, 8)}`
        );
        break;
      }
      if (quoteFree < cost) break;
      const order = await this.placeLimit(symbol, 'buy', level.index, level.price, amount);
      if (!order) break;
      quoteFree -= cost;
      remainingInvestmentUsdt = Math.max(0, remainingInvestmentUsdt - cost);
    }

    for (const level of above) {
      if (this.countActiveOrders(symState, 'sell') >= GRID_MAX_ACTIVE_SELL_ORDERS) {
        console.warn(`[SKIP] ${symbol} SELL level=${level.index} | active sell order limit (${GRID_MAX_ACTIVE_SELL_ORDERS}) reached`);
        break;
      }
      if (activeSellLevels.has(level.index)) continue;
      const trackedAmount = this.amountForTrackedSell(symbol, level.index);
      if (!(trackedAmount > 0)) continue;
      let amount = Math.min(trackedAmount, baseFree);
      if (!(amount > 0)) {
        console.warn(`[SKIP] ${symbol} SELL level=${level.index} | insufficient free base, checking farther sell levels`);
        continue;
      }

      const minCost = this.getMinCost(symbol);
      const notional = amount * level.price;
      if (minCost > 0 && notional < minCost - 1e-8) {
        console.warn(`[SKIP] ${symbol} SELL level=${level.index} | notional too low (dust), keeping buy record for later retry`);
        continue;
      }

      const order = await this.placeLimit(symbol, 'sell', level.index, level.price, amount);
      if (!order) continue;
      baseFree -= amount;
    }

    console.log(
      `[SYNC] ${symbol} price=${roundNumber(currentPrice)} range=${roundNumber(lower)}-${roundNumber(upper)} ` +
      `orders=${managedOrders.length} totalProfit=${roundNumber(symState.realizedGridProfit, 4)} ${this.getQuoteAsset(symbol)}`
    );
  }

  amountForTrackedSell(symbol, sellLevelIndex) {
    const symState = this.state.getSymbol(symbol);
    const buy = symState.lastBuyByLevel[sellLevelIndex - 1];
    if (!buy) return 0;
    return Math.max(0, Number(buy.sellableAmount ?? buy.amount) || 0);
  }

  getAllocatedInvestmentUsdt(symbol) {
    if (!(GRID_TOTAL_INVESTMENT_USDT > 0)) return 0;
    const symState = this.state.getSymbol(symbol);
    let allocated = 0;

    // Sum cost of all filled buys tracked in lastBuyByLevel.
    for (const buy of Object.values(symState.lastBuyByLevel)) {
      allocated += Number(buy.totalCostQuote) || 0;
    }

    // Sum cost of ALL open (pending) buy orders. A level can simultaneously
    // have a filled buy record in lastBuyByLevel (e.g. partially sold) AND a
    // new pending replenishment buy order open at that same level - both
    // amounts are real allocated capital and must both be counted, or the
    // investment cap is under-reported and the bot can over-allocate funds.
    for (const order of Object.values(symState.orders)) {
      if (String(order.side).toLowerCase() !== 'buy') continue;
      allocated += (Number(order.amount) || 0) * (Number(order.price) || 0);
    }

    return allocated;
  }

  getRemainingInvestmentUsdt(symbol) {
    if (!(GRID_TOTAL_INVESTMENT_USDT > 0)) return Infinity;
    return Math.max(0, GRID_TOTAL_INVESTMENT_USDT - this.getAllocatedInvestmentUsdt(symbol));
  }

  amountForBuy(symbol, price, availableInvestmentUsdt = this.getRemainingInvestmentUsdt(symbol)) {
    const minCost = this.getMinCost(symbol);
    const targetNotional = Math.max(this.getOrderSizeUsdt(), minCost);
    const notional = Math.min(targetNotional, availableInvestmentUsdt);
    if (minCost > 0 && notional < minCost - 1e-8) {
      this.warnIfInvestmentPermanentlyStuck(symbol, availableInvestmentUsdt, minCost);
      return 0;
    }
    if (!(notional > 0)) return 0;
    return notional / price;
  }

  warnIfInvestmentPermanentlyStuck(symbol, availableInvestmentUsdt, minCost) {
    if (!(GRID_TOTAL_INVESTMENT_USDT > 0)) return;
    if (!(availableInvestmentUsdt > 0) || availableInvestmentUsdt >= minCost) return;
    if (this.stuckInvestmentWarned.has(symbol)) return;
    this.stuckInvestmentWarned.add(symbol);
    console.warn(
      `[CONFIG] ${symbol} remaining investment ${roundNumber(availableInvestmentUsdt, 8)} USDT is below the ` +
      `exchange minimum order cost ${minCost} USDT. This leftover is PERMANENTLY stuck and cannot be used for ` +
      `new buy orders until a sell adds funds back. Consider lowering GRID_COUNT, raising ` +
      `GRID_TOTAL_INVESTMENT_USDT, or accepting fewer active buy levels.`
    );
  }

  isOrderInsideRange(order, lower, upper) {
    const price = Number(order.price);
    const rangeSize = upper - lower;
    const relativeEpsilon = Math.max(rangeSize * 0.0005, price * 0.00001);
    return price >= lower - relativeEpsilon && price <= upper + relativeEpsilon;
  }

  isOrderCloseToPriceLevel(orderPrice, levels, market) {
    const price = Number(orderPrice);
    const tickSize = market?.precision?.price || 0.00001;
    for (const level of levels) {
      if (Math.abs(price - level) <= tickSize * 1.5) return true;
    }
    return false;
  }

  amountAfterBuyFee(symbol, trade) {
    const amount = Number(trade.amount);
    const feeCost = this.getTradeFeeCost(trade);
    const feeCurrency = this.getTradeFeeCurrency(trade);
    const base = this.getBaseAsset(symbol).toUpperCase();
    let result = amount;
    if (feeCurrency === base) result = Math.max(0, amount - feeCost);
    return result;
  }

  async executeCycle() {
    if (this.isRunning) return;
    this.isRunning = true;
    let hadError = false;
    try {
      if (!this.circuitAllows()) return;
      for (const symbol of SYMBOLS) {
        try {
          await this.reconcileSymbol(symbol);
        } catch (err) {
          hadError = true;
          console.error(`[CYCLE] Error on ${symbol}:`, err);
          this.recordError();
        }
      }
      if (!hadError) this.recordSuccess();
    } catch (err) {
      console.error('[CYCLE]', err);
      this.recordError();
    } finally {
      this.isRunning = false;
    }
  }

  async start() {
    console.log(`
[SPOT GRID BOT STARTED]
Mode: ${EXCHANGE_MODE.toUpperCase()}
Symbols: ${SYMBOLS.join(', ')}
Grid Mode: ${GRID_MODE}
Grid Count: ${GRID_COUNT}
Order Size: ${this.getOrderSizeUsdt()} USDT/grid
Range: ${GRID_LOWER_PRICE && GRID_UPPER_PRICE ? `${GRID_LOWER_PRICE}-${GRID_UPPER_PRICE}` : `auto +/-${GRID_RANGE_PCT}%`}
Trailing Range: ${GRID_TRAILING_RANGE_ENABLED ? 'ON (auto up/down)' : 'OFF'}
Trailing Up: ${GRID_TRAILING_UP_ENABLED ? `ON (range-follow trigger, cooldown=${GRID_TRAILING_UP_COOLDOWN_MS / MINUTE_MS}m)` : 'OFF'}
Trailing Down: ${GRID_TRAILING_DOWN_ENABLED ? `ON (range-follow trigger, cooldown=${GRID_TRAILING_DOWN_COOLDOWN_MS / MINUTE_MS}m)` : 'OFF'}
Max Active Orders: buy=${GRID_MAX_ACTIVE_BUY_ORDERS}, sell=${GRID_MAX_ACTIVE_SELL_ORDERS}
Recreate On Start: ${GRID_RECREATE_ON_START ? 'ON' : 'OFF'}
Post Only (Maker): ${GRID_POST_ONLY ? 'ON' : 'OFF'}
Smart Range Advisor (Gemini): ${GEMINI_RANGE_ADVISOR_ENABLED
      ? `ON (model=${GEMINI_MODEL}, timeframe=${GEMINI_RANGE_ADVISOR_TIMEFRAME} [candle-close aligned], min-range-width=${GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT}%, applies-to=${GEMINI_RANGE_ADVISOR_APPLY_ON})`
      : 'OFF'}
`);
    await this.init();
    await this.startTelegramCommandPolling();
    this.startTelegramStatusReports();
    while (true) {
      await sleep(INTERVAL_MS);
      await this.executeCycle();
    }
  }
}

applyTrailingRangeMethods(SpotGridEngine);
applyOrderExecutionMethods(SpotGridEngine);
applyTelegramMethods(SpotGridEngine);

module.exports = { SpotGridEngine };
