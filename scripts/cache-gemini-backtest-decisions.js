#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const path = require('path');
const dotenv = require('dotenv');
const {
  analyzeTimeframe,
  aggregateTimeframes,
} = require('../src/fibonacci-direction-analyzer');
const {
  GeminiApiKeyPool,
  createGeminiHttpError,
  isGeminiDailyQuotaError,
} = require('../src/gemini-api-keys');
const { normalizeDecision } = require('../src/gemini-adaptive-monitor');
const {
  CACHE_PROMPT_VERSION,
  CACHE_SCHEMA_VERSION,
  cacheKey,
  parseJsonLines,
} = require('../src/backtest-gemini-cache');
const {
  applyConfirmation,
  completedIndex,
  resampleCandles,
} = require('./backtest-fibonacci-direction');
const { loadCachedRows } = require('./backtest-full-grid-pnl');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const MINUTE_MS = 60_000;
const BASE_TIMEFRAME_MS = 15 * MINUTE_MS;
const CANDLE_LIMIT = 100;
const DEFAULT_SYMBOLS = [
  '1000SHIB/USDT:USDT',
  '1000PEPE/USDT:USDT',
  '1000BONK/USDT:USDT',
  'PENGU/USDT:USDT',
  'JUP/USDT:USDT',
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseDate(value, fallback) {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function compactAnalysis(analysis) {
  return {
    direction: analysis.direction,
    confirmedDirection: analysis.confirmedDirection,
    score: analysis.score,
    confidence: analysis.confidence,
    alignment: analysis.alignment,
    timeframes: Object.fromEntries(Object.entries(analysis.timeframes || {}).map(([name, value]) => [name, {
      direction: value.direction,
      score: value.score,
      atrPct: value.atrPct,
      volatilityRatio: value.volatilityRatio,
      recentMoveAtr: value.recentMoveAtr,
    }])),
  };
}

function buildSnapshots(symbol, rows, start, end, intervalMs) {
  const candles1h = resampleCandles(rows, 60 * MINUTE_MS);
  const candles4h = resampleCandles(rows, 4 * 60 * MINUTE_MS);
  const confirmation = { candidate: 'RANGING', count: 0 };
  const snapshots = [];
  let index1h = -1;
  let index4h = -1;
  let previousBucket = null;

  for (let index15m = 0; index15m < rows.length; index15m++) {
    const candle = rows[index15m];
    const timestamp = candle[0] + BASE_TIMEFRAME_MS;
    if (timestamp < start || timestamp >= end) continue;
    index1h = completedIndex(candles1h, 60 * MINUTE_MS, timestamp, index1h);
    index4h = completedIndex(candles4h, 4 * 60 * MINUTE_MS, timestamp, index4h);
    if (index15m + 1 < CANDLE_LIMIT || index1h + 1 < CANDLE_LIMIT || index4h + 1 < CANDLE_LIMIT) continue;
    const timeframeResults = [
      analyzeTimeframe(rows.slice(index15m + 1 - CANDLE_LIMIT, index15m + 1), '15m'),
      analyzeTimeframe(candles1h.slice(index1h + 1 - CANDLE_LIMIT, index1h + 1), '1h'),
      analyzeTimeframe(candles4h.slice(index4h + 1 - CANDLE_LIMIT, index4h + 1), '4h'),
    ];
    if (timeframeResults.some(result => !result)) continue;
    const aggregate = aggregateTimeframes(timeframeResults);
    const confirmedDirection = applyConfirmation(aggregate, confirmation);
    const bucket = Math.floor(timestamp / intervalMs);
    if (bucket === previousBucket) continue;
    previousBucket = bucket;
    snapshots.push({
      id: cacheKey(symbol, timestamp),
      symbol,
      timestamp,
      currentPrice: candle[4],
      analysis: compactAnalysis({ ...aggregate, confirmedDirection }),
    });
  }
  return snapshots;
}

function buildBatchPrompt(snapshots, fixedExposurePct) {
  const inputs = snapshots.map(snapshot => ({
    id: snapshot.id,
    symbol: snapshot.symbol,
    currentPrice: snapshot.currentPrice,
    exposurePct: fixedExposurePct,
    fibonacci: snapshot.analysis,
  }));
  return `Classify historical market snapshots for a long-only Binance futures grid bot.
Return one result for every input id and preserve each id exactly.
Profiles: BULLISH for broad confirmed strength, SIDEWAYS for ranging or mixed conditions, BEARISH for downside where buys should favor lower levels, and RISK_OFF only for materially dangerous downside or volatility expansion.
The fixed exposure is intentional: this cache measures Gemini's market-regime overlay. The deterministic supervisor separately enforces simulated exposure safety.
For each item return only id, profile, and confidence from 0 to 1.
Inputs:\n${JSON.stringify(inputs)}`;
}

function requestBatch({ apiKey, baseUrl, model, timeoutMs, prompt, expectedCount }) {
  const itemSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      profile: { type: 'string', enum: ['BULLISH', 'SIDEWAYS', 'BEARISH', 'RISK_OFF'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['id', 'profile', 'confidence'],
    additionalProperties: false,
  };
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: Math.max(4096, expectedCount * 96),
      responseFormat: {
        text: {
          mimeType: 'APPLICATION_JSON',
          schema: { type: 'array', items: itemSchema, minItems: expectedCount, maxItems: expectedCount },
        },
      },
    },
  });
  const url = `${String(baseUrl).replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-goog-api-key': apiKey,
      },
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(createGeminiHttpError(response.statusCode, raw, response.headers));
          return;
        }
        try {
          const json = JSON.parse(raw);
          const text = (json?.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('').trim();
          const cleaned = text.replace(/```json|```/g, '').trim();
          let parsed;
          try {
            parsed = JSON.parse(cleaned);
          } catch {
            parsed = JSON.parse(cleaned.replace(/,\s*([}\]])/g, '$1'));
          }
          if (!Array.isArray(parsed) || parsed.length !== expectedCount) {
            throw new Error(`expected ${expectedCount} results, received ${parsed?.length}`);
          }
          resolve(parsed);
        } catch (error) {
          reject(new Error(`Could not parse Gemini backtest batch: ${error.message}`));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Gemini backtest batch timed out after ${timeoutMs}ms`)));
    request.once('error', reject);
    request.end(payload);
  });
}

async function requestWithRetry(pool, input, maximumAttempts) {
  let lastError;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    try {
      return await pool.run(apiKey => requestBatch({ ...input, apiKey }));
    } catch (error) {
      lastError = error;
      if (isGeminiDailyQuotaError(error) || attempt === maximumAttempts) break;
      await sleep(Math.min(15_000, 2000 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

async function main() {
  const projectRoot = process.cwd();
  const dataDirectory = path.join(projectRoot, 'backtest-data', 'fibonacci-direction');
  const outputPath = path.resolve(
    process.env.BACKTEST_GEMINI_CACHE || 'backtest-data/gemini-adaptive-decisions.jsonl'
  );
  const symbols = (process.env.BACKTEST_SYMBOLS || DEFAULT_SYMBOLS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  const rowsBySymbol = Object.fromEntries(symbols.map(symbol => [symbol, loadCachedRows(dataDirectory, symbol)]));
  const availableEnd = Math.min(...symbols.map(symbol => rowsBySymbol[symbol].at(-1)[0] + BASE_TIMEFRAME_MS));
  const end = parseDate(process.env.BACKTEST_END, availableEnd);
  const start = parseDate(process.env.BACKTEST_START, end - 365 * 24 * 60 * MINUTE_MS);
  const intervalMinutes = Math.max(15, Number(process.env.BACKTEST_GEMINI_INTERVAL_MINUTES) || 120);
  const intervalMs = intervalMinutes * MINUTE_MS;
  const fixedExposurePct = Number(process.env.BACKTEST_GEMINI_FIXED_EXPOSURE_PCT) || 50;
  const batchSize = Math.max(1, Math.min(100, Number(process.env.BACKTEST_GEMINI_BATCH_SIZE) || 50));
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const baseUrl = process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com';
  const timeoutMs = Math.max(20_000, Number(process.env.GEMINI_ADAPTIVE_MONITOR_TIMEOUT_MS) || 60_000);
  const minimumIntervalMs = Math.max(0, Number(process.env.GEMINI_ADAPTIVE_MONITOR_MIN_REQUEST_INTERVAL_MS) || 5000);
  const maximumAttempts = Math.max(1, Number(process.env.GEMINI_ADAPTIVE_MONITOR_MAX_ATTEMPTS) || 3);
  const apiKeys = [process.env.GEMINI_API_KEY, ...(process.env.GEMINI_API_KEYS || '').split(',')]
    .map(value => String(value || '').trim()).filter(Boolean);
  if (!apiKeys.length) throw new Error('GEMINI_API_KEY or GEMINI_API_KEYS is required');
  const concurrency = Math.max(1, Math.min(
    apiKeys.length,
    Number(process.env.BACKTEST_GEMINI_CONCURRENCY) || apiKeys.length
  ));
  const workerPools = apiKeys.slice(0, concurrency).map(apiKey => new GeminiApiKeyPool({ apiKeys: [apiKey] }));

  const existingValues = fs.existsSync(outputPath)
    ? parseJsonLines(fs.readFileSync(outputPath, 'utf8'))
    : [];
  const existingMeta = existingValues.find(value => value?.type === 'GEMINI_BACKTEST_META');
  if (existingMeta && (
    Number(existingMeta.intervalMinutes) !== intervalMinutes ||
    Number(existingMeta.fixedExposurePct) !== fixedExposurePct ||
    existingMeta.model !== model ||
    existingMeta.promptVersion !== CACHE_PROMPT_VERSION
  )) {
    throw new Error('Existing Gemini cache metadata differs from the requested configuration; use a different cache path');
  }
  const completed = new Set(existingValues
    .filter(value => value?.type === 'GEMINI_BACKTEST_DECISION')
    .map(value => cacheKey(value.symbol, value.timestamp)));
  const snapshots = symbols.flatMap(symbol => buildSnapshots(symbol, rowsBySymbol[symbol], start, end, intervalMs));
  const pending = snapshots.filter(snapshot => !completed.has(snapshot.id));

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  if (!existingMeta) {
    const metadata = {
      type: 'GEMINI_BACKTEST_META',
      schemaVersion: CACHE_SCHEMA_VERSION,
      promptVersion: CACHE_PROMPT_VERSION,
      createdAt: new Date().toISOString(),
      period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      symbols,
      intervalMinutes,
      fixedExposurePct,
      model,
    };
    await fs.promises.appendFile(outputPath, `${JSON.stringify(metadata)}\n`);
  }
  const batches = [];
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    batches.push(pending.slice(offset, offset + batchSize));
  }
  console.log(
    `[GEMINI-CACHE] total=${snapshots.length} cached=${completed.size} pending=${pending.length} ` +
    `batches=${batches.length} workers=${concurrency}`
  );
  let written = 0;
  let writeQueue = Promise.resolve();
  const appendLines = lines => {
    writeQueue = writeQueue.then(() => fs.promises.appendFile(outputPath, `${lines.join('\n')}\n`));
    return writeQueue;
  };
  const runWorker = async workerIndex => {
    for (let batchIndex = workerIndex; batchIndex < batches.length; batchIndex += concurrency) {
      const batch = batches[batchIndex];
      const rawResults = await requestWithRetry(workerPools[workerIndex], {
        baseUrl,
        model,
        timeoutMs,
        prompt: buildBatchPrompt(batch, fixedExposurePct),
        expectedCount: batch.length,
      }, maximumAttempts);
      const byId = new Map(rawResults.map(result => [result.id, result]));
      const lines = batch.map(snapshot => {
        const raw = byId.get(snapshot.id);
        if (!raw) throw new Error(`Gemini omitted result ${snapshot.id}`);
        const decision = normalizeDecision({
          ...raw,
          reasoning: '',
          riskFactors: [],
        }, { minimumConfidence: 0.6 });
        return JSON.stringify({
          type: 'GEMINI_BACKTEST_DECISION',
          symbol: snapshot.symbol,
          timestamp: snapshot.timestamp,
          currentPrice: snapshot.currentPrice,
          analysis: snapshot.analysis,
          model,
          generatedAt: new Date().toISOString(),
          decisionId: snapshot.id,
          decision,
        });
      });
      await appendLines(lines);
      written += batch.length;
      console.log(`[GEMINI-CACHE] ${written}/${pending.length} new decisions cached`);
      if (batchIndex + concurrency < batches.length && minimumIntervalMs > 0) await sleep(minimumIntervalMs);
    }
  };
  await Promise.all(workerPools.map((_pool, index) => runWorker(index)));
  await writeQueue;
  console.log(`[GEMINI-CACHE] complete: ${outputPath}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[GEMINI-CACHE] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildBatchPrompt,
  buildSnapshots,
  requestBatch,
};
