# `--tier good` versus the elite baseline

Run record: `2026-08-02-good.json` (schema 3, `completed: true`).
Baseline: `2026-07-29-elite.json` (schema 1, completeness **UNKNOWN** — it predates the field; see
the README's completeness contract, and do not read its absent `completed` as `false`).

Invocation, verbatim:

```
node tools/deployer-screen/screen.mjs --tier good --max-requests 90 \
  --out tools/deployer-screen/runs/2026-08-02-good.json
```

`--consistency` was deliberately **not** passed: it costs ~19.5 minutes of wall clock to measure
long-horizon steadiness, which is not what the question asks, and the standing captain position is
that long-horizon consistency is the wrong question for a PvP edge. Nothing below needed it.

## The question

Is a competent but **slow** dev the better target? The premise was that tier encodes launch
*volume*, so a quiet, steady, competent operator sits outside `elite` and had therefore never been
in our pool. **The premise about tempo holds. The conclusion it was meant to support is one
marginal wallet, not a population.**

## Spend

Planned worst case **90** keyed requests (3 enumeration + up to 87 gate), stated before spending.
**Actual: 68** — 3 enumeration + 65 profiles, 22 unspent against the run's own ceiling of 90.
That is ~34% of the ~200/day MadeOnSol allowance, so **`moderate` remains affordable today**.
Stage 2 spent **0 keyed requests** and 100 keyless pump.fun requests, 0 shed. Elapsed 1,130s.

## Distinct wallets surfaced, per seed

**No seed was inert.** All three answered with a full page under `tier=good`:

| seed | rows | rows carrying a wallet | **distinct wallets, among the 65 gated** | unique to this seed |
|---|---|---|---|---|
| `recent-bonds:good` | 50 | 50 | 19 | 2 |
| `alerts:good` | 50 | 50 | 24 | 8 |
| `leaderboard:total_bonded:good` | 50 | 50 | **50** | 34 |

7 wallets were surfaced by all three. **72 distinct wallets seeded**, 7 prefiltered before spending
a request, **65 gated, 0 dropped by the candidate cap** — a full screen of everything enumeration
surfaced, unlike the elite baseline which gated 12 of 22.

**Reading trap in the record, worth knowing before the next run.** `coverage.seeds[].walletsReturned`
is a **per-row** count — "rows we could read a wallet out of" — **not a distinct-deployer count**.
`recent-bonds:good` reports `50 rows / 50 wallets` and contributes **19** distinct deployers. The
elite record shows the same shape (`alerts:elite` 50/50 against 22 distinct overall). Distinct
per-seed yield has to be recomputed from `candidates[].seededBy`, and is only recoverable for gated
wallets — the 7 prefiltered entries carry a reason but no provenance.

Against elite, whose `recent-bonds` and `leaderboard` each returned only **12** rows: the elite
population those two feeds can reach is genuinely small, and `good` is not scarce in the same way.

## Launch tempo — the load-bearing number

Tempo is `tokens ÷ spanDays` from the profile the gate already paid for. Where the vendor page is
capped at 70 records the span is the span *of those 70*, so tempo stays a valid recent-window
measure even when the lifetime denominator is truncated.

**Gate-passers only** (the population the question is actually about), launches/day:

| | n | min | p25 | **median** | p75 | max |
|---|---|---|---|---|---|---|
| elite | 5 | 0.73 | 1.68 | **2.00** | 2.50 | 2.71 |
| good | 10 | 0.05 | 0.14 | **0.35** | 0.58 | 2.06 |

**Good-tier competent deployers are about 5.7× slower at the median, and the distributions barely
overlap: 9 of the 10 good-tier passers are slower than the slowest elite passer (0.73/day).** The
premise is evidence now, not inference.

The cleanest cut is the wallets where the vendor page capped at exactly 70 records, because the
denominator is then identical and only the span differs. Both rows below are **gate-passers only**,
the same population as the tempo table above — so elite's `4q4GKB…` (70 records over 3.01 days,
gate-failed on span) and good's `8KYMfX…` (111.7 days) and `ArfVe1…` (312.5 days), both gate-failed
on completion rate, are all excluded:

| | spans over the same 70 launches |
|---|---|
| elite, capped, gate-passed | 25.8, 28.0, 35.0 days |
| good, capped, gate-passed | 34.0, 121.1, 121.9, 156.8 days |

This is a correction: an earlier draw of this table mixed gate-passers and gate-failures across the
two rows, and the like-for-like cut **narrows the gap** it appeared to show. Stated at the strength
the corrected cut supports and no higher: over the same 70-launch denominator, elite gate-passers
take **26–35 days** to produce them and good-tier gate-passers take **34–157 days**.

All 65 graded wallets (64 with a defined tempo; one had 0 usable token records): p25 0.08,
median 0.21, p75 0.75, max 433 — the tail is short-lived spam that the gate rejects on span.

## Clearing the competence gate

| | graded | passed | rate |
|---|---|---|---|
| elite | 12 | **5** | 41.7% |
| good | 65 | **10** | 15.4% |

**Twice the absolute number of competent deployers, at a much lower rate.** The rates are not
like-for-like and should not be quoted against each other: elite graded 12 of 22 seeded, and
`mergeSeeds` orders by provenance count, so those 12 were the *most cross-listed* — the prominent
end of its pool. `good` graded everything it surfaced, tail included. 47 of the 55 good-tier
failures are `sample too small` (<25 tokens); 6 are genuine rate failures between 0.10 and 0.24.

Dominant failure mode differs: elite's 7 rejections were 6 small samples and 1 three-day burst.
Good's 55 are 47 small samples, 14 short spans, 6 low rates (wallets can fail on several).

## Entry — and the one result that matters

Stage 2 scored 3 of the 10 survivors (pinned cap). Every window walked cleanly: **24 of 24 usable,
0 drops of any cause, 0 shed**.

| wallet | tempo/day | median room | verdict |
|---|---|---|---|
| `B6QvkTWS…` | **0.05** | **0.574** | **`entry-room-present`** |
| `ALJ4P5QN…` | 0.57 | 0.290 | `entry-room-absent` |
| `7ufmve7Z…` | 2.06 | 0.281 | `entry-room-absent` |

**`B6QvkTWS…` is the first `entry-room-present` this screen has ever produced on a stranger**, and
it is the slowest deployer in the pool: 39 launches over 790 days, 12 bonded (30.8%).
The three scored wallets order by tempo exactly as the captain's reasoning predicts. **n = 3. That
is a coincidence-sized sample and must not be reported as a relationship.**

Five things keep that verdict honest:

- **It is a marginal pass.** The bar is a median room of 0.55; it read 0.574. The distribution is
  p25 0.393, min 0.000, and only **4 of 8** launches clear the bar. Half its launches leave nothing.
- **No co-ordination was detected at all** — `its own cohort` is 0.000 SOL on all 8 launches, so the
  room figure rests entirely on the size of the dev buy. The co-ordination rule only catches wallets
  that *share a create-slot transaction*. If this operator's helpers do not bundle, the measured room
  is an **overestimate**, and nothing in this run can distinguish the two cases.
- **The field leg is a hair from vetoing it**: 15/27 closed round trips positive (55.6%), median
  **+0.009 SOL gross of fees**, against a veto threshold of 0.50. For scale, our own subject
  `7ufmve7Z…` reads 86.7% positive and median +0.227 SOL gross on the same measure and is *known*
  to be unprofitable fee-inclusive (+0.54 SOL/launch across 106 wallets, 51 of them negative). A
  field sitting at break-even *before* costs is very likely losing after them.
- **The pass hangs on a single uncontested launch.** 1 of the 8 sampled launches had **zero
  outsiders** (`entry.launchesWithNoOutsider: 1`, `outsidersPerLaunch.min: 0`), and it is the top
  observation at `roomLeft.max` 0.973 — a room "hit" nobody was there to contest. With n = 8 the
  median 0.574 is the mean of the 4th and 5th sorted values, so dropping that one observation moves
  the median toward p25 (0.393) and very likely **below the 0.55 bar**. The one positive verdict in
  this run is that sensitive. `ALJ4P5QN…` has 2 such launches and still reads `entry-room-absent`,
  so this bears only on the positive verdict.
- `entry-room-present` means only that **the exit question is worth asking**. Exit is unmeasured,
  every P&L above is gross of fees and an upper bound, and lead time and actor independence are
  unmeasured.

`7ufmve7Z…` re-measured live at median room **0.281** against Stage 0's stored-tape **0.284** — the
live path agreeing with ground truth to 0.003 on a wallet we hold the answer for.

## Two findings about the vendor's tiers

**1. `elite` and `good` are not disjoint populations.** `7ufmve7Z…` was surfaced by **all three
seeds under `tier=elite`** on 2026-07-29 and by **all three seeds under `tier=good`** four days
later, with its own numbers essentially unchanged (70 tokens, span 35.01 → 34.05 days). `Eh3q5AXn…`
likewise appears in both runs. Either tier membership moved under a wallet that did not, or the
filter is not a partition. We hold no definition of either tier and cannot tell which without
spending more quota, but the consequence binds either way: **"outside elite" is not a stable
property, and a screen cannot treat the tiers as a clean population split.** This is the same
failure mode as their `bonding_rate` — a trailing window presented as a standing label.

**2. `rising`-shaped wallets appear inside the `good` feed.** All 7 prefiltered wallets were
3–4 deploys at a perfect rate — the vendor's own published `rising` definition — reached through
`tier=good`. The prefilter caught them before they cost a request.

## What this does and does not settle

- **Settled: good-tier competent deployers are genuinely slower than elite ones.** ~5.7× at the
  median, near-disjoint distributions. The premise was correct.
- **Settled: `good` is the richer hunting ground in absolute terms** — 10 competent deployers from
  one run against elite's 5, from a pool the screen covered in full.
- **Not settled: whether slow devs leave more room.** One marginal `entry-room-present` out of three
  scored, on a wallet with no detected co-ordination and a break-even field. The honest reading is
  *one candidate worth a closer look*, not *slow devs are beatable*.
- **Not answered here: the other 7 survivors.** The pinned scoring cap of 3 spent one of its slots
  re-measuring `7ufmve7Z…`, which `mergeSeeds` ranked first because all three seeds carried it. That
  bought a live control worth having, but 7 competent deployers went unscored for entry. Scoring
  them costs **no keyed quota** — Stage 2 reuses profiles already paid for — but a rerun would spend
  65 keyed requests re-fetching those profiles, since nothing is cached by design.

## Suggested next call, which is the captain's

Either **(a)** score the remaining 7 good-tier survivors, or **(b)** spend the remaining ~130
requests on `--tier moderate` to test whether the tempo gradient continues. Both are affordable
today; doing both is not. If the tempo story is the thing being tested, `moderate` extends the
gradient by a third point. If `B6QvkTWS…` is the thing being tested, it needs exit analysis
(Stage 3, not built) far more than it needs another tier.
