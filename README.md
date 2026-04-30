# BirdBot Alpha 🐦⚡

> Real-time Solana trading intelligence bot powered by Birdeye Data API

---

## 🤖 Try the Bot Live
**Search on Telegram: @BirdRadarBot**

Bot runs 24/7 on Railway - always available.

---

## 🎯 What Makes BirdBot Different

Most bots just say "buy this token."

BirdBot tells you **WHY** with a multi-condition signal system:

```
🚨 STRONG ALPHA SIGNAL

Token: BP
Alpha Score: 68/100
Conditions: 5/5 met

Why this triggered:
+ Volume +2117% spike
+ Price +25.3% momentum
+ Liquidity stable ($276K)
+ Trade activity spike (11.4x vol/liq)
+ Safety score 100/100

Status: MOMENTUM BUILDING -WATCH CLOSELY
Risk: Low

⚠️ Not financial advice. Always DYOR!
```

And tracks whether signals were right or wrong:

```
📊 BirdBot Signal Accuracy Report

Total signals: 12
✅ Wins (>20%): 7
❌ Losses (<-10%): 2
⚖️ Neutral: 1
⏳ Pending (4h): 2

Win Rate: 77%
Avg Win: +43.2%
Avg Loss: -8.1%
```

---

## 📋 All Commands

### 🎯 Signals
| Command | Description |
|---|---|
| `/signals` | Multi-trigger BUY signals with WHY explanation |
| `/exit` | EXIT signal detection - when to take profits |
| `/accuracy` | Signal win/loss tracker with full stats |

### 🔍 Analysis
| Command | Description |
|---|---|
| `/analyze SYMBOL` | Deep token analysis with Alpha Score |
| `/compare SYM1 SYM2` | Side-by-side token battle |
| `/top3` | Top 3 alpha opportunities right now |

### 📊 Market
| Command | Description |
|---|---|
| `/trending` | Top 10 trending Solana tokens |
| `/whale` | Whale volume spike detection |
| `/fear` | Fear & Greed market sentiment index |
| `/market` | Full Solana market dashboard |

### 🔔 Alerts
| Command | Description |
|---|---|
| `/setalert SYMBOL 20` | Alert when token pumps +20% |
| `/myalerts` | View all your active alerts |
| `/subscribe` | Auto whale alerts every 5 minutes |
| `/unsubscribe` | Stop auto alerts |

---

## 🧠 Signal System - How It Works

### BUY Signal Logic
Signal fires when **3 or more of 5 conditions are met**:

| # | Condition | Threshold | Notes |
|---|---|---|---|
| 1 | Volume Spike | >120% | **MANDATORY** |
| 2 | Price Momentum | >8% | 24h price change |
| 3 | Liquidity Stable | >$20K | Not dropping |
| 4 | Trade Activity | vol/liq >1x | People rushing in |
| 5 | Safety Score | >65/100 | Risk check |

### Signal Strength Tiers
- **5/5 conditions** → 🚨 STRONG SIGNAL
- **3-4/5 conditions** → ⚡ EARLY SIGNAL
- **Less than 3** → ignored

### EXIT Signal Logic
Exit warning fires when 2 or more of:
- Volume dropping >30%
- Price going negative
- Liquidity falling below $15K

---

## 📊 Alpha Score Algorithm

Every token gets an Alpha Score (0-100):

```
Alpha Score = (Safety × 0.4) + (Momentum × 0.4) + (Volume Bonus × 0.2)
```

**Safety Score** factors:
- Liquidity depth analysis
- Price pump magnitude
- Volume/liquidity ratio (wash trading detection)
- Market cap size risk
- Bot volume detection

**Momentum Score** factors:
- 24h price change contribution
- 24h volume change contribution
- Liquidity depth contribution

**Volume Bonus** (max 20 points):
- Based on volume change percentage

---

## 📈 Accuracy Tracking

Every signal is automatically logged and resolved after 4 hours:

- **Win** = token pumped >20% after signal
- **Loss** = token dropped >10% after signal
- **Neutral** = stayed flat

Full transparency on signal quality - no other bot does this.

---

## 🔌 Birdeye Data API Endpoints Used

| Endpoint | Usage |
|---|---|
| `/defi/token_trending` | Real-time trending tokens |
| `/defi/tokenlist` | Top volume tokens on Solana |

**API calls made:** 500+ throughout sprint period

---

## 🛠️ Tech Stack

- **Runtime:** Node.js
- **Bot library:** node-telegram-bot-api
- **HTTP client:** axios
- **Data:** Birdeye Data API
- **Deployment:** Railway (24/7)
- **Environment:** dotenv

---

## 🚀 Run Locally

```bash
git clone https://github.com/adityachotaliya9299-jpg/birdbot
cd birdbot
npm install
```

Create `.env` file:
```
TELEGRAM_BOT_TOKEN=your_token_here
BIRDEYE_API_KEY=your_key_here
```

```bash
node bot.js
```

---

## 🏗️ Project Structure

```
birdbot/
├── bot.js          # Main bot file
├── package.json    # Dependencies
├── .env            # Environment variables (not committed)
├── .gitignore      # Git ignore rules
└── README.md       # This file
```

---

## 💡 Why This Beats Other Bots

1. **Explains reasoning** -not just signals, but WHY each fired
2. **Tracks accuracy** -transparent win/loss history
3. **Exit signals** -tells you when to take profits too
4. **Multi-condition system** -reduces false signals
5. **Alpha Score** -single number combining all factors
6. **24/7 deployment** -always running on Railway
7. **Auto alerts** -subscribes to whale notifications
8. **Token comparison** -battle any 2 tokens side by side
9. **Price alerts** -custom threshold notifications
10. **Market dashboard** -full overview in one command

---

## 👤 Built By

**Aditya Chotaliya**
GATE CSE AIR 61 (2026) | AIR 154 (2025) -Top 0.1% nationally

- 🌐 Portfolio: https://adityachotaliya.vercel.app
- 💻 GitHub: https://github.com/adityachotaliya9299-jpg
- 🏗️ 38 smart contracts deployed | 700+ tests passing

---

## 📢 Built for Birdeye Data BIP Competition Sprint 2

#BirdeyeAPI #Solana #BuildInPublic @SuperteamEarn
