# SHARPS — autonomous in-play football trading agents

> Submission for the **TxODDS "World Cup" hackathon** (Superteam Earn) — *Trading Tools & Agents* track.
> Autonomous agents that trade World Cup matches on a calibrated live win-probability model, commit capital
> on-chain, and settle against cryptographically-verifiable match data — all on Solana, powered by TxLINE.

## What it does
Several deterministic strategies trade the same live feed and compete on a P&L leaderboard:

| Agent | Idea |
|-------|------|
| **model-edge** | Backs the outcome our model prices above the de-margined market. Quarter-Kelly. |
| **steam** | Momentum — follows the side the market is moving toward (odds shortening). |
| **market-maker** | Liquidity-style — small stakes on any side priced below fair value. |
| **favorite** | Baseline control — backs the pre-match favorite at a flat stake. |

The model is an **in-play Poisson / Dixon–Coles 1X2 engine**: it backs out each team's expected goals from
the de-margined consensus 1X2, then updates the win/draw/loss probability every moment from the live score,
minute, and red cards. Edge = model fair value − market price.

## How TxLINE / Solana power it
- **Live data** — TxLINE SSE streams (`/api/odds/stream`, `/api/scores/stream`) + snapshots. The odds we
  trade against are TxODDS's `TXLineStablePriceDemargined` consensus (fair, de-vigged) 1X2.
- **On-chain capital** — agents post `create_intent` on the `txoracle` program, locking USDT in an escrow
  vault tied to a fixture + predicate. *(verified on devnet)*
- **On-chain settlement** — outcomes resolve via `validate_stat`: a Merkle proof (from
  `/api/scores/stat-validation`) verified against the oracle's on-chain daily scores root. Both capital and
  resolution are on-chain and cryptographically verifiable. *(verified on devnet)*

See `data/CHAIN.md` for the full reverse-engineered program map (PDA seeds, permission model) and
`data/SCHEMA.md` for the TxLINE data schemas.

## Run it
```bash
npm install
cp .env.example .env
npm run wallet          # generate a devnet wallet (fund ~0.05 SOL from a devnet faucet)
npm run subscribe       # free World Cup tier: on-chain subscribe(1,4) + activate -> writes API_TOKEN
npm run probe           # confirm live data
npm run sim             # run the agents -> writes dashboard/state.json + prints the leaderboard
# serve the dashboard:
cd dashboard && python3 -m http.server 8799   # open http://localhost:8799
```
On-chain primitive checks: `npm run faucet` (USDT), `scripts/12-intent.ts` (escrow),
`scripts/14-validate.ts` (settlement).

## Endpoints used
`/auth/guest/start` · `/api/token/activate` · `/api/fixtures/snapshot` · `/api/odds/snapshot/{id}` ·
`/api/odds/stream` · `/api/scores/snapshot/{id}` · `/api/scores/stream` · `/api/scores/stat-validation` ·
`txoracle` instructions: `subscribe`, `request_devnet_faucet`, `create_intent`, `validate_stat`.

## Status / honesty
- Live data, model, on-chain escrow + settlement: **verified on devnet**.
- Peer-matching (`execute_match`) is operated by the TxODDS backend (admin-gated); our agents use the
  permissionless intent + `validate_stat` path.
- The leaderboard runs matches **simulated from the live market-implied goal rates** (market price lags the
  true probability + 5% overround) so every match resolves and strategies are scored. Real live-match
  settlement uses the on-chain `validate_stat` proofs above. Strategies are intentionally simple first-pass.

Devnet only — no real funds.
