# What captain decision 500a costs, and what it buys — measured on the committed tape

Captain decision **500a**, 2026-08-14: read the create slot's whole block whenever the mint is
known, so `bounds.mjs` → `costLedger`'s two create-slot rows are populated on every candidate rather
than only on the ones whose create slot happened to hold two or more of the launch's own
transactions.

The trigger the decision replaces was a strict request-count argument: one `getBlock` beats the
`getTransaction` calls it replaces only from two transactions up. That was the right argument until
captain decision **466** made the same response the ONLY source of the create-slot tip ceiling and
the create-slot failed-attempt fee ceiling. On the 2026-08-14 try-cost lane the floor left **both
rows `null` on 12 of 15 candidates** (88 of 133 scored windows observed), so 466's authorised bound
was unavailable on 80% of the population.

`measure.mjs` is the harness. `node measure.mjs [--block-unserved] [--out <path>]`. It is **offline
and keyless** — a stub `fetchImpl` handed to the production `SolanaRpcClient`, no socket, no
credential, no vendor — and it holds **no copy of any rule**: the route decision, the pricing, the
scoring and the ledger are `pumpfun.mjs`, `rpc-costs.mjs`, `entry.mjs` and `bounds.mjs` called
unchanged. It was therefore run **on both revisions of `pumpfun.mjs`** and the two readings
differenced, which is what makes the cost below a measurement of the change rather than a model of
it.

A candidate here is a window of `stage2_entry.maxLaunchesPerCandidate` (10) consecutive taped
launches, priced through `rpcCostSource` so the per-candidate route **latch** is the production one.

## The reading

23 candidates, 195 launches walked, `stage2_cost.preferBlockRoute` true, both arms.

| | pre-500a | 500a | delta |
| --- | ---: | ---: | ---: |
| RPC requests, `getBlock` **serving** | 2,959 | 2,959 | **0** |
| RPC requests, `getBlock` **shedding** | 4,220 | 4,220 | **0** |
| Launches carrying a create-slot observation | 189 | **195** | +6 |
| Candidates with BOTH create-slot rows bounded | 1 of 23 | **5 of 23** | +4 |
| Entry verdicts moved | — | **0 of 23** | — |

`result-block-serves.json` / `result-block-sheds.json` are the 500a arms;
`baseline-block-serves.json` / `baseline-block-sheds.json` are the pre-500a ones.

### Why the request delta is zero here, and what bounds it in general

On a create slot holding exactly one of the priced transactions, the `getBlock` this decision adds
**replaces the one `getTransaction` it would otherwise have cost**. That is the whole arithmetic and
it is why the serving arm moves by nothing rather than by a little.

The shedding arm is the case where the added request cannot be recovered: `getBlock` answers `null`,
every transaction is priced individually anyway, and the probe is waste. It measures **zero** too,
because `rpc-costs.mjs` → `rpcCostSource` latches the route off after one failed probe **per
candidate**, and on this tape every candidate's first walked launch already cleared the old
two-transaction floor — so the wasted probe was already being paid before 500a. The general bound
that follows is **at most one wasted request per candidate**, not per launch, and only on an
endpoint that does not serve full blocks.

### No verdict moves — demonstrated, not asserted

Every candidate is scored twice through the production `scoreEntry`: once with the observations the
walk produced and once with none. `entry.verdict` is identical on **23 of 23** candidates in every
arm and on both revisions, and `exitVerdict` reads `exit-unbounded` throughout — three of the
ledger's cost rows stay `null` under captain decision 466 regardless, so bounding the create-slot
two cannot reach a verdict. That is 466's own design (`bounds.mjs` → `UNBOUNDABLE_TODAY`) rather
than a property of this population.

## What this measurement cannot say

- **The magnitudes are vacuous.** The tape's window tape carries no landed-but-failed transaction
  and no tip transfer, so every observation reads `failedAttempts: 0` and `tipSol: 0`. This is a
  measurement of **whether a bound exists**, which is what 500a is about, and says nothing about how
  large the ceilings are on a live slot.
- **n = 1 deployer, and its create slots are dense.** Only 6 of 195 walked launches have exactly one
  create-slot cost target here, which is why the gain reads +6 rather than the 12-of-15 the stranger
  lane saw. The tape understates **both** the gain and the cost against a stranger population; it is
  the wrong population for sizing either and the right one for showing that no verdict moves.
- **The residual `null` rows are NOT 500a's.** 195 of 195 walked launches produced an observation on
  the 500a arm — the walk refuses nothing any more. The 18 candidates whose rows stay `null` are
  refused by `costLedger`'s own completeness rule, over scored launches that produced **no cost
  targets at all** and were therefore never walked. Closing that is a different decision and this
  lane did not touch it.
