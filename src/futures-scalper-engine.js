'use strict';

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { TIMEFRAMES, evaluateMaCross, historicalProtection } = require('./ma-cross-strategy');
const { targetNotional, walletBalance } = require('./scalper/allocation');
const { buildScalperConfig } = require('./scalper/config');
const { normalizeAlgoOrders, scalperOrdersForSide } = require('./scalper/order-inspection');
const { canActivateHandoff, positionForSide, protectionPrices } = require('./scalper/position-policy');
const { loadState, saveState } = require('./scalper/state-store');
const { ScalperTelegramNotifier, formatNumber } = require('./scalper/telegram-notifier');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class FuturesScalperEngine {
  constructor({ exchange, environment = process.env, notifier } = {}) {
    this.config = buildScalperConfig(environment);
    this.exchange = exchange || new ccxt.binanceusdm({
      apiKey: environment.EXCHANGE_API_KEY,
      secret: environment.EXCHANGE_SECRET,
      enableRateLimit: true,
      options: {
        defaultType: 'future',
        adjustForTimeDifference: true,
        recvWindow: 10000,
        fetchCurrencies: false,
      },
    });
    this.notifier = notifier || new ScalperTelegramNotifier(environment);
    this.state = loadState(this.config.statePath);
    this.running = false;
  }

  symbolState(symbol) {
    this.state.symbols[symbol] ||= {
      handoffActive: false,
      lastSignalCandle: { LONG: 0, SHORT: 0 },
      lastExitSignalCandle: { LONG: 0, SHORT: 0 },
      cooldownUntil: { LONG: 0, SHORT: 0 },
      positions: { LONG: null, SHORT: null },
      signals: { LONG: null, SHORT: null },
    };
    const state = this.state.symbols[symbol];
    if (!state.positions) {
      state.positions = { LONG: null, SHORT: state.position || null };
      delete state.position;
    }
    if (typeof state.lastSignalCandle !== 'object') {
      state.lastSignalCandle = { LONG: 0, SHORT: Number(state.lastSignalCandle) || 0 };
    }
    if (typeof state.cooldownUntil !== 'object') {
      state.cooldownUntil = { LONG: 0, SHORT: Number(state.cooldownUntil) || 0 };
    }
    state.lastExitSignalCandle ||= { LONG: 0, SHORT: 0 };
    state.signals ||= { LONG: null, SHORT: null };
    state.positions.LONG ??= null;
    state.positions.SHORT ??= null;
    state.lastSignalCandle.LONG ||= 0;
    state.lastSignalCandle.SHORT ||= 0;
    state.lastExitSignalCandle.LONG ||= 0;
    state.lastExitSignalCandle.SHORT ||= 0;
    state.cooldownUntil.LONG ||= 0;
    state.cooldownUntil.SHORT ||= 0;
    state.signals.LONG ??= null;
    state.signals.SHORT ??= null;
    return state;
  }

  pauseReason() {
    if (!this.config.tradingEnabled) return 'SCALPER_TRADING_ENABLED=false';
    if (this.config.stopTrading) return 'STOP_TRADING=true';
    if (this.config.killSwitchEnabled) {
      try {
        if (fs.existsSync(this.config.killSwitchPath)) return `kill switch ${path.basename(this.config.killSwitchPath)} aktif`;
      } catch (error) {
        return `kill switch tidak dapat diperiksa: ${error.message}`;
      }
    }
    return null;
  }

  canEnterNewPositions() {
    return this.pauseReason() === null;
  }

  async notify(title, rows) {
    try {
      await this.notifier.send(title, rows);
    } catch (error) {
      console.warn(`[SCALPER TELEGRAM] ${error.message}`);
    }
  }

  async closedTradeSummary(symbol, side, since) {
    if (typeof this.exchange.fetchMyTrades !== 'function') return null;
    try {
      const trades = await this.exchange.fetchMyTrades(symbol, Number(since) || undefined, 100);
      const exitSide = side === 'LONG' ? 'sell' : 'buy';
      const sideTrades = trades.filter(trade => {
        const positionSide = String(trade.info?.positionSide || side).toUpperCase();
        return positionSide === side;
      });
      const exits = sideTrades.filter(trade =>
        String(trade.side || trade.info?.side || '').toLowerCase() === exitSide);
      if (!exits.length) return null;
      const amount = exits.reduce((sum, trade) => sum + Math.abs(Number(trade.amount) || 0), 0);
      const quoteValue = exits.reduce((sum, trade) =>
        sum + Math.abs(Number(trade.cost) || (Number(trade.amount) || 0) * (Number(trade.price) || 0)), 0);
      const realizedPnl = sideTrades.reduce((sum, trade) =>
        sum + (Number(trade.info?.realizedPnl ?? trade.info?.realizedProfit) || 0), 0);
      const fees = sideTrades.reduce((sum, trade) => {
        const currency = String(trade.fee?.currency || trade.info?.commissionAsset || 'USDT').toUpperCase();
        return currency === 'USDT'
          ? sum + Math.abs(Number(trade.fee?.cost ?? trade.info?.commission) || 0)
          : sum;
      }, 0);
      return {
        exitPrice: amount > 0 ? quoteValue / amount : null,
        realizedPnl,
        fees,
        netPnl: realizedPnl - fees,
      };
    } catch (error) {
      console.warn(`[SCALPER] ${symbol} could not read closing trades: ${error.message}`);
      return null;
    }
  }

  save() {
    saveState(this.config.statePath, this.state);
  }

  marketId(symbol) {
    return this.exchange.market(symbol).id;
  }

  async fetchAlgoOrders(symbol) {
    const response = await this.exchange.fapiPrivateGetOpenAlgoOrders({ symbol: this.marketId(symbol) });
    return normalizeAlgoOrders(response);
  }

  scalperAlgoOrders(orders, side = null) {
    return scalperOrdersForSide(orders, side);
  }

  async cancelScalperAlgoOrders(symbol, side, orders = null) {
    const active = this.scalperAlgoOrders(orders || await this.fetchAlgoOrders(symbol), side);
    for (const order of active) {
      const algoId = order.algoId || order.id;
      if (!algoId) continue;
      try {
        await this.exchange.fapiPrivateDeleteAlgoOrder({ symbol: this.marketId(symbol), algoId });
      } catch (error) {
        if (!String(error.message).includes('-20124')) throw error;
      }
    }
  }

  async activateHandoffIfFlat(symbol, positions, regularOrders, algoOrders) {
    const state = this.symbolState(symbol);
    if (state.handoffActive) return true;
    if (!canActivateHandoff({ positions, regularOrders, algoOrders })) {
      console.log(`[SCALPER WAIT] ${symbol} legacy position/order still active`);
      return false;
    }
    state.handoffActive = true;
    state.activatedAt = new Date().toISOString();
    state.cooldownUntil.LONG = 0;
    state.cooldownUntil.SHORT = 0;
    this.save();
    console.log(`[SCALPER HANDOFF] ${symbol} is flat; grid ownership released`);
    await this.notify('SCALPER PAIR SIAP', [
      ['Pair', symbol],
      ['Status', 'Posisi dan order strategi lama sudah kosong'],
      ['Sisi aktif', this.config.activeSides.join(' + ') || 'Tidak ada'],
    ]);
    return true;
  }

  async closedKlines(symbol, timeframe = this.config.timeframe) {
    const rows = await this.exchange.fapiPublicGetKlines({
      symbol: this.marketId(symbol), interval: timeframe, limit: 500,
    });
    const now = Date.now();
    return rows.filter(row => Number(row?.[6]) < now);
  }

  async signals(symbol, sides) {
    const rows = Object.fromEntries(await Promise.all(Object.keys(TIMEFRAMES).map(async timeframe => {
      try {
        return [timeframe, await this.closedKlines(symbol, timeframe)];
      } catch (error) {
        console.warn(`[SCALPER] ${symbol} ${timeframe}: ${error.message}`);
        return [timeframe, []];
      }
    })));
    return Object.fromEntries(sides.map(side => {
      const strategy = this.config.strategies[side];
      return [side, evaluateMaCross(rows, side, strategy)];
    }));
  }

  async placeProtections(symbol, position, side) {
    await this.cancelScalperAlgoOrders(symbol, side);
    const strategy = this.symbolState(symbol).positions[side]?.risk || this.config.strategies[side];
    const { takeProfit, stopLoss } = protectionPrices(position.entryPrice, strategy);
    const roundedTakeProfit = this.exchange.priceToPrecision(symbol, takeProfit);
    const roundedStopLoss = this.exchange.priceToPrecision(symbol, stopLoss);
    if (strategy.protectionMode === 'HISTORICAL_CROSS' || strategy.protectionMode === 'CROSS_TARGET_RR1') {
      protectionPrices(position.entryPrice, { ...strategy, protectionMode: 'HISTORICAL_CROSS',
        takeProfitPrice: roundedTakeProfit, stopLossPrice: roundedStopLoss });
    }
    const exitOrderSide = side === 'LONG' ? 'sell' : 'buy';
    const sideCode = side === 'LONG' ? 'l' : 's';
    const common = {
      closePosition: true,
      positionSide: side,
      workingType: 'MARK_PRICE',
    };
    const nonce = Date.now().toString(36);
    const stop = await this.exchange.createOrder(symbol, 'market', exitOrderSide, undefined, undefined, {
      ...common,
      stopLossPrice: roundedStopLoss,
      clientOrderId: `scalp-${sideCode}-sl-${nonce}`.slice(0, 32),
    });
    try {
      const take = await this.exchange.createOrder(symbol, 'market', exitOrderSide, undefined, undefined, {
        ...common,
        takeProfitPrice: roundedTakeProfit,
        clientOrderId: `scalp-${sideCode}-tp-${nonce}`.slice(0, 32),
      });
      return { stopAlgoId: String(stop.id), takeProfitAlgoId: String(take.id), takeProfit, stopLoss };
    } catch (error) {
      await this.cancelScalperAlgoOrders(symbol, side);
      throw error;
    }
  }

  async closePosition(symbol, position, side, reason) {
    await this.cancelScalperAlgoOrders(symbol, side);
    const amount = Number(this.exchange.amountToPrecision(symbol, Number(position.contracts)));
    if (!(amount > 0)) throw new Error(`${symbol} invalid ${side} close amount`);
    const exitOrderSide = side === 'LONG' ? 'sell' : 'buy';
    const sideCode = side === 'LONG' ? 'l' : 's';
    await this.exchange.createOrder(symbol, 'market', exitOrderSide, amount, undefined, {
      positionSide: side,
      newClientOrderId: `scalp-${sideCode}-close-${Date.now().toString(36)}`.slice(0, 32),
    });
    const state = this.symbolState(symbol);
    const tracked = state.positions[side] || {};
    const heldMinutes = tracked.enteredAt ? Math.max(0, (Date.now() - Number(tracked.enteredAt)) / 60_000) : null;
    state.positions[side] = {
      ...tracked,
      closing: { reason, submittedAt: Date.now() },
    };
    this.save();
    console.log(`[SCALPER EXIT] ${symbol} ${side} ${reason} amount=${amount}`);
    const safetyClose = /protection|invalid|failed/i.test(reason);
    if (safetyClose) {
      await this.notify('SCALPER SAFETY CLOSE', [
        ['Pair', symbol],
        ['Sisi', side],
        ['Alasan', reason],
        ['Jumlah', formatNumber(amount)],
        ['Harga entry', formatNumber(position.entryPrice)],
        ['Mark terakhir', formatNumber(position.markPrice ?? position.info?.markPrice)],
        ['PnL berjalan terakhir', Number.isFinite(Number(position.unrealizedPnl))
          ? `${formatNumber(position.unrealizedPnl, 4)} USDT`
          : null],
        ['Durasi', heldMinutes === null ? null : `${formatNumber(heldMinutes, 1)} menit`],
      ]);
    }
  }

  async ensureManagedPosition(symbol, position, side, algoOrders) {
    const state = this.symbolState(symbol);
    if (!state.positions[side]) {
      state.positions[side] = {
        enteredAt: Date.now(),
        entryPrice: Number(position.entryPrice),
        adoptedAfterRestart: true,
      };
      this.save();
    }
    const closing = state.positions[side]?.closing;
    if (closing) {
      const closingAge = Date.now() - Number(closing.submittedAt || 0);
      if (closingAge < this.config.intervalMs * 2) return true;
      delete state.positions[side].closing;
      this.save();
      await this.notify('SCALPER CLOSE RETRY', [
        ['Pair', symbol],
        ['Sisi', side],
        ['Status', 'Posisi masih terbuka setelah market close. Proteksi dipasang kembali.'],
      ]);
    }
    if (this.scalperAlgoOrders(algoOrders, side).length < 2) {
      try {
        state.positions[side].protection = await this.placeProtections(symbol, position, side);
        this.save();
      } catch (error) {
        await this.closePosition(symbol, position, side, `protection placement failed: ${error.message}`);
        throw error;
      }
    }
    return false;
  }

  async enterPosition(symbol, currentPrice, side, signal) {
    if (!signal?.allow || !signal.risk || !this.canEnterNewPositions()) return;
    const ticker = await this.exchange.fetchTicker(symbol);
    const currentEntry = Number(side === 'LONG' ? ticker.ask || ticker.last : ticker.bid || ticker.last);
    const estimatedEntry = currentEntry * (side === 'LONG' ? 1.0002 : 0.9998);
    if (!historicalProtection(estimatedEntry, side, signal.supportResistance, signal.risk).valid) return;
    const balance = await this.exchange.fetchBalance();
    const wallet = walletBalance(balance);
    const notional = targetNotional(
      wallet,
      this.config.allocations[side] * signal.risk.sizeMultiplier,
      this.config.leverage,
      this.config.symbols.length
    );
    const amount = Number(this.exchange.amountToPrecision(symbol, notional / estimatedEntry));
    const market = this.exchange.market(symbol);
    const minAmount = Number(market.limits?.amount?.min) || 0;
    const minCost = Number(market.limits?.cost?.min) || 0;
    if (!(amount > 0) || amount < minAmount || amount * estimatedEntry < minCost) {
      throw new Error(`${symbol} scalper amount ${amount} / notional ${notional} below exchange minimum`);
    }
    const entryOrderSide = side === 'LONG' ? 'buy' : 'sell';
    const sideCode = side === 'LONG' ? 'l' : 's';
    await this.exchange.createOrder(symbol, 'market', entryOrderSide, amount, undefined, {
      positionSide: side,
      newClientOrderId: `scalp-${sideCode}-entry-${Date.now().toString(36)}`.slice(0, 32),
    });
    const positions = await this.exchange.fetchPositions([symbol]);
    const position = positionForSide(positions, symbol, side);
    if (!position) throw new Error(`${symbol} ${side} entry returned but no position is visible`);
    const state = this.symbolState(symbol);
    state.positions[side] = { enteredAt: Date.now(), entryPrice: Number(position.entryPrice),
      risk: signal.risk, countertrend: signal.countertrend, timeframes: signal.timeframes };
    this.save();
    try {
      const filledProtection = historicalProtection(Number(position.entryPrice), side, signal.supportResistance, signal.risk);
      if (!filledProtection.valid) {
        throw new Error('Filled entry invalidates historical cross TP/SL');
      }
      state.positions[side].risk = { ...signal.risk, ...filledProtection };
      state.positions[side].protection = await this.placeProtections(symbol, position, side);
      this.save();
    } catch (error) {
      await this.closePosition(symbol, position, side, `entry protection failed: ${error.message}`);
      state.positions[side] = null;
      this.save();
      throw error;
    }
    console.log(`[SCALPER ENTRY] ${symbol} ${side} amount=${amount} notional=${notional.toFixed(2)}`);
    const protection = state.positions[side].protection;
    await this.notify('SCALPER ENTRY', [
      ['Pair', symbol],
      ['Sisi', side],
      ['Harga entry', formatNumber(position.entryPrice)],
      ['Jumlah', formatNumber(amount)],
      ['Notional', `${formatNumber(notional, 2)} USDT`],
      ['Take profit', formatNumber(protection.takeProfit)],
      ['Stop loss', formatNumber(protection.stopLoss)],
      ['Jatah sisi', `${formatNumber(this.config.allocations[side], 2)}% dibagi ${this.config.symbols.length} pair`],
      ['Sinyal', `MA7/25/99 ${this.config.timeframe}`],
      ['Kondisi', signal.reason],
    ]);
  }

  async cycleSymbol(symbol) {
    const [positions, regularOrders, algoOrders] = await Promise.all([
      this.exchange.fetchPositions([symbol]),
      this.exchange.fetchOpenOrders(symbol),
      this.fetchAlgoOrders(symbol),
    ]);
    if (!await this.activateHandoffIfFlat(symbol, positions, regularOrders, algoOrders)) return;

    const state = this.symbolState(symbol);
    const flatSides = [];
    const openSides = [];
    for (const side of ['LONG', 'SHORT']) {
      const position = positionForSide(positions, symbol, side);
      if (position) {
        const closing = await this.ensureManagedPosition(symbol, position, side, algoOrders);
        if (!closing) openSides.push({ side, position });
        continue;
      }
      if (state.positions[side]) {
        const previous = state.positions[side];
        await this.cancelScalperAlgoOrders(symbol, side, algoOrders);
        const heldMinutes = previous.enteredAt
          ? Math.max(0, (Date.now() - Number(previous.enteredAt)) / 60_000)
          : null;
        const trade = await this.closedTradeSummary(symbol, side, previous.enteredAt);
        await this.notify(previous.closing ? 'SCALPER EXIT CONFIRMED' : 'SCALPER POSITION CLOSED', [
          ['Pair', symbol],
          ['Sisi', side],
          ['Status', 'Posisi sudah tertutup di Binance'],
          ['Alasan', previous.closing?.reason || 'Take profit, stop loss, atau penutupan manual'],
          ['Harga entry', formatNumber(previous.entryPrice)],
          ['Harga exit', trade?.exitPrice ? formatNumber(trade.exitPrice) : null],
          ['PnL bersih', trade ? `${formatNumber(trade.netPnl, 4)} USDT` : null],
          ['Fee exit', trade ? `${formatNumber(trade.fees, 4)} USDT` : null],
          ['Durasi', heldMinutes === null ? null : `${formatNumber(heldMinutes, 1)} menit`],
        ]);
        state.positions[side] = null;
        state.cooldownUntil[side] = Date.now() + this.config.strategies[side].cooldownMinutes * 60_000;
        this.save();
      }
      if (this.canEnterNewPositions() && this.config.activeSides.includes(side)) {
        flatSides.push(side);
      }
    }
    const signalSides = [...new Set([...openSides.map(item => item.side), ...flatSides])];
    if (!signalSides.length) return;
    const signals = await this.signals(symbol, signalSides);
    for (const side of signalSides) {
      const signal = signals[side];
      state.signals[side] = {
        candleTimestamp: signal.candleTimestamp,
        evaluatedAt: new Date().toISOString(),
        available: signal.available,
        ma7: signal.indicator?.ma7 ?? null,
        ma25: signal.indicator?.ma25 ?? null,
        ma99: signal.indicator?.ma99 ?? null,
        timeframes: signal.timeframes,
        supportResistance: signal.supportResistance,
        countertrend: signal.countertrend ?? null,
        risk: signal.risk || null,
        reason: signal.reason,
        allow: Boolean(signal.allow),
        deterministicAllow: signal.deterministicAllow ?? Boolean(signal.allow),
        entrySource: signal.entrySource,
        aiAction: signal.aiDecision?.decision?.action || null,
        aiConfidence: Number.isFinite(Number(signal.aiDecision?.decision?.confidence))
          ? Number(signal.aiDecision.decision.confidence)
          : null,
        aiReason: signal.aiDecision?.reason || null,
        exit: Boolean(signal.exit),
        close: Number(signal.candle?.close) || null,
        flowDeltaRatio: Number.isFinite(Number(signal.indicator?.flowDeltaRatio))
          ? Number(signal.indicator.flowDeltaRatio)
          : null,
        momentumPct: Number.isFinite(Number(signal.indicator?.momentumRatio))
          ? Number(signal.indicator.momentumRatio) * 100
          : null,
        atrPct: Number.isFinite(Number(signal.indicator?.atrPct))
          ? Number(signal.indicator.atrPct)
          : null,
        emaSlow: Number.isFinite(Number(signal.indicator?.emaSlow))
          ? Number(signal.indicator.emaSlow)
          : null,
      };
    }
    this.save();
    for (const side of flatSides) {
      const signal = signals[side];
      if (!signal.candleTimestamp || signal.candleTimestamp === state.lastSignalCandle[side]) continue;
      state.lastSignalCandle[side] = signal.candleTimestamp;
      this.save();
      if (signal.allow) await this.enterPosition(symbol, signal.candle.close, side, signal);
    }
  }

  async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      for (const symbol of this.config.symbols) {
        try {
          await this.cycleSymbol(symbol);
        } catch (error) {
          console.error(`[SCALPER] ${symbol}: ${error.stack || error.message}`);
          const state = this.symbolState(symbol);
          const key = String(error.message || error);
          const now = Date.now();
          if (state.lastErrorKey !== key || now - Number(state.lastErrorNotifiedAt || 0) >= 15 * 60_000) {
            state.lastErrorKey = key;
            state.lastErrorNotifiedAt = now;
            this.save();
            await this.notify('SCALPER ERROR', [
              ['Pair', symbol],
              ['Masalah', key],
              ['Tindakan', 'Bot akan mencoba lagi. Posisi terbuka tetap diperiksa pada siklus berikutnya.'],
            ]);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!this.config.enabled) {
      console.log('[SCALPER] Disabled');
      return;
    }
    if (!this.config.symbols.length) throw new Error('SCALPER requires SYMBOLS');
    await this.exchange.loadMarkets();
    for (const symbol of this.config.symbols) {
      await this.exchange.setLeverage(this.config.leverage, symbol);
      this.symbolState(symbol);
    }
    this.save();
    console.log(
      `[SCALPER] Started ${this.config.activeSides.join('+') || 'EXIT-ONLY'} Hedge Mode; ` +
      `${this.config.timeframe} MA7/25/99; context 15m/1h/4h; ` +
      'TP/SL=historical MA7/MA25 crosses; ' +
      'exit=TP/SL only; ' +
      `allocation=LONG ${this.config.allocations.LONG}% + SHORT ${this.config.allocations.SHORT}% ` +
      `across ${this.config.symbols.length} pairs`
    );
    await this.notify('SCALPER STARTED', [
      ['Mode', this.config.activeSides.join(' + ') || 'EXIT-ONLY'],
      ['Strategi', `${this.config.timeframe} MA7/25/99; konteks 15m/1h/4h`],
      ['Trading', this.pauseReason() || 'Aktif'],
      ['Alokasi', `LONG ${formatNumber(this.config.allocations.LONG, 2)}% + SHORT ${formatNumber(this.config.allocations.SHORT, 2)}%`],
      ['Proteksi', 'TP/SL cross historis terpilih: prioritas timeframe besar dan retest; TP kandidat 3, SL kandidat 2'],
    ]);
    while (true) {
      await this.cycle();
      await sleep(this.config.intervalMs);
    }
  }
}

module.exports = {
  FuturesScalperEngine,
  buildConfig: buildScalperConfig,
  normalizeAlgoOrders,
  positionForSide,
  targetNotional,
};
