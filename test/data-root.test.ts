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
import { mapAt, parseWorkflowYaml, seqAt, textAt } from './workflow-yaml.js';

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

/**
 * Comments are removed and everything else kept, in ONE tokenising pass, so a `//` inside a string
 * (`'https://…'`) cannot eat the rest of its line and hide a hit — and so a doc comment that
 * MENTIONS `process.env` is not read as one.
 */
function withoutComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    (token) => (token.startsWith('/*') || token.startsWith('//') ? '' : token),
  );
}

/**
 * Every environment variable NAME a source file reads DIRECTLY, and what it cannot name.
 *
 * The environment is followed through the names it is BOUND to — a parameter default, a `const`
 * alias, a plain assignment — and every one of those, plus `process.env` itself, is then read for
 * `NAME`, `['NAME']`, `[CONSTANT]` (the idiom `config/data-root.mjs` actually writes, resolved
 * through the constant's own declaration) and a destructuring pattern.
 *
 * **THIS IS A SOURCE-TEXT SCAN AND IT IS A FLOOR ON THE EVIDENCE, NOT A PROOF OF ABSENCE.** It has
 * no dataflow analysis, so it cannot follow the environment through an arbitrary call — hand
 * `process.env`, or a name bound to it, to another function and the read happens inside a
 * parameter this scan never connects to the environment. Four rounds of review each named one more
 * indirection; the class is open, and the honest statement of what this buys is *these direct
 * spellings are checked*, in the same way `roomIsProven` is a floor on create-slot evidence rather
 * than a claim about the operation.
 *
 * What it will not do is pass silently. A subscript it cannot resolve to a literal, a computed or
 * rest element in a destructuring pattern, and a bare `process.env` that is not a binding — which
 * includes handing it to a call — are all reported as unnameable reads rather than skipped, so the
 * guard above fails on them and a human decides. Each of those spellings once returned nothing at
 * all, which is the vacuous pass this exists to prevent.
 */
export function environmentNamesRead(source: string): string[] {
  const code = withoutComments(source);
  const names: string[] = [];
  const aliases = new Set(['env']);
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*process\.env\b(?![.[])/g)) {
    aliases.add(match[1] as string);
  }
  const bound = [...aliases].join('|');
  for (const match of code.matchAll(new RegExp(`\\b(?:${bound})\\.([A-Za-z0-9_$]+)`, 'g'))) {
    names.push(match[1] as string);
  }
  for (const match of code.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*(?:process\\.)?(?:${bound})\\b`, 'g'))) {
    for (const part of (match[1] as string).split(',')) {
      const bound = part.trim();
      if (bound === '') continue;
      if (bound.startsWith('...')) {
        names.push('<the whole environment>');
        continue;
      }
      const key = /^([A-Za-z_$][\w$]*)/.exec(bound);
      names.push(key?.[1] ?? `<${bound}, which is not a literal in this file>`);
    }
  }
  for (const match of code.matchAll(new RegExp(`\\b(?:${bound})\\[([^\\]]*)\\]`, 'g'))) {
    const subscript = (match[1] as string).trim();
    const quoted = /^(['"])([^'"]*)\1$/.exec(subscript);
    if (quoted !== null) {
      names.push(quoted[2] as string);
      continue;
    }
    const declared = /^[A-Za-z_$][\w$]*$/.test(subscript)
      ? new RegExp(`\\b${subscript}\\s*=\\s*['"]([^'"]*)['"]`).exec(code)
      : null;
    names.push(declared?.[1] ?? `<${subscript}, which is not a literal in this file>`);
  }
  for (const match of code.matchAll(/process\.env\b(?![.[])/g)) {
    const before = code.slice(Math.max(0, (match.index ?? 0) - 40), match.index);
    if (!/=\s*$/.test(before)) names.push('<the whole environment>');
  }
  return names;
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

  it('names the directory the SUPPLIED environment resolves to, not the ambient one', () => {
    // The message states which root was consulted, so it has to be the root that was consulted.
    // Reporting "the variable points there" beside a path the variable does not point at is the
    // confident, well-formed, wrong answer, one layer below a measurement.
    const env = { [DATA_ROOT_ENV_VAR]: '/tmp/no-such-slot-zero-root' };
    expect(missingDatasetMessage(POPULATION_TAPE, undefined, env)).toContain(
      join('/tmp/no-such-slot-zero-root', POPULATION_TAPE),
    );
    expect(missingDatasetMessage(POPULATION_TAPE, undefined, env)).not.toContain(DEFAULT_DATA_ROOT);
    expect(() => requireDataset(POPULATION_TAPE, undefined, env)).toThrow(
      new RegExp(join('/tmp/no-such-slot-zero-root', POPULATION_TAPE)),
    );
    // And with no directory it still resolves — and finds — whatever root this run is using.
    expect(requireDataset(POPULATION_TAPE, undefined, process.env)).toBe(POPULATION_TAPE_DIR);
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

  it('REFUSES a manifest that lists nothing, rather than passing over zero entries', () => {
    // The shape a failed regeneration leaves behind: the manifest is there, so the missing-manifest
    // refusal does not fire, and every check walks nothing and reports a whole store. It is the
    // same condition as no manifest at all wearing a green tick.
    const root = store({ 'MANIFEST.sha256': '\n' });
    expect(() => verifyDataRoot(root)).toThrow(/lists nothing/);
    expect(parseManifest('\n')).toEqual([]);
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
  //
  // The workflow is read as the CONTRACT it is — steps, conditions and their order — and never as
  // text. Re-indenting a step or moving its script into a block scalar changes nothing GitHub does
  // and must not fail here; a job-level `if:` or a `continue-on-error:` changes everything and must.
  const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  interface Step {
    index: number;
    name: string | undefined;
    run: string | undefined;
    if: string | undefined;
    continueOnError: string | undefined;
  }

  const job = (text: string) => mapAt(mapAt(mapAt(parseWorkflowYaml(text), 'ci.yml')['jobs'], 'jobs')['test'], 'jobs.test');
  const stepsOf = (text: string): Step[] =>
    seqAt(job(text)['steps'], 'jobs.test.steps').map((node, index) => {
      const step = mapAt(node, `step ${index}`);
      return {
        index,
        name: textAt(step['name'], 'name'),
        run: textAt(step['run'], 'run'),
        if: textAt(step['if'], 'if'),
        continueOnError: textAt(step['continue-on-error'], 'continue-on-error'),
      };
    });

  const steps = stepsOf(ci);
  const byRun = (needle: string): Step => {
    const found = steps.filter((s) => s.run !== undefined && s.run.includes(needle));
    expect(found.length, `exactly one step should run ${needle}`).toBe(1);
    return found[0] as Step;
  };

  it('parses the workflow into steps, so the assertions below are about behaviour', () => {
    // Non-vacuous: a parser that read nothing would satisfy every "must not" below.
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(steps.some((s) => s.run === 'npm ci')).toBe(true);
  });

  it('runs the whole suite UNCONDITIONALLY — no data-free mode, no skip', () => {
    // A condition on this step is how a CI quietly stops exercising the measurement code while
    // still printing a tick; `continue-on-error` is the same thing with the tick left on after it
    // fails. Both live on the STEP, and one lives on the job, so all three are asserted.
    const test = byRun('npm test');
    expect(test.run?.trim()).toBe('npm test');
    expect(test.if, '`npm test` must carry no condition').toBeUndefined();
    expect(test.continueOnError).toBeUndefined();
    expect(job(ci)['if'], 'the job itself must carry no condition').toBeUndefined();
    expect(job(ci)['continue-on-error']).toBeUndefined();
    for (const step of steps) expect(step.continueOnError, `step ${step.index}`).toBeUndefined();
    // And no suite is excluded by name by anything the job actually runs.
    for (const step of steps) {
      expect(step.run ?? '', `step ${step.index}`).not.toMatch(/--exclude|\.skip\(|testNamePattern/);
    }
  });

  it('validates the data source before anything depends on it, and fetch implies verify', () => {
    // An unrecognised variable value must FAIL rather than fall through to the in-repo copy: a
    // typo would otherwise read as a normal green build over something nobody chose. So the check
    // is unconditional and sits ahead of every step that reads the mode.
    const check = byRun('$SLOT_ZERO_DATA_SOURCE');
    const fetch = byRun('gh release download');
    const verify = byRun('config/verify-data-root.mjs');
    const test = byRun('npm test');
    expect(check.if).toBeUndefined();
    expect(check.index).toBeLessThan(fetch.index);
    expect(check.index).toBeLessThan(verify.index);
    expect(fetch.index).toBeLessThan(verify.index);
    expect(verify.index).toBeLessThan(test.index);
    expect(check.run).toMatch(/repo\|release\)/);
    expect(check.run).toMatch(/exit 1/);

    // The fetch and the verification are gated on the SAME condition, so a fetched root is never
    // reached by the suites without having been checked against its manifest — and nothing ELSE in
    // the job is conditional, which is what keeps the suite itself unconditional above.
    const gated = steps.filter((s) => s.if !== undefined);
    expect(gated.map((s) => s.index)).toEqual([fetch.index, verify.index]);
    expect(new Set(gated.map((s) => s.if)).size, 'fetch and verify must share one condition').toBe(1);
    expect(fetch.if).toBe("env.SLOT_ZERO_DATA_SOURCE == 'release'");

    // `set -e` is what turns a failed download into a failed build rather than an empty directory,
    // and the first line is where it has to be for the download itself to be covered.
    for (const step of [check, fetch]) {
      expect((step.run ?? '').split('\n')[0]?.trim(), `step ${step.index}`).toBe('set -euo pipefail');
    }
    // The default mode is the in-repo copy: phase C flips the repository variable, not this file.
    const env = mapAt(parseWorkflowYaml(ci), 'ci.yml')['env'];
    expect(textAt(mapAt(env, 'env')['SLOT_ZERO_DATA_SOURCE'], 'env')).toBe(
      "${{ vars.SLOT_ZERO_DATA_SOURCE || 'repo' }}",
    );
  });

  it('SEES a conditional or continued-on-error test step — the shape a text match misses', () => {
    // The regression this reading exists for: both of these are behaviour changes that leave the
    // step's own text intact, so they must show up in the model rather than in a substring.
    const conditional = ci.replace('      - run: npm test', "      - if: false\n        run: npm test");
    expect(stepsOf(conditional).find((s) => s.run?.trim() === 'npm test')?.if).toBe('false');
    const continued = ci.replace(
      '      - run: npm test',
      '      - continue-on-error: true\n        run: npm test',
    );
    expect(stepsOf(continued).find((s) => s.run?.trim() === 'npm test')?.continueOnError).toBe('true');
    // And re-indenting or re-spelling a step is NOT a change: the model is the same either way.
    const rewritten = ci.replace('      - run: npm test', '      - run: |\n          npm test');
    const step = stepsOf(rewritten).find((s) => s.run?.trim() === 'npm test');
    expect(step, 'the block-scalar rewrite must still parse as the same step').toBeDefined();
    expect(step?.run?.trim()).toBe('npm test');
    expect(step?.if).toBeUndefined();
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
    let readsSeen = 0;
    for (const [file, text] of readConfig(/./)) {
      for (const variable of KEY_VARIABLES) {
        expect(text.includes(variable), `${file} must not name ${variable}`).toBe(false);
      }
      // Every environment read is `env[...]` off a parameter or `process.env` as its default; the
      // only NAME any of them may reach for is the data root's.
      const named = environmentNamesRead(text);
      readsSeen += named.length;
      for (const name of named) expect(name, `${file} reads ${name}`).toBe(DATA_ROOT_ENV_VAR);
    }
    // Non-vacuous: the scan must SEE the reads the resolver actually makes, or it is asserting
    // nothing at all — which is exactly what it was doing while it could only match a quoted
    // subscript and this module subscripts with a constant.
    const resolverReads = environmentNamesRead(readConfig().get('config/data-root.mjs') ?? '');
    expect(resolverReads.length).toBeGreaterThanOrEqual(2);
    expect(new Set(resolverReads)).toEqual(new Set([DATA_ROOT_ENV_VAR]));
    expect(readsSeen).toBe(resolverReads.length);
  });

  it('NAMES a second variable in the direct spellings, and refuses to be silent about the rest', () => {
    // The regression: each of these passed the old scan untouched. A name other than the data
    // root's — or a read that cannot be resolved to one — must come back and fail the guard above,
    // rather than leaving it iterating an empty list.
    //
    // THE BOUND IS PART OF THE CLAIM. This is a source-text scan with no dataflow analysis, so
    // what it proves is that these DIRECT spellings are checked, not that no second variable can
    // be read at all: the environment handed to another function is read inside a parameter this
    // scan cannot connect back to it. It is a floor on the evidence, and the last case below is
    // where the floor stops — an indirect read is reported as UNNAMEABLE, which fails the guard
    // and puts a human on it, rather than passing as nothing.
    expect(environmentNamesRead("const OTHER = 'SLOT_ZERO_CACHE_DIR';\nconst v = env[OTHER];")).toEqual([
      'SLOT_ZERO_CACHE_DIR',
    ]);
    expect(environmentNamesRead("process.env['SLOT_ZERO_CACHE_DIR']")).toEqual(['SLOT_ZERO_CACHE_DIR']);
    expect(environmentNamesRead('process.env.SLOT_ZERO_CACHE_DIR')).toEqual(['SLOT_ZERO_CACHE_DIR']);
    expect(environmentNamesRead('const v = env[pickAVariable()];')[0]).toMatch(/not a literal in this file/);
    // The DOT form off a bound parameter, and DESTRUCTURING off either spelling: both reached the
    // environment while the scan reported an empty list, which is the vacuous pass one spelling
    // over from the one it had just closed.
    expect(
      environmentNamesRead('function f(env = process.env) { return env.SLOT_ZERO_CACHE_DIR; }'),
    ).toEqual(['SLOT_ZERO_CACHE_DIR']);
    expect(environmentNamesRead('const { SLOT_ZERO_OTHER } = process.env;')).toEqual(['SLOT_ZERO_OTHER']);
    expect(environmentNamesRead('function f(env = process.env) { const { SLOT_ZERO_OTHER: o } = env; }')).toEqual(
      ['SLOT_ZERO_OTHER'],
    );
    expect(environmentNamesRead('const { ...rest } = process.env;')).toEqual(['<the whole environment>']);
    // And a module-level ALIAS, which the bound-parameter heuristic used to wave through as
    // benign while every read off it stayed invisible.
    expect(
      environmentNamesRead('const e = process.env;\nexport function f() { return e.SLOT_ZERO_CACHE_DIR; }'),
    ).toEqual(['SLOT_ZERO_CACHE_DIR']);
    expect(environmentNamesRead("const e = process.env;\nconst v = e['SLOT_ZERO_CACHE_DIR'];")).toEqual([
      'SLOT_ZERO_CACHE_DIR',
    ]);
    expect(environmentNamesRead('let e;\ne = process.env;\nconst { SLOT_ZERO_OTHER } = e;')).toEqual([
      'SLOT_ZERO_OTHER',
    ]);
    // A bare `process.env` is a read of the WHOLE environment unless it is bound and then
    // subscripted — the resolver's own `env = process.env` default is the bound form.
    expect(environmentNamesRead('doThings(); process.env;')).toEqual(['<the whole environment>']);
    expect(environmentNamesRead(`function f(env = process.env) { return env[${'DATA_ROOT_ENV_VAR'}]; }
const DATA_ROOT_ENV_VAR = '${DATA_ROOT_ENV_VAR}';`)).toEqual([DATA_ROOT_ENV_VAR]);
    // And a mention inside a doc comment is not a read.
    expect(environmentNamesRead('/** bans the literal `process.env` outright */')).toEqual([]);
    // WHERE THE FLOOR STOPS: the environment handed to a call is read inside a parameter this scan
    // cannot connect back to it, so the NAME is out of reach — but the handover itself is visible,
    // and it is reported as the whole environment rather than as nothing, which fails the guard.
    expect(
      environmentNamesRead('function get(cfg) { return cfg.SLOT_ZERO_CACHE_DIR; }\nconst v = get(process.env);'),
    ).toContain('<the whole environment>');
    expect(environmentNamesRead('const v = readVar(process.env, "SLOT_ZERO_CACHE_DIR");')).toEqual([
      '<the whole environment>',
    ]);
  });

  it('OWNS the answer: no other code file composes a path to a dataset', () => {
    // The property the whole change buys, and the only one that keeps buying it. Before this, the
    // location was written out in eight source files, three tools and five test suites; repointing
    // the data meant finding all of them, and a missed one would read a stale copy while every
    // other reader read the new one — the two disagreeing silently, which is this repo's recurring
    // failure shape. So the names live HERE, and a consumer that grows its own copy fails.
    //
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
