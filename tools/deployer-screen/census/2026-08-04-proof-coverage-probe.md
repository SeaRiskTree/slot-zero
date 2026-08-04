# Proof-coverage probe — can a STRANGER's create slot be made provable? Measured 2026-08-04

**Captain decision 203a.** The 2026-08-04 full-day default screen run record — produced by a
separate lane and **not committed in this repo** — returned
`entry-unmeasured` on all three scored candidates, and **18 of the 22 windows that walked cleanly
were refused by `measure.mjs` → `roomIsProven`** against 8 walk drops over 30 planned. 198b's
near-bar guard fired zero times. The decision read that as *the screen is missing the evidence that
would let a stranger's window be proven*, and sent this lane to go and get it.

**IT WENT AND GOT IT. THE EVIDENCE DOES NOT EXIST TO BE GOT, AND THE PREMISE IS WHAT THE
MEASUREMENT DISCONFIRMS.** Two candidate sources were tested to exhaustion — one the repo already
reaches, one a keyless third-party API it does not. Both add **zero marks**, on the committed tape
and on the stranger windows alike. The reason is not that the create slots are evidence-poor: it is
that they are **participant-poor**. On 15 of the 18 refused windows, walked and inspected one by one,
the create slot holds between **one and ten** pump.fun buy transactions, and on the six that were
priced the whole non-deployer stake is **0.067 SOL or nothing** against a dev buy of ~85 SOL.

Nothing here changes a threshold, a predicate or a verdict. **No rule was widened and none was
relaxed** — captain decision 203 declined 203c (lower the sample-size floor) and 203d (report a bound
on unproven windows), and this record proposes neither. It is a measurement, and the pinning decision
it points at is the captain's.

## What `roomIsProven` requires, exactly

`measure.mjs` → `roomIsProven(m)` is `m.coordinatedWallets >= 1`. Its only input is
`createSlotGroups`, whose only input is the launch's own pump.fun fills, and which marks a
non-deployer wallet under the union of two structural tests (captain decision 182a):

- **(a) shared transaction** — a create-slot transaction carrying 2+ distinct swapping wallets;
- **(b) deployer-anchored adjacency** — a create-slot transaction whose block index reaches the
  deployer's own by a contiguous run at step exactly 1.

**The concrete missing input on a stranger window, named precisely:** nothing in the fill tape says
two *separate, non-adjacent* create-slot transactions were one submission. `Fill` carries `wallet`,
`tx` and `sid`; `sid` yields the true block index, so (b)'s adjacency is a fact rather than a proxy.
What no fill carries is the **submission** a transaction belonged to. That is the whole gap, and the
two things that could close it are below.

## Why our own subject proves and these strangers do not

Not evidence, and not the rule. **Occupancy.** Our subject's create slot carries 13–58 pump.fun buy
transactions with its cohort's two multi-wallet buys sitting inside or immediately after its own
submission; 235 of 235 covered launches are proven. The stranger windows that fail carry 1–10, with
the deployer's own transaction alone at its index and the rest of the field — where there is one —
tens to hundreds of block indices away.

## Source 1 — shared fee payer. Already reachable. ZERO new marks.

The screen's cost leg already reads whole create-slot blocks (`pumpfun.mjs` → `readCreateSlotCosts`)
and already parses `accountKeys[0]` into `TransactionCosts.feePayer`, so this needs no new host. The
rule tested: **a fee payer paying for two or more create-slot transactions that between them carry
two or more distinct wallets marks all of them.** Independent traders do not have a third party pay
their fees.

Measured offline over `data/population-tape-2026-07-29/onchain_create_slot_pnl.csv` — 4,878 rows,
4,394 create-slot transactions, 123 launches, every one of which carries exactly one identified fee
payer among its own trading wallets:

| reading | value |
|---|---|
| launches half (a) proves | 120 of 123 |
| launches half (a) does **not** prove that shared-payer would | **0** |
| wallet-instances shared-payer marks that half (a) does not | **0** |

It is **fully subsumed**: on this tape every shared-payer group is either one wallet's several
transactions or a multi-wallet transaction half (a) already marks. The rule is not weak here, it is
redundant.

**Incidental finding, recorded because it qualifies a load-bearing claim.** Half (a) itself makes
**11 non-cohort marks over 3 launches** in this file (`HmDbKdd7…` 2026-05-21, `H6e9XnLJ…` 2026-05-20,
`BweRjKus…` 2026-05-18) — including both wallets `src/cohort.ts` names as settled *unaffiliated*
outsiders. Every one runs through `62dTXVyx…`, a wallet that shares create-slot transactions with
cohort members and with those outsiders alike; the inference, stated as one, is a shared bundling
service rather than a member of either side. All three launches fall in **era 1** (2026-05-01 …
06-03), so `measure.mjs`'s scoped claim — `nonCohortMarkedCoord = 0` on every **era-2** launch — is
untouched. What is qualified is the unscoped sentence beside it: two independent traders **can**
share a transaction when a third party bundles them, so half (a)'s opposite error is *rare and
era-dependent*, not structurally impossible. That direction (marking an outsider as the operation)
lowers `roomLeft` and biases towards refusal, so it is the safe half — but it is not zero.

## Source 2 — Jito bundle membership. A new keyless host. ZERO marks outside the union.

`bundles.jito.wtf/api/v1/bundles/transaction/{signature}` returns the bundle id a landed transaction
belonged to, and `…/bundles/bundle/{bundleId}` returns that bundle's ordered `txSignatures`. Keyless,
no account, no quota. **This is the strongest evidence available anywhere for the question half (b)
answers by inference** — it replaces "adjacent, therefore probably one submission" with the
submission itself.

The rule tested, deliberately shaped exactly like half (b) so it inherits the same safety argument:
**anchor on the deployer's own create-slot buy transaction, look up its bundle, and mark every other
create-slot buy transaction in that bundle.** Deployer-anchored, create-slot-scoped, union-only, so
`operationShare` can only rise and `roomLeft` can only fall — the direction decision 134a requires.

### Over the committed tape — all 235 covered launches

| reading | value |
|---|---|
| launches where the deployer's anchor is in a bundle | 150 of 235 |
| launches this rule proves on its own | 150 |
| cohort wallet-instances marked | **779** |
| **non-cohort wallet-instances marked** | **0** |
| launches where it marks anything the shipped union does **not** | **0** |
| launches it proves that half (a) alone does not | 21 |
| launches half (a) proves that it does not | 46 |
| launches neither it nor half (a) proves (half (b) alone carries them) | 39 |
| requests | 366 for 235 launches, ~1.6 each |
| shed | **0**, at 1.2 s pacing |

Coverage reaches the tape's oldest launch (create slot 383,821,204, December 2025) — the months in
which half (a) recovers nothing at all, and where this rule marks 3 cohort wallets a launch.

So it is **precise** (0 false marks in 779) and **complementary to (a) in the same place (b) is** —
and it is nonetheless a **strict subset of the shipped union**: 779 marked instances against the
union's 1,142, and not one launch where it sees a wallet the union misses. **On the evidence this
repository holds, it would change no number.**

### Over the stranger windows the full-day run refused

Two of the three scored candidates were re-walked keylessly at the pinned `stage2_entry` parameters,
off the ownership listing, and every unproven create slot was inspected transaction by transaction.

**`yHCxHB…` — 10 of 10 windows walked, 4 proven, 6 refused.** The six refused windows:

| create-slot buy transactions | 1 | 1 | 1 | 2 | 2 | 2 |
|---|---|---|---|---|---|---|
| `roomLeft` | 0.0000 | 0.0000 | 0.0000 | 0.0008 | 0.0008 | 0.0008 |
| dev buy, SOL | 85.01 | 85.01 | 85.01 | 84.94 | 84.94 | 84.94 |
| non-deployer stake, SOL | 0 | 0 | 0 | 0.067 | 0.067 | 0.067 |
| distinct non-deployer wallets | 0 | 0 | 0 | 1 | 1 | 1 |

The deployer's own transaction **is** in a Jito bundle on 3 of the 6, and on none of them does that
bundle contain a second create-slot buy — the other members are the launch's own non-fill
transactions. **Marks: 0 of 6.** On the four proven windows the same rule marks 8–9 wallets each,
every one already inside the union.

**`BXAWg4Jb…` — 10 planned, 1 dropped at the request cap, 9 of 9 refused**, reproducing the run
record's `bundledTx` max 0 / `runTx` max 1 / `adjacencyMarks` max 0 exactly. These create slots are
**not** empty — one holds 10 buy transactions at block indices 494 (the deployer's) and 964, 965,
970, 973, 977, 991, 1259, 1274, 1365 — so this is the case where a blind spot would genuinely matter.
**The deployer's own create-slot transaction is in no Jito bundle on 9 of 9.** It does not submit
through Jito, so there is no bundle for a cohort to ride. **Marks: 0 of 9.**

**`2N7qg9a3…`** was not re-walked; its committed row already reads `bundledTx` max 0 and `runTx`
max 1 across all 3 usable windows, the same shape.

**Total: 0 of 18 refused windows converted.**

## What is left, and why neither is available here

- **A funding-graph link** between a create-slot wallet and the deployer. It is an entity-clustering
  method rather than a create-slot structural rule, its ceiling is the permanent one `README.md`
  states for shared custodial venues, and it costs a signature walk per wallet — thousands of RPC
  requests per candidate against a Stage 2 cost ceiling of 500. Out of budget by two orders of
  magnitude.
- **A recurrence rule** marking a wallet that appears in k of the candidate's trailing create slots.
  Already measured and **refused**: at k = 8 it missed 112 cohort instances and falsely marked 4
  outsiders, and it is contaminated by general-purpose snipers who appear across unrelated deployers
  (`slot-zero-bundling-predicate-question` §6, held in firstmate's records, not in this repo).
  `measure.mjs` → `roomIsProven` names it as not-to-be-re-proposed.

## What this leaves for the captain

The refusals are **correct** on the evidence: `coordinatedWallets = 0` on these windows is a true
statement about the create slot, not a blind spot in the rule. What is left is a question about the
*consequence* of refusing them, and it is the captain's because every answer to it has the shape of
203d, which was declined:

On the six `yHCxHB…` windows the measured `roomLeft` is 0.0000–0.0008 — **no room**, the strongest
possible not-enterable reading — and the co-ordination rule's blind spot can only push a room figure
**down**, never up. So refusing them removes six near-zero readings from the sample and computes the
median over the four surviving windows at 0.153–0.372. **The refusal moves the room reading up,
toward enterable**, on exactly the launches whose measured value is furthest from the bar. That is
the direction decision 134a exists to prevent, arriving by the opposite route.

`slot-zero-guard-unproven-upper-bound` (filed, held in firstmate's records, not in this repo) already
holds this question — it asks whether a proven-refused launch's measured `roomLeft`, being a strict
upper bound, should be padded to the worst case. **This lane does not answer it and must not**: any
answer changes what `roomIsProven` refuses, and that is 203d.

## Method, cost and provenance

Both probes were one-off scripts run outside the tree; neither is committed, and no tool in this
repository reaches `bundles.jito.wtf`. The stranger walks used `pumpfun.mjs` → `readCreatorHistory`
and `readLaunchWindow` unchanged at the pinned `stage2_entry` parameters. Spend: **0 keyed requests,
0 vendor credits, 0 Dune executions**; 130 keyless `swap-api`/`frontend-api-v3` requests with 0 shed,
and 392 `bundles.jito.wtf` requests with 0 shed. **Derive and discard applies**: no bundle id, no
transaction signature and no per-token row is persisted here — only the aggregates above.
