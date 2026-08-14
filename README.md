# slot-zero

A research lab for **pump.fun launch microstructure**, working one question — the captain's, verbatim:

> "Can I beat the dev and all other wallets sniping the same tokens created by the dev currently?"

Three things that question demands, and nothing here may blur them:

- **Profit against the field that is actually there**, not a quality score on the deployer. A
  deployer can complete bonding curves reliably and still run an opening window nobody outside its
  own wallets can profit in. This lab holds that exact wallet and uses it as a control.
- **Both legs, on the same tokens.** The dev *and* every other sniping wallet, measured on the
  launches under consideration — not on two separately assembled populations.
- **Present tense.** This is PvP, devs adapt, and a window that closes is expected behaviour rather
  than a defect. Nothing here claims an edge is durable. The one window this lab has measured end to
  end was shut by the deployer in a single launch.

**What is here is the foundation and the entry half of the answer.** One primary dataset, a typed
loader over it, a test that reproduces the published numbers, one offline measurement over the tape,
and one screening tool that **gates on competence and scores entry**. Exit is a separate, unbuilt
stage. **There is no strategy, backtest, signal or trading logic here.**

**The analysis core under `src/` reaches no network and reads no credential**, and
`test/loader.test.ts` proves it; `analysis/` is held to the same list by
`test/window-population.test.ts`. Every source behind the dataset is keyless and public, and the
dataset was built with **zero metered provider requests**, and so was its extension past the bond.
The network-capable area is `tools/`, and the boundary is the directory: `tools/deployer-screen/`,
`tools/creation-census/` and `tools/venue-label/` are the **keyed** ones; `tools/graduated-life-tape/`,
`tools/arrival-rate-walk/` and `tools/window-decay-tripwire/` are keyless throughout. None of them is imported by `src/` and none
imports from it. See each one's `README.md`.

```bash
npm ci
npm test        # tsc --noEmit, then vitest run
```

CI (`.github/workflows/ci.yml`) runs exactly that on Node 20 for every PR and every push to `main`,
after getting itself the measurement tapes — see "How CI gets them" below. **`npm test` needs the
tapes and they are not in a clone**; "Where the data lives" is the one-time setup.

Public, and nothing here is production. The method, the thresholds and the tapes are all
world-readable (captain decision 377a) — treat none of them as confidential.

### Where the data lives

**The tapes are not in this repository and a clone does not carry them.** All 705 files were
untracked by dry dock phase C, and the reason is **repository hygiene: a lighter tree and faster
clones**. They were 118 MB and 705 of the tree's 833 tracked files, so every clone paid for them.
Nothing about the move is a confidentiality measure and none is claimed — they are in this
repository's public history and untracking cannot un-publish them.

They are published instead as the **`slot-zero-data.tar.gz` asset on the `data-2026-08-02`
release**, together with the manifest that vouches for them. Fetch it once:

```bash
gh release download data-2026-08-02 --pattern slot-zero-data.tar.gz
mkdir -p ~/slot-zero-data
tar -xzf slot-zero-data.tar.gz -C ~/slot-zero-data --strip-components=1
node config/verify-data-root.mjs        # 705 files, every digest matched
npm test
```

**One module owns where a run then reads them from: `config/data-root.mjs`.** Every reader in
`src/`, `analysis/`, `tools/` and `test/` asks it for a dataset directory instead of composing a
path of its own, so the tapes can live anywhere without touching a consumer.

```bash
# keep them somewhere else
export SLOT_ZERO_DATA_ROOT=/srv/tapes
npm test
```

The root is a directory holding the datasets **by name**, so
`$SLOT_ZERO_DATA_ROOT/population-tape-2026-07-29/launches.csv` is the same file whichever root is in
use. `SLOT_ZERO_DATA_ROOT` unset means `~/slot-zero-data`, which is why the commands above need no
configuration at all. It is **not** a credential: it holds a path, it is printed freely, and it is
the only environment variable anything outside `tools/` reads — which is why the owner is its own
area rather than a module in `src/`, where reading one at all is banned by `test/loader.test.ts`.

A dataset that is not where the root says it is reports **what is missing, where it was looked for,
and how to fix it** — fetch the store, or point the variable at the copy you keep — rather than an
`ENOENT` on a file deep inside `window/`.

#### How CI gets them

Captain decision 354a. **CI cannot go green without the tapes and there is no data-free mode** —
measured against a root pointing at nothing, **12 of the 18 suites fail**, because this project's
tests are population assertions rather than fixture tests. A committed representative subset was
built and measured before this was settled: 23 launches, 94 files, 16 MB, and **138 tests still
failed**; it converted exactly one suite over having no data at all, and it changed a published
finding (the blind changepoint scan returned a different break date). Any future proposal to sample
the tapes for testing is refused by that measurement rather than re-measured.

The workflow reads the repository variable `SLOT_ZERO_DATA_SOURCE`, and since phase C it has **one**
mode:

| | |
|---|---|
| `release` (default) | Fetch the tapes from the **public release asset** on this repository — public because this repository is — and verify them against the manifest the store ships. |
| `repo` | **RETIRED by phase C.** It meant "read the copy in the tree", and there is no copy in the tree. It is rejected **by name**, with that reason, so a repository variable still set to it fails with an explanation rather than being swept into the branch below. |

An unrecognised value **fails the job** rather than falling through to anything, so the mode is
always something somebody chose. A release asset rather than a build cache, deliberately: cache
entries are evicted after a period without access, so a quiet week would break CI and the breakage
would look like a data problem. The tapes are **immutable dated snapshots**, so the asset is written
once and never changes.

No credential is involved anywhere in this. The fetch runs on the workflow's own
`secrets.GITHUB_TOKEN` at `permissions: contents: read`, which is the least scope that reads a
release at all.

Verification is not optional, and it is not `sha256sum -c`'s job alone:

```bash
node config/verify-data-root.mjs        # or --root <dir>
```

It walks the store's `MANIFEST.sha256` (705 entries, ~0.2 s) and fails on a **missing** file, a
**wrong digest**, or an **extra file the manifest never listed**. That third one is the reason this
is a script rather than one line of shell: several suites choose their population by reading
`window/` and `life/` with `readdirSync`, so an unlisted tape is an extra *launch* in a published
figure, and a partial fetch does not raise `ENOENT` — it silently moves a number.

**The store is populated, and it was a one-time captain step** — the snapshots never change, so the
asset is written once. This is what was run, and what a re-publication would run again:

```bash
tar -czf slot-zero-data.tar.gz -C ~ slot-zero-data     # ~105 MB
gh release create data-2026-08-02 --repo SeaRiskTree/slot-zero \
  --title 'Measurement tapes' \
  --notes 'population-tape-2026-07-29 and graduated-life-tape-2026-08-02, with MANIFEST.sha256.' \
  slot-zero-data.tar.gz
```

The published release carries a fuller body than that one line; the command above is what a
re-publication needs to run, not a reproduction of the notes.

No repository variable is set, and that is deliberate: `release` is the default, so CI reads the
asset with no configuration and `SLOT_ZERO_DATA_SOURCE` exists only to be *checked* — the contract
354a asked for, which is that an unrecognised value fails rather than falls through.

Do not reach for a stronger compressor: 342 of the 705 files are already gzipped tapes, so the
archive compresses by about **7%** and `zstd -19` beats `gzip` by 2 MB in 118.

---

## Where the lab stands

**The founding question is closed.** It was whether the two winning outsiders were the operator's
own book. They are not: both are settled outsiders, confidence high, on complete signature sets —
see "What is open" below, which now records what that answer did and did not buy.

**And the follow-on measurement killed the opportunity it was gating.** On this deployer the
opening window is no longer enterable by outsiders. The break is **2026-06-04**, it took one launch,
and the cause was **the deployer raising its own buy — not the flood of competing bots.** Both the
bot flood and the parameter change are measured; only the parameter change tracks both ends of the
window. See "The one window, and what closed it" below.

That is why the mission moved from *"is the positive result real?"* to the captain's question at the
top of this file. Answering it means screening *other* deployers, present tense.

**What has landed toward that:**

| | |
|---|---|
| **Stage 0** — local validation, no network, no key | `tools/deployer-screen/stage0.mjs` |
| **Stage 1** — the completion-rate **gate**: keyed MadeOnSol counts, over a launch history derived from the **create** transactions rather than from who owns the tokens now (enumerated on Dune when `DUNE_API_KEY` is set, with the on-chain walk — indexed via Helius when `HELIUS_API_KEY` is set, keyless otherwise — as the fallback) | `tools/deployer-screen/screen.mjs` |
| **Stage 2** — the keyless **entry** score: room in the opening window, what the field there achieved, and **what it cost that field to land** | `tools/deployer-screen/stage2.mjs`, `entry.mjs` |
| **The feedback loop** — the screen grading its own predictions: every run records what it predicted, and a later run scores those claims against launches the wallets made afterwards. A bare invocation is a dry run that opens no socket; method and bounds in `tools/deployer-screen/README.md` → "The feedback loop" | `tools/deployer-screen/grade.mjs` |
| **The candidate discovery feed** — the scheduled lane that surfaces deployer wallets this project has not seen before and queues the gate-clearing ones for the screen; scope, quota bounds and the vendor-selection ceiling in `tools/deployer-screen/FEED.md` | `tools/deployer-screen/feed.mjs` |
| **The creation census** — the answer to that ceiling: every deployer creating in one past month, taken whole above a stated count, one keyed Dune execution per month. **3,036** for 2026-07 at ≥30 launches against the feed's 5 | `tools/creation-census/` |
| **The window-population measurement** — how many profitable windows the tape contains, how long, how fast they close | `analysis/window-population/` |
| **The window-decay tripwire** — watches the wallet currently being traded and raises **STOP AND ROTATE** when its window closes. Detects the one close on record **24.1 h** after the regime changed, against a close that took **24.7 h**, with **0** false stops in the 83-day window; keyless, zero token | `tools/window-decay-tripwire/` |
| **Venue labelling** — names the custodial venue behind an address, on the Helius key this project already holds. **100 credits for up to 100 addresses**, so the batch path is the default and the only one a multi-address run can take. It names walls; it never traces past one, and the citation rule that says so travels with every label | `tools/venue-label/` |
| **CI** — `npm test` on the Node 20 engines floor | `.github/workflows/ci.yml` |

**Stage 2 scores entry and deliberately does not score exit.** Room to enter is not room to leave,
and a single blended score cannot be read back apart, so no exit signal reaches any number Stage 2
produces. **Stage 3 — exit — is a separate lane and is not built.** The prediction-grading loop that
reads the run records under `tools/deployer-screen/runs/` **is**: see the feedback-loop row above.

### The known-negative control

`7ufmve7Z…` — the deployer this whole dataset is built from — is the lab's control, and Stage 0
asserts **both** halves of it every run:

> **The gate must PASS it, and Stage 2 must REFUSE it.**

It is competent (103 of 239 launches bonded, 0.4310) and it is **not beatable**: since 2026-06-04
its own group takes the bottom of its own curve. Stage 2 scores it `entry-room-absent` on both the
recent-launch slice a live run would score and the whole post-break regime, over all 89 of its
post-break launches — under the union co-ordination rule none of them is left **unproven**.
That pairing
is what stops the tool from grading itself favourably, and `stage0.mjs` fails loudly if a later lane
loosens a bar enough to admit the wallet. It matters most because the **field** leg on that same
wallet reads 358 of 469 closed round trips positive gross of fees — followed on its own it would
call the wallet beatable. It is not. Details in `tools/deployer-screen/README.md`.

---

## What is here

| | |
|---|---|
| `population-tape-2026-07-29` **(fetched, not tracked)** | The population tape. 239 launches, 107,439 fills, 20,388 counterparty wallets, reconstructed keyless. Column semantics in its own `README.md`, findings in its `report.md`, import and correction decisions in its `IMPORT.md` — all three ship inside the dataset, so they are in the store and not in this tree. See "Where the data lives". |
| `src/` | The loader. Per-launch, per-wallet and per-(wallet, launch) views, plus the raw per-fill tape. No runtime dependencies. |
| `config/data-root.mjs` | The one owner of **where the data lives** — see "Where the data lives" above. Its own area because it reads an environment variable, which `src/` and `analysis/` may not, and because a resolver under `tools/` could not be imported by either. |
| `test/reproduction.test.ts` | The published headline numbers, asserted against the loaded data. |
| `test/type-guards.test-d.ts` | Compile-time proof that the **four** guards below bite. Type-checked, never executed. |
| `tools/deployer-screen/` | One of the three keyed, network-capable areas. The competence **gate** (stages 0–1, keyed) plus the keyless **entry score** (stage 2) — it gates and scores entry, it does not recommend and it does not score exit. Usage, credential handling, quota bounds and scope in its `README.md`. |
| `graduated-life-tape-2026-08-02` **(fetched, not tracked)** | The same tape, **extended past the bond**: every fill of the 103 graduated launches from mint to graduation + 1 hour. 503,037 fills, 63% of them on PumpSwap. Closure over the wallets each launch's own committed window already shows rises from **47.2% to 94.4%**. 6,539 keyless requests, EUR 0. Method, coverage proofs and limits in its own `README.md`, inside the dataset. |
| `tools/graduated-life-tape/` | The collector behind it. Network-capable and **keyless throughout** — one file opens a socket, one host, and the list of files that may name a credential is empty. |
| `tools/window-decay-tripwire/` | The decay tripwire. Watches one wallet's create slots — the operation's share of the bottom of its own curve — and latches **STOP AND ROTATE** on two consecutive readings at or above 0.55. **+24.1 h** on the one close on record against a **24.7 h** close, **0** false stops in 104 open-window launches; keyless, two hosts, an empty credential allow-list. The ceiling is on the false-alarm rate rather than the latency, and its `README.md` §4 states it. |
| `analysis/window-population/` | How many profitable windows the tape contains, how long, and how fast they close. **One window**, 2026-03-12 → 2026-06-04, **83 days**, closed in a single launch over **24.7 hours** — and **n = 1**, so "are windows numerous?" is *unmeasured*. Offline like `src/`. Findings, definitions and limits in its `README.md`. |
| `tools/arrival-rate-walk/` | The collector that would answer that `n = 1` — the same per-launch series for a **cohort** of deployers, seeded from history rather than from success. **Keyless throughout**; the tool is built and proven on a bounded sample, the multi-day collection is a separate step and has not run. Its cohort query is deployed and is executed by `tools/creation-census/`, which holds the key this directory deliberately does not. Scope, bounds and the limits in its `README.md`. |
| `tools/creation-census/` | The keyed half of that statement, and the answer to the discovery ceiling: **every deployer that created in one past month, taken whole above a stated count**, one Dune execution per month. The committed 2026-07 run reaches **3,036** deployers at ≥30 launches where the vendor feed sees 5. The floor is a **prolific-ness** cut and not a competence one, and the census says so in its own output. Scope, bounds and both named biases in its `README.md`. |
| `tools/venue-label/` | The third keyed area, and the smallest: **which venue is this address**, from Helius's Wallet Identity endpoint on the key this project already holds. Both endpoints cost 100 credits per request and one of them answers 100 addresses, so more than one address is **always** batched. `type: "unknown"` is the vendor's own answer and is preserved as one, never smoothed into a guess. **A venue name is a vendor's claim read on a date, and naming a wall does not let anyone see through it** — that rule is enforced onto every label, record and rendered line rather than documented. Scope, bounds and what it cannot answer in its `README.md`. |
| `.github/workflows/ci.yml` | `npm ci` then `npm test` on Node 20, on PRs and pushes to `main`. The whole check set, on purpose. |
| `AGENTS.md` | Provider facts that cost real time to learn. Read before touching pump.fun or Solana RPC. |

### The four guards the loader makes compile errors

The first three each silently corrupted an analysis during the research. The fourth is the
counterparty hazard that replaced the founding question. Each is now a compile error rather than a
convention, and each is asserted in `test/type-guards.test-d.ts`.

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
4. **A counterparty row is not a trader.** `EgQX9R3Q…` is one wallet of a sniping book this
   dataset cannot see the total of, so the `Outsider` union has no `wallet` field to filter a P&L
   table by — only `IndependentOutsider` does. Reading its address without discriminating, or
   passing a book member where an independent observation is wanted, does not compile.

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
  slot of **235 of 235** reconstructed launches over eight months, pays 0.0009 SOL of fees to get
  there, and appears in **zero of 70 other deployers' launches**. The six fill at **1.08–1.91×**
  the deployer's own price — their per-wallet `median_entry_price_mult`, read straight out of
  `wallet_behaviour_profiles.csv` — against a median of **2.46×** (range 1.30–4.10) across the 59
  non-cohort wallets in that same file that reach the create slot on most of their launches.
  Fee-inclusive, the cohort's median create-slot round trip is **+0.838 SOL**; the non-cohort
  median is **+0.035 SOL**. *(`wallet_behaviour_profiles.csv`; `counterparties.csv`;
  `onchain_create_slot_pnl.csv` for the fee-inclusive figures.)*
  That the six are *part of the operation* was an inference when the source report was
  written; the on-chain record has since turned it into an artefact, and none of what does so
  rests on a vendor. The create-slot record above is one half — 235 of 235 at 1.08× for
  0.0009 SOL of fees, no appearance on 70 other deployers' launches, **221 closed round trips
  at a 0.977 hit rate for +503.9 SOL** gross (`report.md` §4.2), and, on the 120 launches priced
  exactly, **+306.0 SOL fee-inclusive and positive on 100% of them for 0.30 SOL of fees in total**
  (`report.md` §5.5). The other half is direct: `2CHrnc2L…`
  **co-signs the operation's three-signer bundle transactions** with `8kzFH4rg…` and
  `Atgx1JXs…`, which a stranger cannot do, and it is the **on-chain `creator` of all 36 coins
  pump.fun lists it under, with no handover visible on any of them** — the same read on the
  deployer's own 70 finds six that genuinely moved away, which is what makes it a measurement
  rather than a null result. That field is settable and movable and reports **current** creator
  status, so it is evidence of association and not of origin; one of the 36 (`Cwb8T7Ct…pump`)
  had its create transaction read directly and was signed by `2CHrnc2L…` — one coin, not 36.
  `43x1zWzj…` and `5P8A9bG…` have a genesis
  byte-identical to the deployer's — the same 3.500000000 SOL from a custodial hot wallet in
  the same instruction envelope, then a pump.fun create-and-buy crediting the identical
  3.0014616 SOL, minutes later. **Common ownership is still not formally established:**
  nothing on-chain proves ownership, this stays a measured grouping, and on 35 of the 36 coins
  the creator reading cannot tell "launched it" from "was given it". **Two discriminators
  the source report offered are withdrawn rather than softened** — `meta.uxento.io` is a
  third-party deploy platform serving thousands of launches a day, with 23 distinct unrelated
  creator wallets writing metadata there inside one 33-minute live sample, not the
  operator's own host, and those three launches never shared a tool fee account; the only
  address common to all three is pump.fun's own protocol fee recipient, which every launch
  pays. *(`kol-cohort-vs-outsider-funding/report.md` §2.1, §4.4;
  `slot-zero-uxento-host-reexamine/report.md` §3, §4.2, §5.2, §8.6;
  `slot-zero-fee-accounts-protocol-or-tool/report.md` §3 — all three held in firstmate's
  records, not in this repo.)*
- **The outsider edge is real, thin, and bought.** `5brv79eF…` keeps **+47.8 SOL of +100.9
  gross** over 49 exactly-priced launches — it pays away over half in priority fees, and is
  still the best result in 20,388 wallets outside the operation's own six. Its outsider status is
  settled, not presumed — and bounded by the on-chain ceiling in "The ceiling of the method" below.
- **Graduation is a curve constant.** 14.70× the initial price, from the curve parameters
  alone — confirmed here empirically on **18 launches whose raw tape window spans the switch
  to the graduated pool**, across dev buys from 3.46 to 56.30 SOL. At the current
  14.8148-SOL preset that is 6.59× the deployer's entry, and the median launch never gets
  there (median lifetime ATH 5.08×). `report.md` §3.5 puts the deployer's finishing sale at
  **~35% of graduation on the dev-buy basis** — the 6.5856× multiple of its own entry price,
  which holds for the standard preset only.
- **Somebody is already running the fast-reacting-bot strategy, and it is the largest loser
  in the dataset.** `C989QoG3…` and `4o9ndxqo…`: 51 and 52 launches, entering a median one
  second after the mint at ~3× the deployer's price, holding ~42 seconds, never once in the create
  slot. **−106.8 and −100.0 SOL**, profitable on 2% and 4%.
- **The deployer takes 4,315 SOL over 228 complete exits** (median +21.66 per launch, gross
  of fees), and is out at a median +13 seconds. **Below the graduation price every time — which
  is not the same as before graduation.** On all 228 complete exits the price it finishes
  selling at is below the graduation price, checked here on the curve basis, 14.70× each
  launch's own initial price (`CURVE` in `src/index.ts`), where the highest of the 228 reaches
  79% of it. That is a different denominator from the ~35% above, so the two are not a
  median/max pair on one scale. **The price test does not settle the timing, and this bullet
  used to read "long before graduation, every time" as though it did.** A graduated pool has no
  curve floor and falls back below the constant within seconds, so a low exit price is
  compatible with the token having already bonded — and on **10 of 103 graduations** it had
  (`TruthGPT` exits at 0.156 of the graduation price, 39 seconds *after* the bond). All ten sit
  inside a tape window and are reproduced here; that there are no others is
  `kol-bond-timing-vs-dev-exit/report.md` §4.3, which measured the other 85. See
  `population-tape-2026-07-29` → `IMPORT.md` correction 6.

---

## The one window, and what closed it

`analysis/window-population/` measures the tape for profitable windows: intervals in which the
outsiders who reached a launch's create slot, taken together, closed their round trips for more than
they staked. Its README owns the definitions, the method and the limits; this is the summary the
rest of the repo cites.

**One window. 2026-03-12 → 2026-06-04. 83 days, 129 launches.** Both ends are *observed* — 91 days
of no window before it and 54 days after — so the duration is a measurement rather than a lower
bound. Both dates fall out of a **blind changepoint scan** given no candidate dates, on two
independent series (return per SOL and prize in SOL) that agree. Since captain decision 496a every
break is reported with the detection strength that earned it, and the open break on return per SOL
sits inside the **unresolved** band — no measured value moved for that;
`analysis/window-population/README.md` §2.4 and §4.1 own the convention and the readings.

**It closed in one launch, over 24.7 hours,** between `Banknote` (2026-06-03 11:25, +2.61 SOL) and
`Peque` (2026-06-04 12:08, −1.27 SOL). There was no decay. A participant watching only its own P&L
needed 2–3 days and 2–4 launches to tell the change from ordinary variance.

**Whether such windows are *numerous* is unmeasured, and this tape structurally cannot say.**
All 239 launches are one deployer, so **n = 1**. The 70-deployer control is one launch per creator
with no dates and no P&L — 70 rows, **zero** window observations. Nothing here gives an arrival rate,
a concurrency, or an idle time between windows, and no further work on this tape produces a second
observation.

**What closed it was the deployer's own parameter change.** Two facts, both measured on the tape:

- The change is atomic and lands on the launch the scan picks out. Median dev buy per regime runs
  **3.000 → 4.444 → 14.815 SOL** and median cohort create-slot stake **3.00 → 6.00 → 19.75 SOL**,
  while median *outsider* create-slot stake goes **1.64 → 15.47 → 10.84**. The operation's share of
  the bottom of its own curve reads **0.773 before / 0.413 inside / 0.771 after**. It was crowding
  in, not being crowded out.
- That indicator separates **both** ends of the window. The competing-bot flood only exists at one
  of them: across the same 2026-06-04 break, per-launch median first-30-second transaction attempts
  rose about **25×** (362 → 9,169) while fills barely moved (260 → 220), so the share of attempts
  that got filled fell from **73% to 2%** — but nothing comparable happens at the March open, which
  the operation's own share does separate. *(`launches.csv` `chain_tx_all_first30s`,
  `chain_tx_ok_first30s`.)*

Two caveats the measurement states about itself and this summary keeps. The share indicator is
**not fully exogenous** — its denominator contains the outsiders' own stake — and the half of it the
operation controls does not separate the regimes alone. And attributing the close to the parameter
change is the reading the evidence supports across both ends; it is not an experiment.

**The later seats broke on the same day** — entrants who were *not* in the create slot show one
break, on 2026-06-05, median per-launch gross going +1.17 → −3.70 SOL. One close, one cause, not a
second window.

**What the window was worth, and to whom.** +591.7 SOL gross over twelve weeks, shared by 186
trading units, **73% of it to two of them**; only 11 units cleared +5 SOL gross over the whole
window. Applying the 0.540 net/gross ratio measured on its own last 30 launches gives ≈ 320 SOL net
— an estimate, because the window's first 72 launches are not priced fee-inclusive.

**And after it: not enterable.** Over the 80 post-break launches priced exactly, the *entire*
outsider population made **+46.9 SOL net on 922 SOL of stake** — under 0.6 SOL per launch shared by
everyone who entered — against +591.7 SOL gross in the window. Gross return per SOL fell 0.396 →
0.173 and net/gross with it, 0.540 → 0.294. This is the measurement behind the known-negative
control above.

---

## The ceiling of the method: shared custodial venues

Every "unaffiliated" verdict this repo carries is an **on-chain** verdict, and on-chain
evidence has one blind spot that no further on-chain work removes. It is recorded here once,
as a stated limit of the method: `src/cohort.ts` and "What is open" below refer here rather
than restating it.

**The limit.** *If the deployer and an outsider both hold accounts at the same custodial
venue, on-chain evidence cannot see the relationship.* Named first by
`kol-cohort-vs-outsider-funding/report.md` §8.2 — "**Custodial walls are walls.**"

**A wall is wider than "an exchange", and the converse is what makes the rule usable.** A
custodial wall is **any hop where a third party takes custody and re-emits**, and this
project's own data already contains three kinds that are not a centralized exchange: a
**withdrawal-processor relay** (the service that funds `5brv79eF…`), a **durable-nonce batch
payout to unrelated recipients** (the 2026-05-12 transaction below, seven strangers in it), and
a **cross-chain bridge** (`5brv79eF…`'s own first action is a Circle CCTP v2 receive) —
`kol-cohort-vs-outsider-funding/report.md` §2 and §2.1. Mixers are the same class. **Where a
trail crosses one of these it stops there, permanently.** And the converse holds and is worth
stating, because it is what keeps the rule from swallowing ordinary trading: **a true on-chain
DEX swap is never a custodial wall.** The user's own key signs it and both sides settle
atomically in one transaction, so a DEX changes the asset, not the identity — there is no
off-chain ledger hop for anyone to deny. Routers and aggregators do not change that.

**Here it is not hypothetical; it is measured.** The `9BhkaAyb…` book and the operation
demonstrably hold accounts at the same venue:

- The book's bankroll has a **complete lifetime signature index** walked to genesis — **all
  4,806 transactions fetched and parsed, zero unresolved**
  (`slot-zero-bankroll-book-pnl/report.md` §2.1; its later sections are cited bare below).
  *(The funding report's own §1 table records the same index as 4,802: the two counts are the
  same index read at different times — §2.1 accounts for the difference — not a conflict.)*
- Across that complete nine-month life, **before any materiality filter**, **zero** of the
  4,806 name the deployer or any of the six cohort wallets in any capacity (§5.1). That is one
  of the two complete sets the negative rests on — the other is the operation's own;
  `EgQX9R3Q…`'s own index is not one of them. See "Which side each negative is complete on"
  below, which owns that accounting.
- Four transactions touch the operation's *custodial endpoints* rather than its wallets, and
  exactly one of them is above one lamport: on **2026-05-12** the bankroll received
  **149.999 SOL** from `5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9`, a wallet holding
  ~1.1 million SOL that the deployer also deposits its profits into (§5.2).
- **That transaction is not evidence of common ownership.** It pays **eight** recipients
  irregular, user-shaped amounts (0.711940000, 0.291915860, 10.071917000 …) in a single batch
  signed with a **durable nonce** — an exchange withdrawal processor serving unrelated
  parties, with seven strangers in the same transaction as the bankroll (§5.2).
- The other three contacts are **1-lamport address-poisoning spam signed by strangers**, each
  naming both the bankroll and a large custodial wallet (§5.2). Recorded so a later reader does
  not rediscover them as signal: they are not.

**The verdicts stand, and this does not widen them** (§5.3). The book is unaffiliated with the
operation, and so is `5brv79eF…`. What the shared venue adds is the exact reading of the word:
"unaffiliated" here means *no on-chain relationship, tested on complete sets* — not *provably
unrelated*. Those are different claims and no on-chain measurement closes the gap.

**It will not be tested.** Testing the relationship means *asking* the venue, which is off-chain
enquiry; that option was put and **declined** (captain decision 114a, 2026-07-29). *Naming* a
venue is now reachable — `tools/venue-label/` reads a vendor's claim for an address — and it
moves nothing here: a name is not an answer about who is behind the wall. So this is a settled
boundary of the method, not an open question and not a TODO: the ceiling is permanent, and
every unaffiliated verdict this lab produces is to be read as carrying it.

---

## What is open

Stated honestly, because the temptation is to read the sections above as a green light.

### The founding question — answered, and the opportunity it gated is dead

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

**And then the answer stopped being worth anything on this deployer.** The positive result the
question was gating is a create-slot result, and the create slot on `7ufmve7Z…` closed to outsiders
on 2026-06-04 — see "The one window, and what closed it" above. **Neither unit rotated out when the
seat closed; both went on trading this deployer across the break, on a collapsed return.** The
wallet `5brv79eF…` — its own unit — went **0.576 → 0.196** gross ROI, and its 97 launches here run
from 2026-03-14 to the tape's final launch on 2026-07-28. The `9BhkaAyb…` book that `EgQX9R3Q…`
belongs to went **0.540 → 0.097** measured as the one unit its five wallets are, and its whole
post-break leg on this deployer is the book-mate `2CQgjcdN…` (62 launches, 2026-05-26 onward) —
**not `EgQX9R3Q…`**, whose own last launch here is 2026-05-25, before the break.
*(`analysis/window-population/README.md` §6.3 — the second row is a book aggregate, not one
wallet's observation. Dates: `wallet_launch_pnl.csv` joined to `launches.csv` `created_utc`.)*
So the settled outsider status is a fact about who those wallets are, and no
part of it says the seat they sat in is still there.

**Which side each negative is complete on**, because that is what the test rests on and the two
wallets are not symmetric here. Common to both: the **operation's** side is complete — complete
signature sets for the deployer and all six cohort wallets, so any transaction between the
operation and either outsider is necessarily inside them. That alone is sufficient for an
intersection test, which needs one complete side, not two.

- **`5brv79eF…` is complete on both sides.** Its own complete lifetime signature index was
  obtained — 347,230 transactions (the funding report's §1 evidence table, alongside the
  deployer's 157,851 and the cohort's 115,082). What was *not* done is fetching every one of
  those transactions to characterise its **inflows** (§10.2 item 4, which calls it not
  warranted because the complete-set tests already cover every transaction it shares with the
  operation). That is a limit on describing where its money comes from, not a gap in the
  negative.
- **`EgQX9R3Q…` is complete on the bankroll side** — the report's own phrase. No complete
  signature set for the wallet itself exists: its index is ~1,000,000 entries and the walk was
  abandoned at 550,000 (§10.2 item 2, §9.1). Its negative rests on the operation's complete
  sets plus the complete set of the `9BhkaAyb…` bankroll that funds it and receives its sweeps
  — all 4,806 transactions of its nine-month life (`slot-zero-bankroll-book-pnl/report.md`
  §2.1), zero contact (its §5.1), both via "The ceiling of the method" above.
  §10.2 item 2 notes that obtaining the wallet's own set would upgrade this to "complete on
  both".

One set is genuinely truncated and is not used as evidence anywhere: `2CQgjcdN…`'s, at
2026-07-22 (§8.2). And **both negatives carry the shared-custodial-venue ceiling** recorded
above; neither is a claim that the parties are provably unrelated.

`5brv79eF…` in particular is exactly what it appeared to be: an unaffiliated, bridge-funded
sniper that took money out of this operator's launches for four months and withdraws to a service
the operator never touches (§3.1, §6.2). It was **still trading as of the 2026-07-29 observation**
— the date `src/cohort.ts` stores it under, which this offline repo can never refresh, so it is a
snapshot rather than a present-tense fact. **It carries no further caveat from this evidence**
beyond the ceiling every on-chain verdict here carries.

**What this does not say.** Nothing above establishes that the strategy works, or that either
wallet's edge is repeatable by a new entrant. The funding report answers whose money it is
and says so itself (its §7 "Explicitly not claimed", §10). Every limit in "The rest" below
survives it untouched.

### `EgQX9R3Q…` is one wallet of a book, and this dataset cannot measure the book

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

- **How often a window arrives is the question the mission now turns on, and it is still
  unmeasured.** The tape holds one deployer and therefore one window: **n = 1**. Answering it needs
  per-launch create-slot series for 10–20 other prolific deployers over 6+ months each — keyless,
  and days of paced fetching. **The collector for it now exists** (`tools/arrival-rate-walk/`,
  proven on a bounded sample) and its cohort query is now deployed, but the collection is a separate
  operational step that has not run. Until it does, no arrival rate, no concurrency, and no
  idle-time estimate exists here.
- **Exit is not measured at all.** Stage 2 scores room to enter. Whether a position can be left —
  when the dev sells relative to mint and to outsider inflow, whether the trigger is a **size**
  that our own buy counts towards, whether an outsider could have exited first — is stage 3's
  separate deliverable, and it is not built. An entry with room in it can still be a position you
  cannot leave.
- **Everything Stage 2 measures about profit is an upper bound**, so its field leg can only ever
  *veto* a verdict, never earn one. The fill tape alone is gross of fees; Stage 2 also nets the
  entry cost it recovers from the chain, but that cost is itself a lower bound — a landing tip paid
  in a separate transaction of the same bundle is in no figure — so netting sharpens the veto
  without changing its direction. The counterexample is on our own subject: 76.3% of post-break
  closed round trips are positive gross (358 / 469), and the same population is not worth trading
  fee-inclusive.
- **P&L in the population tape is bounded by each launch's own collection window** — across the
  239 it is 60 s on 210, 120 s on 4 and 300 s on 25 — and **on the 103 graduated launches that
  bound is now lifted**: `graduated-life-tape-2026-08-02` carries mint → graduation + 1 hour,
  taking closure over the same early wallets from 47.2% to 94.4%. That baseline is each launch's
  own committed window, never a flat 60 s; on the graduated 103 it is 60 s on 83, 120 s on 3 and
  300 s on 17. Two things it does **not** do — the 136 non-graduated launches are still bounded by
  their committed window (by design; 98 of them are within 1% of the empty curve), and **everything
  it adds is still gross of fees**, so it can complete a position without making its P&L
  fee-inclusive.
- **The launch universe is a lower bound, not the population.** `?creator=` lists by
  *current* creator, and creator records move. The one launch we know was missing was this
  operation's best result by two orders of magnitude. Any other launch whose creator record
  has moved is invisible to the same enumeration.
- **This wallet was selected for being unusual**, so "this operator is unusual" is worth less
  than it looks. The 70-launch control removes exactly one objection — that create-slot
  bundles are generic pump.fun mechanics — and no more. The +0.035 SOL outsider edge is
  measured on this operator's unusually well-attended launches only.
- **Whether the June regime change is specific to this operator or market-wide is untested.**
  Both the operation's parameter change and the twenty-five-fold rise in competing attempts are
  measured on one deployer's launches.
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
   alongside a partial `.jsonl.gz`. **This matters beyond pedantry:** the documented resume rule is
   "a launch is done when its `meta.json` exists," and under that rule those four launches would
   never be retried — which would explain `report.md` §10.1's "returned an empty result across
   three passes" without the endpoint being at fault. Worth checking before anyone spends time
   re-harvesting them. The loader gates on `reached_mint`.
   **The partial files are not "unrelated later trading", which this README used to say.** Every
   row in all four sits inside that launch's own 300-second window, minutes after its mint
   (`GLM` 9 s to 5 min after create; `Marciana` 2:11 to 5:00 after create). What they are
   missing is the *oldest* end — the walk never reached the create slot
   — which is exactly why `reached_mint` and not row count is the coverage test.
6. **§3.5 says "thirteen reconstructed windows span the moment the token graduated."** There
   are **18**. The six current-preset ones it names are exactly the six that reproduce
   6.5856×, so the **price** finding is unaffected — the count is just low.
   **The count is now settled from both directions and the shortfall does matter.**
   `kol-bond-timing-vs-dev-exit/report.md` §4.4 reached the same 18 from the other side, while
   measuring graduation times directly; and **seven of the eighteen are launches that bond before
   the deployer has sold anything**, so undercounting them is what let §3.5 conclude the deployer
   is always out first. That, and §3.5's three other timing claims, are recorded as corrections
   4–7 in `population-tape-2026-07-29` → `IMPORT.md` — **read them before quoting any §3.5
   timing.** In short: `curve_last_tx_s` is a bound, not a timing (it overshoots by up to a
   millionfold); §3.5's 32-minute median is not the shipped file's 129; and "out before
   graduation in every case" is wrong on 10 of 103 graduations.

Everything else reproduced to the published precision, including all four numbers this repo
was asked to pin: slot-0 median **+0.283 SOL** and **72% profitable**; slots 2–4 at or below
zero (see 1); `2CHrnc2L…` in **235 of 235** launches; and the fee-inclusive medians of
**+0.838** (cohort) and **+0.035** (non-cohort).

---

## Stack

TypeScript on Node with vitest — it matches the rest of the fleet's work, and its structural
typing is what lets the fee/no-fee and closed/open distinctions be *unrepresentable* rather
than merely documented, which is the whole point of the loader. No runtime dependencies, so
"does this reach the network?" is answerable by reading `src/`. `tools/` and `analysis/` are
plain `.mjs` with JSDoc types so they run on the Node 20 floor with no build step;
`tsc --noEmit` checks them too.

## Provenance

The dataset and the findings are the work of nine read-only scout investigations — the four
behind the dataset all carried out with zero metered provider requests. The population-tape report and its brief
are reproduced in full inside `population-tape-2026-07-29` itself, so they travel with the dataset
rather than with this tree. The three companion reports
— `kol-deployer-entity-cluster` (the operator behind the launches, and the creator-record
mutability trap), `kol-dev-wallet-sell-side` (the exit-ladder measurement, and the
Token-2022 and fee-payer method notes) and `kol-cohort-vs-outsider-funding` (the funding
graph that settles the outsider question above, and the two corrections in
`population-tape-2026-07-29` → `IMPORT.md`) — are not copied here; the facts from them that
this repo depends on are carried in `AGENTS.md` and in `src/cohort.ts`. Three later ones,
`slot-zero-bankroll-book-pnl` (the bankroll's complete transaction set, and the shared
custodial venue in "The ceiling of the method" above), `slot-zero-june-regime-change` (the
create slot's unprofitability for outsiders since 2026-06-04, and the *operation's share of the
curve's bottom* method that `tools/deployer-screen/` cites) and `kol-bond-timing-vs-dev-exit`
(the directly measured graduation times behind `population-tape-2026-07-29` → `IMPORT.md`
corrections 4–7), are likewise not copied here. Two later ones again,
`slot-zero-uxento-host-reexamine` and `slot-zero-fee-accounts-protocol-or-tool` (which
between them withdrew the metadata-host and tool-fee-account discriminators in "Six wallets
are inside the launch" above, under captain decision 371a), are not copied here either.
**None of the eight companion reports is committed to this repo** — only the population-tape
report and its brief travel with the project at all, and they ship inside the dataset rather
than in this tree — so any figure attributed to one of them is evidence from elsewhere
and is not asserted by any test here. Two of them are confirmed in-repo by an independent
route: `analysis/window-population/` re-derives `slot-zero-june-regime-change`'s 2026-06-04
date and its closed-regime prize from the local tape, and `test/reproduction.test.ts` asserts
the part of `kol-bond-timing-vs-dev-exit`'s §4 that the committed files can measure —
`IMPORT.md` corrections 4, 6 and 7. Its population-level figures still cannot be.
