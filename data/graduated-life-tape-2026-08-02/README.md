# `graduated-life-tape-2026-08-02` — the launch tape, extended past the bond

<!-- requests:6539 -->

Every fill of all **103 graduated launches**, from each one's **mint to one hour after it
graduated**. It extends `data/population-tape-2026-07-29/`, whose window is the launch's first
**60 seconds on 83 of these 103, 120 s on 3 and 300 s on 17**, and it is built from the same
keyless endpoint in the same row schema so the two concatenate.

**Cost: EUR 0.** 6,539 keyless requests to `swap-api.pump.fun`, no account, no credential, no
metered provider request of any kind. That is captain decision **112a** — decline MadeOnSol Pro at
EUR 43/mo, extend our own tape instead — and `data/decisions/112-madeonsol-pro-decline.md` is the
record. `tools/graduated-life-tape/` is the collector; `test/graduated-life-tape.test.ts` enforces
the keyless property structurally rather than trusting it.

---

## Why the window moved

In this population the median bond lands at **+17.2 minutes**. So the committed window — 60 seconds
on 83 of these 103 launches, 120 s on 3 and 300 s on 17 — ends at roughly **27% of the bond price**,
and **it ends while most counterparties are still holding**. Their P&L in the existing tape is
therefore an artefact of where the window stopped rather than of what they did.

The baseline below is **each launch's own committed window**, read from that launch's
`window/{mint}.meta.json` → `window_ms`, not a uniform 60-second cut. The distinction is not
cosmetic: a flat 60 s baseline reports a window a fifth of this population was never collected over,
and it overstates the uplift by ~6 points.

Measured on this tape, over the **26,404 (wallet, launch) pairs visible inside each launch's own
committed window** — the exact population the committed tape publishes P&L for:

| cut at | complete round trips |
|---|---:|
| each launch's own committed window | 12,463 — **47.2%** |
| graduation + 1 hour (this tape) | 24,922 — **94.4%** |

**12,459 pairs — 47.2% of the published population — go from an incomplete position to a complete
round trip.** Those are the same wallets under the same closure rule; only the window end changed.

Read the two numbers below with care, because they do **not** compare the same wallets: across the
whole of this tape 116,020 pairs are visible and 78.5% of them close, but the wider window contains
far more wallets than the narrow one. The like-for-like comparison is the table above, and it is the
one this tape supports.

---

## What is here

| file | |
|---|---|
| `graduation.csv` | The graduation instant of all 103 launches, with the bracket and the method that produced each. |
| `life/{mint}.jsonl.gz` | The fills, ascending by `sid`, in the population tape's row schema. |
| `life/{mint}.meta.json` | Per-launch coverage: window bounds, page and request counts, the coverage **proof**, and the create-slot cross-check. |
| `coverage.csv` | Roll-up of the sidecars plus per-launch closure counts, with `committed_window_s` naming the baseline cut each launch was evaluated at. Regenerate with `summarise.mjs`. |
| `requests.csv` | **One row per request attempt**, retries and refusals included. The run's exact cost. |

Regenerate every derived number from the committed data:

```bash
node tools/graduated-life-tape/summarise.mjs data/graduated-life-tape-2026-08-02
```

### Row schema

Identical to `data/population-tape-2026-07-29/window/*.jsonl.gz`, field for field, so a committed
window file and a life file concatenate without translation:

`slot` · `sid` · `tx` · `ts` · `u` (the swapping wallet) · `k` (`buy`/`sell`) · `p` (venue) ·
`sol` · `base` · `psol` · `pusd`

**`p` is the venue and it is the new column that matters**: `pump` is the bonding curve, `pump_amm`
is PumpSwap. **316,201 of the 503,037 fills here are `pump_amm`** — 62.9% of this tape is trading
that happened after graduation, which no opening window could contain at all.

---

## How it was collected, and what it cost

Two phases, both keyless, both paced at a **4-second floor with adaptive backoff**. Full method in
`tools/graduated-life-tape/README.md`.

| phase | requests | what it did |
|---|---:|---|
| graduation | 857 | Pinned all 103 graduation instants by geometric bisection on the venue field. |
| life | 5,682 | Walked all 103 launches from graduation + 1 h back to the mint, 5,081 pages. |
| **total** | **6,539** | 3 transport failures, **0 endpoint refusals**. |

**The cost projection this lane was scoped on did not hold, and the miss is worth recording.**
`kol-bond-timing-vs-dev-exit` §5 costed this shape at **1,000–4,000 requests**, roughly a quarter of
the ~9,500 for a naive whole-life walk on all 239 launches. It actually cost **6,539 — about 69% of
the naive walk, not 25%.** The narrowing was still right (the 136 non-graduated launches really do
hold nothing), but the *per-launch* estimate of 10–40 pages was low by roughly a factor of two:
actual pages per launch ran **median 46, p90 89, max 179**. Anyone re-planning a walk on this
endpoint should size it from those numbers, not from §5's.

Wall clock ~6 hours across two legs.

**29 further requests were spent outside this ledger** and are not in `requests.csv`: 3 exploratory
probes confirming the cursor's seek semantics, a 22-request 2-launch smoke test written to a scratch
directory, and 4 probes reconciling one graduation instant against the scout's independent
measurement (below). They produced no committed data. The honest total for the lane is **6,568**.

### Graduation timing

Pinned by bisecting the **monotone** venue field: a token is on the curve, then on PumpSwap, and
never goes back, so *"had it graduated by instant T"* is a monotone predicate over a seekable index.

| source | launches | what it means |
|---|---:|---|
| `tape` | 18 | Bracketed inside the committed window. **Zero requests.** |
| `page` | 60 | A fetched page held both venues, bracketing the migration between two adjacent fills. |
| `bisect` | 25 | Converged bracket. |

Distribution from mint: **p10 37 s · median 1,033 s (17.2 min) · p90 11,241 s.**
Bracket width: **median 2 s**, p90 148 s.

**`grad_ms` is the bracket's upper end** — the earliest instant *known* to be post-migration. The
walk's window is `grad_ms + 1 hour`, so bracket imprecision makes it cover **more** than the true
window, never less.

### Cross-checked against an independent measurement

`kol-bond-timing-vs-dev-exit` §2.1 measured the same 103 instants and its output never reached a
repository. Re-derived here rather than transcribed, then compared:

- **33 identical**, **69 agree within their brackets**, **1 required investigation**.
- The one, `Eşek`, was settled with 4 direct probes: at this tape's lower bound the venue is still
  `pump`, above it `pump_amm`, so **this tape's bracket is correct**. The two measurements do not
  disagree — that report's `bisect` rows report the bracket's *lower* end where this one reports the
  upper.
- Independent agreement on the aggregates too: **18 free from the local tape** (their count exactly),
  **median bracket 2 s** (theirs exactly), **median bond +17 min** (theirs exactly), 857 requests
  against their 871.

---

## Coverage, and how it is proved

Rows come back **newest first**, so the walk runs backwards and reaches the create slot **last**. A
backwards walk that stops early does not fail — it returns a plausible pile of fills whose earliest
slot is merely the earliest it saw. So coverage here is never inferred from "we ran out of pages".
Only two things establish it, and `reached_mint` in each sidecar is that proof, not a guess:

- a fill strictly older than the bound is present, or
- the endpoint states there is nothing older.

**102 of 103 launches proved coverage to the mint.**

**A second, independent check runs on every launch that has one.** The committed window tape
proved its own coverage of the create slot; a life walk claiming to have reached the mint must land
on the same slot. **99 of 99 applicable launches agree. Zero disagreements.** The other 4
(`Marciana`, `Leo`, `Fridge` and `69420`) have no covered window tape to check against — which for
three of them is itself a gain, below.

### Three launches that previously had no trade tape at all

`Marciana`, `Leo` and `Fridge` are listed in the population tape as having no tape, which is why the
predecessor could not measure their dev exits. They now have complete lives — 4,846 / 2,697 / 9,737
fills, every one reaching the mint with the endpoint confirming nothing older exists.

---

## What this tape does not establish

1. **Every P&L derivable from it is GROSS OF FEES and is an upper bound.** This is a fill tape; only
   `onchain_*.csv` in the population tape is fee-inclusive. The trap is concrete: on this deployer's
   own post-break field over all 89 launches, gross reads 358/469 closed round trips positive, while fee-inclusive the
   same population made +0.54 SOL per launch with **51 of 106 wallets negative**. A verdict resting
   on a gross figure from this tape can have the wrong sign. Nothing here publishes a SOL quantity,
   and `summarise.mjs` is asserted by test to contain none.
2. **One launch is truncated and it is missing its mint end.** `69420` bonded ~20 days after its
   mint, so its `mint → graduation + 1 h` window is 20.7 days; the walk covered **1.5%** of it and
   completing it would cost ~6,565 more pages (~7 hours). It is recorded `truncated: true` with its
   covered span in the sidecar. Because a backwards walk loses its **oldest** end, what is missing
   is the mint end — the valuable one. **Do not treat `69420`'s oldest fill as its create slot.**
3. **The 136 non-graduated launches are not here at all**, by design. 98 of them sit within 1% of
   the empty curve with under 0.1 SOL of reserves and a median 42 days since their last trade. Any
   population statistic computed over this directory alone is conditioned on graduation.
4. **One hour past the bond is a choice, not a natural boundary.** It covers the median peak
   (1.21× the bond) and closes 94.4% of the early pairs, and it leaves everything after it
   unmeasured. A position still open at graduation + 1 h is still open here.
5. **Graduation is the first PumpSwap *trade*, not the migration instruction.** Those differ by 0–3
   seconds where both are visible — immaterial at a median bond of +17 minutes, and unusable by
   anyone needing sub-second precision.
6. **239 launches is a floor, not the population.** pump.fun lists by *current* creator and the
   record moves; the one launch known to have been missed was this operation's best result by two
   orders of magnitude. This tape inherits that ceiling whole and does nothing to lift it.
7. **This is one deployer over three regimes.** The create slot paid outsiders only between
   2026-03-12 and 2026-06-04. A whole-tape aggregate over this directory mixes the three, and
   **"how many windows are there" is still n = 1**.
8. **Nothing here is a strategy, a backtest or a signal.** It is a record of what happened.

---

## Provider facts learned building it

- **The endpoint refused nothing at a 4-second floor.** 6,539 attempts, **zero HTTP 429**, three
  transport failures. That contradicts the committed tape's own build metadata — 16,960 shed
  against 51,715 OK, 24.7% — and the difference is pacing, not luck: that build ran a `delay` as low
  as 0.75 s. At 4 s with adaptive backoff the shed rate on this endpoint is **nil**. It refuses
  essentially everything at 2 s.
- **Pages per launch for a `mint → graduation + 1 h` window: median 46, p90 89, max 179.** The
  planning estimate of 10–40 was low by roughly a factor of two, and seven launches exceeded a
  100-page ceiling on the first pass.
- **A page ceiling truncates the wrong end.** Six of the seven needed only 1–53 more pages and were
  re-walked to completion at `--max-pages 300`. Sizing that re-walk from each sidecar's covered span
  cost nothing and separated the six cheap cases from the one hopeless one.
