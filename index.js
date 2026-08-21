const { validateConfig } = require('./config');
const { createBot }      = require('./bot');
const { start: startScheduler, stop: stopScheduler } = require('./scheduler');
const logger             = require('./logger');

// ─── VALIDATE CONFIG ──────────────────────────────────────────────────────────
try {
  validateConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

async function main() {
  logger.info('=== AI CRYPTO TRADING BOT STARTING ===');

  const bot = createBot();

  startScheduler(bot);

  // Graceful shutdown
  const shutdown = async (sig) => {
    logger.info(`Received ${sig} — shutting down...`);
    stopScheduler();
    await bot.stop(sig);
    process.exit(0);
  };
  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await bot.launch();
    const me = await bot.telegram.getMe();
    logger.info(`Bot running as @${me.username} (${me.id})`);
    logger.info('=== BOT READY ===');
  } catch (err) {
    logger.error('Failed to launch bot', { err: err.message });
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error('Fatal error', { err: err.message });
  process.exit(1);
});
