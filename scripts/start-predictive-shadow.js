#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeKlines, buildFeatureRows } = require('../src/predictive/features');
const { forecast, scorePending, summary } = require('../src/predictive/forward-evaluator');

function loadState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.records)) throw new Error('Invalid shadow state');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 2, records: [] };
    throw error;
  }
}

function saveState(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function main() {
  require('dotenv').config({ path: path.resolve('.env.futures'), quiet: true });
  const symbol = String(process.env.PREDICTIVE_SYMBOL || 'BTCUSDT');
  if (!/^[A-Z0-9]{6,20}$/.test(symbol)) throw new Error('Invalid PREDICTIVE_SYMBOL');
  const modelDir = path.resolve(process.env.PREDICTIVE_MODEL_DIR ||
    path.join('predictive-results', symbol));
  const models = [15, 30, 60].map(horizon => {
    const model = JSON.parse(fs.readFileSync(path.join(modelDir,
      'model-' + horizon + 'm.json'), 'utf8'));
    if (model.horizon !== horizon || model.approvedForTrading !== false ||
        !model.config || model.config.horizon !== horizon) {
      throw new Error('Missing safe V2 model for horizon ' + horizon);
    }
    return model;
  });
  const statePath = path.resolve(process.env.PREDICTIVE_SHADOW_STATE_FILE ||
    path.join('predictive-results', symbol + '-shadow-v2.json'));
  const state = loadState(statePath);
  const ccxt = require('ccxt');
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true,
    options: { fetchCurrencies: false } });
  let running = true;
  process.once('SIGINT', () => { running = false; });
  process.once('SIGTERM', () => { running = false; });
  console.log('[PREDICTIVE V2] SHADOW_ONLY ' + symbol + ', no account access or orders');
  while (running) {
    try {
      const now = Date.now();
      const raw = await exchange.fapiPublicGetKlines({
        symbol, interval: '1m', limit: 1000,
      });
      const candles = normalizeKlines(raw.filter(row => Number(row[6]) < now));
      const current = buildFeatureRows(candles).at(-1);
      if (!current) throw new Error('Insufficient complete market data');
      const outcomes = scorePending(state.records, candles);
      const ids = new Set(state.records.map(record => record.id));
      let newPredictions = 0;
      for (const model of models) {
        const next = forecast(model, current, symbol, now);
        if (ids.has(next.id)) continue;
        ids.add(next.id);
        state.records.push(next);
        newPredictions += 1;
        console.log('[PREDICTIVE V2] ' + JSON.stringify({
          id: next.id, action: next.action, reason: next.reason,
          probabilities: next.probabilities || null,
        }));
      }
      if (state.records.length > 6000) {
        const evaluated = state.records.filter(record => record.outcome);
        const pending = state.records.filter(record => !record.outcome);
        state.records = [...evaluated.slice(-Math.max(0, 6000 - pending.length)),
          ...pending].sort((a, b) => a.candleCloseTime - b.candleCloseTime);
      }
      saveState(statePath, state);
      if (newPredictions || outcomes.length) {
        console.log('[PREDICTIVE V2] ' + JSON.stringify(summary(state.records)));
      }
    } catch (error) {
      console.error('[PREDICTIVE V2] ' + String(error?.message || error));
    }
    if (running) await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

module.exports = { main, loadState, saveState };
