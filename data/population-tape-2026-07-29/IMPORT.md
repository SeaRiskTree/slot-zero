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

Later evidence has contradicted the imported record eleven times. **The originals stay unmodified** —
that is what makes this directory a primary record — so the corrections live here, and this
is the file to add to when it happens again. The first two come from
`kol-cohort-vs-outsider-funding/report.md` (2026-07-29, read-only, keyless, zero metered
requests), recommendation 4. **Neither touches a measured figure in this directory; both are
about what a figure means.**

Items 4–7 come from `kol-bond-timing-vs-dev-exit/report.md` §4 (2026-07-29, keyless, **zero metered
requests**), which measured the graduation time of all 103 graduated launches directly instead of
proxying it. **All four land in `report.md` §3.5, and they are one failure repeated:** a proxy that
is a valid *bound* was read as a *timing*, and every §3.5 sentence that depends on when a launch
graduated is wrong in the same direction. No column in this directory changes — three of the four are
about how a column may be read, and the fourth (§3.5's 32-minute median) is a prose figure that the
shipped file does not produce. Each is re-derived below from the files here rather than carried
across, and what is re-derivable in this repo is asserted in `test/reproduction.test.ts`.

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

4. **`curve_last_tx_s` is a valid bound and not a usable timing.** §3.5 calls it "a validated
   upper-bound proxy" for graduation and §10.6 quotes "a validated error of 0–70 % on six checks".
   Against the 103 directly measured graduation times the overshoot ratio (proxy ÷ truth, with the
   truth floored at 1 s because two launches bond at +0 s) runs **p25 1.48 · median 8.85 · p75 126 ·
   p90 1,934 · p95 11,994**, with **32 of 102 within 2× and 27 over 100×** — 102 and not 103 because
   `maxxing` carries no `curve_last_tx_s` (correction 5) — re-derived here by
   joining the bond-timing report's Appendix A to this directory's `launches.csv`, reproducing its
   §4.1 to rounding. The cause is `report.md` §9.1's own finding seen from the other side:
   `getSignaturesForAddress` keeps returning *referencing* transactions — bot sweeps that move no
   tokens — for months after the migration, so "the last transaction the curve ever sees" is not
   "the last trade". This directory's own `README.md` glosses the column the same way ("an
   upper-bound proxy for graduation"); the bound is real, the usefulness it implies is not.

   **The bound direction survives**; only its tightness is the fiction. Nothing graduates later than
   its proxy by more than the measurement's own error bar: the two ratios below 1 (`shrek` 0.995×,
   `Baby` 0.997×) sit inside their own bisection bracket, as does `Cracked` — which its §4.1 counts
   as a third undershoot although the ratio is exactly 1.000×.

   **This directory proves it on its own files, with no fetch,** on the 18 launches whose window tape
   spans the migration and whose graduation time is therefore known to the second — the first
   `pump_amm` fill, itself a *tight* upper bound rather than the migration instant exactly, and one
   that errs the conservative way: a bond earlier than that fill only widens the overshoot, so every
   ratio below is a floor and the figures stand (correction 7). The proxy
   overshoots on **all 18**, from **1.22×** (`Lala`, +245 s true against +300 s proxy) to
   **1,036,042×** (`Bullieve`, **+1 s true against +1,036,042 s proxy**); 2 of 18 land within 2× and
   10 of 18 are over 100×. Two things fall out that the bond-timing report did not state: `Bullieve` is
   looser than either of its named worst cases (`Beagles` +53 s against +4,307,478 s, `Fox` +10 s
   against +3,800,581 s), so **"up to five orders of magnitude" is itself an understatement — six**;
   and on the six launches §3.5 names, the proxy's error runs **22 % to 1,505,160 %** (`Dummy`, +35 s
   true against +526,841 s), so §10.6's "0–70 % on six checks" does not reproduce on them either.
   §10.6 does not say which six it means.

5. **§3.5's 32-minute median is not in the shipped file.** It states "Median for graduated launches:
   **32 minutes** after the mint" for the proxy. `curve_last_tx_s` over the **102** graduated
   launches carrying it — every one but `maxxing` — has a median of **7,763.5 s = 129 minutes**.
   The bond-timing report §4.2 reaches the same 129 and likewise cannot reconcile the 32. **No column
   changes**; the sentence is simply not this file's number, and 129 minutes is what a reader
   recomputing it will get. The **measured** median graduation time is **1,042 s = 17.4 minutes**
   (bond-timing report §2.3, all 103 graduations, 871 keyless requests) — evidence from elsewhere and
   not asserted here. **Both numbers matter and neither is 32:** 129 is what the shipped column says,
   17.4 is what happened, and §3.5's figure sits between them, which is why it never looked wrong.

6. **"The deployer is out before graduation in every case" is false — it is wrong on 10 of 103
   graduations.** All ten are inside a tape window, so this directory holds every counterexample;
   the bond-timing report's measurement of the other 85 is what establishes there are no further
   ones. Seven are the large-buy mode §3.6 already documents — `Lockin` (+0 s), `Trump` (+0 s),
   `float` (+1 s), `Bullieve` (+1 s), `Milly` (+2 s), `Bulls` (+4 s), `Float` (+8 s) — which bond
   before the deployer has sold **anything**: `dev_sells = 0` and `dev_sol_out = 0` across their
   whole 60-second windows, which is what `dev_exit_complete = 0` is recording. The other three are
   ordinary stakes where the sniper flood alone completed the curve — `TruthGPT` bonds at +3 s
   against an exit at +42 s, `Sol` at +5 s against +17 s, `Fox` at +10 s against +47 s. On all three
   **the deployer's last sell in the window executes on `pump_amm`**, the graduated pool; on every
   other in-window graduation that carries a deployer sell at all it executes on the curve, and the
   seven large-buy ones carry no deployer sell at all. §3.6 already made this correction for the
   large-buy mode ("the predecessor's *it never sells into its graduated pools* holds for the mode it
   sampled and **not in general**"); §3.5's blanket sentence was never updated to match it.

   **The test §3.5 leans on is sufficient, not necessary.** A graduated pool has no curve floor and
   trades back below the constant within seconds, so a `price_dev_zero` below the graduation price
   does not mean the token had not graduated — it reads 0.156, 0.351 and 0.439 of it on those three.
   **The price fact itself survives intact:** 0 of the 228 complete exits finishes at or above the
   graduation price, the highest reaching 0.79 (`Dummy`). It is the timing inference drawn from it
   that does not follow.

7. **Eighteen reconstructed windows span graduation, not thirteen.** §3.5 says "Thirteen
   reconstructed windows span the moment the token graduated." Scanning all 235 anchored tapes for a
   `pump_amm` fill gives **18**, on which the venue sequence is monotone `pump` → `pump_amm` with
   zero violations. Two independent routes agree: this repo's reproduction found it from the tapes
   (repo `README.md`, "Discrepancies found while reproducing", item 6) and the bond-timing report
   §4.4 found it while measuring graduation times. §3.5 names only six of its thirteen, so which five
   it omitted cannot be recovered. **The shortfall is not pedantry:** seven of the eighteen are the
   instant-bond launches of correction 6, and undercounting exactly those is what let §3.5 conclude
   the deployer is always out first. **The 14.70× constant is unaffected** — it holds on all 18,
   across dev buys from 3.46 to 56.30 SOL.

8. **The era-2 operation share published as `0.768` is not the median of its own stated
   population; it is `0.771`.** `slot-zero-june-regime-change/report.md` §5.1 prints the
   post-2026-06-04 cell as dev 14.814814813 · co-ordinated 19.75 SOL · 6 wallets ·
   independent 10.84 · **share 0.768**, over the 89 launches of this directory that carry a
   window tape and reached the mint. Every other cell in that row reproduces exactly. The share
   does not: the 89-launch series has median **0.7708**, and `0.768` is its **rank-43/44 order
   statistic** — one to two ranks below the middle of the series it is a median of.

   Three independent recipes over this directory agree on `0.7708 → 0.771`, and one of them is
   committed here: summing create-slot buy fills from `window/*.jsonl.gz`; summing
   `wallet_launch_pnl.csv` `sol_in` where `in_create_slot = 1`; and
   `node analysis/window-population/measure.mjs`, whose independent T1 reading for the same
   regime prints **0.771** (`analysis/window-population/README.md` §9).

   **What produces `0.768` is dropping the `meta.reached_mint` gate.** That admits the two
   truncated era-2 launches (`8iXLMfcY…`, `H23di4NX…`, both 2026-07-18) whose "create slot" is a
   mid-window slot containing no deployer at all, giving n = 91 and a median of `0.76751`. But
   that same 91-launch population drives the independent-capital cell to **10.47**, and the
   published row says **10.84**, which is the n = 89 value. So the published row is internally
   inconsistent by one cell, and this directory is not ambiguous about which population it
   describes. The `reached_mint` gate is the one this directory's own coverage rule requires
   (see "Coverage caveats" below, and the repo `README.md`).

   **No figure in this directory changes** — this directory *is* the evidence. What changes is the
   constant a reader may check a reproduction against: `tools/deployer-screen/stage0.mjs` now pins
   era 2 at `0.771` and says so in its output (captain decision 135c). Re-pinning was chosen over
   widening that check's tolerance because the tolerance was absorbing two errors of opposite sign
   that partially cancelled — a real **−0.0115** defect in the screen's co-ordination rule and this
   **+0.0028** documentation error — so the check had been passing for the wrong reason. Both are
   now removed rather than accommodated; `tools/deployer-screen/README.md` → "Stage 0" owns the
   decomposition.

9. **Three of the four launches with "no tape" now have complete ones.** `report.md` §10.1 and its
   coverage table call `Marciana`, `Leo`, `Fridge` and `GLM` the run's only gaps — "returned an empty
   tape across three passes" — and `tape = none` in `launches.csv` is what stopped their dev exits
   from ever being measured. The keyless re-walk in `data/graduated-life-tape-2026-08-02/`
   (2026-08-02, **zero metered requests**) reached the mint on three of them, with the endpoint
   confirming nothing older exists: **`Marciana` 4,846 fills, `Leo` 2,697, `Fridge` 9,737**, each
   over that launch's own mint → graduation + 1 h window. `GLM` did not graduate and was not walked,
   so it is still untaped. **No column in this directory changes** — `tape = none` remains the
   correct description of *this* directory's contents, and the new tape lives beside it rather than
   in it; that dataset's `README.md` → "Three launches that previously had no trade tape at all"
   owns the coverage proof, and everything it adds is still gross of fees.

10. **The screen's era-2 reproduction now lands on `0.770796` over all 89 launches, and two figures
   published in `slot-zero-bundling-predicate-question/report.md` are artifacts of that report's own
   evidence scripts.** Two separate things, recorded together because one change produced both.

   **(a) The constant the screen checks against did not move; what it measures with did.** Captain
   decision 182a widened `tools/deployer-screen/measure.mjs`'s co-ordination rule to the UNION of the
   existing shared-transaction rule and a deployer-anchored contiguous block-index run, read from the
   `sid` field already present on every fill in `window/*.jsonl.gz`. Correction 8 above stands
   unchanged and `0.771` is still the pin. What moved is the reproduction beneath it:

   | estimator | population | share |
   |---|---|---|
   | shared-transaction rule | all 89 era-2 launches | 0.759250 |
   | shared-transaction rule | the 86 it could prove | 0.769153 — what Stage 0 printed under decision 134a |
   | **union rule** | **all 89, all provable** | **0.770796** |
   | named-cohort rule | all 89 | 0.770796 |

   The **−0.0115 defect correction 8 names is now fully removed rather than reduced**: the three
   era-2 launches that carried no bundled create-slot transaction all carry a block-index run, so
   the structural estimator and the named-cohort estimator become the same number to six decimals
   over the full 89. The ±0.02 tolerance was not touched, in either direction.

   **No figure in this directory changes.** Two derived figures published elsewhere in this repo do:
   `stage0.stage2SeamReproduction` era 2 goes from `n: 86, nRoomUnproven: 3` to `n: 89,
   nRoomUnproven: 0`, and the count of create-slot outsider (wallet, launch) pairs the field
   measurement reproduces `wallet_launch_pnl.csv` over goes from **1,502 to 1,322** — the 180 pairs
   it drops are every one a *named cohort wallet*, i.e. the operation's own wallets that were being
   read as independent snipers. The dataset's own rows are unchanged and `wallet_launch_pnl.csv`
   still carries all of them; what changed is which of them the screen calls an outsider.

   **(b) Two figures in `slot-zero-bundling-predicate-question/report.md` do not reproduce, and the
   mechanism is named here so nobody re-derives them.** That report's `evidence/probe.mjs` reads
   `launches.csv` with `r.split(',')`. **Two rows of this directory's `launches.csv` carry a comma
   inside a quoted `name` field** — `4FEphC5X…` (`"even in the darkness, we glow"`) and `EsPnd3XR…`
   (`"i play to win"`) — so their `created_utc` parsed as a fragment of the token name. A leading
   space sorts before a digit, so both April launches were ordered to the FRONT of the series, and
   the two orderings differ at 57 of 235 positions. Consequently:

   - the report's rolling trailing-8 replay under the union, **`present: 84, absent: 144`**, is
     **`present: 88, absent: 140`** in the shipped code, which orders launches by
     `window/{mint}.meta.json` → `created_timestamp`. `windows: 228`, `unmeasured: 0` and
     `falsePositives: 0` are identical under both orderings, so nothing about the decision turns on
     it. The shipped figures are the ones `tools/deployer-screen/stage0.mjs` produces and pins.
   - the report's pre-March slice, **"17 launches, 51 cohort wallet-instances"**, is **15 launches
     and 45 instances**; the other two are the April launches above. The finding itself is
     unaffected — adjacency alone recovers **45 of 45** with **zero** false marks, and the room
     reading equals ground truth to four decimals on **15 of 15**.

   The marking rule is not in question: run against that report's own `evidence/exp4.mjs`
   implementation over all 235 launches, the shipped rule produces an identical marked set and an
   identical per-launch `adjacencyMarks` on every one — **0 differences** — and feeding the report's
   own launch ordering into the identical replay reproduces its 84/144 exactly. `report.md` and that
   report are primary records and are not edited; this entry is the correction.

11. **`window/*.jsonl.gz` carries a WRONG `sol` on 658 of its 107,439 fills (0.61%), and this is the
   first correction that lands on a COLUMN rather than on prose.** Found 2026-08-05 by
   `tools/deployer-screen/dune-reproduction.mjs`, which ran the screen's committed Dune entry
   statement over all 235 taped launches and compared every fill. The two sources agree on the token
   amount on **107,439 of 107,439** rows and disagree on the SOL amount on **1,042**, in two shapes
   that must not be conflated:

   **(a) 658 rows where THIS FILE is wrong, understating `sol` by factors of ~25–40.** Three
   independent things say so, and the first is decisive:

   - **The chain.** Of those 658, **22 reach a create-slot outsider's realised P&L**. All 22 were
     arbitrated with `getTransaction` on `api.mainnet-beta`: the trading wallet's own lamport
     balance change agrees with the statement's figure on **22 of 22** and with this file's on
     **0**. Example — `CympZjku…` / `pekN74ko…`, transaction
     `5pV9eNiyMxR9…`: this file records a 0.072133332 SOL buy, the statement 1.913860914, and the
     wallet's balance moves **−1.939904256 SOL**, which is the larger quote plus fee and rent.
   - **This file's OWN price column.** On every affected row `sol / base` contradicts the row's own
     `psol` by the same 25–40x, while `psol × base` lands on the statement's figure. Unaffected rows
     agree within a couple of percent.
   - **The wallets' own round trips.** The affected fills would make several of them 25x+ returns
     inside a single slot on a curve that had not moved.

   The affected transactions carry pump.fun's newer `BuyExactSolIn` instruction. **That is a lead,
   not an established cause**, and only the 22 were checked on-chain — the other 636 share the shape
   and the internal contradiction, which is evidence rather than proof.

   **The consequence travels to `wallet_launch_pnl.csv`**, which is a projection of these tapes: its
   `realised_sol` is wrong for the **12 (mint, wallet) pairs** those 22 fills belong to. The largest
   error is 1.84 SOL, on `CympZjku…` / `pekN74ko…`. `closed_in_window` is NOT affected on any of
   them — closure is decided on token residuals and the token amounts are correct throughout.
   The twelve pairs are enumerated with their transactions in
   `tools/deployer-screen/dune-reproduction.mjs` → `REFUTED_REFERENCE_PAIRS`.

   **(b) 384 rows where the statement returns `sol_raw = 0` and NEITHER source is wrong.** All 384
   are the whole of one launch — `maxxing`, `97nnzgv9…`, the second of the two launches sharing
   that symbol — which is **quoted in USDC rather than SOL**: its create transaction moves 36.99
   USDC and 0.0189 SOL. The decoded `SwapEvent` reports the SOL amount, which is genuinely zero;
   the trade endpoint this tape was built from reports a SOL-EQUIVALENT valuation. They are
   different quantities.

   **Do not conflate that count with "rows where the statement returns zero", which is 393.** The
   other nine are rows the tape ALSO reads as zero, so both sources agree on them and they were
   never disagreements: 393 zero-returning rows minus the 9 agreements leaves the 384 counted here,
   and 658 + 384 = 1,042.
   **Any SOL-denominated aggregate over `97nnzgv9…` is a SOL-equivalent valuation, not SOL**, and
   that launch happens to contribute zero closed create-slot outsider pairs, so nothing published
   here rests on it.

   **No row in this directory is edited** — the never-reformat rule is absolute, and that is what
   makes this a primary record. `test/dune-entry-reproduction.test.ts` asserts the committed
   measurement, and `tools/deployer-screen/measurements/2026-08-05-dune-entry-reproduction/` holds
   it in full, including the unexcluded reading.

The funding investigation also settles `report.md` §10.3 — **both `5brv79eF…` and `EgQX9R3Q…` are
genuine outsiders, confidence high** — and strengthens §7's "the six create-slot wallets are
part of the operation" from inference toward evidence. Neither is a correction to this
directory; see the repo `README.md`, "What is open".

## Coverage caveats that must travel with the data

Restating the three that silently corrupted an analysis during the research, plus a fourth that
the loader cannot enforce. The loader in `src/` enforces the first three in its types; see the
repo `README.md`.

1. **Every tape-derived P&L column is gross of fees.** Only `onchain_*.csv` are
   fee-inclusive. One wallet reads +31.2 SOL on the tape and −12.2 SOL in reality after
   11.9 SOL of priority fees (`report.md` §5.5).
2. **Only rows with `closed_in_window = 1` have a complete P&L** — 22,333 of 46,553 pairs
   (48%). Summing the rest fabricates losses (`report.md` §4.1).
3. **`dev_exit_complete = 0`** marks the seven launches whose deployer figures are
   window-truncated; `dev_position_timeline_large_buys.csv` is the correct source for those
   (`report.md` §3.6).
4. **`onchain_create_slot_pnl.csv` prices only 30 of the 41 May 2026 launches, so every May
   comparison drawn from it understates by roughly 27%.** Fee-inclusive pricing exists for 123
   of 239 launches and **none before 2026-05**; by month it is **30 of 41 in May, 41 of 41 in
   June, 52 of 56 in July** (the four July misses are exactly the four tapeless launches). May
   is the only month whose coverage gap is large, and it is not neutral: it makes May look
   *smaller* than the months it is compared against, which is the direction that manufactures a
   rise. The June regime-change report, section 9.1, is the worked case — cohort `2CHrnc2L…`
   reads **+71.38 SOL** in May from this file, but its **tape-gross** per-launch rate
   (+2.43 SOL per launch) is identical on the priced 30 and the 11 unpriced May launches, so
   the like-for-like May total is **≈ +97.6 SOL**. The apparent
   "cohort doubled its take" across May → July is that 27% hole plus a rising launch count
   (30 → 41 → 52 priced tokens); per launch the cohort's take is **flat** (+2.38, +2.22,
   +2.76 SOL) while its return per SOL of capital fell about **five-fold** (1.67 → 0.278).
   **Compare per launch, never by monthly total, and never across the May boundary without
   restating May on its priced 30.**

   **This one is prose, not a type, and that is a limit rather than an omission.** The other
   three are properties of a *row* — a unit brand, an absent field, a truncation flag — so the
   loader can withhold the value and make the mistake a compile error. Every row here is
   present and correct; the defect only appears in the *denominator* of a month-level
   aggregate the caller builds itself. `src/` exposes no month-level aggregation to gate, and
   no per-row type can refuse a sum a caller writes over rows that are each individually
   valid. `Tape.onchainRows()` and the readers folded from it — `onchainPositions()` and
   `onchainRoundTrips()` — carry the warning in their JSDoc, which is as close to the call
   site as the loader can put it.

Four launches (`Marciana`, `Leo`, `Fridge`, `GLM`) have `tape = none` and no trade-derived
columns at all. 235 of 239 launches carry a tape.
