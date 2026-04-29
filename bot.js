require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;

// ═══════════════════════════════════════
// CACHE SYSTEM — avoid rate limits
// ═══════════════════════════════════════
let trendingCache = { data: [], time: 0 };
let volumeCache = { data: [], time: 0 };
const CACHE_MS = 60 * 1000; // 1 minute cache

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
  else if (volChange > 500) reasons.push('🐋 Whale activity');

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
  const alpha = Math.round(safety * 0.4 + momentum * 0.4 + volBonus * 0.2);
  return Math.min(100, alpha);
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
// ALERT SYSTEM
// ═══════════════════════════════════════
const priceAlerts = new Map(); // chatId -> [{symbol, threshold, lastPrice}]
const subscribedChats = new Set();

// ═══════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════

// /start
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'trader';
  bot.sendMessage(msg.chat.id, `
🐦 *Welcome to BirdBot Alpha, ${name}!*

The smartest Solana token intelligence bot — powered by Birdeye Data API.

*📋 Commands:*
/trending — Top 10 trending tokens
/signals — 🎯 BUY signals (safe + momentum + volume)
/top3 — 🏆 Top 3 alpha opportunities right now
/whale — 🐋 Whale volume alerts
/fear — 😨 Market Fear & Greed meter
/market — 📊 Full Solana market summary
/analyze SYMBOL — 🔍 Deep token analysis
/compare SYM1 SYM2 — ⚔️ Compare 2 tokens
/setalert SYMBOL 20 — 🔔 Price alert at % threshold
/myalerts — View your active alerts
/subscribe — Auto whale alerts every 5 mins
/help — Show all commands

_Built by Aditya Chotaliya 🚀_
  `, { parse_mode: 'Markdown' });
});

// /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🐦 *BirdBot Alpha — All Commands:*

*Discovery:*
/trending — Top 10 trending tokens with risk
/signals — Best BUY signal tokens right now
/top3 — Top 3 alpha picks today
/whale — Volume spike alerts

*Analysis:*
/analyze SYMBOL — Full token analysis
/compare SYM1 SYM2 — Side by side comparison
/fear — Fear & Greed index
/market — Market health dashboard

*Alerts:*
/setalert SYMBOL 20 — Alert when token pumps 20%+
/myalerts — Your active alerts
/subscribe — Auto whale notifications
/unsubscribe — Stop notifications

_Powered by Birdeye Data API #BirdeyeAPI_
  `, { parse_mode: 'Markdown' });
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
      const changeStr = change > 0 ? `▲ +${change.toFixed(1)}%` : `▼ ${change.toFixed(1)}%`;
      const price = token.price < 0.001 ? token.price.toExponential(2) : token.price.toFixed(4);
      message += `*${i + 1}. ${token.symbol}* ${label}\n`;
      message += `💲 $${price} | ${changeStr}\n`;
      message += `⚡ Alpha: ${alpha}/100 | 💧 Liq: $${((token.liquidity || 0) / 1000).toFixed(0)}K\n\n`;
    });
    message += '_/analyze SYMBOL for deep analysis_';
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error fetching data. Try again in 30 seconds.');
  }
});

// /signals — KILLER FEATURE
bot.onText(/\/signals/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🎯 Scanning for BUY signals...');
  try {
    const tokens = await getTrending();
    const signals = tokens
      .map(t => ({ ...t, risk: calcRisk(t), momentum: calcMomentum(t), alpha: calcAlpha(t) }))
      .filter(t => t.risk.score >= 70 && t.momentum >= 40 && (t.price24hChangePercent || 0) > 0)
      .sort((a, b) => b.alpha - a.alpha)
      .slice(0, 5);

    if (signals.length === 0) {
      bot.sendMessage(chatId, '🎯 No strong BUY signals right now.\n\nMarket conditions not ideal. Check back in 30 minutes.\n\n_Use /fear to see market sentiment._');
      return;
    }

    let message = `🎯 *BUY Signal Tokens — ${new Date().toLocaleTimeString()}*\n`;
    message += `_Tokens meeting: Safety >70 + Positive momentum_\n\n`;

    signals.forEach((token, i) => {
      const change = (token.price24hChangePercent || 0).toFixed(1);
      const vol = ((token.volume24hUSD || 0) / 1_000_000).toFixed(2);
      const price = token.price < 0.001 ? token.price.toExponential(2) : token.price.toFixed(4);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '✅';

      message += `${medal} *${token.symbol}*\n`;
      message += `🏆 Alpha Score: *${token.alpha}/100*\n`;
      message += `🛡️ Safety: ${token.risk.score}/100 | ⚡ Momentum: ${token.momentum}/100\n`;
      message += `💲 $${price} | ▲ +${change}%\n`;
      message += `💰 Vol: $${vol}M\n\n`;
    });

    message += `⚠️ _Not financial advice. Always DYOR!_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error scanning signals. Try again.');
  }
});

// /top3 — KILLER FEATURE
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
      bot.sendMessage(chatId, '🏆 No strong opportunities found right now. Market may be in fear mode.\n\nCheck /fear for sentiment.');
      return;
    }

    let message = `🏆 *Top 3 Alpha Picks — Right Now*\n`;
    message += `_Ranked by Alpha Score (Safety + Momentum + Volume)_\n\n`;

    const medals = ['🥇', '🥈', '🥉'];
    ranked.forEach((token, i) => {
      const change = (token.price24hChangePercent || 0).toFixed(1);
      const volChange = (token.volume24hChangePercent || 0).toFixed(0);
      const vol = ((token.volume24hUSD || 0) / 1_000_000).toFixed(2);
      const liq = ((token.liquidity || 0) / 1000).toFixed(0);
      const price = token.price < 0.001 ? token.price.toExponential(2) : token.price.toFixed(4);

      message += `${medals[i]} *${token.symbol}* — Alpha ${token.alpha}/100\n`;
      message += `━━━━━━━━━━━━━━━\n`;
      message += `💲 Price: $${price}\n`;
      message += `📈 24h: +${change}% | Vol spike: +${volChange}%\n`;
      message += `🛡️ Safety: ${token.risk.score}/100\n`;
      message += `⚡ Momentum: ${token.momentum}/100\n`;
      message += `💧 Liquidity: $${liq}K\n`;
      message += `💰 Volume: $${vol}M\n\n`;
    });

    message += `_Use /analyze SYMBOL for full breakdown_\n`;
    message += `⚠️ _Not financial advice. Always DYOR!_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error finding top picks. Try again.');
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
      bot.sendMessage(chatId, '🐋 No major whale activity right now.\n\nWhales are quiet. Check back in 30 minutes.\n\n_Subscribe to auto alerts: /subscribe_');
      return;
    }

    let message = '🐋 *Whale Alert — Volume Spikes Detected!*\n\n';
    whales.forEach((token, i) => {
      const { score, label } = calcRisk(token);
      const volChange = (token.volume24hChangePercent || 0).toFixed(0);
      const vol = ((token.volume24hUSD || 0) / 1_000_000).toFixed(2);
      const price = token.price < 0.001 ? token.price.toExponential(2) : token.price.toFixed(4);
      const change = (token.price24hChangePercent || 0).toFixed(1);

      message += `*${i + 1}. ${token.symbol}* ${label} (${score}/100)\n`;
      message += `📊 Volume: +${volChange}%\n`;
      message += `💰 $${vol}M traded\n`;
      message += `💲 $${price} | ${change > 0 ? '▲' : '▼'} ${change}%\n\n`;
    });
    message += `_Use /analyze SYMBOL for details_\n`;
    message += `_⚠️ High volume can mean pump OR dump — DYOR!_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error fetching whale data. Try again.');
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
    const losers = tokens.length - gainers;
    const avgChange = (tokens.reduce((s, t) => s + (t.price24hChangePercent || 0), 0) / tokens.length).toFixed(1);

    let message = `${emoji} *Solana Fear & Greed Index*\n\n`;
    message += `*${label}* — Score: *${score}/100*\n`;
    message += `\`${bar}\`\n\n`;
    message += `📊 *Market Stats:*\n`;
    message += `🟢 Gainers: ${gainers} tokens\n`;
    message += `🔴 Losers: ${losers} tokens\n`;
    message += `📈 Avg Change: ${avgChange > 0 ? '+' : ''}${avgChange}%\n\n`;

    if (score >= 75) message += `🚨 *Signal:* Extreme greed — market overheated. Consider taking profits.`;
    else if (score >= 60) message += `📈 *Signal:* Greed detected — momentum strong but stay cautious.`;
    else if (score >= 40) message += `⚖️ *Signal:* Neutral — good time to research entries carefully.`;
    else if (score >= 25) message += `📉 *Signal:* Fear — potential buying opportunity for strong tokens.`;
    else message += `🚨 *Signal:* Extreme fear — very high risk. Only trade with caution.`;

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error calculating Fear & Greed. Try again.');
  }
});

// /market — FULL MARKET DASHBOARD
bot.onText(/\/market/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '📊 Building market dashboard...');
  try {
    const tokens = await getTrending();
    const { score, label, emoji } = calcFearGreed(tokens);
    const gainers = tokens.filter(t => (t.price24hChangePercent || 0) > 0);
    const losers = tokens.filter(t => (t.price24hChangePercent || 0) < 0);
    const whales = tokens.filter(t => (t.volume24hChangePercent || 0) > 300);
    const safeTokens = tokens.filter(t => calcRisk(t).score >= 70);
    const totalVol = tokens.reduce((s, t) => s + (t.volume24hUSD || 0), 0);
    const topGainer = [...tokens].sort((a, b) => (b.price24hChangePercent || 0) - (a.price24hChangePercent || 0))[0];
    const topVolume = [...tokens].sort((a, b) => (b.volume24hUSD || 0) - (a.volume24hUSD || 0))[0];
    const signals = tokens
      .map(t => ({ ...t, risk: calcRisk(t), momentum: calcMomentum(t), alpha: calcAlpha(t) }))
      .filter(t => t.risk.score >= 70 && t.momentum >= 40 && (t.price24hChangePercent || 0) > 0);

    let message = `📊 *Solana Market Dashboard*\n`;
    message += `_${new Date().toLocaleString()}_\n\n`;
    message += `${emoji} *Sentiment:* ${label} (${score}/100)\n\n`;
    message += `━━━━━━━━━━━━━━━\n`;
    message += `📈 *Market Overview:*\n`;
    message += `🟢 Gainers: ${gainers.length} | 🔴 Losers: ${losers.length}\n`;
    message += `🐋 Whale alerts: ${whales.length}\n`;
    message += `🛡️ Safe tokens: ${safeTokens.length}/${tokens.length}\n`;
    message += `💰 Total 24h Vol: $${(totalVol / 1_000_000).toFixed(1)}M\n\n`;
    message += `━━━━━━━━━━━━━━━\n`;
    message += `🏆 *Top Performers:*\n`;
    if (topGainer) message += `📈 Best gainer: *${topGainer.symbol}* +${(topGainer.price24hChangePercent || 0).toFixed(1)}%\n`;
    if (topVolume) message += `💰 Most volume: *${topVolume.symbol}* $${((topVolume.volume24hUSD || 0) / 1_000_000).toFixed(1)}M\n\n`;
    message += `━━━━━━━━━━━━━━━\n`;
    message += `🎯 *BUY Signals: ${signals.length} found*\n`;
    if (signals.length > 0) {
      message += signals.slice(0, 3).map(t => `  • ${t.symbol} (Alpha: ${t.alpha}/100)`).join('\n');
      message += '\n';
    }
    message += `\n_Use /signals for full signal list_\n`;
    message += `_Use /top3 for best opportunities_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error building dashboard. Try again.');
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
      bot.sendMessage(chatId, `❌ *${symbol}* not found.\n\nTry a trending token:\n/trending`, { parse_mode: 'Markdown' });
      return;
    }

    const { score, label, reasons } = calcRisk(token);
    const momentum = calcMomentum(token);
    const alpha = calcAlpha(token);
    const isUp = (token.price24hChangePercent || 0) > 0;
    const change = (token.price24hChangePercent || 0).toFixed(2);
    const vol = ((token.volume24hUSD || 0) / 1_000_000).toFixed(2);
    const liq = ((token.liquidity || 0) / 1000).toFixed(0);
    const volChange = (token.volume24hChangePercent || 0).toFixed(0);
    const price = token.price < 0.001 ? token.price.toExponential(3) : token.price.toFixed(4);
    const fdv = ((token.fdv || token.mc || token.marketcap || 0) / 1_000_000).toFixed(2);

    let recommendation = '';
    if (score >= 70 && isUp && (token.price24hChangePercent || 0) < 100) {
      recommendation = '✅ *WATCHLIST* — Safe with healthy momentum';
    } else if (score >= 70 && (token.price24hChangePercent || 0) > 100) {
      recommendation = '⚠️ *CAUTION* — Safe but already pumped significantly';
    } else if (score < 40) {
      recommendation = '🚨 *AVOID* — High risk detected';
    } else {
      recommendation = '🟡 *RESEARCH* — Moderate risk, do your homework';
    }

    let message = `🐦 *${token.symbol} Deep Analysis*\n`;
    message += `_${token.name}_\n\n`;
    message += `💲 *Price:* $${price}\n`;
    message += `${isUp ? '▲' : '▼'} *24h:* ${isUp ? '+' : ''}${change}%\n`;
    message += `💰 *Volume:* $${vol}M (+${volChange}%)\n`;
    message += `💧 *Liquidity:* $${liq}K\n`;
    message += `🏦 *FDV:* $${fdv}M\n\n`;
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
  bot.sendMessage(chatId, `❌ *${missing}* not found in current trending list.\n\nTry trending tokens:\n/compare ${trending[0]?.symbol} ${trending[1]?.symbol}\n\nCurrent trending: ${symbols}`, { parse_mode: 'Markdown' });
  return;
}

    const riskA = calcRisk(tokenA);
    const riskB = calcRisk(tokenB);
    const momA = calcMomentum(tokenA);
    const momB = calcMomentum(tokenB);
    const alphaA = calcAlpha(tokenA);
    const alphaB = calcAlpha(tokenB);

    const winner = alphaA > alphaB ? symA : symB;

    const fmt = (t) => t.price < 0.001 ? t.price.toExponential(2) : t.price.toFixed(4);
    const fmtVol = (t) => `$${((t.volume24hUSD || 0) / 1_000_000).toFixed(2)}M`;
    const fmtLiq = (t) => `$${((t.liquidity || 0) / 1000).toFixed(0)}K`;
    const w = (a, b, high = true) => high ? (a >= b ? '🏆' : '  ') : (a <= b ? '🏆' : '  ');

    let message = `⚔️ *${symA} vs ${symB}*\n\n`;
    message += `┌─────────────────────┐\n`;
    message += `│ ${symA.padEnd(8)} vs ${symB.padEnd(8)}│\n`;
    message += `└─────────────────────┘\n\n`;
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
    message += `${w(tokenA.volume24hUSD || 0, tokenB.volume24hUSD || 0)} ${symA}: ${fmtVol(tokenA)}\n`;
    message += `${w(tokenB.volume24hUSD || 0, tokenA.volume24hUSD || 0)} ${symB}: ${fmtVol(tokenB)}\n\n`;
    message += `🏆 *Winner: ${winner}*\n\n`;
    message += `⚠️ _Not financial advice. Always DYOR!_`;

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error comparing tokens. Try again.');
  }
});

// /setalert
bot.onText(/\/setalert (\S+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase();
  const threshold = parseInt(match[2]);

  if (threshold < 1 || threshold > 1000) {
    bot.sendMessage(chatId, '❌ Threshold must be between 1 and 1000.\n\nExample: /setalert SOL 20');
    return;
  }

  try {
    const token = await searchToken(symbol);
    if (!token) {
      bot.sendMessage(chatId, `❌ Token *${symbol}* not found. Try a trending token.`, { parse_mode: 'Markdown' });
      return;
    }

    const alerts = priceAlerts.get(chatId) || [];
    const existing = alerts.findIndex(a => a.symbol === symbol);
    const alert = { symbol, threshold, lastPrice: token.price, setAt: Date.now() };

    if (existing >= 0) alerts[existing] = alert;
    else alerts.push(alert);
    priceAlerts.set(chatId, alerts);

    bot.sendMessage(chatId, `🔔 *Alert Set!*\n\nToken: *${symbol}*\nCurrent Price: $${token.price.toFixed(4)}\nAlert when: +${threshold}% pump\n\n_Use /myalerts to view all alerts_`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error setting alert. Try again.');
  }
});

// /myalerts
bot.onText(/\/myalerts/, (msg) => {
  const chatId = msg.chat.id;
  const alerts = priceAlerts.get(chatId) || [];
  if (alerts.length === 0) {
    bot.sendMessage(chatId, '🔔 No active alerts.\n\nSet one with:\n/setalert SYMBOL 20\n\nExample: /setalert SOL 20');
    return;
  }
  let message = '🔔 *Your Active Alerts:*\n\n';
  alerts.forEach((alert, i) => {
    message += `${i + 1}. *${alert.symbol}* — Alert at +${alert.threshold}%\n`;
    message += `   Set price: $${alert.lastPrice.toFixed(4)}\n\n`;
  });
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /subscribe
bot.onText(/\/subscribe/, (msg) => {
  subscribedChats.add(msg.chat.id);
  bot.sendMessage(msg.chat.id, '✅ *Subscribed to Whale Alerts!*\n\nYou will get notified automatically when major volume spikes are detected.\n\n_Send /unsubscribe to stop._', { parse_mode: 'Markdown' });
});

// /unsubscribe
bot.onText(/\/unsubscribe/, (msg) => {
  subscribedChats.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '❌ Unsubscribed from whale alerts.');
});

// ═══════════════════════════════════════
// AUTO SYSTEMS
// ═══════════════════════════════════════

// Auto whale alerts every 5 minutes
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
      const { score, label } = calcRisk(token);
      message += `🐋 *${token.symbol}* ${label}\n`;
      message += `📊 +${volChange}% volume spike!\n`;
      message += `💲 $${token.price < 0.001 ? token.price.toExponential(2) : token.price.toFixed(4)}\n\n`;
    });
    message += '_Use /analyze SYMBOL for details_';

    subscribedChats.forEach(chatId => {
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });
  } catch (err) {
    console.error('Auto alert error:', err.message);
  }
}, 5 * 60 * 1000);

// Price alert checker every 2 minutes
setInterval(async () => {
  if (priceAlerts.size === 0) return;
  try {
    const tokens = await getTrending();
    priceAlerts.forEach((alerts, chatId) => {
      alerts.forEach(alert => {
        const token = tokens.find(t => t.symbol === alert.symbol);
        if (!token) return;
        const changeFromSet = ((token.price - alert.lastPrice) / alert.lastPrice) * 100;
        if (changeFromSet >= alert.threshold) {
          bot.sendMessage(chatId, `🔔 *Price Alert Triggered!*\n\n*${alert.symbol}* pumped +${changeFromSet.toFixed(1)}% since you set the alert!\n\n💲 Current: $${token.price.toFixed(4)}\n💲 Set at: $${alert.lastPrice.toFixed(4)}\n\n_Use /analyze ${alert.symbol} for full analysis_`, { parse_mode: 'Markdown' });
          alert.lastPrice = token.price;
        }
      });
    });
  } catch (err) {
    console.error('Price alert error:', err.message);
  }
}, 2 * 60 * 1000);

console.log('🐦 BirdBot Alpha is running...');
console.log('Commands: /start /trending /signals /top3 /whale /fear /market /analyze /compare /setalert');
