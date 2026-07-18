const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  DASHBOARD_ENABLED,
  DASHBOARD_HOST,
  DASHBOARD_PORT,
  DASHBOARD_REFRESH_SECONDS,
  DASHBOARD_CHART_TIMEFRAME,
  DASHBOARD_CHART_LIMIT,
  EXCHANGE_MODE,
  SYMBOLS,
} = require('./config');
const { retry, numberOrZero } = require('./utils');

const dashboardFile = path.join(__dirname, '..', 'public', 'dashboard.html');

function marketPrice(engine, symbol, value) {
  const numericValue = numberOrZero(value);
  if (!numericValue) return 0;
  try {
    return Number(engine.exchange.priceToPrecision(symbol, numericValue));
  } catch {
    return numericValue;
  }
}

function marketPriceText(engine, symbol, value) {
  const numericValue = numberOrZero(value);
  if (!numericValue) return '0';
  try {
    return engine.exchange.priceToPrecision(symbol, numericValue);
  } catch {
    return String(numericValue);
  }
}

function marketAmountText(engine, symbol, value) {
  const numericValue = numberOrZero(value);
  if (!numericValue) return '0';
  try {
    return engine.exchange.amountToPrecision(symbol, numericValue);
  } catch {
    return String(numericValue);
  }
}

function precisionDigits(formattedValue) {
  const fraction = String(formattedValue).split('.')[1];
  return fraction ? fraction.length : 0;
}

function normalizeOrder(engine, symbol, order, stateOrder) {
  return {
    id: String(order.id),
    symbol,
    side: String(order.side || stateOrder?.side || '').toLowerCase(),
    price: numberOrZero(order.price || stateOrder?.price),
    priceText: marketPriceText(engine, symbol, order.price || stateOrder?.price),
    amount: numberOrZero(order.amount || stateOrder?.amount),
    amountText: marketAmountText(engine, symbol, order.amount || stateOrder?.amount),
    filled: numberOrZero(order.filled),
    remaining: numberOrZero(order.remaining ?? order.amount),
    remainingText: marketAmountText(engine, symbol, order.remaining ?? order.amount),
    level: engine.getBotOrderLevel(order) ?? stateOrder?.levelIndex ?? null,
    timestamp: Number(order.timestamp) || Date.parse(stateOrder?.createdAt || 0) || null,
  };
}

async function buildDashboardSnapshot(engine, requestedSymbol) {
  const symbol = SYMBOLS.includes(requestedSymbol) ? requestedSymbol : SYMBOLS[0];
  const symState = engine.state.getSymbol(symbol);
  const [ticker, exchangeOrders, candles] = await Promise.all([
    retry(() => engine.exchange.fetchTicker(symbol)),
    retry(() => engine.exchange.fetchOpenOrders(symbol)),
    retry(() => engine.exchange.fetchOHLCV(symbol, DASHBOARD_CHART_TIMEFRAME, undefined, DASHBOARD_CHART_LIMIT)),
  ]);
  const managedIds = new Set(Object.keys(symState.orders));
  const orders = exchangeOrders
    .filter(order => managedIds.has(String(order.id)) || engine.getBotOrderLevel(order) !== null)
    .map(order => normalizeOrder(engine, symbol, order, symState.orders[String(order.id)]));
  const buyOrders = orders.filter(order => order.side === 'buy');
  const sellOrders = orders.filter(order => order.side === 'sell');
  const realizedProfit = numberOrZero(symState.realizedGridProfit);

  return {
    generatedAt: new Date().toISOString(),
    refreshSeconds: DASHBOARD_REFRESH_SECONDS,
    source: 'Binance Spot',
    mode: EXCHANGE_MODE,
    running: engine.circuitAllows(),
    tradingEnabled: engine.canPlaceNewOrders(),
    symbols: SYMBOLS,
    selectedSymbol: symbol,
    market: {
      price: marketPrice(engine, symbol, ticker.last),
      priceText: marketPriceText(engine, symbol, ticker.last),
      priceDigits: precisionDigits(marketPriceText(engine, symbol, ticker.last)),
      changePercent: numberOrZero(ticker.percentage),
      high: marketPrice(engine, symbol, ticker.high),
      highText: marketPriceText(engine, symbol, ticker.high),
      low: marketPrice(engine, symbol, ticker.low),
      lowText: marketPriceText(engine, symbol, ticker.low),
      volume: numberOrZero(ticker.quoteVolume || ticker.baseVolume),
      timeframe: DASHBOARD_CHART_TIMEFRAME,
      candles: (candles || []).map(row => ({
        time: Number(row[0]),
        open: marketPrice(engine, symbol, row[1]),
        high: marketPrice(engine, symbol, row[2]),
        low: marketPrice(engine, symbol, row[3]),
        close: marketPrice(engine, symbol, row[4]),
        volume: Number(row[5]),
      })),
    },
    range: {
      lower: numberOrZero(symState.config?.lower),
      lowerText: marketPriceText(engine, symbol, symState.config?.lower),
      upper: numberOrZero(symState.config?.upper),
      upperText: marketPriceText(engine, symbol, symState.config?.upper),
    },
    orders: {
      active: orders,
      buyCount: buyOrders.length,
      sellCount: sellOrders.length,
      buyValue: buyOrders.reduce((sum, order) => sum + order.price * order.remaining, 0),
      sellValue: sellOrders.reduce((sum, order) => sum + order.price * order.remaining, 0),
    },
    profit: {
      realized: realizedProfit,
      totalRealized: numberOrZero(engine.state.data.totals.realizedGridProfit),
      filledBuys: numberOrZero(engine.state.data.totals.filledBuys),
      filledSells: numberOrZero(engine.state.data.totals.filledSells),
      quoteAsset: engine.getQuoteAsset(symbol),
    },
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function startDashboardServer(engine) {
  if (!DASHBOARD_ENABLED || engine.dashboardServer) return null;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        sendJson(response, 200, await buildDashboardSnapshot(engine, url.searchParams.get('symbol')));
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        fs.createReadStream(dashboardFile).pipe(response);
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(response, 503, { error: 'Dashboard data unavailable', detail: err.message });
    }
  });
  const maxPortAttempts = 20;
  const listen = (port, attempt = 0) => {
    const onError = err => {
      if (err.code === 'EADDRINUSE' && attempt < maxPortAttempts) {
        const nextPort = port + 1;
        console.warn(`[DASHBOARD] Port ${port} sudah dipakai, mencoba port ${nextPort}...`);
        listen(nextPort, attempt + 1);
        return;
      }
      console.error('[DASHBOARD]', err.message);
    };
    server.once('error', onError);
    server.listen(port, DASHBOARD_HOST, () => {
      server.removeListener('error', onError);
      server.on('error', err => console.error('[DASHBOARD]', err.message));
      engine.dashboardPort = port;
      console.log(`[DASHBOARD] http://${DASHBOARD_HOST}:${port}`);
    });
  };
  listen(DASHBOARD_PORT);
  engine.dashboardServer = server;
  return server;
}

module.exports = {
  buildDashboardSnapshot,
  marketAmountText,
  marketPrice,
  marketPriceText,
  normalizeOrder,
  precisionDigits,
  startDashboardServer,
};
