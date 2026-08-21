const { v4: uuidv4 } = require('uuid');
const db     = require('./database');
const logger = require('./logger');

const REFERRER_DAYS = 3;
const REFEREE_DAYS  = 1;
const CODE_LENGTH   = 10;

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'REF';
  for (let i = 0; i < CODE_LENGTH - 3; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function getOrCreateCode(userId) {
  const user = db.users.findById(userId);
  if (!user) return null;
  if (user.referral_code) return user.referral_code;
  const code = makeCode();
  await db.users.update(userId, { referral_code: code });
  return code;
}

async function applyReferral(refereeId, code, bot) {
  try {
    const referee = db.users.findById(refereeId);
    if (!referee || referee.referred_by) return;

    const all      = db.users.getAll();
    const referrer = all.find((u) => u.referral_code === code);
    if (!referrer || String(referrer.telegram_id) === String(refereeId)) return;

    const newExpiry = referrer.subscription_expiry
      ? new Date(Math.max(Date.now(), new Date(referrer.subscription_expiry).getTime()) + REFERRER_DAYS * 86400000).toISOString()
      : new Date(Date.now() + REFERRER_DAYS * 86400000).toISOString();

    await db.users.update(referrer.telegram_id, {
      subscription:         'active',
      subscription_expiry:  newExpiry,
      plan:                 referrer.plan || 'referral',
      total_referrals:      (referrer.total_referrals || 0) + 1,
      referral_earnings:    (referrer.referral_earnings || 0) + REFERRER_DAYS,
    });

    const refereeExpiry = new Date(Date.now() + REFEREE_DAYS * 86400000).toISOString();
    await db.users.update(refereeId, {
      referred_by:         referrer.telegram_id,
      referred_by_code:    code,
      subscription:        'active',
      subscription_expiry: refereeExpiry,
      plan:                'referral',
    });

    await db.referrals.log({
      referrer_id:   referrer.telegram_id,
      referee_id:    refereeId,
      code,
      referrer_days: REFERRER_DAYS,
      referee_days:  REFEREE_DAYS,
    });

    if (bot) {
      try {
        await bot.telegram.sendMessage(
          referrer.telegram_id,
          `🎉 <b>Referral Bonus!</b>\n\nSomeone joined using your invite link!\n+${REFERRER_DAYS} days added to your subscription.`,
          { parse_mode: 'HTML' }
        );
      } catch {}
    }

    logger.info(`Referral applied: ${referrer.telegram_id} → ${refereeId} (code: ${code})`);
  } catch (err) {
    logger.error('applyReferral error', { err: err.message });
  }
}

async function buildReferralPage(userId, botUsername) {
  try {
    const code = await getOrCreateCode(userId);
    if (!code) return null;
    const link  = `https://t.me/${botUsername}?start=${code}`;
    const user  = db.users.findById(userId);
    const refs  = db.referrals.forReferrer(userId);
    const earned = user?.referral_earnings || 0;

    const activeRefs = refs.filter((r) => {
      const referee = db.users.findById(r.referee_id);
      return referee && db.subscriptions.isActive(referee);
    }).length;

    const recent = refs.slice(-5).reverse();
    let refList = '';
    if (recent.length > 0) {
      refList = '\n\n📋 <b>Recent Referrals:</b>\n';
      for (const r of recent) {
        const date = new Date(r.timestamp).toLocaleDateString();
        refList += `  • ${date}  (+${r.referrer_days} days earned)\n`;
      }
    }

    const subExpiry = user?.subscription_expiry
      ? `\n📅 Sub expires: ${new Date(user.subscription_expiry).toLocaleDateString()}`
      : '';

    const text =
      `🎁 <b>Referral Program</b>\n\n` +
      `Invite friends — earn free subscription days!\n\n` +
      `👥 Total Referrals: <b>${refs.length}</b>\n` +
      `🟢 Active Referrals: <b>${activeRefs}</b>\n` +
      `🎖 Total Days Earned: <b>${earned}</b>${subExpiry}\n\n` +
      `🔗 <b>Your Invite Link:</b>\n` +
      `<code>${link}</code>\n\n` +
      `📣 Your Code: <code>${code}</code>\n\n` +
      `<b>Rewards:</b>\n` +
      `• You get: +${REFERRER_DAYS} days per referral\n` +
      `• Friend gets: +${REFEREE_DAYS} free day` +
      refList;

    return { text, link, code };
  } catch (err) {
    logger.error('buildReferralPage error', { err: err.message });
    return null;
  }
}

module.exports = { applyReferral, buildReferralPage, getOrCreateCode };
