require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;

// ═══════════════════════════════════════
// CACHE SYSTEM
// ═══════════════════════════════════════
let trendingCache = { data: [], time: 0 };
let volumeCache = { data: [], time: 0 };
const CACHE_MS = 60 * 1000;

async function getTrending() {
  if (Date.now() - trendingCache.time < CACHE_MS && trendingCache.data.length > 0) {
    return trendingCache.data;
  }
  const res = await axios.get(
    'https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20',
    { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
  );
  trendingCache = { data: res.data?.data?.tokens || [], time: Date.now() };
  return trendingCache.data;
}

async function getVolumeList() {
  if (Date.now() - volumeCache.time < CACHE_MS * 5 && volumeCache.data.length > 0) {
    return volumeCache.data;
  }
  try {
    await new Promise(r => setTimeout(r, 1000));
    const res = await axios.get(
      'https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=20&min_liquidity=100',
      { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' } }
    );
    const tokens = (res.data?.data?.tokens || []).map(t => ({
      ...t,
      volume24hUSD: t.v24hUSD || 0,
      price24hChangePercent: t.v24hChangePercent || 0,
      volume24hChangePercent: t.v24hChangePercent || 0,
    }));
    volumeCache = { data: tokens, time: Date.now() };
    return tokens;
  } catch {
    return volumeCache.data || [];
  }
}

async function searchToken(symbol) {
  try {
    const trending = await getTrending();
    const found = trending.find(t => t.symbol?.toLowerCase() === symbol.toLowerCase());
    if (found) return found;
    const volume = await getVolumeList();
    return volume.find(t => t.symbol?.toLowerCase() === symbol.toLowerCase()) || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════
// SIGNAL LOG — for /accuracy tracking
// ═══════════════════════════════════════
const signalLog = []; // { symbol, price, time, conditions, strength }

function logSignal(token, conditions, strength) {
  // Remove duplicate if already logged in last 4 hours
  const existing = signalLog.find(s =>
    s.symbol === token.symbol &&
    Date.now() - s.time < 4 * 60 * 60 * 1000
  );
  if (existing) return;

  signalLog.push({
    symbol: token.symbol,
    price: token.price,
    time: Date.now(),
    conditions,
    strength,
    resolved: false,
    result: null,
    exitPrice: null,
  });

  // Keep only last 50 signals
  if (signalLog.length > 50) signalLog.shift();
}

// Resolve signals older than 4 hours
async function resolveSignals() {
  const now = Date.now();
  const tokens = await getTrending().catch(() => []);

  signalLog.forEach(signal => {
    if (signal.resolved) return;
    if (now - signal.time < 4 * 60 * 60 * 1000) return;

    const current = tokens.find(t => t.symbol === signal.symbol);
    if (!current) {
      signal.resolved = true;
      signal.result = 'unknown';
      return;
    }

    const change = ((current.price - signal.price) / signal.price) * 100;
    signal.resolved = true;
    signal.exitPrice = current.price;
    signal.priceChange = change;
    signal.result = change >= 20 ? 'win' : change <= -10 ? 'loss' : 'neutral';
  });
}

// ═══════════════════════════════════════
// SCORING ALGORITHMS
// ═══════════════════════════════════════
function calcRisk(token) {
  let score = 100;
  const reasons = [];
  const liq = token.liquidity || 0;
  const vol = token.volume24hUSD || token.v24hUSD || 0;
  const priceChange = Math.abs(token.price24hChangePercent || 0);
  const volChange = Math.abs(token.volume24hChangePercent || 0);

  if (liq < 10000) { score -= 35; reasons.push('⚠️ Very low liquidity'); }
  else if (liq < 50000) { score -= 20; reasons.push('⚠️ Low liquidity'); }
  else if (liq < 200000) { score -= 10; reasons.push('📊 Moderate liquidity'); }
  else reasons.push('✅ Good liquidity');

  if (liq > 0 && vol / liq > 100) { score -= 20; reasons.push('⚠️ Suspicious vol/liq ratio'); }
  if (priceChange > 5000) { score -= 30; reasons.push('🚨 Extreme pump'); }
  else if (priceChange > 1000) { score -= 20; reasons.push('⚠️ Very high pump'); }
  else if (priceChange > 200) { score -= 10; reasons.push('📈 High pump'); }
  else reasons.push('✅ Stable price action');
  if (volChange > 10000) { score -= 15; reasons.push('🤖 Bot volume suspected'); }
  else if (volChange > 500) reasons.push('🐋 Whale activity detected');

  const fdv = token.fdv || token.mc || token.marketcap || 0;
  if (fdv < 50000) { score -= 15; reasons.push('⚠️ Micro cap'); }
  else if (fdv < 500000) { score -= 5; reasons.push('📊 Small cap'); }
  else reasons.push('✅ Decent market cap');

  score = Math.max(0, Math.min(100, score));
  const label = score >= 70 ? '🟢 SAFE' : score >= 40 ? '🟡 CAUTION' : '🔴 RISKY';
  return { score, label, reasons };
}

function calcMomentum(token) {
  const priceChange = token.price24hChangePercent || 0;
  const volChange = token.volume24hChangePercent || 0;
  const liq = token.liquidity || 1;
  if (priceChange <= 0) return 0;
  let score = 0;
  score += Math.min(40, priceChange / 100 * 10);
  score += Math.min(30, Math.max(0, volChange) / 100 * 8);
  score += Math.min(30, Math.log10(liq + 1) * 5);
  return Math.min(100, Math.round(score));
}

function calcAlpha(token) {
  const { score: safety } = calcRisk(token);
  const momentum = calcMomentum(token);
  const volChange = token.volume24hChangePercent || 0;
  const volBonus = Math.min(20, volChange / 100 * 5);
  return Math.min(100, Math.round(safety * 0.4 + momentum * 0.4 + volBonus * 0.2));
}

function calcFearGreed(tokens) {
  if (!tokens.length) return { score: 50, label: 'Neutral', emoji: '😐' };
  const avgChange = tokens.reduce((s, t) => s + (t.price24hChangePercent || 0), 0) / tokens.length;
  const gainers = tokens.filter(t => (t.price24hChangePercent || 0) > 0).length;
  let score = 50 + Math.min(25, avgChange / 100 * 5) + (gainers / tokens.length - 0.5) * 30;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 75 ? 'Extreme Greed' : score >= 60 ? 'Greed' : score >= 40 ? 'Neutral' : score >= 25 ? 'Fear' : 'Extreme Fear';
  const emoji = score >= 75 ? '😱' : score >= 60 ? '😀' : score >= 40 ? '😐' : score >= 25 ? '😨' : '😰';
  return { score, label, emoji };
}

// ═══════════════════════════════════════
// UPGRADED MULTI-TRIGGER SIGNAL SYSTEM
// ═══════════════════════════════════════
function evaluateSignal(token) {
  const conditions = [];
  const reasons = [];
  let conditionsMet = 0;

  const volChange = token.volume24hChangePercent || 0;
  const priceChange = token.price24hChangePercent || 0;
  const liq = token.liquidity || 0;
  const { score: safety } = calcRisk(token);
  const momentum = calcMomentum(token);
  const alpha = calcAlpha(token);

  // CONDITION 1: Volume Spike (MANDATORY)
  const hasVolSpike = volChange > 120;
  if (hasVolSpike) {
    conditionsMet++;
    conditions.push({ met: true, text: `+ Volume +${volChange.toFixed(0)}% spike` });
    reasons.push(`Volume surging +${volChange.toFixed(0)}%`);
  } else {
    conditions.push({ met: false, text: `- Volume spike insufficient (+${volChange.toFixed(0)}%)` });
  }

  // CONDITION 2: Price Momentum
  const hasPriceMomentum = priceChange > 8;
  if (hasPriceMomentum) {
    conditionsMet++;
    conditions.push({ met: true, text: `+ Price +${priceChange.toFixed(1)}% momentum` });
    reasons.push(`Price up +${priceChange.toFixed(1)}%`);
  } else {
    conditions.push({ met: false, text: `- Price momentum weak (+${priceChange.toFixed(1)}%)` });
  }

  // CONDITION 3: Liquidity Stability (not dropping)
  const liqStable = liq > 20000;
  if (liqStable) {
    conditionsMet++;
    conditions.push({ met: true, text: `+ Liquidity stable ($${(liq / 1000).toFixed(0)}K)` });
    reasons.push('Liquidity stable');
  } else {
    conditions.push({ met: false, text: `- Liquidity too low/unstable ($${(liq / 1000).toFixed(0)}K)` });
  }

  // CONDITION 4: Trade Activity (high volume vs liquidity = people rushing in)
  const vol = token.volume24hUSD || 0;
  const tradeActivity = liq > 0 && vol / liq > 1;
  if (tradeActivity) {
    conditionsMet++;
    const ratio = (vol / liq).toFixed(1);
    conditions.push({ met: true, text: `+ Trade activity spike (${ratio}x vol/liq)` });
    reasons.push(`Trade activity ${ratio}x above liquidity`);
  } else {
    conditions.push({ met: false, text: `- Trade activity low` });
  }

  // CONDITION 5: Safety Score
  const isSafe = safety >= 65;
  if (isSafe) {
    conditionsMet++;
    conditions.push({ met: true, text: `+ Safety score ${safety}/100` });
    reasons.push(`Safety ${safety}/100`);
  } else {
    conditions.push({ met: false, text: `- Safety score too low (${safety}/100)` });
  }

  // MANDATORY: Volume spike must be present
  if (!hasVolSpike) return null;

  // Need at least 3 conditions
  if (conditionsMet < 3) return null;

  const strength = conditionsMet >= 4 ? 'STRONG' : 'EARLY';

  return {
    token,
    strength,
    conditionsMet,
    conditions,
    reasons,
    alpha,
    safety,
    momentum,
    priceChange,
    volChange,
    liq,
  };
}

// EXIT SIGNAL DETECTION
function evaluateExit(token) {
  const volChange = token.volume24hChangePercent || 0;
  const priceChange = token.price24hChangePercent || 0;
  const liq = token.liquidity || 0;

  const warnings = [];
  let exitScore = 0;

  if (volChange < -30) {
    exitScore++;
    warnings.push(`- Volume fading (${volChange.toFixed(0)}%)`);
  }
  if (priceChange < 0) {
    exitScore++;
    warnings.push(`- Price losing momentum (${priceChange.toFixed(1)}%)`);
  }
  if (liq < 15000) {
    exitScore++;
    warnings.push(`- Liquidity dropping ($${(liq / 1000).toFixed(0)}K)`);
  }

  if (exitScore >= 2) return warnings;
  return null;
}

// ═══════════════════════════════════════
// ALERT SYSTEM
// ═══════════════════════════════════════
const priceAlerts = new Map();
const subscribedChats = new Set();

// ═══════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════

// /start
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'trader';
  bot.sendMessage(msg.chat.id, `
🐦 *Welcome to BirdBot Alpha, ${name}!*

Real-time Solana trading signals powered by Birdeye Data API.

*Core Commands:*
/signals — 🚨 Multi-trigger BUY signals
/exit — ⚠️ EXIT signal detection
/analyze SYMBOL — 🔍 Deep token analysis
/compare SYM1 SYM2 — ⚔️ Token battle
/whale — 🐋 Whale volume alerts
/accuracy — 📊 Signal win/loss tracker
/market — 📈 Market dashboard
/fear — 😨 Fear & Greed index
/top3 — 🏆 Top alpha picks
/trending — 🔥 Top trending tokens
/setalert SYMBOL 20 — 🔔 Price alerts
/subscribe — Auto alerts

_Built by Aditya Chotaliya 🚀_
  `, { parse_mode: 'Markdown' });
});

// /signals — UPGRADED MULTI-TRIGGER
bot.onText(/\/signals/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔍 Scanning multi-trigger signals...');
  try {
    const tokens = await getTrending();
    const signals = tokens
      .map(t => evaluateSignal(t))
      .filter(Boolean)
      .sort((a, b) => b.conditionsMet - a.conditionsMet || b.alpha - a.alpha)
      .slice(0, 5);

    if (signals.length === 0) {
      bot.sendMessage(chatId, `🔍 *No signals detected right now*\n\nConditions not aligned. Market may be:\n• Too quiet (low volume)\n• In fear mode\n• Waiting for catalyst\n\nCheck back in 15-30 minutes.\n_Use /fear to see sentiment_`, { parse_mode: 'Markdown' });
      return;
    }

    for (const signal of signals) {
      const { token, strength, conditionsMet, conditions, alpha, safety, momentum, priceChange, volChange, liq } = signal;
      const price = token.price < 0.001 ? token.price.toExponential(3) : token.price.toFixed(4);
      const strengthEmoji = strength === 'STRONG' ? '🚨' : '⚡';
      const strengthLabel = strength === 'STRONG' ? 'STRONG ALPHA SIGNAL' : 'EARLY SIGNAL';
      const risk = safety >= 80 ? 'Low' : safety >= 60 ? 'Medium' : 'High';
      const status = priceChange > 50 ? 'HIGH MOMENTUM — WATCH ENTRY' : priceChange > 20 ? 'MOMENTUM BUILDING — WATCH CLOSELY' : 'EARLY STAGE — MONITOR';

      let message = `${strengthEmoji} *${strengthLabel}*\n\n`;
      message += `Token: *${token.symbol}*\n`;
      message += `Alpha Score: *${alpha}/100*\n`;
      message += `Conditions: *${conditionsMet}/5 met*\n\n`;
      message += `*Why this triggered:*\n`;
      conditions.filter(c => c.met).forEach(c => { message += `${c.text}\n`; });
      message += `\n*Status:* ${status}\n\n`;
      message += `💲 Price: $${price}\n`;
      message += `🛡️ Safety: ${safety}/100 | ⚡ Momentum: ${momentum}/100\n`;
      message += `Risk: *${risk}*\n\n`;
      message += `⚠️ _Not financial advice. Always DYOR!_`;

      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

      // Log signal for accuracy tracking
      logSignal(token, conditions.filter(c => c.met).map(c => c.text), strength);

      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Error scanning signals. Try again in 30 seconds.');
  }
});

// /exit — EXIT SIGNAL DETECTION
bot.onText(/\/exit/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '⚠️ Scanning for exit signals...');
  try {
    const tokens = await getTrending();
    const exits = tokens
      .filter(t => {
        const warnings = evaluateExit(t);
        return warnings && warnings.length >= 2;
      })
      .map(t => ({ token: t, warnings: evaluateExit(t) }))
      .slice(0, 5);

    if (exits.length === 0) {
      bot.sendMessage(chatId, `✅ *No exit signals detected*\n\nAll trending tokens show stable patterns.\nNo immediate exit pressure detected.\n\n_Use /signals to find entry opportunities_`, { parse_mode: 'Markdown' });
      return;
    }

    let message = `⚠️ *EXIT SIGNALS DETECTED*\n\n`;
    exits.forEach(({ token, warnings }) => {
      const price = token.price < 0.001 ? token.price.toExponential(3) : token.price.toFixed(4);
      message += `*${token.symbol}*\n`;
      message += `💲 $${price}\n`;
      message += `*Warning signs:*\n`;
      warnings.forEach(w => { message += `${w}\n`; });
      message += `\n*Action:* CONSIDER EXIT / TAKE PROFIT\n\n`;
    });
    message += `⚠️ _Not financial advice. Always DYOR!_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error scanning exits. Try again.');
  }
});

// /accuracy — SIGNAL TRACKER
bot.onText(/\/accuracy/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await resolveSignals();

    const total = signalLog.length;
    if (total === 0) {
      bot.sendMessage(chatId, `📊 *Signal Accuracy Tracker*\n\nNo signals logged yet.\n\nRun /signals a few times throughout the day.\nResults resolve after 4 hours.\n\n_Come back later for stats!_`, { parse_mode: 'Markdown' });
      return;
    }

    const resolved = signalLog.filter(s => s.resolved && s.result !== 'unknown');
    const wins = resolved.filter(s => s.result === 'win');
    const losses = resolved.filter(s => s.result === 'loss');
    const neutral = resolved.filter(s => s.result === 'neutral');
    const pending = signalLog.filter(s => !s.resolved);

    const winRate = resolved.length > 0 ? ((wins.length / resolved.length) * 100).toFixed(0) : 0;
    const avgWin = wins.length > 0
      ? (wins.reduce((s, w) => s + w.priceChange, 0) / wins.length).toFixed(1)
      : 0;
    const avgLoss = losses.length > 0
      ? (losses.reduce((s, l) => s + l.priceChange, 0) / losses.length).toFixed(1)
      : 0;

    let message = `📊 *BirdBot Signal Accuracy Report*\n\n`;
    message += `*Overall Stats:*\n`;
    message += `Total signals: ${total}\n`;
    message += `✅ Wins (>20%): ${wins.length}\n`;
    message += `❌ Losses (<-10%): ${losses.length}\n`;
    message += `⚖️ Neutral: ${neutral.length}\n`;
    message += `⏳ Pending (4h): ${pending.length}\n\n`;

    if (resolved.length > 0) {
      message += `*Performance:*\n`;
      message += `Win Rate: *${winRate}%*\n`;
      if (wins.length > 0) message += `Avg Win: +${avgWin}%\n`;
      if (losses.length > 0) message += `Avg Loss: ${avgLoss}%\n\n`;
    }

    if (wins.length > 0) {
      message += `*Recent Wins:*\n`;
      wins.slice(-3).forEach(w => {
        message += `🏆 ${w.symbol}: +${w.priceChange?.toFixed(1)}%\n`;
      });
      message += '\n';
    }

    if (pending.length > 0) {
      message += `*Pending Signals:*\n`;
      pending.slice(-3).forEach(p => {
        const age = Math.floor((Date.now() - p.time) / 60000);
        message += `⏳ ${p.symbol} — ${age}min ago (${p.strength})\n`;
      });
    }

    message += `\n_Signals resolve after 4 hours_\n`;
    message += `_Powered by Birdeye Data API_`;

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error loading accuracy data. Try again.');
  }
});

// /whale
bot.onText(/\/whale/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🐋 Detecting whale activity...');
  try {
    const tokens = await getTrending();
    const whales = tokens
      .filter(t => (t.volume24hChangePercent || 0) > 300 && (t.volume24hUSD || 0) > 10000)
      .sort((a, b) => (b.volume24hChangePercent || 0) - (a.volume24hChangePercent || 0))
      .slice(0, 5);

    if (whales.length === 0) {
      bot.sendMessage(chatId, '🐋 No major whale activity right now.\n\nMarket is quiet. Check back in 30 minutes.\n\n_/subscribe for auto alerts_');
      return;
    }

    let message = '🐋 *Whale Alert — Volume Spikes Detected!*\n\n';
    whales.forEach((token, i) => {
      const { score, label } = calcRisk(token);
      const volChange = (token.volume24hChangePercent || 0).toFixed(0);
      const vol = ((token.volume24hUSD || 0) / 1_000_000).toFixed(2);
      const price = token.price < 0.001 ? token.price.toExponential(2) : token.price.toFixed(4);
      const change = (token.price24hChangePercent || 0);
      message += `*${i + 1}. ${token.symbol}* ${label}\n`;
      message += `📊 Volume: +${volChange}%\n`;
      message += `💰 $${vol}M traded\n`;
      message += `💲 $${price} | ${change > 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}%\n\n`;
    });
    message += `_Use /analyze SYMBOL for full breakdown_\n`;
    message += `_⚠️ High volume = pump OR dump — DYOR!_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error fetching whale data. Try again.');
  }
});

// /analyze
bot.onText(/\/analyze (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase().trim();
  bot.sendMessage(chatId, `🔍 Analyzing *${symbol}*...`, { parse_mode: 'Markdown' });
  try {
    const token = await searchToken(symbol);
    if (!token) {
      bot.sendMessage(chatId, `❌ *${symbol}* not found.\n\nTry: /trending for available tokens`, { parse_mode: 'Markdown' });
      return;
    }

    const { score, label, reasons } = calcRisk(token);
    const momentum = calcMomentum(token);
    const alpha = calcAlpha(token);
    const signal = evaluateSignal(token);
    const exitWarnings = evaluateExit(token);
    const isUp = (token.price24hChangePercent || 0) > 0;
    const change = (token.price24hChangePercent || 0).toFixed(2);
    const vol = ((token.volume24hUSD || 0) / 1_000_000).toFixed(2);
    const liq = ((token.liquidity || 0) / 1000).toFixed(0);
    const volChange = (token.volume24hChangePercent || 0).toFixed(0);
    const price = token.price < 0.001 ? token.price.toExponential(3) : token.price.toFixed(4);

    let recommendation = '';
    if (signal) {
      recommendation = signal.strength === 'STRONG'
        ? '🚨 *STRONG SIGNAL* — Multi-condition aligned. Watch closely.'
        : '⚡ *EARLY SIGNAL* — Conditions building. Monitor entry.';
    } else if (exitWarnings) {
      recommendation = '⚠️ *EXIT CAUTION* — Warning signs detected. Consider taking profits.';
    } else if (score >= 70 && isUp) {
      recommendation = '✅ *WATCHLIST* — Safe with positive momentum.';
    } else if (score < 40) {
      recommendation = '🚨 *AVOID* — High risk detected.';
    } else {
      recommendation = '🟡 *RESEARCH* — Moderate conditions. Do your homework.';
    }

    let message = `🐦 *${token.symbol} Deep Analysis*\n_${token.name}_\n\n`;
    message += `💲 *Price:* $${price}\n`;
    message += `${isUp ? '▲' : '▼'} *24h:* ${isUp ? '+' : ''}${change}%\n`;
    message += `💰 *Volume:* $${vol}M (+${volChange}%)\n`;
    message += `💧 *Liquidity:* $${liq}K\n\n`;
    message += `━━━━━━━━━━━━━━━\n`;
    message += `🏆 *Alpha Score: ${alpha}/100*\n`;
    message += `🛡️ Safety: ${score}/100 ${label}\n`;
    message += `⚡ Momentum: ${momentum}/100\n\n`;
    message += `*Risk Breakdown:*\n`;
    reasons.slice(0, 3).forEach(r => { message += `${r}\n`; });
    message += `\n${recommendation}\n\n`;
    message += `⚠️ _Not financial advice. Always DYOR!_`;

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error analyzing. Try again in 30 seconds.');
  }
});

// /compare
bot.onText(/\/compare (\S+) (\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symA = match[1].toUpperCase();
  const symB = match[2].toUpperCase();
  bot.sendMessage(chatId, `⚔️ Comparing *${symA}* vs *${symB}*...`, { parse_mode: 'Markdown' });
  try {
    const [tokenA, tokenB] = await Promise.all([searchToken(symA), searchToken(symB)]);
    if (!tokenA || !tokenB) {
      const trending = await getTrending();
      const symbols = trending.slice(0, 5).map(t => t.symbol).join(', ');
      const missing = !tokenA ? symA : symB;
      bot.sendMessage(chatId, `❌ *${missing}* not found.\n\nTry: /compare ${trending[0]?.symbol} ${trending[1]?.symbol}\nCurrent trending: ${symbols}`, { parse_mode: 'Markdown' });
      return;
    }

    const riskA = calcRisk(tokenA);
    const riskB = calcRisk(tokenB);
    const momA = calcMomentum(tokenA);
    const momB = calcMomentum(tokenB);
    const alphaA = calcAlpha(tokenA);
    const alphaB = calcAlpha(tokenB);
    const winner = alphaA > alphaB ? symA : symB;
    const w = (a, b) => a >= b ? '🏆' : '  ';

    let message = `⚔️ *${symA} vs ${symB}*\n\n`;
    message += `*Alpha Score:*\n`;
    message += `${w(alphaA, alphaB)} ${symA}: ${alphaA}/100\n`;
    message += `${w(alphaB, alphaA)} ${symB}: ${alphaB}/100\n\n`;
    message += `*Safety:*\n`;
    message += `${w(riskA.score, riskB.score)} ${symA}: ${riskA.score}/100 ${riskA.label}\n`;
    message += `${w(riskB.score, riskA.score)} ${symB}: ${riskB.score}/100 ${riskB.label}\n\n`;
    message += `*Momentum:*\n`;
    message += `${w(momA, momB)} ${symA}: ${momA}/100\n`;
    message += `${w(momB, momA)} ${symB}: ${momB}/100\n\n`;
    message += `*24h Change:*\n`;
    message += `${w(tokenA.price24hChangePercent || 0, tokenB.price24hChangePercent || 0)} ${symA}: +${(tokenA.price24hChangePercent || 0).toFixed(1)}%\n`;
    message += `${w(tokenB.price24hChangePercent || 0, tokenA.price24hChangePercent || 0)} ${symB}: +${(tokenB.price24hChangePercent || 0).toFixed(1)}%\n\n`;
    message += `*Volume:*\n`;
    message += `${w(tokenA.volume24hUSD || 0, tokenB.volume24hUSD || 0)} ${symA}: $${((tokenA.volume24hUSD || 0) / 1e6).toFixed(2)}M\n`;
    message += `${w(tokenB.volume24hUSD || 0, tokenA.volume24hUSD || 0)} ${symB}: $${((tokenB.volume24hUSD || 0) / 1e6).toFixed(2)}M\n\n`;
    message += `🏆 *Winner: ${winner}*\n\n`;
    message += `⚠️ _Not financial advice. Always DYOR!_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error comparing. Try again.');
  }
});

// /top3
bot.onText(/\/top3/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🏆 Finding top 3 alpha opportunities...');
  try {
    const tokens = await getTrending();
    const ranked = tokens
      .map(t => ({ ...t, risk: calcRisk(t), momentum: calcMomentum(t), alpha: calcAlpha(t) }))
      .filter(t => t.risk.score >= 60)
      .sort((a, b) => b.alpha - a.alpha)
      .slice(0, 3);

    if (ranked.length === 0) {
      bot.sendMessage(chatId, '🏆 No strong opportunities right now.\n\nCheck /fear for sentiment.');
      return;
    }

    let message = `🏆 *Top 3 Alpha Picks — Right Now*\n_Ranked by Alpha Score_\n\n`;
    const medals = ['🥇', '🥈', '🥉'];
    ranked.forEach((token, i) => {
      const change = (token.price24hChangePercent || 0).toFixed(1);
      const price = token.price < 0.001 ? token.price.toExponential(2) : token.price.toFixed(4);
      message += `${medals[i]} *${token.symbol}* — Alpha ${token.alpha}/100\n`;
      message += `💲 $${price} | ▲ +${change}%\n`;
      message += `🛡️ ${token.risk.score}/100 | ⚡ ${token.momentum}/100\n\n`;
    });
    message += `_Use /analyze SYMBOL for full breakdown_\n`;
    message += `⚠️ _Not financial advice. Always DYOR!_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error finding top picks. Try again.');
  }
});

// /fear
bot.onText(/\/fear/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const tokens = await getTrending();
    const { score, label, emoji } = calcFearGreed(tokens);
    const bar = '█'.repeat(Math.floor(score / 10)) + '░'.repeat(10 - Math.floor(score / 10));
    const gainers = tokens.filter(t => (t.price24hChangePercent || 0) > 0).length;

    let message = `${emoji} *Solana Fear & Greed Index*\n\n`;
    message += `*${label}* — Score: *${score}/100*\n`;
    message += `\`${bar}\`\n\n`;
    message += `🟢 Gainers: ${gainers} | 🔴 Losers: ${tokens.length - gainers}\n\n`;
    if (score >= 75) message += `🚨 _Extreme greed — consider taking profits_`;
    else if (score >= 60) message += `📈 _Greed — momentum strong, stay cautious_`;
    else if (score >= 40) message += `⚖️ _Neutral — research entries carefully_`;
    else message += `📉 _Fear — potential buying opportunity_`;

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error. Try again.');
  }
});

// /market
bot.onText(/\/market/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '📊 Building market dashboard...');
  try {
    const tokens = await getTrending();
    const { score, label, emoji } = calcFearGreed(tokens);
    const gainers = tokens.filter(t => (t.price24hChangePercent || 0) > 0);
    const whales = tokens.filter(t => (t.volume24hChangePercent || 0) > 300);
    const signals = tokens.map(t => evaluateSignal(t)).filter(Boolean);
    const exits = tokens.filter(t => evaluateExit(t));
    const totalVol = tokens.reduce((s, t) => s + (t.volume24hUSD || 0), 0);
    const topGainer = [...tokens].sort((a, b) => (b.price24hChangePercent || 0) - (a.price24hChangePercent || 0))[0];

    let message = `📊 *Solana Market Dashboard*\n_${new Date().toLocaleTimeString()}_\n\n`;
    message += `${emoji} Sentiment: *${label}* (${score}/100)\n\n`;
    message += `━━━━━━━━━━━━━━━\n`;
    message += `🟢 Gainers: ${gainers.length} | 🔴 Losers: ${tokens.length - gainers.length}\n`;
    message += `🐋 Whale alerts: ${whales.length}\n`;
    message += `🎯 Active signals: ${signals.length}\n`;
    message += `⚠️ Exit warnings: ${exits.length}\n`;
    message += `💰 Total Vol: $${(totalVol / 1_000_000).toFixed(1)}M\n\n`;
    if (topGainer) message += `🏆 Top gainer: *${topGainer.symbol}* +${(topGainer.price24hChangePercent || 0).toFixed(1)}%\n\n`;
    message += `_/signals for BUY opportunities_\n`;
    message += `_/exit for EXIT warnings_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error. Try again.');
  }
});

// /trending
bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔍 Fetching trending tokens...');
  try {
    const tokens = await getTrending();
    let message = '🔥 *Top Trending Solana Tokens*\n\n';
    tokens.slice(0, 10).forEach((token, i) => {
      const { score, label } = calcRisk(token);
      const alpha = calcAlpha(token);
      const change = (token.price24hChangePercent || 0);
      const price = token.price < 0.001 ? token.price.toExponential(2) : token.price.toFixed(4);
      message += `*${i + 1}. ${token.symbol}* ${label}\n`;
      message += `💲 $${price} | ${change > 0 ? '▲ +' : '▼ '}${change.toFixed(1)}%\n`;
      message += `⚡ Alpha: ${alpha}/100\n\n`;
    });
    message += '_/analyze SYMBOL for deep analysis_';
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error. Try again.');
  }
});

// /setalert
bot.onText(/\/setalert (\S+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase();
  const threshold = parseInt(match[2]);
  try {
    const token = await searchToken(symbol);
    if (!token) {
      bot.sendMessage(chatId, `❌ *${symbol}* not found.`, { parse_mode: 'Markdown' });
      return;
    }
    const alerts = priceAlerts.get(chatId) || [];
    const existing = alerts.findIndex(a => a.symbol === symbol);
    const alert = { symbol, threshold, lastPrice: token.price, setAt: Date.now() };
    if (existing >= 0) alerts[existing] = alert;
    else alerts.push(alert);
    priceAlerts.set(chatId, alerts);
    bot.sendMessage(chatId, `🔔 *Alert Set!*\n\nToken: *${symbol}*\nPrice: $${token.price.toFixed(4)}\nAlert: +${threshold}% pump\n\n_/myalerts to view all_`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error setting alert.');
  }
});

// /myalerts
bot.onText(/\/myalerts/, (msg) => {
  const chatId = msg.chat.id;
  const alerts = priceAlerts.get(chatId) || [];
  if (alerts.length === 0) {
    bot.sendMessage(chatId, '🔔 No active alerts.\n\nSet one: /setalert SYMBOL 20');
    return;
  }
  let message = '🔔 *Active Alerts:*\n\n';
  alerts.forEach((a, i) => {
    message += `${i + 1}. *${a.symbol}* — +${a.threshold}%\n`;
    message += `   Set at: $${a.lastPrice.toFixed(4)}\n\n`;
  });
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /subscribe + /unsubscribe
bot.onText(/\/subscribe/, (msg) => {
  subscribedChats.add(msg.chat.id);
  bot.sendMessage(msg.chat.id, '✅ *Subscribed!*\n\nYou will get auto whale alerts every 5 minutes.\n\n_/unsubscribe to stop_', { parse_mode: 'Markdown' });
});

bot.onText(/\/unsubscribe/, (msg) => {
  subscribedChats.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '❌ Unsubscribed from alerts.');
});

// /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🐦 *BirdBot Alpha — Commands*

*🎯 Signals:*
/signals — Multi-trigger BUY signals
/exit — EXIT signal detection
/accuracy — Signal win/loss tracker

*🔍 Analysis:*
/analyze SYMBOL — Deep token analysis
/compare SYM1 SYM2 — Token battle
/top3 — Top 3 alpha picks

*📊 Market:*
/trending — Top 10 trending
/whale — Whale volume alerts
/fear — Fear & Greed index
/market — Full dashboard

*🔔 Alerts:*
/setalert SYMBOL 20 — Price alert
/myalerts — View alerts
/subscribe — Auto whale alerts

_Powered by Birdeye Data API #BirdeyeAPI_
  `, { parse_mode: 'Markdown' });
});

// ═══════════════════════════════════════
// AUTO SYSTEMS
// ═══════════════════════════════════════

// Auto whale alerts every 5 min
setInterval(async () => {
  if (subscribedChats.size === 0) return;
  try {
    const tokens = await getTrending();
    const whales = tokens
      .filter(t => (t.volume24hChangePercent || 0) > 500 && (t.volume24hUSD || 0) > 50000)
      .slice(0, 3);
    if (whales.length === 0) return;
    let message = '🚨 *Auto Whale Alert!*\n\n';
    whales.forEach(token => {
      const volChange = (token.volume24hChangePercent || 0).toFixed(0);
      const { label } = calcRisk(token);
      message += `🐋 *${token.symbol}* ${label}\n`;
      message += `📊 +${volChange}% volume spike!\n\n`;
    });
    message += '_/analyze SYMBOL for details_';
    subscribedChats.forEach(chatId => {
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });
  } catch (err) {
    console.error('Auto alert error:', err.message);
  }
}, 5 * 60 * 1000);

// Price alert checker every 2 min
setInterval(async () => {
  if (priceAlerts.size === 0) return;
  try {
    const tokens = await getTrending();
    priceAlerts.forEach((alerts, chatId) => {
      alerts.forEach(alert => {
        const token = tokens.find(t => t.symbol === alert.symbol);
        if (!token) return;
        const change = ((token.price - alert.lastPrice) / alert.lastPrice) * 100;
        if (change >= alert.threshold) {
          bot.sendMessage(chatId,
            `🔔 *Price Alert!*\n\n*${alert.symbol}* pumped +${change.toFixed(1)}%!\n💲 $${token.price.toFixed(4)}\n\n_/analyze ${alert.symbol} for full analysis_`,
            { parse_mode: 'Markdown' }
          );
          alert.lastPrice = token.price;
        }
      });
    });
  } catch (err) {
    console.error('Price alert error:', err.message);
  }
}, 2 * 60 * 1000);

// Auto resolve signals every 30 min
setInterval(resolveSignals, 30 * 60 * 1000);

console.log('🐦 BirdBot Alpha is running...');
console.log('Commands: /signals /exit /accuracy /analyze /compare /whale /fear /market /top3 /trending');
