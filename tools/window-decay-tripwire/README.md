# The window-decay tripwire — detecting the moment a profitable window CLOSES

**Question**, in the captain's words (2026-08-02), after being shown that the one window on record
ran for 83 days and then died in a single launch:

> "it changes what the tool needs to be good at: not catching brief flickers, but noticing the
> moment a long-running thing stops."

**Mode:** the detector is offline arithmetic; the watcher reads two **keyless** hosts. **Zero
metered provider requests, zero token, no credential of any kind** — enforced structurally by
`test/window-decay-tripwire.test.ts`, whose credential allow-list for this directory is empty.

**Reproduce:**

```bash
node tools/window-decay-tripwire/backtest.mjs   # every number below, offline, ~1 s
npm test                                        # tsc --noEmit, then the assertions
```

---

## The bottom line

> **The window closed in 24.7 hours. This tripwire raises STOP AND ROTATE 24.1 hours after the
> regime changed, having eaten two launches that cost every outsider on them
> −1.37 SOL fee-inclusive between them.** It is, to within an hour, as fast as the thing it is detecting.
>
> <!-- close-speed-hours:24.7 --><!-- alarm-hours:24.1 --><!-- avoided-hours:26.0 -->
>
> | | |
> |---|---|
> | the close, `Banknote` → `Peque` | **24.7 h**, one launch |
> | STOP AND ROTATE raised, at `PvE`'s create slot | **+24.1 h** after the regime changed |
> | first launch not entered, `maxxing` 2026-06-05T14:09 | **+26.0 h** |
> | launches entered under the new regime | **2** (`Peque`, `PvE`) |
> | what those two cost | −1.02 SOL gross, **−1.37 SOL fee-inclusive**, every outsider on them, 9 of 9 round trips priced |
>
> **It is not a P&L test, and that is why it is fast.** It watches the *deployer's own take* — the
> operation's share of the bottom of its curve, the June report's **T1** — which is readable from a
> launch's create slot seconds after the mint and does not wait for anybody's position to close. The
> P&L variance test the same close was previously characterised on needs 48.3 hours to reach the
> same conclusion, with more false alarms, not fewer.
>
> **False alarms: 0 in the 104 open-window launches it could read** — but zero events is not a rate
> of zero, and the honest ceiling is on that number rather than on the latency. **§4 states it in
> full: at the top of the range this sample allows, the instrument would cost more than half the
> window it protects.** One window is one window.
>
> **What it cannot detect at all is a gradual close.** It is a step detector, built on the only
> close ever observed, which was a step. Nothing here would notice four weeks of erosion, and no
> data in this repo says whether that shape exists.

**Confidence.** *High* on the latency, the false-alarm count and the cost of both errors: they are
complete-set measurements over the committed tape, replayed through the production detector.
*None at all* on whether any of it generalises — `n = 1`, one close, one deployer.

---

## 1. Spend accounting

**Metered provider requests: ZERO. Token cost: ZERO. Credentials read: NONE.**

| surface | used | how it is bounded |
|---|---|---|
| `data/population-tape-2026-07-29/` | the whole of §3–§8 | no network at all |
| `swap-api.pump.fun/v2/coins/{mint}/trades` | the live watcher's create-slot reads | keyless; `maxPagesPerLaunch` × `maxLaunchesPerRun`, inside a per-run attempt ceiling |
| `frontend-api-v3.pump.fun/coins?creator=` | the live watcher's launch list | keyless; **one** request per run, and only when `--mints` is not given |
| MadeOnSol, Helius, Dune, SolanaTracker, CoinGecko | **not contacted, and unreachable** | `HOSTS` in `client.mjs` is the complete host allow-list and the client refuses a URL outside it |

`client.mjs` is the only file here that calls `fetch`, it has no header hook and no options bag that
reaches the request, and nothing in this directory names an environment variable. The test asserts
all three, so "zero token" is a property of the tree rather than a claim in this file.

**Per-run cost.** Worst case is `(1 listing + 8 launches × 3 pages) × 4 attempts = 100` requests,
which is exactly the pinned ceiling — so the bound is exact, not nominal. A real run inside an open
window reads one listing page and one page per new launch: at the window's measured cadence of 1.56
launches a day, a four-hourly poll issues **about 3 requests** and finishes in under 15 seconds.
`--dry-run` is the default and prints that plan without issuing anything.

---

## 2. What it watches, and why not P&L

The one close on record was **one parameter change by the deployer**, atomic, between two launches
24.7 hours apart: dev buy 9.876543209 → 14.814814813 SOL and the cohort's create-slot stake
6.91 → 19.75 SOL, both on `Peque` (`analysis/window-population/README.md` §6.1, and
`slot-zero-june-regime-change` §5.1 by an independent route). There was no ramp and no partial
state. A step is a far easier thing to detect than a drift — provided you watch the quantity that
stepped.

So the series is the **operation's share of the bottom of the curve**:

```
share = (deployer's own create-slot buy + the operation's other create-slot stake)
        ÷ (that, plus every other wallet's create-slot stake)
```

which is the June report's **T1**. Three properties make it the right thing to watch:

- **It is readable at the create slot** — one Solana slot, seconds after the mint. The outsiders'
  P&L is not: a round trip has to close before it says anything, and most do not close inside the
  launch window at all (the tape's own closure rate is 47.2%).
- **It separates the regimes cleanly.** Per launch, straight off each launch's own create slot,
  over the launches an outsider actually bid into:

  | | n | p5 | p25 | p50 | p75 | p95 |
  |---|---:|---:|---:|---:|---:|---:|
  | open window | 104 | 0.239 | 0.316 | **0.395** | 0.443 | **0.529** |
  | closed regime | 80 | **0.646** | 0.710 | **0.755** | 0.800 | 0.882 |

  The open window's p95 and the closed regime's p5 do not overlap, and the pinned bar sits in the
  gap between them without having been put there — see §7.
- **It separates the OPEN too.** T1 was built on the close alone, and
  `analysis/window-population/README.md` §9 later found it also separates the window's opening —
  a second, independent transition it did not previously have. That is what makes it a candidate
  detector rather than a curve fitted to one event.

### The two caveats T1 carries, and what the detector does about each

Both are recorded in `analysis/window-population/README.md` §9, and neither is decorative — each is
worth a measurable number of false alarms.

**Caveat 1 — T1 is not fully exogenous.** Its denominator holds the outsiders' own stake, so "the
outsiders happened not to turn up" pushes it to 1.0 with the operation unchanged. Inside the open
window that happened on **25 of 129** launches.

> *In code:* `detector.mjs` → `classifyCreateSlot` returns **no reading** for a create slot with no
> outsider stake — never a reading of 1.0 — and an unread launch neither advances nor resets the
> streak. Reading them as 1.0 instead takes the false-stop count from 0 to **7** (§6, the row
> "T1 naive"). There is deliberately no code path in this tool that can produce a share of exactly 1.

**Caveat 2 — the same reading has two different causes.** Before the window T1 is high because
outsiders were absent; after the close it is high because the operation crowded them out. For a
screen the reading is identical.

> *In code:* the confirmation rule. Absence is a per-launch accident that does not repeat; a
> parameter change is a level that does. All three single-launch false alarms inside the open window
> are **isolated** — none has a neighbour — so requiring two consecutive readings separates the two
> causes empirically as well as in principle.
>
> The watcher also only ever starts on a window it is **already trading**, so the "before" regime —
> the other cause of a high reading — is not in its input at all.

---

## 3. The headline — detection latency, in the units of the close

The close: `Banknote` 2026-06-03T11:25 → `Peque` 2026-06-04T12:08, **24 hours 43 minutes, one
launch**.

| | when | + from the regime change |
|---|---|---:|
| the regime changed | `Peque` 2026-06-04T12:08, share **0.553** | — |
| streak of 1 — `armed`, deliberately not a stop | same launch | +0.0 h |
| streak of 2 — **STOP AND ROTATE** | `PvE` 2026-06-05T12:12, share **0.882** | **+24.1 h** |
| first launch not entered | `maxxing` 2026-06-05T14:09 | **+26.0 h** |

**The two latencies are different things and both are needed.** The alarm is raised *from* a
launch's own create slot, and a sniper is already in that launch by the time its create slot can be
read — it submits before it can see the slot it is submitting into. So the first launch the operator
actually avoids is the next one, and that is the number a position-sizing decision turns on.

**What the latency cost.** The two launches entered under the new regime — `Peque` and `PvE` — took
**−1.02 SOL gross / −1.37 SOL fee-inclusive** across every outsider who closed a create-slot round
trip on them — 9 round trips, 9 of 9 priced. A single seat takes a fraction of that. Set against the open window's own
median per-launch prize of +5.30 SOL, the money lost to this instrument's latency is not the
expensive thing about it. §5 is.

**Against the alternative that was already characterised.** `analysis/window-population/README.md`
§6.2 measured the P&L route on this same close and got 2–3 days and 2–4 launches. Rebuilt here and
run on the same series, the trailing-3 variant fires at `BrownBear`, **+48.3 h** — twice this
tripwire's latency, with **2** false alarms against **0**.

---

## 4. False alarms, measured — and the ceiling, which is here and not on the latency

<!-- false-stops:0 --><!-- open-window-population:104 -->

Started on the window's opening day and fed every launch since, the tripwire raises **0 stops across
the 104 open-window launches it could read** (129 launches, 25 with no outsider in the create slot at
all). Because the confirmation rule can only ever *shorten* a streak, a later start cannot produce an
alarm an earlier one would not — so opening day is the maximum-exposure start and that count is the
worst case over every possible start date.

Three launches did reach `armed` — one reading at or above the bar, no second:

| launch | share | what a single-launch stop there would have forfeited |
|---|---:|---|
| 2026-04-16 `Doggo` | 0.982 | 63 launches / 47.8 days / **389.9 SOL** |
| 2026-04-28 `TruthGPT` | 0.685 | 47 launches / 36.0 days / **295.1 SOL** |
| 2026-05-20 `Universal` | 0.656 | 18 launches / 13.7 days / **128.1 SOL** |

`Doggo` is caveat 1 surviving the outsider-stake filter rather than being caught by it: 0.166 SOL of
outsiders is technically present and is not a crowding-out. `Universal` is the two-launch trial of
the 14.814814813-SOL preset on 2026-05-20 — the reading that led two earlier reports to date the
regime change a fortnight early. Both are the kind of thing the second reading exists to refuse, and
in both cases it did.

### The honest ceiling

**Zero events in 104 launches is not a rate of zero, and this is where the lane's real limit sits.**
The 95% one-sided upper bound on the per-launch false-stop probability is **2.84%**. At the top of
that range:

- the probability of at least one false stop somewhere in a 104-launch window is **95%**;
- the mean cost of one, over every open-window launch it could land on, is **347.8 SOL**;
- so the expected cost of running the instrument is **≈330 SOL**, against a window whose entire gross
  prize for every outsider in it was **591.7 SOL**.

**At the top of the range its own sample allows, this tripwire costs more than half the window it is
protecting.** The measured cost is 1.37 SOL. The sample cannot distinguish those two worlds, and no
further work on this tape will: it holds one window. `analysis/window-population/README.md` §8 states
what a second observation would cost — a multi-deployer per-launch series, ~6,000–12,000 keyless
requests for ten deployers — and that is the work that would close this gap.

### And the limit that no amount of that data fixes

**This is a step detector.** Every number above is one observation of one close, and that close was a
step. A window that eroded over four weeks would trip this instrument late or not at all, and nothing
in this repo says whether that shape exists — `analysis/window-population/README.md` §8 names it as
the third of the three questions the tape cannot answer, and notes that "a 24-hour step and a four-week
decay call for completely different machinery". This is the machinery for the first.

---

## 5. The asymmetry that decides the design

Both errors, priced from the tape, gross, over the whole outsider population — a single seat takes a
fraction of each, and the ratio between them is scale-free:

| error | measured cost |
|---|---:|
| **one false stop**, placed at a uniformly random open-window launch | median **389.9 SOL** of forfeited remaining window |
| **one launch of latency**, at the real close | **−1.02 SOL** gross / −1.37 fee-inclusive, over two launches |
| ratio | **≈ 380 : 1** |

A stop is **one-way**: a competent deployer does not loosen a launch bot it has just tightened
(captain, 2026-08-02), so this lane never un-stops and never re-polls a wallet it has stopped on. The
cost of a false stop is therefore the whole remainder of a window that was still running.

That ratio is the entire argument for the second reading. It is also why the `armed` state exists and
why it is **not** a stop: the single-launch alarm is the fastest honest signal available and it is
surfaced as one, but acting on it is a 380:1 bet in the wrong direction.

---

## 6. Why this detector and not the alternatives

Every candidate scored on the same series, in its strongest form rather than a straw one. "False
alarms" counts open-window launches at which it would raise a stop; "fires" is the first launch of
the closed regime at which it does.

| detector | false alarms | fires at | + from the regime change |
|---|---:|---|---:|
| **share ≥ 0.55, 2 consecutive — this tool** | **0 / 104** | `PvE` | **+24.1 h** |
| share ≥ 0.55, 1 consecutive | 3 / 104 | `Peque` | +0.0 h |
| share ≥ 0.55, 3 consecutive | 0 / 104 | `BrownBear` | +48.3 h |
| share naive (no-outsider read as 1.0), 2 consecutive | 7 / 129 | `PvE` | +24.1 h |
| P&L: trailing-3 median return per SOL < 0.102 | 2 / 102 | `BrownBear` | +48.3 h |
| P&L: trailing-5 median return per SOL < 0.136 | 2 / 102 | `Chikuwa-Kun` | +57.2 h |
| P&L: trailing-7 median return per SOL < 0.138 | 2 / 102 | `Diamond` | +73.5 h |
| deployer's own buy > 1.2× its trailing-8 median | 6 / 121 | `Peque` | +0.0 h |
| deployer's own buy > 1.4× its trailing-8 median | 5 / 121 | `Peque` | +0.0 h |
| outsider create-slot room ≤ 10.57 SOL, 2 consecutive | 7 / 129 | `maxxing` | +26.0 h |
| CUSUM on the share, k = 0.529, h = 0.2 | 1 / 104 | `PvE` | +24.1 h |
| CUSUM on the share, k = 0.529, h = 0.5 | 0 / 104 | `BrownBear` | +48.3 h |

Read down the column: **nothing here is both faster and quieter.** The chosen rule is on the
frontier — CUSUM at h = 0.5 matches its false-alarm count but takes twice as long, and every rule
that matches its latency is noisier.

Four of these deserve a sentence, because each is an idea worth having had:

- **The P&L route is the one this lane was warned about**, and the warning holds: it is exactly twice
  as slow *and* it false-alarms more. Watching the consequence is strictly worse than watching the
  cause when the cause is observable, and here it is.
- **The deployer's own buy alone** is the most exogenous signal available — literally the parameter
  that changed on the day — and on its own it is unusable: **5–6 false alarms**, because the
  operation raised its own stake repeatedly across April and May while the window stayed open. This
  is caveat 1 read the other way, and it is why the *ratio* is the indicator and the operation's half
  of it is not.
- **Outsider room alone** is the consequence rather than the cause, and it inherits caveat 1 whole:
  7 false alarms, and it fires later.
- **CUSUM** is the textbook fast step detector and it was the expected winner. It loses because the
  open window's own share readings are not stationary — the early window runs hotter — so the
  cumulative sum drifts up through March and April and either alarms or has to be desensitised until
  it is slower than the simple rule.

---

## 7. Why 0.55, and what rests on it

**The bar is inherited, not fitted.** `slot-zero-june-regime-change` §10.2 publishes T1 with the
re-open condition *`T1 < 0.55` sustained over 10 consecutive launches* — written before anyone had
looked at where the closing launch sat. 0.55 here is that same bar read as the close condition.

**State the thin part plainly:** `Peque`, the first launch of the closed regime, reads **0.5527**. It
clears 0.55 by 0.003. So the zero-launch reading of the single-launch alarm is not robust, and the
headline latency is quoted from the confirmed alarm, which does not depend on it.

| bar | ×1 | ×2 | ×3 |
|---|---|---|---|
| 0.50 | 8 FP, +0.0 h | 1 FP, +0.0 h | 0 FP, +24.1 h |
| **0.55** | 3 FP, +0.0 h | **0 FP, +24.1 h** | 0 FP, +48.3 h |
| 0.60 | 3 FP, +24.1 h | 0 FP, +48.3 h | 0 FP, +57.2 h |
| 0.65 | 3 FP, +24.1 h | 0 FP, +48.3 h | 0 FP, +57.2 h |

Two independent settings — `0.55 ×2` and `0.50 ×3` — give the same result: 0 false alarms, +24.1 h.
Nothing in the 0.55–0.65 range false-alarms at all with two confirmations; the cost of moving the bar
up is one further launch of latency. The result is not balanced on the exact pinned values.

---

## 8. Deriving the cohort at runtime, instead of being told it

The share needs to know which create-slot wallets belong to the operation. For the deployer this
repo has studied, they are known. For a stranger they are not, so `--cohort` may be omitted and the
detector falls back to the **shared-transaction co-ordination rule** — any create-slot transaction
carrying two or more distinct wallets is one submission, so every wallet in it is one operation
(`detector.mjs` → `bundledWallets`, this lane's own copy). **That is now only half of the screen's
rule**: captain decision 182a widened `tools/deployer-screen/measure.mjs` → `roomIsProven` to the
union of it and a deployer-anchored contiguous block-index run, and this lane deliberately did not
follow, because every figure backtested in this document rests on the narrower predicate. The
reasoning is at `detector.mjs` → `bundledWallets`; widening it here is a decision of its own.

Replayed that way, the tripwire **fires at the same launch, `PvE`, +24.1 h, with 0 false stops**, and
reads 156 launches instead of 184.

It inherits that rule's limit exactly — how much of an operation it recovers is the operator's
submission habit on the day, not a property of the rule:

| | 2026-03 | 2026-04 | 2026-05 | 2026-06 | 2026-07 |
|---|---|---|---|---|---|
| launches it can read a cohort from | 4 / 19 | 33 / 65 | 37 / 41 | 36 / 41 | 46 / 56 |

Before April this deployer did not bundle, and the rule recovers **nothing** — so a create slot with
no bundled transaction yields `no-cohort-evidence` and no reading, never an empty cohort. That is
captain decision 134a's shape for the same reason: finding nothing is indistinguishable from there
being nothing, and reading it as the second credits the operation's own helpers to the outsiders,
which pushes the share **down** — towards "the window is still open", the direction this instrument
must never fail in.

---

## 9. Running it

```bash
# plan only — issues nothing, prints the exact worst-case request cost
node tools/window-decay-tripwire/watch.mjs --wallet <deployer> --state ./tripwire-<deployer>.json

# spend. --live is required, and so is --state
node tools/window-decay-tripwire/watch.mjs --wallet <deployer> --state ./tripwire-<deployer>.json --live

# a wallet whose operation wallets are known, and an explicit mint list (no listing request).
# This run CANNOT confirm a stop — see below.
node tools/window-decay-tripwire/watch.mjs --wallet <deployer> --cohort <a>,<b> --mints <m1>,<m2> \
  --state ./tripwire-<deployer>.json --live
```

**`--state` is not optional for a live run and the CLI refuses without it.** The stop needs two
consecutive readings and a run sees one launch at a time, so without a file to carry the streak the
tool would silently become the single-launch alarm this lane measured and rejected.

**`--mints` can reach `armed` and can NEVER confirm a stop, and the run says so.** The streak is a
statement about launches that are *adjacent* in the deployer's series, and the only evidence of
adjacency this tool has is the launch listing — which `--mints` does not read. Command-line order is
not that evidence: `--mints A,B` says nothing about whether `B` followed `A`, and letting an argument
order assert it would confirm a stop out of two launches that were never neighbours, which is the
one-way ~380:1 error the whole design is built around. So a `--mints` reading records no predecessor
at all and stands alone.

**The split it leaves behind is permanent, so do not use it to fill a hole in the series.** A settled
mint joins `readMints` and is never fetched again, so a launch settled this way keeps its successor's
`prevMint` unmatched for good: no later listing run can confirm a stop spanning that launch. Leaving
the launch in quarantine breaks the chain as well, but reversibly — it heals the moment a listing run
settles it. Reach for `--mints` when you want a share *reading* of a specific launch, not when you
want the series closed up.

**The listing itself can also lie by omission, and the fix is a pinned bound.** It lists by *current*
creator, so a launch whose creator record has moved is simply absent (`maxxing` is the known
instance, `AGENTS.md`) — and an absent launch leaves its two neighbours recorded as neighbours of
each other. `chainsOf` therefore corroborates every claimed adjacency against the elapsed time
between the two launches and breaks the chain above `detector.maxAdjacentGapDays` =
**4.04 days**<!-- max-adjacent-gap-days:4.04 -->,
the widest gap between consecutive launches in the one open window on record (§7.3 of
`analysis/window-population/README.md`; p50 0.69, p90 1.19). It is one-sided: a hole whose survivors
are still inside that gap is not caught, so this narrows the failure rather than closing it — and
every branch of it errs towards *no* stop. The value is refused at load if it is missing or not a
positive finite number, because a `NaN` there breaks every chain at every step and would leave a
tripwire that can never fire while still printing `watching`.

Every verdict printed carries two caveats, in the output and not only here: `n = 1`, and the 380:1
asymmetry that means a `watching` verdict is weaker evidence than a `stop-and-rotate` one.

The bounds are in `thresholds.json` → `bounds`, every one of them with the measurement it rests on
named in `justification`.

---

## 10. What this tool is not

- **Not a way to find a window.** That is `tools/deployer-screen/` and its discovery feed. This one
  watches a wallet you are already trading and tells you to stop.
- **Not a re-entry signal.** The verdict latches. Captain, 2026-08-02: a competent dev will not
  reopen a window, so re-polling a stopped wallet watches the one place a deployer will not change
  its mind.
- **Not an exit signal for a position.** It says the *series* has stopped paying. What to do with
  an open position is Stage 3's question and no signal here may reach an entry or exit number.
- **Not evidence about any deployer but the one it is pointed at.** The calibration is one window
  on one operator. Pointed at a stranger it is a plausible instrument with an unmeasured
  false-alarm rate.

---

## 11. What would overturn this

- **A second window, on any deployer, that closed gradually.** It would show this instrument is the
  wrong shape, not merely uncalibrated.
- **A second window that closed as a step.** It would replace the 2.84% upper bound in §4 with a
  real rate, which is the single most valuable thing that could happen to this lane.
- **A false stop in live use.** One would move the measured rate from 0 in 104 to 1 in
  (104 + however many), and §4's arithmetic says one is enough to make the instrument's expected cost
  material.
- **A deployer that changes its cohort's stake without changing its dev buy, or the reverse.** Both
  moved together on the only close observed and this data cannot separate them
  (`slot-zero-june-regime-change` §5.3). A close driven by one alone would test whether the ratio is
  really the right unit.
