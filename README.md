# SHARPS — autonomous in-play football trading agents

> Submission for the **TxODDS "World Cup" hackathon** (Superteam Earn) — *Trading Tools & Agents* track.
> Autonomous agents that price World Cup matches with a live Dixon–Coles model, find cross-market
> dislocations across TxLINE's 1X2 / Asian-Handicap / Over-Under feeds, commit capital on-chain, and are
> graded by **Closing Line Value** — the professional standard for proving an edge. All on Solana, powered
> by TxLINE.

## The agents
Four deterministic bots trade the same live feed and are ranked by CLV and settled P&L:

| Bot | What it does |
|-----|--------------|
| **cross-arb** | Fits one pair of goal rates jointly to 1X2 + Asian Handicap + Over/Under, then backs whichever market is most underpriced vs that joint-fair fit (2–15% value, only when the three markets are mutually consistent). |
| **inplay-value** | Live only: after goals the market price lags the new fair value — backs the lagging side (4–20% edge, bounded). |
| **steam** | Follows a real line move since the last tick, but only when our model confirms the same side. |
| **favorite** | Baseline control — backs the pre-match favorite flat. (Expected to *lose* CLV; it's the "not sharp" reference.) |

Every bot is gated: it needs a clean model fit, sane odds (1.2–6.0), and a bounded edge. Anything implying a
>15–20% edge against a de-margined market is treated as a data artifact and rejected — efficient markets don't
hand out 80% edges.

## How we know a bot is sharp — Closing Line Value (CLV)
The honest problem with "P&L": you must wait for matches to finish. CLV solves it. CLV compares the odds you
bet to where the line moves *afterwards*; positive CLV over many bets is the professional proof of edge — a
[Pinnacle study](https://www.pinnacleoddsdropper.com/blog/closing-line-value) found +CLV bettors are almost
universally profitable *regardless of win/loss variance*, and −CLV bettors almost universally unprofitable.
It is **computable live, with no match result**. The dashboard ranks every bot by average CLV and beat-close
rate; settled P&L (when a match finishes) is the lagging confirmation.

## The model
In-play **Poisson / Dixon–Coles** 1X2 engine (`src/model/poisson.ts`): back out each side's expected goals
from the de-margined consensus, apply the Dixon–Coles low-score correction (ρ), then update win/draw/loss
every moment from the live score, minute remaining, and red cards. The **cross-market** layer
(`src/model/crossmarket.ts`) fits those goal rates jointly across all three markets and flags the offside one —
model-light triangulation that uses the full breadth of the feed, not a single-market bot.

## How TxLINE / Solana power it
- **Live data** — TxLINE SSE streams (`/api/odds/stream`, `/api/scores/stream`) + snapshots. We trade against
  TxODDS's `TXLineStablePriceDemargined` consensus (fair, de-vigged) across 1X2, Asian Handicap, and Over/Under.
- **On-chain capital** — agents post `create_intent` on the `txoracle` Solana program, locking USDT in a
  per-intent escrow vault tied to a fixture + predicate. *(verified on devnet)*
- **On-chain settlement** — outcomes resolve via `validate_stat`: a Merkle proof from
  `/api/scores/stat-validation`, verified against the oracle's on-chain daily scores root. Both capital and
  resolution are on-chain and cryptographically verifiable. *(verified on devnet)*

The `txoracle` program is undocumented for trading; the PDA seeds and permission model were recovered from the
program binary and are encoded in `src/chain/venue.ts`.

## Run it (devnet, free)
```bash
npm install
cp .env.example .env
npm run wallet      # generate a devnet wallet (fund ~0.05 SOL from any devnet faucet)
npm run subscribe   # free World Cup tier: on-chain subscribe(1,4) + activate -> writes API_TOKEN
npm run probe       # confirm live data
npm run track       # run the agents live: CLV, ledger, on-chain intents, match backlog
# dashboard:
cd dashboard && python3 -m http.server 8799   # http://localhost:8799
```
On-chain primitive checks: `npm run faucet` (USDT) · `scripts/12-intent.ts` (escrow) ·
`scripts/14-validate.ts` (Merkle settlement). Backtest: `npm run sim`.

## TxLINE endpoints used
`/auth/guest/start` · `/api/token/activate` · `/api/fixtures/snapshot` · `/api/odds/snapshot/{id}` ·
`/api/odds/stream` · `/api/scores/snapshot/{id}` · `/api/scores/stream` · `/api/scores/stat-validation` ·
`txoracle` instructions: `subscribe` · `request_devnet_faucet` · `create_intent` · `validate_stat`.

## Honesty / status
- Live data, the model, on-chain escrow + Merkle settlement: **verified on devnet**.
- Peer-matching (`execute_match`) is admin-gated (TxODDS operates the matcher); agents use the permissionless
  `create_intent` + `validate_stat` path, so both capital commitment and resolution stay on-chain + verifiable.
- The devnet feed is a sparse replay — matches often sit pre-match, so **settled P&L fills slowly**. That's why
  CLV (leading, live) is the primary metric and settled P&L is the lagging confirmation.
- The **backtest** leaderboard simulates matches from the live market-implied goal rates (the market lags the
  truth + a 5% overround) so strategies can be scored instantly; it's clearly labelled SIMULATED on the dashboard.
- **Devnet only — no real funds.**

## Feedback on the TxLINE API (for TxODDS)
- **What worked well:** the de-margined consensus (`TXLineStablePriceDemargined`) across 1X2/AH/OU is genuinely
  useful — having a fair, vig-free reference per market made cross-market triangulation straightforward. The
  guest-JWT → on-chain subscribe → activate flow is clean, and the free World Cup tier is a great on-ramp.
  `Prices = decimal × 1000` is consistent and easy. The Merkle-proof `validate_stat` view instruction is a
  standout — verifiable settlement without trusting an oracle response.
- **Friction we hit:** (1) the trading side of the `txoracle` program is undocumented — PDA seeds for
  `order_intent` / `intent_vault` / `trade_vault` and the permission model (admin-gated `create_trade` /
  `execute_match`) had to be reverse-engineered from the program binary; a published IDL-with-seeds + a worked
  `create_intent` example would save every team hours. (2) The OpenAPI at `/api-reference/openapi.json` returns
  a placeholder plant-store spec; the real schema is the YAML. (3) `subscribe` requires `weeks` to be a multiple
  of 4 (`InvalidWeeks`) but the reference example passes `1`. (4) SSE event payload shapes aren't in the docs —
  we captured them empirically. (5) On devnet the match feed is mostly pre-match replays, so end-to-end live
  settlement is hard to demonstrate without mainnet.
