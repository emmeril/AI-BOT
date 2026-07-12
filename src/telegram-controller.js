const fs = require('fs');
const https = require('https');
const {
  SYMBOLS,
  EXCHANGE_MODE,
  KILL_SWITCH_ENABLED,
  STOP_TRADING,
  KILL_SWITCH_FILE,
  KILL_SWITCH_PATH,
  TELEGRAM_ENABLED,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_API_URL,
  TELEGRAM_TIMEOUT_MS,
  TELEGRAM_STATUS_REPORT_ENABLED,
  TELEGRAM_STATUS_REPORT_INTERVAL_MS,
  TELEGRAM_COMMANDS_ENABLED,
  TELEGRAM_COMMAND_POLL_INTERVAL_MS,
  TELEGRAM_COMMANDS_SKIP_OLD_UPDATES
} = require('./config');
const { retry, roundNumber } = require('./utils');

function killSwitchActive() {
  if (STOP_TRADING) return true;
  if (!KILL_SWITCH_ENABLED) return false;
  try {
    return fs.existsSync(KILL_SWITCH_PATH);
  } catch {
    return false;
  }
}

function telegramReady() {
  return TELEGRAM_ENABLED && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID;
}

async function telegramRequest(method, payload = null, query = null) {
  if (!this.telegramReady()) return null;
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const body = payload ? JSON.stringify(payload) : '';
  return await new Promise((resolve, reject) => {
    const req = https.request(`${TELEGRAM_API_URL}/bot${TELEGRAM_BOT_TOKEN}/${method}${qs}`, {
      method: payload ? 'POST' : 'GET',
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      } : undefined,
      timeout: TELEGRAM_TIMEOUT_MS,
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.once('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Telegram ${method} returned HTTP ${response.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch (err) {
          reject(new Error(`Telegram ${method} returned invalid JSON: ${err.message}`));
        }
      });
    });
    req.once('timeout', () => req.destroy(new Error(`Telegram request timed out after ${TELEGRAM_TIMEOUT_MS}ms`)));
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function formatPrice(value) {
  const abs = Math.abs(Number(value));
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 8;
  const rounded = roundNumber(value, digits);
  return rounded === null ? 'n/a' : String(rounded);
}

function formatAmount(value) {
  const rounded = roundNumber(value, 8);
  return rounded === null ? 'n/a' : String(rounded);
}

function formatMoney(value) {
  const rounded = roundNumber(value, 4);
  return rounded === null ? 'n/a' : String(rounded);
}

function formatTelegramMessage(title, rows = []) {
  const body = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${label}: ${value}`);
  return [`[${title}]`, ...body].join('\n');
}

function getPauseStatusText() {
  if (STOP_TRADING) return 'STOP_TRADING=true';
  if (!KILL_SWITCH_ENABLED) return 'kill switch disabled';
  return killSwitchActive() ? `paused (${KILL_SWITCH_FILE})` : 'active';
}

async function buildSymbolStatusLine(symbol) {
  const symState = this.state.getSymbol(symbol);
  const [ticker, openOrders, balance] = await Promise.all([
    retry(() => this.exchange.fetchTicker(symbol)),
    retry(() => this.exchange.fetchOpenOrders(symbol)),
    retry(() => this.exchange.fetchBalance()),
  ]);
  const managedIds = new Set(Object.keys(symState.orders));
  const managedOrders = openOrders.filter(order =>
    managedIds.has(String(order.id)) || this.getBotOrderLevel(order) !== null
  );
  const buyCount = managedOrders.filter(order => String(order.side).toLowerCase() === 'buy').length;
  const sellCount = managedOrders.filter(order => String(order.side).toLowerCase() === 'sell').length;
  const base = this.getBaseAsset(symbol);
  const quote = this.getQuoteAsset(symbol);
  const lower = Number(symState.config?.lower) || 0;
  const upper = Number(symState.config?.upper) || 0;
  const rangeText = lower > 0 && upper > 0
    ? `${this.formatPrice(lower)}-${this.formatPrice(upper)}`
    : 'not initialized';
  return [
    '',
    symbol,
    `Price: ${this.formatPrice(ticker.last)}`,
    `Range: ${rangeText}`,
    `Orders: ${buyCount} buy / ${sellCount} sell`,
    `Free ${quote}: ${this.formatMoney(this.getQuoteFree(balance, symbol))}`,
    `Free ${base}: ${this.formatAmount(this.getBaseFree(balance, symbol))}`,
    `Profit: ${this.formatMoney(symState.realizedGridProfit)} ${quote}`,
  ].join('\n');
}

async function buildStatusMessage() {
  const lines = [
    '[Status]',
    `Mode: ${EXCHANGE_MODE}`,
    `Trading: ${this.getPauseStatusText()}`,
    `Circuit: ${this.circuitAllows() ? 'OK' : 'PAUSED'}`,
    `Filled: ${this.state.data.totals.filledBuys} buy / ${this.state.data.totals.filledSells} sell`,
    `Total Profit: ${this.formatMoney(this.state.data.totals.realizedGridProfit)}`,
  ];
  for (const symbol of SYMBOLS) {
    try {
      lines.push(await this.buildSymbolStatusLine(symbol));
    } catch (err) {
      lines.push('', symbol, `Status Error: ${err.message}`);
    }
  }
  return lines.join('\n').slice(0, 3900);
}

async function buildOrdersMessage() {
  const lines = ['[Orders]'];
  for (const symbol of SYMBOLS) {
    try {
      const symState = this.state.getSymbol(symbol);
      const openOrders = await retry(() => this.exchange.fetchOpenOrders(symbol));
      const managedIds = new Set(Object.keys(symState.orders));
      const managedOrders = openOrders.filter(order =>
        managedIds.has(String(order.id)) || this.getBotOrderLevel(order) !== null
      );
      const buys = managedOrders.filter(order => String(order.side).toLowerCase() === 'buy');
      const sells = managedOrders.filter(order => String(order.side).toLowerCase() === 'sell');
      lines.push('', symbol, `Active: ${buys.length} buy / ${sells.length} sell`, `Tracked: ${Object.keys(symState.orders).length}`);
      for (const order of managedOrders.slice(0, 12)) {
        const level = this.getBotOrderLevel(order) ?? symState.orders[String(order.id)]?.levelIndex ?? '?';
        lines.push(`${String(order.side).toUpperCase()} L${level} | ${this.formatAmount(order.amount)} @ ${this.formatPrice(order.price)}`);
      }
      if (managedOrders.length > 12) lines.push(`... ${managedOrders.length - 12} more`);
    } catch (err) {
      lines.push('', symbol, `Orders Error: ${err.message}`);
    }
  }
  return lines.join('\n').slice(0, 3900);
}

async function handleTelegramCommand(text) {
  const command = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@.+$/, '');
  if (!command) return;
  if (command === '/status') {
    await this.sendAlert(await this.buildStatusMessage());
    return;
  }
  if (command === '/orders') {
    await this.sendAlert(await this.buildOrdersMessage());
    return;
  }
  if (command === '/pause') {
    if (!KILL_SWITCH_ENABLED) {
      await this.sendAlert(this.formatTelegramMessage('Pause Rejected', [
        ['Trading', 'still active'],
        ['Reason', 'KILL_SWITCH_ENABLED=false'],
      ]));
      return;
    }
    await fs.promises.writeFile(KILL_SWITCH_PATH, `paused by telegram at ${new Date().toISOString()}\n`);
    await this.sendAlert(this.formatTelegramMessage('Paused', [
      ['File', KILL_SWITCH_FILE],
      ['Trading', 'new orders paused'],
    ]));
    return;
  }
  if (command === '/resume') {
    try {
      await fs.promises.unlink(KILL_SWITCH_PATH);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await this.sendAlert(this.formatTelegramMessage('Resumed', [
      ['File', `${KILL_SWITCH_FILE} removed`],
      ['Trading', STOP_TRADING ? 'still stopped by STOP_TRADING=true' : 'active'],
    ]));
    return;
  }
  if (command === '/help' || command === '/start') {
    await this.sendAlert([
      '[Commands]',
      '/status - bot summary',
      '/orders - active grid orders',
      '/pause - create kill-switch file',
      '/resume - remove kill-switch file',
    ].join('\n'));
  }
}

async function pollTelegramCommands() {
  if (!TELEGRAM_COMMANDS_ENABLED || !this.telegramReady() || this.telegramPolling) return;
  this.telegramPolling = true;
  try {
    const query = { timeout: '0', limit: '20', allowed_updates: JSON.stringify(['message']) };
    if (this.telegramUpdateOffset !== null) query.offset = String(this.telegramUpdateOffset);
    const response = await this.telegramRequest('getUpdates', null, query);
    const updates = Array.isArray(response?.result) ? response.result : [];
    for (const update of updates) {
      this.telegramUpdateOffset = Math.max(this.telegramUpdateOffset || 0, Number(update.update_id) + 1);
      const message = update.message;
      const chatId = String(message?.chat?.id || '');
      if (chatId !== String(TELEGRAM_CHAT_ID)) continue;
      const text = String(message?.text || '').trim();
      if (text.startsWith('/')) await this.handleTelegramCommand(text);
    }
  } catch (err) {
    console.warn('[TELEGRAM] Command polling failed:', err.message);
  } finally {
    this.telegramPolling = false;
  }
}

async function startTelegramCommandPolling() {
  if (!TELEGRAM_COMMANDS_ENABLED || !this.telegramReady() || this.telegramCommandTimer) return;
  if (TELEGRAM_COMMANDS_SKIP_OLD_UPDATES) {
    try {
      const response = await this.telegramRequest('getUpdates', null, {
        offset: '-1',
        limit: '1',
        timeout: '0',
        allowed_updates: JSON.stringify(['message']),
      });
      const latest = Array.isArray(response?.result) ? response.result.at(-1) : null;
      this.telegramUpdateOffset = latest ? Number(latest.update_id) + 1 : null;
    } catch (err) {
      console.warn('[TELEGRAM] Failed to initialize command offset:', err.message);
    }
  }
  this.telegramCommandTimer = setInterval(() => {
    this.pollTelegramCommands().catch(err => console.warn('[TELEGRAM] Command polling failed:', err.message));
  }, TELEGRAM_COMMAND_POLL_INTERVAL_MS);
  await this.pollTelegramCommands();
}

function startTelegramStatusReports() {
  if (!TELEGRAM_STATUS_REPORT_ENABLED || !this.telegramReady() || this.telegramStatusTimer) return;
  this.telegramStatusTimer = setInterval(() => {
    this.sendTelegramStatusReport().catch(err => console.warn('[TELEGRAM] Status report failed:', err.message));
  }, TELEGRAM_STATUS_REPORT_INTERVAL_MS);
}

async function sendTelegramStatusReport() {
  if (this.telegramStatusReporting) return;
  this.telegramStatusReporting = true;
  try {
    await this.sendAlert(await this.buildStatusMessage());
  } finally {
    this.telegramStatusReporting = false;
  }
}

async function sendAlert(message) {
  if (!this.telegramReady()) return;
  try {
    await this.telegramRequest('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.warn('[ALERT] Failed:', err.message);
  }
}


const telegramMethods = {
  telegramReady,
  telegramRequest,
  formatPrice,
  formatAmount,
  formatMoney,
  formatTelegramMessage,
  getPauseStatusText,
  buildSymbolStatusLine,
  buildStatusMessage,
  buildOrdersMessage,
  handleTelegramCommand,
  pollTelegramCommands,
  startTelegramCommandPolling,
  startTelegramStatusReports,
  sendTelegramStatusReport,
  sendAlert,
};

function applyTelegramMethods(target) {
  Object.assign(target.prototype, telegramMethods);
}

module.exports = {
  applyTelegramMethods,
  telegramMethods,
};
