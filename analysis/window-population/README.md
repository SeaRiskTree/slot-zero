# How many profitable windows, how long, how fast they close, how many at once

**Question**, in the captain's words (2026-07-29):

> "I expected profitable windows to be short lived but numerous but this is yet to be discovered."

**Mode:** measurement on the local tape only. Zero network requests, zero vendor spend, no
credential read. Enforced structurally by `test/window-population.test.ts` →
"analysis/ reaches no network and reads no credential".

**Reproduce:** `node analysis/window-population/measure.mjs`. Every number below comes from that
one command; the headline ones are asserted in `test/window-population.test.ts`.

---

## The bottom line

> **Short-lived: confirmed, and sharper than expected. Numerous: not shown, and this tape
> structurally cannot show it.**
>
> The population tape contains **exactly one profitable window**. It opened on **2026-03-12**,
> closed on **2026-06-04**, and lasted **83 days and 129 launches**. Both ends are *observed* —
> 91 days of no window before it and 54 days of no window after it — so the duration is a
> measurement, not a lower bound. **n = 1.**
>
> **It closed between two consecutive launches, 24.7 hours apart.** There was no decay. The
> launch before the break returned 0.188 SOL per SOL staked; the launch after returned −0.076,
> and the level never came back. A participant watching only its own P&L needed **2–3 days** to
> tell the change from ordinary variance, by which point 2–4 launches had already gone.
>
> **Two trading units took 73% of the window between them**, out of 186 that entered the create
> slot at all. Eleven cleared +5 SOL gross over the whole twelve weeks. Concurrency of
> *earners* inside one window is about **2**, not many.
>
> **Concurrency of windows is unmeasurable here and the gap is structural, not a matter of
> effort.** Every one of the 239 launches is the same deployer. The 70-deployer control is one
> launch per creator with no dates and no P&L — 70 rows, **zero** window observations. Nothing
> in this repo says how often a window arrives, whether two are ever open at once, or how long
> capital would sit idle between them.
>
> **What the tape does say about idleness, on the one deployer:** since the close, **54 days and
> 93 launches with no re-open**. Inside the window, launches came every 0.69 days at the median
> and never more than 4.04 days apart, so a single open window keeps capital engaged almost
> daily — but at a median capacity of **15.5 SOL of outsider create-slot room per launch**,
> shared six ways.
>
> **Both ends of the window are the deployer's own parameter changes**, not competitive erosion.
> The operation's share of the bottom of the curve — the June report's T1 — reads **0.773 before
> / 0.413 inside / 0.771 after**. That indicator was built on the close alone; it separates the
> open too, which is a second, independent transition it did not previously have.

**Confidence.** *High* on the count, the dates, the duration and the close speed: they are
complete-set measurements on this deployer, and the two dates fall out of a blind changepoint
scan that was given no candidate dates. *High* on "this tape cannot count windows across
deployers" — that is a property of what was collected. *No confidence at all* is offered on the
arrival rate of windows, because one observation supports none.

**This does not decide the strategy question.** "Short and numerous" versus "short and rare"
turns on a number this tape does not contain. §8 states exactly what data would settle it and
what it would cost — all of it keyless.

---

## 1. Spend accounting

**Metered provider requests: ZERO. Network requests of any kind: ZERO.**

| source | used |
|---|---|
| `data/population-tape-2026-07-29/launches.csv`, `wallet_launch_pnl.csv`, `onchain_create_slot_pnl.csv`, `control_create_slot.csv`, `launch_universe.jsonl` | everything below |
| MadeOnSol, Helius, SolanaTracker, any keyed provider | not contacted |
| `swap-api.pump.fun`, `api.mainnet-beta.solana.com`, any keyless endpoint | not contacted |

The brief said local tape only, and to report the gap rather than reach for a paid source to
fill it. §7 and §8 are that report.

---

## 2. The definitions, and why they are these

The definition is the deliverable, so it is argued rather than declared.

### 2.1 "Profitable"

**A launch pays if the outsiders who reached its create slot, taken together, closed their
round trips for more than they staked.** Measured as the sum of `realised_sol` over pairs with
`in_create_slot = 1` and `closed_in_window = 1`, excluding the deployer and the six cohort
wallets, against the `sol_in` on the same pairs.

Four choices inside that, each load-bearing:

- **The create slot, and only the create slot.** Slot 0 is where the edge is: pooled over the
  whole tape its median closed round trip is +0.283 SOL, slot 1 is +0.011, and every slot past
  1 is within half a hundredth of a SOL of zero (`README.md`, "What is established"). A
  definition spanning all entrants would average a real edge against a crowd that never had a
  meaningful one. The later seats are measured separately in §4.4 and turn out to break on the
  same day, which is why they are not counted as a second window.
- **Closed round trips only.** `OpenPair` has no complete P&L by construction, and summing the
  open half fabricates a loss of over 5,000 SOL. This is the second of the loader's three traps.
- **The whole outsider population per launch, not the best wallet.** The best wallet on a launch
  is a maximum over ~6 draws and rises with the number of entrants, so a series built on it
  measures attendance as much as opportunity.
- **Gross of fees for the series, fee-inclusive wherever it exists.** Every tape-derived column
  is gross; only `onchain_create_slot_pnl.csv` is fee-inclusive, and it starts on 2026-05-08.
  So the open/close *dates* are established on gross, and the *money* is stated fee-inclusive
  where priced and labelled an estimate where not. On the 30 launches inside the window where
  every closed pair is priced, net is **0.540** of gross; on the 80 after it, **0.294**.

**"Profitable" here is a property of the launch, not of a business.** A launch can pay 0.14 SOL
per SOL staked and still be worthless to trade — which is exactly the post-June state, and why
the window count in §4 does not rest on a profit threshold at all.

### 2.2 "Distinct"

**Two windows are distinct when the level of the per-launch prize changes and stays changed —
not when a rolling average happens to cross a bar.**

Operationally: run **binary segmentation** over the per-launch series, splitting wherever the
standardised Mann–Whitney rank-sum statistic between the two sides exceeds |z| = 4, with a
minimum segment of 8 launches. A window is a maximal segment whose level is the high one.
Rank-based on purpose: one launch in the window paid +27 SOL, and a mean-shift test would chase
single launches rather than levels.

**Why not "count runs above a threshold", which is the obvious method.** Because it answers
whatever you ask it. Same series, same code, trailing-7 median, minimum run of 5 launches:

| bar on the trailing-7 median return per SOL | "windows" found |
|---:|---:|
| 0.05 | **2** |
| 0.10 | **3** |
| 0.15 | **7** |
| 0.20 | **5** |
| 0.25 | **6** |
| 0.30 | **4** |
| 0.35 | **3** |

Seven windows at one bar, two at another — and at the loosest bar the second "window" is
2026-06-10 → 2026-07-28, the period in which the whole outsider population made +46.9 SOL net
in total across 80 launches, which nobody would trade. That table is the finding's own
warning label: **a window count produced by threshold-tuning is a statement about the analyst.**
It is asserted as a test (`test/window-population.test.ts` → "counting runs above a bar instead
manufactures windows") so nobody re-derives it by accident.

Segmentation has no equivalent knob. It asks whether the level differs either side of a point,
never whether the level clears a bar, so it cannot be tuned toward "more windows" without also
relabelling the bar as noise.

### 2.3 What a "window" is a window *on*

**A deployer.** The strategy under consideration is: find a dev wallet whose launches pay, ride
it, rotate when it stops paying. The tradeable unit is therefore (deployer × time), and "how
many windows exist" is a question about a population of deployers.

This matters more than it sounds, because it is the whole reason the answer is n = 1: the tape
holds **one** deployer. Counting per-*wallet* profitable runs instead would produce dozens of
"windows" and every one of them would be a re-observation of the same regime — §6.3 tests that
directly and finds all three testable participants closing on the same date.

---

## 3. Method and coverage

239 launches, 2025-12-01 → 2026-07-28, one deployer (`7ufmve7Z…`; 238 of the 239 still list it
on-chain, the 239th being `maxxing`, whose creator record moved — the trap `AGENTS.md` records).

| | launches | measurable | why not |
|---|---:|---:|---|
| whole tape | 239 | **197** | 4 never reached the mint; 38 had no outsider close a create-slot round trip |
| before the window | 17 | 15 | 2 with no outsider in the create slot |
| inside the window | 129 | 102 | **25** with no outsider in the create slot at all, 2 with none closing |
| after the close | 93 | 80 | 4 tapeless, 9 with no outsider in the create slot |

That "25 of 129" is a fact about the strategy, not only about coverage: **inside an open window,
no outsider reached the create slot at all on one launch in five.**

Fee-inclusive coverage is the one real gap. `onchain_create_slot_pnl.csv` begins on 2026-05-08,
so the window is priced exactly on its last 30 launches and not at all on its first 72. Every
figure below is labelled gross, priced, or estimated.

---

## 4. Result 1 — how many windows: **one**

### 4.1 Both breaks fall out blind

Binary segmentation, given the series and no candidate dates:

| series | break | \|z\| | between |
|---|---|---:|---|
| return per SOL | **open** | 4.3 | 2026-03-02 `Ceasar` → **2026-03-12 `escape`** |
| return per SOL | **close** | 5.0 | 2026-06-03 `Banknote` → **2026-06-04 `Peque`** |
| prize in SOL | **open** | 5.3 | same pair |
| prize in SOL | **close** | 6.5 | same pair |
| prize in SOL | (third) | 4.7 | 2026-06-20 → 2026-06-22, *inside* the closed regime |

Two independent metrics, the same two dates. The close lands on 2026-06-04, which is the date
`slot-zero-june-regime-change` arrived at by an entirely different route — an independent
confirmation of that report's central finding.

The third break is a partial recovery **within** the closed regime: the median prize goes from
0.62 SOL to 1.62 SOL per launch, still a third of the open window's 5.30. It is not a re-open,
and the test asserts that it stays under 2 SOL.

### 4.2 The window is one regime, not several end to end

The strongest split *inside* 2026-03-12 → 2026-06-03 is |z| = 2.99 on return per SOL and
|z| = 3.25 on the prize — both below the 4.0 that the two real breaks clear at 4.3–6.5. Twelve
weeks, 129 launches, one level.

### 4.3 The three regimes

Non-cohort create-slot closed round trips. Distributions, not means, as the standing bar requires.

| | **before** 2025-12-01 → 2026-03-02 | **open** 2026-03-12 → 2026-06-03 | **after** 2026-06-04 → 2026-07-28 |
|---|---:|---:|---:|
| days | 91 | **83** | 54 |
| launches (measurable) | 17 (15) | **129 (102)** | 93 (80) |
| closed round trips | 67 | **542** | 472 |
| outsider stake, SOL | 38.9 | **1,493.4** | 922.4 |
| gross prize, SOL | **+1.7** | **+591.7** | **+159.6** |
| return per SOL, aggregate | 0.044 | **0.396** | 0.173 |
| per-launch prize p10 / p25 / **p50** / p75 / p90, SOL | −0.22 / −0.09 / **−0.01** / 0.02 / 0.81 | 0.65 / 2.58 / **5.30** / 8.22 / 10.10 | 0.25 / 0.91 / **1.38** / 1.99 / 3.27 |
| per-launch return per SOL, same quantiles | −0.082 / −0.057 / **−0.002** / 0.022 / 0.398 | 0.092 / 0.170 / **0.341** / 0.507 / 0.686 | 0.036 / 0.104 / **0.138** / 0.181 / 0.300 |
| fully priced launches | 0 | 30 | 80 |
| net over those, SOL | — | **+108.3** (of 200.6 gross) | **+46.9** (of 159.6 gross) |

Read the median row across: **−0.01 SOL, +5.30 SOL, +1.38 SOL** per launch. The window is a step
up and a step back down, and the "after" level is nearer the "before" level than to the window
in every quantile below the median.

**What the window was worth.** +591.7 SOL gross. Applying the 0.540 net/gross ratio measured on
its own last 30 launches gives **≈ 320 SOL net ≈ $23,700** at the dataset's 74.03 SOL/USD, over
twelve weeks, shared by 186 units with 73% going to two of them. That figure is an **estimate**:
the ratio is measured at the end of the window and the first 72 launches are unpriced.

### 4.4 The later seats close on the same day and are not a second window

The same scan over entrants who were *not* in the create slot finds **one** break, between `PvE`
and `maxxing` — both on **2026-06-05**, one day after the create-slot break. Their median
per-launch gross goes from +1.17 SOL to **−3.70 SOL**, and their median return per SOL from
+0.028 to −0.053. No separate open is detectable: before June they hover just above zero **gross
of fees**, which is at or below zero once fees are paid.

So the later seats are the same window seen from a worse seat — one close, one cause — not a
distinct window with its own life. Counting them as a second observation would be double
counting.

---

## 5. Result 2 — how long: **83 days, and neither end is censored**

| | |
|---|---|
| open | 2026-03-12T18:09:24Z (`escape`) |
| close | 2026-06-04T12:08:52Z (`Peque` is the first launch of the new regime) |
| duration | **82.7 days, 129 launches** |
| observed before it | 91 days, 17 launches, median per-launch prize **−0.01 SOL** |
| observed after it | 54 days, 93 launches, no re-open |
| duty cycle over the 239-day tape | **34.6%** |

**There is no distribution to report.** One window is one number. The brief asked for a
distribution and the honest answer is that the sample does not have one; what follows instead is
the distribution *within* the window, which the tape does support — the per-launch prize and
return quantiles in §4.3, and the cadence in §7.3.

The duty cycle is stated because it is the input a rotation strategy needs, and immediately
qualified: it is one deployer's, and 34.6% of one life is not an estimate of the population's.

---

## 6. Result 3 — how fast it closed: **one launch, 24.7 hours**

### 6.1 The close itself

| launch | when | return per SOL | prize, SOL |
|---|---|---:|---:|
| `Potter` | 2026-06-01 | 0.477 | +6.31 |
| `Gem` | 2026-06-02 | 0.473 | +7.53 |
| `Mary` | 2026-06-03 | 0.428 | +7.67 |
| `Banknote` | 2026-06-03 11:25 | 0.188 | +2.61 |
| **`Peque`** | **2026-06-04 12:08** | **−0.076** | **−1.27** |
| `PvE` | 2026-06-05 | 0.150 | +0.25 |
| `BrownBear` | 2026-06-06 | 0.015 | +0.14 |

**24 hours 43 minutes, one launch.** The parameter change behind it is atomic — dev buy
9.876543209 → 14.814814813 and the cohort's stake 6.91 → 19.75 SOL, both on `Peque`
(`slot-zero-june-regime-change` §5.1). There is no ramp to detect and no partial state to trade.

### 6.2 How long it took to *know*

The regime change is instantaneous; recognising it is not, because the open window itself had
bad launches. Calibrating the alarm on the open window's own 5th percentile — a level it crossed
one launch in twenty — gives a latency with a stated false-alarm rate:

| trailing launches | 1-in-20 level inside the window | first breach after the break |
|---:|---:|---|
| 1 | 0.000 | +0 launches / +0.0 d — but a single launch below zero happens inside the window too, so this is a false-alarm-prone reading, not a warning |
| 3 | 0.102 | **+2 launches / +2.0 days** (`BrownBear`) |
| 5 | 0.136 | +3 launches / +2.4 days (`Chikuwa-Kun`) |
| 7 | 0.138 | +4 launches / +3.1 days (`Diamond`) |

**2–3 days, 2–4 launches**, for a statistic that would have fired falsely roughly once a
fortnight while the window was open — 1 launch in 20, at 1.56 launches a day. At the window's
median capacity that is 30–60 SOL of outsider stake in aggregate committed into the new regime
before it is recognisable, at a gross return per SOL of 0.14.

**This is n = 1 for the close-speed question too.** One close, measured well. Nothing here says
another window would close the same way, and the one mechanism observed — a deployer changing a
preset — is a step function by nature, which is at least consistent with the captain's framing
that a window closing is expected behaviour rather than a defect.

### 6.3 The closes are not staggered

If per-participant windows were independent lives, they would end on their own dates. Only three
units traded the create slot at least 8 times on **both** sides of 2026-06-04 — the only ones
that can be tested at all — and all three fall across the same break:

| unit | inside: trips, return per SOL | after: trips, return per SOL |
|---|---:|---:|
| `5brv79eF…` | 42, **0.576** | 35, **0.196** |
| the `9BhkaAyb…` book (5 wallets, one unit) | 38, **0.540** | 47, **0.097** |
| `GRevWsvJ…` | 9, **0.297** | 26, **0.167** |

One regime governs all of them. This is why §2.3 refuses to count per-wallet runs as windows.

---

## 7. Result 4 — how many ran concurrently

### 7.1 Windows: **not measurable on this tape, and the gap is structural**

Concurrency of windows requires at least two deployers with history. The tape has one.

- **`launch_universe.jsonl`: 239 launches, one deployer.** Asserted in the test.
- **`control_create_slot.csv`: 70 other deployers, one launch each, no dates and no P&L.** Its
  columns are `n_create_slot_trades`, `n_create_slot_wallets`, `p0`, `last_create_slot_price`.
  There is no timestamp to place a launch in time and no realised P&L to say whether anyone made
  money. **70 rows, 0 window observations.**

What the control *can* bound is the search space, on a necessary condition only, and only if the
two sides are counted the same way. `n_create_slot_wallets` excludes the creator — 22 of the 70
rows read 0 wallets against at least one create-slot trade — but it includes whatever helper
wallets that deployer runs, and nothing in the file separates a helper from an outsider. The
subject's comparable figure is therefore its **create-slot total of 10** (`launches.csv`
`n_createslot_wallets`, open-window median, cohort included, deployer excluded), not the **6**
outsiders the rest of this report measures.

At the moment it was sampled, the median other deployer had **2** wallets in its create slot
against this one's 10, and **6 of 70** reach 10 or more. So deployers that even *look* like this
one are a minority — **roughly one in twelve** — and that is a statement about structure, never
about profit. (Against the outsider-only 6 the count would be 14 of 70, one in five; that
comparison is not like for like and this report does not make it.)

The price multiple beside it reads the same quantity on both sides — **the last fill in the
create slot over the deployer's own fill price** — and this deployer's is **2.46**. The control
publishes it as `last_create_slot_price / p0`, where `p0` is the creator's own dev-buy price: on
the 24 control launches using the identical 14.814814813-SOL preset it is this deployer's own
`price_devbuy` to ten significant figures. The subject's side is computed from the window tapes —
the last non-deployer buy in the create slot, over `launches.csv`'s `price_devbuy`, gated on
`meta.reached_mint` — and it covers **all 129** open-window launches, none dropped.

The control has **two** medians and the difference matters. **22 of the 70 control launches had
nobody but the creator in the create slot** — `n_create_slot_wallets = 0` against a single trade
— and each of those reads exactly 1.0000, because the last fill in the slot *is* the creator's
own. Across all 70 rows the median is **1.04**; across the **48** whose create slot someone else
actually bid into, it is **1.24**. The like-for-like partner for the subject's 2.46 is **1.24**,
because the subject's construction skips exactly the case those 22 rows represent: it takes the
last *non-deployer* buy, so a launch nobody else bid into yields no multiple at all rather than a
1.0. That an unbid create slot is itself common — nearly a third of the control — is a fact about
the population worth reading beside the 6-of-70 bound above.

This narrows the gap: 2.46 against 1.24 rather than against 1.04. It is the correct comparison,
and it runs the opposite way to the two corrections above it, which both made the subject look
more unusual. Both control medians and the 22 count are asserted in the test.

The subject's side is deliberately **not** read off `first30s_best.csv`. That file is the ten
best early entrants per launch, so it carries a median of 5 create-slot rows against the 10
wallets actually in the slot, and two open-window launches have no row in it at all: its highest
create-slot fill is below the slot's real last fill on most launches. "Buys only move the curve
up" is true of the curve and false of a truncated file. The remaining caveat is one of coverage:
the subject's figure is 129 launches of one deployer, the control's is one launch each of 70.

### 7.2 Earners inside one window: **about 2**

| | |
|---|---:|
| outsider units taking a closed create-slot round trip inside the window | **186** |
| units ending positive, gross | 101 |
| units clearing +1 SOL gross over the whole 12 weeks | 38 |
| units clearing +5 SOL gross | **11** |
| share of the 591.7-SOL prize taken by the top unit | **41%** |
| top two | **73%** |
| top five | 82% |

The top two are `5brv79eF…` and the `9BhkaAyb…` book — the same two the repo's positive case
already rests on, and the book counted once rather than five times, per `src/cohort.ts`. Neither
arrived at the open: `5brv79eF…`'s first create-slot trip here is 2026-03-14, two days in, and
the book's is 2026-03-29. Both were still trading this deployer at the tape's end, on a collapsed
return. Nobody rotated out.

### 7.3 What this says about idle capital, on the one deployer

- **Inside the window, capital is engaged almost daily.** 129 launches over 82.7 days, on 71
  distinct calendar days; gap between launches p10/p25/**p50**/p75/p90 =
  0.06 / 0.13 / **0.69** / 0.93 / 1.19 days, maximum 4.04. A single open window does not leave
  capital idle for long stretches.
- **But it is small.** Median outsider create-slot room per launch: **15.5 SOL** inside the
  window, 10.3 SOL after it, shared by a median of 6 wallets.
  `slot-zero-june-regime-change` §10.1 measures the same ceiling from the other side.
- **And after the close, everything is idle.** 54 days and 93 launches on this deployer with no
  re-open.

So the idle-capital question does not turn on concurrency *within* a window. It turns entirely on
the arrival rate of the next window, which is §8.

---

## 8. What this tape cannot answer, and what would

Three questions, all of them ones that decide the strategy, and none of them answerable here.
Costs are stated because the brief asked for them; every route is keyless.

**The collector for all three now exists — `tools/arrival-rate-walk/`, which owns the route, its
bounds and its limits.** It supersedes the sketch below in two ways: the cohort is seeded from
**history** (a Dune enumeration of one past month, taken whole) rather than from the
`?creator=` listing, which lists by *current* creator and conditions on success; and the walk uses a
single-bound cursor. The collection itself has not run, so everything below still stands as the
state of the evidence.

1. **How often does a window arrive?** Needs several deployers observed over several months each.
   One deployer × 8 months = one window; the arrival rate has a sample size of one deployer and
   no confidence interval worth writing down.
   *What would answer it:* the same per-launch series for **10–20 other prolific deployers over
   6+ months each**. `frontend-api-v3.pump.fun/coins?creator=` gives a launch list keyless (a
   **lower bound** — the creator record moves, and the launch that goes missing is the good one,
   `AGENTS.md`), then `swap-api.pump.fun/v2/coins/{mint}/trades` gives the create slot at 3–15
   requests per launch with the timestamp cursor. At ~200 launches per deployer that is roughly
   **6,000–12,000 keyless requests for 10 deployers** — the population tape itself cost ~2,000 for
   one. Days of paced fetching, no vendor spend.
2. **Are two windows ever open at once?** Falls out of the same series for free, once it exists
   for more than one deployer. Cannot be approximated from anything held here.
3. **Do windows close the same way elsewhere?** One close is observed and its mechanism is a
   deployer changing its own preset. Whether that is how windows generally end, or whether others
   erode gradually, needs the same multi-deployer series. This one matters for anything that has
   to react in time, because a 24-hour step and a four-week decay call for completely different
   machinery.

**What is deliberately not done here.** The brief scoped this lane to the measurement, so no
screening stage or grading loop is built. §6.2's latency table characterises the observed close;
it is not a tripwire design. The tripwire itself has since been built in a separate lane —
`tools/window-decay-tripwire/`, which owns that design, its latency and its false-alarm ceiling,
and whose §6 scores §6.2's P&L route against the rule it chose instead.

---

## 9. Both ends of the window are the deployer's own lever

Not asked for, and worth recording because it changes what a screen would watch.

The June report's **T1** — the operation's share of the bottom of the curve,
(dev buy + cohort create-slot stake) ÷ (dev buy + all create-slot stake) — was built on the close
alone. Across all three regimes, per-launch median:

| | before | **open** | after |
|---|---:|---:|---:|
| T1 median | **0.773** | **0.413** | **0.771** |
| T1 p25 / p75 | 0.643 / 0.805 | 0.321 / 0.515 | 0.718 / 0.842 |
| deployer dev buy, median SOL | 3.000 | 4.444 | 14.815 |
| cohort create-slot stake, median SOL | 3.00 | 6.00 | 19.75 |
| outsider create-slot stake, median SOL | 1.64 | **15.47** | 10.84 |

The indicator separates **both** transitions, which is a second, independent confirmation it did
not previously have. The June report's threshold — T1 below 0.55 sustained re-opens the question
— is exactly where the window sits (p75 = 0.515) and exactly where the two closed regimes do not.

**Two honest caveats.**

- **T1 is not fully exogenous.** Its denominator contains the outsiders' own stake, so "outsiders
  staked little" pushes it up on its own. The numerator — dev buy plus cohort stake, entirely the
  operation's choice — does *not* separate the regimes by itself: it rises monotonically
  (6.0 → 10.4 → 34.6 SOL) straight through both transitions. The ratio works; the half of it the
  operation controls does not work alone.
- **The same T1 reading has two different causes.** Before the window it is high because
  outsiders were not there (1.64 SOL of them). After the close it is high because the operation
  crowded them out — its own stake tripled while theirs fell. For a screen the reading is the
  same; for understanding what a deployer is doing, it is not.

---

## 10. Against the hypothesis, plainly

> "I expected profitable windows to be short lived but numerous but this is yet to be discovered."

- **Short lived — supported, on n = 1.** 83 days, with a close that took one launch. The
  hypothesis's premise, that a window closing is expected behaviour rather than a defect, is
  consistent with the one mechanism observed: the deployer changed a setting and took the bottom
  of its own curve.
- **Numerous — undiscovered, exactly as the captain said.** This tape observes one deployer. It
  contains one window. It cannot count windows across deployers, and no further work on it will
  change that.
- **The commercial fork the brief names is therefore still open.** "Short and numerous" versus
  "short and rare" needs the multi-deployer series in §8. What can be said today:
  - a window on this deployer was worth **≈ 320 SOL net over 12 weeks** across everyone in it,
    with **73% of it going to two units** — so even a *good* window is a small business unless you
    are one of the two;
  - the deployer's **own** post-close economics are the leg that grew
    (`slot-zero-june-regime-change` §6.1: +29.70 SOL per launch, 97% of the window's profit),
    which is a different question about a different subject;
  - and that report's decision 116a has already closed the create-slot strategy lane for *this*
    operator. Nothing here reopens it. This measurement is about whether there is a population to
    rotate into, and the answer is that the population has not been observed.

**One sentence for the record:** *the tape supports one clean window observation, and one is
reported.*

---

## 11. What would overturn this

- **A second deployer's tape showing a window that opened or closed gradually.** The 24-hour
  close is one observation of one mechanism.
- **Fee-inclusive pricing for the window's first 72 launches.** The dates do not move — they are
  established on gross, and gross and net move together on every launch where both exist — but
  the ≈ 320 SOL estimate would become a measurement. It would need on-chain pricing of those
  launches' create-slot transactions: keyless, `api.mainnet-beta.solana.com`, one process, at the
  pacing `AGENTS.md` records for that host (batching there is measured harmful, so budget by it).
- **A launch of this deployer that the universe missed.** `?creator=` lists by *current* creator
  and the record moves; the one launch known to have gone missing was this operation's best ever.
  If a missing launch sat in the "before" period, the open date could be earlier than 2026-03-12.
  The window's *close* is unaffected — the tape is dense and complete there.
- **Reading the 25 launches with no outsider in the create slot as zeros rather than as missing.**
  They are excluded here. Including them as zero prizes would lower the window's median prize by
  roughly a fifth and would not move either break.

---

## 12. Reproduction

```bash
node analysis/window-population/measure.mjs   # every table above
npm test                                      # tsc --noEmit, then the assertions
```

`test/window-population.test.ts` re-derives the two dates blind from the series, asserts the
regime distributions, reproduces `slot-zero-june-regime-change`'s +46.94 SOL closed-regime prize
from a second direction, asserts that threshold-counting is unstable, and asserts that
`analysis/` opens no socket and reads no credential.
