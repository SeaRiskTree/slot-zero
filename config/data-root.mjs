/**
 * **The one owner of where this repository's measurement data lives.**
 *
 * Every consumer — `src/`, `analysis/`, `tools/` and `test/` — asks this module for a dataset
 * directory instead of composing one from its own relative path. Before this file existed the
 * answer was written out in eight source files, three tools and five test suites as
 * `new URL('../../data/population-tape-2026-07-29/', import.meta.url)` or the `join()` spelling of
 * the same thing, which meant the data could only ever live inside the repository. The captain has
 * decided it no longer does: the tapes are 118 MB and 705 of the tree's 833 tracked files, and they
 * are moving out.
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
 * ## The default, and why it is the in-repository copy
 *
 * {@link DEFAULT_DATA_ROOT} is {@link IN_REPO_DATA_ROOT}. Both defaults were defensible and the
 * choice is deliberate:
 *
 * - Defaulting to the off-repo store would make the tracked copies dead on the day this landed and
 *   would make the untracking phase a pure deletion — but it would break CI *immediately*, because
 *   CI is `actions/checkout` and nothing else (`.github/workflows/ci.yml`), so the only data a CI
 *   runner has is the data in the tree. A change whose job is to be provably neutral must not take
 *   the build red on the way.
 * - It would also make the default configuration machine-specific: a path under someone's `$HOME`
 *   is not reproducible, and this dataset's whole value rests on being reproducible offline.
 *
 * So the default keeps working exactly as it did, and the off-repo store is one variable away. The
 * untracking phase changes this file in ONE place — `DEFAULT_DATA_ROOT` stops being
 * `IN_REPO_DATA_ROOT` — beside deleting the files and telling CI where the data went. Nothing else
 * in the tree has to move, which is the property this phase exists to buy.
 *
 * ## Using it
 *
 * ```bash
 * # read the tapes from outside the repository
 * export SLOT_ZERO_DATA_ROOT=~/slot-zero-data
 * npm test
 * ```
 *
 * The root is a directory holding the datasets by name, so
 * `$SLOT_ZERO_DATA_ROOT/population-tape-2026-07-29/launches.csv` and the in-repo
 * `data/population-tape-2026-07-29/launches.csv` are the same file in the two configurations. It is
 * read once per process, at import: these tools are stateless and short-lived, and a root that
 * could change under a running measurement is a worse thing than one that cannot.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * The data root inside this repository: the `data/` directory, one level up from here.
 *
 * This is the default (see the module note). It is derived from this file's own URL rather than
 * from `process.cwd()`, so a tool invoked from any directory reads the same tapes.
 */
export const IN_REPO_DATA_ROOT = fileURLToPath(new URL('../data', import.meta.url));

/**
 * Where the captain's copy of the data lives, as a suggestion for a human reading an error.
 *
 * It is a HINT and never a fallback: nothing here reads this path unless
 * {@link DATA_ROOT_ENV_VAR} names it. A resolver that quietly tried a second location would make
 * "which copy did this measurement read" unanswerable from the output, which is the failure this
 * repo files under *a confident, well-formed, complete-looking answer that is simply wrong*.
 */
export const OFF_REPO_DATA_ROOT_HINT = '~/slot-zero-data';

/** The population tape's directory name inside the root. Its identity, not its location. */
export const POPULATION_TAPE = 'population-tape-2026-07-29';

/** The graduated-life tape's directory name inside the root. Its identity, not its location. */
export const GRADUATED_LIFE_TAPE = 'graduated-life-tape-2026-08-02';

/** Every dataset the root is expected to hold. */
export const DATASETS = Object.freeze([POPULATION_TAPE, GRADUATED_LIFE_TAPE]);

/**
 * The default root when {@link DATA_ROOT_ENV_VAR} is unset. See the module note for why it is the
 * in-repository copy and what the untracking phase changes here.
 */
export const DEFAULT_DATA_ROOT = IN_REPO_DATA_ROOT;

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
        `  or point it at the store:\n` +
        `      export ${DATA_ROOT_ENV_VAR}=${OFF_REPO_DATA_ROOT_HINT}`,
    );
  }

  const expanded =
    trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/')
        ? join(homedir(), trimmed.slice(2))
        : trimmed;

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
 * The data is not part of a fresh clone, so this message is the first thing a new contributor and a
 * fresh CI runner will see. It therefore names three things and not one: WHAT is missing, WHERE it
 * was looked for, and HOW to point the tool somewhere else. A raw `ENOENT` on a `.jsonl.gz` deep
 * inside `window/` says none of them.
 *
 * @param {string} dataset One of {@link DATASETS}.
 * @param {string} [dir] The directory that was looked in. Defaults to the one `env` resolves to,
 *   never to the ambient one — a message that names a directory the reported root does not point at
 *   is the confident, well-formed, wrong answer this repo keeps refusing.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function missingDatasetMessage(dataset, dir, env = process.env) {
  const looked = dir ?? datasetDir(dataset, env);
  const configured = env[DATA_ROOT_ENV_VAR] !== undefined;
  const where = configured
    ? `${DATA_ROOT_ENV_VAR} is set, so the root is where that variable points.`
    : `${DATA_ROOT_ENV_VAR} is not set, so the root defaulted to ${DEFAULT_DATA_ROOT}.`;
  return (
    `the ${dataset} dataset is not at ${looked}\n` +
    `  ${where}\n` +
    `  This repository's measurement data is not part of a fresh clone. Point the tools at the\n` +
    `  store, which holds each dataset under its own name:\n` +
    `      export ${DATA_ROOT_ENV_VAR}=${OFF_REPO_DATA_ROOT_HINT}\n` +
    `  and check that ${join(OFF_REPO_DATA_ROOT_HINT, dataset)} exists. See README.md, "Where the data lives".`
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
 *   one. Checked and reported the same way, so an operator who points a tool at the wrong directory
 *   gets the same sentence as one who has no data.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} The directory that was checked, so this can wrap an assignment.
 */
export function requireDataset(dataset, dir, env = process.env) {
  const target = dir ?? datasetDir(dataset, env);
  if (!existsSync(target)) throw new Error(missingDatasetMessage(dataset, target, env));
  return target;
}
