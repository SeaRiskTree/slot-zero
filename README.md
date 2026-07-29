# slot-zero

A research lab for **pump.fun launch microstructure**: what happens in the first seconds of
a token launch, who profits, and whether any of it is capturable.

This repo is the foundation, and only the foundation. It holds one primary dataset, a typed
loader over it, and a test that reproduces the published numbers. **There is no strategy,
backtest, signal or trading logic here.** The question that used to gate that work — whether
the two winning outsiders were the operator's own book — has been answered; what is still
gated, and what no longer is, is stated at the bottom of this file.

Nothing in this repo reaches the network. Nothing reads a credential. Every source behind
the dataset is keyless and public, and the whole thing was built with **zero metered
provider requests**.

```bash
npm ci
npm test        # tsc --noEmit, then vitest run
```

Private. Nothing here is production.

---

## What is here

| | |
|---|---|
| `data/population-tape-2026-07-29/` | The population tape. 239 launches, 107,439 fills, 20,388 counterparty wallets, reconstructed keyless. Column semantics in its `README.md`, findings in its `report.md`, import and correction decisions in its `IMPORT.md`. |
| `src/` | The loader. Per-launch, per-wallet and per-(wallet, launch) views, plus the raw per-fill tape. No runtime dependencies. |
| `test/reproduction.test.ts` | The published headline numbers, asserted against the loaded data. |
| `test/type-guards.test-d.ts` | Compile-time proof that the three traps below are unreachable — and that `EgQX9R3Q…`'s figures cannot be read as an independent observation. |
| `AGENTS.md` | Provider facts that cost real time to learn. Read before touching pump.fun or Solana RPC. |

### The three traps the loader makes unreachable

Each of these silently corrupted an analysis during the research. Each is now a compile
error, not a convention.

1. **Tape-derived P&L is gross of fees.** `GrossSol` and `NetSol` are mutually unassignable
   brands; every tape field is named `…GrossOfFees`. Only `onchain_*.csv` is fee-inclusive.
   The canonical case: `2CQgjcdN…` reads **+31.2 SOL on the tape and −12.2 SOL in reality**
   after 11.9 SOL of priority fees. A backtest on swap quotes alone would have hired it.
2. **Only `closed_in_window` rows have a complete P&L** — 22,333 of 46,553 pairs (48%).
   `ClosedPair` has `realisedSolGrossOfFees`; `OpenPair` does not have the field at all.
   Summing the open half fabricates a loss of over 5,000 SOL that nobody took.
3. **`dev_exit_complete = 0`** marks the seven launches whose deployer figures are
   window-truncated. `DevExitTruncated` exposes no complete net figure — only a
   `windowTruncated…` field and a pointer to the file that has the real number.

```ts
import { Tape, medianGross, medianNet, fractionPositive } from 'slot-zero';

const tape = Tape.load();
const slot0 = tape.closedRoundTrips().filter((p) => p.slotsAfterCreate === 0);

medianGross(slot0.map((p) => p.realisedSolGrossOfFees));       // +0.283 SOL — gross of fees
fractionPositive(slot0.map((p) => p.realisedSolGrossOfFees));  // 0.72

// The same population priced exactly, with every fee netted:
const trips = tape.onchainRoundTrips().filter((t) => !t.isCohort);
medianNet(trips.map((t) => t.netSol));                         // +0.035 SOL — the real number
```

---

## What is established

Every claim below traces to a file and column in the imported data, and every one is
asserted in `test/reproduction.test.ts` — **except where a claim is explicitly attributed to
a companion report**, which this repo does not hold and cannot assert against. Those carry
the report's name and section inline; they are evidence from elsewhere, not reproductions.

- **The edge is in the create slot and essentially nowhere else.** Closed round trips
  entering in the same slot as the create transaction: **1,999 pairs, median +0.283 SOL,
  72% profitable**. Slot 1 is +0.011. Slots 2, 3 and 4 are at or below zero. Everything past
  that is within half a hundredth of a SOL of zero.
  *(`wallet_launch_pnl.csv`, closed rows, grouped by `first_slot` − create slot.)*
- **Six wallets are inside the launch, not competing for it.** `2CHrnc2L…` is in the create
  slot of **235 of 235** reconstructed launches over eight months, fills at 1.08× the
  deployer's own price where outsiders pay 2–3×, pays 0.0009 SOL of fees to get there, and
  appears in **zero of 70 other deployers' launches**. Fee-inclusive, the cohort's median
  create-slot round trip is **+0.838 SOL**; the non-cohort median is **+0.035 SOL**.
  *(`counterparties.csv`; `onchain_create_slot_pnl.csv` for the fee-inclusive figures.)*
  That the six are *part of the operation* was an inference when the source report was
  written; the funding graph has since turned it into an artefact. **The discriminator is the
  operator's own tooling, host and handle on the cohort's own launches:** `2CHrnc2L…` is
  listed by pump.fun as the current creator of **36 coins, every one on the operator's own
  metadata host `meta.uxento.io`, one citing `genyrational` — the deployer's own promo
  handle**; and `43x1zWzj…` and `5P8A9bG…` have a genesis byte-identical to the deployer's —
  the same 3.500000000 SOL from a custodial hot wallet in the same instruction envelope, then
  a pump.fun create-and-buy crediting the identical 3.0014616 SOL through the same tool fee
  accounts, minutes later. **Common ownership is still not formally established:** `?creator=`
  lists by *current* creator, so the 36 may mean "launched it" or "was given it", and nothing
  on-chain proves ownership. *(`kol-cohort-vs-outsider-funding/report.md` §2.1, §6.3.)*
- **The outsider edge is real, thin, and bought.** `5brv79eF…` keeps **+47.8 SOL of +100.9
  gross** over 49 exactly-priced launches — it pays away over half in priority fees, and is
  still the best unaffiliated result in 20,388 wallets. Its outsider status is settled, not
  presumed — and bounded by the on-chain ceiling in "The ceiling of the method" below.
- **Graduation is a curve constant.** 14.70× the initial price, from the curve parameters
  alone — confirmed here empirically on **18 launches whose raw tape window spans the switch
  to the graduated pool**, across dev buys from 3.46 to 56.30 SOL. At the current
  14.8148-SOL preset that is 6.59× the deployer's entry, and the median launch never gets
  there (median lifetime ATH 5.08×). The deployer finishes selling at ~35% of graduation.
- **Somebody is already running the fast-reacting-bot strategy, and it is the largest loser
  in the dataset.** `C989QoG3…` and `4o9ndxqo…`: 51 and 52 launches, entering a median one
  second after the mint at ~3× the deployer's price, holding ~42 seconds. **−106.8 and
  −100.0 SOL**, profitable on 2% and 4%.
- **The deployer takes 4,315 SOL over 228 complete exits** (median +21.66 per launch, gross
  of fees), and is out at a median +13 seconds — long before graduation, every time.

---

## The ceiling of the method: shared custodial venues

Every "unaffiliated" verdict this repo carries is an **on-chain** verdict, and on-chain
evidence has one blind spot that no further on-chain work removes. It is recorded here once,
as a stated limit of the method: `src/cohort.ts` and "What is open" below refer here rather
than restating it.

**The limit.** *If the deployer and an outsider both hold accounts at the same custodial
venue, on-chain evidence cannot see the relationship.* Named first by
`kol-cohort-vs-outsider-funding/report.md` §8.2 — "**Custodial walls are walls.**"

**Here it is not hypothetical; it is measured.** The `9BhkaAyb…` book and the operation
demonstrably hold accounts at the same venue (`slot-zero-bankroll-book-pnl/report.md` §5.2,
§5.3, the source for every figure in this section):

- Across the **complete nine-month life** of the book's bankroll — **all 4,806 transactions,
  before any materiality filter** — **zero** name the deployer or any of the six cohort
  wallets in any capacity. That is one of the two complete sets the negative rests on — the
  other is the operation's own; `EgQX9R3Q…`'s own index is not one of them. See "Which side
  each negative is complete on" below, which owns that accounting.
- Four transactions touch the operation's *custodial endpoints* rather than its wallets, and
  exactly one of them is above one lamport: on **2026-05-12** the bankroll received
  **149.999 SOL** from `5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9`, a wallet holding
  ~1.1 million SOL that the deployer also deposits its profits into.
- **That transaction is not evidence of common ownership.** It pays **eight** recipients
  irregular, user-shaped amounts (0.711940000, 0.291915860, 10.071917000 …) in a single batch
  signed with a **durable nonce** — an exchange withdrawal processor serving unrelated
  parties, with seven strangers in the same transaction as the bankroll.
- The other three contacts are **1-lamport address-poisoning spam signed by strangers**, each
  naming both the bankroll and a large custodial wallet. Recorded so a later reader does not
  rediscover them as signal: they are not.

**The verdicts stand, and this does not widen them.** The book is unaffiliated with the
operation, and so is `5brv79eF…`. What the shared venue adds is the exact reading of the word:
"unaffiliated" here means *no on-chain relationship, tested on complete sets* — not *provably
unrelated*. Those are different claims and no on-chain measurement closes the gap.

**It will not be tested.** Naming the venue and asking it would take off-chain enquiry. That
option was put and **declined** (captain decision 114a, 2026-07-29). So this is a settled
boundary of the method, not an open question and not a TODO: the ceiling is permanent, and
every unaffiliated verdict this lab produces is to be read as carrying it.

---

## What is open

Stated honestly, because the temptation is to read the section above as a green light.

### The one that gated everything — answered

**Both wallets are genuine outsiders. The positive case survives. Confidence: high for
both.** The funding graph this section used to say nobody had built has been built —
`kol-cohort-vs-outsider-funding/report.md`, read-only and keyless, zero metered provider
requests.

Neither `5brv79eF…`'s nor `EgQX9R3Q…`'s money touches the deployer or any of the six cohort
wallets, on complete signature sets for the deployer and all six (§4.2's matrix; §4.5 fetched
and classified 1,504 of the 1,558 non-dust candidates one at a time and found no link, using a
method shown twice to surface real links when they exist, §4.4). Each traces to a distinct,
independently characterised funding channel the operation never uses, and neither shares a
funder or a destination with it (§5).

**Which side each negative is complete on**, because that is what the test rests on and §8.2
states it plainly. Neither outsider's *own* index was exhaustively enumerated — `5brv79eF…`'s
runs to 347,230 transactions (§4.1) and `EgQX9R3Q…`'s to ~1,000,000, which the funding report
attempted and abandoned (§10.2, §9.1). The completeness is on the **operation's** side:
complete signature sets for the deployer and all six cohort wallets, so any transaction
between the operation and either outsider is necessarily inside them. That is sufficient for an
intersection test, which needs one complete side, not two. For `EgQX9R3Q…` a second complete set backs it up — the
`9BhkaAyb…` bankroll that funds it and receives its sweeps, all 4,806 transactions of its
nine-month life, zero contact ("The ceiling of the method" above). One set is genuinely
truncated and is not used as evidence anywhere: `2CQgjcdN…`'s, at 2026-07-22 (§8.2). And
**both negatives carry the shared-custodial-venue ceiling** recorded above; neither is a claim
that the parties are provably unrelated.

`5brv79eF…` in particular is exactly what it appeared to be: an unaffiliated, still-running,
bridge-funded sniper that has taken money out of this operator's launches for four months and
withdraws to a service the operator never touches (§3.1, §6.2). **It carries no further
caveat from this evidence** beyond the ceiling every on-chain verdict here carries.

**What this does not say.** Nothing above establishes that the strategy works, or that either
wallet's edge is repeatable by a new entrant. The funding report answers whose money it is
and says so itself (its §7 "Explicitly not claimed", §10). Every limit in "The rest" below
survives it untouched.

### What replaces it: `EgQX9R3Q…` is one wallet of a book, and this dataset cannot measure the book

`EgQX9R3Q…` is **not an individual trader**. It is one wallet of a sniping book of at least
five run out of a single bankroll (`9BhkaAyb…`) — and `2CQgjcdN…`, this dataset's own
headline fee-blindness loser at **−12.2 SOL**, is in the same book (§8.1). Its **+47.1 SOL and
that wallet's −12.2 SOL are the same operator's P&L.** `report.md` §4.2 lists them as two
independent rows and §5.5 prices them as two independent wallets; they are one trader listed
twice.

Measured on this dataset, on the 123 launches priced exactly on-chain: that operator's two
rows together are **+34.9 SOL over 60 launches, not +47.1 over 10** — and even that is only
the part of the book that touches this deployer. The other three known book-mates never trade
this operator at all, and on this operator's launches the two that do **never once appear
together** (48 launches and 62, zero shared), so no counterparty table built from this tape
could ever have shown it.

Once you know the two are one operator, the tape shows the handover: `EgQX9R3Q…`'s last
launch here is **2026-05-25** and `2CQgjcdN…`'s first is **33 hours later**. One wallet stops
and the next starts — which is why they never share a launch, and why "`EgQX9R3Q…` ran
March–May and stopped" was always a statement about this deployer's launches rather than
about the wallet. *(`launches.csv` `created_utc` joined to `wallet_launch_pnl.csv`;
`onchain_create_slot_pnl.csv` for the P&L. All of it asserted in
`test/reproduction.test.ts` → "the outsider question, settled". Reading the adjacency as a
deliberate rotation is inference; the dates are measured.)*

**Any strategy claim resting on `EgQX9R3Q…` must be evaluated at the book level, and this repo
holds no such measurement.** The book has since been measured by
`slot-zero-bankroll-book-pnl/report.md`, but importing its figures is another lane's scope; until
they land here, treat that wallet's figures as one leg of a total this repo does not hold.

The loader encodes this rather than documenting it: `src/cohort.ts` → `SETTLED_OUTSIDERS` is
a union in which only `IndependentOutsider` has a `wallet`, so filtering a P&L table by
`EgQX9R3Q…`'s address is a compile error until you have read the name it is stored under and
the book beside it.

**On the sentence that used to be here.** *"Do not build a strategy on this dataset until
that question is answered"* is retired, because its stated condition is met. What survives of
it is narrower and specific: any lane starting from `EgQX9R3Q…` is gated on the book
measurement, which exists in `slot-zero-bankroll-book-pnl/report.md` but is not imported here;
`5brv79eF…` is an existence proof and not a base rate — one wallet out of
20,388, on an operator selected for being unusual; and the limits in "The rest" below still
bind. That is a smaller hold than a blanket one, and it is the one the evidence supports.

### The rest

- **Every P&L here is bounded by a 60-second window** (300 s on 21 launches, 120 s on 4).
  48% of pairs close inside it; the other 52% are late, small and still holding, and their
  outcome is unknown. A whole-life tape is the same endpoint with no window bound — roughly
  4× the harvest cost — and it is what a hold-longer strategy would need.
- **The launch universe is a lower bound, not the population.** `?creator=` lists by
  *current* creator, and creator records move. The one launch we know was missing was this
  operation's best result by two orders of magnitude. Any other launch whose creator record
  has moved is invisible to the same enumeration.
- **This wallet was selected for being unusual**, so "this operator is unusual" is worth less
  than it looks. The 70-launch control removes exactly one objection — that create-slot
  bundles are generic pump.fun mechanics — and no more. The +0.035 SOL outsider edge is
  measured on this operator's unusually well-attended launches only.
- **Something changed in June 2026 and it was not the operator.** First-30-second attempts
  rose roughly twentyfold while fills stayed flat: two thirds of entrants used to get filled,
  now two per cent do. Slots 2–10 were break-even before and lose money after. Whether that
  is specific to this operator or market-wide is untested.
- **Four launches have no tape at all** (`Marciana`, `Leo`, `Fridge`, `GLM`).
- **Fee-inclusive P&L covers 123 of 239 launches.** The rest would tighten the tails of the
  one measurement that actually decides whether the window pays.

---

## Discrepancies found while reproducing

Reproducing a number and having it come out differently is more valuable than having it
pass, so these are recorded rather than smoothed over. **No test was adjusted to match the
prose** — each assertion states what the data says.

1. **"Slots 2–10 at or below zero" is prose rounding, not the measurement.** `report.md` §2
   says "land two to ten slots later and the median is at or below zero." The §5.2 table it
   summarises gives slots 5–10 a median of **+0.003 SOL** — above zero, if trivially. Slots
   2, 3 and 4 are genuinely at or below zero. The test asserts the table, and separately
   asserts what survives of the claim: every slot past 1 is within 0.005 SOL of zero against
   +0.283 in the create slot. *Immaterial to the finding; the cliff is real either way.*
2. **§5.5's "111 launches (3,977 transactions)" is stale.** `onchain_create_slot_pnl.csv`
   holds **123 launches and 4,394 transactions** — which is what §2 and the §5.5 result rows
   actually used, and what reproduces the published medians. The dataset `README.md` repeats
   the stale figure. The file grew after that sentence was written.
3. **§5.3's "407 wallets" and its other columns count different populations.** 407 is every
   non-cohort wallet that reaches the create slot at all; the 1,081 pairs and +0.056 median
   in the same row are closed round trips only, which involve **319** wallets. Both numbers
   are correct; the row mixes them. The test asserts both.
4. **The percentile convention is linear interpolation, and it had to be discovered.**
   Nearest-rank gives the cohort p25 as −0.2372 where §5.5 publishes −0.238. All four
   published p25/p75 figures match numpy-default linear interpolation exactly. `percentile()`
   in `src/units.ts` implements that, with the reason recorded.
5. **The dataset `README.md` says a `window/*.meta.json` "is not written" when the walk did
   not reach the mint. It is.** All 239 mints have one; four carry `reached_mint: false`
   alongside a partial `.jsonl.gz` of unrelated later trading (`Marciana`'s 1,000 rows are
   PumpSwap fills from six days after its launch). **This matters beyond pedantry:** the
   documented resume rule is "a launch is done when its `meta.json` exists," and under that
   rule those four launches would never be retried — which would explain `report.md` §10.1's
   "returned an empty result across three passes" without the endpoint being at fault. Worth
   checking before anyone spends time re-harvesting them. The loader gates on `reached_mint`.
6. **§3.5 says "thirteen reconstructed windows span the moment the token graduated."** There
   are **18**. The six current-preset ones it names are exactly the six that reproduce
   6.5856×, so the finding is unaffected — the count is just low.

Everything else reproduced to the published precision, including all four numbers this repo
was asked to pin: slot-0 median **+0.283 SOL** and **72% profitable**; slots 2–4 at or below
zero (see 1); `2CHrnc2L…` in **235 of 235** launches; and the fee-inclusive medians of
**+0.838** (cohort) and **+0.035** (non-cohort).

---

## Stack

TypeScript on Node with vitest — it matches the rest of the fleet's work, and its structural
typing is what lets the fee/no-fee and closed/open distinctions be *unrepresentable* rather
than merely documented, which is the whole point of the loader. No runtime dependencies, so
"does this reach the network?" is answerable by reading `src/`.

## Provenance

The dataset and the findings are the work of four read-only scout investigations, all
carried out with zero metered provider requests. The population-tape report and its brief
are reproduced in full under `data/population-tape-2026-07-29/`. The three companion reports
— `kol-deployer-entity-cluster` (the operator behind the launches, and the creator-record
mutability trap), `kol-dev-wallet-sell-side` (the exit-ladder measurement, and the
Token-2022 and fee-payer method notes) and `kol-cohort-vs-outsider-funding` (the funding
graph that settles the outsider question above, and the two corrections in
`data/population-tape-2026-07-29/IMPORT.md`) — are not copied here; the facts from them that
this repo depends on are carried in `AGENTS.md` and in `src/cohort.ts`. A later one,
`slot-zero-bankroll-book-pnl` (the bankroll's complete transaction set, and the shared
custodial venue in "The ceiling of the method" above), is likewise not copied here.
