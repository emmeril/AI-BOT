#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const { ExchangeManager } = require('../src/exchange-manager');
const { GridState } = require('../src/grid-state');
const { AtomicFileWriter } = require('../src/atomic-file-writer');
const { GRID_STATE_PATH } = require('../src/config');
const {
  EPSILON,
  replayFifoInventory,
  summarizeTrackedInventory,
  calculateInventoryRecovery,
} = require('../src/inventory-reconciliation');

const apply = process.argv.includes('--apply');
const symbolArg = process.argv.find(arg => arg.startsWith('--symbol='));
const symbol = symbolArg ? symbolArg.slice('--symbol='.length) : process.env.SYMBOLS?.split(',')[0]?.trim();

function buildLevels(config) {
  const count = Number(config.count);
  const lower = Number(config.lower);
  const upper = Number(config.upper);
  const advised = config.rangeAdvisor?.levels || config.aiAdvisor?.levels;
  if (Array.isArray(advised) && advised.length === count + 1) return advised.map(Number);
  if (String(config.mode).toUpperCase() === 'GEOMETRIC') {
    const ratio = Math.pow(upper / lower, 1 / count);
    return Array.from({ length: count + 1 }, (_, index) => lower * Math.pow(ratio, index));
  }
  const step = (upper - lower) / count;
  return Array.from({ length: count + 1 }, (_, index) => lower + step * index);
}

async function fetchAllTrades(exchange, market, since) {
  const trades = [];
  let cursor = since;
  for (let page = 0; page < 100; page++) {
    const batch = await exchange.fetchMyTrades(market, cursor, 1000);
    if (!batch.length) break;
    trades.push(...batch);
    if (batch.length < 1000) break;
    const lastTimestamp = Number(batch[batch.length - 1].timestamp);
    if (!(lastTimestamp >= cursor)) throw new Error('Trade pagination did not advance');
    cursor = lastTimestamp + 1;
  }
  return trades;
}

async function main() {
  if (!symbol) throw new Error('Pass --symbol=SHIB/USDT or configure SYMBOLS');
  const state = new GridState();
  const symState = state.getSymbol(symbol);
  const [base, quote] = symbol.split('/');
  const exchange = ExchangeManager.getInstance();
  await exchange.loadMarkets();
  const since = Date.parse(symState.createdAt || 0) || 0;
  const [trades, balance] = await Promise.all([
    fetchAllTrades(exchange, symbol, since),
    exchange.fetchBalance(),
  ]);

  const replayed = replayFifoInventory(trades, base, quote.split(':')[0]);
  const tracked = summarizeTrackedInventory(symState);
  const recovery = calculateInventoryRecovery(replayed, tracked);
  const exchangeTotal = Number(balance?.total?.[base] || 0);
  const balanceTolerance = Math.max(1, exchangeTotal * 1e-8);
  if (Math.abs(exchangeTotal - replayed.sellableAmount) > balanceTolerance) {
    throw new Error(
      `Exchange balance ${exchangeTotal} ${base} does not match reconstructed ${replayed.sellableAmount}; ` +
      'history may start too late, so automatic recovery is unsafe'
    );
  }

  console.log(JSON.stringify({ symbol, trades: trades.length, exchangeTotal, replayed, tracked, recovery }, null, 2));
  if (!apply || recovery.sellableAmount <= EPSILON) {
    console.log(apply ? '[RECOVERY] No missing inventory found.' : '[DRY-RUN] Re-run with --apply to persist recovery.');
    return;
  }

  const originalState = JSON.stringify(state.data, null, 2);
  const levels = buildLevels(symState.config);
  const levelIndex = levels.reduce((best, price, index) =>
    Math.abs(price - recovery.averagePrice) < Math.abs(levels[best] - recovery.averagePrice) ? index : best, 0);
  const existing = symState.lastBuyByLevel[levelIndex];
  const existingAmount = Number(existing?.sellableAmount ?? existing?.amount) || 0;
  const existingCost = (Number(existing?.totalCostQuote) || 0) + (Number(existing?.totalFeeQuote) || 0);
  const combinedAmount = existingAmount + recovery.sellableAmount;
  const combinedCost = existingCost + recovery.totalCostQuote;
  symState.lastBuyByLevel[levelIndex] = {
    ...existing,
    price: combinedCost / combinedAmount,
    amount: combinedAmount,
    sellableAmount: combinedAmount,
    totalCostQuote: combinedCost,
    totalFeeQuote: 0,
    refillCount: Math.max(0, Number(existing?.refillCount) || 0),
    at: new Date().toISOString(),
    aggregated: true,
    recoveredInventory: true,
  };
  symState.refillCountByLevel[levelIndex] = symState.lastBuyByLevel[levelIndex].refillCount;
  symState.inventoryReconciliation = {
    appliedAt: new Date().toISOString(),
    method: 'FIFO_TRADE_HISTORY',
    tradeCount: trades.length,
    recoveredAmount: recovery.sellableAmount,
    recoveredCostQuote: recovery.totalCostQuote,
    levelIndex,
  };

  const backupPath = `${GRID_STATE_PATH}.bak-inventory-recovery-${Date.now()}`;
  await AtomicFileWriter.write(backupPath, () => originalState);
  await state.save();
  console.log(`[RECOVERY] Added ${recovery.sellableAmount} ${base} at level ${levelIndex}; backup: ${backupPath}`);
}

main().catch(err => {
  console.error('[RECOVERY] Failed:', err.message);
  process.exitCode = 1;
});
