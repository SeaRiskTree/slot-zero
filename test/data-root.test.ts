/**
 * The one owner of where the measurement data lives, and the area it lives in.
 *
 * Two things are asserted here and they are different in kind.
 *
 * **The resolver behaves**, including the failure a new contributor and a fresh CI runner will
 * meet: the data is not part of a clone, so "it is not there" has to arrive as a sentence naming
 * what is missing, where it was looked for and how to point somewhere else. A raw `ENOENT` on a
 * `.jsonl.gz` five directories down says none of that.
 *
 * **And `config/` is governed like every other area of this tree.** `src/` and `analysis/` are held
 * to `test/offline-guard.ts` whole; `config/` is held to all of it EXCEPT the one expression that
 * reads an environment variable, which is the entire reason it is a separate area — and the
 * exception is narrowed to a single named variable rather than left open, so a credential cannot
 * arrive here by the door the data root opened.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DATASETS,
  DATA_ROOT_ENV_VAR,
  DEFAULT_DATA_ROOT,
  GRADUATED_LIFE_TAPE,
  GRADUATED_LIFE_TAPE_DIR,
  IN_REPO_DATA_ROOT,
  POPULATION_TAPE,
  POPULATION_TAPE_DIR,
  datasetDir,
  missingDatasetMessage,
  requireDataset,
  resolveDataRoot,
} from '../config/data-root.mjs';
import { describeVerifyResult, parseManifest, verifyDataRoot } from '../config/verify-data-root.mjs';
import { KEY_SHAPED, NETWORK_PATTERNS } from './offline-guard.js';

const CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Every file under `config/`, recursively — the same shape the other area guards use. */
function readConfig(pattern = /\.(ts|mjs|js)$/): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
      else if (pattern.test(entry)) out.set(`${prefix}${entry}`, readFileSync(full, 'utf8'));
    }
  };
  walk(CONFIG_DIR, 'config/');
  return out;
}

describe('the data root resolves', () => {
  it('defaults to the copy in this repository, so a clone works with no setup', () => {
    // The DELIBERATE half of the choice: the other default — the off-repo store — would have made
    // the untracking phase a pure deletion, and would have taken CI red on the day it landed,
    // because CI is `actions/checkout` and the only data a runner has is the data in the tree.
    expect(resolveDataRoot({})).toBe(IN_REPO_DATA_ROOT);
    expect(DEFAULT_DATA_ROOT).toBe(IN_REPO_DATA_ROOT);
    expect(IN_REPO_DATA_ROOT).toBe(join(REPO_ROOT, 'data'));
  });

  it('the OTHER configuration is reachable by the variable alone — no code change', () => {
    // The property phase B exists to buy, and the one a phase-C deletion is priced against.
    const root = resolveDataRoot({ [DATA_ROOT_ENV_VAR]: '/srv/tapes' });
    expect(root).toBe('/srv/tapes');
    expect(datasetDir(POPULATION_TAPE, { [DATA_ROOT_ENV_VAR]: '/srv/tapes' })).toBe(
      join('/srv/tapes', POPULATION_TAPE),
    );
    expect(datasetDir(GRADUATED_LIFE_TAPE, { [DATA_ROOT_ENV_VAR]: '/srv/tapes' })).toBe(
      join('/srv/tapes', GRADUATED_LIFE_TAPE),
    );
  });

  it('expands a leading tilde and resolves a relative value, so every path it hands out is absolute', () => {
    // `export SLOT_ZERO_DATA_ROOT="~/slot-zero-data"` — quoted — reaches us with the tilde intact,
    // and the store's own name is written that way in every message this module produces.
    expect(resolveDataRoot({ [DATA_ROOT_ENV_VAR]: '~/slot-zero-data' })).toBe(
      join(homedir(), 'slot-zero-data'),
    );
    expect(resolveDataRoot({ [DATA_ROOT_ENV_VAR]: '~' })).toBe(homedir());
    // Not shell syntax this has any business reimplementing: `~other` is a literal directory name.
    expect(resolveDataRoot({ [DATA_ROOT_ENV_VAR]: '/x/~other' })).toBe('/x/~other');
    expect(resolveDataRoot({ [DATA_ROOT_ENV_VAR]: 'relative/tapes' })).toBe(
      join(process.cwd(), 'relative', 'tapes'),
    );
  });

  it('REFUSES a set-but-empty value rather than quietly reading the default', () => {
    // `FOO=$BAR` with BAR unset is how this variable ends up blank, and an operator who set it
    // meant to point somewhere. Falling back would hand them a measurement from the copy they were
    // trying not to read, with nothing in the output saying so.
    for (const blank of ['', '   ', '\n']) {
      expect(() => resolveDataRoot({ [DATA_ROOT_ENV_VAR]: blank })).toThrow(/is set but empty/);
    }
    expect(() => resolveDataRoot({ [DATA_ROOT_ENV_VAR]: '' })).toThrow(DATA_ROOT_ENV_VAR);
  });

  it('refuses a dataset it does not own, rather than composing a path to nothing', () => {
    expect(DATASETS).toEqual([POPULATION_TAPE, GRADUATED_LIFE_TAPE]);
    expect(() => datasetDir('population-tape-2099-01-01')).toThrow(/unknown dataset/);
  });

  it('says what is missing, where it looked and how to point elsewhere', () => {
    const dir = join('/tmp', 'no-such-slot-zero-root', POPULATION_TAPE);
    const message = missingDatasetMessage(POPULATION_TAPE, dir, {
      [DATA_ROOT_ENV_VAR]: '/tmp/no-such-slot-zero-root',
    });
    expect(message).toContain(POPULATION_TAPE); // what
    expect(message).toContain(dir); // where
    expect(message).toContain(DATA_ROOT_ENV_VAR); // how
    expect(message).toContain('~/slot-zero-data');
    // And it distinguishes the two situations, because the fix is different: the variable is
    // pointed at the wrong place, or it is unset and the default is empty.
    expect(message).toMatch(/is set, so the root is where that variable points/);
    expect(missingDatasetMessage(POPULATION_TAPE, dir, {})).toMatch(/is not set, so the root defaulted/);
  });

  it('requireDataset throws that message, and returns the directory when it is there', () => {
    expect(() => requireDataset(POPULATION_TAPE, '/tmp/no-such-slot-zero-root/population-tape')).toThrow(
      new RegExp(DATA_ROOT_ENV_VAR),
    );
    // An explicit directory — a `--data-dir` flag, say — is checked and reported the same way, so
    // an operator who mistypes a path gets the same sentence as one who has no data at all.
    expect(requireDataset(POPULATION_TAPE, POPULATION_TAPE_DIR)).toBe(POPULATION_TAPE_DIR);
  });

  it('the exported directories are the resolved root joined with each dataset name', () => {
    expect(POPULATION_TAPE_DIR).toBe(datasetDir(POPULATION_TAPE));
    expect(GRADUATED_LIFE_TAPE_DIR).toBe(datasetDir(GRADUATED_LIFE_TAPE));
    // No trailing separator. Two readers used to build paths by concatenation and depended on one;
    // they use `join()` now, and this is what stops the dependency coming back.
    expect(POPULATION_TAPE_DIR.endsWith('/')).toBe(false);
    expect(GRADUATED_LIFE_TAPE_DIR.endsWith('/')).toBe(false);
    // And whatever the root is on this run, the data is actually there — the suite is meaningless
    // otherwise, and this is what turns a mispointed run into one clear failure.
    for (const dataset of DATASETS) expect(existsSync(datasetDir(dataset)), datasetDir(dataset)).toBe(true);
  });
});

describe('a fetched data root is verified, never trusted', () => {
  // Captain decision 354a moved CI's data from `checkout` to a fetch, which puts a transfer
  // between the store and the suites. The dangerous failure is the PARTIAL one: a root that
  // exists and holds most of its files reads as data, and several suites choose their population
  // by reading `window/` and `life/` with readdirSync, so a short fetch moves a published number
  // instead of raising ENOENT.
  const write = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'slot-zero-root-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  /** A minimal but STRUCTURALLY REAL store: a manifest plus the files it lists. */
  const store = (extra: Record<string, string> = {}) => {
    const a = `${POPULATION_TAPE}/launches.csv`;
    const b = `${GRADUATED_LIFE_TAPE}/coverage.csv`;
    return write({
      [a]: 'mint\nx\n',
      [b]: 'mint\ny\n',
      'MANIFEST.sha256': `${sha('mint\nx\n')}  ./${a}\n${sha('mint\ny\n')}  ./${b}\n`,
      ...extra,
    });
  };

  it('passes a whole store, and reports what it checked', () => {
    const result = verifyDataRoot(store());
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
    expect(describeVerifyResult(result)).toMatch(/verified: 2 files/);
  });

  it('REFUSES a root with no manifest rather than waving it through as nothing to check', () => {
    // "No manifest" is not "no problem": it is a root whose provenance is unknown, which is the
    // whole condition CI left behind when it stopped getting the data from a commit.
    const root = write({ [`${POPULATION_TAPE}/launches.csv`]: 'mint\nx\n' });
    expect(() => verifyDataRoot(root)).toThrow(/carries no MANIFEST\.sha256/);
    // And it says why the in-repo copy is exempt, so nobody "fixes" this by generating one.
    expect(() => verifyDataRoot(root)).toThrow(/git is its manifest/);
  });

  it('catches the truncated fetch, the truncated FILE, and the stale extra file', () => {
    const missing = store();
    rmSync(join(missing, POPULATION_TAPE, 'launches.csv'));
    expect(verifyDataRoot(missing).missing).toEqual([`${POPULATION_TAPE}/launches.csv`]);

    const corrupt = store();
    writeFileSync(join(corrupt, POPULATION_TAPE, 'launches.csv'), 'mint\n'); // tail lost
    expect(verifyDataRoot(corrupt).corrupt).toEqual([`${POPULATION_TAPE}/launches.csv`]);

    // The one a naive `sha256sum -c` misses entirely, and the one that matters most here: an
    // unlisted tape is an extra LAUNCH in every figure computed by enumerating that directory.
    const extra = store({ [`${POPULATION_TAPE}/window/ZZZstale.jsonl.gz`]: 'x' });
    expect(verifyDataRoot(extra).unexpected).toEqual([`${POPULATION_TAPE}/window/ZZZstale.jsonl.gz`]);

    for (const root of [missing, corrupt, extra]) {
      const result = verifyDataRoot(root);
      expect(result.ok, root).toBe(false);
      // A transport failure must not read as a measurement failure, or someone goes looking in
      // the wrong half of the system.
      expect(describeVerifyResult(result)).toMatch(/TRANSPORT failure/);
      expect(describeVerifyResult(result)).toContain(DATA_ROOT_ENV_VAR);
    }
  });

  it('refuses a manifest line it cannot read, rather than skipping it', () => {
    // A manifest half of which silently does not apply is worse than none: it reports a pass over
    // whatever it happened to understand.
    const root = store({ 'MANIFEST.sha256': 'not-a-digest  ./x\n' });
    expect(() => verifyDataRoot(root)).toThrow(/line 1 is not a sha256sum entry/);
    expect(parseManifest(`${'a'.repeat(64)}  ./p/q\n`)).toEqual([{ digest: 'a'.repeat(64), path: 'p/q' }]);
  });
});

describe('CI cannot go green without the tapes', () => {
  // Captain decision 354a, requirement 4: a failed or partial fetch must fail the build, and CI
  // must never skip the data-bound suites and report green. Twelve of the eighteen suites need
  // the data, so the property is real; these pin the workflow shape that keeps it.
  const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('runs the whole suite UNCONDITIONALLY — no data-free mode, no skip', () => {
    // The step that runs the tests carries no `if:`. A conditional here is how a CI quietly stops
    // exercising the measurement code while still printing a tick.
    const testStep = /\n {6}- run: npm test\n/.test(ci);
    expect(testStep, 'ci.yml must run `npm test` as a bare, unconditional step').toBe(true);
    expect(ci).not.toMatch(/npm test[\s\S]{0,200}?\n {8}if:/);
    // And no suite is excluded by name anywhere in the job.
    expect(ci).not.toMatch(/--exclude|\.skip\(|testNamePattern/);
  });

  it('validates the data source before anything depends on it, and fetch implies verify', () => {
    // An unrecognised variable value must FAIL rather than fall through to the in-repo copy: a
    // typo would otherwise read as a normal green build over something nobody chose.
    expect(ci).toMatch(/SLOT_ZERO_DATA_SOURCE is '\$SLOT_ZERO_DATA_SOURCE'/);
    expect(ci).toMatch(/repo\|release\)/);
    // The fetch and the verification are gated on the SAME condition, so a fetched root is never
    // reached by the suites without having been checked against its manifest.
    const guarded = [...ci.matchAll(/if: env\.SLOT_ZERO_DATA_SOURCE == '(\w+)'/g)].map((m) => m[1]);
    expect(guarded).toEqual(['release', 'release']);
    expect(ci).toContain('node config/verify-data-root.mjs');
    // `set -e` is what turns a failed download into a failed build rather than an empty directory.
    expect(ci).toMatch(/gh release download[\s\S]*?/);
    expect((ci.match(/set -euo pipefail/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('config/ is governed like the other areas', () => {
  it('scans every file, at every depth', () => {
    // A guard that silently scanned nothing would pass every assertion below.
    const files = readConfig();
    expect(files.size).toBeGreaterThanOrEqual(1);
    expect([...files.keys()]).toContain('config/data-root.mjs');
  });

  it('opens no socket and holds no key-shaped string', () => {
    for (const [file, text] of readConfig(/./)) {
      for (const re of NETWORK_PATTERNS) expect(re.test(text), `${file} matches ${re}`).toBe(false);
      expect(KEY_SHAPED.test(text), `${file} may contain a real key`).toBe(false);
    }
  });

  it('reads exactly ONE environment variable, and it is not a credential', () => {
    // The exception that buys this area its existence, kept as narrow as it can be. `src/` and
    // `analysis/` are banned from reading any variable at all; here the ban is on reading any
    // OTHER one. Adding a second means coming back here on purpose.
    const KEY_VARIABLES = ['MADEONSOL_API_KEY', 'HELIUS_API_KEY', 'DUNE_API_KEY'];
    for (const [file, text] of readConfig(/./)) {
      for (const variable of KEY_VARIABLES) {
        expect(text.includes(variable), `${file} must not name ${variable}`).toBe(false);
      }
      // Every environment read is `env[...]` off a parameter or `process.env` as its default; the
      // only NAME any of them may reach for is the data root's.
      const named = [...text.matchAll(/process\.env\.([A-Z0-9_]+)|env\[['"]([A-Z0-9_]+)['"]\]/g)].map(
        (m) => m[1] ?? m[2],
      );
      for (const name of named) expect(name, `${file} reads ${name}`).toBe(DATA_ROOT_ENV_VAR);
    }
  });

  it('OWNS the answer: no other code file composes a path to a dataset', () => {
    // The property the whole change buys, and the only one that keeps buying it. Before this, the
    // location was written out in eight source files, three tools and five test suites; repointing
    // the data meant finding all of them, and a missed one would read a stale copy while every
    // other reader read the new one — the two disagreeing silently, which is this repo's recurring
    // failure shape. So the names live HERE, and a consumer that grows its own copy fails.
    //
    // Comments are removed and everything else kept, in ONE tokenising pass, so a `//` inside a
    // string (`'https://…'`) cannot eat the rest of its line and hide a hit.
    const withoutComments = (source: string): string =>
      source.replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
        (token) => (token.startsWith('/*') || token.startsWith('//') ? '' : token),
      );

    /**
     * EXHAUSTIVE, and each entry states why the name is legitimately in executable text there.
     * Adding one means coming back here on purpose — a path composed anywhere else is the defect.
     */
    const ALLOWED = new Map<string, string>([
      [
        'tools/deployer-screen/bundling.mjs',
        'a printed report line naming the SOURCE DATASET of a census, not a path it opens',
      ],
    ]);

    const areas = ['src', 'analysis', 'tools', 'test'];
    const offenders: string[] = [];
    let checked = 0;
    let allowedHits = 0;
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full, `${prefix}${entry}/`);
          continue;
        }
        if (!/\.(ts|mjs|js)$/.test(entry)) continue;
        checked += 1;
        const file = `${prefix}${entry}`;
        const code = withoutComments(readFileSync(full, 'utf8'));
        const hit = DATASETS.some((d) => code.includes(d));
        if (!hit) continue;
        if (ALLOWED.has(file)) allowedHits += 1;
        else offenders.push(file);
      }
    };
    for (const area of areas) walk(join(REPO_ROOT, area), `${area}/`);

    expect(offenders, 'these must ask config/data-root.mjs instead').toEqual([]);
    // Non-vacuous twice over: the scan reached the tree, and it still SEES the one allowed hit —
    // so a tokenising slip that blinded it would show up here rather than as a quiet pass.
    expect(checked).toBeGreaterThan(30);
    expect(allowedHits).toBe(ALLOWED.size);
  });

  it('imports nothing from src/, analysis/ or tools/ — it is below all three, not beside them', () => {
    // It is imported BY all three, so an edge in the other direction would put `src/` one hop from
    // `tools/` and dissolve the boundary `test/loader.test.ts` and this file both rest on.
    for (const [file, text] of readConfig()) {
      for (const area of ['src/', 'analysis/', 'tools/', 'test/']) {
        expect(text, `${file} must not import from ${area}`).not.toMatch(
          new RegExp(`from\\s+['"][^'"]*${area}`),
        );
      }
    }
  });
});
