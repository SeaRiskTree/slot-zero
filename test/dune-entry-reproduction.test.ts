/**
 * The Dune entry statement, its custody, and the reproduction that promoted it from a claim to a
 * measurement. Gate 3 precondition 1, 2026-08-05.
 *
 * **Nothing here reaches the network.** Every client is built with the `fetchImpl` seam, and the one
 * test that reads a live figure reads it from the COMMITTED run record rather than by asking Dune.
 *
 * Three things are pinned, and the second is the one this file exists for:
 *
 * 1. **The statement carries captain decision 256a's union**, names its venue on every row, and does
 *    not contain the epoch arithmetic that was measured to fail a billed execution outright.
 * 2. **Custody precedes the spend, and THE ASSERTION THAT SAYS SO CAN FAIL.** An assertion that
 *    cannot fail is the defect this repo keeps finding — 261a's deny-list passed a module named
 *    exactly what the decision prescribed — so the ordering predicate is driven twice: once over the
 *    production runner, and once over a deliberately execute-first runner built from the same
 *    primitives, where it is asserted to REFUSE. A guard is only a guard if it is shown failing.
 * 3. **The committed record meets the bar**: 0 closure mismatches and a max realised error under
 *    1e-6 SOL, `stage0.mjs`'s own. The 5e-07 recorded elsewhere in this repo is a MEASURED RESULT
 *    from the tape-sourced leg and is deliberately not used as a threshold here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DuneClient } from '../tools/deployer-screen/client.mjs';
import { assertSavedQueryMatches, describeExecutionError, executeAndRead } from '../tools/deployer-screen/dune.mjs';
import {
  ENTRY_QUERY_ID,
  ENTRY_SQL,
  committedEntryQuery,
  duneRowsToWindow,
  entryQueryParameters,
} from '../tools/deployer-screen/dune-fills.mjs';
import {
  ESTIMATED_BYTES_PER_ROW,
  NO_TRIM_SLOT_SPAN,
  REFUTED_REFERENCE_PAIRS,
  SCAN_MARGIN_MS,
  WORST_CASE_CREDITS_PER_EXECUTION,
  type CustodyCall,
  compareReproduction,
  custodyOrderVerdict,
  duneLaunchFrom,
  entrySqlFingerprint,
  estimateReproductionCredits,
  fieldEntrantsDisagree,
  parseArgs,
  planReproduction,
  readTapeLaunches,
  recordCustody,
  runReproduction,
  scanWindowFor,
} from '../tools/deployer-screen/dune-reproduction.mjs';

const KEY = 'x'.repeat(32);
const TOOL_DIR = join(import.meta.dirname, '..', 'tools', 'deployer-screen');
const DATA_DIR = join(import.meta.dirname, '..', 'data', 'population-tape-2026-07-29');
const RECORD_PATH = join(TOOL_DIR, 'measurements', '2026-08-05-dune-entry-reproduction', 'reproduction.json');
const MINT = '13JbNUE6PUmkhda8YyfMaHqUnYYYvtq1Tgp9SJjepump';
const OTHER_MINT = '3BhUv3FtuuqBgM1n6yYEhEvQ78dpdR99v4frjmXUpump';
const BOUNDS = { pollIntervalMs: 0, maxPollAttempts: 3, maxResultRows: 40_000 };

/**
 * The statement's EXECUTABLE half — every line that is not a `--` comment.
 *
 * Every "the statement must NOT contain X" assertion below runs over this rather than over the raw
 * text, and the reason is the same one `executableHalf` exists for in the screen's own test file:
 * this statement's comments NAME the things it refuses — the dex_solana model that came back 48%
 * short, the two quote columns that matched nothing, the epoch form that failed a billed execution
 * — because that is where the traps are written down. Asserting over the raw text would make the
 * documentation unwritable, and a rule that forbids explaining a trap is not a rule worth having.
 */
const sqlCode = ENTRY_SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

/** One statement row, in the shape the projection returns it. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mint: MINT,
    block_slot: 100,
    tx_index: 1,
    outer_instruction_index: 5,
    inner_instruction_index: 7,
    tx_id: 'a'.repeat(88),
    trader_id: 'b'.repeat(43),
    is_buy: true,
    venue: 'pump',
    sol_raw: '1000000000',
    token_raw: '1000000',
    ts_unix: 1_700_000_000,
    ...over,
  };
}

function resultBody(rows: unknown[]): Response {
  return new Response(
    JSON.stringify({
      execution_ended_at: '2026-08-05T20:00:00.000000Z',
      result: { rows, metadata: { total_row_count: rows.length, total_result_set_bytes: rows.length * 230 } },
    }),
    { status: 200 },
  );
}

/**
 * A vendor that answers the four calls a batch makes, and lets a test move the SQL it serves.
 *
 * `savedSql` is a function rather than a value so a test can make the saved query disagree with the
 * committed text — which is the whole failure custody exists to catch.
 */
function stub(opts: { savedSql?: () => string; rows?: unknown[] } = {}) {
  const savedSql = opts.savedSql ?? (() => ENTRY_SQL);
  const rows = opts.rows ?? [row()];
  const paths: string[] = [];
  let executions = 0;
  const impl = async (url: unknown) => {
    const path = String(url);
    paths.push(path);
    if (path.endsWith(`/query/${ENTRY_QUERY_ID}`)) {
      return new Response(JSON.stringify({ query_sql: savedSql() }), { status: 200 });
    }
    if (path.includes(`/query/${ENTRY_QUERY_ID}/execute`)) {
      executions += 1;
      return new Response(JSON.stringify({ execution_id: `e${executions}` }), { status: 200 });
    }
    if (path.includes('/status')) {
      return new Response(JSON.stringify({ state: 'QUERY_STATE_COMPLETED' }), { status: 200 });
    }
    if (path.includes('/results')) return resultBody(rows);
    return new Response('not found', { status: 404 });
  };
  return { impl, paths };
}

function client(impl: (url: unknown) => Promise<Response>, maxExecutions = 4) {
  return new DuneClient({
    key: KEY,
    maxExecutions,
    maxRequests: 200,
    minIntervalMs: 0,
    fetchImpl: impl as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
}

function batchOf(mints: string[]) {
  return [
    {
      month: '2026-04',
      launches: mints.map((mint, i) => ({
        mint,
        symbol: `s${i}`,
        createdAtMs: Date.parse('2026-04-07T13:27:14.000Z'),
        windowMs: 60_000,
        tapeFills: 10,
      })),
      plannedRows: 10 * mints.length,
    },
  ];
}

/**
 * **These are text checks over `ENTRY_SQL`, and that cost was weighed and ACCEPTED rather than
 * missed.** A behaviour-preserving rewrite of the statement — aliasing a table in a CTE, reflowing
 * the projection — breaks them while changing nothing the vendor computes.
 *
 * They are kept because the statement is executed by a VENDOR: there is no local consumer to assert
 * semantics against without spending credits on every test run, and the committed text is itself the
 * custody surface — `assertSavedQueryMatches` compares this exact string against saved query 8235460
 * before an execution is billed. What each assertion pins is a trap that cost money or a measurement
 * to find, named so a rewrite has to meet it deliberately.
 *
 * **The acceptance is safe because the record now BINDS to the statement text.** `entrySqlSha256`
 * ties the committed measurement to `normaliseSql(ENTRY_SQL)`, so an edit turns the "the bar is met
 * over 235 launches" block below red rather than leaving it green over a statement it never saw —
 * a stronger drift guard than any of these substrings was going to be.
 */
describe('the committed statement — captain decision 256a, and the arithmetic that failed a bill', () => {
  it('unions BOTH venues, because 18 launches of the tape have their tail on the AMM', () => {
    // The union is the whole reason those 18 windows are measurable. Reading the curve alone returns
    // them SHORT, and a short window loses late sells first — so wallets that closed read as open
    // and their realised P&L leaves the field rather than disagreeing with it.
    expect(ENTRY_SQL).toContain('pumpdotfun_solana.base_trades');
    expect(ENTRY_SQL).toContain('pumpdotfun_solana.pump_amm_evt_buyevent');
    expect(ENTRY_SQL).toContain('pumpdotfun_solana.pump_amm_evt_sellevent');
    // And the venue is SELECTED, not inferred. `parseDuneTradeRow` refuses a row without it; a
    // statement that stopped emitting it would refuse every row rather than mislabel one, but the
    // failure would then read as an outage instead of as a projection change.
    expect(ENTRY_SQL).toMatch(/'pump' AS venue/);
    expect(ENTRY_SQL).toMatch(/'pump_amm' AS venue/);
    expect(ENTRY_SQL).toMatch(/f\.venue/);
  });

  it('does NOT read the AMM through dex_solana, which was MEASURED 48% short', () => {
    // `pumpswap_solana.base_trades` is a view over a backfill that INNER JOINs each swap to a
    // matching SPL transfer inside a bounded instruction-index band; where the join finds nothing
    // the swap is dropped, silently. The first whole-tape run read it and got 5,444 of the tape's
    // 10,476 AMM fills across all 18 launches, while missing zero curve fills. Pinned as a name
    // rather than as prose because the dex_solana table is the one a reader reaches for first.
    expect(sqlCode).not.toContain('pumpswap_solana.base_trades');
    expect(sqlCode).not.toContain('dex_solana.base_trades');
  });

  it('takes the AMM quote from the user_ columns, the only ones that matched the tape', () => {
    // BuyEvent carries three quote amounts and only `user_quote_amount_in` is the SOL the wallet
    // actually parted with (base + LP fee + protocol fee). Matched 198/198 on one launch where the
    // other two matched 0/198 — so the wrong column here is not an approximation, it is a different
    // number on every AMM fill.
    expect(ENTRY_SQL).toContain('b.user_quote_amount_in AS sol_raw');
    expect(ENTRY_SQL).toContain('s.user_quote_amount_out, s.base_amount_in');
    expect(sqlCode).not.toContain('quote_amount_in_with_lp_fee');
    expect(sqlCode).not.toContain('quote_amount_out_without_lp_fee');
  });

  it('keeps one side of every row WSOL, so a lamport field can never hold a USDC amount', () => {
    // The bonding curve only trades against SOL. A PumpSwap pool need not, and that asymmetry is
    // exactly where the union could go wrong quietly. On the AMM half the guard sits on the POOL,
    // because the event carries a pool and not a mint.
    const wsol = 'So11111111111111111111111111111111111111112';
    expect(ENTRY_SQL).toContain(`AND (c.token_sold_mint_address = '${wsol}'`);
    expect(ENTRY_SQL).toContain(`OR c.token_bought_mint_address = '${wsol}')`);
    expect(ENTRY_SQL).toContain(`WHERE p.quote_mint = '${wsol}'`);
  });

  it('scales no amount in SQL — the reader owns the decimals', () => {
    // Dividing in Trino puts a double rounding between the chain and the comparison and makes exact
    // agreement with a committed fill tape unprovable. The only division in the statement is the
    // epoch conversion in the `windows` CTE, which is on the parameter and not on an amount.
    const projection = sqlCode.slice(sqlCode.indexOf('), curve AS ('));
    expect(projection).not.toMatch(/(sol_raw|token_raw)\s*\/|\/\s*(1e9|1000000|pow\()/);
    expect(ENTRY_SQL).toContain('CAST(f.sol_raw AS varchar)');
    expect(ENTRY_SQL).toContain('CAST(f.token_raw AS varchar)');
  });

  it('does NOT use the epoch arithmetic that was measured to fail a billed execution', () => {
    // MEASURED 2026-08-05: date_add('millisecond', <epoch ms>, TIMESTAMP '1970-01-01') fails the
    // whole execution with "integer overflow", and an execution is billed whether or not it
    // succeeds. This is pinned rather than left to memory because the overflowing form is the one a
    // reader reaches for first, and the failure costs money to rediscover.
    expect(sqlCode).not.toContain("date_add('millisecond'");
    expect(ENTRY_SQL).toContain('from_unixtime(');
    // And the output side stays timezone-free, so a committed statement cannot change meaning with
    // a session setting while its text — and therefore its custody — stays identical.
    expect(ENTRY_SQL).toContain("date_diff('second', TIMESTAMP '1970-01-01 00:00:00', f.block_time)");
  });

  it('names its own committed home, so a browser reader can find the text it must match', () => {
    expect(ENTRY_SQL).toContain('ENTRY_SQL in tools/deployer-screen/dune-fills.mjs');
  });
});

describe('the parameter builder — a mint reaches a single-quoted SQL literal', () => {
  it('refuses an address that is not base58-shaped, and THROWS rather than dropping it', () => {
    // The rule binds wherever a vendor-derived address reaches a query language (dune.mjs ->
    // WALLET_SHAPE; the arrival-rate walk carries its own copy). It throws because a silently
    // shortened batch is a result that is complete-looking and short, which is the failure this
    // whole route is written against.
    expect(() => entryQueryParameters([{ mint: "x'; DROP", fromMs: 1, toMs: 2 }])).toThrow(/base58-shaped/);
    expect(() => entryQueryParameters([])).toThrow(/at least one/);
    expect(() => entryQueryParameters([{ mint: MINT, fromMs: 5, toMs: 4 }])).toThrow(/not a window/);
  });

  it('derives the partition hull FROM the batch, so the two cannot disagree', () => {
    const p = entryQueryParameters([
      { mint: MINT, fromMs: Date.parse('2026-04-07T13:27:09.000Z'), toMs: Date.parse('2026-04-07T13:28:14.000Z') },
      { mint: OTHER_MINT, fromMs: Date.parse('2026-04-20T00:00:00.000Z'), toMs: Date.parse('2026-04-20T00:05:00.000Z') },
    ]);
    expect(p.launches).toBe(
      `${MINT}:1775568429000:1775568494000,${OTHER_MINT}:1776643200000:1776643500000`,
    );
    expect(p.scan_from).toBe('2026-04-07 13:27:09.000');
    expect(p.scan_to).toBe('2026-04-20 00:05:00.000');
  });

  it('committedEntryQuery assembles the ONE-launch predicate Gate 3 will inject', () => {
    // `committedEntryQuery` is called by nothing today — screen.mjs injects no query and the
    // reproduction suite drives ENTRY_QUERY_ID/ENTRY_SQL/entryQueryParameters directly, because it
    // batches many windows into one execution while this builds the single-launch predicate a
    // production `readWindow` needs. Gate 3's wiring is its first caller.
    //
    // Unreached is acceptable; UNEXERCISED is not. An exported seam no test drives is the same shape
    // as a reading computed twice and checked once — it compiles, it looks maintained, and the first
    // caller finds out whether it works. So it is driven here, at zero cost.
    const query = committedEntryQuery();
    expect(query.id).toBe(ENTRY_QUERY_ID);
    expect(query.sql).toBe(ENTRY_SQL);

    const ref = { mint: MINT } as Parameters<typeof query.parameters>[0];
    const scan = { fromMs: Date.parse('2026-04-07T13:27:09.000Z'), toMs: Date.parse('2026-04-07T13:28:14.000Z'), requests: 0 };
    const p = query.parameters(ref, scan);
    // ONE launch, and it is the launch asked about — batching is the caller's, never this builder's.
    expect(p.launches).toBe(`${MINT}:1775568429000:1775568494000`);
    // And the hull collapses onto that single window rather than widening past it.
    expect(p.scan_from).toBe('2026-04-07 13:27:09.000');
    expect(p.scan_to).toBe('2026-04-07 13:28:14.000');
    // The guards travel with it: a mint that is not base58-shaped never reaches the SQL literal.
    expect(() => query.parameters({ mint: "x'; DROP" } as typeof ref, scan)).toThrow(/base58-shaped/);
  });
});

describe('CUSTODY — the comparison precedes the spend, and this assertion can fail', () => {
  it('states the property over a call log rather than over source order', () => {
    const verified: CustodyCall[] = [
      { kind: 'saved-query-read', queryId: ENTRY_QUERY_ID },
      { kind: 'execute', queryId: ENTRY_QUERY_ID },
      { kind: 'execute', queryId: ENTRY_QUERY_ID },
    ];
    expect(custodyOrderVerdict(verified).ok).toBe(true);
    // A refusal costs nothing, and a log with no execution passes vacuously — that IS the property.
    expect(custodyOrderVerdict([{ kind: 'saved-query-read', queryId: ENTRY_QUERY_ID }]).ok).toBe(true);
    expect(custodyOrderVerdict([]).ok).toBe(true);
    // Verifying afterwards is a receipt for a bill already incurred, not custody.
    const after: CustodyCall[] = [
      { kind: 'execute', queryId: ENTRY_QUERY_ID },
      { kind: 'saved-query-read', queryId: ENTRY_QUERY_ID },
    ];
    expect(custodyOrderVerdict(after).ok).toBe(false);
    // And verifying one id while executing another has checked nothing.
    const wrongId: CustodyCall[] = [
      { kind: 'saved-query-read', queryId: 1 },
      { kind: 'execute', queryId: 2 },
    ];
    expect(custodyOrderVerdict(wrongId).ok).toBe(false);
  });

  it('the production runner reads the saved query BEFORE its first execution', async () => {
    const { impl, paths } = stub();
    const { client: recorded, log } = recordCustody(client(impl));
    await runReproduction(recorded, { batches: batchOf([MINT]), bounds: BOUNDS });
    expect(custodyOrderVerdict(log).ok).toBe(true);
    // Belt and braces on the wire itself: the saved-query read is the first request of the run.
    expect(paths[0]).toBe(`https://api.dune.com/api/v1/query/${ENTRY_QUERY_ID}`);
    expect(paths.findIndex((p) => p.includes('/execute'))).toBeGreaterThan(0);
  });

  it('THE MUTATION PROOF: the same predicate REFUSES an execute-first runner', async () => {
    // The requirement, stated exactly: demonstrate that this assertion can fail. So the ordering is
    // inverted here — the same two primitives, `executeAndRead` then `assertSavedQueryMatches`,
    // which is what a careless refactor of `runReproduction` produces — and the SAME
    // `custodyOrderVerdict` is asked about it. If it passed this, it would be proving nothing about
    // the runner above.
    const { impl } = stub();
    const { client: recorded, log } = recordCustody(client(impl));
    const executeFirst = async () => {
      const parameters = entryQueryParameters(batchOf([MINT])[0]!.launches.map(scanWindowFor));
      await executeAndRead(recorded, ENTRY_QUERY_ID, parameters, BOUNDS);
      await assertSavedQueryMatches(recorded, ENTRY_QUERY_ID, ENTRY_SQL);
    };
    await executeFirst();

    const verdict = custodyOrderVerdict(log);
    expect(verdict.ok, 'the predicate must REFUSE an execute-first run').toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/billed before its committed text had been compared/);
    // And the wire agrees: the bill came first.
    expect(log[0]!.kind).toBe('execute');
  });

  it('a repo/saved-query disagreement refuses the WHOLE leg terminally and costs NOTHING', async () => {
    const { impl } = stub({ savedSql: () => `${ENTRY_SQL}\n-- edited from a browser` });
    const c = client(impl);
    const { client: recorded, log } = recordCustody(c);
    await expect(runReproduction(recorded, { batches: batchOf([MINT]), bounds: BOUNDS })).rejects.toThrow(
      /no longer matches the SQL committed/,
    );
    // The deliverable: zero executions. An execution is billed whether or not its answer is used.
    expect(c.executions()).toBe(0);
    expect(c.resultBytes()).toBe(0);
    expect(log.some((call) => call.kind === 'execute')).toBe(false);
    expect(custodyOrderVerdict(log).ok).toBe(true);
  });

  it('COUNTS a row returned for a mint the run did not ask about, and fails on it', async () => {
    // The claim this closes used to be a comment saying such a row "surfaces as a row-count
    // disagreement". It does not: an unasked mint lands in no launch's bucket, so every launch the
    // run DID ask about still matches the tape exactly, and the run passes while the vendor answers
    // a question nobody asked. Only a counter sees it — so the counter is shown SEEING it here,
    // rather than pinned at the zero the real run happens to produce.
    const asked = row();
    const stranger = row({ mint: OTHER_MINT });
    const noMintAtAll = row({ mint: undefined });
    const { impl } = stub({ rows: [asked, stranger, noMintAtAll, 'not an object'] });
    const { unplacedRows, rowsByMint } = await runReproduction(client(impl), {
      batches: batchOf([MINT]),
      bounds: BOUNDS,
    });
    // Two unplaceable rows and one unreadable one; only the asked-for mint was kept.
    expect(unplacedRows).toBe(3);
    expect(rowsByMint.get(MINT)).toHaveLength(1);
    expect(rowsByMint.has(OTHER_MINT)).toBe(false);
  });

  it('places every row when the statement answers only what was asked', async () => {
    // The other side of the same property: the counter must not fire on a well-behaved result, or a
    // passing run would carry a permanent false alarm.
    const { impl } = stub({ rows: [row(), row({ tx_index: 2 })] });
    const { unplacedRows, rowsByMint } = await runReproduction(client(impl), {
      batches: batchOf([MINT]),
      bounds: BOUNDS,
    });
    expect(unplacedRows).toBe(0);
    expect(rowsByMint.get(MINT)).toHaveLength(2);
  });

  it('and that refusal is not an artefact of the fixture — the same stub executes when it matches', async () => {
    // Without this, "zero executions" above would also hold for a stub that simply cannot execute,
    // and the test would pass against a broken harness. Same stub, same runner, matching text.
    const { impl } = stub();
    const c = client(impl);
    await runReproduction(c, { batches: batchOf([MINT]), bounds: BOUNDS });
    expect(c.executions()).toBe(1);
  });
});

describe('the plan, and the ceiling that refuses before the first request', () => {
  it('batches within a month and never plans a result the reader would refuse as a page', () => {
    const launches = readTapeLaunches(join(TOOL_DIR, '..', '..', 'data', 'population-tape-2026-07-29'));
    expect(launches).toHaveLength(235); // reached_mint, not file existence: 239 files, four truncated
    const batches = planReproduction(launches);
    for (const b of batches) {
      expect(b.launches.length).toBeGreaterThan(0);
      const months = new Set(b.launches.map((l) => new Date(l.createdAtMs).toISOString().slice(0, 7)));
      expect(months, 'a batch that straddles months pays for both partitions').toEqual(new Set([b.month]));
      expect(b.plannedRows).toBeLessThanOrEqual(20_000);
      expect(b.plannedRows).toBe(b.launches.reduce((n, l) => n + l.tapeFills, 0));
    }
    // Every launch appears exactly once: a plan that dropped one would report completeness over a
    // population it chose.
    expect(batches.flatMap((b) => b.launches.map((l) => l.mint)).sort()).toEqual(launches.map((l) => l.mint).sort());
    // Deterministic, so two plans over the same tape are the same plan.
    expect(JSON.stringify(planReproduction(launches))).toBe(JSON.stringify(batches));
  });

  it('prices executions at the ceiling and bytes at the tape\'s own row counts', () => {
    const estimate = estimateReproductionCredits(batchOf([MINT, OTHER_MINT]));
    expect(estimate.executionCredits).toBe(WORST_CASE_CREDITS_PER_EXECUTION);
    expect(estimate.exportBytes).toBe(20 * ESTIMATED_BYTES_PER_ROW);
    expect(estimate.worstCaseCredits).toBeCloseTo(WORST_CASE_CREDITS_PER_EXECUTION + (20 * ESTIMATED_BYTES_PER_ROW * 20) / 1e6, 6);
  });

  it('defaults to a dry run, so spending is something you ask for', () => {
    // `--live` is the only way to spend, and the default opens no socket. Same contract the census
    // and the feedback loop already carry.
    expect(parseArgs([]).live).toBe(false);
    expect(parseArgs(['--live']).live).toBe(true);
    expect(parseArgs(['--months', '2026-04,2026-05']).months).toEqual(['2026-04', '2026-05']);
    expect(parseArgs(['--mints', MINT]).mints).toEqual([MINT]);
    expect(parseArgs([]).rows).toBeNull();
    expect(() => parseArgs(['--all-of-it'])).toThrow(/unknown flag/);
  });

  it('the byte ceiling is ABOVE the measured figure the run recorded, not equal to it', () => {
    // An estimate that sits on its own measurement refuses nothing. The record carries the vendor's
    // declared bytes, so this stays checkable rather than remembered.
    const record = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as {
      spend: { resultBytes: number };
      result: { duneRows: number };
    };
    const measured = record.spend.resultBytes / record.result.duneRows;
    expect(measured).toBeLessThan(ESTIMATED_BYTES_PER_ROW);
    expect(measured).toBeGreaterThan(200); // and the pin is not absurdly loose either
  });
});

describe('the row -> window path, run through the production reader', () => {
  it('refuses a window whose scan began at or after the declared mint', () => {
    // The coverage proof: an absence of older rows only means something if older rows were asked
    // for. This is the truncated backwards walk in a different costume.
    const launch = { mint: MINT, symbol: 's', createdAtMs: 1_700_000_000_000, windowMs: 60_000, tapeFills: 1 };
    const scan = scanWindowFor(launch);
    expect(launch.createdAtMs - scan.fromMs).toBe(SCAN_MARGIN_MS);
    const window = duneRowsToWindow([row()], {
      mint: MINT,
      createdAtMs: launch.createdAtMs,
      windowSlotSpan: NO_TRIM_SLOT_SPAN,
      scan: { fromMs: launch.createdAtMs, toMs: scan.toMs, requests: 0 },
    });
    expect(window.usable).toBe(false);
    expect(window.dropReason).toBe('coverage-unproven');
  });

  it('carries an AMM fill through to a measurable window, and refuses one with no venue', () => {
    const launch = { mint: MINT, symbol: 's', createdAtMs: 1_700_000_000_000, windowMs: 60_000, tapeFills: 3 };
    const rows = [
      row({ ts_unix: 1_700_000_000, sol_raw: '5000000000', token_raw: '5000000' }),
      row({ block_slot: 140, tx_index: 2, ts_unix: 1_700_000_030, venue: 'pump_amm', is_buy: false }),
    ];
    const { taped, window } = duneLaunchFrom(launch, rows);
    expect(window.usable).toBe(true);
    expect(window.fills.map((f) => f.venue)).toEqual(['pump', 'pump_amm']);
    expect(taped).not.toBeNull();
    // The no-op trim must be inert, and that is checked rather than assumed.
    expect(window.fills.length).toBe(window.rowsSeen);

    const noVenue = duneLaunchFrom(launch, [row({ venue: undefined }), row()]);
    expect(noVenue.window.usable).toBe(false);
    expect(noVenue.window.dropReason).toBe('unparsed-rows');
  });
});

describe('the structural checks GATE, and each one is shown FAILING', () => {
  /** One statement row for an arbitrary mint, timestamped inside that launch's own window. */
  function rowFor(mint: string, createdAtMs: number, over: Record<string, unknown> = {}) {
    return row({ mint, ts_unix: Math.floor(createdAtMs / 1000), ...over });
  }

  it('a launch the statement came back SHORT on fails the run', () => {
    // Short is the failure direction: a window missing its tail loses late sells first, so a wallet
    // that closed reads as open. It used to be computed, reported and ignored.
    const launch = readTapeLaunches(DATA_DIR)[0]!;
    const result = compareReproduction(DATA_DIR, [launch], new Map([[launch.mint, []]]));
    expect(result.launchesDuneShort).toBe(1);
    expect(result.failures.join(' ')).toMatch(/came back SHORT/);
    expect(result.ok).toBe(false);
    // And LONG must not gate — that is a finding about the tape's own walk, and the committed record
    // carries one (`Killswitch`) while reading `ok: true`, which the record block below asserts.
  });

  it('a launch holding a different number of field entrants than the tape fails the run', () => {
    // The gap this closes: an entrant dropped by an edit to the statement does not raise a closure
    // mismatch, does not raise `missingFromCsv` (which counts the other direction) and does not move
    // the create slot — the population simply shrinks and the suite prints a smaller PASS.
    const launch = readTapeLaunches(DATA_DIR).find((l) => l.symbol === 'Chungus')!;
    const rows = [
      rowFor(launch.mint, launch.createdAtMs),
      rowFor(launch.mint, launch.createdAtMs, { block_slot: 140, tx_index: 2, is_buy: false, trader_id: 'c'.repeat(43) }),
    ];
    // `tapeFills` is set to what was returned so the SHORT gate above cannot be what fires here.
    const result = compareReproduction(
      DATA_DIR,
      [{ ...launch, tapeFills: rows.length }],
      new Map([[launch.mint, rows]]),
    );
    expect(result.launchesDuneShort).toBe(0);
    expect(result.launches[0]!.usable).toBe(true);
    expect(result.launches[0]!.tapeFieldEntrants).toBeGreaterThan(result.launches[0]!.fieldEntrants);
    expect(result.fieldDisagreementsOnUnrefutedReferences).toBe(1);
    // BOTH readings come out of `fieldEntrantsDisagree` inside `compareReproduction`, differing only
    // in the flag — so the reported one is exercised in production use here rather than only in the
    // unit assertions below. It used to be a second, inline `fieldEntrants !== tapeFieldEntrants`
    // expression of the same predicate, which made the two numbers equal by authorship rather than
    // by construction and left the reported one covered by no production caller at all.
    expect(result.fieldDisagreements).toBe(1);
    expect(result.failures.join(' ')).toMatch(/different number of field entrants/);
    expect(result.ok).toBe(false);
  });

  it('but the gate does NOT count the pairs captain decision 293a excludes', () => {
    // The trap. The enumerated pairs are exactly where the chain refutes the TAPE's own reference,
    // so a gate that counted them would fail on the defect 293a ruled on and reverse that ruling by
    // the back door. Driven over a real excluded pair rather than an invented one.
    const excluded = REFUTED_REFERENCE_PAIRS[0]!;
    const shared = [{ wallet: 'w1' }, { wallet: 'w2' }];
    const withExcluded = [...shared, { wallet: excluded.wallet }];

    expect(fieldEntrantsDisagree(excluded.mint, shared, withExcluded, { ignoringRefutedReferences: true })).toBe(false);
    // Reported both ways, and the UNFILTERED reading still sees it — the exclusion is disclosed, not
    // hidden.
    expect(fieldEntrantsDisagree(excluded.mint, shared, withExcluded, { ignoringRefutedReferences: false })).toBe(true);
    // The exclusion is per (mint, wallet): the same wallet on another launch is not excluded.
    expect(fieldEntrantsDisagree(OTHER_MINT, shared, withExcluded, { ignoringRefutedReferences: true })).toBe(true);
    // And no wallet outside the enumerated set is ever dropped, whatever it does to the figure.
    expect(
      fieldEntrantsDisagree(excluded.mint, shared, [...shared, { wallet: 'stranger' }], {
        ignoringRefutedReferences: true,
      }),
    ).toBe(true);
  });
});

describe('the run record — the bar, met over every launch on the committed tape', () => {
  const record = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as {
    queryId: number;
    unplacedRows: number | null;
    entrySqlSha256: string;
    custody: { ok: boolean };
    result: {
      launchesPlanned: number;
      launchesMeasured: number;
      ammLaunches: number;
      ammRows: number;
      duneRows: number;
      tapeRows: number;
      launchesDuneShort: number;
      launchesDuneLong: number;
      rowCountDisagreements: number;
      createSlotDisagreements: number;
      fieldDisagreements: number;
      fieldDisagreementsOnUnrefutedReferences: number;
      ok: boolean;
      field: { pairs: number; closureMismatches: number; maxRealisedErrorSol: number; missingFromCsv: number };
      fieldOnUnrefutedReferences: {
        pairs: number;
        closureMismatches: number;
        maxRealisedErrorSol: number;
        missingFromCsv: number;
      };
      refutedReferences: { mint: string; wallet: string; disagreeingFills: number }[];
      tapeField: { pairs: number; closureMismatches: number; maxRealisedErrorSol: number };
    };
  };

  it('is bound to the STATEMENT TEXT, not merely to the saved-query id', () => {
    // The documented deploy step keeps the same id across an edit, so an id alone identifies
    // nothing: without this every assertion in this block would stay green over a record describing
    // a statement that no longer exists. Editing ENTRY_SQL turns this red until the lane is re-run.
    expect(record.entrySqlSha256).toBe(entrySqlFingerprint());
    // And the fingerprint is of the CUSTODY equivalence, not of the raw bytes — the same
    // normalisation `assertSavedQueryMatches` compares under, so a reflow the vendor comparison
    // accepts does not invalidate a measurement.
    expect(entrySqlFingerprint(`${ENTRY_SQL}\n\n`)).toBe(record.entrySqlSha256);
    expect(entrySqlFingerprint(`${ENTRY_SQL}\nAND 1 = 2`)).not.toBe(record.entrySqlSha256);
  });

  it('placed every row it was given — nothing came back for an unasked mint', () => {
    // 0 by PROOF from the run's own output rather than by assumption: the run log's per-batch
    // returned counts sum to 107,453 and the row cache it wrote holds 107,453 placed rows, so
    // returned equals placed. The measurement README records that derivation. `null` here would
    // mean NOT OBSERVED, which is not the same as clean and must not read as a pass.
    expect(record.unplacedRows).toBe(0);
  });

  it('ran the committed statement against EVERY launch the tape proved coverage for', () => {
    expect(record.queryId).toBe(ENTRY_QUERY_ID);
    expect(record.result.launchesPlanned).toBe(235);
    expect(record.result.launchesMeasured).toBe(235);
    expect(record.custody.ok).toBe(true);
  });

  it('meets the bar: 0 closure mismatches and a max realised error under 1e-6 SOL', () => {
    // stage0.mjs:389's own rule, applied to Dune-sourced fills. 1e-6 SOL is a thousandth of a
    // lamport-scale rounding; the dataset stores SOL to six decimals, so anything at or below this
    // is representation and anything above it is a different sum.
    //
    // CLOSURE IS CHECKED ON THE WHOLE POPULATION and is zero there: no exclusion is doing any work
    // on that half of the bar. The realised half reads the unrefuted population — see the block
    // below, which pins what is excluded and why.
    expect(record.result.field.closureMismatches).toBe(0);
    expect(record.result.fieldOnUnrefutedReferences.closureMismatches).toBe(0);
    expect(record.result.fieldOnUnrefutedReferences.maxRealisedErrorSol).toBeLessThan(1e-6);
    expect(record.result.fieldOnUnrefutedReferences.missingFromCsv).toBe(0);
    expect(record.result.fieldOnUnrefutedReferences.pairs).toBeGreaterThan(0);
    expect(record.result.ok).toBe(true);
  });

  it('lands on the SAME figure the tape-sourced leg does, not merely inside the bar', () => {
    // The stronger statement, and the one worth having: over the pairs whose reference the chain
    // does not refute, measuring from Dune's decoded rows and measuring from the committed fill tape
    // produce the identical max realised error. "Under 1e-6" would also be satisfied by a route that
    // was merely close; this says the two routes agree.
    expect(record.result.fieldOnUnrefutedReferences.maxRealisedErrorSol).toBe(
      record.result.tapeField.maxRealisedErrorSol,
    );
    expect(record.result.tapeField.closureMismatches).toBe(0);
    expect(record.result.createSlotDisagreements).toBe(0);
    // Both readings, and both are what `ok` was reached over: the gating one counts the entrants the
    // chain does not refute, and on this record the two coincide.
    expect(record.result.fieldDisagreements).toBe(0);
    expect(record.result.fieldDisagreementsOnUnrefutedReferences).toBe(0);
  });

  it('the exclusions are ENUMERATED, small, and the unexcluded figure ships beside them', () => {
    // The guard against an exclusion becoming a tolerance. Twelve pairs of 1,322, each named with
    // the transaction that settles it, and the all-pairs reading is in the same record — so a reader
    // who rejects the exclusion can read the number it hides (1.842 SOL) without rerunning anything.
    expect(record.result.refutedReferences).toHaveLength(12);
    expect(record.result.field.pairs - record.result.fieldOnUnrefutedReferences.pairs).toBe(12);
    expect(record.result.field.pairs).toBe(record.result.tapeField.pairs);
    expect(record.result.field.maxRealisedErrorSol).toBeGreaterThan(1);
    for (const p of record.result.refutedReferences) {
      expect(p.mint.length).toBeGreaterThan(30);
      expect(p.wallet.length).toBeGreaterThan(30);
      expect(p.disagreeingFills).toBeGreaterThan(0);
    }
  });

  it('is SHORT on no launch — the one row-count disagreement runs the other way', () => {
    // The two directions mean opposite things and are counted apart for that reason. Short is the
    // failure this route is written against: a window missing its tail loses late sells first, so a
    // wallet that closed reads as open. Long says the TAPE's own walk was short — the swap-api sheds
    // and backs off — and on the committed tape it happens once, `Killswitch`, where Dune returns 14
    // extra curve fills in the last 80 s of a 300 s window. None of them belongs to a create-slot
    // outsider, which is why the field reproduction above is unaffected.
    expect(record.result.launchesDuneShort).toBe(0);
    expect(record.result.launchesDuneLong).toBe(1);
    expect(record.result.duneRows - record.result.tapeRows).toBe(14);
  });

  it('MEASURED the 18 graduation-spanning launches rather than skipping them — decision 256a', () => {
    // Without the union these 18 windows come back short and silently. The count is the tape's own:
    // 18 launches carry at least one `pump_amm` fill, and 10,476 of the 107,439 fills are on the AMM.
    expect(record.result.ammLaunches).toBe(18);
    expect(record.result.ammRows).toBe(10_476);
  });
});

describe('a failed execution is billed, so its reason must reach the operator', () => {
  it('carries the vendor\'s own message into the refusal', async () => {
    // Captain ruling 292a: a path that spends money and then withholds the result gets closed. The
    // throw used to name the state alone, so an operator who had just paid for a failed execution
    // had to go and ask Dune separately what it objected to. This is the real message the entry
    // statement's first execution came back with.
    const impl = async (url: unknown) => {
      const path = String(url);
      if (path.endsWith(`/query/${ENTRY_QUERY_ID}`)) return new Response(JSON.stringify({ query_sql: ENTRY_SQL }), { status: 200 });
      if (path.includes('/execute')) return new Response(JSON.stringify({ execution_id: 'e1' }), { status: 200 });
      return new Response(
        JSON.stringify({
          state: 'QUERY_STATE_FAILED',
          error: { type: 'FAILED_TYPE_EXECUTION_FAILED', message: 'integer overflow [Execution ID: 01KZ]' },
        }),
        { status: 200 },
      );
    };
    await expect(
      executeAndRead(client(impl), ENTRY_QUERY_ID, { launches: 'x' }, BOUNDS),
    ).rejects.toThrow(/integer overflow/);
  });

  it('says so when Dune gives no reason, rather than eliding the failure', () => {
    expect(describeExecutionError({ state: 'QUERY_STATE_FAILED' })).toBe('Dune returned no reason for the failure.');
    expect(describeExecutionError(null)).toBe('Dune returned no reason for the failure.');
    // Shape is discovered rather than documented, so a non-string message must not throw from inside
    // the reporting path and replace a billed execution's reason with a stack trace.
    expect(describeExecutionError({ error: { message: { nested: true } } })).toBe(
      'Dune returned no reason for the failure.',
    );
    expect(describeExecutionError({ error: { type: 'T' } })).toBe('T.');
  });
});
