# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

`slot-zero` is a **private research repo** studying pump.fun launch microstructure. There is
no production here. It holds one primary dataset and a loader over it — see `README.md` for
what is established and what is open.

## Build and test

- `npm test` — `tsc --noEmit` then `vitest run`. **Both halves matter**: the type guards in
  `test/type-guards.test-d.ts` are compile-time assertions that fail `tsc`, not `vitest`.
- `npm run test:unit` runs only vitest. No runtime dependencies; `npm ci` is dev-only.
- **Nothing in this repo may reach the network or read a credential.** Enforced structurally
  by `test/loader.test.ts` → "this repo does not reach the network and reads no credential",
  which greps `src/` for sockets, `process.env` and key-shaped strings. Keep it that way; the
  entire dataset was built keyless and its value depends on staying reproducible offline.

## The dataset

`data/population-tape-2026-07-29/` is a **primary record — never reformat, re-sort or
"clean" a row.** Column semantics are in its `README.md`, findings in its `report.md`,
import and exclusion decisions in its `IMPORT.md`. `sigindex/` (97 MB of raw RPC signature
cache) and a superseded `tape/` probe were excluded; everything else is verbatim.

Three traps that each silently corrupted an analysis during the research. The loader makes
all three compile errors — do not work around them, and read `src/types.ts` before adding a
view:

1. **Every tape-derived P&L column is gross of fees.** Only `onchain_*.csv` is
   fee-inclusive. `GrossSol` and `NetSol` are unassignable brands (`src/units.ts`).
2. **Only `closed_in_window` rows have a complete P&L** (48%). `OpenPair` has no
   `realisedSolGrossOfFees` field at all.
3. **`dev_exit_complete = 0`** marks seven window-truncated launches; `DevExitTruncated`
   has no complete net figure, only a pointer to the correct file.

Two data hazards the loader handles and callers must not undo:

- **Symbols are not unique — key on `mint`.** Two launches are called `maxxing`, one of them
  the operator's best result ever.
- **All 239 mints have a `window/*.jsonl.gz`, but four never reached the mint.** Coverage is
  `meta.reached_mint`, not file existence; the four partial files hold unrelated later
  trading. `Tape.windowTape()` gates on this, `incompleteWindowTape()` is the diagnostic.

## pump.fun / Solana provider facts

Learned at real cost; the citations are to
`data/population-tape-2026-07-29/report.md` unless stated.

- **The trade endpoint is the affordable route to a per-token tape.** §9.2:
  `swap-api.pump.fun/v2/coins/{mint}/trades?limit=100`, keyless, 100 fills a page, the
  swapping wallet on every row. Its cursor is `<slotIndexId>-<timestampMs>` and **the
  timestamp component seeks**, so a launch window costs 3–15 requests instead of walking the
  token's whole history. This turned a ~500,000-request job into ~2,000. `/v1/…/trades` is
  410; `frontend-api-v3` `/trades/…` is 404.
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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
