#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester, DEFAULT_OPTIONS } = require('../src/full-grid-backtester');
const {
  classificationWithMonitor,
} = require('../src/adaptive-grid-supervisor');
const {
  DEFAULT_POLICY,
  buildPolicyCandidate,
} = require('../src/adaptive-supervisor-learner');
const {
  createGeminiReplay,
  loadGeminiBacktestCache,
} = require('../src/backtest-gemini-cache');
const {
  aggregate,
  comparison,
  fetchFundingRates,
  loadCachedRows,
} = require('./backtest-full-grid-pnl');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const DAY_MS = 86_400_000;
const BASE_TIMEFRAME_MS = 15 * 60_000;
const DEFAULT_SYMBOLS = [
  '1000SHIB/USDT:USDT',
  '1000PEPE/USDT:USDT',
  '1000BONK/USDT:USDT',
  'PENGU/USDT:USDT',
  'JUP/USDT:USDT',
];
const VARIANTS = Object.freeze([
  'baseline',
  'adaptiveDeterministic',
  'adaptiveGemini',
  'adaptiveLearned',
]);

function parseDate(value, fallback) {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function findCandleIndex(rows, evaluationTimestamp) {
  let low = 0;
  let high = rows.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const timestamp = rows[middle][0] + BASE_TIMEFRAME_MS;
    if (timestamp === evaluationTimestamp) return middle;
    if (timestamp < evaluationTimestamp) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

function learningEvents(cache, rowsBySymbol, start, end, options = {}) {
  const horizonCandles = Math.round((Number(options.horizonHours) || 4) * 60 / 15);
  const events = [];
  for (const record of cache.records) {
    if (record.timestamp < start || record.timestamp >= end || !record.analysis) continue;
    const rows = rowsBySymbol[record.symbol];
    if (!rows) continue;
    const index = findCandleIndex(rows, record.timestamp);
    if (index < 0 || index + horizonCandles >= rows.length) continue;
    const baselinePrice = rows[index][4];
    const returnPct = (rows[index + horizonCandles][4] / baselinePrice - 1) * 100;
    const classified = classificationWithMonitor(record.analysis, 0.5, {
      minimumConfidence: options.minimumConfidence || 0.65,
      riskExposureRatio: options.riskExposureRatio || 0.9,
      learningPolicy: DEFAULT_POLICY,
    }, record.decision);
    const key = `${record.symbol}:${record.timestamp}`;
    events.push({
      type: 'SUPERVISOR_DECISION',
      key,
      symbol: record.symbol,
      observedAtMs: record.timestamp,
      recordedAt: new Date(record.timestamp).toISOString(),
      supervisor: {
        profile: classified.profile,
        deterministicProfile: classified.deterministicProfile,
        decisionSource: classified.source,
      },
      gemini: {
        accepted: record.decision.accepted,
        profile: record.decision.profile,
        confidence: record.decision.confidence,
      },
    });
    events.push({
      type: 'SUPERVISOR_OUTCOME',
      key,
      symbol: record.symbol,
      horizonHours: Number(options.horizonHours) || 4,
      returnPct,
    });
  }
  return events;
}

function trainLearningPolicy(cache, rowsBySymbol, start, splitAt, options = {}) {
  const events = learningEvents(cache, rowsBySymbol, start, splitAt, options);
  const candidate = buildPolicyCandidate(events, DEFAULT_POLICY, {
    minimumEpisodes: Number(options.minimumEpisodes) || 60,
    validationRatio: Number(options.validationRatio) || 0.3,
    minimumValidationEpisodes: Number(options.minimumValidationEpisodes) || 15,
    minimumBucketEpisodes: Number(options.minimumBucketEpisodes) || 10,
    minimumValidationAccuracy: Number(options.minimumValidationAccuracy) || 0.6,
    minimumImprovement: options.minimumImprovement === undefined
      ? 0.05
      : Number(options.minimumImprovement),
    horizonHours: Number(options.horizonHours) || 4,
    episodeGapMinutes: Number(options.episodeGapMinutes) || 120,
    moveThresholdPct: Number(options.moveThresholdPct) || 0.5,
  });
  const policy = candidate.eligible
    ? {
      schemaVersion: 1,
      version: `backtest-learned-${new Date(splitAt).toISOString()}`,
      source: 'BACKTEST_TRAIN_ONLY',
      generatedAt: new Date(splitAt).toISOString(),
      ...candidate.policy,
    }
    : { ...DEFAULT_POLICY };
  return { events: events.length, candidate, policy };
}

function simulateVariants(simulator, input, replay, learnedPolicy, learnedFrom) {
  return {
    baseline: simulator.simulate({ ...input, adaptive: false, variant: 'baseline' }),
    adaptiveDeterministic: simulator.simulate({
      ...input,
      adaptive: true,
      variant: 'adaptive-deterministic',
    }),
    adaptiveGemini: simulator.simulate({
      ...input,
      adaptive: true,
      monitorDecisionProvider: replay,
      learningPolicyProvider: () => DEFAULT_POLICY,
      variant: 'adaptive-gemini',
    }),
    adaptiveLearned: simulator.simulate({
      ...input,
      adaptive: true,
      monitorDecisionProvider: replay,
      learningPolicyProvider: ({ timestamp }) => timestamp >= learnedFrom ? learnedPolicy : DEFAULT_POLICY,
      variant: 'adaptive-learned',
    }),
  };
}

function aggregateScope(scope, symbols, options) {
  scope.aggregate = Object.fromEntries(VARIANTS.map(variant => [
    variant,
    aggregate(symbols.map(symbol => scope.perSymbol[symbol][variant]), options),
  ]));
  scope.comparison = Object.fromEntries(VARIANTS.slice(1).map(variant => [
    variant,
    comparison(scope.aggregate.baseline, scope.aggregate[variant]),
  ]));
}

function format(value, suffix = '') {
  return value === null || value === undefined ? 'n/a' : `${value}${suffix}`;
}

function renderMarkdown(report) {
  const labels = {
    baseline: 'baseline',
    adaptiveDeterministic: 'adaptive deterministic',
    adaptiveGemini: 'adaptive + Gemini cache',
    adaptiveLearned: 'adaptive + learned policy',
  };
  const lines = [
    '# Adaptive Variants Full-grid Backtest',
    '',
    `Period: ${report.period.start} to ${report.period.end}`,
    '',
    `Train/test split: ${report.period.splitAt}`,
    '',
    `Symbols: ${report.symbols.join(', ')}`,
    '',
    `Gemini cache SHA-256: \`${report.geminiCache.sha256}\``,
    '',
    '| Scope | Variant | Net liquidation PnL | Return / notional | Fees | Funding | Grid cycles | Sum max DD |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scope of ['full', 'outOfSample']) {
    for (const variant of VARIANTS) {
      const item = report[scope].aggregate[variant];
      lines.push(
        `| ${scope === 'full' ? 'Full period' : 'Out-of-sample'} | ${labels[variant]} | ` +
        `${format(item.netLiquidationPnl, ' USDT')} | ${format(item.returnOnNotionalPct, '%')} | ` +
        `${format(item.fees, ' USDT')} | ${format(item.fundingPnl, ' USDT')} | ${item.gridCycles} | ` +
        `${format(item.sumOfPerSymbolMaximumDrawdowns, ' USDT')} |`
      );
    }
  }
  lines.push('', '## Out-of-sample differences versus baseline', '');
  for (const variant of VARIANTS.slice(1)) {
    const item = report.outOfSample.comparison[variant];
    lines.push(`- ${labels[variant]}: PnL ${item.netPnlDelta} USDT; drawdown ${item.drawdownDelta} USDT (negative is better).`);
  }
  lines.push(
    '',
    '## Out-of-sample PnL per symbol',
    '',
    '| Symbol | Baseline | Deterministic | Gemini | Learned |',
    '|---|---:|---:|---:|---:|'
  );
  for (const symbol of report.symbols) {
    const item = report.outOfSample.perSymbol[symbol];
    lines.push(
      `| ${symbol} | ${item.baseline.netLiquidationPnl} | ` +
      `${item.adaptiveDeterministic.netLiquidationPnl} | ${item.adaptiveGemini.netLiquidationPnl} | ` +
      `${item.adaptiveLearned.netLiquidationPnl} |`
    );
  }
  lines.push(
    '',
    '## Learned policy',
    '',
    `- Status: ${report.learning.candidate.status}.`,
    `- Eligible: ${report.learning.candidate.eligible}.`,
    `- Episodes: ${report.learning.candidate.episodes}.`,
    `- Policy used after split: aligned >= ${report.learning.policy.alignedMinConfidence}; conflict >= ${report.learning.policy.conflictMinConfidence}.`,
    `- Validation accuracy: active ${report.learning.candidate.validation?.active?.accuracy ?? 'n/a'}; candidate ${report.learning.candidate.validation?.candidate?.accuracy ?? 'n/a'}.`,
    `- Reasons: ${(report.learning.candidate.reasons || []).join(', ') || 'none'}.`,
    '',
    '## Assumptions and limitations',
    ''
  );
  for (const assumption of report.assumptions) lines.push(`- ${assumption}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const projectRoot = process.cwd();
  const symbols = (process.env.BACKTEST_SYMBOLS || process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  const dataDirectory = path.join(projectRoot, 'backtest-data', 'fibonacci-direction');
  const fundingDirectory = path.join(projectRoot, 'backtest-data', 'funding');
  const resultsDirectory = path.join(projectRoot, 'backtest-results');
  const cachePath = path.resolve(
    process.env.BACKTEST_GEMINI_CACHE || 'backtest-data/gemini-adaptive-decisions.jsonl'
  );
  const cache = loadGeminiBacktestCache(cachePath, { minimumConfidence: 0.6 });
  const rowsBySymbol = Object.fromEntries(symbols.map(symbol => [symbol, loadCachedRows(dataDirectory, symbol)]));
  const commonAvailableEnd = Math.min(...symbols.map(symbol => rowsBySymbol[symbol].at(-1)[0] + BASE_TIMEFRAME_MS));
  const end = parseDate(process.env.BACKTEST_END, Math.min(Date.now(), commonAvailableEnd));
  const start = parseDate(process.env.BACKTEST_START, end - 365 * DAY_MS);
  if (!(start < end)) throw new Error('BACKTEST_START must be before BACKTEST_END');
  const splitAt = start + Math.floor((end - start) / 2);
  const intervalMinutes = Number(cache.metadata.intervalMinutes) || 120;
  const replay = createGeminiReplay(cache, { maximumAgeMs: intervalMinutes * 60_000 + 1 });
  const learning = trainLearningPolicy(cache, rowsBySymbol, start, splitAt, {
    minimumEpisodes: Number(process.env.ADAPTIVE_SUPERVISOR_LEARNING_MIN_EPISODES) || 60,
    validationRatio: Number(process.env.ADAPTIVE_SUPERVISOR_LEARNING_VALIDATION_RATIO) || 0.3,
    minimumValidationEpisodes: Number(process.env.ADAPTIVE_SUPERVISOR_LEARNING_MIN_VALIDATION_EPISODES) || 15,
    minimumBucketEpisodes: Number(process.env.ADAPTIVE_SUPERVISOR_LEARNING_MIN_BUCKET_EPISODES) || 10,
    minimumValidationAccuracy: Number(process.env.ADAPTIVE_SUPERVISOR_LEARNING_MIN_ACCURACY) || 0.6,
    minimumImprovement: Number(process.env.ADAPTIVE_SUPERVISOR_LEARNING_MIN_IMPROVEMENT) || 0.05,
    horizonHours: Number(process.env.ADAPTIVE_SUPERVISOR_LEARNING_HORIZON_HOURS) || 4,
    episodeGapMinutes: Number(process.env.ADAPTIVE_SUPERVISOR_LEARNING_EPISODE_GAP_MINUTES) || 120,
    moveThresholdPct: Number(process.env.ADAPTIVE_SUPERVISOR_LEARNING_MOVE_THRESHOLD_PCT) || 0.5,
  });
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  const options = {
    ...DEFAULT_OPTIONS,
    gridCount: Number(process.env.GRID_COUNT) || 27,
    totalInvestment: Number(process.env.GRID_TOTAL_INVESTMENT_USDT) || 150,
    leverage: Number(process.env.LEVERAGE) || 5,
    maxActiveBuyOrders: Number(process.env.GRID_MAX_ACTIVE_BUY_ORDERS) || 20,
    maxRefills: Number(process.env.GRID_MAX_REFILLS) || 2,
    makerFeeRate: Number(process.env.BINANCE_FUTURES_MAKER_FEE_RATE) || 0.0002,
    minimumNetProfitPct: Number(process.env.GRID_MIN_NET_PROFIT_PCT) || 0.05,
  };
  const full = { perSymbol: {} };
  const outOfSample = { perSymbol: {} };
  try {
    for (const symbol of symbols) {
      const rows = rowsBySymbol[symbol];
      if (rows[0][0] > start || rows.at(-1)[0] + BASE_TIMEFRAME_MS < end) {
        throw new Error(`${symbol} candle cache does not cover requested period`);
      }
      const symbolCache = cache.recordsBySymbol.get(symbol) || [];
      if (!symbolCache.some(record => record.timestamp <= start + intervalMinutes * 60_000) ||
          !symbolCache.some(record => record.timestamp >= end - intervalMinutes * 60_000)) {
        throw new Error(`${symbol} Gemini cache does not cover requested period`);
      }
      console.log(`[BACKTEST] ${symbol}: simulating four variants`);
      const fundingRates = await fetchFundingRates(exchange, symbol, start, end, fundingDirectory);
      const minimumNotional = Number(exchange.market(symbol)?.limits?.cost?.min) || 5;
      const simulator = new FullGridBacktester(exchange, { ...options, minimumNotional });
      full.perSymbol[symbol] = simulateVariants(
        simulator,
        { symbol, rows, fundingRates, start, end },
        replay,
        learning.policy,
        splitAt
      );
      outOfSample.perSymbol[symbol] = simulateVariants(
        simulator,
        { symbol, rows, fundingRates, start: splitAt, end },
        replay,
        learning.policy,
        splitAt
      );
    }
  } finally {
    await exchange.close();
  }
  aggregateScope(full, symbols, options);
  aggregateScope(outOfSample, symbols, options);
  const report = {
    generatedAt: new Date().toISOString(),
    period: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      splitAt: new Date(splitAt).toISOString(),
    },
    symbols,
    configuration: options,
    geminiCache: {
      path: path.relative(projectRoot, cache.path),
      sha256: cache.sha256,
      records: cache.records.length,
      metadata: cache.metadata,
    },
    learning,
    assumptions: [
      'Gemini decisions are replayed from an immutable local cache; the PnL run never calls Gemini.',
      `Gemini snapshots are sampled every ${intervalMinutes} minutes with fixed ${cache.metadata.fixedExposurePct}% exposure so the cache is independent of each simulation path.`,
      'Actual simulated exposure still reaches the deterministic Supervisor safety rule and can force RISK_OFF.',
      'The learned policy is trained only on the first half and becomes active at the train/test split.',
      'If the learning candidate fails the configured promotion gates, adaptive + learned policy uses the default policy.',
      '15-minute OHLC candles cannot reproduce queue position, slippage, latency, rejected post-only orders, or exact intrabar sequencing.',
      'Liquidation and maintenance-margin tiers are not simulated.',
    ],
    full,
    outOfSample,
  };
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const jsonPath = path.join(resultsDirectory, 'adaptive-variants-full-grid-backtest.json');
  const markdownPath = path.join(resultsDirectory, 'adaptive-variants-full-grid-backtest.md');
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
  aggregateScope,
  learningEvents,
  renderMarkdown,
  simulateVariants,
  trainLearningPolicy,
};
