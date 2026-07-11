const fs = require('fs');
const { GRID_STATE_PATH, MAX_PROCESSED_TRADE_IDS } = require('./config');
const { AtomicFileWriter } = require('./atomic-file-writer');
const { isPlainObject, numberOrZero, scopedTradeId } = require('./utils');

class GridState {
  constructor() {
    this.data = this.load();
    this.rebuildProcessedTradeIndex();
  }

  static createEmpty() {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      symbols: {},
      processedTradeIds: [],
      totals: { filledBuys: 0, filledSells: 0, realizedGridProfit: 0 },
    };
  }

  static createSymbolState() {
    return {
      createdAt: new Date().toISOString(),
      config: {},
      orders: {},
      lastBuyByLevel: {},
      realizedGridProfit: 0,
      lastTradeTimestamp: 0,
      trailingUp: { shifts: 0, lastShiftAt: null },
      trailingDown: { shifts: 0, lastShiftAt: null },
      rangeTransition: null,
    };
  }

  static normalizeSymbolState(symbolState) {
    const sym = isPlainObject(symbolState) ? symbolState : GridState.createSymbolState();
    sym.config = isPlainObject(sym.config) ? sym.config : {};
    sym.orders = isPlainObject(sym.orders) ? sym.orders : {};
    sym.lastBuyByLevel = isPlainObject(sym.lastBuyByLevel) ? sym.lastBuyByLevel : {};
    sym.realizedGridProfit = numberOrZero(sym.realizedGridProfit);
    sym.lastTradeTimestamp = numberOrZero(sym.lastTradeTimestamp);
    if (!isPlainObject(sym.trailingUp)) sym.trailingUp = { shifts: 0, lastShiftAt: null };
    if (!isPlainObject(sym.trailingDown)) sym.trailingDown = { shifts: 0, lastShiftAt: null };
    if (sym.rangeTransition === undefined) sym.rangeTransition = null;
    return sym;
  }

  static normalize(data) {
    const normalized = isPlainObject(data) ? data : {};
    normalized.version = numberOrZero(normalized.version) || 1;
    normalized.updatedAt = normalized.updatedAt || new Date().toISOString();
    normalized.symbols = isPlainObject(normalized.symbols) ? normalized.symbols : {};
    normalized.processedTradeIds = Array.isArray(normalized.processedTradeIds)
      ? normalized.processedTradeIds.map(String).slice(-MAX_PROCESSED_TRADE_IDS)
      : [];
    normalized.totals = isPlainObject(normalized.totals) ? normalized.totals : {};
    normalized.totals.filledBuys = numberOrZero(normalized.totals.filledBuys);
    normalized.totals.filledSells = numberOrZero(normalized.totals.filledSells);
    normalized.totals.realizedGridProfit = numberOrZero(normalized.totals.realizedGridProfit);
    return normalized;
  }

  load() {
    try {
      if (fs.existsSync(GRID_STATE_PATH)) {
        return GridState.normalize(JSON.parse(fs.readFileSync(GRID_STATE_PATH, 'utf8')));
      }
    } catch (err) {
      console.warn('[STATE] Failed to read grid state, starting fresh:', err.message);
    }
    return GridState.createEmpty();
  }

  rebuildProcessedTradeIndex() {
    this.processedTradeIdSet = new Set(this.data.processedTradeIds);
  }

  ensureProcessedTradeIndex() {
    if (
      !this.processedTradeIdSet ||
      this.processedTradeIdSet.size !== this.data.processedTradeIds.length
    ) {
      this.rebuildProcessedTradeIndex();
    }
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    return AtomicFileWriter.write(GRID_STATE_PATH, () => JSON.stringify(this.data, null, 2));
  }

  getSymbol(symbol) {
    const sym = GridState.normalizeSymbolState(this.data.symbols[symbol]);
    this.data.symbols[symbol] = sym;
    // Marker for an in-flight range reset/trailing shift: set (and persisted)
    // BEFORE any exchange orders are cancelled, cleared only once the local
    // remap has been fully computed and persisted in the same save(). If the
    // process crashes/restarts between those two points, this survives on
    // disk so the transition can be resumed against the SAME target range
    // instead of silently leaving cancelled-on-exchange orders paired with
    // stale local config/lastBuyByLevel. See resumeInterruptedRangeTransition().
    return sym;
  }

  async rememberOrder(symbol, order, meta) {
    const sym = this.getSymbol(symbol);
    sym.orders[String(order.id)] = {
      id: String(order.id),
      side: order.side,
      levelIndex: meta.levelIndex,
      price: Number(order.price),
      amount: Number(order.amount),
      createdAt: new Date().toISOString(),
    };
    await this.save();
  }

  async forgetOrder(symbol, orderId) {
    const sym = this.getSymbol(symbol);
    delete sym.orders[String(orderId)];
    await this.save();
  }

  processedTrade(symbol, id) {
    this.ensureProcessedTradeIndex();
    const scopedId = scopedTradeId(symbol, id);
    // NOTE: previously this also checked the legacy, unscoped `String(id)`
    // for backward compatibility with old state files. That was removed:
    // if two different symbols happen to share a numeric trade id and one
    // was ever stored as a legacy (unscoped) id, the other symbol's genuine
    // trade would be wrongly treated as already-processed and silently
    // skipped (missed fill -> stale P&L / buy records). All trades written
    // by this version use the scoped id; any legacy ids left over in an old
    // state file are simply ignored now rather than trusted.
    return this.processedTradeIdSet.has(scopedId);
  }

  // Mutates in-memory state only — does NOT persist. Callers that also touch
  // other parts of symState (buy records, profit totals, order bookkeeping)
  // in the same handler should call this, make all their other mutations,
  // and then call save() exactly once at the end. This is what closes the
  // double-processing hole: previously a trade could be persisted as
  // "processed" via its own separate save() while a sibling mutation from
  // the same fill (e.g. the buy record) had not yet been written, or vice
  // versa, so a crash in between made the fill look unprocessed again on
  // the next cycle even though part of its effect was already applied.
  markProcessedTradeLocal(symbol, id) {
    this.ensureProcessedTradeIndex();
    const scopedId = scopedTradeId(symbol, id);
    if (this.processedTrade(symbol, id)) return false;
    this.data.processedTradeIds.push(scopedId);
    this.processedTradeIdSet.add(scopedId);
    this.data.processedTradeIds = this.data.processedTradeIds.slice(-MAX_PROCESSED_TRADE_IDS);
    if (this.data.processedTradeIds.length >= MAX_PROCESSED_TRADE_IDS) {
      this.rebuildProcessedTradeIndex();
    }
    return true;
  }

  // Convenience wrapper for call sites that have no other pending mutation
  // to batch with — mutates and immediately persists by itself.
  async markProcessedTrade(symbol, id) {
    const changed = this.markProcessedTradeLocal(symbol, id);
    if (changed) await this.save();
    return changed;
  }
}

module.exports = { GridState };
