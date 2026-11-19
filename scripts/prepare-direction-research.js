#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeKlines } = require('../src/predictive/features');
const { SCHEMA, NAMES, buildDirectionFeatures } = require('../src/predictive/direction-features');

function prepare(file, destination) {
  const symbol = /^([A-Z0-9]{6,20})-1m-\d+d\.json$/.exec(path.basename(file))?.[1];
  if (symbol !== 'DOGEUSDT') throw new Error('Direction accuracy research currently requires DOGEUSDT history');
  const candles = normalizeKlines(JSON.parse(fs.readFileSync(file)));
  const rows = buildDirectionFeatures(candles);
  if (rows.length < 10000) throw new Error('Need at least 10000 context feature rows');
  const at = fraction => rows[Math.floor(rows.length * fraction)].time;
  const boundaries = { validationStart: at(0.6), holdoutStart: at(0.8),
    selectionFolds: [[at(0.3), at(0.4)], [at(0.4), at(0.5)], [at(0.5), at(0.6)]] };
  const data = { symbol, featureSchema: SCHEMA, featureNames: NAMES, source: path.resolve(file), boundaries,
    features: rows.map(row => row.x), times: rows.map(row => row.time),
    labels: Object.fromEntries([15, 30, 60].map(horizon => [horizon, rows.map(row => {
      const future = candles[row.index + horizon];
      return future ? future.close > row.close ? 2 : future.close < row.close ? 0 : 1 : -1;
    })])) };
  fs.writeFileSync(destination, JSON.stringify(data));
  console.log(JSON.stringify({ rows: rows.length, features: NAMES.length, boundaries }));
}

if (require.main === module) {
  try { prepare(process.argv[2], process.argv[3]); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}

module.exports = { prepare };
