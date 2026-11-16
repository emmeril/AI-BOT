'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TIMEFRAMES, evaluateMaCross, maSnapshot, historicalCrossLevels, historicalProtection } = require('../src/ma-cross-strategy');
const { buildScalperConfig } = require('../src/scalper/config');
const { FuturesScalperEngine } = require('../src/futures-scalper-engine');
const now = Date.UTC(2026, 10, 16, 8);
const config = buildScalperConfig({});
for (const strategy of Object.values(config.strategies)) strategy.crossSelection = null;

function rows(prices, tf) {
  const duration = TIMEFRAMES[tf];
  return prices.map((price, i) => [now - (prices.length - i) * duration, price, price, price, price, 100,
    now - (prices.length - i - 1) * duration - 1]);
}
function market(up, above) {
  const baseline = above ? 90 : 110;
  const prices = [...Array(74).fill(baseline), ...Array(25).fill(100), up ? 101 : 99];
  const history = [60, 100, 60, 100, 100, 140, 100, 140].flatMap(price => Array(30).fill(price));
  return Object.fromEntries(Object.keys(TIMEFRAMES).map(tf => [tf,
    rows([...history, ...(tf === '1m' ? prices : Array.from({ length: 110 }, (_, i) => above ? 100 + i : 300 - i))], tf)]));
}

test('MA uses simple close averages and previous MA for a genuine cross', () => {
  const snapshot = maSnapshot(rows(Array.from({ length: 100 }, (_, i) => i + 1), '1m'));
  assert.equal(snapshot.ma7, 97);
  assert.equal(snapshot.ma25, 88);
  assert.equal(snapshot.ma99, 51);
  assert.equal(snapshot.previousMa7, 96);
  assert.equal(maSnapshot([]), null);
});
for (const [side, up] of [['LONG', true], ['SHORT', false]]) {
  for (const above of [true, false]) {
    test(`${side} cross ${above ? 'above' : 'below'} MA99 is allowed with matching risk`, () => {
      const signal = evaluateMaCross(market(up, above), side, config.strategies[side], now);
      assert.equal(signal.allow, true);
      const countertrend = side === 'LONG' ? !above : above;
      assert.equal(signal.countertrend, countertrend);
      assert.equal(signal.risk.sizeMultiplier, countertrend ? 0.25 : 1);
      assert.equal(signal.risk.protectionMode, 'HISTORICAL_CROSS');
      assert.equal(signal.risk.takeProfitPrice, side === 'LONG' ? signal.supportResistance.resistance.price : signal.supportResistance.support.price);
      assert.equal(signal.risk.stopLossPrice, side === 'LONG' ? signal.supportResistance.support.price : signal.supportResistance.resistance.price);
      assert.equal(signal.risk.maxHoldMinutes, null);
      const other = side === 'LONG' ? 'SHORT' : 'LONG';
      assert.equal(evaluateMaCross(market(up, above), other, config.strategies[other], now).exit, false);
    });
  }
}
test('higher timeframe opposition reduces risk without blocking the cross', () => {
  const data = market(true, true);
  data['4h'] = market(true, false)['4h'];
  const signal = evaluateMaCross(data, 'LONG', config.strategies.LONG, now);
  assert.equal(signal.allow, true);
  assert.equal(signal.countertrend, true);
});
test('missing higher timeframe denies entry and cannot close an existing position', () => {
  const data = market(false, true);
  delete data['4h'];
  assert.equal(evaluateMaCross(data, 'SHORT', config.strategies.SHORT, now).allow, false);
  assert.equal(evaluateMaCross(data, 'LONG', config.strategies.LONG, now).exit, false);
});

test('live management ignores persisted hold limits on an old protected position', async () => {
  const engine = new FuturesScalperEngine({ exchange: {}, notifier: { send: async () => {} },
    environment: { SCALPER_STATE_FILE: `/tmp/ma-original-hold-${process.pid}.json` } });
  engine.symbolState('TEST').positions.LONG = { enteredAt: 1, risk: { maxHoldMinutes: 1 } };
  engine.scalperAlgoOrders = () => [{}, {}];
  engine.closePosition = () => { throw new Error('Protected position should remain open'); };
  assert.equal(await engine.ensureManagedPosition('TEST', { entryPrice: 100 }, 'LONG', []), false);
});
test('unfinished candles are ignored and stale or gapped histories deny entries', () => {
  const data = market(true, true);
  const expected = evaluateMaCross(data, 'LONG', config.strategies.LONG, now);
  data['1m'].push([now, 1, 1, 1, 1, 1, now + 59_999]);
  assert.deepEqual(evaluateMaCross(data, 'LONG', config.strategies.LONG, now), expected);
  assert.equal(evaluateMaCross(data, 'LONG', config.strategies.LONG, now + 120_000).allow, false);
  data['1m'].splice(data['1m'].length - 20, 1);
  assert.equal(evaluateMaCross(data, 'LONG', config.strategies.LONG, now).allow, false);
});
test('remaining above MA25 without a fresh cross does not re-enter', () => {
  const data = market(true, true);
  data['1m'] = rows([...Array(75).fill(90), ...Array(23).fill(100), 101, 102], '1m');
  assert.equal(evaluateMaCross(data, 'LONG', config.strategies.LONG, now).allow, false);
});
test('support/resistance uses historical cross intersections and excludes entry cross', () => {
  const prices = Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / 9));
  prices[prices.length - 1] = 100;
  const data = Object.fromEntries(Object.keys(TIMEFRAMES).map(tf => [tf, rows(prices, tf)]));
  const signal = evaluateMaCross(data, 'LONG', config.strategies.LONG, now);
  const sr = signal.supportResistance;
  assert.ok(sr.levels.length > 0);
  assert.ok(sr.support.price < signal.candle.close);
  assert.ok(sr.resistance.price > signal.candle.close);
  assert.ok(sr.levels.every(level => level.timestamp < signal.candleTimestamp));
  assert.equal(sr.support.price, Math.max(...sr.levels.filter(level => level.price < signal.candle.close).map(level => level.price)));
  assert.equal(sr.resistance.price, Math.min(...sr.levels.filter(level => level.price > signal.candle.close).map(level => level.price)));
  const flatThenUp = rows([...Array(25).fill(100), 110], '1m');
  const levels = historicalCrossLevels(flatThenUp, '1m', now);
  assert.equal(levels.length, 1);
  assert.equal(levels[0].price, 100);
  assert.equal(historicalCrossLevels(flatThenUp, '1m', flatThenUp.at(-1)[0]).length, 0);
});
test('invalid risk settings fail before any order can be submitted', () => {
  assert.throws(() => buildScalperConfig({ SCALPER_COUNTERTREND_SIZE_MULTIPLIER: '2' }), /between 0 and 1/);
  assert.throws(() => buildScalperConfig({ SCALPER_STOP_LOSS_PCT: '-1' }), /positive/);
});
test('countertrend order uses reduced size and persists protection through restart', async () => {
  const orders = [];
  const exchange = {
    fetchBalance: async () => ({ total: { USDT: 100 } }),
    fetchTicker: async () => ({ last: 100 }),
    amountToPrecision: (_s, amount) => String(amount),
    priceToPrecision: (_s, price) => String(price),
    market: () => ({ id: 'TESTUSDT', limits: {} }),
    createOrder: async (...args) => { orders.push(args); return { id: orders.length }; },
    fetchPositions: async () => [{ symbol: 'TEST', side: 'short', contracts: 0.4375, entryPrice: 100 }],
    fapiPrivateGetOpenAlgoOrders: async () => [],
  };
  const engine = new FuturesScalperEngine({ exchange, notifier: { send: async () => {} },
    environment: { SYMBOLS: 'TEST', KILL_SWITCH_ENABLED: 'false',
      SCALPER_STATE_FILE: `/tmp/ma-cross-test-${process.pid}.json` } });
  engine.save = () => {};
  const signal = evaluateMaCross(market(false, true), 'SHORT', config.strategies.SHORT, now);
  signal.supportResistance = { support: { price: 90 }, resistance: { price: 110 } };
  signal.risk = { ...signal.risk, ...historicalProtection(100, 'SHORT', signal.supportResistance) };
  signal.allow = true;
  await engine.enterPosition('TEST', 100, 'SHORT', signal);
  assert.ok(Math.abs(orders[0][3] * 99.98 - 43.75) < 1e-8);
  assert.equal(Number(orders[1][5].stopLossPrice), 110);
  assert.equal(Number(orders[2][5].takeProfitPrice), 90);
  assert.equal(engine.symbolState('TEST').positions.SHORT.risk.maxHoldMinutes, null);
  orders.length = 0;
  await engine.placeProtections('TEST', { entryPrice: 100 }, 'SHORT');
  assert.equal(Number(orders[0][5].stopLossPrice), 110);
});

test('historical protection maps levels symmetrically and rejects only missing or crossed levels', () => {
  const sr = { support: { price: 95 }, resistance: { price: 105 } };
  const long = historicalProtection(100, 'LONG', sr);
  const short = historicalProtection(100, 'SHORT', sr);
  assert.equal(long.takeProfitPrice, 105);
  assert.equal(long.stopLossPrice, 95);
  assert.equal(short.takeProfitPrice, 95);
  assert.equal(short.stopLossPrice, 105);
  assert.equal(historicalProtection(106, 'LONG', sr).valid, false);
  assert.equal(historicalProtection(100, 'LONG', {}).valid, false);
  const smallTarget = historicalProtection(100, 'LONG', { support: { price: 95 }, resistance: { price: 100.01 } });
  assert.equal(smallTarget.valid, true);
  assert.ok(smallTarget.estimatedNetReturn < 0);
});

test('cross target RR1 calculates mirrored stop using the filled entry and needs no opposing cross', () => {
  const long = historicalProtection(100, 'LONG', { resistance: { price: 102 } }, { stopMode: 'MIRROR_TARGET' });
  assert.equal(long.valid, true);
  assert.equal(long.stopLossPrice, 98);
  assert.equal(long.takeProfitPrice, 102);
  const short = historicalProtection(100, 'SHORT', { support: { price: 98 } }, { stopMode: 'MIRROR_TARGET' });
  assert.equal(short.stopLossPrice, 102);
  assert.equal(short.takeProfitPrice, 98);
  const filled = historicalProtection(100.5, 'LONG', { resistance: { price: 102 } }, { stopMode: 'MIRROR_TARGET' });
  assert.equal(filled.stopLossPrice, 99);
  assert.equal(long.protectionMode, 'CROSS_TARGET_RR1');
});

test('exchange SL is mirrored from filled entry rather than the signal candle entry', async () => {
  const orders = [];
  const exchange = {
    market: () => ({ id: 'TEST' }), fapiPrivateGetOpenAlgoOrders: async () => [],
    priceToPrecision: (_symbol, price) => String(price),
    createOrder: async (...args) => { orders.push(args); return { id: String(orders.length) }; },
  };
  const engine = new FuturesScalperEngine({ exchange, notifier: { send: async () => {} },
    environment: { SCALPER_STATE_FILE: `/tmp/mirror-actual-entry-${process.pid}.json` } });
  engine.symbolState('TEST').positions.LONG = { risk: { side: 'LONG', protectionMode: 'CROSS_TARGET_RR1',
    takeProfitPrice: 102, stopLossPrice: 98 } };
  await engine.placeProtections('TEST', { entryPrice: 100.5 }, 'LONG');
  assert.equal(Number(orders[0][5].stopLossPrice), 99);
  assert.equal(Number(orders[1][5].takeProfitPrice), 102);
});

test('historical levels include all three MA pairs with fully initialized MA99', () => {
  const prices = Array.from({ length: 350 }, (_, i) => 100 + 10 * Math.sin(i / 12));
  const data = rows(prices, '1m');
  const levels = historicalCrossLevels(data, '1m', now);
  assert.deepEqual([...new Set(levels.map(level => level.pair))].sort(), ['MA25/MA99', 'MA7/MA25', 'MA7/MA99']);
  for (const level of levels.filter(level => level.slowPeriod === 99)) {
    const index = data.findIndex(row => Number(row[0]) === level.timestamp);
    assert.ok(index >= 99);
    const average = (end, period) => prices.slice(end - period + 1, end + 1).reduce((a, b) => a + b, 0) / period;
    const prevFast = average(index - 1, level.fastPeriod);
    const prevSlow = average(index - 1, level.slowPeriod);
    const fast = average(index, level.fastPeriod);
    const slow = average(index, level.slowPeriod);
    const fraction = -(prevFast - prevSlow) / ((fast - slow) - (prevFast - prevSlow));
    assert.ok(Math.abs(level.price - (prevFast + fraction * (fast - prevFast))) < 1e-8);
  }
  const old = historicalCrossLevels(data, '1m', now, [[7, 25]]);
  assert.ok(old.every(level => level.pair === 'MA7/MA25'));
  assert.deepEqual(historicalCrossLevels([...data, [now, 1, 1, 1, 1, 0, now + 59_999]], '1m', now), levels);
});

test('MA99 cross contributes levels without creating an extra MA7/MA25 entry', () => {
  const prices = Array.from({ length: 350 }, (_, i) => 100 + 10 * Math.sin(i / 12));
  const data = rows(prices, '1m');
  const levels = historicalCrossLevels(data, '1m', now);
  const cross99 = levels.find(level => level.slowPeriod === 99 &&
    !levels.some(other => other.timestamp === level.timestamp && other.pair === 'MA7/MA25'));
  assert.ok(cross99);
  const index = data.findIndex(row => Number(row[0]) === cross99.timestamp);
  const history = Object.fromEntries(Object.keys(TIMEFRAMES).map(tf => [tf,
    rows(tf === '1m' ? prices.slice(0, index + 1) : prices, tf)]));
  for (const side of ['LONG', 'SHORT']) {
    const signal = evaluateMaCross(history, side, config.strategies[side], now);
    assert.equal(signal.available, true);
    assert.equal(signal.allow, false);
  }
});

test('entry signal exposes ranked historical levels and refuses insufficient cross candidates', () => {
  const data = market(true, true);
  const strategy = buildScalperConfig({}).strategies.LONG;
  const selected = evaluateMaCross(data, 'LONG', strategy, now);
  assert.equal(selected.supportResistance.source, 'SELECTED_HISTORICAL_CROSSES');
  assert.deepEqual(selected.supportResistance.selection, strategy.crossSelection);
  assert.ok(selected.supportResistance.levels.every(level => Number.isInteger(level.supportRetests) && Number.isInteger(level.resistanceRetests)));
  const insufficient = evaluateMaCross(data, 'LONG', { ...strategy,
    crossSelection: { ...strategy.crossSelection, targetIndex: 9999 } }, now);
  assert.equal(insufficient.allow, false);
  assert.equal(insufficient.risk.valid, false);
  assert.equal(insufficient.supportResistance.resistance, null);
});

test('live entry does not place an order when current price already crossed the selected target', async () => {
  let orders = 0;
  const engine = new FuturesScalperEngine({
    exchange: { fetchTicker: async () => ({ ask: 106 }), createOrder: async () => { orders++; } },
    notifier: { send: async () => {} },
    environment: { KILL_SWITCH_ENABLED: 'false', SCALPER_STATE_FILE: `/tmp/ma-sr-gap-${process.pid}.json` },
  });
  const supportResistance = { support: { price: 95 }, resistance: { price: 105 } };
  await engine.enterPosition('TEST', 100, 'LONG', { allow: true, supportResistance,
    risk: { side: 'LONG', ...historicalProtection(100, 'LONG', supportResistance) } });
  assert.equal(orders, 0);
});
