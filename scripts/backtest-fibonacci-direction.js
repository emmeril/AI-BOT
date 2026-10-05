#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const {
  analyzeTimeframe,
  aggregateTimeframes,
} = require('../src/fibonacci-direction-analyzer');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const MINUTE_MS = 60_000;
const BASE_TIMEFRAME = '15m';
const BASE_TIMEFRAME_MS = 15 * MINUTE_MS;
const DEFAULT_HISTORY_DAYS = 365;
const WARMUP_DAYS = 21;
const CANDLE_LIMIT = 100;
const CONFIRMATIONS = 2;
const MIN_CONFIDENCE = 0.65;
const DEFAULT_SYMBOLS = [
  '1000SHIB/USDT:USDT',
  '1000PEPE/USDT:USDT',
  '1000BONK/USDT:USDT',
  'PENGU/USDT:USDT',
  'JUP/USDT:USDT',
];
const VARIANTS = [
  { key: 'current', label: 'Current: confidence only', minimumAlignment: 0 },
  { key: 'align_055', label: 'Alignment >= 0.55', minimumAlignment: 0.55 },
  { key: 'align_060', label: 'Alignment >= 0.60', minimumAlignment: 0.60 },
  { key: 'align_067', label: 'Alignment >= 0.67', minimumAlignment: 0.67 },
  { key: 'align_075', label: 'Alignment >= 0.75', minimumAlignment: 0.75 },
  { key: 'consensus_4h_plus_one', label: 'Consensus: 4h + one lower timeframe', consensus: true },
];

function parseDate(value, fallback) {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function safeName(symbol) {
  return symbol.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index];
}

function normalizeRow(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const normalized = row.slice(0, 6).map(Number);
  if (!normalized.every(Number.isFinite) || !(normalized[2] >= normalized[3]) || !(normalized[3] > 0)) {
    return null;
  }
  return normalized;
}

function resampleCandles(rows, timeframeMs) {
  const expected = Math.round(timeframeMs / BASE_TIMEFRAME_MS);
  const buckets = new Map();
  for (const raw of rows) {
    const row = normalizeRow(raw);
    if (!row) continue;
    const [timestamp, open, high, low, close, volume] = row;
    const bucketStart = Math.floor(timestamp / timeframeMs) * timeframeMs;
    const existing = buckets.get(bucketStart);
    if (!existing) {
      buckets.set(bucketStart, [bucketStart, open, high, low, close, volume, 1]);
      continue;
    }
    existing[2] = Math.max(existing[2], high);
    existing[3] = Math.min(existing[3], low);
    existing[4] = close;
    existing[5] += volume;
    existing[6] += 1;
  }
  return [...buckets.values()]
    .filter(row => row[6] === expected)
    .sort((a, b) => a[0] - b[0])
    .map(row => row.slice(0, 6));
}

async function fetchCandles(exchange, symbol, since, until, cacheDirectory) {
  const cachePath = path.join(
    cacheDirectory,
    `${safeName(symbol)}-${BASE_TIMEFRAME}-${new Date(since).toISOString().slice(0, 10)}-${new Date(until).toISOString().slice(0, 10)}.json`
  );
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }

  const rowsByTimestamp = new Map();
  let cursor = since;
  while (cursor < until) {
    let batch;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        batch = await exchange.fetchOHLCV(symbol, BASE_TIMEFRAME, cursor, 1500);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
    if (!Array.isArray(batch) || !batch.length) break;
    for (const raw of batch) {
      const row = normalizeRow(raw);
      if (row && row[0] >= since && row[0] < until) rowsByTimestamp.set(row[0], row);
    }
    const lastTimestamp = Number(batch.at(-1)?.[0]);
    if (!Number.isFinite(lastTimestamp) || lastTimestamp < cursor) break;
    cursor = lastTimestamp + BASE_TIMEFRAME_MS;
    const progress = Math.min(100, ((cursor - since) / (until - since)) * 100);
    process.stdout.write(`\r[DATA] ${symbol} ${progress.toFixed(1)}%`);
    if (batch.length < 2 && cursor < until) break;
  }
  process.stdout.write('\n');
  const rows = [...rowsByTimestamp.values()].sort((a, b) => a[0] - b[0]);
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(rows));
  return rows;
}

function completedIndex(rows, timeframeMs, evaluationTime, currentIndex) {
  let index = currentIndex;
  while (index + 1 < rows.length && rows[index + 1][0] + timeframeMs <= evaluationTime) index++;
  return index;
}

function applyConfirmation(aggregate, state) {
  const candidate = ['BULLISH', 'BEARISH'].includes(aggregate.direction)
    ? aggregate.direction
    : 'RANGING';
  if (candidate === 'RANGING') {
    state.candidate = 'RANGING';
    state.count = 0;
    return 'RANGING';
  }
  if (state.candidate === candidate) state.count++;
  else {
    state.candidate = candidate;
    state.count = 1;
  }
  return state.count >= CONFIRMATIONS ? candidate : 'RANGING';
}

function directionForVariant(variant, aggregate, confirmedDirection) {
  if (!['BULLISH', 'BEARISH'].includes(confirmedDirection)) return 'RANGING';
  if (aggregate.confidence < MIN_CONFIDENCE) return 'RANGING';
  if (variant.consensus) {
    const sameHigherTimeframe = aggregate.timeframes['4h']?.direction === confirmedDirection;
    const sameLowerTimeframe = ['15m', '1h']
      .some(timeframe => aggregate.timeframes[timeframe]?.direction === confirmedDirection);
    return sameHigherTimeframe && sameLowerTimeframe ? confirmedDirection : 'RANGING';
  }
  return aggregate.alignment >= variant.minimumAlignment ? confirmedDirection : 'RANGING';
}

function createAccumulator() {
  return {
    samples: 0,
    bullish: { returns4h: [], returns24h: [] },
    bearish: { returns4h: [], returns24h: [] },
    ranging: 0,
    episodes: [],
    lastDirection: 'RANGING',
  };
}

function addObservation(accumulator, direction, return4h, return24h, timestamp) {
  accumulator.samples++;
  if (direction === 'RANGING') accumulator.ranging++;
  else {
    accumulator[direction.toLowerCase()].returns4h.push(return4h);
    accumulator[direction.toLowerCase()].returns24h.push(return24h);
  }
  if (direction !== 'RANGING' && direction !== accumulator.lastDirection) {
    accumulator.episodes.push({ direction, timestamp, return4h, return24h });
  }
  accumulator.lastDirection = direction;
}

function summarizeReturns(values, expectedSign) {
  const correct = values.filter(value => expectedSign > 0 ? value > 0 : value < 0).length;
  return {
    count: values.length,
    accuracyPct: values.length ? round(correct / values.length * 100, 2) : null,
    meanPct: round(mean(values) * 100, 4),
    medianPct: round(median(values) * 100, 4),
    p10Pct: round(percentile(values, 0.1) * 100, 4),
    p90Pct: round(percentile(values, 0.9) * 100, 4),
  };
}

function summarizeAccumulator(accumulator) {
  const bullish4h = summarizeReturns(accumulator.bullish.returns4h, 1);
  const bearish4h = summarizeReturns(accumulator.bearish.returns4h, -1);
  const bullish24h = summarizeReturns(accumulator.bullish.returns24h, 1);
  const bearish24h = summarizeReturns(accumulator.bearish.returns24h, -1);
  const directionalCount = bullish4h.count + bearish4h.count;
  const correct4h = bullish4h.count * (bullish4h.accuracyPct || 0) / 100 +
    bearish4h.count * (bearish4h.accuracyPct || 0) / 100;
  const correct24h = bullish24h.count * (bullish24h.accuracyPct || 0) / 100 +
    bearish24h.count * (bearish24h.accuracyPct || 0) / 100;
  const episode4h = accumulator.episodes.map(item => item.direction === 'BULLISH' ? item.return4h : -item.return4h);
  const episode24h = accumulator.episodes.map(item => item.direction === 'BULLISH' ? item.return24h : -item.return24h);
  return {
    samples: accumulator.samples,
    directionalSamples: directionalCount,
    coveragePct: accumulator.samples ? round(directionalCount / accumulator.samples * 100, 2) : null,
    rangingSamples: accumulator.ranging,
    combinedAccuracy4hPct: directionalCount ? round(correct4h / directionalCount * 100, 2) : null,
    combinedAccuracy24hPct: directionalCount ? round(correct24h / directionalCount * 100, 2) : null,
    bullish: { horizon4h: bullish4h, horizon24h: bullish24h },
    bearish: { horizon4h: bearish4h, horizon24h: bearish24h },
    episodes: {
      count: accumulator.episodes.length,
      accuracy4hPct: episode4h.length ? round(episode4h.filter(value => value > 0).length / episode4h.length * 100, 2) : null,
      accuracy24hPct: episode24h.length ? round(episode24h.filter(value => value > 0).length / episode24h.length * 100, 2) : null,
      meanDirectionalReturn4hPct: round(mean(episode4h) * 100, 4),
      meanDirectionalReturn24hPct: round(mean(episode24h) * 100, 4),
    },
  };
}

function mergeSummaries(perSymbol, key) {
  const merged = createAccumulator();
  for (const symbolData of Object.values(perSymbol)) {
    const source = symbolData.raw[key];
    merged.samples += source.samples;
    merged.ranging += source.ranging;
    merged.bullish.returns4h.push(...source.bullish.returns4h);
    merged.bullish.returns24h.push(...source.bullish.returns24h);
    merged.bearish.returns4h.push(...source.bearish.returns4h);
    merged.bearish.returns24h.push(...source.bearish.returns24h);
    merged.episodes.push(...source.episodes);
  }
  return summarizeAccumulator(merged);
}

function backtestSymbolWithRaw(symbol, rows, start, end) {
  const candles15m = rows;
  const candles1h = resampleCandles(rows, 60 * MINUTE_MS);
  const candles4h = resampleCandles(rows, 4 * 60 * MINUTE_MS);
  const raw = Object.fromEntries(VARIANTS.map(variant => [variant.key, createAccumulator()]));
  const confirmation = { candidate: 'RANGING', count: 0 };
  let index1h = -1;
  let index4h = -1;

  for (let index15m = 0; index15m < candles15m.length; index15m++) {
    const candle = candles15m[index15m];
    const evaluationTime = candle[0] + BASE_TIMEFRAME_MS;
    if (evaluationTime < start || evaluationTime >= end) continue;
    if (index15m + 96 >= candles15m.length) break;
    index1h = completedIndex(candles1h, 60 * MINUTE_MS, evaluationTime, index1h);
    index4h = completedIndex(candles4h, 4 * 60 * MINUTE_MS, evaluationTime, index4h);
    if (index15m + 1 < CANDLE_LIMIT || index1h + 1 < CANDLE_LIMIT || index4h + 1 < CANDLE_LIMIT) continue;
    const timeframeResults = [
      analyzeTimeframe(candles15m.slice(index15m + 1 - CANDLE_LIMIT, index15m + 1), '15m'),
      analyzeTimeframe(candles1h.slice(index1h + 1 - CANDLE_LIMIT, index1h + 1), '1h'),
      analyzeTimeframe(candles4h.slice(index4h + 1 - CANDLE_LIMIT, index4h + 1), '4h'),
    ];
    if (timeframeResults.some(result => !result)) continue;
    const aggregate = aggregateTimeframes(timeframeResults);
    const confirmedDirection = applyConfirmation(aggregate, confirmation);
    const currentClose = candle[4];
    const return4h = candles15m[index15m + 16][4] / currentClose - 1;
    const return24h = candles15m[index15m + 96][4] / currentClose - 1;
    for (const variant of VARIANTS) {
      addObservation(
        raw[variant.key],
        directionForVariant(variant, aggregate, confirmedDirection),
        return4h,
        return24h,
        candle[0]
      );
    }
  }
  return {
    symbol,
    candles: rows.length,
    raw,
    summary: Object.fromEntries(Object.entries(raw).map(([key, accumulator]) => [key, summarizeAccumulator(accumulator)])),
  };
}

function renderMarkdown(report) {
  const lines = [
    '# Fibonacci Direction Backtest',
    '',
    `Period: ${report.period.start} to ${report.period.end}`,
    '',
    `Symbols: ${report.symbols.join(', ')}`,
    '',
    'This report evaluates direction classification only. It does not claim full grid PnL, liquidation, or intrabar execution accuracy.',
    '',
    '| Variant | Coverage | Accuracy 4h | Accuracy 24h | Episodes | Episode accuracy 24h |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const variant of VARIANTS) {
    const result = report.aggregate[variant.key];
    lines.push(
      `| ${variant.label} | ${result.coveragePct ?? 'N/A'}% | ${result.combinedAccuracy4hPct ?? 'N/A'}% | ` +
      `${result.combinedAccuracy24hPct ?? 'N/A'}% | ${result.episodes.count} | ${result.episodes.accuracy24hPct ?? 'N/A'}% |`
    );
  }
  lines.push('', '## Walk-forward split', '');
  lines.push(`Train: ${report.walkForward.train.period.start} to ${report.walkForward.train.period.end}`);
  lines.push(`Test: ${report.walkForward.test.period.start} to ${report.walkForward.test.period.end}`, '');
  lines.push('| Variant | Train accuracy 24h | Test accuracy 24h | Train coverage | Test coverage |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const variant of VARIANTS) {
    const train = report.walkForward.train.aggregate[variant.key];
    const test = report.walkForward.test.aggregate[variant.key];
    lines.push(
      `| ${variant.label} | ${train.combinedAccuracy24hPct ?? 'N/A'}% | ${test.combinedAccuracy24hPct ?? 'N/A'}% | ` +
      `${train.coveragePct ?? 'N/A'}% | ${test.coveragePct ?? 'N/A'}% |`
    );
  }
  lines.push('', '## Per symbol', '');
  for (const [symbol, data] of Object.entries(report.perSymbol)) {
    lines.push(`### ${symbol}`, '', '| Variant | Coverage | Accuracy 4h | Accuracy 24h |', '|---|---:|---:|---:|');
    for (const variant of VARIANTS) {
      const result = data[variant.key];
      lines.push(`| ${variant.label} | ${result.coveragePct ?? 'N/A'}% | ${result.combinedAccuracy4hPct ?? 'N/A'}% | ${result.combinedAccuracy24hPct ?? 'N/A'}% |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const end = parseDate(process.env.BACKTEST_END, Date.now());
  const historyDays = Math.max(30, Number(process.env.BACKTEST_HISTORY_DAYS) || DEFAULT_HISTORY_DAYS);
  const start = parseDate(process.env.BACKTEST_START, end - historyDays * 24 * 60 * MINUTE_MS);
  const fetchStart = start - WARMUP_DAYS * 24 * 60 * MINUTE_MS;
  const symbols = (process.env.BACKTEST_SYMBOLS || process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  const cacheDirectory = path.resolve(process.cwd(), 'backtest-data', 'fibonacci-direction');
  const resultsDirectory = path.resolve(process.cwd(), 'backtest-results');
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  const detailed = {};
  const splitAt = start + Math.floor((end - start) / 2);
  const walkForwardDetailed = { train: {}, test: {} };

  for (const symbol of symbols) {
    console.log(`[BACKTEST] Loading ${symbol}`);
    const rows = await fetchCandles(exchange, symbol, fetchStart, end + 24 * 60 * MINUTE_MS, cacheDirectory);
    console.log(`[BACKTEST] ${symbol} candles=${rows.length}`);
    detailed[symbol] = backtestSymbolWithRaw(symbol, rows, start, end);
    walkForwardDetailed.train[symbol] = backtestSymbolWithRaw(symbol, rows, start, splitAt);
    walkForwardDetailed.test[symbol] = backtestSymbolWithRaw(symbol, rows, splitAt, end);
  }
  await exchange.close();

  const report = {
    generatedAt: new Date().toISOString(),
    period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    assumptions: {
      baseTimeframe: BASE_TIMEFRAME,
      candleLimit: CANDLE_LIMIT,
      confirmations: CONFIRMATIONS,
      minimumConfidence: MIN_CONFIDENCE,
      forwardHorizons: ['4h', '24h'],
      noLookahead: true,
      scope: 'direction classification; not full grid execution PnL',
    },
    symbols,
    aggregate: Object.fromEntries(VARIANTS.map(variant => [variant.key, mergeSummaries(detailed, variant.key)])),
    perSymbol: Object.fromEntries(Object.entries(detailed).map(([symbol, data]) => [symbol, data.summary])),
    walkForward: {
      train: {
        period: { start: new Date(start).toISOString(), end: new Date(splitAt).toISOString() },
        aggregate: Object.fromEntries(VARIANTS.map(variant => [
          variant.key,
          mergeSummaries(walkForwardDetailed.train, variant.key),
        ])),
      },
      test: {
        period: { start: new Date(splitAt).toISOString(), end: new Date(end).toISOString() },
        aggregate: Object.fromEntries(VARIANTS.map(variant => [
          variant.key,
          mergeSummaries(walkForwardDetailed.test, variant.key),
        ])),
      },
    },
  };

  fs.mkdirSync(resultsDirectory, { recursive: true });
  const jsonPath = path.join(resultsDirectory, 'fibonacci-direction-backtest.json');
  const markdownPath = path.join(resultsDirectory, 'fibonacci-direction-backtest.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(report));
  console.log(renderMarkdown(report));
  console.log(`[BACKTEST] JSON: ${jsonPath}`);
  console.log(`[BACKTEST] Markdown: ${markdownPath}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[BACKTEST] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  VARIANTS,
  applyConfirmation,
  backtestSymbolWithRaw,
  completedIndex,
  directionForVariant,
  normalizeRow,
  resampleCandles,
  summarizeAccumulator,
};
