# Import provenance

This directory is a verbatim copy of the scout deliverable
`kun-agent-workspace/data/kol-deployer-population-tape/`, imported **2026-07-29**.

**Not one row was reformatted, re-sorted, re-derived or "cleaned."** This is a primary
record and its value is that it is exactly what was measured. `README.md` (column
semantics) and `report.md` (the findings) are the originals, unmodified — where later
evidence has contradicted their prose it is recorded under "Corrections" below rather than
edited into them.

The dataset was produced with **zero metered provider requests** — every source is
keyless and public (`swap-api.pump.fun`, `frontend-api-v3.pump.fun`,
`api.mainnet-beta.solana.com`). See `report.md` "Spend accounting".

## What was excluded, and why

| excluded | size | why |
|---|---:|---|
| `sigindex/` | **97 MB** | Raw per-mint RPC cache: `[signature, slot, blockTime, err_flag]` for all 1.46M transactions referencing each bonding curve. It is an input, not a finding — every number derived from it is already in `launches.csv` (`chain_tx_total`, `chain_tx_ok`, `chain_tx_failed`, `chain_tx_ok_first30s`, `chain_tx_all_first30s`, `curve_last_tx_s`). The dataset's own `README.md` §Size says to delete it if you only need the derived tables. Committing 97 MB of regenerable signature strings to carry six already-computed columns is not a trade worth making. |
| `tape/` | 104 KB | Two files for one mint (`BLs49Duf…`, `Luka`) from an early single-launch probe, `complete: false`, 600 trades. `window/` carries the same mint properly: `complete: true`, `reached_mint: true`, 1,419 trades. Superseded scratch, undocumented in the dataset README. |

## What was kept, and why

`window/` **was kept** (20 MB, 478 files) even though it is per-mint. It is not a cache —
it is *the tape*: 107,439 fills, each with its counterparty wallet, slot, side, SOL, tokens
and price. Every derived table in this directory is a projection of it, and it is the thing
`report.md` §9.1 validated against the chain. Dropping it would leave the repo unable to
recompute any of its own findings, which for a research repo is the whole asset. Its 20 MB
is gzipped JSONL and does not need Git LFS.

## Size

**35 MB total; largest single file `wallet_launch_pnl.csv` at 9.9 MB.** Comfortably
committable as plain Git objects — no LFS, no sampling, no truncation. Nothing was dropped
for size other than the two directories named above.

## Corrections

Later evidence has contradicted the imported prose three times. **The originals stay unmodified** —
that is what makes this directory a primary record — so the corrections live here, and this
is the file to add to when it happens again. The first two come from
`kol-cohort-vs-outsider-funding/report.md` (2026-07-29, read-only, keyless, zero metered
requests), recommendation 4. **Neither touches a measured figure in this directory; both are
about what a figure means.**

1. **`EgQX9R3Q…` did not stop in May.** `report.md` §2 ("ran the same way from March to May
   and stopped") and §4.3 ("`EgQX9R3Q…` ran March–May and stopped") describe this dataset's
   window into *this deployer's* launches, not the wallet. On-chain it ran until
   **2026-07-06 19:25:32 UTC**, and two of its book-mates stopped within two seconds of it
   while a fourth stopped on 2026-07-10: the book was retired in one batch, which is a
   decision by whoever runs it rather than a wallet fading out. (Funding report §6.1.)

2. **`EgQX9R3Q…` and `2CQgjcdN…` are not independent rows.** `report.md` §4.2's counterparty
   table and §5.5's per-wallet fee table both list them separately.
   Both are funded by, and sweep to, the same private bankroll `9BhkaAyb…`, which runs a
   sniping book of **at least five** wallets: `EgQX9R3Q…`'s **+47.1 SOL** and `2CQgjcdN…`'s
   **−12.2 SOL** are the same operator's P&L. The figures themselves are correct; reading
   either row as one independent observation is not, and **the book's total has not been
   measured**. (Funding report §8.1, Appendix B; encoded in `src/cohort.ts` →
   `SETTLED_OUTSIDERS`, asserted in `test/reproduction.test.ts`.)

   This directory corroborates it, which is worth recording because it was there all along:
   the two wallets appear on **48 and 62 launches here and share not one** — `EgQX9R3Q…`'s
   last is `2026-05-25T12:02:46Z` and `2CQgjcdN…`'s first is 33 hours later. One wallet hands
   over to the next. (`launches.csv` `created_utc` joined to `wallet_launch_pnl.csv`. The
   dates are measured; reading the adjacency as a deliberate rotation is inference, and it is
   only available once the funding graph says the two are one operator.)

3. **`report.md` §9.4's public-RPC pacing no longer holds.** Its "batches of 5–8 `getTransaction`,
   separate rate-limit buckets" guidance (and `brief.md`'s "batch 5–8 with 3s pacing") was
   re-measured on `api.mainnet-beta.solana.com` on **2026-08-02** and batching is now actively
   harmful — the limiter weights each batch entry. **No figure in this directory changes**; only
   the advice for a *new* walk does. The measurement and the sustainable pacing are owned by
   `AGENTS.md` → "pump.fun / Solana provider facts" and pinned in
   `tools/deployer-screen/thresholds.json` → `creation_walk`; do not re-derive them here.

The funding investigation also settles `report.md` §10.3 — **both `5brv79eF…` and `EgQX9R3Q…` are
genuine outsiders, confidence high** — and strengthens §7's "the six create-slot wallets are
part of the operation" from inference toward evidence. Neither is a correction to this
directory; see the repo `README.md`, "What is open".

## Coverage caveats that must travel with the data

Restating the three that silently corrupted an analysis during the research. The loader in
`src/` enforces all three in its types; see the repo `README.md`.

1. **Every tape-derived P&L column is gross of fees.** Only `onchain_*.csv` are
   fee-inclusive. One wallet reads +31.2 SOL on the tape and −12.2 SOL in reality after
   11.9 SOL of priority fees (`report.md` §5.5).
2. **Only rows with `closed_in_window = 1` have a complete P&L** — 22,333 of 46,553 pairs
   (48%). Summing the rest fabricates losses (`report.md` §4.1).
3. **`dev_exit_complete = 0`** marks the seven launches whose deployer figures are
   window-truncated; `dev_position_timeline_large_buys.csv` is the correct source for those
   (`report.md` §3.6).

Four launches (`Marciana`, `Leo`, `Fridge`, `GLM`) have `tape = none` and no trade-derived
columns at all. 235 of 239 launches carry a tape.
