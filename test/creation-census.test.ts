/**
 * Tests for the creation census. **Nothing here reaches the network.**
 *
 * Every fixture is synthetic — hand-written to the shape Dune returned on 2026-08-04, never a
 * captured payload — except where a test deliberately reads this repository's own committed run,
 * which is ours and is the point.
 *
 * The `fetchImpl` and `sleepImpl` seams on `DuneClient` exist for these tests. No test constructs a
 * client without them, so a regression that starts issuing real requests fails here rather than
 * quietly spending a billed, unrecoverable execution.
 *
 * Five kinds of assertion live here and they are not interchangeable:
 *
 * - **Boundary** — this is the repository's FIFTH network-capable directory and it is the second
 *   keyed one. The scans below are what make "one host, one socket, one file names the credential"
 *   a property of the tree rather than a review note.
 * - **Duplication** — `CENSUS_SQL` and this module's readers are copies of
 *   `tools/arrival-rate-walk/cohort.mjs`. The directory boundary is why (see that file and the
 *   README); these tests are what stop the copies drifting, by asserting the SQL byte for byte and
 *   driving both readers over one set of fixtures.
 * - **Refusal** — almost every failure mode here returns a confident, complete-LOOKING wrong answer:
 *   a table that starts after the month, a result cut at its own limit, a page read as a whole
 *   result, a capped census read as a short one. The tests assert what is refused, not only what is
 *   computed.
 * - **Spend** — an execution is billed whether or not it succeeds and is never retried. That is
 *   asserted against a counting stub, not trusted.
 * - **Evidence** — the committed run is re-read and its numbers re-derived, so a record that stops
 *   agreeing with its own cohort file fails a test.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CENSUS_SQL,
  CENSUS_TABLES,
  LADDER_TARGETS,
  PROLIFIC_CUT_CAVEAT,
  RECORD_SCHEMA_VERSION,
  WALLET_SHAPE,
  assessCensusCoverage,
  buildCensusRecord,
  monthBounds,
  normaliseSql,
  parseCensusRows,
  parseDuneTimestamp,
  PUBLISHED_LADDER,
  PUBLISHED_LADDER_SOURCE,
  readCount,
  reconcileWithPublished,
  serialiseCohortFile,
  summariseLaunches,
} from '../tools/creation-census/census.mjs';
import { DuneClient, DuneRefused, CeilingReached, DUNE_API_BASE, describeDuneStatus } from '../tools/creation-census/client.mjs';
import { KEY_ENV_VAR, resolveDuneCredential } from '../tools/creation-census/credential.mjs';
import {
  EXIT,
  assertSavedQueryMatches,
  buildPlan,
  deploySavedQuery,
  executeAndRead,
  evidencePointer,
  main,
  parseArgs,
  readBounds,
  readResult,
  readSavedQueries,
} from '../tools/creation-census/run.mjs';
import {
  COHORT_SQL,
  COHORT_TABLES,
  assessCohortCoverage,
  parseCohortRows,
  readDuneResultFile,
} from '../tools/arrival-rate-walk/cohort.mjs';
import { CREDENTIAL_PATTERNS, KEY_SHAPED } from './offline-guard.js';

const TOOL_DIR = fileURLToPath(new URL('../tools/creation-census/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const SENTINEL_KEY = 'SENTINELsentinelSENTINELsentinel';

function readAll(dir: string, prefix: string, pattern = /\.(ts|mjs|js)$/): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const [k, v] of readAll(full, `${prefix}${entry}/`, pattern)) out.set(k, v);
    } else if (pattern.test(entry)) {
      out.set(`${prefix}${entry}`, readFileSync(full, 'utf8'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fixtures

const WALLET_A = '7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL';
const WALLET_B = '2E94st2NZnzA943HBceijgkw75gXTTxch39yquMBfeQk';
const WALLET_C = '4q4GKBpVop3q1S8pnPCbivnc9Uc2q3Q7WQBb3aqfKGmL';

const JULY = monthBounds('2026-07');

function coverageRow(key: string, a: string | null, b: string | null, n: number) {
  return { kind: 'coverage', key, a, b, n };
}

/** A whole, healthy result: both surfaces bracket the month, a total, three deployers. */
function healthyRows(): Record<string, unknown>[] {
  return [
    coverageRow('evt_createevent', '2024-04-26 09:55:52.000 UTC', '2026-08-04 05:23:05.000 UTC', 857288),
    coverageRow('call_create', '2024-01-14 12:57:12.000 UTC', '2026-08-04 05:22:36.000 UTC', 2851),
    { kind: 'total', key: 'deployers_at_or_above_floor', a: null, b: null, n: 3 },
    { kind: 'deployer', key: WALLET_A, a: null, b: null, n: 62 },
    { kind: 'deployer', key: WALLET_B, a: null, b: null, n: 432 },
    { kind: 'deployer', key: WALLET_C, a: null, b: null, n: 31 },
  ];
}

/** A client whose every response is scripted by path. */
function client(script: (path: string, init: RequestInit) => Response, over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
    const path = String(url).slice(DUNE_API_BASE.length);
    calls.push(path);
    return script(path, init);
  });
  const c = new DuneClient({
    key: SENTINEL_KEY,
    maxExecutions: 1,
    maxRequests: 20,
    minIntervalMs: 0,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async () => undefined,
    ...over,
  });
  return { c, calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function results(rows: unknown[], metadata: Record<string, unknown> = {}): unknown {
  return {
    result: { rows, metadata: { total_row_count: rows.length, total_result_set_bytes: 1234, ...metadata } },
  };
}

// ---------------------------------------------------------------------------------------------

describe('the statement is one text, and this directory is only its keyed half', () => {
  it('carries COHORT_SQL byte for byte', () => {
    // The committed home of the statement is the KEYLESS lane, which cannot execute it: its
    // credential allow-list is empty and test/arrival-rate-walk.test.ts enforces that. So the text
    // is duplicated across the directory boundary, and this is what stops the copies drifting —
    // a divergence fails here rather than producing two different censuses under one query id.
    expect(CENSUS_SQL).toBe(COHORT_SQL);
    expect(CENSUS_TABLES).toEqual([...COHORT_TABLES]);
    expect(WALLET_SHAPE.source).toBe(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.source);
  });

  it('reads a result exactly as the keyless lane would', () => {
    // Behavioural parity for the READER, which cannot be asserted textually. Both parsers and both
    // coverage rules run over one set of fixtures and must reach the same verdict — including on
    // every refusal, since a copy that refused less would publish what the original would not.
    const cases: { name: string; rows: unknown[] }[] = [
      { name: 'healthy', rows: healthyRows() },
      { name: 'missing a coverage row', rows: healthyRows().filter((r) => r['key'] !== 'call_create') },
      {
        name: 'a surface starting after the month',
        rows: healthyRows().map((r) =>
          r['key'] === 'evt_createevent' ? { ...r, a: '2026-07-15 00:00:00.000 UTC' } : r,
        ),
      },
      { name: 'no rows in the month', rows: healthyRows().map((r) => (r['kind'] === 'coverage' ? { ...r, n: 0 } : r)) },
      { name: 'no declared total', rows: healthyRows().filter((r) => r['kind'] !== 'total') },
      { name: 'capped', rows: healthyRows().map((r) => (r['kind'] === 'total' ? { ...r, n: 99 } : r)) },
      { name: 'an unreadable row', rows: [...healthyRows(), { kind: 'deployer', key: WALLET_A, n: 'many' }] },
      { name: 'a wallet that is not base58-shaped', rows: [...healthyRows(), { kind: 'deployer', key: 'not a wallet!', n: 40 }] },
      { name: 'empty', rows: [] },
    ];
    for (const { name, rows } of cases) {
      const mine = parseCensusRows(rows);
      const theirs = parseCohortRows(rows);
      expect(mine.deployers, name).toEqual(theirs.deployers);
      expect(mine.declaredTotal, name).toBe(theirs.declaredTotal);
      expect(mine.unreadableRows, name).toBe(theirs.unreadableRows);
      expect(mine.refusedByShape, name).toBe(theirs.refusedByShape);
      expect([...mine.coverage.entries()], name).toEqual([...theirs.coverage.entries()]);
      const a = assessCensusCoverage({ census: mine, monthStartMs: JULY.startMs, monthEndMs: JULY.endMs });
      const b = assessCohortCoverage({ cohort: theirs, monthStartMs: JULY.startMs, monthEndMs: JULY.endMs });
      expect(a.ok, `${name}: verdict`).toBe(b.ok);
      expect(a.reasons.length, `${name}: reason count`).toBe(b.reasons.length);
    }
  });

  it('writes a cohort file the keyless lane reads back unchanged', () => {
    // The census hands the walk its input with NO conversion step between them. If this envelope
    // stops being one `readDuneResultFile` accepts, the two lanes are joined by an operator instead.
    const rows = healthyRows();
    const text = serialiseCohortFile({
      queryId: 1,
      month: '2026-07',
      parameters: { month_start: JULY.startSql, month_end: JULY.endSql, min_launches: '30', max_rows: '5000' },
      executedAtUtc: '2026-08-04T05:26:09.244Z',
      rows,
    });
    expect(readDuneResultFile(text, 'fixture')).toEqual(rows);
    // One row per line, so a 3,000-row evidence file is reviewable in a diff.
    expect(text.split('\n').filter((l) => l.trimStart().startsWith('{"')).length).toBe(rows.length);
  });
});

describe('the census refuses what it cannot vouch for', () => {
  const assess = (rows: unknown[]) =>
    assessCensusCoverage({ census: parseCensusRows(rows), monthStartMs: JULY.startMs, monthEndMs: JULY.endMs });

  it('accepts a result whose surfaces bracket the month', () => {
    const verdict = assess(healthyRows());
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('refuses a surface it reads but nothing bounds', () => {
    const verdict = assess(healthyRows().filter((r) => r['key'] !== 'call_create'));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('call_create');
  });

  it('refuses a decoded table that starts after the month — the silent start date', () => {
    // The whole reason a count travels with its probe. A table beginning mid-month returns a
    // well-formed, complete-LOOKING answer for the part it does not hold.
    const verdict = assess(
      healthyRows().map((r) => (r['key'] === 'call_create' ? { ...r, a: '2026-07-15 00:00:00.000 UTC' } : r)),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/does not bracket the seed month/);
  });

  it('refuses a month in which the read surfaces hold no creation at all', () => {
    // Distinct from a non-bracketing table: a surface can span the month and still be missing it,
    // and an empty census then says nothing about how many deployers there were.
    const verdict = assess(healthyRows().map((r) => (r['kind'] === 'coverage' ? { ...r, n: 0 } : r)));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/NO creation row at all/);
  });

  it('refuses the WHOLE census for one unreadable row, never the row alone', () => {
    // A row that fails to parse commonly has no readable wallet, so the deployer that went missing
    // is exactly the one that cannot be named. Partial use would be a silent, unnameable shortfall.
    const verdict = assess([...healthyRows(), 'not a row']);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/could not be read/);
  });

  it('refuses a capped result rather than reading it as a short-but-complete census', () => {
    const rows = healthyRows().map((r) => (r['kind'] === 'total' ? { ...r, n: 900 } : r));
    const verdict = assess(rows);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/row cap truncated it/);
    expect(parseCensusRows(rows).declaredTotal).toBe(900);
  });

  it('refuses a result that declares no total', () => {
    expect(assess(healthyRows().filter((r) => r['kind'] !== 'total')).ok).toBe(false);
  });

  it('counts a wallet that is not base58-shaped rather than carrying it into another SQL literal', () => {
    const parsed = parseCensusRows([...healthyRows(), { kind: 'deployer', key: "bob'; drop--", a: null, b: null, n: 40 }]);
    expect(parsed.refusedByShape).toBe(1);
    expect(parsed.deployers.map((d) => d.wallet)).not.toContain("bob'; drop--");
    // And a refusal by shape is NOT an unreadable row: the total accounts for it, so the census is
    // not refused whole for a wallet it deliberately declined to carry.
    expect(parsed.unreadableRows).toBe(0);
  });
});

describe('the readers behave', () => {
  it('parses both Dune timestamp spellings and rejects anything else', () => {
    expect(parseDuneTimestamp('2025-12-01 19:37:59.000 UTC')).toBe(Date.UTC(2025, 11, 1, 19, 37, 59));
    expect(parseDuneTimestamp('2026-08-03T09:12:21.429632Z')).toBe(Date.UTC(2026, 7, 3, 9, 12, 21, 429));
    expect(parseDuneTimestamp('yesterday')).toBeNull();
    expect(parseDuneTimestamp(17)).toBeNull();
  });

  it('reads a count more narrowly than Number does', () => {
    expect(readCount(3)).toBe(3);
    expect(readCount(' 12 ')).toBe(12);
    for (const bad of [true, null, '', '12abc', -1, 1.5]) expect(readCount(bad)).toBeNull();
  });

  it('bounds a month half-open, and rolls December into the next year', () => {
    expect(JULY.startSql).toBe('2026-07-01 00:00:00');
    expect(JULY.endSql).toBe('2026-08-01 00:00:00');
    const dec = monthBounds('2025-12');
    expect(dec.endSql).toBe('2026-01-01 00:00:00');
    expect(() => monthBounds('2026-13')).toThrow(TypeError);
    expect(() => monthBounds('July')).toThrow(TypeError);
  });

  it('summarises with quantiles and a ladder, never a mean', () => {
    const deployers = Array.from({ length: 100 }, (_, i) => ({ wallet: `w${i}`, launchesInMonth: i + 1 }));
    const s = summariseLaunches(deployers);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(51);
    // The ladder answers "what floor gives me a cohort of about this size", which is the question
    // `chooseThreshold` asks over the same rows.
    const ten = s.ladder.find((r) => r.cohortAtMost === 10);
    expect(ten?.deployers).toBeLessThanOrEqual(10);
    expect(ten?.threshold).toBe(91);
    expect(summariseLaunches([]).ladder).toEqual([]);
    expect(summariseLaunches([]).p50).toBeNull();
    expect(LADDER_TARGETS[0]).toBe(10);
  });

  it('has no mean anywhere in its executable half', () => {
    // A standing captain bar for this class of claim: creation counts are heavily right-skewed
    // (the committed run's max is 12,555 against a median of 66), so a mean is a wrong answer
    // rather than a rough one.
    const source = readFileSync(join(TOOL_DIR, 'census.mjs'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.includes('/**'))
      .join('\n');
    expect(source).not.toMatch(/\bmean\b|\baverage\b/i);
  });

  it('compares SQL on comments too, because the comments are where the traps are written', () => {
    expect(normaliseSql('SELECT 1  \r\n')).toBe('SELECT 1');
    expect(normaliseSql(CENSUS_SQL)).not.toBe(normaliseSql(CENSUS_SQL.replace('-- slot-zero', '-- edited')));
  });
});

describe('the credential is resolved, and never said out loud', () => {
  it('names its own variable and nothing else does', () => {
    expect(KEY_ENV_VAR).toBe('DUNE_API_KEY');
    const allowed = new Set(['tools/creation-census/credential.mjs']);
    for (const [file, text] of readAll(TOOL_DIR, 'tools/creation-census/')) {
      if (allowed.has(file)) continue;
      for (const variable of ['DUNE_API_KEY', 'MADEONSOL_API_KEY', 'HELIUS_API_KEY', 'SOLSCAN_API_KEY']) {
        expect(text.includes(variable), `${file} must not name ${variable}`).toBe(false);
      }
    }
    for (const pattern of CREDENTIAL_PATTERNS) {
      expect(pattern.test(readFileSync(join(TOOL_DIR, 'credential.mjs'), 'utf8'))).toBe(true);
    }
  });

  it('tells a missing key from a malformed one, and quotes neither', () => {
    // "No candidates" that is really "no credential" is the failure this repository refuses
    // everywhere else. There is no keyless route to a census, so an absent key is an ABSENT answer.
    const missing = resolveDuneCredential({});
    expect(missing.outcome).toBe('missing');
    expect(missing.key).toBeNull();
    expect(missing.message).toMatch(/no keyless route/);

    const url = resolveDuneCredential({ DUNE_API_KEY: 'https://api.dune.com?api-key=abc123def456' });
    expect(url.outcome).toBe('malformed');
    expect(url.message).not.toContain('abc123def456');

    const short = resolveDuneCredential({ DUNE_API_KEY: 'abc' });
    expect(short.outcome).toBe('malformed');
    expect(short.message).not.toContain('abc');

    const ok = resolveDuneCredential({ DUNE_API_KEY: ` ${SENTINEL_KEY} ` });
    expect(ok.outcome).toBe('ok');
    expect(ok.key).toBe(SENTINEL_KEY);
    expect(ok.message).not.toContain(SENTINEL_KEY);
  });

  it('never lets the key reach a message, on any failure path', async () => {
    // Driven against a sentinel rather than reviewed for: every refusal the client can produce is
    // rendered and searched. The key is a HEADER, so no URL this client builds can carry one.
    const messages: string[] = [];
    for (const status of [401, 402, 403, 429, 500, 404]) {
      const { c } = client(() => new Response(SENTINEL_KEY, { status }), { maxRequests: 3 });
      await c.getJson('/query/1').catch((e) => messages.push(String(e?.message)));
    }
    const { c } = client(() => {
      throw new Error(`socket ${SENTINEL_KEY}`);
    });
    await c.getJson('/query/1').catch((e) => messages.push(String(e?.message)));
    expect(messages.length).toBeGreaterThan(5);
    // The vendor's own body is excerpted into the message, so a sentinel PLANTED in the body is
    // expected there; what must never appear is the key we hold. They are the same string here on
    // purpose — so the assertion below is made on the header instead, which is where ours goes.
    const { c: c2, fetchImpl } = client(() => json({ query_sql: 'x' }));
    await c2.getJson('/query/1');
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-dune-api-key']).toBe(SENTINEL_KEY);
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain(SENTINEL_KEY);
    expect(describeDuneStatus(402, '/x', '')).toMatch(/allowance is spent/);
  });
});

describe('spending is bounded, and an execution is never bought twice', () => {
  it('issues the execution exactly once and does not retry a failed one', async () => {
    // AN EXECUTION IS BILLED WHETHER OR NOT IT SUCCEEDS. A retried execution buys a second bill for
    // the same answer and there is no failure mode where that is the right move.
    let executes = 0;
    const { c } = client((path) => {
      if (path.endsWith('/execute')) {
        executes += 1;
        return json({ execution_id: 'e1' });
      }
      if (path.includes('/status')) return json({ state: 'QUERY_STATE_FAILED' });
      return json({});
    });
    await expect(
      executeAndRead(c, 1, {}, { pollIntervalMs: 0, maxPollAttempts: 3, resultLimit: 100 }),
    ).rejects.toThrow(/ended QUERY_STATE_FAILED/);
    expect(executes).toBe(1);
    expect(c.executions()).toBe(1);
  });

  it('counts the execution BEFORE the request, so a timeout is not under-reported', async () => {
    const { c } = client(() => {
      throw new Error('timeout');
    });
    await expect(c.execute(1, {})).rejects.toThrow(/Transport failure/);
    expect(c.executions()).toBe(1);
  });

  it('refuses to start a second execution under a ceiling of one', async () => {
    const { c } = client(() => json({ execution_id: 'e1' }), { maxExecutions: 1 });
    await c.execute(1, {});
    await expect(c.execute(1, {})).rejects.toBeInstanceOf(CeilingReached);
  });

  it('retries a read but never a create', async () => {
    // Reads are billed by bytes returned, so a failed one costs nothing. A create spends one of the
    // ten private query slots, which no later run can win back.
    const { c, calls } = client((path) => (calls.length < 2 ? new Response('', { status: 503 }) : json({ ok: 1 })));
    await c.getJson('/query/1');
    expect(calls.length).toBe(2);

    const { c: c2, calls: calls2 } = client(() => new Response('', { status: 503 }));
    await expect(c2.postJson('/query', {})).rejects.toBeInstanceOf(DuneRefused);
    expect(calls2.length).toBe(1);
  });

  it('stops the run rather than paging when the request ceiling is reached', async () => {
    const { c } = client(() => json({}), { maxRequests: 1 });
    await c.getJson('/a');
    await expect(c.getJson('/b')).rejects.toBeInstanceOf(CeilingReached);
  });
});

describe('a read that cannot prove it is whole is refused, never published', () => {
  const read = (body: unknown, limit = 100) => {
    const { c } = client(() => json(body));
    return readResult(c, '/execution/e/results', limit);
  };

  it('accepts a whole result and accounts its bytes', async () => {
    const { c } = client(() => json(results(healthyRows())));
    const out = await readResult(c, '/execution/e/results', 100);
    expect(out.rows.length).toBe(6);
    expect(c.stats().resultBytes).toBe(1234);
    expect(c.stats().estimatedExportCredits).toBeCloseTo(0.025, 3);
  });

  it('refuses a result with no declared total', async () => {
    await expect(read({ result: { rows: [], metadata: {} } })).rejects.toThrow(/no `total_row_count`/);
  });

  it('refuses a result sitting exactly on its own limit', async () => {
    const rows = Array.from({ length: 5 }, () => ({ kind: 'deployer', key: WALLET_A, n: 1 }));
    await expect(read(results(rows), 5)).rejects.toThrow(/sits on its own limit/);
  });

  it('refuses a PAGE read as a whole result — Dune pages on response size independently of ours', async () => {
    // Under the limit and over the row count: every other check passes and it is still short.
    await expect(read(results(healthyRows(), { total_row_count: 90 }), 100)).rejects.toThrow(/is a PAGE/);
  });

  it('refuses a declared total above the limit it was issued with', async () => {
    await expect(read({ result: { rows: [], metadata: { total_row_count: 999 } } }, 10)).rejects.toThrow(
      /above the `\?limit=10`/,
    );
  });
});

describe('the saved query is verified before an execution is spent', () => {
  it('passes when the deployed text matches byte for byte', async () => {
    const { c, calls } = client(() => json({ query_sql: CENSUS_SQL }));
    // It returns its verdict rather than only throwing, because the run record carries that verdict
    // as a field and a field asserting a verification must be wired to the verification.
    await expect(assertSavedQueryMatches(c, 8214953)).resolves.toBe(true);
    expect(calls).toEqual(['/query/8214953']);
    expect(c.executions()).toBe(0);
  });

  it('refuses terminally when a browser has edited it, including only its comments', async () => {
    const { c } = client(() => json({ query_sql: CENSUS_SQL.replace('ONE execution', 'many executions') }));
    await expect(assertSavedQueryMatches(c, 8214953)).rejects.toMatchObject({ terminal: true });
    expect(c.executions()).toBe(0);
  });

  it('refuses a saved query that returns no SQL at all', async () => {
    const { c } = client(() => json({}));
    await expect(assertSavedQueryMatches(c, 1)).rejects.toThrow(/returned no SQL/);
  });
});

describe('the deploy step counts the slots it is about to spend', () => {
  it('reads the account rather than asserting a number', async () => {
    // The claim that stalled this lane for a month was a COUNT IN A COMMENT: "the free tier's ten
    // private query slots are full", where the account held eight. A number in a comment cannot be
    // checked by the next reader; this call is the enforcement, and it happens immediately before
    // anything is created.
    const { c } = client(() => json({ total: 8, queries: [{ id: 1, name: 'a' }] }));
    const saved = await readSavedQueries(c);
    expect(saved.total).toBe(8);
  });

  it('falls back to counting the rows when the vendor declares no total', async () => {
    const { c } = client(() => json({ queries: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }));
    expect((await readSavedQueries(c)).total).toBe(2);
  });

  it('counts the PRIVATE population the cap governs, not every query the account owns', async () => {
    // The Free-tier allowance is on private queries; `total` counts public and archived ones too.
    // A guard measuring a different population than the cap it enforces is the same take-it-on-faith
    // defect this step exists to remove.
    const { c } = client(() =>
      json({
        total: 5,
        queries: [
          { id: 1, name: 'private', is_private: true },
          { id: 2, name: 'public', is_private: false },
          { id: 3, name: 'archived', is_private: true, is_archived: true },
          { id: 4, name: 'archived the other spelling', is_private: true, archived: true },
          { id: 5, name: 'private again', is_private: true },
        ],
      }),
    );
    const saved = await readSavedQueries(c);
    expect(saved.total).toBe(5);
    expect(saved.privateInUse).toBe(2);
  });

  it('COUNTS a row that declares nothing, because under-counting is what over-spends', async () => {
    // `/queries?limit=100` rows carry neither `is_private` nor `is_archived` (verified against the
    // live account 2026-08-04) while `GET /query/{id}` does. Dropping a silent row would under-count
    // and let the deploy spend a slot it has no evidence is free — the one direction that must not
    // happen. Rows the vendor declares but does not list are counted the same way.
    const { c } = client(() => json({ total: 4, queries: [{ id: 1, name: 'a' }, { id: 2, name: 'b', is_private: false }] }));
    const saved = await readSavedQueries(c);
    expect(saved.total).toBe(4);
    expect(saved.privateInUse).toBe(3); // one silent row + two declared-but-unlisted
  });

  it('gates the deploy on the FILTERED count and reports both figures', () => {
    // Both numbers reach the operator so the guard is auditable: the vendor's declared total beside
    // the filtered count, and the message says which one was compared against the cap.
    const source = readFileSync(join(TOOL_DIR, 'run.mjs'), 'utf8');
    expect(source).toContain('saved.privateInUse >= bounds.dune.privateQuerySlots');
    expect(source).not.toContain('saved.total >= bounds.dune.privateQuerySlots');
    expect(source).toContain('FILTERED count');
  });

  it('refuses when it cannot establish the count', async () => {
    const { c } = client(() => json({ queries: null }));
    await expect(readSavedQueries(c)).rejects.toThrow(/number of private slots in use cannot be established/);
  });

  it('deploys the committed text and nothing else, and refuses a create with no id back', async () => {
    let sent: any = null;
    const { c } = client((path, init) => {
      sent = JSON.parse(String(init.body));
      return json({ query_id: 8214953 });
    });
    const id = await deploySavedQuery(c, { name: 'n', parameters: [] });
    expect(id).toBe(8214953);
    expect(sent.query_sql).toBe(COHORT_SQL);
    expect(sent.is_private).toBe(true);

    const { c: c2 } = client(() => json({}));
    await expect(deploySavedQuery(c2, { name: 'n', parameters: [] })).rejects.toThrow(/returned no query id/);
  });
});

describe('the CLI plans before it spends', () => {
  const bounds = readBounds();

  it('parses its arguments and refuses nonsense rather than guessing', () => {
    expect(parseArgs(['--month', '2026-01', '--live']).month).toBe('2026-01');
    expect(parseArgs(['--min-launches', 'lots']).errors).toHaveLength(1);
    expect(parseArgs(['--wat']).errors[0]).toMatch(/unknown argument/);
    expect(parseArgs(['--deploy', '--verify']).errors[0]).toMatch(/separate steps/);
    // The dry run is the default, and naming it explicitly must not be an error.
    expect(parseArgs(['--dry-run']).errors).toEqual([]);
    expect(parseArgs([]).live).toBe(false);
  });

  it('reads the `?limit=` strictly above the largest result the SQL can produce', () => {
    // A complete result of exactly `?limit=` rows is indistinguishable from a truncated one and is
    // refused, so the headroom is what stops a full census reading as an unprovable one.
    const plan = buildPlan(bounds, { month: '2026-07', minLaunches: null, maxRows: 5000 });
    expect(plan.resultLimit).toBeGreaterThan(plan.maxRows);
    expect(plan.parameters).toEqual({
      month_start: '2026-07-01 00:00:00',
      month_end: '2026-08-01 00:00:00',
      min_launches: String(bounds.census.minLaunches),
      max_rows: '5000',
    });
    expect(plan.refusals).toEqual([]);
  });

  it('refuses an undeployed query id and an oversized read', () => {
    const undeployed = buildPlan({ ...bounds, census: { ...bounds.census, queryId: null } }, {
      month: null,
      minLaunches: null,
      maxRows: null,
    });
    expect(undeployed.refusals.join(' ')).toMatch(/not deployed/);
    const huge = buildPlan(bounds, { month: null, minLaunches: null, maxRows: bounds.census.maxRowsCeiling + 1 });
    expect(huge.refusals.join(' ')).toMatch(/above the pinned ceiling/);
  });

  it('never writes a truncated pointer to the record\'s own evidence', () => {
    // The record is a versioned evidence contract and this string is its ONE link to the raw rows.
    // A `--out` outside the checkout is a legitimate invocation; the earlier derivation sliced at
    // `indexOf('tools/')` and wrote a single character for it, with nothing failing.
    expect(evidencePointer(join(TOOL_DIR, 'runs', '2026-07-cohort.json'))).toBe(
      'tools/creation-census/runs/2026-07-cohort.json',
    );
    for (const outside of ['/tmp/census/2026-07-cohort.json', '/2026-07-cohort.json']) {
      const pointer = evidencePointer(outside);
      expect(pointer).toBe(outside);
      expect(pointer.length).toBeGreaterThan(1);
    }
  });

  it('issues nothing at all without --live, and says the caveat anyway', async () => {
    const lines: string[] = [];
    const code = await main([], {}, (l) => lines.push(l));
    expect(code).toBe(EXIT.ok);
    const out = lines.join('\n');
    expect(out).toContain('DRY RUN');
    expect(out).toContain(PROLIFIC_CUT_CAVEAT);
    // No credential was even resolved, so a dry run works on a machine that holds no key.
    expect(out).not.toMatch(/resolved \(/);
  });

  it('exits on the credential rather than reporting an empty census', async () => {
    const lines: string[] = [];
    const code = await main(['--live'], {}, (l) => lines.push(l));
    expect(code).toBe(EXIT.credential);
    expect(lines.join('\n')).toMatch(/is not set/);
  });
});

describe('the caveat travels with the number', () => {
  it('names the floor as a prolific-ness cut, not a competence one', () => {
    // The current feed's filter looked like quality and was tempo, and that cost this project real
    // coverage. This floor is the same species of trap in a weaker form, and a caveat that lives
    // only in a doc is one a consumer never meets — so it is pinned in all four places.
    expect(PROLIFIC_CUT_CAVEAT).toContain('PROLIFIC-NESS CUT, NOT A COMPETENCE ONE');
    expect(PROLIFIC_CUT_CAVEAT).toMatch(/low-cadence deployer/);
    // Quoted verbatim in the README, allowing only for markdown blockquote wrapping — so the two
    // copies cannot drift into saying different things about the same threshold.
    const unwrapped = readFileSync(join(TOOL_DIR, 'README.md'), 'utf8')
      .replace(/^>\s?/gm, '')
      .replace(/\s+/g, ' ');
    expect(unwrapped).toContain(PROLIFIC_CUT_CAVEAT.replace(/\s+/g, ' '));
    expect(readFileSync(join(TOOL_DIR, 'bounds.json'), 'utf8')).toMatch(/PROLIFIC-NESS CUT, NOT A COMPETENCE ONE/);
    const record = buildCensusRecord({
      runAtUtc: '2026-08-04T00:00:00.000Z',
      bounds: JULY,
      parameters: { minLaunches: 30, maxRows: 5000 },
      queryId: 1,
      census: parseCensusRows(healthyRows()),
      coverage: { ok: true, reasons: [] },
      spend: { requests: 5, executions: 1, executionCeiling: 1, resultBytes: 1, estimatedExportCredits: 0 },
      cohortFile: 'x',
      savedQueryMatchedCommittedSql: true,
    });
    expect(record['caveats']).toContain(PROLIFIC_CUT_CAVEAT);
  });

  it('leaves the request ceiling able to COVER a whole successful run', () => {
    // At 40 the request ceiling bound before `maxPollAttempts` did, so an execution finishing on a
    // late poll exhausted the budget BEFORE the result read: a billed, unrecoverable execution
    // spent and its answer thrown away. The ceiling must cover 1 verify + 1 execute +
    // maxPollAttempts polls + 1 read, plus one retry of headroom.
    const bounds = readBounds();
    expect(bounds.dune.maxRequestsPerRun).toBeGreaterThanOrEqual(bounds.dune.maxPollAttempts + 4);
    expect(String(bounds.justification['dune.maxRequestsPerRun'])).toMatch(/maxPollAttempts \+ 4/);
  });

  it('gives every pinned parameter a stated reason', () => {
    // The 2026-08-02 provenance audit on the screen found eight values with no stated reason at all.
    // "No measurement backs this, and here is what would" is acceptable; inventing an anchor is not.
    const bounds = readBounds();
    for (const group of ['census', 'dune'] as const) {
      for (const key of Object.keys(bounds[group])) {
        const reason = bounds.justification[`${group}.${key}`];
        expect(typeof reason, `${group}.${key} has no justification`).toBe('string');
        expect(reason.length, `${group}.${key}'s justification is a stub`).toBeGreaterThan(80);
      }
    }
    // And nothing may quote curve_last_tx_s, which is a non-timing.
    expect(JSON.stringify(bounds.justification)).not.toContain('curve_last_tx_s');
  });

  it('replaces the stale slot-exhaustion claim with something re-checkable', () => {
    // The recorded reason this census went unbuilt was that the free tier's ten private query slots
    // were full. The account held eight. Whatever replaces that sentence must not be another count
    // the next reader has to trust — so the justification names the call that establishes it, and
    // `readSavedQueries` is what runs before anything is created.
    const bounds = readBounds();
    const reason = String(bounds.justification['census.queryId']);
    expect(reason).toMatch(/re-checkable/i);
    expect(reason).toContain('/api/v1/queries');
    expect(bounds.census.queryId).toBe(8214953);
    for (const file of ['bounds.json', 'README.md']) {
      const text = readFileSync(join(TOOL_DIR, file), 'utf8');
      expect(text, `${file} must not restate the stale claim as current`).not.toMatch(
        /the (free tier's )?ten private query slots are\s+full\b(?!.{0,400}held (eight|8))/s,
      );
    }
  });
});

describe('the committed run is evidence, and it still agrees with itself', () => {
  const recordPath = join(TOOL_DIR, 'runs', '2026-07-census.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const cohort = readDuneResultFile(readFileSync(join(TOOL_DIR, 'runs', '2026-07-cohort.json'), 'utf8'), 'committed');

  it('pins the exact key set the record carries for its schema version', () => {
    // A versioned contract: bump, never retro-edit. A reader version-detects, so a record whose
    // version defines a key set must carry that block — the VERSION decides whether to assert,
    // never the block's presence.
    expect(record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(Object.keys(record).sort()).toEqual(
      [
        'caveats',
        'census',
        'cohortFile',
        'coverage',
        'dune',
        'month',
        'monthEndUtc',
        'monthStartUtc',
        'parameters',
        'reconciliation',
        'runAtUtc',
        'schemaVersion',
        'tool',
      ].sort(),
    );
    expect(Object.keys(record.reconciliation).sort()).toEqual(
      [
        'agrees',
        'cut',
        'floor',
        'measured',
        'note',
        'publishedAtOtherFloors',
        'publishedAtThisFloor',
        'source',
      ].sort(),
    );
    expect(Object.keys(record.coverage).sort()).toEqual(['ok', 'reasons', 'tables']);
    expect(Object.keys(record.census).sort()).toEqual(
      ['capped', 'declaredTotal', 'deployersReturned', 'launchesInMonth', 'refusedByShape', 'unreadableRows'].sort(),
    );
    for (const table of record.coverage.tables) {
      expect(Object.keys(table).sort()).toEqual(
        ['bracketsMonth', 'firstRowUtc', 'lastRowUtc', 'rowsInMonth', 'table'].sort(),
      );
    }
  });

  it('re-derives its own numbers from the cohort file it names', () => {
    const reparsed = parseCensusRows(cohort);
    expect(reparsed.declaredTotal).toBe(record.census.declaredTotal);
    expect(reparsed.deployers.length).toBe(record.census.deployersReturned);
    expect(reparsed.unreadableRows).toBe(0);
    expect(reparsed.refusedByShape).toBe(0);
    expect(summariseLaunches(reparsed.deployers)).toEqual(record.census.launchesInMonth);
    const verdict = assessCensusCoverage({
      census: reparsed,
      monthStartMs: Date.parse(record.monthStartUtc),
      monthEndMs: Date.parse(record.monthEndUtc),
    });
    expect(verdict.ok).toBe(true);
    expect(record.coverage.ok).toBe(true);
  });

  it('re-asserts that both source tables START WELL BEFORE the month it read', () => {
    // Measured, not assumed — the investigation's figures reproduced through the shipped probe.
    // `pump_call_create_v2` is absent from the union for exactly this reason and is probed nowhere.
    const byTable = Object.fromEntries(record.coverage.tables.map((t: any) => [t.table, t]));
    expect(Object.keys(byTable).sort()).toEqual([...CENSUS_TABLES].sort());
    expect(byTable['evt_createevent'].firstRowUtc).toBe('2024-04-26T09:55:52.000Z');
    expect(byTable['call_create'].firstRowUtc).toBe('2024-01-14T12:57:12.000Z');
    for (const t of record.coverage.tables) {
      expect(t.bracketsMonth, `${t.table} must bracket the month it was read for`).toBe(true);
      expect(Date.parse(t.firstRowUtc)).toBeLessThan(Date.parse(record.monthStartUtc));
      expect(Date.parse(t.lastRowUtc)).toBeGreaterThan(Date.parse(record.monthEndUtc));
    }
  });

  it('was not capped, and cost one execution', () => {
    expect(record.census.capped).toBe(false);
    expect(record.dune.executions).toBe(1);
    expect(record.dune.executions).toBeLessThanOrEqual(record.dune.executionCeiling);
    expect(record.dune.queryId).toBe(readBounds().census.queryId);
    expect(record.dune.savedQueryMatchedCommittedSql).toBe(true);
  });

  it('found the one deployer this repository independently knows is competent', () => {
    // Not a verdict — a census answers WHO CREATED and nothing else. It is a check that the method
    // reaches a real operator without being told about it: `7ufmve7Z…` is the screen's known
    // control and it falls out of the census unprompted.
    const wallets = new Map(parseCensusRows(cohort).deployers.map((d) => [d.wallet, d.launchesInMonth]));
    expect(wallets.get(WALLET_A)).toBeGreaterThan(0);
    // And the widening is real: the wallet decision 187a names is present and is NOT in the
    // committed vendor ledger.
    expect(wallets.get(WALLET_B)).toBeGreaterThan(0);
    const ledger = JSON.parse(
      readFileSync(fileURLToPath(new URL('../tools/deployer-screen/feed/ledger.json', import.meta.url)), 'utf8'),
    );
    const known = new Set(Object.keys(ledger.wallets));
    expect(known.has(WALLET_A)).toBe(true);
    expect(known.has(WALLET_B)).toBe(false);
    const unseen = [...wallets.keys()].filter((w) => !known.has(w)).length;
    expect(unseen).toBeGreaterThan(wallets.size * 0.9);
  });
});

describe('every count states which cut produced it', () => {
  // The headline authorising this lane is 10,280 deployers creating in 2026-07; a run at the pinned
  // floor returns 3,036. Both are right and they are ONE census at two floors — but a figure that
  // looks measured while measuring something else is this repository's characteristic defect, so
  // the comparison is computed into the record rather than left for a reader to make.
  it('reconciles a run against the published ladder at the SAME floor', () => {
    const r = reconcileWithPublished({ month: '2026-07', minLaunches: 30, declaredTotal: 3036 });
    expect(r.agrees).toBe(true);
    expect(r.publishedAtThisFloor).toBe(3036);
    expect(r.note).toMatch(/SAME census at LOWER floors/);
    // The larger figure must be named as the same census at a lower floor, not as a rival number.
    expect(r.note).toContain('10280 at >=8');
    // And the record's own ladder cannot re-derive it, which the note has to say rather than imply.
    expect(r.note).toMatch(/CANNOT re-derive the lower rungs/);
  });

  it('says DISAGREES when a closed past month moves at the same floor', () => {
    const r = reconcileWithPublished({ month: '2026-07', minLaunches: 30, declaredTotal: 2900 });
    expect(r.agrees).toBe(false);
    expect(r.note).toMatch(/DISAGREES/);
    expect(r.note).toMatch(/backfilled or reprocessed|no longer the one that produced/);
  });

  it('claims no check it cannot make', () => {
    // A floor with no published rung, and a month with no ladder at all, both reconcile against
    // NOTHING — stated as `null`, never as agreement.
    const noRung = reconcileWithPublished({ month: '2026-07', minLaunches: 25, declaredTotal: 4000 });
    expect(noRung.agrees).toBeNull();
    expect(noRung.note).toMatch(/NOT\s+a check on it/);
    const noMonth = reconcileWithPublished({ month: '2025-05', minLaunches: 30, declaredTotal: 10 });
    expect(noMonth.agrees).toBeNull();
    expect(noMonth.publishedAtOtherFloors).toEqual([]);
    expect(PUBLISHED_LADDER_SOURCE).toContain('slot-zero-discovery-widen-operations');
  });

  it('states the cut in full, including what does NOT enter it', () => {
    const r = reconcileWithPublished({ month: '2026-07', minLaunches: 30, declaredTotal: 3036 });
    expect(r.cut).toContain('SIGNED');
    expect(r.cut).toContain('deduped by mint');
    expect(r.cut).toMatch(/No bonding, completion, recency or "still active" term/);
    expect(r.cut).toContain('30');
  });

  it('carries the investigation\'s whole ladder, so the headline is re-findable', () => {
    expect(PUBLISHED_LADDER['2026-07'][8]).toBe(10280);
    expect(PUBLISHED_LADDER['2026-07'][30]).toBe(3036);
    expect(PUBLISHED_LADDER['2026-01'][8]).toBe(13298);
  });

  it('is stated in the committed record and reconciles clean there', () => {
    const record = JSON.parse(readFileSync(join(TOOL_DIR, 'runs', '2026-07-census.json'), 'utf8'));
    expect(record.reconciliation.agrees).toBe(true);
    expect(record.reconciliation.measured).toBe(record.census.declaredTotal);
    expect(record.reconciliation.floor).toBe(record.parameters.min_launches);
    expect(record.reconciliation.publishedAtOtherFloors).toContainEqual({ floor: 8, deployers: 10280 });
  });
});

describe('the boundary holds around this tool', () => {
  it('opens a socket in exactly one file', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/creation-census/')) {
      if (file === 'tools/creation-census/client.mjs') continue;
      expect(/\bfetch\s*\(/.test(text), `${file} must not call fetch directly`).toBe(false);
    }
  });

  it('reaches exactly one host, and never a metered or dead one', () => {
    const urls = new Set<string>();
    for (const text of readAll(TOOL_DIR, 'tools/creation-census/', /\.(mjs|js)$/).values()) {
      for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) urls.add(m[0]);
    }
    expect([...urls]).toEqual(['https://api.dune.com']);
    expect(DUNE_API_BASE.startsWith('https://api.dune.com/')).toBe(true);
    for (const [file, text] of readAll(TOOL_DIR, 'tools/creation-census/', /\.(mjs|js|md|json)$/)) {
      // `solana-rpc.publicnode.com` 403s this repository's clients on every request and the retry
      // backoff hides it. Neither metered vendor is needed here and neither may be reached.
      expect(/https?:\/\/[^\s'"]*publicnode/.test(text), `${file} must not build a publicnode URL`).toBe(false);
      expect(/https?:\/\/[^\s'"]*(madeonsol|helius)/i.test(text), `${file} must not reach a metered host`).toBe(false);
    }
  });

  it('holds no key-shaped string and assigns no credential, in any committed file', () => {
    // EVERY committed file, not just the sources: bounds.json, README.md and runs/*.json are the
    // likeliest places a real key gets pasted by accident. The Dune key is 32 alphanumerics, which
    // is exactly the shape of a Solana address — and this tool's evidence file is 3,000 of those —
    // so what is asserted is the shape of an accidental PASTE rather than the key itself.
    const all = readAll(TOOL_DIR, 'tools/creation-census/', /./);
    expect([...all.keys()]).toContain('tools/creation-census/README.md');
    expect([...all.keys()]).toContain('tools/creation-census/bounds.json');
    expect([...all.keys()].some((f) => f.startsWith('tools/creation-census/runs/'))).toBe(true);
    for (const [file, text] of all) {
      expect(KEY_SHAPED.test(text), `${file} may contain a real key`).toBe(false);
      expect(
        /(?:MADEONSOL_API_KEY|HELIUS_API_KEY|DUNE_API_KEY)\s*=\s*['"`]?[A-Za-z0-9_-]{12,}/.test(text),
        `${file} may assign a real key to a credential variable`,
      ).toBe(false);
      const literalHeader = /['"`]?x-dune-api-key['"`]?\s*:\s*['"`][A-Za-z0-9]{8,}/i;
      expect(literalHeader.test(text), `${file} may hard-code a Dune credential header`).toBe(false);
    }
  });

  it('does not import src/, analysis/ or another tool, and is not imported by them', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/creation-census/')) {
      expect(text, `${file} must not import from src/`).not.toMatch(/from\s+['"](\.\.\/)+src\//);
      expect(text, `${file} must not import from analysis/`).not.toMatch(/from\s+['"].*analysis\//);
      // The duplication with tools/arrival-rate-walk/ is deliberate and is asserted at the top of
      // this file instead: that lane is keyless throughout and must not gain a dependency on a
      // directory that holds a credential.
      expect(text, `${file} must not import from another tool`).not.toMatch(
        /from\s+['"][^'"]*(deployer-screen|graduated-life-tape|arrival-rate-walk|window-decay-tripwire)/,
      );
    }
    for (const [file, text] of readAll(SRC_DIR, 'src/')) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
  });

  it('ships its method and its bounds beside the code', () => {
    const files = [...readAll(TOOL_DIR, 'tools/creation-census/', /./).keys()];
    expect(files).toContain('tools/creation-census/README.md');
    expect(files).toContain('tools/creation-census/bounds.json');
    const readme = readFileSync(join(TOOL_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/## What this tool cannot answer/);
    expect(readme).toMatch(/re-checkable/i);
  });
});
