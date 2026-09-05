const test = require('node:test');
const assert = require('node:assert/strict');
const {
  marketAmountText,
  marketPrice,
  marketPriceText,
  normalizeOrder,
  precisionDigits,
  isLoopbackHost: isSpotLoopbackHost,
} = require('../src/dashboard-server');
const {
  buildFuturesDashboardSnapshot,
  isLoopbackHost,
  positionMetrics,
  validateDashboardExposure,
} = require('../src/futures-dashboard-server');
const { telegramMethods } = require('../src/telegram-controller');

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
