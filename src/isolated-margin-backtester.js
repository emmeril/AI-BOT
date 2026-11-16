'use strict';

const { marginBracket, liquidationPrice, isLiquidatable, settleLiquidation } = require('./isolated-liquidation');

function simulateIsolatedMargin(prepared, markRows, method, options) {
  const { start, end, leverage, brackets, liquidationFeeRate, priceSelector, funding = [],
    initialWallet = 100, normalNotional = 100, allocationPct = null,
    feeRate = 0.0005, slippageRate = 0.0002, enableLiquidation = true } = options;
  if (!(leverage > 0 && initialWallet > 0)) throw new Error('Invalid leverage or initial wallet');
  const marks = markRows instanceof Map ? markRows : new Map(markRows.map(row => [Number(row[0]), row]));
  const positions = { LONG: null, SHORT: null };
  let cash = initialWallet;
  let realizedNetPnl = 0;
  let totalFunding = 0;
  let tradingFees = 0;
  let clearanceFees = 0;
  let insuranceCovered = 0;
  let peak = initialWallet;
  let maxDrawdown = 0;
  let fundingIndex = 0;
  let skippedMargin = 0;
  let insufficientLeverageTier = 0;
  let ambiguousCandles = 0;
  const trades = [];
  let lastMark = null;

  function close(side, rawExecutionPrice, triggerMark, timestamp, reason) {
    const position = positions[side];
    const executionPrice = rawExecutionPrice * (1 - position.direction * slippageRate);
    const liquidation = reason.startsWith('LIQUIDATION');
    let credit;
    let exitFee = 0;
    let liquidationSettlement = null;
    const grossPnl = position.direction * position.quantity * (executionPrice - position.entry);
    if (liquidation) {
      liquidationSettlement = settleLiquidation(position, executionPrice, triggerMark, liquidationFeeRate);
      credit = liquidationSettlement.returnedCollateral;
      clearanceFees += liquidationSettlement.clearanceFee;
      insuranceCovered += liquidationSettlement.insuranceCovered;
    } else {
      exitFee = position.quantity * executionPrice * feeRate;
      tradingFees += exitFee;
      credit = position.isolatedWallet + grossPnl - exitFee;
    }
    cash += credit;
    const netPnl = credit - position.initialMargin - position.entryFee + position.walletFunding;
    realizedNetPnl += netPnl;
    trades.push({ ...position, side, exitTimestamp: timestamp, reason, triggerMark, executionPrice,
      grossPnl, exitFee, netPnl, liquidationSettlement });
    positions[side] = null;
  }

  function rawFill(markLevel, contract, mark) {
    const basisFill = markLevel * Number(contract[1]) / Number(mark[1]);
    return Math.max(Number(contract[3]), Math.min(Number(contract[2]), basisFill));
  }

  function applyFunding(timestamp, markOpen) {
    while (fundingIndex < funding.length && Math.floor(Number(funding[fundingIndex].fundingTime) / 60_000) * 60_000 <= timestamp) {
      const event = funding[fundingIndex++];
      const fundingTime = Math.floor(Number(event.fundingTime) / 60_000) * 60_000;
      for (const position of Object.values(positions)) {
        if (!position || position.entryTimestamp >= fundingTime) continue;
        const payment = -position.direction * position.quantity * Number(event.markPrice || markOpen) * Number(event.fundingRate);
        totalFunding += payment;
        position.funding += payment;
        if (payment >= 0) {
          cash += payment;
          position.walletFunding += payment;
        } else {
          const fromWallet = Math.min(Math.max(0, cash), -payment);
          cash -= fromWallet;
          position.walletFunding -= fromWallet;
          const fromMargin = -payment - fromWallet;
          position.isolatedWallet -= fromMargin;
          position.marginFunding -= fromMargin;
        }
      }
    }
  }

  function markValue(position, markClose) {
    const estimatedExit = markClose * (1 - position.direction * slippageRate);
    return position.isolatedWallet + position.direction * position.quantity * (estimatedExit - position.entry) -
      position.quantity * estimatedExit * feeRate;
  }

  for (let index = 0; index < prepared.rows.length; index++) {
    const row = prepared.rows[index];
    const timestamp = Number(row[0]);
    if (timestamp < start) continue;
    if (timestamp >= end) break;
    const mark = marks.get(timestamp);
    if (!mark || Number(mark[6]) !== timestamp + 59_999) throw new Error(`Missing aligned mark candle at ${timestamp}`);
    lastMark = Number(mark[4]);
    const markOpen = Number(mark[1]);
    applyFunding(timestamp, markOpen);

    for (const side of ['LONG', 'SHORT']) {
      const position = positions[side];
      if (!position) continue;
      if (enableLiquidation && isLiquidatable(position, markOpen, brackets)) {
        close(side, Number(row[1]), markOpen, timestamp, 'LIQUIDATION_GAP');
      } else if (position.direction * (markOpen - position.stop) <= 0) {
        close(side, Number(row[1]), markOpen, timestamp, 'STOP_LOSS_GAP');
      } else if (position.direction * (markOpen - position.target) >= 0) {
        close(side, Number(row[1]), markOpen, timestamp, 'TAKE_PROFIT_GAP');
      }
    }

    const event = prepared.events.get(index);
    if (event && !positions[event.side]) {
      const direction = event.side === 'LONG' ? 1 : -1;
      const entry = Number(row[1]) * (1 + direction * slippageRate);
      const levels = priceSelector(event, entry, method, { feeRate, slippageRate });
      if (levels) {
        const walletBalance = cash + Object.values(positions).reduce((sum, position) => sum + (position?.isolatedWallet || 0), 0);
        const notional = (allocationPct === null ? normalNotional : walletBalance * allocationPct / 100 * leverage) * event.size;
        const quantity = notional / entry;
        const initialMargin = notional / leverage;
        const entryFee = notional * feeRate;
        const tier = marginBracket(quantity * markOpen, brackets);
        if (leverage > Number(tier.initialLeverage)) insufficientLeverageTier++;
        else if (!(notional > 0) || cash < initialMargin + entryFee) skippedMargin++;
        else {
          cash -= initialMargin + entryFee;
          tradingFees += entryFee;
          positions[event.side] = { ...levels, side: event.side, direction, entry, quantity, initialMargin, entryFee,
            entryTimestamp: timestamp, isolatedWallet: initialMargin, countertrend: event.countertrend,
            walletFunding: 0, marginFunding: 0, funding: 0,
            liquidationAtEntry: liquidationPrice({ direction, entry, quantity, isolatedWallet: initialMargin }, brackets) };
          const opened = positions[event.side];
          opened.stopBeyondLiquidationAtEntry = opened.liquidationAtEntry !== null &&
            direction * (opened.stop - opened.liquidationAtEntry) <= 0;
        }
      }
    }

    for (const side of ['LONG', 'SHORT']) {
      const position = positions[side];
      if (!position) continue;
      if (enableLiquidation && isLiquidatable(position, markOpen, brackets)) {
        close(side, Number(row[1]), markOpen, timestamp, 'LIQUIDATION_ENTRY');
        continue;
      }
      const lp = enableLiquidation ? liquidationPrice(position, brackets) : null;
      const stopHit = position.direction > 0 ? Number(mark[3]) <= position.stop : Number(mark[2]) >= position.stop;
      const takeHit = position.direction > 0 ? Number(mark[2]) >= position.target : Number(mark[3]) <= position.target;
      const liqHit = lp !== null && (position.direction > 0 ? Number(mark[3]) <= lp : Number(mark[2]) >= lp);
      if (takeHit && (stopHit || liqHit)) ambiguousCandles++;
      // On the adverse leg the nearer boundary executes first. A protective SL
      // before the liquidation boundary must not become a fictitious liquidation.
      const liquidationFirst = liqHit && (!stopHit || position.direction * (position.stop - lp) <= 0);
      if (liquidationFirst) close(side, rawFill(lp, row, mark), lp, timestamp + 60_000, 'LIQUIDATION');
      else if (stopHit) close(side, rawFill(position.stop, row, mark), position.stop, timestamp + 60_000, 'STOP_LOSS');
      else if (takeHit) close(side, rawFill(position.target, row, mark), position.target, timestamp + 60_000, 'TAKE_PROFIT');
    }
    const equity = cash + Object.values(positions).reduce((sum, position) => sum + (position ? markValue(position, lastMark) : 0), 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  if (lastMark === null) throw new Error('No candles in requested period');
  const openPositions = Object.entries(positions).filter(([, position]) => position).map(([side, position]) => ({ ...position, side,
    markPrice: lastMark, liquidationPrice: liquidationPrice(position, brackets),
    estimatedNetPnl: markValue(position, lastMark) - position.initialMargin - position.entryFee + position.walletFunding }));
  const endEquity = cash + Object.values(positions).reduce((sum, position) => sum + (position ? markValue(position, lastMark) : 0), 0);
  const netPnl = endEquity - initialWallet;
  const winners = trades.filter(trade => trade.netPnl > 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = -trades.filter(trade => trade.netPnl <= 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  return { initialWallet, endEquity, netPnl, realizedNetPnl, openNetPnl: netPnl - realizedNetPnl,
    trades: trades.length, wins: winners.length, winRate: trades.length ? winners.length / trades.length : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : null, maxDrawdown,
    liquidations: trades.filter(trade => trade.reason.startsWith('LIQUIDATION')).length,
    stopsBeyondLiquidation: [...trades, ...openPositions].filter(position => position.stopBeyondLiquidationAtEntry).length,
    tradingFees, clearanceFees, insuranceCovered, funding: totalFunding,
    skippedMargin, insufficientLeverageTier, ambiguousCandles, openPositions, tradeDetails: trades };
}

module.exports = { simulateIsolatedMargin };
