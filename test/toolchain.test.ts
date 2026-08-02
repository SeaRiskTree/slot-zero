import { readFileSync } from 'node:fs';
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

describe('the type surface matches the runtime the repo says it supports', () => {
  it('@types/node is pinned to the engines floor major', () => {
    expect(major(pkg.devDependencies['@types/node']!)).toBe(enginesMajor);
  });

  it('the installed @types/node is that major too, not merely the declared range', () => {
    const installed = JSON.parse(read('node_modules/@types/node/package.json')) as {
      version: string;
    };
    expect(major(installed.version)).toBe(enginesMajor);
  });

  it('CI type-checks and tests on the engines floor major', () => {
    const ci = read('.github/workflows/ci.yml');
    const declared = [...ci.matchAll(/node-version:\s*'?"?([^\s'"#]+)/g)].map((m) => m[1]!);
    expect(declared.length, 'ci.yml declares no node-version').toBeGreaterThan(0);
    for (const v of declared) expect(major(v)).toBe(enginesMajor);
  });

  it("tsconfig's lib does not promise more than the floor runtime provides", () => {
    // ES2022 is fully implemented on Node 20; anything later would reintroduce the same
    // silent gap from the language-library side rather than the @types/node side.
    const tsconfig = read('tsconfig.json');
    const lib = /"lib"\s*:\s*\[([^\]]*)\]/.exec(tsconfig)?.[1] ?? '';
    const target = /"target"\s*:\s*"([^"]+)"/.exec(tsconfig)?.[1] ?? '';
    const allowed = new Set(['ES5', 'ES2015', 'ES2016', 'ES2017', 'ES2018', 'ES2019', 'ES2020', 'ES2021', 'ES2022']);
    for (const entry of lib.split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean)) {
      expect(allowed.has(entry), `lib ${entry} is newer than the Node ${enginesMajor} floor`).toBe(
        true,
      );
    }
    expect(allowed.has(target), `target ${target} is newer than the Node ${enginesMajor} floor`).toBe(
      true,
    );
  });
});
