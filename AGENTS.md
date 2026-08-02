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
- **The one network-capable area is `tools/`, and the boundary is the directory.** `tools/deployer-screen/`
  holds a keyed MadeOnSol client; `test/deployer-screen.test.ts` asserts the other half of the
  boundary — no imports across `src/`↔`tools/`, only `client.mjs`/`pumpfun.mjs` may call `fetch`,
  only `credential.mjs`/`screen.mjs` may name `MADEONSOL_API_KEY`, and no file there may contain a
  key-shaped string. Duplicated curve constants between `src/index.ts` and
  `tools/deployer-screen/measure.mjs` are this boundary's deliberate cost — do not "fix" them by
  importing across it.
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
- **It sheds about a quarter of every request, and a client without retry cannot use it.**
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
  **The walk normally covers NO window at all** — 100 requests per candidate against 1,000-entry
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
  Helius/SolanaTracker/CoinGecko keys are production-shared and unchanged, as is keyless pump.fun
  pacing. `tools/deployer-screen/README.md` → "Bounds" owns the numbers and the endpoint list.
- **ToS §5a(b)/(d) bind us**: internal research only, and no accumulation beyond what is necessary.
  The screen derives and discards — per-token records live in memory for one run; only derived counts
  are ever written, and only with `--out`. Test fixtures are synthetic, never captured payloads.

## The deployer screen's stages, and the two wallets that keep it honest

`tools/deployer-screen/` — full scope, bounds and reproduction in its `README.md`. It answers the
captain's question *"can I beat the dev and all other wallets sniping the same tokens created by the
dev currently?"*, and the shape of the answer is the point:

- **Stage 1 GATES on competence** (keyed, MadeOnSol). **Stage 2 SCORES ENTRY** (keyless, pump.fun
  fills): room in the opening window, plus what every *other* sniping wallet there achieved.
  **Stage 3 — EXIT — is a separate lane and no exit signal may reach an entry number.** Room to enter
  is not room to leave, and one blended score cannot be read back apart.
- **Stage 2 spends no keyed request.** It reuses the mint list from the profile Stage 1 already paid
  for (`measure.mjs` → `toLaunchRefs`), so the shared vendor allowance is untouched by it.
- **`7ufmve7Z…` is the known-negative control, and it is load-bearing twice over.** Stage 0 asserts
  the gate **passes** it (it is competent) *and* that Stage 2 **refuses** it (it is not beatable —
  measured, `data/slot-zero-june-regime-change/report.md`). Any design that scores it as beatable is
  wrong; `runStage0` fails loudly, including if a later lane loosens `minRoomLeft` to fit an output.
- **Everything derived from the fill tape is GROSS OF FEES and is an upper bound.** The trap is
  concrete, not theoretical: gross, `7ufmve7Z…`'s post-break field reads **351/460 closed round trips
  positive**; fee-inclusive, that same regime made **+0.54 SOL per launch with 51 of 106 wallets
  negative**. So in the entry score the field leg can only ever **veto** a verdict, never earn one,
  and every P&L field name ends `GrossOfFees`.
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
  `maxWalletsInOneTx` reach the score, record (**schema 5**) and rendered line so a saved run stays
  auditable — a schema-≤4 `entry.roomLeft` may be inflated and the record cannot say by how much, and
  a schema-≤4 `stage0` block is not comparable either (era-2 `n` moved 89→86 for the same reason).
  The predicate is **create-slot-scoped, not operation-scoped** — it is a floor on the evidence, and
  no tighter one exists: a deployer-in-bundle reading matches 0 of 235 launches because this deployer
  never shares its own create-slot transaction (decision 139a, `measure.mjs` → `roomIsProven`).
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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
