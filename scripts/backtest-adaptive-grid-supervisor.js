#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  analyzeTimeframe,
  aggregateTimeframes,
} = require('../src/fibonacci-direction-analyzer');
const {
  PROFILES,
  AdaptiveGridSupervisor,
} = require('../src/adaptive-grid-supervisor');
const {
  applyConfirmation,
  completedIndex,
  resampleCandles,
} = require('./backtest-fibonacci-direction');

const MINUTE_MS = 60_000;
const BASE_TIMEFRAME_MS = 15 * MINUTE_MS;
const CANDLE_LIMIT = 100;
const FUTURE_4H_CANDLES = 16;
const FUTURE_24H_CANDLES = 96;
const DEFAULT_SYMBOLS = [
  '1000SHIB/USDT:USDT',
  '1000PEPE/USDT:USDT',
  '1000BONK/USDT:USDT',
  'PENGU/USDT:USDT',
  'JUP/USDT:USDT',
];

function safeName(symbol) {
  return symbol.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function parseDate(value, fallback) {
  if (!value) return fallback;
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid date: ${value}`);
  return result;
}

function createAccumulator() {
  return {
    samples: 0,
    transitions: 0,
    profiles: Object.fromEntries(Object.values(PROFILES).map(profile => [profile, {
      returns4h: [],
      returns24h: [],
      adverse24h: [],
      favorable24h: [],
      episodes: 0,
    }])),
    rawProfiles: Object.fromEntries(Object.values(PROFILES).map(profile => [profile, 0])),
  };
}

function addObservation(accumulator, decision, future) {
  accumulator.samples += 1;
  accumulator.rawProfiles[decision.rawProfile] += 1;
  const profile = accumulator.profiles[decision.profile];
  profile.returns4h.push(future.return4h);
  profile.returns24h.push(future.return24h);
  profile.adverse24h.push(future.adverse24h);
  profile.favorable24h.push(future.favorable24h);
  if (decision.changed) {
    accumulator.transitions += 1;
    profile.episodes += 1;
  }
}

function summarizeProfile(profile, totalSamples) {
  const count = profile.returns24h.length;
  return {
    samples: count,
    coveragePct: totalSamples ? round(count / totalSamples * 100, 2) : null,
    episodes: profile.episodes,
    meanReturn4hPct: round(mean(profile.returns4h) * 100),
    meanReturn24hPct: round(mean(profile.returns24h) * 100),
    medianReturn24hPct: round(percentile(profile.returns24h, 0.5) * 100),
    negative24hPct: count
      ? round(profile.returns24h.filter(value => value < 0).length / count * 100, 2)
      : null,
    meanAdverse24hPct: round(mean(profile.adverse24h) * 100),
    p10Adverse24hPct: round(percentile(profile.adverse24h, 0.1) * 100),
    meanFavorable24hPct: round(mean(profile.favorable24h) * 100),
  };
}

function summarizeAccumulator(accumulator, durationDays) {
  return {
    samples: accumulator.samples,
    transitions: accumulator.transitions,
    transitionsPer30Days: durationDays > 0 ? round(accumulator.transitions / durationDays * 30, 2) : null,
    profiles: Object.fromEntries(Object.entries(accumulator.profiles).map(([profile, values]) => [
      profile,
      summarizeProfile(values, accumulator.samples),
    ])),
    rawProfileCoveragePct: Object.fromEntries(Object.entries(accumulator.rawProfiles).map(([profile, count]) => [
      profile,
      accumulator.samples ? round(count / accumulator.samples * 100, 2) : null,
    ])),
  };
}

function mergeAccumulators(accumulators) {
  const merged = createAccumulator();
  for (const accumulator of accumulators) {
    merged.samples += accumulator.samples;
    merged.transitions += accumulator.transitions;
    for (const profile of Object.values(PROFILES)) {
      merged.rawProfiles[profile] += accumulator.rawProfiles[profile];
      merged.profiles[profile].returns4h.push(...accumulator.profiles[profile].returns4h);
      merged.profiles[profile].returns24h.push(...accumulator.profiles[profile].returns24h);
      merged.profiles[profile].adverse24h.push(...accumulator.profiles[profile].adverse24h);
      merged.profiles[profile].favorable24h.push(...accumulator.profiles[profile].favorable24h);
      merged.profiles[profile].episodes += accumulator.profiles[profile].episodes;
    }
  }
  return merged;
}

function futureOutcome(candles, index) {
  const currentClose = candles[index][4];
  const window = candles.slice(index + 1, index + 1 + FUTURE_24H_CANDLES);
  return {
    return4h: candles[index + FUTURE_4H_CANDLES][4] / currentClose - 1,
    return24h: candles[index + FUTURE_24H_CANDLES][4] / currentClose - 1,
    adverse24h: Math.min(...window.map(candle => candle[3])) / currentClose - 1,
    favorable24h: Math.max(...window.map(candle => candle[2])) / currentClose - 1,
  };
}

function backtestSymbol(symbol, rows, start, end, supervisorOptions = {}) {
  const candles1h = resampleCandles(rows, 60 * MINUTE_MS);
  const candles4h = resampleCandles(rows, 4 * 60 * MINUTE_MS);
  const supervisor = new AdaptiveGridSupervisor(supervisorOptions);
  const confirmation = { candidate: 'RANGING', count: 0 };
  const accumulator = createAccumulator();
  let index1h = -1;
  let index4h = -1;

  for (let index15m = 0; index15m < rows.length; index15m++) {
    const candle = rows[index15m];
    const evaluationTime = candle[0] + BASE_TIMEFRAME_MS;
    if (evaluationTime < start || evaluationTime >= end) continue;
    if (index15m + FUTURE_24H_CANDLES >= rows.length) break;
    index1h = completedIndex(candles1h, 60 * MINUTE_MS, evaluationTime, index1h);
    index4h = completedIndex(candles4h, 4 * 60 * MINUTE_MS, evaluationTime, index4h);
    if (index15m + 1 < CANDLE_LIMIT || index1h + 1 < CANDLE_LIMIT || index4h + 1 < CANDLE_LIMIT) continue;

    const timeframeResults = [
      analyzeTimeframe(rows.slice(index15m + 1 - CANDLE_LIMIT, index15m + 1), '15m'),
      analyzeTimeframe(candles1h.slice(index1h + 1 - CANDLE_LIMIT, index1h + 1), '1h'),
      analyzeTimeframe(candles4h.slice(index4h + 1 - CANDLE_LIMIT, index4h + 1), '4h'),
    ];
    if (timeframeResults.some(result => !result)) continue;
    const aggregate = aggregateTimeframes(timeframeResults);
    const confirmedDirection = applyConfirmation(aggregate, confirmation);
    const decision = supervisor.evaluate(symbol, {
      analysis: { ...aggregate, confirmedDirection },
      // Historical account exposure is unavailable, so this run evaluates market signals only.
      exposureRatio: 0.5,
      now: evaluationTime,
      signalId: candle[0],
    });
    addObservation(accumulator, decision, futureOutcome(rows, index15m));
  }
  return accumulator;
}

function loadCachedRows(cacheDirectory, symbol) {
  const prefix = `${safeName(symbol)}-15m-`;
  const candidates = fs.readdirSync(cacheDirectory)
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
  if (!candidates.length) throw new Error(`No cached 15m data for ${symbol} in ${cacheDirectory}`);
  return JSON.parse(fs.readFileSync(path.join(cacheDirectory, candidates.at(-1)), 'utf8'));
}

function policyChecks(summary) {
  const { BULLISH, SIDEWAYS, BEARISH, RISK_OFF } = summary.profiles;
  const defensive = [BEARISH, RISK_OFF].filter(profile => profile.samples > 0);
  const defensiveAdverse = defensive.length
    ? defensive.reduce((sum, profile) => sum + profile.meanAdverse24hPct * profile.samples, 0) /
      defensive.reduce((sum, profile) => sum + profile.samples, 0)
    : null;
  const defensiveReturn = defensive.length
    ? defensive.reduce((sum, profile) => sum + profile.meanReturn24hPct * profile.samples, 0) /
      defensive.reduce((sum, profile) => sum + profile.samples, 0)
    : null;
  return {
    defensiveProfilesFindDeeperDownside: Number.isFinite(defensiveAdverse) &&
      defensiveAdverse < SIDEWAYS.meanAdverse24hPct,
    defensiveProfilesFindLowerReturns: Number.isFinite(defensiveReturn) &&
      defensiveReturn < SIDEWAYS.meanReturn24hPct,
    riskOffStricterThanBearish: RISK_OFF.samples >= 100 &&
      RISK_OFF.meanAdverse24hPct < BEARISH.meanAdverse24hPct,
    bullishSeparatesFromBearish: BULLISH.samples > 0 && BEARISH.samples > 0 &&
      BULLISH.meanReturn24hPct > BEARISH.meanReturn24hPct,
  };
}

function renderMarkdown(report) {
  const lines = [
    '# Adaptive Grid Supervisor Shadow Backtest',
    '',
    `Period: ${report.period.start} to ${report.period.end}`,
    '',
    `Symbols: ${report.symbols.join(', ')}`,
    '',
    'This is a shadow policy test. It does not simulate grid fills, fees, funding, liquidation, or PnL.',
    'Historical account exposure is unavailable, so exposure is fixed at 50% and RISK_OFF is triggered by market conditions only.',
    '',
    '| Profile | Coverage | Mean return 4h | Mean return 24h | Negative after 24h | Mean adverse 24h | P10 adverse 24h | Transitions into profile |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const profile of Object.values(PROFILES)) {
    const item = report.aggregate.profiles[profile];
    lines.push(
      `| ${profile} | ${item.coveragePct}% | ${item.meanReturn4hPct}% | ${item.meanReturn24hPct}% | ` +
      `${item.negative24hPct}% | ${item.meanAdverse24hPct}% | ${item.p10Adverse24hPct}% | ${item.episodes} |`
    );
  }
  lines.push(
    '',
    `Transitions per pair per day: ${report.aggregate.transitionsPerPairPerDay}`,
    `Transitions per 30 days across all symbols: ${report.aggregate.transitionsPer30Days}`,
    ''
  );
  lines.push('## Out-of-sample checks', '');
  for (const [name, passed] of Object.entries(report.walkForward.test.checks)) {
    lines.push(`- ${passed ? 'PASS' : 'FAIL'}: ${name}`);
  }
  lines.push('', '## Per symbol', '');
  lines.push('| Symbol | Bullish 24h | Sideways 24h | Bearish 24h | Risk-off 24h | Transitions / 30d |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [symbol, summary] of Object.entries(report.perSymbol)) {
    lines.push(
      `| ${symbol} | ${summary.profiles.BULLISH.meanReturn24hPct}% | ` +
      `${summary.profiles.SIDEWAYS.meanReturn24hPct}% | ${summary.profiles.BEARISH.meanReturn24hPct}% | ` +
      `${summary.profiles.RISK_OFF.meanReturn24hPct}% | ${summary.transitionsPer30Days} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const projectRoot = process.cwd();
  const priorReportPath = path.join(projectRoot, 'backtest-results', 'fibonacci-direction-backtest.json');
  const priorReport = fs.existsSync(priorReportPath)
    ? JSON.parse(fs.readFileSync(priorReportPath, 'utf8'))
    : null;
  const defaultEnd = priorReport ? Date.parse(priorReport.period.end) : Date.now();
  const defaultStart = priorReport ? Date.parse(priorReport.period.start) : defaultEnd - 365 * 24 * 60 * MINUTE_MS;
  const start = parseDate(process.env.BACKTEST_START, defaultStart);
  const end = parseDate(process.env.BACKTEST_END, defaultEnd);
  const splitAt = start + Math.floor((end - start) / 2);
  const durationDays = (end - start) / (24 * 60 * MINUTE_MS);
  const halfDurationDays = durationDays / 2;
  const symbols = (process.env.BACKTEST_SYMBOLS || DEFAULT_SYMBOLS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
  const cacheDirectory = path.join(projectRoot, 'backtest-data', 'fibonacci-direction');
  const options = {
    minimumConfidence: 0.65,
    profileConfirmations: 3,
    cooldownMs: 120 * MINUTE_MS,
    riskExposureRatio: 0.9,
  };
  const full = {};
  const train = {};
  const test = {};

  for (const symbol of symbols) {
    console.log(`[SHADOW-BACKTEST] ${symbol}`);
    const rows = loadCachedRows(cacheDirectory, symbol);
    full[symbol] = backtestSymbol(symbol, rows, start, end, options);
    train[symbol] = backtestSymbol(symbol, rows, start, splitAt, options);
    test[symbol] = backtestSymbol(symbol, rows, splitAt, end, options);
  }

  const fullMerged = mergeAccumulators(Object.values(full));
  const trainMerged = mergeAccumulators(Object.values(train));
  const testMerged = mergeAccumulators(Object.values(test));
  const aggregate = summarizeAccumulator(fullMerged, durationDays);
  aggregate.transitionsPerPairPerDay = round(
    aggregate.transitionsPer30Days / 30 / Math.max(symbols.length, 1),
    2
  );
  const trainSummary = summarizeAccumulator(trainMerged, halfDurationDays);
  const testSummary = summarizeAccumulator(testMerged, halfDurationDays);
  const report = {
    generatedAt: new Date().toISOString(),
    period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    symbols,
    assumptions: {
      baseTimeframe: '15m',
      directionTimeframes: ['15m', '1h', '4h'],
      directionConfirmations: 2,
      profileConfirmations: 3,
      cooldownMinutes: 120,
      historicalExposurePct: 50,
      noLookahead: true,
      overlappingForwardWindows: true,
      scope: 'shadow policy classification; not grid PnL',
    },
    aggregate: { ...aggregate, checks: policyChecks(aggregate) },
    perSymbol: Object.fromEntries(Object.entries(full).map(([symbol, accumulator]) => [
      symbol,
      summarizeAccumulator(accumulator, durationDays),
    ])),
    walkForward: {
      train: {
        period: { start: new Date(start).toISOString(), end: new Date(splitAt).toISOString() },
        ...trainSummary,
        checks: policyChecks(trainSummary),
      },
      test: {
        period: { start: new Date(splitAt).toISOString(), end: new Date(end).toISOString() },
        ...testSummary,
        checks: policyChecks(testSummary),
      },
    },
    automationReady: false,
  };

  const resultsDirectory = path.join(projectRoot, 'backtest-results');
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const jsonPath = path.join(resultsDirectory, 'adaptive-grid-supervisor-shadow.json');
  const markdownPath = path.join(resultsDirectory, 'adaptive-grid-supervisor-shadow.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(report));
  console.log(renderMarkdown(report));
  console.log(`[SHADOW-BACKTEST] JSON: ${jsonPath}`);
  console.log(`[SHADOW-BACKTEST] Markdown: ${markdownPath}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[SHADOW-BACKTEST] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  addObservation,
  backtestSymbol,
  createAccumulator,
  futureOutcome,
  mergeAccumulators,
  policyChecks,
  summarizeAccumulator,
};
