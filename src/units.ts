/**
 * Branded SOL units.
 *
 * The single most expensive mistake available in this dataset is adding up a
 * tape-derived P&L column and reading the result as money. `report.md` §5.5:
 * `2CQgjcdN…` is +31.2 SOL on the tape and **−12.2 SOL in reality**, after 11.9 SOL of
 * priority fees it paid to reach the create slot. A backtest built on swap quotes alone
 * would have hired it.
 *
 * So SOL is not `number` here. It is one of two mutually unassignable brands:
 *
 * - {@link GrossSol}  — from `swap-api.pump.fun` swap quotes. Excludes the venue fee and
 *   the transaction's own priority fee. Every column of every `*.csv` in the dataset
 *   except `onchain_*.csv` is this.
 * - {@link NetSol}    — a real lamport delta read off the chain. Nets fees, the swap and
 *   rent. Only `onchain_create_slot_pnl.csv` and `onchain_fee_sample.csv` are this.
 *
 * You cannot add one to the other, pass one where the other is expected, or sum a mixed
 * array — the compiler stops you. To go from gross to net you must actually measure the
 * fees; there is deliberately no conversion function, because there is no conversion.
 */

declare const GROSS: unique symbol;
declare const NET: unique symbol;

/** SOL from a pump.fun swap quote. **Excludes venue and priority fees.** */
export type GrossSol = number & { readonly [GROSS]: 'gross-of-fees' };

/** SOL as a true on-chain lamport delta. **Fees, swap and rent already netted.** */
export type NetSol = number & { readonly [NET]: 'fee-inclusive' };

/** Any SOL quantity, when the caller genuinely does not care which. Rare. */
export type Sol = GrossSol | NetSol;

/** Tag a raw number as gross-of-fees. Only the CSV readers should call this. */
export const grossSol = (n: number): GrossSol => n as GrossSol;

/** Tag a raw number as fee-inclusive. Only the `onchain_*` readers should call this. */
export const netSol = (n: number): NetSol => n as NetSol;

/** Lamports → fee-inclusive SOL. The `onchain_*` files are denominated in lamports. */
export const lamportsToNetSol = (lamports: number): NetSol => netSol(lamports / 1e9);

/**
 * Strip the brand. Named to be conspicuous in a diff and in a code review: if this
 * appears in an aggregation, the aggregation has lost its fee semantics.
 */
export const unsafeUnbrand = (n: Sol): number => n as number;

// -- aggregation, brand-preserving -------------------------------------------------

export const sumGross = (xs: readonly GrossSol[]): GrossSol =>
  grossSol(xs.reduce((a, b) => a + (b as number), 0));

export const sumNet = (xs: readonly NetSol[]): NetSol =>
  netSol(xs.reduce((a, b) => a + (b as number), 0));

const medianOf = (xs: readonly number[]): number => {
  if (xs.length === 0) throw new Error('median of an empty set');
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

export const medianGross = (xs: readonly GrossSol[]): GrossSol => grossSol(medianOf(xs as readonly number[]));
export const medianNet = (xs: readonly NetSol[]): NetSol => netSol(medianOf(xs as readonly number[]));

/**
 * Linearly-interpolated percentile (numpy's default, `method='linear'`).
 *
 * The convention matters and was determined empirically, not assumed: nearest-rank gives
 * the cohort p25 as −0.2372 where `report.md` §5.5 publishes −0.238, and linear
 * interpolation gives −0.2382. All four published p25/p75 figures in that table match
 * linear interpolation exactly, so that is what the scout used.
 */
export const percentile = (xs: readonly Sol[], q: number): number => {
  if (xs.length === 0) throw new Error('percentile of an empty set');
  const s = [...(xs as readonly number[])].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, s.length - 1);
  return (s[lo] as number) + (h - lo) * ((s[hi] as number) - (s[lo] as number));
};

/** Share of values strictly greater than zero. */
export const fractionPositive = (xs: readonly Sol[]): number => {
  if (xs.length === 0) throw new Error('fraction positive of an empty set');
  return (xs as readonly number[]).filter((x) => x > 0).length / xs.length;
};
