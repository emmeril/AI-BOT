#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { normalizeKlines, buildFeatureRows } = require('../src/predictive/features');
const { validateDirectionModel } = require('../src/predictive/direction-model');
const { SCHEMA, buildDirectionFeatures } = require('../src/predictive/direction-features');
const { validateExitModel, planExit } = require('../src/predictive/exit-planner');
const { simulationSizing, normalizeFixedSizing } = require('../src/predictive/shadow-sizing');
const { ADAPTIVE_KIND, validateReachability } = require('../src/predictive/reachability');
const { ADAPTIVE_POLICY_ID } = require('../src/predictive/adaptive-exits');
const { forecastDirection, scorePendingDirection, directionSummary } =
  require('../src/predictive/direction-forward');

function loadState(file, symbol) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.objective !== 'PRICE_DIRECTION' || !Array.isArray(data.records) ||
        data.records.some(record => record.objective !== 'PRICE_DIRECTION' ||
          (symbol && record.symbol !== symbol))) {
      throw new Error('Incompatible shadow state; use a separate file for price direction forecasts');
    }
    normalizeFixedSizing(data.records);
    data.simulationSizing = simulationSizing();
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 2, objective: 'PRICE_DIRECTION',
      simulationSizing: simulationSizing(), records: [] };
    throw error;
  }
}

function saveState(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function loadModels(modelDir, symbol) {
  const manifestFile = path.join(modelDir, 'manifest.json');
  if (fs.existsSync(manifestFile) && JSON.parse(fs.readFileSync(manifestFile)).promotionEligible === false) {
    throw new Error('Research models did not pass accuracy promotion checks');
  }
  const models = [15, 30, 60].map(horizon => {
    const model = JSON.parse(fs.readFileSync(path.join(modelDir, 'model-' + horizon + 'm.json'), 'utf8'));
    validateDirectionModel(model, symbol);
    if (model.featureSchema && !['base-v1', SCHEMA].includes(model.featureSchema)) {
      throw new Error('Unsupported direction feature schema');
    }
    if (model.horizon !== horizon || !model.modelId || !model.trainingRunId) {
      throw new Error('Missing price direction model for horizon ' + horizon);
    }
    return model;
  });
  if (new Set(models.map(model => model.trainingRunId)).size !== 1) {
    throw new Error('Direction models must come from the same completed training run');
  }
  return models;
}

function currentFeatures(models, candles) {
  const result = new Map();
  for (const model of models) {
    const schema = model.featureSchema || 'base-v1';
    if (!['base-v1', SCHEMA].includes(schema)) throw new Error('Unsupported direction feature schema');
    if (!result.has(schema)) {
      const rows = schema === SCHEMA ? buildDirectionFeatures(candles) : buildFeatureRows(candles);
      if (!rows.length) throw new Error('Insufficient complete market data');
      result.set(schema, rows.at(-1));
    }
  }
  return result;
}

function loadExitModels(directory, symbol, directionModels) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  if (manifest.objective !== 'FUTURE_PRICE_EXCURSIONS' || manifest.symbol !== symbol || manifest.completed !== true) {
    throw new Error('Incomplete or incompatible exit model bundle');
  }
  const result = new Map(directionModels.map(direction => {
    const model = JSON.parse(fs.readFileSync(path.join(directory, `exit-model-${direction.horizon}m.json`)));
    validateExitModel(model, symbol, direction.modelId);
    if (model.horizon !== direction.horizon || model.trainingRunId !== manifest.trainingRunId) {
      throw new Error('Incompatible exit model training run');
    }
    return [direction.horizon, model];
  }));
  return result;
}

async function fetchPriceTick(exchange, symbol) {
  const data = await exchange.fapiPublicGetExchangeInfo();
  const filter = data.symbols?.find(row => row.symbol === symbol)?.filters?.find(row => row.filterType === 'PRICE_FILTER');
  const tick = Number(filter?.tickSize);
  if (!Number.isFinite(tick) || tick <= 0) throw new Error('Price tick unavailable for ' + symbol);
  return tick;
}

function loadReachabilityModels(directory, symbol, directionModels, exitModels, sourceDirectories) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  if (manifest.completed !== true || manifest.objective !== 'TP_BEFORE_SL_WITHIN_HORIZON' || manifest.symbol !== symbol) {
    throw new Error('Incomplete or incompatible reachability bundle');
  }
  return new Map(directionModels.map(direction => {
    const exitModel = exitModels.get(direction.horizon);
    if (!exitModel) throw new Error('Missing excursion model for adaptive exits');
    const model = validateReachability(JSON.parse(fs.readFileSync(path.join(directory,
      `model-${direction.horizon}m.json`))), symbol, direction.modelId, exitModel.modelId);
    if (model.horizon !== direction.horizon || model.trainingRunId !== manifest.trainingRunId ||
        model.modelId !== manifest.modelIds?.[direction.horizon]) throw new Error('Incompatible reachability training run');
    if (sourceDirectories) {
      const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (model.directionModelHash !== digest(path.join(sourceDirectories.directionDirectory, `model-${direction.horizon}m.json`)) ||
          model.exitModelHash !== digest(path.join(sourceDirectories.exitDirectory, `exit-model-${direction.horizon}m.json`))) {
        throw new Error('Reachability upstream model hash mismatch');
      }
    }
    return [direction.horizon, model];
  }));
}

async function main() {
  require('dotenv').config({ path: path.resolve('.env.futures'), quiet: true });
  const symbol = String(process.env.PREDICTIVE_SYMBOL || 'DOGEUSDT');
  if (!/^[A-Z0-9]{6,20}$/.test(symbol)) throw new Error('Invalid PREDICTIVE_SYMBOL');
  const modelDir = path.resolve(process.env.PREDICTIVE_MODEL_DIR ||
    path.join('predictive-results', symbol + '-direction-v2'));
  const models = loadModels(modelDir, symbol);
  const exitDirectory = path.resolve(process.env.PREDICTIVE_EXIT_MODEL_DIR ||
    path.join('predictive-results', symbol + '-exit-levels-v1'));
  let exitModels = new Map();
  try { exitModels = loadExitModels(exitDirectory, symbol, models); }
  catch (error) { console.error('[PREDICTIVE EXITS] ' + error.message); }
  const reachabilityDirectory = path.resolve(process.env.PREDICTIVE_REACHABILITY_MODEL_DIR ||
    path.join('predictive-results', symbol + '-adaptive-exits-v2'));
  let reachabilityModels = new Map();
  try {
    reachabilityModels = loadReachabilityModels(reachabilityDirectory, symbol, models, exitModels,
      { directionDirectory: modelDir, exitDirectory });
    if ([...reachabilityModels.values()].some(model => model.kind !== ADAPTIVE_KIND)) {
      throw new Error('Active worker requires adaptive net expectancy models');
    }
  } catch (error) {
    reachabilityModels = new Map();
    console.error('[PREDICTIVE REACHABILITY] ' + error.message);
  }
  const statePath = path.resolve(process.env.PREDICTIVE_SHADOW_STATE_FILE ||
    path.join('predictive-results', symbol + '-adaptive-shadow-v5.json'));
  const state = loadState(statePath, symbol);
  const ccxt = require('ccxt');
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true,
    options: { fetchCurrencies: false } });
  let tickSize = null;
  try { tickSize = await fetchPriceTick(exchange, symbol); }
  catch (error) { console.error('[PREDICTIVE EXITS] Using unrounded indicative prices: ' + error.message); }
  let running = true;
  const shutdown = new AbortController();
  const stop = () => { running = false; shutdown.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log('[PREDICTIVE V2] PRICE_DIRECTION SHADOW_ONLY ' + symbol);
  console.log('[PREDICTIVE V2] ' + JSON.stringify({ simulationSizing: simulationSizing(), riskPolicyId: ADAPTIVE_POLICY_ID }));
  for (const model of models) {
    console.log('[PREDICTIVE V2] ' + JSON.stringify({ horizon: model.horizon,
      modelId: model.modelId, objective: model.objective, temperature: model.temperature,
      classifierKind: model.classifier.kind, featureSchema: model.featureSchema || 'base-v1',
      exitModelId: exitModels.get(model.horizon)?.modelId || null, priceTick: tickSize,
      reachabilityModelId: reachabilityModels.get(model.horizon)?.modelId || null,
      validationOutperformsBaseline: model.validationOutperformsBaseline,
    }));
  }
  while (running) {
    try {
      const raw = await exchange.fapiPublicGetKlines({
        symbol, interval: '1m', limit: 1000,
      });
      const now = Date.now();
      const candles = normalizeKlines(raw.filter(row => Number(row[6]) < now));
      const features = currentFeatures(models, candles);
      const exitFeatures = exitModels.size ? buildDirectionFeatures(candles).at(-1) : null;
      const outcomes = scorePendingDirection(state.records, candles);
      const ids = new Set(state.records.map(record => record.id));
      let newPredictions = 0;
      for (const model of models) {
        const current = features.get(model.featureSchema || 'base-v1');
        const next = forecastDirection(model, current, symbol, now);
        if (ids.has(next.id)) continue;
        try {
          next.exitPlan = planExit(next, exitModels.get(model.horizon), exitFeatures?.x,
            { tickSize, targetLevels: true, candles: candles.slice(-16), reachabilityModel: reachabilityModels.get(model.horizon) });
        } catch (error) {
          console.error('[PREDICTIVE EXITS] ' + error.message);
          next.exitPlan = { status: 'UNAVAILABLE', reason: 'EXIT_ESTIMATION_FAILED', executionAllowed: false };
        }
        ids.add(next.id);
        state.records.push(next);
        newPredictions += 1;
        console.log('[PREDICTIVE V2] ' + JSON.stringify({
          id: next.id, objective: next.objective, direction: next.direction,
          confidence: next.confidence ?? null, reason: next.reason,
          referencePrice: next.referencePrice, targetCloseTime: next.targetCloseTime,
          probabilities: next.probabilities || null,
          exitPlan: next.exitPlan,
        }));
      }
      if (state.records.length > 6000) {
        const evaluated = state.records.filter(record => record.outcome);
        const pending = state.records.filter(record => !record.outcome);
        const keep = Math.max(0, 6000 - pending.length);
        state.records = [...(keep ? evaluated.slice(-keep) : []),
          ...pending].sort((a, b) => a.candleCloseTime - b.candleCloseTime);
      }
      saveState(statePath, state);
      if (newPredictions || outcomes.length) {
        console.log('[PREDICTIVE V2] ' + JSON.stringify(directionSummary(state.records)));
      }
    } catch (error) {
      console.error('[PREDICTIVE V2] ' + String(error?.message || error));
    }
    if (running) {
      await delay(60000, undefined, { signal: shutdown.signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

module.exports = { main, loadState, saveState, loadModels, currentFeatures, loadExitModels, loadReachabilityModels, fetchPriceTick };
