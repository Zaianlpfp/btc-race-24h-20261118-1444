// Stabilised washout-recovery dip-buy cbBTC bot v3 for make.fun
// btc-race-24h-20261118-1444 (bars-replay/v1).
//
// Idea: on a 24h cbBTC window the money is in sharp washouts followed by a
// slow recovery, not in chasing the trend (every momentum variant loses on
// the dev windows, and the kit's EMA/momentum baselines lose too). So this
// bot only buys a deep dip once the bounce has already started, then banks
// the recovery with a profit target, a ratchet trailing stop and a long
// time stop. One strategy pattern only: washout-recovery dip-buy.
//
// Entry (flat only): the 30-minute return is below -80 bps AND the
// 5-minute return has turned positive above +20 bps -- the dip is deep
// and the bounce has just started. One tranche only: a third of the
// $1,000 starting cash. No scale-in: on every frozen window I could test,
// a second tranche only bought deeper into washouts that kept falling.
// Exits (whole position): +350 bps profit target above the average FILL
// price, a trailing stop that is loose (350 bps) until the position is
// +50 bps in profit and then tightens to 40 bps (banks fast recoveries
// while letting slow ones ride), a 300 bps hard stop below the average
// fill price, or a 480-bar (8 hour) time stop -- the 1444 dev window's
// only washout takes ~8 hours to recover, and a 2-hour stop sold it at
// a loss.
//
// Cost basis is the true average FILL price (taken from the fills the
// harness reports), not the decision close: in a washout the fill at the
// next bar's open can sit ~100 bps away from the close the entry was
// decided on, and measuring exits from the decision close mis-arms the
// ratchet. A buy or sell decided on bar k fills at bar k+1's open; the
// bot notes the decision when it sends the order and confirms it
// against the next batch's fills (filled = take the fill price as the
// cost basis, rejected = drop the entry / retry the exit). This keeps
// the internal state in sync with the account even if a fill is
// rejected (e.g. max slippage on a fast rip).
//
// Trade cap (P0-3): at most 6 filled orders per 24h window. A new buy
// is only sent while 4 or fewer fills have been seen, so the eventual
// exit can never push the total past 6; exits themselves are always
// allowed. Long only, no shorts, no leverage. Deterministic: decisions
// use only the closes and fills seen so far; no randomness, no wall
// clock, no network, standard library only (plus the kit's bars SDK
// shim, vendored byte-for-byte under vendor/).
//
// Validation (offline replay of the harness fill model, validated to
// the cent against the documented 0603-family results -- 0828 +$25.13
// uncapped, 2314 +$2.02, 0603 +$1.67): this parameter set is net
// positive on ALL FOUR frozen dev windows I could test, with at most
// 4 filled orders and max drawdown under 1.4% on each:
//   1444 (this race's dev window): +$2.13, 2 fills, DD 0.50%
//   2314: +$0.61, 4 fills, DD 0.77%
//   0603: +$1.67, 2 fills, DD 0.19%
//   0828: +$1.25, 4 fills, DD 1.36%
// The set sits in the middle of a 540-combination plateau that is all
// positive on all four windows (bounce 18-22 bps, ratchet 50-60 bps,
// target 350-450 bps all give identical trades), not on a sharp peak.
// Honest note: the margins are thin -- worst window +$0.61 -- because
// the 1444 dev window is a slow grind down with a single washout whose
// best recovery is ~+180 bps; no dip-buy variant in this family makes
// more than ~$14 on it, and the >$25 target in the brief is not
// reachable there. What this bot offers is a positive worst case and
// no losing window, which is what the race window (unseen) rewards.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (see the header comment for validation).
const DROP_BPS = 80; // 30-min return must be below -80 bps to buy
const BOUNCE_BPS = 20; // 5-min return must be above +20 bps to buy
const MAX_TRANCHES = 1; // one tranche per cycle, no scale-in
const TRANCHE_SIZE = 1_000_000_000n / 3n; // $333.33 in micro-USDC
const TARGET_BPS = 350; // profit target above the average fill price
const TRAIL_BPS = 350; // loose trailing stop below the peak close
const RATCHET_BPS = 50; // tighten the trail once +50 bps in profit
const TIGHT_TRAIL_BPS = 40; // tight trailing stop below the peak close
const STOP_BPS = 300; // hard stop below the average fill price
const TIME_STOP = 480; // bars from the first tranche, then exit
const MAX_SLIPPAGE_BPS = 50; // cap the fill slippage the bot accepts
const MAX_FILLS_BEFORE_BUY = 4; // new buys only while fills <= 4 (total <= 6)

/** State for one run: the closes seen and the open cycle, if any. */
class WashoutBot {
  closes: number[] = []; // closes of bars seen, in order (price units)
  entries: number[] = []; // FILL prices of the tranches held
  openedAt = 0; // index in closes of the decision bar of the first tranche
  peakClose = -Infinity; // highest close since openedAt
  pending: { side: 'buy' | 'sell'; clientId: string; decidedAt: number } | null = null;
  fills = 0; // filled orders seen so far (flatten fills excluded by the harness)

  heldQty(state: BarsState): bigint {
    return state.positions.get(SYMBOL)?.qty ?? 0n;
  }

  /** Average fill price of the tranches held, in raw price units. */
  avgEntry(state: BarsState): number {
    if (this.entries.length > 0) {
      return this.entries.reduce((a, x) => a + x, 0) / this.entries.length;
    }
    // Fallback: rebuild from the position cost the harness reports.
    const pos = state.positions.get(SYMBOL);
    if (pos !== undefined && pos.qty !== '0') {
      return Number((BigInt(pos.cost_quote_units) * 10_000_000n) / BigInt(pos.qty));
    }
    return 0;
  }

  buyOrder(clientId: string): [BuyInput] {
    return [{ side: 'buy', client_id: clientId, symbol: SYMBOL, notional_quote_units: TRANCHE_SIZE, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  sellOrder(state: BarsState, clientId: string): [SellInput] {
    return [{ side: 'sell', client_id: clientId, symbol: SYMBOL, qty: this.heldQty(state), max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  /** Fold the previous batch's fills into the cycle state. */
  confirmPending(batch: Batch): void {
    if (this.pending === null) return;
    const fill = batch.fills.find((f) => f.client_id === this.pending!.clientId);
    if (this.pending.side === 'buy') {
      if (fill !== undefined && fill.status === 'filled') {
        // Take the fill price as the cost basis; the cycle opens.
        this.entries.push(Number(fill.price));
        let peak = -Infinity;
        for (let i = this.pending.decidedAt; i < this.closes.length; i++) {
          if (this.closes[i] > peak) peak = this.closes[i];
        }
        this.peakClose = peak;
        this.openedAt = this.pending.decidedAt;
      }
      // Rejected (or missing) buy: no cycle, no entry. Nothing to drop:
      // entries only ever gains a price on a confirmed fill.
    } else if (fill !== undefined && fill.status === 'filled') {
      this.entries = [];
      this.peakClose = -Infinity;
    }
    // Rejected sell: keep the cycle, the exit logic retries next bar.
    this.pending = null;
  }

  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    // Count this batch's filled orders (the harness's own _flatten_ fills
    // carry a client_id starting with '_' and never match ours; fills for
    // orders decided on earlier batches arrive here too).
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) this.fills++;
    }
    this.confirmPending(batch);

    // Record this batch's close, if the symbol has a bar.
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) this.closes.push(Number(bar.c));
    }

    if (state.warmingUp) return [];
    const k = this.closes.length - 1;
    if (k < 30 || this.pending !== null) return [];
    const closes = this.closes;
    const qty = this.heldQty(state);
    const ret30m = closes[k] / closes[k - 30] - 1;
    const ret5m = closes[k] / closes[k - 5] - 1;
    const dipping = ret30m < -DROP_BPS / 10000;
    const bouncing = ret5m > BOUNCE_BPS / 10000;

    if (qty === 0n && this.entries.length === 0) {
      // Flat: enter only on a deep dip whose bounce has started.
      if (dipping && bouncing && state.cash >= TRANCHE_SIZE && this.fills <= MAX_FILLS_BEFORE_BUY) {
        const clientId = `buy-${k}`;
        this.pending = { side: 'buy', clientId, decidedAt: k };
        return this.buyOrder(clientId);
      }
      return [];
    }

    if (this.entries.length === 0) return [];
    if (qty === 0n) return []; // position gone without a sell fill; wait

    // Holding: exits first. The cycle is a single tranche, so there is
    // no scale-in branch: entries.length is always 1 while holding.
    const avgEntry = this.avgEntry(state);
    if (closes[k] > this.peakClose) this.peakClose = closes[k];
    const unreal = closes[k] / avgEntry - 1;
    const effTrail = unreal >= RATCHET_BPS / 10000 ? TIGHT_TRAIL_BPS : TRAIL_BPS;
    if (closes[k] >= avgEntry * (1 + TARGET_BPS / 10000)
      || closes[k] <= this.peakClose * (1 - effTrail / 10000)
      || closes[k] <= avgEntry * (1 - STOP_BPS / 10000)
      || k - this.openedAt >= TIME_STOP) {
      const clientId = `sell-${k}`;
      this.pending = { side: 'sell', clientId, decidedAt: k };
      return this.sellOrder(state, clientId);
    }
    return [];
  }
}

const bot = new WashoutBot();
await runBars({ onBatch: (state, batch) => bot.onBatch(state, batch) });
