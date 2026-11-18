'use strict';

const { settings, simulateExit } = require('./trade-simulator');

function labeledRows(features, candles, options = {}) {
  const config = settings(options);
  return features.map(row => {
    const longTrade = simulateExit(candles, row.index, 'LONG', config);
    const shortTrade = simulateExit(candles, row.index, 'SHORT', config);
    if (!longTrade || !shortTrade) return null;
    return {
      ...row,
      longTrade,
      shortTrade,
      labelLong: Number(longTrade.targetHit),
      labelShort: Number(shortTrade.targetHit),
    };
  }).filter(Boolean);
}

module.exports = { labeledRows };
