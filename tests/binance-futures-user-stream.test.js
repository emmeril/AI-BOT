const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BinanceFuturesUserStream,
  extractListenKey,
} = require('../src/binance-futures-user-stream');

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  emit(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

test('futures user stream opens with a listenKey and forwards parsed events', async () => {
  FakeWebSocket.instances = [];
  const events = [];
  const stream = new BinanceFuturesUserStream({
    exchange: {
      fapiPrivatePostListenKey: async () => ({ listenKey: 'listen-key-1' }),
      fapiPrivatePutListenKey: async () => ({}),
    },
    WebSocketImpl: FakeWebSocket,
    wsBaseUrl: 'wss://example.test/ws/',
    onEvent: event => events.push(event),
    logger: { log() {}, warn() {} },
  });

  assert.equal(await stream.start(), true);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://example.test/ws/listen-key-1');

  socket.emit('open');
  socket.emit('message', {
    data: JSON.stringify({ e: 'ORDER_TRADE_UPDATE', o: { s: 'BTCUSDT', x: 'TRADE' } }),
  });
  await Promise.resolve();

  assert.equal(events.length, 1);
  assert.equal(events[0].o.s, 'BTCUSDT');
  stream.stop();
  assert.equal(socket.closed, true);
});

test('stopping a closed user stream prevents reconnect', async () => {
  FakeWebSocket.instances = [];
  const warnings = [];
  const stream = new BinanceFuturesUserStream({
    exchange: {
      fapiPrivatePostListenKey: async () => ({ listenKey: 'listen-key-2' }),
      fapiPrivatePutListenKey: async () => ({}),
    },
    WebSocketImpl: FakeWebSocket,
    logger: { log() {}, warn(message) { warnings.push(message); } },
  });

  await stream.start();
  const socket = FakeWebSocket.instances[0];
  stream.stop();

  assert.equal(stream.reconnectTimer, null);
  assert.equal(warnings.some(message => message.includes('Reconnecting')), false);
  assert.equal(socket.closed, true);
});

test('listenKey extraction rejects malformed Binance responses', () => {
  assert.equal(extractListenKey({ info: { listenKey: 'nested-key' } }), 'nested-key');
  assert.throws(() => extractListenKey({}), /listenKey/);
});
