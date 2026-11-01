'use strict';

const { booleanValue } = require('./environment');

function normalizeAlgoOrders(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.orders)) return response.orders;
  return [];
}

function algoClientId(order) {
  return String(order?.clientAlgoId || order?.clientOrderId || order?.info?.clientAlgoId || '');
}

function algoPositionSide(order) {
  const explicit = String(order?.positionSide || order?.info?.positionSide || '').toUpperCase();
  if (explicit === 'LONG' || explicit === 'SHORT') return explicit;
  const clientId = algoClientId(order);
  if (clientId.startsWith('scalp-l-')) return 'LONG';
  if (clientId.startsWith('scalp-s-')) return 'SHORT';
  return null;
}

function algoKind(order) {
  const type = String(order?.orderType || order?.type || order?.info?.orderType || '').toUpperCase();
  const clientId = algoClientId(order);
  if (type.includes('TAKE_PROFIT') || clientId.includes('-tp-')) return 'TAKE_PROFIT';
  if (type.includes('STOP') || clientId.includes('-sl-')) return 'STOP_LOSS';
  return type || 'CONDITIONAL';
}

function algoTriggerPrice(order) {
  const value = Number(order?.triggerPrice ?? order?.stopPrice ?? order?.info?.triggerPrice ?? order?.info?.stopPrice);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function scalperOrdersForSide(response, side = null) {
  const orders = normalizeAlgoOrders(response)
    .filter(order => algoClientId(order).startsWith('scalp-'));
  if (!side) return orders;
  const expectedSide = String(side).toUpperCase();
  return orders.filter(order => algoPositionSide(order) === expectedSide);
}

function scalperProtectionSnapshot(response, side, hasOpenPosition) {
  const expectedSide = String(side || '').toUpperCase();
  const orders = scalperOrdersForSide(response, expectedSide).map(order => ({
    id: String(order.algoId || order.id || ''),
    clientId: algoClientId(order),
    positionSide: expectedSide,
    side: String(order.side || order.info?.side || '').toLowerCase(),
    kind: algoKind(order),
    triggerPrice: algoTriggerPrice(order),
    closePosition: booleanValue(order.closePosition ?? order.info?.closePosition, false),
  }));
  const takeProfit = orders.find(order => order.kind === 'TAKE_PROFIT') || null;
  const stopLoss = orders.find(order => order.kind === 'STOP_LOSS') || null;
  const covered = Boolean(hasOpenPosition && takeProfit && stopLoss);
  return {
    status: !hasOpenPosition ? 'NOT_REQUIRED' : covered ? 'PROTECTED' : 'INCOMPLETE',
    covered,
    count: orders.length,
    takeProfit,
    stopLoss,
    orders,
  };
}

async function fetchOpenAlgoOrders(exchange, symbol) {
  if (typeof exchange.fapiPrivateGetOpenAlgoOrders !== 'function') return [];
  const marketId = typeof exchange.market === 'function' ? exchange.market(symbol)?.id : null;
  const response = await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: marketId || symbol });
  return normalizeAlgoOrders(response);
}

module.exports = {
  algoClientId,
  algoKind,
  algoPositionSide,
  algoTriggerPrice,
  booleanValue,
  fetchOpenAlgoOrders,
  normalizeAlgoOrders,
  scalperOrdersForSide,
  scalperProtectionSnapshot,
};
