const { Markup } = require('telegraf');
const db         = require('./database');
const logger     = require('./logger');

// ─── DURATION HELPER ─────────────────────────────────────────────────────────
function dur(startIso, endIso) {
  if (!startIso) return 'N/A';
  const ms = new Date(endIso || new Date()) - new Date(startIso);
  const m  = Math.floor(ms / 60000);
  const h  = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
async function showDashboard(ctx, user, edit = false) {
  try {
    const { syncUserFromBinance } = require('./trading');
    await syncUserFromBinance(user);
    user = db.users.findById(user.telegram_id) || user;
  } catch {}

  const openTrades = db.trades.openForUser(user.telegram_id);
  const sub        = db.subscriptions.isActive(user);
  const subLabel   = sub ? `✅ ${(user.plan || 'Active').toUpperCase()}` : '❌ Inactive';

  // balance = total wallet, available = free to trade
  const totalBal   = (user.balance           || 0).toFixed(2);
  const avail      = (user.available_balance || user.balance || 0).toFixed(2);
  const locked     = Math.max(0, (user.balance || 0) - (user.available_balance || user.balance || 0)).toFixed(2);
  const uPnl       = (user.unrealized_pnl   || 0).toFixed(4);
  const net        = (user.net_pnl          || 0).toFixed(4);
  const todayPNL   = (user.today_pnl        || 0).toFixed(4);
  const weekPNL    = (user.weekly_pnl       || 0).toFixed(4);
  const syncTime   = user.last_binance_sync ? new Date(user.last_binance_sync).toLocaleTimeString() : 'Never';

  const paused   = user.trading_paused ? '⏸ Paused Today' : '';
  const status   = paused || (user.auto_trading ? '🤖 Auto Trading ON' : '⏹ Auto Trading OFF');

  const mktLabel = user.market_type
    ? `${user.market_type === 'futures' ? '📊 Futures' : '📈 Spot'}${user.testnet ? ' [Testnet]' : ''}`
    : '—';

  const msg =
    `📊 <b>Dashboard</b>\n` +
    `👋 <b>${user.first_name || user.username || 'Trader'}</b>  |  ${subLabel}\n` +
    `${mktLabel}\n\n` +
    `💰 <b>Wallet</b>\n` +
    `  Total: <code>${totalBal} USDT</code>\n` +
    `  Available: <code>${avail} USDT</code>\n` +
    `  In Positions: <code>${locked} USDT</code>\n` +
    `  Unrealized PNL: <code>${parseFloat(uPnl) >= 0 ? '+' : ''}${uPnl} USDT</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📈 <b>Statistics</b>\n` +
    `  Total: ${user.total_trades || 0}  ✅${user.wins || 0} ❌${user.losses || 0} ⚖️${user.breakeven || 0}\n` +
    `  Win Rate: <b>${user.win_rate || 0}%</b>\n` +
    `  Net PNL: <b>${parseFloat(net) >= 0 ? '+' : ''}${net} USDT</b>\n` +
    `  Consec. Wins: ${user.consecutive_wins || 0}  |  Losses: ${user.consecutive_losses || 0}\n\n` +
    `📅 <b>PNL</b>\n` +
    `  Today: <b>${parseFloat(todayPNL) >= 0 ? '+' : ''}${todayPNL} USDT</b>\n` +
    `  Weekly: <b>${parseFloat(weekPNL) >= 0 ? '+' : ''}${weekPNL} USDT</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 Today: ✅${user.daily_wins || 0} ❌${user.daily_losses || 0}\n` +
    `🔓 Open Trades: <b>${openTrades.length}</b>\n` +
    `Status: <b>${status}</b>\n` +
    `🔄 Synced: ${syncTime}`;

  const kbRows = [
    [Markup.button.callback('💰 Balance', 'balance'), Markup.button.callback('📈 Active Trades', 'active_trades')],
    [Markup.button.callback('📜 History', 'trade_history'), Markup.button.callback('📊 Statistics', 'statistics')],
  ];
  if (sub) {
    kbRows.push([user.auto_trading
      ? Markup.button.callback('🔴 Auto Trading OFF', 'trading_off')
      : Markup.button.callback('🟢 Auto Trading ON',  'trading_on')]);
  }
  kbRows.push([Markup.button.callback('⚙️ Settings', 'user_settings'), Markup.button.callback('💳 Subscription', 'subscription')]);
  kbRows.push([Markup.button.callback('🎁 Referral', 'referral'), Markup.button.callback('ℹ️ Help', 'help')]);

  const kb = Markup.inlineKeyboard(kbRows);
  try {
    if (edit && ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
    else await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  } catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── BALANCE ─────────────────────────────────────────────────────────────────
async function handleBalance(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');
  if (!user.api_key) {
    return ctx.editMessageText('⚠️ No Binance API connected.\n\nConnect via Settings.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Connect Binance', 'change_api')],
        [Markup.button.callback('🔙 Dashboard',       'dashboard')],
      ]),
    }).catch(() => ctx.reply('No API connected.'));
  }
  const { createClient } = require('./binance');
  const client = createClient(user);
  if (!client) return;
  try {
    const bal = await client.getBalance();

    // For spot, calculate unrealized PNL from open trades
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
      last_binance_sync: new Date().toISOString(),
    });

    const locked = Math.max(0, bal.total - (bal.available ?? bal.free));
    const msg =
      `💰 <b>Your Balance</b>\n\n` +
      `📊 Total Wallet: <code>${bal.total.toFixed(4)} USDT</code>\n` +
      `💵 Available: <code>${(bal.available ?? bal.free).toFixed(4)} USDT</code>\n` +
      `🔒 In Positions: <code>${locked.toFixed(4)} USDT</code>\n` +
      (bal.margin_balance !== undefined ? `🏦 Margin Balance: <code>${bal.margin_balance.toFixed(4)} USDT</code>\n` : '') +
      `📈 Unrealized PNL: <code>${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(4)} USDT</code>\n` +
      `\nAccount: <b>${user.market_type?.toUpperCase() || 'N/A'}${user.testnet ? ' [Testnet]' : ''}</b>`;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'balance')],
      [Markup.button.callback('🔙 Dashboard', 'dashboard')],
    ]);
    try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
    catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
  } catch (err) {
    logger.warn('[BALANCE-FAIL]', { err: err.message });
    await ctx.reply('❌ Could not fetch balance: ' + err.message);
  }
}

// ─── ACTIVE TRADES (live, all fields, manage buttons) ─────────────────────────
async function handleActiveTrades(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');

  if (user.api_key) {
    try { const { syncUserFromBinance } = require('./trading'); await syncUserFromBinance(user); } catch {}
  }

  const open = db.trades.openForUser(user.telegram_id);

  if (!open.length) {
    const msg = '📈 <b>Active Trades</b>\n\nNo open trades.\n\n<i>Your Binance positions are imported automatically every 25 seconds.</i>';
    const kb  = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'active_trades')],
      [Markup.button.callback('🔙 Dashboard', 'dashboard')],
    ]);
    try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
    catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
    return;
  }

  let msg = `📈 <b>Active Trades (${open.length})</b>\n\n`;
  const kbRows = [];

  for (const t of open) {
    const price    = t.current_price || t.entry;
    const pnlUsdt  = t.profit       || 0;
    const pnlPct   = t.profit_pct   || 0;
    const e        = t.side === 'BUY' ? '🟢' : '🔴';
    const lev      = t.leverage     || 1;
    const margin   = t.margin_used ? `${t.margin_used.toFixed(2)} USDT` : 'N/A';
    const liqPx    = t.liquidation_price ? `<code>${t.liquidation_price}</code>` : 'N/A';
    const duration = dur(t.open_time, new Date().toISOString());
    const tag      = t.imported ? ' [Manual]' : '';
    const stLabel  = pnlUsdt >= 0 ? '🟢 PROFIT' : '🔴 LOSS';

    const mkt = (t.market_type || 'spot').toUpperCase();
    const mktEmoji = mkt === 'FUTURES' ? '📊' : '📈';
    msg +=
      `${e} <b>${t.side} ${t.symbol}</b>${tag}\n` +
      `  ${mktEmoji} Market: <b>${mkt}</b>\n` +
      `  Entry: <code>${t.entry}</code>  →  Now: <code>${typeof price === 'number' ? price.toFixed(8) : price}</code>\n` +
      `  Qty: <code>${t.quantity}</code>  |  Lev: <b>${lev}x</b>  |  Margin: ${margin}\n` +
      (t.sl ? `  SL: <code>${t.sl}</code>  ` : '  ') +
      (t.tp ? `TP: <code>${t.tp}</code>\n` : '\n') +
      (t.liquidation_price ? `  Liq: ${liqPx}\n` : '') +
      `  💰 PNL: <b>${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(4)} USDT</b>  (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)\n` +
      `  ⏱ Duration: ${duration}  |  ${stLabel}\n\n`;

    kbRows.push([
      Markup.button.callback(`🔴 Close ${t.symbol}`, `close_trade_${t.trade_id}`),
      Markup.button.callback('📊 Manage',             `manage_trade_${t.trade_id}`),
    ]);
  }

  kbRows.push([Markup.button.callback('🔄 Refresh', 'active_trades'), Markup.button.callback('🔙 Dashboard', 'dashboard')]);
  const kb = Markup.inlineKeyboard(kbRows);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── TRADE MANAGEMENT MENU ────────────────────────────────────────────────────
async function showTradeManagement(ctx, tradeId) {
  const trade = db.trades.findById(tradeId);
  if (!trade || trade.status !== 'open') return ctx.answerCbQuery('Trade not found or already closed.', { show_alert: true });

  const price   = trade.current_price || trade.entry;
  const pnlUsdt = trade.profit       || 0;
  const pnlPct  = trade.profit_pct   || 0;
  const e       = trade.side === 'BUY' ? '🟢' : '🔴';

  const tradeMkt = (trade.market_type || 'spot').toUpperCase();
  const tradeMktEmoji = tradeMkt === 'FUTURES' ? '📊' : '📈';
  const msg =
    `📊 <b>Manage Trade</b>\n\n` +
    `${e} <b>${trade.side} ${trade.symbol}</b>${trade.imported ? ' [Manual]' : ''}\n` +
    `${tradeMktEmoji} Market: <b>${tradeMkt}</b>\n` +
    `Entry: <code>${trade.entry}</code>  →  Now: <code>${typeof price === 'number' ? price.toFixed(8) : price}</code>\n` +
    `Qty: <code>${trade.quantity}</code>  |  Lev: <b>${trade.leverage || 1}x</b>  |  Margin: ${trade.margin_used ? trade.margin_used.toFixed(2) + ' USDT' : 'N/A'}\n` +
    (trade.sl ? `SL: <code>${trade.sl}</code>\n` : '') +
    (trade.tp ? `TP: <code>${trade.tp}</code>\n` : '') +
    `\n💰 PNL: <b>${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(4)} USDT</b>  (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)\n` +
    `⏱ Duration: ${dur(trade.open_time, new Date().toISOString())}\n\n` +
    `Choose action:`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔴 Close 100%', `close_trade_${tradeId}`), Markup.button.callback('⚡ Close 50%', `partial_close_${tradeId}_50`)],
    [Markup.button.callback('🔸 Close 25%',  `partial_close_${tradeId}_25`), Markup.button.callback('🔹 Close 75%', `partial_close_${tradeId}_75`)],
    [Markup.button.callback('🛡 Move SL', `move_sl_${tradeId}`), Markup.button.callback('🎯 Move TP', `move_tp_${tradeId}`)],
    [Markup.button.callback('⚖️ Break Even', `break_even_${tradeId}`), Markup.button.callback('🔄 Trailing Stop', `trailing_stop_${tradeId}`)],
    [Markup.button.callback('🔙 Back', 'active_trades')],
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── TRADE HISTORY (full fields) ──────────────────────────────────────────────
async function handleTradeHistory(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const user   = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');
  const closed = db.trades.forUser(user.telegram_id)
    .filter((t) => t.status === 'closed')
    .sort((a, b) => new Date(b.close_time) - new Date(a.close_time))
    .slice(0, 12);

  if (!closed.length) {
    const msg = '📜 <b>Trade History</b>\n\nNo closed trades yet.';
    const kb  = Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard', 'dashboard')]]);
    try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
    catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
    return;
  }

  let msg = `📜 <b>Trade History (last ${closed.length})</b>\n\n`;
  for (const t of closed) {
    const label  = t.result || (t.profit > 0 ? 'WIN' : t.profit === 0 ? 'BREAKEVEN' : 'LOSS');
    const emoji  = label === 'WIN' ? '✅' : label === 'BREAKEVEN' ? '⚖️' : '❌';
    const pct    = t.profit_pct ? ` (${t.profit_pct >= 0 ? '+' : ''}${t.profit_pct.toFixed(2)}%)` : '';
    const tag    = t.imported ? ' [M]' : '';
    const lev    = t.leverage || 1;
    const margin = t.margin_used ? `${t.margin_used.toFixed(2)}U` : '—';
    const mktFull = (t.market_type || 'spot').toUpperCase();
    const mktHistEmoji = mktFull === 'FUTURES' ? '📊' : '📈';
    const d      = dur(t.open_time, t.close_time);
    msg +=
      `${emoji} <b>${t.side} ${t.symbol}</b>${tag}\n` +
      `  ${mktHistEmoji} Market: <b>${mktFull}</b>\n` +
      `  Entry: <code>${t.entry}</code>  Exit: <code>${t.close_price ? parseFloat(t.close_price).toFixed(8) : 'N/A'}</code>\n` +
      `  Qty: <code>${t.quantity || '—'}</code>  Lev: <b>${lev}x</b>  Margin: ${margin}\n` +
      `  PNL: <b>${(t.profit || 0) >= 0 ? '+' : ''}${(t.profit || 0).toFixed(4)} USDT</b>${pct}\n` +
      `  Duration: ${d}  |  ${t.close_reason || 'MANUAL'}\n` +
      `  Result: <b>${label}</b>\n\n`;
  }

  const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard', 'dashboard')]]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── STATISTICS ───────────────────────────────────────────────────────────────
async function handleStatistics(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');

  const openCount = db.trades.openForUser(user.telegram_id).length;
   const today     = db.trades.todayStats(user.telegram_id);
   const week      = db.trades.weekStats(user.telegram_id);
   const month     = db.trades.monthStats(user.telegram_id);
  const totalBE   = db.trades.countBreakeven(user.telegram_id);

  const msg =
    `📊 <b>Statistics</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏆 <b>All Time</b>\n` +
    `  Total: <b>${user.total_trades || 0}</b>  (Spot: ${user.spot_trades || 0} | Futures: ${user.futures_trades || 0})\n` +
    `  ✅ Wins: <b>${user.wins || 0}</b>  ❌ Losses: <b>${user.losses || 0}</b>  ⚖️ BE: <b>${totalBE}</b>\n` +
    `  Win Rate: <b>${user.win_rate || 0}%</b>\n` +
    `  Consec. Wins: ${user.consecutive_wins || 0}  |  Losses: ${user.consecutive_losses || 0}\n\n` +
    `💰 <b>PNL</b>\n` +
    `  Total Profit: <b>+${(user.total_profit || 0).toFixed(4)} USDT</b>\n` +
    `  Total Loss: <b>-${(user.total_loss   || 0).toFixed(4)} USDT</b>\n` +
    `  Net PNL: <b>${(user.net_pnl || 0) >= 0 ? '+' : ''}${(user.net_pnl || 0).toFixed(4)} USDT</b>\n` +
    `  Avg Win: ${(user.avg_win  || 0).toFixed(4)} USDT  |  Avg Loss: ${(user.avg_loss || 0).toFixed(4)} USDT\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 <b>Today</b>  ✅${today.wins} ❌${today.losses} ⚖️${today.breakeven}\n` +
    `  PNL: <b>${today.pnl >= 0 ? '+' : ''}${today.pnl.toFixed(4)} USDT</b>\n\n` +
    `📆 <b>Week</b>  ✅${week.wins} ❌${week.losses} ⚖️${week.breakeven}\n` +
    `  PNL: <b>${week.pnl >= 0 ? '+' : ''}${week.pnl.toFixed(4)} USDT</b>\n\n` +
    `🗓 <b>Month</b>  ✅${month.wins} ❌${month.losses} ⚖️${month.breakeven}\n` +
    `  PNL: <b>${month.pnl >= 0 ? '+' : ''}${month.pnl.toFixed(4)} USDT</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔓 Open Trades: <b>${openCount}</b>\n` +
    `⏸ Trading Paused: <b>${user.trading_paused ? 'Yes (admin pause)' : 'No'}</b>`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'statistics'), Markup.button.callback('🔙 Dashboard', 'dashboard')],
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── USER SETTINGS ────────────────────────────────────────────────────────────
async function handleUserSettings(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');
  const connected = user.api_key ? '✅ Connected' : '❌ Not Connected';
  const mkt = user.market_type
    ? `${user.market_type === 'futures' ? '📊 Futures' : '📈 Spot'}${user.testnet ? ' [Testnet]' : ''}`
    : 'Not set';
  const syncTime = user.last_binance_sync ? new Date(user.last_binance_sync).toLocaleTimeString() : 'Never';
  const msg =
    `⚙️ <b>Settings</b>\n\n` +
    `🔗 Binance API: ${connected}\n` +
    `📊 Market: ${mkt}\n` +
    `🆔 Telegram ID: <code>${user.telegram_id}</code>\n` +
    `👤 Username: @${user.username || 'N/A'}\n` +
    `📅 Joined: ${new Date(user.join_date).toLocaleDateString()}\n` +
    `🔄 Last Sync: ${syncTime}`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Change Binance API', 'change_api')],
    [Markup.button.callback('🔄 Sync Binance Now',   'sync_binance')],
    [Markup.button.callback('📋 Copy My ID',         'copy_id')],
    [Markup.button.callback('🔙 Dashboard',          'dashboard')],
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── AUTO TRADING ─────────────────────────────────────────────────────────────
async function handleAutoTradingOn(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');
  if (!db.subscriptions.isActive(user)) return ctx.answerCbQuery('❌ Active subscription required.', { show_alert: true });
  if (!user.api_key) return ctx.answerCbQuery('❌ Connect Binance API first.', { show_alert: true });
  await db.users.update(user.telegram_id, { auto_trading: true });
  await showDashboard(ctx, db.users.findById(user.telegram_id), true);
}

async function handleAutoTradingOff(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const user = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');
  await db.users.update(user.telegram_id, { auto_trading: false });
  await showDashboard(ctx, db.users.findById(user.telegram_id), true);
}

// ─── CLOSE TRADE (manual 100%) ────────────────────────────────────────────────
async function handleCloseTradeAction(ctx, tradeId, bot) {
  await ctx.answerCbQuery('Closing...').catch(() => {});
  const user  = db.users.findById(ctx.from.id);
  if (!user) return ctx.reply('Use /start first.');
  const trade = db.trades.findById(tradeId);
  if (!trade || trade.status !== 'open') return ctx.answerCbQuery('Trade not found or already closed.', { show_alert: true });
  if (String(trade.user_id) !== String(user.telegram_id)) return ctx.answerCbQuery('Not your trade.', { show_alert: true });

  const { closeTrade } = require('./trading');
  const result = await closeTrade(user, trade, 'MANUAL');
  if (!result.success) return ctx.reply('❌ Failed to close: ' + (result.error || 'Unknown error'));

  const label  = result.result_label || (result.profit > 0 ? 'WIN' : result.profit === 0 ? 'BREAKEVEN' : 'LOSS');
  const emoji  = label === 'WIN' ? '✅' : label === 'BREAKEVEN' ? '⚖️' : '❌';
  const pct    = result.profitPct || 0;

  const closeMsg =
    `${emoji} <b>Trade Closed — ${label}</b>\n\n` +
    `📌 ${trade.side} <b>${trade.symbol}</b>\n` +
    `📍 Entry: <code>${trade.entry}</code>\n` +
    `📤 Exit: <code>${result.closePrice?.toFixed(8) || 'N/A'}</code>\n` +
    `💰 P&L: <b>${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b> (${result.profit >= 0 ? '+' : ''}${result.profit?.toFixed(4)} USDT)\n` +
    `⏱ Duration: ${dur(trade.open_time, new Date().toISOString())}\n` +
    `📋 Reason: Manual Close`;

  try { await ctx.editMessageText(closeMsg, { parse_mode: 'HTML' }); }
  catch { await ctx.reply(closeMsg, { parse_mode: 'HTML' }); }

  const sig = db.signals.findById(trade.signal_id);
  if (sig) { const channel = require('./channel'); await channel.closeChannelSignal(sig, result); }
}

module.exports = {
  showDashboard,
  handleBalance,
  handleActiveTrades,
  showTradeManagement,
  handleTradeHistory,
  handleStatistics,
  handleUserSettings,
  handleAutoTradingOn,
  handleAutoTradingOff,
  handleCloseTradeAction,
};
