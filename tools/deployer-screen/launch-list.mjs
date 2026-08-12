/**
 * The launch list the screen leaves behind, as a BY-PRODUCT of work it already paid for.
 *
 * Captain decision **457a**, 2026-08-12. PR 87 / decision 437a required a lane budget on every
 * code path that spends a Dune credit, which left the arrival-rate walk's launch-list leg with **no
 * guarded execution path at all** — that lane is keyless throughout, its credential allow-list is
 * empty and a test enforces it, so it cannot acquire one. The captain's answer was neither to give
 * an unkeyed lane a keyed path nor to add a second guarded caller, but to notice that the screen
 * ALREADY enumerates exactly these rows, under a budget that is already approved, and to write them
 * down instead of discarding them.
 *
 * ## Which path it rides on, and why that path was already approved
 *
 * `dune.mjs` → `enumerateCreations`, the Stage 1 creation-enumeration leg. It is one of the two
 * callers of `DuneClient.execute` in this repository (`test/dune-credit-ceiling.test.ts` → "437(a)"
 * pins that enumeration as a source fact), it refuses before its first request without a monthly
 * allowance decision and a lane budget, and it is what a default screen run has been spending on
 * since captain decision 156a. **Nothing here adds a request, an execution, a credit or a byte to
 * it.** The rows written out are the rows that leg parsed for the gate; this module projects them
 * and `screen.mjs` writes the file after the leg has answered.
 *
 * It is nonetheless **opt-in** (`--launch-list`), for the reason `--out` is: the flag buys
 * permission to PERSIST per-launch rows, not permission to spend, and this tool's standing posture
 * is that those rows live in memory for one run unless an operator asks otherwise. A default-on
 * write is also how a test run — or any run nobody asked — comes to deposit a fixture in the
 * directory a real lane takes its newest list from, which is not hypothetical: it is what the first
 * cut of this change did.
 *
 * ## Where it goes, and why not into the tree
 *
 * `config/data-root.mjs` → {@link SCREEN_LAUNCH_LIST_DIRNAME} by default, in the off-repo data
 * store; `--launch-list <dir>` names another. A real
 * batch is tens of thousands of rows — one committed candidate reads 749 launches on its own — so a
 * file per run in this repository would grow back exactly what dry dock phase C removed. It is the
 * same reason `tools/arrival-rate-walk/collect.mjs` puts its `--out` in the store, and the location
 * lives in `config/` because neither tool may import the other and a copy in each is a path free to
 * be corrected in one and forgotten in the other.
 *
 * ## What persisting it changes, stated rather than buried
 *
 * `CREATION-DERIVED.md` §8.7 read *"per-launch rows live in memory for one run, only derived counts
 * are written"*. That is no longer true of a run that writes this file, and §8.7 now says so. What
 * has NOT changed is the ToS argument behind it: Dune's terms address neither caching nor derived
 * data, the columns here are chain facts — a mint, its creation instant, whether its curve completed
 * — obtainable keylessly from the chain and not proprietary to the vendor, the file is written
 * OUTSIDE the repository and is not committed, and the whole point of it is to REMOVE an execution
 * the arrival-rate lane would otherwise need. This is the same shape captain decision 459 recorded
 * one lane over: the retention posture moved and the argument did not.
 *
 * ## What this module may not become
 *
 * It reaches no vendor, holds no client and is imported by no scoring module. It is a projection and
 * a file format. If a future lane needs a launch list the screen did not happen to produce, the
 * answer is to run the screen over those wallets (`--wallets`, captain decision 398a) — **not** to
 * add a second guarded caller here, which is the option the captain did not choose.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCREEN_LAUNCH_LIST_DIRNAME, screenLaunchListDir } from '../../config/data-root.mjs';

export { SCREEN_LAUNCH_LIST_DIRNAME, screenLaunchListDir };

/**
 * The machine-readable marker on the envelope.
 *
 * A reader keys on this before anything else, and the arrival-rate walk carries a byte-identical
 * copy of it (`tools/arrival-rate-walk/launch-list.mjs`) because the two tools may not import each
 * other; `test/launch-list-handover.test.ts` pins the copies together in both directions.
 *
 * It is deliberately NOT the shape `cohort.mjs` → `readDuneResultFile` accepts. That reader takes a
 * bare array, `{rows}` or `{result:{rows}}`, so naming this file's rows `rows` would let it be read
 * as an ordinary Dune export — silently, with every provenance and staleness field on the envelope
 * ignored. The rows live under {@link LAUNCH_LIST_ROWS_KEY} instead, so the raw reader REFUSES this
 * file rather than half-understanding it.
 */
export const LAUNCH_LIST_KIND = 'slot-zero-screen-launch-list';

/** The document's own contract version. Bump, never retro-edit — this is another lane's input. */
export const LAUNCH_LIST_SCHEMA_VERSION = 1;

/** Where the rows live. See {@link LAUNCH_LIST_KIND} for why it is not `rows`. */
export const LAUNCH_LIST_ROWS_KEY = 'launches';

/**
 * The contract, carried INSIDE every document rather than only in a README.
 *
 * A launch list is read by a lane that cannot see this repository's prose at the moment it walks,
 * and the four sentences below are the ones a reader gets wrong at real cost. It travels with the
 * file for the same reason `identity.mjs` → `CITATION_RULE` travels with a venue label: the
 * misreading is easier than the reading.
 */
export const LAUNCH_LIST_CONTRACT = [
  'BY-PRODUCT, NOT A FETCH. These rows are the deployer screen\'s Stage 1 creation-enumeration ' +
    'answer, written down instead of discarded. No vendor request was issued to produce this file ' +
    'and no lane may issue one to refresh it: re-run the screen over the wallets you need ' +
    '(--wallets), which is the one approved path.',
  'generatedAtIso IS THE OBSERVATION CEILING. Nothing after that instant was looked for. A ' +
    'deployer with no launch near the end of this list may have stopped launching or may simply be ' +
    'beyond the list\'s reach, and THIS FILE CANNOT TELL THOSE APART — so a reader measuring ' +
    'arrival, duration or idle time must treat the ceiling as the end of its observation and must ' +
    'state the list\'s age.',
  'AN ABSENT WALLET WAS NEVER ASKED ABOUT, and an empty row set is not a history of zero. Every ' +
    'wallet this run enumerated is in `deployers` with its own status; a wallet that is not there ' +
    'was outside this run\'s batch. Reading either as "created nothing" is the invisible false ' +
    'rejection the creation-derived lane exists to remove.',
  'A DEPLOYER MARKED usable:false MAY NOT BE WALKED ON THESE ROWS. The screen refused to gate on ' +
    'that reading and said why — a truncated prefix, a history reaching outside the probed ' +
    'coverage, an unreadable row anywhere in the batch. The rows may still be there; what is ' +
    'missing is any claim that they are whole.',
].join('\n');

/**
 * @typedef {object} LaunchListDeployer
 * @property {string} wallet
 * @property {boolean} usable Whether the screen's own gate would read this wallet's rows. `false`
 *   means the rows may not be walked as a history — see {@link LAUNCH_LIST_CONTRACT}.
 * @property {string[]} reasons Why not, empty when usable.
 * @property {number} launchesReturned Rows in this document for this wallet.
 * @property {number | null} declaredLaunches `launches_total`, or `null` when the wallet returned no
 *   row or its rows disagreed about their own count.
 * @property {boolean} truncatedByLaunchCap Whether the per-deployer cap cut this history.
 */

/**
 * @typedef {object} LaunchListDocument
 * @property {string} kind
 * @property {number} schemaVersion
 * @property {string} contract
 * @property {string} generatedAtIso
 * @property {{ tool: string, path: string, recordSchemaVersion: number, runRecord: string | null,
 *   candidateSource: string }} producedBy
 * @property {{ creationQueryId: number, rowsReturned: number, unreadableRows: number,
 *   launchCap: number, walletsAsked: number, walletsUsable: number, legFailure: string | null,
 *   coverage: { ok: boolean, fromIso: string | null, toIso: string | null, reasons: string[] } | null }} enumeration
 * @property {LaunchListDeployer[]} deployers
 * @property {import('./dune.mjs').LaunchListRow[]} launches
 */

/**
 * Assemble the document from what the enumeration leg already returned.
 *
 * **A leg that FAILED still produces a document**, with no rows and `legFailure` set. That is
 * deliberate: the file name carries the instant, so a reader taking the newest one must be able to
 * see that the newest attempt came back empty. Writing nothing would leave an older, successful list
 * looking like the current state of the world, which is the one reading this whole handover exists
 * to prevent.
 *
 * @param {object} input
 * @param {import('./dune.mjs').DuneEnumeration | null} input.enumeration `null` when the leg threw.
 * @param {readonly string[]} input.wallets Every wallet the leg was asked about, in run order.
 * @param {number} input.generatedAtMs
 * @param {number} input.creationQueryId
 * @param {number} input.recordSchemaVersion
 * @param {string | null} input.runRecord Where this run's record was written, or `null`.
 * @param {string} input.candidateSource `vendor-seed` or `wallet-list` — provenance only, exactly as
 *   on the run record, and read by nothing.
 * @param {string | null} input.legFailure The leg's own failure note, or `null`.
 * @returns {LaunchListDocument}
 */
export function buildLaunchListDocument(input) {
  const { enumeration } = input;
  /** @type {LaunchListDeployer[]} */
  const deployers = [];
  /** @type {import('./dune.mjs').LaunchListRow[]} */
  const launches = [];
  for (const wallet of input.wallets) {
    const e = enumeration?.byWallet.get(wallet) ?? null;
    const rows = enumeration?.launchListByWallet.get(wallet) ?? [];
    deployers.push({
      wallet,
      // A leg that threw established nothing about any wallet, so every one of them is unusable
      // here rather than absent: absent means NEVER ASKED, and these were asked.
      usable: e?.usable ?? false,
      reasons:
        e === null
          ? [
              input.legFailure ??
                'the Dune enumeration leg produced no answer for this run, so nothing is established ' +
                  'about this wallet either way.',
            ]
          : [...e.reasons],
      launchesReturned: rows.length,
      declaredLaunches: e?.declaredLaunches ?? null,
      truncatedByLaunchCap: e?.truncatedByLaunchCap ?? false,
    });
    launches.push(...rows);
  }
  const coverage = enumeration?.coverage ?? null;
  return {
    kind: LAUNCH_LIST_KIND,
    schemaVersion: LAUNCH_LIST_SCHEMA_VERSION,
    contract: LAUNCH_LIST_CONTRACT,
    generatedAtIso: new Date(input.generatedAtMs).toISOString(),
    producedBy: {
      tool: 'tools/deployer-screen/screen.mjs',
      path: 'dune.mjs -> enumerateCreations (Stage 1 creation enumeration)',
      recordSchemaVersion: input.recordSchemaVersion,
      runRecord: input.runRecord,
      candidateSource: input.candidateSource,
    },
    enumeration: {
      creationQueryId: input.creationQueryId,
      rowsReturned: enumeration?.rowsReturned ?? 0,
      unreadableRows: enumeration?.unreadableRows ?? 0,
      launchCap: enumeration?.launchCap ?? 0,
      walletsAsked: input.wallets.length,
      walletsUsable: deployers.filter((d) => d.usable).length,
      legFailure: input.legFailure,
      coverage:
        coverage === null
          ? null
          : {
              ok: coverage.ok,
              fromIso: coverage.fromMs === null ? null : new Date(coverage.fromMs).toISOString(),
              toIso: coverage.toMs === null ? null : new Date(coverage.toMs).toISOString(),
              reasons: [...coverage.reasons],
            },
    },
    deployers,
    // Spelled out rather than computed from LAUNCH_LIST_ROWS_KEY so the type checker sees the shape
    // the typedef declares; `test/launch-list-handover.test.ts` pins the constant against the key
    // this literal actually emits, in both tools.
    launches,
  };
}

/**
 * The file name for a document, derived from its own `generatedAtIso`.
 *
 * **Lexicographic order is chronological order**, which is what lets a reader pick the newest
 * without opening every file in the directory. The colons an ISO instant carries are replaced
 * because they are not portable in a file name; the reader re-derives this name from the envelope it
 * read and REFUSES a mismatch, so a renamed or hand-edited file is caught rather than trusted.
 *
 * @param {string} generatedAtIso
 * @returns {string}
 */
export function launchListFileName(generatedAtIso) {
  return `${generatedAtIso.replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')}.json`;
}

/**
 * Write the document into the handover directory, creating it if it is not there.
 *
 * @param {LaunchListDocument} doc
 * @param {string} [dir] Defaults to {@link screenLaunchListDir}.
 * @returns {string} The path written.
 */
export function writeLaunchListDocument(doc, dir = screenLaunchListDir()) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, launchListFileName(doc.generatedAtIso));
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return target;
}
