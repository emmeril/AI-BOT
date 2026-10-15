#!/usr/bin/env node

const dotenv = require('dotenv');

dotenv.config({ path: '.env.futures', quiet: true });

const shortDefaults = {
  FUTURES_POSITION_SIDE: 'SHORT',
  SYMBOLS: '1000SHIB/USDT:USDT,1000PEPE/USDT:USDT,1000BONK/USDT:USDT,PENGU/USDT:USDT',
  GRID_STATE_FILE: 'grid-state-futures-short.json',
  BOT_LOCK_FILE: 'grid-state-futures-short.json.lock',
  GRID_COUNT: '10',
  GRID_ORDER_SIZE_USDT: '6',
  GRID_TOTAL_INVESTMENT_USDT: '60',
  FUTURES_MAX_SYMBOL_EXPOSURE_USDT: '60',
  FUTURES_MAX_TOTAL_EXPOSURE_USDT: '300',
  GRID_MAX_ACTIVE_BUY_ORDERS: '10',
  GRID_MAX_ACTIVE_SELL_ORDERS: '10',
  GRID_AGGREGATED_EXIT_LADDER_ENABLED: 'false',
  FIBONACCI_RANGE_ADVISOR_STATE_FILE: 'fibonacci-range-advisor-futures-short.json',
  FIBONACCI_DIRECTION_ANALYZER_ENABLED: 'true',
  FUTURES_SHORT_ENTRY_DIRECTION: 'BEARISH',
  ADAPTIVE_GRID_SUPERVISOR_ENABLED: 'false',
  ADAPTIVE_RISK_STATE_MACHINE_ENABLED: 'false',
  ADAPTIVE_SUPERVISOR_OUTCOME_JOURNAL_ENABLED: 'false',
  TELEGRAM_ENABLED: 'false',
  FUTURES_DASHBOARD_ENABLED: 'false',
};

for (const [key, fallback] of Object.entries(shortDefaults)) {
  const override = process.env[`SHORT_${key}`];
  process.env[key] = override === undefined || override === '' ? fallback : override;
}

require('../futures-grid').bootstrap().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
