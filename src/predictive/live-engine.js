'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { asBoolean, selectLiveForecast, candidateEvidence, openPositions, positionAmount, algoOrders,
  ownedAlgo, insideProtection, buildEntryPlan, protectionParameters, protectionMatches, positionDirectionReview } = require('./live-policy');
const { validateDirectionModel } = require('./direction-model');
const { RISK_POLICY_ID } = require('./net-risk-reward');
const { ADAPTIVE_KIND, validateReachability, planReachableTargets } = require('./reachability');
const { ADAPTIVE_POLICY_ID } = require('./adaptive-exits');
const { assessAiReview } = require('./ai-review-policy');
const { loadAiReviewState } = require('./ai-review-service');

const TERMINAL_ORDER_STATUSES = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH']);

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
  constructor({ config, exchange, state, save, readForecasts, readAiReviews, now = Date.now }) {
    this.config = config;
    this.exchange = exchange;
    this.state = state || loadLiveState(config.stateFile);
    this.save = save || (() => saveLiveState(config.stateFile, this.state));
    this.readForecasts = readForecasts || (() => JSON.parse(fs.readFileSync(config.forecastFile)));
    this.readAiReviews = readAiReviews || (() => loadAiReviewState(config.aiReview.stateFile));
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

  async positionSnapshot() {
    const rows = await this.exchange.fapiPrivateV3GetPositionRisk({ symbol: this.config.symbol });
    return { positions: openPositions(rows) };
  }

  reviewEntry(forecast) {
    let state;
    if (this.config.aiReview.enabled) {
      try { state = this.readAiReviews(); }
      catch { state = null; }
    }
    return assessAiReview(forecast, state, this.config.aiReview, this.now());
  }

  assertEntryReview(plan) {
    if (!this.config.aiReview.enabled) return;
    if (!Number.isFinite(plan.quoteTime) || plan.quoteTime > this.now() + 2000 || this.now() - plan.quoteTime > 10000) {
      throw new Error('Entry quote expired before submission');
    }
    const forecast = selectLiveForecast(this.readForecasts(), this.config, this.expectedModelId,
      this.now(), this.expectedReachabilityModelId);
    const review = this.reviewEntry(forecast);
    if (forecast.id !== plan.forecastId || review.approved !== true ||
        (this.config.aiReview.failureMode !== 'PRIMARY_FALLBACK' && plan.aiReview?.reviewId !== review.reviewId) ||
        plan.aiReview?.candidateFingerprint !== review.candidateFingerprint) {
      throw new Error('Entry AI approval changed or expired: ' + review.reason);
    }
    plan.aiReview = review;
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
    const aiReview = this.reviewEntry(forecast);
    const plan = buildEntryPlan(this.config, forecast, snapshot.market, snapshot.book, snapshot.availableUsdt,
      snapshot.hedgeMode, this.now(), this.reachabilityModel);
    return { status: !evidence.matchesUserCriteria ? 'BLOCKED_BY_FORWARD_RESULTS' :
      !aiReview.approved ? 'BLOCKED_BY_AI_REVIEW' : 'CONFIGURATION_VERIFIED_READ_ONLY',
      orderExecutionEnabled: false,
      positionExitPolicy: this.config.positionExitPolicy,
      timeBasedPositionExit: this.config.positionExitPolicy === 'HORIZON',
      availableUsdt: snapshot.availableUsdt, walletUsdt: snapshot.walletUsdt,
      currentLeverage: Number(snapshot.settings.leverage), requestedLeverage: this.config.leverage,
      currentMarginType: snapshot.settings.marginType, requestedMarginType: 'ISOLATED',
      hedgeMode: snapshot.hedgeMode, maxOpenPositions: 1, sessionLossBudgetUsdt: this.config.sessionLossBudgetUsdt,
      directionModelId: this.expectedModelId, reachabilityModelId: this.expectedReachabilityModelId, evidence, aiReview, plan };
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
    const rawQuantity = order?.executedQty;
    const quantity = ['string', 'number'].includes(typeof rawQuantity) && String(rawQuantity).trim()
      ? Number(rawQuantity) : NaN;
    const reportedPrice = Number(order?.avgPrice), cumulativeQuote = Number(order?.cumQuote);
    const entryPrice = Number.isFinite(reportedPrice) && reportedPrice > 0 ? reportedPrice :
      Number.isFinite(cumulativeQuote) && cumulativeQuote > 0 && quantity > 0 ? cumulativeQuote / quantity : NaN;
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
      const tracked = this.state.tracked;
      if (tracked && (tracked.plan.entryClientId !== plan.entryClientId || tracked.orderId !== String(order.orderId))) {
        throw new Error('Entry fill does not match the owned order');
      }
      if (tracked && quantity < tracked.quantity) throw new Error('Entry cumulative fill decreased');
      if (tracked) Object.assign(tracked, { entryPrice, quantity });
      else this.state.tracked = { plan, enteredAt: this.now(), orderId: String(order.orderId),
        closeAttempts: 0, positionSeen: false, flatChecks: 0, entryPrice, quantity };
      if (TERMINAL_ORDER_STATUSES.has(order.status)) {
        this.state.intent = null;
        if (this.state.pausedReason === 'ENTRY_SUBMISSION_UNCERTAIN') this.state.pausedReason = null;
      }
      this.save();
      return true;
    }
    if (TERMINAL_ORDER_STATUSES.has(order?.status) && order.status !== 'FILLED' && quantity === 0) {
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
      if (!this.state.pausedReason) this.state.pausedReason = 'ENTRY_SUBMISSION_UNCERTAIN';
      this.save();
      throw new Error('Entry outcome unresolved; no new entry will be submitted: ' + error.message);
    }
  }

  async enter(plan) {
    this.assertEnabled();
    this.assertEntryReview(plan);
    const previouslyConsumed = this.state.consumedForecastId;
    this.state.consumedForecastId = plan.forecastId;
    this.state.intent = { plan, submittedAt: this.now() };
    this.save();
    try { this.assertEntryReview(plan); }
    catch (error) {
      this.state.intent = null;
      this.state.consumedForecastId = previouslyConsumed;
      this.save();
      throw error;
    }
    let needsReconciliation = false;
    try {
      const order = await this.exchange.fapiPrivatePostOrder({ symbol: plan.symbol, side: plan.orderSide,
        positionSide: plan.positionSide, type: 'MARKET', quantity: plan.quantity,
        newClientOrderId: plan.entryClientId, newOrderRespType: 'RESULT' });
      needsReconciliation = !this.recordFill(order, plan);
    } catch (error) {
      if (!this.state.pausedReason) this.state.pausedReason = 'ENTRY_SUBMISSION_UNCERTAIN';
      this.save();
      await this.resolveIntent();
    }
    if (needsReconciliation && this.state.intent) await this.resolveIntent();
    if (this.state.tracked) {
      await this.ensureProtection({});
      if (this.state.tracked && !this.state.tracked.closing) await this.manageTrackedPosition();
    }
  }

  async ensureProtection(snapshot) {
    this.assertEnabled();
    const tracked = this.state.tracked, plan = tracked.plan;
    try {
      if (plan.riskPolicyId === this.config.riskPolicyId &&
          plan.reachabilityModelId === this.expectedReachabilityModelId) {
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
      const algorithms = snapshot.algorithms ?? algoOrders(await this.exchange.fapiPrivateGetOpenAlgoOrders({ symbol: plan.symbol }));
      for (const kind of ['SL', 'TP']) {
        const clientId = kind === 'SL' ? plan.stopClientId : plan.takeClientId;
        const existing = algorithms.find(row => row.clientAlgoId === clientId);
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

  recordCloseOrder(order) {
    const tracked = this.state.tracked, closing = tracked.closing;
    const rawQuantity = order?.executedQty;
    const executedQty = ['string', 'number'].includes(typeof rawQuantity) && String(rawQuantity).trim()
      ? Number(rawQuantity) : NaN;
    if (!['NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL', ...TERMINAL_ORDER_STATUSES].includes(order?.status) ||
        !Number.isFinite(executedQty) || executedQty < 0 ||
        (order.clientOrderId && order.clientOrderId !== closing.clientOrderId)) {
      throw new Error('Invalid close order response');
    }
    closing.status = order.status;
    closing.executedQty = executedQty;
    closing.orderId = order.orderId == null ? null : String(order.orderId);
    if (order.status === 'FILLED' && executedQty >= closing.quantity - 1e-8) tracked.closeConfirmed = true;
    if (TERMINAL_ORDER_STATUSES.has(order.status) && this.state.pausedReason === 'CLOSE_SUBMISSION_UNCERTAIN') {
      this.state.pausedReason = null;
    }
    this.save();
  }

  async resolveCloseIntent() {
    const tracked = this.state.tracked;
    try {
      const order = await this.exchange.fapiPrivateGetOrder({ symbol: tracked.plan.symbol,
        origClientOrderId: tracked.closing.clientOrderId });
      this.recordCloseOrder(order);
    } catch (error) {
      if (!this.state.pausedReason) this.state.pausedReason = 'CLOSE_SUBMISSION_UNCERTAIN';
      this.save();
      throw new Error('Close outcome unresolved; no duplicate close will be submitted: ' + error.message);
    }
  }

  async close(reason) {
    this.assertEnabled();
    const tracked = this.state.tracked;
    if (!tracked) return;
    if (this.state.intent) {
      const intent = this.state.intent;
      if (intent.plan.entryClientId !== tracked.plan.entryClientId) throw new Error('Pending entry has a different owner');
      try {
        const order = await this.exchange.fapiPrivateDeleteOrder({ symbol: tracked.plan.symbol,
          origClientOrderId: intent.plan.entryClientId });
        this.recordFill(order, intent.plan);
      } catch {
        await this.resolveIntent();
      }
      if (this.state.intent) {
        if (!this.state.pausedReason) this.state.pausedReason = 'ENTRY_SUBMISSION_UNCERTAIN';
        this.save();
        throw new Error('Pending entry cancellation is unresolved; protection remains active');
      }
    }
    const snapshot = await this.positionSnapshot();
    const position = this.positionFor(snapshot, tracked.plan);
    const plan = tracked.plan;
    if (position) { tracked.positionSeen = true; tracked.flatChecks = 0; }
    if (tracked.closing && !tracked.closing.clientOrderId) {
      tracked.closing.clientOrderId = `p60-x-${plan.token}-${Math.max(0, tracked.closeAttempts - 1)}`.slice(0, 36);
      tracked.closing.quantity = tracked.quantity;
      this.save();
    }
    const closing = tracked.closing;
    if (closing && (!TERMINAL_ORDER_STATUSES.has(closing.status) ||
        (closing.status === 'FILLED' && !(Number.isFinite(closing.executedQty) &&
          closing.executedQty >= closing.quantity - 1e-8)))) await this.resolveCloseIntent();
    if (!position && (tracked.positionSeen || tracked.closeConfirmed || this.now() - tracked.enteredAt >= 15000)) {
      await this.confirmFlat(snapshot, reason); return;
    }
    if (tracked.closing && (tracked.closing.status === 'FILLED' || !TERMINAL_ORDER_STATUSES.has(tracked.closing.status))) return;
    if (position && positionAmount(position) > tracked.quantity + 1e-8) {
      this.state.pausedReason = 'POSITION_OWNERSHIP_CHANGED'; this.save();
      throw new Error('DOGE position size changed externally; no additional close submitted');
    }
    const attempt = tracked.closeAttempts++;
    const params = { symbol: plan.symbol, side: plan.side === 'LONG' ? 'SELL' : 'BUY',
      positionSide: plan.positionSide, type: 'MARKET', quantity: position ? positionAmount(position) : tracked.quantity,
      newClientOrderId: `p60-x-${plan.token}-${attempt}`.slice(0, 36), newOrderRespType: 'RESULT' };
    if (plan.positionSide === 'BOTH') params.reduceOnly = 'true';
    tracked.closing = { reason: tracked.closing?.reason || reason, submittedAt: this.now(),
      clientOrderId: params.newClientOrderId, quantity: params.quantity };
    this.save();
    try {
      const order = await this.exchange.fapiPrivatePostOrder(params);
      this.recordCloseOrder(order);
    }
    catch (error) {
      const rejectionCode = Number(error.code ?? String(error.message).match(/"code"\s*:\s*(-\d+)/)?.[1]);
      if ([-2022, -2024].includes(rejectionCode)) {
        tracked.closing.status = 'REJECTED';
        tracked.closing.rejectionCode = rejectionCode;
        this.save();
      } else await this.resolveCloseIntent();
    }
    const after = await this.positionSnapshot();
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
    const algorithms = snapshot.algorithms ?? algoOrders(await this.exchange.fapiPrivateGetOpenAlgoOrders({ symbol: this.config.symbol }));
    await this.cancelOwnedOrders(algorithms);
    let walletUsdt = Number.isFinite(snapshot.walletUsdt) ? snapshot.walletUsdt : null;
    if (walletUsdt === null) {
      try {
        const account = await this.exchange.fapiPrivateV3GetAccount();
        const value = Number(account.assets?.find(row => row.asset === 'USDT')?.walletBalance ?? account.totalWalletBalance);
        if (Number.isFinite(value)) walletUsdt = value;
      } catch {}
    }
    const tracked = this.state.tracked;
    this.state.closed.push({ forecastId: tracked?.plan.forecastId || null,
      entryOrderId: tracked?.orderId || null, entryPrice: tracked?.entryPrice || null,
      quantity: tracked?.quantity || null, side: tracked?.plan.side || null,
      takeProfit: tracked?.plan.takeProfit || null, stopLoss: tracked?.plan.stopLoss || null,
      positionExitPolicy: this.config.positionExitPolicy, directionReview: tracked?.directionReview || null,
      closedAt: this.now(), reason, walletUsdt });
    this.state.closed = this.state.closed.slice(-1000);
    this.state.tracked = null; this.save();
  }

  async manageTrackedPosition() {
    let snapshot;
    try { snapshot = await this.positionSnapshot(); }
    catch (error) {
      if (this.state.tracked && !this.state.tracked.closing) await this.ensureProtection({});
      throw error;
    }
    if (this.state.tracked) await this.manage(snapshot);
  }

  async manage(snapshot) {
    const tracked = this.state.tracked;
    if (tracked.closing) { await this.close(tracked.closing.reason); return; }
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
    if (this.config.positionExitPolicy === 'HORIZON') {
      if (this.now() >= tracked.plan.expiresAt) { await this.close('HORIZON_EXPIRED'); return; }
    } else {
      let review;
      try { review = positionDirectionReview(this.readForecasts(), this.config, tracked.plan, this.expectedModelId, this.now()); }
      catch { review = { close: false, reason: 'PREDICTION_UNAVAILABLE', forecastId: null, direction: null }; }
      if (tracked.directionReview?.forecastId !== review.forecastId || tracked.directionReview?.reason !== review.reason ||
          tracked.directionReview?.direction !== review.direction) {
        tracked.directionReview = { ...review, checkedAt: this.now() };
        this.save();
      }
      if (review.close) { await this.close('PREDICTION_REVERSED'); return; }
    }
    await this.ensureProtection(snapshot);
  }

  async cycle() {
    this.assertEnabled();
    if (this.state.intent) {
      try { await this.resolveIntent(); }
      catch (error) {
        if (this.state.tracked) await this.manageTrackedPosition();
        throw error;
      }
      if (this.state.intent && !this.state.tracked) return { status: 'ENTRY_PENDING', forecastId: this.state.intent.plan.forecastId };
    }
    if (this.state.tracked) {
      await this.manageTrackedPosition();
      return this.state.intent ? { status: 'ENTRY_PENDING', forecastId: this.state.intent.plan.forecastId } : undefined;
    }
    const snapshot = await this.snapshot();
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
    const aiReview = this.reviewEntry(forecast);
    if (!aiReview.approved) return { status: 'WAITING', reason: aiReview.reason, aiReview, evidence };
    const plan = buildEntryPlan(this.config, forecast, snapshot.market, snapshot.book, snapshot.availableUsdt,
      snapshot.hedgeMode, this.now(), this.reachabilityModel);
    if (aiReview.enabled) plan.aiReview = aiReview;
    await this.enter(plan);
    return { status: this.state.tracked ? 'POSITION_OPEN' : this.state.intent ? 'ENTRY_PENDING' : 'FLAT',
      aiReview: plan.aiReview || aiReview };
  }
}

module.exports = { PredictiveLiveEngine, loadLiveState, saveLiveState };
