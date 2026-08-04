# The clock pre-flight, 2026-08-03

**Result: the two clocks agree exactly, on 12 of 12 launches spread across the committed tape's
whole range. The pinned 5,000 ms floor slack holds with 4 s to spare, and the collection may
proceed on that ground.**

Reproduce:

```bash
node tools/arrival-rate-walk/collect.mjs --phase preflight --out <dir>
```

**Spend: 12 keyless requests against `api.mainnet-beta.solana.com`, 2.5 s apart, 12 of 12 answered
200, no retry, no shed.** Ceiling was 60. Zero keyed requests, zero Dune executions.

---

## What was tested and why

`walk.mjs` bounds each launch's window from a **declared mint instant** that comes from Dune's
`created_at` — the **chain's block time**. Every fill's `ts` comes from the **vendor's** clock at
second resolution. `tools/deployer-screen/pumpfun.mjs`'s pre-mint tripwire compares the two with
**zero slack**, and its own comment warns that a positive skew of one millisecond would delete the
entire create slot. It would do so silently, and on whichever launches happened to sit at the bad
end — a non-random subset.

`data/slot-zero-cursor-gap-walk-blast/report.md` §7.7 ranks this seventh of the biases it found and
says why it is worth a pre-flight anyway: the prior evidence that the clocks agree is **n = 5** and
was never checked against the Dune column specifically.

## Leg A — chain block time against the vendor's creation instant

For twelve of the 239 committed launches, `getBlockTime(createSlot)` against the window sidecar's
`created_timestamp`. Launches chosen by spreading across the tape's own date range rather than
sampling at random, because the quantity under test is a *systematic* difference between two clocks
that have both been running for the whole tape.

Only launches with a **proved** create slot are eligible (`reached_mint: true`): on an uncovered
window the oldest slot is merely the oldest the builder reached, and asking the chain what time that
block was produced would compare the creation instant against a mid-window sniper's block.

| launch | vendor creation instant | skew (chain − vendor) |
|---|---|---:|
| `maxxing` | 2025-12-01T19:37:59Z | **0 ms** |
| `Solana` | 2026-03-17T17:00:01Z | **0 ms** |
| `Success` | 2026-04-03T12:31:43Z | **0 ms** |
| `Dino` | 2026-04-09T10:32:27Z | **0 ms** |
| `Hope` | 2026-04-17T17:08:25Z | **0 ms** |
| `Molly` | 2026-05-05T16:30:34Z | **0 ms** |
| `Valera` | 2026-05-20T19:48:36Z | **0 ms** |
| `BrownBear` | 2026-06-06T12:27:13Z | **0 ms** |
| `Pufferfish` | 2026-06-22T13:38:14Z | **0 ms** |
| `float` | 2026-07-05T13:03:12Z | **0 ms** |
| `Us` | 2026-07-20T18:02:52Z | **0 ms** |
| `Restoration` | 2026-07-28T20:51:02Z | **0 ms** |

Median 0 ms, max positive 0 ms, max negative 0 ms, 0 unmeasured. Worst case with one second of
shared clock granularity: **1,000 ms**, against a pinned floor slack of **5,000 ms**.

Note the first row: `maxxing` is the launch whose creator record moved on-chain and which the
ownership listing loses. Its block time still lands on the vendor's instant to the second.

## What this does NOT establish

- **It is a chain-clock check, not a Dune-column check.** Dune's `evt_block_time` is the block time
  of the block a creation landed in, which is the quantity `getBlockTime` returns — but that is an
  inference from the decoded table's schema, not a measurement of the column. **Leg B is the direct
  form, it costs no request and no execution, and it must be run before the collection**: it
  compares the launch-list export's `created_at` against the same twelve sidecars.

  ```bash
  node tools/arrival-rate-walk/collect.mjs --phase preflight --out <dir> --launch-list <export>
  ```

  Leg B could not run here because the launch-list export does not exist yet — as recorded on this
  date, the cohort stage was believed blocked on a Dune saved-query slot. **That blocker was not
  real** and `COHORT_SQL` was deployed on 2026-08-04 as saved query `8214953`; the cohort stage is
  runnable now and leg B is still to run (`README.md` → "The census that runs this statement").
- **Both clocks are second-resolution, so 0 ms means "within one second", never "identical".** That
  is exactly why the verdict's arithmetic carries `SECOND_RESOLUTION_MS` rather than reading a
  measured zero as a proved zero.
- **n = 12, on one deployer's launches.** The clocks belong to the venue and the chain rather than
  to the deployer, so there is no obvious mechanism by which a stranger's launches would differ —
  but no stranger's launch was checked, and the walk records `pre_mint_fills` per launch so a
  disagreement shows up in the collection itself rather than waiting for another pre-flight.
- **It says nothing about the *newest* end of a window.** That end is bounded by one number in one
  unit here (`walk.mjs`), which is the point of the design and is a separate argument.
