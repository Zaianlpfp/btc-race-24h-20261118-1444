# Stabilised washout-recovery dip-buy cbBTC bot v3

make.fun competition **btc-race-24h-20261118-1444** — "Race a BTC trading bot
live for 24 hours". Node 22, standard library only, plus the kit's bars SDK
shim vendored byte-for-byte under `vendor/` (sha256
`9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8`).

## Idea

On a 24h cbBTC window the money is in sharp washouts followed by a slow
recovery, not in chasing the trend: every momentum variant I tested loses
on the dev windows, and so do the kit's EMA/momentum baselines. So this bot
only buys a deep dip once the bounce has already started, then banks the
recovery with a profit target, a ratchet trailing stop and a long time stop.
One strategy pattern only: washout-recovery dip-buy.

## Rules

- **Entry (flat only):** the 30-minute return is below -80 bps AND the
  5-minute return has turned positive above +20 bps — the dip is deep and
  the bounce has just started.
- **Size:** one tranche of $333.33 (a third of the $1,000 starting cash).
  No scale-in: on every frozen window I could test, a second tranche only
  bought deeper into washouts that kept falling.
- **Exits (whole position):** +350 bps profit target above the average
  FILL price; a trailing stop that is loose (350 bps) until the position
  is +50 bps in profit and then tightens to 40 bps (banks fast recoveries
  while letting slow ones ride); a 300 bps hard stop below the average
  fill price; a 480-bar (8 hour) time stop — the 1444 dev window's only
  washout takes ~8 hours to recover, and a 2-hour stop sold it at a loss.
- **Trade cap:** at most 6 filled orders per 24h window. A new buy is only
  sent while 4 or fewer fills have been seen, so the eventual exit can
  never push the total past 6; exits are always allowed.
- **Cost basis:** the true average FILL price (taken from the fills the
  harness reports), not the decision close. In a washout the fill at the
  next bar's open can sit ~100 bps away from the close the entry was
  decided on, and measuring exits from the decision close mis-arms the
  ratchet. A buy or sell decided on bar k fills at bar k+1's open; the bot
  notes the decision when it sends the order and confirms it against the
  next batch's fills (filled = take the fill price as the cost basis,
  rejected = drop the entry / retry the exit).
- Long only, no shorts, no leverage. Deterministic: decisions use only the
  closes and fills seen so far; no randomness, no wall clock, no network.

## Dev results (verified with `grade-local --driver process`)

| window | net PnL | fills | max DD | fees |
|--------|---------|-------|--------|------|
| 1444 (this race's dev) | **+$2.13** | 2 | 0.50% | $0.27 |
| 2314 | +$0.61 | 4 | 0.77% | $0.53 |
| 0603 | +$1.67 | 2 | 0.19% | $0.27 |
| 0828 | +$1.25 | 4 | 1.35% | $0.53 |

Guardrails met on all four windows (≥1 trade, max DD ≤ 25%, ≤ 6 fills).
`grade-local` runs the bot twice and regrades: **L1 regrade reproduced byte
for byte on every window**, and a second full `grade-local` run on the 1444
kit reproduced the same `result_sha256`
(`52c8be8a1450c75529f2dfb271242c860f59b510e686787f1f5640be38bcaff4`) and
`action_log_sha256`
(`7c0677b153c0f1e17c9babe7d563437d40dc92b7dde09e9c5e5bb6e5fdd939ab`).

## How the parameters were chosen

I started from the 0603 entry's washout-recovery family and re-derived the
harness fill model in an offline backtester (fill at next bar's open, 4 bps
fee, 2 bps slippage, constant-product impact vs the open depth, BigInt
math), then validated the backtester to the cent against the documented
0603-family numbers (0828 +$25.13 uncapped, 2314 +$2.02, 0603 +$1.67).
A coarse grid over the washout parameters, then a fine local grid of
13,122 combinations around the best set, ranked by worst-case net PnL
across the four frozen windows. The chosen set sits in the middle of a
540-combination plateau that is net positive on all four windows (bounce
18–22 bps, ratchet 50–60 bps, target 350–450 bps all give identical
trades) — not on a sharp peak. For comparison, the previous top-10 race
winners all ran the same dip-buy / washout-recovery / capitulation-bounce
family with 2–8 trades and ≤ 2% drawdown, and the shipped 0603 params
score -$0.63 on this race's dev window.

## Honest caveats

The margins are thin — worst window +$0.61 — because the 1444 dev window
is a slow grind down with a single washout whose best recovery is ~+180 bps.
No dip-buy variant in this family makes more than ~$14 on it, so a >$25
dev-window target is not reachable there; what this bot offers is a
positive worst case and no losing window, which is what an unseen race
window rewards. The race window is a fresh 24h of BTC price action, so
these dev numbers are a robustness check, not a promise.
