# Creation-derived launch history — what was measured

Measured 2026-08-02, extended 2026-08-03 with the indexed (Helius) route — see §7. Method and code:
`creation.mjs`, `pumpfun.mjs` → `readCreatedHistory` (keyless) and `readCreatedHistoryIndexed`
(keyed), and README → [Which history the gate counts](./README.md#which-history-the-gate-counts).

This file records **numbers**, not method. It exists because the correction it documents turned out
to be small, and a small correction with no record of its size is indistinguishable from a large one
nobody checked.

## The result, in three lines

1. **The premise is true.** A token's creator record does move, and the one we caught moving is the
   best launch in our 239-launch record — created by `7ufmve7Z…`, no longer listed under it.
2. **The gap it opens is nil at the level this gate reads.** Five wallets have both readings;
   four show a gap of exactly zero launches, one shows one launch in 239. **No verdict changes.**
3. **The reason is measurable, not lucky.** Creator records move often (up to 15 of 27 launches on
   one wallet) but almost always into a *fee-sharing config* that pump.fun still attributes to the
   wallet. Only a genuine handover removes the token, and that is rare.

The correction is kept anyway: it converts an unbounded unknown into a measured zero, and the run
record now carries both readings so the day it stops being zero is visible.

---

## 1. The premise, confirmed on-chain

The defect was asserted from a code comment and a sibling project's note. It is now observed.

| | |
|---|---|
| token | `32CdQdBUxbCsLy5AUHWmyidfwhgGUr9N573NBUrDpump` — `maxxing`, ATH **$7,721,545** |
| **created by** | `7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL` (our subject deployer) |
| **create transaction** | `64pCziaL1tpcXKNtamcrryukkZjpY37tJoWEcLj8Emao4Gp7GQraReGVSJYJXYK4x1EEeAp1oQzBq433JZTviSEU` — slot 383821204, 2025-12-01T19:37:59Z, program log `Instruction: CreateV2`, sole non-mint signer `7ufmve7Z…` |
| **owner now, per pump.fun** | `creator` = `cto_address` = `CnV5TnQrMBLdrZGQsRXJC91s38XaXZsFatq27LA2Vpen` |
| **owner now, on-chain** | bonding curve `EwUYjzduqTwSmAo8ubECzLUVU524LhfhqtVx2H86ievc` offset 49 → `9v45QaQtNN9xNYgsnUqeUwCK8iHi3MPTbn5on8DY9SQy` |
| **the move** | `5fjZDdFQFpn69AhXnXg3WdKFFqeLUFeBbwxnQxz4paaYcbG1AoxggMFZPbM8ZKf4eBS2VYWBuvDtPHnxc9H1yryr` — slot 398086225, 2026-02-04T21:41:18Z, signer `CnV5TnQr…`, logs `CollectCreatorFee` → `CreateFeeSharingConfig` → `MigrateBondingCurveCreator` → `MigratePoolCoinCreator` |

Offset 49 was validated first against a control token whose creator has never moved
(`EijM3FJm…pump`, curve `Xeka4UrE…`), where it reads `7ufmve7Z…` exactly.

The creator moved **twice**: deployer → community-takeover wallet → fee-sharing config. The
current on-chain creator is therefore not a wallet at all. The takeover transaction itself was not
pinned; it lies among the 4,245 curve transactions between 2025-12-01 and 2026-02-04 and locating
it would have cost ~4,245 `getTransaction` calls for no additional conclusion.

**The premise holds.** `?creator=7ufmve7Z…` cannot return this mint.

## 2. The parser, validated against the 239-launch ground truth

Five launches checked end to end — the four cheapest to reach plus `maxxing`. On all five,
`parseCreateTransaction` and `readCurveState` reproduced the committed dataset exactly:

| launch | mint matches | creator | `complete` vs `graduated` | creator-moved vs `creator_field_moved` |
|---|---|---|---|---|
| `End` | ✓ | `7ufmve7Z…` | false / 0 ✓ | false / 0 ✓ |
| `Mindset` | ✓ | `7ufmve7Z…` | false / 0 ✓ | false / 0 ✓ |
| `Trenchmade` | ✓ | `7ufmve7Z…` | false / 0 ✓ | false / 0 ✓ |
| `Replenish` | ✓ | `7ufmve7Z…` | false / 0 ✓ | false / 0 ✓ |
| `maxxing` | ✓ | `7ufmve7Z…` | true / 1 ✓ | **true / 1 ✓** |

Creation timestamps matched `created_utc` to the second on all five.

## 3. The size of the error

### 3.1 The subject deployer — exact, complete, from committed ground truth

`data/population-tape-2026-07-29/launches.csv` is a creation-derived census of all 239 launches
and carries `creator_field_moved` per row. No network was needed for this row.

| reading | launches | bonded | rate |
|---|---|---|---|
| **creation-derived** (truth) | 239 | 103 | **0.4310** |
| ownership-derived | 238 | 102 | 0.4286 |
| **gap** | −1 (**0.42%**) | −1 (**0.97%**) | −0.0024 (0.55% relative) |

**The predicted direction holds and the predicted magnitude does not.** The bonded count is
understated 2.3× more than the launch count, exactly as the mechanism says it should be — the
token that moved was a graduation. But one launch in 239 moved, and the rate moved by 0.0024. The
verdict does not change: this wallet clears the gate on both readings, comfortably.

The one launch that moved was the **best one in the record**: $7.72M ATH against $918k for the
next. So the *selection* is as adversarial as predicted — 1 of 239 launches, but 1 of 1 of the top
launches — while the *aggregate* barely moves. Both facts are true and neither cancels the other.
A completion-rate gate is nearly immune. A gate that weighted by peak market cap, or any Stage 2
measurement that looks at the best launch rather than the count, would not be.

### 3.2 The elite cohort — four of twelve, and why not twelve

**Four of the twelve wallets in `runs/2026-07-29-elite.json` were measured. In all four the gap is
zero.** Two were walked over their *entire* signature index, so those two are not windows but
complete histories.

| wallet | walk coverage | created in window | listing showed | **hidden** | acquired | on-chain creator moved |
|---|---|---|---|---|---|---|
| `F5ExBJxM…` | **WHOLE INDEX**, 386 days | 10 | 10 | **0** | 0 | 2 of 10 |
| `ELcFk5c9…` | **WHOLE INDEX**, 248 days | 8 | 8 | **0** | 0 | 0 of 8 |
| `4q4GKBpV…` | 29.8 days (request-ceiling) | 24 (+3 below the floor) | 24 | **0** | 0 | 15 of 27 |
| `3FiWnNDT…` | 33.7 days (request-ceiling) | 52 (+9 below the floor) | 52 | **0** | 0 | 2 of 61 |

Walk cost actually spent, and it matched the model: 170 / 213 / 999 / 999 requests, scanning
909 / 225 / 2,000 / 32,687 signatures. **Zero load-shed events and zero unresolved transactions
across all four** at 2.5 s pacing and batch size 1.

| wallet | creation-derived | pump.fun listing | MadeOnSol, committed run | verdict |
|---|---|---|---|---|
| `F5ExBJxM…` | 6/10 = 0.6000 | 6/10 = 0.6000 | 5/9 = 0.5556 | gate-failed, unchanged |
| `ELcFk5c9…` | 7/8 = 0.8750 | 7/8 = 0.8750 | 7/7 = 1.0000 | gate-failed, unchanged |
| `4q4GKBpV…` | 49/152 = 0.3224 | 49/152 = 0.3224 | 22/70 = 0.3143 | gate-failed, unchanged |
| `3FiWnNDT…` | 25/65 = 0.3846 | 25/65 = 0.3846 | 24/63 = 0.3810 | **gate-passed**, unchanged |

### The distribution, stated as a distribution

Across the five wallets where both readings exist — the four above plus the subject deployer, whose
answer is exact and complete:

| launches hidden by the ownership reading | wallets |
|---|---|
| 0 | 4 |
| 1 | 1 |

| completion-rate gap | wallets |
|---|---|
| 0.0000 | 4 |
| 0.0024 | 1 |

**Verdicts changed: 0 of 5.** No mean is quoted because four of five values are exactly zero and a
mean of that is a number with no referent.

**This is a negative result and it is reported as one.** The defect is real, its direction is real,
and on these wallets its magnitude is nil. The correction was still worth making — but it is worth
making because it removes an *unbounded unknown*, not because it moved a number.

### Why the gap is so much smaller than the mechanism suggests

The measurement explains itself. **On-chain creator movement is common; losing the token off the
owner's listing is not.** `4q4GKBpV…` moved the on-chain creator on **15 of 27** launches and lost
**none** of them from `?creator=`. That is because the common form of the move is a *fee-sharing
config migration* — the curve's `creator` field becomes a config PDA while pump.fun still
attributes the token to the wallet. The rare form is a genuine handover or community takeover,
which does remove it, and that is what happened to `maxxing`.

So the population rate of the thing that actually hurts is **1 launch in 239 observed**, not the
"any creator move" rate of roughly 1 in 3. A screen that had counted `movedCreator` as the bias
would have overstated it by two orders of magnitude.

### A bigger denominator error was sitting next to this one

On three of the four wallets, MadeOnSol's 70-record page is a **larger** under-count than the
ownership question ever was: `4q4GKBpV…` reads 70 launches from the vendor against **152** from
pump.fun's own listing, and `3FiWnNDT…` 63 against 65. That error was already known and already
disclosed as `vendorPageCapped`; it is noted here only because a reader comparing the last two
columns of the table above will see it first and should know it is not what this lane fixed.

## 4. What it costs, and why only four of twelve

Sustained keyless throughput against `api.mainnet-beta.solana.com`, measured on the day:
**0.42 requests/second**. Batching `getTransaction` is **actively harmful** — the same
transactions took 58 s at batch=1 with **zero** load-shed events, 76 s at batch=4 with 7, and
110 s at batch=8 with 11. The endpoint weights each entry of a JSON-RPC batch against its limiter.
This corrects `report.md` §9.4.

Cost is driven entirely by the fraction of a wallet's signature index that **succeeded**, because
creations always succeed and failures can be discarded without being fetched. That fraction is not
a constant:

| wallet | index rate | succeeded | full-history cost | minutes |
|---|---|---|---|---|
| `yHCxHBEa…` | 3,002/day | **1.7%** | 2,734 | 109 |
| `GeBJSHK4…` | 840/day | 5.0% | 3,263 | 131 |
| `7ufmve7Z…` | 661/day | 4.4% | 7,166 | 287 |
| `3FiWnNDT…` | 304/day | 5.5% | 656 | **26** |
| `5KTX7LZy…` | 256/day | 99.7% | 9,439 | 378 |
| `4q4GKBpV…` | 34/day | 82.7% | 173 | **7** |
| `EeLjBXRE…` | 334/day | 7.3% | 14,053 | 562 |
| `Eh3q5AXn…` | 1,061/day | 36.5% | 58,186 | 2,327 |
| `F5ExBJxM…` | whole index < 1,000 | 18.5% | 169 | **7** |
| `ELcFk5c9…` | whole index < 1,000 | 93.8% | 212 | **8** |
| `3YpQRAGD…` | 541/day | 27.2% | 126,766 | 5,071 |
| `6Wg4aeZ2…` | 1,365/day | 99.4% | 6,568 | 263 |

**All twelve over their full listing spans: ~153 hours.** The four in bold were measured; the rest
were not, and are reported as unmeasured rather than estimated. Nothing here is extrapolated from
the four to the eight.

The ceiling also has to leave budget to *classify* what the walk finds. The first attempt at
`4q4GKBpV…` spent all 900 of its requests walking, found its creations, and then had nothing left
to read their bonding-curve accounts with — every launch it had just recovered would have scored as
not-bonded. `readCreatedHistory` now stops one request per hundred creations short of its ceiling.
A correction that deflates the rate it was widening is not a correction.

`Eh3q5AXn…` and `3YpQRAGD…` are the reason a per-candidate request ceiling exists rather than a
time bound: eight launches over 858 days behind a 541/day index is 127,000 requests for eight
records, and no bound expressed in launches would have caught that in advance.

## 5. Does this need a paid provider?

**Asked 2026-08-02 and answered no; superseded 2026-08-03, when the captain bought the plan.** The
original assessment is kept verbatim below because it is the baseline the new route is measured
against, and because a decision whose predecessor is not recorded beside it becomes an invisible
assumption one release later. §7 records what the paid route actually turned out to cost and cover.

> **Not for the gate as it stands, and the decision is the captain's, not this tool's.**
>
> The keyless route is correct, validated, and bounded, and it is affordable for a wallet whose
> index is small or whose failure rate is high. It is *not* affordable for a routine twelve-candidate
> screen over full histories. An indexed provider (Helius DAS, Bitquery, Dune, Shyft) would answer
> "tokens created by wallet W" in one request instead of thousands — but every one of them is keyed,
> which is a new dependency and a standing-policy decision. **No such provider was contacted and no
> key was obtained.** It is recorded here as an option with its cost, not taken.
>
> The measured case for spending that money is currently weak: on the only wallet where the true
> answer is known, the correction is 0.42% of launches and 0.0024 of the rate, and it changes no
> verdict. The case would strengthen the moment Stage 2 scores a deployer on its *best* launch
> rather than its count, because that is precisely the launch the ownership reading loses.

**What changed is the price of coverage, not the size of the correction.** §3's measured zero still
stands and nothing in §7 revises it. What the paid route buys is that the walk now *finishes*: four
of twelve wallets were measured on the keyless route and two of those four were windows rather than
histories, because the rest were unaffordable. All twelve are now complete.

## 6. Two things easy to misread

- **`movedCreator` is not `hiddenByOwnership`.** The on-chain curve `creator` moving does not mean
  the token left the wallet's `?creator=` listing: a fee-sharing migration moves the on-chain field
  to a config PDA while pump.fun still attributes the token to the wallet. `F5ExBJxM…` has 2 of 10
  launches with a moved on-chain creator and **0** hidden from its listing. Only
  `hiddenByOwnership` measures the bias.
- **A creation window is not a history.** Only `stopReason: "index-exhausted"` means the walk saw
  the wallet's whole index. Under any other value the launches before `coveredFromIso` come from
  the ownership listing and are a lower bound, as they always were — and `coveredFromIso: null`
  with `coveredDays: 0` is the limit case of that, a walk that finished no page and so covered
  nothing, where the *whole* reading is the ownership listing. A page the endpoint never
  resolved cannot produce that value: a `null` from `getSignaturesForAddress` is load-shedding, it
  is retried once, and a page that still does not resolve stops the walk on `upstream-error`.
- **`gate-unmeasured` is not a rejection, and none of the numbers above came from one.** Three
  sources decide whether a launch bonded, in order: the on-chain curve's `complete` byte
  (`bondedFromCurve`), then the ownership listing's own flag (`bondedFromListing`), then nothing
  (`bondedUndecidable`). A launch **hidden from the ownership listing has no row by definition** —
  which is exactly the launch this whole measurement exists to find — so a failed curve read on one
  leaves it undecidable rather than scored as a failure. Any undecidable launch, or an ownership
  listing that failed to read at all, makes the candidate's whole reading unmeasured and its
  verdict `gate-unmeasured`. Do not aggregate those rows with `gate-failed` ones: the wallet was
  not judged, and treating "not judged" as "judged and rejected" would reintroduce the invisible
  false rejection this document is about, one layer up.

## 7. The indexed route — Helius, measured 2026-08-03

The captain bought a **Helius Developer** plan, so the walk in §4 is no longer the only way to
reach a create transaction. `pumpfun.mjs` → `readCreatedHistoryIndexed` replaces the
signature-scan-plus-fetch with one call: `getTransactionsForAddress`, `transactionDetails: "full"`,
`filters: { status: "succeeded" }`, `sortOrder: "asc"`, paged by `paginationToken`. The keyless
walk is untouched and still runs when no key is set.

**Plan and prices**, from Helius's own pricing and billing pages read on the day: $49/month,
**10,000,000 credits**, **50 requests/second**. `getTransactionsForAddress` in `full` mode bills
**10 credits per 100 transactions returned**, rounded up, 10 minimum; `getSignaturesForAddress`,
`getTransaction`, `getBlock` and `getMultipleAccounts` are **1 credit** each. The key is
**unshared** — this research lane's alone (captain, 2026-08-03).

### 7.1 The parsers work unchanged, and that was checked rather than assumed

`full` + `jsonParsed` returns `getTransaction`'s own envelope — `{ transaction: { signatures,
message }, meta, blockTime }`. Fetched the `maxxing` create transaction
(`64pCziaL…`) by both routes and compared every field `parseCreateTransaction` reads — block time,
`meta.err`, log count, signature, account-key count, the signer set, and the pump.fun instruction's
account list. **Identical.** So `parseCreateTransaction` and `readCurveState` are shared between the
two walks with no adapter, no fork and no wrapper.

### 7.2 Cost and coverage, all twelve elite wallets, every one walked to exhaustion

The keyless route could afford four of these twelve, and two of those four were windows. The
indexed route completed **all twelve**, in 27.7 seconds of enumeration.

| wallet | succeeded transactions | full pages | credits | keyless equivalent (§4) |
|---|---|---|---|---|
| `F5ExBJxM…` | 168 | 1 | 20 | 169 requests, 7 min |
| `ELcFk5c9…` | 211 | 1 | 30 | 212 requests, 8 min |
| `3FiWnNDT…` | 1,007 | 2 | 110 | 656 requests, 26 min |
| `3YpQRAGD…` | 1,026 | 2 | 110 | 126,766 requests, **5,071 min** |
| `4q4GKBpV…` | 2,136 | 3 | 220 | 173 requests, 7 min |
| `5KTX7LZy…` | 2,989 | 3 | 300 | 9,439 requests, 378 min |
| `EeLjBXRE…` | 3,344 | 4 | 340 | 14,053 requests, 562 min |
| `Eh3q5AXn…` | 4,749 | 5 | 480 | 58,186 requests, 2,327 min |
| `GeBJSHK4…` | 6,378 | 7 | 640 | 3,263 requests, 131 min |
| `7ufmve7Z…` | 7,791 | 9 † | 793 † | 7,166 requests, 287 min |
| `yHCxHBEa…` | 46,815 | 47 | 4,690 | 2,734 requests, 109 min |
| `6Wg4aeZ2…` | 49,367 | 50 | 4,940 | 6,568 requests, 263 min |

† **The subject deployer's row is the END-TO-END figure the production walk actually recorded**
(§7.5), and it is the only row here that is: 8 data pages at 780 credits, **plus** the further page
that returns no rows and proves exhaustion by answering `paginationToken: null` at the 10-credit
minimum, **plus** 3 `getMultipleAccounts` curve reads for its 247 creations at 1 credit each — 9
pages, 793 credits, 12 requests. The other eleven rows are the enumeration measurement's **data
pages only**, which is a standalone probe that counted neither the exhaustion-proving page nor the
curve reads, so the aggregate below is unchanged and is a data-page figure. Read a row here as a
lower bound on an end-to-end walk, never as one.

**Median 320 credits, max 4,940, 12,660 for all twelve.** All twelve on the keyless route were
~153 hours; here they are 136 pages. Note the `3YpQRAGD…` row: 860 days of history behind a heavy
index cost 5,071 minutes keyless and **110 credits** indexed. That is the shape of the change — it
is largest exactly where the keyless walk was least affordable, which is where coverage was being
lost.

The per-candidate ceiling is pinned at **5,000 credits**, just above the largest history here, so
every wallet in this population walks its whole index. `thresholds.json` → `creation_walk_helius`
owns the derivation.

### 7.3 Pacing, re-measured on this endpoint rather than carried over

A ladder against the busiest wallet — full mode at 1000/500/250/100/0 ms, 20 requests a rung, and
signatures mode at 500/200/100/50/0 ms, 30 a rung — recorded **zero shed events and zero JSON-RPC
errors at every rung, including 0 ms**. A concurrency probe of 150 simultaneous requests was
answered 200 on all 150 at an observed 161 req/s. Throughput is **latency-bound, not limit-bound**:
3.98 req/s at 100 ms against 3.89 at 0 ms in full mode, 7.54 against 7.38 in signatures mode. Pinned
at **200 ms** — a courtesy floor with an order of magnitude of headroom, not a shed-avoidance
figure. This is the opposite of `api.mainnet-beta`, where 2.5 s is *faster* in wall clock than 1.4 s
because of backoff, and that keyless finding is unchanged.

**The batching question does not carry over because it no longer arises.** §4's finding — batch=1
at 58 s with zero shed against batch=8 at 110 s with eleven — was about issuing one `getTransaction`
per transaction. The indexed route issues one request per 1,000 transactions, so there is nothing
left to batch. The keyless finding still governs the keyless walk.

### 7.4 Failure shapes, confirmed before being trusted

The keyless client's rule is *a null is a retry, never absent*. Helius does not use the same
signals, so they were measured rather than assumed:

| condition | response |
|---|---|
| invalid address | HTTP **200**, `{"error":{"code":-32602,"message":"Invalid param: Invalid Base58 string"}}` |
| `limit: 5000` | HTTP **200**, `{"error":{"code":-32603,…"You can only request up to 1000 transactions at a time"}}` |
| corrupt `paginationToken` | HTTP **200**, `{"error":{"code":-32603,"message":"Bad request: Invalid pagination token"}}` |
| unknown method | HTTP **200**, `{"error":{"code":-32601},"id":null}` |
| empty slot range | HTTP **200**, `{"data":[],"paginationToken":null}` |
| wrong or missing key | HTTP **401**, plain-text `Unauthorized` (not JSON) |

So the distinction the walk turns on is **different from the keyless one and had to be rebuilt**:
an `error` envelope is the endpoint's considered answer and arrives on a 200, so it stops the walk
on `upstream-error` and is never retried and never read as an exhausted index; an absent result is
load-shedding and is retried; and exhaustion is proved **only** by `paginationToken: null` on a page
that succeeded. An empty page carrying a token is not the end. A 401 is a credential failure, not a
measurement, and stops immediately rather than being retried three times.

`covered.fromMs === null` still means **covered nothing**, never "since the epoch". The route pages
ascending, so a truncated walk covers from genesis forwards and leaves the recent end to the
ownership listing — the opposite end from the keyless walk, and the better one to lose.

### 7.5 The whole thing reproduced against the 239-launch ground truth

The strongest available check, run with the production code rather than a probe: the indexed walk
over `7ufmve7Z…`, compared against `data/population-tape-2026-07-29/launches.csv`.

| | |
|---|---|
| wall clock | **5.7 seconds** |
| requests / credits | 12 / **793** (ceiling 5,000) |
| pages, transactions | 9 pages, 7,791 transactions |
| stop reason | `index-exhausted`, covering 2025-12-01 → 2026-08-03 |
| unresolved transactions | **0** |
| **launches in the tape found** | **239 of 239** |
| `maxxing` (`32CdQdBU…`) found | **yes** — the launch `?creator=` cannot return |
| launches found but not in the tape | 8, **all created after the tape's newest launch** (2026-07-28T20:51:02Z) |
| bonded flag vs the tape's `graduated` | **238 of 239 identical** |
| the one difference | `DGWppJtf…`, created 2026-07-16 — tape says not graduated, curve says complete, i.e. it bonded after the 2026-07-29 snapshot |
| curves read / unread | 247 / **0** |

Every difference from the committed census is the six days of activity between the tape being cut
and the check being run, and each one runs in the only direction it can. **No measured value moved
and no verdict changed.** Compare the keyless cost for this same wallet: 7,166 requests and ~287
minutes, and that is only reachable at all with the per-candidate ceiling lifted — under the pinned
100 requests it covers a window, not a history.
