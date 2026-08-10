# The usable window fraction on the WIDENED population — measured 2026-08-09/10

**The number: `0.1810` — 38 room readings over 210 planned windows, 21 distinct deployers, three
legs.** Flow-weighted, which is the unit captain decision **399a** allocates in, it is **`0.0462`**.

**It is not the 0.5526 the supply plan is written against, and the plan does not survive it.** At
the measured fraction the full 398a + 399a ladder delivers **91–355 distinct usable windows a
month against a floor of 1,000** — short by 645 at best and 909 at worst. The floor is not
reachable at the current gate by any combination of the authorised levers.

Reproduce every figure here offline, with no credential and no socket:

```
node tools/deployer-screen/measurements/2026-08-09-widened-usable-fraction/usable-fraction.mjs
```

---

## 1. What "usable" means, and the denominator that is easy to get wrong

A window is **usable** when it produced the figure Stage 2 exists to produce: **a room reading**
(`entry.launchesSampled`). The fraction is that over `entry.coverage.launchesPlanned`, summed over
every candidate a run SCORED.

That is exactly the definition `slot-zero-discovery-beyond-madeonsol` → `report.md` §2.2 used for
the pooled 0.5526 (held in firstmate's records, not in this repo). **The script reproduces that
pooled figure from the committed records before reporting any new one** — 105/190 = 0.5526, with
every per-leg value matching — so the old number and the new one are known to be the same quantity
measured two ways, not two quantities compared.

**Two denominators, and they answer different questions.** `usable / PLANNED` is what a scoring
slot is worth and is the only one a throughput figure may be multiplied by. `usable / WALKED` is
what the room rule alone costs once our own walk drops are removed. Note that
`coverage.launchesUsable` means *the walk returned a tape* — that is NOT this report's sense of
usable, and conflating the two is the easiest available mistake here.

## 2. The population, and why it is the right one

The **37 pump.fun deployers that passed the committed Stage 1 gate in 2026-07 and are invisible to
every discovery source this repo has** — the rows marked **unseen** in
`slot-zero-census-gate-true-denominator` → `gate-passers-2026-07.md` (held in firstmate's records,
not in this repo; census read 2026-08-07 over all 176,200 July-active deployers, 58 of which pass).

They are the population captain decision **398a**'s `--wallets` input exists to reach, and they are
worth 1,442 of the 2,002 distinct windows the whole gate-passing population produced in July. The
committed input is `widened-37.txt`; the three legs gate `widened-37-part{1,2,3}.txt`, which are
disjoint, interleaved by census rank so each leg spans the launch-flow distribution, and whose union
is exactly the 37.

**This is a different population from the four baseline legs and is never pooled with them.**

## 3. The result

| leg | date | scored | planned | walked | room | usable/planned |
|---|---|---|---|---|---|---|
| `widened-part1.json` | 2026-08-09 | 7 | 70 | 70 | 18 | 0.2571 |
| `widened-part2.json` | 2026-08-10 | 7 | 70 | 70 | 11 | 0.1571 |
| `widened-part3.json` | 2026-08-10 | 7 | 70 | 69 | 9 | 0.1286 |
| **MEASURED, widened, 2026-08-09/10** | | **21** | **210** | **209** | **38** | **0.1810** |

For contrast only, never pooled with the above — the superseded baseline, reproduced here from the
committed records: `runs/2026-08-04.json` 0.1333, `2026-08-05-tier-good` 0.5857,
`…tier-elite` 0.6000, `…untiered` 0.9000, **pooled 0.5526** over 190 windows.

**The three widened legs agree with each other.** The 0.13-to-0.90 swing that made the pooled
baseline unusable does not appear on this population: 0.2571 / 0.1571 / 0.1286 across three
independent thirds. That agreement is what makes this a usable estimate rather than another wide
spread.

## 4. WHERE the windows went — and it is not our budget

| disposition | windows | share of planned |
|---|---|---|
| produced a room reading | 38 | 0.1810 |
| **refused by `roomIsProven` — create slot not provably co-ordinated** | **171** | **0.8143** |
| dropped by the request cap | 1 | 0.0048 |

**209 of 210 windows walked cleanly (0.9952).** The fill walk is not the constraint and no
transport failed; `keylessShed` was **0** across all three legs. What refuses these windows is
captain decision **134a**: a create slot carrying no bundled transaction and no adjacency run is
*indistinguishable* from one with no co-ordination, so it is not scored.

Entry verdicts over the 21 scored candidates: **18 `entry-unmeasured`, 3 `entry-room-absent`, zero
`entry-open-after-costs`.**

This REPRODUCES, on a 7× larger sample and a different population, what
`runs/2026-08-04-full-day-default.md` found: 18 of its 22 walked windows were refused by the same
rule. **Captain decision 203a already established that the evidence which would make a stranger's
create slot provable has been looked for and is not there** — Jito bundle membership converts 0 of
18 such windows and shared fee payer is fully subsumed by the shipped union. So these 171 windows
are not recoverable by any authorised lever, and the cause is occupancy rather than blindness.

## 5. The fraction falls as launch flow rises — which is the term 399a ranks on

| | n | mean usable fraction |
|---|---|---|
| flow ≥ 1 launch/day | 9 | **0.0333** |
| flow < 1 launch/day | 12 | **0.2917** |

Spearman **ρ = −0.4719** between a wallet's `launchesPerDay` and its usable fraction, **t = −2.333
on 19 df**, two-sided *p* < 0.05. The tempo is read from `scoringRotation.order[].launchesPerDay`,
persisted since schema 23 — so this is derived from the run records alone and asks no vendor
anything.

**n = 21 wallets, one population, one measurement.** It is a real association at this sample size
and it is not established as causal; the direction, not the coefficient, is what matters below.

The consequence is specific and uncomfortable: **399a points the scoring cap at the highest-flow
survivors, and those are the ones returning no usable windows.** The highest-flow wallet measured
(17.10 launches/day) returned **0 of 10**. That is why the flow-weighted fraction (0.0462) is a
quarter of the pooled one (0.1810), and it converts 399a's harvest gain into a usable-window loss.

## 6. THE RESTATEMENT — distinct USABLE windows per month (captain decision 379b's unit)

Every figure in this table is in **distinct usable windows per month**. The middle column is what
the supply plan currently quotes; the right column is the same rung at the fraction measured here.
The distinct-window counts (560 / 1,067 / 1,963 / 2,002) are unchanged — they are a harvest
arithmetic and this measurement does not touch them.

| rung | distinct windows/mo | @ 0.5526 (superseded) | @ measured | fraction applied |
|---|---|---|---|---|
| today: 21 reachable wallets | 560 | **309** | **101** | pooled 0.1810 |
| + 398a wallet-list input, round-robin | 1,067 | **590** | **193** | pooled 0.1810 |
| + 399a flow-weighted allocation | 1,963 | **1,085** | **91** | flow-weighted 0.0462 |
| ceiling: all 58 fully harvested | 2,002 | 1,106 | 362 | pooled 0.1810 |
| capacity (**measurement ACTS**/mo, a different unit) | 2,100 | 1,160 | 380 | pooled 0.1810 |

**The floor is 1,000 distinct usable windows per month. The ladder does not clear it, on either
reading, and it is not close.** The full 398a + 399a rung reads **91** flow-weighted and **355**
pooled — **short by 909 and 645**. Even the absolute ceiling, every one of the 58 gate-passers
harvested completely, reads **362**: the floor is **2.8× the entire addressable pump.fun supply** at
this fraction, against ~90% of it at the superseded one.

**399a reads lower than 398a alone (91 against 193).** That is not an error in the table. 399a
harvests 1.84× more distinct windows but draws them from the wallets §5 measures as least usable, so
the usable count falls. Read it as: *the allocation gain is real in windows and negative in usable
windows on this population.* This is the measured form of the selection-quality cost the captain
accepted knowingly when adopting 399a, and re-deciding it is the captain's, not this lane's.

## 7. What this measurement does NOT establish, and one it is robust to

- **The gate reading is the ownership listing, not creation-derived history.** The Dune enumeration
  leg could not run: the account holding the four saved queries has 455.643 credits against a pinned
  worst case of 690.4 that is independent of candidate count, so the guard refuses it (shortfall
  259.757). The legs therefore ran `--no-dune`, and the keyless creation walk covers **nothing**:
  `candidates[].creation.coveredDays` is **0 on 35 of the 37**, every one stopping on
  `request-ceiling` with `createdInWindow: 0`, so the merged history is the 280-record
  `frontend-api-v3` ownership listing carried over. `historySource` on every record says
  `creation-derived`; read it as *listing-dominated*. That is the documented behaviour of the
  keyless route — 100 requests against 1,000-entry signature pages usually stops inside page one —
  and it is why the walk cost 2.4 h of the lane's wall clock and bought no coverage.
- **The conclusion is robust to that gap anyway.** The listing reading gate-passed **34 of 37**,
  against the census's Dune-derived 37 of 37. The three it loses fail `minCompletionRate` at 0.2405,
  0.2326 and 0.2179 against a 0.25 bar — near-misses, not coverage artefacts, and notably not the
  `minSpanDays` failures the shorter 70-record vendor page produced. So a Dune-gated run could add at
  most 3 wallets, and even if all 30 of their windows were perfectly usable the fraction would reach
  only **68/240 = 0.2833** — still half the superseded figure, and still 646 short of the floor at
  the 399a rung. **No Dune reading rescues the supply plan.**
- **One month, one population, one measurement.** 21 wallets and 210 windows. The census's own
  caution applies: 58 is a reading of 2026-07 taken on 2026-08-07, not a stationary rate.
- **It says nothing about captain decision 343a**, which is the only authorised lever that raises the
  usable fraction. 343a lets the already-computed `roomMedianBound` emit `entry-room-absent`; it does
  not make a `roomIsProven` refusal scoreable, and §4's 171 windows are refusals of that kind. Sizing
  343a against this population is its own lane.

## 8. Spend — projected, then actual

| provider | projected | **actual** | bound |
|---|---|---|---|
| MadeOnSol | ≤37 keyed/run | **97 keyed** total (recon 37, abandoned run 23, refused run 0, three legs 37) | 100,000/day — **0.097%**, against a 5% stop |
| Dune | ~11 credits if the leg ran | **0 credits, 0 executions** | leg refused before its first billed request |
| Helius | 0 | **0 credits** | `HELIUS_API_KEY` unset for every child |
| keyless `api.mainnet-beta` | ≤3,700 + ≤3,500/run | **3,663** over the legs | pinned per-candidate ceilings |
| keyless `frontend-api-v3` | ≤148/run | **583** over the legs | ceiling 1,400/run |
| keyless `swap-api` | ≤1,260/run | **527** over the legs, **0 shed** | ceiling 1,260/run |
| money | EUR 0 | **EUR 0** | — |

Dune contact was limited to the free `POST /usage` metadata endpoint, which consumes no credits, plus
one 404 on a saved query. Both accounts' balances were unmoved by this lane: 3,590.173 remaining on
the paid key, 455.643 on the query-bearing one.

Wall clock: three legs in **3.6 h** (71 + 65 + 78 min).

## 9. The files

- `widened-37.txt` — the population; `widened-37-part{1,2,3}.txt` — the three disjoint legs.
- `runs/widened-part{1,2,3}.json` — the run records every figure here is computed from.
- `runs/widened-2.partial.json` — the Dune-enumerated run that was refused, kept because its `dune`
  block is the evidence for §7's allowance shortfall.
- `recon/recon-ownership.json` — the free `--ownership-only --no-stage2` reconnaissance over all 37.
- `usable-fraction.mjs` — the analysis, offline and credential-free.
- `chain-free.sh` — the runner that produced the three legs, carrying its own declared bound.
- `rotation-state.json` — the rotation state the three legs advanced, so each leg's selection is
  re-derivable; `dune-spend.tsv` — the before/after credit ledger, showing a delta of 0.

**A credit-balance helper was written for this lane and is deliberately NOT committed.** It named
`DUNE_API_KEY`, and `test/deployer-screen.test.ts` → "only the credential module names an
environment variable that holds a key" refuses that anywhere under `tools/deployer-screen/` except
`credential.mjs` and `screen.mjs`. The guard is right and was not weakened to keep a convenience:
the balances this lane needed are recorded in `runs/widened-2.partial.json` → `dune.allowance`,
which is the run's own reading and better evidence than a helper's.
