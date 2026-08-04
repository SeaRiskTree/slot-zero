import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A CITATION TO A MISSING FILE READS AS EVIDENCE AND IS NOT.
 *
 * `data/` in this repo holds tapes — two of them. Every companion report and decision record this
 * project cites lives in firstmate's records, OUTSIDE this tree; `README.md` → "the six companion
 * reports" states that position, and it is deliberate rather than an oversight. So a citation
 * written as `data/<report-name>/report.md` renders as a path a reader can open and there is no
 * such file, which is this repo's characteristic defect — a claim outrunning what backs it — in its
 * purest form. One instance sat inside a committed evidence record (`runs/2026-08-02-good.json`),
 * so the lab's own audit trail cited a source nobody could open.
 *
 * It was fixed once before and came back, because the citation is genuinely WANTED: the external
 * report really is the evidence for those claims, and nothing in the tree distinguished a real
 * dataset path from a report name. So a sweep does not hold and this check exists instead.
 * `AGENTS.md` → "Citing a report this repo does not hold" owns the form to write instead, and
 * prefers an in-repo route (`analysis/window-population/`) wherever one exists, because a reader
 * can check that.
 *
 * Scope: `data/**\/*.md`, i.e. citation-shaped references to a document. Deliberately NOT every
 * `data/...` string — `--out data/arrival-rate-2026-08` in a usage example is a destination the run
 * creates, not a claim about existing evidence, and flagging it would teach the next lane that this
 * check cries wolf.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * This file's own tracked path, derived rather than written out so a rename cannot silently
 * re-break the exclusion below.
 */
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).split(sep).join('/');

/**
 * A `data/…/….md` reference: a citation shaped like a document a reader could open.
 *
 * Left-anchored so a path segment merely ENDING in `data/` (`metadata/schema.md`) cannot match from
 * the `data/` substring onward and report a truncated path the author cannot find in their file.
 */
const DATA_DOC_CITATION = /(?<![A-Za-z0-9_.-])data\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.md/g;

/**
 * The sites that predate this check, and the dead path each still carries.
 *
 * THIS IS A WORKLIST, NOT AN EXEMPTION. Every entry is a real dead citation awaiting the lane that
 * owns its file; firstmate sequences them, because several of these files are held by live lanes
 * and exclusive ownership is how this project avoids two agents editing one file. The entries are
 * asserted to be STILL DEAD below, so retiring one and forgetting this list fails the suite rather
 * than rotting quietly.
 *
 * A citation added from today is not here and fails immediately. Adding an entry is not how you
 * make this check pass.
 *
 * Handed off by the lane that removed the six `data/slot-zero-june-regime-change/report.md`
 * citations (`AGENTS.md`, `tools/deployer-screen/stage0.mjs` ×2, `tools/deployer-screen/screen.mjs`,
 * `tools/deployer-screen/runs/2026-08-02-good.json`) and the three other dead report paths in
 * `AGENTS.md`. `tools/deployer-screen/README.md` was explicitly out of that round's scope.
 */
const PENDING: ReadonlyArray<readonly [file: string, deadPath: string]> = [
  // Held by the deployer-screen README/thresholds lane running alongside the round that added this
  // check. The June-report citation here is the last of the seven that round was opened for.
  ['tools/deployer-screen/README.md', 'data/slot-zero-june-regime-change/report.md'],
  ['tools/deployer-screen/README.md', 'data/slot-zero-bundling-predicate-question/report.md'],
  ['tools/deployer-screen/thresholds.json', 'data/slot-zero-stage2-reverify/report.md'],

  // Rest of the deployer-screen tool.
  ['tools/deployer-screen/CREATION-DERIVED.md', 'data/slot-zero-dune-evaluate/report.md'],
  [
    'tools/deployer-screen/CREATION-DERIVED.md',
    'data/decisions/156-slot-zero-dune-vs-helius-creation-walk.md',
  ],
  ['tools/deployer-screen/dune.mjs', 'data/decisions/156-slot-zero-dune-vs-helius-creation-walk.md'],
  ['tools/deployer-screen/bundling.mjs', 'data/slot-zero-stage2-reverify/report.md'],
  [
    'tools/deployer-screen/census/2026-08-03-bundling-census.md',
    'data/slot-zero-bundling-predicate-question/report.md',
  ],
  [
    'tools/deployer-screen/census/2026-08-03-bundling-census.md',
    'data/slot-zero-stage2-reverify/report.md',
  ],

  // The arrival-rate walk.
  ['tools/arrival-rate-walk/README.md', 'data/slot-zero-discovery-widen-operations/report.md'],
  ['tools/arrival-rate-walk/bounds.json', 'data/slot-zero-discovery-widen-operations/report.md'],
  ['tools/arrival-rate-walk/cohort.mjs', 'data/slot-zero-discovery-widen-operations/report.md'],
  ['tools/arrival-rate-walk/walk.mjs', 'data/slot-zero-cursor-gap-walk-blast/report.md'],
  ['tools/arrival-rate-walk/preflight.mjs', 'data/slot-zero-cursor-gap-walk-blast/report.md'],
  [
    'tools/arrival-rate-walk/preflight-2026-08-03.md',
    'data/slot-zero-cursor-gap-walk-blast/report.md',
  ],
  ['test/arrival-rate-walk.test.ts', 'data/slot-zero-cursor-gap-walk-blast/report.md'],

  // The creation census.
  ['tools/creation-census/README.md', 'data/slot-zero-discovery-widen-operations/report.md'],
  ['tools/creation-census/bounds.json', 'data/slot-zero-discovery-widen-operations/report.md'],
  ['tools/creation-census/census.mjs', 'data/slot-zero-discovery-widen-operations/report.md'],
  ['tools/creation-census/credential.mjs', 'data/slot-zero-discovery-widen-operations/report.md'],
  // A committed evidence record. Correcting a citation inside one is licensed; touching a measured
  // value or a row inside one is not.
  [
    'tools/creation-census/runs/2026-07-census.json',
    'data/slot-zero-discovery-widen-operations/report.md',
  ],
];

/**
 * Tracked files worth scanning: skip `data/` itself and the binary/columnar payloads.
 *
 * This file is excluded too, and the reason is principled rather than a carve-out to make the suite
 * green: it is the allow-list's home, so every dead path it names is a string literal of a citation
 * that BY DEFINITION does not resolve — the subject of the check, not an instance of the defect.
 * Scanning it would report `PENDING` back as 22 new violations. The exclusion is exactly one file
 * (asserted below) so it cannot quietly widen into a directory-level skip.
 */
function scannableFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  return tracked.filter(
    (f) => !f.startsWith('data/') && !f.endsWith('.gz') && !f.endsWith('.csv') && f !== SELF,
  );
}

/** Every `(file, deadPath)` pair in the tree, deduplicated per file. */
function deadCitations(): Array<{ file: string; deadPath: string }> {
  const found: Array<{ file: string; deadPath: string }> = [];
  for (const file of scannableFiles()) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // a symlink to a file scanned under its own name, or an unreadable blob
    }
    for (const deadPath of new Set(text.match(DATA_DOC_CITATION) ?? [])) {
      if (!existsSync(join(ROOT, deadPath))) found.push({ file, deadPath });
    }
  }
  return found;
}

const key = (file: string, deadPath: string) => `${file} → ${deadPath}`;

/** One scan of the tree, shared by every assertion below. */
const DEAD = deadCitations();

describe('no citation points at a document this repo does not hold', () => {
  it('the guard excludes exactly its own source, and nothing else', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .filter((f) => !f.startsWith('data/') && !f.endsWith('.gz') && !f.endsWith('.csv'));
    const scanned = new Set(scannableFiles());

    expect(tracked).toContain(SELF);
    expect(tracked.filter((f) => !scanned.has(f))).toEqual([SELF]);
  });

  it('every new `data/**/*.md` citation resolves on disk', () => {
    const allowed = new Set(PENDING.map(([f, p]) => key(f, p)));
    const unexpected = DEAD.map(({ file, deadPath }) => key(file, deadPath))
      .filter((k) => !allowed.has(k))
      .sort();

    // `data/` holds tapes, not reports. Cite an external report by name — see AGENTS.md →
    // "Citing a report this repo does not hold" — or, better, cite the in-repo route that
    // re-derives the claim, which a reader can actually check.
    expect(unexpected).toEqual([]);
  });

  it('the pending allow-list is the worklist it claims to be — no entry has gone stale', () => {
    const live = new Set(DEAD.map(({ file, deadPath }) => key(file, deadPath)));
    const retired = PENDING.map(([f, p]) => key(f, p))
      .filter((k) => !live.has(k))
      .sort();

    // A retired entry means the dead citation is gone — delete its line from PENDING in the same
    // commit, so the list keeps naming exactly the work that is left.
    expect(retired).toEqual([]);
  });

  it('the file every agent reads carries no dead citation of its own', () => {
    // AGENTS.md is the propagation vector: a lane reaching for this evidence copies the form it
    // finds here. That is why the same dead path came back after being fixed once, and why this
    // file is held to the rule with no pending entries.
    const inAgentsMd = DEAD.filter(({ file }) => file === 'AGENTS.md');
    expect(inAgentsMd).toEqual([]);
  });
});
