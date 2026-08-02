import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The type surface the compiler trusts must not run ahead of the runtime the repo declares it
// supports. A Node 22-only API type-checks clean against @types/node@22, ships, and then throws
// on the Node 20 floor CI actually runs — a green board that does not mean what it says. These
// assertions fail loudly the next time the two majors drift apart.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const pkg = JSON.parse(read('package.json')) as {
  engines: { node: string };
  devDependencies: Record<string, string>;
};

/** Leading major in a semver range or version string: ">=20" → 20, "^20.19.43" → 20. */
function major(spec: string): number {
  const m = /(\d+)/.exec(spec);
  expect(m, `no major version found in ${JSON.stringify(spec)}`).not.toBeNull();
  return Number(m![1]);
}

const enginesMajor = major(pkg.engines.node);

// Highest ES library year each Node major fully implements. The ceiling moves with the floor:
// raising engines to >=22 makes lib/target ES2023 legal, and only then. A floor this map does
// not know is a hard failure rather than a silent pass — extend it in the same commit.
const ES_CEILING_BY_NODE_MAJOR = new Map([
  [20, 2022],
  [22, 2023],
  [24, 2024],
]);

// Libraries that carry no ES year at all; they say nothing about the runtime's ES support.
const NON_VERSIONED_LIBS = new Set([
  'dom',
  'webworker',
  'scripthost',
  'decorators',
]);

// Pre-2015 and the ES6/ES7 spellings TypeScript still accepts, mapped to their year.
const LEGACY_LIB_YEARS = new Map([
  ['es3', 1999],
  ['es5', 2009],
  ['es6', 2015],
  ['es7', 2016],
]);

/**
 * Year a tsconfig `lib`/`target` entry promises, or null if it promises no ES year.
 * Case-insensitive, and sub-libraries compare on their parent's year: `ES2022.Array` → 2022.
 * `ESNext` is Infinity — it is by construction newer than any released floor.
 */
function esYear(entry: string): number | null {
  const head = entry.trim().toLowerCase().split('.')[0] ?? '';
  if (NON_VERSIONED_LIBS.has(head)) return null;
  if (head === 'esnext') return Number.POSITIVE_INFINITY;
  const legacy = LEGACY_LIB_YEARS.get(head);
  if (legacy !== undefined) return legacy;
  const m = /^es(\d{4})$/.exec(head);
  expect(m, `unrecognised tsconfig lib/target ${JSON.stringify(entry)}`).not.toBeNull();
  return Number(m![1]);
}

/**
 * The `node-version:` values a workflow actually declares, as bare literals.
 * A whole-line comment is not a declaration: capturing one would fail the guard with a
 * divergence that does not exist — the exact failure mode this guard exists to prevent.
 * Trailing comments and surrounding quotes are stripped from the values that remain.
 */
function declaredNodeVersions(workflow: string): string[] {
  return workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .flatMap((line) => {
      const m = /node-version:\s*(.+)/.exec(line);
      if (!m) return [];
      return [
        (m[1] ?? '')
          .replace(/#.*$/, '')
          .trim()
          .replace(/^['"]|['"]$/g, ''),
      ];
    });
}

describe('the type surface matches the runtime the repo says it supports', () => {
  it('@types/node is pinned to the engines floor major', () => {
    expect(major(pkg.devDependencies['@types/node']!)).toBe(enginesMajor);
  });

  it('the installed @types/node is that major too, not merely the declared range', () => {
    const require = createRequire(import.meta.url);
    let manifest: string;
    try {
      manifest = require.resolve('@types/node/package.json');
    } catch {
      throw new Error(
        'cannot resolve @types/node/package.json — run `npm ci` before this test; ' +
          'it checks the INSTALLED version, not just the declared range',
      );
    }
    const installed = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
    expect(major(installed.version)).toBe(enginesMajor);
  });

  it('CI type-checks and tests on the engines floor major', () => {
    const declared = declaredNodeVersions(read('.github/workflows/ci.yml'));
    expect(declared.length, 'ci.yml declares no node-version').toBeGreaterThan(0);
    for (const value of declared) {
      // A matrix reference or a list would let this guard check one entry, or none, while
      // reading as if it checked them all. Neither is a divergence — but neither is a check.
      expect(
        /^\d[\w.-]*$/.test(value),
        `ci.yml node-version ${JSON.stringify(value)} is not a literal version; this guard ` +
          'cannot resolve matrix references or lists — inline the version, or teach it to',
      ).toBe(true);
      expect(major(value)).toBe(enginesMajor);
    }
  });

  it('a commented-out node-version is not read as a declaration', () => {
    // The scan used to be line-unanchored, so a parked line like the first one below was
    // captured as if it were live and failed the guard against a version nothing runs on.
    const workflow = [
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      "          # node-version: '22'  # parked until the floor is raised",
      "          node-version: '20' # package.json engines: node >=20",
    ].join('\n');
    expect(declaredNodeVersions(workflow)).toEqual(['20']);
  });

  it("tsconfig's lib does not promise more than the floor runtime provides", () => {
    const ceiling = ES_CEILING_BY_NODE_MAJOR.get(enginesMajor);
    expect(
      ceiling,
      `no ES library ceiling recorded for the Node ${enginesMajor} floor — add it to ` +
        'ES_CEILING_BY_NODE_MAJOR in the commit that raises engines',
    ).toBeDefined();

    const tsconfig = read('tsconfig.json');
    const lib = /"lib"\s*:\s*\[([^\]]*)\]/.exec(tsconfig)?.[1] ?? '';
    const target = /"target"\s*:\s*"([^"]+)"/.exec(tsconfig)?.[1] ?? '';
    const entries = [
      ...lib.split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean),
      ...(target ? [target] : []),
    ];
    expect(entries.length, 'tsconfig declares neither lib nor target').toBeGreaterThan(0);
    for (const entry of entries) {
      const year = esYear(entry);
      if (year === null) continue;
      expect(
        year <= ceiling!,
        `${entry} is newer than ES${ceiling}, the most the Node ${enginesMajor} floor provides`,
      ).toBe(true);
    }
  });
});
