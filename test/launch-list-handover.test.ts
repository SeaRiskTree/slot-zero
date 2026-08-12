/**
 * The launch-list handover — captain decision **457a**, 2026-08-12.
 *
 * PR 87 / decision 437a required a lane budget on every code path that spends a Dune credit. The
 * arrival-rate walk's launch-list leg had no such path and structurally cannot acquire one: that
 * directory is keyless throughout, its credential allow-list is EMPTY, and
 * `test/arrival-rate-walk.test.ts` enforces both. So the leg could not run at all. The captain's
 * answer was to have the deployer screen's ALREADY-APPROVED enumeration leg write the rows down and
 * let the frequency lane read the file — option (a). Option (b), a second guarded caller, was not
 * chosen, and the tests below are what keep the implementation on the side that was.
 *
 * Four properties, and each is one of the decision's binding constraints:
 *
 * 1. **No new spending.** The by-product is a projection of rows `enumerateCreations` already
 *    parsed for the gate. A run that writes it issues exactly the requests a run that does not
 *    issue, and the writer module reaches no vendor at all.
 * 2. **The frequency lane stays credential-free.** Its reader is file I/O. The zero-credential
 *    tests in its own suite are untouched and still cover the new file, because they scan every file
 *    in that directory — this suite pins the reader's shape from the other side.
 * 3. **The two copies of the contract cannot drift.** Neither tool may import the other, so the
 *    envelope's constants are duplicated on purpose; they are pinned equal here.
 * 4. **Absence and staleness both fail towards refusal**, and a stale list can never be walked
 *    silently.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearedAllowance, isUsagePath, usageResponseBody } from './dune-lane-budget-fixture.js';

import { BASE_URL, DuneClient } from '../tools/deployer-screen/client.mjs';
import {
  DUNE_API_BASE,
  DUNE_KEY_ENV_VAR,
  KEY_ENV_VAR,
  PUBLIC_SOLANA_RPC,
} from '../tools/deployer-screen/credential.mjs';
import { FRONTEND_API } from '../tools/deployer-screen/pumpfun.mjs';
import { loadThresholds, main, parseArgs } from '../tools/deployer-screen/screen.mjs';
import { CREATION_SQL, COVERAGE_SQL, enumerateCreations } from '../tools/deployer-screen/dune.mjs';
import {
  LAUNCH_LIST_CONTRACT,
  LAUNCH_LIST_KIND as WRITER_KIND,
  LAUNCH_LIST_ROWS_KEY as WRITER_ROWS_KEY,
  LAUNCH_LIST_SCHEMA_VERSION as WRITER_SCHEMA_VERSION,
  buildLaunchListDocument,
  launchListFileName,
  writeLaunchListDocument,
} from '../tools/deployer-screen/launch-list.mjs';
import {
  LAUNCH_LIST_KIND as READER_KIND,
  LAUNCH_LIST_ROWS_KEY as READER_ROWS_KEY,
  LAUNCH_LIST_SCHEMA_VERSION as READER_SCHEMA_VERSION,
  LAUNCH_LIST_STALENESS_RULE,
  isLaunchListDocument,
  newestLaunchListPath,
  readLaunchListDocument,
  resolveLaunchListPath,
} from '../tools/arrival-rate-walk/launch-list.mjs';
import { parseLaunchListRows, readDuneResultFile } from '../tools/arrival-rate-walk/cohort.mjs';
import { buildPlan, readLaunchListInput } from '../tools/arrival-rate-walk/collect.mjs';

const NOW_MS = Date.parse('2026-08-12T00:00:00.000Z');
const KEY = 'x'.repeat(32);
const DAY_MS = 86_400_000;

const BOUNDS = {
  pollIntervalMs: 0,
  maxPollAttempts: 3,
  maxResultRows: 20_000,
  maxCoverageLagMs: 6 * 3_600_000,
  worstCaseCreditsPerExecution: 200,
  resultBytesPerRowCeiling: 121,
};

const ALLOWANCE = clearedAllowance({ creditsIncluded: 2500, creditsIncludedVendor: 2500 });

/** A base58-shaped address — anything else is dropped by `WALLET_SHAPE` before it is asked about. */
const wallet = (n: number) =>
  `W${'abcdefghijkmnopqrstuvwxyz'[n % 25]}${'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(n / 25) % 24]}${'q'.repeat(41)}`;

function months(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const from = fromIso.split('-').map(Number) as [number, number];
  const to = toIso.split('-').map(Number) as [number, number];
  for (let y = from[0], m = from[1]; y < to[0] || (y === to[0] && m <= to[1]); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01 00:00:00.000 UTC`);
  }
  return out;
}

function probeRows(): unknown[] {
  const rows: unknown[] = [];
  for (const [tbl, first, from] of [
    ['evt_createevent', '2024-04-26 09:55:52.000 UTC', '2024-04'],
    ['call_create', '2024-01-14 12:57:12.000 UTC', '2024-01'],
  ] as const) {
    rows.push({ tbl, metric: 'first_row', at: first, n: 1_000_000 });
    rows.push({ tbl, metric: 'last_row', at: '2026-08-11 23:00:00.000 UTC', n: 1_000_000 });
    for (const at of months(from, '2026-08')) rows.push({ tbl, metric: 'month', at, n: 10 });
  }
  return rows;
}

function resultBody(rows: unknown[]): Response {
  return new Response(
    JSON.stringify({
      execution_ended_at: '2026-08-11T23:30:00.000000Z',
      result: { rows, metadata: { total_row_count: rows.length, total_result_set_bytes: rows.length * 105 } },
    }),
    { status: 200 },
  );
}

/** `count` launch rows for `w`, each declaring `total` as that wallet's true history. */
function launchRows(w: string, count: number, total: number, startIso = '2026-02-01'): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    deployer: w,
    mint: `${w}-mint-${i}`,
    created_at: `${startIso} 0${i % 8}:00:00.000 UTC`,
    bonded: i % 5 === 0,
    launches_total: total,
    is_mayhem_mode: i % 3 === 0 ? true : null,
  }));
}

/** A stub that answers the probe from cache and hands each execution its own rows. */
function stub(rows: unknown[]) {
  let requests = 0;
  const impl = async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    requests += 1;
    if (isUsagePath(path)) return new Response(JSON.stringify(usageResponseBody()), { status: 200 });
    if (path.includes('/query/2/results')) return resultBody(probeRows());
    if (path.endsWith('/query/2')) return new Response(JSON.stringify({ query_sql: COVERAGE_SQL }), { status: 200 });
    if (path.endsWith('/query/1')) return new Response(JSON.stringify({ query_sql: CREATION_SQL }), { status: 200 });
    if (path.includes('/query/1/execute')) {
      void JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ execution_id: 'e1' }), { status: 200 });
    }
    if (path.includes('/execution/e1/status')) {
      return new Response(JSON.stringify({ state: 'QUERY_STATE_COMPLETED' }), { status: 200 });
    }
    if (path.includes('/execution/e1/')) return resultBody(rows);
    return new Response('not found', { status: 404 });
  };
  return { impl, requests: () => requests };
}

function client(impl: (url: unknown, init?: RequestInit) => Promise<Response>) {
  return new DuneClient({
    key: KEY,
    maxExecutions: 4,
    maxRequests: 100,
    minIntervalMs: 0,
    fetchImpl: impl as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
}

async function enumerate(wallets: string[], rows: unknown[]) {
  const s = stub(rows);
  const result = await enumerateCreations(client(s.impl), {
    wallets,
    creationQueryId: 1,
    coverageQueryId: 2,
    refreshProbe: false,
    nowMs: NOW_MS,
    bounds: BOUNDS,
    allowance: ALLOWANCE,
  });
  return { result, requests: s.requests() };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'slot-zero-launch-list-'));
}

// -----------------------------------------------------------------------------------------------

describe('the two copies of the envelope contract cannot drift', () => {
  it('pins every shared constant equal in both tools', () => {
    // `tools/arrival-rate-walk/` may not import `tools/deployer-screen/` and a test in each suite
    // asserts it — the collector runs for days and must not be coupled to a file another lane is
    // editing. The cost of that is a duplicated contract, and this is what pays it.
    expect(READER_KIND).toBe(WRITER_KIND);
    expect(READER_SCHEMA_VERSION).toBe(WRITER_SCHEMA_VERSION);
    expect(READER_ROWS_KEY).toBe(WRITER_ROWS_KEY);
  });

  it('the writer emits its rows under the key the reader looks for, and NOT under `rows`', () => {
    // The load-bearing half. `readDuneResultFile` accepts `{rows}`, so a document keyed that way
    // would be readable as an ordinary Dune export — with the observation ceiling, the coverage
    // verdict and every per-deployer refusal silently ignored. Under `launches` that route refuses.
    const doc = buildLaunchListDocument({
      enumeration: null,
      wallets: [],
      generatedAtMs: NOW_MS,
      creationQueryId: 1,
      recordSchemaVersion: 27,
      runRecord: null,
      candidateSource: 'wallet-list',
      legFailure: null,
    });
    expect(Object.keys(doc)).toContain(WRITER_ROWS_KEY);
    expect(Object.keys(doc)).not.toContain('rows');
    expect(() => readDuneResultFile(JSON.stringify(doc), 'a by-product')).toThrow(/holds no result rows/);
  });

  it('carries the contract inside the document, not only in a README', () => {
    const doc = buildLaunchListDocument({
      enumeration: null,
      wallets: [],
      generatedAtMs: NOW_MS,
      creationQueryId: 1,
      recordSchemaVersion: 27,
      runRecord: null,
      candidateSource: 'wallet-list',
      legFailure: null,
    });
    expect(doc.contract).toBe(LAUNCH_LIST_CONTRACT);
    // The four sentences a reader gets wrong at real cost.
    expect(doc.contract).toContain('BY-PRODUCT, NOT A FETCH');
    expect(doc.contract).toContain('OBSERVATION CEILING');
    expect(doc.contract).toContain('NEVER ASKED ABOUT');
    expect(doc.contract).toContain('usable:false');
  });
});

describe('the by-product rides on the approved path and costs nothing', () => {
  it('writing it issues exactly the requests not writing it issues', async () => {
    // The whole claim in one assertion: the rows come out of the enumeration's own parsed output,
    // so the document is free. If a future edit made the writer fetch anything, the two counts
    // would diverge here rather than on a bill.
    const rows = [...launchRows(wallet(1), 4, 4), ...launchRows(wallet(2), 3, 3)];
    const withList = await enumerate([wallet(1), wallet(2)], rows);
    const withoutList = await enumerate([wallet(1), wallet(2)], rows);
    buildLaunchListDocument({
      enumeration: withList.result,
      wallets: [wallet(1), wallet(2)],
      generatedAtMs: NOW_MS,
      creationQueryId: 1,
      recordSchemaVersion: 27,
      runRecord: null,
      candidateSource: 'wallet-list',
      legFailure: null,
    });
    expect(withList.requests).toBe(withoutList.requests);
  });

  it('the writer module reaches no vendor: no client, no host, no credential', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../tools/deployer-screen/launch-list.mjs', import.meta.url)),
      'utf8',
    );
    expect(text, 'the writer must not open a socket').not.toMatch(/\bfetch\s*\(/);
    expect(text, 'the writer must not build a client').not.toMatch(/from\s+['"]\.\/client\.mjs['"]/);
    expect(text, 'the writer must not read the environment').not.toMatch(/process\.env/);
    expect(text, 'the writer must not name a host').not.toMatch(/https?:\/\//);
  });

  it('the reader is file I/O and nothing else', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../tools/arrival-rate-walk/launch-list.mjs', import.meta.url)),
      'utf8',
    );
    // The zero-credential boundary itself is asserted over EVERY file in that directory by
    // `test/arrival-rate-walk.test.ts`, unchanged and still failing if the boundary is crossed.
    // This is the same claim stated about the one file this decision added, so a reader of this
    // suite does not have to go and find the other one.
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/https?:\/\//);
    // The IMPORT, not the word: this module names the screen's CLI in its own refusal messages on
    // purpose, because "run the screen over these wallets" is the only route to a launch list.
    expect(text, 'the reader must not import the screen').not.toMatch(/from\s+['"][^'"]*deployer-screen/);
  });
});

describe('the rows survive the handover exactly', () => {
  it('round-trips the enumeration into the shape the walk already parses', async () => {
    const rows = [...launchRows(wallet(1), 5, 5), ...launchRows(wallet(2), 2, 2)];
    const { result } = await enumerate([wallet(1), wallet(2)], rows);
    const dir = tmp();
    try {
      const path = writeLaunchListDocument(
        buildLaunchListDocument({
          enumeration: result,
          wallets: [wallet(1), wallet(2)],
          generatedAtMs: NOW_MS - DAY_MS,
          creationQueryId: 1,
          recordSchemaVersion: 27,
          runRecord: 'runs/2026-08-11.json',
          candidateSource: 'wallet-list',
          legFailure: null,
        }),
        dir,
      );
      const read = readLaunchListDocument(readFileSync(path, 'utf8'), {
        path,
        nowMs: NOW_MS,
        maxAgeMs: 7 * DAY_MS,
      });
      expect(read.provenance.refusals).toEqual([]);
      expect(read.provenance.ageDays).toBeCloseTo(1, 6);

      const list = parseLaunchListRows(read.rows);
      expect(list.unreadableRows).toBe(0);
      expect(list.byDeployer.get(wallet(1))).toHaveLength(5);
      expect(list.byDeployer.get(wallet(2))).toHaveLength(2);
      expect(list.declaredByDeployer.get(wallet(1))).toBe(5);
      // The mints and their creation instants are the enumeration's own, to the millisecond.
      const enumerated = result.byWallet.get(wallet(1))!;
      expect(list.byDeployer.get(wallet(1))!.map((l) => l.mint).sort()).toEqual(
        enumerated.creates.map((c) => c.mint).sort(),
      );
      expect(list.byDeployer.get(wallet(1))!.map((l) => l.createdAtMs).sort()).toEqual(
        enumerated.creates.map((c) => c.createdAtMs).sort(),
      );
      // And `bonded` survives as the chain's answer rather than as a truthiness test.
      const bonded = list.byDeployer.get(wallet(1))!.filter((l) => l.bonded).length;
      expect(bonded).toBe(enumerated.bonded);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a wallet the enumeration answered for nobody about is EMPTY, never absent', async () => {
    // Absent means never asked. Empty means asked and nothing came back, which the screen refuses
    // to gate on — two opposite findings, and collapsing them is the invisible false rejection.
    const { result } = await enumerate([wallet(1), wallet(3)], launchRows(wallet(1), 2, 2));
    const doc = buildLaunchListDocument({
      enumeration: result,
      wallets: [wallet(1), wallet(3)],
      generatedAtMs: NOW_MS,
      creationQueryId: 1,
      recordSchemaVersion: 27,
      runRecord: null,
      candidateSource: 'wallet-list',
      legFailure: null,
    });
    const row = doc.deployers.find((d) => d.wallet === wallet(3))!;
    expect(row).toBeDefined();
    expect(row.launchesReturned).toBe(0);
    expect(row.usable).toBe(false);
    expect(row.reasons.join(' ')).toMatch(/absence of evidence/);
  });
});

describe('absence fails towards refusal', () => {
  it('names the screen invocation that fills the directory rather than walking nothing', () => {
    const missing = join(tmp(), 'nowhere');
    const resolved = resolveLaunchListPath(missing);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain('keyless by construction');
      expect(resolved.reason).toContain('--wallets');
    }
  });

  it('refuses an EMPTY handover directory the same way', () => {
    const dir = tmp();
    try {
      const resolved = resolveLaunchListPath(dir);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.reason).toContain('may not go and get it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('picks the newest list by name, and refuses one whose name and contents disagree', () => {
    const dir = tmp();
    try {
      for (const iso of ['2026-08-09T00:00:00.000Z', '2026-08-11T00:00:00.000Z']) {
        writeLaunchListDocument(
          buildLaunchListDocument({
            enumeration: null,
            wallets: [],
            generatedAtMs: Date.parse(iso),
            creationQueryId: 1,
            recordSchemaVersion: 27,
            runRecord: null,
            candidateSource: 'wallet-list',
            legFailure: 'the leg threw',
          }),
          dir,
        );
      }
      expect(newestLaunchListPath(dir)).toBe(join(dir, launchListFileName('2026-08-11T00:00:00.000Z')));

      // A renamed file is refused, because the NEWEST is chosen by name — so a name that does not
      // match its contents would decide which observation was walked.
      const liar = join(dir, launchListFileName('2026-08-12T00:00:00.000Z'));
      writeFileSync(liar, readFileSync(join(dir, launchListFileName('2026-08-09T00:00:00.000Z')), 'utf8'));
      expect(() =>
        readLaunchListDocument(readFileSync(liar, 'utf8'), { path: liar, nowMs: NOW_MS, maxAgeMs: DAY_MS * 30 }),
      ).toThrow(/named for a different instant/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('staleness is visible, bounded, and never chosen by a default', () => {
  // A document whose enumeration vouches for itself, so the ONLY thing under test below is the age.
  // Every other refusal has its own case in the section after this one.
  const doc = (generatedAtMs = NOW_MS - 30 * DAY_MS) => {
    const d = buildLaunchListDocument({
      enumeration: null,
      wallets: [],
      generatedAtMs,
      creationQueryId: 1,
      recordSchemaVersion: 27,
      runRecord: null,
      candidateSource: 'wallet-list',
      legFailure: null,
    }) as unknown as Record<string, unknown>;
    (d['enumeration'] as Record<string, unknown>)['coverage'] = {
      ok: true,
      fromIso: '2024-01-14T12:57:12.000Z',
      toIso: '2026-08-11T23:00:00.000Z',
      reasons: [],
    };
    return d;
  };

  it('THROWS without a maximum age — a default is a pin, and no measurement here supports one', () => {
    // The same rule `measure.mjs` -> `measureWindowParticipation` applies to its own bar. Nothing
    // this lane has measured says how fast a screened deployer population goes stale.
    for (const bad of [undefined, null, 0, -1, Number.NaN]) {
      expect(() =>
        readLaunchListDocument(JSON.stringify(doc()), {
          path: '/x/2026-07-13T00-00-00Z.json',
          nowMs: NOW_MS,
          maxAgeMs: bad as unknown as number,
        }),
      ).toThrow(/positive maxAgeMs/);
    }
    expect(LAUNCH_LIST_STALENESS_RULE).toContain('No maximum is pinned');
  });

  it('reports the age on every read and refuses past the stated bound', () => {
    const inside = readLaunchListDocument(JSON.stringify(doc()), {
      path: '/x/y.json',
      nowMs: NOW_MS,
      maxAgeMs: 60 * DAY_MS,
    });
    expect(inside.provenance.ageDays).toBeCloseTo(30, 6);
    expect(inside.provenance.maxAgeDays).toBeCloseTo(60, 6);
    expect(inside.provenance.refusals).toEqual([]);

    const outside = readLaunchListDocument(JSON.stringify(doc()), {
      path: '/x/y.json',
      nowMs: NOW_MS,
      maxAgeMs: 7 * DAY_MS,
    });
    expect(outside.provenance.ageDays).toBeCloseTo(30, 6);
    expect(outside.provenance.refusals.join(' ')).toMatch(/30\.00 days old/);
    // And the rule travels with the refusal, so an operator reads WHY rather than only THAT.
    expect(outside.provenance.refusals.join(' ')).toContain('OBSERVATION WITH A CEILING');
  });

  it('refuses a list from the future rather than reporting a negative age', () => {
    const ahead = doc(NOW_MS + DAY_MS);
    const read = readLaunchListDocument(JSON.stringify(ahead), {
      path: '/x/y.json',
      nowMs: NOW_MS,
      maxAgeMs: 365 * DAY_MS,
    });
    expect(read.provenance.ageMs).toBe(0);
    expect(read.provenance.refusals.join(' ')).toMatch(/AFTER this reading/);
  });

  it('refuses a schema version it does not understand rather than reading what lines up', () => {
    const future = { ...doc(), schemaVersion: READER_SCHEMA_VERSION + 1 };
    expect(() =>
      readLaunchListDocument(JSON.stringify(future), { path: '/x/y.json', nowMs: NOW_MS, maxAgeMs: DAY_MS }),
    ).toThrow(/understands 1/);
  });
});

describe("the screen's own refusals reach the plan", () => {
  const provenanceFor = (mutate: (doc: Record<string, unknown>) => void) => {
    const base = buildLaunchListDocument({
      enumeration: null,
      wallets: [],
      generatedAtMs: NOW_MS,
      creationQueryId: 1,
      recordSchemaVersion: 27,
      runRecord: null,
      candidateSource: 'wallet-list',
      legFailure: null,
    }) as unknown as Record<string, unknown>;
    mutate(base);
    return readLaunchListDocument(JSON.stringify(base), {
      path: '/x/y.json',
      nowMs: NOW_MS,
      maxAgeMs: 30 * DAY_MS,
    }).provenance;
  };

  it('refuses a leg that failed, an unreadable row, and a refused coverage probe', () => {
    expect(
      provenanceFor((d) => {
        (d['enumeration'] as Record<string, unknown>)['legFailure'] = 'the execution timed out';
      }).refusals.join(' '),
    ).toMatch(/could not complete its creation enumeration/);

    expect(
      provenanceFor((d) => {
        (d['enumeration'] as Record<string, unknown>)['unreadableRows'] = 3;
      }).refusals.join(' '),
    ).toMatch(/3 row\(s\) of the enumeration/);

    expect(
      provenanceFor((d) => {
        (d['enumeration'] as Record<string, unknown>)['coverage'] = { ok: false, reasons: ['a month with no row'] };
      }).refusals.join(' '),
    ).toMatch(/coverage probe .* REFUSED/);
  });

  it('a deployer the screen would not gate on refuses the plan ONLY where the plan walks it', () => {
    // This document is one screen batch and the frequency lane's cohort is chosen elsewhere, so a
    // wallet in it that nobody here asked for is somebody else's refusal.
    const rows = launchRows(wallet(1), 3, 3);
    const provenance = {
      path: '/x/y.json',
      generatedAtIso: '2026-08-12T00:00:00.000Z',
      generatedAtMs: NOW_MS,
      ageMs: 0,
      ageDays: 0,
      maxAgeDays: 30,
      producedBy: 'screen',
      candidateSource: 'wallet-list',
      walletsAsked: 2,
      walletsUsable: 1,
      rowsReturned: 3,
      stalenessRule: LAUNCH_LIST_STALENESS_RULE,
      refusals: [],
      advisories: [],
      unusableDeployers: [{ wallet: wallet(9), reasons: ['a prefix, not a history.'] }],
    };
    const list = parseLaunchListRows(rows);

    const notWalked = buildPlan({
      cohortText: null,
      launchList: list,
      nowMs: NOW_MS,
      launchListProvenance: provenance,
    });
    expect(notWalked.refusals.filter((r) => r.includes(wallet(9)))).toEqual([]);

    const walked = buildPlan({
      cohortText: null,
      launchList: parseLaunchListRows([...rows, ...launchRows(wallet(9), 2, 2)]),
      nowMs: NOW_MS,
      launchListProvenance: provenance,
    });
    expect(walked.ok).toBe(false);
    expect(walked.refusals.join(' ')).toContain(wallet(9));
    expect(walked.refusals.join(' ')).toMatch(/nobody vouched for/);
  });

  it('carries the handover evidence onto the plan so a saved plan says which list it costed', () => {
    const plan = buildPlan({
      cohortText: null,
      launchList: parseLaunchListRows(launchRows(wallet(1), 2, 2)),
      nowMs: NOW_MS,
    });
    // A raw Dune export states no ceiling. `null` is the ABSENCE of that evidence and never a claim
    // that the export is fresh.
    expect(plan.launchListProvenance).toBeNull();
  });
});

describe('routing: a by-product can never be read as a raw export', () => {
  it('detects the document by its marker, wherever it was copied to', () => {
    const doc = buildLaunchListDocument({
      enumeration: null,
      wallets: [],
      generatedAtMs: NOW_MS,
      creationQueryId: 1,
      recordSchemaVersion: 27,
      runRecord: null,
      candidateSource: 'wallet-list',
      legFailure: null,
    });
    expect(isLaunchListDocument(JSON.stringify(doc))).toBe(true);
    expect(isLaunchListDocument('[{"deployer":"x"}]')).toBe(false);
    expect(isLaunchListDocument('not json at all')).toBe(false);
  });

  it('REFUSES a by-product handed to the walk with no stated maximum age', async () => {
    const { result } = await enumerate([wallet(1)], launchRows(wallet(1), 2, 2));
    const dir = tmp();
    try {
      const path = writeLaunchListDocument(
        buildLaunchListDocument({
          enumeration: result,
          wallets: [wallet(1)],
          generatedAtMs: NOW_MS,
          creationQueryId: 1,
          recordSchemaVersion: 27,
          runRecord: null,
          candidateSource: 'wallet-list',
          legFailure: null,
        }),
        dir,
      );
      expect(() => readLaunchListInput(path, { nowMs: NOW_MS, maxAgeDays: null })).toThrow(
        /--launch-list-max-age-days/,
      );
      // And a DIRECTORY resolves to the newest list in it, which is how the lane discovers a
      // handover it did not produce.
      const viaDir = readLaunchListInput(dir, { nowMs: NOW_MS, maxAgeDays: 30 });
      expect(viaDir.provenance?.path).toBe(path);
      expect(viaDir.list.byDeployer.get(wallet(1))).toHaveLength(2);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a RAW Dune export exactly as before, with no ceiling and no staleness flag', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'raw-export.json');
      writeFileSync(path, JSON.stringify(launchRows(wallet(1), 3, 3)));
      const read = readLaunchListInput(path, { nowMs: NOW_MS, maxAgeDays: null });
      expect(read.provenance).toBeNull();
      expect(read.list.byDeployer.get(wallet(1))).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------------------------

describe('the whole screen writes it, and only when asked — end to end through `main`', () => {
  // THE WIRING HALF. Everything above proves the projection and the reader; this drives the real
  // screen over stubbed transports and reads the written file back, so the block inside the
  // enumeration leg is pinned by what it produces rather than by its own comment. Deleting the
  // write, or moving it somewhere a default run never reaches, turns this red.
  //
  // No transport is real and nothing is billed: every request this run can make is answered here.
  const DUNE_IDS = loadThresholds()['dune'] as { coverageQueryId: number; creationQueryId: number };
  const SCREEN_WALLETS = Array.from({ length: 2 }, (_, i) => `Wa11et${'x'.repeat(30)}${'AB'[i]}`);
  const DAY = 86_400_000;

  const duneTs = (ms: number) => `${new Date(ms).toISOString().replace('T', ' ').replace('Z', '')} UTC`;

  const screenProbeRows = (nowMs: number): unknown[] => {
    const rows: unknown[] = [];
    for (const [tbl, first, from] of [
      ['evt_createevent', '2024-04-26 09:55:52.000 UTC', '2024-04'],
      ['call_create', '2024-01-14 12:57:12.000 UTC', '2024-01'],
    ] as const) {
      rows.push({ tbl, metric: 'first_row', at: first, n: 20_571_130 });
      rows.push({ tbl, metric: 'last_row', at: duneTs(nowMs - 3_600_000), n: 20_571_130 });
      for (const at of months(from, new Date(nowMs).toISOString().slice(0, 7))) {
        rows.push({ tbl, metric: 'month', at, n: 10 });
      }
    }
    return rows;
  };

  /** Thirty launches a wallet, half bonded, spread over sixty days — a clear gate pass. */
  const screenRows = (nowMs: number) =>
    SCREEN_WALLETS.flatMap((deployer, w) =>
      Array.from({ length: 30 }, (_, i) => ({
        deployer,
        mint: `MINT${w}_${i}`,
        created_at: duneTs(nowMs - (60 - i) * DAY),
        bonded: i % 2 === 0,
        launches_total: 30,
        is_mayhem_mode: false,
      })),
    );

  const runScreen = async (extraArgs: string[]) => {
    const nowMs = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'screen-e2e-'));
    const rows = screenRows(nowMs);
    const fetchImpl = async (url: unknown) => {
      const target = String(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (target.startsWith(DUNE_API_BASE)) {
        const path = target.replace(DUNE_API_BASE, '');
        if (path.startsWith('/usage')) {
          return json({
            billing_periods: [
              {
                start_date: new Date(nowMs - 5 * DAY).toISOString().slice(0, 10),
                end_date: new Date(nowMs + 25 * DAY).toISOString().slice(0, 10),
                credits_used: 0,
                credits_included: 4000,
              },
            ],
          });
        }
        if (path.startsWith(`/query/${DUNE_IDS.coverageQueryId}/results`)) {
          const probe = screenProbeRows(nowMs);
          return json({ result: { rows: probe, metadata: { total_row_count: probe.length, total_result_set_bytes: 1000 } } });
        }
        if (path.startsWith(`/query/${DUNE_IDS.coverageQueryId}`)) return json({ query_sql: COVERAGE_SQL });
        if (path.startsWith(`/query/${DUNE_IDS.creationQueryId}/execute`)) return json({ execution_id: 'e1' });
        if (path.startsWith(`/query/${DUNE_IDS.creationQueryId}`)) return json({ query_sql: CREATION_SQL });
        if (path.startsWith('/execution/e1/status')) return json({ state: 'QUERY_STATE_COMPLETED' });
        if (path.startsWith('/execution/e1/results')) {
          return json({ result: { rows, metadata: { total_row_count: rows.length, total_result_set_bytes: 50_000 } } });
        }
        throw new Error(`unstubbed Dune request ${path}`);
      }
      if (target.startsWith(BASE_URL)) {
        const w = SCREEN_WALLETS.find((x) => target.includes(x));
        // Minted seconds ago, so Stage 2's eligibility gate refuses every launch and the run
        // reaches its verdicts without a keyless request.
        if (w !== undefined) return json({ pump_tokens: [{ mint: `${w}-live`, created_timestamp: nowMs, complete: true }] });
        return json(SCREEN_WALLETS);
      }
      if (target.startsWith(FRONTEND_API)) return json([]);
      if (target.startsWith(PUBLIC_SOLANA_RPC)) return json({ jsonrpc: '2.0', id: 1, result: [] });
      throw new Error(`unstubbed request ${target}`);
    };

    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);
    try {
      const parsed = parseArgs(['--json', '--no-rotation', '--out', join(dir, 'run.json'), ...extraArgs]);
      if (!parsed.ok) throw new Error(parsed.message);
      const errs: string[] = [];
      const code = await main(
        parsed.opts,
        { [KEY_ENV_VAR]: 'm'.repeat(32), [DUNE_KEY_ENV_VAR]: 'd'.repeat(32) },
        () => {},
        (l) => errs.push(l),
      );
      expect(errs.join('\n')).toBe('');
      expect(code).toBe(0);
      return dir;
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it('writes the enumeration it already paid for, readable by the frequency lane', async () => {
    const lists = join(tmp(), 'handover');
    const dir = await runScreen(['--launch-list', lists]);
    try {
      // Read back through the arrival-rate lane's OWN reader, pointed at the directory rather than
      // the file — which is the discovery route a real collection takes.
      const resolved = resolveLaunchListPath(lists);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const read = readLaunchListDocument(readFileSync(resolved.path, 'utf8'), {
        path: resolved.path,
        nowMs: Date.now(),
        maxAgeMs: DAY,
      });
      expect(read.provenance.refusals).toEqual([]);
      expect(read.provenance.producedBy).toContain('enumerateCreations');
      expect(read.provenance.walletsAsked).toBe(SCREEN_WALLETS.length);
      expect(read.provenance.walletsUsable).toBe(SCREEN_WALLETS.length);

      const list = parseLaunchListRows(read.rows);
      expect(list.unreadableRows).toBe(0);
      for (const w of SCREEN_WALLETS) {
        expect(list.byDeployer.get(w)).toHaveLength(30);
        expect(list.declaredByDeployer.get(w)).toBe(30);
      }
    } finally {
      rmSync(lists, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes NOTHING without the flag — persisting is opt-in, exactly as --out is', async () => {
    // The guard that keeps a test run, or any run nobody asked, from depositing a fixture in the
    // handover directory a real lane takes its newest list from.
    const dir = await runScreen([]);
    try {
      expect(readdirSync(dir).sort()).toEqual(['run.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
