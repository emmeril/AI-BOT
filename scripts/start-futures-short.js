#!/usr/bin/env node

const dotenv = require('dotenv');

const DEFAULT_SYMBOLS =
  '1000SHIB/USDT:USDT,1000PEPE/USDT:USDT,1000BONK/USDT:USDT,PENGU/USDT:USDT,JUP/USDT:USDT';

function buildShortEnvironment(baseEnvironment) {
  const environment = { ...baseEnvironment };
  const defaults = {
    FUTURES_POSITION_SIDE: 'SHORT',
    SYMBOLS: baseEnvironment.SYMBOLS || DEFAULT_SYMBOLS,
    GRID_STATE_FILE: 'grid-state-futures-short.json',
    BOT_LOCK_FILE: 'grid-state-futures-short.json.lock',
    GRID_COUNT: '10',
    GRID_ORDER_SIZE_USDT: '6',
    GRID_TOTAL_INVESTMENT_USDT: '60',
    FUTURES_MAX_SYMBOL_EXPOSURE_USDT: '60',
    FUTURES_MAX_TOTAL_EXPOSURE_USDT: '300',
    GRID_MAX_ACTIVE_BUY_ORDERS: '10',
    GRID_MAX_ACTIVE_SELL_ORDERS: '10',
    GRID_EXIT_TARGET_LEVEL_OFFSET: '0',
    GRID_AGGREGATED_EXIT_LADDER_ENABLED: 'false',
    FIBONACCI_RANGE_ADVISOR_STATE_FILE: 'fibonacci-range-advisor-futures-short.json',
    FIBONACCI_DIRECTION_ANALYZER_ENABLED: 'true',
    FUTURES_SHORT_ENTRY_DIRECTION: 'BEARISH',
    VOLUME_DELTA_ENTRY_FILTER_ENABLED: 'true',
    VOLUME_DELTA_ENTRY_FILTER_MODE: 'LIVE',
    VOLUME_DELTA_TIMEFRAME: '5m',
    VOLUME_DELTA_LOOKBACK_CANDLES: '12',
    VOLUME_DELTA_OPPOSITION_THRESHOLD_PCT: '2.5',
    VOLUME_DELTA_FAIL_CLOSED: 'false',
    ADAPTIVE_GRID_SUPERVISOR_ENABLED: 'false',
    ADAPTIVE_RISK_STATE_MACHINE_ENABLED: 'false',
    ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_ENABLED: 'false',
    TELEGRAM_ENABLED: 'true',
    FUTURES_TELEGRAM_COMMAND_PROCESSING_ENABLED: 'false',
    FUTURES_DASHBOARD_ENABLED: 'false',
  };
  for (const [key, fallback] of Object.entries(defaults)) {
    const override = baseEnvironment[`SHORT_${key}`];
    environment[key] = override === undefined || override === '' ? fallback : override;
  }
  return environment;
}

function main() {
  dotenv.config({ path: '.env.futures', quiet: true });
  Object.assign(process.env, buildShortEnvironment(process.env));
  require('../futures-grid').bootstrap().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

if (require.main === module) main();

module.exports = { DEFAULT_SYMBOLS, buildShortEnvironment };
