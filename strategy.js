const logger = require('./logger');
const {
  SL_ATR_MULT,
  SCORE_MIN_TRADE,
  SCORE_PREMIUM,
  SCORE_STRONG,
  SCORE_LOW_CONF,
  MIN_RR,
} = require('./config');

// ─── SCORING WEIGHTS ──────────────────────────────────────────────────────────
const WEIGHTS = {
  trend_4h:       20,
  trend_1h:       15,
  bos:            15,
  choch:          10,
  order_block:    15,
  fvg:            10,
  liq_sweep:       5,
  volume_spike:    5,
  rsi:             5,
};

// ─── INDICATOR MATH ───────────────────────────────────────────────────────────

function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    val = (val * (period - 1) + trs[i]) / period;
  }
  return val;
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function parseKlines(raw) {
  return raw.map((k) => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── SMC INDICATORS ───────────────────────────────────────────────────────────

function getTrend(closes, period = 50) {
  const e21 = ema(closes, 21);
  const e50 = ema(closes, period);
  if (!e21.length || !e50.length) return null;
  return e21.at(-1) > e50.at(-1) ? 'bull' : 'bear';
}

function findSwings(candles, strength = 2) {
  const swings = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i], left = candles.slice(i - strength, i), right = candles.slice(i + 1, i + strength + 1);
    if (left.every((x) => c.high > x.high) && right.every((x) => c.high >= x.high)) swings.push({ type: 'high', index: i, price: c.high });
    if (left.every((x) => c.low < x.low) && right.every((x) => c.low <= x.low)) swings.push({ type: 'low', index: i, price: c.low });
  }
  return swings;
}

function detectBOSandCHOCH(candles, lookback = 80) {
  const c = candles.slice(-lookback), swings = findSwings(c, 2);
  const highs = swings.filter((s) => s.type === 'high'), lows = swings.filter((s) => s.type === 'low');
  if (highs.length < 2 || lows.length < 2) return { bos_bull: false, bos_bear: false, choch_bull: false, choch_bear: false };
  const last = c.at(-1), previousHigh = highs.at(-2), previousLow = lows.at(-2);
  const priorTrend = previousHigh.price > highs[0].price && previousLow.price > lows[0].price ? 'bull'
    : previousHigh.price < highs[0].price && previousLow.price < lows[0].price ? 'bear' : 'range';
  const bos_bull = last.close > highs.at(-1).price && last.close > last.open;
  const bos_bear = last.close < lows.at(-1).price && last.close < last.open;
  return { bos_bull, bos_bear, choch_bull: priorTrend === 'bear' && bos_bull, choch_bear: priorTrend === 'bull' && bos_bear,
    brokenLevel: bos_bull ? highs.at(-1).price : bos_bear ? lows.at(-1).price : null,
    recentHigh: highs.at(-1).price, recentLow: lows.at(-1).price };
}

function findOrderBlocks(candles, price, direction, lookback = 30) {
  const c = candles.slice(-lookback);
  const a = atr(c, 14) || 0;
  for (let i = c.length - 4; i >= 2; i--) {
    const ob = c[i], impulse = c.slice(i + 1, i + 3);
    const displacement = Math.abs(impulse.at(-1).close - ob.close) > a * 0.8;
    const bullish = direction === 'bull' && ob.close < ob.open && impulse.at(-1).close > ob.high;
    const bearish = direction === 'bear' && ob.close > ob.open && impulse.at(-1).close < ob.low;
    const fresh = !c.slice(i + 3).some((x) => x.low <= ob.high && x.high >= ob.low);
    if ((bullish || bearish) && displacement && fresh && price >= ob.low && price <= ob.high) return true;
  }
  return false;
}

function findFVG(candles, price, direction, lookback = 20) {
  const c = candles.slice(-lookback);
  for (let i = c.length - 3; i >= 1; i--) {
    const left = c[i - 1], right = c[i + 1];
    const bull = direction === 'bull' && right.low > left.high;
    const bear = direction === 'bear' && right.high < left.low;
    const low = bull ? left.high : right.high, high = bull ? right.low : left.low;
    const mitigated = c.slice(i + 2).some((x) => x.low <= high && x.high >= low);
    if ((bull || bear) && !mitigated && price >= low && price <= high) return true;
  }
  return false;
}

function detectLiquiditySweep(candles, direction, lookback = 20) {
  const c    = candles.slice(-lookback);
  const last = c[c.length - 1];
  const sweep = c[c.length - 2];
  const prev = c.slice(0, -2);
  const swH  = Math.max(...prev.map((x) => x.high));
  const swL  = Math.min(...prev.map((x) => x.low));
  const range = sweep.high - sweep.low, body = Math.abs(last.close - last.open), a = atr(c, 14) || range;
  const rejection = direction === 'bull'
    ? Math.min(sweep.open, sweep.close) - sweep.low > range * 0.35 && last.close > sweep.high
    : sweep.high - Math.max(sweep.open, sweep.close) > range * 0.35 && last.close < sweep.low;
  const displacement = body > a * 0.6;
  if (direction === 'bull') return sweep.low < swL && rejection && displacement;
  if (direction === 'bear') return sweep.high > swH && rejection && displacement;
  return false;
}

function hasVolumeSpike(candles, period = 20) {
  const vols = candles.slice(-period).map((c) => c.volume);
  const avg  = vols.reduce((a, b) => a + b, 0) / vols.length;
  return candles.at(-1).volume > avg * 1.3;
}

function rsiConfirmed(rsiVal, direction) {
  if (direction === 'bull') return rsiVal >= 30 && rsiVal <= 55;
  if (direction === 'bear') return rsiVal >= 45 && rsiVal <= 75;
  return false;
}

function macdConfirmed(closes, direction) {
  const fast = ema(closes, 12), slow = ema(closes, 26);
  if (!fast.length || !slow.length) return false;
  return direction === 'bull' ? fast.at(-1) > slow.at(-1) : fast.at(-1) < slow.at(-1);
}

function isSideways(candles) {
  const closes = candles.map((c) => c.close);
  const e21 = ema(closes, 21).at(-1), e50 = ema(closes, 50).at(-1), a = atr(candles, 14);
  return !e21 || !e50 || !a || Math.abs(e21 - e50) / a < 0.8;
}

// ─── SCORE CALCULATION ────────────────────────────────────────────────────────

function calculateScore(confirmations, direction) {
  let score = 0;
  const c   = confirmations;
  if (c.trend_4h   && c.trend_4h   === direction) score += WEIGHTS.trend_4h;
  if (c.trend_1h   && c.trend_1h   === direction) score += WEIGHTS.trend_1h;
  if (direction === 'bull' ? c.bos_bull   : c.bos_bear)   score += WEIGHTS.bos;
  if ((direction === 'bull' ? c.choch_bull : c.choch_bear) &&
      !(direction === 'bull' ? c.bos_bull : c.bos_bear)) score += WEIGHTS.choch;
  if (c.order_block)  score += WEIGHTS.order_block;
  if (c.fvg)          score += WEIGHTS.fvg;
  if (c.liq_sweep)    score += WEIGHTS.liq_sweep;
  if (c.volume_spike) score += WEIGHTS.volume_spike;
  if (c.rsi)          score += WEIGHTS.rsi;
  return score;
}

function scoreGrade(score) {
  if (score >= SCORE_PREMIUM)   return 'PREMIUM';
  if (score >= SCORE_STRONG)    return 'STRONG';
  if (score >= SCORE_LOW_CONF)  return 'LOW_CONF';
  return 'IGNORE';
}

// ─── POSITION SIZING ──────────────────────────────────────────────────────────

function getRiskPct(score) {
  const {
    RISK_LOW_CONF,
    RISK_STRONG,
    RISK_PREMIUM,
  } = require('./config');

  if (score >= SCORE_PREMIUM) return RISK_PREMIUM;
  if (score >= SCORE_STRONG)  return RISK_STRONG;
  return RISK_LOW_CONF;
}

function calculatePositionSize(balance, riskPct, entry, stopLoss) {
  const riskAmt     = balance * (riskPct / 100);
  const riskPerUnit = Math.abs(entry - stopLoss);
  if (riskPerUnit === 0) return 0;
  return parseFloat((riskAmt / riskPerUnit).toFixed(6));
}

function atrValid(atrVal, price) {
  if (!atrVal || !price) return false;
  const pct = (atrVal / price) * 100;
  return pct >= 0.08 && pct <= 12;
}

// ─── ADAPTIVE TP ENGINE ───────────────────────────────────────────────────────
// Uses ATR volatility regime + S/R swing levels + FVG fills + OB targets
// to produce a TP that is neither too tight nor too greedy.

function findSRSwingLevels(candles, direction, entry, lookback = 60) {
  const c      = candles.slice(-lookback);
  const levels = [];

  for (let i = 2; i < c.length - 2; i++) {
    if (direction === 'bull') {
      if (
        c[i].high > c[i - 1].high && c[i].high > c[i - 2].high &&
        c[i].high > c[i + 1].high && c[i].high > c[i + 2].high &&
        c[i].high > entry
      ) {
        levels.push(c[i].high);
      }
    } else {
      if (
        c[i].low < c[i - 1].low && c[i].low < c[i - 2].low &&
        c[i].low < c[i + 1].low && c[i].low < c[i + 2].low &&
        c[i].low < entry
      ) {
        levels.push(c[i].low);
      }
    }
  }

  return direction === 'bull'
    ? levels.sort((a, b) => a - b)
    : levels.sort((a, b) => b - a);
}

function findFVGTarget(candles, entry, direction, lookback = 40) {
  const c = candles.slice(-lookback);
  for (let i = 1; i < c.length - 1; i++) {
    const prev = c[i - 1], next = c[i + 1];
    if (direction === 'bull' && next.low > prev.high && next.low > entry) {
      return (prev.high + next.low) / 2;
    }
    if (direction === 'bear' && next.high < prev.low && next.high < entry) {
      return (next.high + prev.low) / 2;
    }
  }
  return null;
}

function findOrderBlockTarget(candles, entry, direction, lookback = 50) {
  const c = candles.slice(-lookback);
  for (let i = 1; i < c.length - 1; i++) {
    const prev = c[i - 1], cur = c[i], next = c[i + 1];
    const avgVol = sma(c.slice(0, i).map((x) => x.volume), 5) || 0;
    if (direction === 'bull') {
      if (
        prev.close > prev.open && next.close < next.open &&
        cur.volume > avgVol * 1.3 && prev.high > entry
      ) {
        return prev.high;
      }
    } else {
      if (
        prev.close < prev.open && next.close > next.open &&
        cur.volume > avgVol * 1.3 && prev.low < entry
      ) {
        return prev.low;
      }
    }
  }
  return null;
}

function calculateAdaptiveTP(candles1h, candles15, entry, sl, signalType, atr15) {
  const direction = signalType === 'BUY' ? 'bull' : 'bear';
  const slDist    = Math.abs(entry - sl);
  if (slDist === 0) return signalType === 'BUY' ? entry + atr15 * 3.0 : entry - atr15 * 3.0;

  const atrPct = (atr15 / entry) * 100;

  // Dynamic base ATR multiplier based on volatility regime
  let baseMult;
  if (atrPct >= 2.5)      baseMult = 5.0;
  else if (atrPct >= 1.5) baseMult = 4.0;
  else if (atrPct >= 0.8) baseMult = 3.5;
  else if (atrPct >= 0.4) baseMult = 3.0;
  else                     baseMult = 2.5;

  const baseTP = signalType === 'BUY'
    ? entry + atr15 * baseMult
    : entry - atr15 * baseMult;

  // Collect TP candidates with their sources
  const candidates = [{ price: baseTP, rr: Math.abs(baseTP - entry) / slDist, source: 'ATR' }];

  // 1. S/R swing levels from 1h candles
  const srLevels = findSRSwingLevels(candles1h, direction, entry, 60);
  for (const lvl of srLevels.slice(0, 4)) {
    const rr = Math.abs(lvl - entry) / slDist;
    if (rr >= 1.5) candidates.push({ price: lvl, rr, source: 'SR' });
  }

  // 2. FVG fill target from 1h
  const fvg1h = findFVGTarget(candles1h, entry, direction, 40);
  if (fvg1h) {
    const rr = Math.abs(fvg1h - entry) / slDist;
    if (rr >= 1.5) candidates.push({ price: fvg1h, rr, source: 'FVG_1H' });
  }

  // 3. FVG fill from 15m (closer-term)
  const fvg15 = findFVGTarget(candles15, entry, direction, 30);
  if (fvg15) {
    const rr = Math.abs(fvg15 - entry) / slDist;
    if (rr >= 1.5) candidates.push({ price: fvg15, rr, source: 'FVG_15M' });
  }

  // 4. Order block target from 1h
  const obTarget = findOrderBlockTarget(candles1h, entry, direction, 50);
  if (obTarget) {
    const rr = Math.abs(obTarget - entry) / slDist;
    if (rr >= 1.5) candidates.push({ price: obTarget, rr, source: 'OB' });
  }

  // Select the candidate closest to RR = 3.0 (balanced between conservative & greedy)
  // but not below MIN_RR = 1.5
  const targetRR = 3.0;
  candidates.sort((a, b) => Math.abs(a.rr - targetRR) - Math.abs(b.rr - targetRR));

  const chosen = candidates[0];
  logger.debug(`[ADAPTIVE-TP] ${signalType} entry:${entry.toFixed(4)} sl:${sl.toFixed(4)} tp:${chosen.price.toFixed(4)} rr:${chosen.rr.toFixed(2)} src:${chosen.source} atrPct:${atrPct.toFixed(2)}%`);
  return chosen.price;
}

// ─── MAIN ANALYSIS ────────────────────────────────────────────────────────────

async function analyzeSymbol(client, symbol) {
  try {
    const [raw4h, raw1h, raw15] = await Promise.all([
      client.getKlines(symbol, '4h', 100),
      client.getKlines(symbol, '1h', 200),
      client.getKlines(symbol, '15m', 200),
    ]);

    if (!raw4h || raw4h.length < 30) return null;
    if (!raw1h || raw1h.length < 60) return null;
    if (!raw15 || raw15.length < 60) return null;

    // Binance returns the currently forming candle last. It is never valid
    // evidence for structure, indicators, or an entry decision.
    const c4h  = parseKlines(raw4h).slice(0, -1);
    const c1h  = parseKlines(raw1h).slice(0, -1);
    const c15  = parseKlines(raw15).slice(0, -1);

    const closes4h = c4h.map((c) => c.close);
    const closes1h = c1h.map((c) => c.close);
    const closes15 = c15.map((c) => c.close);
     const price    = closes15.at(-1);

    const atr15 = atr(c15, 14);
    if (!atrValid(atr15, price)) return null;

    const trend4h = getTrend(closes4h, 50);
    const trend1h = getTrend(closes1h, 50);
    if (!trend4h) return null;

     const trendsAgree = trend4h === trend1h;
     const choppy = isSideways(c1h);

    const rsi15 = rsi(closes15, 14);
    if (rsi15 === null) return null;

    const struct = detectBOSandCHOCH(c1h, 30);

    const checkDir = (dir) => {
      const confs = {
        trend_4h:     trend4h,
        trend_1h:     trend1h,
        bos_bull:     struct.bos_bull,
        bos_bear:     struct.bos_bear,
        choch_bull:   struct.choch_bull,
        choch_bear:   struct.choch_bear,
        order_block:  findOrderBlocks(c1h, price, dir, 30),
        fvg:          findFVG(c1h, price, dir, 20),
        liq_sweep:    detectLiquiditySweep(c1h, dir, 20),
         volume_spike: hasVolumeSpike(c15, 20),
        rsi:          rsiConfirmed(rsi15, dir),
         macd:         macdConfirmed(closes15, dir),
        rsi_value:    rsi15,
        atr:          atr15,
      };
      const score = calculateScore(confs, dir);
      return { confs, score };
    };

    const bull = checkDir('bull');
    const bear = checkDir('bear');

    let direction = null;
    let chosen    = null;

    if (bull.score > bear.score && bull.score >= SCORE_LOW_CONF) {
      direction = 'bull'; chosen = bull;
    } else if (bear.score > bull.score && bear.score >= SCORE_LOW_CONF) {
      direction = 'bear'; chosen = bear;
    }
     if (!direction || !chosen || choppy) {
       logger.info(`[SIGNAL-DECISION] ${symbol} Direction:${direction || 'NONE'} 4H:${trend4h} 1H:${trend1h} Market:${choppy ? 'SIDEWAYS' : 'TRENDING'} FINAL DECISION: REJECTED Reason: ${choppy ? 'Sideways/choppy market' : 'No directional setup'}`);
       return null;
     }

    const { confs, score } = chosen;
    const grade = scoreGrade(score);
    if (grade === 'IGNORE') return null;

    const hasBOS   = direction === 'bull' ? confs.bos_bull : confs.bos_bear;
    const hasCHOCH = direction === 'bull' ? confs.choch_bull : confs.choch_bear;
    const volOk    = confs.volume_spike;
     const sweepOk = confs.liq_sweep;
     const displacementOk = hasBOS || hasCHOCH;
     const canTrade = score >= SCORE_MIN_TRADE && trendsAgree && hasBOS && sweepOk && displacementOk &&
       confs.order_block && confs.fvg && volOk && confs.rsi && confs.macd;

    const signalType = direction === 'bull' ? 'BUY' : 'SELL';

    const entry = price;
     const structureStop = direction === 'bull'
       ? Math.min(struct.recentLow || entry, entry - atr15 * SL_ATR_MULT)
       : Math.max(struct.recentHigh || entry, entry + atr15 * SL_ATR_MULT);
     const sl = structureStop;

    // Adaptive TP using ATR regime + S/R + FVG + OB
    const tp = calculateAdaptiveTP(c1h, c15, entry, sl, signalType, atr15);

    const slDist = Math.abs(entry - sl);
    const rrRaw  = Math.abs(tp - entry) / slDist;
    const rr     = parseFloat(rrRaw.toFixed(2));
    const rrOk   = rr >= MIN_RR;

    logger.info(`[SIGNAL-DECISION] ${symbol} Direction:${signalType} 4H:${trend4h} 1H:${trend1h} BOS:${hasBOS} CHOCH:${hasCHOCH} LiquiditySweep:${confs.liq_sweep} Displacement:${displacementOk} OB:${confs.order_block} FVG:${confs.fvg} RSI:${confs.rsi} Volume:${confs.volume_spike} Market:${choppy ? 'SIDEWAYS' : 'TRENDING'} RR:${rr} FINAL DECISION: ${canTrade && rrOk ? 'VALID SIGNAL' : 'REJECTED'}${!(canTrade && rrOk) ? ` Reason: ${!trendsAgree ? 'HTF disagreement' : !confs.liq_sweep ? 'No valid liquidity sweep' : !rrOk ? 'RR below 1:2' : 'Missing confirmation'}` : ''}`);
    return {
      symbol,
      signal:    signalType,
      direction,
      entry:     parseFloat(entry.toFixed(8)),
      sl:        parseFloat(sl.toFixed(8)),
      tp:        parseFloat(tp.toFixed(8)),
      rr,
      score,
      grade,
       canTrade:  canTrade && rrOk,
      trendsAgree,
      confirmations: {
        trend_4h:     trend4h === direction,
        trend_1h:     trend1h === direction,
        bos:          hasBOS,
        choch:        hasCHOCH,
        order_block:  confs.order_block,
        fvg:          confs.fvg,
        liq_sweep:    confs.liq_sweep,
        volume_spike: confs.volume_spike,
         rsi:          confs.rsi,
         macd:         confs.macd,
         market_condition: choppy ? 'SIDEWAYS' : 'TRENDING',
      },
      rsi_value: rsi15.toFixed(1),
      atr:       atr15,
    };
  } catch (err) {
    logger.debug(`Analysis skipped ${symbol}`, { err: err.message });
    return null;
  }
}

module.exports = {
  analyzeSymbol,
  calculatePositionSize,
  calculateAdaptiveTP,
  getRiskPct,
  scoreGrade,
  parseKlines,
  ema,
  rsi,
  atr,
  findSwings,
  detectBOSandCHOCH,
  detectLiquiditySweep,
  findOrderBlocks,
  findFVG,
  isSideways,
  WEIGHTS,
};
