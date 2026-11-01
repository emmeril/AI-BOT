'use strict';

const https = require('https');
const { booleanValue } = require('./environment');

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
  formatNumber,
  formatScalperMessage,
  ScalperTelegramNotifier,
};
