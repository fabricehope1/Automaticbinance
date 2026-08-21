const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { config, SIGNAL_COOLDOWN_MS } = require('./config');
const logger = require('./logger');

// ─── ENSURE DATA DIR ─────────────────────────────────────────────────────────
const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync('./logs'))  fs.mkdirSync('./logs',  { recursive: true });

// ─── LOCK SYSTEM ─────────────────────────────────────────────────────────────
const _locks = {};
function withLock(file, fn) {
  if (!_locks[file]) _locks[file] = Promise.resolve();
  const result = _locks[file].then(() => fn());
  _locks[file]  = result.catch(() => {});
  return result;
}

// ─── JSON I/O ─────────────────────────────────────────────────────────────────
function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}
function writeJSON(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    logger.error('writeJSON failed', { file: filePath, err: err.message });
    return false;
  }
}

function todayUTC() { return new Date().toISOString().split('T')[0]; }

const db = {

  // ── SUBSCRIPTIONS ─────────────────────────────────────────────────────────
  // Kept separate from users so subscription history survives revokes/expiry.
  subscriptions: {
    getAll() { return readJSON(config.paths.subscriptions) || []; },
    forUser(userId) {
      return db.subscriptions.getAll().filter((s) => String(s.user_id) === String(userId))
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    },
    current(userId) { return db.subscriptions.forUser(userId)[0] || null; },
    isActive(userOrId) {
      const id = typeof userOrId === 'object' ? userOrId.telegram_id : userOrId;
      const sub = db.subscriptions.current(id);
      if (sub) return sub.status === 'ACTIVE' &&
        (!sub.expires_at || Date.now() < new Date(sub.expires_at).getTime());
      // Backward-compatible read of the original user fields until migration runs.
      const user = typeof userOrId === 'object' ? userOrId : db.users.findById(id);
      return !!(user?.subscription === 'active' &&
        (user.plan === 'lifetime' || !user.subscription_expiry ||
         Date.now() < new Date(user.subscription_expiry).getTime()));
    },
    async save(data) {
      return withLock(config.paths.subscriptions, () => {
        const all = db.subscriptions.getAll();
        const now = new Date().toISOString();
        const record = {
          user_id: String(data.user_id),
          subscription_type: String(data.subscription_type || 'MONTHLY').toUpperCase(),
          started_at: data.started_at || now,
          expires_at: data.expires_at || null,
          status: data.status || 'ACTIVE',
          created_at: data.created_at || now,
          updated_at: now,
        };
        all.push(record);
        writeJSON(config.paths.subscriptions, all);
        return record;
      });
    },
    async update(userId, patch) {
      return withLock(config.paths.subscriptions, () => {
        const all = db.subscriptions.getAll();
        const idx = all.map((s) => String(s.user_id)).lastIndexOf(String(userId));
        if (idx < 0) return null;
        all[idx] = { ...all[idx], ...patch, updated_at: new Date().toISOString() };
        writeJSON(config.paths.subscriptions, all);
        return all[idx];
      });
    },
    async migrateLegacy() {
      const all = db.subscriptions.getAll();
      const known = new Set(all.map((s) => String(s.user_id)));
      for (const user of db.users.getAll()) {
        if (known.has(String(user.telegram_id)) || user.subscription !== 'active') continue;
        await db.subscriptions.save({
          user_id: user.telegram_id,
          subscription_type: user.plan === 'lifetime' ? 'LIFETIME' : String(user.plan || 'MONTHLY').toUpperCase(),
          started_at: user.join_date || new Date().toISOString(),
          expires_at: user.plan === 'lifetime' ? null : user.subscription_expiry,
          status: user.subscription_expiry && Date.now() >= new Date(user.subscription_expiry).getTime() ? 'EXPIRED' : 'ACTIVE',
        });
      }
    },
  },

  // ── SETTINGS ─────────────────────────────────────────────────────────────
  settings: {
    get() {
      return readJSON(config.paths.settings) || {
        risk_percent:    1,
        scan_interval:   60,
        max_trades:      3,
        maintenance:     false,
        welcome_message: '',
        channel_id:      '',
        channel_enabled: false,
      };
    },
    async update(patch) {
      return withLock(config.paths.settings, () => {
        const updated = { ...db.settings.get(), ...patch };
        writeJSON(config.paths.settings, updated);
        return updated;
      });
    },
  },

  // ── PAYMENT SETTINGS ─────────────────────────────────────────────────────
  payment: {
    get() {
      return readJSON(config.paths.payment) || {
        monthly_price:   29.99,
        weekly_price:    9.99,
        lifetime_price:  99.99,
        daily_price:     2.99,
        currency:        'USD',
        admin_username:  '',
        payment_note:    '',
      };
    },
    async update(patch) {
      return withLock(config.paths.payment, () => {
        const updated = { ...db.payment.get(), ...patch };
        writeJSON(config.paths.payment, updated);
        logger.info('[PAYMENT-UPDATE] Payment settings updated', { patch });
        return updated;
      });
    },
  },

  // ── HELP SETTINGS ─────────────────────────────────────────────────────────
  help: {
    get() {
      return readJSON(config.paths.help) || {
        support_username: '',
        telegram_username: '',
        help_message: 'Need help? Contact support.',
      };
    },
    async update(patch) {
      return withLock(config.paths.help, () => {
        const updated = { ...db.help.get(), ...patch };
        writeJSON(config.paths.help, updated);
        logger.info('[HELP-UPDATE] Help settings updated', { patch });
        return updated;
      });
    },
  },

  // ── COOLDOWN STORE ────────────────────────────────────────────────────────
  // Per-symbol, per-market, per-side cooldown. Never global.
  cooldown: {
    _path: config.paths.cooldown,

    _key(symbol, market, side) {
      return `${symbol}:${market}:${side}`;
    },

    getAll() {
      return readJSON(db.cooldown._path) || {};
    },

    isActive(symbol, market, side) {
      const store = db.cooldown.getAll();
      const key   = db.cooldown._key(symbol, market, side);
      const entry = store[key];
      if (!entry) return false;
      const elapsed = Date.now() - entry.timestamp;
      const active  = elapsed < (SIGNAL_COOLDOWN_MS || 4 * 60 * 60 * 1000);
      if (!active) {
        // Clean up expired entry
        db.cooldown.clear(symbol, market, side);
      }
      return active;
    },

    set(symbol, market, side) {
      const store = db.cooldown.getAll();
      const key   = db.cooldown._key(symbol, market, side);
      store[key]  = { symbol, market, side, timestamp: Date.now() };
      writeJSON(db.cooldown._path, store);
      logger.info(`[COOLDOWN-SET] ${symbol} ${market} ${side}`);
    },

    clear(symbol, market, side) {
      const store = db.cooldown.getAll();
      const key   = db.cooldown._key(symbol, market, side);
      delete store[key];
      writeJSON(db.cooldown._path, store);
    },

    clearAll() {
      writeJSON(db.cooldown._path, {});
    },

    // Remove all expired entries
    cleanup() {
      const store   = db.cooldown.getAll();
      const now     = Date.now();
      const ttl     = SIGNAL_COOLDOWN_MS || 4 * 60 * 60 * 1000;
      let changed   = false;
      for (const [key, entry] of Object.entries(store)) {
        if (now - entry.timestamp >= ttl) { delete store[key]; changed = true; }
      }
      if (changed) writeJSON(db.cooldown._path, store);
    },
  },

  // ── CHANNEL CONFIG ────────────────────────────────────────────────────────
  channel: {
    get() {
      return readJSON(config.paths.channel) || { channel_id: '', enabled: false, messages: {} };
    },
    async update(patch) {
      return withLock(config.paths.channel, () => {
        const updated = { ...db.channel.get(), ...patch };
        writeJSON(config.paths.channel, updated);
        return updated;
      });
    },
    async saveMessageId(signalId, messageId) {
      return withLock(config.paths.channel, () => {
        const cur = db.channel.get();
        cur.messages = cur.messages || {};
        cur.messages[signalId] = { message_id: messageId };
        const keys = Object.keys(cur.messages);
        if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete cur.messages[k];
        writeJSON(config.paths.channel, cur);
        return true;
      });
    },
    getMessageId(signalId) {
      return db.channel.get().messages?.[signalId]?.message_id || null;
    },
  },

  // ── USERS ─────────────────────────────────────────────────────────────────
  users: {
    getAll()      { return readJSON(config.paths.users) || []; },
    findById(id)  { return db.users.getAll().find((u) => String(u.telegram_id) === String(id)) || null; },
    findByUsername(u) { return db.users.getAll().find((x) => x.username === u) || null; },

    async create(data) {
      return withLock(config.paths.users, () => {
        const users = db.users.getAll();
        const exists = users.find((u) => String(u.telegram_id) === String(data.telegram_id));
        if (exists) return exists;
        const user = {
          telegram_id:          String(data.telegram_id),
          username:             data.username    || '',
          first_name:           data.first_name  || '',
          join_date:            new Date().toISOString(),
          api_key:              '',
          api_secret:           '',
          market_type:          '',
          testnet:              false,
          balance:              0,
          available_balance:    0,
          margin_balance:       0,
          unrealized_pnl:       0,
          subscription:         'inactive',
          plan:                 null,
          subscription_expiry:  null,
          auto_trading:         false,
          total_trades:         0,
          spot_trades:          0,
          futures_trades:       0,
          wins:                 0,
          losses:               0,
          breakeven:            0,
          consecutive_wins:     0,
          consecutive_losses:   0,
          win_rate:             0,
          total_profit:         0,
          total_loss:           0,
          net_pnl:              0,
          avg_win:              0,
          avg_loss:             0,
          active_trades:        0,
          recovery_mode:        false,
          recovery_triggered:   0,
          daily_wins:           0,
          daily_losses:         0,
          daily_reset_date:     todayUTC(),
          trading_paused:       false,
          banned:               false,
          referral_code:        null,
          referred_by:          null,
          referred_by_code:     null,
          total_referrals:      0,
          referral_earnings:    0,
          last_binance_sync:    null,
          today_pnl:            0,
          weekly_pnl:           0,
          monthly_pnl:          0,
        };
        users.push(user);
        writeJSON(config.paths.users, users);
        return user;
      });
    },

    async update(id, patch) {
      return withLock(config.paths.users, () => {
        const users = db.users.getAll();
        const idx   = users.findIndex((u) => String(u.telegram_id) === String(id));
        if (idx === -1) return null;
        users[idx] = { ...users[idx], ...patch };
        writeJSON(config.paths.users, users);
        return users[idx];
      });
    },

    async delete(id) {
      return withLock(config.paths.users, () => {
        writeJSON(config.paths.users, db.users.getAll().filter((u) => String(u.telegram_id) !== String(id)));
        return true;
      });
    },

    count()           { return db.users.getAll().length; },
    countPremium()    { return db.users.getAll().filter((u) => db.subscriptions.isActive(u)).length; },
    countFree()       { return db.users.getAll().filter((u) => !db.subscriptions.isActive(u)).length; },
    countActive()     { return db.users.getAll().filter((u) => u.auto_trading).length; },
    countBanned()     { return db.users.getAll().filter((u) => u.banned).length; },
    countSpot()       { return db.users.getAll().filter((u) => u.market_type === 'spot').length; },
    countFutures()    { return db.users.getAll().filter((u) => u.market_type === 'futures').length; },
    countActiveToday() {
      const today = todayUTC();
      return db.users.getAll().filter((u) => u.daily_reset_date === today && (u.daily_wins > 0 || u.daily_losses > 0)).length;
    },

    async resetDailyIfNeeded(id) {
      const user  = db.users.findById(id);
      if (!user) return;
      const today = todayUTC();
      if (user.daily_reset_date !== today) {
        await db.users.update(id, { daily_wins: 0, daily_losses: 0, daily_reset_date: today, trading_paused: false });
      }
    },
  },

  // ── REFERRALS ─────────────────────────────────────────────────────────────
  referrals: {
    _path: config.paths.referrals,

    getAll() {
      return readJSON(db.referrals._path) || [];
    },

    forReferrer(referrerId) {
      return db.referrals.getAll().filter((r) => String(r.referrer_id) === String(referrerId));
    },

    forReferee(refereeId) {
      return db.referrals.getAll().filter((r) => String(r.referee_id) === String(refereeId));
    },

    countForReferrer(referrerId) {
      return db.referrals.forReferrer(referrerId).length;
    },

    async log(data) {
      return withLock(db.referrals._path, () => {
        const all = db.referrals.getAll();
        const entry = {
          referral_id:   uuidv4(),
          referrer_id:   String(data.referrer_id),
          referee_id:    String(data.referee_id),
          code:          data.code,
          referrer_days: data.referrer_days || 3,
          referee_days:  data.referee_days  || 1,
          timestamp:     new Date().toISOString(),
        };
        all.push(entry);
        writeJSON(db.referrals._path, all);
        logger.info(`[REFERRAL-LOG] referrer:${entry.referrer_id} referee:${entry.referee_id} code:${entry.code}`);
        return entry;
      });
    },
  },

  // ── TRADES ────────────────────────────────────────────────────────────────
  trades: {
    getAll()         { return readJSON(config.paths.trades) || []; },
    findById(id)     { return db.trades.getAll().find((t) => t.trade_id === id) || null; },
    forUser(uid)     { return db.trades.getAll().filter((t) => String(t.user_id) === String(uid)); },
    openForUser(uid) { return db.trades.forUser(uid).filter((t) => t.status === 'open'); },

    findOpenImported(userId, symbol, marketType, side) {
      return db.trades.getAll().find((t) =>
        String(t.user_id) === String(userId) &&
        t.symbol === symbol && t.market_type === marketType &&
        t.side === side && t.status === 'open' && t.imported === true
      ) || null;
    },

    // Fix: include market_type in the duplicate check
    findOpenBySymbolSide(userId, symbol, side, marketType) {
      return db.trades.getAll().find((t) =>
        String(t.user_id) === String(userId) &&
        t.symbol === symbol && t.side === side && t.status === 'open' &&
        (!marketType || t.market_type === marketType)
      ) || null;
    },

    findOpenBySymbol(userId, symbol, marketType) {
      return db.trades.getAll().find((t) =>
        String(t.user_id) === String(userId) &&
        t.symbol === symbol && t.market_type === marketType && t.status === 'open'
      ) || null;
    },

    findDuplicates() {
      const all  = db.trades.getAll().filter((t) => t.status === 'open');
      const seen = new Map();
      const dups = [];
      for (const t of all) {
        const key = `${t.user_id}:${t.symbol}:${t.side}:${t.market_type}`;
        if (seen.has(key)) {
          dups.push(t);
        } else {
          seen.set(key, t);
        }
      }
      return dups;
    },

    countBreakeven(uid) {
      const trades = uid ? db.trades.forUser(uid) : db.trades.getAll();
      return trades.filter((t) => t.status === 'closed' && t.result === 'BREAKEVEN').length;
    },

    async create(data) {
      return withLock(config.paths.trades, () => {
        const trades = db.trades.getAll();

        // Duplicate guard: never insert if same user+symbol+side+market is already open
        const dupIdx = trades.findIndex((t) =>
          String(t.user_id) === String(data.user_id) &&
          t.symbol === data.symbol &&
          t.side   === data.side &&
          t.market_type === (data.market_type || 'spot') &&
          t.status === 'open'
        );
        if (dupIdx !== -1) {
          logger.warn(`[TRADE-DEDUP] Skipped duplicate create: ${data.symbol} ${data.side} ${data.market_type} user:${data.user_id}`);
          return trades[dupIdx];
        }

        const trade  = {
          trade_id:          uuidv4(),
          user_id:           String(data.user_id),
          market_type:       data.market_type || 'spot',
          symbol:            data.symbol,
          side:              data.side,
          entry:             data.entry,
          sl:                data.sl    || null,
          tp:                data.tp    || null,
          quantity:          data.quantity || 0,
          leverage:          data.leverage || 1,
          margin_used:       data.margin_used || 0,
          risk_pct:          data.risk_pct || 1,
          score:             data.score || 0,
          signal_id:         data.signal_id || '',
          order_id:          String(data.order_id || ''),
          sl_order_id:       String(data.sl_order_id || ''),
          tp_order_id:       String(data.tp_order_id || ''),
          status:            'open',
          imported:          data.imported || false,
          profit:            0,
          profit_pct:        0,
          result:            null,
          current_price:     data.current_price || data.entry,
          liquidation_price: data.liquidation_price || null,
          open_time:         data.open_time || new Date().toISOString(),
          close_time:        null,
          close_reason:      null,
          close_price:       null,
          notified:          false,
          user_message_ids:  data.user_message_ids || {},
        };
        trades.push(trade);
        writeJSON(config.paths.trades, trades);
        return trade;
      });
    },

    // Upsert imported: UPDATE if open imported trade exists, INSERT if not
    async upsertImported(data) {
      return withLock(config.paths.trades, () => {
        const trades = db.trades.getAll();

        // Find existing open trade for this user+symbol+market+side (imported or bot-opened)
        const idx = trades.findIndex((t) =>
          String(t.user_id) === String(data.user_id) &&
          t.symbol === data.symbol && t.market_type === data.market_type &&
          t.side === data.side && t.status === 'open'
        );
        if (idx !== -1) {
          trades[idx] = {
            ...trades[idx],
            current_price:     data.current_price     ?? trades[idx].current_price,
            profit:            data.profit            ?? trades[idx].profit,
            profit_pct:        data.profit_pct        ?? trades[idx].profit_pct,
            quantity:          data.quantity          ?? trades[idx].quantity,
            leverage:          data.leverage          ?? trades[idx].leverage,
            sl:                data.sl                ?? trades[idx].sl,
            tp:                data.tp                ?? trades[idx].tp,
            liquidation_price: data.liquidation_price ?? trades[idx].liquidation_price,
            margin_used:       data.margin_used       ?? trades[idx].margin_used,
            imported:          trades[idx].imported,
          };
          writeJSON(config.paths.trades, trades);
          return { trade: trades[idx], created: false };
        }
        const trade = {
          trade_id:          uuidv4(),
          user_id:           String(data.user_id),
          market_type:       data.market_type || 'futures',
          symbol:            data.symbol,
          side:              data.side,
          entry:             data.entry,
          sl:                data.sl || null,
          tp:                data.tp || null,
          quantity:          data.quantity || 0,
          leverage:          data.leverage || 1,
          margin_used:       data.margin_used || 0,
          risk_pct:          data.risk_pct || 0,
          score:             0,
          signal_id:         '',
          order_id:          String(data.order_id || ''),
          sl_order_id:       String(data.sl_order_id || ''),
          tp_order_id:       String(data.tp_order_id || ''),
          status:            'open',
          imported:          true,
          profit:            data.profit || 0,
          profit_pct:        data.profit_pct || 0,
          result:            null,
          current_price:     data.current_price || data.entry,
          liquidation_price: data.liquidation_price || null,
          open_time:         data.open_time || new Date().toISOString(),
          close_time:        null,
          close_reason:      null,
          close_price:       null,
          notified:          false,
          user_message_ids:  {},
        };
        trades.push(trade);
        writeJSON(config.paths.trades, trades);
        logger.info(`[IMPORT-NEW] ${data.symbol} ${data.side} ${data.market_type} user:${data.user_id}`);
        return { trade, created: true };
      });
    },

    async update(id, patch) {
      return withLock(config.paths.trades, () => {
        const trades = db.trades.getAll();
        const idx    = trades.findIndex((t) => t.trade_id === id);
        if (idx === -1) return null;
        trades[idx] = { ...trades[idx], ...patch };
        writeJSON(config.paths.trades, trades);
        return trades[idx];
      });
    },

    count()       { return db.trades.getAll().length; },
    countOpen()   { return db.trades.getAll().filter((t) => t.status === 'open').length; },

    todayStats(uid = null) {
      const today  = todayUTC();
      const closed = db.trades.getAll().filter((t) => t.status === 'closed' && (!uid || String(t.user_id) === String(uid)) && t.close_time?.startsWith(today));
      return {
        total:    closed.length,
        wins:     closed.filter((t) => t.result === 'WIN').length,
        losses:   closed.filter((t) => t.result === 'LOSS').length,
        breakeven: closed.filter((t) => t.result === 'BREAKEVEN').length,
        pnl:      closed.reduce((s, t) => s + (t.profit || 0), 0),
      };
    },
    weekStats(uid = null) {
      const week   = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const closed = db.trades.getAll().filter((t) => t.status === 'closed' && (!uid || String(t.user_id) === String(uid)) && t.close_time >= week);
      return {
        total:    closed.length,
        wins:     closed.filter((t) => t.result === 'WIN').length,
        losses:   closed.filter((t) => t.result === 'LOSS').length,
        breakeven: closed.filter((t) => t.result === 'BREAKEVEN').length,
        pnl:      closed.reduce((s, t) => s + (t.profit || 0), 0),
      };
    },
    monthStats(uid = null) {
      const month  = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      const closed = db.trades.getAll().filter((t) => t.status === 'closed' && (!uid || String(t.user_id) === String(uid)) && t.close_time >= month);
      return {
        total:    closed.length,
        wins:     closed.filter((t) => t.result === 'WIN').length,
        losses:   closed.filter((t) => t.result === 'LOSS').length,
        breakeven: closed.filter((t) => t.result === 'BREAKEVEN').length,
        pnl:      closed.reduce((s, t) => s + (t.profit || 0), 0),
      };
    },
    totalProfit() {
      return db.trades.getAll().reduce((s, t) => s + (t.profit || 0), 0).toFixed(4);
    },
  },

  // ── SIGNALS ───────────────────────────────────────────────────────────────
  signals: {
    getAll()    { return readJSON(config.paths.signals) || []; },
    findById(id){ return db.signals.getAll().find((s) => s.signal_id === id) || null; },
    recent(n = 20) {
      return db.signals.getAll()
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, n);
    },
    todayCount() {
      return db.signals.getAll().filter((s) => s.timestamp?.startsWith(todayUTC())).length;
    },

    // ── PER-SYMBOL COOLDOWN CHECK ──────────────────────────────────────────
    // Cooldown is ONLY per symbol+market+side. Never blocks other symbols.
    // Spot and Futures are tracked independently.
    findActiveDuplicate(symbol, side, marketType, entryPrice) {
      // 1. Check dedicated cooldown store (per symbol:market:side)
      if (db.cooldown.isActive(symbol, marketType, side)) {
        logger.info(`[COOLDOWN-ACTIVE] ${symbol} ${marketType} ${side} — blocked by cooldown only for this pair`);
        return { duplicate: true, reason: 'COOLDOWN_ACTIVE' };
      }

      // 2. Check recent signals within cooldown window for same symbol+side+market
      const sigs    = db.signals.getAll();
      const now     = Date.now();
      const cooldown = SIGNAL_COOLDOWN_MS || (4 * 60 * 60 * 1000);

      const recentSame = sigs.find((s) => {
        if (s.symbol !== symbol || s.signal !== side || s.market_type !== marketType) return false;
        const age = now - new Date(s.timestamp).getTime();
        if (age >= cooldown) return false;
        if (entryPrice && s.entry) {
          const diff = Math.abs(entryPrice - s.entry) / s.entry;
          if (diff > 0.005) return false;
        }
        return true;
      });
      if (recentSame) {
        return { duplicate: true, reason: 'COOLDOWN_ACTIVE', signal: recentSame };
      }

      return { duplicate: false };
    },

    async create(data) {
      return withLock(config.paths.signals, () => {
        const sigs = db.signals.getAll();
        const sig  = {
          signal_id:     uuidv4(),
          market_type:   data.market_type || 'spot',
          symbol:        data.symbol,
          signal:        data.signal,
          entry:         data.entry,
          sl:            data.sl,
          tp:            data.tp,
          rr:            data.rr || '',
          score:         data.score || 0,
          grade:         data.grade || 'STRONG',
          confirmations: data.confirmations || {},
          atr:           data.atr || 0,
          timestamp:     new Date().toISOString(),
        };
        sigs.push(sig);
        if (sigs.length > 2000) sigs.splice(0, sigs.length - 2000);
        writeJSON(config.paths.signals, sigs);

        // Record cooldown per symbol:market:side
        db.cooldown.set(data.symbol, data.market_type || 'spot', data.signal);

        return sig;
      });
    },

    count() { return db.signals.getAll().length; },
  },

  // ── DATABASE CLEANUP ──────────────────────────────────────────────────────
  async cleanOrphansAndDuplicates() {
    return withLock(config.paths.trades, () => {
      const trades  = db.trades.getAll();
      const seen    = new Map();
      const cleaned = [];
      let dupCount  = 0;

      for (const t of trades) {
        if (t.status !== 'open') { cleaned.push(t); continue; }
        const key = `${t.user_id}:${t.symbol}:${t.side}:${t.market_type}`;
        if (seen.has(key)) {
          const existing    = seen.get(key);
          const existingIdx = cleaned.indexOf(existing);
          if (!existing.order_id && t.order_id) {
            cleaned.splice(existingIdx, 1, t);
            seen.set(key, t);
          }
          dupCount++;
          logger.warn(`[DB-CLEAN] Removed duplicate trade: ${t.trade_id} (${t.symbol} ${t.side} ${t.market_type} user:${t.user_id})`);
        } else {
          seen.set(key, t);
          cleaned.push(t);
        }
      }

      if (dupCount > 0) {
        writeJSON(config.paths.trades, cleaned);
        logger.info(`[DB-CLEAN] Removed ${dupCount} duplicate open trade(s)`);
      }

      const sigs    = db.signals.getAll();
      const sigSeen = new Map();
      const cleanSigs = [];
      let sigDups = 0;

      for (const s of [...sigs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))) {
        const key = `${s.symbol}:${s.signal}:${s.market_type}`;
        const existing = sigSeen.get(key);
        if (existing) {
          const ageDiff = Math.abs(new Date(existing.timestamp) - new Date(s.timestamp));
          if (ageDiff < 10 * 60 * 1000) { sigDups++; continue; }
        }
        sigSeen.set(key, s);
        cleanSigs.push(s);
      }

      if (sigDups > 0) {
        writeJSON(config.paths.signals, cleanSigs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
        logger.info(`[DB-CLEAN] Removed ${sigDups} duplicate signal(s)`);
      }

      // Cleanup expired cooldowns
      db.cooldown.cleanup();

      return { dupTrades: dupCount, dupSignals: sigDups };
    });
  },

  // ── API ERROR LOG ─────────────────────────────────────────────────────────
  apiErrors: {
    _path: './logs/api_errors.json',
    getAll() { return readJSON(db.apiErrors._path) || []; },
    async log(data) {
      return withLock(db.apiErrors._path, () => {
        const errors = db.apiErrors.getAll();
        errors.push({
          id:            uuidv4(),
          user_id:       String(data.user_id || ''),
          username:      data.username || '',
          time:          new Date().toISOString(),
          market_type:   data.market_type || '',
          error_code:    data.error_code || null,
          error_message: data.error_message || '',
          binance_code:  data.binance_code || null,
          binance_msg:   data.binance_msg  || '',
        });
        if (errors.length > 500) errors.splice(0, errors.length - 500);
        writeJSON(db.apiErrors._path, errors);
      });
    },
  },
};

module.exports = db;
