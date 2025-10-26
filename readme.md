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

## ⚙️ Quick Config (`.env` example)
```bash
# Wallet
PUBLIC_KEY=your_wallet_public_key
PRIVATE_KEY=your_wallet_private_key

# Trading
BUY_SOL=0.5
BUY_SLIPPAGE=1000          # in basis points (e.g., 1000 = 10.00%)
SELL1_SLIPPAGE=1000
SELL2_SLIPPAGE=1000
PRIORITY_FEE=0.00000000005

# Time & behavior
EVENT_TIMEOUT_MS=900
FIRST_SELL_DELAY_MS=500
SECOND_SELL_DELAY_MS=1500

# APIs
SOLANA_STREAMING_API_KEY=
RPC_ENDPOINT=https://your.rpc.node

# Modes
DRY_RUN=true               # if true, won't broadcast transactions
LOG_LEVEL=info
```

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

### A. TypeScript strategy interface (recommended)
Create a file `strategies/myStrategy.ts` and export an object that follows this shape:

```ts
import { TradeContext, Strategy } from "../types";

export const myStrategy: Strategy = {
  // decide whether to buy (true/false)
  shouldBuy: async (context: TradeContext) => {
    // context: { mint, launchTime, timeDiffMs, priceData, liquidity, ... }
    // Example: buy if time difference <= 900ms AND liquidity > threshold
    if (context.timeDiffMs <= 900 && context.liquidity > 0.5) return true;
    return false;
  },

  // custom buy behavior: returns buy result or throws
  onBuy: async (context, api) => {
    // api.buy(mint, amountSol, slippage)
    return await api.buy(context.mint, context.config.BUY_SOL, context.config.BUY_SLIPPAGE);
  },

  // handle each sell phase (phase = 1, 2, ...)
  onSellPhase: async (phase, context, api) => {
    if (phase === 1) {
      // sell 70%
      return await api.sellPercent(context.tokenAccount, 70, context.config.SELL1_SLIPPAGE);
    } else if (phase === 2) {
      // sell remaining
      return await api.sellPercent(context.tokenAccount, 100, context.config.SELL2_SLIPPAGE);
    }
  },

  // optional: handle failures / retries
  onError: async (err, context) => {
    // e.g., log to monitoring service
  }
};
```

Then load it in your bot setup:
```ts
import { myStrategy } from "./strategies/myStrategy";
bot.setStrategy(myStrategy);
```

### B. JSON rule strategy (easy, no-code)
Create `strategies/simple.json`:
```json
{
  "buy": {
    "maxTimeDiffMs": 900,
    "minLiquidity": 0.3,
    "amountSol": 0.5,
    "slippageBp": 1000
  },
  "sellPhases": [
    { "delayMs": 500, "percent": 70, "slippageBp": 1000 },
    { "delayMs": 1500, "percent": 100, "slippageBp": 1000 }
  ],
  "retry": { "maxAttempts": 0, "backoffMs": 500 }
}
```
`maxAttempts: 0` means infinite retry. The bot will read this and run the specified actions.

---

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

## 🧰 Utilities / API provided to strategies
When writing `onBuy` / `onSellPhase`, the bot exposes a small API:
```ts
interface BotApi {
  buy(mint: string, amountSol: number, slippageBp: number): Promise<BuyResult>;
  sellPercent(tokenAccount: string, percent: number, slippageBp: number): Promise<SellResult>;
  getPrice(mint: string): Promise<number>;
  getLiquidity(mint: string): Promise<number>;
  wait(ms: number): Promise<void>;
  log(level: string, msg: string): void;
}
```

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
   ```bash
  npx ts-node trade.ts
   ```
Or Run start.bat
---

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
