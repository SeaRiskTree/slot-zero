# The oversized split — reading the largest census deployers instead of refusing them

**Captain decision 196a, 2026-08-04.** Record:
`slot-zero-census-wallet-gate-validation` → `decision-196a-oversized-split.md` (held in firstmate's
records, not in this repo). It answers that study's finding 2 and its §8 item 1.

Measured live on the census population. Evidence: `runs/2026-08-04-oversized-split.json`. The code
is `tools/deployer-screen/dune.mjs` → `planOversizedSplit` and `enumerateCreations`.

---

## The headline

**Every one of the nine cap-refused wallets in a 40-wallet census batch came back whole, and the
cap-refusal rate on that batch went 9/40 = 22.5% → 0/40 = 0.0%.** The overall refusal rate went
**12/40 = 30.0% → 5/40 = 12.5%**.

**The remaining 5 are a different cause and this change does not touch it.** Every one of them —
including two the split had just enumerated whole — is refused because its newest launch post-dates
the cached coverage probe's own last row. That is the study's second refusal class (311 of 3,036
census deployers, 10.2%), and it is `toWalletEnumeration`'s per-wallet freshness rule doing exactly
what it is for. **The blackout is not closed; the larger half of it is.**

It cost **3 extra Dune executions and ~43 estimated export credits** on this batch, against a whole
run of 4 executions / 24 requests / 3,102,261 result bytes / **~62.0 estimated export credits**
(~2.5% of the 2,500-credit monthly free tier).

---

## Why a split and not a bigger cap

`CREATION_SQL` returns at most `max(500, floor(19999 / <deployers in the batch>))` rows per deployer,
and a wallet whose true history exceeds that comes back as a prefix, is detected exactly against its
own `launches_total`, and is refused. On the 2026-07 census that refuses **604 of 3,036 deployers
(19.9%)**, and the refusal is **biased towards the largest histories** — the wallets most worth
finding.

Raising `LAUNCH_CAP_FLOOR` moves the boundary and keeps the bias, one notch further out. The split
removes it at its cause: the cap is a function of BATCH SIZE, so the same committed SQL hands a
seven-wallet batch 2,857 rows per deployer and a one-wallet batch 19,999. **No SQL changed, so saved
query `8204672` is untouched** and the deploy step this repository warns about is not part of this
change.

**The sizes are free.** `launches_total` travels beside every row, so the first execution already
said exactly how big each truncated wallet is. Planning the follow-up executions is arithmetic over
numbers already paid for, not a discovery step — and the measurement below shows the arithmetic is
exact, not approximate: every follow-up execution returned precisely the rows its plan expected.

---

## What was measured, and how

**Sample.** The published study's stratum-A draw, reproduced verbatim: rank the 3,031 deployers of
`runs/2026-07-cohort.json` that are absent from `tools/deployer-screen/feed/ledger.json` by
`sha256("slot-zero-census-wallet-gate-validation:" || wallet)` ascending as hex, take the first 40.
It reproduces the published draw exactly (min 30 / p25 43 / p50 93 / p75 147 / p90 346 / max 685 July
creations), so the before/after is against a figure someone else already published.

**40 is a bound, not a preference.** At 40 wallets the per-deployer cap is exactly **500** — the same
cap a full 195-candidate production run applies. A smaller batch gets a *more generous* cap and would
understate the refusal rate, which is the quantity being measured.

**One invocation, not two.** `enumerateCreations({ splitOversized: true })` was called once. The
"before" is recovered exactly rather than re-measured: the split's eligible set **is** the set the
first execution's cap truncated, and it changes no other wallet, so
`refused before = refused after + recovered`. Re-running the first execution to observe a number
already implied would have bought nothing and cost ~19 credits.

---

## The result

| | before | after |
|---|---|---|
| wallets refused | **12 / 40 = 30.0%** | **5 / 40 = 12.5%** |
| …refused by the per-deployer cap | **9** | **0** |
| …refused because their newest launch post-dates the probe | 3 | 5 |

All nine cap-truncated wallets returned **exactly** their declared history:

| declared launches | rows returned | bonded | still refused? |
|---|---|---|---|
| 6,694 | 6,694 | 98 | no |
| 5,979 | 5,979 | 61 | no |
| 2,618 | 2,618 | 44 | **yes — probe freshness** |
| 1,178 | 1,178 | 12 | no |
| 1,126 | 1,126 | 16 | no |
| 899 | 899 | 16 | **yes — probe freshness** |
| 717 | 717 | 0 | no |
| 692 | 692 | 0 | no |
| 653 | 653 | 37 | no |

Three cross-checks that make those numbers believable:

- **Row accounting closes exactly.** The first execution returned 8,986 rows, which is the sum over
  the 40 wallets of `min(launches_total, 500)` to the row.
- **The plan predicted every follow-up execution's size to the row** — 6,694 / 5,979 / 7,883 planned,
  6,694 / 5,979 / 7,883 returned.
- **The first execution's apportioned bytes are 943,637 against the 944,347 the published study
  measured for this same batch**, 0.08% apart.

---

## What it cost, and what it will cost

| | |
|---|---|
| executions | **4** (1 enumeration + 3 follow-ups), ceiling 5 |
| requests | **24**, ceiling 100 |
| result bytes | **3,102,261** at a measured **105.0 bytes/row** over 29,542 rows |
| estimated export credits | **~62.0** total; **~43.2 of it is the split** (20,556 of the 29,542 rows) |
| structural worst case | 19,999 + 3 × 8,000 rows at the pinned ≤121 bytes/row ceiling = **~107 credits**, and no run of this shape can exceed it |

Nothing was swept and nothing was issued before a dry run printed the sample, every ceiling and the
worst case. Credits are the vendor's estimate at ~20/MB of results; only `POST /usage` is
authoritative, and **nothing here tracks the month** — the tool is stateless between runs, so the
monthly arithmetic stays the operator's.

**The ongoing cost is a real one and it scales with how oversized the batch is, not with its size.**
Two bounds decide how many follow-up executions a run issues, and both are the vendor's rather than
this lane's:

1. **The cap must clear the group's largest wallet**, so a 6,694-launch wallet forces a batch of at
   most 2 and in practice runs alone. **Oversized wallets are packed largest-first**: the refusal
   being fixed is biased towards the largest histories, so a budget that binds must bind on the
   *smallest* oversized wallets rather than reinstate the bias it just removed.
2. **The rows must stay inside what the result reader accepts.** This run pinned **8,000 rows per
   follow-up execution** rather than the reader's own 19,999. `/results` pages on RESPONSE SIZE
   independently of our `?limit=`, and a paged read is refused whole — a billed execution for no
   answer. The largest single-page read this repository has measured is 944,347 bytes, about 8,200
   rows at the measured 105 bytes/row, so 8,000 keeps every follow-up read inside measured territory.
   It cost one extra execution against a 19,999 packing and bought the run's answer against the risk
   of losing one. **A larger value is untested rather than known-bad.**

---

## What is still refused, and why — read this before quoting the after figure

**The split removes one refusal class and cannot remove any other.**

- **Probe freshness — 5 of 40 here, 311 of 3,036 census-wide (10.2%).** A wallet whose newest
  enumerated launch is newer than the probed surfaces' own last row is refused per wallet, because
  the probe cannot vouch for a period it does not reach. Two of these five are wallets the split had
  just enumerated whole: it turned them from *a truncated prefix* into *a whole history refused for a
  different reason*, which is a strictly better failure but is not an answer. **This class is a
  tunable, not a limit** — `thresholds.json` → `dune.refreshProbeByDefault` is `false`, so the probe
  read here was cached at 01:41 UTC while the enumerations ran at 07:11. Refreshing it in the same
  run costs one execution and would remove most of it. That is a different lane's file and a
  different decision.
- **The freshness class GREW while this was measured, and that is the point of it.** The published
  study read 1 of these 40 wallets as freshness-refused; this run reads 3, on the same 40 wallets,
  because the cached probe aged while they kept creating. A discovery lane is by construction about
  wallets creating right now, so this class is not rare there.
- **A wallet bigger than one whole execution is not seatable at any batch size.** Above 19,999
  launches — the largest result the reader accepts — no batch size helps and the creation walk is the
  only route. None appeared in this sample; the census's own top wallet created 12,555 mints in July
  alone, so the case is reachable and is named rather than left to be discovered.
- **A run whose execution budget binds leaves the smallest oversized wallets refused**, each with its
  own sentence, counted in `oversizedSplit.unplaced`. Zero here.
- **Everything the published study's other findings say still stands.** The split says nothing about
  whether a census-derived competence reading may gate discovery (its §7 owns that), nothing about
  the vendor's empty-profile directory, and nothing about the estimand gap between a lifetime rate
  and a trailing one.

---

## What this change does NOT do

**It is opt-in, and `screen.mjs` does not yet pass the flag.** `thresholds.json` →
`dune.maxExecutionsPerRun` is 2, and its pinned justification reads *"one execution for the
enumeration, and at most one more to re-execute the coverage probe … nothing else in a run may
execute"*. A default that quietly spent that reserve would contradict a pinned reason rather than
change it. Wiring the screen up is one flag, one threshold and one justification — all in files this
lane does not own — and it is that lane's change, not a hidden consequence of this one.

Nor does the split reach the run record yet: `screen.mjs` builds the record's `dune` block from a
fixed key list, so `oversizedSplit` is on the enumeration and not in `runs/*.json`. Surfacing it is a
schema bump and belongs with the same wiring.

---

## Reproducing it

The measurement harness is disposable (the same convention the published study used: scripts are
scratch, the figures are the durable record). What is durable is here:

- `runs/2026-08-04-oversized-split.json` — sample, bounds, per-wallet before/after, per-group
  executions, spend.
- `tools/deployer-screen/dune.mjs` → `planOversizedSplit`, which is pure and is unit-tested offline
  in `test/dune-oversized-split.test.ts`, including that the packing it produces can never be
  truncated by the cap it plans against.

To re-measure, call `enumerateCreations` with `splitOversized: true` and
`bounds.maxOversizedExecutions` / `bounds.maxOversizedRowsPerExecution` set, over a 40-wallet draw
from the committed cohort file. It needs a Dune key in the environment and **it spends** — dry-run
the sample and the ceilings first.
