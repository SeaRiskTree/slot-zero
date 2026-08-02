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
  `meta.reached_mint`, not file existence; the four partial files hold unrelated later
  trading. `Tape.windowTape()` gates on this, `incompleteWindowTape()` is the diagnostic.
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
- **`?creator=` lists by *current* creator, and the creator record can move on-chain.**
  §1.2 and `kol-deployer-entity-cluster/report.md` §6. This silently deleted this operation's
  best launch (`maxxing`, $7.7M ATH, 83% of its lifetime creator-fee income) from its own
  history. **A creator's listed history is a lower bound, and the token that goes missing is
  exactly the good one.** Read the on-chain `creator` (bonding-curve PDA `["bonding-curve",
  mint]`, offset 49) before trusting it, and validate the offset on a known token first.
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
  Treat a null as "retry", never as "absent".
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
  concurrent jobs earned a sustained 429 lockout. Sustainable: one process, batches of 5–8
  `getTransaction`, ~1.4 s between requests.

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
- **Free tier only** — ~200 requests/day, ~10/min, **shared** across whatever holds the key, and keys
  expire every 30 days. `/{wallet}/history` is PRO+. Paid tiers are refused standing policy.
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
  concrete, not theoretical: gross, `7ufmve7Z…`'s post-break field reads **362/473 closed round trips
  positive**; fee-inclusive, that same population made **+0.54 SOL per launch with 51 of 106 wallets
  negative**. So in the entry score the field leg can only ever **veto** a verdict, never earn one,
  and every P&L field name ends `GrossOfFees`.
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
