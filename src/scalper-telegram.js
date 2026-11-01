'use strict';

const https = require('https');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function formatNumber(value, maximumFractionDigits = 8) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'N/A';
  return new Intl.NumberFormat('id-ID', {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(number);
}

function formatScalperMessage(title, rows = []) {
  const body = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${label}: ${value}`);
  return [`[${title}]`, '', ...body].join('\n');
}

function normalizeAlgoOrders(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.orders)) return response.orders;
  return [];
}

function algoClientId(order) {
  return String(order?.clientAlgoId || order?.clientOrderId || order?.info?.clientAlgoId || '');
}

function algoPositionSide(order) {
  const explicit = String(order?.positionSide || order?.info?.positionSide || '').toUpperCase();
  if (explicit === 'LONG' || explicit === 'SHORT') return explicit;
  const clientId = algoClientId(order);
  if (clientId.startsWith('scalp-l-')) return 'LONG';
  if (clientId.startsWith('scalp-s-')) return 'SHORT';
  return null;
}

function algoKind(order) {
  const type = String(order?.orderType || order?.type || order?.info?.orderType || '').toUpperCase();
  const clientId = algoClientId(order);
  if (type.includes('TAKE_PROFIT') || clientId.includes('-tp-')) return 'TAKE_PROFIT';
  if (type.includes('STOP') || clientId.includes('-sl-')) return 'STOP_LOSS';
  return type || 'CONDITIONAL';
}

function algoTriggerPrice(order) {
  const value = Number(order?.triggerPrice ?? order?.stopPrice ?? order?.info?.triggerPrice ?? order?.info?.stopPrice);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function scalperProtectionSnapshot(response, side, hasOpenPosition) {
  const expectedSide = String(side || '').toUpperCase();
  const orders = normalizeAlgoOrders(response)
    .filter(order => algoClientId(order).startsWith('scalp-'))
    .filter(order => algoPositionSide(order) === expectedSide)
    .map(order => ({
      id: String(order.algoId || order.id || ''),
      clientId: algoClientId(order),
      positionSide: expectedSide,
      side: String(order.side || order.info?.side || '').toLowerCase(),
      kind: algoKind(order),
      triggerPrice: algoTriggerPrice(order),
      closePosition: booleanValue(order.closePosition ?? order.info?.closePosition, false),
    }));
  const takeProfit = orders.find(order => order.kind === 'TAKE_PROFIT') || null;
  const stopLoss = orders.find(order => order.kind === 'STOP_LOSS') || null;
  const covered = Boolean(hasOpenPosition && takeProfit && stopLoss);
  return {
    status: !hasOpenPosition ? 'NOT_REQUIRED' : covered ? 'PROTECTED' : 'INCOMPLETE',
    covered,
    count: orders.length,
    takeProfit,
    stopLoss,
    orders,
  };
}

class ScalperTelegramNotifier {
  constructor(environment = process.env, request = https.request) {
    this.enabled = booleanValue(environment.TELEGRAM_ENABLED, false) &&
      Boolean(environment.TELEGRAM_BOT_TOKEN) && Boolean(environment.TELEGRAM_CHAT_ID);
    this.token = String(environment.TELEGRAM_BOT_TOKEN || '');
    this.chatId = String(environment.TELEGRAM_CHAT_ID || '');
    this.apiUrl = String(environment.TELEGRAM_API_URL || 'https://api.telegram.org').trim().replace(/\/+$/, '');
    this.timeoutMs = Math.max(1000, Number(environment.TELEGRAM_TIMEOUT_MS) || 10000);
    this.request = request;
  }

  async send(title, rows = []) {
    if (!this.enabled) return false;
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: formatScalperMessage(title, rows),
      disable_web_page_preview: true,
    });
    await new Promise((resolve, reject) => {
      const request = this.request(`${this.apiUrl}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: this.timeoutMs,
      }, response => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.once('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve();
          else reject(new Error(`Telegram returned HTTP ${response.statusCode}: ${data}`));
        });
      });
      request.once('timeout', () => request.destroy(new Error(`Telegram timed out after ${this.timeoutMs}ms`)));
      request.once('error', reject);
      request.end(body);
    });
    return true;
  }
}

module.exports = {
  ScalperTelegramNotifier,
  algoClientId,
  algoKind,
  algoPositionSide,
  algoTriggerPrice,
  booleanValue,
  formatNumber,
  formatScalperMessage,
  normalizeAlgoOrders,
  scalperProtectionSnapshot,
};
