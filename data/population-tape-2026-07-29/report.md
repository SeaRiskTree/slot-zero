# kol-deployer-population-tape — scout report

**Subject:** deployer wallet `7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL`
**Question:** does a viable trading strategy exist around this operation? Reconstruct the tape —
every launch, every counterparty, every fill — and read it honestly.
**Mode:** read-only investigation. No project code changed, no PR. All scratch discarded.
**Date:** 2026-07-29. **Repo at** `65074b3`.
**Predecessors, all read in full:** `data/kol-dev-wallet-sell-side/report.md` (its §6 method notes
were followed and are why this data is not silently wrong), `data/kol-dev-wallet-7ufmve7z/report.md`,
and — mid-run, on a coverage correction relayed from the sibling task —
`data/kol-deployer-entity-cluster/report.md` §3.1 and §6.

**The dataset is the other half of this deliverable.** `README.md` in this directory documents every
file and column. The report cannot carry 239 launches of transaction detail and does not try to.

---

## Spend accounting — read this first

**Metered provider requests: ZERO.** Not a reduced cap — none were made and none were needed.

| Source | Keyless | What it gave |
|---|---|---|
| `swap-api.pump.fun/v2/coins/{mint}/trades` | yes | **the trade tape** — every fill, with the counterparty wallet, side, slot, SOL, tokens and price |
| `frontend-api-v3.pump.fun/coins?creator=` and `/coins/{mint}` | yes | the launch universe, ATH and current market cap |
| `api.mainnet-beta.solana.com` (public Solana RPC) | yes | the whole-population transaction census, the true fee-inclusive P&L, the deployer's own token-account timelines, and the independent validation of the tape |
| local dev Postgres (`launch_events`) | n/a | the control sample of other deployers' launches; single `SELECT`s only |

Roughly **7,000 keyless HTTP requests**, paced and retried. No backfill, poller, sweep or worker was
started against the project's own services; every database query was a single `SELECT`; nothing was
written anywhere except this directory.

**The most reusable thing in this report:**
`swap-api.pump.fun/v2/coins/{mint}/trades` serves the complete per-token trade tape, keyless,
cursor-paginated, with the counterparty wallet on every row. The predecessor costed a population
reconstruction at ~30 parsed RPC transactions per token; this endpoint returns 100 fills per request
and **is provably complete** (§9.1). It turned a ~500,000-request job into ~2,000. Its `cursor` is
`<slotIndexId>-<timestampMs>` and **the timestamp component seeks**, so a launch window can be
fetched directly without walking the token's whole history.

---

## 1. Coverage — read every later number against this

| | count | note |
|---|---:|---|
| Launches in the universe | **239** | pump.fun's 238 for this creator **plus `maxxing`** (§1.2). **A lower bound, not the population.** |
| **Launch-window trade tape reconstructed** | **239 attempted, 235 usable** | mint → +60 s (210), +120 s (4) or +300 s (21). Four launches — `Marciana`, `Leo`, `Fridge`, `GLM`, all 2026-07-18/20 — returned an empty tape across three passes and are the only gaps. |
| **On-chain transaction census** (whole token life) | **238 of 238** | complete for every pump.fun-listed launch |
| Trades in the tapes | **107,439** | every one carries its counterparty wallet |
| Distinct counterparty wallets | **20,388** | 14,187 of them appear on exactly one launch |
| (wallet, launch) pairs | **46,553** | **22,333 (48 %)** are flat by the end of the window and so have a complete P&L (§4.1) |
| Deployer exit ladders | **228 complete of 235** | the other 7 are the second operating mode (§3.6) and were reconstructed from the chain instead |
| Fee-inclusive on-chain P&L | **123 launches, 4,394 transactions** | §5.5 |
| Control: create slot of **other** deployers' launches | **70** | the check on whether any of this is unusual (§6) |

**Coverage is complete on the launch dimension** — every month of the operation's life:

```
2025-12  11/11    2026-01   3/3    2026-02   1/1    2026-03  21/21
2026-04  65/65    2026-05  41/41   2026-06  41/41   2026-07  52/56
```

**What is bounded is time-within-launch, not launches.** Every trade-derived number covers the first
60 seconds after the mint (300 s on 21 launches, 120 s on 4). That window contains the deployer's
entire exit on 228 of 235 launches and 48 % of all counterparty round trips; §4.1 characterises the
other 52 % precisely rather than leaving them as a hole.

The harvest is resumable: a launch is done when its `window/{mint}.meta.json` exists and nothing else
is state.

### 1.1 What the rate limits cost

The trade endpoint sits behind Cloudflare and rate-limits hard: sustained throughput settled at
roughly **one page per 1.5–15 s** depending on how recently it had been pushed, with a ~25 % refusal
rate. Full coverage took about four hours of wall clock. Two notes worth keeping:

- I ran four harvester processes concurrently for about 25 minutes without noticing, because a
  `pkill -f` pattern kept matching its own command line and killing the shell instead of the target.
  That produced the worst of the throttling. **Check `pgrep` output, not `pkill` exit status.**
- The public Solana RPC is a genuinely separate budget. `api.mainnet-beta.solana.com` sustained
  ~0.6 req/s on `getSignaturesForAddress` and ~1 req/s on `getTransaction`, concurrently, with no
  interference from the tape harvest. The census in §5.1, the fee measurement in §5.5 and the
  timelines in §3.6 cost the tape nothing.

### 1.2 The 239th launch, and why 239 is still a lower bound

The sibling task `kol-deployer-entity-cluster` established that
`frontend-api-v3.pump.fun/coins?creator=` returns coins by **current** creator, and that the creator
record can move on-chain. `32CdQdBUxbCsLy5AUHWmyidfwhgGUr9N573NBUrDpump` (`maxxing`, minted
2025-12-01 19:37:59, ATH **$7,721,545**, still trading at $441k) is this wallet's first-ever launch
and had silently dropped out of its own history; pump.fun now lists a different creator.

I added it and reconstructed its window. **My tape independently confirms it is this operation's
launch:** the first trade on the token is a buy by `7ufmve7Z…` itself, followed in the same slot by
`2CHrnc2L…`, `Atgx1JXs…` and `8kzFH4rg…` — three of the six wallets that appear in the create slot of
every later launch (§5.4). Same conclusion the sibling reached from the bonding-curve `creator`
field, arrived at from a different direction.

**So 239 is a floor.** Any other launch whose creator record has moved is invisible to the same
enumeration, and nothing in my method would find it. The population figures below — 103/239
graduated, median ATH $21,150 — are the operation *minus* an unknown number of its results, and the
one we know about was its best by two orders of magnitude.

---

## 2. The answers, up front

**1. What does the price do after the deployer is out? The peak is *before* the exit, not after it.**
The highest price of the whole token life is reached **inside the create slot itself** on 58 of 239
launches and within thirty seconds on 74 — at a median **2.57×** the deployer's own entry price. The
deployer sells a ladder into that, finishing at a median **+13 s** with the price at **2.31×** its
entry. From there the token drifts: **2.05×** at +60 s, a lifetime peak of **5.08×**, and today a
median of **0.48×**. **Only 3 % of these tokens currently trade above the price the deployer paid.**
Median drawdown from all-time high to now: **89.5 %**. Graduation is a fixed point on the curve —
**6.59× the deployer's entry at the current preset** — and the median launch never gets there (§3.5).

**2. Did anyone beat the deployer? Yes — and the answer has two parts, which the control separates.**
Six addresses are in the **create slot itself** on essentially every launch — `2CHrnc2L…` on **235 of
235**, over the whole eight months. They fill at **1.08–1.22×** the deployer's price while everyone
else pays 2–3×, they arrive as two three-signer transactions paying **0.0009 SOL** of fees, and
across **70 launches by other deployers they appear zero times**. Measured on-chain with every fee
included, `2CHrnc2L…` is **+306 SOL over the 120 launches I priced exactly**, positive on 100 % of
them. That is not a strategy; it is a position inside the launch.

**But separately, and this is the finding that matters for the captain's question:** `5brv79eF…` is
**not** in that bundle — it pays a market fill of **2.27×**, bids real priority fees (median 0.051
SOL, once 1.88 SOL), appears in the control, and misses 142 of the 239 launches. Over 97 launches it
is **+313.7 SOL gross, and +47.8 SOL net of every fee on the 49 I priced exactly**, positive on
78 %. A second, `EgQX9R3Q…`, ran the same way from March to May and stopped: **+227.8 gross, +47.1
net on the 10 priced**, 100 % positive. **Outsiders can and do win this, at scale, for months.**

**3. Is the first 30 seconds winnable by a non-deployer? Yes — but only the create slot, and the
median outsider's edge is eaten by the fee they pay to get there.** P&L by slot offset is a cliff:
land in the create slot and the median closed round trip is **+0.283 SOL with 72 % profitable**;
land two to ten slots later and the median is at or below zero. Netting every fee on-chain across
123 launches, the median **cohort** create-slot round trip is **+0.838 SOL** and the median
**non-cohort** one is **+0.035 SOL**. `2CQgjcdN…` is the cleanest demonstration of why that
distinction matters: **+31.2 SOL on the trade tape, −12.2 SOL in reality**, after 11.9 SOL of
priority fees.

**And the sharpest single fact in the dataset:** `C989QoG3…` and `4o9ndxqo…` have traded 51 and 52 of
these launches, arriving a median **1 second** after the mint at **~3×** the deployer's price and
holding **~42 seconds**, and have lost **−106.8** and **−100.0 SOL**, profitable on **2 %** and
**4 %**. Somebody is already running the fast-bot strategy the captain's hypothesis describes. It is
the largest loser in the dataset.

**A fourth answer nobody asked for, and it corrects two prior findings.**
(a) **The 15-SOL dev buy is not a fixed parameter of the operation — it is the current one.** It
first appears on **2026-05-20**. Before that the stake was 3–10 SOL and the whole operation was a
tenth the size: median net **+2.10 SOL** per launch in December 2025 against **+30.12** in July 2026.
Lifetime take over the 228 complete exits: **4,315 SOL ≈ $319k**.
(b) **The deployer does sell into a graduated pool**, on the seven launches where it buys 33–70 % of
supply and forces graduation within seconds (§3.6). The predecessor's "never" is true of the mode it
sampled and false in general.

---

## 3. What the price does after the deployer is out

### 3.1 The lifetime shape, all 239 launches

pump.fun's own figures (`ath_market_cap`, `usd_market_cap`) — **a provider claim, single-sourced**,
corroborated by our tape wherever the peak falls inside a reconstructed window:

```
ATH market cap USD  p10 $10,319  p25 $13,866  med $21,150  p75 $36,388  p90 $78,155  p99 $378,597  max $7,721,545
time from mint      p10 1s       p25 7s       med 371s     p75 1,774s   p90 11,887s  max 158 days
```

The median hides what matters. **58 of 239 launches reach their all-time high within five seconds of
the mint** — before the deployer has finished selling — and another 16 within thirty. A further 82
peak between five minutes and an hour. The tail is one token, `maxxing`, at $7.7M.

Drawdown from ATH to today: p25 **83.9 %**, median **89.5 %**, p75 **96.2 %**.

### 3.2 The path through the exit, measured on the tape

Every price is a multiple of the price the deployer itself paid on the same launch.

| point | n | p10 | p25 | **median** | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| end of second 0 (the create slot) | 235 | 1.37× | 2.08× | **2.57×** | 2.89× | 3.28× | 6.04× |
| deployer's position hits zero | 228 | 1.41× | 1.76× | **2.31×** | 3.02× | 3.42× | 5.23× |
| +30 s | 235 | 1.30× | 1.67× | **2.23×** | 3.03× | 3.69× | 7.09× |
| +60 s | 235 | 1.23× | 1.58× | **2.05×** | 2.94× | 3.85× | 14.68× |
| +120 s | 25 | 1.60× | 1.94× | **2.53×** | 3.28× | 4.19× | 8.44× |
| +300 s | 21 | 1.22× | 1.60× | **2.68×** | 3.50× | 4.45× | 5.52× |
| highest price inside the window | 235 | 2.48× | 3.12× | **3.56×** | 4.45× | 5.63× | 14.86× |
| **lifetime ATH** (pump.fun) | 235 | 3.09× | 3.51× | **5.08×** | 9.21× | 18.87× | 1842× |
| **today** (pump.fun) | 235 | 0.31× | 0.40× | **0.48×** | 0.67× | 0.73× | 105× |

Read down that column. The price roughly triples inside the create slot, is around 2.3× while the
deployer finishes liquidating, sits at 2.0–2.7× for the first five minutes, reaches ~5× at some point
in its life, and ends at 0.48×. **Only 3 % of these tokens currently trade above the deployer's own
entry price.** The +120 s and +300 s rows come from 25 and 21 launches with a long enough window and
are indicative, not the same sample as the rest.

### 3.3 The exit ladder itself

Over the 228 launches with a complete in-window exit: first sell at a median **+3 s** (p25 2, p75 4,
min 1, max 43); position at exactly zero at a median **+13 s** (p25 7, p75 19, min 2, max 47). The
ladder is ~26 rungs at the current preset and shorter on the smaller early stakes. Rung-by-rung
detail with the price at each fill is in `dev_exit_ladder.csv` (2,064 rows). At the current preset
the shape is: 10 % of the bag at +4 s into 2.54× its entry, 30 % by +4.5 s at 2.05×, 60 % by +7.5 s
at 2.00×, and the remainder by +19 s at ~2.15×.

### 3.4 The operation scaled up tenfold, and only recently

This is what full coverage buys that a recent sample cannot:

| month | launches | median dev buy | median net | median time to zero | month total |
|---|---:|---:|---:|---:|---:|
| 2025-12 | 11 | 3.00 SOL | **+2.10** | +4 s | 20 SOL |
| 2026-01 | 3 | 3.00 | +1.64 | +5 s | 7 |
| 2026-02 | 1 | 2.96 | +0.73 | +5 s | 1 |
| 2026-03 | 21 | 3.95 | +5.14 | +7 s | 132 |
| 2026-04 | 65 | 3.46 | +6.12 | +7 s | 542 |
| 2026-05 | 41 | 9.88 | **+25.80** | +16 s | 1,083 |
| 2026-06 | 41 | 14.81 | +27.88 | +22 s | 1,051 |
| 2026-07 | 52 | 14.81 | **+30.12** | +17 s | 1,479 |

**Total across the 228 complete exits: 4,315 SOL, about $319,000** at the ~$74/SOL the tape's own
paired price fields imply. **The 14.814814813-SOL preset first appears on 2026-05-20** — before that
the operation ran a 3–10 SOL stake for a +2 to +6 SOL return. The predecessor's "fixed 15-SOL preset"
correctly describes the current regime and not the operation's history, and the same is true of
"~+36 SOL per launch": that is a July number, not a lifetime one.

### 3.5 Graduation is a curve constant, and most launches never reach it

I did not need to measure graduation prices. On pump.fun's bonding curve the graduation point is
fixed: from the curve parameters (30 SOL / 1,073,000,000 initial virtual reserves, 793,100,000
sellable), graduation occurs at exactly **14.70× the token's initial price**, and the 14.81-SOL dev
buy lands at 2.233× that initial price, so **graduation is 6.59× the deployer's own entry**.

**Confirmed empirically, not assumed.** Thirteen reconstructed windows span the moment the token
graduated. On every current-preset one, the last bonding-curve price before the first PumpSwap trade
is **6.59× the dev-buy price = 14.71× the initial price** — `Dummy`, `Lala`, `Sol`, `papoi`, `Slap`,
`大坏蛋`, all to two decimal places. As a cross-check, 87 of the 88 launches whose ATH market cap
exceeds the implied graduation cap did graduate.

Two consequences: **the median launch never reaches graduation price** (median lifetime ATH 5.08×
against a 6.59× requirement — the same fact as "103 of 239 graduated", seen from the price side), and
**the deployer finishes selling at about 35 % of the graduation price.** Whatever it is selling into,
it is not the graduation. For *when* graduation happened I used a validated upper-bound proxy — the
last transaction the bonding curve ever sees, since trading moves to the AMM at graduation. Median
for graduated launches: **32 minutes** after the mint. **The deployer is out before graduation in
every case.**

### 3.6 The second operating mode — and a correction to a prior finding

Seven launches use a much larger dev buy — **13.52 to 56.30 SOL, taking 33 % to 70 % of total
supply** — which pushes the token so far up the curve that the sniper flood completes graduation
**within 0 to 8 seconds of the mint**. On none of them does the deployer exit inside 60 seconds; I
reconstructed those from the chain instead (the deployer's own Token-2022 account per mint), in
`dev_position_timeline_large_buys.csv`:

| launch | dev buy | supply taken | exit at | how it left | ATH |
|---|---:|---:|---:|---|---:|
| `Trump` | 56.30 SOL | 70 % | +144 s | **sold**, 55.24 SOL | $112,361 |
| `Bulls` | 46.10 SOL | 65 % | +59→147 s | 400M **transferred out**, 250M **sold into the PumpSwap pool** for 84.46 SOL | $56,072 |
| `Float` | 46.10 SOL | 65 % | +500 s | **sold**, 43.82 SOL | $64,318 |
| `Milly` | 26.27 SOL | 50 % | +898 s | **sold**, 20.56 SOL | $43,618 |
| `float` | 26.18 SOL | 50 % | +246 s | whole position into **Streamflow** | $98,744 |
| `Lockin` | 26.18 SOL | 50 % | +91 s | whole position into **Streamflow** | $49,885 |
| `Bullieve` | 13.52 SOL | 33 % | +161 s | whole position into **Streamflow** | $29,602 |

**All seven graduated (7/7), with a median ATH of $56,072 against $18,964 for the current preset.**

Two things here matter beyond the arithmetic:

- **The deployer does sell into a graduated pool.** `Bulls`'s +126 s sale routes through
  `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` — the PumpSwap AMM — as an inner instruction of a
  `FLASHX8…` router call. The predecessor's "it never sells into its graduated pools" holds for the
  mode it sampled and **not in general**; every one of its eight tokens was the other mode.
- **On three launches the position leaves as a Streamflow token stream**
  (`strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m`), not a sale — a vesting/lock contract, with a
  common destination account across all three. On those launches the wallet's SOL P&L is not the
  outcome: the value left as tokens. **Where it went is the entity/funding lane's question and I did
  not pursue it.**

I am not going to speculate about why the operator does this on ~3 % of launches. The measured facts
are: bigger stake, instant graduation, better outcomes, slower and different exit.

---

## 4. The counterparty P&L league table

### 4.1 How P&L is computed, and the two things that would make it wrong

For each (wallet, launch): SOL in from buys, SOL out from sells, residual marked. **The only rows
with a complete P&L are those where the wallet is flat by the end of the tape window** — otherwise a
wallet that bought inside the window and sold outside it shows a fabricated loss. **22,333 of 46,553
pairs (48 %) close inside the window**, and the headline table uses only those. The dataset carries
two marked variants for the rest (`residual_mark_window_sol`, `residual_mark_now_sol`); read both as
bounds.

That 48 % is a real limitation, so here is what the other half is: open pairs have a **median stake
of 0.244 SOL** (against 0.474 for closed), enter at a **median +30 s** (against +11 s), and **89 % of
them never sell at all** inside the window. They are late, small, and holding. Critically,
**create-slot pairs — the ones §5 turns on — are 81 % closed**, so the finding that matters depends
least on the assumption.

**All tape-derived P&L is gross of fees**, and for this population that is not a rounding error.
pump.fun's `amountSol` is the swap quote, excluding the venue fee and the transaction's own priority
fee. Measured against the chain across 123 launches, the tape overstates a wallet's true net by a
median **0.112 SOL per launch** — plus whatever priority fee that wallet bid, which for create-slot
outsiders reaches **3.15 SOL on a single launch**. §5.5 prices this exactly rather than modelling it,
and it flips at least one wallet from profit to loss.

### 4.2 The table

Closed round trips only, tape-derived (gross of fees — see §5.5 for the same wallets priced exactly).
`cslot` = launches entered in the same slot as the create transaction; `ctrl` = appearances in the
create slot of 70 *other* deployers' launches; `fill` = median entry price as a multiple of the
deployer's own.

| wallet | launches | closed | hit rate | **P&L (SOL)** | median | cslot | ctrl | fill | hold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `2CHrnc2LyagAbMaMFgthiDWh7ZZ9zT9TF8WEJf7MNE71` | 235 | 221 | **0.977** | **+503.9** | +2.156 | 235 | **0** | 1.08× | 25 s |
| `Atgx1JXsp8pTQ9Qsi74wF5pLMVwHwyQc6jJCu84evN7c` | 235 | 215 | 0.930 | **+375.1** | +1.466 | 235 | **0** | 1.15× | 31 s |
| `5brv79eFZ2rGprXNvqgVJBkBptkkw8GJX1XydJyZLyAr` | 97 | 90 | 0.967 | **+313.7** | +1.274 | 83 | 2 | **2.27×** | 10 s |
| `8kzFH4rgFzy4ccz97AhgqRT7Qbt7HnD5oJCDK1Sxdarb` | 235 | 208 | 0.856 | **+269.9** | +1.045 | 235 | **0** | 1.22× | 35 s |
| `EgQX9R3Qph1dPHE1Ysou1auSYqRGomCNmLDC28Yg77aq` | 48 | 48 | 0.938 | **+227.8** | +3.977 | 34 | 0 | **1.99×** | 17 s |
| `2CQgjcdNEo7WtbQLpJTAVcC3Ga61pNvRDTgP5grzctFG` | 62 | 60 | 0.617 | +38.0 | +0.127 | 53 | 3 | 2.33× | 8 s |
| `GfJA84gwT9LpeyzeckeXkCsf8vdQuA64ZYQ91xoBawvt` | 174 | 100 | 0.530 | +27.0 | +0.064 | 174 | 0 | 1.41× | 43 s |
| `Anubis512ho5t7S6LNSwoxUWdeQmX2kf3RvZ8ApHHF5w` | 76 | 76 | 0.855 | +26.4 | +0.291 | 38 | **9** | 2.90× | **2 s** |
| `7gEnRjDud56BVmBQMWLTticJoouzrpnyaAnN5A3EEqiy` | 39 | 38 | 0.684 | +19.5 | +0.300 | 26 | 0 | 2.22× | 25 s |
| … | | | | | | | | | |
| `4o9ndxqonUYamkzjHT6hCU6tNmg8VFcyhMqsxeTg4K37` | 52 | 46 | **0.044** | **−100.0** | −2.579 | 0 | 0 | 3.03× | 41 s |
| `C989QoG39etYt32zfE7mHYqJwFh1kJK4fBrmsySFjzaS` | 51 | 46 | **0.022** | **−106.8** | −2.556 | 0 | 0 | 2.97× | 42 s |

Full table in `counterparties.csv` (20,388 rows); the behaviour columns come from
`wallet_behaviour_profiles.csv` (1,653 wallets on ≥5 launches).

### 4.3 Persistent winner or lucky once? — the question the brief asked

**Three distinct populations, and the `fill` and `ctrl` columns separate them.**

- **Inside the launch: the six create-slot wallets.** `2CHrnc2L…`, `Atgx1JXs…`, `8kzFH4rg…`,
  `5P8A9bG…`, `GfJA84gw…`, `43x1zWzj…`. They fill at **1.08–1.41×** the deployer's price — a price
  nobody bidding in an open auction gets — appear in **zero** of 70 control launches, and pay
  **0.0009 SOL** of fees to be there. **The bundle grew:** three of them are on `maxxing` in December
  2025 and on essentially every launch since; `5P8A9bG…` and `GfJA84gw…` join by May 2026;
  `43x1zWzj…` in June. Their order inside the bundle decides their outcome: the first wins 98 % of
  the time, the sixth 53 % with a near-zero median.
- **Outside the launch, and winning anyway: `5brv79eF…` and `EgQX9R3Q…`.** They pay **2.0–2.3×** —
  full market price — bid real priority fees, appear in the control, and miss launches (they are on
  97 and 48 of 239). `5brv79eF…` has run continuously since March 2026; `EgQX9R3Q…` ran March–May
  and stopped. **These two are the entire empirical case that the strategy is copyable**, and §5.5
  prices them net of fees.
- **The generic sniper: `Anubis512…`.** 76 launches here, **9 of 70 control launches**, fills at
  2.90× and is out in **2 seconds**. +26.4 SOL. This is what a general-purpose launch bot looks
  like, and it is a useful negative control on the two above.
- **Lucky once: the great majority.** Of 20,388 wallets, **14,187 appear on exactly one launch.**
  Across 233 launches the best non-cohort early buyer is **102 different wallets**.
- **Persistently wrong: `C989QoG3…` and `4o9ndxqo…`.** 51 and 52 launches, median +1 s entry at ~3×,
  median 42-second hold, −106.8 and −100.0 SOL. §5.6 shows exactly what they do wrong.

### 4.4 The pool this is drawn from

Over the 235 reconstructed launches, closed round trips total **+2,375.6 SOL** of counterparty profit
(gross of fees) against a deployer take of **+4,315 SOL**. Those do not net to zero and are not
supposed to: the difference sits with the 52 % of pairs still holding at the end of the window and
with everyone who bought after it. **The closed-only table is conditional on having got out**, which
is precisely the population that can win. Read it as "of those who round-tripped, this is how they
did" — never as the market's aggregate.

---

## 5. Is the first 30 seconds winnable? — the evidence

### 5.1 What the window looks like, across all 238 launches

From the complete on-chain census (`getSignaturesForAddress` on each bonding-curve account, whole
token life):

| | median | p10 | p90 | total |
|---|---:|---:|---:|---:|
| transactions over the token's whole life | 4,086 | 642 | 14,112 | 1,461,950 |
| of which succeed | 1,547 | 360 | 3,651 | 435,482 |
| transactions in the first 30 s | 554 | 191 | 11,643 | 986,855 |
| of which **succeed** | **236** | 102 | 380 | 57,827 |

These count transactions *referencing* the bonding curve, which is what the RPC returns. On the
launches where I also hold the tape, **the median share of successful curve transactions that are
genuine trades is 100 %** (p10 92 %) — so "succeed" reads as "filled" with two known exceptions
(§9.1).

**And the contest is new.** Split by month, the number of *fills* in the first thirty seconds barely
moves — the number of attempts explodes:

| month | launches | median tx over life | median tx in first 30 s | median **successful** in first 30 s | median failure rate |
|---|---:|---:|---:|---:|---:|
| 2025-12 | 10 | 144 | 86 | 67 | 20 % |
| 2026-01 | 3 | 240 | 88 | 61 | 19 % |
| 2026-02 | 1 | 439 | 37 | 32 | 14 % |
| 2026-03 | 21 | 1,037 | 255 | 196 | 25 % |
| 2026-04 | 65 | 1,823 | 295 | 224 | 26 % |
| 2026-05 | 41 | 3,004 | 559 | 350 | 36 % |
| **2026-06** | 41 | 11,995 | **10,330** | 207 | **98 %** |
| **2026-07** | 56 | 11,393 | 8,986 | 250 | **97 %** |

**Something changed in June 2026: attempts in the first thirty seconds rose roughly twentyfold while
fills stayed flat.** Before it, two thirds of entrants got filled; after it, two per cent do.

### 5.2 P&L by slot offset — the cliff

Closed round trips, grouped by how many slots after the create transaction the wallet's first trade
landed (one slot ≈ 400 ms):

| slots after create | pairs | median SOL | mean SOL | % profitable | total SOL |
|---:|---:|---:|---:|---:|---:|
| **0 (the create slot)** | 1,999 | **+0.283** | +0.975 | **72 %** | **+1,949.0** |
| 1 | 628 | +0.011 | +0.307 | 60 % | +192.8 |
| 2 | 272 | −0.002 | −0.275 | 42 % | −74.8 |
| 3 | 294 | −0.030 | −0.534 | 35 % | −156.8 |
| 4 | 232 | −0.006 | +0.007 | 40 % | +1.5 |
| 5–10 | 2,173 | +0.003 | +0.020 | 54 % | +44.0 |
| 11–25 | 5,109 | +0.001 | +0.046 | 52 % | +235.3 |
| 26+ | 11,626 | +0.000 | +0.016 | 50 % | +184.5 |

**Essentially all of the early-window edge is in slot 0**, and everywhere past it is a coin flip.

**And it got sharply worse in June**, which the whole-history median hides:

| slots after create | pre-June 2026 (142 launches) | June 2026 onward (93 launches) |
|---|---|---|
| 0 | +0.337 med, 73 % profitable | +0.242 med, 71 % profitable |
| 2 | −0.000 med, 44 % | **−0.023 med, 38 %** |
| 3 | −0.001 med, 41 % | **−0.690 med, 27 %** |
| 5–10 | **+0.011 med, 61 %** | **−0.012 med, 33 %** |

Before June, arriving a second or two late was harmless. Since June it is expensive. The create-slot
edge itself is roughly unchanged.

### 5.3 Who is in slot 0

| group | wallets | pairs | median SOL | % profitable | total SOL | median stake |
|---|---:|---:|---:|---:|---:|---:|
| the six-wallet cohort | 6 | 918 | +1.064 | 78 % | +1,196.0 | 2.17 SOL |
| everyone else | 407 | 1,081 | +0.056 | 67 % | +753.0 | 0.99 SOL |

Four hundred and seven other wallets reach the create slot at least once. The median one makes about
a twentieth of what the median cohort member makes — because the cohort fills **first**.

### 5.4 The cohort's presence, month by month

Create-slot presence over the covered launches — the strongest single piece of evidence in this
report:

| | 2025-12 | 2026-05 | 2026-06 | 2026-07 |
|---|---:|---:|---:|---:|
| `2CHrnc2L…` | ✓ | 100 % | 100 % | 100 % |
| `Atgx1JXs…` | ✓ | 100 % | 100 % | 100 % |
| `8kzFH4rg…` | ✓ | 100 % | 100 % | 100 % |
| `5P8A9bG…` | — | 100 % | 95 % | 98 % |
| `GfJA84gw…` | — | 100 % | 95 % | 98 % |
| `43x1zWzj…` | — | — | 83 % | 98 % |

### 5.5 The fee correction — measured on-chain, and it flips a wallet

The tape's SOL amounts exclude the venue fee and the transaction's own priority fee. For an outsider
the create slot has to be **bought**, and the price is on the chain. Reading every create-slot
entrant's transactions off `api.mainnet-beta.solana.com` for **111 launches (3,977 transactions)** and
taking each wallet's true lamport delta:

| group | round trips | true median SOL | p25 | p75 | % positive | total |
|---|---:|---:|---:|---:|---:|---:|
| cohort, create slot | 596 | **+0.838** | −0.238 | +2.068 | 68 % | +681.0 |
| non-cohort, create slot | 630 | **+0.035** | −0.045 | +0.310 | 60 % | +155.2 |

Fees per launch: cohort median **0.00123 SOL** (max 0.014). Non-cohort median **0.00224**, p75
**0.022**, p90 **0.131**, and one wallet paid **3.149 SOL** on a single launch to land in the create
slot. The deployer's own create+dev-buy transaction pays **0.000010 SOL** — it does not compete for
the slot, it *is* the slot.

Per wallet, on the launches priced exactly:

| wallet | launches priced | tape P&L | **true P&L** | fees paid | % positive |
|---|---:|---:|---:|---:|---:|
| `2CHrnc2L…` (cohort) | 120 | +324.3 | **+306.0** | **0.30** | **100 %** |
| `5brv79eF…` (outsider) | 49 | +100.9 | **+47.8** | **17.50** | 78 % |
| `EgQX9R3Q…` (outsider) | 10 | +69.5 | **+47.1** | **12.91** | 100 % |
| `Anubis512…` (generic sniper) | 38 | +15.7 | **+13.4** | 0.01 | 87 % |
| `2CQgjcdN…` | 50 | **+31.2** | **−12.2** | **11.89** | 36 % |

**`2CQgjcdN…` is the demonstration.** It looks like a +31 SOL winner on the trade tape and is a
−12 SOL loser in reality, because it spent 11.9 SOL bidding for create-slot inclusion. Any backtest
built on swap quotes alone would have hired it.

**The outsider's edge is real but it is bought.** `5brv79eF…` keeps +47.8 of a +100.9 gross — it
pays away just over half — and is still comfortably the best unaffiliated result in the dataset.

### 5.6 What separates the repeat winners from the repeat losers

Every one of these wallets does one buy and one sell per launch. Medians over all their launches:

| wallet | launches | enters at | fill vs dev price | hold | median P&L (tape) |
|---|---:|---:|---:|---:|---:|
| `2CHrnc2L…` (cohort) | 235 | **t = 0** | **1.08×** | 25 s | **+2.16** |
| `EgQX9R3Q…` (outsider) | 48 | t = 0 | 1.99× | 17 s | **+3.98** |
| `5brv79eF…` (outsider) | 97 | t = 0 | 2.27× | 10 s | +1.27 |
| `Anubis512…` (sniper) | 76 | t = 0 | 2.90× | **2 s** | +0.29 |
| `C989QoG3…` (loser) | 51 | +1 s | **2.97×** | **42 s** | **−2.56** |
| `4o9ndxqo…` (loser) | 52 | +1 s | 3.03× | 41 s | −2.58 |

The discriminator is not speed. **The losers are fast — a median one second — and they buy at ~3×
the deployer's price and hold for forty seconds**, which is exactly long enough for the ladder and
the post-spike drift to take the price back below their entry. The winners either get in cheap (the
bundle), or pay the spike and leave inside 2–17 seconds.

Mapping every repeat wallet with at least five closed round trips onto (entry time × hold time) —
the whole set is in `wallet_behaviour_profiles.csv` — one cell stands out and the rest is noise:

| median entry | median hold | wallets | median of their median P&L | median hit rate |
|---|---|---:|---:|---:|
| **create slot** | **≤ 2 s** | 25 | **+0.0695** | **0.83** |
| create slot | 30–60 s | 8 | +0.0604 | 0.59 |
| create slot | 2–10 s | 28 | +0.0314 | 0.64 |
| 0–2 s | 10–30 s | 10 | −0.0022 | 0.37 |
| 2–10 s | 10–30 s | 146 | −0.0000 | 0.50 |
| 10–30 s | 10–30 s | 163 | −0.0000 | 0.50 |
| 30–120 s | 10–30 s | 32 | −0.0003 | 0.44 |

Of 794 such wallets, 506 (64 %) are net positive but only **39 clear +5 SOL in total**.

### 5.7 The verdict on the captain's hypothesis

The hypothesis was that a fast enough bot could buy and sell before the deployer does. The data
supports a narrow version and refutes the general one:

- **Supported, and more strongly than I expected going in:** the create slot is profitable, and two
  unaffiliated wallets have taken **+47.8 and +47.1 SOL net of every fee** out of it over months.
  `5brv79eF…` is a working existence proof.
- **Refuted as posed:** "fast enough" is not a speed you reach by reacting. The winning entries are
  in the *same slot as the create transaction* — the predecessor established the announcing post
  fires a median 12.2 s before the mint, and the create slot is not reachable from it. What *is*
  reachable by reacting is slot 2 and later, and since June 2026 those slots lose money.
- **The median outsider does not clear costs.** +0.035 SOL a launch net, p25 negative. This is a slot
  auction with a thin prize, and `2CQgjcdN…` shows what overbidding for it looks like.
- **Already tested by someone else, at scale, and it lost:** `C989QoG3…` and `4o9ndxqo…` run exactly
  the reacting-bot strategy across ~50 launches each and have lost 207 SOL between them.

---

## 6. The control — is any of this actually unusual?

The obvious objection is that create-slot bundles may simply be how pump.fun launches work. So I ran
the control: the create slot of **70 launches by other deployers**, sampled from our own
`launch_events` over 2026-07-27 onward — **24 using the identical 14.814814813-SOL preset** (same
tool, same stake, same days, different wallets) and 46 at other stakes.

| | subject | control, same preset | control, other stakes |
|---|---|---|---|
| create-slot wallets besides the deployer | median 11 | median 4 (max 14) | median 1 (max 12) |
| launches with a **multi-wallet transaction** in the create slot | essentially every one | **2 / 24** | 4 / 46 |
| maximum wallets in a single create-slot transaction | 3 (×2 transactions, every launch) | 3 | 3 |
| the six subject wallets appearing at all | every launch | **0 / 24** | **0 / 46** |

Three things follow, and the third is the one that matters:

1. **Create-slot sniping is normal.** Other deployers' launches draw a median of four wallets into
   the create slot. This operator draws eleven.
2. **Multi-wallet bundle transactions are not unique but are uncommon** — 2 of 24 comparable control
   launches carry one, against essentially all of the subject's.
3. **The six wallets trade this operator's launches and no one else's.** Zero appearances across all
   70 control launches, against 160 distinct wallets that do appear there. By contrast `Anubis512…`
   shows up in **9 of the 70**, alongside other recurring general-purpose snipers (`DQApNebk…` 9,
   `6hh9uNdE…` 8), and `5brv79eF…` — the best unaffiliated performer — appears in 2. The control
   cleanly separates a sniper bot from a bundle, and puts `5brv79eF…` on the sniper side of the line.

---

## 7. Evidence and inference, separated

### Evidence — measured, with the source named

| Claim | Source |
|---|---|
| The pump.fun trade tape is complete against the chain | 94-launch comparison: 46,023 tape transactions, **zero** absent from the chain; the 2.9 % chain-only residue sampled and shown to be no-op probes (§9.1) |
| Deployer exits 100 % of its dev position, median +13 s, on 228 of 235 launches | the tape |
| Median deployer net +21.66 SOL; 4,315 SOL over 228 complete exits; +2.10/launch in Dec 2025 rising to +30.12 in Jul 2026 | the tape |
| The 14.814814813-SOL preset first appears 2026-05-20 | the tape |
| Seven launches buy 13.5–56.3 SOL, take 33–70 % of supply, graduate in 0–8 s, exit at +91 to +898 s | the tape plus the deployer's own on-chain token accounts |
| One of those exits routes through the PumpSwap AMM; three move the position into Streamflow | `api.mainnet-beta.solana.com`, parsed instructions |
| Graduation = 14.70× the initial price = 6.59× the dev-buy price | curve parameters, **confirmed** on 13 launches whose window spans graduation |
| Price peaks at a median 3.56× the dev-buy price inside the window; 58/239 launches peak within 5 s | the tape; pump.fun `ath_market_cap_timestamp` for the population figure |
| 97 % of these tokens trade below the deployer's own entry price today | pump.fun `usd_market_cap` ÷ our measured dev-buy price |
| `2CHrnc2L…` is in the create slot of 235 of 235 launches; three of the six are on `maxxing` (2025-12-01) | the tape |
| The cohort enters as two three-signer transactions paying 0.000915 SOL | `api.mainnet-beta.solana.com`, `meta.fee` and parsed account keys |
| Outsiders pay up to 3.149 SOL of fees to reach the same slot | same |
| Slot-0 round trips: median +0.283 SOL, 72 % profitable; slots 2–10 at or below zero | the tape |
| Fee-inclusive: cohort create-slot median +0.838 SOL, non-cohort +0.035; `2CQgjcdN…` +31.2 tape → −12.2 real | on-chain lamport deltas, 123 launches |
| `5brv79eF…` +47.8 SOL net over 49 priced launches; `EgQX9R3Q…` +47.1 over 10 | same |
| First-30-second attempts rose ~20× in June 2026 while fills stayed flat | on-chain census, all 238 launches |
| Slots 2–10 were break-even before June 2026 and lose money after | the tape, era split |
| The six wallets appear in 0 of 70 other deployers' create slots; `Anubis512…` in 9, `5brv79eF…` in 2 | the control |
| `maxxing` is this wallet's launch and is absent from `?creator=` | the sibling task's on-chain `creator` read, **and** independently my tape's first trade being the subject wallet's own buy |

### Inference — reasoning on top of that evidence, labelled as such

- **The six create-slot wallets are part of the operation, not independent traders.** Nothing here
  proves common ownership. What the data shows is: presence on every launch across eight months;
  co-signature in two shared transactions; a fixed fill order; a fill price (1.08–1.41×) that nobody
  bidding in an open auction achieves; a fee bill three orders of magnitude below what outsiders pay
  for the same position; and zero presence on 70 other deployers' launches while genuine sniper bots
  appear on 9 and 8 of them. The simplest explanation is one bundle submitted with the create. **A
  funding or cluster analysis would settle it and is the sibling lane's scope, not mine.**
- **`5brv79eF…` and `EgQX9R3Q…` are outsiders, not a second bundle.** They pay 2.0–2.3× where the
  cohort pays 1.08–1.22×, they bid priority fees where the cohort pays none, they miss launches, and
  one of them appears in the control. Every discriminator points the same way. **But I have not
  excluded that they are the same operator running a differently-positioned book**, and a funding
  check is the way to settle it.
- **The create-slot position is bought, not raced.** Outsiders paying 0.02–3.15 SOL in priority fees
  to land there is the observable price of a slot auction. That is an interpretation of fee data, not
  a direct observation of a bundle.
- **Slots 2–10 lose because they buy the create-slot spike and sell into the drift.** The facts are
  separately measured (peak inside second 0; ladder from +3 s to +13 s; losers' entry at 2.97× and
  42-second hold); the causal reading joining them is mine.
- **The June 2026 step change is competition, not a change by the operator.** Fills stayed flat while
  attempts rose twentyfold, and the operator's parameters had already changed a month earlier.
- **The large-buy mode looks deliberate.** 2–4× the standard stake, reliably forcing graduation
  within seconds, followed by a slower and different exit. Seven instances is a pattern, not proof of
  intent.

### Explicitly not claimed

- That the six wallets are the deployer's own. Not established.
- That `5brv79eF…`'s result is repeatable by a new entrant. It is one wallet, and its edge has been
  competed against since June (§5.2 era split).
- That any of this generalises to pump.fun deployers in general. §6 tests one specific structural
  question and answers it; it does not make this operator representative.
- Anything about the funding, ownership, destination or Streamflow beneficiary of any wallet here.
  Out of scope by the brief.

---

## 8. The selection-bias caveat, stated rather than left to be remembered

**This wallet was handed to the fleet because somebody noticed it was unusual.** Everything here is
measured on an operator selected for being interesting, and "this operator is unusual" is therefore
worth less than it looks.

- **The control (§6) removes exactly one of those objections and no more.** It shows the six-wallet
  bundle is not generic pump.fun launch mechanics. It says nothing about whether the operator's
  returns, its graduation rate or its counterparty structure are unusual, and it is 70 launches over
  two days.
- **The +0.035 SOL outsider edge is measured on this operator's launches only.** These are unusually
  well-attended (a 42.9 % graduation rate against a 2.87 % population baseline, per the
  predecessor). An edge that exists here need not exist on a typical launch, and vice versa.
- **The population itself is selected by a provider field that moves.** §1.2. The one launch we know
  is missing is the operation's best result by a factor of eight, and it would have skewed §3.1's
  distribution had it stayed hidden.
- **The strategy conclusions rest on two wallets.** `5brv79eF…` and `EgQX9R3Q…` are the whole
  positive case in §5.7, out of 20,388. That is not a base rate; it is an existence proof.

---

## 9. Method notes worth keeping

### 9.1 The tape is validated against the chain, not trusted

`swap-api.pump.fun` is a provider and its trade feed is not evidence until it is checked. I checked
it twice — once exactly, once at scale.

**Exactly, on one launch.** For `Restoration` I took the complete on-chain signature index of the
bonding-curve account (11,591 transactions, 2,217 successful) and compared the successful set inside
the first 300 s with the tape's transaction set for the same window:

```
chain: 1,102 successful bonding-curve transactions in [mint, mint+300s]
tape:  1,102 distinct transactions
tape not in chain: 0        chain not in tape: 0
```

**At scale, for free** — the census already holds the on-chain signature set for all 238:

```
94 launches compared (tape window vs on-chain census over the same window)
on-chain successful bonding-curve transactions : 47,386
distinct bonding-curve transactions in the tape: 46,023
in the tape but NOT on chain                   :      0     <- zero, on every launch
on chain but NOT in the tape                   :  1,363  (2.9 %)
```

**The tape never invents a transaction.** The 2.9 % residue is not missing trades: it is transactions
that merely *reference* the bonding curve — the predecessor's own warning about
`getSignaturesForAddress`, seen from the other side. I pulled a sample (`Potter`, the worst launch at
201): every one invokes `FJX4qJbmhQ7ou8a99LNJMB1QYaKq5bvbqwxbawiUwkD2`, moves **no tokens at all**
(pre- and post-balances identical), moves no SOL beyond the 5,000-lamport base fee, and carries token
balances for *unrelated* mints — a bot sweeping many curves in one transaction. Across the 94
launches the **median share of successful curve transactions that are real trades is 100 %** (p10
92 %), with the residue concentrated in two launches (`Gem` 242, `Potter` 201).

### 9.2 The trade endpoint, in enough detail to reuse

- `GET https://swap-api.pump.fun/v2/coins/{mint}/trades?limit=100&createdTs=0` — newest first.
  `limit` is hard-capped at 100 (400 above it). `/v1/.../trades` is 410 Gone; the `frontend-api-v3`
  `/trades/...` paths are 404, as the predecessor recorded.
- Paginate with `&cursor=<pagination.nextCursor>`. The cursor is `<slotIndexId>-<timestampMs>` and
  **the timestamp component seeks**: `cursor=9999999999990000000000-<ms>` starts the walk at an
  arbitrary point in the token's history. That is what makes a launch-window reconstruction cost
  ~3–15 requests instead of walking the whole token.
- `slotIndexId[:12]` is the slot; the remaining ten digits order fills within it.
- `priceUsd`/`priceSol` on every row give an exact per-trade SOL/USD rate for free (73–76 over this
  period, consistent with the predecessor's 74.03).
- `GET /v1/coins/{mint}/candles?interval=1m&limit=1000` also works keyless (max 1,000 candles,
  anchored on *now*, so it does not reach the mint for tokens older than ~16 h at 1 m).
- Rate limiting is Cloudflare 1015 and it is unforgiving; §1.1.

### 9.3 Everything from the predecessor's §6 held

These mints are Token-2022, `getSignaturesForAddress` returns *referencing* transactions, and the
public RPC sheds load with nulls rather than errors. All three still apply. The tape route sidesteps
the fee-payer-filtering trap entirely — pump.fun reports the *swapping* wallet per fill, which is the
right unit and is **not** the fee payer in a bundled transaction. That is a trap in the other
direction: for the cohort, `accountKeys[0]` is `2CHrnc2L…` for three wallets' buys, so fee-payer
attribution would have merged three distinct traders into one.

### 9.4 Two bugs worth naming

- `getSignaturesForAddress` and `getTransaction` are **separate** rate-limit buckets on
  `api.mainnet-beta.solana.com` and can be run in parallel. A token-bucket pacer written as
  `allow = min(rate, …)` deadlocks silently for any rate below 1/s — burst capacity must be
  `max(1, rate)`. That cost me two stalled jobs before I found it.
- `pkill -f <pattern>` matches the shell's own command line when the pattern and the target appear in
  the same compound command. It killed my monitoring shells while leaving four harvesters running.

---

## 10. What I could not determine, and what it would cost

1. **Four launches have no tape** — `Marciana`, `Leo`, `Fridge`, `GLM`, all 2026-07-18/20. The
   endpoint returned an empty result for their windows across three passes. Cost to chase: a handful
   of keyless requests, or the RPC route at ~30 transactions each.
2. **Whole-life P&L.** Every P&L here is bounded by a 60-second window (300 s on 21 launches); 48 %
   of pairs close inside it and the rest are late, small and holding (§4.1). A whole-life tape is the
   same endpoint with no window bound — roughly 40 pages per launch rather than 3–15, so ~4× this
   task's tape cost. **This is the largest remaining gap** and it is what a backtest of a
   hold-longer strategy would need.
3. **Whether `5brv79eF…` and `EgQX9R3Q…` are outsiders or the same operator's second book.** Every
   discriminator I have says outsider (§7), but the settling evidence is the funding graph, which
   this brief assigns elsewhere. **This is the single highest-value follow-up**, because the entire
   positive answer to the captain's question rests on those two wallets.
4. **Where the Streamflow'd supply went** (§3.6). Three launches, ~500M tokens each, into a vesting
   contract with a shared destination. Keyless and cheap to trace; an ownership question, so it
   belongs to the entity lane.
5. **Whether the June 2026 competition jump is specific to this operator or market-wide.** The census
   method costs ~12 keyless RPC pages per launch; running it over 50 other deployers' launches spread
   across the same months would settle it in about an hour.
6. **Exact graduation timestamps.** Proxied, not measured (§3.5), with a validated error of 0–70 % on
   six checks. Exact values cost a cursor binary search per token (~8 requests × 103 graduated).
7. **Whether more launches are missing from the universe** (§1.2). Needs the full
   authored-transaction walk the sibling costed; I did not attempt it.
8. **Fee-inclusive P&L on the remaining 116 launches.** Priced 123 of 239 exactly (4,394
   transactions); the rest is ~1,400 more keyless RPC requests and would tighten §5.5's tails.

---

## 11. Recommendations

1. **Nothing here should ship as a code change, and I propose none.**
2. **The strategy question now has a specific answer, and it is narrower than "yes".** The window is
   winnable, one unaffiliated wallet has taken +48 SOL net out of it over 49 measured launches, and
   the median attempt does not clear its own priority fee. The reacting-bot version the hypothesis
   describes is the biggest loser in the dataset. If a strategy lane starts, **it should start from
   `5brv79eF…`'s actual behaviour** — create slot, market fill at ~2.3×, out in ten seconds, roughly
   half the gross paid away in fees — rather than from a latency assumption.
3. **Settle §10.3 before building anything.** If `5brv79eF…` turns out to be the operator's, the
   positive case in §5.7 collapses to zero and the answer becomes a flat no.
4. **`data/kol-deployer-population-tape/` is the input for any backtest.** One row per fill with the
   counterparty wallet, slot and price, plus per-launch, per-wallet and per-behaviour aggregates.
   Read `README.md` for column semantics — in particular `closed_in_window` decides which P&L rows
   are complete, `dev_exit_complete = 0` marks the seven launches whose deployer figures are
   window-truncated, and **every tape-derived P&L column is gross of fees**; the `onchain_*` files
   are the only fee-inclusive ones, and §5.5 shows that difference flipping a wallet's sign.
5. **Record three provider facts in AGENTS.md if any lane touches pump.fun again:** the trade
   endpoint in §9.2 (it makes per-token trade reconstruction essentially free, and we had it costed
   at hundreds of RPC calls); the `?creator=` current-creator hazard in §1.2, which silently deleted
   this operation's best result from its own history; and that pump.fun graduation is a fixed curve
   constant (14.70× the initial price), so "did it graduate" and "what was its peak" are the same
   measurement.
6. **Two predecessor findings need qualifiers if they are ever quoted.** "Never sells into a
   graduated pool" is true of the 15-SOL mode and false of the large-buy mode (§3.6). "A fixed 15-SOL
   dev buy, ~+36 SOL per launch" describes the regime since 2026-05-20; over the operation's life the
   stake was 3–10 SOL and the median take was +21.66 SOL (§3.4). Neither was an error at the sample
   size available; both are corrected by the population.
