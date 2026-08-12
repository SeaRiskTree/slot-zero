/**
 * Reading the launch list the deployer screen leaves behind. **No network, no credential, no spend.**
 *
 * Captain decision **457a**, 2026-08-12. This lane needs a launch list — which mints each cohort
 * deployer created, and when — and it has no way to fetch one: it is keyless throughout, its
 * credential allow-list is EMPTY, and `test/arrival-rate-walk.test.ts` enforces both. PR 87 /
 * decision 437a then required a lane budget on every code path that spends a Dune credit, which left
 * the launch-list leg with no guarded execution path at all. The captain's answer was **not** to give
 * this lane a keyed one. The deployer screen already enumerates exactly these rows on a path that is
 * already budgeted and already approved (`dune.mjs` → `enumerateCreations`), so it writes them down
 * and this module reads the file.
 *
 * **Everything here is file I/O.** It opens no socket, names no credential, and adding either would
 * fail this directory's own boundary tests — which is the point of doing it this way rather than the
 * other way.
 *
 * ## Getting a list for THIS lane's cohort
 *
 * The screen enumerates the candidates IT was given, so a list covering this lane's January cohort
 * comes from running the screen over that cohort:
 *
 * ```bash
 * # the cohort's wallets, one per line — the screen gates them, it does not just enumerate them
 * node tools/deployer-screen/screen.mjs --wallets cohort-wallets.txt --no-stage2 --out <record>
 * ```
 *
 * `--wallets` is captain decision 398a's already-approved input and the screen's ONE gate loop
 * decides the verdicts either way; the launch list falls out of the enumeration the run was going to
 * do regardless. **A wallet that fails that gate still has its launches enumerated**, because
 * enumeration happens before the gate reads anything — so this lane's historical seed (decision
 * 165b, take the month whole, no filter on success) is not narrowed by the screen's own bar. What it
 * IS narrowed by is a wallet the screen could not vouch for; see the refusals below.
 *
 * ## The staleness rule, in one place
 *
 * {@link LAUNCH_LIST_STALENESS_RULE} states it and it is carried into the plan. The short form:
 * `generatedAtIso` is the **observation ceiling**, the age is always reported, a list from the future
 * is refused rather than given a negative age, and past a maximum age the CALLER states, the list is
 * refused. **There is no default maximum age and this module throws without one** — a default is a
 * pin, and nothing measured here establishes how fast a deployer population goes stale.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SCREEN_LAUNCH_LIST_DIRNAME, screenLaunchListDir } from '../../config/data-root.mjs';

export { SCREEN_LAUNCH_LIST_DIRNAME, screenLaunchListDir };

/**
 * The marker the writer stamps on the envelope, copied here byte for byte.
 *
 * The copy is deliberate and is this lane's standing cost: `tools/arrival-rate-walk/` may not import
 * `tools/deployer-screen/` and a test asserts it in both directions, because this collector runs for
 * days and must not be coupled to a file another lane is editing. What keeps the two honest is
 * `test/launch-list-handover.test.ts`, which pins every constant in this block against the writer's.
 */
export const LAUNCH_LIST_KIND = 'slot-zero-screen-launch-list';

/** The document contract version this reader understands. Exactly one. */
export const LAUNCH_LIST_SCHEMA_VERSION = 1;

/**
 * Where the rows live in the envelope — deliberately NOT `rows`.
 *
 * {@link readDuneResultFile} accepts a bare array, `{rows}` or `{result:{rows}}`, so a document
 * keyed on `rows` would read as an ordinary Dune export with every provenance and staleness field
 * silently ignored. Under this key that reader REFUSES the file instead, which is the direction a
 * handover has to fail in even when somebody routes it the wrong way.
 */
export const LAUNCH_LIST_ROWS_KEY = 'launches';

/** File names are the generated instant, so lexicographic order is chronological order. */
export const LAUNCH_LIST_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/;

/**
 * The rule this lane applies to an old list, stated once and carried into `plan.json`.
 *
 * **The correctness half and the refusal half are different things and both are needed.** The
 * correctness half is that `generatedAtIso` is the observation ceiling: nothing after it was looked
 * for, so a deployer that appears to have gone quiet at the ceiling may simply be beyond the list's
 * reach. `arrival.mjs` measures observation from the first to the last MEASURED launch rather than
 * from a wall clock, so an old list yields a SHORTER observation rather than a longer one divided by
 * the same launches — but the last segment of every deployer is then censored by OUR file's age and
 * not by the deployer's behaviour, and that is indistinguishable in the series itself. Hence the
 * refusal half.
 *
 * **No maximum age is pinned here.** Nothing this lane has measured says how fast a population of
 * screened deployers goes stale, and this repo's rule is that inventing an anchor is worse than
 * saying there is none — so the bound is a REQUIRED argument and {@link readLaunchListDocument}
 * throws without it, exactly as `measure.mjs` → `measureWindowParticipation` throws without its bar.
 * The CLI asks for it with `--launch-list-max-age-days` and the plan records what was applied, so
 * the choice is disclosed with the result rather than hidden in a default.
 */
export const LAUNCH_LIST_STALENESS_RULE =
  'A LAUNCH LIST IS AN OBSERVATION WITH A CEILING. generatedAtIso is the last instant anything was ' +
  'looked for; a deployer with no launch near it may have stopped launching or may simply be beyond ' +
  'this list\'s reach, and the file cannot tell those apart — so the last segment of every deployer ' +
  'may be censored by the list\'s age rather than by the deployer. The age is therefore reported ' +
  'with every read, a list generated AFTER the reading clock is refused rather than given a negative ' +
  'age, and a list older than the maximum age the caller STATES is refused. No maximum is pinned: ' +
  'nothing measured here establishes how fast this population goes stale, and a default would be a ' +
  'pin nobody chose.';

/**
 * @typedef {object} LaunchListProvenance
 * @property {string} path            Where it was read from.
 * @property {string} generatedAtIso  The observation ceiling.
 * @property {number} generatedAtMs
 * @property {number} ageMs           Against the caller's `nowMs`. Never negative — a future
 *   instant is a refusal, not a negative age.
 * @property {number} ageDays
 * @property {number} maxAgeDays      What the caller stated. Recorded so the plan says what was
 *   applied rather than leaving a reader to guess the rule.
 * @property {string} producedBy      Which tool and which path produced it.
 * @property {string} candidateSource The screen's own provenance field. Read by nothing.
 * @property {number} walletsAsked
 * @property {number} walletsUsable
 * @property {number} rowsReturned
 * @property {string} stalenessRule   {@link LAUNCH_LIST_STALENESS_RULE}, carried into the plan.
 * @property {string[]} refusals      Each one stops the run.
 * @property {string[]} advisories    Stated and fatal to nothing.
 * @property {{ wallet: string, reasons: string[] }[]} unusableDeployers Wallets the screen would not
 *   gate on. A refusal is raised for one only when the plan actually wants to walk it — a batch this
 *   lane's cohort does not overlap is not this lane's problem.
 */

/**
 * @typedef {object} LaunchListRead
 * @property {readonly unknown[]} rows The rows, in the shape `parseLaunchListRows` already reads.
 * @property {LaunchListProvenance} provenance
 */

/**
 * The handover directory, when the caller names no path.
 *
 * @returns {string}
 */
export function launchListHandoverDir() {
  return screenLaunchListDir();
}

/**
 * The newest launch list in a directory, or `null` when there is none.
 *
 * Chosen by FILE NAME, which the writer derives from the document's own `generatedAtIso` — so the
 * ordering is chronological without opening a file. {@link readLaunchListDocument} then re-derives
 * the expected name from the envelope it read and refuses a mismatch, so a renamed or hand-edited
 * file is caught rather than trusted on the strength of its name.
 *
 * @param {string} dir
 * @returns {string | null}
 */
export function newestLaunchListPath(dir) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((n) => LAUNCH_LIST_FILE_PATTERN.test(n))
    .sort();
  const newest = names[names.length - 1];
  return newest === undefined ? null : join(dir, newest);
}

/**
 * Turn what the operator supplied into the file to read.
 *
 * A directory means "the newest list in here", which is how this lane discovers a handover it did
 * not produce; a file means that file. **Absence is a refusal with a sentence**, never a silently
 * empty walk: the message names the directory, says the screen is what fills it, and says this lane
 * may not fetch one itself.
 *
 * @param {string} target A file or a directory.
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function resolveLaunchListPath(target) {
  if (!existsSync(target)) {
    return {
      ok: false,
      reason:
        `there is no launch list at ${target}. This lane cannot fetch one — it is keyless by ` +
        `construction — so the list comes from a deployer-screen run over the wallets you want: ` +
        `node tools/deployer-screen/screen.mjs --wallets <file> --no-stage2, which writes into ` +
        `<data root>/${SCREEN_LAUNCH_LIST_DIRNAME}/ as a by-product of the enumeration it was ` +
        `already going to do.`,
    };
  }
  if (!statSync(target).isDirectory()) return { ok: true, path: target };
  const newest = newestLaunchListPath(target);
  if (newest === null) {
    return {
      ok: false,
      reason:
        `${target} holds no launch list. A deployer-screen run writes one there as a by-product of ` +
        `its Dune enumeration leg; until one has run over the wallets you want, there is nothing ` +
        `here to walk and this lane may not go and get it.`,
    };
  }
  return { ok: true, path: newest };
}

/**
 * Read and validate a launch-list document.
 *
 * **Every refusal below is the screen's own refusal or this file's own integrity, never a judgement
 * about a deployer.** A reading that cannot vouch for itself is refused rather than walked, which is
 * the same rule `dune.mjs` applies one lane over and the same rule `assessCohortCoverage` applies to
 * a cohort here.
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.path      Where it came from, for the messages and the name check.
 * @param {number} opts.nowMs     The reading clock.
 * @param {number} opts.maxAgeMs  REQUIRED. See {@link LAUNCH_LIST_STALENESS_RULE} for why there is
 *   no default: a default is a pin, and no measurement here supports one.
 * @returns {LaunchListRead}
 */
export function readLaunchListDocument(text, { path, nowMs, maxAgeMs }) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error(
      'readLaunchListDocument needs a positive maxAgeMs: a launch list is an observation with a ' +
        'ceiling and this reader will not choose the bound for you. ' +
        LAUNCH_LIST_STALENESS_RULE,
    );
  }

  /** @type {string[]} */
  const refusals = [];
  /** @type {string[]} */
  const advisories = [];

  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${path} is not readable JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const doc = /** @type {Record<string, unknown>} */ (
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}
  );

  if (doc['kind'] !== LAUNCH_LIST_KIND) {
    throw new Error(
      `${path} is not a ${LAUNCH_LIST_KIND} document (kind: ${JSON.stringify(doc['kind'])}). A raw ` +
        `Dune export goes through readLaunchList instead; this reader exists so a document carrying ` +
        `a staleness ceiling cannot be read as one that does not.`,
    );
  }
  if (doc['schemaVersion'] !== LAUNCH_LIST_SCHEMA_VERSION) {
    throw new Error(
      `${path} declares launch-list schema ${JSON.stringify(doc['schemaVersion'])} and this reader ` +
        `understands ${LAUNCH_LIST_SCHEMA_VERSION}. A version it cannot read is refused rather than ` +
        `read as far as the fields happen to line up.`,
    );
  }
  if (typeof doc['contract'] !== 'string' || doc['contract'].length === 0) {
    throw new Error(
      `${path} carries no contract text. Every document the screen writes embeds one, so a file ` +
        `without it was not written by that path and this reader will not guess at its shape.`,
    );
  }

  const generatedAtIso = doc['generatedAtIso'];
  const generatedAtMs = typeof generatedAtIso === 'string' ? Date.parse(generatedAtIso) : Number.NaN;
  if (typeof generatedAtIso !== 'string' || !Number.isFinite(generatedAtMs)) {
    throw new Error(
      `${path} has no readable generatedAtIso, so it states no observation ceiling. ` +
        LAUNCH_LIST_STALENESS_RULE,
    );
  }

  // The name is derived from the instant, so this catches a renamed or hand-edited file — which
  // matters because `newestLaunchListPath` picks by name and would otherwise trust it.
  const expectedName = `${generatedAtIso.replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')}.json`;
  const actualName = path.slice(path.lastIndexOf('/') + 1);
  if (LAUNCH_LIST_FILE_PATTERN.test(actualName) && actualName !== expectedName) {
    throw new Error(
      `${path} is named for a different instant than it declares (${actualName} against ` +
        `${expectedName} for ${generatedAtIso}). The newest list is chosen BY NAME, so a name that ` +
        `does not match its contents would decide which observation this lane walked.`,
    );
  }

  const ageMs = nowMs - generatedAtMs;
  if (ageMs < 0) {
    refusals.push(
      `the launch list at ${path} declares it was generated at ${generatedAtIso}, which is AFTER ` +
        `this reading (${new Date(nowMs).toISOString()}). The two clocks disagree, so the ` +
        `observation ceiling cannot be used and the age cannot be computed. Refused rather than ` +
        `reported as a negative age.`,
    );
  } else if (ageMs > maxAgeMs) {
    refusals.push(
      `the launch list at ${path} is ${(ageMs / 86_400_000).toFixed(2)} days old (generated ` +
        `${generatedAtIso}), past the ${(maxAgeMs / 86_400_000).toFixed(2)} days this run stated. ` +
        `${LAUNCH_LIST_STALENESS_RULE}`,
    );
  }

  const enumeration = /** @type {Record<string, unknown>} */ (
    typeof doc['enumeration'] === 'object' && doc['enumeration'] !== null ? doc['enumeration'] : {}
  );
  const legFailure = enumeration['legFailure'];
  if (typeof legFailure === 'string' && legFailure.length > 0) {
    refusals.push(
      `the run that wrote ${path} could not complete its creation enumeration, so the list holds ` +
        `nothing it can vouch for: ${legFailure}`,
    );
  }
  const unreadableRows = enumeration['unreadableRows'];
  if (typeof unreadableRows !== 'number') {
    refusals.push(
      `${path} does not say how many rows its own enumeration could not read, so nothing bounds ` +
        `what is missing from it.`,
    );
  } else if (unreadableRows > 0) {
    refusals.push(
      `${unreadableRows} row(s) of the enumeration behind ${path} could not be read, so the screen ` +
        `refused that whole batch. A row that fails to parse commonly has no readable deployer, ` +
        `which is why the blast radius is the batch and not one wallet.`,
    );
  }
  const coverage = enumeration['coverage'];
  if (typeof coverage !== 'object' || coverage === null) {
    refusals.push(
      `${path} carries no coverage assessment for the surfaces it was read from. Decoded tables ` +
        `have silent start dates, so a count over unprobed surfaces is a confident answer that is ` +
        `simply wrong before their first row.`,
    );
  } else if (/** @type {Record<string, unknown>} */ (coverage)['ok'] !== true) {
    const reasons = /** @type {Record<string, unknown>} */ (coverage)['reasons'];
    refusals.push(
      `the coverage probe behind ${path} REFUSED the creation surfaces` +
        (Array.isArray(reasons) && reasons.length > 0 ? `: ${reasons.map(String).join(' ')}` : '.'),
    );
  }

  const rawRows = doc[LAUNCH_LIST_ROWS_KEY];
  if (!Array.isArray(rawRows)) {
    throw new Error(`${path} holds no ${LAUNCH_LIST_ROWS_KEY} array, so there is nothing to walk.`);
  }

  /** @type {{ wallet: string, reasons: string[] }[]} */
  const unusableDeployers = [];
  const rawDeployers = doc['deployers'];
  if (!Array.isArray(rawDeployers)) {
    refusals.push(
      `${path} carries no deployers block, so this lane cannot tell a wallet that was asked about ` +
        `and returned nothing from a wallet that was never in the batch. Those are opposite ` +
        `findings and reading the first as "created nothing" is the invisible false rejection.`,
    );
  } else {
    // **AN ENTRY THIS READER CANNOT READ IS A REFUSAL, NEVER A SKIP.** The deployers block is the
    // only thing that says which wallets were asked about and which of them the screen would gate
    // on, so an entry that carries no readable wallet removes a wallet from BOTH answers at once:
    // its rows would then be walked with nothing vouching for them, and its absence from
    // `unusableDeployers` would read as "the screen vouched for it". Same direction as the
    // writer-side rule that one unreadable row refuses the whole batch.
    let unreadableDeployerEntries = 0;
    /** @type {Set<string>} */
    const declaredWallets = new Set();
    for (const raw of rawDeployers) {
      if (typeof raw !== 'object' || raw === null) {
        unreadableDeployerEntries += 1;
        continue;
      }
      const row = /** @type {Record<string, unknown>} */ (raw);
      const wallet = row['wallet'];
      if (typeof wallet !== 'string' || wallet === '') {
        unreadableDeployerEntries += 1;
        continue;
      }
      declaredWallets.add(wallet);
      if (row['usable'] === true) continue;
      const reasons = Array.isArray(row['reasons']) ? row['reasons'].map(String) : [];
      unusableDeployers.push({ wallet, reasons });
    }
    if (unreadableDeployerEntries > 0) {
      refusals.push(
        `${unreadableDeployerEntries} of the ${rawDeployers.length} entries in the deployers block ` +
          `of ${path} could not be read as a wallet with a status. That block is what says which ` +
          `wallets were asked about and which of them the screen would gate on, so an entry it ` +
          `cannot read leaves rows in this file that nothing vouches for — and leaves them looking ` +
          `vouched for. Refused rather than skipped.`,
      );
    }
    // The other half of the same rule, from the other side: a wallet whose ROWS are here but whose
    // status is not. Walking it would be an arrival rate over a history no run claimed was whole,
    // which is exactly what `unusableDeployers` exists to stop where the status IS present.
    /** @type {Set<string>} */
    const undeclared = new Set();
    for (const raw of rawRows) {
      if (typeof raw !== 'object' || raw === null) continue;
      const deployer = /** @type {Record<string, unknown>} */ (raw)['deployer'];
      if (typeof deployer !== 'string' || deployer === '') continue;
      if (!declaredWallets.has(deployer)) undeclared.add(deployer);
    }
    if (undeclared.size > 0) {
      refusals.push(
        `${undeclared.size} wallet(s) have rows in ${path} but no entry in its deployers block ` +
          `(${[...undeclared].sort().slice(0, 5).join(', ')}${undeclared.size > 5 ? ', …' : ''}). ` +
          `Nothing in this file says whether the screen would gate on those histories, so walking ` +
          `them would measure an arrival rate over a reading nobody vouched for.`,
      );
    }
    if (unusableDeployers.length > 0) {
      // An ADVISORY here and a REFUSAL only where the plan wants the wallet: this document is one
      // screen run's batch, and a wallet in it that this lane's cohort never asked for is somebody
      // else's refusal. `walletsRefused` in the plan is where it becomes fatal.
      advisories.push(
        `${unusableDeployers.length} of the ${rawDeployers.length} deployer(s) in ${path} carry a ` +
          `reading the screen would not gate on. Their rows are present but nothing claims they are ` +
          `whole, so any of them this run means to walk refuses the plan.`,
      );
    }
  }

  const walletsAsked = typeof enumeration['walletsAsked'] === 'number' ? enumeration['walletsAsked'] : 0;
  const walletsUsable = typeof enumeration['walletsUsable'] === 'number' ? enumeration['walletsUsable'] : 0;
  const rowsReturned = typeof enumeration['rowsReturned'] === 'number' ? enumeration['rowsReturned'] : 0;
  const producedBy = /** @type {Record<string, unknown>} */ (
    typeof doc['producedBy'] === 'object' && doc['producedBy'] !== null ? doc['producedBy'] : {}
  );

  return {
    rows: rawRows,
    provenance: {
      path,
      generatedAtIso,
      generatedAtMs,
      ageMs: Math.max(0, ageMs),
      ageDays: Math.max(0, ageMs) / 86_400_000,
      maxAgeDays: maxAgeMs / 86_400_000,
      producedBy: `${String(producedBy['tool'] ?? 'unknown')} — ${String(producedBy['path'] ?? 'unknown')}`,
      candidateSource: String(producedBy['candidateSource'] ?? 'unknown'),
      walletsAsked,
      walletsUsable,
      rowsReturned,
      stalenessRule: LAUNCH_LIST_STALENESS_RULE,
      refusals,
      advisories,
      unusableDeployers,
    },
  };
}

/**
 * Whether a file's text is one of these documents at all.
 *
 * Used by `collect.mjs` to route `--launch-list` to the right reader. It keys on the marker rather
 * than on the file name, so a document copied anywhere still gets the staleness rule applied to it —
 * the failure this guards against is a by-product read as a raw export, which would walk a ceiling'd
 * observation while reporting nothing about its age.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isLaunchListDocument(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const body = JSON.parse(trimmed);
    return typeof body === 'object' && body !== null && /** @type {Record<string, unknown>} */ (body)['kind'] === LAUNCH_LIST_KIND;
  } catch {
    return false;
  }
}
