## 📌 Project Summary
This is a lightweight TypeScript Solana auto trading bot that watches for newly launched tokens (e.g., Pump.fun events) and executes trades automatically. It uses a fast streaming source (gRPC/WebSocket) to detect token launches and tries to buy at the earliest possible moment. You can plug in your own buy/sell strategies through simple function hooks or JSON rules.

Key goals:
- Detect new token launches in real time.
- Execute buy orders quickly and confirm them.
- Run configurable, customizable sell strategies (multiple phases allowed).
- Safe defaults + clear logging and retry behaviors.

---

## 🚀 Features (short & clear)
- **Real-time monitoring** via streaming API (WebSocket or gRPC).
- **Fast buy execution**: configurable time threshold to trade only near launch time.
- **Customizable strategies**: implement buy/sell logic as simple TypeScript functions or JSON rules.
- **Phased selling**: e.g., sell 70% then 100% (configurable delays).
- **Retries & confirmation**: robust retries for failed sells, confirms buys via RPC.
- **Logging & stats**: console + rolling log files + JSON stats.
- **Safety tools**: duplicate protection, global lock, dry-run simulation mode.

---



## 🧭 How it works (simple flow)
1. Start bot → load config → connect to streaming API.  
2. When a new token event arrives:
   - Parse mint address and launch timestamp.
   - Compute time difference vs local clock.
   - If within threshold (e.g., ≤ `EVENT_TIMEOUT_MS`), call `strategy.onBuy(...)`.
3. `onBuy` executes buy order and waits for confirmation.
4. After buy confirmed, bot calls `strategy.onSellPhase(phase, context)` at configured delays.
5. On sell failures, the bot will retry (or follow your strategy's retry policy).

---

## 🧩 Strategy Customization (how to plug your own logic)
You can provide strategies two ways:
1. **JS/TS function hooks** — full code control.  
2. **Declarative JSON rules** — simple rule-based behavior (no code).



## 🧪 Example strategies (ideas you can copy)
1. **Time-first sniper** — buy only if `timeDiffMs <= 500ms`.
2. **Liquidity guard** — only buy if LP pool > X SOL.
3. **Price-check** — run a small price probe before buying to avoid honeypots.
4. **Dynamic sizing** — scale buy amount based on token liquidity:
   - `amount = base * min(1, liquidity / liquidityThreshold)`.
5. **Trailing exit** — after first sell, put a small trailing-protect sell order to capture further gains.
6. **Blacklist / Whitelist** — filter tokens by symbol pattern, creator address, or token metadata.

---

## 🔒 Safety & recommended protections
- **Dry-run mode**: test strategies without broadcasting transactions. (`DRY_RUN=true`)
- **Blacklist**: maintain a list of token creators or mint addresses you will never buy.
- **Minimum liquidity**: reject tokens with tiny pools.
- **Max slippage guard**: set upper slippage limits so you don’t pay extreme prices.
- **Rate limiting**: avoid sending too many RPCs/txs in a short time.
- **Private key safety**: never commit `.env` to git. Use secure vault/secret manager in production.

---



---

## 🧾 Logging & stats
- Logs folder: `./logs/` with daily files `sniper_YYYY-MM-DD.log`.
- Stats JSON: `./logs/stats_YYYY-MM-DD.json` — contains per-trade timings and P&L summary.
- Console: live friendly messages (INFO / SUCCESS / ERROR).

---

## 🛠 Deployment (quick)
1. Install Node.js (v18+ recommended).  
2. Configure `.env`.  
3. Run BOT:
   ```
   npx ts-node trade.ts
  Or Run start.bat
   



## ❗ Legal & ethical note
Automated trading, sniping, or interacting with new token launches can carry technical, legal, and ethical risks. This project is provided for educational purposes. You are responsible for:
- Complying with local laws and exchange/platform rules.
- Avoiding actions that could be considered market manipulation or violating terms of service.
- Securing your funds and private keys.

---


---

## ❓ Troubleshooting (common issues)
- `Time drift` — ensure your machine clock is accurate (use NTP).  
- `Remote origin already exists` when pushing code — remove or update git remote (this is a git issue, not bot-related).
- `Transactions not confirming` — check RPC endpoint and rate limits; switch to a reliable node provider.

---

"# mev-bot-solana-auto-trading-bot" 
"# mev-bot-solana-auto-trading-fast" 
"# mev-bot-solana-auto-trading-fast" 
"# mev-bot-solana-auto-trading-fast" 
