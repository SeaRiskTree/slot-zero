# The Dune entry statement, run against every launch on the committed tape

**2026-08-05. Gate 3 precondition 1.** `dune-fills.mjs` → `ENTRY_SQL`, executed against all **235**
launches of `data/population-tape-2026-07-29/` that proved coverage, and compared — through this
repo's own production functions — against the dataset's committed `wallet_launch_pnl.csv`.

`reproduction.json` is the record. `node tools/deployer-screen/dune-reproduction.mjs` reproduces the
plan and its estimate for free; `test/dune-entry-reproduction.test.ts` asserts the result.

## The headline

| | |
|---|---|
| launches measured | **235 of 235** |
| rows returned | **107,453** against the tape's 107,439 |
| launches where the statement was SHORT | **0** |
| create-slot disagreements | **0** |
| PumpSwap fills — decision 256a's union | **10,476 across 18 launches**, exactly the tape's own |
| closure mismatches, all 1,322 pairs | **0** |
| max realised error, 1,310 unrefuted pairs | **5.000e-7 SOL** |
| max realised error, all 1,322 pairs | **1.842e+0 SOL** — see "The twelve" |
| custody | saved query verified **before** the first execution |

The second-to-last row is the one worth reading twice. **5.000e-7 SOL is not merely inside the 1e-6
bar; it is the identical figure the tape-sourced leg produces.** Measuring from Dune's decoded rows
and measuring from the committed fill tape land on the same number, so the statement is not "close
enough" — the two routes agree.

## The bar, and exactly what was excluded from it

The bar is `stage0.mjs` → `verifyFieldReproduction`'s own: **0 closure mismatches and a max realised
error under 1e-6 SOL**. (The 5e-07 recorded elsewhere in this repo is a *measured result*, not a
threshold, and nothing here treats it as one — it is simply where this measurement also landed.)

**Closure is met on the whole population**: 0 mismatches over all 1,322 pairs, no exclusion involved.

**The realised half reads 1,310 of the 1,322 pairs, by captain decision 293a**, which judges the bar
over the pairs the chain does not refute on three standing conditions: the exclusions stay
enumerated by transaction, the unexcluded reading stays printed beside them, and closure stays
checked over the whole population. All three hold here. The exclusion is enumerated rather than
described — `dune-reproduction.mjs` → `REFUTED_REFERENCE_PAIRS` names every one with a transaction
you can re-check — and it is **not a tolerance**: the unexcluded reading (1.842 SOL) ships in the
same record, so a reader who rejects the exclusion can read the number it would otherwise hide
without rerunning anything.

## The twelve — the tape is what the chain disagrees with

Over 107,439 fills the two sources agree on the **token** amount on every single one, and disagree
on the **SOL** amount on 1,042 (0.97%), in two shapes:

**658 rows where the committed tape's `sol` is too small**, by factors of 25–40. Twenty-two of them
reach a create-slot outsider's realised P&L, and all twenty-two were arbitrated with
`getTransaction` on `api.mainnet-beta`: **the trading wallet's own balance change agrees with the
statement on 22 of 22 and with the tape on 0.** The tape's own `psol` column agrees with the
statement too — on the affected rows `sol / base` contradicts the row's own `psol` by the same
25–40x. The transactions carry pump.fun's newer `BuyExactSolIn` instruction, which is a lead on the
cause and is not established here.

Those 22 fills are the 12 excluded pairs. The finding is filed as correction 11 in
`data/population-tape-2026-07-29/IMPORT.md`, **ratified as filed by captain decision 294a**; no
dataset row was edited.

**384 rows where the statement returns `sol_raw = 0`, and neither source is wrong.** All 384 are the
whole of one launch — `maxxing`, `97nnzgv9…`, the second of the two launches sharing that symbol —
which is **quoted in USDC, not SOL**. The decoded `SwapEvent` reports a SOL amount that is genuinely
zero; the trade endpoint reports a SOL-equivalent valuation. **That count is not the same as "rows
the statement returns zero on", which is 393**: the other nine are rows the tape reads as zero too,
so both sources agree on them and they were never disagreements — which is what makes 658 + 384 =
1,042 the whole of the split. **That launch contributes zero closed create-slot outsider pairs, so it never
reaches this comparison — luck, not design.** A lane scoring a non-SOL-quoted launch through the
Dune source would read those zeros as free entries, and nothing today stops it: **captain decision
295b files that guard against the Gate 3 cutover rather than against the statement or this suite**,
so it is recorded here and enforced nowhere.

## One launch where the TAPE is short

`Killswitch` returns **14 more** curve fills from Dune than the tape holds, all in the last 80 s of a
300 s window — the swap-api walk sheds and backs off, so its own tail can be incomplete. None of the
14 belongs to a create-slot outsider, so no P&L moved. The two directions are counted apart in the
record (`launchesDuneShort` 0, `launchesDuneLong` 1) because only *short* is this route's failure
direction.

## What it cost, and what that says about the cost model

| | estimate | actual |
|---|---|---|
| whole-tape run | **657.195 credits** (12 × 10 compute + 26.9 MB at 20 credits/MB) | **~495** |
| first whole-tape run, superseded | 657.195 | **529.954** |
| probes and validation | — | ~15 |

**Retrieval is ~95% of this lane's bill, not compute** — 24.7 MB of result bytes against ~4.9 credits
of compute per execution. That inverts the assumption `thresholds.json` → `stage2_entry_dune`
reasons from ("the lever is windows scanned, not rows returned"), and the two are not in conflict:
that block returns one aggregated row per launch and this statement returns every fill.

The pinned `WORST_CASE_CREDITS_PER_EXECUTION` was **re-derived for this statement rather than
carried**: at the borrowed 225 the plan priced at 3,237 credits and the guard refused it, correctly
and uninformatively. Measured from the balance itself — 0.25 credits of compute at a 65-second scan
hull, 1.91 at 16.1 days — it is pinned at 10.

**The first whole-tape run's 530 credits bought rows that were then thrown away**, so correcting the
statement's AMM half meant buying all 107,439 again. `--rows` and `--from-rows` exist because of
that: a change to the *comparison* must never cost a re-fetch. The row cache is a working file and is
deliberately **not committed** — Dune's terms are derive-and-discard.

## Two fields were added to this record after the run, and neither was measured again

Both are stated here rather than left to look like run output:

- **`entrySqlSha256`** — sha256 of `normaliseSql(ENTRY_SQL)`, computed by
  `dune-reproduction.mjs` → `entrySqlFingerprint` and now written by every run. It was back-filled
  because the statement's text has not changed since the commit that carries this record, so the
  record *was* produced by exactly this text. It exists because the saved-query **id** survives an
  edit: without it, editing `ENTRY_SQL` leaves every assertion below green over a record describing
  a different statement.
- **`result.fieldDisagreementsOnUnrefutedReferences`** — the gating half of the field-entrant check,
  added when that check was made to gate at all. It is **0 by derivation, not by re-measurement**:
  the unfiltered count is 0 on every one of the 235 launches in this record, and the filtered
  reading drops the same enumerated wallets from both sides, so it cannot differ here.

## Limits

- **One deployer, one tape.** Agreement here says the decoded tables and the trade endpoint report
  the same fills for these 235 windows. It establishes nothing about a launch outside them.
- **Gross of fees on both sides.** `wallet_launch_pnl.csv` is a projection of the same fill tape, so
  this proves the statement reproduces those fills — not that the resulting P&L is fee-inclusive.
- **Only 22 of the 658 suspect tape rows were checked on-chain.** The rest share the shape and the
  internal contradiction, which is evidence and not proof.
- **Nothing routes through this statement.** `screen.mjs` selects the swap-api fill source on every
  run; Gate 3 has not been convened.
