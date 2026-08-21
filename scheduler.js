const { publicSpot, publicFutures }        = require('./binance');
const { analyzeSymbol }                     = require('./strategy');
const { openTrade, monitorTrades, updateUserBalances, syncUserFromBinance, cleanDatabaseDuplicates } = require('./trading');
const channel  = require('./channel');
const db       = require('./database');
const logger   = require('./logger');
const {
  SCAN_INTERVAL, MIN_SPOT_VOLUME, MIN_FUTURES_VOLUME,
  MONITOR_INTERVAL_MS,
} = require('./config');

let scanTimer    = null;
let monitorTimer = null;
let balanceTimer = null;
let subTimer     = null;
let reportTimer  = null;
let syncTimer    = null;
let isScanning   = false;
let isMonitoring = false;
let botRef       = null;

// ─── NOTIFY HELPERS ───────────────────────────────────────────────────────────
async function notify(telegramId, text, opts = {}) {
  if (!botRef) return null;
  try { return await botRef.telegram.sendMessage(telegramId, text, { parse_mode: 'HTML', ...opts }); }
  catch (e) { logger.debug(`[NOTIFY-FAIL] ${telegramId}`, { err: e.message }); return null; }
}

async function editMessage(telegramId, messageId, text, opts = {}) {
  if (!botRef || !messageId) return;
  try { await botRef.telegram.editMessageText(telegramId, messageId, null, text, { parse_mode: 'HTML', ...opts }); }
  catch (e) { if (!e.message?.includes('not modified')) logger.debug(`[EDIT-FAIL] ${telegramId}:${messageId}`, { err: e.message }); }
}

// ─── DURATION ────────────────────────────────────────────────────────────────
function duration(startIso, endIso) {
  const ms = new Date(endIso) - new Date(startIso);
  const m  = Math.floor(ms / 60000);
  const h  = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

// ─── SIGNAL TEXT ─────────────────────────────────────────────────────────────
function buildSignalText(sig, profitPct = null, status = 'ACTIVE') {
  const c   = sig.confirmations || {};
  const isBuy = sig.signal === 'BUY';
  const dir   = isBuy ? 'Bullish' : 'Bearish';
  const e     = isBuy ? '🟢' : '🔴';
  const grade = sig.grade === 'PREMIUM' ? '🚀 PREMIUM' : '💎 STRONG';
  const mkt   = (sig.market_type || 'spot').toUpperCase();
  const mktEmoji = mkt === 'FUTURES' ? '📊' : '📈';
  const statusMap = { ACTIVE: '🟢 ACTIVE', WIN: '✅ WIN', LOSS: '❌ LOSS', BREAKEVEN: '⚖️ BREAKEVEN' };
  const profitLine = profitPct !== null
    ? (profitPct >= 0 ? `\n💰 Profit: <b>+${profitPct.toFixed(2)}%</b>` : `\n🔻 Loss: <b>${profitPct.toFixed(2)}%</b>`)
    : '';
  const row = (label, ok) => `${ok ? '✅' : '❌'} ${label}`;
  return (
    `${e} <b>${grade} ${sig.signal} SIGNAL</b>\n\n` +
    `📊 Symbol: <b>${sig.symbol}</b>\n` +
    `${mktEmoji} Market: <b>${mkt}</b>\n` +
    `📊 Score: <b>${sig.score}/100</b>\n\n` +
    `📍 Entry: <code>${sig.entry}</code>\n` +
    `🛡 SL: <code>${sig.sl}</code>\n` +
    `🎯 TP: <code>${sig.tp || sig.tp1 || '—'}</code>\n` +
    `⚖️ RR: <b>1:${sig.rr}</b>\n\n` +
    `✨ <b>Confirmations:</b>\n` +
    `${row(`4H ${dir} Trend`, c.trend_4h)}\n` +
    `${row(`1H ${dir} Trend`, c.trend_1h)}\n` +
    `${row('BOS',             c.bos)}\n` +
    `${row('CHOCH',           c.choch)}\n` +
    `${row('Order Block',     c.order_block)}\n` +
    `${row('Fair Value Gap',  c.fvg)}\n` +
    `${row('Volume Spike',    c.volume_spike)}\n` +
    `${row('RSI Confirmed',   c.rsi)}\n\n` +
    `📈 Status: ${statusMap[status] || statusMap.ACTIVE}` + profitLine
  );
}

function buildTpNotification(trade, result) {
  const pct = result.profitPct || 0;
  return (
    `🎉 <b>Take Profit Hit!</b>\n\n` +
    `📊 <b>${trade.symbol}</b>  ${trade.side}\n` +
    `${((trade.market_type||'spot').toUpperCase()==='FUTURES'?'📊':'📈')} Market: <b>${(trade.market_type||'spot').toUpperCase()}</b>\n` +
    `📍 Entry: <code>${trade.entry}</code>\n` +
    `📤 Exit: <code>${result.closePrice?.toFixed(8) || 'N/A'}</code>\n` +
    `💰 Profit: <b>+${result.profit?.toFixed(4)} USDT</b>  (+${Math.abs(pct).toFixed(2)}%)\n` +
    `⏱ Duration: ${trade.open_time ? duration(trade.open_time, new Date().toISOString()) : 'N/A'}\n` +
    `Result: ✅ <b>WIN</b>`
  );
}

function buildSlNotification(trade, result) {
  const pct = result.profitPct || 0;
  return (
    `❌ <b>Stop Loss Hit</b>\n\n` +
    `📊 <b>${trade.symbol}</b>  ${trade.side}\n` +
    `${((trade.market_type||'spot').toUpperCase()==='FUTURES'?'📊':'📈')} Market: <b>${(trade.market_type||'spot').toUpperCase()}</b>\n` +
    `📍 Entry: <code>${trade.entry}</code>\n` +
    `📤 Exit: <code>${result.closePrice?.toFixed(8) || 'N/A'}</code>\n` +
    `🔻 Loss: <b>${result.profit?.toFixed(4)} USDT</b>  (${pct.toFixed(2)}%)\n` +
    `⏱ Duration: ${trade.open_time ? duration(trade.open_time, new Date().toISOString()) : 'N/A'}\n` +
    `Result: ❌ <b>LOSS</b>`
  );
}

function buildCloseText(trade, result) {
  const label = result.result_label || (result.isWin ? 'WIN' : result.profit === 0 ? 'BREAKEVEN' : 'LOSS');
  const emoji = label === 'WIN' ? '✅' : label === 'BREAKEVEN' ? '⚖️' : '❌';
  const pct   = result.profitPct || 0;
  return (
    `${emoji} <b>Trade ${label}</b>\n\n` +
    `📊 <b>${trade.symbol}</b>  ${trade.side}\n` +
    `${((trade.market_type||'spot').toUpperCase()==='FUTURES'?'📊':'📈')} Market: <b>${(trade.market_type||'spot').toUpperCase()}</b>\n` +
    `📍 Entry: <code>${trade.entry}</code>\n` +
    `📤 Exit: <code>${result.closePrice?.toFixed(8) || 'N/A'}</code>\n` +
    `💰 PNL: <b>${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b> (${result.profit >= 0 ? '+' : ''}${result.profit?.toFixed(4)} USDT)\n` +
    `📋 Reason: <b>${trade.close_reason || 'Manual'}</b>\n` +
    `⏱ Duration: ${trade.open_time ? duration(trade.open_time, new Date().toISOString()) : 'N/A'}`
  );
}

function buildLiveTradeText(trade) {
  const price   = trade.current_price || trade.entry;
  const pnlUsdt = trade.profit       || 0;
  const pnlPct  = trade.profit_pct   || 0;
  const e       = trade.side === 'BUY' ? '🟢' : '🔴';
  const lev     = trade.leverage   || 1;
  const margin  = trade.margin_used ? `${trade.margin_used.toFixed(2)} USDT` : 'N/A';
  const liqPx   = trade.liquidation_price ? `<code>${trade.liquidation_price}</code>` : 'N/A';
  const dur     = trade.open_time ? duration(trade.open_time, new Date().toISOString()) : 'N/A';
  const statusEmoji = pnlUsdt >= 0 ? '🟢' : '🔴';
  const mkt     = (trade.market_type || 'spot').toUpperCase();
  const mktEmoji = mkt === 'FUTURES' ? '📊' : '📈';
  return (
    `${e} <b>${trade.side} ${trade.symbol}</b>\n` +
    `${mktEmoji} Market: <b>${mkt}</b>\n\n` +
    `📍 Entry: <code>${trade.entry}</code>\n` +
    `💹 Current: <code>${typeof price === 'number' ? price.toFixed(8) : price}</code>\n` +
    `📦 Qty: <code>${trade.quantity}</code>  |  ⚡ Lev: <b>${lev}x</b>\n` +
    `🏦 Margin: ${margin}\n` +
    (trade.sl ? `🛡 SL: <code>${trade.sl}</code>\n` : '') +
    (trade.tp ? `🎯 TP: <code>${trade.tp}</code>\n` : '') +
    (trade.liquidation_price ? `💥 Liq: ${liqPx}\n` : '') +
    `\n${statusEmoji} PNL: <b>${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(4)} USDT</b>  (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)\n` +
    `⏱ Duration: ${dur}\n` +
    `🆔 <code>${trade.trade_id.slice(0, 8)}</code>`
  );
}

// ─── BROADCAST SIGNAL ────────────────────────────────────────────────────────
async function broadcastSignal(signal) {
  const users = db.users.getAll().filter((u) => db.subscriptions.isActive(u) && !u.banned);
  const text  = buildSignalText(signal);
  let sent    = 0;
  for (const u of users) {
    const msg = await notify(u.telegram_id, text);
    if (msg) sent++;
  }
  await channel.postSignalToChannel(signal);
  logger.info(`[SIGNAL-BROADCAST] ${signal.symbol} ${signal.signal} → ${sent}/${users.length} users`);
}

// ─── SCAN ONE MARKET ─────────────────────────────────────────────────────────
async function scanMarket(client, marketType, minVolume) {
  const pairs = await client.getActivePairs(minVolume);
  if (!pairs.length) return [];
  const BATCH   = 8;
  const results = [];
  for (let i = 0; i < pairs.length; i += BATCH) {
    const settled = await Promise.allSettled(pairs.slice(i, i + BATCH).map((p) => analyzeSymbol(client, p.symbol)));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) results.push({ ...r.value, market_type: marketType });
    }
    if (i + BATCH < pairs.length) await new Promise((r) => setTimeout(r, 300));
  }
  return results.sort((a, b) => b.score - a.score);
}

// ─── MAIN MARKET SCAN (single global scanner) ─────────────────────────────────
async function runMarketScan() {
  if (isScanning) {
    logger.debug('[SCAN-SKIP] Already scanning');
    return;
  }
  isScanning = true;
  const started = Date.now();
  try {
    logger.info('[SCAN-START] Scanning all Binance pairs (Spot + Futures)');

    const [spotRes, futRes] = await Promise.allSettled([
      scanMarket(publicSpot,    'spot',    MIN_SPOT_VOLUME),
      scanMarket(publicFutures, 'futures', MIN_FUTURES_VOLUME),
    ]);
    if (spotRes.status === 'rejected') logger.error('[SCAN-SPOT-ERR]',    { err: spotRes.reason?.message });
    if (futRes.status  === 'rejected') logger.error('[SCAN-FUTURES-ERR]', { err: futRes.reason?.message });

    const allSignals = [
      ...(spotRes.status    === 'fulfilled' ? spotRes.value    : []),
      ...(futRes.status === 'fulfilled' ? futRes.value : []),
    ].filter((s) => s.canTrade);

    logger.info(`[SCAN-DONE] ${allSignals.length} tradeable signals in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    for (const sig of allSignals.slice(0, 5)) {
      // ── DEDUP: symbol+side+market+entryZone ─────────────────────────────
      const dupCheck = db.signals.findActiveDuplicate(sig.symbol, sig.signal, sig.market_type, sig.entry);
      if (dupCheck.duplicate) {
        logger.info(`[SIGNAL-SKIP] ${sig.symbol} ${sig.signal} reason:${dupCheck.reason}`);
        continue;
      }

      const saved = await db.signals.create(sig);
      sig.signal_id = saved.signal_id;
      logger.info(`[SIGNAL-GEN] ${sig.symbol} ${sig.signal} score:${sig.score} market:${sig.market_type}`);

      await broadcastSignal(saved);

      // Auto trade for eligible users
      const autoUsers = db.users.getAll().filter((u) =>
         u.auto_trading && db.subscriptions.isActive(u) &&
        u.api_key && !u.banned && u.market_type === sig.market_type
      );

      for (const user of autoUsers) {
        const result = await openTrade(user, sig);
        if (result.success) {
          const t    = result.trade;
          const e    = sig.signal === 'BUY' ? '🟢' : '🔴';
          const mLbl = sig.market_type === 'futures' ? '📊 Futures' : '📈 Spot';
          const msg  = await notify(
            user.telegram_id,
            `${e} <b>Trade Opened</b> [${mLbl}]\n\n` +
            `📌 ${sig.signal} <b>${sig.symbol}</b>  Score: <b>${sig.score}/100</b>\n` +
            `📍 Entry: <code>${t.entry}</code>\n` +
            `🛡 SL: <code>${t.sl}</code>  🎯 TP: <code>${t.tp}</code>\n` +
            `📦 Qty: <code>${t.quantity}</code>  ⚡ Lev: <b>${t.leverage}x</b>\n` +
            `💰 Risk: <b>${result.riskPct}%</b>\n` +
            `🆔 <code>${t.trade_id.slice(0, 8)}</code>`,
            {
              reply_markup: { inline_keyboard: [[
                { text: '🔴 Close', callback_data: `close_trade_${t.trade_id}` },
                { text: '📊 Manage', callback_data: `manage_trade_${t.trade_id}` },
              ]] },
            }
          );
          if (msg) {
            const msgIds = t.user_message_ids || {};
            msgIds[String(user.telegram_id)] = msg.message_id;
            await db.trades.update(t.trade_id, { user_message_ids: msgIds });
          }
        } else {
          logger.info(`[TRADE-REJECT] user:${user.telegram_id} ${sig.symbol} reason:${result.reason}`);
        }
      }
    }
  } catch (err) {
    logger.error('[SCAN-ERR]', { err: err.message });
  } finally {
    isScanning = false;
  }
}

// ─── MONITOR CYCLE ────────────────────────────────────────────────────────────
async function runMonitor() {
  if (isMonitoring) return;
  isMonitoring = true;
  try {
    const closedEvents = await monitorTrades();

    for (const ev of closedEvents) {
      const { trade, user, result, reason } = ev;
      const freshTrade = db.trades.findById(trade.trade_id);
      if (!freshTrade || freshTrade.notified) continue;
      await db.trades.update(trade.trade_id, { notified: true });

      let text;
      if (reason === 'TP_HIT')      text = buildTpNotification(freshTrade, result);
      else if (reason === 'SL_HIT') text = buildSlNotification(freshTrade, result);
      else                           text = buildCloseText(freshTrade, result);

      const msgIds  = freshTrade.user_message_ids || {};
      const existing = msgIds[String(user.telegram_id)];
      if (existing) {
        await editMessage(user.telegram_id, existing, text);
      } else {
        await notify(user.telegram_id, text);
      }

      const sig = db.signals.findById(trade.signal_id);
      if (sig) await channel.closeChannelSignal(sig, result);
    }

    await updateLivePnlMessages();
  } catch (err) {
    logger.error('[MONITOR-ERR]', { err: err.message });
  } finally {
    isMonitoring = false;
  }
}

// ─── LIVE PNL UPDATES ────────────────────────────────────────────────────────
async function updateLivePnlMessages() {
  const open = db.trades.getAll().filter((t) => t.status === 'open' && t.current_price != null);
  for (const trade of open) {
    const liveText = buildLiveTradeText(trade);
    const msgIds   = trade.user_message_ids || {};
    for (const [uid, msgId] of Object.entries(msgIds)) {
      await editMessage(uid, msgId, liveText, {
        reply_markup: { inline_keyboard: [[
          { text: '🔴 Close', callback_data: `close_trade_${trade.trade_id}` },
          { text: '📊 Manage', callback_data: `manage_trade_${trade.trade_id}` },
        ]] },
      });
    }
    const sig = db.signals.findById(trade.signal_id);
    if (sig) await channel.updateChannelSignalPnl(sig, trade.profit_pct || 0);
  }
}

// ─── BINANCE SYNC FOR ALL USERS ───────────────────────────────────────────────
async function runBinanceSync() {
  const users = db.users.getAll().filter((u) => u.api_key && !u.banned);
  for (const user of users) {
    try { await syncUserFromBinance(user); } catch {}
  }
}

// ─── SUBSCRIPTION CHECKER ────────────────────────────────────────────────────
async function checkSubscriptions() {
  const now = Date.now();
  for (const user of db.users.getAll()) {
    const sub = db.subscriptions.current(user.telegram_id);
    if (sub?.status === 'ACTIVE' && sub.expires_at && now >= new Date(sub.expires_at).getTime()) {
        await db.subscriptions.update(user.telegram_id, { status: 'EXPIRED' });
        await db.users.update(user.telegram_id, { subscription: 'inactive', auto_trading: false });
        await notify(user.telegram_id, '⚠️ <b>Subscription Expired</b>\n\nAuto trading paused. Contact admin to renew.');
        logger.info(`[SUB-EXPIRED] user:${user.telegram_id}`);
    }
  }
}

// ─── DAILY REPORT ────────────────────────────────────────────────────────────
function msUntilNextReport() {
  const now  = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function runDailyReport() {
  if (!botRef) return;
  try {
    const { config } = require('./config');
    const today = db.trades.todayStats();
    const week  = db.trades.weekStats();
    const month = db.trades.monthStats();
    const msg   =
      `📊 <b>Daily Bot Summary</b>  ${new Date().toDateString()} UTC\n\n` +
      `👥 Users: ${db.users.count()} (Premium: ${db.users.countPremium()})\n` +
      `📈 Today: ${today.total} trades  ✅${today.wins} ❌${today.losses} ⚖️${today.breakeven}\n` +
      `💰 Today PNL: ${today.pnl >= 0 ? '+' : ''}${today.pnl.toFixed(4)} USDT\n` +
      `📆 Week PNL: ${week.pnl >= 0 ? '+' : ''}${week.pnl.toFixed(4)} USDT\n` +
      `🗓 Month PNL: ${month.pnl >= 0 ? '+' : ''}${month.pnl.toFixed(4)} USDT\n\n` +
      `📡 Signals Today: ${db.signals.todayCount()}  |  Open Trades: ${db.trades.countOpen()}`;
    await botRef.telegram.sendMessage(config.bot.adminChatId, msg, { parse_mode: 'HTML' });
  } catch (err) { logger.error('[DAILY-REPORT-ERR]', { err: err.message }); }
  finally { reportTimer = setTimeout(runDailyReport, 24 * 60 * 60 * 1000); }
}

// ─── START / STOP ─────────────────────────────────────────────────────────────
async function start(bot) {
  botRef = bot;
  channel.setBot(bot);

  logger.info('[STARTUP] Running database cleanup...');
  try { await cleanDatabaseDuplicates(); } catch {}
  try { await db.subscriptions.migrateLegacy(); } catch (err) { logger.warn('[SUB-MIGRATION]', { err: err.message }); }

  const settings = db.settings.get();
  const interval  = (settings.scan_interval || SCAN_INTERVAL) * 1000;
  const monitorMs = MONITOR_INTERVAL_MS || 25000;

  logger.info(`[WORKERS] scan:${interval / 1000}s monitor:${monitorMs / 1000}s`);

  setTimeout(runBinanceSync,  3000);
  setTimeout(runMarketScan,   8000);

  scanTimer    = setInterval(runMarketScan,      interval);
  monitorTimer = setInterval(runMonitor,         monitorMs);
  balanceTimer = setInterval(updateUserBalances, 60000);
  subTimer     = setInterval(checkSubscriptions, 300000);
  syncTimer    = setInterval(runBinanceSync,     monitorMs);

  const ms = msUntilNextReport();
  reportTimer = setTimeout(runDailyReport, ms);
  logger.info(`[WORKERS-READY] Daily report in ${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`);
}

function stop() {
  [scanTimer, monitorTimer, balanceTimer, subTimer, syncTimer].forEach((t) => { if (t) clearInterval(t); });
  if (reportTimer) clearTimeout(reportTimer);
  logger.info('[WORKERS-STOPPED]');
}

function updateScanInterval(seconds) {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(runMarketScan, seconds * 1000);
}

module.exports = {
  start, stop, updateScanInterval,
  runMarketScan, runBinanceSync, notify,
  buildSignalText, buildCloseText, buildLiveTradeText,
};
