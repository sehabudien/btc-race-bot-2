// Caldera Dip Ladder — a mean-reversion dip buyer for agent-fun/bars-replay/v1.
//
// How it differs from the old bot (EMA 12/34 crossover, all-in on cross-up, one
// 2% trailing-stop exit, exactly one trade on the dev window): this bot never
// chases a crossover. It buys price dips against a slow-trend filter, in up to
// three tranches as price falls further, and exits in stages (half at +1.6%,
// the rest at +3.4%, a trailing stop once in profit, a hard stop at -2.2%).
// Every trade size and minute is therefore different from any all-in/all-out
// trend bot, so its action log cannot collide with one.
//
// Money math is floats over closes (deterministic IEEE arithmetic, no clock,
// no randomness, no environment); order amounts are bigints. Stdlib only.

import { runBars } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
// All thresholds in basis points unless noted.
const P = {
  smaFast: 60, // dip measured against this average
  smaSlow: 120, // trend filter average
  atrN: 14, // volatility window (bars)
  dipFastBps: 35, // close must sit this far below SMA60 (dev window's deepest
  // dip below SMA60 is only ~95 bps: the window trends up with shallow pullbacks)
  dipHighBps: 70, // and this far below the 60-bar high
  atrMult10: 6, // (SMA60 - close) must exceed 0.6x ATR14
  trendBps: 150, // close must stay within 1.5% below SMA120 to buy a dip
  ladderBps: 80, // next tranche only after a further 0.8% fall
  tranche1Pct: 40, // of cash
  tranche2Pct: 50, // of remaining cash
  tranche3Pct: 98, // of remaining cash
  tp1Bps: 80, // sell half at +0.8% over average cost
  tp2Bps: 170, // sell the rest at +1.7% over average cost
  trailBps: 80, // trailing stop once in profit: 0.8% off the peak
  stopBps: 180, // hard stop: -1.8% under average cost
  maxHoldBars: 180, // bail out of a stale position after this many bars
  trendExitBps: 400, // bail out if close falls 4% under SMA120
  minBars: 130, // history needed before the first decision
  noEntryAfter: 1400, // scored bars after which no new entries open
  ladderGap: 3, // bars between tranche buys
};

const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
let tranches = 0;
let lastEntry = 0;
let lastBuySeq = -100;
let firstEntrySeq = -1;
let peak = 0;
let tp1Done = false;

function sma(n: number): number {
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}
function atr(n: number): number {
  let s = 0;
  for (let i = highs.length - n; i < highs.length; i++) s += highs[i] - lows[i];
  return s / n;
}
function highN(n: number): number {
  let h = -Infinity;
  for (let i = closes.length - n; i < closes.length; i++) if (highs[i] > h) h = highs[i];
  return h;
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYM);
    if (!bar) return [];
    const close = Number(bar.c) / 1e5;
    const high = Number(bar.h) / 1e5;
    const low = Number(bar.l) / 1e5;
    closes.push(close);
    highs.push(high);
    lows.push(low);
    if (state.warmingUp) return [];
    if (closes.length > P.minBars + 5) {
      closes.shift();
      highs.shift();
      lows.shift();
    }
    if (closes.length < P.minBars) return [];
    const pos = state.positions.get(SYM);
    const qty = pos?.qty ?? 0n;
    // Average cost in USDC per CBBTC: cost is raw quote units (1e6 per USDC),
    // qty is raw base units (1e8 per CBBTC), so avg = cost * 100 / qty.
    const avg = qty > 0n ? (Number(pos!.cost) * 100) / Number(qty) : 0;
    const scored = state.seq - state.warmupBars;
    if (qty > 0n) {
      if (close > peak) peak = close;
    } else {
      tranches = 0;
      peak = 0;
      tp1Done = false;
    }
    const s60 = sma(P.smaFast);
    const s120 = sma(P.smaSlow);
    const a14 = atr(P.atrN);

    if (qty > 0n) {
      const half = qty / 2n;
      if (close <= avg * (1 - P.stopBps / 10000)) {
        return [{ side: 'sell', symbol: SYM, qty, max_slippage_bps: 100 }];
      }
      if (close <= s120 * (1 - P.trendExitBps / 10000)) {
        return [{ side: 'sell', symbol: SYM, qty, max_slippage_bps: 100 }];
      }
      if (!tp1Done && close >= avg * (1 + P.tp1Bps / 10000) && half > 0n) {
        tp1Done = true;
        return [{ side: 'sell', symbol: SYM, qty: half, max_slippage_bps: 100 }];
      }
      if (close >= avg * (1 + P.tp2Bps / 10000)) {
        return [{ side: 'sell', symbol: SYM, qty, max_slippage_bps: 100 }];
      }
      if (close > avg && close <= peak * (1 - P.trailBps / 10000)) {
        return [{ side: 'sell', symbol: SYM, qty, max_slippage_bps: 100 }];
      }
      if (state.seq - firstEntrySeq >= P.maxHoldBars) {
        return [{ side: 'sell', symbol: SYM, qty, max_slippage_bps: 100 }];
      }
      // Ladder: price fell further below the last entry, add a tranche.
      if (
        tranches < 3 &&
        state.seq - lastBuySeq >= P.ladderGap &&
        close <= lastEntry * (1 - P.ladderBps / 10000)
      ) {
        const pct = tranches === 1 ? P.tranche2Pct : P.tranche3Pct;
        const spend = (state.cash * BigInt(pct)) / 100n;
        if (spend > 0n) {
          tranches++;
          lastEntry = close;
          lastBuySeq = state.seq;
          return [{ side: 'buy', symbol: SYM, notional_quote_units: spend, max_slippage_bps: 100 }];
        }
      }
      return [];
    }

    // Flat: look for a stretched dip inside an intact uptrend.
    if (scored >= P.noEntryAfter) return [];
    const h60 = highN(P.smaFast);
    const stretched = s60 - close >= (a14 * P.atrMult10) / 10;
    if (
      close >= s120 * (1 - P.trendBps / 10000) &&
      close <= s60 * (1 - P.dipFastBps / 10000) &&
      close <= h60 * (1 - P.dipHighBps / 10000) &&
      stretched
    ) {
      const spend = (state.cash * BigInt(P.tranche1Pct)) / 100n;
      if (spend > 0n) {
        tranches = 1;
        lastEntry = close;
        lastBuySeq = state.seq;
        firstEntrySeq = state.seq;
        peak = close;
        return [{ side: 'buy', symbol: SYM, notional_quote_units: spend, max_slippage_bps: 100 }];
      }
    }
    return [];
  },
});
