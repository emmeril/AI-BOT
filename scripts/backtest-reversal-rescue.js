#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const dotenv = require('dotenv');
const { FullGridBacktester } = require('../src/full-grid-backtester');
const { aggregate, fetchFundingRates } = require('./backtest-full-grid-pnl');
const { cachedRows } = require('./backtest-exit-targets');
const { buildIndicatorMap } = require('./backtest-fibonacci-entry-filters');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.futures', quiet: true });

const REFERENCE_PATH = path.resolve('backtest-results/scalping-volume-delta-backtest.json');
const FUNDING_DIRECTORY = path.resolve('backtest-data/funding');
const RESULTS_DIRECTORY = path.resolve('backtest-results');
const SYMBOLS = ['1000SHIB/USDT:USDT', '1000BONK/USDT:USDT'];
const WALLET_BALANCE_USDT = 92.11767654;
const LEVERAGE = 5;
const BASE_SYMBOL_CAP_USDT = 20.66;
const RESCUE_NOTIONAL_USDT = Math.round(WALLET_BALANCE_USDT * 0.05 * LEVERAGE * 100) / 100;
const HOUR_MS = 60 * 60_000;
const PROFIT_BANK_RESERVE_USDT = 0.05;

const RESCUE_OPTIONS = Object.freeze({
  controlledHandoff: true,
  handoffMinimumNetProfitPct: 0.05,
  handoffRescueNotionalUsdt: RESCUE_NOTIONAL_USDT,
});

const VARIANTS = Object.freeze({
  handoff: {
    controlledHandoff: true,
    handoffMinimumNetProfitPct: 0.05,
    handoffRescueNotionalUsdt: 0,
  },
  rescue_once: {
    ...RESCUE_OPTIONS,
  },
  bank_12h_50: {
    ...RESCUE_OPTIONS,
    handoffProfitBankExitEnabled: true,
    handoffProfitBankActivationMs: 12 * HOUR_MS,
    handoffProfitBankExitFraction: 0.5,
    handoffProfitBankReserveUsdt: PROFIT_BANK_RESERVE_USDT,
  },
  bank_24h_25: {
    ...RESCUE_OPTIONS,
    handoffProfitBankExitEnabled: true,
    handoffProfitBankActivationMs: 24 * HOUR_MS,
    handoffProfitBankExitFraction: 0.25,
    handoffProfitBankReserveUsdt: PROFIT_BANK_RESERVE_USDT,
  },
  bank_24h_50: {
    ...RESCUE_OPTIONS,
    handoffProfitBankExitEnabled: true,
    handoffProfitBankActivationMs: 24 * HOUR_MS,
    handoffProfitBankExitFraction: 0.5,
    handoffProfitBankReserveUsdt: PROFIT_BANK_RESERVE_USDT,
  },
  bank_24h_full: {
    ...RESCUE_OPTIONS,
    handoffProfitBankExitEnabled: true,
    handoffProfitBankActivationMs: 24 * HOUR_MS,
    handoffProfitBankExitFraction: 1,
    handoffProfitBankReserveUsdt: PROFIT_BANK_RESERVE_USDT,
  },
  bank_48h_50: {
    ...RESCUE_OPTIONS,
    handoffProfitBankExitEnabled: true,
    handoffProfitBankActivationMs: 48 * HOUR_MS,
    handoffProfitBankExitFraction: 0.5,
    handoffProfitBankReserveUsdt: PROFIT_BANK_RESERVE_USDT,
  },
});

function sum(items, key) {
  return items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
}

function rounded(value) {
  return Number(Number(value).toFixed(6));
}

function pnlToDrawdown(item) {
  const drawdown = Number(item.sumOfPerSymbolMaximumDrawdowns) || 0;
  return drawdown > 0 ? Number(item.netLiquidationPnl) / drawdown : Infinity;
}

function aggregateResults(items, options) {
  return {
    ...aggregate(items, options),
    handoffSignals: sum(items, 'handoffSignals'),
    handoffCompleted: sum(items, 'handoffCompleted'),
    handoffCancelled: sum(items, 'handoffCancelled'),
    handoffExitFills: sum(items, 'handoffExitFills'),
    handoffRescueOrders: sum(items, 'handoffRescueOrders'),
    handoffRescueFills: sum(items, 'handoffRescueFills'),
    handoffProfitBankOrders: sum(items, 'handoffProfitBankOrders'),
    handoffProfitBankFills: sum(items, 'handoffProfitBankFills'),
    handoffProfitBankFullExits: sum(items, 'handoffProfitBankFullExits'),
    handoffProfitBankPartialExits: sum(items, 'handoffProfitBankPartialExits'),
    handoffProfitBankExitNotional: rounded(sum(items, 'handoffProfitBankExitNotional')),
    handoffProfitBankRealizedPnl: rounded(sum(items, 'handoffProfitBankRealizedPnl')),
    finalInventoryNetPnl: rounded(sum(items, 'finalInventoryNetPnl')),
    maxInventoryAgeHours: rounded(Math.max(...items.map(item =>
      Number(item.maxInventoryAgeHours) || 0
    ))),
    maxFinalInventoryAgeHours: rounded(Math.max(...items.map(item =>
      Number(item.finalInventoryAgeHours) || 0
    ))),
    maxFinalBreakEvenDistancePct: rounded(Math.max(...items.map(item =>
      Number(item.finalBreakEvenDistancePct) || 0
    ))),
    inventoryNotionalHours: rounded(sum(items, 'inventoryNotionalHours')),
    staleInventoryNotionalHours: rounded(sum(items, 'staleInventoryNotionalHours')),
  };
}

function renderMarkdown(report) {
  const lines = [
    '# Reversal Inventory Backtest',
    '',
    `Period: ${report.period.start} to ${report.period.end}`,
    '',
    `Out-of-sample: ${report.period.splitAt} to ${report.period.end}`,
    '',
    `Wallet reference: ${report.configuration.walletBalanceUsdt} USDT`,
    '',
    `One rescue order: ${report.configuration.rescueNotionalUsdt} USDT notional (${report.configuration.rescueMarginPct}% wallet margin at ${report.configuration.leverage}x)`,
    '',
    '| Scope | Sizing profile | Variant | Net PnL | Sum max DD | Final inventory | Inventory PnL | Final age h | Break-even distance | Stale notional-hours | Bank exits | Handoffs |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scope of ['full', 'outOfSample']) {
    for (const profile of Object.keys(report.profiles)) {
      for (const variant of Object.keys(VARIANTS)) {
        const item = report.results[scope][profile].aggregate[variant];
        lines.push(
          `| ${scope} | ${profile} | ${variant} | ${item.netLiquidationPnl} | ` +
          `${item.sumOfPerSymbolMaximumDrawdowns} | ${item.finalInventoryNotional} | ` +
          `${item.finalInventoryNetPnl} | ${item.maxFinalInventoryAgeHours} | ` +
          `${item.maxFinalBreakEvenDistancePct}% | ${item.staleInventoryNotionalHours} | ` +
          `${item.handoffProfitBankFills} | ` +
          `${item.handoffCompleted} |`
        );
      }
    }
  }
  lines.push(
    '',
    '## Verdict',
    '',
    `- ${report.verdict}.`,
    `- Selected variant: ${report.selection.selectedVariant || 'none'}.`,
    `- Maximum accepted drawdown: ${report.selection.maximumDrawdownUsdt} USDT (15% of wallet).`,
    '',
    '## Rules',
    '',
    '- Reversal ownership uses the existing 12-hour price momentum signal on completed 5-minute candles.',
    '- Fibonacci multi-timeframe remains the range and level generator; direction level bias is disabled as in live REPORT_ONLY mode.',
    '- On reversal, normal entries stop. The candidate may place one rescue entry at the nearest valid Fibonacci level only while the old position is net negative.',
    '- The enlarged old position exits together at its fee-adjusted average breakeven plus 0.05% net profit before ownership changes side.',
    '- Profit-bank variants wait 12, 24, or 48 hours, then reduce 25%, 50%, or 100% at the next favorable Fibonacci level.',
    '- A profit-bank exit is sized so realized cash profit remains at least 0.05 USDT after its exit fee.',
    '- The base symbol exposure cap is 20.66 USDT. Rescue may add at most 23.03 USDT notional once.',
    '',
    '## Limitations',
    '',
    '- Candle-touch fills assume maker execution; queue priority, slippage, latency, rejected post-only orders, liquidation tiers, and exact intrabar ordering are unavailable.',
    '- LONG and SHORT sizing differ live. A sizing-profile label does not describe the final position direction.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

async function main() {
  const reference = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  const start = Date.parse(reference.period.start);
  const end = Date.parse(reference.period.end);
  const splitAt = Date.parse(reference.period.splitAt);
  const scopes = {
    full: { start, end, perProfile: {} },
    outOfSample: { start: splitAt, end, perProfile: {} },
  };
  const profiles = {
    long_sizing: {
      ...reference.configuration.LONG,
      orderSizeUsdt: 5,
      maxExposureUsdt: BASE_SYMBOL_CAP_USDT,
    },
    short_sizing: {
      ...reference.configuration.SHORT,
      orderSizeUsdt: 6,
      maxExposureUsdt: BASE_SYMBOL_CAP_USDT,
    },
  };
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  try {
    for (const [profileName, profile] of Object.entries(profiles)) {
      for (const scope of Object.values(scopes)) {
        scope.perProfile[profileName] = { perSymbol: {} };
      }
      for (const symbol of SYMBOLS) {
        const rows = cachedRows(symbol, start, end).map(row => row.slice(0, 6).map(Number));
        const indicators = buildIndicatorMap(rows);
        const fundingRates = await fetchFundingRates(
          exchange, symbol, start, end, FUNDING_DIRECTORY
        );
        const minimumNotional = Number(exchange.market(symbol)?.limits?.cost?.min) || 5;
        const simulator = new FullGridBacktester(exchange, {
          ...profile,
          minimumNotional,
          directionStrategy: 'TREND',
          directionLevelBiasPct: 0,
          longEntryDirection: 'ALWAYS',
          shortEntryDirection: 'ALWAYS',
          mutualExclusion: true,
          handoffEntryCooldownMs: 0,
        });
        const positionSideProvider = context => {
          const indicator = indicators.get(context.timestamp);
          if (!indicator || !Number.isFinite(indicator.roc144) || indicator.roc144 === 0) {
            return context.activePositionSide;
          }
          return indicator.roc144 > 0 ? 'LONG' : 'SHORT';
        };
        for (const [variantName, variant] of Object.entries(VARIANTS)) {
          simulator.options = { ...simulator.options, ...variant };
          for (const scope of Object.values(scopes)) {
            scope.perProfile[profileName].perSymbol[symbol] ||= {};
            scope.perProfile[profileName].perSymbol[symbol][variantName] = simulator.simulate({
              symbol,
              rows,
              fundingRates,
              start: scope.start,
              end: scope.end,
              positionSideProvider,
              variant: `${profileName}-${variantName}`,
            });
          }
        }
        console.log(`[REVERSAL RESCUE] completed ${profileName} ${symbol}`);
      }
    }
  } finally {
    await exchange.close();
  }

  const results = {};
  for (const [scopeName, scope] of Object.entries(scopes)) {
    results[scopeName] = {};
    for (const [profileName, profileResult] of Object.entries(scope.perProfile)) {
      results[scopeName][profileName] = { perSymbol: profileResult.perSymbol, aggregate: {} };
      for (const variantName of Object.keys(VARIANTS)) {
        results[scopeName][profileName].aggregate[variantName] = aggregateResults(
          SYMBOLS.map(symbol => profileResult.perSymbol[symbol][variantName]),
          profiles[profileName]
        );
      }
    }
  }

  const maximumDrawdownUsdt = rounded(WALLET_BALANCE_USDT * 0.15);
  const candidateVariants = Object.keys(VARIANTS).filter(name => name.startsWith('bank_'));
  const candidateSummaries = candidateVariants.map(variantName => {
    const comparisons = Object.keys(profiles).flatMap(profileName =>
      ['full', 'outOfSample'].map(scopeName => {
        const baseline = results[scopeName][profileName].aggregate.rescue_once;
        const candidate = results[scopeName][profileName].aggregate[variantName];
        return {
          profileName,
          scopeName,
          pnlDelta: rounded(candidate.netLiquidationPnl - baseline.netLiquidationPnl),
          drawdownDelta: rounded(
            candidate.sumOfPerSymbolMaximumDrawdowns - baseline.sumOfPerSymbolMaximumDrawdowns
          ),
          finalInventoryDelta: rounded(
            candidate.finalInventoryNotional - baseline.finalInventoryNotional
          ),
          baselinePnlToDrawdown: rounded(pnlToDrawdown(baseline)),
          candidatePnlToDrawdown: rounded(pnlToDrawdown(candidate)),
          candidatePnl: candidate.netLiquidationPnl,
          candidateDrawdown: candidate.sumOfPerSymbolMaximumDrawdowns,
          candidateFinalInventory: candidate.finalInventoryNotional,
          finalInventoryPnlDelta: rounded(
            candidate.finalInventoryNetPnl - baseline.finalInventoryNetPnl
          ),
          maxInventoryAgeDelta: rounded(
            candidate.maxInventoryAgeHours - baseline.maxInventoryAgeHours
          ),
          finalInventoryAgeDelta: rounded(
            candidate.maxFinalInventoryAgeHours - baseline.maxFinalInventoryAgeHours
          ),
          finalBreakEvenDistanceDelta: rounded(
            candidate.maxFinalBreakEvenDistancePct - baseline.maxFinalBreakEvenDistancePct
          ),
          staleInventoryNotionalHoursDelta: rounded(
            candidate.staleInventoryNotionalHours - baseline.staleInventoryNotionalHours
          ),
          candidateFinalInventoryPnl: candidate.finalInventoryNetPnl,
          candidateMaxInventoryAgeHours: candidate.maxInventoryAgeHours,
          candidateStaleInventoryNotionalHours: candidate.staleInventoryNotionalHours,
        };
      })
    );
    const totalFinalInventory = rounded(sum(comparisons, 'candidateFinalInventory'));
    const totalPnl = rounded(sum(comparisons, 'candidatePnl'));
    const totalStaleInventoryNotionalHours = rounded(
      sum(comparisons, 'candidateStaleInventoryNotionalHours')
    );
    const totalFinalInventoryLoss = rounded(comparisons.reduce(
      (total, item) => total + Math.max(0, -item.candidateFinalInventoryPnl), 0
    ));
    const eligible = comparisons.every(item => item.candidatePnl > 0 &&
      item.candidateDrawdown <= maximumDrawdownUsdt &&
      item.finalInventoryPnlDelta >= -1e-8 &&
      item.maxInventoryAgeDelta <= 1e-8 &&
      item.finalInventoryAgeDelta <= 1e-8 &&
      item.finalBreakEvenDistanceDelta <= 1e-8 &&
      item.staleInventoryNotionalHoursDelta <= 1e-8) &&
      comparisons.some(item => item.finalInventoryPnlDelta > 1e-8 ||
        item.maxInventoryAgeDelta < -1e-8 ||
        item.finalInventoryAgeDelta < -1e-8 ||
        item.finalBreakEvenDistanceDelta < -1e-8 ||
        item.staleInventoryNotionalHoursDelta < -1e-8);
    return {
      variantName,
      comparisons,
      totalFinalInventory,
      totalFinalInventoryLoss,
      totalStaleInventoryNotionalHours,
      totalPnl,
      eligible,
    };
  });
  const selected = candidateSummaries
    .filter(item => item.eligible)
    .sort((left, right) =>
      left.totalStaleInventoryNotionalHours - right.totalStaleInventoryNotionalHours ||
      left.totalFinalInventoryLoss - right.totalFinalInventoryLoss ||
      right.totalPnl - left.totalPnl
    )[0] || null;
  const inventoryCleared = Boolean(selected) && selected.comparisons.every(
    item => item.candidateFinalInventory <= 1e-8
  );
  const report = {
    generatedAt: new Date().toISOString(),
    period: reference.period,
    symbols: SYMBOLS,
    profiles,
    variants: VARIANTS,
    configuration: {
      walletBalanceUsdt: WALLET_BALANCE_USDT,
      leverage: LEVERAGE,
      baseSymbolCapUsdt: BASE_SYMBOL_CAP_USDT,
      rescueMarginPct: 5,
      rescueNotionalUsdt: RESCUE_NOTIONAL_USDT,
    },
    results,
    candidateSummaries,
    selection: {
      maximumDrawdownUsdt,
      selectedVariant: selected?.variantName || null,
      inventoryCleared,
    },
    verdict: inventoryCleared
      ? 'LAYAK: selected profit-bank rule cleared final inventory in every validation slice, kept net PnL positive, and stayed within the drawdown limit'
      : selected
        ? 'LAYAK TERBATAS: selected profit-bank rule reduced stale exposure, inventory age, and terminal inventory loss without making any validation slice unprofitable or exceeding the drawdown limit'
        : 'TIDAK LAYAK: no profit-bank rule reduced inventory consistently while keeping net PnL positive and drawdown within the limit',
  };
  fs.mkdirSync(RESULTS_DIRECTORY, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIRECTORY, 'reversal-rescue-backtest.json'),
    JSON.stringify(report, null, 2)
  );
  fs.writeFileSync(
    path.join(RESULTS_DIRECTORY, 'reversal-rescue-backtest.md'),
    renderMarkdown(report)
  );
  console.log(renderMarkdown(report));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[REVERSAL RESCUE] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { VARIANTS, renderMarkdown };
