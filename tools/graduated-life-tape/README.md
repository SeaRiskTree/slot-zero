# `graduated-life-tape` — extending the launch tape past the bond, at EUR 0

The collector behind `data/graduated-life-tape-2026-08-02/`. It answers captain decision **112a**
— *decline MadeOnSol Pro at EUR 43/mo, extend our own keyless tape instead* — and the EUR 0 is not
an aspiration in this directory, it is a property the test suite enforces.

```bash
node tools/graduated-life-tape/collect.mjs --phase graduation --out data/graduated-life-tape-2026-08-02
node tools/graduated-life-tape/collect.mjs --phase life       --out data/graduated-life-tape-2026-08-02
```

Both phases are **resumable**: every launch is written the moment its own work finishes, and each
phase skips launches already on disk. Interrupting a run costs the launch in flight and nothing
else. Re-running the same command resumes.

### Flags

| flag | default | what it does |
|---|---|---|
| `--phase` | *required* | `graduation` or `life`. |
| `--out` | *required* | Dataset directory. Required for a live run so no run happens without leaving `requests.csv`. |
| `--only <mint>` | all | Restrict to these mints. Repeatable. |
| `--limit <n>` | all | Take the first `n` launches of whatever survives the filters. |
| `--max-pages <n>` | `MAX_PAGES_PER_LAUNCH` (100) | Per-launch page ceiling for the life walk. |
| `--min-interval-ms <ms>` | `DEFAULT_MIN_INTERVAL_MS` (4,000) | Pacing floor. **May be raised, never lowered** — 4 s is measured and the parser refuses anything below it. |

All three numeric flags are validated at parse time and **reject** a non-positive or non-finite
value rather than coercing it. That is not defensiveness: `Number('x')` is `NaN`, and every
comparison this collector makes against these values fails *open* — a `NaN` interval removes the
pacing floor entirely against a shared public endpoint, and a `NaN` page ceiling walks zero pages
and then writes an empty sidecar the resume logic treats as a finished launch.

**The resume filter runs BEFORE `--only`, and that ordering is deliberate.** A mint that already
has output is dropped from the work list first, so `--only <mint>` can narrow a run but can never
re-do a launch that is already on disk. To re-walk one — the procedure used to complete the seven
launches the default page ceiling truncated — **delete that launch's sidecar first**:

```bash
rm data/graduated-life-tape-2026-08-02/life/<mint>.meta.json
node tools/graduated-life-tape/collect.mjs --phase life --out data/graduated-life-tape-2026-08-02 \
  --only <mint> --max-pages 300
```

The skip-if-present behaviour is what makes a multi-hour walk resumable, so it stays; the deletion
is the explicit, visible way to spend requests on a launch twice.

---

## What it collects, and why that shape

The committed population tape covers each of its 239 launches for that launch's own **opening
window** — 60 s on 210 of them, 120 s on 4 and 300 s on 25. That window was right for the question
it was built for and is wrong for what is left, because in this population the median bond lands at
**+17 minutes**. So the committed window ends at roughly **27% of the bond price**, **52% of
(wallet, launch) pairs are still open when it ends**, and every counterparty who held past it
currently has a P&L that is an artefact of where the window stopped rather than of what they did.

The naive fix — a whole-life walk on all 239 launches — was costed at **~9,500 keyless requests**
and would spend most of them on nothing. This collector is the narrowed shape recommended by
`kol-bond-timing-vs-dev-exit` §5: **roughly a quarter of the cost for the great majority of the
remaining information.**

**Three narrowings:**

1. **No graduation-detection inside the walk.** Phase one pins every graduation instant first, for
   ~10 requests a launch, and phase two is *bounded by* it. Discovering the same fact inside a
   bigger walk costs far more and bounds nothing.
2. **Graduated launches only** — 103 of 239. Of the 136 skipped, 98 sit within 1% of the empty
   curve with under 0.1 SOL of reserves and a median 42 days since their last trade. There is no
   price path left to reconstruct and the interesting part of their life is already inside the
   committed opening window. That alone is ~57% of the token count.
3. **Bounded at the last trade, not at "now."** Median idle time is 3.7 days for graduated tokens.
   A walk that runs to the present spends requests on silence.

**Three widenings**, all of which fall out of walking `mint → graduation + 1 hour` on all 103:

4. **The window where the remaining question lives.** The median peak is 1.21× the bond, and one
   hour past graduation closes the great majority of the positions the committed window left open.
5. **The dev's own behaviour on the ten launches where the deployer is still holding at the bond** —
   the one mode in which he can sell into a graduated pool. Seven were chain-reconstructed by an
   earlier scout at considerable cost; `TruthGPT`, `Sol` and `Fox` never were. The trade endpoint
   covers all ten, and it does so as a by-product of walking everything.
6. **The four >5× outcomes and the two survivors** — `maxxing` (151.7× its bond), `Gnomes` (12.0×),
   `papoi` (4.4×), `float` (3.0×). Four tokens carry essentially all of the upside in the dataset
   and none had a reconstructed life. They are the whole of the positive evidence and they are
   cheap to walk.

---

## Phase one: pinning graduation by geometric bisection

A re-derivation of `kol-bond-timing-vs-dev-exit` §2.1, whose own output lived in that task's `/tmp`
and never reached a repository. Re-derived rather than transcribed, because a number this whole
collection is *bounded by* must be reproducible from committed code and committed data.

The method rests on one property: **the venue field is monotone.** `program` is `pump` on the
bonding curve and `pump_amm` on PumpSwap, a token never goes back, and the first `pump_amm` fill
**is** the migration to within one fill. The scout verified monotonicity on 18 on-disk tapes with
zero violations and verified the venue field itself on-chain against the two program ids. So *"had
this token graduated by instant T"* is a monotone predicate over a seekable index, and monotone
predicates over seekable indexes can be bisected.

**Geometric, not arithmetic.** The unknown ranges over five orders of magnitude in this population
— `Lockin` bonded in under a second, `Moonbase` took weeks. Bisecting the logarithm reaches a fixed
*relative* precision in a fixed number of probes at any scale: ~9 probes for 2%, whether the answer
is 5 seconds or 30 days.

Three accelerations, and each is **exact rather than converged**:

- **The committed window is free.** Launches that bonded inside their own opening window
  are already bracketed in committed data at **zero requests**.
- **A page holding both venues brackets the migration between two adjacent fills.** Rows come back
  newest-first and the sequence is monotone, so such a page reads `[AMM … AMM, curve … curve]` and
  the migration sits in the gap.
- **The uncursored first page does three jobs for one request**: says whether the token ever
  graduated, fixes the outer bound of the later walk, and can terminate the search outright.

`source` in `graduation.csv` records which of the three answered — `tape`, `page` or `bisect` — and
`bracket_ms` records the width. **A point estimate with no width would let a ±17-minute bisection
and a one-fill page straddle read as the same measurement**, and three launches in this population
bond days to weeks after the mint and are genuinely imprecise.

**`grad_ms` is the upper end of the bracket** — the earliest instant *known* to be post-migration.
That direction is deliberate: phase two's window is `grad_ms + 1 hour`, so bracket imprecision makes
the walk cover **more** than the true window rather than less. Over-covering is recoverable by
filtering; under-covering is the silent truncation this tool exists to refuse.

---

## Phase two: the bounded backwards walk

Rows come back **newest first**, so this walk runs backwards and reaches the create slot **last**.

That is the whole hazard. A backwards walk that stops early does not fail — **it returns a
plausible pile of fills whose earliest slot is merely the earliest it happened to see**, and any
create-slot measure taken on it will crown a mid-window sniper as the deployer. Coverage is
therefore never inferred from "we ran out of pages". Two things and only two things prove it:

- a fill strictly older than the bound is present, so the walk demonstrably crossed it; or
- the endpoint states there is nothing more (`hasMore === false`).

An unrecognised body proves nothing. A recognised-but-empty page proves nothing on its own. This is
the same standard as the committed tape's `meta.reached_mint`, and `reached_mint` in each life
sidecar carries the answer per launch — never summed, because a truncated walk loses its **oldest**
end, which is the mint end, which is the valuable one.

**One free cross-check runs on every launch.** The committed window tape proved its own coverage
of the create slot. A life walk that claims to have reached the mint must land on the same slot;
`create_slot_agrees` in each sidecar records the comparison, and `test/graduated-life-tape.test.ts`
asserts it never comes back false.

---

## Bounds, and why they are these numbers

**One host, keyless, no account, no cost:** `swap-api.pump.fun/v2/coins/{mint}/trades`. Nothing
else. `solana-rpc.publicnode.com` is deliberately absent — it 403s this client outright on every
request, and anything copying the entity report's endpoint list sends half its batches to a dead
host while the retry backoff hides it. A test refuses any URL naming it.

**Pacing is measured, not chosen.** The endpoint refuses essentially everything at a 2 s interval
and serves cleanly at 8 s. The scout that pinned the graduation instants settled on a **4 s floor
with adaptive backoff** and completed 871 requests in 66 minutes with no sustained lockout.
`DEFAULT_MIN_INTERVAL_MS` is that floor; `BACKOFF` grows the interval by 1.6× on every 429 or 5xx
and decays it by 0.85× after five clean responses, clamped to 40 s — the top of the range the
committed tape's own builder reached.

**A 429 is the normal case, not an incident.** The committed tape's build metadata records
**16,960 HTTP 429 against 51,715 OK, with 221 of 235 launches shedding at least once.** A client
without retry cannot walk this endpoint at all.

| bound | value | why |
|---|---:|---|
| `GRADUATION_CEILING` | 1,600 attempts | 85 launches needing probes × ~10, plus room for the measured ~25% shed rate |
| `LIFE_CEILING` | 6,000 attempts | 103 launches × 10–40 pages, plus shed |
| `MAX_PAGES_PER_LAUNCH` | 100 | 10,000 fills — four times the widest launch in the committed tape |
| `MAX_PROBES` | 14 | geometric bisection over 1 s–40 days needs ~10 to reach 2% |
| interval floor | 4,000 ms | measured; 2 s is refused, 8 s is clean, 4 s + backoff sustained 871 requests |

Every **attempt** counts against a ceiling, retries included — a bound that only counted first
tries would not be a bound. Every attempt is also written to `requests.csv`, so the run's exact cost
is a committed fact rather than a claim in prose, and a test asserts the dataset README's published
count equals the ledger's row count.

---

## Why this duplicates `tools/deployer-screen/pumpfun.mjs`

On purpose, and it is the cheaper of two costs. That module has a keyless client over the same
endpoint and is under active edit by the screen lane; importing it would couple a multi-hour
collection walk to a file whose pacing constants and error types are moving. The duplication is the
same kind of deliberate cost as the curve constants shared between `src/index.ts` and
`tools/deployer-screen/measure.mjs` — do not "fix" it by importing across it. A test refuses any
import between the two directories.

## The keyless guarantee, enforced structurally

`test/graduated-life-tape.test.ts` asserts that **only `client.mjs` calls `fetch`**, that no file
here names an environment variable or any credential-shaped identifier, that no file contains a
key-shaped string, that no URL reaches a metered host, and that nothing imports across
`src/`↔`tools/` or `analysis/`↔`tools/`. Unlike `tools/deployer-screen/`, this directory has no
allowed list of files that may name a key — **the list is empty**, and that is the guarantee: no
request originating here can ever be metered.
