# The bundling census — how often does a deployer bundle its create-slot transaction?

**Captain decision 173a, 2026-08-03.** Run record: `2026-08-03-bundling-census.json`, beside this file.
Tool: `node tools/deployer-screen/bundling.mjs`. Bounds: `thresholds.json` → `bundling_census`.

**Read the sample size before any rate on this page.** Every fraction below is stated with its own
denominator, and the largest denominator here is **14 candidates**. That is not a rounding of 20–30;
it is the entire gate-survivor population this repository can currently reach. §1 says why.

---

## Verdict

**The per-launch bundling rate across the whole sample is 18 of 112 windows = 0.1607, and the
headline is 1 of 14 candidates = 0.0714.** The one candidate that bundles on all eight of its most
recent eligible launches **is our own control deployer.** Among the thirteen strangers the rate is
**0 of 13**.

**11 of the 14 never bundle at all** — `maxWalletsInOneTx <= 1` on every one of their eight
windows — so re-screening them produces the same silence forever. Only **2** are near-misses that
bundle sometimes and fell short of eight of eight.

**The create slots are not empty, and that is what makes the finding a finding.** Across the 112
windows the create slot held a median of **5.5 distinct wallets** (p75 10.25, max 35), and **96 of
the 112 held two or more**. Of those 96, only **18** carried a transaction with two wallets in it.
So the co-ordination rule is not looking at quiet openings — it is looking at busy ones in which
nobody shares a transaction.

**`n = 2 strangers` has become `n = 13 strangers`, and the direction did not change.** It got
stronger.

---

## 0. Bounds declared before the first request, and what was actually spent

| provider | metered in | **bound declared** | **actually spent** |
|---|---|---|---|
| **MadeOnSol** | requests | **0** | **0** |
| **Helius** | credits | **0** | **0** |
| **Dune** | executions | **0** | **0** |
| `frontend-api-v3.pump.fun` | requests | 480 (`maxListingRequests`) | **101**, 0 shed |
| `swap-api.pump.fun` | requests | 4,320 (`maxKeylessRequests`) | **484**, 0 shed |
| `api.mainnet-beta.solana.com` | requests | 0 | **0** |

Wall clock **59.7 minutes**, exit 0, run completed. Zero load-shed events on either host.

**The keyed zero is structural, not careful.** There is no keyed client in `bundling.mjs` — a test
asserts `BoundedClient`, `DuneClient`, `SolanaRpcClient`, `credential.mjs` and `process.env` are all
absent from it. The pass could not spend a vendor request if it were told to.

**Why it is zero rather than the ~20 the brief sized.** This environment holds no
`MADEONSOL_API_KEY`. Rather than block on that, the pass takes its cohort from records this
repository already paid for — `feed/ledger.json` and `runs/*.json`, 82 distinct wallets — and reads
each candidate's launch list from the keyless ownership listing. The shared daily allowance is
untouched, and no measurement below depends on a key.

Two hand-issued probe legs sit outside the tool and are counted here for completeness: a **6-launch
clock-skew probe** (~30 swap-api requests, §5) and a **2-launch parsing control** against our own
subject (~13 swap-api requests, §4). Both keyless, both on the free host.

---

## 1. The sample is 14, it is under the brief's 20–30, and the reason is not budget

| | |
|---|---|
| cohort found in committed records | **82** wallets |
| gated by this pass, keylessly | **82** |
| cleared the pinned `stage1_gate` bars | **14** |
| surveyed | **14** (the cap is 30; nothing was truncated) |
| gate-failed, not surveyed | 68 |

**14 is the whole population, not a sample of it.** The census cap is 30 and `leftUnsurveyedByCap`
is 0 — every wallet that passed the gate was walked. Reaching 20–30 would require *new* MadeOnSol
discovery, which is keyed and which this environment cannot do. The honest statement is that this
repository's entire accumulated discovery pool yields 14 gate survivors, and all 14 are here.

**The gate applied is the OWNERSHIP reading**, which `FEED.md` establishes is biased *towards
rejection*. So these 14 are survivors on the harder of the two readings, and the surveyed population
is a subset of what a keyed Stage 1 would have passed rather than a superset. It agrees with this
repository's own recorded keyed verdicts on **80 of 82** wallets: `8KYMfXzp…` passes here and was
recorded `gate-failed`, `9LUgfzet…` fails here and was recorded `gate-passed`.

**What a denominator of 14 can and cannot settle.** Its granularity is 1/14 = 7.1 points, and a
95% interval around the headline is roughly ±20 points. It separates *"almost none"* from *"most"*
and settles nothing finer. Do not quote 0.0714 to three figures as though it were a population
parameter.

---

## 2. The four answers

### 2.1 Per-launch bundling rate — **18 of 112 = 0.1607**

n = **112 launch windows** over **14 candidates**. Every window was walked back past its own mint
and proved: **0 dropped, for any cause**, so the denominator is windows whose create slot was
actually seen. A window that could not be walked is dropped rather than counted as unbundled —
counting an unreachable create slot as "no bundle" would manufacture this very finding.

### 2.2 Per-candidate distributions

Distributions, never a mean — the standing captain bar for this class.

| statistic | n | min | p25 | median | p75 | max |
|---|---|---|---|---|---|---|
| `bundledTx`, per launch | 112 | 0 | 0 | **0** | 0 | 3 |
| `maxWalletsInOneTx`, per launch | 112 | 1 | 1 | **1** | 1 | 3 |
| median `bundledTx`, per candidate | 14 | 0 | 0 | **0** | 0 | 2 |
| median `maxWalletsInOneTx`, per candidate | 14 | 1 | 1 | **1** | 1 | 3 |
| bundled share, per candidate | 14 | 0 | 0 | **0** | 0 | 1 |

The median candidate's median window has **no bundled transaction and no transaction carrying more
than one wallet.** Every quartile except the max is degenerate, which is the shape of the finding.

Per candidate, `usable` is 8 and `dropped` is 0 on every row:

| wallet | listed | rate | span d | bundled / 8 | all 8 | never bundles | med `maxWalletsInOneTx` | med create-slot wallets |
|---|---|---|---|---|---|---|---|---|
| `7ufmve7Z…` **(our control)** | 249 | 0.4337 | 244.0 | **8** | **yes** | no | **3** | 13.5 |
| `AbVkRUfy…` | 73 | 0.3288 | 706.9 | 6 | no | no | 2 | 10.5 |
| `yHCxHBEa…` | 280 | 0.6679 | 51.9 | 4 | no | no | 2 | 16.5 |
| `2N7qg9a3…` | 61 | 0.5410 | 581.6 | 0 | no | **yes** | 1 | 1 |
| `3FiWnNDT…` | 65 | 0.3846 | 38.5 | 0 | no | **yes** | 1 | 10.5 |
| `3jBzE4c9…` | 56 | 0.2679 | 297.0 | 0 | no | **yes** | 1 | 8.5 |
| `3yKebvka…` | 29 | 0.3448 | 117.0 | 0 | no | **yes** | 1 | 7 |
| `4J54atPc…` | 26 | 0.3077 | 216.4 | 0 | no | **yes** | 1 | 4 |
| `5KTX7LZy…` | 32 | 0.6563 | 42.1 | 0 | no | **yes** | 1 | 7.5 |
| `8KYMfXzp…` | 82 | 0.2927 | 120.5 | 0 | no | **yes** | 1 | 2 |
| `ALJ4P5QN…` | 162 | 0.3395 | 290.2 | 0 | no | **yes** | 1 | 4.5 |
| `AQdBYZNy…` | 90 | 0.3667 | 780.6 | 0 | no | **yes** | 1 | 2.5 |
| `B6QvkTWS…` | 39 | 0.3077 | 789.9 | 0 | no | **yes** | 1 | 5.5 |
| `GeBJSHK4…` | 280 | 0.3750 | 77.8 | 0 | no | **yes** | 1 | 4.5 |

### 2.3 THE HEADLINE — **1 of 14 = 0.0714** bundle on all eight

n = **14 candidates with a full 8-window sample** (all 14 produced one, so nothing was excluded for
a reason that is not bundling).

**That fraction is exactly the population Stage 2 can currently reach a verdict for.** Its
complement — **13 of 14** — is what the current pinning silences.

**And the one is our own control.** `7ufmve7Z…` is the deployer this repository already holds 239
launches of, and Stage 0 asserts Stage 2 must *refuse* it. **Among the 13 strangers the fraction is
0 of 13.** On this sample the screen would have produced an entry verdict for nobody it did not
already know.

### 2.4 Permanently unscoreable — **11 of 14** — counted apart from the near-misses

| category | count | meaning |
|---|---|---|
| **never bundles** | **11** | `maxWalletsInOneTx <= 1` on all 8 windows. The `GeBJSHK4…` shape: the co-ordination rule can never see a bundle, so re-screening produces the same silence forever. |
| near-miss | **2** | bundles sometimes, fell short of 8 of 8 (`AbVkRUfy…` 6/8, `yHCxHBEa…` 4/8). A different screen day could move these. |
| scoreable | **1** | our own control. |

The two are never summed. 11 of the 13 silenced candidates are silenced *permanently*; only 2 are
silenced by luck.

**The 11 are not quiet launches.** Pooled over their own 88 windows — not the whole sample's 112 —
their create slots hold a median of 4.0 wallets, up to 26, and 72 of the 88 held 2+. (The
whole-sample median 5.5 / max 35 of §2.1 is over all 14 candidates' 112 windows, and the 35 belongs
to `yHCxHBEa…`, a near-miss that bundles 4 of 8 and is not in this group.) `3FiWnNDT…` has a median
of 10.5 wallets in the create slot — mean 9.375 — and never once has two of them in one transaction.

---

## 3. Era and trend — **the live sample cannot carry it, and here is what can**

**It cannot, and I am not going to pretend otherwise.** Each candidate contributes its eight most
recent *contiguous* eligible launches; the sampled ages run median 10.65 days. Bucketing the 112
windows by age gives this —

| age bucket | launches | bundled | rate | distinct candidates |
|---|---|---|---|---|
| 0–7 d | 45 | 12 | 0.2667 | 9 |
| 7–30 d | 28 | 2 | 0.0714 | 7 |
| 30–90 d | 25 | 4 | 0.1600 | 5 |
| 90 d+ | 14 | 0 | 0.0000 | 2 |

— and **that table is confounded, not a trend.** The 0–7 d bucket is where the two heaviest
bundlers' launches land, so it is measuring *which deployers launch often*, not *when bundling
happens*. With 14 deployers and no within-deployer time depth, deployer identity and calendar time
cannot be separated. **No trend claim is made from this run.**

**Where the era question CAN be answered is offline, at n = 1 deployer.** `--subject-era` buckets
the committed population tape's 235 proved create slots (no request of any kind):

| month | launches | bundled | rate | median `maxWalletsInOneTx` |
|---|---|---|---|---|
| 2025-12 | 11 | 0 | 0.0000 | 1 |
| 2026-01 | 3 | 0 | 0.0000 | 1 |
| 2026-02 | 1 | 0 | 0.0000 | 1 |
| 2026-03 | 21 | 6 | 0.2857 | 1 |
| 2026-04 | 65 | 38 | 0.5846 | 3 |
| 2026-05 | 41 | 41 | 1.0000 | 3 |
| 2026-06 | 41 | 39 | 0.9512 | 3 |
| 2026-07 | 52 | 51 | 0.9808 | 3 |
| **whole tape** | **235** | **175** | **0.7447** | |

Replaying the headline over that history — would the trailing 8 launches all have been bundled,
i.e. would Stage 2 have reached a verdict that day? — gives **147 of 228 trailing windows =
0.6447**, rising from 0.0000 before April to 0.8462 in July, and **true** for the newest window.

**Read that as one deployer.** It is a within-deployer trend and a second window series does not
exist in this repository. What it establishes is that **the rate is not stationary for an operator
who changes its submission habit** — this one went from never bundling to nearly always bundling
inside two months. What it does not establish is how many other deployers moved the same way, and
the live census's 11 permanent non-bundlers suggest most have not.

---

## 4. Three independent cross-checks, and why the zeros are believed

A finding of "almost nobody bundles" is exactly the shape a silent parsing bug would produce — if
the live trade row's transaction field never reached `Fill.tx`, every fill would look like its own
transaction and `maxWalletsInOneTx` would be 1 everywhere. That was checked **before** the zeros
were believed, not after.

1. **Our own subject, walked live through the production functions.** Its newest launch reads
   `bundledTx 2`, `maxWalletsInOneTx 3`, and wallets-per-transaction `1,3,3,1,1,1,1,1,1` — the dev
   buying alone plus two three-wallet bundles, which is exactly the shape the committed tape
   describes. The field reaches `Fill.tx` correctly.
2. **`7ufmve7Z…` in the census itself: 8 of 8, `bundledTx 2` and `maxWalletsInOneTx 3` on every one
   of the eight windows.** That agrees with the offline tape's 0.9808 July rate. A run that read
   every deployer as a non-bundler would have read this one that way too.
3. **`yHCxHBEa…` reads 4 of 8 and `GeBJSHK4…` reads 0 of 8 with `maxWalletsInOneTx` 1 at min, median
   and max** — reproducing `data/slot-zero-stage2-reverify/report.md` §2a **exactly**, from a
   *different launch-list surface*. That run took its mints from the keyed MadeOnSol profile; this
   one from the keyless ownership listing, four days apart. Two surfaces, same numbers.

---

## 5. A defect this run found and fixed, which any future window walk driven off this surface will hit

**The first live run dropped 5 of the first candidate's 8 launches as `mint-time-disagreement`.**

Cause, measured over 6 launches of one cohort wallet: `frontend-api-v3`'s `created_timestamp`
carries **millisecond precision on older listing rows** while `swap-api`'s fill `ts` is **whole
seconds, floored**. So the declared mint lands *after* the launch's own first fill:

| launch | `created_timestamp` | oldest fill `ts` | skew |
|---|---|---|---|
| `3ghKZfLZ…` | …205**000** | …205000 | **0 ms** |
| `HJatmT9Z…` | …747**000** | …747000 | **0 ms** |
| `AoYbxbyG…` | …352**000** | …352000 | **0 ms** |
| `6NSjxVC8…` | …849**813** | …848000 | **+1,813 ms** |
| `CA8pKYD4…` | …559**313** | …558000 | **+1,313 ms** |
| `6jDBxde8…` | …485**014** | …483000 | **+2,014 ms** |

`readLaunchWindow`'s pre-mint tripwire compares with **zero slack** and its own comment warns that a
positive skew of one millisecond deletes an entire create slot. It does, and silently, and on a
non-random subset — the *older* half of a wallet's history.

Fixed by pinning `bundling_census.mintTimeBackdateMs: 5000` — 2.5× the worst observed skew plus the
shared second of granularity, and **the same value `tools/arrival-rate-walk/bounds.json` already
pins as `walk.mintFloorSlackMs`** for the same failure on a different clock pair. Precedent applied,
not a number invented. After the fix: **0 drops across all 112 windows.**

The backdate cannot reach the measurement — the create slot is the *oldest* end of the walk, so a
wider floor admits more of this launch's own opening and nothing of any other token's. What it costs
is stated in `MINT_TIME_BACKDATE_CAVEAT`, which travels into the dry-run plan, the record and the
rendered summary: a genuine disagreement smaller than 5 s is no longer detected. One larger still
drops the launch and is still counted by cause.

Recorded in `CLAUDE.md` → pump.fun provider facts, because it binds anything driving
`readLaunchWindow` off a `frontend-api-v3` creation time.

---

## 6. What this measurement does NOT establish

- **It is not a population rate for pump.fun deployers.** It is 14 wallets, every one of them
  surfaced by MadeOnSol enumeration and then gated on competence. Captain decision 165b's warning
  binds: every seed this repository has conditions on current or lifetime success.
- **The launch list is the OWNERSHIP reading.** A listed token may have been acquired rather than
  created — its create slot is then somebody else's bundling habit — and a token handed on is
  missing entirely, and the ones handed on are the winners. The measured size of that gap on the
  five wallets holding both readings is nil (`CREATION-DERIVED.md`), which bounds it without
  removing it.
- **`bundledTx` is a property of the create slot, not of the operator.** `roomIsProven` asks only
  whether *some* transaction there carried 2+ wallets. A deployer whose own cohort co-ordinates via
  separate transactions in the same Jito bundle is invisible to it — which is `measure.mjs`'s stated
  blind spot, and the most likely explanation for 11 of 14 reading zero. **This census measures how
  often the rule can see anything. It does not measure how often deployers co-ordinate.**
- **It says nothing about whether those 13 windows are enterable.** No room figure, no field, no
  entry cost, no verdict was computed. Room to enter is a Stage 2 question and this pass is not
  Stage 2.

---

## 7. What the number implies for the pinning choice — **and the choice is the captain's**

Stated as implications, not as a recommendation. No threshold moved in this lane's diff, and
lowering `minLaunchesSampled` is separately refused by captain decision 141a and asserted against by
Stage 0.

- **The silencing is not an edge case.** On this sample Stage 2 reaches a verdict for 1 candidate in
  14, and that one is the control it is designed to refuse. For strangers the observed rate is 0 of
  13. Whatever the true population rate is, a sample of 14 is enough to say it is **not** "most".
- **Relaxing the sample size would not fix most of it.** 11 of the 13 silenced candidates never
  bundle *at all*, so any rule of the form "k of the most recent n" silences them for every k ≥ 1.
  Only the 2 near-misses are reachable by moving `minLaunchesSampled` below
  `maxLaunchesPerCandidate`. **The sample-size question and the never-bundles question are different
  questions, and the second is the larger one here.**
- **The three levers are not equivalent.** Lowering `minLaunchesSampled` buys the 2 near-misses at
  the cost of thinner evidence per verdict (141a's argument, unchanged). Raising
  `maxLaunchesPerCandidate` buys a longer history at a proportional request cost —
  `3 × 20 × 18 = 1,080` and ~2.1 h per run — and would *not* reach the 11. Reaching the 11 at all
  requires a different **predicate**, not a different sample, and decision 139a already measured
  that the obvious tightening (require the deployer in the bundle) matches 0 of 235 launches on our
  own tape.
- **The direction of error is unchanged and still correct.** #17 can only produce false rejections.
  What this run establishes is the *magnitude*: on the population the screen actually meets, the
  refusal is the common case rather than the exception.

---

## 8. Reproduction

```
node tools/deployer-screen/bundling.mjs --dry-run       # the whole exposure, fetches nothing
node tools/deployer-screen/bundling.mjs --subject-era   # §3's offline table, zero requests
node tools/deployer-screen/bundling.mjs --out tools/deployer-screen/census/2026-08-03-bundling-census.json
npm test                                                # 637 tests, tsc clean
```

The cohort is read off disk, so the wallet list is reproducible from the tree. The gate readings and
the windows are live and will move as those wallets launch again; the record pins what was seen at
`startedAtIso`.
