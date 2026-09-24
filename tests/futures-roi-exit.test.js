'use strict';

process.env.GRID_TAKE_PROFIT_PRICE = '100';
process.env.GRID_STOP_LOSS_PRICE = '-100';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FuturesGridEngine } = require('../futures-grid');

function makeEngine(positionSnapshots) {
  const engine = Object.create(FuturesGridEngine.prototype);
  const orders = [];
  let fetchIndex = 0;
  const symState = { lastBuyByLevel: { 1: { amount: 0.25 } } };

  engine.exchange = {
    fetchPositions: async () => positionSnapshots[Math.min(fetchIndex++, positionSnapshots.length - 1)],
    amountToPrecision: (_symbol, amount) => String(amount),
    createOrder: async (...args) => {
      orders.push(args);
      return { id: 'close-1' };
    },
  };
  engine.state = {
    getSymbol: () => symState,
    save: async () => {},
  };
  engine.cancelGridOrders = async () => ({ cancelled: ['grid-1'], failed: [] });
  engine.sendAlert = async () => {};

  return { engine, orders };
}

test('exit fill records Binance realized PnL minus closing fee', async () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  const symState = { realizedExitProfit: 0, tradingFees: 0, orders: {} };
  const processed = [];
  engine.state = {
    data: { totals: { realizedExitProfit: 0, tradingFees: 0, filledSells: 0 } },
    markProcessedTradeLocal: (_symbol, id) => processed.push(id),
    save: async () => {},
  };
  engine.sendAlert = async () => {};

  await engine.handleExitFill('BTC/USDT:USDT', symState, {
    id: 'exit-trade-1',
    order: 'exit-order-1',
    price: 70000,
    fee: { cost: 0.5, currency: 'USDT' },
    info: { realizedPnl: '25' },
  }, new Set());

  assert.equal(symState.realizedExitProfit, 24.5);
  assert.equal(symState.tradingFees, 0.5);
  assert.equal(engine.state.data.totals.realizedExitProfit, 24.5);
  assert.deepEqual(processed, ['exit-trade-1']);
});

test('funding history records received and paid funding exactly once', async () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  const symState = {
    createdAt: new Date(0).toISOString(),
    fundingProfit: 0,
    lastFundingTimestamp: 0,
  };
  const processed = new Set();
  engine.lastFundingSyncAt = new Map();
  engine.exchange = {
    fetchFundingHistory: async () => [
      { id: 'fund-1', timestamp: 1000, currency: 'USDT', info: { income: '2.5' } },
      { id: 'fund-2', timestamp: 2000, currency: 'USDT', info: { income: '-1' } },
    ],
  };
  engine.state = {
    data: { totals: { fundingProfit: 0 }, processedFundingIds: [] },
    getSymbol: () => symState,
    processedFunding: (symbol, id) => processed.has(`${symbol}|${id}`),
    markProcessedFundingLocal: (symbol, id) => processed.add(`${symbol}|${id}`),
    save: async () => {},
  };

  assert.equal(await engine.syncFundingHistory('BTC/USDT:USDT', { force: true }), 1.5);
  assert.equal(await engine.syncFundingHistory('BTC/USDT:USDT', { force: true }), 0);
  assert.equal(symState.fundingProfit, 1.5);
  assert.equal(engine.state.data.totals.fundingProfit, 1.5);
  assert.equal(symState.lastFundingTimestamp, 2000);
});

test('100 percent ROI closes the complete active LONG position at market', async () => {
  const activePosition = {
    symbol: 'BTC/USDT:USDT',
    side: 'long',
    contracts: 0.25,
    percentage: 100,
  };
  const { engine, orders } = makeEngine([
    [activePosition],
    [{ ...activePosition, contracts: 0 }],
  ]);

  const canContinue = await engine.enforceRangeExits('BTC/USDT:USDT', 70000, [activePosition]);

  assert.equal(canContinue, false);
  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0].slice(0, 5), ['BTC/USDT:USDT', 'market', 'sell', 0.25, undefined]);
  assert.equal(orders[0][5].positionSide, 'LONG');

  assert.equal(await engine.enforceRangeExits('BTC/USDT:USDT', 70000, []), false);
  assert.equal(orders.length, 1);
});

test('ROI below 100 percent keeps the futures grid running', async () => {
  const activePosition = {
    symbol: 'BTC/USDT:USDT',
    side: 'long',
    contracts: 0.25,
    percentage: 99.99,
  };
  const { engine, orders } = makeEngine([[activePosition]]);

  assert.equal(await engine.enforceRangeExits('BTC/USDT:USDT', 70000, [activePosition]), true);
  assert.equal(orders.length, 0);
});

test('minus 100 percent ROI closes the complete active LONG position', async () => {
  const activePosition = {
    symbol: 'BTC/USDT:USDT',
    side: 'long',
    contracts: 0.25,
    percentage: -100,
  };
  const { engine, orders } = makeEngine([
    [activePosition],
    [{ ...activePosition, contracts: 0 }],
  ]);

  assert.equal(await engine.enforceRangeExits('BTC/USDT:USDT', 50000, [activePosition]), false);
  assert.equal(orders.length, 1);
  assert.equal(orders[0][1], 'market');
  assert.equal(orders[0][2], 'sell');
});

test('ROI exit finalizes safely when position settlement is delayed to the next cycle', async () => {
  const activePosition = {
    symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.25, percentage: 100,
  };
  const { engine, orders } = makeEngine([
    ...Array.from({ length: 6 }, () => [activePosition]),
  ]);
  const alerts = [];
  engine.sendAlert = async message => alerts.push(message);

  await assert.rejects(
    engine.enforceRangeExits('BTC/USDT:USDT', 70000, [activePosition]),
    /left 0\.25 contracts active/
  );
  assert.equal(orders.length, 1);
  assert.equal(alerts.length, 0);

  assert.equal(await engine.enforceRangeExits('BTC/USDT:USDT', 70000, []), false);
  assert.equal(orders.length, 1);
  assert.equal(alerts.length, 1);
});

test('ROI exit does not submit a duplicate market close while the first is pending', async () => {
  const activePosition = {
    symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.25, percentage: 100,
  };
  const { engine, orders } = makeEngine([
    ...Array.from({ length: 6 }, () => [activePosition]),
  ]);
  engine.roiCloseOrders = new Map();

  await assert.rejects(
    engine.enforceRangeExits('BTC/USDT:USDT', 70000, [activePosition]),
    /left 0\.25 contracts active/
  );
  await assert.rejects(
    engine.enforceRangeExits('BTC/USDT:USDT', 70000, [activePosition]),
    /refusing duplicate exit/
  );
  assert.equal(orders.length, 1);
});

test('ROI exit can close a remaining position after a prior close is filled partially', async () => {
  const activePosition = {
    symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.25, percentage: 100,
  };
  const { engine, orders } = makeEngine([
    [activePosition],
    [activePosition],
    [activePosition],
    [{ ...activePosition, contracts: 0 }],
  ]);
  engine.exchange.fetchOrder = async () => ({ status: 'closed', filled: 0.25 });
  engine.roiCloseOrders = new Map([['BTC/USDT:USDT', { id: 'close-1', amount: 0.5 }]]);

  assert.equal(await engine.enforceRangeExits('BTC/USDT:USDT', 70000, [activePosition]), false);
  assert.equal(orders.length, 1);
});

test('ROI exit does not close a position when a grid order failed to cancel', async () => {
  const activePosition = {
    symbol: 'BTC/USDT:USDT',
    side: 'long',
    contracts: 0.25,
    percentage: 120,
  };
  const { engine, orders } = makeEngine([[activePosition]]);
  engine.cancelGridOrders = async () => ({
    cancelled: [],
    failed: [{ id: 'grid-1', error: new Error('cancel failed') }],
  });

  await assert.rejects(
    engine.enforceRangeExits('BTC/USDT:USDT', 70000, [activePosition]),
    /failed to cancel/
  );
  assert.equal(orders.length, 0);
});

test('ROI falls back to unrealized PnL divided by initial margin', () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  assert.equal(engine.getPositionRoiPct({ unrealizedPnl: 10, initialMargin: 10 }), 100);
});

test('futures Telegram status reports total PnL and no position when it is closed', () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  engine.state = {
    getSymbol: () => ({ realizedGridProfit: 0.2409, realizedExitProfit: 0, fundingProfit: -0.0016,
      accountIncome: { since: Date.now() - 10000, syncedAt: Date.now(), records: {
        pnl: { type: 'REALIZED_PNL', income: 0.2409, asset: 'USDT' },
        funding: { type: 'FUNDING_FEE', income: -0.0016, asset: 'USDT' },
      } },
    }),
  };
  engine.latestPositions = new Map(String(process.env.SYMBOLS || 'BTC/USDT:USDT').split(',').map(symbol => [symbol.trim(), null]));

  const message = engine.buildTelegramStatusMessage();
  assert.match(message, /PnL: \+0,2393 USDT/);
  assert.match(message, /Posisi: tidak ada/);
  assert.doesNotMatch(message, /unrealized=null/);
});

test('futures Telegram messages use a readable sectioned layout', () => {
  const engine = Object.create(FuturesGridEngine.prototype);
  const message = engine.formatFuturesTelegramMessage('FUTURES SELL FILLED', [
    ['Symbol', '1000SHIB/USDT:USDT'],
    ['Net Profit', '0.2292 USDT'],
  ]);

  assert.equal(message, [
    '[FUTURES SELL FILLED]',
    '',
    'Symbol: 1000SHIB/USDT:USDT',
    'Net Profit: 0.2292 USDT',
  ].join('\n'));
});
