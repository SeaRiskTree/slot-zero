/**
 * **The one owner of where this repository's measurement data lives.**
 *
 * Every consumer — `src/`, `analysis/`, `tools/` and `test/` — asks this module for a dataset
 * directory instead of composing one from its own relative path. Before this file existed the
 * answer was written out in eight source files, three tools and five test suites as
 * `new URL('../../data/population-tape-2026-07-29/', import.meta.url)` or the `join()` spelling of
 * the same thing, which meant the data could only ever live inside the repository. **It no longer
 * does.** Dry dock phase C untracked all 705 tape files, and the reason is repository hygiene and
 * nothing else: they were 118 MB and 705 of the tree's 833 tracked files, so every clone paid for
 * them. They are in this repository's public commit history and untracking cannot un-publish them;
 * no confidentiality is claimed by the move and none is bought by it.
 *
 * ## Why this is a fourth area, and not a module in `src/`
 *
 * `src/` and `analysis/` are held to `test/offline-guard.ts` → `CREDENTIAL_PATTERNS`, which bans the
 * literal `process.env` outright — the guard that makes "this repo reads no credential" structural
 * rather than a promise. A configurable data root has to read one environment variable, so it
 * cannot live in either area without weakening a load-bearing guard for a reason that has nothing
 * to do with credentials. `tools/` is out for a different reason: `src/`↔`tools/` and
 * `analysis/`↔`tools/` imports are both forbidden in both directions, so a resolver there could not
 * be the ONE owner — the other two areas would have to keep their own copies, which is the defect
 * this file removes.
 *
 * So `config/` is its own area, importable by all four, and it is governed like the others:
 * `test/data-root.test.ts` asserts it opens no socket, contains no key-shaped string, names no
 * credential variable and reads exactly one environment variable — {@link DATA_ROOT_ENV_VAR}.
 *
 * ## The default, and why it moved
 *
 * {@link DEFAULT_DATA_ROOT} is {@link OFF_REPO_DATA_ROOT_HINT} — `~/slot-zero-data`, the store's
 * canonical name — and until phase C it was the `data/` directory of this repository. Phase B kept
 * it in-repo on two arguments, and phase C settled both:
 *
 * - **It would have taken CI red on the day it landed**, because CI was `actions/checkout` and
 *   nothing else, so the only data a runner had was the data in the tree. CI fetches the store now
 *   and sets {@link DATA_ROOT_ENV_VAR} itself (`.github/workflows/ci.yml`), so this default is not
 *   what a CI run reads at all.
 * - **A path under someone's `$HOME` is not reproducible.** That is still true, and it is now the
 *   better of two unreproducible defaults rather than the worse of one: the in-repo path stopped
 *   naming anything a clone has. What the choice buys is that a contributor who unpacks the release
 *   asset where the whole tree already tells them to has a working `npm test` with no configuration
 *   at all — and, on a machine where phase C left an untracked `data/` behind, that runs are read
 *   from the store git can vouch for rather than from a stale copy nothing checks.
 *
 * Neither default resolves in a bare clone, and that is honest rather than unfortunate: the data is
 * genuinely not there, and {@link missingDatasetMessage} is what turns that into a sentence a
 * reader can act on.
 *
 * ## Using it
 *
 * ```bash
 * # the default: unpack the release asset where the store lives
 * mkdir -p ~/slot-zero-data
 * tar -xzf slot-zero-data.tar.gz -C ~/slot-zero-data --strip-components=1
 * npm test
 *
 * # or keep it anywhere else
 * export SLOT_ZERO_DATA_ROOT=/srv/tapes
 * npm test
 * ```
 *
 * The root is a directory holding the datasets by name, so
 * `$SLOT_ZERO_DATA_ROOT/population-tape-2026-07-29/launches.csv` is the same file whichever root is
 * in use. It is read once per process, at import: these tools are stateless and short-lived, and a
 * root that could change under a running measurement is a worse thing than one that cannot.
 *
 * `README.md` → "Where the data lives" owns the operator's half — fetching the store, verifying it,
 * and how CI gets it.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * The one environment variable this module reads, and the only one anything in `config/` may name.
 *
 * Spelled in the project's existing idiom — a screaming-snake name prefixed with the thing it
 * configures, like the three vendor-key variables `tools/deployer-screen/credential.mjs` owns.
 * Unlike those it is **not** a credential: it holds a filesystem path, it is printed freely in
 * error messages, and it is safe in a shell history. It is also not spelled out here for a reason —
 * `test/data-root.test.ts` asserts this area names no credential variable at all, so the ban on a
 * key arriving through the door the data root opened is structural rather than a habit.
 */
export const DATA_ROOT_ENV_VAR = 'SLOT_ZERO_DATA_ROOT';

/**
 * Where the data store lives when nobody says otherwise: the DEFAULT, and the path every message
 * this module writes suggests.
 *
 * It is written with a tilde because that is how it is spoken about everywhere in this tree and in
 * the release asset's own instructions; {@link DEFAULT_DATA_ROOT} is this same path expanded, so
 * the two cannot drift apart.
 *
 * There is still no second location and no fallback chain. If the root this resolves to holds
 * nothing, that is reported (see {@link missingDatasetMessage}) rather than quietly retried
 * somewhere else — a resolver that tried a second place would make "which copy did this measurement
 * read" unanswerable from the output, which is the failure this repo files under *a confident,
 * well-formed, complete-looking answer that is simply wrong*.
 */
export const OFF_REPO_DATA_ROOT_HINT = '~/slot-zero-data';

/** The population tape's directory name inside the root. Its identity, not its location. */
export const POPULATION_TAPE = 'population-tape-2026-07-29';

/** The graduated-life tape's directory name inside the root. Its identity, not its location. */
export const GRADUATED_LIFE_TAPE = 'graduated-life-tape-2026-08-02';

/** Every dataset the root is expected to hold. */
export const DATASETS = Object.freeze([POPULATION_TAPE, GRADUATED_LIFE_TAPE]);

/**
 * Expand a leading `~/` (or a bare `~`) against this account's home directory.
 *
 * Only that form. `~other` is somebody else's home in shell syntax and a literal directory name
 * here, which this has no business reimplementing.
 *
 * @param {string} path
 * @returns {string}
 */
function expandTilde(path) {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * The default root when {@link DATA_ROOT_ENV_VAR} is unset: the store at
 * {@link OFF_REPO_DATA_ROOT_HINT}, expanded.
 *
 * It is DERIVED from the hint rather than written out again, so the path this resolves to and the
 * path every error message tells a reader to use are the same path by construction. See the module
 * note for why the default is no longer the copy in this repository — in one line, phase C untracked
 * that copy, so it named a directory a clone does not have.
 */
export const DEFAULT_DATA_ROOT = expandTilde(OFF_REPO_DATA_ROOT_HINT);

/**
 * Resolve the data root from an environment-like object.
 *
 * Takes the environment as a parameter, like `credential.mjs` → `resolveKey`, so the whole module
 * is testable without mutating the real environment.
 *
 * Three behaviours worth knowing:
 *
 * - **A set-but-empty value REFUSES rather than falling back.** `FOO=$BAR` with `BAR` unset is the
 *   classic way this variable ends up blank, and an operator who set it meant to point somewhere.
 *   Silently reading the default would give them a measurement from the copy they were trying not
 *   to read, and nothing in the output would say so.
 * - **A leading `~/` is expanded**, because the store's own name is `~/slot-zero-data` and a quoted
 *   `export SLOT_ZERO_DATA_ROOT="~/slot-zero-data"` reaches us with the tilde intact. Only a
 *   leading `~/` (or a bare `~`); no `~user` form, which is shell syntax this has no business
 *   reimplementing.
 * - **A relative value is resolved against the working directory**, so every path this module hands
 *   out is absolute and every error message names a path the reader can paste into `ls`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} An absolute directory path. It is NOT checked for existence — see
 *   {@link requireDataset}, which is where a missing dataset is reported.
 */
export function resolveDataRoot(env = process.env) {
  const raw = env[DATA_ROOT_ENV_VAR];
  if (raw === undefined) return DEFAULT_DATA_ROOT;

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `${DATA_ROOT_ENV_VAR} is set but empty (length ${raw.length}), so this run has no data root.\n` +
        `  It was probably assigned from an unset variable. Unset it to read the default root\n` +
        `      ${DEFAULT_DATA_ROOT}\n` +
        `  or point it at the copy you meant:\n` +
        `      export ${DATA_ROOT_ENV_VAR}=/somewhere/else`,
    );
  }

  const expanded = expandTilde(trimmed);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * The absolute directory of one dataset inside the resolved root.
 *
 * @param {string} dataset One of {@link DATASETS}.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function datasetDir(dataset, env = process.env) {
  if (!DATASETS.includes(dataset)) {
    throw new Error(`unknown dataset '${dataset}': this root holds ${DATASETS.join(' and ')}`);
  }
  return join(resolveDataRoot(env), dataset);
}

/** The population tape's directory, wherever the root points. */
export const POPULATION_TAPE_DIR = datasetDir(POPULATION_TAPE);

/** The graduated-life tape's directory, wherever the root points. */
export const GRADUATED_LIFE_TAPE_DIR = datasetDir(GRADUATED_LIFE_TAPE);

/**
 * What to tell a human when a dataset is not where the root says it is.
 *
 * The data is not part of a clone, so this message is the first thing a new contributor and a fresh
 * CI runner will see. It therefore names three things and not one: WHAT is missing, WHERE it was
 * looked for, and HOW to fix it. A raw `ENOENT` on a `.jsonl.gz` deep inside `window/` says none of
 * them.
 *
 * The sentence explaining WHERE has to be about the path that was actually looked in. A directory
 * handed in — a `--data-dir` flag, `Tape.load({ dataDir })` — was not decided by the root at all,
 * and explaining it by the root anyway is the confident, well-formed, wrong answer this repo keeps
 * refusing: it sends an operator who mistyped a flag to go and check an environment variable.
 *
 * And HOW is two halves since phase C, because the likeliest cause changed with the default. The
 * first is FETCH THE STORE — the data left the tree and the reader may simply not have it — and only
 * the second is point the variable somewhere else. Offering only the second would tell somebody who
 * has no copy at all to go and name the one they have not got, and where the default is
 * {@link OFF_REPO_DATA_ROOT_HINT} that advice is circular on top of being wrong.
 *
 * @param {string} dataset One of {@link DATASETS}.
 * @param {string} [dir] The directory that was looked in. Defaults to the one `env` resolves to,
 *   never to the ambient one.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function missingDatasetMessage(dataset, dir, env = process.env) {
  const resolved = DATASETS.includes(dataset) ? datasetDir(dataset, env) : undefined;
  const looked = dir ?? datasetDir(dataset, env);
  const configured = env[DATA_ROOT_ENV_VAR] !== undefined;
  const where =
    dir !== undefined && dir !== resolved
      ? `That directory was supplied directly, so no data root was consulted and ${DATA_ROOT_ENV_VAR} did not choose it.`
      : configured
        ? `${DATA_ROOT_ENV_VAR} is set, so the root is where that variable points.`
        : `${DATA_ROOT_ENV_VAR} is not set, so the root defaulted to ${DEFAULT_DATA_ROOT}.`;
  return (
    `the ${dataset} dataset is not at ${looked}\n` +
    `  ${where}\n` +
    `  This repository's measurement data is not part of a clone: the tapes are published as the\n` +
    `  slot-zero-data.tar.gz release asset, and a root holds each dataset under its own name.\n` +
    `  Unpack it at the default root, which needs no configuration at all:\n` +
    `      mkdir -p ${OFF_REPO_DATA_ROOT_HINT} && tar -xzf slot-zero-data.tar.gz -C ${OFF_REPO_DATA_ROOT_HINT} --strip-components=1\n` +
    `  or, if you keep it elsewhere, point this run at that copy:\n` +
    `      export ${DATA_ROOT_ENV_VAR}=/somewhere/else\n` +
    `  Either way, check that <root>/${dataset} exists. See README.md, "Where the data lives".`
  );
}

/**
 * The absolute directory of one dataset, checked for existence.
 *
 * Call this at the point a reader is about to open its FIRST file, not on every read: the check is
 * a `stat` and the message is for a human who has not got the data at all.
 *
 * @param {string} dataset One of {@link DATASETS}.
 * @param {string} [dir] An explicit directory — a `--data-dir` flag, say — instead of the resolved
 *   one. Checked the same way, and reported as what it is: {@link missingDatasetMessage} is told
 *   whether the path was handed in or resolved, so the sentence it prints is true of the path it
 *   names.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} The directory that was checked, so this can wrap an assignment.
 */
export function requireDataset(dataset, dir, env = process.env) {
  const target = dir ?? datasetDir(dataset, env);
  if (!existsSync(target)) throw new Error(missingDatasetMessage(dataset, dir, env));
  return target;
}
