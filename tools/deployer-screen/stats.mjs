/**
 * The exact (Clopper–Pearson) binomial interval, and the incomplete beta function it inverts.
 *
 * ## Why this module exists at all
 *
 * It holds ONE implementation of a thing this repository had already written once, in a measurement
 * directory (`measurements/2026-08-10-entry-cost-cleared-fifteen/summarise.mjs`), and which a
 * production score now needs as well. A second copy would be two implementations of an interval —
 * and an interval that disagrees with the one a committed record was published under is worse than
 * no interval, because both look authoritative. The measurement re-exports this module rather than
 * keeping its own, so `test/entry-cost-cleared-fifteen.test.ts`'s pins are pins on THIS code.
 *
 * It imports nothing, reads no file, opens no socket and names no vendor, which is what lets a
 * scoring module take an edge to it (`test/deployer-screen.test.ts` → "a scoring module imports only
 * from a declared pure set"; that allow-list was edited on purpose to admit this one).
 *
 * ## Why exact rather than normal-approximate
 *
 * Every rate this repository reports is over a small, hard-won n — a hit rate over the closed round
 * trips of ten walked windows, a share of six candidates — and the normal approximation is at its
 * worst exactly there: it can put an interval outside [0, 1], and it is anti-conservative near 0 and
 * 1, which on this project is the direction that manufactures a finding. Clopper–Pearson is
 * conservative by construction, which is the direction the captain's standing evidence bar asks for.
 */

/**
 * The regularized incomplete beta function `I(x; a, b)`, by the standard continued fraction.
 *
 * Written here rather than depended on: this repo has no runtime dependency and is not going to
 * acquire one for a confidence interval.
 *
 * @param {number} x @param {number} a @param {number} b @returns {number}
 */
export function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  // Lentz's algorithm on the continued fraction, which converges for x < (a+1)/(a+b+2); the
  // symmetry `I(x;a,b) = 1 - I(1-x;b,a)` covers the rest.
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
  const tiny = 1e-30;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 300; i++) {
    const m = Math.floor(i / 2);
    /** @type {number} */
    let numerator;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = (-((a + m) * (a + b + m)) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-14) break;
  }
  return front * (f - 1);
}

/** @param {number} z @returns {number} */
function lgamma(z) {
  // Lanczos, g = 7, n = 9 — accurate to ~1e-13 over the range a confidence interval needs.
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  const x = z - 1;
  let a = g[0] ?? 0;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += (g[i] ?? 0) / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * The exact (Clopper–Pearson) two-sided 95% interval for `k` of `n`.
 *
 * Bisection on {@link incompleteBeta} rather than a beta-quantile library, for the same
 * no-dependency reason. `n === 0` returns `null` — an interval over nothing is not an interval.
 *
 * @param {number} k @param {number} n @param {number} [alpha]
 * @returns {{ k: number, n: number, rate: number, lo: number, hi: number } | null}
 */
export function clopperPearson(k, n, alpha = 0.05) {
  if (n === 0) return null;
  /** @param {number} target @param {number} a @param {number} b */
  const invert = (target, a, b) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (incompleteBeta(mid, a, b) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return {
    k,
    n,
    rate: k / n,
    lo: k === 0 ? 0 : invert(alpha / 2, k, n - k + 1),
    hi: k === n ? 1 : invert(1 - alpha / 2, k + 1, n - k),
  };
}
