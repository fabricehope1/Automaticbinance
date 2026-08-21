const fs = require('fs');
const path = require('path');

const LOG_DIR  = './logs';
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB rotate

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotate() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch {}
}

function write(level, msg, meta) {
  ensureDir();
  rotate();
  const ts   = new Date().toISOString();
  const line = meta
    ? `[${ts}] [${level}] ${msg} ${JSON.stringify(meta)}`
    : `[${ts}] [${level}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  if (level === 'ERROR' || level === 'WARN' || level === 'INFO') {
    console.log(line);
  }
}

const logger = {
  info:  (msg, meta) => write('INFO',  msg, meta),
  warn:  (msg, meta) => write('WARN',  msg, meta),
  error: (msg, meta) => write('ERROR', msg, meta),
  debug: (msg, meta) => write('DEBUG', msg, meta),

  recentLines(n = 100) {
    try {
      if (!fs.existsSync(LOG_FILE)) return [];
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
      return lines.slice(-n);
    } catch { return []; }
  },
};

module.exports = logger;
