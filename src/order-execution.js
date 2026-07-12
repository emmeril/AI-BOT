const ccxt = require('ccxt');
const {
  GRID_POST_ONLY,
  GRID_PRICE_PRECISION_MAX_DEVIATION_PCT
} = require('./config');
const { retry } = require('./utils');

function getPreciseOrderNumbers(symbol, price, amount) {
  const precisePrice = this.exchange.priceToPrecision(symbol, price);
  const preciseAmount = this.exchange.amountToPrecision(symbol, amount);
  const priceNum = Number(precisePrice);
  const amountNum = Number(preciseAmount);
  return {
    precisePrice,
    preciseAmount,
    priceNum,
    amountNum,
    notional: priceNum * amountNum,
  };
}

async function fetchContext(symbol) {
  const [ticker, openOrders, balance] = await Promise.all([
    retry(() => this.exchange.fetchTicker(symbol)),
    retry(() => this.exchange.fetchOpenOrders(symbol)),
    retry(() => this.exchange.fetchBalance()),
  ]);
  const currentPrice = Number(ticker.last);
  const { lower, upper, levels: advisedLevels } = await this.buildRange(symbol, currentPrice);
  const levels = advisedLevels || this.buildLevels(lower, upper, symbol);
  return { ticker, currentPrice, openOrders, balance, lower, upper, levels };
}

async function getManagedOpenOrders(symbol, openOrders) {
  const symState = this.state.getSymbol(symbol);
  const managedIds = new Set(Object.keys(symState.orders));
  const managed = [];
  for (const order of openOrders) {
    const orderId = String(order.id);
    const levelIndex = this.getBotOrderLevel(order);
    if (!managedIds.has(orderId) && levelIndex !== null) {
      await this.state.rememberOrder(symbol, order, { levelIndex });
      managedIds.add(orderId);
      console.warn(`[RECOVER] ${symbol} adopted order ${orderId} level=${levelIndex}`);
    }
    if (managedIds.has(orderId)) managed.push(order);
  }
  return managed;
}

function getOrderClientId(order) {
  return String(order.clientOrderId || order.info?.clientOrderId || order.info?.origClientOrderId || '');
}

function getBotOrderLevel(order) {
  const match = this.getOrderClientId(order).match(/^grid-[a-z0-9]+-[bs]-(\d+)-/);
  return match ? Number(match[1]) : null;
}

function makeClientOrderId(symbol, side, levelIndex) {
  const market = symbol.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `grid-${market}-${side[0]}-${levelIndex}-${nonce}`.slice(0, 36);
}

async function cancelGridOrders(symbol, reason) {
  const result = { cancelled: [], failed: [] };
  if (!this.exchange?.fetchOpenOrders || !this.exchange?.cancelOrder) return result;
  const openOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
  const managed = await this.getManagedOpenOrders(symbol, openOrders);
  for (const order of managed) {
    try {
      await retry(() => this.exchange.cancelOrder(order.id, symbol));
      await this.state.forgetOrder(symbol, order.id);
      result.cancelled.push(String(order.id));
      console.log(`[CANCEL] ${symbol} ${order.side} ${order.id} | ${reason}`);
    } catch (err) {
      result.failed.push({ id: String(order.id), error: err });
      console.warn(`[CANCEL] Failed to cancel ${symbol} order ${order.id}: ${err.message}`);
    }
  }
  return result;
}

async function cancelOrder(symbol, order, reason) {
  if (!this.exchange?.cancelOrder) return;
  await retry(() => this.exchange.cancelOrder(order.id, symbol));
  await this.state.forgetOrder(symbol, order.id);
  console.log(`[CANCEL] ${symbol} ${order.side} ${order.id} | ${reason}`);
}

async function createOrder(symbol, side, amount, price, levelIndex) {
  const clientOrderId = this.makeClientOrderId(symbol, side, levelIndex);
  const orderParams = { newClientOrderId: clientOrderId };
  if (GRID_POST_ONLY) {
    orderParams.postOnly = true;
  }
  return await this.exchange.createLimitOrder(
    symbol,
    side,
    amount,
    price,
    orderParams
  );
}

async function placeLimit(symbol, side, levelIndex, price, amount) {
  const pendingKey = `${symbol}|${side}|${levelIndex}`;
  if (this.pendingOrderLevels.has(pendingKey)) {
    console.warn(`[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} | placement already in progress`);
    return null;
  }

  this.pendingOrderLevels.add(pendingKey);
  try {
    const {
      precisePrice,
      preciseAmount,
      priceNum: preciseNum,
      amountNum: preciseAmountNum,
      notional,
    } = this.getPreciseOrderNumbers(symbol, price, amount);
    const priceDiffPct = Math.abs(preciseNum - Number(price)) / Number(price) * 100;
    if (priceDiffPct > GRID_PRICE_PRECISION_MAX_DEVIATION_PCT) {
      console.warn(
        `[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} price=${price} -> ${precisePrice} | precision adjustment too large (${priceDiffPct.toFixed(4)}%)`
      );
      return null;
    }

    if (side === 'sell') {
      const minCost = this.getMinCost(symbol);
      if (minCost > 0 && notional < minCost - 1e-8) {
        console.warn(`[SKIP] ${symbol} SELL level=${levelIndex} | notional ${notional.toFixed(8)} below min ${minCost}, skipping order (dust)`);
        return null;
      }
    }

    if (!(preciseAmountNum > 0) || !(preciseNum > 0)) {
      console.warn(`[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} | amount or price rounded to zero`);
      return null;
    }

    const order = await this.createOrder(symbol, side, preciseAmount, precisePrice, levelIndex);
    await this.state.rememberOrder(symbol, order, { levelIndex });
    console.log(`[GRID] ${symbol} ${side.toUpperCase()} level=${levelIndex} amount=${preciseAmount} price=${precisePrice}${GRID_POST_ONLY ? ' (postOnly)' : ''}`);
    return order;
  } catch (err) {
    if (this.isInsufficientFundsError(err)) {
      console.warn(
        `[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} amount=${amount} price=${price} | insufficient balance`
      );
      return null;
    }
    if (this.isInvalidOrderAmountError(err)) {
      console.warn(
        `[SKIP] ${symbol} ${side.toUpperCase()} level=${levelIndex} amount=${amount} | invalid order amount: ${err.message}`
      );
      return null;
    }
    throw err;
  } finally {
    this.pendingOrderLevels.delete(pendingKey);
  }
}

function isInsufficientFundsError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return err instanceof ccxt.InsufficientFunds ||
    err?.name === 'InsufficientFunds' ||
    message.includes('insufficient balance') ||
    message.includes('insufficient funds');
}

function isInvalidOrderAmountError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return err instanceof ccxt.InvalidOrder ||
    err?.name === 'InvalidOrder' ||
    (message.includes('amount') && (
      message.includes('minimum amount') ||
      message.includes('precision') ||
      message.includes('must be greater')
    ));
}


const orderExecutionMethods = {
  getPreciseOrderNumbers,
  fetchContext,
  getManagedOpenOrders,
  getOrderClientId,
  getBotOrderLevel,
  makeClientOrderId,
  cancelGridOrders,
  cancelOrder,
  createOrder,
  placeLimit,
  isInsufficientFundsError,
  isInvalidOrderAmountError,
};

function applyOrderExecutionMethods(target) {
  Object.assign(target.prototype, orderExecutionMethods);
}

module.exports = {
  applyOrderExecutionMethods,
  orderExecutionMethods,
};
