'use strict';

const fs = require('node:fs');
const { PredictiveLiveEngine, loadLiveState, saveLiveState } = require('./live-engine');
const { asBoolean, openPositions, positionAmount, algoOrders, selectLiveForecast,
  candidateEvidence, protectionMatches } = require('./live-policy');

const SIDES = ['LONG', 'SHORT'];

function hedgeState(source) {
  if (source.initialWalletUsdt !== null && !Number.isFinite(source.initialWalletUsdt)) throw new Error('Invalid hedge session wallet baseline');
  if (source.version === 2 && source.symbol === 'DOGEUSDT' && source.horizon === 60 && source.slots) {
    for (const side of SIDES) {
      const slot = source.slots[side];
      if (slot?.version !== 1 || slot.symbol !== source.symbol || slot.horizon !== source.horizon ||
          slot.initialWalletUsdt !== source.initialWalletUsdt || !Array.isArray(slot.closed) ||
          [slot.intent?.plan, slot.tracked?.plan].filter(Boolean)
            .some(plan => plan.side !== side || plan.positionSide !== side || plan.symbol !== source.symbol)) throw new Error('Invalid hedge slot state');
    }
    return source;
  }
  if (source.version !== 1 || source.symbol !== 'DOGEUSDT' || source.horizon !== 60) throw new Error('Incompatible hedge runtime state');
  const root = { version: 2, symbol: source.symbol, horizon: source.horizon,
    initialWalletUsdt: source.initialWalletUsdt, pausedReason: null,
    legacyClosed: source.closed || [], closed: source.closed || [], slots: {} };
  for (const side of SIDES) root.slots[side] = { version: 1, symbol: source.symbol, horizon: source.horizon,
    initialWalletUsdt: source.initialWalletUsdt, consumedForecastId: source.consumedForecastId,
    intent: null, tracked: null, pausedReason: null, closed: [] };
  for (const key of ['intent', 'tracked']) {
    if (!source[key]) continue;
    const plan = source[key].plan;
    if (!SIDES.includes(plan?.side) || plan.positionSide !== plan.side || plan.symbol !== source.symbol) throw new Error('An existing one-way or foreign position cannot be migrated into hedge slots');
    root.slots[plan.side][key] = source[key];
  }
  const owner = source.tracked?.plan.side || source.intent?.plan.side;
  if (source.pausedReason && owner && source.pausedReason !== 'SESSION_LOSS_BUDGET_REACHED') {
    root.slots[owner].pausedReason = source.pausedReason;
  } else root.pausedReason = source.pausedReason;
  return root;
}

function loadHedgeState(file) {
  try { return hedgeState(JSON.parse(fs.readFileSync(file))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return hedgeState(loadLiveState(file));
  }
}

function sideExchange(exchange, side, symbol = 'DOGEUSDT') {
  return new Proxy(exchange, { get(target, name) {
    const method = target[name];
    if (typeof method !== 'function') return method;
    return async (...args) => {
      if (['fapiPrivatePostOrder', 'fapiPrivatePostAlgoOrder'].includes(name) &&
          (args[0]?.positionSide !== side || args[0]?.symbol !== symbol)) {
        throw new Error('Exchange submission does not match its hedge slot');
      }
      const result = await method.apply(target, args);
      if (name === 'fapiPrivateV3GetPositionRisk') return result.filter(row => row.positionSide === side);
      if (name === 'fapiPrivateGetOpenOrders') return result.filter(row => row.positionSide === side);
      if (name === 'fapiPrivateGetOpenAlgoOrders') return algoOrders(result).filter(row => row.positionSide === side);
      if (['fapiPrivateGetOrder', 'fapiPrivatePostOrder', 'fapiPrivatePostAlgoOrder'].includes(name) &&
          ((!result || typeof result !== 'object') || (result.positionSide && result.positionSide !== side) ||
            (result.symbol && result.symbol !== symbol))) {
        throw new Error('Exchange returned another hedge side or symbol');
      }
      return result;
    };
  } });
}

class PredictiveHedgeEngine {
  constructor({ config, exchange, state, save, readForecasts, readAiReviews, now = Date.now }) {
    if (config.maxOpenPositions !== 2 || config.positionExitPolicy !== 'TP_SL_ONLY') throw new Error('Hedge engine requires two independent TP/SL-only slots');
    this.config = config; this.exchange = exchange; this.now = now;
    this.state = state ? hedgeState(state) : loadHedgeState(config.stateFile);
    this.write = save || (() => saveLiveState(config.stateFile, this.state));
    this.readForecasts = readForecasts || (() => JSON.parse(fs.readFileSync(config.forecastFile)));
    this.engines = Object.fromEntries(SIDES.map(side => [side, new PredictiveLiveEngine({
      config: { ...config, entrySide: side }, exchange: sideExchange(exchange, side, config.symbol), state: this.state.slots[side],
      now, save: () => this.persist(), readForecasts: this.readForecasts, readAiReviews,
      beforeEntry: plan => this.beforeEntry(plan),
    })]));
    this.expectedModelId = this.engines.LONG.expectedModelId;
    this.expectedReachabilityModelId = this.engines.LONG.expectedReachabilityModelId;
  }

  hasExposure() { return SIDES.some(side => this.state.slots[side].tracked || this.state.slots[side].intent); }

  persist() {
    const combined = [...(this.state.legacyClosed || []), ...SIDES.flatMap(side => this.state.slots[side].closed)];
    this.state.closed = [...new Map(combined.map(row => [row.side + ':' + row.entryOrderId + ':' + row.closedAt, row])).values()]
      .sort((a, b) => a.closedAt - b.closedAt).slice(-1000);
    this.state.openSides = SIDES.filter(side => this.state.slots[side].tracked);
    this.state.pendingSides = SIDES.filter(side => this.state.slots[side].intent);
    this.state.slotPausedReasons = Object.fromEntries(SIDES.map(side => [side, this.state.slots[side].pausedReason]));
    this.state.updatedAt = this.now();
    this.write();
  }

  async snapshot() {
    const e = this.exchange, symbol = this.config.symbol;
    const [positions, orders, algorithms, account, accountConfig, settings] = await Promise.all([
      e.fapiPrivateV3GetPositionRisk({ symbol }), e.fapiPrivateGetOpenOrders({ symbol }),
      e.fapiPrivateGetOpenAlgoOrders({ symbol }), e.fapiPrivateV3GetAccount(),
      e.fapiPrivateGetAccountConfig(), e.fapiPrivateGetSymbolConfig({ symbol }),
    ]);
    if (!Array.isArray(orders) || !Array.isArray(settings)) throw new Error('Invalid hedge account snapshot');
    const asset = account.assets?.find(row => row.asset === 'USDT');
    return { positions: openPositions(positions), orders, algorithms: algoOrders(algorithms), account, accountConfig,
      settings: settings.find(row => row.symbol === symbol), hedgeMode: asBoolean(accountConfig.dualSidePosition),
      walletUsdt: Number(asset?.walletBalance ?? account.totalWalletBalance),
      availableUsdt: Number(asset?.availableBalance ?? account.availableBalance) };
  }

  async configureAccount() {
    if (!this.config.enabled) throw new Error('Live hedge order execution is disabled');
    let snapshot = await this.snapshot();
    if (snapshot.positions.length || snapshot.orders.length || snapshot.algorithms.length) return;
    if (!snapshot.hedgeMode) {
      await this.exchange.fapiPrivatePostPositionSideDual({ dualSidePosition: 'true' });
      snapshot = await this.snapshot();
    }
    this.engines.LONG.validateAccount(snapshot);
    if (String(snapshot.settings?.marginType).toUpperCase() !== 'ISOLATED') {
      await this.exchange.fapiPrivatePostMarginType({ symbol: this.config.symbol, marginType: 'ISOLATED' });
    }
    await this.exchange.fapiPrivatePostLeverage({ symbol: this.config.symbol, leverage: this.config.leverage });
    snapshot = await this.snapshot();
    this.engines.LONG.validateAccount(snapshot);
    if (Number(snapshot.settings?.leverage) !== this.config.leverage || String(snapshot.settings.marginType).toUpperCase() !== 'ISOLATED') {
      throw new Error('Could not verify isolated 10x hedge configuration');
    }
    if (this.state.initialWalletUsdt === null) this.state.initialWalletUsdt = snapshot.walletUsdt;
    for (const side of SIDES) this.state.slots[side].initialWalletUsdt = this.state.initialWalletUsdt;
    this.persist();
  }

  entryBlock(snapshot, plan, readOnly = false) {
    if (this.state.pausedReason) return this.state.pausedReason;
    if (!snapshot.hedgeMode) return 'HEDGE_MODE_REQUIRED';
    if (Number(snapshot.settings?.leverage) !== this.config.leverage || String(snapshot.settings?.marginType).toUpperCase() !== 'ISOLATED') return 'HEDGE_SETTINGS_CHANGED';
    if (this.state.initialWalletUsdt !== null && this.state.initialWalletUsdt - snapshot.walletUsdt >= this.config.sessionLossBudgetUsdt) {
      if (!readOnly) { this.state.pausedReason = 'SESSION_LOSS_BUDGET_REACHED'; this.persist(); }
      return 'SESSION_LOSS_BUDGET_REACHED';
    }
    for (const side of SIDES) {
      const slot = this.state.slots[side];
      if (slot.pausedReason) return 'HEDGE_SLOT_PAUSED:' + side + ':' + slot.pausedReason;
      if (slot.intent && slot.intent.plan.entryClientId !== plan?.entryClientId) return 'HEDGE_ENTRY_PENDING';
      if (slot.tracked?.closing) return 'HEDGE_CLOSE_PENDING';
    }
    for (const position of snapshot.positions) {
      const slot = this.state.slots[position.positionSide];
      if (!slot || (!slot.tracked && !slot.intent)) return 'FOREIGN_DOGE_POSITION';
      if (slot.tracked && Math.abs(positionAmount(position) - slot.tracked.quantity) > 1e-8) return 'HEDGE_POSITION_OWNERSHIP_CHANGED';
    }
    for (const order of snapshot.orders) {
      const slot = this.state.slots[order.positionSide];
      if (!slot || ![slot.intent?.plan.entryClientId, slot.tracked?.closing?.clientOrderId].includes(order.clientOrderId)) return 'FOREIGN_DOGE_ORDER';
    }
    for (const order of snapshot.algorithms) {
      const slot = this.state.slots[order.positionSide];
      const owner = slot?.tracked?.plan || slot?.intent?.plan;
      if (!owner || ![owner.stopClientId, owner.takeClientId].includes(order.clientAlgoId)) return 'FOREIGN_DOGE_CONDITIONAL_ORDER';
    }
    for (const side of SIDES) {
      const tracked = this.state.slots[side].tracked;
      if (tracked && !['SL', 'TP'].every(kind => snapshot.algorithms.some(order => protectionMatches(order, tracked.plan, kind)))) {
        return 'HEDGE_PROTECTION_NOT_CONFIRMED:' + side;
      }
    }
    if (plan) {
      const slot = this.state.slots[plan.side];
      if (!slot || slot.tracked || snapshot.positions.some(row => row.positionSide === plan.side) ||
          snapshot.orders.some(row => row.positionSide === plan.side) || snapshot.algorithms.some(row => row.positionSide === plan.side)) return 'HEDGE_SIDE_ALREADY_OCCUPIED';
      if (snapshot.availableUsdt < this.config.marginUsdt + this.config.feeReserveUsdt) return 'INSUFFICIENT_FREE_USDT';
      const existing = snapshot.positions.reduce((sum, row) => sum + positionAmount(row) * Number(row.entryPrice), 0);
      if (!Number.isFinite(existing) || existing + plan.estimatedNotionalUsdt > this.config.maxTotalNotionalUsdt + 1e-8) return 'HEDGE_TOTAL_NOTIONAL_LIMIT';
    }
    return null;
  }

  async beforeEntry(plan) {
    const snapshot = await this.snapshot();
    this.engines[plan.side].validateAccount(snapshot);
    const reason = this.entryBlock(snapshot, plan);
    if (reason) throw new Error('Hedge entry blocked: ' + reason);
  }

  async preflight() {
    const snapshot = await this.snapshot();
    this.engines.LONG.validateAccount(snapshot);
    const source = this.readForecasts();
    const evidence = candidateEvidence(source, this.config, this.expectedModelId, this.expectedReachabilityModelId);
    const base = { orderExecutionEnabled: false, maxOpenPositions: 2, maxPositionsPerSide: 1,
      targetNotionalUsdtPerSide: this.config.notionalUsdt, maxTotalNotionalUsdt: this.config.maxTotalNotionalUsdt,
      hedgeMode: snapshot.hedgeMode, availableUsdt: snapshot.availableUsdt, walletUsdt: snapshot.walletUsdt,
      positionExitPolicy: 'TP_SL_ONLY', timeBasedPositionExit: false, evidence };
    const blocked = this.entryBlock(snapshot, null, true);
    if (blocked) return { ...base, status: 'WAITING', reason: blocked };
    const forecast = selectLiveForecast(source, this.config, this.expectedModelId, this.now(), this.expectedReachabilityModelId);
    const side = forecast.exitPlan.side;
    if (this.state.slots[side].tracked || this.state.slots[side].intent) return { ...base, status: 'WAITING', reason: 'HEDGE_SIDE_ALREADY_OCCUPIED', side };
    return { ...await this.engines[side].preflight(), ...base, side };
  }

  async cycle() {
    if (!this.config.enabled) throw new Error('Live hedge order execution is disabled');
    const errors = [];
    for (const side of SIDES) {
      const slot = this.state.slots[side];
      if (!slot.tracked && !slot.intent) continue;
      try { await this.engines[side].cycle({ manageOnly: true }); }
      catch (error) {
        let message = String(error?.message || error).replace(/signature=[^&\s]+/g, 'signature=[redacted]');
        for (const value of [this.exchange.apiKey, this.exchange.secret]) if (value) message = message.split(value).join('[redacted]');
        errors.push({ side, message: message.slice(0, 300) });
      }
    }
    this.state.lastManagementErrors = errors; this.persist();
    const snapshot = await this.snapshot();
    this.engines.LONG.validateAccount(snapshot);
    const blocked = this.entryBlock(snapshot);
    if (blocked || errors.length) return { status: 'WAITING', reason: blocked || 'HEDGE_MANAGEMENT_ERROR', errors, openSides: this.state.openSides };
    if (this.state.initialWalletUsdt === null) {
      this.state.initialWalletUsdt = snapshot.walletUsdt;
      for (const side of SIDES) this.state.slots[side].initialWalletUsdt = snapshot.walletUsdt;
      this.persist();
    }
    let forecast;
    try { forecast = selectLiveForecast(this.readForecasts(), this.config, this.expectedModelId, this.now(), this.expectedReachabilityModelId); }
    catch (error) {
      if (error.code === 'EXIT_SETUP_REJECTED') return { status: 'WAITING', reason: error.reason, openSides: this.state.openSides };
      throw error;
    }
    const side = forecast.exitPlan.side, slot = this.state.slots[side];
    if (slot.tracked || slot.intent) return { status: 'WAITING', reason: 'HEDGE_SIDE_ALREADY_OCCUPIED', side, openSides: this.state.openSides };
    const result = await this.engines[side].cycle();
    this.persist();
    return { ...result, side, hedged: true, openSides: this.state.openSides };
  }
}

module.exports = { PredictiveHedgeEngine, hedgeState, loadHedgeState, sideExchange };
