require('dotenv').config();

const BINANCE_SPOT_URL            = 'https://api.binance.com';
const BINANCE_FUTURES_URL         = 'https://fapi.binance.com';
const BINANCE_SPOT_TESTNET_URL    = 'https://testnet.binance.vision';
const BINANCE_FUTURES_TESTNET_URL = 'https://testnet.binancefuture.com';

const SCORE_MIN_TRADE        = 90;
const SCORE_PREMIUM          = 95;
const SCORE_STRONG           = 90;
const SCORE_LOW_CONF         = 85;
const SCORE_RECOVERY_MIN     = 95;

const RISK_LOW_CONF          = 0.50;
const RISK_STRONG            = 0.75;
const RISK_PREMIUM           = 1.00;
const RISK_RECOVERY_PREMIUM  = 0.50;
const RISK_RECOVERY_HIGH     = 0.75;

const DAILY_MAX_LOSSES        = 2;
const RECOVERY_TRIGGER_LOSSES = 2;

const SCAN_INTERVAL      = 60;
const MAX_ACTIVE_TRADES  = 3;
const MIN_SPOT_VOLUME    = 500000;
const MIN_FUTURES_VOLUME = 1000000;
const SL_ATR_MULT        = 1.5;
const TP_ATR_MULT        = 3.0;
const MIN_RR             = 2.0;
const RECOVERY_MIN_RR    = 3.0;

const SIGNAL_COOLDOWN_MS  = 4 * 60 * 60 * 1000;
const MONITOR_INTERVAL_MS = 25000;

const config = {
  bot: {
    token:       process.env.BOT_TOKEN     || '',
    adminChatId: process.env.ADMIN_CHAT_ID || '',
  },
  paths: {
    users:     './data/users.json',
    subscriptions: './data/subscriptions.json',
    trades:    './data/trades.json',
    signals:   './data/signals.json',
    settings:  './data/settings.json',
    stats:     './data/stats.json',
    channel:   './data/channel.json',
    payment:   './data/payment.json',
    help:      './data/help.json',
    cooldown:  './data/cooldown.json',
    referrals: './data/referrals.json',
    logs:      './logs',
  },
};

function validateConfig() {
  const errors = [];
  if (!config.bot.token)       errors.push('BOT_TOKEN is required in .env');
  if (!config.bot.adminChatId) errors.push('ADMIN_CHAT_ID is required in .env');
  if (errors.length) throw new Error('Config error:\n' + errors.join('\n'));
}

module.exports = {
  config,
  validateConfig,
  BINANCE_SPOT_URL,
  BINANCE_FUTURES_URL,
  BINANCE_SPOT_TESTNET_URL,
  BINANCE_FUTURES_TESTNET_URL,
  SCORE_MIN_TRADE,
  SCORE_PREMIUM,
  SCORE_STRONG,
  SCORE_LOW_CONF,
  SCORE_RECOVERY_MIN,
  RISK_LOW_CONF,
  RISK_STRONG,
  RISK_PREMIUM,
  RISK_RECOVERY_PREMIUM,
  RISK_RECOVERY_HIGH,
  DAILY_MAX_LOSSES,
  RECOVERY_TRIGGER_LOSSES,
  SCAN_INTERVAL,
  MAX_ACTIVE_TRADES,
  MIN_SPOT_VOLUME,
  MIN_FUTURES_VOLUME,
  SL_ATR_MULT,
  TP_ATR_MULT,
  MIN_RR,
  RECOVERY_MIN_RR,
  SIGNAL_COOLDOWN_MS,
  MONITOR_INTERVAL_MS,
};
