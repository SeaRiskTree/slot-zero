# Import provenance

This directory is a verbatim copy of the scout deliverable
`kun-agent-workspace/data/kol-deployer-population-tape/`, imported **2026-07-29**.

**Not one row was reformatted, re-sorted, re-derived or "cleaned."** This is a primary
record and its value is that it is exactly what was measured. `README.md` (column
semantics) and `report.md` (the findings) are the originals, unmodified.

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
