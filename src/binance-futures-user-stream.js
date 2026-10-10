const DEFAULT_KEEPALIVE_MS = 45 * 60 * 1000;
const DEFAULT_RECONNECT_MAX_MS = 30 * 1000;

function extractListenKey(response) {
  const listenKey = response?.listenKey ?? response?.info?.listenKey;
  if (typeof listenKey !== 'string' || !listenKey.trim()) {
    throw new Error('Binance did not return a futures user-stream listenKey');
  }
  return listenKey.trim();
}

function parseMessageData(data) {
  if (typeof data === 'string') return JSON.parse(data);
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8'));
  if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString('utf8'));
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
  }
  return JSON.parse(String(data));
}

class BinanceFuturesUserStream {
  constructor(options = {}) {
    this.exchange = options.exchange;
    this.enabled = options.enabled !== false;
    this.wsBaseUrl = String(options.wsBaseUrl || 'wss://fstream.binance.com/ws').replace(/\/$/, '');
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.keepaliveMs = Math.max(1000, Number(options.keepaliveMs) || DEFAULT_KEEPALIVE_MS);
    this.reconnectMaxMs = Math.max(1000, Number(options.reconnectMaxMs) || DEFAULT_RECONNECT_MAX_MS);
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.logger = options.logger || console;
    this.random = options.random || Math.random;
    this.socket = null;
    this.listenKey = null;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.connectPromise = null;
    this.reconnectAttempts = 0;
    this.stopped = true;
  }

  async start() {
    if (!this.enabled) return false;
    if (!this.exchange?.fapiPrivatePostListenKey) {
      throw new Error('CCXT exchange does not support Binance Futures listenKey endpoints');
    }
    if (typeof this.WebSocketImpl !== 'function') {
      throw new Error('WebSocket is unavailable in this Node.js runtime');
    }
    this.stopped = false;
    try {
      await this.connect();
      return true;
    } catch (error) {
      this.logger.warn(`[USER-STREAM] Initial connection failed: ${error.message}`);
      this.scheduleReconnect();
      return false;
    }
  }

  async connect() {
    if (this.stopped || !this.enabled) return false;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openConnection().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async openConnection() {
    const response = await this.exchange.fapiPrivatePostListenKey();
    const listenKey = extractListenKey(response);
    if (this.stopped) return false;

    this.listenKey = listenKey;
    const socket = new this.WebSocketImpl(`${this.wsBaseUrl}/${encodeURIComponent(listenKey)}`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.reconnectAttempts = 0;
      this.scheduleKeepalive();
      this.logger.log('[USER-STREAM] Binance Futures WebSocket connected');
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const payload = parseMessageData(event.data);
        if (payload?.e === 'listenKeyExpired') {
          this.logger.warn('[USER-STREAM] Binance listenKey expired; reconnecting');
          socket.close();
          return;
        }
        Promise.resolve(this.onEvent(payload)).catch(error => {
          this.logger.warn(`[USER-STREAM] Event handler failed: ${error.message}`);
        });
      } catch (error) {
        this.logger.warn(`[USER-STREAM] Invalid event payload: ${error.message}`);
      }
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket && !this.stopped) {
        this.logger.warn('[USER-STREAM] WebSocket transport error');
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      this.clearKeepalive();
      if (!this.stopped) this.scheduleReconnect();
    });
    return true;
  }

  scheduleKeepalive() {
    this.clearKeepalive();
    this.keepaliveTimer = setInterval(() => {
      this.keepalive().catch(error => {
        this.logger.warn(`[USER-STREAM] ListenKey keepalive failed: ${error.message}`);
        this.restartConnection();
      });
    }, this.keepaliveMs);
    this.keepaliveTimer.unref?.();
  }

  async keepalive() {
    if (this.stopped || !this.listenKey) return;
    await this.exchange.fapiPrivatePutListenKey();
  }

  restartConnection() {
    const socket = this.socket;
    this.socket = null;
    this.clearKeepalive();
    try { socket?.close(); } catch {}
    if (!this.stopped) this.scheduleReconnect(0);
  }

  scheduleReconnect(delayOverride = null) {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = this.reconnectAttempts++;
    const baseDelay = Math.min(this.reconnectMaxMs, 1000 * (2 ** Math.min(attempt, 5)));
    const jitter = Math.floor(baseDelay * 0.2 * this.random());
    const delay = delayOverride === null ? baseDelay + jitter : Math.max(0, delayOverride);
    this.logger.warn(`[USER-STREAM] Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(error => {
        this.logger.warn(`[USER-STREAM] Reconnect failed: ${error.message}`);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  clearKeepalive() {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  stop() {
    this.stopped = true;
    this.clearKeepalive();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch {}
  }
}

module.exports = {
  BinanceFuturesUserStream,
  extractListenKey,
  parseMessageData,
};
