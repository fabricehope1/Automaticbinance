const { Telegraf, Markup } = require('telegraf');
const { BinanceSpotClient, BinanceFuturesClient } = require('./binance');
const {
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
} = require('./dashboard');
const {
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
  handleRestart,
  broadcastSessions,
  actionSessions,
  editSessions,
  handleSetMaxTrades,
  handleMaintenanceToggle,
  handleSubscriptionCommand,
  handleGrantDuration,
} = require('./admin');
const { applyReferral, buildReferralPage, getOrCreateCode } = require('./referral');
const {
  closeTrade,
  partialCloseTrade,
  moveStopLoss,
  moveTakeProfit,
  setBreakEven,
  setTrailingStop,
  syncUserFromBinance,
  clearUserAccountData,
} = require('./trading');
const db     = require('./database');
const logger = require('./logger');
const { config } = require('./config');

// ─── API SETUP SESSIONS ──────────────────────────────────────────────────────
const setupSessions = {};

// ─── TRADE ACTION SESSIONS (for SL/TP input) ─────────────────────────────────
const tradeActionSessions = {};

// ─── WELCOME TEXT ─────────────────────────────────────────────────────────────

function buildWelcome(user) {
  const name   = user?.first_name || user?.username || 'Trader';
  const total  = db.users.count();
  const sigs   = db.signals.count();
  const trades = db.trades.count();
  return (
    `┌──────────────────────────────┐\n` +
    `│  🤖  <b>AI CRYPTO TRADING BOT</b>   │\n` +
    `└──────────────────────────────┘\n\n` +
    `👋 Welcome, <b>${name}</b>!\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🧠 <b>SMC + ICT Professional Strategy</b>\n` +
    `📡 <b>All Binance Pairs — 60s Scans</b>\n` +
    `⭐ <b>Confidence Scoring 0-100</b>\n` +
    `🛡 <b>Adaptive Recovery Mode</b>\n` +
    `🔄 <b>Real-Time Live Updates (25s)</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Platform Stats</b>\n` +
    `👥 Users: <b>${total}</b>  📡 Signals: <b>${sigs}</b>  💹 Trades: <b>${trades}</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 <b>Strategy:</b>\n` +
    `• 4H/1H Trend • BOS & CHOCH\n` +
    `• Order Blocks • Fair Value Gaps\n` +
    `• Liquidity Sweeps • RSI • Volume • ATR\n\n` +
    `🎯 Only <b>2-5 premium signals/day</b> — quality over quantity.`
  );
}

// ─── CREATE BOT ──────────────────────────────────────────────────────────────

function createBot() {
  const bot = new Telegraf(config.bot.token);

  // ─── /START ───────────────────────────────────────────────────────────────

  bot.start(async (ctx) => {
    try {
      const from    = ctx.from;
      const payload = ctx.startPayload || '';
      const isNew   = !db.users.findById(from.id);

      let user = db.users.findById(from.id);
      if (!user) {
        user = await db.users.create({
          telegram_id: from.id,
          username:    from.username   || '',
          first_name:  from.first_name || '',
        });
        logger.info(`New user: ${from.id} @${from.username}`);
      }

      const settings = db.settings.get();
      if (settings.maintenance && !isAdmin(ctx)) {
        return ctx.reply('🔧 Bot is under maintenance. Please try again later.');
      }

      if (isAdmin(ctx)) return showAdminPanel(ctx);

      if (isNew && payload && payload.startsWith('REF')) {
        setImmediate(() => applyReferral(from.id, payload, bot).catch(() => {}));
      }

      const kb = buildMainMenu(user);

      try {
        await ctx.replyWithPhoto(
          { url: 'https://i.imgur.com/7sMJBgJ.png' },
          { caption: buildWelcome(user), parse_mode: 'HTML', ...kb }
        );
      } catch {
        await ctx.reply(buildWelcome(user), { parse_mode: 'HTML', ...kb });
      }
    } catch (err) {
      logger.error('/start error', { err: err.message });
    }
  });

  // ─── ADMIN INLINE ────────────────────────────────────────────────────────

  bot.action('adm_panel',           (ctx) => showAdminPanel(ctx, true));
  bot.action('adm_users',           handleAdminUsers);
  bot.action('adm_trades',          handleAdminTrades);
  bot.action('adm_stats',           handleAdminStats);
  bot.action('adm_revenue',         handleAdminRevenue);
  bot.action('adm_settings',        handleAdminSettings);
  bot.action(/^adm_set_max_trades_(\d+)$/, (ctx) => handleSetMaxTrades(ctx, parseInt(ctx.match[1], 10)));
  bot.action('adm_maint_on',        (ctx) => handleMaintenanceToggle(ctx, true));
  bot.action('adm_maint_off',       (ctx) => handleMaintenanceToggle(ctx, false));
  bot.action('adm_logs',            handleAdminLogs);
  bot.action('adm_export',          handleExport);
  bot.action('adm_restart',         handleRestart);
  bot.action('adm_status',          handleAdminStatus);
  bot.command('status', (ctx) => isAdmin(ctx) ? handleAdminStatus(ctx) : undefined);

  bot.action('adm_broadcast_menu',  showBroadcastMenu);
  bot.action(/^bc_type_(\w+)$/,     (ctx) => startBroadcast(ctx, ctx.match[1]));
  bot.action(/^bc_target_(\w+)$/,   (ctx) => selectBroadcastTarget(ctx, ctx.match[1]));
  bot.action('bc_pin_yes',          (ctx) => executeBroadcast(ctx, true,  bot));
  bot.action('bc_pin_no',           (ctx) => executeBroadcast(ctx, false, bot));
  bot.action('bc_cancel',           async (ctx) => {
    delete broadcastSessions[ctx.from.id];
    await ctx.answerCbQuery('Cancelled');
    await showAdminPanel(ctx, true);
  });

  bot.action('adm_channel_menu',    showChannelMenu);
  bot.action('ch_enable',           handleChannelEnable);
  bot.action('ch_disable',          handleChannelDisable);
  bot.action('ch_test',             handleChannelTest);

  bot.action('adm_ban',    (ctx) => promptAction(ctx, 'ban'));
  bot.action('adm_unban',  (ctx) => promptAction(ctx, 'unban'));
  bot.action('adm_delete', (ctx) => promptAction(ctx, 'delete'));
  bot.action('adm_grant',  (ctx) => promptAction(ctx, 'grant'));
  bot.action(/^adm_grant_duration_(DAILY|WEEKLY|MONTHLY|LIFETIME)$/, (ctx) => handleGrantDuration(ctx, ctx.match[1], bot));

  // ─── PAYMENT SETTINGS ─────────────────────────────────────────────────────
  bot.action('adm_payment',                handleAdminPayment);
  bot.action(/^pay_edit_(\w+)$/,           (ctx) => promptPaymentEdit(ctx, ctx.match[1]));

  // ─── HELP SETTINGS ────────────────────────────────────────────────────────
  bot.action('adm_help_settings',          handleAdminHelpSettings);
  bot.action(/^help_edit_(\w+)$/,          (ctx) => promptHelpEdit(ctx, ctx.match[1]));

  // ─── USER INLINE ──────────────────────────────────────────────────────────

  bot.action('dashboard', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = db.users.findById(ctx.from.id);
    if (!user) return ctx.reply('Use /start first.');
    await showDashboard(ctx, user, true);
  });

  bot.action('trading_on',    handleAutoTradingOn);
  bot.action('trading_off',   handleAutoTradingOff);
  bot.action('balance',       handleBalance);
  bot.action('active_trades', handleActiveTrades);
  bot.action('trade_history', handleTradeHistory);
  bot.action('statistics',    handleStatistics);
  bot.action('user_settings', handleUserSettings);

  // Sync Binance manually
  bot.action('sync_binance', async (ctx) => {
    await ctx.answerCbQuery('Syncing...').catch(() => {});
    const user = db.users.findById(ctx.from.id);
    if (!user || !user.api_key) return ctx.answerCbQuery('No API connected.', { show_alert: true });
    try {
      const result = await syncUserFromBinance(user);
      const fresh  = db.users.findById(ctx.from.id);
      await ctx.answerCbQuery(
        result
          ? `✅ Synced! ${result.positions} position(s)`
          : '✅ Sync complete',
        { show_alert: true }
      ).catch(() => {});
      await showDashboard(ctx, fresh, true);
    } catch (err) {
      await ctx.answerCbQuery('❌ Sync failed: ' + err.message, { show_alert: true }).catch(() => {});
    }
  });

  // ─── CLOSE TRADE (100%) ──────────────────────────────────────────────────

  bot.action(/^close_trade_(.+)$/, async (ctx) => {
    const tradeId = ctx.match[1];
    await handleCloseTradeAction(ctx, tradeId, bot);
  });

  // ─── MANAGE TRADE ────────────────────────────────────────────────────────

  bot.action(/^manage_trade_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const tradeId = ctx.match[1];
    const user    = db.users.findById(ctx.from.id);
    if (!user) return ctx.reply('Use /start first.');
    const trade   = db.trades.findById(tradeId);
    if (!trade || String(trade.user_id) !== String(user.telegram_id))
      return ctx.answerCbQuery('Not your trade.', { show_alert: true });
    await showTradeManagement(ctx, tradeId);
  });

  // ─── PARTIAL CLOSE ────────────────────────────────────────────────────────

  bot.action(/^partial_close_(.+)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Closing partial...').catch(() => {});
    const tradeId     = ctx.match[1];
    const pct         = parseInt(ctx.match[2]);
    const user        = db.users.findById(ctx.from.id);
    if (!user) return ctx.reply('Use /start first.');
    const trade       = db.trades.findById(tradeId);
    if (!trade || trade.status !== 'open' || String(trade.user_id) !== String(user.telegram_id))
      return ctx.answerCbQuery('Trade not found.', { show_alert: true });

    const result = await partialCloseTrade(user, trade, pct);
    if (!result.success) {
      return ctx.reply('❌ Partial close failed: ' + (result.error || result.reason));
    }

    const msg =
      `⚡ <b>Partial Close (${pct}%)</b>\n\n` +
      `📌 ${trade.side} <b>${trade.symbol}</b>\n` +
      `📦 Closed: <code>${result.closedQty}</code> units\n` +
      `📦 Remaining: <code>${result.remainingQty}</code> units\n` +
      `📤 Close Price: <code>${result.closePrice?.toFixed(8)}</code>\n` +
      `💰 PNL: <b>${result.profit >= 0 ? '+' : ''}${result.profit?.toFixed(4)} USDT</b>`;

    try { await ctx.editMessageText(msg, { parse_mode: 'HTML' }); }
    catch { await ctx.reply(msg, { parse_mode: 'HTML' }); }
  });

  // ─── MOVE STOP LOSS ──────────────────────────────────────────────────────

  bot.action(/^move_sl_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const tradeId = ctx.match[1];
    const user    = db.users.findById(ctx.from.id);
    if (!user) return;
    const trade   = db.trades.findById(tradeId);
    if (!trade || trade.status !== 'open' || String(trade.user_id) !== String(user.telegram_id))
      return ctx.answerCbQuery('Trade not found.', { show_alert: true });

    tradeActionSessions[ctx.from.id] = { action: 'move_sl', tradeId };
    await ctx.reply(
      `🛡 <b>Move Stop Loss</b>\n\n` +
      `Current SL: <code>${trade.sl || 'N/A'}</code>\n` +
      `Current Price: <code>${trade.current_price || trade.entry}</code>\n\n` +
      `Enter new Stop Loss price:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `manage_trade_${tradeId}`)]]),
      }
    );
  });

  // ─── MOVE TAKE PROFIT ────────────────────────────────────────────────────

  bot.action(/^move_tp_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const tradeId = ctx.match[1];
    const user    = db.users.findById(ctx.from.id);
    if (!user) return;
    const trade   = db.trades.findById(tradeId);
    if (!trade || trade.status !== 'open' || String(trade.user_id) !== String(user.telegram_id))
      return ctx.answerCbQuery('Trade not found.', { show_alert: true });

    tradeActionSessions[ctx.from.id] = { action: 'move_tp', tradeId };
    await ctx.reply(
      `🎯 <b>Move Take Profit</b>\n\n` +
      `Current TP: <code>${trade.tp || 'N/A'}</code>\n` +
      `Current Price: <code>${trade.current_price || trade.entry}</code>\n\n` +
      `Enter new Take Profit price:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `manage_trade_${tradeId}`)]]),
      }
    );
  });

  // ─── BREAK EVEN ──────────────────────────────────────────────────────────

  bot.action(/^break_even_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Setting break even...').catch(() => {});
    const tradeId = ctx.match[1];
    const user    = db.users.findById(ctx.from.id);
    if (!user) return;
    const trade   = db.trades.findById(tradeId);
    if (!trade || trade.status !== 'open' || String(trade.user_id) !== String(user.telegram_id))
      return ctx.answerCbQuery('Trade not found.', { show_alert: true });

    const result = await setBreakEven(user, trade);
    if (result.success) {
      await ctx.answerCbQuery('✅ Stop Loss moved to entry (Break Even)', { show_alert: true }).catch(() => {});
      const msg =
        `⚖️ <b>Break Even Set</b>\n\n` +
        `📌 ${trade.side} <b>${trade.symbol}</b>\n` +
        `🛡 SL moved to entry: <code>${trade.entry}</code>\n` +
        `Trade is now risk-free.`;
      try { await ctx.editMessageText(msg, { parse_mode: 'HTML' }); }
      catch { await ctx.reply(msg, { parse_mode: 'HTML' }); }
    } else {
      await ctx.reply('❌ Break Even failed: ' + (result.error || result.reason));
    }
  });

  // ─── TRAILING STOP ────────────────────────────────────────────────────────

  bot.action(/^trailing_stop_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const tradeId = ctx.match[1];
    const user    = db.users.findById(ctx.from.id);
    if (!user) return;
    const trade   = db.trades.findById(tradeId);
    if (!trade || trade.status !== 'open' || String(trade.user_id) !== String(user.telegram_id))
      return ctx.answerCbQuery('Trade not found.', { show_alert: true });

    if (user.market_type !== 'futures') {
      return ctx.answerCbQuery('Trailing Stop is only supported for Futures trades.', { show_alert: true });
    }

    tradeActionSessions[ctx.from.id] = { action: 'trailing_stop', tradeId };
    await ctx.reply(
      `🔄 <b>Trailing Stop</b>\n\n` +
      `📌 ${trade.side} <b>${trade.symbol}</b>\n\n` +
      `Enter callback rate (e.g. <code>1.0</code> for 1%):\n` +
      `<i>Range: 0.1% – 5%</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `manage_trade_${tradeId}`)]]),
      }
    );
  });

  // ─── API CONNECT ─────────────────────────────────────────────────────────

  bot.action('change_api', (ctx) => { ctx.answerCbQuery().catch(() => {}); askMarketType(ctx); });

  bot.action(/^market_(spot|futures)(_testnet)?$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const marketType = ctx.match[1];
    const testnet    = !!ctx.match[2];
    setupSessions[ctx.from.id] = { step: 'api_key', marketType, testnet };
    const label = marketType === 'futures'
      ? `📊 Futures${testnet ? ' [Testnet]' : ''}`
      : `📈 Spot${testnet ? ' [Testnet]' : ''}`;
    await ctx.reply(
      `${label} selected.\n\n🔑 Enter your Binance <b>API Key</b>:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_setup')]]),
      }
    );
  });

  bot.action('cancel_setup', async (ctx) => {
    delete setupSessions[ctx.from.id];
    await ctx.answerCbQuery('Cancelled').catch(() => {});
    const user = db.users.findById(ctx.from.id);
    if (user) await showDashboard(ctx, user, true);
  });

  // ─── SUBSCRIPTION ─────────────────────────────────────────────────────────

  bot.action('subscription', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = db.users.findById(ctx.from.id);
    await showSubscription(ctx, user);
  });
  bot.action('copy_id', async (ctx) => {
    await ctx.answerCbQuery(`Your Telegram ID: ${ctx.from.id}`, { show_alert: true });
  });

  // ─── REFERRAL ─────────────────────────────────────────────────────────────

  bot.action('referral', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await showReferralPage(ctx, bot);
  });

  // ─── HELP ─────────────────────────────────────────────────────────────────

  bot.action('help', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await showHelp(ctx);
  });

  // ─── TEXT HANDLER ─────────────────────────────────────────────────────────

  bot.on('text', async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const text   = ctx.message?.text?.trim() || '';

    // Admin text routing
    if (isAdmin(ctx)) {
      if (broadcastSessions[userId]) { await handleBroadcastContent(ctx, bot); return; }
      if (actionSessions[userId])    { await handleActionInput(ctx, bot);       return; }
      if (editSessions[userId])      { await handleEditInput(ctx);              return; }
      if (await handleSubscriptionCommand(ctx)) return;
      if (await handleChannelCommand(ctx)) return;
      if (await handleSettingCommand(ctx)) return;
      if (text === '/admin' || text.toLowerCase() === 'admin') return showAdminPanel(ctx);
      return;
    }

    // Trade action sessions (SL / TP / trailing input)
    const tradeSession = tradeActionSessions[userId];
    if (tradeSession) {
      delete tradeActionSessions[userId];
      const user  = db.users.findById(userId);
      const trade = db.trades.findById(tradeSession.tradeId);

      if (!user || !trade || trade.status !== 'open') {
        return ctx.reply('❌ Trade no longer active.');
      }

      const value = parseFloat(text);
      if (isNaN(value) || value <= 0) {
        return ctx.reply('❌ Invalid value. Please enter a positive number.');
      }

      if (tradeSession.action === 'move_sl') {
        const result = await moveStopLoss(user, trade, value);
        if (result.success) {
          await ctx.reply(`✅ Stop Loss updated to <code>${value}</code>`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply('❌ Failed: ' + (result.error || result.reason));
        }
      } else if (tradeSession.action === 'move_tp') {
        const result = await moveTakeProfit(user, trade, value);
        if (result.success) {
          await ctx.reply(`✅ Take Profit updated to <code>${value}</code>`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply('❌ Failed: ' + (result.error || result.reason));
        }
      } else if (tradeSession.action === 'trailing_stop') {
        const rate = Math.min(Math.max(value, 0.1), 5.0);
        const result = await setTrailingStop(user, trade, rate);
        if (result.success) {
          await ctx.reply(`✅ Trailing Stop set at <b>${result.callbackRate}%</b> callback rate`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply('❌ Failed: ' + (result.error || result.reason));
        }
      }
      return;
    }

    // API setup flow
    const session = setupSessions[userId];
    if (session) {
      if (session.step === 'api_key') {
        setupSessions[userId] = { ...session, api_key: text, step: 'api_secret' };
        return ctx.reply(
          '✅ API Key saved.\n\n🔐 Now enter your Binance <b>Secret Key</b>:',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_setup')]]),
          }
        );
      }
      if (session.step === 'api_secret') {
        const { marketType, testnet, api_key } = session;
        delete setupSessions[userId];
        await ctx.reply('🔄 Verifying API credentials...');
        await verifyAndSave(ctx, userId, marketType, testnet, api_key, text, bot);
        return;
      }
    }
  });

  // ─── PHOTO / VIDEO / etc for broadcast ───────────────────────────────────

  bot.on(['photo', 'video', 'animation', 'voice', 'document', 'audio', 'video_note'], async (ctx) => {
    if (!isAdmin(ctx)) return;
    if (broadcastSessions[ctx.from.id]) await handleBroadcastContent(ctx, bot);
  });

  // ─── ERROR HANDLER ────────────────────────────────────────────────────────

  bot.catch((err, ctx) => {
    logger.error('Bot unhandled error', { err: err.message, update: ctx?.updateType });
  });

  return bot;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildMainMenu(user) {
  const rows = [
    [Markup.button.callback('📊 Dashboard', 'dashboard')],
    [
      Markup.button.callback('💰 Balance',       'balance'),
      Markup.button.callback('📈 Active Trades', 'active_trades'),
    ],
    [
      Markup.button.callback('📜 History',       'trade_history'),
      Markup.button.callback('📊 Statistics',    'statistics'),
    ],
    [
      Markup.button.callback('💳 Subscription',  'subscription'),
      Markup.button.callback('🎁 Referral',       'referral'),
    ],
    [Markup.button.callback('ℹ️ Help', 'help')],
  ];
  return Markup.inlineKeyboard(rows);
}

async function askMarketType(ctx) {
  await ctx.reply(
    '🔑 <b>Connect Binance</b>\n\nSelect your account type:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📈 Spot',           'market_spot'),
          Markup.button.callback('📊 Futures',         'market_futures'),
        ],
        [
          Markup.button.callback('🟡 Spot Testnet',    'market_spot_testnet'),
          Markup.button.callback('🟡 Futures Testnet', 'market_futures_testnet'),
        ],
        [Markup.button.callback('❌ Cancel', 'cancel_setup')],
      ]),
    }
  );
}

// ─── VERIFY AND SAVE (ACCOUNT SWITCH FIX) ────────────────────────────────────
async function verifyAndSave(ctx, userId, marketType, testnet, api_key, api_secret, bot) {
  const user = db.users.findById(userId);
  let client;
  if (marketType === 'futures') {
    client = new BinanceFuturesClient(api_key, api_secret, testnet);
  } else {
    client = new BinanceSpotClient(api_key, api_secret, testnet);
  }

  const result = await client.verifyCredentials();

  if (!result.valid) {
    await db.apiErrors.log({
      user_id:       userId,
      username:      user?.username || '',
      market_type:   marketType,
      error_code:    result.binanceCode,
      error_message: result.errorReason,
      binance_code:  result.binanceCode,
      binance_msg:   result.binanceMsg,
    });
    const codeBlock = result.binanceCode
      ? `\n\n<b>Error Code:</b> <code>${result.binanceCode}</code>\n<b>Message:</b> <code>${result.binanceMsg || 'N/A'}</code>`
      : '';
    await ctx.reply(
      `${result.errorTitle}\n\n<b>Reason:</b>\n${result.errorReason}` + codeBlock +
      `\n\n<b>What to check:</b>\n• API key + secret match\n• Trading permissions enabled\n• IP restriction OFF`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Try Again',  'change_api')],
          [Markup.button.callback('📊 Dashboard',  'dashboard')],
        ]),
      }
    );
    return;
  }

  // ── ACCOUNT SWITCH: clear all cached data from previous account ──────────
  const hadPreviousApi = user?.api_key && user.api_key !== api_key;
  if (hadPreviousApi) {
    logger.info(`[ACCOUNT-SWITCH] User ${userId} switching from old API to new. Clearing old data.`);
    await clearUserAccountData(userId);
  }

  // Save credentials + fresh balance
  await db.users.update(userId, {
    api_key,
    api_secret,
    market_type:          marketType,
    testnet,
    balance:              result.usdtBalance,
    available_balance:    result.availableBalance  ?? result.usdtBalance,
    unrealized_pnl:       result.unrealizedPnl     ?? 0,
    margin_balance:       result.marginBalance      ?? result.usdtBalance,
    last_binance_sync:    new Date().toISOString(),
    // Clear stale cached fields if switching accounts
    ...(hadPreviousApi ? { active_trades: 0 } : {}),
  });

  const mLabel = marketType === 'futures'
    ? `📊 Futures${testnet ? ' [Testnet]' : ''}`
    : `📈 Spot${testnet ? ' [Testnet]' : ''}`;
  const perms  = (result.permissions || []).join(', ') || 'N/A';

  await ctx.reply(
    `✅ <b>Binance Connected!</b>\n\n` +
    `🏦 Account: ${mLabel}\n` +
    `💰 Balance: <code>${result.usdtBalance.toFixed(4)} USDT</code>\n` +
    `✅ Permissions: ${perms}\n\n` +
    `🔄 Syncing your positions...`,
    { parse_mode: 'HTML' }
  );

  // ── FULL SYNC immediately after connect (imports live positions) ──────────
  try {
    const fresh      = db.users.findById(userId);
    const syncResult = await syncUserFromBinance(fresh);

    if (syncResult && syncResult.positions > 0) {
      logger.info(`[SYNC-SUCCESS] user:${userId} imported:${syncResult.imported} positions:${syncResult.positions}`);
      await ctx.reply(
        `✅ <b>Sync Complete!</b>\n\n` +
        `📊 Open Positions: <b>${syncResult.positions}</b>\n` +
        `📥 Imported: <b>${syncResult.imported}</b>\n` +
        `🔄 Updated: <b>${syncResult.updated}</b>\n\n` +
        `All your Binance positions are now visible in Active Trades.`,
        { parse_mode: 'HTML' }
      );
    } else {
      logger.info(`[SYNC-SUCCESS] user:${userId} no open positions found`);
      await ctx.reply(
        `✅ <b>Sync Complete</b>\n\nNo open positions found on Binance.`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (err) {
    logger.warn(`[SYNC-FAILED] Post-connect sync failed for user:${userId}`, { err: err.message });
  }

  await new Promise((r) => setTimeout(r, 500));
  const refreshed = db.users.findById(userId);
  await showDashboard(ctx, refreshed);
}

async function showReferralPage(ctx, bot) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const user = db.users.findById(userId);
  if (!user) return ctx.reply('Use /start first.');

  try {
    const botInfo = await bot.telegram.getMe();
    const page    = await buildReferralPage(userId, botInfo.username);
    if (!page) return ctx.reply('❌ Could not load referral page.');

    await ctx.reply(page.text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url('🔗 Share Invite Link',
          `https://t.me/share/url?url=${encodeURIComponent(page.link)}&text=${encodeURIComponent('🤖 Join this AI Crypto Trading Bot!')}`)],
        [
          Markup.button.callback('🔄 Refresh',   'referral'),
          Markup.button.callback('🔙 Dashboard', 'dashboard'),
        ],
      ]),
    });
  } catch (err) {
    logger.error('showReferralPage error', { err: err.message });
    await ctx.reply('❌ Failed to load referral page.');
  }
}

// ─── SUBSCRIPTION (reads from dynamic payment settings) ──────────────────────
async function showSubscription(ctx, user) {
  const sub    = user && db.subscriptions.isActive(user);
  const expiry = sub && user.subscription_expiry && user.plan !== 'lifetime'
    ? `\n📅 Expires: ${new Date(user.subscription_expiry).toLocaleDateString()}`
    : sub && user.plan === 'lifetime' ? '\n♾️ Lifetime access' : '';

  const p = db.payment.get();
  const currency = p.currency || 'USD';
  const sym = currency === 'USD' ? '$' : currency + ' ';

  const contactLine = p.admin_username
    ? `To subscribe, contact admin: <b>${p.admin_username}</b>`
    : `To subscribe, send your Telegram ID to admin:\n<code>${user?.telegram_id || ctx.from.id}</code>`;

  const payNote = p.payment_note ? `\n\n📝 <i>${p.payment_note}</i>` : '';

  const msg =
    `💳 <b>Subscription Plans</b>\n\n` +
    `Status: ${sub ? '✅ Active' : '❌ Inactive'}${expiry}\n` +
    `Plan: <b>${user?.plan?.toUpperCase() || 'None'}</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📅 <b>Daily</b>    — ${sym}${p.daily_price}\n` +
    `📆 <b>Weekly</b>   — ${sym}${p.weekly_price}\n` +
    `🗓 <b>Monthly</b>  — ${sym}${p.monthly_price}\n` +
    `♾️ <b>Lifetime</b> — ${sym}${p.lifetime_price}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    contactLine + payNote;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Copy My ID', 'copy_id')],
    [Markup.button.callback('🔙 Dashboard',  'dashboard')],
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

// ─── HELP (reads from dynamic help settings) ──────────────────────────────────
async function showHelp(ctx) {
  const h = db.help.get();

  // Build dynamic contact line
  let contactLine = '';
  if (h.support_username) contactLine += `📞 Support: <b>${h.support_username}</b>\n`;
  if (h.telegram_username) contactLine += `💬 Telegram: <b>${h.telegram_username}</b>\n`;

  // If admin has set a custom help message, show it alongside defaults
  const customNote = h.help_message && h.help_message !== 'Need help? Contact support.'
    ? `\n\n📝 <b>Additional Info:</b>\n${h.help_message}`
    : '';

  const msg =
    `ℹ️ <b>How to Use</b>\n\n` +
    `<b>1. Connect Binance</b>\n` +
    `   Dashboard → Settings → Connect Binance\n` +
    `   Paste your API Key + Secret\n` +
    `   → All positions import instantly\n\n` +
    `<b>2. Subscribe</b>\n` +
    `   Copy your ID and contact admin\n\n` +
    `<b>3. Enable Auto Trading</b>\n` +
    `   Dashboard → Auto Trading ON\n\n` +
    `<b>4. Bot runs 24/7</b>\n` +
    `   Scans ALL Binance pairs every 60s\n` +
    `   Live PNL updates every 25s\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `<b>Trade Management (Active Trades → Manage):</b>\n` +
    `• Close 100% / 50% / 25% / 75%\n` +
    `• Move Stop Loss\n` +
    `• Move Take Profit\n` +
    `• Break Even (SL → Entry)\n` +
    `• Trailing Stop (Futures only)\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `<b>Signal Grades:</b>\n` +
    `🚀 Premium (95-100): Risk 1%\n` +
    `💎 Strong  (90-94):  Risk 0.75%\n\n` +
    `<b>Protection:</b>\n` +
     `• Maximum drawdown and open-trade limits\n` +
     `• Emergency stop and Binance/API safety controls\n\n` +
    `<b>Signals include:</b> Entry, SL, TP, RR` +
    (contactLine ? `\n\n━━━━━━━━━━━━━━━━━\n${contactLine}` : '') +
    customNote;

  const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Dashboard', 'dashboard')]]);
  try { await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode: 'HTML', ...kb }); }
}

module.exports = { createBot };
