# slot-zero

A research lab for **pump.fun launch microstructure**: what happens in the first seconds of
a token launch, who profits, and whether any of it is capturable.

This repo is the foundation, and only the foundation. It holds one primary dataset, a typed
loader over it, and a test that reproduces the published numbers. **There is no strategy,
backtest, signal or trading logic here, and there should not be** — that work is gated on an
unresolved question stated at the bottom of this file.

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
| `data/population-tape-2026-07-29/` | The population tape. 239 launches, 107,439 fills, 20,388 counterparty wallets, reconstructed keyless. Column semantics in its `README.md`, findings in its `report.md`, import decisions in its `IMPORT.md`. |
| `src/` | The loader. Per-launch, per-wallet and per-(wallet, launch) views, plus the raw per-fill tape. No runtime dependencies. |
| `test/reproduction.test.ts` | The published headline numbers, asserted against the loaded data. |
| `test/type-guards.test-d.ts` | Compile-time proof that the three traps below are unreachable. |
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
asserted in `test/reproduction.test.ts`.

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
  That the six are *part of the operation* is an inference the source report labels as such —
  common ownership is not established, and settling it needs a funding graph.
- **The outsider edge is real, thin, and bought.** `5brv79eF…` keeps **+47.8 SOL of +100.9
  gross** over 49 exactly-priced launches — it pays away over half in priority fees, and is
  still the best unaffiliated result in 20,388 wallets.
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

## What is open

Stated honestly, because the temptation is to read the section above as a green light.

### The one that gates everything

**The entire positive strategy result rests on two wallets out of 20,388, and whether they
are genuine outsiders is not settled.** `5brv79eF…` and `EgQX9R3Q…` are the whole empirical
case that this launch window is winnable by someone not inside the operation. Every
discriminator available points to "outsider" — they pay full market price where the cohort
pays 1.08×, they bid real priority fees where the cohort pays none, they miss most launches,
and one of them appears in the control. **None of that excludes their being the same
operator running a differently-positioned book.** The settling evidence is a funding graph
that nobody has built.

If they turn out to be the operator's, the positive answer collapses to zero and the honest
conclusion becomes a flat no. **Do not build a strategy on this dataset until that question
is answered.** (`report.md` §7, §10.3; `src/cohort.ts` → `UNSETTLED_OUTSIDERS`.)

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

The dataset and the findings are the work of three read-only scout investigations, all
carried out with zero metered provider requests. The population-tape report and its brief
are reproduced in full under `data/population-tape-2026-07-29/`. The two companion reports —
`kol-deployer-entity-cluster` (the operator behind the launches, and the creator-record
mutability trap) and `kol-dev-wallet-sell-side` (the exit-ladder measurement, and the
Token-2022 and fee-payer method notes) — are not copied here; the facts from them that this
repo depends on are carried in `AGENTS.md`.
