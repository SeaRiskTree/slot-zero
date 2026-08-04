# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

`slot-zero` is a **private research repo** studying pump.fun launch microstructure. There is
no production here. It holds one primary dataset and a loader over it — see `README.md` for
what is established and what is open.

## Build and test

- `npm test` — `tsc --noEmit` then `vitest run`. **Both halves matter**: the type guards in
  `test/type-guards.test-d.ts` are compile-time assertions that fail `tsc`, not `vitest`.
- `npm run test:unit` runs only vitest. No runtime dependencies; `npm ci` is dev-only.
- CI is `.github/workflows/ci.yml` (PRs and pushes to `main`): `npm ci` then `npm test` on
  Node 20 — the `engines` floor, not the dev box's version. That is the whole check set on
  purpose; there is no lint script and no coverage, audit or matrix gate to satisfy.
- **The type surface is pinned to the engines floor major, not to the dev box.** `@types/node`
  tracks Node 20 so a Node 22-only API cannot type-check clean and then throw on the supported
  runtime. `test/toolchain.test.ts` asserts `engines`, the CI `node-version`, the declared and
  installed `@types/node` majors and the tsconfig `lib`/`target` all agree; raising the floor means
  moving all of them together, and that is a captain decision, not a dependency bump. The
  `lib`/`target` ceiling is derived from the floor via `ES_CEILING_BY_NODE_MAJOR` in that test —
  extend the map in the same commit that raises `engines`, and keep the CI `node-version` a
  literal, since the guard refuses a matrix reference rather than half-checking it.
- **`src/` may never reach the network or read a credential.** Enforced structurally by
  `test/loader.test.ts` → "this repo does not reach the network and reads no credential", which
  scans `src/` **recursively** for sockets, `process.env` and key-shaped strings. Keep it that
  way; the entire dataset was built keyless and its value depends on staying reproducible offline.
- **The one network-capable area is `tools/`, and the boundary is the directory.** Each tool there is
  governed by its own test, and there are three. `tools/deployer-screen/` holds the keyed MadeOnSol and
  Dune clients; `test/deployer-screen.test.ts` asserts no imports across `src/`↔`tools/`, only
  `client.mjs`/`pumpfun.mjs` may call `fetch` (**a third vendor goes into `client.mjs`, not a new
  file — keeping that allow-list at two is what makes the ceilings auditable by reading two files**),
  only `credential.mjs`/`screen.mjs` may name `MADEONSOL_API_KEY` / `HELIUS_API_KEY` / `DUNE_API_KEY`,
  and no file there may contain a key-shaped string or assign a value to a credential variable. `tools/graduated-life-tape/`
  is **keyless throughout** — `test/graduated-life-tape.test.ts` holds it to the same shape with the
  credential allow-list **empty**, which is what makes captain decision 112a's "EUR 0" a property of
  the tree. `tools/arrival-rate-walk/` is keyless too and `test/arrival-rate-walk.test.ts` holds it
  the same way, plus a **host allow-list**: exactly `swap-api.pump.fun` and `api.mainnet-beta.solana.com`
  appear in its code, asserted as a set rather than as a ban-list. Duplicated curve constants between
  `src/index.ts` and `tools/deployer-screen/measure.mjs`, the duplicated keyless client across the
  tools, and the duplicated segmentation between `analysis/window-population/measure.mjs` and
  `tools/arrival-rate-walk/arrival.mjs`, are this boundary's deliberate cost — do not "fix" any of
  them by importing across it. The segmentation copy is held together by a **reproduction test**, not
  by discipline: the tool's own code must return the published break dates over the committed tape.
- **`analysis/` is a third area and it is offline like `src/`.** One-off measurements over the
  local tape that are neither library nor tool. `test/window-population.test.ts` scans it for
  sockets, `process.env` and key-shaped strings, and asserts no imports across `analysis/`↔`tools/`.
  It parses the CSVs itself rather than importing `src/`, for the same build-step reason `tools/` does.
- `tools/` and `analysis/` are plain `.mjs` with JSDoc types so they run on the Node 20 floor with
  no build step; `tsconfig.json` covers them with `allowJs`+`checkJs`, so `tsc --noEmit` checks them too.

## The dataset

`data/population-tape-2026-07-29/` is a **primary record — never reformat, re-sort or
"clean" a row.** Column semantics are in its `README.md`, findings in its `report.md`,
import, exclusion and **correction** decisions in its `IMPORT.md`. `sigindex/` (97 MB of raw
RPC signature cache) and a superseded `tape/` probe were excluded; everything else is
verbatim. When later evidence contradicts the imported prose, add to `IMPORT.md`
→ "Corrections"; do not edit `report.md` or the dataset `README.md`.

**`report.md` §3.5's timing claims are all four wrong and `IMPORT.md` corrections 4–7 own the
fixes** — read them before quoting §3.5 on *when* anything happened. The one that will bite a new
view: **`curve_last_tx_s` is an upper *bound*, never a timing.** The curve keeps taking referencing
transactions for months after migration, so it overshoots by a median 8.85× and by up to a
millionfold; never difference it against anything. §3.5's price findings and the 14.70× constant are
unaffected.

Three traps that each silently corrupted an analysis during the research. The loader makes
all three compile errors — do not work around them, and read `src/types.ts` before adding a
view:

1. **Every tape-derived P&L column is gross of fees.** Only `onchain_*.csv` is
   fee-inclusive. `GrossSol` and `NetSol` are unassignable brands (`src/units.ts`).
2. **Only `closed_in_window` rows have a complete P&L** (48%). `OpenPair` has no
   `realisedSolGrossOfFees` field at all.
3. **`dev_exit_complete = 0`** marks seven window-truncated launches; `DevExitTruncated`
   has no complete net figure, only a pointer to the correct file.

Four data hazards callers must not undo — the first three the loader handles, the fourth is a
permanent limit of the evidence:

- **Symbols are not unique — key on `mint`.** Two launches are called `maxxing`, one of them
  the operator's best result ever.
- **All 239 mints have a `window/*.jsonl.gz`, but four never reached the mint.** Coverage is
  `meta.reached_mint`, not file existence. The four partial files are **truncated at the
  oldest end, not full of foreign rows**: every row sits inside that launch's own window,
  minutes after its own mint — what is missing is the create slot the backwards walk never
  reached. `Tape.windowTape()` gates on this, `incompleteWindowTape()` is the diagnostic.
- **A counterparty row is not a trader.** `EgQX9R3Q…` (+47.1 SOL) and `2CQgjcdN…`
  (−12.2 SOL) are two rows of one sniping book run off a single bankroll, and nothing in this
  tape reveals it — they never share a launch. `SETTLED_OUTSIDERS` in `src/cohort.ts` makes
  the book member's address unreachable without discriminating; **do not give
  `BookMemberOutsider` a `wallet` field.** Both wallets *are* settled outsiders — the
  question the repo used to be gated on is answered; see `README.md`, "What is open".
- **"Unaffiliated" here means *no on-chain relationship on complete sets*, never *provably
  unrelated*.** Shared custodial venues are invisible to on-chain evidence, and this operation
  and the book demonstrably share one. That ceiling is permanent and off-chain enquiry to test
  it was declined (captain decision 114a). `README.md` → "The ceiling of the method: shared
  custodial venues" owns the claim: cite it, do not restate it, and do not let a verdict in a
  new view read broader than it.
- **The tape is one deployer over three regimes, and cutting it by month hides them.** The
  create slot paid outsiders only between **2026-03-12 and 2026-06-04** — before that the prize
  was ~0 per launch, after it ~1/4 of the window's. Both boundaries fall out of a blind
  changepoint scan on the per-launch prize; `analysis/window-population/` owns the measurement,
  the definitions and the limits. Two consequences bind any new view: **a monthly or whole-tape
  aggregate mixes the three regimes** and will understate or overstate depending on the cut; and
  **"how many windows are there" is n = 1 here** — the 70-launch control is one launch per
  creator with no dates and no P&L, so it holds zero window observations, and no amount of work
  on this tape produces a second one.

## The tape past the bond, and what it cost

`data/graduated-life-tape-2026-08-02/` extends the population tape from its own per-launch window to
**mint → graduation + 1 hour on all 103 graduated launches**. Collector, method and bounds in
`tools/graduated-life-tape/README.md`; coverage proofs and limits in the dataset's own `README.md`.
Five facts that bind any lane touching it:

- **Closure, not P&L, is what it changes.** Over the 26,404 (wallet, launch) pairs each launch's own
  committed window already shows, complete round trips go **47.2% → 94.4%**. Everything it adds is
  still **gross of fees**, so it completes positions without making their P&L fee-inclusive. Do not
  compare "47.2% of pairs at the committed window" with "78.5% of all pairs at graduation + 1 h" —
  different denominators; the wider window holds far more wallets. `summarise.mjs` →
  `closureOfEarlyPairs` is the like-for-like measure and the only one to quote.
- **The committed window is NOT a constant, and a flat 60 s baseline is a published-number bug.**
  On the graduated 103 it is 60 s on 83, 120 s on 3 and 300 s on 17 — `window_ms` in
  `data/population-tape-2026-07-29/window/{mint}.meta.json`, exposed by `launches.mjs` →
  `readWindowMeta`. Hardcoding 60 s overstated this uplift by ~6 points before it was caught, and
  `coverage.csv` now carries `committed_window_s` per launch so a reader can see the cut applied.
- **`69420` is truncated at its MINT end** — it bonded ~20 days after mint and the walk covered 1.5%
  of that window. **Do not treat its oldest fill as its create slot.** Every other launch proved
  coverage, and 99 of 99 applicable launches agree with the committed window tape's own create slot.
- **`Marciana`, `Leo` and `Fridge` now have trade tapes.** The population tape lists them as having
  none, which is why their dev exits were never measured; `GLM` never graduated and is still
  untaped. `IMPORT.md` → "Corrections", item 9 owns the fix.
- **The §5 cost projection was wrong by ~2.5x and the real numbers are here.** It costed this shape
  at 1,000–4,000 requests; it cost **6,539** (857 pinning graduations + 5,682 walking). Pages per
  launch for this window run **median 46, p90 89, max 179**, not the 10–40 planned. Size any future
  walk from those.

## The arrival-rate walk, and the two-bound cursor it exists not to repeat

`tools/arrival-rate-walk/` answers `analysis/window-population/README.md` §8's first question — *how
often does a profitable opening window arrive, and how long does it last* — by building that report's
per-launch series for a cohort of deployers instead of one. Scope, bounds and limits in its
`README.md`; the investigation behind its shape is `data/slot-zero-cursor-gap-walk-blast/report.md`.
Five things bind anything that touches it or copies from it:

- **A WINDOW WALK GETS ONE BOUND, IN ONE UNIT — copy `walk.mjs`, never `readLaunchWindow`.**
  `tools/deployer-screen/pumpfun.mjs` seeks in **milliseconds** (`createdAtMs + windowMs +
  seekMarginMs` = 65,000) and decides membership in **slots** (`createSlot + windowSlotSpan` = 160),
  reconciled only by a nominal 400 ms/slot with ~1 s of headroom. The chain drifted past it: p50
  389.0 ms/slot in 2025-12 against **418.0 in 2026-07, max 441.3**, so 160 slots is up to 70.6 s
  against a 65 s reach and the walk never fetches the tail — while reporting `usable: true`,
  `reachedCreateSlot: true` and a note true in every clause. Measured cost: **354 in-window fills,
  161 of them sells, across 102 launches**. It moves §2.1's create-slot series by *nothing* (identical
  to seven significant figures) because create-slot outsiders close early; it moves an all-entrant
  reading by 69 pairs / 17.1 SOL. `tools/graduated-life-tape/walk.mjs` and
  `tools/arrival-rate-walk/walk.mjs` both use `seekCursor(endMs)` + `tsMs <= endMs` and cannot have it.
- **The two clocks agree, and this was measured rather than assumed.** Dune's `created_at` is the
  chain's block time; every fill's `ts` is the vendor's. `getBlockTime(createSlot)` equals the window
  sidecar's `created_timestamp` on **12 of 12** launches spread over 2025-12 → 2026-07 — skew 0 ms,
  12 keyless requests (`tools/arrival-rate-walk/preflight-2026-08-03.md`). Both clocks are
  second-resolution, so 0 ms means *within one second*: `walk.mjs` still backdates its membership
  floor by 5 s and counts `preMintFills`, because `readLaunchWindow`'s pre-mint tripwire has **zero
  slack** and a positive skew of one millisecond deletes an entire create slot, silently. Leg B — the
  same comparison against Dune's column directly, which costs no request and no execution — has NOT
  run; it needs a launch-list export.
- **Seed a population question from HISTORY, not from success** (captain decision 165b). Every seed
  this repo has — MadeOnSol `recent-bonds`/`alerts`, both leaderboards, a Dune `total_bonded` ranking
  — conditions on current or lifetime success, so a deployer whose window opened, paid, closed and who
  then quit is invisible: arrival rate biased **up**, duration **up**, close rate **down**, on the
  exact estimand, with nothing in the output revealing it. The cohort is every deployer creating in
  one past month above a stated threshold, taken **whole**, followed forward with **no active filter**;
  widening the month goes **backwards**, never forwards.
- **An all-entrant P&L figure is a FLOOR and the label travels with the number** (decision 164c). The
  walk persists every fill in the window so both series come from one pass, but closure is measured
  inside a bounded window and the loss falls on late entrants. `ALL_ENTRANT_FLOOR_CAVEAT` reaches the
  row, the CSV column name and the record. Persisting fills preserves the option; it does not repair
  the data.
- **The lane is keyless and its cohort SQL is NOT DEPLOYED.** `cohort.mjs` → `COHORT_SQL` needs a
  saved Dune query of its own and the free tier's ten private slots are full, so
  `bounds.json` → `dune.cohortQueryId` is `null` and the cohort stage cannot execute. The launch-list
  leg reuses the screen's existing `8204672` **unchanged**. Everything else is proven on a bounded
  sample: 5/5 create slots and exact fill counts against the committed tape (25 requests, 0 shed), and
  `arrival.mjs` reproduces §4.1's break dates, §4.3's three regimes and §5's 82.7-day window offline.

## pump.fun / Solana provider facts

Learned at real cost; the citations are to
`data/population-tape-2026-07-29/report.md` unless stated.

- **The trade endpoint is the affordable route to a per-token tape.** §9.2:
  `swap-api.pump.fun/v2/coins/{mint}/trades?limit=100`, keyless, 100 fills a page, the
  swapping wallet on every row. Its cursor is `<slotIndexId>-<timestampMs>` and **the
  timestamp component seeks** — `cursor=0-<ms>` works, the slot half is ignored — so a launch
  window costs 3–15 requests instead of walking the token's whole history. This turned a
  ~500,000-request job into ~2,000. `/v1/…/trades` is 410; `frontend-api-v3` `/trades/…` is 404.
  `tools/deployer-screen/pumpfun.mjs` → `readLaunchWindow` is the walk; the two traps it exists
  to refuse are below.
- **Its shed rate is a function of YOUR pacing, and at a 4-second floor it is nil.** The
  graduated-life collection issued **6,539 requests with zero HTTP 429** and three transport
  failures (2026-08-03). The tape build below measured 24.7% shed — at a `delay` that went as low as
  0.75 s. 2 s is refused outright, 8 s is clean, **4 s with adaptive backoff sustains indefinitely**.
  Retry is still mandatory (transport failures happen), but a run that sheds heavily is a run that is
  going too fast, not an endpoint having a bad day.
- **It sheds about a quarter of every request when pushed, and a client without retry cannot use it.**
  Measured from the tape's own build metadata (`window/*.meta.json` → `stats`): **16,960 HTTP
  429 against 51,715 OK across 235 launches, and 221 of the 235 shed at least once.** The
  builder's recorded `delay` ranges 0.75s–40s, i.e. it backed off adaptively. A 429 here is the
  normal case, not an incident.
- **Rows come back NEWEST FIRST, so a backwards walk reaches the create slot LAST — and a
  truncated walk is silently wrong, not visibly wrong.** It returns a plausible pile of fills
  whose earliest slot is merely the earliest it saw, and any create-slot measure will then crown
  a mid-window sniper as the deployer. Coverage must be *proved*: only a row older than the mint,
  or the endpoint saying nothing is older, establishes it. Same distinction as the dataset's
  `meta.reached_mint`. Also **sort by `sid`/`slotIndexId` before reading the queue** — the stored
  tape is ascending and the live endpoint is descending.
- **THE TWO PUMP.FUN SURFACES DO NOT AGREE ON A MINT INSTANT, and the disagreement runs in exactly
  the direction that deletes a create slot.** `frontend-api-v3`'s `coins?creator=` rows carry
  **millisecond-precision** `created_timestamp` on older launches while `swap-api`'s fill `ts` is
  **whole seconds, floored** — so the declared mint lands *after* the launch's own first fill.
  Measured 2026-08-03 over 6 launches of one cohort wallet: **0 ms on the 3 whose
  `created_timestamp` ends in `000`, and +1,313 / +1,813 / +2,014 ms on the 3 that carry
  milliseconds.** `readLaunchWindow`'s pre-mint tripwire compares with **zero slack**, so those
  launches are dropped whole and silently — measured live at **5 of 8 launches on the first
  candidate walked**. Anything driving `readLaunchWindow` from a `frontend-api-v3` creation time
  must backdate it; `tools/deployer-screen/bundling.mjs` and `tools/arrival-rate-walk/` both pin
  **5,000 ms** and both count what still trips. The tape's own `created_timestamp` does not have
  this problem (0 disagreements on 235 launches), so it is a property of the vendor pair, not of
  the walk.
- **Per-launch request budgets: p50 4 pages, p90 8, p95 13, max 24** (same metadata; fills p50
  381, max 2,321). Bound a walk by **requests, not pages**, or the shed rate makes the true cost
  ~3x the plan.
- **Every pump.fun surface answers "who OWNS this now", never "who CREATED it".** §1.2 and
  `kol-deployer-entity-cluster/report.md` §6. Ownership is a sellable position — the owner collects
  the creator fees — so the ones that move on are the winners, and a listed history understates
  launches, understates *bonded* launches by more, and therefore **scores the better dev worse**.
  The bias runs towards rejection, and a false rejection is invisible. Confirmed on-chain
  2026-08-02: `maxxing` (`32CdQdBU…pump`, $7.7M ATH, this operation's best launch and 83% of its
  lifetime creator-fee income) was created by
  `7ufmve7Z…` in tx `64pCziaL…`, and its creator has since moved twice — the second time (tx
  `5fjZDdFQ…`, `MigrateBondingCurveCreator`) to a fee-sharing config that is not a wallet at all.
  **There is no keyless index by original creator**: `?creator=`, `/coins/{mint}.creator`,
  `.cto_address` and `advanced-api-v2/…/metadata/{mint}.dev` are all current-owner, and
  `coins/list?dev=` silently ignores the filter rather than applying it. The only route is the
  create transaction — `tools/deployer-screen/creation.mjs` and its README section "Which history
  the gate counts" own this, including what the walk costs and how to read the record.
  **The KEYLESS walk normally covers NO window at all** — 100 requests per candidate against 1,000-entry
  signature pages means it usually stops inside page 1, and the floor only advances after a page is
  inspected whole. So `covered.fromMs` is `number | null` and **`null` means covered nothing, never
  "since the epoch"**: a `0` sentinel there read as a 56-year window and made the merge delete 29 of
  one live wallet's 30 launches as "acquired". Under an empty window the whole reading falls back to
  the ownership listing. README → "Four rules keep that window from claiming more than it covers".
  **Measured size of the bias: nil so far.** Five wallets have both readings; four gaps of exactly
  zero, one of 1 launch in 239, no verdict changed
  (`tools/deployer-screen/CREATION-DERIVED.md`). The reason is worth knowing before re-deriving it:
  creator records move *often* — up to 15 of 27 launches on one wallet — but nearly always into a
  **fee-sharing config that pump.fun still attributes to the wallet**. Only a genuine handover or
  CTO removes the token from `?creator=`. Counting "creator moved" as the bias overstates it by two
  orders of magnitude.
- **Bonding-curve account (`["bonding-curve", mint]`): `complete` at offset 48, `creator` at offset
  49**, both validated 2026-08-02 against a control token whose creator never moved. One
  `getMultipleAccounts` reads both for 100 mints. Note the on-chain `creator` moving is **not** the
  same as the token leaving that wallet's `?creator=` listing — a fee-sharing migration moves the
  on-chain field while pump.fun still lists the token under the wallet.
- **Graduation is a fixed curve constant, not a measurement.** §3.5: **14.70× the initial
  price**, from the curve parameters, independent of the deployer's stake. `CURVE` in
  `src/index.ts` carries the parameters, and the reproduction test confirms 14.70× on 18
  launches whose tape window spans graduation. So "did it graduate" and "what was its peak"
  are the same measurement.
- **These mints are Token-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), not legacy
  SPL. `kol-dev-wallet-sell-side/report.md` §6: a legacy-program holdings query returns the
  right headline for the wrong reason. Any ATA derivation must seed with Token-2022.
- **`getSignaturesForAddress` returns *referencing* transactions, not authored ones.** For a
  pump.fun creator this is dominated by other people's trades — 953 apparent "failures" per
  1,000 that are not the operator's at all. **Fee-payer filtering is mandatory**
  (`kol-dev-wallet-sell-side/report.md` §6).
  **Counter-trap, and it runs the other way:** for a *bundled* transaction the fee payer is
  **not** the trader — `accountKeys[0]` is one cohort wallet for three wallets' buys, so
  fee-payer attribution would merge three distinct traders into one (§9.3). The tape's
  per-fill wallet (`u`) is the right unit for who traded; the fee payer is only the right
  unit for who paid. `onchain_*.csv` carries `is_fee_payer` for exactly this reason.
- **The public RPC sheds load with `null` results inside batches rather than erroring.**
  Treat a null as "retry", never as "absent". A 429 from it is load-shedding rather than a verdict —
  back off and retry, unlike a keyed 429 where the allowance is genuinely spent.
- **`getSignaturesForAddress` on a deployer is ~95% other people's FAILED trades, and that is a
  gift**: creations always succeed, so `err === null` discards most of the index before a single
  `getTransaction` is spent. **The surviving fraction is the whole cost model and it is not a
  constant** — measured 1.7% to 99.7% across twelve elite wallets, i.e. 170 to 127,000 requests for
  one wallet's full history, 7 minutes to 84 hours. Never assume this walk is cheap for the next
  wallet because it was cheap for the last one.
- **`getSignaturesForAddress`'s `before` accepts a *foreign* signature**, one that is not in
  the queried address's index at all. `kol-cohort-vs-outsider-funding/report.md` §9.1: so a
  wallet's genesis can be **binary-searched by slot**, pulling cursor signatures from
  arbitrary blocks with `getBlock(slot, transactionDetails='signatures')` — ~22 iterations
  regardless of index size. That found one wallet's genesis in **66 requests against a
  ~1,000,000-entry index**, where the naive walk was ~1,000 pages. This is the general form of
  `kol-deployer-entity-cluster/report.md` §3.1's trick (use the wallet's WSOL ATA's oldest
  signature as the cursor), which is free when it works and fails when the ATA is itself
  large — 41,000+ transactions on the wallet above. Try the ATA cursor, fall back to bisection.
- **`solana-rpc.publicnode.com` 403s this client outright** — every request, with or without
  a browser `User-Agent` (§9.3). It is in the entity report's endpoint list; **anything
  copying that list sends half its batches to a dead host**, and the retry backoff hides it
  (it stalled a job for 40 minutes). `api.mainnet-beta.solana.com` is the only working keyless
  endpoint found, and it rate-limits **globally** across `getSignaturesForAddress` and
  `getTransaction` — the tape report §9.4's "separate buckets" did not hold, and two
  concurrent jobs earned a sustained 429 lockout. **Re-measured 2026-08-02, §9.4's "batches of 5–8"
  no longer holds either: batching is now actively harmful.** The same transactions took 58 s at
  batch=1 with *zero* load-shed events, 76 s at batch=4 with 7, and 110 s at batch=8 with 11 — the
  endpoint weights each batch entry against its limiter. Sustainable: one process, **one**
  `getTransaction` per request, ~2.5 s between requests, giving ~0.42 requests/second. The
  nominally faster 1.4 s is *slower* in wall-clock once backoff is counted.

## Dune facts — the PRIMARY creation-enumeration surface

Captain decision 156a, 2026-08-03. Long form and every figure in
`tools/deployer-screen/CREATION-DERIVED.md` §8; bounds in `thresholds.json` → `dune`; method in
`tools/deployer-screen/dune.mjs`.

- **Creation ENUMERATION — "which mints did this wallet create" — is Dune now; the Solana RPC walk is
  the FALLBACK.** Helius is undemoted for everything transaction-level, including Stage 2's
  entry-cost leg (`meta.fee`, pre/post balances), which no decoded table serves. `DUNE_API_KEY` is
  OPTIONAL: unset, the run is byte-for-byte what it was before this decision. **No Dune value may
  reach a Stage 2 entry number or Stage 3**, and a test asserts it structurally.
- **The surface is `pump_evt_createevent` UNION `pump_call_create`, deduped by mint, and neither
  alone is usable.** `pump_call_create` alone returns **zero rows** for our deployer (it decodes only
  the original `Create`; we use `CreateV2`). `pump_call_create_v2` alone is **not backfilled before
  2026-04-30** and silently misses **101 of our 239 launches, `maxxing` included**.
- **Attribute on `"user"` / `account_user`, the SIGNER — never on `creator`**, a settable `CreateV2`
  argument: six mints declare our deployer as `creator` while being signed by six different
  bot-shaped wallets, inflating the count 247 → 253.
- **EVERY Dune-derived count ships with its own coverage probe, and a count that reaches outside the
  probed coverage is refused, never published.** Decoded tables have **silent start dates**: a
  confident, well-formed, complete-looking answer that is simply wrong before their first row, with
  nothing in the response saying so — the same failure shape as a truncated backwards walk in
  `pumpfun.mjs`, failing in the same direction. `dune.mjs` → `assessCoverage` refuses a missing or
  empty table, **a month inside the covered span where every read table is empty**, staleness past
  6 h, and per wallet a history reaching the probed floor or past the probed ceiling. A refused
  reading falls back to the walk — **per wallet**, so one run can carry both sources and every
  candidate's `enumerationSource` says which answered it.
- **The refusal rule is general, not coverage-only: a reading that cannot vouch for itself falls back
  to the walk rather than being gated on.** `CREATION-DERIVED.md` §8.2 lists all nine; five are not
  the probe. A result read that cannot prove it is whole (missing `total_row_count`, a total over the
  ceiling, exactly the `?limit=` many rows, or rows disagreeing with the declared total — `/results`
  pages on response size independently of ours) is refused. **One unreadable row refuses the WHOLE
  batch** — a row that fails to parse commonly has no readable `deployer`, so the wallet whose history
  came back short is the one you cannot name, and partial attribution would gate it on what survived
  the parser. **`bonded` is TYPE-checked, not truth-checked**: `false` is legitimate there, so
  `=== true` would collapse "the column is gone" into "this launch did not bond" and gate-fail every
  candidate at 0% bonded on a run reporting itself fully measured. **A wallet the enumeration returned NO row for is refused, never read as zero
  launches**: absence of evidence, not evidence of absence, and reading it the other way lets
  `mergeHistories` reclassify that wallet's whole in-window ownership listing as acquired and gate it
  on nothing — the invisible false rejection this lane exists to remove. **A candidate whose address
  is not base58-shaped is never sent**: wallets are vendor-supplied and land inside a single-quoted
  SQL literal (`dune.mjs` → `WALLET_SHAPE`; the record's `dune.walletsRefusedByShape` counts the
  drops). The rule binds wherever a vendor-derived wallet reaches a query language —
  `tools/arrival-rate-walk/cohort.mjs` carries its own copy of the guard for the cohort it hands to
  `CREATION_SQL`'s `{{deployers}}`.
- **THE ROW CEILING REFUSES A RESULT, AND ENUMERATION IS ONE EXECUTION FOR THE WHOLE BATCH — so the
  cap that keeps one spam wallet from pricing the batch is PER DEPLOYER, inside the SQL.**
  `CREATION_SQL` returns at most `greatest(500, floor(19999 / <deployers in the batch>))` rows per
  deployer — **most recent first**, because the tool asks what a wallet is creating now — plus each
  deployer's TRUE count (`launches_total`), so an oversized wallet (the `total_bonded` leaderboard
  seed serves an 8,518-deploy one) falls back ALONE instead of costing all 195 candidates their Dune
  answer (~13 h of walking against ~1 credit). **A capped wallet is a PREFIX, never a
  short-but-complete history**, and the check is deliberately separate from the reader's
  `rows.length !== total_row_count` (vendor paging). `launches_total` is type-checked as hard as
  `bonded`: absent ⇒ unreadable row, never "not capped". **The cap is `max(pinned floor 500, ceiling
  shared out)`, and the floor is the load-bearing half**: the share-out alone is 102 rows at the
  195-candidate cap, which would truncate the subject deployer (247) and `4q4GKBpV…` (152) on every
  full run, so 500 (~2× the largest measured history, ~17× under the spam extreme) is what keeps
  every measured wallet whole at ANY batch size. **The rows bound is therefore
  `max(19,999, <deployers> × 500)`, NOT 19,999 by construction** — above 39 deployers it exceeds
  `maxResultRows`, and the ceiling stays as the backstop that refuses such a result whole, exactly as
  before the cap existed. Bytes are bounded separately and unchanged, by `?limit=maxResultRows`.
  `CREATION-DERIVED.md` §8.2b owns it.
- **A FAILED EXECUTION IS STILL BILLED AND IS TERMINAL.** `DuneClient.execute` is the one call in
  this repository that is never retried, on any failure, for any reason; polling and result reads are
  retried because they return no bytes when they fail. **Budget from *billed* credits, not
  `execution_cost_credits`, which understates by ~3.5×** — retrieving results is ~71% of the bill at
  ~20 credits/MB. Hence: aggregate server-side, select only the columns the tool reads (dropping the
  create tx and graduation timestamp halved the payload to **~97 bytes/row**, measured at FOUR
  columns — the fifth is bounded by arithmetic, not measured), one execution for the whole batch,
  and a **cached** probe read by default.
- **Free tier: 2,500 credits/month, SHARED, and only 10 PRIVATE QUERIES — the account holds 10, so a
  new query cannot be created.** The two production queries were upgraded in place (`8204672`
  enumeration, `8204603` coverage). Their SQL is committed in `dune.mjs` and
  `assertSavedQueryMatches` compares it before spending an execution, because a saved query is
  editable from a browser and its answer is a gate input. **EDITING EITHER SQL IN THIS REPO IS HALF
  THE CHANGE: the saved query must be updated IN PLACE or the next real run refuses the whole Dune
  leg terminally** — the comparison happens before the execution. `README.md` → "Deploying a change
  to the committed SQL" owns the step and names which id goes with which text. **Nothing tracks the
  month** — the tool is stateless between runs. Auth is the `X-Dune-API-Key` **header**, never `Bearer`.
- **Measured cost, 2026-08-03:** five deployers' whole histories = **8 requests, 1 execution, 1.75
  billed credits**; a 195-candidate run ≈ 20 credits, i.e. ~125 full-cap runs a month. Against 793
  Helius credits and 12 requests for ONE deployer, or 7,166 keyless requests and ~287 min.
- **It changed no measured value and no verdict**, reproduced through the wired code path: 239 of 239
  tape launches with `maxxing`, 8 extras all post-tape, and all five `CREATION-DERIVED.md` wallets
  exact on launches *and* bonded rate.
- **`movedCreator` is UNMEASURED on this route, not zero.** Dune says who created a mint and whether
  it completed, and nothing about who owns the curve today. `CurveState.creator` is `null` there,
  `mergeHistories` counts `creatorMovementUnmeasured`, and a schema-≤8 record's `movedCreator: 0` —
  which means the walk read every curve and none had moved — is not the same number.
- **ToS reviewed 2026-08-03** (`CREATION-DERIVED.md` §8.7): no conflict. The scraping ban is on the
  Site, not the SQL API; the addendum forbids substituting for or competing with Dune, which internal
  research does not. `derive and discard` applies unchanged.

## Helius facts — the keyed RPC route, and what it does NOT change

Measured 2026-08-03. Long form and every figure in `tools/deployer-screen/CREATION-DERIVED.md` §7;
bounds in `thresholds.json` → `creation_walk_helius`.

- **Helius is the creation walk's FALLBACK role now (captain decision 156a) and its PRIMARY role for
  every transaction-level measurement.** The walk below runs when Dune is absent, fails, or has a
  reading refused by its coverage probe; Stage 2's entry-cost leg is Helius/RPC always.
- **`HELIUS_API_KEY` is OPTIONAL and its absence is a supported configuration, not a fault.** Set,
  the creation walk takes the indexed route; unset, it is the keyless signature scan and every
  number is what it was before. `credential.mjs` → `resolveSolanaRpcEndpoint` is the only chooser.
  **Store the bare key, never the composed URL** — Helius's address is the host plus the key as a
  query parameter, composed in code in exactly one place, and a URL in an env var is a credential
  that leaks the moment anything formats it into a message. The client therefore carries `url`
  (fetched, never printed) and `label` (printed, never keyed); a test drives every failure path
  against a sentinel URL and asserts the sentinel reaches no message.
- **Plan: Developer, $49/mo, 10M credits, 50 req/s, and the key is UNSHARED** (captain, 2026-08-03)
  — this research lane's alone, so budget against the whole allowance. `getTransactionsForAddress`
  in `full` mode bills **10 credits per 100 transactions RETURNED**; `getSignaturesForAddress`,
  `getTransaction`, `getBlock`, `getMultipleAccounts` are 1 credit.
- **`getTransactionsForAddress` collapses the whole creation walk into one call per 1,000
  transactions**: `transactionDetails: 'full'`, `encoding: 'jsonParsed'`, `filters: {status:
  'succeeded'}`, `sortOrder: 'asc'`, `paginationToken`. **`full` + `jsonParsed` returns
  `getTransaction`'s own envelope**, so `parseCreateTransaction` and `readCurveState` are shared
  unchanged — verified field for field on the `maxxing` create. Subject deployer's whole history:
  **7,791 transactions, 9 pages, 793 credits, 5.7 s**, against 7,166 requests / ~287 min keyless.
  All twelve elite wallets complete: 125,981 transactions, 12,660 credits, against ~153 hours.
- **CREDITS, NOT WALL CLOCK, ARE THE BINDING CONSTRAINT NOW, and that inversion is the thing to
  remember.** A request ceiling cannot bound a provider that bills by rows returned. Per-candidate
  cost for a COMPLETE history ranged 20 to 4,940 credits (median 320) over those twelve wallets, so
  a 195-candidate run is ~62k credits expected and 1,014k worst case — about a ninth of a month. The screen
  **refuses a plan that does not fit before its first request**, and a page is only started when a
  whole page's worst case still fits, so the ceiling is exact. Nothing tracks the month: the tool is
  stateless between runs, so the monthly arithmetic is the operator's.
- **Helius's failure shapes are NOT the public endpoint's, and the retry-vs-exhausted rule had to be
  rebuilt against them.** A bad parameter is **HTTP 200 carrying a JSON-RPC `error` envelope**
  (invalid address, `limit > 1000`, corrupt pagination token); an absent result is load-shedding; a
  bad or missing key is **HTTP 401 with a plain-text body**. So: an error envelope stops the walk
  and is never retried and never read as exhaustion, a null is still a retry, a 401 stops
  immediately, and **exhaustion is proved only by `paginationToken: null` on a page that
  succeeded** — an empty page carrying a token is not the end. `covered.fromMs === null` still means
  covered NOTHING. The route pages **ascending**, so a truncated walk loses the RECENT end to the
  ownership listing rather than the old end.
- **Pacing is 200 ms and nothing sheds.** A ladder at 1000/500/250/100/**0** ms recorded zero shed
  events at every rung, and 150 concurrent requests were all answered 200 at 161 req/s. The walk is
  latency-bound, not limit-bound. **The batching finding does not carry over because it no longer
  arises** — one request per 1,000 transactions leaves nothing to batch; `api.mainnet-beta`'s
  batch=1 rule is unchanged and still governs the keyless fallback.
- **This route changed no measured value and no verdict.** Reproduced against the committed ground
  truth: **239 of 239 launches found** including `maxxing`, 238/239 bonded flags identical (the one
  difference bonded after the tape was cut), 8 extra launches all created after the tape's newest.
  Stage 0 is offline and untouched by any of it.

## MadeOnSol Deployer Hunter facts

Measured 2026-07-29 against our own ground truth. Long form and reproduction in
`tools/deployer-screen/README.md`; the screen itself is `node tools/deployer-screen/screen.mjs`.

- **Their per-token records are trustworthy; every aggregate they publish is not.**
  `profile.pump_tokens` agreed with our tape **67/67 exactly** on the completion flag with no
  in-window launch missing. But `bonding_rate` / `total_bonded` / `total_tokens_deployed` are a
  trailing **~7.5-day** window their own alert text calls "lifetime": read 22/15/0.6818 and then
  20/13/0.6500 two hours later, against a ground truth of 239/103/**0.4310**. It **slid and shrank**
  while the deployer launched again, which is how we know it is a time window and not a count.
- **`GET /deployer-hunter/{wallet}/tokens` is BONDED-ONLY, so it has no denominator.** 100 records
  fetched for our subject: 98 in our graduated set, **zero** of our 136 failed launches, `total: 101`
  against our 103 bonded, and `only_bonded=true` returns the identical total (the flag is a no-op).
  `bonded/total` from it is **1.0000 for every deployer alive**. Never compute a completion rate from
  it; use `profile.pump_tokens`, which carries both outcomes.
- **The spec lies about that endpoint's limit.** `?limit=100` returns **HTTP 400**; the real cap is
  **50**. Their OpenAPI document declares **no response schemas at all**, so shapes are discovered.
- **The free leaderboard's extremes are both degenerate.** `sort=bonding_rate` DESC is wallets with
  1 deploy / 1 bond / rate 1.0 (their `rising` tier), some last active in **May 2024**;
  `sort=total_bonded` DESC is industrial spam (8,518 deployed / 127 bonded = **0.0149**). Seed from
  `recent-bonds` and `alerts` instead, and use `--tier` to reach a usable population.
- **Those two seeds nest the deployer block under `deployers` — PLURAL — and `recent-bonds` wraps its
  rows in `tokens`, not `bonds`.** Reading the singular `deployer` extracts **zero wallets while still
  spending a keyed request**, and it is silent: two committed runs were leaderboard-only pools before
  anyone noticed. Whatever reads these feeds must report rows *and* wallets per seed, because rows
  present with wallets zero is the only visible sign that the reader — not the vendor — is wrong.
- **The elite-tier recent-bond feed is `recent-bonds?tier=elite`**, a `tier` filter on the shared
  feed (enum `elite|good|moderate|rising|cold`); there is no separate elite endpoint to hunt for.
- **The tiers are not disjoint and membership is not stable.** `7ufmve7Z…` came back from all three
  seeds under `tier=elite` (2026-07-29) and from all three under `tier=good` four days later, its own
  numbers essentially unchanged (70 tokens, span 35.0 → 34.1 days); `rising`-shaped wallets (3–4 deploys, perfect rate) reach us through `tier=good`
  too. So "outside elite" is not a property a screen may rely on — treat `tier` as another trailing
  window, like `bonding_rate`. `tools/deployer-screen/runs/2026-08-02-good-vs-elite.md` owns this,
  and it also holds the measured tempo gap: good-tier gate-passers launch ~5.7x slower at the median.
- **A run record's `coverage.seeds[].walletsReturned` is a PER-ROW count, not distinct deployers.**
  `recent-bonds:good` reads `50 rows / 50 wallets` and contributes **19** distinct wallets. Its job is
  to separate "vendor sent nothing" from "our reader is wrong", and it does that; it is not a yield.
  Distinct per-seed yield must be recomputed from `candidates[].seededBy`, and only gated wallets
  carry provenance — prefiltered entries record a reason and no seed. `tools/deployer-screen/README.md`
  → "Two of the three seeds used to yield nothing, silently" owns the field's semantics.
- **Free tier only** — ~200 requests/day, ~10/min, **shared** across whatever holds the key, and keys
  expire every 30 days. `/{wallet}/history` is PRO+. Paid tiers are refused standing policy.
- **Spend the whole MadeOnSol daily allowance when a run will answer something** (captain, 2026-08-02:
  there is no free substitute for this data, so hoarding it buys nothing). The screen's pinned bounds
  are the full ~200/day; the earlier quarter-allowance ceiling is withdrawn, so do not re-derive it.
  The "if it gets results" conditional binds — no sweeps, no idle retries. **MadeOnSol only**:
  SolanaTracker/CoinGecko keys are production-shared and unchanged, as is keyless pump.fun
  pacing. **Helius is NO LONGER production-shared** — captain, 2026-08-03: that key is this research
  lane's alone, so budget against the whole allowance (see the Helius section below).
  `tools/deployer-screen/README.md` → "Bounds" owns the numbers and the endpoint list.
- **ToS §5a(b)/(d) bind us**: internal research only, and no accumulation beyond what is necessary.
  The screen derives and discards — per-token records live in memory for one run; only derived counts
  are ever written, and only with `--out`. Test fixtures are synthetic, never captured payloads.

## The deployer screen's stages, and the two wallets that keep it honest

`tools/deployer-screen/` — full scope, bounds and reproduction in its `README.md`. It answers the
captain's question *"can I beat the dev and all other wallets sniping the same tokens created by the
dev currently?"*, and the shape of the answer is the point:

- **Stage 1 ENUMERATES on Dune** (keyed, free tier — which mints the wallet created, with the RPC
  walk as fallback) and **GATES on competence** (keyed, MadeOnSol). **Stage 2 SCORES ENTRY** (keyless): room in
  the opening window, what every *other* sniping wallet there achieved, and — since the captain's
  ruling of 2026-08-02 — **what it cost them to land**. **Stage 3 — EXIT — is a separate lane and no
  exit signal may reach an entry number.** Room to enter is not room to leave, and one blended score
  cannot be read back apart.
- **Stage 2 spends no keyed request.** It reuses the mint list from the profile Stage 1 already paid
  for (`measure.mjs` → `toLaunchRefs`), so the shared vendor allowance is untouched by it.
- **A pinned value's `justification` must name the measurement the CALL SITE applies it to, and a
  test now pins that every parameter has one** (`test/deployer-screen.test.ts` → "every pinned
  parameter carries a stated reason"). The 2026-08-02 provenance audit found three justifications
  naming a quantity the code does not compute, four quoting figures that did not reproduce, and eight
  values with no stated reason at all; the round that fixed them is the standard. **"No measurement
  backs this, and here is what would" is an acceptable justification** — `minEpochs`,
  `minTokensPerEpoch`, `creation_walk.maxTransactionsPerCandidate` and Stage 0's `minLaunches` /
  `minPairs` / positive-share / era-tolerance constants all say exactly that. Inventing an anchor is
  not. **`minLaunchesSampled = 8` is the canonical case: it is a BUDGET bound** (3 × 8 × 18 = 432,
  the Stage 2 request ceiling), not a statistical one, and the June report's smallest published
  per-launch quartile bucket is 20 — so a verdict resting on 8 launches is weaker evidence and the
  record's `launchesSampled` is how a reader sees it (captain decision 141a; the value does not move).
  Do not quote `curve_last_tx_s` in any justification: it is a non-timing (see above).
- **"Enterable" means enterable AFTER what it costs to enter, and `entry-room-present` no longer
  exists.** Fees are inside the entry window (captain, 2026-08-02) and the field's after-cost result
  ships with them (decision 136b). The strongest verdict is now `entry-open-after-costs`; two new
  ones — `entry-cost-unmeasured` and `entry-cost-prohibitive` — have no older equivalent, and
  **unmeasured cost is never a pass**. A schema-≤5 `entry-room-present` is NOT the same finding;
  `tools/deployer-screen/README.md` → "The run-record schema" owns the boundary.
- **Entry cost is recovered from the chain, and the signatures are free.** Every `Fill` carries its
  transaction, so `measure.mjs` → `walletTransactions` and `entry.mjs` → `entryCostTargets` name the
  transactions to price with no discovery step; `pumpfun.mjs` → `parseTransactionCosts` reads
  `meta.fee` (base + priority, exact) and the pre/post balance delta. **The free legs — room and the
  gross field — run FIRST**, so a deployer failing either costs zero RPC requests; that ordering is
  the cost model. Measured per launch on our tape: **~19 DISTINCT transactions at the median — the
  UNION** of the create-slot scope (p50 7) and the closed-round-trip window scope (p50 18), not
  their sum; ×8 launches that is ~152 requests, not ~200. Pacing is `creation_walk`'s and the two legs are
  serialised — `api.mainnet-beta` rate-limits globally across methods. **`entry-cost-prohibitive`
  gates on the PER-LAUNCH median** (`entryCostPerSolStakedByLaunch`, decision 140a) — every launch
  counts once, so a busy launch cannot outvote the rest; the pooled per-entry distribution ships
  beside it as the finer-grained evidence and is not what the verdict reads. Re-derived from the
  committed tape over the **gated** (proven-opening) population, which is what the bar reads:
  per-launch median 0.0389 against a per-entry 0.0369, worst launch 0.3311, bar 0.12.
  **A launch the RPC ceiling cuts short is discarded whole**, because a truncated walk holds the
  earliest entrants by slot, which is a biased sample rather than a short one; and **a transport
  failure abandons the cost leg for that candidate only**, leaving `entry-cost-unmeasured` rather
  than aborting a run whose keyed allowance is already spent.
- **A landing tip paid in a SEPARATE transaction of the same bundle is in NO figure, and its absence
  is OPTIMISTIC.** It is not recoverable from the entrant's own transaction and is not in this repo's
  ground truth either, so every cost is a lower bound and every after-cost result an upper bound.
  `entry.mjs` → `LANDING_TIP_CAVEAT` is the one string; it must reach the score's caveats, the
  verdict's own sentence, the rendered block, the run record and the dry-run plan — **not just a
  doc**. Same for `WINNERS_ONLY_CAVEAT`: the tape only holds wallets that won the auction.
- **Stage 0 check 8 regression-tests the cost leg offline** (`stage0.mjs` →
  `verifyOnChainCostReproduction`), running the production `priceLaunchEntry` over
  `onchain_create_slot_pnl.csv`. **It prices the GATED population — proven openings only, the same
  launches `scoreEntry` scores** — because a regression guard over a neighbouring population is
  decision 140's defect shape. On the current tape: 110 launches, 618 round trips priced end to end,
  median entry cost 0.0308 SOL, field hit rate **0.7379 gross → 0.6117 net**, 81 sign flips; the
  unfiltered reading (113 / 631 / 0.7401 → 0.6070 / 87 flips, per-launch cost 0.0388 against the
  gated 0.0389 — i.e. *cheaper*, the optimistic direction) is printed beside it on every run. It
  asserts the *direction* — netting fees must move the field DOWN — because a sign error there would
  manufacture an edge silently. It deliberately does **not** assert that the net leg vetoes
  `7ufmve7Z…`: post-break its priced round trips are still 0.64 positive at +0.05 SOL net, so that
  wallet is refused by ROOM and only room.
- **`7ufmve7Z…` is the known-negative control, and it is load-bearing twice over.** Stage 0 asserts
  the gate **passes** it (it is competent) *and* that Stage 2 **refuses** it (it is not beatable —
  measured, `data/slot-zero-june-regime-change/report.md`). Any design that scores it as beatable is
  wrong; `runStage0` fails loudly, including if a later lane loosens `minRoomLeft` to fit an output.
- **Everything derived from the fill tape ALONE is GROSS OF FEES and is an upper bound.** The trap is
  concrete, not theoretical: gross, `7ufmve7Z…`'s post-break field reads **351/460 closed round trips
  positive**; fee-inclusive, that same regime made **+0.54 SOL per launch with 51 of 106 wallets
  negative**. So the field leg can only ever **veto** a verdict, never earn one — netting the
  measured cost sharpens the veto without changing its direction, because measured cost is itself a
  lower bound. Every P&L field name ends `GrossOfFees` or `NetOfMeasuredFees`, never neither, and a
  test enforces it.
- **A create slot with NO bundled transaction is UNPROVEN, and unproven launches are not scored.**
  The co-ordination rule marks every wallet in a create-slot transaction carrying 2+ distinct
  wallets, which is what makes the method work on a stranger — but how much of the operation it
  recovers is the *operator's submission habit on the day*, not a property of the rule: 0% of our
  subject's known cohort in Dec 2025–Feb 2026, 41.6% in March, 97–100% from May. Finding nothing is
  indistinguishable from there being nothing, and reading it as the second books ~9.6–10.0 SOL of the
  operation's own stake as outsider capital, which **inflates room — the only direction the rule can
  err**. Captain decision 134a: refuse to score them (`measure.mjs` → `roomIsProven`), which on our
  tape removes 24 of 24 false-positive rolling windows for 0 true positives and 81 unmeasured ones.
  Stage 0's **rolling replay** (`stage0.mjs` → `replayRollingRoom`) is the control and fails loudly
  if it reopens; the two slice checks structurally cannot catch it. `bundledTx` /
  `maxWalletsInOneTx` reach the score, record (added at **schema 5**) and rendered line so a saved run
  stays auditable — a schema-≤4 `entry.roomLeft` may be inflated and the record cannot say by how much, and
  a schema-≤4 `stage0` block is not comparable either (era-2 `n` moved 89→86 for the same reason).
  The predicate is **create-slot-scoped, not operation-scoped** — it is a floor on the evidence, and
  no tighter one exists: a deployer-in-bundle reading matches 0 of 235 launches because this deployer
  never shares its own create-slot transaction (decision 139a, `measure.mjs` → `roomIsProven`).
- **HOW OFTEN THAT REFUSAL FIRES IS MEASURED NOW, AND IT IS THE COMMON CASE: 1 candidate in 14.**
  `maxLaunchesPerCandidate` and `minLaunchesSampled` are both 8, so Stage 2 reaches a verdict only
  for a candidate whose most recent 8 eligible launches were *every one* bundled. Captain decision
  173a sized that with `tools/deployer-screen/bundling.mjs`, a **windows-only** pass that reports
  only `bundledTx` / `maxWalletsInOneTx` and spends **zero keyed requests**. Run 2026-08-03, **14
  gate survivors / 112 windows / 0 dropped**: per-launch bundling **18 of 112 = 0.1607**; **1 of 14
  bundles on all eight — and that one is our own control**, so among the 13 strangers it is **0 of
  13**. **11 of the 14 never bundle at all** (`maxWalletsInOneTx <= 1` on every window) and are
  therefore *permanently* unscoreable — counted apart from the 2 near-misses, because no
  `minLaunchesSampled` can reach them. Their own create slots are **not** quiet: over those 11
  candidates' 88 windows, median 4.0 wallets, max 26, and 72 of 88 held 2+ (over all 14 candidates'
  112 windows it is median 5.5, max 35, 96 of 112). So the rule's blind spot — co-ordination via separate transactions
  in one bundle — is most of what it meets. `census/2026-08-03-bundling-census.md` owns the numbers,
  the three cross-checks that make the zeros believable, and what they do and do not imply for the
  pinning; **the pinning itself is unmoved and is the captain's.** `--subject-era` answers the era
  question offline at n = 1: our subject went 0% (Dec–Feb) → 58.5% (Apr) → 98.1% (Jul), 175/235
  overall, so the rate is not stationary *for an operator that changes its habit*.
- **Stage 0's era-2 constant is `0.771`, not the published `0.768`** (decision 135c). `0.768` is the
  rank-43/44 order statistic of an 89-launch series whose median is `0.7708`; three recipes agree,
  including `analysis/window-population/measure.mjs`. **Never widen that tolerance instead** — it was
  absorbing a real −0.0115 defect and a +0.0028 documentation error that partially cancelled, so the
  check passed for the wrong reason. Correction recorded in the tape's `IMPORT.md` → "Corrections",
  never in the primary record itself.
- **Distributions plus a hit rate, never a mean** — a standing captain bar for this class of claim.
  Sniper outcomes are heavy-tailed on both sides, so a mean is a wrong answer rather than a rough one.
  A test asserts `entry.mjs` contains no mean in its executable half.
- **Only closed round trips have a P&L**, by the dataset's own rule (residual within 0.1% of tokens
  bought). Reproducing it from raw fills agrees with `wallet_launch_pnl.csv` on **1,502 create-slot
  outsider pairs, 0 closure mismatches, max error 5e-7 SOL** — checked in Stage 0 every run.
- **The run record is a VERSIONED CONTRACT: bump, never retro-edit.** Committed records are the
  grading lane's input; readers version-detect, and `test/deployer-screen.test.ts` asserts the exact
  key set PER version — for the candidate row, the `entry` block, (from schema 6) `entry.coverage`,
  the run-level `spend` and (from schema 9) the run-level `dune` block, its `dune.coverage`
  sub-block and every row of `dune.coverage.tables` — against the committed records themselves, as
  well as against `buildRecord`'s own source literal. Adding a field means a
  bump plus its assertions in **both** legs. **Every per-schema block pin follows ONE rule: the
  VERSION decides whether to assert, never the block's presence** — a `if (block !== undefined)`
  guard catches a key changing and misses the whole block being stripped or renamed, so a record
  whose version defines a key set must carry that block. The only licensed deviation is a value that
  is legitimately `null` (`entry` on an unscored candidate, `dune.coverage` on a run that never
  enumerated), and there the key's own presence is pinned one level up. The rule is stated in full
  beside the `spend` pin in `test/deployer-screen.test.ts`.
  **`record.mjs` and the README's schema table are two prose copies of the same contract and have
  drifted twice**; a test now pins them together, so move both in one commit. Current version:
  `RECORD_SCHEMA_VERSION` in `record.mjs`.

## Where candidate wallets come from, and the ceiling on that

`tools/deployer-screen/feed.mjs` — the scheduled discovery lane, long form in its `FEED.md`. It
supersedes the re-open monitor (captain, 2026-08-02: *a competent dev will not reopen a window*), so
**nothing here ever re-polls a wallet already graded — it is simply never offered as new again**;
`ledger.mjs` is that memory and `tools/deployer-screen/feed/ledger.json` is the committed state.

- **Discovery is 100% vendor-selected and no count the lane prints bounds what it cannot see.** Every
  candidate comes from a MadeOnSol enumeration endpoint, so a deployer they never profiled is
  invisible, not rare. **Measured consequence: a wallet in the ledger had already been deploying for a
  median of ≥132.7 days (max ≥857, n=74) before this project first saw it.** That figure is a lower
  bound and it exists only for wallets the vendor profiled — cite it, do not let it read as coverage.
- **The feed grades on the OWNERSHIP reading, so its failures are `held`, never `gate-failed`.** The
  creation-derived walk costs ~100 keyless RPC per candidate (or Helius credits when keyed) and this
  lane's bounds carry neither — it spends no Solana RPC at all. Ownership is biased
  towards rejection, so `held` is a triage outcome and `screen.mjs` stays the authority; every run
  prints the standing held count and the one-leg near-misses inside it.
- **Bounds are per-run and pinned in `thresholds.json` → `feed`: 3 enumeration + at most `--gate`
  keyed requests, zero keyless, and `--live` is required to spend anything.** The daily arithmetic
  (15 × 6 = 90 of ~200) is deliberately a minority share; raising the cadence without lowering the
  per-run ceiling makes this lane the allowance's largest consumer.
- **Exit 9 means the feed is dry or broken, not quiet** — a seed serving rows we read no wallet from,
  every seed inert, every gated profile unreadable (needs ≥2 gated, so `--gate 1` disarms it), or 3
  consecutive live, completed runs with no new wallet.
- **The queue is not yet wired into the screen**: `screen.mjs` enumerates its own candidates and has
  no wallet-list flag, so handing the queue over is an operator step today.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
