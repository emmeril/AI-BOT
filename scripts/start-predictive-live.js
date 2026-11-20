#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const ccxt = require('ccxt');
const { setTimeout: delay } = require('node:timers/promises');
const { CrossProcessMutex } = require('../src/cross-process-mutex');
const { buildLiveConfig } = require('../src/predictive/live-policy');
const { PredictiveLiveEngine } = require('../src/predictive/live-engine');
const { PredictiveHedgeEngine } = require('../src/predictive/hedge-engine');

function loadEnvironment() {
  const root = path.resolve(__dirname, '..');
  const credentialsFile = path.join(root, '.env.futures');
  const profileFile = path.join(root, '.env.predictive-live');
  const credentials = dotenv.parse(fs.readFileSync(credentialsFile));
  const profile = fs.existsSync(profileFile) ? dotenv.parse(fs.readFileSync(profileFile)) : {};
  return { ...credentials, ...profile, ...process.env };
}

async function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--run'].includes(mode)) throw new Error('Use --check for read-only inspection or --run for user-activated execution');
  const environment = loadEnvironment();
  const config = buildLiveConfig({ ...environment,
    PREDICTIVE_LIVE_ENABLED: mode === '--check' ? 'false' : environment.PREDICTIVE_LIVE_ENABLED });
  if (mode === '--run' && !config.enabled) throw new Error('Live trading is disabled. The profile must be activated explicitly by its operator.');
  if (!environment.EXCHANGE_API_KEY || !environment.EXCHANGE_SECRET) throw new Error('Missing futures API credentials');
  const exchange = new ccxt.binanceusdm({ apiKey: environment.EXCHANGE_API_KEY,
    secret: environment.EXCHANGE_SECRET, enableRateLimit: true,
    options: { adjustForTimeDifference: true, recvWindow: 10000, fetchCurrencies: false } });
  const Engine = config.maxOpenPositions === 2 ? PredictiveHedgeEngine : PredictiveLiveEngine;
  const createEngine = () => new Engine({ config, exchange });
  const redact = error => {
    let message = String(error?.message || error).replace(/signature=[^&\s]+/g, 'signature=[redacted]');
    for (const value of [environment.EXCHANGE_API_KEY, environment.EXCHANGE_SECRET]) {
      if (value) message = message.split(value).join('[redacted]');
    }
    return message;
  };
  if (mode === '--check') {
    const engine = createEngine();
    const report = await engine.preflight();
    console.log(JSON.stringify({ ...report, orderExecutionEnabled: false,
      inspectedAt: new Date().toISOString(), checkWasReadOnly: true }, null, 2));
    if (report.status !== 'CONFIGURATION_VERIFIED_READ_ONLY') process.exitCode = 2;
    return;
  }
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  const mutex = new CrossProcessMutex(config.stateFile + '.process', { timeoutMs: 1000 });
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());
  await mutex.run('DOGEUSDT-predictive-60m', async () => {
    const engine = createEngine();
    const active = config.maxOpenPositions === 2 ? engine.hasExposure() : engine.state.tracked || engine.state.intent;
    if (!active && !engine.state.pausedReason) await engine.configureAccount();
    console.log('[PREDICTIVE LIVE] DOGEUSDT horizon=60 marginPerPosition=5USDT leverage=10 notionalPerPosition=50USDT isolated maxPositions=' + config.maxOpenPositions);
    console.log('[PREDICTIVE LIVE] ' + JSON.stringify({ positionExitPolicy: config.positionExitPolicy,
      timeBasedPositionExit: config.positionExitPolicy === 'HORIZON', maxOpenPositions: config.maxOpenPositions,
      maxTotalNotionalUsdt: config.maxTotalNotionalUsdt, aiReviewEnabled: config.aiReview.enabled,
      aiReviewRequired: config.aiReview.enabled && config.aiReview.failureMode === 'BLOCK',
      aiReviewFailureMode: config.aiReview.failureMode,
      aiReviewModel: config.aiReview.model, aiReviewTimeoutMs: config.aiReview.timeoutMs, aiReviewStateFile: config.aiReview.stateFile }));
    while (!shutdown.signal.aborted) {
      try {
        const result = await engine.cycle();
        if (result) console.log('[PREDICTIVE LIVE] ' + JSON.stringify(result));
      } catch (error) { console.error('[PREDICTIVE LIVE] ' + redact(error)); }
      await delay(config.intervalMs, undefined, { signal: shutdown.signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  });
}

if (require.main === module) {
  main().catch(error => {
    const message = String(error?.message || error).replace(/signature=[^&\s]+/g, 'signature=[redacted]');
    console.error('[PREDICTIVE LIVE] ' + message);
    process.exitCode = 1;
  });
}

module.exports = { main, loadEnvironment };
