'use strict';

const fs = require('fs');
const path = require('path');

function emptyState() {
  return { version: 1, updatedAt: new Date().toISOString(), symbols: {} };
}

function loadState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    parsed.symbols ||= {};
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error(`Cannot load scalper handoff state ${filePath}: ${error.message}`, { cause: error });
  }
}

function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function isHandoffActive(filePath, symbol) {
  return loadState(filePath).symbols?.[symbol]?.handoffActive === true;
}

function hasPosition(position) {
  return Math.abs(Number(position?.contracts ?? position?.info?.positionAmt) || 0) > 1e-12;
}

function canActivateHandoff({ positions = [], regularOrders = [], algoOrders = [] } = {}) {
  return !positions.some(hasPosition) && regularOrders.length === 0 && algoOrders.length === 0;
}

function protectionPrices(entryPrice, { takeProfitPct = 2.5, stopLossPct = 1, side = 'SHORT' } = {}) {
  const entry = Number(entryPrice);
  if (!(entry > 0)) throw new Error(`Invalid scalper entry price: ${entryPrice}`);
  const direction = String(side).toUpperCase() === 'LONG' ? 1 : -1;
  return {
    takeProfit: entry * (100 + direction * takeProfitPct) / 100,
    stopLoss: entry * (100 - direction * stopLossPct) / 100,
  };
}

module.exports = {
  canActivateHandoff,
  emptyState,
  hasPosition,
  isHandoffActive,
  loadState,
  protectionPrices,
  saveState,
};
