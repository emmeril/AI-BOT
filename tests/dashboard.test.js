const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDashboardSnapshot,
  marketAmountText,
  marketPrice,
  marketPriceText,
  normalizeOrder,
  precisionDigits,
  isLoopbackHost: isSpotLoopbackHost,
} = require('../src/dashboard-server');
const {
  buildFuturesDashboardSnapshot,
  decisionSnapshot,
  isLoopbackHost,
  positionMetrics,
  validateDashboardExposure,
} = require('../src/futures-dashboard-server');
const { telegramMethods } = require('../src/telegram-controller');

test('spot dashboard reports total, free and locked balances for the selected pair', async () => {
  const { SYMBOLS } = require('../src/config');
  const symbol = SYMBOLS[0];
  const [base, quote] = symbol.split('/');
  const engine = {
    state: { getSymbol: () => ({ orders: {}, config: {} }), data: { totals: {} } },
    exchange: {
      fetchTicker: async () => ({ last: 1 }),
      fetchOpenOrders: async () => [],
      fetchOHLCV: async () => [],
      fetchBalance: async () => ({
        free: { [quote]: '12.5', [base]: '0.00001234' },
        used: { [quote]: '7.5', [base]: '0.00000001' },
        total: { [quote]: '20', [base]: '0.00001235' },
      }),
    },
    getQuoteAsset: () => quote,
    getBotOrderLevel: () => null,
    circuitAllows: () => true,
    canPlaceNewOrders: () => true,
  };
  const snapshot = await buildDashboardSnapshot(engine, symbol);
  assert.deepEqual(snapshot.balance.assets, [
    { asset: quote, free: 12.5, used: 7.5, total: 20 },
    { asset: base, free: 0.00001234, used: 0.00000001, total: 0.00001235 },
  ]);
  engine.exchange.fetchBalance = async () => ({});
  const empty = await buildDashboardSnapshot(engine, symbol);
  assert.ok(empty.balance.assets.every(asset => asset.total === 0 && asset.free === 0 && asset.used === 0));
});

test('spot Telegram messages separate their title from details', () => {
  assert.equal(telegramMethods.formatTelegramMessage('SPOT BUY FILLED', [
    ['Symbol', 'SHIB/USDT'],
    ['Price', '0.000005'],
  ]), [
    '[SPOT BUY FILLED]',
    '',
    'Symbol: SHIB/USDT',
    'Price: 0.000005',
  ].join('\n'));
});

test('futures command forwarding does not send an acknowledgement message', async () => {
  const calls = [];
  const fs = require('fs');
  const target = require('path').resolve(process.cwd(), 'futures-telegram-command.json');
  const hadExisting = fs.existsSync(target);
  const previousContents = hadExisting ? fs.readFileSync(target) : null;
  try {
    const engine = {
      sendAlert: async message => calls.push(message),
    };
    await telegramMethods.handleTelegramCommand.call(engine, '/futures_status');
    assert.equal(calls.length, 0);
  } finally {
    if (hadExisting) fs.writeFileSync(target, previousContents);
    else {
      try { fs.unlinkSync(target); } catch {}
    }
  }
});

test('futures dashboard uses position margin and excludes open-order margin from ROI', () => {
  const result = positionMetrics({
    contracts: 2982,
    notional: '15.93130518',
    entryPrice: '0.005281',
    markPrice: '0.00534249',
    unrealizedPnl: '0.18336318',
    initialMargin: '13.68235164',
    info: { positionInitialMargin: '3.18626104', openOrderInitialMargin: '10.49609060' },
  }, 5, 0.00314958);

  assert.equal(result.positionMargin, 3.18626104);
  assert.equal(result.openPositionFees, 0.00314958);
  assert.ok(Math.abs(result.roiPct - 5.754) < 0.01);
});

test('futures dashboard reports fill counts for the selected symbol', async () => {
  class TestEngine {}
  TestEngine.SYMBOLS = ['1000SHIB/USDT:USDT', '1000PEPE/USDT:USDT'];
  const states = {
    '1000SHIB/USDT:USDT': {
      config: {}, orders: {}, lastBuyByLevel: {}, filledBuys: 163, filledSells: 148,
    },
    '1000PEPE/USDT:USDT': {
      config: {}, orders: {}, lastBuyByLevel: {}, filledBuys: 2, filledSells: 0,
    },
  };
  const engine = new TestEngine();
  engine.state = {
    data: { totals: { filledBuys: 165, filledSells: 148, realizedGridProfit: 0, realizedExitProfit: 0 } },
    getSymbol: symbol => states[symbol],
  };
  engine.exchange = {
    fetchTicker: async () => ({ last: 1, high: 1, low: 1 }),
    fetchOpenOrders: async () => [],
    fetchOHLCV: async () => [],
    fetchBalance: async () => ({ free: { USDT: 10 }, total: { USDT: 20 }, info: {} }),
    fetchPositions: async () => [],
    priceToPrecision: (_symbol, value) => String(value || 0),
    amountToPrecision: (_symbol, value) => String(value || 0),
  };
  engine.getBotOrderLevel = () => null;
  engine.circuitAllows = () => true;
  engine.canPlaceNewOrders = () => true;

  const snapshot = await buildFuturesDashboardSnapshot(engine, '1000PEPE/USDT:USDT');

  assert.equal(snapshot.selectedSymbol, '1000PEPE/USDT:USDT');
  assert.equal(snapshot.profit.filledBuys, 2);
  assert.equal(snapshot.profit.filledSells, 0);
  assert.equal(snapshot.profit.net, null);
  assert.equal(snapshot.intelligence.execution.positionContracts, 0);
  assert.equal(snapshot.intelligence.execution.uncovered, 0);
  states['1000PEPE/USDT:USDT'].realizedGridProfit = 999;
  states['1000PEPE/USDT:USDT'].accountIncome = {
    since: Date.now() - 10000, syncedAt: Date.now(), records: {
      pnl: { asset: 'USDT', type: 'REALIZED_PNL', income: -3 },
      fee: { asset: 'USDT', type: 'COMMISSION', income: -0.1 },
    },
  };
  states['1000PEPE/USDT:USDT'].lastBuyByLevel = { 1: { totalFeeQuote: 0.1 } };
  engine.exchange.fetchPositions = async () => [{ symbol: '1000PEPE/USDT:USDT', side: 'long', contracts: 1, unrealizedPnl: -3 }];
  const accounted = await buildFuturesDashboardSnapshot(engine, '1000PEPE/USDT:USDT');
  assert.equal(accounted.profit.realized, -3.1);
  assert.equal(accounted.profit.net, -6.1);
  assert.equal(accounted.profit.gridPairProfit, 999);
});

test('futures decision snapshot exposes AI flow and SELL coverage without mutating execution', () => {
  const previous = {
    cap: process.env.GRID_TOTAL_INVESTMENT_USDT,
    count: process.env.GRID_COUNT,
    risk: process.env.ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT,
    mode: process.env.ADAPTIVE_GRID_SUPERVISOR_MODE,
    apply: process.env.FIBONACCI_DIRECTION_APPLY_MODE,
  };
  process.env.GRID_TOTAL_INVESTMENT_USDT = '150';
  process.env.GRID_COUNT = '27';
  process.env.ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT = '90';
  process.env.ADAPTIVE_GRID_SUPERVISOR_MODE = 'LIVE';
  process.env.FIBONACCI_DIRECTION_APPLY_MODE = 'LEVEL_BIAS';
  try {
    const symbol = 'TEST/USDT:USDT';
    const engine = {
      fibonacciDirectionAnalyzer: { cache: { [symbol]: { analysis: {
        direction: 'BEARISH', confirmedDirection: 'BEARISH', score: -0.7,
        confidence: 0.9, alignment: 1, confirmationCount: 3, confirmationsRequired: 2,
        timeframes: { '4h': { direction: 'BEARISH', score: -1 } },
      } } } },
      geminiAdaptiveMonitor: {
        isEnabled: () => true,
        getDecision: () => ({ accepted: true, profile: 'BEARISH', confidence: 0.8, riskFactors: ['volatility'] }),
      },
      adaptiveGridDecisions: new Map([[symbol, {
        mode: 'LIVE', profile: 'RISK_OFF', rawProfile: 'RISK_OFF', decisionSource: 'DETERMINISTIC_SAFETY',
        exposurePct: 92, recommendation: { buyWeight: { upper: 0.25, middle: 0.5, lower: 1.25 }, spacingMultiplier: 1.4 },
      }]]),
      getAllocatedInvestmentUsdt: () => 138,
    };
    const result = decisionSnapshot(engine, symbol, { lastBuyByLevel: {}, lastTradeTimestamp: 10 }, [
      { side: 'buy', price: 1, remaining: 2 },
      { side: 'sell', price: 2, remaining: 8 },
    ], { contracts: 10 });
    assert.equal(result.fibonacci.appliedDirection, 'BEARISH');
    assert.equal(result.gemini.profile, 'BEARISH');
    assert.equal(result.adaptive.profile, 'RISK_OFF');
    assert.equal(result.adaptive.exposurePct, 92);
    assert.equal(result.execution.gridCount, 27);
    assert.equal(result.execution.uncovered, 2);
    assert.equal(result.execution.sellCoveragePct, 80);
  } finally {
    if (previous.cap === undefined) delete process.env.GRID_TOTAL_INVESTMENT_USDT; else process.env.GRID_TOTAL_INVESTMENT_USDT = previous.cap;
    if (previous.count === undefined) delete process.env.GRID_COUNT; else process.env.GRID_COUNT = previous.count;
    if (previous.risk === undefined) delete process.env.ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT; else process.env.ADAPTIVE_GRID_SUPERVISOR_RISK_EXPOSURE_PCT = previous.risk;
    if (previous.mode === undefined) delete process.env.ADAPTIVE_GRID_SUPERVISOR_MODE; else process.env.ADAPTIVE_GRID_SUPERVISOR_MODE = previous.mode;
    if (previous.apply === undefined) delete process.env.FIBONACCI_DIRECTION_APPLY_MODE; else process.env.FIBONACCI_DIRECTION_APPLY_MODE = previous.apply;
  }
});

test('dashboard market price follows Binance symbol precision', () => {
  const engine = {
    exchange: {
      priceToPrecision: (_symbol, value) => Number(value).toFixed(2),
      amountToPrecision: (_symbol, value) => Number(value).toFixed(4),
    },
  };

  assert.equal(marketPrice(engine, 'BTC/USDT', 65432.127), 65432.13);
  assert.equal(marketPriceText(engine, 'BTC/USDT', 65432.1), '65432.10');
  assert.equal(precisionDigits('65432.10'), 2);
  assert.equal(precisionDigits('2'), 0);
  assert.equal(marketAmountText(engine, 'BTC/USDT', 0.12), '0.1200');
});

test('futures dashboard recognizes loopback IPv4 and IPv6 hosts', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.42.1.9'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.10'), false);
  assert.doesNotThrow(() => validateDashboardExposure('127.0.0.1', false));
  assert.doesNotThrow(() => validateDashboardExposure('0.0.0.0', true));
  assert.throws(
    () => validateDashboardExposure('0.0.0.0', false),
    /authentication is required/
  );
});

test('spot dashboard uses the same loopback exposure rule', () => {
  assert.equal(isSpotLoopbackHost('127.0.0.1'), true);
  assert.equal(isSpotLoopbackHost('0.0.0.0'), false);
});

test('dashboard order normalization uses exchange data and tracked grid level', () => {
  const engine = {
    getBotOrderLevel: () => null,
    exchange: {
      priceToPrecision: (_symbol, value) => Number(value).toFixed(2),
      amountToPrecision: (_symbol, value) => Number(value).toFixed(4),
    },
  };
  const result = normalizeOrder(engine, 'BTC/USDT', {
    id: 42,
    side: 'BUY',
    price: '100.50',
    amount: '0.2',
    filled: '0.05',
    remaining: '0.15',
    timestamp: 1234,
  }, { levelIndex: 3 });

  assert.deepEqual(result, {
    id: '42',
    symbol: 'BTC/USDT',
    side: 'buy',
    price: 100.5,
    priceText: '100.50',
    amount: 0.2,
    amountText: '0.2000',
    filled: 0.05,
    remaining: 0.15,
    remainingText: '0.1500',
    level: 3,
    timestamp: 1234,
  });
});
