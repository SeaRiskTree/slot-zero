# Creation-derived launch history — what was measured

Measured 2026-08-02. Method and code: `creation.mjs`, `pumpfun.mjs` → `readCreatedHistory`, and
README → [Which history the gate counts](./README.md#which-history-the-gate-counts).

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

**Not for the gate as it stands, and the decision is the captain's, not this tool's.**

The keyless route is correct, validated, and bounded, and it is affordable for a wallet whose
index is small or whose failure rate is high. It is *not* affordable for a routine twelve-candidate
screen over full histories. An indexed provider (Helius DAS, Bitquery, Dune, Shyft) would answer
"tokens created by wallet W" in one request instead of thousands — but every one of them is keyed,
which is a new dependency and a standing-policy decision. **No such provider was contacted and no
key was obtained.** It is recorded here as an option with its cost, not taken.

The measured case for spending that money is currently weak: on the only wallet where the true
answer is known, the correction is 0.42% of launches and 0.0024 of the rate, and it changes no
verdict. The case would strengthen the moment Stage 2 scores a deployer on its *best* launch
rather than its count, because that is precisely the launch the ownership reading loses.

## 6. Two things easy to misread

- **`movedCreator` is not `hiddenByOwnership`.** The on-chain curve `creator` moving does not mean
  the token left the wallet's `?creator=` listing: a fee-sharing migration moves the on-chain field
  to a config PDA while pump.fun still attributes the token to the wallet. `F5ExBJxM…` has 2 of 10
  launches with a moved on-chain creator and **0** hidden from its listing. Only
  `hiddenByOwnership` measures the bias.
- **A creation window is not a history.** Only `stopReason: "index-exhausted"` means the walk saw
  the wallet's whole index. Under any other value the launches before `coveredFromIso` come from
  the ownership listing and are a lower bound, as they always were.
