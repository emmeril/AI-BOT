'use strict';

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { buildIndicators, entrySignal, exitSignal } = require('./micro-scalper-strategy');
const { ScalperTelegramNotifier, formatNumber } = require('./scalper-telegram');
const {
  canActivateHandoff,
  hasPosition,
  loadState,
  protectionPrices,
  saveState,
} = require('./scalper-handoff');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function numberEnv(environment, name, fallback) {
  const value = Number(environment[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanEnv(environment, name, fallback = false) {
  const value = environment[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function buildConfig(environment = process.env) {
  const symbols = String(environment.SYMBOLS || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  const totalAllocationPct = numberEnv(environment, 'SCALPER_ALLOCATION_PCT', 70);
  const strategy = side => ({
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
    takeProfitPct: numberEnv(environment, 'SCALPER_TAKE_PROFIT_PCT', 2),
    stopLossPct: numberEnv(environment, 'SCALPER_STOP_LOSS_PCT', 1),
    maxHoldMinutes: numberEnv(environment, 'SCALPER_MAX_HOLD_MINUTES', 240),
    cooldownMinutes: numberEnv(environment, 'SCALPER_COOLDOWN_MINUTES', 15),
  });
  const strategies = { LONG: strategy('LONG'), SHORT: strategy('SHORT') };
  const activeSides = ['LONG', 'SHORT'].filter(side =>
    booleanEnv(environment, `SCALPER_${side}_ENABLED`, side === 'LONG'));
  return {
    symbols,
    enabled: booleanEnv(environment, 'SCALPER_ENABLED', true),
    tradingEnabled: booleanEnv(environment, 'SCALPER_TRADING_ENABLED', true),
    intervalMs: Math.max(5000, numberEnv(environment, 'SCALPER_INTERVAL_MS', 15000)),
    timeframe: String(environment.SCALPER_TIMEFRAME || '15m'),
    allocationPct: totalAllocationPct,
    allocations: {
      LONG: numberEnv(environment, 'SCALPER_LONG_ALLOCATION_PCT', totalAllocationPct / 2),
      SHORT: numberEnv(environment, 'SCALPER_SHORT_ALLOCATION_PCT', totalAllocationPct / 2),
    },
    leverage: numberEnv(environment, 'LEVERAGE', 5),
    stopTrading: booleanEnv(environment, 'STOP_TRADING', false),
    killSwitchEnabled: booleanEnv(environment, 'KILL_SWITCH_ENABLED', true),
    killSwitchPath: path.resolve(environment.KILL_SWITCH_FILE || 'bot-paused.flag'),
    statePath: path.resolve(environment.SCALPER_STATE_FILE || 'futures-scalper-state.json'),
    strategies,
    strategy: strategies.SHORT,
    activeSides,
  };
}

function normalizeAlgoOrders(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.orders)) return response.orders;
  return [];
}

function positionForSide(positions, symbol, side) {
  return positions.find(position => position.symbol === symbol &&
    String(position.side || position.info?.positionSide).toUpperCase() === side && hasPosition(position));
}

function targetNotional(walletBalance, allocationPct, leverage, pairCount) {
  const wallet = Number(walletBalance);
  const pairs = Number(pairCount);
  if (!(wallet > 0) || !(pairs > 0)) return 0;
  return wallet * Number(allocationPct) / 100 * Number(leverage) / pairs;
}

class FuturesScalperEngine {
  constructor({ exchange, environment = process.env, notifier } = {}) {
    this.config = buildConfig(environment);
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
    const scalperOrders = orders.filter(order =>
      String(order.clientAlgoId || order.clientOrderId || '').startsWith('scalp-'));
    if (!side) return scalperOrders;
    const expected = String(side).toUpperCase();
    return scalperOrders.filter(order => {
      const positionSide = String(order.positionSide || order.info?.positionSide || '').toUpperCase();
      if (positionSide) return positionSide === expected;
      const clientId = String(order.clientAlgoId || order.clientOrderId || '');
      if (clientId.startsWith('scalp-l-')) return expected === 'LONG';
      if (clientId.startsWith('scalp-s-')) return expected === 'SHORT';
      return expected === 'SHORT';
    });
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
    state.cooldownUntil.LONG = Date.now() + this.config.intervalMs * 2;
    state.cooldownUntil.SHORT = Date.now() + this.config.intervalMs * 2;
    this.save();
    console.log(`[SCALPER HANDOFF] ${symbol} is flat; grid ownership released`);
    await this.notify('SCALPER PAIR SIAP', [
      ['Pair', symbol],
      ['Status', 'Posisi dan order strategi lama sudah kosong'],
      ['Sisi aktif', this.config.activeSides.join(' + ') || 'Tidak ada'],
    ]);
    return true;
  }

  async closedKlines(symbol) {
    const lookback = Math.max(...Object.values(this.config.strategies).map(strategy =>
      Math.max(strategy.emaSlow, strategy.momentumWindow, strategy.atrPeriod, strategy.flowWindow)
    ));
    const rows = await this.exchange.fapiPublicGetKlines({
      symbol: this.marketId(symbol), interval: this.config.timeframe, limit: Math.min(1500, lookback + 10),
    });
    const now = Date.now();
    return rows.filter(row => Number(row?.[6]) < now);
  }

  async signals(symbol, sides) {
    const rows = await this.closedKlines(symbol);
    return Object.fromEntries(sides.map(side => {
      const strategy = this.config.strategies[side];
      const { candles, indicators } = buildIndicators(rows, strategy);
      const index = candles.length - 1;
      return [side, {
        candleTimestamp: candles[index]?.timestamp || 0,
        allow: entrySignal(candles[index], indicators[index], strategy),
        exit: exitSignal(candles[index], indicators[index], strategy),
        candle: candles[index],
        indicator: indicators[index],
      }];
    }));
  }

  walletBalance(balance) {
    const candidates = [
      balance?.info?.totalWalletBalance,
      balance?.total?.USDT,
      balance?.USDT?.total,
    ].map(Number).filter(Number.isFinite);
    return candidates.find(value => value > 0) || 0;
  }

  async placeProtections(symbol, position, side) {
    await this.cancelScalperAlgoOrders(symbol, side);
    const strategy = this.config.strategies[side];
    const { takeProfit, stopLoss } = protectionPrices(position.entryPrice, strategy);
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
      stopLossPrice: this.exchange.priceToPrecision(symbol, stopLoss),
      clientOrderId: `scalp-${sideCode}-sl-${nonce}`.slice(0, 32),
    });
    try {
      const take = await this.exchange.createOrder(symbol, 'market', exitOrderSide, undefined, undefined, {
        ...common,
        takeProfitPrice: this.exchange.priceToPrecision(symbol, takeProfit),
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
    const maxAge = this.config.strategies[side].maxHoldMinutes * 60_000;
    if (Date.now() - Number(state.positions[side].enteredAt) >= maxAge) {
      await this.closePosition(
        symbol, position, side, `maximum ${this.config.strategies[side].maxHoldMinutes}-minute hold`
      );
      return true;
    }
    return false;
  }

  async enterPosition(symbol, currentPrice, side) {
    const balance = await this.exchange.fetchBalance();
    const wallet = this.walletBalance(balance);
    const notional = targetNotional(
      wallet,
      this.config.allocations[side],
      this.config.leverage,
      this.config.symbols.length
    );
    const amount = Number(this.exchange.amountToPrecision(symbol, notional / currentPrice));
    const market = this.exchange.market(symbol);
    const minAmount = Number(market.limits?.amount?.min) || 0;
    const minCost = Number(market.limits?.cost?.min) || 0;
    if (!(amount > 0) || amount < minAmount || amount * currentPrice < minCost) {
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
    state.positions[side] = { enteredAt: Date.now(), entryPrice: Number(position.entryPrice) };
    this.save();
    try {
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
      ['Sinyal', `Volume delta reversal ${this.config.timeframe}`],
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
        const closedForAge = await this.ensureManagedPosition(symbol, position, side, algoOrders);
        if (!closedForAge) openSides.push({ side, position });
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
      if (this.canEnterNewPositions() && this.config.activeSides.includes(side) &&
        Date.now() >= Number(state.cooldownUntil[side] || 0)) {
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
        available: Boolean(signal.candle && signal.indicator),
        allow: Boolean(signal.allow),
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
    for (const { side, position } of openSides) {
      const signal = signals[side];
      if (!signal.exit || !signal.candleTimestamp ||
        signal.candleTimestamp === state.lastExitSignalCandle[side]) continue;
      state.lastExitSignalCandle[side] = signal.candleTimestamp;
      this.save();
      await this.closePosition(symbol, position, side, 'adverse volume delta');
    }
    for (const side of flatSides) {
      const signal = signals[side];
      if (!signal.candleTimestamp || signal.candleTimestamp === state.lastSignalCandle[side]) continue;
      state.lastSignalCandle[side] = signal.candleTimestamp;
      this.save();
      if (signal.allow) await this.enterPosition(symbol, signal.candle.close, side);
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
      `${this.config.timeframe} volume-delta reversal; ` +
      `TP=${this.config.strategy.takeProfitPct}%; SL=${this.config.strategy.stopLossPct}%; ` +
      `maxHold=${this.config.strategy.maxHoldMinutes}m; ` +
      `allocation=LONG ${this.config.allocations.LONG}% + SHORT ${this.config.allocations.SHORT}% ` +
      `across ${this.config.symbols.length} pairs`
    );
    await this.notify('SCALPER STARTED', [
      ['Mode', this.config.activeSides.join(' + ') || 'EXIT-ONLY'],
      ['Strategi', `${this.config.timeframe} volume-delta reversal`],
      ['Trading', this.pauseReason() || 'Aktif'],
      ['Alokasi', `LONG ${formatNumber(this.config.allocations.LONG, 2)}% + SHORT ${formatNumber(this.config.allocations.SHORT, 2)}%`],
      ['Proteksi', `TP ${formatNumber(this.config.strategy.takeProfitPct, 2)}% / SL ${formatNumber(this.config.strategy.stopLossPct, 2)}%`],
    ]);
    while (true) {
      await this.cycle();
      await sleep(this.config.intervalMs);
    }
  }
}

module.exports = {
  FuturesScalperEngine,
  buildConfig,
  normalizeAlgoOrders,
  positionForSide,
  targetNotional,
};
