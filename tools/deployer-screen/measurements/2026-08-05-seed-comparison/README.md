# The 2026-08-05 seeding comparison — three records that no schema version describes

These are the three run records of the 2026-08-05 seeding comparison (captain decision 232c),
preserved **byte for byte as the run wrote them**:

| leg | invocation | record |
|---|---|---|
| A — untiered | `screen.mjs` | `2026-08-05-untiered.json` |
| B1 — tiered | `screen.mjs --tier good` | `2026-08-05-tier-good.json` |
| B2 — tiered | `screen.mjs --tier elite` | `2026-08-05-tier-elite.json` |

The analysis is `../../runs/2026-08-05-seed-comparison.md`.

## Why no version number describes them

They declare `schemaVersion: 16` and they do **not** satisfy schema 16 as `main` defines it: no
candidate row carries `prediction`, which is the one key `PERSISTED_BY_SCHEMA[16]` adds. Their
candidate rows match **schema 15 exactly**. Their run-level `predictions` block holds the
`--predict` document, which under the shipped contract is a **schema-17 block named
`declaredPredictions`** — schema 16's `predictions` is a different thing entirely, the screen's own
per-candidate prediction claims emitted from its own verdicts.

So these are schema-15 candidate rows plus a run-level block that only exists at 17. They were
written by a build that was rebased away when a concurrent PR took schema 16 for that different
mechanism. No single version number is true of them, and inventing one would be worse than saying so.

## Why they are not in `runs/`

`runs/` is the prediction-grading lane's contract: every record there is asserted, per version,
against the key sets the tests pin. These are not conformant run records, and keeping them there
behind an exemption would assert they belong to a contract they demonstrably do not satisfy — while
costing every other record the strength of the check. Moving them says the true thing and leaves
every assertion with its teeth.

## What they still are

They remain the **evidence** for `../../runs/2026-08-05-seed-comparison.md` and for the captain
decisions that report leaves open. They must never be retro-edited, reformatted or renumbered.

**Re-running does not reproduce them.** A re-run measures a different day: the vendor pools slide,
and the elite pool moved from 22 to 59 in a week. What is here is the only record of what was
measured on 2026-08-05.
