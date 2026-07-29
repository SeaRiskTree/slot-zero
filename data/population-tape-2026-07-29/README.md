# kol-deployer-population-tape — dataset

Reconstructed trade tape and derived P&L for every pump.fun launch by deployer
`7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL`.

**Read `report.md` first — especially §1 (coverage), §4.1 (what a P&L row does and does not mean)
and §10 (limits).** All 239 launches are covered; what is bounded is *time within each launch* —
every trade-derived column covers the first 60 s after the mint (300 s on 21 launches, 120 s on 4)
and will be wrong if read as a whole-life figure. **Every tape-derived P&L column is gross of
transaction and priority fees**; only the `onchain_*` files are fee-inclusive, and report §5.5 shows
that difference flipping a wallet from +31 SOL to −12 SOL.

All data is keyless and public. Sources, and which columns come from which:

| source | keyless | used for |
|---|---|---|
| `swap-api.pump.fun/v2/coins/{mint}/trades` | yes | the trade tape (`window/`, `full/`, and everything derived from them) |
| `frontend-api-v3.pump.fun/coins?creator=` and `/coins/{mint}` | yes | the launch universe, ATH/market-cap columns |
| `api.mainnet-beta.solana.com` (public Solana RPC) | yes | `sigindex/` census, `onchain_fee_sample.csv`, tape validation |

**No metered provider request was made. Zero.**

---

## Files

### `launches.csv` — one row per launch (all 239 rows always present)

`tape` says what trade data exists for that launch: `window` (mint → mint+`tape_window_s`),
`full` (whole life), or `none` (not reconstructed). **Every trade-derived column is blank when
`tape` is `none`, and is bounded by `tape_window_s` when `tape` is `window`.**

| column | meaning |
|---|---|
| `mint`, `symbol`, `name`, `created_utc` | identity; `created_utc` from pump.fun `created_timestamp` |
| `graduated` | 1 if pump.fun reports `complete` |
| `ath_mcap_usd`, `ath_t_s` | pump.fun's own all-time-high market cap, and seconds from mint to it. **Provider claim, single source.** Price = mcap / 1e9 (total supply is 1e9 on every one of these). |
| `mcap_now_usd` | pump.fun market cap at snapshot time 2026-07-29 01:30 UTC. Provider claim. |
| `twitter` | the `twitter` field of the token's metadata document (the cited X post) |
| `chain_tx_total`, `chain_tx_ok`, `chain_tx_failed` | on-chain transaction census of the bonding-curve account over the token's whole life (`getSignaturesForAddress`). Independent of the tape. |
| `chain_tx_ok_first30s`, `chain_tx_all_first30s` | same census restricted to mint → mint+30 s |
| `curve_last_tx_s` | seconds from mint to the last transaction the bonding curve ever sees — an upper-bound proxy for graduation (report §3.4) |
| `listed_creator`, `creator_field_moved` | pump.fun's current `creator` for the mint, and 1 when it is no longer the subject wallet |
| `tape`, `tape_window_s` | coverage of the trade tape for this launch |
| `n_trades`, `n_wallets` | trades and distinct non-deployer wallets inside the tape window |
| `dev_sells`, `dev_sol_in`, `dev_sol_out`, `dev_net_sol`, `dev_net_usd` | the deployer's own ladder. SOL amounts are the **swap quote amounts** reported by pump.fun, i.e. gross of the 1 % venue fee and of transaction fees. |
| `dev_first_sell_s`, `dev_zero_s` | seconds from mint to the deployer's first sell, and to the sell that takes its position to zero |
| `dev_exit_complete` | 1 if the deployer sold ≥99.9 % of its dev buy inside the window |
| `price_devbuy`, `price_dev_zero`, `price_t60` | SOL per token at the dev buy, at the deployer's zero point, and at +60 s |
| `window_peak_price`, `window_peak_t_s`, `window_peak_mult` | highest traded price **inside the tape window** and when. Not the lifetime peak — use `ath_mcap_usd` for that. |
| `sol_usd` | median SOL/USD implied by the tape's own paired `priceUsd`/`priceSol`, during this launch |
| `n_createslot_wallets` | non-deployer wallets whose first trade is in the same slot as the create |
| `n_wallets_30s`, `n_winners_30s`, `n_winners_all` | wallets first trading within 30 s; how many of them end the window positive; ditto over all wallets |
| `best_wallet`, `best_wallet_sol`, `best_30s_wallet`, `best_30s_sol` | best counterparty overall and best among those entering within 30 s |

### `dev_exit_ladder.csv` — one row per deployer sell

`t_s` seconds from mint · `slot` · `tx` · `sol` received (gross) · `tokens` sold ·
`price_sol`, `price_usd` at the fill · `cum_frac_of_devbuy` cumulative fraction of the dev buy
liquidated after this rung.

### `wallet_launch_pnl.csv` — one row per (wallet, launch)

| column | meaning |
|---|---|
| `first_t_s`, `last_t_s`, `first_slot` | first/last trade seconds from mint; slot of first trade |
| `in_create_slot` | 1 if the wallet's first trade is in the same slot as the create transaction |
| `closed_in_window` | 1 if the wallet's position is flat (≤0.1 % of tokens bought) by the end of the tape window. **Only these rows have a complete P&L.** |
| `n_buys`, `n_sells`, `sol_in`, `sol_out` | counts and gross swap SOL in/out inside the window |
| `tokens_bought`, `tokens_sold`, `residual_tokens` | token flow and unsold remainder at window end |
| `residual_mark_window_sol` | residual marked at the last price seen inside the window |
| `residual_mark_now_sol` | residual marked at the token's latest known price (`mcap_now_usd`/1e9, converted at 74.03 SOL/USD) |
| `realised_sol` | `sol_out − sol_in`. Exact and complete **only when `closed_in_window = 1`.** |
| `pnl_sol_gross_of_fees` | `realised_sol + residual_mark_now_sol` |
| `pnl_window_marked_sol` | `realised_sol + residual_mark_window_sol` |

**Every P&L column is gross of transaction and priority fees.** For wallets racing into the create
slot those fees are large and are measured separately in `onchain_fee_sample.csv`.

### `counterparties.csv` — one row per wallet, aggregated across launches

Sorted by `pnl_closed_sol` descending.

`launches_traded` · `launches_closed_in_window` / `launches_open_at_window_end` ·
`pnl_closed_sol` (sum of `realised_sol` over closed pairs only — the headline, honest measure) ·
`closed_wins`, `closed_hit_rate`, `median_closed_pnl_sol` ·
`pnl_sol_gross_of_fees` / `realised_sol` / `pnl_usd_gross_of_fees` (all pairs, marked) ·
`sol_deployed`, `sol_returned`, `n_buys`, `n_sells` ·
`median_first_trade_s` · `launches_entered_within_30s` · `launches_in_create_slot`.

### `first30s_best.csv` — the ten best early entrants per launch

Restricted to wallets whose first trade is within 30 s of the mint. Adds
`slots_after_create` (0 = the create slot itself), `first_buy_price_sol` and
`fill_mult_vs_devbuy` (their fill price as a multiple of the deployer's own dev-buy price).

### `price_path.csv` — the price path per launch

Long format: `point` ∈ {`end_of_second_0`, `dev_zero`, `t30`, `t60`, `t120`, `t300`, `window_peak`},
with `t_s`, `price_sol`, and `mult_vs_devbuy`. Points beyond the tape window are absent.

### `onchain_fee_sample.csv` — measured transaction cost of racing the create slot

One row per (transaction, create-slot wallet) from `api.mainnet-beta.solana.com`, for a sample of
launches. `fee_lamports` is the transaction's total fee (base + priority) paid by `fee_payer`;
`sol_delta_lamports` is that wallet's true net lamport change, which nets fees, the swap and any
rent; `token_delta` is its token change in the same transaction. Multi-wallet bundle transactions
appear once per participating wallet, with `is_fee_payer` distinguishing who paid.

### `window/` and `full/` — the raw trade tapes

- `window/{mint}.jsonl.gz` — the trade tape from the mint to mint+`window_ms`, one JSON object per
  trade, oldest first. Fields: `slot`, `sid` (pump.fun `slotIndexId`, the within-slot ordering key),
  `tx`, `ts` (ISO, second resolution), `u` (wallet), `k` (`buy`/`sell`), `p` (`pump` = bonding curve,
  `pump_amm` = graduated PumpSwap pool), `sol` (swap quote SOL), `base` (tokens), `psol`/`pusd`
  (price per token in SOL and USD).
- `window/{mint}.meta.json` — `n`, `pages`, `complete`, `reached_mint`, `window_ms`. **A launch is
  only counted as covered when `reached_mint` is true**; a meta file is not written otherwise, which
  is what makes the harvest resumable.
- `full/` — reserved for whole-life tapes; none were reconstructed in this run (report §10.2).

### `sigindex/` — on-chain transaction census per launch

`{mint}.json.gz` holds `[signature, slot, blockTime, err_flag]` for every transaction referencing the
bonding-curve account over the token's life; `{mint}.meta.json` holds the counts summarised into
`launches.csv`. This is the independent on-chain check on the tape.

---

## Resuming the harvest

The harvest is per-launch and idempotent: a launch is done when its `*.meta.json` exists, and the
work list is `frontend-api-v3.pump.fun/coins?creator=<deployer>` walked by items **received**
(the server caps a page at 70 whatever `limit` says), sorted by `created_timestamp` descending.
Delete a `meta.json` to redo that launch. The tape walk itself is a cursor page-walk over
`swap-api.pump.fun/v2/coins/{mint}/trades?limit=100`, seeded with
`cursor=9999999999990000000000-<mint_ms + window_ms>` and paged backwards until a page's oldest
trade predates the mint. See report.md §8 for the pacing that endpoint tolerates.

---

## Files added during the run

### `launch_universe.jsonl` — the 239-launch work list

One pump.fun coin record per line, exactly as the venue returned it. 238 come from
`?creator=<deployer>` walked by items **received**; the 239th (`maxxing`) was fetched by mint after
the sibling task established that `?creator=` lists by *current* creator and this one had moved. It
carries an extra `_added_by` field. **This list is a lower bound on the population**, not the
population — see report §1.2.

### `control_create_slot.csv` / `control_create_slot_wallets.csv`

The control: the create slot of 70 launches by **other** pump.fun deployers, sampled from our own
`launch_events` over 2026-07-27 onward, 24 of them using the identical 14.814814813-SOL dev-buy
preset and 46 at other stake sizes. Per launch: `n_create_slot_wallets`, `multi_wallet_tx` (transactions carrying more than one
wallet's fill), `max_wallets_in_one_tx`, `creator_is_first`. The wallets file is the recurrence count
of each create-slot wallet across those 70 launches — that is what separates a general-purpose sniper
from a wallet that only ever appears on this operator's launches.

### `onchain_fee_sample.csv`, `onchain_create_slot_pnl.csv`

True fee-inclusive P&L from `api.mainnet-beta.solana.com` for create-slot entrants — 111 launches
and 3,977 transactions in `onchain_create_slot_pnl.csv`, plus a first 6-launch pass in
`onchain_fee_sample.csv`. **These are the only fee-inclusive P&L in the dataset.** `fee_lamports` is
the transaction's whole fee (base + priority) and is attributed to `fee_payer`; `sol_delta_lamports`
is the named wallet's real lamport change and already nets fees, the swap and rent.
`onchain_fee_sample.csv` is the first pass (6 launches, every create-slot entrant);
`onchain_create_slot_pnl.csv` is the wider pass over as many covered launches as completed.

### `dev_position_timeline_large_buys.csv`

The deployer's own token-account timeline for the launches where it does **not** follow the 15-SOL
preset. Reconstructed from the chain (the deployer's Token-2022 account for that mint), because the
exit falls outside the tape window on every one of them. `pre_tokens`/`post_tokens` are the
deployer's position either side of the transaction and `sol_delta` its true lamport change, so a row
with a large positive `sol_delta` is a sale and a row with `sol_delta ≈ −0.174` moving the whole
position is a **transfer out**, not a sale.

**Caveat that must travel with `launches.csv`:** on those launches `dev_sol_out`, `dev_net_sol` and
`dev_zero_s` are window-bounded and therefore wrong as whole-launch figures —
`dev_exit_complete = 0` is the flag that says so, and this file is the correct source for them.

### `wallet_behaviour_profiles.csv` — how each repeat counterparty actually trades

One row per wallet appearing on ≥5 covered launches (medians over its launches):
`median_stake_sol` · `median_entry_t_s` (seconds after the mint) ·
`median_entry_price_mult` / `median_first_exit_price_mult` (fill price as a multiple of the
deployer's own dev-buy price on that launch) · `median_hold_s` · `median_buys` / `median_sells` ·
`create_slot_frac` (share of its launches entered in the create slot) ·
`median_closed_pnl_sol` / `total_closed_pnl_sol` / `closed_hit_rate` over its closed round trips.

This is the file to read for the strategy question: it makes the difference between the repeat
winners and the repeat losers legible in three columns (report §5.6).

---

## Size

About 115 MB, almost all of it `sigindex/` — 1.46 million transaction records across 238 launches,
gzipped. Delete that directory if you only need the derived tables; everything in `launches.csv`
that comes from it is already summarised into the `chain_tx_*` and `curve_last_tx_s` columns.
