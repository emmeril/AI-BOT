const fs = require('fs');
const http = require('http');
const path = require('path');
const { retry, numberOrZero } = require('./utils');
const { createDashboardAuth } = require('./dashboard-auth');
const {
  marketPrice,
  marketPriceText,
  marketAmountText,
  precisionDigits,
  normalizeOrder,
} = require('./dashboard-server');

const dashboardFile = path.join(__dirname, '..', 'public', 'dashboard.html');
const enabled = String(process.env.FUTURES_DASHBOARD_ENABLED ?? 'true').toLowerCase() !== 'false';
const host = process.env.FUTURES_DASHBOARD_HOST || '0.0.0.0';
const port = Math.max(Number(process.env.FUTURES_DASHBOARD_PORT || 3988), 1);
const refreshSeconds = Math.max(Number(process.env.FUTURES_DASHBOARD_REFRESH_SECONDS || 5), 2);
const timeframe = process.env.FUTURES_DASHBOARD_CHART_TIMEFRAME || '1m';
const chartLimit = Math.max(Number(process.env.FUTURES_DASHBOARD_CHART_LIMIT || 120), 20);
const authEnabled = String(
  process.env.FUTURES_DASHBOARD_AUTH_ENABLED ?? process.env.DASHBOARD_AUTH_ENABLED ?? 'false'
).toLowerCase() === 'true';
const authUsername = process.env.FUTURES_DASHBOARD_USERNAME || process.env.DASHBOARD_USERNAME || '';
const authPassword = process.env.FUTURES_DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD || '';
const authSessionHours = Math.max(Number(
  process.env.FUTURES_DASHBOARD_SESSION_HOURS || process.env.DASHBOARD_SESSION_HOURS || 12
), 1);

function positionMetrics(position, leverage, openPositionFees = 0) {
  if (!position) return null;
  const safeLeverage = Number(leverage) > 0 ? Number(leverage) : 1;
  const contracts = numberOrZero(position.contracts);
  const notional = Math.abs(numberOrZero(position.notional ?? position.info?.notional));
  const positionMargin = numberOrZero(
    position.info?.positionInitialMargin ?? position.initialMargin ?? (notional / safeLeverage)
  );
  const unrealizedPnl = numberOrZero(position.unrealizedPnl ?? position.info?.unRealizedProfit);
  return {
    contracts,
    notional,
    entryPrice: numberOrZero(position.entryPrice),
    markPrice: numberOrZero(position.markPrice ?? position.info?.markPrice),
    liquidationPrice: numberOrZero(position.liquidationPrice ?? position.info?.liquidationPrice),
    positionMargin,
    roiPct: positionMargin > 0 ? (unrealizedPnl / positionMargin) * 100 : 0,
    unrealizedPnl,
    openPositionFees: numberOrZero(openPositionFees),
  };
}

async function buildFuturesDashboardSnapshot(engine, requestedSymbol) {
  const symbols = engine.constructor.SYMBOLS || String(process.env.SYMBOLS || '').split(',').filter(Boolean);
  const symbol = symbols.includes(requestedSymbol) ? requestedSymbol : symbols[0];
  const symState = engine.state.getSymbol(symbol);
  const [ticker, exchangeOrders, candles, balance, positions] = await Promise.all([
    retry(() => engine.exchange.fetchTicker(symbol)),
    retry(() => engine.exchange.fetchOpenOrders(symbol)),
    retry(() => engine.exchange.fetchOHLCV(symbol, timeframe, undefined, chartLimit)),
    retry(() => engine.exchange.fetchBalance()),
    retry(() => engine.exchange.fetchPositions([symbol])),
  ]);
  const managedIds = new Set(Object.keys(symState.orders));
  const orders = exchangeOrders
    .filter(order => managedIds.has(String(order.id)) || engine.getBotOrderLevel(order) !== null)
    .map(order => normalizeOrder(engine, symbol, order, symState.orders[String(order.id)]));
  const long = positions.find(position => String(position.side || '').toLowerCase() === 'long' && Number(position.contracts) > 0);
  const freeUsdt = numberOrZero(balance?.free?.USDT);
  const totalUsdt = numberOrZero(balance?.total?.USDT);
  const unrealizedPnl = numberOrZero(long?.unrealizedPnl ?? long?.info?.unRealizedProfit);
  const realized = numberOrZero(symState.realizedGridProfit) + numberOrZero(symState.realizedExitProfit);
  const funding = numberOrZero(symState.fundingProfit);
  const fee = numberOrZero(symState.tradingFees);
  const openPositionFees = Object.values(symState.lastBuyByLevel || {})
    .reduce((sum, buy) => sum + numberOrZero(buy?.totalFeeQuote), 0);
  const leverage = Number(process.env.LEVERAGE) || 0;
  const position = positionMetrics(long, leverage, openPositionFees);
  const walletInfo = balance?.info || {};
  const walletBalance = numberOrZero(walletInfo.totalWalletBalance ?? balance?.total?.USDT);
  const availableBalance = numberOrZero(walletInfo.availableBalance ?? freeUsdt);
  const positionMargin = position ? numberOrZero(position.positionMargin) : 0;
  const openOrderMargin = numberOrZero(walletInfo.totalOpenOrderInitialMargin);
  const usedMargin = numberOrZero(walletInfo.totalInitialMargin ?? balance?.used?.USDT);
  const net = realized + funding + unrealizedPnl - openPositionFees;
  return {
    generatedAt: new Date().toISOString(), refreshSeconds, dashboardAuthEnabled: authEnabled,
    source: 'Binance USDⓈ-M Futures',
    mode: process.env.EXCHANGE_MODE || 'testnet', running: engine.circuitAllows(),
    tradingEnabled: engine.canPlaceNewOrders(), symbols, selectedSymbol: symbol,
    market: {
      price: marketPrice(engine, symbol, ticker.last), priceText: marketPriceText(engine, symbol, ticker.last),
      priceDigits: precisionDigits(marketPriceText(engine, symbol, ticker.last)), changePercent: numberOrZero(ticker.percentage),
      high: marketPrice(engine, symbol, ticker.high), highText: marketPriceText(engine, symbol, ticker.high),
      low: marketPrice(engine, symbol, ticker.low), lowText: marketPriceText(engine, symbol, ticker.low),
      volume: numberOrZero(ticker.quoteVolume || ticker.baseVolume), timeframe,
      candles: (candles || []).map(row => ({ time: Number(row[0]), open: marketPrice(engine, symbol, row[1]), high: marketPrice(engine, symbol, row[2]), low: marketPrice(engine, symbol, row[3]), close: marketPrice(engine, symbol, row[4]), volume: Number(row[5]) })),
    },
    range: { lower: numberOrZero(symState.config?.lower), lowerText: marketPriceText(engine, symbol, symState.config?.lower), upper: numberOrZero(symState.config?.upper), upperText: marketPriceText(engine, symbol, symState.config?.upper) },
    orders: {
      active: orders, buyCount: orders.filter(order => order.side === 'buy').length, sellCount: orders.filter(order => order.side === 'sell').length,
      buyValue: orders.filter(order => order.side === 'buy').reduce((sum, order) => sum + order.price * order.remaining, 0),
      sellValue: orders.filter(order => order.side === 'sell').reduce((sum, order) => sum + order.price * order.remaining, 0),
    },
    profit: {
      realized: numberOrZero(symState.realizedGridProfit) + numberOrZero(symState.realizedExitProfit),
      totalRealized: numberOrZero(engine.state.data.totals.realizedGridProfit) + numberOrZero(engine.state.data.totals.realizedExitProfit),
      filledBuys: numberOrZero(symState.filledBuys), filledSells: numberOrZero(symState.filledSells), quoteAsset: 'USDT',
      funding, fees: fee, openPositionFees, unrealizedPnl, net,
    },
    futures: {
      leverage, marginMode: process.env.MARGIN_MODE || '', positionMode: 'HEDGE',
      positionSide: 'LONG', freeUsdt, totalUsdt, walletBalance, availableBalance, usedMargin,
      positionMargin, openOrderMargin, position,
    },
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function startFuturesDashboardServer(engine) {
  if (!enabled || engine.futuresDashboardServer) return null;
  const auth = createDashboardAuth({
    enabled: authEnabled,
    username: authUsername,
    password: authPassword,
    sessionHours: authSessionHours,
    cookieName: 'grid_futures_session',
    dashboardName: 'Dashboard Futures',
  });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (await auth.handleRoute(request, response, url)) return;
      if (!auth.requireAuthentication(request, response, url)) return;
      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        sendJson(response, 200, await buildFuturesDashboardSnapshot(engine, url.searchParams.get('symbol')));
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        fs.createReadStream(dashboardFile).pipe(response);
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(response, 503, { error: 'Futures dashboard data unavailable', detail: err.message });
    }
  });
  server.on('error', err => console.error('[FUTURES DASHBOARD]', err.message));
  server.listen(port, host, () => {
    console.log(`[FUTURES DASHBOARD] http://${host}:${port} auth=${auth.enabled ? 'ON' : 'OFF'}`);
  });
  engine.futuresDashboardServer = server;
  return server;
}

module.exports = { buildFuturesDashboardSnapshot, positionMetrics, startFuturesDashboardServer };
