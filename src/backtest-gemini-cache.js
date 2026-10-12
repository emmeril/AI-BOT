const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeDecision } = require('./gemini-adaptive-monitor');

const CACHE_SCHEMA_VERSION = 1;
const CACHE_PROMPT_VERSION = 'market-regime-v1';

function cacheKey(symbol, timestamp) {
  return `${symbol}|${Number(timestamp)}`;
}

function parseJsonLines(contents) {
  const values = [];
  for (const line of String(contents || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    values.push(JSON.parse(line));
  }
  return values;
}

function validateRecord(raw, minimumConfidence = 0.6) {
  if (raw?.type !== 'GEMINI_BACKTEST_DECISION') return null;
  const timestamp = Number(raw.timestamp);
  if (!raw.symbol || !Number.isFinite(timestamp)) return null;
  const decision = normalizeDecision(raw.decision, { minimumConfidence });
  return {
    type: 'GEMINI_BACKTEST_DECISION',
    symbol: String(raw.symbol),
    timestamp,
    currentPrice: Number(raw.currentPrice) || null,
    analysis: raw.analysis || null,
    decision: {
      ...decision,
      source: 'GEMINI_BACKTEST_CACHE',
      model: raw.model || null,
      generatedAt: raw.generatedAt || null,
      decisionId: raw.decisionId || cacheKey(raw.symbol, timestamp),
      stale: false,
      error: null,
    },
  };
}

function loadGeminiBacktestCache(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  const contents = fs.readFileSync(resolved, 'utf8');
  const values = parseJsonLines(contents);
  const metadata = values.find(value => value?.type === 'GEMINI_BACKTEST_META') || null;
  if (!metadata || Number(metadata.schemaVersion) !== CACHE_SCHEMA_VERSION) {
    throw new Error(`Unsupported or missing Gemini backtest cache metadata in ${resolved}`);
  }
  const records = values
    .map(value => validateRecord(value, options.minimumConfidence))
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
  const recordsBySymbol = new Map();
  for (const record of records) {
    const list = recordsBySymbol.get(record.symbol) || [];
    list.push(record);
    recordsBySymbol.set(record.symbol, list);
  }
  return {
    path: resolved,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    metadata,
    records,
    recordsBySymbol,
  };
}

function latestAtOrBefore(records, timestamp) {
  let low = 0;
  let high = records.length - 1;
  let match = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (records[middle].timestamp <= timestamp) {
      match = records[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}

function createGeminiReplay(cache, options = {}) {
  const maximumAgeMs = Math.max(1, Number(options.maximumAgeMs) || 120 * 60_000);
  return ({ symbol, timestamp }) => {
    const records = cache.recordsBySymbol.get(symbol) || [];
    const record = latestAtOrBefore(records, Number(timestamp));
    if (!record || Number(timestamp) - record.timestamp >= maximumAgeMs) return null;
    return record.decision;
  };
}

module.exports = {
  CACHE_PROMPT_VERSION,
  CACHE_SCHEMA_VERSION,
  cacheKey,
  createGeminiReplay,
  latestAtOrBefore,
  loadGeminiBacktestCache,
  parseJsonLines,
  validateRecord,
};
