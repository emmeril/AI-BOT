const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADAPTIVE_GRID_SUPERVISOR_ENABLED = 'true';
process.env.ADAPTIVE_GRID_SUPERVISOR_MODE = 'LIVE';
process.env.FIBONACCI_RANGE_ADVISOR_ENABLED = 'true';
process.env.FIBONACCI_DIRECTION_ANALYZER_ENABLED = 'true';
process.env.GRID_TOTAL_INVESTMENT_USDT = '150';
process.env.GRID_COUNT = '27';

const { FuturesGridEngine, validateRuntimeConfiguration } = require('../futures-grid');
const { recommendationFor } = require('../src/adaptive-grid-supervisor');

const symbol = 'TEST/USDT:USDT';

function createEngine(allocated = 0) {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.state = {
    getSymbol: () => ({
      lastBuyByLevel: allocated
        ? { 0: { totalCostQuote: allocated } }
        : {},
      orders: {},
    }),
  };
  engine.exchange = {
    markets: {
      [symbol]: { limits: { cost: { min: 5 } } },
    },
  };
  engine.adaptiveMinimumWarnings = new Set();
  engine.adaptiveGridDecisions = new Map([[
    symbol,
    { profile: 'RISK_OFF', recommendation: recommendationFor('RISK_OFF') },
  ]]);
  return engine;
}

test('live adaptive configuration passes runtime validation', () => {
  assert.doesNotThrow(() => validateRuntimeConfiguration());
});

test('risk-off reserve limits new allocation to half of the configured investment', () => {
  assert.equal(createEngine().getRemainingInvestmentUsdt(symbol), 75);
  assert.equal(createEngine(70).getRemainingInvestmentUsdt(symbol), 5);
  assert.equal(createEngine(80).getRemainingInvestmentUsdt(symbol), 0);
});

test('live sizing skips sub-minimum upper buys but keeps lower-zone buys', () => {
  const engine = createEngine();
  assert.equal(engine.amountForBuy(symbol, 100, 75, 0.25), 0);
  assert.equal(engine.amountForBuy(symbol, 100, 75, 0.5), 0);
  assert.ok(Math.abs(engine.amountForBuy(symbol, 100, 75, 1.25) * 100 - 6.9444444444) < 1e-8);
});

test('risk-off placement widens the live BUY ladder', () => {
  const engine = createEngine();
  const levels = Array.from({ length: 28 }, (_, index) => 74 + index);
  const plan = engine.getBuyPlacementLevels(symbol, levels, 101, 20);
  assert.deepEqual(plan.slice(0, 4).map(level => level.price), [100, 98, 96, 94]);
  assert.deepEqual([...new Set(plan.map(level => level.weight))], [0.25, 0.5, 1.25]);
});
