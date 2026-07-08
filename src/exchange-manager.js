const ccxt = require('ccxt');
const { EXCHANGE_MODE, VALID_EXCHANGE_MODES } = require('./config');

class ExchangeManager {
  static instance = null;

  static getInstance() {
    if (!this.instance) {
      if (!VALID_EXCHANGE_MODES.has(EXCHANGE_MODE)) {
        throw new Error(`EXCHANGE_MODE invalid: ${EXCHANGE_MODE}. Use live or testnet.`);
      }
      this.instance = new ccxt.binance({
        apiKey: process.env.EXCHANGE_API_KEY,
        secret: process.env.EXCHANGE_SECRET,
        enableRateLimit: true,
        options: {
          defaultType: 'spot',
          fetchMarkets: { types: ['spot'] },
          adjustForTimeDifference: true,
          recvWindow: 10000,
        },
      });
      if (EXCHANGE_MODE === 'testnet') {
        this.instance.setSandboxMode(true);
      }
    }
    return this.instance;
  }
}

module.exports = { ExchangeManager };
