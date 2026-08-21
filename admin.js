const { Markup }   = require('telegraf');
const db           = require('./database');
const logger       = require('./logger');
const { config }   = require('./config');
const channel      = require('./channel');
const { verifyChannelPermissions } = require('./channel');

function isAdmin(ctx) {
  return String(ctx.from?.id) === String(config.bot.adminChatId);
}

// ─── SESSION STORES ───────────────────────────────────────────────────────────
const broadcastSessions = {};   // userId → { step, type, content, target, pin }
const actionSessions    = {};   // userId → { action }
const editSessions      = {};   // userId → { field, context }

// ─── TODAY HELPER ─────────────────────────────────────────────────────────────
function todayUTC() { return new Date().toISOString().split('T')[0]; }

const SUB_DAYS = { DAILY: 1, WEEKLY: 7, MONTHLY: 30, LIFETIME: null };
function subscriptionExpiry(type, base = Date.now()) {
  const days = SUB_DAYS[String(type).toUpperCase()];
  return days === null ? null : new Date(base + days * 86400000).toISOString();
}

async function grantSubscription(user, type, extend = false) {
  const subscription_type = String(type || 'MONTHLY').toUpperCase();
  if (!(subscription_type in SUB_DAYS)) throw new Error('Duration must be DAILY, WEEKLY, MONTHLY, or LIFETIME');
  const current = db.subscriptions.current(user.telegram_id);
  const now = Date.now();
  const base = extend && current?.expires_at ? Math.max(now, new Date(current.expires_at).getTime()) : now;
  const expires_at = subscription_type === 'LIFETIME' ? null : subscriptionExpiry(subscription_type, base);
  let record;
  if (current && !extend) {
    record = await db.subscriptions.update(user.telegram_id, {
      subscription_type, started_at: new Date().toISOString(), expires_at, status: 'ACTIVE',
    });
  } else if (current && extend) {
    record = await db.subscriptions.update(user.telegram_id, { subscription_type, expires_at, status: 'ACTIVE' });
  } else {
    record = await db.subscriptions.save({ user_id: user.telegram_id, subscription_type, expires_at, status: 'ACTIVE' });
  }
  await db.users.update(user.telegram_id, {
    subscription: 'active', plan: subscription_type.toLowerCase(), subscription_expiry: expires_at,
  });
  return record;
}

async function revokeSubscription(user) {
  const record = db.subscriptions.current(user.telegram_id);
  if (record) await db.subscriptions.update(user.telegram_id, { status: 'REVOKED' });
  await db.users.update(user.telegram_id, { subscription: 'inactive', auto_trading: false });
}

// ─── ADMIN PANEL (inline) ────────────────────────────────────────────────────

async function showAdminPanel(ctx, edit = false) {
  const users   = db.users;
  const trades  = db.trades;
  const signals = db.signals;
  const today   = trades.todayStats();
  const chCfg   = db.channel.get();

  const msg =
    `🔐 <b>ADMIN PANEL</b>\n\n` +
    `👥 Total Users: <b>${users.count()}</b>\n` +
    `   💎 Premium: ${users.countPremium()}  |  🆓 Free: ${users.countFree()}\n` +
    `   📈 Spot: ${users.countSpot()}  |  📊 Futures: ${users.countFutures()}\n` +
    `   🤖 Auto Trading: ${users.countActive()}\n` +
    `   👁 Active Today: ${users.countActiveToday()}\n\n` +
    `📈 <b>Trades</b>\n` +
    `   🔓 Open: ${trades.countOpen()}\n` +
    `   📅 Today: ${today.total} (✅${today.wins} ❌${today.losses})\n` +
    `   💰 Today PNL: ${today.pnl >= 0 ? '+' : ''}${today.pnl.toFixed(4)} USDT\n` +
    `   💹 Total PNL: ${parseFloat(trades.totalProfit()) >= 0 ? '+' : ''}${trades.totalProfit()} USDT\n\n` +
    `📡 Signals Today: <b>${signals.todayCount()}</b>\n` +
    `📢 Channel: <b>${chCfg.enabled && chCfg.channel_id ? '🟢 ON' : '🔴 OFF'}</b>\n\n` +
    `⏰ ${new Date().toUTCString()}`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('👥 Users',          'adm_users'),
      Markup.button.callback('📈 Trades',         'adm_trades'),
    ],
    [
      Markup.button.callback('📊 Statistics',     'adm_stats'),
      Markup.button.callback('💰 Revenue',        'adm_revenue'),
    ],
    [
      Markup.button.callback('📢 Broadcast',      'adm_broadcast_menu'),
      Markup.button.callback('📡 Channel',        'adm_channel_menu'),
    ],
    [
      Markup.button.callback('⚙️ Settings',       'adm_settings'),
      Markup.button.callback('📋 Logs',           'adm_logs'),
    ],
    [
      Markup.button.callback('💳 Payment Setup',  'adm_payment'),
      Markup.button.callback('ℹ️ Help Settings',  'adm_help_settings'),
    ],
    [
      Markup.button.callback('🔒 Ban User',       'adm_ban'),
      Markup.button.callback('✅ Unban',          'adm_unban'),
    ],
    [
      Markup.button.callback('🗑 Delete User',    'adm_delete'),
      Markup.button.callback('💳 Grant Sub',      'adm_grant'),
    ],
    [
      Markup.button.callback('📥 Export',         'adm_export'),
      Markup.button.callback('🔄 Restart',        'adm_restart'),
    ],
  ]);

  try {
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
    } else {
      await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
    }
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

// ─── USERS ────────────────────────────────────────────────────────────────────

async function handleAdminUsers(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const all   = db.users.getAll().slice(0, 30);
  const total = db.users.count();

  let msg = `👥 <b>Users (${total} total)</b>\n\n`;
  for (const u of all) {
    const sub = db.subscriptions.isActive(u) ? '💎' : '🆓';
    const bot = u.auto_trading ? '🤖' : '—';
    const ban = u.banned ? ' 🚫' : '';
    const mkt = u.market_type ? `[${u.market_type[0].toUpperCase()}]` : '';
    msg +=
      `${sub}${bot}${ban} ${mkt} <b>${u.first_name || u.username || 'N/A'}</b>\n` +
      `  ID: <code>${u.telegram_id}</code>  Bal: ${(u.balance || 0).toFixed(2)} USDT  Trades: ${u.total_trades || 0}  WR: ${u.win_rate || 0}%\n\n`;
  }
  if (total > 30) msg += `<i>...and ${total - 30} more</i>`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'adm_panel')]]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

// ─── TRADES ──────────────────────────────────────────────────────────────────

async function handleAdminTrades(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const trades = db.trades.getAll()
    .sort((a, b) => new Date(b.open_time) - new Date(a.open_time))
    .slice(0, 20);

  let msg = `📈 <b>Recent Trades (${db.trades.count()} total, ${db.trades.countOpen()} open)</b>\n\n`;
  for (const t of trades) {
    const e   = t.status === 'open' ? '🟡' : (t.profit >= 0 ? '✅' : '❌');
    const m   = t.market_type === 'futures' ? '[F]' : '[S]';
    const pct = t.profit_pct ? ` (${t.profit_pct >= 0 ? '+' : ''}${t.profit_pct}%)` : '';
    msg +=
      `${e} ${m} <b>${t.symbol}</b> ${t.side}  Score: ${t.score || '?'}\n` +
      `  UID: <code>${t.user_id}</code>  PNL: <code>${(t.profit || 0).toFixed(4)}</code>${pct}  ${t.status}\n\n`;
  }

  const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'adm_panel')]]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

// ─── STATISTICS ───────────────────────────────────────────────────────────────

async function handleAdminStats(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const users  = db.users.getAll();
  const trades = db.trades.getAll();
  const closed = trades.filter((t) => t.status === 'closed');
  const wins   = closed.filter((t) => t.profit > 0);
  const losses = closed.filter((t) => t.profit < 0);
  const wr     = closed.length ? ((wins.length / closed.length) * 100).toFixed(1) : '0';
  const profit = wins.reduce((s, t) => s + t.profit, 0).toFixed(4);
  const loss   = losses.reduce((s, t) => s + Math.abs(t.profit), 0).toFixed(4);
  const net    = (parseFloat(profit) - parseFloat(loss)).toFixed(4);

  const weekStart  = new Date(); weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const filter = (from) => closed.filter((t) => t.close_time && new Date(t.close_time) >= from);
  const weekClosed  = filter(weekStart);
  const monthClosed = filter(monthStart);

  function periodStats(list) {
    const w = list.filter((t) => t.profit > 0);
    const l = list.filter((t) => t.profit < 0);
    const wr = list.length ? ((w.length / list.length) * 100).toFixed(1) : '0';
    const pnl = list.reduce((s, t) => s + (t.profit || 0), 0);
    return `${list.length} trades  ✅${w.length} ❌${l.length}  WR: ${wr}%  PNL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDT`;
  }

  const pausedUsers = users.filter((u) => u.trading_paused).length;

  const msg =
    `📊 <b>Bot Statistics</b>\n\n` +
    `👥 <b>Users</b>\n` +
    `  Total: ${users.length}  Premium: ${db.users.countPremium()}  Free: ${db.users.countFree()}\n` +
    `  Spot: ${db.users.countSpot()}  Futures: ${db.users.countFutures()}\n` +
    `  Auto Trading: ${db.users.countActive()}  Banned: ${db.users.countBanned()}\n` +
    `  Paused Today: ${pausedUsers}\n\n` +
    `📅 <b>Today</b>\n  ${periodStats([...closed].filter((t) => t.close_time?.startsWith(todayUTC())))}\n\n` +
    `📆 <b>This Week</b>\n  ${periodStats(weekClosed)}\n\n` +
    `🗓 <b>This Month</b>\n  ${periodStats(monthClosed)}\n\n` +
    `🏆 <b>All Time</b>\n` +
    `  Trades: ${trades.length}  Open: ${db.trades.countOpen()}  Closed: ${closed.length}\n` +
    `  Win Rate: ${wr}%  (${wins.length}W / ${losses.length}L)\n` +
    `  Profit: +${profit} USDT  Loss: -${loss} USDT\n` +
    `  Net: ${parseFloat(net) >= 0 ? '+' : ''}${net} USDT\n\n` +
    `📡 Signals Generated: ${db.signals.count()}`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'adm_panel')]]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

// ─── REVENUE (reads from dynamic payment settings) ───────────────────────────

async function handleAdminRevenue(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const users   = db.users.getAll();
  const payment = db.payment.get();
  const plans   = {
    daily:    payment.daily_price    || 2.99,
    weekly:   payment.weekly_price   || 9.99,
    monthly:  payment.monthly_price  || 29.99,
    lifetime: payment.lifetime_price || 99.99,
  };
  const cnts    = { daily: 0, weekly: 0, monthly: 0, lifetime: 0 };
  for (const u of users) { if (u.plan && cnts[u.plan] !== undefined) cnts[u.plan]++; }
  const total   = Object.entries(cnts).reduce((s, [p, c]) => s + (plans[p] || 0) * c, 0).toFixed(2);
    const active  = users.filter((u) => db.subscriptions.isActive(u)).length;
  const expired = users.filter((u) => !db.subscriptions.isActive(u) && u.plan).length;

  const msg =
    `💰 <b>Revenue Overview</b>\n\n` +
    `✅ Active Subscribers: <b>${active}</b>\n` +
    `❌ Expired: <b>${expired}</b>\n\n` +
    `📅 Daily ($${plans.daily}):    <b>${cnts.daily}</b>   → $${(cnts.daily * plans.daily).toFixed(2)}\n` +
    `📆 Weekly ($${plans.weekly}):   <b>${cnts.weekly}</b>  → $${(cnts.weekly * plans.weekly).toFixed(2)}\n` +
    `🗓 Monthly ($${plans.monthly}): <b>${cnts.monthly}</b> → $${(cnts.monthly * plans.monthly).toFixed(2)}\n` +
    `♾️ Lifetime ($${plans.lifetime}): <b>${cnts.lifetime}</b> → $${(cnts.lifetime * plans.lifetime).toFixed(2)}\n\n` +
    `💵 <b>Estimated Total Revenue: $${total}</b>`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'adm_panel')]]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

async function handleAdminSettings(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const s = db.settings.get();
  const msg =
    `⚙️ <b>Bot Settings</b>\n\n` +
    `📊 Risk Per Trade: <b>${s.risk_percent}%</b>\n` +
    `⏱ Scan Interval: <b>${s.scan_interval}s</b>\n` +
    `📈 Max Active Trades: <b>${s.max_trades}</b>\n` +
    `🔧 Maintenance: <b>${s.maintenance ? '🟡 ON' : '🟢 OFF'}</b>\n\n` +
    `<b>Quick Set — Max Trades:</b> (tap a button below)\n\n` +
    `Or send text commands:\n` +
    `<code>set risk 1</code>\n` +
    `<code>set interval 60</code>\n` +
    `<code>set max_trades 5</code>\n` +
    `<code>set maintenance on/off</code>`;

  const cur = s.max_trades || 3;
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(cur === 3  ? '✅ Max: 3'  : 'Max: 3',  'adm_set_max_trades_3'),
      Markup.button.callback(cur === 5  ? '✅ Max: 5'  : 'Max: 5',  'adm_set_max_trades_5'),
      Markup.button.callback(cur === 10 ? '✅ Max: 10' : 'Max: 10', 'adm_set_max_trades_10'),
    ],
    [
      Markup.button.callback('🔧 Maintenance ON',  'adm_maint_on'),
      Markup.button.callback('✅ Maintenance OFF', 'adm_maint_off'),
    ],
    [Markup.button.callback('🔙 Back', 'adm_panel')],
  ]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

async function handleSetMaxTrades(ctx, n) {
  await ctx.answerCbQuery(`✅ Max trades set to ${n}`).catch(() => {});
  await db.settings.update({ max_trades: n });
  logger.info(`[ADMIN-SETTING] max_trades → ${n}`);
  await handleAdminSettings(ctx);
}

async function handleMaintenanceToggle(ctx, on) {
  await ctx.answerCbQuery(`🔧 Maintenance ${on ? 'ON' : 'OFF'}`).catch(() => {});
  await db.settings.update({ maintenance: on });
  logger.info(`[ADMIN-SETTING] maintenance → ${on}`);
  await handleAdminSettings(ctx);
}

async function handleSettingCommand(ctx) {
  const text = ctx.message?.text?.trim() || '';
  const m    = text.match(/^set\s+(\w+)\s+(.+)$/i);
  if (!m) return false;

  const [, key, val] = m;
  const keyMap = {
    risk:        'risk_percent',
    interval:    'scan_interval',
    max_trades:  'max_trades',
    maintenance: 'maintenance',
    welcome:     'welcome_message',
  };
  const dbKey = keyMap[key.toLowerCase()];
  if (!dbKey) return false;

  let parsed = val.trim();
  if (dbKey === 'maintenance') parsed = (parsed.toLowerCase() === 'on');
  else if (dbKey !== 'welcome_message') { parsed = parseFloat(parsed); if (isNaN(parsed)) return false; }

  await db.settings.update({ [dbKey]: parsed });
  logger.info(`[ADMIN-EDIT] Setting ${dbKey} = ${parsed}`);
  await ctx.reply(`✅ <b>${dbKey}</b> updated to <code>${parsed}</code>`, { parse_mode: 'HTML' });
  return true;
}

// ─── PAYMENT SETTINGS ─────────────────────────────────────────────────────────

async function handleAdminPayment(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const p = db.payment.get();
  const msg =
    `💳 <b>Payment Settings</b>\n\n` +
    `📅 Daily:    <b>$${p.daily_price}</b>\n` +
    `📆 Weekly:   <b>$${p.weekly_price}</b>\n` +
    `🗓 Monthly:  <b>$${p.monthly_price}</b>\n` +
    `♾️ Lifetime: <b>$${p.lifetime_price}</b>\n` +
    `💱 Currency: <b>${p.currency || 'USD'}</b>\n` +
    `👤 Admin Username: <b>${p.admin_username || '(not set)'}</b>\n` +
    `📝 Payment Note: <b>${p.payment_note || '(not set)'}</b>\n\n` +
    `<i>To update, tap a button below:</i>`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('📅 Daily Price',    'pay_edit_daily'),
      Markup.button.callback('📆 Weekly Price',   'pay_edit_weekly'),
    ],
    [
      Markup.button.callback('🗓 Monthly Price',  'pay_edit_monthly'),
      Markup.button.callback('♾️ Lifetime Price', 'pay_edit_lifetime'),
    ],
    [
      Markup.button.callback('👤 Admin Username', 'pay_edit_admin_username'),
      Markup.button.callback('📝 Payment Note',   'pay_edit_payment_note'),
    ],
    [Markup.button.callback('🔙 Back', 'adm_panel')],
  ]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

async function promptPaymentEdit(ctx, field) {
  await ctx.answerCbQuery().catch(() => {});
  const labels = {
    daily:          'Daily Price',
    weekly:         'Weekly Price',
    monthly:        'Monthly Price',
    lifetime:       'Lifetime Price',
    admin_username: 'Admin Telegram Username (e.g. @admin)',
    payment_note:   'Payment Note (instructions for users)',
  };
  editSessions[ctx.from.id] = { context: 'payment', field };
  await ctx.reply(
    `✏️ Enter new value for <b>${labels[field] || field}</b>:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'adm_payment')]]),
    }
  );
}

// ─── HELP SETTINGS ────────────────────────────────────────────────────────────

async function handleAdminHelpSettings(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const h = db.help.get();
  const msg =
    `ℹ️ <b>Help Settings</b>\n\n` +
    `👤 Support Username: <b>${h.support_username || '(not set)'}</b>\n` +
    `📨 Telegram Username: <b>${h.telegram_username || '(not set)'}</b>\n` +
    `📄 Help Message:\n<i>${(h.help_message || '(not set)').slice(0, 400)}</i>\n\n` +
    `<i>Tap a button to edit:</i>`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('👤 Support Username',   'help_edit_support_username'),
      Markup.button.callback('📨 Telegram Username',  'help_edit_telegram_username'),
    ],
    [Markup.button.callback('📄 Help Message',        'help_edit_help_message')],
    [Markup.button.callback('🔙 Back',                'adm_panel')],
  ]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

async function promptHelpEdit(ctx, field) {
  await ctx.answerCbQuery().catch(() => {});
  const labels = {
    support_username:  'Support Telegram Username (e.g. @support)',
    telegram_username: 'Telegram Username (shown in /help)',
    help_message:      'Full help message text (HTML supported)',
  };
  editSessions[ctx.from.id] = { context: 'help', field };
  await ctx.reply(
    `✏️ Enter new value for <b>${labels[field] || field}</b>:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'adm_help_settings')]]),
    }
  );
}

// ─── HANDLE EDIT INPUT (payment/help settings) ─────────────────────────────────

async function handleEditInput(ctx) {
  const uid     = ctx.from.id;
  const session = editSessions[uid];
  if (!session) return false;

  const text  = ctx.message?.text?.trim() || '';
  const { context, field } = session;
  delete editSessions[uid];

  if (context === 'payment') {
    const numFields = ['daily', 'weekly', 'monthly', 'lifetime'];
    const key = field === 'daily'    ? 'daily_price'
              : field === 'weekly'   ? 'weekly_price'
              : field === 'monthly'  ? 'monthly_price'
              : field === 'lifetime' ? 'lifetime_price'
              : field;

    let value = text;
    if (numFields.includes(field)) {
      value = parseFloat(text);
      if (isNaN(value) || value <= 0) {
        await ctx.reply('❌ Invalid price. Enter a positive number (e.g. 9.99).');
        return true;
      }
    }

    await db.payment.update({ [key]: value });
    logger.info(`[PAYMENT-UPDATE] Admin updated payment.${key} = ${value}`);
    await ctx.reply(`✅ <b>${key}</b> updated to <code>${value}</code>`, { parse_mode: 'HTML' });
  } else if (context === 'help') {
    await db.help.update({ [field]: text });
    logger.info(`[HELP-UPDATE] Admin updated help.${field}`);
    await ctx.reply(`✅ <b>${field}</b> updated.`, { parse_mode: 'HTML' });
  }

  return true;
}

// ─── LOGS ─────────────────────────────────────────────────────────────────────

async function handleAdminLogs(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const logger = require('./logger');
  const lines  = logger.recentLines(50).join('\n').slice(-4000) || 'No logs yet.';
  const msg    = `📋 <b>Recent Logs (last 50)</b>\n\n<pre>${lines}</pre>`;
  const kb     = Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'adm_panel')]]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

// ─── BROADCAST MENU ───────────────────────────────────────────────────────────

async function showBroadcastMenu(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const msg = `📢 <b>Broadcast System</b>\n\nSend a message to all or selected users.\n\nSelect content type:`;
  const kb  = Markup.inlineKeyboard([
    [Markup.button.callback('✉️ Text',       'bc_type_text'),
     Markup.button.callback('🖼 Photo',      'bc_type_photo')],
    [Markup.button.callback('🎬 Video',      'bc_type_video'),
     Markup.button.callback('🎞 GIF',        'bc_type_animation')],
    [Markup.button.callback('🎤 Voice',      'bc_type_voice'),
     Markup.button.callback('📄 Document',   'bc_type_document')],
    [Markup.button.callback('🎵 Audio',      'bc_type_audio'),
     Markup.button.callback('📹 VideoNote',  'bc_type_videonote')],
    [Markup.button.callback('🔙 Back',       'adm_panel')],
  ]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

async function startBroadcast(ctx, type) {
  await ctx.answerCbQuery().catch(() => {});
  const uid  = ctx.from.id;
  broadcastSessions[uid] = { step: 'content', type };

  const typeLabel = {
    text: 'text message', photo: 'photo', video: 'video', animation: 'GIF/animation',
    voice: 'voice message', document: 'document', audio: 'audio', videonote: 'video note',
  };

  await ctx.reply(
    `📢 Send your <b>${typeLabel[type] || type}</b> now:\n\n<i>Or type /cancel to abort.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'bc_cancel')]]),
    }
  );
}

async function handleBroadcastContent(ctx, bot) {
  const uid     = ctx.from.id;
  const session = broadcastSessions[uid];
  if (!session || session.step !== 'content') return;

  const msg = ctx.message;
  let content = {};

  if (session.type === 'text') {
    content.text = msg.text;
  } else if (session.type === 'photo') {
    const ph = msg.photo?.at(-1);
    if (!ph) return ctx.reply('Please send a photo.');
    content = { file_id: ph.file_id, caption: msg.caption || '' };
  } else if (session.type === 'video') {
    if (!msg.video) return ctx.reply('Please send a video.');
    content = { file_id: msg.video.file_id, caption: msg.caption || '' };
  } else if (session.type === 'animation') {
    if (!msg.animation) return ctx.reply('Please send a GIF/animation.');
    content = { file_id: msg.animation.file_id, caption: msg.caption || '' };
  } else if (session.type === 'voice') {
    if (!msg.voice) return ctx.reply('Please send a voice message.');
    content = { file_id: msg.voice.file_id };
  } else if (session.type === 'document') {
    if (!msg.document) return ctx.reply('Please send a document.');
    content = { file_id: msg.document.file_id, caption: msg.caption || '' };
  } else if (session.type === 'audio') {
    if (!msg.audio) return ctx.reply('Please send an audio file.');
    content = { file_id: msg.audio.file_id, caption: msg.caption || '' };
  } else if (session.type === 'videonote') {
    if (!msg.video_note) return ctx.reply('Please send a video note.');
    content = { file_id: msg.video_note.file_id };
  }

  broadcastSessions[uid] = { ...session, step: 'target', content };

  await ctx.reply(
    `📢 <b>Select Target Audience:</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👥 All Users',     'bc_target_all')],
        [Markup.button.callback('💎 Premium Users', 'bc_target_premium')],
        [Markup.button.callback('🆓 Free Users',    'bc_target_free')],
        [Markup.button.callback('❌ Cancel',         'bc_cancel')],
      ]),
    }
  );
}

async function selectBroadcastTarget(ctx, target) {
  await ctx.answerCbQuery().catch(() => {});
  const uid     = ctx.from.id;
  const session = broadcastSessions[uid];
  if (!session) return;
  broadcastSessions[uid] = { ...session, step: 'pin', target };

  await ctx.editMessageText(
    `📌 <b>Pin Broadcast?</b>\n\nPin the message for each user?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📌 Yes — Pin It', 'bc_pin_yes'),
         Markup.button.callback('▶️ No — Just Send', 'bc_pin_no')],
        [Markup.button.callback('❌ Cancel', 'bc_cancel')],
      ]),
    }
  );
}

async function executeBroadcast(ctx, pin, bot) {
  await ctx.answerCbQuery().catch(() => {});
  const uid     = ctx.from.id;
  const session = broadcastSessions[uid];
  delete broadcastSessions[uid];
  if (!session) return;

  const { type, content, target } = session;

  let users = db.users.getAll().filter((u) => !u.banned);
    if (target === 'premium') users = users.filter((u) => db.subscriptions.isActive(u));
    if (target === 'free')    users = users.filter((u) => !db.subscriptions.isActive(u));

  let sent = 0, failed = 0;

  const statusMsg = await ctx.reply(
    `📢 <b>Broadcasting...</b>\n\nTarget: ${users.length} users`,
    { parse_mode: 'HTML' }
  );

  for (const u of users) {
    try {
      let msg = null;
      const opts = { parse_mode: 'HTML' };

      if (type === 'text') {
        msg = await bot.telegram.sendMessage(u.telegram_id, content.text, opts);
      } else if (type === 'photo') {
        msg = await bot.telegram.sendPhoto(u.telegram_id, content.file_id, { caption: content.caption, ...opts });
      } else if (type === 'video') {
        msg = await bot.telegram.sendVideo(u.telegram_id, content.file_id, { caption: content.caption, ...opts });
      } else if (type === 'animation') {
        msg = await bot.telegram.sendAnimation(u.telegram_id, content.file_id, { caption: content.caption, ...opts });
      } else if (type === 'voice') {
        msg = await bot.telegram.sendVoice(u.telegram_id, content.file_id, opts);
      } else if (type === 'document') {
        msg = await bot.telegram.sendDocument(u.telegram_id, content.file_id, { caption: content.caption, ...opts });
      } else if (type === 'audio') {
        msg = await bot.telegram.sendAudio(u.telegram_id, content.file_id, { caption: content.caption, ...opts });
      } else if (type === 'videonote') {
        msg = await bot.telegram.sendVideoNote(u.telegram_id, content.file_id, opts);
      }

      if (msg && pin) {
        try { await bot.telegram.pinChatMessage(u.telegram_id, msg.message_id); } catch {}
      }
      sent++;
    } catch { failed++; }

    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    await bot.telegram.editMessageText(
      ctx.from.id, statusMsg.message_id, null,
      `📢 <b>Broadcast Complete</b>\n\n` +
      `✅ Sent: ${sent}\n❌ Failed: ${failed}\n👥 Total: ${users.length}\n📌 Pinned: ${pin ? 'Yes' : 'No'}`,
      { parse_mode: 'HTML' }
    );
  } catch {
    await ctx.reply(`📢 Broadcast done. Sent: ${sent}  Failed: ${failed}`, { parse_mode: 'HTML' });
  }
}

// ─── CHANNEL SETTINGS ────────────────────────────────────────────────────────

async function showChannelMenu(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const cfg = db.channel.get();
  const msg =
    `📡 <b>Channel Settings</b>\n\n` +
    `Channel: <b>${cfg.channel_id || 'Not set'}</b>\n` +
    `Signals: <b>${cfg.enabled ? '🟢 Enabled' : '🔴 Disabled'}</b>\n\n` +
    `To set the channel, send: <code>set channel @yourchannel</code>`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Enable Signals',  'ch_enable'),
      Markup.button.callback('❌ Disable Signals', 'ch_disable'),
    ],
    [Markup.button.callback('🔬 Test Channel',  'ch_test')],
    [Markup.button.callback('🔙 Back',          'adm_panel')],
  ]);
  try {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
  }
}

async function handleChannelEnable(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const cfg = db.channel.get();
  if (!cfg.channel_id) {
    return ctx.answerCbQuery('Set a channel first: send  set channel @id', { show_alert: true });
  }
  await db.channel.update({ enabled: true });
  await ctx.reply('✅ Channel signals enabled.', { parse_mode: 'HTML' });
  await showChannelMenu(ctx);
}

async function handleChannelDisable(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await db.channel.update({ enabled: false });
  await ctx.reply('🔴 Channel signals disabled.', { parse_mode: 'HTML' });
  await showChannelMenu(ctx);
}

async function handleChannelTest(ctx) {
  await ctx.answerCbQuery('Testing channel...').catch(() => {});
  const cfg = db.channel.get();
  if (!cfg.channel_id) {
    return ctx.reply('⚠️ No channel configured. Send: <code>set channel @yourchannel</code>', { parse_mode: 'HTML' });
  }

  const result = await verifyChannelPermissions(cfg.channel_id);
  if (result.ok) {
    await ctx.reply(
      `✅ <b>Channel OK</b>\n\nName: ${result.chatTitle}\nBot status: ${result.status}\nCan post: Yes`,
      { parse_mode: 'HTML' }
    );
    try {
      const { botRef } = require('./channel');
      await ctx.reply(`🟢 Test passed. Bot can post to: <b>${result.chatTitle}</b>`, { parse_mode: 'HTML' });
    } catch {}
  } else {
    await ctx.reply(`❌ <b>Channel Test Failed</b>\n\nError: ${result.error}`, { parse_mode: 'HTML' });
  }
}

// ─── USER ACTIONS ─────────────────────────────────────────────────────────────

async function promptAction(ctx, action) {
  await ctx.answerCbQuery().catch(() => {});
  actionSessions[ctx.from.id] = { action };
  const labels = {
    ban: 'ban',  unban: 'unban', delete: 'delete', grant: 'grant subscription to',
  };
  await ctx.reply(
    `Enter the Telegram ID or @username to <b>${labels[action] || action}</b>:` +
    (action === 'grant' ? `\n\nThen include duration: <code>DAILY</code>, <code>WEEKLY</code>, <code>MONTHLY</code>, or <code>LIFETIME</code>.\nExample: <code>123456 MONTHLY</code>` : ''),
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'adm_panel')]]),
    }
  );
}

async function handleActionInput(ctx, bot) {
  const uid     = ctx.from.id;
  const session = actionSessions[uid];
  if (!session) return;

  const text   = ctx.message?.text?.trim() || '';
  const action = session.action;

  if (action === 'grant') {
    const parts  = text.split(/\s+/);
    const target = parts[0];
    const plan   = (parts[1] || '').toUpperCase();

    let user = db.users.findById(target) || db.users.findByUsername(target.replace('@', ''));
    if (!user) { delete actionSessions[uid]; return ctx.reply('❌ User not found.'); }

    if (!plan) {
      actionSessions[uid] = { action: 'grant_duration', userId: user.telegram_id };
      return ctx.reply('Select subscription duration:', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('DAILY', 'adm_grant_duration_DAILY'), Markup.button.callback('WEEKLY', 'adm_grant_duration_WEEKLY')],
          [Markup.button.callback('MONTHLY', 'adm_grant_duration_MONTHLY'), Markup.button.callback('LIFETIME', 'adm_grant_duration_LIFETIME')],
          [Markup.button.callback('❌ Cancel', 'adm_panel')],
        ]),
      });
    }
    if (!(plan in SUB_DAYS)) { delete actionSessions[uid]; return ctx.reply('❌ Duration must be DAILY, WEEKLY, MONTHLY, or LIFETIME.'); }
    const record = await grantSubscription(user, plan);
    delete actionSessions[uid];
    logger.info(`[ADMIN-SUBSCRIPTION] Granted ${plan} to user:${user.telegram_id}`, { expires_at: record.expires_at });
    await ctx.reply(`✅ Granted <b>${plan}</b> plan to <code>${user.telegram_id}</code>`, { parse_mode: 'HTML' });

    try {
       const planLabels = { DAILY: '1 day', WEEKLY: '7 days', MONTHLY: '30 days', LIFETIME: 'Lifetime' };
      await bot.telegram.sendMessage(
        user.telegram_id,
         `🎉 <b>Subscription Activated!</b>\n\nPlan: <b>${plan}</b> (${planLabels[plan] || plan})\nAuto trading is now available.\n\nWelcome to the bot!`,
        { parse_mode: 'HTML' }
      );
    } catch {}
    return;
  }

  let user = db.users.findById(text) || db.users.findByUsername(text.replace('@', ''));
  if (!user) { delete actionSessions[uid]; return ctx.reply('❌ User not found.'); }

  if (action === 'ban') {
    await db.users.update(user.telegram_id, { banned: true, auto_trading: false });
    await ctx.reply(`🚫 User <code>${user.telegram_id}</code> banned.`, { parse_mode: 'HTML' });
  } else if (action === 'unban') {
    await db.users.update(user.telegram_id, { banned: false });
    await ctx.reply(`✅ User <code>${user.telegram_id}</code> unbanned.`, { parse_mode: 'HTML' });
  } else if (action === 'delete') {
    await db.users.delete(user.telegram_id);
    await ctx.reply(`🗑 User <code>${user.telegram_id}</code> deleted.`, { parse_mode: 'HTML' });
  }

  delete actionSessions[uid];
}

async function handleGrantDuration(ctx, type, bot) {
  await ctx.answerCbQuery().catch(() => {});
  const session = actionSessions[ctx.from.id];
  if (!session || session.action !== 'grant_duration') return;
  const user = db.users.findById(session.userId);
  delete actionSessions[ctx.from.id];
  if (!user) return ctx.reply('❌ User not found.');
  const record = await grantSubscription(user, type);
  await ctx.reply(`✅ Granted <b>${type}</b> to <code>${user.telegram_id}</code>\nExpires: <code>${record.expires_at || 'Never'}</code>`, { parse_mode: 'HTML' });
  try {
    await bot.telegram.sendMessage(user.telegram_id, `🎉 Subscription activated: <b>${type}</b>`, { parse_mode: 'HTML' });
  } catch {}
}

async function handleSubscriptionCommand(ctx) {
  const text = ctx.message?.text?.trim() || '';
  const m = text.match(/^(grant|extend|revoke|subscription)\s+(\S+)(?:\s+(\S+))?$/i);
  if (!m) return false;
  const user = db.users.findById(m[2]) || db.users.findByUsername(m[2].replace('@', ''));
  if (!user) return ctx.reply('❌ User not found.');
  const action = m[1].toLowerCase();
  if (action === 'revoke') {
    await revokeSubscription(user);
    return ctx.reply(`✅ Subscription revoked for <code>${user.telegram_id}</code>.`, { parse_mode: 'HTML' });
  }
  if (action === 'subscription') {
    const s = db.subscriptions.current(user.telegram_id);
    return ctx.reply(`📋 ${user.telegram_id}: ${s?.status || 'NONE'} ${s?.subscription_type || ''} expires ${s?.expires_at || 'never'}`);
  }
  await grantSubscription(user, (m[3] || 'MONTHLY').toUpperCase(), action === 'extend');
  return ctx.reply(`✅ ${action}ed ${(m[3] || 'MONTHLY').toUpperCase()} subscription for <code>${user.telegram_id}</code>.`, { parse_mode: 'HTML' });
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────

async function handleExport(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const data = {
      users:    db.users.getAll(),
      trades:   db.trades.getAll(),
      signals:  db.signals.getAll(),
      settings: db.settings.get(),
      payment:  db.payment.get(),
      help:     db.help.get(),
      exported: new Date().toISOString(),
    };
    const json = JSON.stringify(data, null, 2);
    const buf  = Buffer.from(json, 'utf8');
    await ctx.replyWithDocument(
      { source: buf, filename: `bot_export_${Date.now()}.json` },
      { caption: '📥 Full database export' }
    );
  } catch (err) {
    await ctx.reply('❌ Export failed: ' + err.message);
  }
}

// ─── RESTART ─────────────────────────────────────────────────────────────────

async function handleRestart(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('🔄 Restarting bot process...', { parse_mode: 'HTML' });
  logger.info('Admin requested restart');
  setTimeout(() => process.exit(0), 1000);
}

// ─── CHANNEL COMMAND HANDLER ─────────────────────────────────────────────────

async function handleChannelCommand(ctx) {
  const text = ctx.message?.text?.trim() || '';
  const m    = text.match(/^set\s+channel\s+(.+)$/i);
  if (!m) return false;
  const channelId = m[1].trim();
  await db.channel.update({ channel_id: channelId });
  await ctx.reply(
    `📡 Channel set to: <code>${channelId}</code>\n\nUse "Test Channel" to verify bot permissions.`,
    { parse_mode: 'HTML' }
  );
  return true;
}


// ─── BOT STATUS (/status admin command) ──────────────────────────────────────
async function handleAdminStatus(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Unauthorized.');
  await ctx.answerCbQuery?.().catch(() => {});

  const uptime    = process.uptime();
  const uptimeStr = (() => {
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);
    return `${h}h ${m}m ${s}s`;
  })();

  const mem       = process.memoryUsage();
  const memMB     = (mem.rss / 1024 / 1024).toFixed(1);
  const heapMB    = (mem.heapUsed / 1024 / 1024).toFixed(1);

  const allUsers  = db.users.getAll();
  const openTrades = db.trades.countOpen();
  const totalUsers = allUsers.length;
  const apiUsers   = allUsers.filter((u) => u.api_key).length;

  // Cooldown keys currently active
  const cooldownStore = db.cooldown.getAll();
  const now           = Date.now();
  const ttl           = 4 * 60 * 60 * 1000;
  const activeCooldowns = Object.entries(cooldownStore)
    .filter(([, ts]) => now - ts < ttl);

  // Last sync times — show the 5 most-recently synced users
  const recentSyncs = allUsers
    .filter((u) => u.last_binance_sync)
    .sort((a, b) => new Date(b.last_binance_sync) - new Date(a.last_binance_sync))
    .slice(0, 5)
    .map((u) => {
      const ago = Math.round((now - new Date(u.last_binance_sync).getTime()) / 1000);
      const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago/60)}m ago` : `${Math.round(ago/3600)}h ago`;
      return `  • <code>${String(u.telegram_id).slice(0,6)}…</code> [${(u.market_type||'spot').toUpperCase()}] ${agoStr}`;
    });

  let msg =
    `🤖 <b>Bot Status</b>\n\n` +
    `⏱ Uptime: <b>${uptimeStr}</b>\n` +
    `🧠 RAM: <b>${memMB} MB</b>  (heap ${heapMB} MB)\n\n` +
    `👥 Users: <b>${totalUsers}</b>  (API connected: ${apiUsers})\n` +
    `🔓 Open Trades: <b>${openTrades}</b>\n` +
    `⏳ Active Cooldowns: <b>${activeCooldowns.length}</b>\n`;

  if (activeCooldowns.length) {
    msg += activeCooldowns.slice(0, 5).map(([k]) => `  • ${k}`).join('\n') + '\n';
  }

  msg += `\n🔄 <b>Recent Syncs:</b>\n`;
  msg += recentSyncs.length
    ? recentSyncs.join('\n')
    : '  None yet';

  msg += `\n\n⏰ ${new Date().toUTCString()}`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'adm_status')],
    [Markup.button.callback('🔙 Admin Panel', 'adm_panel')],
  ]);

  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

module.exports = {
  handleSetMaxTrades,
  handleMaintenanceToggle,
  isAdmin,
  showAdminPanel,
  handleAdminUsers,
  handleAdminTrades,
  handleAdminStats,
  handleAdminRevenue,
  handleAdminSettings,
  handleAdminLogs,
  handleAdminPayment,
  handleAdminHelpSettings,
  promptPaymentEdit,
  promptHelpEdit,
  handleEditInput,
  handleSettingCommand,
  handleChannelCommand,
  showBroadcastMenu,
  startBroadcast,
  handleBroadcastContent,
  selectBroadcastTarget,
  executeBroadcast,
  showChannelMenu,
  handleChannelEnable,
  handleChannelDisable,
  handleChannelTest,
  promptAction,
  handleActionInput,
  handleExport,
  handleAdminStatus,
  handleSubscriptionCommand,
  handleGrantDuration,
  grantSubscription,
  revokeSubscription,
  handleRestart,
  broadcastSessions,
  actionSessions,
  editSessions,
};
