const db     = require('./database');
const logger = require('./logger');

let botRef = null;

function setBot(bot) { botRef = bot; }

function gradeLabel(grade, score) {
  if (grade === 'PREMIUM') return `🚀 PREMIUM ${score >= 95 ? '⭐' : ''} SIGNAL`;
  return `💎 STRONG SIGNAL`;
}

function confirmRow(label, ok) { return `${ok ? '✅' : '❌'} ${label}`; }

// ─── BUILD SIGNAL MESSAGE (single TP — no TP2) ───────────────────────────────

function buildSignalMessage(signal, profitPct = null, status = 'ACTIVE') {
  const isBuy = signal.signal === 'BUY';
  const c     = signal.confirmations || {};
  const dir   = isBuy ? 'Bullish' : 'Bearish';

  const statusLine = status === 'WIN'  ? '✅ WIN'
    : status === 'LOSS'                ? '❌ LOSS'
    : status === 'BREAKEVEN'           ? '⚖️ BREAKEVEN'
    : '🟢 ACTIVE';

  const profitLine = profitPct !== null
    ? (profitPct >= 0
      ? `\n💰 Current Profit: <b>+${profitPct.toFixed(2)}%</b>`
      : `\n🔻 Current Loss: <b>${profitPct.toFixed(2)}%</b>`)
    : '';

  const tpValue = signal.tp || signal.tp1 || '—';

  return (
    `${gradeLabel(signal.grade, signal.score)}\n\n` +
    `📊 Pair: <b>${signal.symbol}</b>\n` +
    `🎯 Confidence: <b>${signal.score}/100</b>\n\n` +
    `📍 Entry: <code>${signal.entry}</code>\n` +
    `🛡 SL: <code>${signal.sl}</code>\n` +
    `🎯 TP: <code>${tpValue}</code>\n` +
    `⚖️ RR: <b>1:${signal.rr}</b>\n\n` +
    `✨ Confirmations:\n` +
    `${confirmRow(`4H ${dir} Trend`, c.trend_4h)}\n` +
    `${confirmRow(`1H ${dir} Trend`, c.trend_1h)}\n` +
    `${confirmRow('BOS',             c.bos)}\n` +
    `${confirmRow('CHOCH',           c.choch)}\n` +
    `${confirmRow('Order Block',     c.order_block)}\n` +
    `${confirmRow('Fair Value Gap',  c.fvg)}\n` +
    `${confirmRow('Volume Spike',    c.volume_spike)}\n` +
    `${confirmRow('RSI Confirmation',c.rsi)}\n\n` +
    `📈 Status: ${statusLine}` +
    profitLine
  );
}

function buildCloseMessage(signal, result) {
  const isWin = result.isWin !== undefined ? result.isWin : result.profit > 0;
  const label = result.result_label || (isWin ? 'WIN' : result.profit === 0 ? 'BREAKEVEN' : 'LOSS');
  const emoji = label === 'WIN' ? '✅' : label === 'BREAKEVEN' ? '⚖️' : '❌';
  const pct   = result.profitPct !== undefined ? result.profitPct : null;

  return (
    `${emoji} SIGNAL CLOSED — <b>${label}</b>\n\n` +
    `📊 Pair: <b>${signal.symbol}</b>\n` +
    `Direction: <b>${signal.signal}</b>\n` +
    (pct !== null
      ? (pct >= 0
        ? `Profit: <b>+${Math.abs(pct).toFixed(2)}%</b>`
        : `Loss: <b>-${Math.abs(pct).toFixed(2)}%</b>`)
      : `PNL: <b>${(result.profit || 0) >= 0 ? '+' : ''}${(result.profit || 0).toFixed(4)} USDT</b>`)
  );
}

// ─── POST SIGNAL TO CHANNEL ───────────────────────────────────────────────────

async function postSignalToChannel(signal) {
  if (!botRef) return;
  const channelCfg = db.channel.get();
  if (!channelCfg.enabled || !channelCfg.channel_id) return;

  try {
    const msg = await botRef.telegram.sendMessage(
      channelCfg.channel_id,
      buildSignalMessage(signal),
      { parse_mode: 'HTML' }
    );
    await db.channel.saveMessageId(signal.signal_id, msg.message_id);
    logger.info(`Signal posted to channel: ${signal.signal_id} → msg ${msg.message_id}`);
  } catch (err) {
    logger.error('Channel post failed', { err: err.message, channel: channelCfg.channel_id });
    try {
      const { config } = require('./config');
      if (config.bot.adminChatId) {
        await botRef.telegram.sendMessage(
          config.bot.adminChatId,
          `⚠️ <b>Channel Post Failed</b>\n\nSignal: ${signal.symbol}\nError: ${err.message}`,
          { parse_mode: 'HTML' }
        );
      }
    } catch {}
  }
}

// ─── UPDATE / CLOSE CHANNEL MESSAGE ──────────────────────────────────────────

async function updateChannelMessage(signalId, text) {
  if (!botRef) return;
  const channelCfg = db.channel.get();
  if (!channelCfg.enabled || !channelCfg.channel_id) return;
  const messageId = db.channel.getMessageId(signalId);
  if (!messageId) return;
  try {
    await botRef.telegram.editMessageText(
      channelCfg.channel_id, messageId, null, text, { parse_mode: 'HTML' }
    );
  } catch (err) {
    if (!err.message?.includes('message is not modified')) {
      logger.debug('Channel edit failed', { err: err.message });
    }
  }
}

async function closeChannelSignal(signal, result) {
  if (!botRef) return;
  const channelCfg = db.channel.get();
  if (!channelCfg.enabled || !channelCfg.channel_id) return;

  const messageId = db.channel.getMessageId(signal.signal_id);
  const closeText = buildCloseMessage(signal, result);

  if (!messageId) {
    try { await botRef.telegram.sendMessage(channelCfg.channel_id, closeText, { parse_mode: 'HTML' }); } catch {}
    return;
  }
  try {
    await botRef.telegram.editMessageText(
      channelCfg.channel_id, messageId, null, closeText, { parse_mode: 'HTML' }
    );
  } catch (err) {
    if (!err.message?.includes('message is not modified')) {
      logger.debug('Channel close edit failed', { err: err.message });
    }
  }
}

async function updateChannelSignalPnl(signal, profitPct) {
  await updateChannelMessage(signal.signal_id, buildSignalMessage(signal, profitPct, 'ACTIVE'));
}

async function verifyChannelPermissions(channelId) {
  if (!botRef) return { ok: false, error: 'Bot not initialized' };
  try {
    const me     = await botRef.telegram.getMe();
    const chat   = await botRef.telegram.getChat(channelId);
    const member = await botRef.telegram.getChatMember(channelId, me.id);
    const canPost = ['administrator', 'creator'].includes(member.status) &&
                    (member.can_post_messages !== false);
    return { ok: canPost, chatTitle: chat.title || channelId, status: member.status,
             error: canPost ? null : 'Bot is not an admin or cannot post messages' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  setBot,
  postSignalToChannel,
  updateChannelMessage,
  closeChannelSignal,
  updateChannelSignalPnl,
  verifyChannelPermissions,
  buildSignalMessage,
  buildCloseMessage,
};
