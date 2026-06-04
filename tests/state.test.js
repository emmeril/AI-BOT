const test = require('node:test');
const assert = require('node:assert/strict');

const { Config, GridState } = require('../index');

test('Config.boolean parses explicit true and false values', () => {
  const original = process.env.TEST_BOOLEAN;
  try {
    process.env.TEST_BOOLEAN = 'NO';
    assert.equal(Config.boolean('TEST_BOOLEAN'), false);
    process.env.TEST_BOOLEAN = '1';
    assert.equal(Config.boolean('TEST_BOOLEAN'), true);
    process.env.TEST_BOOLEAN = 'invalid';
    assert.throws(() => Config.boolean('TEST_BOOLEAN'), /must be a boolean value/);
  } finally {
    if (original === undefined) {
      delete process.env.TEST_BOOLEAN;
    } else {
      process.env.TEST_BOOLEAN = original;
    }
  }
});

test('GridState.normalize repairs incomplete legacy state', () => {
  const state = GridState.normalize({
    symbols: null,
    processedTradeIds: [1, 2],
    totals: { filledBuys: '3' },
  });

  assert.deepEqual(state.symbols, {});
  assert.deepEqual(state.processedTradeIds, ['1', '2']);
  assert.deepEqual(state.totals, {
    filledBuys: 3,
    filledSells: 0,
    realizedGridProfit: 0,
  });
});

test('GridState.getSymbol repairs an incomplete symbol state', () => {
  const state = Object.create(GridState.prototype);
  state.data = GridState.normalize({
    symbols: {
      'BTC/USDT': { orders: null, realizedGridProfit: '1.25' },
    },
  });

  const symbol = state.getSymbol('BTC/USDT');

  assert.deepEqual(symbol.config, {});
  assert.deepEqual(symbol.orders, {});
  assert.deepEqual(symbol.lastBuyByLevel, {});
  assert.equal(symbol.realizedGridProfit, 1.25);
});

test('GridState.getSymbol replaces an invalid symbol entry', () => {
  const state = Object.create(GridState.prototype);
  state.data = GridState.normalize({
    symbols: {
      'BTC/USDT': 'invalid',
    },
  });

  const symbol = state.getSymbol('BTC/USDT');

  assert.deepEqual(symbol.orders, {});
  assert.equal(symbol.realizedGridProfit, 0);
});

test('processed trade IDs are scoped by symbol and remain legacy-compatible', () => {
  const state = Object.create(GridState.prototype);
  state.data = GridState.createEmpty();
  state.save = () => {};

  state.markProcessedTrade('BTC/USDT', '42');

  assert.equal(state.processedTrade('BTC/USDT', '42'), true);
  assert.equal(state.processedTrade('ETH/USDT', '42'), false);

  state.data.processedTradeIds.push('99');
  assert.equal(state.processedTrade('BTC/USDT', '99'), true);
});
