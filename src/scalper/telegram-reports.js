'use strict';

const { buildScalperConfig } = require('./config');
const { fetchOpenAlgoOrders, scalperProtectionSnapshot } = require('./order-inspection');
const { positionForSide } = require('./position-policy');
const { loadState } = require('./state-store');
const { formatNumber } = require('./telegram-notifier');

class ScalperTelegramReports {
  constructor({ exchange, environment = process.env, retry = operation => operation(), stateLoader = loadState } = {}) {
    if (!exchange) throw new Error('ScalperTelegramReports requires an exchange');
    this.exchange = exchange;
    this.config = buildScalperConfig(environment);
    this.retry = retry;
    this.stateLoader = stateLoader;
  }

  async algoOrders(symbol) {
    return this.retry(() => fetchOpenAlgoOrders(this.exchange, symbol));
  }

  async status({ paused = false } = {}) {
    const positions = await this.retry(() => this.exchange.fetchPositions(this.config.symbols));
    const scalperState = this.stateLoader(this.config.statePath);
    const lines = [
      '[STATUS SCALPER FUTURES]',
      '',
      `Trading: ${this.config.tradingEnabled && !this.config.stopTrading && !paused ? 'AKTIF' : 'DIJEDA'}`,
      `Strategi: Volume delta reversal ${this.config.timeframe}`,
      `Sisi: ${this.config.activeSides.join(' + ') || 'EXIT-ONLY'}`,
      `Alokasi: LONG ${formatNumber(this.config.allocations.LONG)}% + SHORT ${formatNumber(this.config.allocations.SHORT)}%`,
    ];

    for (const symbol of this.config.symbols) {
      const algoOrders = await this.algoOrders(symbol);
      const symbolState = scalperState.symbols?.[symbol] || {};
      lines.push('', symbol, `Handoff: ${symbolState.handoffActive ? 'SIAP' : 'MENYELESAIKAN POSISI LAMA'}`);
      for (const side of ['LONG', 'SHORT']) {
        const position = positionForSide(positions, symbol, side);
        const protection = scalperProtectionSnapshot(algoOrders, side, Boolean(position));
        const signal = symbolState.signals?.[side];
        const signalText = !signal?.available ? 'menunggu candle' : signal.allow ? 'ENTRY' : 'menunggu';
        const enabled = this.config.activeSides.includes(side);
        if (!position) {
          lines.push(`${side}: ${enabled ? 'kosong' : 'entry nonaktif'} | Sinyal ${signalText}`);
          continue;
        }
        lines.push(
          `${side}: ${formatNumber(position.contracts)} kontrak @ ${formatNumber(position.entryPrice)}`,
          `TP/SL ${side}: ${protection.covered ? 'LENGKAP' : 'PERLU DIPERIKSA'} | PnL ${formatNumber(position.unrealizedPnl, 4)} USDT`
        );
      }
    }
    return lines.join('\n').slice(0, 3900);
  }

  async orders() {
    const positions = await this.retry(() => this.exchange.fetchPositions(this.config.symbols));
    const lines = ['[ORDER SCALPER FUTURES]'];
    for (const symbol of this.config.symbols) {
      const [regularOrders, algoOrders] = await Promise.all([
        this.retry(() => this.exchange.fetchOpenOrders(symbol)),
        this.algoOrders(symbol),
      ]);
      lines.push('', symbol);
      let count = 0;
      for (const side of ['LONG', 'SHORT']) {
        const position = positionForSide(positions, symbol, side);
        const protection = scalperProtectionSnapshot(algoOrders, side, Boolean(position));
        for (const order of protection.orders) {
          count += 1;
          lines.push(`${side} ${order.kind}: ${formatNumber(order.triggerPrice)} | close position`);
        }
      }
      for (const order of regularOrders) {
        count += 1;
        lines.push(
          `${String(order.side || '').toUpperCase()} REGULAR: ` +
          `${formatNumber(order.amount)} @ ${formatNumber(order.price)}`
        );
      }
      if (!count) lines.push('Tidak ada order aktif');
    }
    return lines.join('\n').slice(0, 3900);
  }
}

module.exports = {
  positionForSide,
  ScalperTelegramReports,
};
