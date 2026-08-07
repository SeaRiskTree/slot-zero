#!/usr/bin/env node
/**
 * **Verify that a fetched data root is the data root it claims to be.**
 *
 * Captain decision 354a: CI fetches the measurement tapes from a private store rather than getting
 * them from the clone, so between the store and the suites there is now a transfer that can go
 * wrong — and the way it goes wrong is the dangerous shape. A download that dies half way leaves a
 * root that EXISTS, holds most of its files, and reads as data. Several suites enumerate
 * `window/` and `life/` with `readdirSync`, so a short fetch does not raise `ENOENT`; it silently
 * changes the population every published number is computed over. That is the same failure this
 * repo files under *a confident, well-formed, complete-looking answer that is simply wrong*.
 *
 * So the transfer is checked, not trusted. The store carries `MANIFEST.sha256` — written by dry
 * dock phase A, `sha256sum -c` compatible, 705 entries, excluding the three manifest files
 * themselves — and this walks it.
 *
 * ```bash
 * node config/verify-data-root.mjs                 # the root config/data-root.mjs resolves
 * node config/verify-data-root.mjs --root /tmp/x   # an explicit one
 * ```
 *
 * Three failure modes, all of them exit 1 with the paths named:
 *
 * - **Missing** — a manifest entry with no file. The ordinary shape of a truncated fetch.
 * - **Corrupt** — a file whose digest disagrees. The shape of a truncated *file*, which is what a
 *   dropped connection leaves behind at the tail of an archive.
 * - **Unexpected** — a file under a dataset directory that the manifest does not list. Benign in a
 *   tree that is only ever read by name; **not** benign here, because `readdirSync` over `window/`
 *   and `life/` is how several measurements choose their population, so an extra tape is an extra
 *   launch in a published figure.
 *
 * **A missing manifest — or one that lists nothing — is itself a failure, and deliberately so.** It
 * cannot be waved through as
 * "nothing to check": a root with no manifest is a root whose provenance is unknown, and the whole
 * point of the check is that CI stopped getting its data from a place git could vouch for. The
 * in-repo copy needs no manifest because git is its manifest — every byte is content-addressed in
 * the commit the runner checked out — which is why CI only runs this in the fetching mode.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATASETS, DATA_ROOT_ENV_VAR, resolveDataRoot } from './data-root.mjs';

/** The manifest phase A wrote, at the root of the store. */
export const MANIFEST_FILE = 'MANIFEST.sha256';

/** How many offending paths a report names before it says "and N more". */
const NAMED_LIMIT = 10;

/**
 * Parse a `sha256sum` manifest.
 *
 * Format is the coreutils one: 64 hex characters, two spaces, then a path relative to the manifest's
 * own directory. A line this cannot read is an ERROR rather than a skip — a manifest half of which
 * silently does not apply is worse than no manifest, since it reports a pass over whatever it
 * happened to understand.
 *
 * @param {string} text
 * @returns {{ digest: string, path: string }[]}
 */
export function parseManifest(text) {
  /** @type {{ digest: string, path: string }[]} */
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = /** @type {string} */ (lines[i]);
    if (line.trim() === '') continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (m === null) throw new Error(`${MANIFEST_FILE} line ${i + 1} is not a sha256sum entry: ${line.slice(0, 80)}`);
    out.push({ digest: /** @type {string} */ (m[1]), path: /** @type {string} */ (m[2]).replace(/^\.\//, '') });
  }
  return out;
}

/**
 * Every file under a directory, as paths relative to `root`, with `/` separators.
 *
 * @param {string} root
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(root, dir) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (/** @type {string} */ d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

/**
 * @typedef {object} VerifyResult
 * @property {string} root      The directory checked.
 * @property {boolean} ok       Whether every check passed.
 * @property {number} checked   Manifest entries walked.
 * @property {string[]} missing Entries with no file.
 * @property {string[]} corrupt Entries whose digest disagreed.
 * @property {string[]} unexpected Files under a dataset directory the manifest does not list.
 */

/**
 * Check a data root against the manifest it carries.
 *
 * @param {string} root
 * @returns {VerifyResult}
 */
export function verifyDataRoot(root) {
  const manifestPath = join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${root} carries no ${MANIFEST_FILE}, so nothing here can vouch for what it holds.\n` +
        `  A FETCHED store must ship its manifest — dry dock phase A wrote one beside the tapes.\n` +
        `  The copy inside this repository deliberately has none: git is its manifest, every byte\n` +
        `  content-addressed in the commit that was checked out, so it is not verified this way.\n` +
        `  If you meant to check the in-repo copy, there is nothing to check.`,
    );
  }

  const entries = parseManifest(readFileSync(manifestPath, 'utf8'));
  if (entries.length === 0) {
    throw new Error(
      `${manifestPath} lists nothing, so it vouches for nothing.\n` +
        `  An empty manifest is the same condition as no manifest at all, dressed as a pass: every\n` +
        `  check below would walk zero entries and report a whole store. It is the shape a failed\n` +
        `  phase-A regeneration leaves behind, and CI would print a green line over a root with no\n` +
        `  tapes in it. Re-write the manifest beside the tapes, or re-fetch the store.`,
    );
  }
  /** @type {string[]} */ const missing = [];
  /** @type {string[]} */ const corrupt = [];
  const listed = new Set(entries.map((e) => e.path));

  for (const entry of entries) {
    const full = join(root, entry.path);
    if (!existsSync(full)) {
      missing.push(entry.path);
      continue;
    }
    const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
    if (digest !== entry.digest) corrupt.push(entry.path);
  }

  // Only the dataset directories are swept. The root itself legitimately holds the manifest files
  // and whatever else the store keeps beside them; an extra file THERE cannot reach a measurement.
  /** @type {string[]} */ const unexpected = [];
  for (const dataset of DATASETS) {
    for (const path of filesUnder(root, join(root, dataset))) {
      if (!listed.has(path)) unexpected.push(path);
    }
  }

  return {
    root,
    ok: missing.length === 0 && corrupt.length === 0 && unexpected.length === 0,
    checked: entries.length,
    missing,
    corrupt,
    unexpected,
  };
}

/**
 * The report a human or a CI log reads. Names the paths rather than only counting them, because
 * "17 files are wrong" sends someone hunting and "these 10 of 17, all under `life/`" does not.
 *
 * @param {VerifyResult} result
 * @returns {string}
 */
export function describeVerifyResult(result) {
  if (result.ok) {
    return `data root verified: ${result.checked} files at ${result.root}, every digest matched.`;
  }
  const lines = [`DATA ROOT FAILED VERIFICATION at ${result.root} (${result.checked} manifest entries).`];
  /** @param {string} label @param {string[]} paths @param {string} why */
  const section = (label, paths, why) => {
    if (paths.length === 0) return;
    lines.push(`  ${label}: ${paths.length} — ${why}`);
    for (const p of paths.slice(0, NAMED_LIMIT)) lines.push(`    ${p}`);
    if (paths.length > NAMED_LIMIT) lines.push(`    ...and ${paths.length - NAMED_LIMIT} more`);
  };
  section('MISSING', result.missing, 'the fetch did not deliver these');
  section('CORRUPT', result.corrupt, 'delivered but the bytes disagree with the manifest');
  section(
    'UNEXPECTED',
    result.unexpected,
    'not in the manifest; several measurements choose their population by reading these directories',
  );
  lines.push(
    `  This is a TRANSPORT failure, not a measurement one. Re-fetch the store; if it persists, the`,
    `  store itself no longer matches the manifest it ships and that is a captain matter.`,
    `  ${DATA_ROOT_ENV_VAR} selects the root that was checked.`,
  );
  return lines.join('\n');
}

/* c8 ignore start -- the CLI shell. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const i = process.argv.indexOf('--root');
  const root = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && root === undefined) {
    process.stderr.write('usage: verify-data-root.mjs [--root <dir>]\n');
    process.exit(2);
  }
  let result;
  try {
    result = verifyDataRoot(root ?? resolveDataRoot());
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${describeVerifyResult(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
/* c8 ignore stop */
