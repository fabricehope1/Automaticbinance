const { createClient }              = require('./binance');
const { calculatePositionSize, getRiskPct } = require('./strategy');
const db                            = require('./database');
const logger                        = require('./logger');
const {
  MAX_ACTIVE_TRADES, SCORE_MIN_TRADE,
} = require('./config');

// ─── CONCURRENT TRADE LOCK ────────────────────────────────────────────────────
const _tradeLocks = new Map();

async function withTradeLock(key, fn) {
  while (_tradeLocks.has(key)) {
    await _tradeLocks.get(key);
  }
  let resolve;
  const lock = new Promise((r) => (resolve = r));
  _tradeLocks.set(key, lock);
  try {
    return await fn();
  } finally {
    _tradeLocks.delete(key);
    resolve();
  }
}

// ─── LOT SIZE FILTER ─────────────────────────────────────────────────────────
// Respects exchange stepSize, minQty, and minNotional for both Spot and Futures.
async function applyLotSizeFilter(client, symbol, rawQty, entry) {
  try {
    const info    = await client.getExchangeInfo();
    const symInfo = (info.symbols || []).find((s) => s.symbol === symbol);
    if (!symInfo) return rawQty;

    let stepSize    = null;
    let minQty      = null;
    let minNotional = null;
    let precision   = null;

    // Futures may expose quantityPrecision at the symbol level
    if (symInfo.quantityPrecision !== undefined) {
      precision = symInfo.quantityPrecision;
    }

    for (const f of (symInfo.filters || [])) {
      if (f.filterType === 'LOT_SIZE') {
        stepSize = parseFloat(f.stepSize);
        minQty   = parseFloat(f.minQty);
      }
      if (f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') {
        minNotional = parseFloat(f.minNotional || f.minNotionalValue || 0);
      }
    }

    let qty = rawQty;

    if (stepSize && stepSize > 0) {
      qty = Math.floor(qty / stepSize) * stepSize;
      const dec = precision !== null
        ? precision
        : (stepSize.toString().includes('.') ? stepSize.toString().split('.')[1].length : 0);
      qty = parseFloat(qty.toFixed(dec));
    } else if (precision !== null) {
      qty = parseFloat(qty.toFixed(precision));
    }

    if (minQty && qty < minQty) {
      logger.debug(`[LOT-FILTER] ${symbol} qty ${qty} < minQty ${minQty}, rejecting`);
      return 0;
    }
    if (minNotional && qty * entry < minNotional) {
      logger.debug(`[LOT-FILTER] ${symbol} notional ${(qty * entry).toFixed(4)} < minNotional ${minNotional}, rejecting`);
      return 0;
    }

    return qty;
  } catch (err) {
    logger.debug(`[LOT-FILTER-ERR] ${symbol}`, { err: err.message });
    return rawQty;
  }
}

// ─── OPEN TRADE ───────────────────────────────────────────────────────────────
async function openTrade(user, signal) {
  const lockKey = `${user.telegram_id}:${signal.symbol}:${signal.signal}:${signal.market_type || user.market_type}`;

  return withTradeLock(lockKey, async () => {
    try {
      const settings  = db.settings.get();
      const maxTrades = settings.max_trades || MAX_ACTIVE_TRADES;

       if (!db.subscriptions.isActive(user)) return { success: false, reason: 'SUBSCRIPTION_INACTIVE' };
      if (user.banned)                    return { success: false, reason: 'USER_BANNED' };
      if (!user.api_key)                  return { success: false, reason: 'NO_API_KEY' };

      // ── DUPLICATE CHECK 1: local DB (includes market_type) ──────────────
      const dbDup = db.trades.findOpenBySymbolSide(
        user.telegram_id, signal.symbol, signal.signal, user.market_type
      );
      if (dbDup) {
        logger.info(`[TRADE-SKIP] Duplicate in DB: ${signal.symbol} ${signal.signal} ${user.market_type} user:${user.telegram_id}`);
        return { success: false, reason: 'DUPLICATE_IN_DB' };
      }

      if (db.trades.openForUser(user.telegram_id).length >= maxTrades)
        return { success: false, reason: 'MAX_TRADES_REACHED' };

      if (!signal.canTrade) return { success: false, reason: 'SIGNAL_BELOW_THRESHOLD' };

      const client = createClient(user);
      if (!client) return { success: false, reason: 'NO_CLIENT' };

      // ── DUPLICATE CHECK 2: live Binance (futures only) ───────────────────
      if (user.market_type === 'futures') {
        try {
          const livePositions = await client.getOpenPositions();
          const liveDup = livePositions.find((p) => p.symbol === signal.symbol && p.side === signal.signal);
          if (liveDup) {
            logger.info(`[TRADE-SKIP] Already open on Binance: ${signal.symbol} ${signal.signal} user:${user.telegram_id}`);
            await db.trades.upsertImported({ ...liveDup, user_id: user.telegram_id, market_type: 'futures', imported: true });
            return { success: false, reason: 'DUPLICATE_ON_BINANCE' };
          }
        } catch {}
      }

      const balData = await client.getBalance();
      // Use available balance (free) for position sizing — this is what we can actually deploy
      const availableBalance = balData.available ?? balData.free;
      if (availableBalance < 10) return { success: false, reason: 'INSUFFICIENT_BALANCE' };

      const riskPct  = getRiskPct(signal.score);
      const rawQty   = calculatePositionSize(availableBalance, riskPct, signal.entry, signal.sl);
      if (rawQty <= 0) return { success: false, reason: 'INVALID_QUANTITY' };

      const quantity = await applyLotSizeFilter(client, signal.symbol, rawQty, signal.entry);
      if (quantity <= 0) return { success: false, reason: 'BELOW_MIN_NOTIONAL' };

      let order, sl_order_id = '', tp_order_id = '';

      if (user.market_type === 'spot') {
        try {
          order = await client.placeMarketOrder(signal.symbol, signal.signal, quantity);
        } catch (err) {
          logger.error(`[TRADE-FAIL] Spot order: ${user.telegram_id} ${signal.symbol}`, { err: err.message });
          return { success: false, reason: 'ORDER_FAILED', error: err.message };
        }
      } else if (user.market_type === 'futures') {
        try {
          try { await client.setLeverage(signal.symbol, 5); } catch {}
          try { await client.setMarginType(signal.symbol, 'CROSSED'); } catch {}
          order = await client.placeMarketOrder(signal.symbol, signal.signal, quantity, 'BOTH');
          const closeSide = signal.signal === 'BUY' ? 'SELL' : 'BUY';
          try { const slO = await client.placeStopOrder(signal.symbol, closeSide, quantity, signal.sl, 'BOTH'); sl_order_id = String(slO.orderId || ''); } catch (e) { logger.warn('[SL-FAIL]', { err: e.message }); }
          try { const tpO = await client.placeTakeProfitOrder(signal.symbol, closeSide, quantity, signal.tp, 'BOTH'); tp_order_id = String(tpO.orderId || ''); } catch (e) { logger.warn('[TP-FAIL]', { err: e.message }); }
        } catch (err) {
          logger.error(`[TRADE-FAIL] Futures order: ${user.telegram_id} ${signal.symbol}`, { err: err.message });
          return { success: false, reason: 'ORDER_FAILED', error: err.message };
        }
      } else {
        return { success: false, reason: 'UNKNOWN_MARKET_TYPE' };
      }

      const filledPrice = order?.fills?.length
        ? order.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
          order.fills.reduce((s, f) => s + parseFloat(f.qty), 0)
        : signal.entry;

      const leverage    = 5;
      const margin_used = user.market_type === 'futures'
        ? parseFloat(((quantity * filledPrice) / leverage).toFixed(4))
        : 0;

      const fresh = db.users.findById(user.telegram_id);
      const trade = await db.trades.create({
        user_id: user.telegram_id, market_type: user.market_type,
        symbol: signal.symbol, side: signal.signal,
        entry: filledPrice, sl: signal.sl, tp: signal.tp,
        quantity, leverage, margin_used, risk_pct: riskPct,
        score: signal.score, signal_id: signal.signal_id || '',
        order_id: String(order?.orderId || ''), sl_order_id, tp_order_id, imported: false,
      });

      const mType = user.market_type;
      await db.users.update(user.telegram_id, {
        active_trades:  (fresh.active_trades  || 0) + 1,
         total_trades:   fresh.total_trades || 0,
        spot_trades:    mType === 'spot'    ? (fresh.spot_trades    || 0) + 1 : (fresh.spot_trades    || 0),
        futures_trades: mType === 'futures' ? (fresh.futures_trades || 0) + 1 : (fresh.futures_trades || 0),
      });

      logger.info(`[TRADE-OPEN] ${trade.trade_id} ${signal.symbol} ${signal.signal} score:${signal.score} risk:${riskPct}% user:${user.telegram_id}`);
      return { success: true, trade, riskPct };
    } catch (err) {
      logger.error('[openTrade] error', { err: err.message });
      return { success: false, reason: 'ERROR', error: err.message };
    }
  });
}

// ─── CLOSE TRADE ─────────────────────────────────────────────────────────────
async function closeTrade(user, trade, reason = 'MANUAL', overridePrice = null) {
  try {
    const client = createClient(user);
    let closePrice  = overridePrice || trade.current_price || trade.entry;
    let realizedPnl = null;
    const openTimestamp = trade.open_time ? new Date(trade.open_time).getTime() : undefined;

    if (client) {
      const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
      try {
        if (user.market_type === 'futures') {
          if (trade.sl_order_id) try { await client.cancelOrder(trade.symbol, trade.sl_order_id); } catch {}
          if (trade.tp_order_id) try { await client.cancelOrder(trade.symbol, trade.tp_order_id); } catch {}
          const closeOrder = await client.placeMarketOrder(trade.symbol, closeSide, trade.quantity, 'BOTH');

          await new Promise((r) => setTimeout(r, 1500));

          const fillPrice = await client.getActualFillPrice(trade.symbol, trade.open_time, closeSide);
          if (fillPrice && fillPrice > 0) closePrice = fillPrice;
          else if (closeOrder?.fills?.length) {
            closePrice = closeOrder.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
                         closeOrder.fills.reduce((s, f) => s + parseFloat(f.qty), 0);
          }

          try {
            const pnlResult = await client.getRealizedPnlRange(trade.symbol, openTimestamp, Date.now());
            if (pnlResult.total !== null) realizedPnl = pnlResult.total;
          } catch {}
        } else {
          const closeOrder = await client.placeMarketOrder(trade.symbol, closeSide, trade.quantity);
          if (closeOrder?.fills?.length) {
            closePrice = closeOrder.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
                         closeOrder.fills.reduce((s, f) => s + parseFloat(f.qty), 0);
          }
        }
      } catch (err) {
        logger.warn('[CLOSE-WARN] Exchange close failed — recording locally', { err: err.message });
        if (!overridePrice) {
          try { const ticker = await client.getPrice(trade.symbol); closePrice = parseFloat(ticker.price); } catch {}
        }
      }
    }

    let profit, profitPct, isWin;

    if (realizedPnl !== null) {
      profit    = parseFloat(realizedPnl.toFixed(4));
      const pd  = trade.side === 'BUY' ? closePrice - trade.entry : trade.entry - closePrice;
      profitPct = trade.entry > 0 ? parseFloat(((pd / trade.entry) * 100).toFixed(2)) : 0;
      isWin     = profit > 0;
    } else {
      const pd  = trade.side === 'BUY' ? closePrice - trade.entry : trade.entry - closePrice;
      profit    = parseFloat((pd * trade.quantity).toFixed(4));
      profitPct = trade.entry > 0 ? parseFloat(((pd / trade.entry) * 100).toFixed(2)) : 0;
      isWin     = profit > 0;
    }

    const isBreakeven  = Math.abs(profit) < 0.001;
    const result_label = isBreakeven ? 'BREAKEVEN' : isWin ? 'WIN' : 'LOSS';

    await db.trades.update(trade.trade_id, {
      status: 'closed', profit, profit_pct: profitPct,
      close_time: new Date().toISOString(), close_reason: reason,
      close_price: closePrice, result: result_label,
    });

    await _updateUserStatsOnClose(user, profit, profitPct, result_label);

    logger.info(`[TRADE-CLOSE] ${trade.trade_id} ${trade.symbol} ${reason} result:${result_label} pnl:${profit} exitPx:${closePrice?.toFixed(4)}`);
    return { success: true, profit, profitPct, closePrice, isWin, result_label };
  } catch (err) {
    logger.error('[closeTrade] error', { err: err.message });
    return { success: false, error: err.message };
  }
}

// ─── PARTIAL CLOSE ────────────────────────────────────────────────────────────
async function partialCloseTrade(user, trade, closePercent = 50) {
  try {
    const client = createClient(user);
    if (!client) return { success: false, reason: 'NO_CLIENT' };
    const closeQty = parseFloat((trade.quantity * (closePercent / 100)).toFixed(3));
    if (closeQty <= 0) return { success: false, reason: 'INVALID_QUANTITY' };
    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    let closePrice  = trade.current_price || trade.entry;
    try {
      const o = user.market_type === 'futures'
        ? await client.placeMarketOrder(trade.symbol, closeSide, closeQty, 'BOTH')
        : await client.placeMarketOrder(trade.symbol, closeSide, closeQty);
      if (o?.fills?.length) closePrice = o.fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) / o.fills.reduce((s, f) => s + parseFloat(f.qty), 0);
    } catch (err) { return { success: false, error: err.message }; }
    const pd = trade.side === 'BUY' ? closePrice - trade.entry : trade.entry - closePrice;
    const partProfit = parseFloat((pd * closeQty).toFixed(4));
    const newQty = parseFloat((trade.quantity - closeQty).toFixed(6));
    await db.trades.update(trade.trade_id, { quantity: newQty });
    logger.info(`[PARTIAL-CLOSE] ${trade.trade_id} ${closePercent}% qty:${closeQty} remain:${newQty} pnl:${partProfit}`);
    return { success: true, closedQty: closeQty, remainingQty: newQty, profit: partProfit, closePrice };
  } catch (err) {
    logger.error('[partialCloseTrade] error', { err: err.message });
    return { success: false, error: err.message };
  }
}

// ─── MOVE SL ─────────────────────────────────────────────────────────────────
async function moveStopLoss(user, trade, newSL) {
  try {
    const client = createClient(user);
    if (!client) return { success: false, reason: 'NO_CLIENT' };
    if (user.market_type === 'futures') {
      if (trade.sl_order_id) try { await client.cancelOrder(trade.symbol, trade.sl_order_id); } catch {}
      const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
      try {
        const slO = await client.placeStopOrder(trade.symbol, closeSide, trade.quantity, newSL, 'BOTH');
        await db.trades.update(trade.trade_id, { sl: newSL, sl_order_id: String(slO.orderId) });
      } catch { await db.trades.update(trade.trade_id, { sl: newSL }); }
    } else {
      await db.trades.update(trade.trade_id, { sl: newSL });
    }
    logger.info(`[MOVE-SL] ${trade.trade_id} ${trade.symbol} newSL:${newSL}`);
    return { success: true, newSL };
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── MOVE TP ─────────────────────────────────────────────────────────────────
async function moveTakeProfit(user, trade, newTP) {
  try {
    const client = createClient(user);
    if (!client) return { success: false, reason: 'NO_CLIENT' };
    if (user.market_type === 'futures') {
      if (trade.tp_order_id) try { await client.cancelOrder(trade.symbol, trade.tp_order_id); } catch {}
      const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
      try {
        const tpO = await client.placeTakeProfitOrder(trade.symbol, closeSide, trade.quantity, newTP, 'BOTH');
        await db.trades.update(trade.trade_id, { tp: newTP, tp_order_id: String(tpO.orderId) });
      } catch { await db.trades.update(trade.trade_id, { tp: newTP }); }
    } else {
      await db.trades.update(trade.trade_id, { tp: newTP });
    }
    logger.info(`[MOVE-TP] ${trade.trade_id} ${trade.symbol} newTP:${newTP}`);
    return { success: true, newTP };
  } catch (err) { return { success: false, error: err.message }; }
}

async function setBreakEven(user, trade) { return moveStopLoss(user, trade, trade.entry); }

// ─── TRAILING STOP ────────────────────────────────────────────────────────────
async function setTrailingStop(user, trade, trailPercent = 1.0) {
  try {
    if (user.market_type !== 'futures') return { success: false, reason: 'FUTURES_ONLY' };
    const client = createClient(user);
    if (!client) return { success: false, reason: 'NO_CLIENT' };
    if (trade.sl_order_id) try { await client.cancelOrder(trade.symbol, trade.sl_order_id); } catch {}
    const closeSide    = trade.side === 'BUY' ? 'SELL' : 'BUY';
    const callbackRate = parseFloat(Math.min(Math.max(trailPercent, 0.1), 5).toFixed(1));
    const o = await client.req('POST', '/fapi/v1/order', { symbol: trade.symbol, side: closeSide, type: 'TRAILING_STOP_MARKET', quantity: trade.quantity.toFixed(3), callbackRate, positionSide: 'BOTH' }, true);
    await db.trades.update(trade.trade_id, { sl_order_id: String(o.orderId), trailing_stop: callbackRate });
    logger.info(`[TRAIL-STOP] ${trade.trade_id} ${callbackRate}%`);
    return { success: true, callbackRate };
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── IMPORT BINANCE POSITIONS (upsert — never duplicates) ────────────────────
async function importBinancePositions(user) {
  try {
    const client    = createClient(user);
    if (!client) return { imported: 0, updated: 0, errors: [] };
    const positions = await client.getOpenPositions();
    if (!positions?.length) return { imported: 0, updated: 0, total: 0, errors: [] };

    let imported = 0, updated = 0;
    const errors = [];
    for (const pos of positions) {
      try {
        const r = await db.trades.upsertImported({
          user_id: user.telegram_id, market_type: user.market_type || 'futures',
          symbol: pos.symbol, side: pos.side, entry: pos.entry,
          current_price: pos.current_price, quantity: pos.quantity,
          leverage: pos.leverage, profit: pos.profit, profit_pct: pos.profit_pct,
          liquidation_price: pos.liquidation_price, margin_used: pos.margin_used,
          open_time: pos.open_time ? new Date(pos.open_time).toISOString() : new Date().toISOString(),
          imported: true,
        });
        if (r.created) {
          imported++;
          logger.info(`[IMPORT-POSITION] New: ${pos.symbol} ${pos.side} user:${user.telegram_id}`);
        } else {
          updated++;
        }
      } catch (err) { errors.push({ symbol: pos.symbol, error: err.message }); }
    }

    const openCount = db.trades.openForUser(user.telegram_id).length;
    await db.users.update(user.telegram_id, { active_trades: openCount, last_binance_sync: new Date().toISOString() });
    if (imported > 0) logger.info(`[IMPORT-DONE] user:${user.telegram_id} imported:${imported} updated:${updated}`);
    return { imported, updated, total: positions.length, errors };
  } catch (err) {
    logger.error('[importBinancePositions] error', { err: err.message });
    return { imported: 0, updated: 0, errors: [{ error: err.message }] };
  }
}

// ─── DETECT MANUAL CHANGES ────────────────────────────────────────────────────
async function detectAndSyncManualChanges(user, client, dbOpenTrades, livePositions, openOrders) {
  const changes = { newManual: 0, manualClose: 0, slTpUpdated: 0, partialClose: 0 };

  const liveMap = new Map(livePositions.map((p) => [`${p.symbol}:${p.side}`, p]));
  const dbMap   = new Map(dbOpenTrades.map((t) => [`${t.symbol}:${t.side}`, t]));

  for (const [key, pos] of liveMap) {
    if (!dbMap.has(key)) {
      const r = await db.trades.upsertImported({
        user_id: user.telegram_id, market_type: user.market_type || 'futures',
        symbol: pos.symbol, side: pos.side, entry: pos.entry,
        current_price: pos.current_price, quantity: pos.quantity,
        leverage: pos.leverage, profit: pos.profit, profit_pct: pos.profit_pct,
        liquidation_price: pos.liquidation_price, margin_used: pos.margin_used,
        open_time: pos.open_time ? new Date(pos.open_time).toISOString() : new Date().toISOString(),
        imported: true,
      });
      if (r.created) {
        changes.newManual++;
        logger.info(`[MANUAL-OPEN] Detected new manual position: ${pos.symbol} ${pos.side} user:${user.telegram_id}`);
      }
    }
  }

  for (const [key, trade] of dbMap) {
    if (!liveMap.has(key)) {
      let realizedPnl = null;
      let closePrice  = trade.current_price || trade.entry;
      const openTs    = trade.open_time ? new Date(trade.open_time).getTime() : undefined;
      try {
        const pnlResult = await client.getRealizedPnlRange(trade.symbol, openTs, Date.now());
        if (pnlResult.total !== null) realizedPnl = pnlResult.total;
        const closeSide   = trade.side === 'BUY' ? 'SELL' : 'BUY';
        const fillPrice   = await client.getActualFillPrice(trade.symbol, trade.open_time, closeSide);
        if (fillPrice && fillPrice > 0) closePrice = fillPrice;
      } catch {}

      const profit      = realizedPnl !== null ? parseFloat(realizedPnl.toFixed(4)) : 0;
      const pd          = trade.side === 'BUY' ? closePrice - trade.entry : trade.entry - closePrice;
      const profitPct   = trade.entry > 0 ? parseFloat(((pd / trade.entry) * 100).toFixed(2)) : 0;
      const isBreakeven = Math.abs(profit) < 0.001;
      const result_label = isBreakeven ? 'BREAKEVEN' : profit > 0 ? 'WIN' : 'LOSS';
      const reason = realizedPnl !== null
        ? (result_label === 'WIN' ? 'TP_OR_MANUAL' : result_label === 'LOSS' ? 'SL_OR_MANUAL' : 'BREAKEVEN')
        : 'MANUAL_DETECTED';

      await db.trades.update(trade.trade_id, {
        status: 'closed', profit, profit_pct: profitPct,
        close_time: new Date().toISOString(), close_reason: reason,
        close_price: closePrice, result: result_label,
      });
      await _updateUserStatsOnClose(user, profit, profitPct, result_label);
      changes.manualClose++;
      logger.info(`[MANUAL-CLOSE] ${trade.trade_id} ${trade.symbol} result:${result_label} pnl:${profit} exitPx:${closePrice?.toFixed?.(4)}`);
      return { ...changes, closedTrade: trade, closedResult: { profit, profitPct, closePrice, isWin: profit > 0, result_label } };
    }
  }

  const ordersBySymbol = new Map();
  for (const o of (openOrders || [])) {
    if (!ordersBySymbol.has(o.symbol)) ordersBySymbol.set(o.symbol, []);
    ordersBySymbol.get(o.symbol).push(o);
  }

  for (const [key, trade] of dbMap) {
    const live = liveMap.get(key);
    if (!live) continue;

    const patch = {};

    if (live.leverage && live.leverage !== trade.leverage) {
      patch.leverage = live.leverage;
    }

    if (live.quantity && Math.abs(live.quantity - trade.quantity) > 0.0001 && live.quantity < trade.quantity) {
      patch.quantity = live.quantity;
      changes.partialClose++;
      logger.info(`[PARTIAL-MANUAL] ${trade.trade_id} qty: ${trade.quantity} → ${live.quantity}`);
    }

    const symOrders = ordersBySymbol.get(trade.symbol) || [];
    for (const o of symOrders) {
      const sp = parseFloat(o.stopPrice || 0);
      if (!sp) continue;
      if ((o.type === 'STOP_MARKET' || o.type === 'STOP') && Math.abs(sp - (trade.sl || 0)) > 0.000001) {
        patch.sl        = sp;
        patch.sl_order_id = String(o.orderId);
        changes.slTpUpdated++;
        logger.info(`[SL-SYNC] ${trade.trade_id} ${trade.symbol} SL: ${trade.sl} → ${sp}`);
      }
      if ((o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT') && Math.abs(sp - (trade.tp || 0)) > 0.000001) {
        patch.tp        = sp;
        patch.tp_order_id = String(o.orderId);
        changes.slTpUpdated++;
        logger.info(`[TP-SYNC] ${trade.trade_id} ${trade.symbol} TP: ${trade.tp} → ${sp}`);
      }
    }

    patch.current_price     = live.current_price;
    patch.profit            = live.profit;
    patch.profit_pct        = live.profit_pct;
    patch.liquidation_price = live.liquidation_price;
    patch.margin_used       = live.margin_used;

    if (Object.keys(patch).length > 0) {
      await db.trades.update(trade.trade_id, patch);
    }
  }

  return changes;
}

// ─── FULL BINANCE SYNC ────────────────────────────────────────────────────────
// For Spot: calculates unrealized PNL from open trades against live prices.
// For Futures: uses the exchange-reported unrealized PNL.
async function syncUserFromBinance(user) {
  try {
    const client = createClient(user);
    if (!client) return null;

    const bal = await client.getBalance();

    // Calculate spot unrealized PNL from live prices across open trades
    let unrealizedPnl = bal.unrealized_pnl ?? 0;
    if (user.market_type === 'spot') {
      const openTrades = db.trades.openForUser(user.telegram_id);
      if (openTrades.length > 0) {
        let spotUPnl = 0;
        const priceResults = await Promise.allSettled(
          openTrades.map((t) => client.getPrice(t.symbol))
        );
        for (let i = 0; i < openTrades.length; i++) {
          const trade  = openTrades[i];
          const result = priceResults[i];
          if (result.status !== 'fulfilled' || !result.value) continue;
          const price = parseFloat(result.value.price);
          const pd    = trade.side === 'BUY' ? price - trade.entry : trade.entry - price;
          spotUPnl   += pd * trade.quantity;
        }
        unrealizedPnl = parseFloat(spotUPnl.toFixed(4));
      }
    }

    await db.users.update(user.telegram_id, {
      balance:           bal.total,           // total wallet (free + locked)
      available_balance: bal.available ?? bal.free,
      margin_balance:    bal.margin_balance ?? bal.total,
      unrealized_pnl:    unrealizedPnl,
      last_binance_sync: new Date().toISOString(),
    });

    const syncResult = await importBinancePositions(user);
    logger.info(`[SYNC-SUCCESS] user:${user.telegram_id} positions:${syncResult.total || 0} imported:${syncResult.imported || 0}`);
    return { balance: bal, positions: syncResult.total || 0, imported: syncResult.imported || 0, updated: syncResult.updated || 0 };
  } catch (err) {
    logger.warn(`[SYNC-FAILED] user:${user.telegram_id}`, { err: err.message });
    return null;
  }
}

// ─── ACCOUNT SWITCH — clear all cached data for previous account ──────────────
async function clearUserAccountData(userId) {
  logger.info(`[ACCOUNT-SWITCH] Clearing cached data for user:${userId}`);
  await db.users.update(userId, {
    balance:           0,
    available_balance: 0,
    margin_balance:    0,
    unrealized_pnl:    0,
    active_trades:     0,
    last_binance_sync: null,
  });

  const openTrades = db.trades.openForUser(userId);
  for (const trade of openTrades) {
    await db.trades.update(trade.trade_id, {
      status:       'closed',
      close_time:   new Date().toISOString(),
      close_reason: 'ACCOUNT_SWITCH',
      result:       'BREAKEVEN',
      profit:       0,
    });
    logger.info(`[ACCOUNT-SWITCH] Closed old trade ${trade.trade_id} ${trade.symbol} on account switch`);
  }
  logger.info(`[ACCOUNT-SWITCH] Cleared ${openTrades.length} old trade(s) for user:${userId}`);
}

// ─── MONITOR OPEN TRADES ──────────────────────────────────────────────────────
async function monitorTrades() {
  const open = db.trades.getAll().filter((t) => t.status === 'open');
  if (!open.length) return [];

  const closedEvents = [];

  const byUser = {};
  for (const t of open) {
    const uid = String(t.user_id);
    if (!byUser[uid]) byUser[uid] = [];
    byUser[uid].push(t);
  }

  for (const [uid, userTrades] of Object.entries(byUser)) {
    const user = db.users.findById(uid);
    if (!user?.api_key) continue;
    const client = createClient(user);
    if (!client) continue;

    try {
      if (user.market_type === 'futures') {
        const [livePositions, openOrders] = await Promise.all([
          client.getOpenPositions().catch(() => null),
          client.getAllOpenOrders().catch(() => []),
        ]);

        if (!livePositions) continue;

        const changes = await detectAndSyncManualChanges(user, client, userTrades, livePositions, openOrders);

        if (changes.closedTrade) {
          closedEvents.push({
            trade:  changes.closedTrade,
            user,
            result: changes.closedResult,
            reason: changes.closedResult.result_label === 'WIN' ? 'TP_OR_MANUAL' : 'SL_OR_MANUAL',
          });
        }

        const liveMap = new Map(livePositions.map((p) => [`${p.symbol}:${p.side}`, p]));
        for (const trade of userTrades) {
          const live = liveMap.get(`${trade.symbol}:${trade.side}`);
          if (!live) continue;

          const price = live.current_price;
          const hitTP = trade.tp && (trade.side === 'BUY' ? price >= trade.tp : price <= trade.tp);
          const hitSL = trade.sl && (trade.side === 'BUY' ? price <= trade.sl : price >= trade.sl);

          if (hitTP) {
            const result = await closeTrade(user, trade, 'TP_HIT', price);
            if (result.success) { closedEvents.push({ trade, user, result, reason: 'TP_HIT' }); }
          } else if (hitSL) {
            const result = await closeTrade(user, trade, 'SL_HIT', price);
            if (result.success) { closedEvents.push({ trade, user, result, reason: 'SL_HIT' }); }
          }
        }
      } else {
        for (const trade of userTrades) {
          try {
            const ticker  = await client.getPrice(trade.symbol);
            const price   = parseFloat(ticker.price);
            const pd      = trade.side === 'BUY' ? price - trade.entry : trade.entry - price;
            const profit  = parseFloat((pd * trade.quantity).toFixed(4));
            const pnlPct  = trade.entry > 0 ? parseFloat(((pd / trade.entry) * 100).toFixed(2)) : 0;
            await db.trades.update(trade.trade_id, { current_price: price, profit, profit_pct: pnlPct });

            const hitTP = trade.tp && (trade.side === 'BUY' ? price >= trade.tp : price <= trade.tp);
            const hitSL = trade.sl && (trade.side === 'BUY' ? price <= trade.sl : price >= trade.sl);
            if (hitTP) {
              const result = await closeTrade(user, trade, 'TP_HIT', price);
              if (result.success) { closedEvents.push({ trade, user, result, reason: 'TP_HIT' }); }
            } else if (hitSL) {
              const result = await closeTrade(user, trade, 'SL_HIT', price);
              if (result.success) { closedEvents.push({ trade, user, result, reason: 'SL_HIT' }); }
            }
          } catch {}
        }
      }
    } catch (err) {
      logger.debug(`[MONITOR-ERR] user:${uid}`, { err: err.message });
    }
  }

  return closedEvents;
}

// ─── UPDATE USER BALANCES ─────────────────────────────────────────────────────
// Recalculates spot unrealized PNL from live prices for open trades.
async function updateUserBalances() {
  const users = db.users.getAll().filter((u) => u.api_key && !u.banned);
  for (const user of users) {
    try {
      const client = createClient(user);
      if (!client) continue;
      const bal = await client.getBalance();

      let unrealizedPnl = bal.unrealized_pnl ?? 0;
      if (user.market_type === 'spot') {
        const openTrades = db.trades.openForUser(user.telegram_id);
        if (openTrades.length > 0) {
          let spotUPnl = 0;
          const priceResults = await Promise.allSettled(
            openTrades.map((t) => client.getPrice(t.symbol))
          );
          for (let i = 0; i < openTrades.length; i++) {
            const trade  = openTrades[i];
            const result = priceResults[i];
            if (result.status !== 'fulfilled' || !result.value) continue;
            const price = parseFloat(result.value.price);
            const pd    = trade.side === 'BUY' ? price - trade.entry : trade.entry - price;
            spotUPnl   += pd * trade.quantity;
          }
          unrealizedPnl = parseFloat(spotUPnl.toFixed(4));
        }
      }

      await db.users.update(user.telegram_id, {
        balance:           bal.total,
        available_balance: bal.available ?? bal.free,
        margin_balance:    bal.margin_balance ?? bal.total,
        unrealized_pnl:    unrealizedPnl,
      });
    } catch {}
  }
}

// ─── CLEAN DATABASE DUPLICATES ────────────────────────────────────────────────
async function cleanDatabaseDuplicates() {
  return db.cleanOrphansAndDuplicates();
}

// ─── UPDATE USER STATS ON CLOSE ───────────────────────────────────────────────
async function _updateUserStatsOnClose(user, profit, profitPct, result_label) {
  try {
    const fresh       = db.users.findById(user.telegram_id);
    if (!fresh) return;
    const isWin       = result_label === 'WIN';
    const isLoss      = result_label === 'LOSS';
    const isBreakeven = result_label === 'BREAKEVEN';

    const newWins     = (fresh.wins      || 0) + (isWin  ? 1 : 0);
    const newLosses   = (fresh.losses    || 0) + (isLoss ? 1 : 0);
    const newBE       = (fresh.breakeven || 0) + (isBreakeven ? 1 : 0);
    const totalClosed = newWins + newLosses + newBE;
    const newWinRate  = totalClosed > 0 ? parseFloat(((newWins / totalClosed) * 100).toFixed(1)) : 0;

    const newConsecWins   = isWin   ? (fresh.consecutive_wins   || 0) + 1 : 0;
    const newConsecLosses = isLoss  ? (fresh.consecutive_losses || 0) + 1 : 0;

    const newTotalProfit = isWin   ? (fresh.total_profit || 0) + profit : (fresh.total_profit || 0);
    const newTotalLoss   = isLoss  ? (fresh.total_loss   || 0) + Math.abs(profit) : (fresh.total_loss || 0);
    const newNetPnl      = (fresh.net_pnl || 0) + profit;

    const newActiveTrades = Math.max(0, (fresh.active_trades || 0) - 1);
    const newTotalTrades = totalClosed;

    const dailyWins   = (fresh.daily_wins   || 0) + (isWin  ? 1 : 0);
    const dailyLosses = (fresh.daily_losses || 0) + (isLoss ? 1 : 0);

    const todayPnl   = (fresh.today_pnl   || 0) + profit;
    const weeklyPnl  = (fresh.weekly_pnl  || 0) + profit;
    const monthlyPnl = (fresh.monthly_pnl || 0) + profit;

    const avgWin  = newWins   > 0 ? parseFloat((newTotalProfit / newWins).toFixed(4)) : 0;
    const avgLoss = newLosses > 0 ? parseFloat((newTotalLoss   / newLosses).toFixed(4)) : 0;

    await db.users.update(user.telegram_id, {
      wins:               newWins,
      losses:             newLosses,
      breakeven:          newBE,
      win_rate:           newWinRate,
      consecutive_wins:   newConsecWins,
      consecutive_losses: newConsecLosses,
      total_profit:       parseFloat(newTotalProfit.toFixed(4)),
      total_loss:         parseFloat(newTotalLoss.toFixed(4)),
      net_pnl:            parseFloat(newNetPnl.toFixed(4)),
      active_trades:      newActiveTrades,
      total_trades:       newTotalTrades,
      daily_wins:         dailyWins,
      daily_losses:       dailyLosses,
      today_pnl:          parseFloat(todayPnl.toFixed(4)),
      weekly_pnl:         parseFloat(weeklyPnl.toFixed(4)),
      monthly_pnl:        parseFloat(monthlyPnl.toFixed(4)),
      avg_win:            avgWin,
      avg_loss:           avgLoss,
    });
  } catch (err) {
    logger.error('[_updateUserStatsOnClose] error', { err: err.message });
  }
}

module.exports = {
  openTrade,
  closeTrade,
  partialCloseTrade,
  moveStopLoss,
  moveTakeProfit,
  setBreakEven,
  setTrailingStop,
  importBinancePositions,
  syncUserFromBinance,
  clearUserAccountData,
  monitorTrades,
  updateUserBalances,
  cleanDatabaseDuplicates,
};
