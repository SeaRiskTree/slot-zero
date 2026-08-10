# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

`slot-zero` is a **public research repo** studying pump.fun launch microstructure (captain decision
377a: the method, the thresholds and the tapes are all world-readable, and none of them is to be
treated as confidential). There is no production here. It works over one primary dataset and holds a
loader for it — **the dataset itself is NOT in this tree**, see "Where the data lives" below. See
`README.md` for what is established and what is open.

## Build and test

- `npm test` — `tsc --noEmit` then `vitest run`. **Both halves matter**: the type guards in
  `test/type-guards.test-d.ts` are compile-time assertions that fail `tsc`, not `vitest`.
- `npm run test:unit` runs only vitest. No runtime dependencies; `npm ci` is dev-only.
- CI is `.github/workflows/ci.yml` (PRs and pushes to `main`): `npm ci` then `npm test` on
  Node 20 — the `engines` floor, not the dev box's version. That is the whole check set on
  purpose; there is no lint script and no coverage, audit or matrix gate to satisfy. The job's
  only other steps get it the tapes it cannot go green without — see "Where the data lives"
  below, which owns the modes and the manifest verification.
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
  governed by its own test, and there are six — three of them keyed. `tools/deployer-screen/` holds the
  keyed MadeOnSol and
  Dune clients; `test/deployer-screen.test.ts` asserts no imports across `src/`↔`tools/`, only
  `client.mjs`/`pumpfun.mjs` may call `fetch` (**a third vendor goes into `client.mjs`, not a new
  file — keeping that allow-list at two is what makes the ceilings auditable by reading two files**),
  only `credential.mjs`/`screen.mjs` may name `MADEONSOL_API_KEY` / `HELIUS_API_KEY` / `DUNE_API_KEY`,
  and no file there may contain a key-shaped string or assign a value to a credential variable.
  `tools/creation-census/` is the **second keyed** tool — it holds `DUNE_API_KEY` for the creation
  census, and `test/creation-census.test.ts` holds it to the same shape with `DUNE_API_KEY` alone
  allow-listed, to `credential.mjs` alone. `tools/venue-label/` is the **third keyed** tool and the
  smallest — it holds `HELIUS_API_KEY` for the Wallet Identity endpoint, and
  `test/venue-label.test.ts` holds it to the same shape with `HELIUS_API_KEY` alone allow-listed, to
  `credential.mjs` alone, plus a **host allow-list of one** (`api.helius.xyz`) asserted as a set.
  `tools/graduated-life-tape/`, `tools/arrival-rate-walk/` and `tools/window-decay-tripwire/` are
  **keyless throughout** — `test/graduated-life-tape.test.ts`, `test/arrival-rate-walk.test.ts` and
  `test/window-decay-tripwire.test.ts` hold them to the same shape with the credential allow-list
  **empty**, which is what makes captain decision 112a's "EUR 0" a property of the tree. The walk and
  the tripwire each additionally pin a **host allow-list** of two keyless hosts, asserted as a set
  rather than as a ban-list: `swap-api.pump.fun` and `api.mainnet-beta.solana.com` for the walk,
  `swap-api.pump.fun` and `frontend-api-v3.pump.fun` for the tripwire, which its client refuses to go
  outside. Duplicated curve constants between `src/index.ts` and `tools/deployer-screen/measure.mjs`, the
  duplicated client across all five tools — keyless in four, and a **keyed Dune** copy in
  `tools/creation-census/`, which also copies `COHORT_SQL` and its readers verbatim rather than
  importing them — and the duplicated segmentation between
  `analysis/window-population/measure.mjs` and `tools/arrival-rate-walk/arrival.mjs`, are this
  boundary's deliberate cost — do not "fix" any of them by importing across it. The segmentation copy
  is held together by a **reproduction test**, not by discipline: the tool's own code must return the
  published break dates over the committed tape. **The copies have now DIVERGED in the RULE, not
  only in the code**: captain decision 182a widened the screen's co-ordination rule to a union, and
  `tools/arrival-rate-walk/series.mjs` → `roomIsProven` and `tools/window-decay-tripwire/` both
  deliberately keep the narrower shared-transaction predicate, because 182a's room readings were
  verified against the one deployer whose cohort is named and those two lanes run on strangers and
  on published backtest constants respectively. Each file says so at its own `roomIsProven`; do not
  reconcile them without a decision.
- **`analysis/` is a third area and it is offline like `src/`.** One-off measurements over the
  local tape that are neither library nor tool. `test/window-population.test.ts` scans it for
  sockets, `process.env` and key-shaped strings, and asserts no imports across `analysis/`↔`tools/`.
  It parses the CSVs itself rather than importing `src/`, for the same build-step reason `tools/` does.
- `tools/`, `analysis/` and `config/` are plain `.mjs` with JSDoc types so they run on the Node 20
  floor with no build step; `tsconfig.json` covers them with `allowJs`+`checkJs`, so `tsc --noEmit`
  checks them too.

## Citing a report this repo does not hold

**NOTHING IS UNDER `data/` ANY MORE, so EVERY `data/…` citation is a dead path** — it renders as a
file the reader can open, and there is no such file. Two different things end up spelled that way
and both are wrong now:

- **A companion report or decision record.** These have always lived in firstmate's records, outside
  this tree, so `data/<report-name>/report.md` never resolved. `README.md` → "None of the eight
  companion reports" states the standing position: none of them is committed here, so any figure
  attributed to one is evidence from elsewhere and is asserted by no test in this repo. That is a
  deliberate boundary, not an oversight; **do not import one to make a citation resolve** — bringing
  an external document in has a licensing and provenance dimension and is a captain decision.
- **A file inside a TAPE** — `report.md`, `IMPORT.md`, `launches.csv`, a `window/*.meta.json`. These
  did resolve until dry dock phase C untracked the tapes for repository hygiene. They are real files
  and they still exist; what they are not is a path in this tree.

**The form, and it is enforced:** name the thing *without* a `data/` prefix and say where it lives.
For a report — `` `slot-zero-june-regime-change` §6.1 (held in firstmate's records, not in this
repo) ``; `tools/window-decay-tripwire/detector.mjs` is the model. For a tape file, the dataset's own
name IS the location, because that is how a data root is addressed:
`` `population-tape-2026-07-29` → `IMPORT.md` `` (captain decision 356a settled that shape for a
printed census label, and it is the same shape here). **Prefer an in-repo route when one exists**,
because a reader can check it: `analysis/window-population/` re-derives the June report's
2026-06-04 close and its closed-regime prize from the tape, and
`test/window-population.test.ts` asserts both — so claims resting on that break cite §4.1/§4.3
there rather than the external report.

`test/citations.test.ts` fails on any `data/**/*.md` citation that does not resolve on disk. It
carries a **pending allow-list** of the sites that predate it, each of which must still contain the
dead path it is listed for — so the list cannot go stale, and it is the worklist for retiring them.
A citation added from today is not on that list and fails immediately. **Adding an entry to it is
not how you make the check pass**; fix the citation.

## Where the data lives — one owner, and it is NOT `data/`

**`config/data-root.mjs` is the single owner of where the tapes are read from, and it is its own
area for two structural reasons.** It reads one environment variable, `SLOT_ZERO_DATA_ROOT`, and
`src/` and `analysis/` are both banned from reading ANY variable by `test/offline-guard.ts` — the
guard that makes "this repo reads no credential" a property rather than a promise. And `src/`↔
`tools/` and `analysis/`↔`tools/` imports are forbidden in both directions, so a resolver under
`tools/` could not be the one owner. `test/data-root.test.ts` governs the new area on the same
terms as the others: no socket, no key-shaped string, no credential variable named, **exactly one
environment variable read**, and no import from `src/`, `analysis/`, `tools/` or `test/`. That
env-var guard is a source-text scan with no dataflow analysis, so what it proves is that the
DIRECT spellings are checked — a floor on the evidence, `roomIsProven`'s shape one area over — and
a read it cannot resolve to a name fails the guard rather than passing as nothing. The test's own
doc owns that bound; cite it rather than restating it.

- **Ask it; never compose a path.** `POPULATION_TAPE_DIR` / `GRADUATED_LIFE_TAPE_DIR` for the two
  datasets, `datasetDir(name)` for either, `requireDataset(name, dir)` at the point a reader opens
  its FIRST file — that last one is what turns "there is no data here" into a sentence naming what
  is missing, where it was looked for and how to point elsewhere, instead of an `ENOENT` five
  directories down. A test scans `src/`, `analysis/`, `tools/` and `test/` for a dataset name in
  executable text and fails on a new one; its allow-list holds exactly one entry, and it is a
  printed report label rather than a path.
- **THE TAPES ARE NOT IN THE TREE, AND THE REASON IS REPOSITORY HYGIENE — nothing else.** Dry dock
  phase C untracked all 705 files (118 MB of an 833-file tree) and `.gitignore` names the two
  dataset paths so they cannot be re-added by accident; every clone stopped paying for them. They
  are in this repository's public commit history and untracking cannot un-publish them, so **no
  confidentiality is claimed by the move and none is bought by it** — do not let any document say
  otherwise. They are published as the **public** `slot-zero-data.tar.gz` asset on the
  `data-2026-08-02` release, beside phase A's `MANIFEST.sha256`.
  **"THE COMMITTED TAPE" STILL MEANS WHAT IT ALWAYS MEANT and phase C did NOT rewrite the ~290
  places that say it.** Read it as *the pinned, dated snapshot every published number here is
  computed over* — as against a live vendor read — not as a claim about git. Renaming it would churn
  test names, run records and measurement records, several of which may not be retro-edited, and
  would move no path; what phase C corrected instead is every reference that named a `data/…`
  LOCATION, since those are the ones a reader can follow and find nothing.
- **`DEFAULT_DATA_ROOT` is therefore `~/slot-zero-data`, not `<repo>/data`.** Phase B kept the
  default in-repo because CI was `actions/checkout` and nothing else; phase C settled that by
  pointing CI at the release and untracking the copy the old default named. It is derived from
  `OFF_REPO_DATA_ROOT_HINT` rather than written out twice, so the resolved path and the path every
  error message prints cannot drift. **Neither default resolves in a bare clone** — the data is
  genuinely not there — which is what `missingDatasetMessage` is for; it now offers the FETCH first
  and the variable second. The module's own doc owns the argument; cite it rather than restating it.
- **Both configurations are proven, not assumed.** The default root with nothing set — rehearsed by
  phase C from a fresh clone carrying no `data/` at all, with only the release asset unpacked — and
  an explicit `SLOT_ZERO_DATA_ROOT` pointed at a copy kept elsewhere are both green, and a root
  pointed at nothing fails **12 of the 18 suites as measured 2026-08-05 at 354a; the repo now has
  19**, and which of them fail against an empty root has not been re-measured since — outstanding
  work for a follow-up lane. That count is also the measure of how much of this suite is data-bound,
  and the reason CI cannot simply lose the tapes.
- **Two readers used to build paths by concatenation** (`analysis/window-population/measure.mjs`,
  `tools/window-decay-tripwire/tape.mjs`) and depended on a trailing separator. The resolver returns
  none; those sites use `join()` now and a test pins the absence.
- **THIS PROJECT'S TESTS ARE POPULATION ASSERTIONS, NOT FIXTURE TESTS — do not propose sampling the
  tapes for testing, and do not re-measure it** (captain decision 354a, which records the
  measurement in full). A properly stratified subset was built and run: 13 strata over regime ×
  graduated × committed window width × coverage, densest and sparsest create slot in each,
  **23 launches / 94 files / 16 MB**. Result: **138 tests failed across 11 of the 18 suites as
  measured 2026-08-05 at 354a; the repo now has 19** — and 354a's own instruction not to re-measure
  stands, so read every figure in this bullet as that dated reading. It converted
  **exactly one** suite over having no data at all (`data-root`, which only needs the
  directories to exist), and — the decisive part — **it changed a published finding**: the blind
  changepoint scan returned `2026-03-26T16:10:24Z` against the published `2026-03-14T17:28:20Z`.
  The failures are `toHaveLength(239)`, 46,553 pair rows, 107,439 fills, 1,999 create-slot pairs,
  123 priced launches, 103 graduated — no subset satisfies them, and `counterparties.csv` (2.8 MB,
  20,388 wallets) has **no `mint` column**, so it cannot be subsetted by launch at all.
- **CI therefore FETCHES the tapes, and the fetch is verified.** `.github/workflows/ci.yml` reads
  the repository variable `SLOT_ZERO_DATA_SOURCE` and since phase C has ONE mode: `release`
  (default) — the **public** `slot-zero-data.tar.gz` asset on the `data-2026-08-02` release, public
  because this repository is. `repo`, the copy in the tree, is **RETIRED and rejected by name** with
  that reason, because there is no copy in the tree; an unrecognised value fails the job as before,
  rather than falling through to anything. No credential is involved — the run's own
  `secrets.GITHUB_TOKEN` at `permissions: contents: read` is the whole of it. **`config/verify-data-root.mjs`
  walks the store's own `MANIFEST.sha256` and fails on a missing file, a wrong digest, OR AN EXTRA
  FILE the manifest never listed** — that third one is why it is a script and not `sha256sum -c`:
  several suites choose their population with `readdirSync` over `window/` and `life/`, so a
  partial fetch raises no `ENOENT`, it moves a published number. README → "How CI gets them" owns
  the provisioning commands; **populating the store is a captain step**, and the archive compresses
  by only ~7% because 342 of the 705 files are already gzipped.

## The dataset

`population-tape-2026-07-29` is a **primary record — never reformat, re-sort or
"clean" a row.** Column semantics are in its `README.md`, findings in its `report.md`,
import, exclusion and **correction** decisions in its `IMPORT.md`. `sigindex/` (97 MB of raw
RPC signature cache) and a superseded `tape/` probe were excluded; everything else is
verbatim. When later evidence contradicts the imported prose, add to `IMPORT.md`
→ "Corrections"; do not edit `report.md` or the dataset `README.md`.

**WHICH DATASETS THAT NEVER-EDIT RULE PROTECTS** (captain ruling 186a; full record
`slot-zero-bundling-predicate-question` → `decision-182a-gradtape-figure.md`, held outside this
repo — see "Citing a report this repo does not hold" below). The protection
attaches to an **imported primary record**, marked by an `IMPORT.md` plus explicit
primary-record / never-reformat-a-row language — `population-tape-2026-07-29` is the
example. A dataset **produced by this repo** carries no `IMPORT.md`, and its prose is ordinary
documentation and editable; `graduated-life-tape-2026-08-02` is one, and 186a authorised
editing its cross-reference sentence. Either way the scope limit is the same: **a data row and
its formatting are never touched.** And the rule's last clause is first-class, not a footnote —
**if you are unsure which kind you are facing, stop and ask.** The cost of asking is one round;
the cost of editing an imported primary record is the record.

**THE TAPE'S WINDOW IS NOT A FLAT 60 s — it is per launch, and assuming otherwise has already
produced wrong published statements more than once.** Read each launch's own
`window/{mint}.meta.json` → `window_ms` before any per-launch rate, uplift or page-count aggregate;
the distribution and the accessor are below, "The tape past the bond".

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

Six data hazards callers must not undo — the first three the loader handles, the last three are
permanent limits of the evidence:

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
- **A SHARED VENDOR ARTEFACT NEVER ATTRIBUTES A WALLET TO AN OPERATION — a metadata host, a fee
  account, a deploy preset, a description string.** Before calling any artefact "the operator's
  own", count the distinct unrelated wallets that also carry it; on pump.fun that count is free, and
  where it has been measured the answer came back in the dozens inside a single 33-minute live
  sample. **This trap fired twice in two days and both times it reached
  committed prose**: `meta.uxento.io`, named in `README.md` and `src/cohort.ts` as "the operator's
  own metadata host", is a commercial third-party deploy platform (23 unrelated creator wallets in one
  33-minute live sample, thousands of launches a day, and this operation in none of them), and the
  cohort genesis's "same tool fee accounts" were never shared — the only account common to all three
  launches is pump.fun's own protocol fee recipient, which every launch pays. Both clauses are now
  deleted and `src/cohort.ts` → `CREATE_SLOT_COHORT` carries the discriminators that actually hold
  (behavioural and on-chain, no vendor involved). Captain decision 371a; the measurements are
  `slot-zero-uxento-host-reexamine/report.md` and
  `slot-zero-fee-accounts-protocol-or-tool/report.md`, both held in firstmate's records, not in this
  repo — the second's §5.3 (*is this thing reached by unrelated third parties?*) is the general form
  of the test.
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

`graduated-life-tape-2026-08-02` extends the population tape from its own per-launch window to
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
  On the graduated 103 it is 60 s on 83, 120 s on 3 and 300 s on 17 (whole tape: 210 / 4 / 25 of
  239) — `window_ms` in `population-tape-2026-07-29/window/{mint}.meta.json`, exposed by
  `launches.mjs` → `readWindowMeta`. Hardcoding 60 s overstated this uplift by ~6 points before it
  was caught, and `coverage.csv` now carries `committed_window_s` per launch so a reader can see the
  cut applied.
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
`README.md`; the investigation behind its shape is `slot-zero-cursor-gap-walk-blast` → `report.md`,
held outside this repo (see "Citing a report this repo does not hold").
Five things bind anything that touches it or copies from it:

- **A WINDOW WALK GETS ONE BOUND, IN ONE UNIT — copy `walk.mjs`, never `readLaunchWindow`.** The rule
  stands; the instance behind it is now **FIXED, and the fix is what a copier must not undo.**
  `tools/deployer-screen/pumpfun.mjs` used to seek in **milliseconds** (`createdAtMs + windowMs +
  seekMarginMs` = 65,000) and decide membership in **slots** (`createSlot + windowSlotSpan` = 160),
  reconciled only by a nominal 400 ms/slot with ~1 s of headroom. The chain drifted past it: p50
  389.0 ms/slot in 2025-12 against **418.0 in 2026-07, max 446.55**, so 160 slots ran up to 71.4 s
  against that 65 s reach and the walk never fetched the tail — while reporting `usable: true`,
  `reachedCreateSlot: true` and a note true in every clause. Measured cost: **354 in-window fills,
  161 of them sells, across 102 launches**. It moves §2.1's create-slot series by *nothing* (identical
  to seven significant figures) because create-slot outsiders close early; it moves an all-entrant
  reading by 69 pairs / 17.1 SOL. **Captain decision 144a closed it** (PR #38): the seek is now
  `pumpfun.mjs` → `windowReachMs`, derived from `windowSlotSpan` in the span's own unit at
  `MAX_MS_PER_SLOT` 500 (`MEASURED_MAX_MS_PER_SLOT` 446.55 × a stated 1.1 margin), with `windowMs`
  surviving only as a floor — **85,000 ms at the pinned values**, and re-derived from both committed
  tapes by a test on every run rather than pinned in prose. **That function's doc is the OWNER** of
  the reach, the page cost it buys (p50 5→6, p95 8→9, max 14→17 pages over the 127 committed launches
  that can show it, and 4 of them now dropped as `request-cap` where it was 0) and the drop's
  consequence; cite it rather than restating any of those figures. The one-bound design is still the
  thing to copy, because it removes the class instead of bounding it:
  `tools/graduated-life-tape/walk.mjs` and `tools/arrival-rate-walk/walk.mjs` both use
  `seekCursor(endMs)` + `tsMs <= endMs` and can never acquire a second unit to reconcile.
  **KNOWN CAVEAT, DO NOT RE-DERIVE: the `windowSlotSpan` justification's "~63.5 s" is history, not a
  live bound.** It converts 160 slots at the tape's old ~397 ms/slot. `thresholds.json` →
  `stage2_entry.justification.windowSlotSpan` and `…windowMs` and `tools/deployer-screen/stage2.mjs`
  now all say so in place and point at the 71,448 ms the same span is worth at the measured
  446.55 ms/slot maximum — **read the bound, not the median.** What is still open is only the
  re-derivation: the ~63.5 s figure and the "~3.5 s wider than the tape's 60 s windows" claim resting
  on it belong to a separate consolidation lane, so read them as an underestimate and do not patch
  them in passing. **The two bounds that reach forward from the mint are now ONE derivation, and the
  second failure is the lesson to carry, not the first.** Stage 2's eligibility gate — "is this
  launch old enough to have finished happening" — was a hand-written `windowMs + seekMarginMs` =
  65,000 ms that 144a's own fix left behind: 6,448 ms short of the span at the measured rate and
  20,000 ms short of the reach, so a launch could be admitted 20 s before the cursor's own bound was
  in the past, and the guard on it (`windowSlotSpan × 400 ms <= windowMs + seekMarginMs`) was
  denominated in the variable that did not move, so it stayed green while ceasing to mean anything.
  **Raising the constant to 71,448 would have re-armed the identical trap** — the defect is writing a
  DURATION for something the chain controls. `stage2.mjs` and `tools/deployer-screen/bundling.mjs`
  therefore write no duration at all: since captain decision 260a they **ask their fill source**
  (`fillSource.minAgeMs`), and the swap-api source answers with the same `windowReachMs` call the
  cursor is placed with, so the gate and the cursor are still one number by construction — see the
  260a bullet under "The deployer screen's stages" for the injection. A test reads the gate out of a
  live `scoreCandidateEntry` and checks it against the tape-derived rate on every run. It changed no
  committed reading — the last real run's youngest launch was ~1.95 h old
  against an 85 s gate — and the error it closed ran toward wrongly REFUSING a deployer, which is the
  permanent, invisible direction, since a graded wallet is filed and never offered again.
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
- **The lane is still keyless, and its cohort SQL is now DEPLOYED — executed from OUTSIDE this
  directory.** `cohort.mjs` → `COHORT_SQL` is saved Dune query `8214953` (captain decision 187a) and
  `bounds.json` → `dune.cohortQueryId` pins it, but this directory's credential allow-list is empty
  and a test enforces that, so it cannot execute its own statement: `tools/creation-census/` is the
  keyed half that does — see `tools/creation-census/README.md`. **The slot-exhaustion reason once
  recorded here was false** — see the Dune section's "10 PRIVATE
  QUERIES" entry for how to re-check the count. The launch-list leg reuses the screen's existing
  `8204672` **unchanged**. Everything else is proven on a bounded sample: 5/5 create slots and exact
  fill counts against the committed tape (25 requests, 0 shed), and `arrival.mjs` reproduces §4.1's
  break dates, §4.3's three regimes and §5's 82.7-day window offline.

## pump.fun / Solana provider facts

Learned at real cost; the citations are to
`population-tape-2026-07-29/report.md` unless stated.

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
- **`sid` decomposes exactly: `slot(12) + blockTxIndex(6) + innerInstructionIndex(4)`** — validated
  over all 2,699 create-slot fills of the committed tape; `tools/deployer-screen/measure.mjs` →
  `blockTxIndex` and `slot-zero-bundling-predicate-question/report.md` §3.1 own it, and a later
  957-fill check agrees. **Read it as a STRING SLICE, never as a number**: `Number(sid.slice(0, 12))`
  for the slot (`tools/arrival-rate-walk/trades.mjs`, `tools/window-decay-tripwire/createslot.mjs`),
  `sid.slice(-10, -4)` for the index. A 22-digit `sid` is past `Number.MAX_SAFE_INTEGER`, so
  arithmetic on it can round a fill down into the previous slot. The low 10 digits order fills
  *within* a slot and are not a timestamp — never difference two `sid`s as a duration.
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
  the walk. **A THIRD vendor pair shows the same shape and the screen does NOT backdate against
  it**: Stage 2's mint times come from **MadeOnSol**'s `profile.pump_tokens[].created_timestamp`
  (`measure.mjs` → `toLaunchRefs`), and the first full-day default run dropped **6 windows on one
  candidate** to the pre-mint tripwire — 6 of the 7 drops that took it from 10 planned windows to 3
  walked.
  Whether `screen.mjs` should pin the same 5,000 ms is open and is a decision, not a passing fix;
  `runs/2026-08-04-full-day-default.md` → "Two things that went wrong in the plumbing" owns the
  observation and states what is and is not proven about the cause.
- **Per-launch request budgets: p50 4 pages, p90 8, p95 13, max 24** (same metadata; fills p50
  381, max 2,321). Bound a walk by **requests, not pages**, or the shed rate makes the true cost
  ~3x the plan.
- **Every pump.fun surface answers "who OWNS this now", never "who CREATED it".** §1.2 and
  `kol-deployer-entity-cluster/report.md` §6. Ownership is a sellable position — the owner collects
  the creator fees — so the ones that move on are the winners, and a listed history understates
  launches, understates *bonded* launches by more, and therefore **scores the better dev worse**.
  The COUNT bias runs towards rejection, and a false rejection is invisible — but **a RATE computed
  from that same page runs the other way** and both directions are measured; see "Where candidate
  wallets come from" below before calling the ownership reading conservative. Confirmed on-chain
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
- **`is_mayhem_mode` IS A SIXTH COLUMN, AND SINCE CAPTAIN DECISION 351 IT DECIDES EXACTLY ONE THING:
  A MAYHEM LAUNCH IS EXCLUDED FROM BOTH SIDES OF `minCompletionRate`** (schema 19, thresholds 6.8.0;
  it REVERSES 227b, and **227c — dropping a mayhem-heavy DEPLOYER outright — is NOT reversed and
  remains DECLINED**). A mayhem graduation raises a median **0.291 SOL** against **85.005** for a
  classic curve one — 292x cheaper, indistinguishable in trade data from a token that churned ~$1,700
  and died — and mayhem supplied **46.41%** of 2026-07's pump.fun graduations, so the bar that IS the
  gate had been counting two achievements through one number. `measure.mjs` → `measureCompletion`
  owns the rule and every argument; `dune.mjs` → `MAYHEM_NOT_COMPETENCE` is the one sentence, printed
  once per run. **The denominator half is what keeps this out of 227c** — numerator-only drives a
  mayhem-heavy deployer's rate to 0.0000 and removes them, which is 227c by arithmetic — and it is why
  `tokens`, `completed`, `completionRate` and `spanDays` are ALL the non-mayhem reading now, so **a
  schema-≤18 rate is a different quantity and must not be pooled with a schema-19 one**. Beyond the
  gate nothing reads the flag: 227a's per-candidate SHARE is still an observation, and no Stage 2 bar
  or verdict touches it. **Four traps.** An **unreadable** flag is KEPT in the competence denominator
  and counted (`competenceMayhemUnreadable`; equal to `tokens` AND `competenceMayhemExcluded` 0 ⇒ the pre-351 reading, both conjuncts) — dropping it
  would empty the denominator of every walk-sourced candidate on evidence about the SURFACE, the
  permanent invisible direction — so 351 is inert on every route that cannot see the column. An
  **all-mayhem** deployer reads **UNMEASURED, never 0.0000** (`rank.mjs` → `competenceEmptiedByMayhem`
  → `gate-unmeasured`): zero of zero is an absent measurement. A malformed value folds to `null`
  rather than refusing the row, unlike `bonded`/`launches_total` — a refused row refuses the WHOLE
  batch into the walk, which cannot see the column at all, and folding can only return the gate to
  its pre-351 rate, never REMOVE a launch. And the two denominators are **different and legitimately
  differ**: `creation.mayhemShare`'s is `mayhemFlagReadable` over what the ENUMERATION returned (101
  of the subject's 252 launches read `null`, and all three fields are `null` — UNMEASURED, not 0% —
  on a walk-sourced candidate), while 351's counts are over the MERGED history the gate read.
  **The 112, the 58 and the monthly gate populations below are PRE-351 pooled readings and must be
  re-derived rather than adjusted** — `slot-zero-rederive-gate-population-post-351`, a separate lane
  which is now also PRE-352b and must re-derive under the measure as adopted.
- **A FAILED EXECUTION IS STILL BILLED AND IS TERMINAL — AND "FREE IF IT FAILS" IS TRUE ONLY OF A
  STATEMENT THAT FAILS TO *COMPILE*.** Dune bills compute by engine time consumed: a statement the
  planner rejects consumes none and costs nothing, and a statement the planner ACCEPTS and cannot
  finish consumes the vendor's whole **30-minute** limit and is billed for it. Both come back as
  "failed". **Measured 2026-08-08: 180.002 credits for an execution that returned no rows**, read off
  the free `POST /usage` counter either side with no other execution in flight (219.825 → 399.827)
  and re-read after settling — so ~**6.0 credits an engine-minute**, an inference from one reading
  and the only pricing there is. **Iterate on COMPILE errors, which return in seconds; a failure that
  takes minutes to arrive is the most expensive thing on this account.** Two more measured facts from
  the same lane, both cheap to fall into twice: `information_schema.columns` filtered with
  `table_schema IN (...)` is the shape that did not finish in 30 minutes while the identical read
  with `table_schema = '<literal>'` returned in seconds (stated as an inference about predicate
  pushdown, not as confirmed engine behaviour); and **the account behind `DUNE_API_KEY` has ZERO
  private query slots** — `POST /api/v1/query` with `is_private: true` returns `402 Max number of
  private queries reached` while `GET /queries` reports `total: 0` — so **a scratch probe must be
  created as a PUBLIC query or a lane cannot run at all**, and `run.mjs` → `deploySavedQuery` still
  sends `is_private: true`, which is recorded in `bounds.json` → `justification.dune.privateQuerySlots`
  and not acted on. Evidence: `slot-zero-venue-gradeability-inventory` → `report.md` §0, held in
  firstmate's records, not in this repo.
- **A PRE-FLIGHT ALLOWANCE CHECK CANNOT BOUND AN EXECUTION, AND CAPTAIN DECISION 381 (2026-08-08) IS
  BOTH HALVES OF THE ANSWER.** The guard refuses a plan whose *pinned* worst case does not fit; the
  spend happens after it passes, and Dune caps a single execution's cost nowhere — so the protection
  was only ever as good as the pin, and the pin was a guess. The lane that proved it was not careless:
  it ran behind this repo's own guarded path with the live counter re-read before every execution and
  printed `verdict: sufficient (ok=true)` against a pinned worst case of 6. **(1) The pin is now
  derived from the vendor's ceiling, not from our statement**: `dune.worstCaseCreditsPerExecution` is
  **200** in *both* keyed bounds files (was 25), from `client.mjs` →
  `executionDeadlineCredits(ENGINE_TIMEOUT_MS)` = 181 plus ~10% for n = 1 on one engine size, and
  `test/dune-credit-ceiling.test.ts` pins both at or above that floor and pins them equal. It changes
  what the lanes can PLAN — a default census reserves 224.51 credits rather than 49.51 and a period
  affords ~17 reserved runs rather than ~80; the screen's leg reserves 690.4 rather than 340.4 — while
  a real run of either still costs single-digit credits. **(2) The deadline is what actually caps one
  execution**: `dune.executionDeadlineMs` is 120,000 ms in both, exactly the give-up point both poll
  loops already had, and what changed is that giving up now issues `POST /execution/{id}/cancel`
  instead of walking away from a live engine. **Cancelling bounds the WAIT for certain and the BILL
  only if Dune stops the engine on cancel — undocumented, and settling it costs a runaway execution,
  so it is not claimed**; that is exactly why the pin stays at the engine floor. Worth **13 credits**
  per execution at the default if cancelling does stop the clock, which is the figure to size a lane
  from. Abandonment is its OWN outcome (`DuneExecutionAbandoned`, census exit **5**, distinct from the
  vendor's exit 4) so an operator can tell *we stopped this* from *this broke*, and **no path leaves a
  live execution running** — a request ceiling or transport failure mid-poll cancels too and rethrows
  its own error unchanged. Cite each lane's `justification.dune.worstCaseCreditsPerExecution` and
  `…executionDeadlineMs` rather than restating the arithmetic. **The two per-execution pins this did
  NOT move are recorded where they live**: `entry_source_agreement.worstCaseComputeCreditsPerExecution`
  (1) cannot take the engine floor and stay plannable at 82 executions, and repricing an unactivated
  Gate 3 leg is that decision's; `dune-reproduction.mjs` → `WORST_CASE_CREDITS_PER_EXECUTION` moved
  10 → **61**, the floor its own 600 s deadline buys.
- **Budget from *billed* credits, not
  `execution_cost_credits`, which understates by ~3.5×** — retrieving results is ~71% of the bill at
  ~20 credits/MB. Hence: aggregate server-side, select only the columns the tool reads (dropping the
  create tx and graduation timestamp halved the payload to **~97 bytes/row** at FOUR columns; the SQL
  selects **six** today and re-measures at **105.9 bytes/row** at BOTH read shapes against a pinned
  121 ceiling that therefore does not move — `CREATION-DERIVED.md` §8.2c owns those figures, retires
  the old ~115 five-column reading as non-reproducible, and states the live tripwire: **headroom is
  now 15.08 bytes, less than one more boolean column is worth, so a SEVENTH column must re-measure
  and raise the pin**), one execution for the whole batch, and a **cached** probe read by default.
  **A FAILED PROBE EXECUTION NO LONGER TAKES THE LEG WITH IT** (captain decision 298a):
  `readCoverageProbe` falls back to Dune's **cached** result, which costs no execution — a READ, never
  a retry, and the never-retry rule above is exactly why (`maxExecutionsPerRun` is 2, so a retry would
  spend the enumeration's own remaining execution to buy the same answer). Its signature in a record
  is `dune.executions` ≥ 1 beside `dune.coverage.fromCache: true`.
- **LOSING THE WHOLE DUNE LEG IS A SPEND CLIFF, NOT THE SLOWER ROAD THE DESIGN INTENT DESCRIBES, AND
  IT IS NOW REFUSED BEFORE IT IS PAID** (captain decision 298a, 2026-08-06). Measured from records
  committed here: `runs/2026-08-04.json` lost its leg to a failed probe execution and spent **221,731
  Helius credits / 3,941 RPC requests** over 82 candidates; the 2026-08-05 untiered leg spent
  **232,937 over 76**, against **1,924 over 69** for the leg that kept its answer.
  `creation_walk_helius.maxCreditsPerRun` catches none of it and cannot — it is sized for the walk
  being the INTENDED route, so it already reserves every candidate walking. Two guards, and **neither
  distrusts the walk**, which is the correct answer to a Dune refusal and the only surface that says
  who holds a curve today: (1) `dune.mjs` → `walkFallbackReasons` puts a sentence on EVERY candidate
  that fell back while the leg was asked — a whole-leg one starts with the `dune-leg-failed:` marker —
  so `duneFallbackReasons` empty now means only "Dune answered" or "Dune was never asked"; before
  this, all 82 candidates of `runs/2026-08-04.json` read empty and a per-candidate cost model built
  from that record described the DEGRADED path while looking like the normal one, by ~3 orders of
  magnitude. (2) `priceWalkFallbackCliff` prices the whole-batch fallback against the plan that was
  made and `screen.mjs` refuses the run (exit 2, before the first walk request) past
  `dune.legFallbackCliffMultiple`, unless `--allow-walk-fallback`. **Cite
  `thresholds.json` → `dune.justification.legFallbackCliffMultiple` and the tool README's "A
  WHOLE-LEG Dune failure is a spend cliff" rather than restating the figures**; the baseline share is
  re-derived from the two committed legs by a test. The guard first bites at 9 candidates and is inert
  below that, and inert on a run that never asked Dune.
- **THE MONTHLY CEILING IS NOW CHECKED BEFORE A RUN SPENDS, NOT DISCOVERED BY HITTING IT — and the
  period is NOT a calendar month.** `POST /api/v1/usage` is free (a metadata endpoint that consumes
  no credits), reports `credits_used`/`credits_included` per **billing period**, and this account's
  period was measured running **2026-07-29 → 2026-08-29**, i.e. it resets on a subscription
  anniversary. Both keyed lanes read it before their first billed request — the coverage probe
  included, since a result read is billed by bytes — price their own CEILINGS in credits, and
  **refuse rather than half-run**: the screen falls back to the RPC walk, the census defers.
  An unreadable balance refuses too; it is not headroom. **The guard is one text duplicated byte for
  byte in both `client.mjs` files** (neither keyed tool may import the other) and
  `test/dune-credit-ceiling.test.ts` pins the copies together and owns the refusal regression —
  read it, and each tool's README section "The monthly credit ceiling", rather than restating the
  numbers. **Three things it cannot see, and they are on every verdict:** the counter LAGS (measured
  +6.0 credits while idle, whole-credit jumps, so a reading over-states what remains — hence a pinned
  reserve); a reading is ONE ACCOUNT's — the key is unshared, but every lane of this fleet draws on
  that account and a second key is a second account entirely — so a sufficient reading is evidence
  and never a reservation; and Dune
  publishes NO price table for execution compute, so `worstCaseCreditsPerExecution` is a per-lane pin
  against measured executions of *these* statements — **a query that grows a `dex_solana.trades` join
  is ~9x it with nothing else failing** (measured: 0.75–0.92 credits for the creation queries against
  81.74 and 221.51 for two trade-tape joins). **One field name is an ASSUMPTION**: Dune's docs say
  `billing_periods` in the schema and `billingPeriods` in the example, no live response has been seen
  from here, and both are accepted — narrow it if one is ever settled, do not widen it.
- **THE CEILING A RUN IS PRICED AGAINST IS THE SMALLER OF TWO REAL NUMBERS, AND THE CAP LIVES IN
  CONFIGURATION** (captain decision 322a, 2026-08-06). One is the vendor's `credits_included` for the
  billing period; the other is the CAPTAIN'S OWN fleet-wide monthly cap, pinned as
  `dune.monthlyCreditCapCredits` in **both** `tools/deployer-screen/thresholds.json` and
  `tools/creation-census/bounds.json` — never in a `.mjs`, and `test/dune-credit-ceiling.test.ts`
  pins the two equal because a cap binding one keyed lane is not a fleet-wide total.
  `client.mjs` → `bindingCreditCeiling` takes the `min()`; `decideAllowance` measures the PERIOD's own
  `credits_used` against it, which is what makes a monthly cap bind on tools that hold no state
  between runs. **It is enforced PER ACCOUNT-PERIOD, which is not the same as fleet-wide, and the gap
  is stated rather than closed: the fleet holds MORE THAN ONE Dune key, separate keys are separate
  ACCOUNTS with separate quotas and separate period boundaries, so two keys each honouring the cap
  spend twice it between them with neither run wrong.** One key or a smaller cap on each is the
  captain's decision. **Neither figure is rewritten into the other** — both, and the name of the one that
  bound, are on every verdict (`monthlyCapCredits` / `creditsIncludedVendor` / `bindingCeiling`) and
  in the refusal's own sentences, so an operator reads whether to raise the cap or wait for the period
  to roll. **It is a `min()` precisely because both sides move, and they moved during the
  implementation**: one key read 2,500 included / 2,044.357 used over 2026-07-29 → 2026-08-29 (live
  `POST /usage`, 2026-08-07T01:42:32Z) while a second key reported 4,000 included / 0 used over
  2026-08-06 → 2026-09-06. **NEVER quote either figure or either period — read them from the response
  the key in use returned**, which is what the guard does. On the free key the vendor binds and every
  verdict is what it was before 322a; where the plan equals the cap, a tie is reported as the
  vendor's, since raising the cap then buys nothing. An unreadable or
  non-positive cap REFUSES, in the same place and by the same rule as an unpriceable plan, rather
  than leaving a lane silently uncapped. Each tool's README section "The monthly credit ceiling" owns
  the rest; do not restate the figures, and re-read the live balance rather than quoting one.
- **THE PLAN IS *ANALYST*, 4,000 CREDITS/MONTH, $0.016 PER EXTRA CREDIT, AND ZERO PRIVATE QUERIES —
  captain-supplied 2026-08-09 and AUTHORITATIVE, superseding the free-tier figures the rest of this
  section was written against.** Never quote a Dune plan number from memory or from Dune's published
  material; the captain's figures outrank both, and the live `POST /usage` balance outranks any
  pinned number (`bindingCreditCeiling` takes the `min()` of the vendor's `credits_included` and the
  captain's own `dune.monthlyCreditCapCredits`, which is 4,000 in both keyed bounds files). Two
  consequences that are easy to get wrong in opposite directions. **FAILED EXECUTIONS STILL BILL, so
  a lane bounds spend for ATTEMPTS and not for successes** — an older scout report claiming a failed
  execution costs 0 credits and that probing is therefore free is **WRONG and outranked**; do not
  build a budget on it, and see the "A FAILED EXECUTION IS STILL BILLED" bullet above, which is the
  correct account. And **every saved query on this account is PUBLIC**, so never write a secret, a
  key or a client name into query SQL, and keep gate values as query PARAMETERS rather than in the
  query text. **Prefer `GET /query/{id}/results`, the cached read, over re-executing.**
  Sizing note, captain-supplied and worth carrying because it decides a lane's SHAPE: scoring all
  **857,288 launches of 2026-07 cost 31.19 credits and 109 seconds in ONE execution**, and the cost
  is set by the trade table's DATE RANGE rather than by how many tokens are scored — so a trade-table
  criterion is cheap as a **census** and pointless as a **per-candidate lookup**.
- **Free tier: 2,500 credits/month on that plan, UNSHARED, and only 10 PRIVATE QUERIES — READ THE
  BULLET ABOVE FIRST, which supersedes the plan and the credit figure here; what survives is the
  saved-query discipline. The
  account is NOT at that cap, and "the slots are full" is a stale claim that once blocked a lane
  on nothing. AND ON THE KEY THIS FLEET IS USING TODAY THE PRIVATE ALLOWANCE IS *ZERO*, measured
  2026-08-08** — `GET /queries` reports `total: 0` and `POST /usage` reports `private_queries: 0`,
  yet `POST /api/v1/query` with `is_private: true` returns `402 Max number of private queries
  reached`, while the same create as a PUBLIC query succeeds. So the whole ladder below describes a
  DIFFERENT account's slots, which is the same "re-list rather than quote" discipline it already
  preaches, one level up: **a lane needing a scratch slot on this key must create a public query, and
  a `--deploy` that sends `is_private: true` cannot succeed at all.**
  **Never take a saved-query count on trust; re-checking it is free of credits, not of the key:**
  `GET /api/v1/queries?limit=100` with the `X-Dune-API-Key` header lists them, and creating a
  throwaway with `POST /api/v1/query` then archiving it proves a slot is free without spending an
  execution. Measured that way 2026-08-04 by the discovery-widen investigation, then moved the same
  day by decision 187a taking one of the free slots: **9 saved queries, 3 production and 6 retired
  scratch probes** — and re-listed 2026-08-05 at **10, the cap**, a sibling lane having taken the
  last free slot for a scratch probe. Retiring the retired scratch ids is queued work, so the number
  moves in both directions — **re-list rather than quote it**; three corrections inside two days are
  an instance of exactly why, because the SAME DAY it read 10 it re-listed again at **3** once those
  probes were archived, and the entry-reproduction lane then created a fourth. **At the cap there is
  no slot for a throwaway**, so a lane that needs to validate new SQL either archives a retired probe
  first or deploys to the production id and measures through it. **THERE IS NOW A FIFTH COMMITTED
  SQL TEXT AND IT IS DELIBERATELY UNDEPLOYED**: `tools/deployer-screen/dune-fills.mjs` →
  `TRADE_COVERAGE_SQL`, the coverage probe for the TRADE tables `ENTRY_SQL` reads, whose
  `TRADE_COVERAGE_QUERY_ID` is `null`. The Dune FILL source cannot be built without it — eligibility
  there is an observed watermark (257a) and the enumeration's probe bounds the CREATE tables only,
  which lag differently — so `null` refuses rather than "skips the probe", and pointing it at an
  existing id would refuse the leg terminally after a billed probe. Deploying it takes a slot and is
  a captain decision. The four production queries
  are deployed, **each in ONE workspace and reachable only by a key on that account**: `8204672`
  enumeration and `8204603` coverage, whose SQL is committed in
  `dune.mjs`, `8235460` the Stage 2 opening-window fill tape, whose SQL is committed in
  `tools/deployer-screen/dune-fills.mjs` → `ENTRY_SQL` and whose id is pinned beside it as
  `ENTRY_QUERY_ID`, and `8214953` creation census, whose SQL is committed in
  `tools/arrival-rate-walk/cohort.mjs` → `COHORT_SQL` and whose runner is
  `tools/creation-census/run.mjs`. Each lane's `assertSavedQueryMatches` compares the committed text
  before spending an execution, because a saved
  query is editable from a browser and its answer is a gate input. **EDITING ANY OF THE FOUR SQL
  TEXTS IN THIS
  REPO IS HALF THE CHANGE: the saved query must be updated IN PLACE or the next real run refuses
  the whole Dune leg terminally** — the comparison happens before the execution.
  `tools/deployer-screen/README.md` →
  "Deploying a change to the committed SQL" owns the step for the screen's three and names which id
  goes with which text; `tools/creation-census/README.md` owns it for `8214953`.
  **A SAVED-QUERY ID IS SCOPED TO A WORKSPACE, SO A SECOND KEY ON THE SAME LOGIN MAY SEE NONE OF
  THEM — and a run pointed at such a key does NOT fail cheaply**: it exits 2 at the walk-fallback
  spend cliff with the MadeOnSol seed allowance already spent. That is another instance of why the
  discipline above is *re-list rather than quote*, under the key the run will actually use — and the
  ids are being reissued under captain decision 326a, so no number in this bullet is authoritative.
  `tools/deployer-screen/README.md` → "Deploying a change to the committed SQL" owns the operational
  detail and the (untested, off-tree, 2026-08-07) evidence.
  **Nothing tracks the month ACROSS runs** — each run checks the ceiling itself (bullet above) and
  then forgets; the tools carry no spend state between runs (the screen's Stage 2 rotation state is
  the only state any of them keeps, and it reaches no vendor). Auth is the `X-Dune-API-Key`
  **header**, never `Bearer`.
- **THE ROW CEILING HAS NOW REFUSED A REAL RUN, AND THE TRIGGER IS THE CANDIDATE COUNT, NOT A SPAM
  WALLET.** 2026-08-05, an untiered default run at **76 deployers**: the per-deployer cap of 500
  permits 38,000 rows, the batch returned **27,731** against the pinned 20,000 ceiling, and the
  reading was refused **whole** — `dune.rowsReturned: 0`, `dune.coverage: null`,
  `enumerationSource: "helius"` on all 76. This is the arithmetic `maxResultRows`'s justification
  states in advance (the rows bound is `max(19,999, deployers × 500)`) biting for the first time.
  **CAPTAIN DECISION 264a HAS SINCE RAISED THE CEILING 20,000 → 40,000**, which covers that batch and
  moves the crossover from above 40 deployers to **above 80**; `?limit=40000` was verified accepted
  by the vendor before the value moved. **The SQL was NOT touched**: `SQL_ROW_CEILING` stays 19,999
  and the two are now pinned as an INEQUALITY rather than an equality, deliberately — the equality
  was a derivation, the safety property is the inequality, and freezing the literal means the raise
  needs **no saved-query deploy** and so cannot leave the Dune leg refusing terminally. The ceiling
  stays genuinely reachable, so it is still a backstop. **Two consequences.** It cost that leg **232,937
  Helius credits and 4,105 RPC requests** against 1,924 and 33 for a 69-deployer leg that kept its
  Dune answer; and **a walk-sourced leg has NO mayhem reading at all** — `mayhemShare` null on 76 of
  76, UNMEASURED and never 0%. Mitigation for a run that wants its Dune answer is `--candidates`
  below ~39 or a raised ceiling, and both are decisions.
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
- **THE STAGE 2 ENTRY STATEMENT IS NOW A MEASUREMENT RATHER THAN A CLAIM, AND IT FOUND A DEFECT IN
  THE COMMITTED TAPE.** `dune-fills.mjs` → `ENTRY_SQL` (saved query `8235460`, custody as
  `CREATION_SQL`'s) ran against all **235** taped launches through this repo's own production
  functions: 235 measured, 0 create-slot disagreements, 0 launches short, **10,476 PumpSwap fills
  across the 18 graduation-spanning launches — the tape's own count** — 0 closure mismatches over all
  1,322 pairs, and a max realised error of **5.000e-7 SOL, the IDENTICAL figure the tape-sourced leg
  produces**. `tools/deployer-screen/measurements/2026-08-05-dune-entry-reproduction/` owns every
  number and its limits; `test/dune-entry-reproduction.test.ts` asserts them. Four things bind:
  **(1) THE AMM HALF IS THE DECODED PROGRAM EVENTS, NOT `dex_solana`** — `pumpswap_solana.base_trades`
  is a view over a backfill that inner-joins each swap to an SPL transfer and silently drops the
  misses, measured at **5,444 of 10,476** AMM fills while missing zero curve fills;
  `pumpdotfun_solana.pump_amm_evt_buyevent`/`sellevent` have no such join, and the quote column is
  the **`user_`** one (matched 198/198 where the other two matched 0/198).
  **(2) `window/*.jsonl.gz` IS WRONG ON 658 OF 107,439 FILLS** — understating `sol` 25–40x, on
  `BuyExactSolIn` transactions; 22 of them reach a graded pair and the chain agrees with the
  STATEMENT on 22 of 22. **Captain decision 293a judges the bar over the 1,310 pairs the chain does
  not refute** on three standing conditions — the exclusions stay enumerated by transaction, the
  unexcluded reading (1.842 SOL) stays printed beside them, and closure stays checked over the whole
  1,322 — and **294a ratifies `IMPORT.md` correction 11 as filed, with no row edited**. The twelve
  pairs are enumerated in `dune-reproduction.mjs` → `REFUTED_REFERENCE_PAIRS`.
  **(3) A PUMP.FUN LAUNCH CAN BE QUOTED IN SOMETHING OTHER THAN SOL** — `maxxing` `97nnzgv9…` (the
  second launch of that name) is USDC-quoted, so all 384 of its fills return `sol_raw = 0`
  legitimately while the trade endpoint reports a SOL-EQUIVALENT. It contributes no closed
  create-slot outsider pair, so nothing published rests on it — **luck, not design**, and a lane
  scoring such a launch through the Dune source would read those zeros as free entries.
  **Captain decision 295b files that guard against the GATE 3 CUTOVER, not against the statement or
  the reproduction** — so it is recorded here and enforced nowhere; do not add a quote-mint filter
  in passing.
  **(4) RETRIEVAL IS ~95% OF THIS LANE'S BILL** — ~495 credits for a whole-tape run, ~4.9 of compute
  per execution against 24.7 MB of result bytes — which inverts `stage2_entry_dune`'s "the lever is
  windows scanned" without contradicting it: that block returns one row per launch and this
  statement returns every fill. `--rows`/`--from-rows` exist because the first run discarded its rows
  and a correction then cost a second full fetch.
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

## Naming a custodial venue — the standing capability, and the rule that binds every use of it

`tools/venue-label/` — captain decision 366a, 2026-08-07. **The same Helius key, a different API.**
Full method, bounds and what it cannot answer in its `README.md`; the evidence base is
`slot-zero-attribution-product-pricing` (held in firstmate's records, not in this repo).

- **THE CITATION RULE IS PART OF THE DECISION, NOT A NICETY, AND IT IS ENFORCED RATHER THAN
  DOCUMENTED.** Two clauses, and the second is load-bearing. (1) A venue name is a **VENDOR'S CLAIM
  READ ON A DATE** — unaudited, no published methodology, no error rate — so every label carries the
  date it was read on and is cited as a claim, never as a property of the chain. (2) **NAMING A WALL
  DOES NOT LET ANYONE SEE THROUGH IT**: this lab never traces past a custodial wall, two wallets that
  both touched Coinbase are NOT thereby related and two that touched different exchanges are NOT
  thereby unrelated, and README → "The ceiling of the method: shared custodial venues" is completely
  unaffected by any name. **Cheap venue names make that misreading EASIER**, which is why the caveat
  travels on the label row, the run record and the rendered line rather than living in a document.
  `identity.mjs` → `CITATION_RULE` is the text and a test asserts it reaches all four surfaces; do
  not publish a venue name without it, and do not restate the clauses — cite the constant.
- **THE BATCH ENDPOINT IS THE DEFAULT BECAUSE IT IS A 100x SAVING, AND THE EXPENSIVE PATH IS
  UNREACHABLE.** `GET /v1/wallet/{address}/identity` and `POST /v1/wallet/batch-identity` **both cost
  100 credits per REQUEST**, and the batch one answers up to 100 addresses — so 100 addresses singly
  is 10,000 credits and together is 100. `planLookups` always batches more than one address and a
  test pins that no configuration produces the other shape. The body field is **`addresses`**, not
  `wallets`: the published docs implied the latter and the live API returns `400`.
- **`type: "unknown"` IS THE VENDOR'S ANSWER AND IS PRESERVED AS ONE — and it is NOT the same as a
  row that never came back.** FOUR states since captain decision 372a, kept apart on purpose:
  *named*; *unknown*, where `name` is `null` and never `""`, and which says the address is not a
  venue this vendor knows; *typed but unnamed*, a real `type` with no usable `name`, which is an
  INCOMPLETE answer and never a declined one — folding it into *unknown* prints "the vendor declines
  to name this address" over an answer it never gave; and *no answer*, which is OUR coverage failure
  and is counted and rendered separately. The fourth class is **derived** (`identity.mjs` →
  `isTypedButUnnamed`) rather than stored on the row, so the committed schema-1 record needed no
  edit; the summary gaining its count took `RECORD_SCHEMA_VERSION` to **2**. A rejected key
  reports a refusal rather than every address being unknown, and **a per-run CEILING is reported as
  OUR bound rather than as the vendor's refusal**, sharing exit `4` only because a request may
  already have billed. Responses are read **keyed by address,
  never by position** — the vendor answers in request order today and nothing promises it will.
  **No message this tool emits can carry the key**: the URL sent carries it as a query parameter and
  vendors echo request URLs in 4xx bodies, so every vendor- or transport-authored string goes
  through `credential.mjs` → `redactKey` before it can reach one.
- **Measured, and it is the committed evidence.** `runs/2026-08-07-funding-walls.json`: one batch
  request, **100 credits, 6 addresses, 5 named, 1 honestly unknown**. Four funding walls are Coinbase
  hot wallets; the relay wall `Bukt1ztP…` is declined rather than confabulated; and
  `62qc2CNX…` returns **"Pump.fun AMM Fees 2"**, independently confirming a classification an earlier
  investigation reached by structural argument alone — the strongest evidence here that the labels
  are real, and still **n = 1**. One row carries `name: "Coinbase Hot Wallet 12"` with tag
  `"Bitstamp Deposit"`: two venues on one address, unresolved, and `TAGS_CAVEAT` rides on any row
  with tags because of it.
- **It is a LEAF and it moves no number.** No bar, gate, threshold or verdict in this repository
  reads a venue name, no other tool imports it (a test pins that), and a lane wanting its labels
  reads a committed record rather than coupling to a metered client. **The dry run is the default
  and issues nothing**; a plan over the pinned ceilings is refused before the first request, and
  every issued attempt is counted as billed because the vendor says nothing about whether a shed
  request bills.

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
- **NO LONGER FREE TIER, AND NO LONGER SHARED — the key is ULTRA and EXCLUSIVE to slot-zero**
  (captain, 2026-08-05). Measured the same day from the response headers: `x-ratelimit-limit`
  **100,000**/day, resetting at **00:00Z**. **Captain decision 267a has now RE-DERIVED every bound
  that used to rest on the old ~200/day shared figure** (`thresholds.json` 6.0.0 — a version citation
  here names where a value LANDED and is never bumped to track the file's current version), and the shape of
  that re-derivation is the thing to carry: the allowance stopped being what binds this tool, so
  each value is now fixed by the constraint that replaced it, and each `justification` names which.
  `budget.maxKeyedRequests` 200 → **402** — no longer an allowance figure but the plan's ONE-RETRY
  worst case, `2 × (6 enumeration + 195 candidates)`; it was FORCED, since a tiered default plan
  costs 201 and would be refused at 200. `budget.maxCandidates` is **unchanged at 195 and completely
  re-derived** — `floor(1,365 / 7 pages a candidate)` from `maxKeylessRequests`, which is now the
  tightest ceiling; **the matching integer is a coincidence, not continuity.** `keyedMinIntervalMs`
  6,500 → **250**, re-measured (below). **The upgrade authorised NO widening on its own** — 195 did
  not move for it, and reading 100,000 as licence to raise a bound is still a captain decision.
  **`/{wallet}/history` is NO LONGER out of reach**: it was PRO+, the Ultra key answers it `200`
  (measured 2026-08-05), and it is still not requested — the reason changed from entitlement to
  design, since it serves daily snapshots of the trailing aggregates this tool refuses to read.
- **THE ~10/MINUTE BURST LIMIT DOES NOT DESCRIBE THIS TIER, AND THAT IS WHY 267a REQUIRED A
  RE-MEASUREMENT RATHER THAN A CARRY-ACROSS.** `keyedMinIntervalMs` was 6,500 ms because the Free
  tier burst at ~10/min, recorded as *"the vendor's rate limit, not our caution"* — exactly the kind
  of claim that goes stale invisibly when a tier changes. Measured 2026-08-05, one request in
  flight: a ladder at 6,500 / 2,000 / 500 / **0** ms shed **nothing at any rung**, and **60
  back-to-back requests (≈183/minute sustained) shed nothing either**, which a 10/min limiter
  refuses at request 11. The gate's own endpoint behaved the same (30 back-to-back, 0 shed), and
  `x-ratelimit-used` advanced by exactly 30 — **the counter is per-request and GLOBAL across
  endpoints**. What binds is response latency (p50 312 ms leaderboard, 182 ms profile), so 250 ms is
  a courtesy floor rather than a shed-avoidance figure. Consequence: the keyed leg of a full run
  goes ~21 min → **~50 s**, and a full default run ~19.2 h → **~18.9 h**. **The measurement is one
  day, ~150 requests and SERIAL ONLY — it says nothing about concurrency.**
  `tools/deployer-screen/measurements/2026-08-05-ultra-keyed-envelope/` owns it and its limits.
- **THE VENDOR SENDS ITS DAILY COUNTER ON EVERY RESPONSE AND NOTHING HERE READS IT.**
  `x-ratelimit-remaining` / `x-ratelimit-used` / `x-ratelimit-reset` are on the wire.
  `budget.maxKeyedRequests` bounds ONE RUN and the tool is stateless between runs, so N legs of
  60–85 requests each pass the check individually and can exceed the day together — which is exactly
  what stopped a run mid-flight on 2026-08-05, back when the cap was 200 and shared, after another
  holder had spent 153 of it. Every other ceiling in this tool refuses before the first request, the
  Dune monthly balance included. The Ultra upgrade removed the urgency, not the gap: **read the
  header before a multi-leg session** (`runs/2026-08-05-seed-comparison.md` → "Spend" has the
  one-line curl) rather than assuming the day is yours.
- **Spend the whole MadeOnSol daily allowance when a run will answer something** (captain, 2026-08-02:
  there is no free substitute for this data, so hoarding it buys nothing). The earlier
  quarter-allowance ceiling is withdrawn, so do not re-derive it. **What the bounds are sized against
  is no longer the allowance at all** — see 267a above; a full run is ~201 requests, 0.2% of the day.
  The "if it gets results" conditional binds — no sweeps, no idle retries. **MadeOnSol only**:
  SolanaTracker/CoinGecko keys are production-shared and unchanged, as is keyless pump.fun
  pacing. **Helius is NO LONGER production-shared** — captain, 2026-08-03: that key is this research
  lane's alone, so budget against the whole allowance (see the Helius section below).
  `tools/deployer-screen/README.md` → "Bounds" owns the numbers and the endpoint list.
- **ToS §5a(b)/(d) bind us**: internal research only, and no accumulation beyond what is necessary.
  The screen derives and discards — per-token records live in memory for one run, and only derived
  counts are ever written. `tools/deployer-screen/README.md` → "Retention" owns which files a run
  writes and when. Test fixtures are synthetic, never captured payloads.

## The deployer screen's stages, and the two wallets that keep it honest

`tools/deployer-screen/` — full scope, bounds and reproduction in its `README.md`. It answers the
captain's question *"can I beat the dev and all other wallets sniping the same tokens created by the
dev currently?"*, and the shape of the answer is the point:

- **THE CANDIDATE LIST CAN NOW BE HANDED IN, AND A SUPPLIED LIST IS A SEED AND NEVER A SUBSTITUTE
  FOR THE GATE** (captain decision 398a, 2026-08-09; record **schema 22**). `--wallets <file>` gates
  the addresses in a file instead of enumerating from MadeOnSol. It exists because **supply, not
  measuring capacity, binds the captain's 1,000-window floor**: the reachable population yields ~309
  distinct usable windows a month against a capacity of ~1,160 **at the superseded pooled usable
  fraction of 0.5526 — re-measured on the widened population itself those two read ~101 and ~380;
  see "The usable fraction has been re-measured" below, which owns the correction and which every
  figure in this bullet and the next now defers to**, and **37 of the 58 deployers that
  passed this gate in 2026-07 — 64% — are invisible to every discovery source here**, worth 1,442
  windows a month. It is cheap because **the vendor gatekeeps ENUMERATION, not measurement**:
  `/deployer-hunter/{wallet}` answered in full for two wallets its own hunter feeds have never
  surfaced (n=2 plus a control — an observation, not a rate), so `measure.mjs` → `toLaunchRefs`
  already has what Stage 2 needs the moment Stage 1 has paid for the profile.
  **398a chose the UNRESTRICTED input over one accepting only our own enumeration's addresses, which
  makes the seed-not-bypass rule a hard requirement rather than a principle** — and it is the
  CONTROL FLOW that enforces it, not a string: a listed address becomes an ordinary `SeedCandidate`
  and enters the ONE gate loop, so there is no second path and no bar it can skip.
  `wallet-list.mjs` → `WALLET_LIST_IS_A_SEED` is the sentence the run prints and the record carries;
  `test/deployer-screen.test.ts` → "a LISTED wallet still has to pass the gate — 398a" drives a
  failing wallet end to end and asserts `gate-failed` **and** `entry: null`. **`candidateSource`
  (`vendor-seed` / `wallet-list`) is provenance and is read by NOTHING** — a test scans the scoring
  modules' executable half for it — and its absence on a schema-≤21 record is unambiguous, since
  nothing before 22 could supply a list. **The plan arithmetic moves and nothing else does**: a
  listed run issues NO enumeration request, so the keyed worst case is `0 + <addresses>` rather than
  `6 + <cap>` and the candidate cap is the list's own length (`--candidates` and `--tier` are
  REFUSED beside `--wallets` — capping a supplied list is dropping addresses out of it). Zero Dune,
  zero Helius beyond what a seeded run spends, and **Stage 2's keyless swap-api ceiling cannot move
  at all**, being `maxCandidatesScored × maxLaunchesPerCandidate × maxRequestsPerLaunch`, none of
  which is a function of the candidate count or source. A malformed entry, a two-token line, a
  duplicate or an empty list refuses the run naming every bad line, before Stage 0, and uses none of
  the file. `tools/deployer-screen/README.md` → "The vendor gatekeeps ENUMERATION, not measurement"
  owns the long form. **The flow-weighted allocation (399a) has since LANDED and is its own section
  below** — 398a left `rotation.mjs`'s comparator untouched and 399a is what moved it; the two are
  the pair that clears the 1,000 floor, and neither does alone. **The chain-wide enumeration that
  would PRODUCE lists (350a) is still a separate lane**, and `feed.mjs` still neither writes a list
  nor is read by `screen.mjs`.
- **Stage 1 ENUMERATES on Dune** (keyed, free tier — which mints the wallet created, with the RPC
  walk as fallback) and **GATES on competence** (keyed, MadeOnSol). **Stage 2 SCORES ENTRY** (keyless): room in
  the opening window, what every *other* sniping wallet there achieved, and — since the captain's
  ruling of 2026-08-02 — **what it cost them to land**. **Stage 3 — EXIT — is a separate lane and no
  exit signal may reach an entry number.** Room to enter is not room to leave, and one blended score
  cannot be read back apart.
- **Stage 2 spends no keyed request.** It reuses the mint list from the profile Stage 1 already paid
  for (`measure.mjs` → `toLaunchRefs`), so the keyed vendor allowance is untouched by it.
- **WHERE THE FILLS AND THE COSTS COME FROM IS INJECTED, AND NO SCORING MODULE NAMES A VENDOR**
  (captain decision 260a). `fill-source.mjs` and `cost-source.mjs` are CONTRACTS that import nothing
  at runtime; `swapapi-fills.mjs`, `rpc-costs.mjs` and `dune-fills.mjs` are implementations;
  `screen.mjs` → `selectEntryFillSource` is the one selection site and **refuses** a kind it has no
  constructor for rather than falling back. `stage2.mjs`, `entry.mjs`, `measure.mjs`, `stage0.mjs`
  and `rank.mjs` reach no source implementation at any depth and may not read a source `kind`.
  **The eligibility gate moved with it and that is the third time** — it is `fillSource.minAgeMs()`
  now, because "has this launch finished happening" is the VENDOR'S to answer (144a's *never write a
  duration for something someone else controls*, and 257a's watermark requires exactly this
  inversion). `ENTRY_FILL_SOURCE_KIND` is `'swap-api'`: **the Dune path is committed and nothing
  routes through it**, which is the correct resting state until Gate 3, and `dune-fills.mjs` refuses
  every window it is handed no statement for — the statement itself is now committed there and
  measured (see the Dune section's entry-statement bullet), which did not wire it. No record field,
  bar or verdict moved.
  `tools/deployer-screen/README.md` → "Where the fills come from is INJECTED" owns it, including
  what the change does **not** claim — after the cutover a Dune value *will* reach `entry.roomLeft`;
  what survives is that nothing deciding anything knows which vendor produced its input.
- **A RUN CAN NOW CARRY BOTH FILL SOURCES AND AGREE WITH ITSELF PER CANDIDATE, AND IT IS OFF**
  (Gate 3 precondition 4, record **schema 18**). `--entry-source-agreement` scores every candidate
  through both sources, records `entrySource` per candidate — `enumerationSource`'s shape one stage
  over, Dune primary with a per-candidate swap-api fallback — and classifies the two verdicts on the
  candidate. **It emits COUNTS BY CLASS AND NEVER A RATE**: captain decision 143a, because a 98.4%
  whole-window agreement figure on this project hid a total failure confined to the create slot, so
  `agreed` / `disagreed` / `only-<kind>-answered` / `neither-answered` are kept apart and
  `only-<kind>-answered` is a COVERAGE difference rather than a disagreement (174b, one level up).
  **BOTH SOURCES SCORE AT ONE RECIPE** (`stage2_entry`), or a difference would be the sampling caps'
  and not the transport's — which also keeps `grade.mjs` reading back the caps that were applied.
  **THREE THINGS GATE IT AND ALL THREE ARE UNMET**: `entry_source_agreement.active` is `false`, the
  trade coverage probe is undeployed (Dune section above), and the spend is unapproved —
  `tools/deployer-screen/measurements/2026-08-06-dual-source-agreement-estimate/` prices the run
  against a live `POST /usage` balance and records that the proposed shape did NOT fit the
  2026-07-29 → 2026-08-29 period; cite it rather than restating its figures, since the balance moves.
  **This is NOT the cutover** — `ENTRY_FILL_SOURCE_KIND` is unmoved and a default run is unchanged.
  One consequence for any lane touching `plan-source.mjs`: a registration's `build` **may now be
  async**, because a billed construction reaches a vendor.
  **AND TWO GUARDS RUN BEFORE THE FIRST BILLED REQUEST, BECAUSE NEITHER DID WHEN THE MODE WAS FIRST
  WRITTEN** (captain decisions 317a and 318a, `thresholds.json` 6.5.0). (1) `screen.mjs` →
  `buildDuneEntryFillSource` reads the monthly credit balance from the free `POST /usage`, prices
  this leg through `dune-fills.mjs` → `tradeFillSpendPlan`, and refuses through the SAME
  `decideAllowance` every other keyed lane uses — **before the trade coverage probe, which is the
  first billed read.** The balance is a READING and is pinned NOWHERE; the estimate document's
  correction note says so and says the guard post-dates it. `worstCaseComputeCreditsPerExecution` is
  a new pin and no new anchor: it is `worstCaseCreditsPerWindow`'s own compute term, split out
  because both credit pricers derive retrieval from bytes themselves and the composite counted it
  twice. (2) `assertAgreementWindowsFit` makes `maxWindowsPerRun` BIND — it was reported by the
  record and enforced by nothing, so 82 windows could run against a ceiling of 80. **80 and 82 stay
  unequal on purpose** (`82 = 80 + probe + headroom`); do not reconcile them.
  **AND THE BALANCE IS READ ONCE PER RUN AND RESERVED, AND A RUN IS CHARGED FOR WHAT IT PLANS**
  (captain decisions 320a and 321a, `thresholds.json` 6.6.0, no value moved). `dune.mjs` →
  `openDuneCreditLedger` is the run's ONE reservation: the entry leg and the enumeration each read
  `POST /usage` and each decided alone, so two verdicts from the same reading could both pass while
  their combined worst case overran. A cleared leg's worst case is now HELD, so the next leg is
  priced against what is left — one mechanism, not two guards subtracting each other, and
  `checkDuneAllowance` IS one reservation against it. And `dune-fills.mjs` →
  `agreementExecutionsFor` prices `windowsPlanned + probe + headroom` (capped by the pins, and the
  same figure bounds the client) instead of the ceiling, because pricing the ceiling refused
  `--score 2` identically to a full run — **under a fixed monthly Dune budget a reduced-scale run is
  the normal operating mode**. The monthly budget itself is the captain's and is pinned NOWHERE.
  **AND THE TWO GATE-3 SPEND HAZARDS 320a/321a LEFT BEHIND ARE NOW CLOSED, BOTH BY DERIVING FROM
  WHAT A RUN WILL ACTUALLY DO** (the pre-Gate-3 hazard round, 2026-08-06; no value moved). Under the
  captain's Dune account controls — extra credits capped at $0, per-query and per-read throttles OFF
  — the cost of either is **AVAILABILITY, not money**: the vendor refuses at the ceiling rather than
  billing past it, so a run that bills and then dies leaves the period consumed and nothing produced,
  and this repo's own guard is the only thing bounding a run's size. (1) **The priced window count
  followed the AGREEMENT FLAG, which is the one thing the cutover does not touch** — pointing
  `ENTRY_FILL_SOURCE_KIND` at `dune` left it 0, so `agreementExecutionsFor` bounded the client and
  cleared the allowance at *probe + headroom* for a leg intending `maxScored × maxLaunchesPerCandidate`
  windows: bill the probe, then die on `CeilingReached`. `screen.mjs` → `entrySourceKindsRead` is now
  the ONE derivation of which sources a run reads (built on `entryFillSourceIsRead`, so "no source"
  and "no Dune source" cannot disagree), and the ceiling check, the priced count and the run's own
  construction all read it. Its `selectedKind` parameter exists so a test can stand where Gate 3
  will — do not inline the constant. (2) **320a shared the reservation but never fixed the ORDER**,
  and control flow had the EXPENSIVE OPTIONAL leg first: the entry source is built before Stage 1
  enumerates, so it billed its coverage probe, the enumeration was priced out into the RPC walk, and
  `priceWalkFallbackCliff` refused the whole run at exit 2. `dune.mjs` → `DUNE_LEG_ORDER`
  (`enumeration` then `entry`) is enforced by the ledger, **before the free balance read**;
  `checkDuneAllowance`'s `leg` is REQUIRED with no default, a leg that will not spend must
  `declineToSpend` rather than be skipped (silence blocks the legs behind it, which fails towards
  refusing), and a ledgerless call is the SOLE leg and queues behind nothing — so every single-leg
  path is byte-identical. **AND ORDERING THE RESERVATIONS DOES NOT ORDER THE SPEND**, which the
  review of that round caught: a ledger holds a leg until its predecessors have SETTLED, never until
  they have ANSWERED, so the entry probe could still be billed and the run then refused whole at the
  cliff. The construction is therefore SPLIT and carries **two properties, neither of which may
  lose**. (1) A run whose Stage 2 fill source cannot be RESOLVED refuses BEFORE the MadeOnSol seed
  enumeration is spent — `runEntrySourcePlan(..., { constructionPhase: 'free-only' })` RESOLVES every
  kind the run will read, so an unknown kind still refuses there and resolution touches no vendor,
  and builds only what the registry DECLARES free (the swap-api, so a default run is byte-identical).
  **The Dune CREDENTIAL is asked in that free phase too, because the answer costs nothing** —
  `duneFillSourceCredentialRefusal` is one rule with two evaluation points, the free phase and the
  constructor's own backstop, and the free phase reads `entrySourceKindsRead`'s answer rather than
  asking again whether this is a Dune run, so the `--stage0` fold reaches it. Without it a
  Gate 3 run with no usable `DUNE_API_KEY` spent the whole seed enumeration and then refused, on a
  configuration where the seeds buy nothing (`usingDune` false ⇒ no enumeration, no cliff).
  **WHAT REMAINS IS STILL NARROWER THAN THE PRE-SPLIT BEHAVIOUR AND THE NARROWING IS DELIBERATE — do
  not read it as "an unusable source always refuses before anything is spent".** The three failures
  that can only be learnt by REACHING the vendor (undeployed coverage probe, refused allowance,
  unreadable watermark) now refuse at `completeEntrySourcePlan` with the seeds already sunk; before
  the split they refused ahead of them and BILLED the probe ahead of them, which is the hazard (2)
  removes, so the two cannot both be had.
  (2) The OPTIONAL BILLED leg only bills once the MANDATORY one has ANSWERED —
  `completeEntrySourcePlan` builds the deferred billed and UNDECLARED constructions after the
  enumeration and after `priceWalkFallbackCliff`, still ahead of the gate loop, and its refusal reads
  *"Refusing to score"* and may NOT claim nothing was spent. `DUNE_LEG_ORDER` is KEPT beside the
  control flow deliberately: it is the guard that survives a future reordering. `main` carries a
  `seam.entryFillSourceKind` so a Dune-selected run is reachable from a test — the constant is Gate
  3's own edit — and both directions of both properties are driven through `main` over a stubbed
  transport. **AND `--no-dune` / `--ownership-only` NOW BIND THE FILL SOURCE, NOT JUST THE
  ENUMERATION** — the same defect one flag over, since they were checked only against
  `--entry-source-agreement`, which the cutover does not touch: at Gate 3 a `--no-dune` run would
  have built its own Dune client, billed the coverage probe and one execution per window, and filed
  `dune.used: false`. `screen.mjs` → `duneFillSourceContradiction` asks the same derivation and
  **REFUSES rather than suppressing** (suppressing discards the configured source; honouring spends
  what the flag forbade), in `parseArgs` and again in `main` where the pinned bounds are readable.
  **AND `--stage0` IS FOLDED INTO `entryFillSourceIsRead`, WHICH IS THE CORRECTION TO THAT GUARD'S
  OWN FIRST CUT**: `--stage0` leaves `opts.stage2` true, so at the cutover the guard would have
  refused `--stage0 --no-dune` — the free, offline, keyless mode — while `main`'s copy, sitting below
  the `stage0Only` return, let it through. It is folded into the DERIVATION rather than exempted at
  the call site, because exempting would put the mode question beside a flag again and leave the two
  copies free to drift apart. **`--dry-run` is deliberately NOT folded**: a dry run reads no source
  but PLANS one, and `planEligibility` gates on this predicate, so folding it would stop the plan
  naming its source and regress 286c. The asymmetry is STRUCTURAL — `--stage0` returns before the
  plan is built — and a test pins both halves.
  Neither guard can fire on the default branch; the first run that exercises
  the Dune fill source is Gate 3's.
- **`node tools/deployer-screen/screen.mjs` WITH NO MODE FLAG IS A LIVE RUN AND SPENDS, and the
  agent environment normally has all three keys set.** It costs MadeOnSol keyed requests immediately
  and a Dune coverage-probe result read — billed by bytes — before the gate loop starts. `--dry-run`
  and `--stage0` are the free modes and are what a smoke test wants; `--dry-run --dry-run-spend`
  authorises a bounded purchase. Check whether `DUNE_API_KEY`/`MADEONSOL_API_KEY` are set before
  invoking the CLI at all: these tools are designed to be provable from tests and fixtures, so a lane
  under a no-billed-execution constraint should never need a live run.
- **A DRY RUN IS FREE AND ALWAYS PRINTS THE PLAN, AND THOSE TWO STOPPED BEING COMPATIBLE — SO THE
  CAPTAIN SPLIT IT** (decision 286c). 281a/284a/285a made the plan state the eligibility bound the
  SELECTED source applies instead of re-deriving it; asking a source anything needs the source to
  EXIST, and the Dune one cannot be built without a **billed** coverage probe. So a Dune dry run
  could only SPEND (and stop being a preview) or THROW (and withhold a page of free, correct
  figures). Neither. `screen.mjs` → `resolveEntryFillSource` now **selects without building** —
  registry entries are data — and `plan-source.mjs` → `planEligibility` builds only where the
  registration DECLARES the construction free, or where `--dry-run-spend` (with `--dry-run` only)
  authorised it, stating the BOUND before and the ACTUAL after in a `finally`. A figure it may not
  buy prints **UNAVAILABLE with the source and the reason** — `eligibilityUnavailableNote`, one
  wording shared by the screen's plan and the census's, never a blank, a zero or another source's
  number. It returns **pre-wrapped lines** and its wrapper is unexported, so a consumer indents and
  cannot pick a width — the class is removed rather than enumerated in a guard. **An UNDECLARED construction counts as billed, and is never built by a plan even under the
  opt-in**: an absence is not evidence of "free", and a spend that cannot be bounded first is not an
  authorised spend. A run that READS the source still builds and pays, because it was always going to
  reach that vendor. **Nothing routes through the Dune source until Gate 3, so none of it has been
  exercised against the real source and it must not be**: the free path is proven with a stub
  constructor that fails the test if it is called, the opt-in by what it announces.
  `tools/deployer-screen/README.md` → "The dry run is SPLIT so it can be both free and honest" owns
  it.
- **THE RUN PATH GATES ON THE SAME CONDITION NOW, AND CLOSING IT BEFORE THE CUTOVER IS THE POINT.**
  286c's review found the identical exposure one level over — the run path built its source outside
  any `--no-stage2` guard while consuming it only inside the block that scores — and correctly did
  NOT fix it, that lane's intent having frozen the run path. Under a billed construction a real
  `--no-stage2` run would have paid the coverage probe for a source Stage 2 never reads, and an
  UNBUILDABLE source would have refused the whole run (`EXIT.upstream`) — gate, enumeration and
  record lost — over a leg the operator switched off. **Neither is reachable today, which is exactly
  why it closed now: the first run that ever exercises the Dune source is the one that would pay.**
  **One mechanism, not two patterns** — `screen.mjs` → `entryFillSourceIsRead` is the single
  predicate both paths ask, written once because two expressions that merely agree is 144a's defect
  and is how the run path came to sit outside the plan path's guard; `screen.mjs` →
  `runEntryFillSource` is the run half and returns `null` having touched no constructor. It is **not**
  `planEligibility` and must never become it (a plan refuses a billed or undeclared construction, a
  run builds both — the source-text pins say so). Stage 2's block is guarded by
  `entryFillSource !== null`, so constructing and scoring are ONE decision. Stage 2 enabled is
  unchanged and still reads the swap-api; **this was not the cutover.** **The construction also sits
  BELOW the credential refusal, which is the same invariant one condition over**: a run whose
  MadeOnSol credential does not resolve screens nothing, so it reads nothing, and building above the
  refusal would pay a billed probe before returning `EXIT.credentialMissing` — or refuse with
  `EXIT.upstream` and mask the credential message — for a source never read. No consumer sits between
  the two points, so the ORDER is the guard and a test pins it.
- **THE 156a BOUNDARY IS GUARDED BY TWO ASSERTIONS NOW, AND THE OLD ONE CANNOT FAIL** (captain
  decision 261a). `test/deployer-screen.test.ts` → "NO Dune value can reach a Stage 2 entry number or
  Stage 3" is a deny-list on the literal filename `./dune.mjs`, and **one hop of indirection defeats
  it completely** — measured: a module importing `dune.mjs` and imported by `stage2.mjs` passed the
  whole file, including when named `dune-costs.mjs`, the name 255b step (3) itself prescribes. It is
  kept byte-unchanged as the record of 156a's intent; the enforcing one beside it — "a scoring module
  imports only from a declared pure set" — is an **exhaustive allow-list plus a transitive closure
  plus a no-branching-on-provenance rule**, so it fails on a NEW edge at any depth whatever it is
  called. Adding an import to a scoring module means editing that list on purpose.
- **THE GATE'S COMPLETION RATE IS TWO DIFFERENT QUANTITIES AND A BAR ON ONE DOES NOT TRANSFER TO THE
  OTHER.** `screen.mjs` gates on the **creation-derived merged history** by default (median window
  147.1 days on the last real run's 82 candidates); `--ownership-only` and `feed.mjs` read the
  **vendor 70-record page**, a shorter and success-biased window (median span 3.4 days there, one
  wallet reading 1.0000 against 0.3071 on the gate reading). `stage1_gate.minCompletionRate` is
  **0.25 measured on the gate reading** — captain decision 231a holds the value and its
  `justification` in `thresholds.json` owns the ceiling (`7ufmve7Z…` reads 0.4325 there, so a higher
  bar excludes the control), the sweep and the false-rejection asymmetry. Cite it rather than
  restating the figures, and name the reading whenever this bar is described.
- **WHAT THAT RATE COUNTS AS A COMPLETION IS *RAISE-85* NOW, ON EVERY VENUE INCLUDING PUMP.FUN —
  captain decision 352b (record schema 21, thresholds 6.9.0).** *Net quote inflow into a token's own
  primary market, over its first 24 hours, reaching 85 SOL-equivalent*, replacing pump.fun's own
  graduation flag as the DEFINITION. One yardstick for every deployer; the two halves of 352b cannot
  be separated, because adopting it off-launchpad while pump.fun kept its native reading leaves
  pump.fun deployers a ~46% graduation credit no off-launchpad deployer can earn. `measure.mjs` →
  `RAISE_85_IS_THE_COMPLETION_MEASURE` is the sentence, printed once per run;
  `tools/deployer-screen/README.md` → "The completion measure is RAISE-85" owns the long form. **The
  bar does not move and is not to be lowered to buy recall** — the 85 was read off the data (85.005
  at p50 AND p99 over 157,259 launches) and has ZERO token-level false positives, which is what makes
  a rate from it a LOWER BOUND and adoption safe in one direction (measured over 176,200 July-active
  deployers: **zero promotions**, 1,417 demotions); at 50 SOL that property is gone (42 promotions)
  and the safety argument with it. `measure.mjs` → `RAISE_85_SOL_BAR` owns it.
  **THE SEAM WITH 351 IS THE THING NOT TO GET WRONG, AND THE ORDER OF THE TWO FILTERS IS ALL THAT
  PREVENTS IT.** RAISE-85 as a definition touches only the NUMERATOR — it simply never registers a
  mayhem graduation — so mayhem LAUNCHES left in the denominator would drive a mayhem-heavy deployer
  to 0.0000 and drop them, **which is 227c, and 227c REMAINS DECLINED**. So the mayhem exclusion runs
  FIRST over the whole history and the criterion only over what it leaves; a mayhem launch is counted
  in `competenceMayhemExcluded` and NEVER in `competenceCriterionUnreadable`, and **the two pairs are
  not additive in meaning**. Both mutations — mayhem back into the denominator, unreadable scored as
  a failure — are pinned by `test/deployer-screen.test.ts` → "352b: RAISE-85 is the measure, and it
  must not compose with 351 into 227c".
  **Three more things bind.** (1) **A launch the criterion cannot be READ on leaves BOTH sides and is
  never scored as a failure**; a candidate with none readable is `gate-unmeasured`, never 0.0000
  (`rank.mjs` → `competenceEmptiedByCriterion`), **and so is a candidate with ANY unreadable launch,
  on EVERY leg** (`rank.mjs` → `competenceCriterionIncomplete`, checked in `verdictFor` so the vendor
  reading, `--ownership-only`, `feed.mjs` and the bundling census get it by construction): those
  launches leave `tokens` and `spanDays` as well as the rate, so `minTokens`/`minSpanDays` would
  otherwise gate-FAIL a wallet over OUR coverage — permanent and invisible, since a graded wallet is
  filed in `feed/ledger.json` and never offered again. **That is blunt on purpose: ONE missing or
  malformed `complete` field anywhere in a history withholds that candidate's whole verdict, so if a
  vendor stopped serving the field nothing would be queued and the feed would report itself DRY
  rather than rejecting anybody. What that buys is no rejection computed on OUR coverage, and
  VISIBILITY — the tell is exit 9 on wallets that plainly have launch records — plus, on
  `screen.mjs` alone, a wallet a later run can still judge. It does NOT buy re-offerability in the
  FEED, where an unmeasured wallet is graded and never offered again exactly like a `held` one**;
  that predicate's doc, `ledger.mjs` → `markWorthARequest` and `ledger.mjs` → `feedAlarm` own it. The one behaviour that genuinely moved is the launch
  neither the curve nor the ownership listing could answer for — it was `completed: false`, and is
  unreadable now. (2) **Every route this repo has READS the criterion through pump.fun's graduation
  flag, which is an ESTIMATOR**: its negative is exact (every token reaching 85 SOL graduated,
  precision 1.0000), its positive is an upper bound (0.82% of graduations did not, recall 0.9918), so
  a rate here errs towards ACCEPTANCE and `competenceCriterionEstimated === tokens` says the whole
  rate is that bound. `measure.mjs` → `PUMPFUN_GRADUATION_ESTIMATOR` owns it, including that on a
  MAYHEM launch it is 292x wrong rather than 0.82% wrong — which is why it is only ever asked about
  launches 351 already kept. (3) **Cross-venue comparability is NOT established and must not be
  claimed**: the same bar is reached by 0.80% of new pump.fun tokens, 0.25% on Meteora DBC and 46.71%
  on Meteora CPAMM. `measure.mjs` → `CROSS_VENUE_STRICTNESS_UNESTABLISHED` travels with the number
  (it is in `LIMITATIONS`, so it reaches every rendered surface and the run record);
  `slot-zero-cross-venue-strictness-measure` owns the question, held in firstmate's records, not in
  this repo. **No bar and no committed verdict moved** — `minCompletionRate` stays 0.25 and Stage 0's
  tape regressions are byte-identical — and **a schema-≤20 rate is a different quantity from a
  schema-21 one**, which is now true at two of the last three versions (19 moved the same quantity,
  20 left it alone), so read `schemaVersion`
  before pooling any two `completionRate` values from this tool.
- **A pinned value's `justification` must name the measurement the CALL SITE applies it to, and a
  test now pins that every parameter has one** (`test/deployer-screen.test.ts` → "every pinned
  parameter carries a stated reason"). The 2026-08-02 provenance audit found three justifications
  naming a quantity the code does not compute, four quoting figures that did not reproduce, and eight
  values with no stated reason at all; the round that fixed them is the standard. **"No measurement
  backs this, and here is what would" is an acceptable justification** — `minEpochs`,
  `minTokensPerEpoch`, `creation_walk.maxTransactionsPerCandidate` and Stage 0's `minLaunches` /
  `minPairs` / positive-share / era-tolerance constants all say exactly that. Inventing an anchor is
  not. **`minLaunchesSampled = 8` is the canonical case: it is a BUDGET bound** — the Stage 2 request
  ceiling is `maxCandidatesScored × maxLaunchesPerCandidate × maxRequestsPerLaunch` and the ceiling
  and the declared worst case are kept the same number (**7 × 10 × 18 = 1,260** since the scoring
  cap went 3 → 7 on 2026-08-04; it was 3 × 10 × 18 = 540 after captain decision 190a raised the
  LAUNCH cap to 10, and 3 × 8 × 18 = 432 when cap and floor were equal). It is not a
  statistical bound, and the June report's smallest published per-launch quartile bucket is 20 — so a
  verdict resting on 8 launches is weaker evidence and the record's `launchesSampled` is how a reader
  sees it (captain decision 141a; **the FLOOR does not move — 190a raises the cap instead, and a
  future lane may not close the gap from the floor's side**).
  Do not quote `curve_last_tx_s` in any justification: it is a non-timing (see above).
- **`maxCandidatesScored` is 7, and it is a BUDGET bound too — the survivor count cannot fix it.**
  The 2026-08-04 full-day run left a gate-passed wallet unscored for cap reasons alone
  (`scoringCap: {max: 3, survivorsUnscored: 1}`), which is a cap and not a refusal and is invisible
  unless a reader opens that block. 7 is the **largest** cap that fits the ceilings already pinned
  without moving a second threshold: `7 × 10 × 18 = 1,260` stays under `budget.maxKeylessRequests`
  of 1,400, where 8 would be 1,440. **Do not derive it from a gate-pass rate** — the two committed
  runs disagree by nearly an order of magnitude (4 of 82 against 5 of 12), so at the 195-candidate
  cap the survivor count spans ~10 to ~81. It costs wall clock and nothing else: Stage 2 goes ~21/63
  min to ~49/147 min typical/worst, the cost leg's run-level RPC worst case goes 1,500 to 3,500
  requests, and a full default run's worst case goes ~16.4 h to ~19.2 h.
  `thresholds.json` → `stage2_entry.justification.maxCandidatesScored` owns all of it.
- **THOSE THREE SAMPLING CAPS ARE SOURCE-SCOPED SINCE `thresholds.json` 6.1.0, so 7 / 8 / 10 are the
  SWAP-API source's request arithmetic and nothing else's.** The Dune fill source carries its own
  three in `stage2_entry_dune` — **14 / 20 / 22** since captain decision 289b, derived in CREDITS for
  windows scanned (308 windows, ~128 credits a run, ~19 runs a month against the vendor figure that
  applied when 289b was written — read the binding ceiling live, it is now a `min()`; see 322a above).
  The two `maxCandidatesScored` were the same integer until 289b and the coincidence had to be
  disclaimed in prose; now the values themselves show the scoping. **14 is INTERIM, not terminal** —
  27 would serve the whole pooled survivor set but is sized to today's population, so the final size
  gets derived against the widened discovery pool. **`stage2_entry_dune` is the SINGLE OWNER of
  those three values** — `stage2_entry`'s justifications point at it and restate none of them, so
  the block is the one edit site when the interim size is superseded. **Nothing reads that block**:
  Gate 3 has not been convened and `screen.mjs` selects `'swap-api'` on every run, so every live
  number is still `stage2_entry`'s. Every evidence bar (`minRoomLeft`, the field bars, the cost bar)
  stays in `stage2_entry` and governs both sources, and a test forbids either justification from
  NAMING the other's cost parameters **or stating a QUANTITY in the other's unit** — a credit figure
  on the swap-api side, a request figure on the Dune side — while a bare mention used to disclaim the
  other unit is deliberately allowed on both sides (vocabulary and cross-unit figures, not the
  arithmetic itself — the test says so itself).
  **A Gate 3 wiring MUST record the source-scoped caps**: `screen.mjs` files `stage2_entry`
  unconditionally and `grade.mjs` reads `minLaunchesSampled`/`maxLaunchesPerCandidate` back out of
  it, and those are exactly the two keys that differ, so scoring through Dune while recording
  `stage2_entry` files a recipe the run never applied. A test pins that they genuinely disagree. Each block's `justification` owns its own derivation —
  including that the Dune floor of 20 makes a verdict HARDER to reach, not easier.
- **"Enterable" means enterable AFTER what it costs to enter, and `entry-room-present` no longer
  exists.** Fees are inside the entry window (captain, 2026-08-02) and the field's after-cost result
  ships with them (decision 136b). The strongest verdict is now `entry-open-after-costs`; two new
  ones — `entry-cost-unmeasured` and `entry-cost-prohibitive` — have no older equivalent, and
  **unmeasured cost is never a pass**. A schema-≤5 `entry-room-present` is NOT the same finding;
  `tools/deployer-screen/README.md` → "The run-record schema" owns the boundary.
- **AN UNMEASURED VERDICT IS SEVEN PRODUCERS AND EVERY ONE OF THEM IS OUR OWN COVERAGE — a later
  stage may filter ONLY on a MEASURED verdict, never on an unmeasured one whatever its cause**
  (captain decision 174b, schema 10; the seventh arrived with 198b at schema 12). The four
  filterable verdicts are `entry-open-after-costs`,
  `entry-room-absent`, `entry-cost-prohibitive` and `entry-field-loss-making`; every unmeasured
  outcome is **no answer** and must be carried forward, surfaced and counted, never dropped.
  `verdict !== 'entry-unmeasured'` is a filter on our own budget and evidence wearing a
  measurement's clothes — the invisible false rejection this screen exists to remove, one layer
  down. **`entry.mjs` → `isDeployerAttributable` is the predicate; do not rebuild the attribution
  table in a consumer**, and note that **Stage 3 is a second consumer of Stage 2's fill walk, not a
  reader of `runs/*.json`**. `tools/deployer-screen/README.md` → "What a later stage may filter on"
  owns the seven-row table, the attribution rationale, the predicate's fail-safe behaviours and the
  superseded-rule note; the evidence is `slot-zero-stage2-reverify` → `report.md` §5, held outside
  this repo (see "Citing a report this repo does not hold").
- **A SAMPLE TWO LAUNCHES SHORT DOES NOT GET TO DECIDE THE ROOM BAR, AND THE GUARD PINS NO NUMBER**
  (captain decision 198b, schema 12). 190a's headroom made a verdict shape reachable that was
  structurally impossible at 8-and-8: a candidate scored on 8 of 10 where the two missing launches
  were selected by DROP CAUSE — the request cap takes the busiest windows, `roomIsProven` takes the
  ones with no co-ordination evidence — rather than at random. `entry.mjs` → `roomBarRobustness`
  refuses to score whenever completing that hole could have put the median on the other side of
  `minRoomLeft`, in **BOTH** directions, and the cause `room-verdict-not-robust-to-missing-launches`
  is how a run record says so. **The DIRECTION of the bias is UNMEASURED and the guard is built not
  to need it** — the attempt failed (rank correlation 0.0250; busiest-quartile median room 0.3032
  against the quietest 0.2771; dropping the busiest 3.1% moves the median 0.3146 → 0.3314, i.e. the
  two statistics disagree in sign, on n = 1). So **no margin is pinned**: the interval is the
  candidate's own reachable median range under `measure.mjs` → `ROOM_LEFT_RANGE`, which is algebraic
  (`roomLeft` is a share of non-negative buy SOL), which makes the effective margin the sample's own
  dispersion around the bar. **The committed tape cannot exercise it** — our subject is proven
  235/235 with no walk drops, so the hole is 0 at every window and Stage 0 is byte-identical either
  way; that is a limit of the one tape here, not a check the guard passed. **That function's doc owns
  the argument and its figures**; `tools/deployer-screen/README.md` → "A sample two launches short
  does not get to decide a bar it cannot reach" carries the consequences. Cite them rather than
  restating the figures.
- **THE ROOM MEDIAN NOW STATES ITS OWN INCOMPLETENESS, AND THE BOUND IS A REPORT THAT NO GATE READS**
  (captain decision 208b, schema 14; 208d folded in as its measurement step). The median is over the
  launches that were SCORED and the rest did not go missing at random, so `EntryScore.roomLeftBound`
  sits beside `roomLeft` on every score: the interval the median would lie in if the hole were
  filled, `overstatementMax` as the headline, `provablyOverstated` when completing it MUST lower the
  figure, the hole split into refused-and-measured versus never-measured, and the refused windows'
  own `refusedRoomLeft`. It reaches the run record, the rendered block on the line under `room left`,
  every rationale that states a median, and `caveats` — 208b was chosen over 208a precisely so the
  figure cannot be quoted without it. **`roomIsProven` is UNTOUCHED and no floor moved**: 203c and
  203d stay declined, and a sibling lane established the missing evidence does not exist to be got,
  so these refusals are correct answers being described rather than a gap being closed. **The one
  trap: the bound is NARROWER than `roomBarRobustness`'s and must never be handed to it** — a refused
  launch's own measurement replaces the algebraic ceiling, so giving it to the guard would make the
  guard refuse less. **The DIRECTION is not universal and a one-way correction would be wrong**: on
  the 2026-08-04 stranger it runs UP and large (median 0.288940 reported against 0.0008 completed),
  on our own tape under the superseded shared-transaction half it runs the other way on 52 of 63
  windows, because there the refused windows carry the operation's own adjacency-co-ordinated stake
  and read HIGH. **Refusal means no evidence, not near-zero room.** `entry.mjs` → `roomMedianBound`
  owns the construction, the argument and the figures — including the 63-of-63 validation that the
  bound contains the union's better reading — and
  `tools/deployer-screen/README.md` → "The room median states its own incompleteness" carries the
  consequences. Cite them rather than restating the numbers.
- **Entry cost is recovered from the chain, and the signatures are free.** Every `Fill` carries its
  transaction, so `measure.mjs` → `walletTransactions` and `entry.mjs` → `entryCostTargets` name the
  transactions to price with no discovery step; `pumpfun.mjs` → `parseTransactionCosts` reads
  `meta.fee` (base + priority, exact) and the pre/post balance delta. **The free legs — room and the
  gross field — run FIRST**, so a deployer failing either costs zero RPC requests; that ordering is
  the cost model. Measured per launch on our tape: **~19 DISTINCT transactions at the median — the
  UNION** of the create-slot scope (p50 7) and the closed-round-trip window scope (p50 18), not
  their sum (`render.mjs` publishes that pair and the union). Over the cap of launches a candidate is
  walked, that is **~190 requests at the median, ~350 at p90 and ~740 at the observed worst** at
  captain decision 190a's cap of 10. **`stage2_cost.maxRpcRequestsPerCandidate` HAD TO MOVE WITH THAT
  CAP and is 500, not 400** (captain decision 197b) — sized to hold the PER-PLANNED-LAUNCH headroom
  constant, `500 / 10 = 400 / 8 = 50` requests a launch, which is why 500 and not another number.
  **The median fitting is not the test**, and that is the trap the raise closed: `stage2.mjs` skips a
  WHOLE launch when the remaining ceiling cannot cover its target list — a launch is never priced
  half-way — and `minPricedFraction` is a hit rate over field ENTRANTS, not over launches, so a
  skipped launch is by construction one of the heaviest and removes a disproportionate share of the
  numerator while every one of its entrants stays in the denominator.
  `thresholds.json` → `stage2_cost.justification.maxRpcRequestsPerCandidate` owns the arithmetic,
  including the breach point (`500 / 8 = 62.5` transactions a launch) and why all of it is an upper
  bound. Pacing is `creation_walk`'s and the two legs are
  serialised — `api.mainnet-beta` rate-limits globally across methods. **`entry-cost-prohibitive`
  gates on the PER-LAUNCH median** (`entryCostPerSolStakedByLaunch`, decision 140a) — every launch
  counts once, so a busy launch cannot outvote the rest; the pooled per-entry distribution ships
  beside it as the finer-grained evidence and is not what the verdict reads. Re-derived from the
  committed tape over the **gated** (proven-opening) population, which is what the bar reads:
  per-launch median 0.0391 against a per-entry 0.0371, worst launch 0.3311, bar 0.12.
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
  decision 140's defect shape. On the current tape: 112 launches, 627 round trips priced end to end,
  median entry cost 0.0308 SOL, field hit rate **0.7384 gross → 0.6045 net**, 87 sign flips; the
  unfiltered reading is printed beside it on every run and under the union rule coincides with the
  gated one (nothing on this tape is unproven), which is exactly what the two key sets exist to make
  visible on a tape where it does not. It asserts the *direction* — netting fees must move the field DOWN — because a sign error there would
  manufacture an edge silently. It deliberately does **not** assert that the net leg vetoes
  `7ufmve7Z…`: post-break its priced round trips are still 0.64 positive at +0.05 SOL net, so that
  wallet is refused by ROOM and only room.
- **`7ufmve7Z…` is the known-negative control, and it is load-bearing twice over.** Stage 0 asserts
  the gate **passes** it (it is competent) *and* that Stage 2 **refuses** it (it is not beatable —
  measured, `analysis/window-population/README.md` §4.1 and §4.3, which re-derive the 2026-06-04
  close blind from the committed tape and are asserted by `test/window-population.test.ts`). Any
  design that scores it as beatable is wrong; `runStage0` fails loudly, including if a later lane
  loosens `minRoomLeft` to fit an output.
- **Everything derived from the fill tape ALONE is GROSS OF FEES and is an upper bound.** The trap is
  concrete, not theoretical: gross, `7ufmve7Z…`'s post-break field reads **358/469 closed round trips
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
  operation's own stake as outsider capital, which **inflates room — the direction that manufactures
  an edge** (the opposite error is rare, era-dependent and biases towards refusal; `measure.mjs` →
  `roomIsProven` owns it). Captain decision 134a: refuse to score them (`measure.mjs` → `roomIsProven`), which on our
  tape removes 24 of 24 false-positive rolling windows for 0 true positives and 81 unmeasured ones.
  Stage 0's **rolling replay** (`stage0.mjs` → `replayRollingRoom`) is the control and fails loudly
  if it reopens; the two slice checks structurally cannot catch it. `bundledTx` /
  `maxWalletsInOneTx` reach the score, record (added at **schema 5**) and rendered line so a saved run
  stays auditable — a schema-≤4 `entry.roomLeft` may be inflated and the record cannot say by how much, and
  a schema-≤4 `stage0` block is not comparable either (era-2 `n` moved 89→86 for the same reason).
  The predicate is **create-slot-scoped, not operation-scoped** — it is a floor on the evidence, and
  no tighter one exists: a deployer-in-bundle reading matches 0 of 235 launches because this deployer
  never shares its own create-slot transaction (decision 139a, `measure.mjs` → `roomIsProven`).
- **HOW OFTEN THAT REFUSAL FIRES IS MEASURED UNDER BOTH HALVES NOW, AND THE HEADLINE DID NOT MOVE:
  1 candidate in 14, and that one is our own control.** **READ THE CENSUS'S RULE AND THE LIVE RULE
  APART.** When it ran, `maxLaunchesPerCandidate` and `minLaunchesSampled` were both 8, so Stage 2
  reached a verdict only for a candidate whose most recent 8 eligible launches were *every one*
  proven, and that all-of-8 is what every figure below counts. **Captain decision 190a then raised
  the cap to 10 against the same floor of 8** — the floor never moves — so the live rule is 8 proven
  of 10 planned and a candidate absorbs two drops before losing its verdict. The census has NOT been
  re-run under it and its record is never retro-edited: its all-of-8 headline is now *stricter* than
  the live rule, which understates scoreability, the safe direction for a finding of this shape.
  Captain decision 173a sized that with
  `tools/deployer-screen/bundling.mjs`, a **windows-only** pass spending **zero keyed requests**;
  decision 183a re-ran it under 182a's union (record **schema 2**), and `bundling.mjs` now **calls**
  `measure.mjs` → `roomIsProven` instead of copying it, so the census cannot drift from the screen it
  is a finding about. Same **14 gate survivors / 112 windows / 0 dropped**: per-launch proven
  **44 of 112 = 0.3929** under the union against **18 = 0.1607** under the superseded
  shared-transaction half; **1 of 14 proven on all eight**, so among the 13 strangers it is **0 of
  13**. **6 of the 14 are permanently unscoreable** — neither half marks anything on any of their
  windows, down from 11 — and **3 now sit one window short at 7 of 8**. So the binding constraint had
  changed hands: it was the sampling rule (decision 141a), no longer the predicate — and 190a is the
  captain answering that finding by giving the rule two launches of headroom rather than by lowering
  the floor. `census/2026-08-03-bundling-census.md` owns the numbers, the cross-checks that make the
  zeros believable, and what they do and do not imply for the pinning; **the pinning is the
  captain's, and the three that sat at 7 of 8 are exactly the population 190a's headroom addresses —
  re-measuring them is a separate decision, not an inference from this record.** `--subject-era` answers the era question offline at n = 1 under both halves:
  our subject is **proven 235/235** while it *bundles* 0% (Dec–Feb) → 58.5% (Apr) → 98.1% (Jul),
  175/235 overall — so the bundling rate is not stationary *for an operator that changes its habit*,
  and a shared-transaction-only reading takes the rule's blind spot for the deployer's habit.
- **AND THE CENSUS'S SHAPE HELD LIVE: the first full-day default run returned NO measured entry
  verdict at all.** 82 gated, 4 gate-passed, 3 scored, **3 of 3 `entry-unmeasured`** — so the run
  could not answer "is any window enterable after costs", and that is the result rather than a
  failure. **The dominant hole is UNPROVEN windows, not walk drops: 18 of the 22 windows that walked
  cleanly were refused by `roomIsProven`, against 8 walk drops over 30 planned.** Two consequences
  bind a lane reading this: 190a's headroom and 198b's guard both landed before it, and **198b fired
  zero times** — every refusal came from the sample-size floor upstream of it, so *the near-bar
  guard is not the binding constraint and tightening its padding alone would convert nothing*. Also
  **182a's adjacency half marked zero extra wallets on all 22 stranger windows**, so on strangers the
  union collapsed to the shared-transaction rule; n = 3 deployers, an observation and not a rate.
  `runs/2026-08-04-full-day-default.md` owns every figure, the refusal-cause split, the spend and
  what it does and does not imply for the unproven-upper-bound follow-up — cite it rather than
  restating them. **Do not carry the pre-existing "roughly one candidate in four" refusal prior
  anywhere**: it predates both changes and this run does not support it.
- **THE EVIDENCE THAT WOULD MAKE A STRANGER'S CREATE SLOT PROVABLE HAS BEEN LOOKED FOR AND IS NOT
  THERE — DO NOT RE-DERIVE THIS** (decision 203a; `census/2026-08-04-proof-coverage-probe.md` owns
  every figure). Two sources were measured to exhaustion. **Shared fee payer**, which the cost leg
  already reads: **0 marks** half (a) does not already make, over 123 tape launches — fully
  subsumed. **Jito bundle membership** (`bundles.jito.wtf`, keyless, no account), anchored on the
  deployer's own create-slot transaction: precise (**779 cohort marks, 0 non-cohort, over 235
  launches, 366 requests, 0 shed**, history reaching Dec 2025) and **a STRICT SUBSET of the shipped
  union — 0 launches where it marks anything (a)∪(b) misses**. Applied to the full-day run's refused
  stranger windows it converts **0 of 18**. **The reason is occupancy, not evidence**: those create
  slots hold 1–10 buy transactions, and where priced the whole non-deployer stake is 0.067 SOL or
  nothing against a ~85 SOL dev buy, so `coordinatedWallets = 0` is TRUE there rather than blind.
  One deployer's own create transaction is in **no Jito bundle on 9 of 9** windows. **A funding
  graph** is out of budget by two orders of magnitude and **a recurrence rule** is already refused
  (`roomIsProven` names it). The CONSEQUENCE of refusing them is now measured and REPORTED beside
  every room median by decision 208b (bullet above; `entry.mjs` → `roomMedianBound` owns it) — and
  read that bullet before quoting the census record's "the refusal moves the room reading up, toward
  enterable": it holds on these stranger windows and **not universally**. What still belongs to
  `slot-zero-guard-unproven-upper-bound` is only turning a refusal into a verdict, because every
  answer to that has the shape of the 203d the captain declined.
- **Stage 0's era-2 constant is `0.771`, not the published `0.768`** (decision 135c). `0.768` is the
  rank-43/44 order statistic of an 89-launch series whose median is `0.7708`; three recipes agree,
  including `analysis/window-population/measure.mjs`. **Never widen that tolerance instead** — it was
  absorbing a real −0.0115 defect and a +0.0028 documentation error that partially cancelled, so the
  check passed for the wrong reason. **Decision 182a closed the residual entirely**: the union rule
  reproduces era 2 at **0.770796 over all 89** where the shared-transaction rule read 0.769153 over
  the 86 it could prove, so the structural and named-cohort estimators are now the same number to
  six decimals. `0.771` and the ±0.02 tolerance are unchanged. Corrections 8 and 10 in the tape's
  `IMPORT.md` own both notes, never the primary record itself.
- **Distributions plus a hit rate, never a mean** — a standing captain bar for this class of claim.
  Sniper outcomes are heavy-tailed on both sides, so a mean is a wrong answer rather than a rough one.
  A test asserts `entry.mjs` contains no mean in its executable half.
- **Only closed round trips have a P&L**, by the dataset's own rule (residual within 0.1% of tokens
  bought). Reproducing it from raw fills agrees with `wallet_launch_pnl.csv` on **1,322 create-slot
  outsider pairs, 0 closure mismatches, max error 5e-7 SOL** — checked in Stage 0 every run. It read
  1,502 until decision 182a, and **every one of the 180 pairs the union removes is a NAMED cohort
  wallet**: the field was reporting the operation's own best-priced wallets as independent snipers.
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
- **A RUN CARRIES THE PREDICTIONS IT WAS MADE TO TEST** (schema 17, captain decision 232c).
  `--predict <path>` reads a document, `record.mjs` → `readPredictions` shape-checks it **before the
  first request** and refuses one that declares its own `source`, since the reader sets that field
  from the path; it is embedded verbatim as the run-level `declaredPredictions` block — **not**
  schema 16's `predictions`, which is the screen's own per-candidate claim summary. A prediction's
  `metric` is a dotted record path **or** a `derived:` name from `DERIVED_PREDICTION_METRICS`, and
  `resolvePredictionMetric` is the one resolver for both — the derived half exists because the
  questions worth predicting are counts over `candidates[]`, not fields. **`reading` is REQUIRED and
  is never defaulted**: that is 231a's rule one level down, and every rate metric names its reading
  in its own name (`medianGateCompletionRate` against `medianVendorPageCompletionRate`). **Nothing is
  evaluated by the screen** — it records the claim and measures the run; grading is another lane's.
  `declaredPredictions: null` means NOTHING WAS PREDICTED, never that a prediction failed. The block is
  shape-checked and **not** content-checked, so what makes these predictions rather than
  postdictions is that the document is committed in its own commit ahead of the run, exactly as
  `thresholds.json` is — the record cannot prove that and does not claim to.

## There are TWO provability predicates now, and the second is not a looser first

`measure.mjs` → `measureWindowParticipation` / `windowParticipationIsProven`, beside `roomIsProven`.
Captain decision 408a, 2026-08-10. **NOTHING CALLS THEM** — no stage, no threshold, no record — and a
test pins that absence, so wiring them is a decision rather than a diff.
`tools/deployer-screen/README.md` → "A SECOND provability instrument" owns the long form; cite it
rather than restating the figures. Five things bind:

- **THE TWO CLAIMS ARE DIFFERENT, NOT NESTED, AND CONFLATING THEM IS THE WHOLE HAZARD.**
  `roomIsProven` licenses a room SHARE to be read as measured (create-slot-scoped, and it is
  co-ordination evidence); this licenses only *the window had a field in it* (whole-window, and it is
  CONTESTED PARTICIPATION). **Neither implies the other**, and no `roomLeft`, `operationShare`,
  verdict or spend may be computed from a reading proven under the new one alone.
  `measure.mjs` → `WINDOW_PARTICIPATION_IS_A_DIFFERENT_CLAIM` is the sentence — cite the constant.
- **THE REASON IT EXISTS IS A MEASUREMENT, AND IT IS THE MIRROR IMAGE OF pump.fun's PROBLEM.** On the
  Meteora DBC tradeable band (July 2026, SOL-quoted, 10–30 SOL migration threshold, 19,826 pools with
  a create-slot fill) `roomIsProven` fires on **0.00%**, max **one wallet per transaction** all month,
  create slot **1 wallet / 1 fill at the median** — not because the evidence is ambiguous but because
  at the create slot there is nothing to co-ordinate. The contest is the following window: median
  **134 s, 134 outsider wallets, 181 fills**. So **captain decision 203a does NOT transfer** — it was
  measured on pump.fun, where the evidence exists and is ambiguous.
  `slot-zero-meteora-dbc-venue-scope` → `report.md` §§2–4 (held in firstmate's records, not in this
  repo) owns every figure.
- **THE BAR IS A REQUIRED PARAMETER AND THE FUNCTION THROWS WITHOUT ONE — a default IS a pin.**
  `WINDOW_OUTSIDER_BAR_MEASURED_AT` is `[5, 20, 50]`, the counts the supply evidence was measured at,
  so 5–50 is **where evidence exists and is not a recommendation**; inside it the supply question is
  already answered either way (the weaker month at the strictest measured bar clears the 1,000-window
  floor by 1.8×), and net-of-fees profitability on that band is UNMEASURED. Pinning the number is the
  captain's. **Profitability on that band HAS since been measured and the venue line is CLOSED — see
  "Meteora DBC: the venue line is CLOSED" below before sizing anything on the supply figures here.
  The predicate is DORMANT, not orphaned, and stays unwired with its bar unpinned.**
- **IT TAKES THE WINDOW, THE DEPLOYER AND THE OPERATION'S WALLETS AS INPUTS, and the error runs one
  way.** Deriving each works on pump.fun and not there: the window ends at curve completion (a
  different table, not in the fill stream), the creator buys its own launch on only **60.59%** of the
  band, and there is no structural rule to recover a book with. A wallet the caller cannot name is
  counted as an outsider, so an unnamed book reads participation **HIGH** — the direction that
  manufactures an instrument where there is none. Evidence is kept in halves (create slot vs after),
  with `windowOnlyOutsiderWallets` the size of what the wide framing adds, so a saved reading
  recomposes narrow or wide without re-walking.
- **THERE IS STILL NO DBC DATA PATH IN THIS TREE** — `pumpfun.mjs` is the only venue module and there
  is no venue abstraction — and **captain decision 409** (how deployer completion is measured there,
  RAISE-85 being unevaluable on it as written) was deliberately OPEN and is now **MOOT**, closed
  unanswered by 413a below. Do not design around an answer, and do not read the closure as one.

## Meteora DBC: the venue line is CLOSED

Captain decisions **413a** (close the line), **414a** (leave the post-migration exit measurement
declined) and the moot-closure of **409**, all 2026-08-10. **The verdict: the windows are real; they
are not opportunities; and this project's screen-the-deployer method does not convert them either —
the line fails on deployer TURNOVER before it fails on edge.** Three lanes measured it for 73.9 Dune
credits total, and the scratch query they shared (public `8280657`) is archived. **Nothing in this
tree changed for the closure** — no threshold, gate, screen or measurement path — and the section
above's predicate is dormant rather than retired. Read this before spending a credit on the venue.

The evidence, held in firstmate's records and not in this repo (see "Citing a report this repo does
not hold"); **point at them rather than restating them**:

- `slot-zero-meteora-dbc-venue-scope` → `report.md` — the venue splits by config threshold. Below
  10 SOL the curve completes IN THE CREATE SLOT and there is no window at all (72.4% of SOL
  launches); the 10–30 SOL band has a real **134 s median window, 134 distinct outsider wallets**,
  and 1,778–4,512 usable windows a month against the captain's floor of 1,000. **Supply was never
  the problem.**
- `slot-zero-dbc-netfees-profitability` → `report.md` — that band loses **13.6–29.5% of deployed
  capital on every sampled day**, across 306,886 wallet-launch pairs, and it is negative **BEFORE
  fees** rather than after. Fewer than 1,000 wallets of ~11,000 hold 99%+ of all gains.
- `slot-zero-dbc-per-deployer-conditional` → `report.md` — **0 of 398 and 0 of 2,039 deployers has a
  profitable field.** The screened advantage is small, overlapping, capital-concentrated, and
  explained by launch size and closure share rather than by deployer skill. Only **18.4%** of June's
  gate-clearing deployers launch at all in July, which is the turnover the verdict turns on.

Three specifics worth keeping in their own right, because they are reusable and not obvious:

- **CURVE COMPLETION ON THIS VENUE IS PURCHASABLE, so a completion measure built on "did the curve
  complete" measures a PURCHASE and not an achievement.** Eight deployers were observed completing
  their own curve with a single threshold-sized buy from a second wallet — one wallet, one pair per
  launch, **10.96–10.98 SOL against a ~11 SOL threshold**, never selling. That is why 409 closed
  without a DBC completion measure being pinned. It is this repo's own `SETTLED_OUTSIDERS` trap one
  venue over (`src/cohort.ts`, and the "a counterparty row is not a trader" hazard above):
  **`payer <> creator` does not mean "independent trader".**
- **RAISE-85 IS UNREACHABLE ON THE DBC CURVE.** The tradeable band completes at ~11 SOL, so anything
  reaching the 85-SOL bar does so in the POST-MIGRATION market rather than on the curve — which is
  what made 352b's measure unevaluable there as written.
- **ONE GAP IS OPEN AND WAS DELIBERATELY LEFT UNBOUGHT — the verdict is not a complete accounting.**
  About **90% of outsider positions still hold tokens when the curve completes** and are marked at
  zero, and **closure share is the strongest single predictor** of a deployer's measured field rate.
  The post-migration exit measurement (**81–221 Dune credits**) is the thing that would settle it.
  **414a declined it because the line is being closed, NOT because the gap was resolved.** A lane
  reopening the venue buys that measurement first.

## Stage 2 scoring has a MEMORY now, and it is allocated by FLOW

`tools/deployer-screen/rotation.mjs`, state at `tools/deployer-screen/rotation/stage2-scored.json`,
record block `scoringRotation` at **schema 20**, its flow term at **schema 23**. Method, rule and
consequences in `tools/deployer-screen/README.md` → "WHICH survivors the cap is spent on"; the
module's own doc owns the argument. Captain decisions **336a** and **399a**, and six things bind any
lane that touches Stage 2:

- **The cap goes where a visit covers the most NEW GROUND, and it used to go to the head of the
  list.** `survivors.slice(0, maxScored)` over a deterministic `mergeSeeds` order meant a daily run
  re-measured the same seven wallets every day, while the median survivor needs ~21.5 days for its
  ten windows to refresh and **0 of 27** refresh within a day — ~168 distinct windows a month
  against ~2,571 of supply, against a floor of 1,000. 336a made it cycle by recency; **399a
  re-allocated it by launch flow, because a round robin gives every survivor the same number of
  visits whatever its tempo and that strands the tail** — over the 58 census July gate-passers the
  same 210 monthly scorings harvest **1,067** windows round-robin against **1,963** by flow, 17 of
  the 58 launching more than the 36.2-window round-robin allowance and stranding 935 between them,
  and full harvest needing 231 visits against 210 available (only 10% oversubscribed, so the loss is
  ALLOCATION and not capacity). Worth **590 → 1,085** usable windows a month on top of `--wallets`
  (398a) **at the superseded 0.5526 — at the re-measured fraction those same two rungs read 193 and
  91, i.e. 399a's harvest gain is a usable-window LOSS on the widened population, and NEITHER rung
  nor the two together clear the floor; the bullet below owns it**; **neither clears the captain's
  1,000 floor alone.** **Neither decision is a capacity
  change**: `maxCandidatesScored` stays 7 (captain decision **339a**; raising it moves the scoring
  cap and the request budget together and is a separate decision), `maxLaunchesPerCandidate` and
  `maxRequestsPerLaunch` stay 10 and 18 so **Stage 2's keyless ceiling — their product — never
  moved**, and no Stage 1 bar moved (loosening the minimum-launches bar is **337a** and letting the
  room bound emit `entry-room-absent` is **343a**; both are required headroom under **400a** and both
  are their own lanes, not this one). It costs **zero in every currency** — one local file plus the
  committed run records, no vendor, and the tempo is a field the gate already measured.
- **THE RANK KEY SATURATES, AND THAT IS WHAT STOPS GREED PARKING A LOW-FLOW WALLET.** `rotation.mjs`
  → `newGroundWindows` is `launchesPerDay × days waited`, capped at `maxLaunchesPerCandidate` —
  ground beyond what one visit reaches is not ground this visit covers. So a low-flow wallet's key
  RISES every day and saturates after `windowCap / launchesPerDay` days, which is exactly how long
  that wallet takes to produce a full visit's worth of new launches; once saturated it ties on flow
  and 336a's least-recently-scored tiebreak is a strict FIFO, so the set ahead of it only shrinks.
  Every gate survivor has a strictly positive tempo by construction (`minTokens` launches over a
  finite span, and a test pins `minTokens >= maxLaunchesPerCandidate` so the never-scored key stays
  exact), so **every survivor saturates in bounded time**. A never-scored survivor ranks first
  whatever anyone's flow, and an **UNREADABLE tempo is SATURATED, never zero** — reading absence as
  no flow would park a wallet permanently and invisibly on OUR coverage. **With no tempo readable
  anywhere the rule degenerates to exactly 336a's**, which is how the superseded allocation stays
  testable through production code with no second comparator to drift from the live one.
- **THREE COSTS THE CAPTAIN ACCEPTED KNOWINGLY, and none may be presented as free.** (1) It is a
  **selection-quality trade**: visiting the highest-tempo wallets most often concentrates the cap on
  the busiest launches, which `stage2_entry.justification.maxLaunchesPerCandidate` already records
  the request cap dropping most often, and the one stranger leg on record read a **0.1333** usable
  fraction. **THAT COST IS NOW MEASURED AND IT IS LARGER THAN A TRADE-OFF: on the widened population
  the usable fraction FALLS as flow rises** (≥1 launch/day: 0.0333 over 9 wallets; <1/day: 0.2917
  over 12; Spearman −0.4719, t −2.333 on 19 df), so flow-weighting the harvest lowers the usable
  count — see the bullet below. (2) The tempo is **LIFETIME**, so a wallet that has gone quiet is still visited on it —
  clamping by last deploy would park a dormant wallet, which is the starvation the saturation ceiling
  exists to prevent. (3) **A MAYHEM-HEAVY SURVIVOR IS UNDER-VISITED**: the tempo is the gate's own
  `tokens / spanDays`, computed over the mayhem-EXCLUDED set (351) while Stage 2 harvests every
  launch, so that wallet saturates late and comes round less often than its real flow merits — the
  same 13-of-58 population 351 protects. It is **under-service and never starvation** (the key still
  saturates, 336a's FIFO still brings it round), and the alternative readings are worse ones;
  `rotation.mjs` → `RotationRow.launchesPerDay` owns the argument.
- **THE USABLE FRACTION HAS NOW BEEN RE-MEASURED ON THE WIDENED POPULATION, IT IS `0.1810`, AND THE
  LADDER DOES NOT CLEAR THE 1,000 FLOOR.** `tools/deployer-screen/measurements/2026-08-09-widened-usable-fraction/`
  owns every figure and reproduces them offline; cite it rather than restating them. **`0.5526` is
  SUPERSEDED for any widened-population sizing** — it was pooled over four vendor-seeded legs
  (2026-08-04→05) whose 0.1333-to-0.90 swing made it unusable, and the widened measurement replaces
  it with 38 room readings over 210 planned windows across 21 deployers and three legs that agree
  with each other (0.2571 / 0.1571 / 0.1286). The two are **different populations and are never
  pooled**; each figure travels with its own date and population. **Restated in 379b's unit —
  distinct usable windows a month — the ladder reads 101 today, 193 with 398a, and 91 with 399a
  flow-weighted (355 if the pooled fraction is applied instead), against a floor of 1,000**; even
  the absolute ceiling of all 58 gate-passers harvested whole reads **362**, so the floor is ~2.8x
  the entire addressable pump.fun supply at this fraction. **The binding constraint is NOT our
  budget and NOT discovery**: 209 of 210 windows walked cleanly and **171 of 210 (81.4%) were
  refused by `roomIsProven`** — the same rule, and the same dominant cause, that
  `runs/2026-08-04-full-day-default.md` found on 18 of its 22 walked windows — and captain decision
  **203a** already established that the evidence which would make a stranger's create slot provable
  has been looked for and is not there. The measurement ran WITHOUT the Dune enumeration leg (the
  key holding the saved queries is short of the pinned worst case), so the gate reading is
  listing-dominated; that gap is bounded and does not change the verdict — the listing gate-passed
  34 of 37 against the census's 37, and even a perfect Dune reading caps the fraction at 0.2833.
  **Sizing anything else on this ladder is a captain decision now, not an inference from this
  measurement.**
- **THE SCREEN IS NO LONGER STATELESS AND REPRODUCIBILITY IS PRESERVED ANOTHER WAY — that condition
  is an acceptance criterion, not a nicety.** A rotation that cannot be reproduced from committed
  evidence is not acceptable here. Three things pay for it and all three must survive any edit: the
  state is **committed**, byte-stable and refuses rather than starting over on an unreadable or
  unknown-version file (starting over silently restores the repeat while the record still reports a
  rotation); the run record **names** it — `statePath`, `stateSchemaVersion` and the SHA-256
  `stateDigestBefore`/`stateDigestAfter`, so **run N's `after` is run N+1's `before`**; and the block
  carries the WHOLE ranked `order` rather than the slice, so `rotation.mjs` → `verifySelection`
  re-derives the selection from the record ALONE. Selector and verifier share one comparator
  (`compareRotationRows`) — do not give the verifier its own. **399a's flow term is subject to that
  condition rather than exempt from it**: a comparator reading anything the record does not carry
  breaks the contract, so schema 23 puts `launchesPerDay` AND the `newGroundWindows` it produced on
  every `order` row and `windowCap` on the block, and `verifySelection` re-derives the key from the
  tempo when handed the run's own `startedAtIso` and that cap. **A schema-≤22 row carries neither key
  and its absence is read as *this row states no flow term*, never as zero flow**, so a pre-399a
  record still verifies by 336a's own rule.
- **With no state every row is never-scored and saturated, so the ranking IS the survivor list's own
  order**, and the first run after either decision landed is byte-identical to the slice it replaced;
  `--no-rotation` keeps that reachable. Rotation off is a recorded STATE (`enabled: false` plus a
  `reason`), never the block's absence, so a stateless run can never be read as a rotated one that
  happened to repeat. **On a schema-≤19 record the block's absence means the head of the list was
  taken** — two such records scoring the same wallets say nothing about those wallets — and **two
  schema-≤22 records scoring the same wallets do not mean what two schema-23 ones do**, since from 23
  the wallet list also says which have the most unharvested flow, so a rate over "wallets this tool
  scored" is drawn from a differently-weighted sample either side.
- **An UNMEASURED verdict advances the rotation** (it consumed the cap and the keyless walk), and a
  survivor set that SHRANK keeps its rows unread so a wallet that drops out and returns resumes its
  place instead of jumping the queue as a stranger. Neither breaches 174b: nobody is dropped and the
  record still surfaces and counts every unmeasured verdict. The committed state is not hand-written
  — `importScoredFromRunRecords` recovers it from `runs/*.json` on **every** run, so a lost state
  file degrades to a slower rotation rather than a wrong one, and it only ADDS.

## The feedback loop — the screen grading its own predictions

`node tools/deployer-screen/grade.mjs`, with `prediction.mjs` (what a run claimed), `outcome.mjs`
(the grading arithmetic and the ledger) and `thresholds.json` → `feedback_loop`. Full method in
`tools/deployer-screen/README.md` → "The feedback loop"; the record shape is schema 16 in
`record.mjs`. The captain's requirement: *"we do the same research in a repeatable way … then loop
the process continuous getting better"*.

- **A RUN THAT DID NOT RECORD WHAT IT PREDICTED CAN NEVER BE GRADED** — not "gradeable later",
  never, because neither the claim nor the instant it stops being in-sample survives anywhere else.
  Every record before schema 16 is therefore **permanently unfalsifiable**, and `grade.mjs` says so
  today: **zero gradeable claims across all three committed records** (two refused by verdict
  vocabulary, `runs/2026-08-04.json` because every candidate it scored reached an unmeasured
  verdict). That is the finding, not a failure — treat it as the reason the record half exists.
- **AN UNMEASURED VERDICT IS NOT A PREDICTION, on either side of the loop.** `prediction.mjs` routes
  every claim through `entry.mjs` → `isDeployerAttributable`, so only the four MEASURED verdicts
  become one; and an outcome walk that reaches an unmeasured verdict grades NOTHING and stays **out
  of the hit rate's denominator**. Reading either as "not beatable" would let the screen score itself
  right whenever its own budget ran out — decision 174b's failure mode wearing a hit rate. The two
  ways a claim can be absent are kept apart and mean opposite things about spend: `not-scored`
  (Stage 2 never ran) and `entry-unmeasured` (it ran and could not answer).
- **THE GRADE IS OUT OF SAMPLE, AND THE BOUNDARY IS A PROOF.** Only launches created strictly after
  the run's `finishedAtIso` are measured: Stage 2 refused every launch younger than its fill
  source's own eligibility gate at the instant it chose its sample, and that instant precedes the
  run finishing. Re-measuring the prediction's own launches would agree with itself and report a hit
  rate near 1.0 meaning nothing, so the filter is asserted against the fetched URLs, not described.
- **Same recipe, same bars, ONE Stage 2.** The outcome is scored at the `stage2_entry`/`stage2_cost`
  values the PREDICTING run recorded, never at today's; a record that cannot supply them leaves its
  claims `recipe-unusable` rather than being graded against a screen it never was. `grade.mjs` and
  `screen.mjs` share `stage2.mjs` → `scoreLaunchRefsEntry` — **do not give the grader its own walk**,
  because it would drift from the screen it grades and the drift would surface as a hit rate rather
  than as a failure.
- **The default costs nothing and the loop is idempotent.** A bare invocation is a dry run: it prints
  the hit rate and the plan and opens no socket; `--live` is the only way to spend. A grade's identity
  is *(source record, wallet, subject)*, so one wallet predicted by two runs is two claims; `hit` and
  `miss` are **latched and never revised**, and an `ungraded` row waits `retryAfterDays` — so a rerun
  the same day costs nothing while the loop still converges with no flag. Two runs over the same
  inputs write the same bytes.
- **Bounds are per-run and refused BEFORE the first request**, priced from each claim's own recorded
  recipe: 6 keyed MadeOnSol requests, 540 keyless, 1,500 Solana RPC, 3 claims. A plan that does not
  fit is refused **whole**, never truncated to fit — a Stage 2 walk cut short holds the earliest
  entrants by slot, which is a biased sample rather than a short one. This lane issues no Dune
  execution and no Helius credit.
- **It re-tunes NOTHING and a test pins that.** No bar moved for it; verdicts are identical with the
  prediction block present and absent. **Stage 3 is DEFERRED, not cancelled (captain decision 237a)**:
  no exit claim is made or graded, and `predictions.subjectsDeferred` records that absence so a
  grader can tell "the stage did not exist" from "the stage could not measure it". Claims are a list
  keyed by subject, so appending `exit` later invalidates no record written under schema 16.

## The window-decay tripwire — when to STOP AND ROTATE

`tools/window-decay-tripwire/` — the instrument that answers *has the window we are currently
trading closed?* Keyless, zero token, two hosts. Full method, both error costs and the ceiling in
its `README.md`; every number reproduces from `node tools/window-decay-tripwire/backtest.mjs`.

- **It watches the DEPLOYER'S OWN TAKE, not the outsiders' P&L, and that is why it is fast.** The
  series is the June report's **T1** — (dev buy + the operation's create-slot stake) ÷ (that plus
  every other wallet's) — read straight off each launch's create slot, one Solana slot after the
  mint. **Achieved latency +24.1 h against a close that took 24.7 h**, with the first launch not
  entered at +26.0 h. The P&L variance route on the same close takes **+48.3 h** *and* false-alarms
  more: watching the consequence is strictly worse than watching the cause when the cause is
  observable. Do not rebuild this on realised P&L.
- **The bar is 0.55 because the June report published it, not because it fits.** `T1 < 0.55
  sustained` was that report's *re-open* condition, written before anyone looked at the closing
  launch. Note the thin part: `Peque` reads 0.5527 and clears it by 0.003, so the single-launch
  reading is not robust and the headline is quoted from the confirmed alarm.
- **TWO CONSECUTIVE READINGS, and the second one is the whole design.** One reading is wrong 3 times
  in 104 open-window launches; two are wrong 0 times, and the three singles are all isolated.
  Measured asymmetry: **a false stop costs ~380x a launch of latency** (median 389.9 SOL of forfeited
  remaining window against −1.37 SOL fee-inclusive for the two launches eaten at the real close),
  because a stop is one-way. Never trade latency for that ratio.
- **A create slot with NO outsider stake yields NO reading — never a share of 1.0** — and an unread
  launch neither advances nor resets the streak. That is T1's first recorded caveat
  (`analysis/window-population/README.md` §9) in code, it covers **25 of the open window's 129
  launches**, and removing it costs 7 false stops.
- **THE CEILING IS ON THE FALSE-ALARM RATE, NOT THE LATENCY, and it is material.** 0 stops in 104 is
  not a rate of zero: the 95% upper bound is 2.84%, at which a window of this length is 95% likely to
  be stopped early at a mean cost of 347.8 SOL — **more than half the 591.7 SOL the whole window was
  worth**. One window cannot distinguish that from zero. Also, **this is a step detector**: it would
  miss a gradual close entirely, and no data here says whether that shape exists.
- **The cohort is load-bearing and a dev-buy-only variant does NOT work.** The deployer's own buy is
  the most exogenous signal available and alone it costs **5–6 false alarms** — the operation raised
  its own stake repeatedly while the window stayed open (the tool's `README.md` §6). Without a
  supplied cohort the detector falls back to the repo's co-ordination rule and reaches the same
  verdict at the same latency with 0 false stops — but that rule recovers **nothing** on this
  deployer before 2026-04, so a create slot with no bundled transaction is silence, never an empty
  cohort (decision 134a's shape).
- **`--dry-run` is the default, `--live` needs `--state`.** The stop needs two consecutive readings
  and a run sees one launch, so without the state file the tool would silently become the
  single-launch alarm this lane rejected — the CLI refuses rather than degrade. The verdict latches:
  this lane never un-stops and never re-polls a wallet it has stopped on.

## The two seedings, measured against each other

`tools/deployer-screen/runs/2026-08-05-seed-comparison.md` (captain decision 232c) runs the screen on
the untiered default seeds and on `--tier good`/`--tier elite`, same day, same code, at an unmoved
`minCompletionRate` of 0.25. **THE SEEDING HAS SINCE BEEN CHOSEN AND IT IS TIERED — captain decision
262a, 2026-08-05.** A default plan is now `good` + `elite`, six enumeration requests rather than
three (`tools/deployer-screen/seed.mjs` → `DEFAULT_TIERS`), on the dominance argument below: the
untiered admitted set is a strict SUBSET, so untiered forfeited 25 candidates and gained none.
**`--tier <t>` still narrows to one tier; the untiered seeding no longer reaches any CLI** and is
reproducible only from the committed records. Read the four bullets below as the evidence FOR that
default rather than as an open question — but the third is now a live cost of the default, not an
observation about a flag. Three records back it, held at
`tools/deployer-screen/measurements/2026-08-05-seed-comparison/` and **not** under `runs/`: they are
the 2026-08-05 measurement whose schema number was superseded — schema-15 candidate rows plus a
run-level `predictions` block that only exists at 17, under the name `declaredPredictions`, so no
version describes them and they are not the grading lane's contract. That directory's `README.md`
owns the statement. **The seeding question is CLOSED — 262a chose tiered, and reopening it is the
captain's.** Four things bind any lane that touches the gate or the feed:

- **THE BAR'S ROLE INVERTS BETWEEN THE SEEDINGS, so an argument about 0.25 is an argument about the
  UNTIERED pool only.** Untiered: 59 of 76 candidates are eligible on `minTokens`+`minSpanDays` and
  the rate bar then admits **2** — it is doing all the work. `--tier good`: 18 of 69 eligible, 14
  admitted. `--tier elite`: 13 of 59 eligible, **13 admitted — the rate bar rejects nobody**, and all
  46 elite rejections are sample-size rejections. On the tiered legs `minCompletionRate` is very
  nearly inert.
- **THE ADMITTED SETS BARELY OVERLAP AND THE RELATION IS A SUBSET, NOT A DISAGREEMENT.** 2 wallets in
  common (Jaccard 0.0741); every wallet the untiered leg admitted the tiered pair also admitted, and
  the tiered pair admitted 25 more the untiered leg never saw. The two tier pools were **disjoint**
  that day, which is tier membership behaving as the trailing window it is.
- **THE TIERED SEEDING IMPORTS THE VENDOR'S RANKING BY SELECTION, NOT BY RATE INFLATION, and
  conflating those two gives the wrong answer.** Rate flattery is **nil**: median (vendor page −
  gate reading) is **0.0000** on all three pools and all three admitted sets, because the two
  readings are IDENTICAL below the 70-record page cap and diverge in **both** directions above it.
  Selection is total: **27 of 27 tiered admissions were reachable through `leaderboard:total_bonded`**
  (the volume ranking) against **0 of 2** untiered ones, which came through `alerts`. Nothing there
  measures whether vendor rank predicts `roomLeft` — that correlation is the obvious next question
  and has not been run.
- **THE "ARTEFACT READS HIGHER THAN THE CONTROL" ASYMMETRY IS A PROPERTY OF THE VENDOR PAGE AND
  REVERSES ON THE GATE READING.** `thresholds.json` → `minCompletionRate` concludes that raising the
  bar removes the operator and keeps the artefacts. Measured: on the page the artefacts read 1.0000
  and 0.9429 against the control's 0.5429, exactly as stated — but on the **gate reading**, which is
  what the bar is compared against, they read **0.3089 and 0.3303 against the control's 0.4325**, so
  a bar in **(0.3303, 0.4325]** removes both and keeps the control. n = 2 artefacts, one control, one
  day. **THE BAR IS STILL 0.25 AND STILL UNMOVED, BUT `thresholds.json` IS NO LONGER SILENT ABOUT
  IT** — captain decision 263b, 2026-08-05, a TEXT correction that changes no value.
  `minCompletionRate`'s justification used to quote the artefacts on the vendor page and the control
  on both readings inside one sentence, then conclude *"there is no bar that removes those two and
  keeps the control"* — a claim true of neither reading on its own. It now states the two readings
  apart and records the (0.3303, 0.4325] band with its limits attached. **Acting on it is still a
  captain decision and 263b explicitly declines to**: n = 2 artefacts and one control, one day, and
  the band's lower edge sits 0.1022 below a control whose own month-to-month rates span 0.256.

Stage 2 answered on this population where it had not before: **10 measured `entry-room-absent`
verdicts** across the three legs against 0 on the 2026-08-04 run, **no `entry-open-after-costs`**, and
the entry-cost leg never ran because room refused first. The known-negative control was refused
**live on a stranger run** for the first time (room 0.2805 over 10 launches, 0 unproven). The scoring
cap of 7 is now the binding constraint on the tiered legs — 13 of 27 survivors went unscored for cap
reasons alone, which is a cap and not a refusal.

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
  lane's bounds carry neither — it spends no Solana RPC at all. So `held` is a triage outcome and
  `screen.mjs` stays the authority; every run prints the standing held count and the one-leg
  near-misses inside it.
- **THAT READING IS BIASED IN BOTH DIRECTIONS AT ONCE, FROM THE SAME SURFACE — "biased towards
  rejection" names only half of it and was the standing text here until captain decision 233a.**
  Measured over the 82 candidates of the screen's last real run, which records both readings per
  candidate (`slot-zero-gate-bar-measure-own-population` §2.1/§2.3, held in firstmate's records, not
  in this repo): it **rejects** through the count bars — **20 of 82** wallets clear
  `minTokens`+`minSpanDays` on the vendor page against **66 of 82** on the gate reading, because a
  70-record page for a wallet creating ~9/day spans three days — while the **rate** it computes reads
  *higher* than the gate's on **37 of 81** wallets (lower on 29, median difference 0.0000) and by up
  to **+0.6929**. The page is not merely a short window, it is a **success-biased** short window. So
  the feed's `held` pile is over-populated and its `queued`/gate-passed pile is over-generous,
  simultaneously — do not reason about it as a one-way conservative filter.
- **`feed.mjs`'s `completionRate` and `screen.mjs`'s are DIFFERENT QUANTITIES that can differ by
  0.69 on the same wallet, and `gateReading` is the field that tells them apart.** Every ledger row
  records it (`ownership-only` for all 75 graded wallets today); `screen.mjs`'s default is
  `creation-derived`. That is what keeps the two legible rather than silently conflated, and it is
  what makes keeping the feed on the vendor page defensible — **never compare or pool the two
  without reading `gateReading` first.** `tools/deployer-screen/FEED.md` → "Why the gate here reads
  ownership, and what that costs" is the long form.
- **Bounds are per-run and pinned in `thresholds.json` → `feed`: 6 enumeration + at most `--gate`
  keyed requests, zero keyless, and `--live` is required to spend anything.** 6 and not 3 since
  captain decision 262a made the seeding tiered, which forced `maxKeyedRequestsPerRun` 15 → 18. The
  daily arithmetic is now **18 × 6 = 108 of 100,000 (0.108%)**, not 90 of ~200 — the denominator
  moved by 500x and 267a restated the share against it. **The bounds were kept anyway and that is
  the point**: a cron is the one caller no human reviews before each spend, so an unbounded lane
  against a 100,000-request day is still unbounded, and raising the cadence without lowering the
  per-run ceiling still makes this lane the largest consumer of a day nothing here tracks.
- **Exit 9 means the feed is dry or broken, not quiet** — a seed serving rows we read no wallet from,
  every seed inert, every gated profile unreadable (needs ≥2 gated, so `--gate 1` disarms it), or 3
  consecutive live, completed runs with no new wallet.
- **`screen.mjs` NOW TAKES A WALLET LIST, so handing a queue over is a file rather than a rebuild —
  but the FEED is still not wired into it.** `--wallets <file>` gates the addresses in a file
  instead of enumerating (captain decision 398a; the screen's own section above owns the rule, the
  arithmetic and what does not move). What has not changed: `feed.mjs` does not write that file and
  `screen.mjs` does not read `feed/ledger.json`, so producing the list is still an operator step,
  and the recurring chain-wide enumeration that would produce one is 350a's own lane.

## How big the addressable population is, and why discovery stopped hunting identities

Four measurement lanes ran 2026-08-07 and settled the questions below. **None of them moved a
threshold, a bar, a verdict or a line of code here, and neither does this section** — every figure
below is evidence from elsewhere, asserted by no test in this repo, recorded because a contributor
cannot see it otherwise and it was expensive to get. Sources are held in firstmate's records, not in
this repo (see "Citing a report this repo does not hold"):
`slot-zero-census-gate-true-denominator` → `report.md`,
`slot-zero-seed-sources-for-1000-verdicts` → `report.md`,
`slot-zero-offlaunchpad-graduation-criterion` → `report.md`,
`slot-zero-operation-fingerprint-discriminates` → `report.md`, and
`kol-cohort-vs-outsider-funding` → `report.md` §§2 and 2.1, consolidated in
`wider-net-ruled-in-ruled-out.md`.

- **THE ADDRESSABLE POPULATION IS ORDER 10², AND THAT IS A CEILING RATHER THAN A CURRENT SHORTFALL.**
  **176,200** pump.fun deployers created a token in 2026-07 and **58** pass the committed Stage 1
  gate (`minTokens` 25, `minCompletionRate` 0.25, `minSpanDays` 14) read over each deployer's
  lifetime pump.fun history; 2026-06 reads 169,323 and **52**. **112 wallets pass that gate in the
  entire recorded history of pump.fun, and 240 at a 15-launch bar** (103 in 2026-07 at that bar).
  **The gate is not the binding constraint and loosening it buys weak operators rather than hidden
  good ones**: `minSpanDays` is inert (12 July exclusions on its own), `minTokens` costs 889, and
  `minCompletionRate` alone removes **6,477 of the 6,535** July deployers clearing the other two —
  of which **90% sit below a 0.05 completion rate**. Every count here is pump.fun-only, so a
  deployer's launches on other venues are invisible to it.
  `slot-zero-census-gate-true-denominator` → `report.md`; the 90% reading is stated in
  `wider-net-ruled-in-ruled-out.md` §1.1.
- **CHAIN-WIDE CREATOR SUPPLY DOES NOT FIX IT, AND THE TWO MULTIPLIERS HAVE DIFFERENT
  DENOMINATORS — do not reconcile them.** Solana produces a mean of **11,938** distinct
  fungible-token creators a day over 2026-05-01 → 2026-08-06 (median 11,584, range 10,011–15,426),
  of which **9,828/day are genuinely new** — first appearances, which is the binding figure for a
  lane like `ledger.mjs` that grades a wallet once and never offers it again — and **61.1% are
  already pump.fun** (7,294/day). So going chain-wide multiplies the DAILY creator supply by
  **1.64×**, and the MONTHLY distinct-creator population by **1.8×** (319,204 chain-wide against
  pump.fun's 176,200), not by an order of magnitude.
  `slot-zero-seed-sources-for-1000-verdicts` → `report.md`.
- **PUMP.FUN GRADUATES TWO DIFFERENT WAYS AND THE CAPITAL SPLIT BETWEEN THEM IS 292×.** Over all
  157,259 pump.fun launches created 2026-07-01→05, split on the venue's own `is_mayhem_mode` flag: a
  classic curve graduation is preceded by a median net quote inflow of **85.005 SOL** into the
  token's own primary market, a **mayhem** graduation by **0.291 SOL** — 292× cheaper, and not
  separable in trade data from a token that churned ~$1,700 and died. This is **not** the second,
  small (4.292-SOL reserve / 12.161-SOL) curve a sibling lane published; at 0.5-SOL resolution that
  bucket holds 1 token. It is not a fringe case either: in 2026-07 mayhem was **27.15% of pump.fun
  launches and 46.41% of its graduations**, and its daily graduation count went **26 → 261 inside
  three days**. **The consequence for this repo is that `minCompletionRate` counts two different
  achievements through one number** — of the 58 all-time gate-passers active in July, **13 are
  mayhem-heavy and read exactly 0.0000 under an economic reading against a real rate up to 0.6897**.
  **Captain decision 351 IS NOW IMPLEMENTED** (schema 19, thresholds 6.8.0 — see the Dune section's
  `is_mayhem_mode` bullet, which owns the rule): a mayhem launch is excluded from both sides of
  `minCompletionRate`, so those 13 are judged on their non-mayhem record rather than reading 0.0000.
  **And captain decision 352b has since replaced what that rate COUNTS with RAISE-85** (schema 21,
  thresholds 6.9.0), which is why the 13 must not be read from the census figure above as landing at
  0.0000: that figure is the pre-351 arithmetic, and the adopted implementation removes the mayhem
  launches before the criterion is applied to anything.
  One thing follows for a reader today. **The 58 / 112 / 240 counts above rest on the pre-351,
  pre-352b pooled reading of graduation, and both decisions require them RE-DERIVED rather than
  adjusted in prose** — `slot-zero-rederive-gate-population-post-351`, which has not run and which
  must re-derive under the measure as 352b adopted it. `tools/deployer-screen/README.md`'s
  schema-15 row now carries the correction in place; the row itself is the record of what schema 15
  did and is deliberately not rewritten.
  `slot-zero-offlaunchpad-graduation-criterion` → `report.md` §4 and §8.2, and its
  `decision-351-mayhem-not-competence.md`.
- **RAISE-85 IS THE VENUE-AGNOSTIC SUBSTITUTE FOR GRADUATION, AND CAPTAIN DECISION 352b HAS NOW
  ADOPTED IT AS *THE* COMPLETION MEASURE — read this entry as the EVIDENCE behind that decision, not
  as an open question.** *Net quote inflow into a token's own primary market over its first 24 hours,
  reaching 85 SOL-equivalent.* Computable from one cross-venue trade table with no venue-specific
  code, and against the classic curve it reproduces pump.fun's own graduation almost exactly on that
  157,259-launch sample: **precision 1.0000 — zero false positives against 108,310 non-graduating
  tokens — recall 0.9918, F1 0.9959**, with the 85 SOL constant read off the data rather than fitted
  (graduating non-mayhem tokens read 85.005 SOL, p50 = p99, to three decimals). **The rule and its
  seam with 351 now live one section up** — see "WHAT THAT RATE COUNTS AS A COMPLETION IS *RAISE-85*
  NOW" under the deployer screen's stages, which owns the implementation, the order of the two
  exclusions and the three things that bind. Two things this entry keeps, because they are the
  evidence and not the rule. **The direction is entirely towards refusal — zero deployers gain
  admission at any floor** — which under this repo's stated asymmetry (a false rejection is permanent
  and invisible) is the dangerous direction; what makes adopting it safe anyway is that the
  zero-false-positive property makes the rate a LOWER BOUND, so the measure can only ever refuse, and
  the bar is therefore not to be lowered to buy recall. And its limits travel with it: **equivalent
  strictness across venues is not established** and the rate-level result is one month of one venue.
  `slot-zero-offlaunchpad-graduation-criterion` → `report.md` §§2.2, 3, 8.2 and 9.
- **DISCOVERY PIVOTED TWICE, AND THE SECOND STEP CLOSED IDENTIFICATION. RANK BY MEASURED BEHAVIOUR;
  DO NOT TRY TO IDENTIFY WHO ANYONE IS.** First (captain decision 359d) the question moved from
  scoring individual deployers on past competence to hunting the OPERATIONS that create tokens, on
  the three measurements above: the competent-deployer population is permanently order 10², the
  completion-rate bar's cost is 90% concentrated below a 0.05 rate, and chain-wide creator supply is
  only 1.8× pump.fun's. **Then identification itself was closed** (captain decision 370a), because
  every wallet-side identifier tried collapsed against the chain-wide population: the
  funding-and-launch template matches **53.8%** of chain-wide fungible-token creators (7,122 of
  13,238 on 2026-07-15) and the chain median funding-to-launch gap is **27 seconds**, making the
  studied operation's own 4m31s *slower* than typical; the full four-rung stack retains
  **1.51%**, which is still **200 wallets in one day across 58 distinct launcher-tool fee accounts**;
  the fee account common to all three of that operation's template launches is pump.fun's own
  protocol fee recipient, the genuinely third-party addresses were never the same twice, and that one
  operation's own tool address changed **six times in eight months**. The surviving discriminator —
  an exactly round SOL funding amount, **2.06% of chain-wide creators, 273 wallets/day** — narrows
  and does not identify, and is **not being pursued**. **Measurement is what keeps working**: it is
  keyless, free, and already the core asset. **Do not open another wallet-side identifier hunt, and
  read any text that sounds like one as stale.** Captain decisions 359d and 370a
  (`2026-08-07-slot-zero-359d-wider-net-operation-pivot.md`,
  `2026-08-07-slot-zero-370a-rank-not-identify.md`); evidence in `wider-net-ruled-in-ruled-out.md`.
  **This does not weaken `src/cohort.ts` → `CREATE_SLOT_COHORT`**, whose byte-identical genesis is a
  far narrower observation on six named wallets and already says common ownership is not formally
  established — what is ruled out is the template as a way of FINDING operations at chain scale.
- **FUNDER-ADDRESS CLUSTERING DOES NOT WORK, and it is a measured negative worth not repeating.**
  In the studied operation **no funder is shared by any two of the nine wallets whose genesis was
  read exactly**: the deployer and three cohort launchers were each funded from a *different*
  custodial exchange hot wallet holding 41,939–51,439 SOL. The operator funds each launcher from a
  fresh exchange withdrawal, so the signal was the funding **template**, not the funding **address**
  — and per the bullet above neither is being pursued as an identifier now.
  `kol-cohort-vs-outsider-funding` → `report.md` §2.
- **DUNE CANNOT LABEL SOLANA ADDRESSES, AND THIS IS PERMANENT.** `labels.addresses` holds **1.96
  billion rows of which 7,261 are Solana, every one a validator**. It is an EVM product. This is the
  single most re-derived dead end in this project's history — **do not buy it again**. For an address
  label, `tools/venue-label/` is the route this repo actually has, and pump.fun's own `Global` config
  settles a protocol fee recipient for free. `wider-net-ruled-in-ruled-out.md` §1.7.
- **Two facts a reader of this section will need, both already owned elsewhere in this tree — cite
  them, do not restate them.** The custodial wall is a permanent limit of the method, it is wider
  than "an exchange", and a true on-chain DEX swap is never one: `README.md` → "The ceiling of the
  method: shared custodial venues" owns all of it. And **this project's tests are population
  assertions rather than fixture tests**, so a failure means the population moved and not that a
  fixture drifted: "Where the data lives" above owns that, including why sampling the tapes for
  testing is refused.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
