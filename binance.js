const crypto = require('crypto');
const https  = require('https');
const WebSocket = require('ws');
const logger = require('./logger');
const {
  BINANCE_SPOT_URL, BINANCE_FUTURES_URL,
  BINANCE_SPOT_TESTNET_URL, BINANCE_FUTURES_TESTNET_URL,
} = require('./config');

// ─── ERROR CODE MAP ───────────────────────────────────────────────────────────
const BINANCE_ERRORS = {
  '0':     'Binance unavailable from this region (geo-restriction).',
  '-1002': 'Unauthorized — check API key and secret.',
  '-1003': 'Rate limit exceeded. Wait before retrying.',
  '-1013': 'Invalid quantity or price — check lot size/tick size filters.',
  '-1021': 'Timestamp out of sync. Check your system clock.',
  '-1022': 'Invalid signature — key and secret do not match.',
  '-2010': 'Order rejected — insufficient balance or invalid parameters.',
  '-2013': 'Order does not exist.',
  '-2014': 'API key format invalid.',
  '-2015': 'Invalid API key, IP restriction, or insufficient permissions.',
  '-2019': 'Insufficient margin balance.',
  '-4003': 'Futures quantity below minimum.',
  '-4059': 'Margin type already set — no change needed.',
  '-4061': 'Order side does not match open position side.',
};

function humanizeError(code, msg) {
  const known = BINANCE_ERRORS[String(code)];
  if (known) return known;
  if (!msg) return `Binance error code ${code}`;
  const m = msg.toLowerCase();
  if (m.includes('ip') && m.includes('restrict')) return 'API key is IP-restricted. Disable IP restriction on Binance.';
  if (m.includes('signature')) return 'Invalid signature — key and secret do not match.';
  if (m.includes('api-key') || m.includes('apikey')) return 'API key does not exist or was deleted.';
  if (m.includes('timestamp')) return 'Timestamp mismatch — check system clock.';
  if (m.includes('permission')) return 'Permission denied — enable trading permission on this API key.';
  return msg;
}

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────
function httpsRequest(baseUrl, method, path, params, apiKey, signed, apiSecret) {
  return new Promise((resolve, reject) => {
    let qs = params ? new URLSearchParams(params).toString() : '';
    if (signed && apiSecret) {
      const ts = Date.now();
      qs += (qs ? '&' : '') + `timestamp=${ts}`;
      qs += `&signature=${crypto.createHmac('sha256', apiSecret).update(qs).digest('hex')}`;
    }
    const url = new URL(baseUrl + path + (qs ? '?' + qs : ''));
    const options = {
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-MBX-APIKEY': apiKey } : {}) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
              typeof parsed.code === 'number' && parsed.msg !== undefined) {
            const err = new Error(humanizeError(parsed.code, parsed.msg));
            err.binanceCode = parsed.code;
            err.binanceMsg  = parsed.msg;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch { reject(new Error('Failed to parse Binance response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        const e = new Error('Network error — cannot connect to Binance.');
        e.binanceCode = 'NETWORK'; reject(e);
      } else { reject(err); }
    });
    req.setTimeout(12000, () => { req.destroy(); reject(Object.assign(new Error('Request timeout.'), { binanceCode: 'TIMEOUT' })); });
    req.end();
  });
}

// ─── SPOT CLIENT ─────────────────────────────────────────────────────────────
class BinanceSpotClient {
  constructor(apiKey = '', apiSecret = '', testnet = false) {
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    this.base      = testnet ? BINANCE_SPOT_TESTNET_URL : BINANCE_SPOT_URL;
    this.wsBase    = testnet ? 'wss://testnet.binance.vision/ws' : 'wss://stream.binance.com:9443/ws';
    this.sockets   = {};
    this.marketType = 'spot';
  }

  req(method, path, params = {}, signed = false) {
    return httpsRequest(this.base, method, path, params, this.apiKey, signed, this.apiSecret);
  }

  ping()               { return this.req('GET', '/api/v3/ping'); }
  getExchangeInfo()    { return this.req('GET', '/api/v3/exchangeInfo'); }
  getKlines(s, i, l=200) { return this.req('GET', '/api/v3/klines', { symbol: s, interval: i, limit: l }); }
  getAllTickers()       { return this.req('GET', '/api/v3/ticker/24hr'); }
  getPrice(symbol)     { return this.req('GET', '/api/v3/ticker/price', { symbol }); }
  getAccountInfo()     { return this.req('GET', '/api/v3/account', {}, true); }
  getOpenOrders(symbol){ return this.req('GET', '/api/v3/openOrders', symbol ? { symbol } : {}, true); }
  cancelOrder(s, id)   { return this.req('DELETE', '/api/v3/order', { symbol: s, orderId: id }, true); }

  async getBalance() {
    const account = await this.getAccountInfo();
    const usdt = account.balances.find((b) => b.asset === 'USDT');
    return {
      free:           parseFloat(usdt?.free   || 0),
      locked:         parseFloat(usdt?.locked || 0),
      total:          parseFloat(usdt?.free   || 0) + parseFloat(usdt?.locked || 0),
      available:      parseFloat(usdt?.free   || 0),
      margin_balance: parseFloat(usdt?.free   || 0),
      unrealized_pnl: 0,
      canTrade:       account.canTrade,
    };
  }

  async getOpenPositions() {
    try {
      const orders = await this.getOpenOrders();
      return (orders || []).map((o) => ({
        symbol:    o.symbol,
        side:      o.side,
        type:      o.type,
        quantity:  parseFloat(o.origQty || 0),
        price:     parseFloat(o.price   || 0),
        order_id:  String(o.orderId),
        status:    o.status,
      }));
    } catch { return []; }
  }

  async placeMarketOrder(symbol, side, quantity) {
    return this.req('POST', '/api/v3/order', {
      symbol, side: side.toUpperCase(),
      type: 'MARKET', quantity: quantity.toFixed(6),
    }, true);
  }

  async getActivePairs(minVolume = 500000) {
    let info, tickers;
    try { [info, tickers] = await Promise.all([this.getExchangeInfo(), this.getAllTickers()]); }
    catch (err) { logger.error('Spot getActivePairs error', { err: err.message }); return []; }
    if (!info?.symbols || !Array.isArray(tickers)) return [];
    const active = new Set(
      info.symbols
        .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed && !/(UP|DOWN|BEAR|BULL)/.test(s.symbol))
        .map((s) => s.symbol)
    );
    return tickers
      .filter((t) => active.has(t.symbol) && parseFloat(t.quoteVolume) >= minVolume)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 100)
      .map((t) => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume) }));
  }

  async verifyCredentials() {
    try { await this.ping(); } catch (err) {
      return { valid: false, errorTitle: '❌ Network Error', errorReason: err.message, binanceCode: err.binanceCode || 'NETWORK', binanceMsg: err.binanceMsg || err.message };
    }
    try {
      const account = await this.getAccountInfo();
      const usdt    = account.balances.find((b) => b.asset === 'USDT');
      if (!account.canTrade) return { valid: false, errorTitle: '❌ Trading Disabled', errorReason: 'API key lacks Spot trading permission.', binanceCode: null, binanceMsg: 'canTrade=false' };
      return { valid: true, accountType: 'Spot', usdtBalance: parseFloat(usdt?.free || 0), availableBalance: parseFloat(usdt?.free || 0), canTrade: true, permissions: account.permissions || ['SPOT'] };
    } catch (err) {
      return { valid: false, errorTitle: '❌ Access Failed', errorReason: err.message, binanceCode: err.binanceCode, binanceMsg: err.binanceMsg };
    }
  }

  subscribeKlines(symbol, interval, callback) {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const ws = new WebSocket(`${this.wsBase}/${stream}`);
    ws.on('message', (d) => { try { const m = JSON.parse(d); if (m.k) callback(m.k); } catch {} });
    ws.on('error', () => {});
    ws.on('close', () => setTimeout(() => this.subscribeKlines(symbol, interval, callback), 5000));
    this.sockets[stream] = ws;
    return ws;
  }

  closeAll() { Object.values(this.sockets).forEach((ws) => { try { ws.close(); } catch {} }); this.sockets = {}; }
}

// ─── FUTURES CLIENT ───────────────────────────────────────────────────────────
class BinanceFuturesClient {
  constructor(apiKey = '', apiSecret = '', testnet = false) {
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    this.base      = testnet ? BINANCE_FUTURES_TESTNET_URL : BINANCE_FUTURES_URL;
    this.wsBase    = testnet ? 'wss://stream.binancefuture.com/ws' : 'wss://fstream.binance.com/ws';
    this.sockets   = {};
    this.marketType = 'futures';
  }

  req(method, path, params = {}, signed = false) {
    return httpsRequest(this.base, method, path, params, this.apiKey, signed, this.apiSecret);
  }

  ping()               { return this.req('GET', '/fapi/v1/ping'); }
  getKlines(s, i, l=200) { return this.req('GET', '/fapi/v1/klines', { symbol: s, interval: i, limit: l }); }
  getAllTickers()       { return this.req('GET', '/fapi/v1/ticker/24hr'); }
  getPrice(symbol)     { return this.req('GET', '/fapi/v1/ticker/price', { symbol }); }
  getExchangeInfo()    { return this.req('GET', '/fapi/v1/exchangeInfo'); }
  getAccountInfo()     { return this.req('GET', '/fapi/v2/account', {}, true); }
  getPositions()       { return this.req('GET', '/fapi/v2/positionRisk', {}, true); }
  getPositionBySymbol(symbol) { return this.req('GET', '/fapi/v2/positionRisk', { symbol }, true); }
  getOpenOrders(symbol){ return this.req('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {}, true); }
  cancelOrder(s, id)   { return this.req('DELETE', '/fapi/v1/order', { symbol: s, orderId: id }, true); }
  setLeverage(s, l)    { return this.req('POST', '/fapi/v1/leverage', { symbol: s, leverage: l }, true); }
  setMarginType(s, t)  { return this.req('POST', '/fapi/v1/marginType', { symbol: s, marginType: t }, true); }

  // Actual fill prices for a symbol — used for correct exit price
  async getUserTrades(symbol, startTime, limit = 50) {
    try {
      const params = { symbol, limit };
      if (startTime) params.startTime = startTime;
      const trades = await this.req('GET', '/fapi/v1/userTrades', params, true);
      return Array.isArray(trades) ? trades : [];
    } catch (err) {
      logger.debug(`getUserTrades error for ${symbol}`, { err: err.message });
      return [];
    }
  }

  // Realized PNL from income history — THE authoritative source for WIN/LOSS
  async getRealizedPnl(symbol, startTime) {
    try {
      const params = { incomeType: 'REALIZED_PNL', limit: 50 };
      if (symbol)    params.symbol    = symbol;
      if (startTime) params.startTime = startTime;
      const result = await this.req('GET', '/fapi/v1/income', params, true);
      if (!Array.isArray(result)) return null;
      return result.reduce((sum, r) => sum + parseFloat(r.income || 0), 0);
    } catch (err) {
      logger.debug('getRealizedPnl error', { err: err.message });
      return null;
    }
  }

  // Realized PNL with endTime for a specific trade window
  async getRealizedPnlRange(symbol, startTime, endTime) {
    try {
      const params = { incomeType: 'REALIZED_PNL', limit: 100 };
      if (symbol)    params.symbol    = symbol;
      if (startTime) params.startTime = startTime;
      if (endTime)   params.endTime   = endTime;
      const result = await this.req('GET', '/fapi/v1/income', params, true);
      if (!Array.isArray(result)) return { total: null, records: [] };
      const total = result.reduce((sum, r) => sum + parseFloat(r.income || 0), 0);
      return { total, records: result };
    } catch { return { total: null, records: [] }; }
  }

  // Get actual weighted average fill price from user trades (closing side)
  async getActualFillPrice(symbol, openTime, closeSide) {
    try {
      const startTime = openTime ? new Date(openTime).getTime() : undefined;
      const trades = await this.getUserTrades(symbol, startTime, 50);
      if (!trades.length) return null;
      // Find closing trades (opposite side)
      const closing = trades.filter((t) => t.side === closeSide && !t.maker);
      if (!closing.length) {
        const all = trades.filter((t) => t.side === closeSide);
        if (!all.length) return null;
        const totalQty = all.reduce((s, t) => s + parseFloat(t.qty), 0);
        if (!totalQty) return null;
        return all.reduce((s, t) => s + parseFloat(t.price) * parseFloat(t.qty), 0) / totalQty;
      }
      const totalQty = closing.reduce((s, t) => s + parseFloat(t.qty), 0);
      if (!totalQty) return null;
      return closing.reduce((s, t) => s + parseFloat(t.price) * parseFloat(t.qty), 0) / totalQty;
    } catch { return null; }
  }

  // All open positions (non-zero positionAmt)
  async getOpenPositions() {
    try {
      const positions = await this.getPositions();
      return (positions || []).filter((p) => parseFloat(p.positionAmt) !== 0).map((p) => {
        const posAmt = parseFloat(p.positionAmt);
        const side   = posAmt > 0 ? 'BUY' : 'SELL';
        const qty    = Math.abs(posAmt);
        const entry  = parseFloat(p.entryPrice);
        const mark   = parseFloat(p.markPrice);
        const unreal = parseFloat(p.unRealizedProfit);
        const lev    = parseInt(p.leverage || 1);
        const liq    = parseFloat(p.liquidationPrice || 0);
        const margin = lev > 0 ? (qty * entry) / lev : qty * entry;
        const diff   = side === 'BUY' ? mark - entry : entry - mark;
        const pnlPct = entry > 0 ? parseFloat(((diff / entry) * 100).toFixed(2)) : 0;
        return {
          symbol: p.symbol, side, quantity: qty, entry, current_price: mark, leverage: lev,
          profit: parseFloat(unreal.toFixed(4)), profit_pct: pnlPct,
          liquidation_price: liq, margin_used: parseFloat(margin.toFixed(4)),
          unrealized_pnl: parseFloat(unreal.toFixed(4)),
          open_time: p.updateTime || Date.now(),
        };
      });
    } catch (err) {
      logger.debug('getOpenPositions error', { err: err.message });
      return [];
    }
  }

  // Full open orders for all symbols — used for SL/TP detection
  async getAllOpenOrders() {
    try {
      const orders = await this.getOpenOrders();
      return Array.isArray(orders) ? orders : [];
    } catch { return []; }
  }

  async getBalance() {
    const account = await this.getAccountInfo();
    const usdt = (account.assets || []).find((a) => a.asset === 'USDT');
    const avail = parseFloat(usdt?.availableBalance || account.availableBalance || 0);
    const total = parseFloat(usdt?.walletBalance    || account.totalWalletBalance || 0);
    const mBal  = parseFloat(account.totalMarginBalance   || total);
    const uPnl  = parseFloat(account.totalUnrealizedProfit || 0);
    return { free: avail, locked: total - avail, total, available: avail, margin_balance: mBal, unrealized_pnl: uPnl, canTrade: account.canTrade !== false };
  }

  async placeMarketOrder(symbol, side, quantity, positionSide = 'BOTH') {
    return this.req('POST', '/fapi/v1/order', { symbol, side: side.toUpperCase(), type: 'MARKET', quantity: quantity.toFixed(3), positionSide }, true);
  }
  async placeLimitOrder(symbol, side, quantity, price, positionSide = 'BOTH') {
    return this.req('POST', '/fapi/v1/order', { symbol, side: side.toUpperCase(), type: 'LIMIT', quantity: quantity.toFixed(3), price: price.toFixed(8), timeInForce: 'GTC', positionSide }, true);
  }
  async placeStopOrder(symbol, side, quantity, stopPrice, positionSide = 'BOTH') {
    return this.req('POST', '/fapi/v1/order', { symbol, side: side.toUpperCase(), type: 'STOP_MARKET', quantity: quantity.toFixed(3), stopPrice: stopPrice.toFixed(8), positionSide }, true);
  }
  async placeTakeProfitOrder(symbol, side, quantity, stopPrice, positionSide = 'BOTH') {
    return this.req('POST', '/fapi/v1/order', { symbol, side: side.toUpperCase(), type: 'TAKE_PROFIT_MARKET', quantity: quantity.toFixed(3), stopPrice: stopPrice.toFixed(8), positionSide }, true);
  }

  async getActivePairs(minVolume = 1000000) {
    let info, tickers;
    try { [info, tickers] = await Promise.all([this.getExchangeInfo(), this.getAllTickers()]); }
    catch (err) { logger.error('Futures getActivePairs error', { err: err.message }); return []; }
    if (!info?.symbols || !Array.isArray(tickers)) return [];
    const active = new Set(
      (info.symbols || [])
        .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
        .map((s) => s.symbol)
    );
    return tickers
      .filter((t) => active.has(t.symbol) && parseFloat(t.quoteVolume) >= minVolume)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 100)
      .map((t) => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume) }));
  }

  async verifyCredentials() {
    try { await this.ping(); } catch (err) {
      return { valid: false, errorTitle: '❌ Network Error', errorReason: err.message, binanceCode: err.binanceCode || 'NETWORK', binanceMsg: err.binanceMsg };
    }
    try {
      const account = await this.getAccountInfo();
      const usdt    = (account.assets || []).find((a) => a.asset === 'USDT');
      const balance = parseFloat(usdt?.walletBalance     || account.totalWalletBalance || 0);
      const avail   = parseFloat(usdt?.availableBalance  || account.availableBalance   || 0);
      const uPnl    = parseFloat(account.totalUnrealizedProfit || 0);
      if (account.canTrade === false) return { valid: false, errorTitle: '❌ Trading Disabled', errorReason: 'API key lacks Futures trading permission.', binanceCode: null, binanceMsg: 'canTrade=false' };
      return { valid: true, accountType: 'Futures (USDT-M)', usdtBalance: balance, availableBalance: avail, unrealizedPnl: uPnl, canTrade: true, feeTier: account.feeTier, permissions: ['FUTURES'] };
    } catch (err) {
      return { valid: false, errorTitle: '❌ Access Failed', errorReason: err.message, binanceCode: err.binanceCode, binanceMsg: err.binanceMsg };
    }
  }

  subscribeKlines(symbol, interval, callback) {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const ws = new WebSocket(`${this.wsBase}/${stream}`);
    ws.on('message', (d) => { try { const m = JSON.parse(d); if (m.k) callback(m.k); } catch {} });
    ws.on('error', () => {});
    ws.on('close', () => setTimeout(() => this.subscribeKlines(symbol, interval, callback), 5000));
    this.sockets[stream] = ws;
    return ws;
  }

  closeAll() { Object.values(this.sockets).forEach((ws) => { try { ws.close(); } catch {} }); this.sockets = {}; }
}

// ─── FACTORY ─────────────────────────────────────────────────────────────────
function createClient(user) {
  if (!user || !user.api_key) return null;
  return user.market_type === 'futures'
    ? new BinanceFuturesClient(user.api_key, user.api_secret, user.testnet || false)
    : new BinanceSpotClient(user.api_key, user.api_secret, user.testnet || false);
}

const publicSpot    = new BinanceSpotClient();
const publicFutures = new BinanceFuturesClient();

module.exports = { BinanceSpotClient, BinanceFuturesClient, createClient, publicSpot, publicFutures };
