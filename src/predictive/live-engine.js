'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { asBoolean, selectLiveForecast, candidateEvidence, openPositions, positionAmount, algoOrders,
  ownedAlgo, insideProtection, buildEntryPlan, protectionParameters, protectionMatches } = require('./live-policy');
const { validateDirectionModel } = require('./direction-model');
const { RISK_POLICY_ID } = require('./net-risk-reward');
const { ADAPTIVE_KIND, validateReachability, planReachableTargets } = require('./reachability');
const { ADAPTIVE_POLICY_ID } = require('./adaptive-exits');

function loadLiveState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file));
    if (state.version !== 1 || state.symbol !== 'DOGEUSDT' || state.horizon !== 60) throw new Error('Incompatible live runtime state');
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, symbol: 'DOGEUSDT', horizon: 60, consumedForecastId: null,
      intent: null, tracked: null, pausedReason: null, initialWalletUsdt: null, closed: [] };
  }
}

function saveLiveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

class PredictiveLiveEngine {
  constructor({ config, exchange, state, save, readForecasts, now = Date.now }) {
    this.config = config;
    this.exchange = exchange;
    this.state = state || loadLiveState(config.stateFile);
    this.save = save || (() => saveLiveState(config.stateFile, this.state));
    this.readForecasts = readForecasts || (() => JSON.parse(fs.readFileSync(config.forecastFile)));
    this.now = now;
    const model = JSON.parse(fs.readFileSync(config.modelFile));
    validateDirectionModel(model, config.symbol);
    if (model.horizon !== config.horizon || !model.modelId) throw new Error('Selected live model must be the current 60 minute direction model');
    this.expectedModelId = model.modelId;
    const exitModel = JSON.parse(fs.readFileSync(config.exitModelFile));
    const reachability = validateReachability(JSON.parse(fs.readFileSync(config.reachabilityModelFile)),
      config.symbol, model.modelId, exitModel.modelId);
    if (reachability.horizon !== config.horizon) throw new Error('Live reachability horizon mismatch');
    if ((reachability.kind === ADAPTIVE_KIND ? ADAPTIVE_POLICY_ID : RISK_POLICY_ID) !== config.riskPolicyId) {
      throw new Error('Live exit policy does not match the model');
    }
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(config.modelFile)).digest('hex');
    const stopHash = crypto.createHash('sha256').update(fs.readFileSync(config.exitModelFile)).digest('hex');
    if (reachability.directionModelHash !== sourceHash || reachability.exitModelHash !== stopHash) {
      throw new Error('Reachability upstream model hash mismatch');
    }
    this.reachabilityModel = reachability;
    this.expectedReachabilityModelId = reachability.modelId;
    this.market = null;
  }

  assertEnabled() {
    if (this.config.enabled !== true) throw new Error('Live order execution is disabled; use read-only preflight');
  }

  async snapshot() {
    const e = this.exchange, symbol = this.config.symbol;
    if (!this.market) {
      const info = await e.fapiPublicGetExchangeInfo();
      this.market = info.symbols?.find(row => row.symbol === symbol);
      if (!this.market) throw new Error('DOGEUSDT market metadata unavailable');
    }
    const [account, accountConfig, positions, orders, algorithms, symbolConfig, book] = await Promise.all([
      e.fapiPrivateV3GetAccount(), e.fapiPrivateGetAccountConfig(),
      e.fapiPrivateV3GetPositionRisk({ symbol }), e.fapiPrivateGetOpenOrders({ symbol }),
      e.fapiPrivateGetOpenAlgoOrders({ symbol }), e.fapiPrivateGetSymbolConfig({ symbol }),
      e.fapiPublicGetTickerBookTicker({ symbol }),
    ]);
    if (!Array.isArray(orders) || !Array.isArray(symbolConfig)) throw new Error('Invalid account/order snapshot');
    const settings = symbolConfig.find(row => row.symbol === symbol);
    if (!settings) throw new Error('Missing DOGE account configuration');
    const usdt = account.assets?.find(row => row.asset === 'USDT');
    return { account, accountConfig, positions: openPositions(positions), orders,
      algorithms: algoOrders(algorithms), settings, book, market: this.market,
      availableUsdt: Number(usdt?.availableBalance ?? account.availableBalance),
      walletUsdt: Number(usdt?.walletBalance ?? account.totalWalletBalance),
      hedgeMode: asBoolean(accountConfig.dualSidePosition) };
  }

  validateAccount(snapshot) {
    if (!asBoolean(snapshot.accountConfig.canTrade)) throw new Error('Futures trading permission is unavailable');
    if (asBoolean(snapshot.accountConfig.multiAssetsMargin)) throw new Error('This profile requires single-asset isolated margin');
    if (asBoolean(snapshot.settings.isAutoAddMargin)) throw new Error('Disable DOGE auto-add margin before using the fixed margin profile');
    if (![snapshot.availableUsdt, snapshot.walletUsdt].every(Number.isFinite)) throw new Error('Invalid account balances');
  }

  async preflight() {
    const snapshot = await this.snapshot();
    this.validateAccount(snapshot);
    if (snapshot.positions.length || snapshot.orders.length || snapshot.algorithms.length) {
      throw new Error('DOGE must be flat with no regular or conditional orders before new activation');
    }
    const source = this.readForecasts();
    const evidence = candidateEvidence(source, this.config, this.expectedModelId, this.expectedReachabilityModelId);
    const forecast = selectLiveForecast(source, this.config, this.expectedModelId, this.now(), this.expectedReachabilityModelId);
    const plan = buildEntryPlan(this.config, forecast, snapshot.market, snapshot.book, snapshot.availableUsdt,
      snapshot.hedgeMode, this.now(), this.reachabilityModel);
    return { status: evidence.matchesUserCriteria ? 'CONFIGURATION_VERIFIED_READ_ONLY' : 'BLOCKED_BY_FORWARD_RESULTS',
      orderExecutionEnabled: false,
      availableUsdt: snapshot.availableUsdt, walletUsdt: snapshot.walletUsdt,
      currentLeverage: Number(snapshot.settings.leverage), requestedLeverage: this.config.leverage,
      currentMarginType: snapshot.settings.marginType, requestedMarginType: 'ISOLATED',
      hedgeMode: snapshot.hedgeMode, maxOpenPositions: 1, sessionLossBudgetUsdt: this.config.sessionLossBudgetUsdt,
      directionModelId: this.expectedModelId, reachabilityModelId: this.expectedReachabilityModelId, evidence, plan };
  }

  async configureAccount() {
    this.assertEnabled();
    const snapshot = await this.snapshot();
    this.validateAccount(snapshot);
    if (snapshot.positions.length || snapshot.orders.length || snapshot.algorithms.length) throw new Error('Cannot reconfigure DOGE while positions or orders exist');
    if (String(snapshot.settings.marginType).toUpperCase() !== 'ISOLATED') {
      await this.exchange.fapiPrivatePostMarginType({ symbol: this.config.symbol, marginType: 'ISOLATED' });
    }
    await this.exchange.fapiPrivatePostLeverage({ symbol: this.config.symbol, leverage: this.config.leverage });
    const verified = await this.snapshot();
    if (Number(verified.settings.leverage) !== this.config.leverage || String(verified.settings.marginType).toUpperCase() !== 'ISOLATED') {
      throw new Error('Could not verify isolated 10x DOGE configuration');
    }
    if (this.state.initialWalletUsdt === null) this.state.initialWalletUsdt = verified.walletUsdt;
    this.save();
  }

  positionFor(snapshot, plan) {
    return snapshot.positions.find(row => row.symbol === plan.symbol && row.positionSide === plan.positionSide);
  }

  async cancelOwnedOrders(orders) {
    this.assertEnabled();
    for (const order of orders.filter(ownedAlgo)) {
      await this.exchange.fapiPrivateDeleteAlgoOrder({ symbol: this.config.symbol, algoId: order.algoId });
    }
  }

  recordFill(order, plan) {
    if (Number(order.executedQty) > 0 && Number(order.avgPrice) > 0) {
      this.state.tracked = { plan, enteredAt: this.now(), orderId: String(order.orderId),
        entryPrice: Number(order.avgPrice), quantity: Number(order.executedQty), closeAttempts: 0,
        positionSeen: false, flatChecks: 0 };
      this.state.intent = null;
      this.save();
      return true;
    }
    if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(order.status)) {
      this.state.intent = null; this.state.pausedReason = 'ENTRY_REJECTED'; this.save();
    }
    return false;
  }

  async resolveIntent() {
    this.assertEnabled();
    const intent = this.state.intent;
    if (!intent) return;
    try {
      const order = await this.exchange.fapiPrivateGetOrder({ symbol: this.config.symbol,
        origClientOrderId: intent.plan.entryClientId });
      this.recordFill(order, intent.plan);
    } catch (error) {
      this.state.pausedReason = 'ENTRY_SUBMISSION_UNCERTAIN';
      this.save();
      throw new Error('Entry outcome unresolved; no new entry will be submitted: ' + error.message);
    }
  }

  async enter(plan) {
    this.assertEnabled();
    this.state.consumedForecastId = plan.forecastId;
    this.state.intent = { plan, submittedAt: this.now() };
    this.save();
    try {
      const order = await this.exchange.fapiPrivatePostOrder({ symbol: plan.symbol, side: plan.orderSide,
        positionSide: plan.positionSide, type: 'MARKET', quantity: plan.quantity,
        newClientOrderId: plan.entryClientId, newOrderRespType: 'RESULT' });
      this.recordFill(order, plan);
    } catch (error) {
      this.state.pausedReason = 'ENTRY_SUBMISSION_UNCERTAIN'; this.save();
      await this.resolveIntent();
    }
    if (this.state.tracked) {
      await this.ensureProtection(await this.snapshot());
      if (this.state.tracked && !this.state.tracked.closing) await this.manage(await this.snapshot());
    }
  }

  async ensureProtection(snapshot) {
    this.assertEnabled();
    const tracked = this.state.tracked, plan = tracked.plan;
    if (plan.riskPolicyId === this.config.riskPolicyId) {
      const risk = planReachableTargets(this.reachabilityModel, plan.contextFeatures, plan.directionProbabilities,
        { side: plan.side, entryFill: tracked.entryPrice, stopLoss: plan.stopLoss, tickSize: plan.tick,
        costAssumptions: plan.costAssumptions });
      if (risk.status !== 'ESTIMATED') {
        await this.close(plan.riskPolicyId === ADAPTIVE_POLICY_ID ?
          'FILLED_ENTRY_NON_POSITIVE_EXPECTED_NET' : 'FILLED_ENTRY_TP1_BEFORE_SL_NOT_SUPPORTED');
        return;
      }
      const targetChanged = plan.takeProfit !== risk.takeProfit || plan.selectedTarget !== risk.selectedTarget;
      Object.assign(plan, risk);
      if (targetChanged) this.save();
    }
    if (!insideProtection(tracked.entryPrice, plan.side, plan) ||
        tracked.quantity * tracked.entryPrice > this.config.notionalUsdt + 1e-8) {
      await this.close('FILLED_ENTRY_OUTSIDE_BUDGET_OR_PROTECTION');
      return;
    }
    try {
      for (const kind of ['SL', 'TP']) {
        const clientId = kind === 'SL' ? plan.stopClientId : plan.takeClientId;
        const existing = snapshot.algorithms.find(row => row.clientAlgoId === clientId);
        if (existing && protectionMatches(existing, plan, kind)) continue;
        if (existing) await this.exchange.fapiPrivateDeleteAlgoOrder({ symbol: plan.symbol, algoId: existing.algoId });
        try { await this.exchange.fapiPrivatePostAlgoOrder(protectionParameters(plan, kind)); }
        catch (error) {
          const observed = algoOrders(await this.exchange.fapiPrivateGetOpenAlgoOrders({ symbol: plan.symbol }));
          if (!observed.some(row => protectionMatches(row, plan, kind))) throw error;
        }
      }
      const verified = algoOrders(await this.exchange.fapiPrivateGetOpenAlgoOrders({ symbol: plan.symbol }));
      if (!['SL', 'TP'].every(kind => verified.some(row => protectionMatches(row, plan, kind)))) {
        throw new Error('Exchange has not confirmed both protective orders');
      }
      tracked.protectedAt = this.now(); this.save();
    } catch (error) {
      this.state.pausedReason = 'PROTECTION_FAILURE'; this.save();
      await this.close('PROTECTION_FAILURE');
      throw error;
    }
  }

  async close(reason) {
    this.assertEnabled();
    const tracked = this.state.tracked;
    if (!tracked) return;
    const snapshot = await this.snapshot();
    const position = this.positionFor(snapshot, tracked.plan);
    if (!position && (tracked.positionSeen || this.now() - tracked.enteredAt >= 15000)) {
      await this.confirmFlat(snapshot, reason); return;
    }
    const plan = tracked.plan;
    const attempt = tracked.closeAttempts++;
    tracked.closing = { reason, submittedAt: this.now() }; this.save();
    const params = { symbol: plan.symbol, side: plan.side === 'LONG' ? 'SELL' : 'BUY',
      positionSide: plan.positionSide, type: 'MARKET', quantity: position ? positionAmount(position) : tracked.quantity,
      newClientOrderId: `p60-x-${plan.token}-${attempt}`.slice(0, 36), newOrderRespType: 'RESULT' };
    if (plan.positionSide === 'BOTH') params.reduceOnly = 'true';
    try {
      const order = await this.exchange.fapiPrivatePostOrder(params);
      if (order.status === 'FILLED' && Number(order.executedQty) >= Number(params.quantity) - 1e-8) {
        tracked.closeConfirmed = true; this.save();
      }
    }
    catch (error) {
      if (this.positionFor(await this.snapshot(), plan)) throw error;
    }
    const after = await this.snapshot();
    if (!this.positionFor(after, plan)) await this.confirmFlat(after, reason);
  }

  async confirmFlat(snapshot, reason) {
    const tracked = this.state.tracked;
    if (!tracked) return;
    tracked.flatChecks = (tracked.flatChecks || 0) + 1;
    if (!tracked.positionSeen && !tracked.closeConfirmed && this.now() - tracked.enteredAt >= 15000) {
      this.state.pausedReason = 'FILLED_POSITION_NEVER_OBSERVED';
    }
    this.save();
    if (tracked.flatChecks < 2 || (!tracked.positionSeen && !tracked.closeConfirmed)) return;
    await this.finalizeFlat(snapshot, reason);
  }

  async finalizeFlat(snapshot, reason = 'EXCHANGE_POSITION_CLOSED') {
    this.assertEnabled();
    await this.cancelOwnedOrders(snapshot.algorithms);
    const tracked = this.state.tracked;
    this.state.closed.push({ forecastId: tracked?.plan.forecastId || null,
      entryOrderId: tracked?.orderId || null, entryPrice: tracked?.entryPrice || null,
      quantity: tracked?.quantity || null, side: tracked?.plan.side || null,
      takeProfit: tracked?.plan.takeProfit || null, stopLoss: tracked?.plan.stopLoss || null,
      closedAt: this.now(), reason, walletUsdt: snapshot.walletUsdt });
    this.state.closed = this.state.closed.slice(-1000);
    this.state.tracked = null; this.save();
  }

  async manage(snapshot) {
    const tracked = this.state.tracked;
    const position = this.positionFor(snapshot, tracked.plan);
    if (!position) {
      if (!tracked.protectedAt && !tracked.closing) await this.ensureProtection(snapshot);
      await this.confirmFlat(snapshot, tracked.closing?.reason);
      return;
    }
    tracked.positionSeen = true; tracked.flatChecks = 0;
    if (snapshot.positions.length !== 1 || Math.abs(positionAmount(position) - tracked.quantity) > 1e-8) {
      this.state.pausedReason = 'POSITION_OWNERSHIP_CHANGED'; this.save();
      throw new Error('DOGE position size changed externally; new entries paused');
    }
    if (tracked.closing || this.now() >= tracked.plan.expiresAt) { await this.close(tracked.closing?.reason || 'HORIZON_EXPIRED'); return; }
    await this.ensureProtection(snapshot);
  }

  async cycle() {
    this.assertEnabled();
    if (this.state.intent) await this.resolveIntent();
    const snapshot = await this.snapshot();
    if (this.state.tracked) { await this.manage(snapshot); return; }
    this.validateAccount(snapshot);
    if (this.state.pausedReason) return { status: 'PAUSED', reason: this.state.pausedReason };
    if (snapshot.positions.length || snapshot.orders.length || snapshot.algorithms.length) {
      return { status: 'WAITING', reason: 'DOGE_POSITION_OR_ORDER_ALREADY_EXISTS' };
    }
    if (Number(snapshot.settings.leverage) !== this.config.leverage || String(snapshot.settings.marginType).toUpperCase() !== 'ISOLATED') {
      throw new Error('DOGE leverage or margin mode changed; entry blocked');
    }
    if (this.state.initialWalletUsdt === null) throw new Error('Live session has not been initialized');
    if (this.state.initialWalletUsdt - snapshot.walletUsdt >= this.config.sessionLossBudgetUsdt) {
      this.state.pausedReason = 'SESSION_LOSS_BUDGET_REACHED'; this.save(); return;
    }
    const source = this.readForecasts();
    const evidence = candidateEvidence(source, this.config, this.expectedModelId, this.expectedReachabilityModelId);
    if (!evidence.matchesUserCriteria) return { status: 'WAITING', reason: 'FORWARD_CRITERIA_NOT_MET', evidence };
    let forecast;
    try {
      forecast = selectLiveForecast(source, this.config, this.expectedModelId, this.now(), this.expectedReachabilityModelId);
    } catch (error) {
      if (error.code === 'EXIT_SETUP_REJECTED') return { status: 'WAITING', reason: error.reason, evidence };
      throw error;
    }
    if (forecast.id === this.state.consumedForecastId) return { status: 'WAITING', reason: 'FORECAST_ALREADY_CONSUMED' };
    const plan = buildEntryPlan(this.config, forecast, snapshot.market, snapshot.book, snapshot.availableUsdt,
      snapshot.hedgeMode, this.now(), this.reachabilityModel);
    await this.enter(plan);
    return { status: this.state.tracked ? 'POSITION_OPEN' : this.state.intent ? 'ENTRY_PENDING' : 'FLAT' };
  }
}

module.exports = { PredictiveLiveEngine, loadLiveState, saveLiveState };
