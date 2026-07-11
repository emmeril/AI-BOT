const {
  GRID_COUNT,
  GRID_MODE,
  GRID_TRAILING_UP_ENABLED,
  GRID_TRAILING_UP_COOLDOWN_MS,
  GRID_TRAILING_DOWN_ENABLED,
  GRID_TRAILING_DOWN_COOLDOWN_MS,
  hasManualGridRange
} = require('./config');
const { roundNumber, numberOrZero } = require('./utils');

const TRAILING_CONFIG = {
  up: {
    enabled: GRID_TRAILING_UP_ENABLED,
    cooldownMs: GRID_TRAILING_UP_COOLDOWN_MS,
    stateKey: 'trailingUp',
    label: 'Up',
  },
  down: {
    enabled: GRID_TRAILING_DOWN_ENABLED,
    cooldownMs: GRID_TRAILING_DOWN_COOLDOWN_MS,
    stateKey: 'trailingDown',
    label: 'Down',
  },
};

function getTrailingConfig(direction) {
  const config = TRAILING_CONFIG[direction];
  if (!config) throw new Error(`Unsupported trailing direction: ${direction}`);
  return config;
}

function getTrailingState(symbol, direction) {
  const symState = this.state.getSymbol(symbol);
  const { stateKey } = getTrailingConfig(direction);
  if (!symState[stateKey]) symState[stateKey] = { shifts: 0, lastShiftAt: null };
  return symState[stateKey];
}

function getTrailingUpState(symbol) {
  return this.getTrailingState(symbol, 'up');
}

function getTrailingDownState(symbol) {
  return this.getTrailingState(symbol, 'down');
}

function calculateTrailingShift(currentPrice, lower, upper, direction, symbol = null) {
  let shift;
  if (GRID_MODE === 'GEOMETRIC') {
    const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
    if (!(ratio > 1)) return null;
    if (direction === 'up') {
      if (currentPrice < this.getTrailingTrigger(lower, upper, direction)) return null;
      const steps = Math.max(1, Math.floor(Math.log(currentPrice / upper) / Math.log(ratio)));
      shift = {
        steps,
        lower: lower * Math.pow(ratio, steps),
        upper: upper * Math.pow(ratio, steps),
      };
    } else {
      if (currentPrice > this.getTrailingTrigger(lower, upper, direction)) return null;
      const steps = Math.max(1, Math.floor(Math.log(lower / currentPrice) / Math.log(ratio)));
      shift = {
        steps,
        lower: lower / Math.pow(ratio, steps),
        upper: upper / Math.pow(ratio, steps),
      };
    }
  } else {
    const stepSize = (upper - lower) / GRID_COUNT;
    if (!(stepSize > 0)) return null;
    if (direction === 'up') {
      if (currentPrice < this.getTrailingTrigger(lower, upper, direction)) return null;
      const steps = Math.max(1, Math.floor((currentPrice - upper) / stepSize));
      shift = {
        steps,
        lower: lower + stepSize * steps,
        upper: upper + stepSize * steps,
      };
    } else {
      if (currentPrice > this.getTrailingTrigger(lower, upper, direction)) return null;
      const steps = Math.max(1, Math.floor((lower - currentPrice) / stepSize));
      shift = {
        steps,
        lower: lower - stepSize * steps,
        upper: upper - stepSize * steps,
      };
    }
  }
  if (!shift) return null;
  if (symbol && !this.shiftLevelsAreUsable(symbol, shift, direction)) return null;
  return shift;
}

// Validates that the range resulting from a trailing shift would still
// produce distinct grid price levels once rounded to the exchange's tick
// size, for BOTH grid modes. Previously this guard used a raw-step
// comparison that only ran for ARITHMETIC mode (rawStep was forced to null
// for GEOMETRIC), so a GEOMETRIC grid could trail into a collapsed range
// undetected here and only surface later as an uncaught error thrown by
// buildLevels()/assertLevelsAreDistinct() during the next reconcile cycle.
// Reusing buildLevels()/assertLevelsAreDistinct() directly (instead of a
// hand-rolled step/tick-size comparison) also makes the check exact: it
// mirrors precisely what will happen when the new range is actually used.
function shiftLevelsAreUsable(symbol, shift, direction) {
  try {
    this.buildLevels(shift.lower, shift.upper, symbol);
    return true;
  } catch (err) {
    console.warn(
      `[TRAILING] ${symbol} skipping ${direction} shift: resulting range ` +
      `${roundNumber(shift.lower)}-${roundNumber(shift.upper)} would produce overlapping grid levels ` +
      `after rounding to exchange tick size (${err.message}). Widen the range or lower GRID_COUNT.`
    );
    return false;
  }
}

function getTrailingTrigger(lower, upper, direction) {
  if (GRID_MODE === 'GEOMETRIC') {
    const ratio = Math.pow(upper / lower, 1 / GRID_COUNT);
    return direction === 'up' ? upper * ratio : lower / ratio;
  }
  const stepSize = (upper - lower) / GRID_COUNT;
  return direction === 'up' ? upper + stepSize : lower - stepSize;
}

function getTrailingUpTrigger(lower, upper) {
  return this.getTrailingTrigger(lower, upper, 'up');
}

function getTrailingDownTrigger(lower, upper) {
  return this.getTrailingTrigger(lower, upper, 'down');
}

function shiftStoredLevelIndexes(symbol, offset) {
  const symState = this.state.getSymbol(symbol);
  this.shiftStoredOrderIndexes(symState, offset);

  const shiftedBuys = {};
  for (const [levelIndex, buy] of Object.entries(symState.lastBuyByLevel)) {
    shiftedBuys[Number(levelIndex) + offset] = buy;
  }
  symState.lastBuyByLevel = shiftedBuys;
}

function shiftStoredOrderIndexes(symState, offset) {
  const shiftedOrders = {};
  for (const [orderId, order] of Object.entries(symState.orders)) {
    const shiftedIndex = Number(order.levelIndex) + offset;
    const clampedIndex = this.clampBuyLevelIndex(shiftedIndex);
    if (clampedIndex !== shiftedIndex) {
      // Without clamping, an order's levelIndex could land outside
      // [0, GRID_COUNT-1]. That breaks every lookup keyed on levelIndex:
      // reconcileSymbolUnlocked's activeBuyLevels/activeSellLevels
      // wouldn't recognize the order (risking a duplicate placed at the
      // same price), handleSellFill's `levelIndex - 1` buy lookup could
      // go negative and silently skip profit accounting, and
      // handleBuyFill's `levelIndex + 1` sell-refill lookup could target
      // a non-existent level. Clamping keeps the index valid; this order
      // is pinned to the boundary grid level, so its bookkeeping stays
      // internally consistent even though its live exchange price sits
      // just past that level's nominal price after the shift.
      console.warn(
        `[TRAILING] Order ${orderId} (${order.side}) level index ${shiftedIndex} out of range ` +
        `[0, ${GRID_COUNT - 1}] after shift; clamping to boundary level ${clampedIndex}.`
      );
    }
    shiftedOrders[orderId] = {
      ...order,
      levelIndex: clampedIndex,
    };
  }
  symState.orders = shiftedOrders;
}

function mergeBuyRecords(existing, incoming, { aggregatedAcrossLevels = false } = {}) {
  if (!existing) {
    return aggregatedAcrossLevels ? { ...incoming, aggregated: true } : { ...incoming };
  }
  const existingAmount = Number(existing.amount) || 0;
  const incomingAmount = Number(incoming.amount) || 0;
  const amount = existingAmount + incomingAmount;
  const sellableAmount = numberOrZero(existing.sellableAmount ?? existing.amount) +
    numberOrZero(incoming.sellableAmount ?? incoming.amount);
  const totalCostQuote = (Number(existing.totalCostQuote) || 0) + (Number(incoming.totalCostQuote) || 0);
  const totalFeeQuote = (Number(existing.totalFeeQuote) || 0) + (Number(incoming.totalFeeQuote) || 0);
  return {
    ...existing,
    ...incoming,
    price: amount > 0 && totalCostQuote > 0 ? totalCostQuote / amount : Number(incoming.price ?? existing.price) || 0,
    amount,
    sellableAmount,
    totalCostQuote,
    totalFeeQuote,
    at: Date.parse(incoming.at || 0) > Date.parse(existing.at || 0) ? incoming.at : existing.at,
    aggregated: aggregatedAcrossLevels || existing.aggregated === true || incoming.aggregated === true,
  };
}

function clampBuyLevelIndex(levelIndex) {
  return Math.max(0, Math.min(GRID_COUNT - 1, Number(levelIndex)));
}

function hasActiveOrderAtLevel(symState, side, levelIndex) {
  return Object.values(symState.orders).some(order =>
    String(order.side).toLowerCase() === side &&
    Number(order.levelIndex) === Number(levelIndex)
  );
}

function countActiveOrders(symState, side) {
  return Object.values(symState.orders).filter(order =>
    String(order.side).toLowerCase() === side
  ).length;
}

async function applyTrailingRangeShift(symbol, lower, upper, shift, direction) {
  const symStateForMarker = this.state.getSymbol(symbol);
  // Persist BEFORE the irreversible step (cancelling live orders), same
  // rationale as remapStateAfterRangeReset: survives a crash so the shift
  // can be resumed onto this exact target range instead of left half-done.
  const t = symStateForMarker.rangeTransition;
  if (!t || t.kind !== 'trail' || t.newLower !== shift.lower || t.newUpper !== shift.upper) {
    symStateForMarker.rangeTransition = {
      kind: 'trail', direction, oldLower: lower, oldUpper: upper,
      newLower: shift.lower, newUpper: shift.upper, steps: shift.steps,
    };
    await this.state.save();
  }

  const cancelResult = await this.cancelGridOrders(symbol, `trailing-${direction}`);
  if (cancelResult.failed.length > 0) {
    const failedIds = cancelResult.failed.map(f => f.id).join(', ');
    // Abort the shift entirely: some orders are still live on the exchange
    // at OLD-range prices. If we shifted local state anyway, those orders'
    // levelIndex would now point at NEW-grid levels that don't match their
    // actual price -- if one later fills, profit calc pairs it with the
    // wrong buy record, corrupting P&L. Mirrors remapStateAfterRangeReset's
    // strictness: bail out and let the caller retry next cycle once all
    // orders are confirmed cancelled.
    throw new Error(
      `[TRAILING] ${symbol} trailing-${direction} shift aborted: ${cancelResult.failed.length} order ` +
      `cancellation(s) failed (ids: ${failedIds}). Will retry shift next cycle once all orders are cancelled.`
    );
  }

  const symState = this.state.getSymbol(symbol);
  const trailingState = this.getTrailingState(symbol, direction);
  const offset = direction === 'up' ? -shift.steps : shift.steps;

  // cancelGridOrders() already called state.forgetOrder() for every order
  // it cancelled above, so symState.orders should normally be empty here.
  // This is a defensive fallback for any order that ended up in local
  // state without being picked up as "managed" by getManagedOpenOrders --
  // shiftStoredOrderIndexes() clamps its levelIndex to stay valid.
  const storedOrderCount = Object.keys(symState.orders).length;
  if (storedOrderCount > 0) {
    console.warn(
      `[TRAILING] ${symbol} had ${storedOrderCount} unexpected leftover order(s) in local state after ` +
      `full cancellation; shifting (and clamping) their local metadata defensively`
    );
    this.shiftStoredOrderIndexes(symState, offset);
  }

  symState.config.lower = shift.lower;
  symState.config.upper = shift.upper;

  const cleanedBuys = {};
  for (const [idx, buy] of Object.entries(symState.lastBuyByLevel)) {
    const newIdx = Number(idx) + offset;
    const exitIdx = this.clampBuyLevelIndex(newIdx);
    const collapsedAcrossLevels = exitIdx !== newIdx || Boolean(cleanedBuys[exitIdx]);
    cleanedBuys[exitIdx] = this.mergeBuyRecords(cleanedBuys[exitIdx], buy, {
      aggregatedAcrossLevels: collapsedAcrossLevels,
    });
    if (exitIdx !== newIdx) {
      console.warn(
        `[TRAILING] Keeping buy at shifted level ${newIdx} as boundary buy level ${exitIdx} after ${direction} shift. ` +
        `This level's stored price is now a weighted average across collapsed levels, not a single fill price.`
      );
    }
  }
  symState.lastBuyByLevel = cleanedBuys;
  trailingState.shifts += shift.steps;
  trailingState.lastShiftAt = new Date().toISOString();
  symState.rangeTransition = null;
  await this.state.save();

  console.log(
    `[TRAILING ${direction.toUpperCase()}] ${symbol} shifted ${shift.steps} grid(s): ` +
    `${roundNumber(lower)}-${roundNumber(upper)} -> ${roundNumber(shift.lower)}-${roundNumber(shift.upper)}`
  );
  await this.sendAlert(this.formatTelegramMessage(`Trailing ${direction.toUpperCase()}`, [
    ['Symbol', symbol],
    ['Shift', `${shift.steps} grid(s)`],
    ['Old Range', `${this.formatPrice(lower)} - ${this.formatPrice(upper)}`],
    ['New Range', `${this.formatPrice(shift.lower)} - ${this.formatPrice(shift.upper)}`],
  ]));

  return { lower: shift.lower, upper: shift.upper };
}

async function maybeTrailRange(symbol, currentPrice, lower, upper, direction) {
  const config = getTrailingConfig(direction);
  if (!config.enabled || hasManualGridRange()) return null;
  const trailingState = this.getTrailingState(symbol, direction);
  const lastShiftAt = Date.parse(trailingState.lastShiftAt || 0);
  if (config.cooldownMs > Date.now() - lastShiftAt) return null;
  const shift = this.calculateTrailingShift(currentPrice, lower, upper, direction, symbol);
  if (!shift) return null;
  try {
    return await this.applyTrailingRangeShift(symbol, lower, upper, shift, direction);
  } catch (err) {
    console.error(`[TRAILING] ${config.label} shift failed for ${symbol}:`, err);
    return null;
  }
}

async function maybeTrailUpRange(symbol, currentPrice, lower, upper) {
  return this.maybeTrailRange(symbol, currentPrice, lower, upper, 'up');
}

async function maybeTrailDownRange(symbol, currentPrice, lower, upper) {
  return this.maybeTrailRange(symbol, currentPrice, lower, upper, 'down');
}


const trailingRangeMethods = {
  getTrailingState,
  getTrailingUpState,
  getTrailingDownState,
  calculateTrailingShift,
  shiftLevelsAreUsable,
  getTrailingTrigger,
  getTrailingUpTrigger,
  getTrailingDownTrigger,
  shiftStoredLevelIndexes,
  shiftStoredOrderIndexes,
  mergeBuyRecords,
  clampBuyLevelIndex,
  hasActiveOrderAtLevel,
  countActiveOrders,
  applyTrailingRangeShift,
  maybeTrailRange,
  maybeTrailUpRange,
  maybeTrailDownRange,
};

function applyTrailingRangeMethods(target) {
  Object.assign(target.prototype, trailingRangeMethods);
}

module.exports = {
  applyTrailingRangeMethods,
  trailingRangeMethods,
};
