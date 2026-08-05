# The MadeOnSol Ultra pacing measurement — 2026-08-05

**Captain decision 267a required `budget.keyedMinIntervalMs` to be RE-MEASURED on the new tier
rather than carried across from the Free tier.** This is that measurement. It is committed here
because the pinned value's justification cites it, and a justification citing a measurement nobody
can read is a justification citing nothing.

It also records two vendor facts that fell out of the same session and that other lanes will want:
the daily counter's shape, and one endpoint whose entitlement changed.

## What the old value rested on, and why it had to be re-checked

`budget.keyedMinIntervalMs` was **6,500 ms**, justified as:

> Free tier bursts at ~10/minute. […] This is the vendor's rate limit, not our caution, so raising
> the daily bounds does not touch it.

That is exactly the class of claim that has to be re-checked when the tier changes: it was true of
the Free tier, it was recorded as a property of the vendor rather than of the plan, and nothing in
the code could notice it becoming false.

## Method

One request in flight, serial, no concurrency — the shape `BoundedClient` actually produces. Fixed
rungs of enforced interval between request *starts*, counting shed events (HTTP 429) and any
non-200. The same shape as the Helius ladder recorded at
`thresholds.json` → `creation_walk_helius.justification.rpcMinIntervalMs`.

Two endpoints, because a limiter could plausibly be per-endpoint:
`/deployer-hunter/leaderboard?sort=total_bonded&limit=1` (cheap, and one of the three seeds) and
`/deployer-hunter/{wallet}` (the gate's own endpoint — the one a run actually spends its allowance
on, one request per candidate).

## The ladder — `/deployer-hunter/leaderboard`, 12 requests a rung

| enforced interval | n | shed | other non-200 | p50 | min | max | wall | rate |
|---|---|---|---|---|---|---|---|---|
| 6,500 ms | 12 | **0** | 0 | 412 ms | 372 | 864 | 77.3 s | 0.16/s |
| 2,000 ms | 12 | **0** | 0 | 319 ms | 309 | 587 | 26.3 s | 0.46/s |
| 500 ms | 12 | **0** | 0 | 317 ms | 293 | 352 | 9.3 s | 1.29/s |
| **0 ms** | 12 | **0** | 0 | 312 ms | 304 | 359 | 3.9 s | 3.11/s |

## The sustained burst — the test that actually kills the ~10/minute claim

**60 back-to-back requests at 0 ms: 19.7 s, 3.05 req/s, ≈183/minute sustained, `shed = 0`.**

A ~10/minute limiter refuses request 11 inside the first ten seconds. It did not.

## The gate's own endpoint — `/deployer-hunter/{wallet}`, 30 back-to-back at 0 ms

**0 shed, p50 182 ms, min 178, max 761, 6.1 s, 4.95 req/s.** `x-ratelimit-used` advanced by
**exactly 30**, so the counter is per-request and **global across endpoints**, not per-endpoint.

## What the measurement concludes

- **The ~10/minute burst limit does not describe this tier.** 6,500 ms was buying nothing.
- **What binds is response latency, not a limiter** — p50 312 ms on the leaderboard, 182 ms on the
  profile endpoint — so one serial client tops out near 3–5 req/s whatever the interval says. Same
  shape as the Helius finding: latency-bound, not limit-bound.
- **250 ms is pinned as a COURTESY FLOOR, not a shed-avoidance figure.** It sits at or below the
  measured latency of both endpoints, so it costs a run essentially nothing while keeping a serial
  floor in place rather than none at all. It is the number this repo already pins for its other
  keyed host (`dune.minIntervalMs`) and one rung above the Helius floor (200 ms), both measured the
  same way on vendors that also shed nothing.
- **Wall-clock consequence:** the keyed leg of a full 201-request run goes from **~21 minutes to
  ~50 seconds**. It was never the run's wall clock and still is not — the creation walk dominates by
  an order of magnitude.

## What it does NOT establish

Stated here rather than left to be discovered by someone quoting it wider than it reaches:

- **One day, ~150 requests.** It bounds nothing about a sustained multi-hour leg.
- **Serial only.** No probe put several requests in flight, so it says nothing about concurrency.
  The Helius pin has a concurrency probe (150 simultaneous, all answered 200); this one does not.
- **It cannot see a limiter that only bites above ~183/minute**, because serial pacing structurally
  cannot reach higher.

What would extend it: the same ladder repeated across several days, and a concurrency probe of the
shape `creation_walk_helius.rpcMinIntervalMs` records.

## Two vendor facts from the same session

**The daily counter.** `x-ratelimit-limit: 100000`, `x-ratelimit-reset: 1785974400` (00:00Z),
`x-ratelimit-used` / `x-ratelimit-remaining` on every response. Confirms the Ultra facts captain
recorded, off the wire rather than off a pricing page. **Nothing in this repository reads these
headers** — that gap is unchanged by the upgrade, and it is why `client.mjs` →
`MADEONSOL_DAILY_REQUESTS` is a pinned constant rather than a live reading.

**`/deployer-hunter/{wallet}/history` is now REACHABLE and is still not requested.** It was PRO+ and
out of reach on the Free tier; the Ultra key answers it `200`. It returns daily snapshots of
`bonding_rate` / `total_deployed` / `recent_bond_rate` — the trailing-window aggregates this tool
refuses to read at any single instant — so **the reason it is skipped changed from entitlement to
design**, and `render.mjs`'s "NOT REQUESTED, deliberately" block now says so. Its one snapshot also
happened to show the known-negative control `7ufmve7Z…` reading `tier: "good"` that day, which is
the tier drift `runs/2026-08-02-good-vs-elite.md` already owns; nothing here acts on it.

## Spend

**139 keyed requests** of a 100,000/day allowance (0.139%): 1 header read, 48 ladder, 60 burst, 30
profile. `x-ratelimit-used` moved 389 → 527 across the session, agreeing with the local count to one
request. Captain's standing instruction of 2026-08-02 — *spend the allowance when spending it gets
results* — is what licenses it, and the conditional binds: this run answered a question 267a asked
in advance.

**No Dune execution was spent.** The one Dune request in this lane was a cached `/results` read
against the production coverage query `8204603` at `?limit=40000`, to verify the vendor accepts the
raised limit before `dune.maxResultRows` moved (captain decision 264a). It returned **HTTP 200**,
6,924 bytes — a fraction of a credit, and no execution.
