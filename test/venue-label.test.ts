/**
 * Tests for the venue-labelling tool. **Nothing here reaches the network and nothing here needs a
 * key** — every client is constructed with a `fetchImpl` seam and a sentinel credential, so a
 * regression that starts issuing real requests fails here rather than quietly spending 100 credits
 * a time against an allowance the deployer screen's creation walk also draws on.
 *
 * The one exception is deliberate and is the point: `runs/2026-08-07-funding-walls.json` is a real,
 * dated response, recorded from ONE live batch request through this tool's own production path. It
 * is the fixture, and it is also the artefact clause 1 of the citation rule demands — the labels and
 * the date they were read on, together, in a committed file. Every other fixture here is synthetic.
 *
 * Six kinds of assertion live here and they are not interchangeable:
 *
 * - **Boundary** — this is the repository's SIXTH network-capable directory and its THIRD keyed one.
 *   The scans below are what make "one host, one socket, one file names the credential" a property
 *   of the tree rather than a review note.
 * - **The cheap path** — both endpoints cost the same per request and one of them answers 100
 *   addresses. A planner that could ever choose the expensive path would be a 100x bill, silently.
 * - **Honesty about "unknown"** — the vendor declining to name an address is an ANSWER. A row that
 *   never arrived is not. Those two and "we could not parse it" are three different states and the
 *   tests assert they never collapse into each other.
 * - **The citation rule** — captain decision 366a made it part of the deliverable. It is asserted to
 *   reach the label row, the record, the rendered block and the dry run, because a caveat that lives
 *   only in a document is one a consumer never meets.
 * - **Spend** — a plan that does not fit is refused BEFORE the first request, every attempt is
 *   counted as billed, and a terminal status is never retried. Asserted against counting stubs.
 * - **Evidence** — the committed record is re-read and its numbers re-derived, so a record that
 *   stops agreeing with itself fails a test.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KEY_ENV_VAR,
  KEY_MAX_LENGTH,
  KEY_MIN_LENGTH,
  WALLET_API_HOST,
  describeKey,
  redactKey,
  resolveHeliusCredential,
  walletIdentityUrl,
} from '../tools/venue-label/credential.mjs';
import {
  BATCH_IDENTITY_PATH,
  CREDITS_PER_REQUEST,
  CeilingReached,
  HeliusRefused,
  IDENTITY_PATH,
  RETRY_BACKOFF_MS,
  WalletIdentityClient,
  describeHeliusStatus,
} from '../tools/venue-label/client.mjs';
import {
  ADDRESS_SHAPE,
  AUTHORITATIVE_RECORD,
  BATCH_MAX_ADDRESSES,
  CITATION_RULE,
  LABEL_SOURCE,
  RECORD_SCHEMA_VERSION,
  TAGS_CAVEAT,
  UNKNOWN_TYPE,
  VENDOR_CLAIM_CAVEAT,
  WALL_CAVEAT,
  buildRecord,
  isTypedButUnnamed,
  labelCitation,
  planLookups,
  readIdentityResponse,
  readIdentityRow,
  renderLabels,
  summariseLabels,
} from '../tools/venue-label/identity.mjs';
import {
  EXIT,
  main,
  parseAddressFile,
  parseArgs,
  readBounds,
  reportRunStopped,
} from '../tools/venue-label/label.mjs';
import { CREDENTIAL_PATTERNS, KEY_SHAPED } from './offline-guard.js';

const TOOL_DIR = fileURLToPath(new URL('../tools/venue-label/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** Passes the length band, is not URL-shaped, and appears in no committed file. */
const SENTINEL_KEY = 'SENTINELsentinel-SENTINELsentinel-abc';

const READ_AT = '2026-08-07T16:32:49.888Z';

const COINBASE = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE';
const BITSTAMP_TAGGED = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS';
const RELAY_WALL = 'Bukt1ztP1AetQPdfHKUjFp7cVJPFusCNi98bvZcL7Ug5';
const PUMPFUN_FEES = '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV';

/** The base58 alphabet — no `0`, `O`, `I` or `l`, which is exactly what the shape guard enforces. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A distinct, legitimately base58-shaped 44-character address. Synthetic; no wallet is real. */
function fakeAddress(i: number): string {
  let n = i;
  let tail = '';
  do {
    tail = B58[n % 58] + tail;
    n = Math.floor(n / 58);
  } while (n > 0);
  return 'z'.repeat(44 - tail.length) + tail;
}

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

/** A synthetic vendor row. Hand-written to the shape the API returns, never a captured payload. */
function namedRow(address: string, over: Record<string, unknown> = {}) {
  return {
    address,
    type: 'exchange',
    name: 'Coinbase Hot Wallet 11',
    category: 'Centralized Exchange',
    tags: [],
    website: 'https://www.coinbase.com/',
    ...over,
  };
}

/** A client whose every response is scripted, and which can never reach a real socket. */
function client(script: (url: string, init: RequestInit) => Response, over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
    calls.push(String(url));
    return script(String(url), init);
  });
  const c = new WalletIdentityClient({
    key: SENTINEL_KEY,
    maxRequests: 12,
    maxCredits: 1200,
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

const BOUNDS = readBounds();

const PLAN_BOUNDS = {
  maxAddressesPerRun: BOUNDS.budget.maxAddressesPerRun,
  maxRequestsPerRun: BOUNDS.budget.maxRequestsPerRun,
  maxCreditsPerRun: BOUNDS.budget.maxCreditsPerRun,
  creditsPerRequest: BOUNDS.lookup.creditsPerRequest,
  attemptsPerRequest: RETRY_BACKOFF_MS.length + 1,
};

// ---------------------------------------------------------------------------------------------

describe('the cheap path is the default, and the expensive one is unreachable', () => {
  it('resolves more than one address in batches, never one request each', () => {
    // Both endpoints cost the same per REQUEST and one of them answers 100 addresses. 100 addresses
    // one at a time is 10,000 credits; together they are 100. That is not an optimisation the caller
    // opts into — there is no configuration of this planner that produces the expensive shape.
    const many = Array.from({ length: 250 }, (_, i) => fakeAddress(i));
    const plan = planLookups(many, { ...PLAN_BOUNDS, maxAddressesPerRun: 300, maxRequestsPerRun: 99, maxCreditsPerRun: 99_000 });
    expect(plan.requests.map((r) => r.kind)).toEqual(['batch', 'batch', 'batch']);
    expect(plan.requests.map((r) => r.addresses.length)).toEqual([100, 100, 50]);
    expect(plan.credits).toBe(3 * CREDITS_PER_REQUEST);
    // The saving, stated as arithmetic rather than as a comment.
    expect(plan.addresses.length * CREDITS_PER_REQUEST).toBe(plan.credits * 250 / 3);
  });

  it('never chooses the single-address route for more than one address', () => {
    for (const n of [2, 3, 99, 100, 101]) {
      const plan = planLookups(Array.from({ length: n }, (_, i) => fakeAddress(i)), {
        ...PLAN_BOUNDS,
        maxRequestsPerRun: 99,
        maxCreditsPerRun: 99_000,
      });
      expect(plan.requests.every((r) => r.kind === 'batch'), `n=${n}`).toBe(true);
      expect(plan.requests.length, `n=${n}`).toBe(Math.ceil(n / BATCH_MAX_ADDRESSES));
    }
    // One address takes the single route, which costs exactly the same as a batch of one.
    expect(planLookups([COINBASE], PLAN_BOUNDS).requests).toEqual([{ kind: 'single', addresses: [COINBASE] }]);
  });

  it('drops duplicates rather than paying a batch slot for them', () => {
    const plan = planLookups([COINBASE, COINBASE, RELAY_WALL, COINBASE], PLAN_BOUNDS);
    expect(plan.addresses).toEqual([COINBASE, RELAY_WALL]);
    expect(plan.duplicatesDropped).toBe(2);
  });

  it('refuses an address that is not base58-shaped rather than putting it in a URL path', () => {
    // It lands inside a URL path on the single-address route. The rule is the fleet's, one vendor
    // over: an operator-supplied identifier reaching a vendor's parser is shape-checked first.
    const plan = planLookups([COINBASE, "bob'; drop--", '../../etc/passwd', ''], PLAN_BOUNDS);
    expect(plan.addresses).toEqual([COINBASE]);
    expect(plan.refusedByShape).toHaveLength(3);
    expect(ADDRESS_SHAPE.test(COINBASE)).toBe(true);
    expect(ADDRESS_SHAPE.test('0OIl' + 'x'.repeat(30))).toBe(false); // base58 excludes 0 O I l
  });
});

describe('"unknown" is the vendor\'s answer, and it is preserved as one', () => {
  it('keeps unknown as unknown, and never smooths it into a name or a blank', () => {
    const label = readIdentityRow({ address: RELAY_WALL, type: UNKNOWN_TYPE }, READ_AT);
    expect(label).not.toBeNull();
    expect(label?.type).toBe(UNKNOWN_TYPE);
    expect(label?.named).toBe(false);
    // `null`, never `''`. A blank cell reads as a name nobody typed.
    expect(label?.name).toBeNull();
    expect(label?.category).toBeNull();
    expect(label?.tags).toEqual([]);
  });

  it('folds an empty-string name to null rather than carrying a blank forward', () => {
    const label = readIdentityRow({ address: COINBASE, type: 'exchange', name: '   ' }, READ_AT);
    expect(label?.name).toBeNull();
    expect(label?.named).toBe(false);
  });

  it('keeps a type it has never seen, rather than reading it as unknown', () => {
    // A `type` the vendor invents tomorrow is still a claim it made. Reading it as unknown would
    // silently discard a label, which is the same defect as smoothing unknown into a guess.
    const label = readIdentityRow({ address: COINBASE, type: 'bridge', name: 'Wormhole' }, READ_AT);
    expect(label?.type).toBe('bridge');
    expect(label?.named).toBe(true);
  });

  it('keeps THREE states apart: named, unknown, and no answer at all', () => {
    const reading = readIdentityResponse(
      [namedRow(COINBASE), { address: RELAY_WALL, type: UNKNOWN_TYPE }, 'not a row'],
      [COINBASE, RELAY_WALL, PUMPFUN_FEES],
      READ_AT,
    );
    // Asked for and answered "I do not know" — the vendor's answer.
    expect(reading.byAddress.get(RELAY_WALL)?.named).toBe(false);
    // Asked for and never answered — OUR failure. It is NOT unknown: it was not declined.
    expect(reading.missing).toEqual([PUMPFUN_FEES]);
    expect(reading.byAddress.has(PUMPFUN_FEES)).toBe(false);
    // Present and unparseable — also ours, and counted separately again.
    expect(reading.unreadableRows).toBe(1);

    const summary = summariseLabels([COINBASE, RELAY_WALL, PUMPFUN_FEES], reading);
    expect(summary).toEqual({
      requested: 3,
      named: 1,
      unknown: 1,
      typedUnnamed: 0,
      unreadable: 1,
      missing: 1,
    });
  });

  it('keeps a FOURTH state apart: a real type with no usable name is not "unknown"', () => {
    // Captain decision 372a. The vendor answering `exchange` with no name declined nothing; it
    // answered incompletely. Counting it as unknown asserts a refusal the vendor never made.
    const typed = readIdentityRow({ address: COINBASE, type: 'exchange', name: '  ' }, READ_AT);
    expect(typed?.type).toBe('exchange');
    expect(typed?.name).toBeNull();
    expect(typed?.named).toBe(false);
    expect(isTypedButUnnamed(typed!)).toBe(true);
    // The vendor's own "unknown" is NOT this class, and a named row is neither.
    expect(isTypedButUnnamed(readIdentityRow({ address: RELAY_WALL, type: UNKNOWN_TYPE }, READ_AT)!)).toBe(false);
    expect(isTypedButUnnamed(readIdentityRow(namedRow(PUMPFUN_FEES), READ_AT)!)).toBe(false);

    const reading = readIdentityResponse(
      [
        { address: COINBASE, type: 'exchange' },
        { address: RELAY_WALL, type: UNKNOWN_TYPE },
        namedRow(PUMPFUN_FEES),
      ],
      [COINBASE, RELAY_WALL, PUMPFUN_FEES],
      READ_AT,
    );
    expect(summariseLabels([COINBASE, RELAY_WALL, PUMPFUN_FEES], reading)).toEqual({
      requested: 3,
      named: 1,
      unknown: 1,
      typedUnnamed: 1,
      unreadable: 0,
      missing: 0,
    });
  });

  it('renders a typed-but-unnamed row apart from unknown, and claims no refusal for it', () => {
    const typed = readIdentityRow({ address: COINBASE, type: 'exchange' }, READ_AT);
    const text = renderLabels([typed], [COINBASE]).join('\n');
    expect(text).toMatch(/UNNAMED\s+\(vendor type: exchange/);
    expect(text).toMatch(/incomplete answer/);
    // The three sentences that belong to the OTHER outcomes must not appear over this row.
    expect(text).not.toMatch(/declines to name/);
    expect(text).not.toMatch(/vendor type: unknown/);
    expect(text).not.toMatch(/NO ANSWER/);
    // And the genuine unknown keeps its own wording, unchanged.
    const declined = renderLabels(
      [readIdentityRow({ address: RELAY_WALL, type: UNKNOWN_TYPE }, READ_AT)],
      [RELAY_WALL],
    ).join('\n');
    expect(declined).toMatch(/declines to name/);
    expect(declined).not.toMatch(/UNNAMED/);
  });

  it('keys by address and never by position', () => {
    // The vendor answers in request order today and nothing promises it will. Reading by index
    // would attach one address's venue to another, which on this surface is the worst failure
    // available — a wall named as the wrong exchange looks exactly like a finding.
    const reading = readIdentityResponse(
      [namedRow(PUMPFUN_FEES, { name: 'Pump.fun AMM Fees 2', type: 'protocol' }), namedRow(COINBASE)],
      [COINBASE, PUMPFUN_FEES],
      READ_AT,
    );
    expect(reading.byAddress.get(COINBASE)?.name).toBe('Coinbase Hot Wallet 11');
    expect(reading.byAddress.get(PUMPFUN_FEES)?.name).toBe('Pump.fun AMM Fees 2');
    expect(reading.missing).toEqual([]);
  });

  it('sets aside a row for an address nobody asked about', () => {
    const reading = readIdentityResponse([namedRow(PUMPFUN_FEES)], [COINBASE], READ_AT);
    expect(reading.unexpected).toEqual([PUMPFUN_FEES]);
    expect(reading.missing).toEqual([COINBASE]);
    expect(reading.byAddress.size).toBe(0);
  });
});

describe('the citation rule travels with the label', () => {
  it('states all three clauses, and points at the record rather than copying it', () => {
    expect(VENDOR_CLAIM_CAVEAT).toMatch(/VENDOR CLAIM READ ON A DATE/);
    expect(VENDOR_CLAIM_CAVEAT).toMatch(/unaudited/);
    expect(WALL_CAVEAT).toMatch(/DOES NOT LET YOU SEE THROUGH IT/);
    expect(WALL_CAVEAT).toMatch(/NOT thereby related/);
    expect(WALL_CAVEAT).toMatch(/NOT thereby unrelated/);
    expect(CITATION_RULE).toEqual([VENDOR_CLAIM_CAVEAT, WALL_CAVEAT]);
    expect(AUTHORITATIVE_RECORD).toContain('slot-zero-attribution-product-pricing');
    expect(AUTHORITATIVE_RECORD).toContain('366a');
    // A pointer, not a copy: the record lives outside this tree and a copy would go stale.
    expect(AUTHORITATIVE_RECORD).toContain('not in this repo');
  });

  it('puts the date and the rule on the ROW, so a row copied out of a table keeps them', () => {
    const label = readIdentityRow(namedRow(COINBASE), READ_AT);
    expect(label?.readAtUtc).toBe(READ_AT);
    expect(label?.source).toBe(LABEL_SOURCE);
    expect(label?.citation).toBe(labelCitation(READ_AT));
    expect(label?.citation).toContain(READ_AT);
    expect(label?.caveats).toEqual([VENDOR_CLAIM_CAVEAT, WALL_CAVEAT]);
  });

  it('adds the tags note to exactly the rows that carry tags', () => {
    // `H8sMJSCQ…` reads name "Coinbase Hot Wallet 12" with tag "Bitstamp Deposit" — two venues on
    // one address, unresolved. It is the most concrete reason these labels are assertions, so a row
    // with tags says so rather than leaving a reader to notice.
    const tagged = readIdentityRow(namedRow(BITSTAMP_TAGGED, { tags: ['Bitstamp Deposit'] }), READ_AT);
    expect(tagged?.caveats).toContain(TAGS_CAVEAT);
    expect(readIdentityRow(namedRow(COINBASE), READ_AT)?.caveats).not.toContain(TAGS_CAVEAT);
    expect(TAGS_CAVEAT).toMatch(/Bitstamp Deposit/);
  });

  it('reaches the rendered block, including the tags note when one applies', () => {
    const addresses = [COINBASE, BITSTAMP_TAGGED, RELAY_WALL];
    const labels = [
      readIdentityRow(namedRow(COINBASE), READ_AT),
      readIdentityRow(namedRow(BITSTAMP_TAGGED, { tags: ['Bitstamp Deposit'] }), READ_AT),
      readIdentityRow({ address: RELAY_WALL, type: UNKNOWN_TYPE }, READ_AT),
    ];
    const text = renderLabels(labels, addresses).join('\n');
    for (const clause of CITATION_RULE) expect(text).toContain(clause);
    expect(text).toContain(TAGS_CAVEAT);
    expect(text).toContain(AUTHORITATIVE_RECORD);
    // The unknown row renders as unknown and says what that means, rather than as an empty cell.
    expect(text).toMatch(/unknown\s+\(vendor type: unknown/);
    expect(text).toMatch(/declines to name/);
    // And a row that never came back is not rendered as unknown either.
    const none = renderLabels([null], [PUMPFUN_FEES]).join('\n');
    expect(none).toMatch(/NO ANSWER/);
    expect(none).not.toMatch(/vendor type: unknown/);
    expect(none).toMatch(/That is not "unknown"/);
  });

  it('reaches the record, at run level and on every row', () => {
    const plan = planLookups([COINBASE, RELAY_WALL], PLAN_BOUNDS);
    const reading = readIdentityResponse(
      [namedRow(COINBASE), { address: RELAY_WALL, type: UNKNOWN_TYPE }],
      plan.addresses,
      READ_AT,
    );
    const record = buildRecord({
      readAtUtc: READ_AT,
      plan,
      reading,
      spend: { requests: 1, creditsAssumedSpent: 100, shed: 0, transportFailures: 0 },
      bounds: {},
    });
    expect(record['citationRule']).toEqual([...CITATION_RULE]);
    expect(record['authoritativeRecord']).toBe(AUTHORITATIVE_RECORD);
    expect(record['readAtUtc']).toBe(READ_AT);
    for (const label of record['labels'] as { caveats: string[]; readAtUtc: string }[]) {
      expect(label.readAtUtc).toBe(READ_AT);
      for (const clause of CITATION_RULE) expect(label.caveats).toContain(clause);
    }
  });

  it('reaches the free dry run, which is the surface most people will actually see', async () => {
    const lines: string[] = [];
    const code = await main([COINBASE, RELAY_WALL], {}, (l) => lines.push(l));
    expect(code).toBe(EXIT.ok);
    const text = lines.join('\n');
    expect(text).toContain('DRY RUN');
    for (const clause of CITATION_RULE) expect(text).toContain(clause);
  });

  it('is stated in the tool\'s own header, not only in what it prints', () => {
    // The deliverable's own wording: the rule goes where it cannot be missed. `identity.mjs` is the
    // owner and the two entry points point at it.
    const identity = readFileSync(join(TOOL_DIR, 'identity.mjs'), 'utf8');
    const header = identity.slice(0, identity.indexOf('*/'));
    expect(header).toMatch(/THE CITATION RULE/);
    expect(header).toMatch(/VENDOR'S CLAIM READ ON A DATE/);
    expect(header).toMatch(/DOES NOT LET ANYONE SEE THROUGH IT/);
    for (const file of ['label.mjs', 'README.md']) {
      expect(readFileSync(join(TOOL_DIR, file), 'utf8'), `${file}`).toMatch(/citation rule/i);
    }
  });
});

describe('the credential is resolved, and never said out loud', () => {
  it('names its own variable and nothing else does', () => {
    expect(KEY_ENV_VAR).toBe('HELIUS_API_KEY');
    const allowed = new Set(['tools/venue-label/credential.mjs']);
    for (const [file, text] of readAll(TOOL_DIR, 'tools/venue-label/')) {
      if (allowed.has(file)) continue;
      for (const variable of ['HELIUS_API_KEY', 'DUNE_API_KEY', 'MADEONSOL_API_KEY', 'SOLSCAN_API_KEY']) {
        expect(text.includes(variable), `${file} must not name ${variable}`).toBe(false);
      }
    }
    for (const pattern of CREDENTIAL_PATTERNS) {
      expect(pattern.test(readFileSync(join(TOOL_DIR, 'credential.mjs'), 'utf8'))).toBe(true);
    }
  });

  it('tells a missing key from a malformed one, and quotes neither', () => {
    // "No label" that is really "no credential" is the failure this repository refuses everywhere
    // else. There is no keyless route to a venue name, so an absent key is an ABSENT answer.
    const missing = resolveHeliusCredential({});
    expect(missing.outcome).toBe('missing');
    expect(missing.key).toBeNull();
    expect(missing.message).toMatch(/no keyless route/);
    expect(missing.message).toMatch(/ABSENT answer, never an unknown one/);

    // A composed URL is the one malformed value the length band cannot catch: this host plus a UUID
    // sits comfortably inside 24-128, so it would be accepted and composed a second time.
    const url = resolveHeliusCredential({ HELIUS_API_KEY: `${WALLET_API_HOST}/?api-key=abc123def456ghi` });
    expect(url.outcome).toBe('malformed');
    expect(url.message).not.toContain('abc123def456ghi');
    expect(url.message).toMatch(/composed URL/);

    const short = resolveHeliusCredential({ HELIUS_API_KEY: 'abcdef' });
    expect(short.outcome).toBe('malformed');
    expect(short.message).not.toContain('abcdef');
    expect(short.message).toContain(String(KEY_MIN_LENGTH));
    expect(short.message).toContain(String(KEY_MAX_LENGTH));

    const ok = resolveHeliusCredential({ HELIUS_API_KEY: ` ${SENTINEL_KEY} ` });
    expect(ok.outcome).toBe('ok');
    expect(ok.key).toBe(SENTINEL_KEY);
    expect(ok.message).not.toContain(SENTINEL_KEY);
    expect(describeKey(SENTINEL_KEY)).toEqual({ length: 37, hasDocumentedShape: false });
    expect(describeKey('0123abcd-0123-4567-89ab-0123456789ab').hasDocumentedShape).toBe(true);
  });

  it('composes the key into a URL in exactly one place, and hands back a safe spelling', () => {
    const { url, safe } = walletIdentityUrl(SENTINEL_KEY, BATCH_IDENTITY_PATH);
    expect(url).toContain(SENTINEL_KEY);
    expect(safe).not.toContain(SENTINEL_KEY);
    expect(safe).toBe(`${WALLET_API_HOST}${BATCH_IDENTITY_PATH}?api-key=<not shown>`);
    expect(() => walletIdentityUrl(SENTINEL_KEY, 'v1/wallet')).toThrow(TypeError);

    // ONE place. The composition is a template literal joining the host to a key, and it may not
    // grow a second home — a second spelling of an address is how a credential ends up in a log.
    const composing = [...readAll(TOOL_DIR, 'tools/venue-label/').entries()].filter(([, text]) =>
      /api-key=\$\{/.test(text),
    );
    expect(composing.map(([f]) => f)).toEqual(['tools/venue-label/credential.mjs']);
  });

  it('never lets the key reach a message, on any failure path', async () => {
    // Driven against a sentinel rather than reviewed for. The vendor's own body deliberately does
    // NOT contain the sentinel here, so any appearance is a leak of ours rather than an echo.
    const messages: string[] = [];
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const { c } = client(() => new Response('vendor body', { status }), { retryBackoffMs: [] });
      await c.batchIdentity([COINBASE]).catch((e) => messages.push(String(e?.message ?? e)));
    }
    const { c } = client(() => {
      throw new Error('socket hang up');
    }, { retryBackoffMs: [] });
    await c.identity(COINBASE).catch((e) => messages.push(String(e?.message ?? e)));
    expect(messages.length).toBe(7);
    for (const m of messages) expect(m).not.toContain(SENTINEL_KEY);

    // And the key DOES go where it has to: the URL that is fetched, and nowhere else.
    const { c: ok, calls } = client(() => json([namedRow(COINBASE)]));
    await ok.batchIdentity([COINBASE]);
    expect(calls[0]).toContain(SENTINEL_KEY);
  });

  it('strikes the key out of a vendor body that ECHOES the keyed request URL back at us', async () => {
    // The case the previous test cannot reach, because it picks a body with no sentinel in it. The
    // URL we send carries the key as a query parameter and vendors and gateways commonly quote the
    // request URL inside a 4xx body — so the body excerpt is a real route from the wire to stdout.
    const echoed = `{"error":"bad request for https://api.helius.xyz/v1/wallet/batch-identity?api-key=${SENTINEL_KEY}"}`;
    const messages: string[] = [];

    for (const status of [400, 401, 403, 429, 500]) {
      const { c } = client(() => new Response(echoed, { status }), { retryBackoffMs: [] });
      await c.batchIdentity([COINBASE]).catch((e) => messages.push(String(e?.message ?? e)));
    }
    // A 200 whose body is not JSON is quoted too, by a different path.
    const { c: broken } = client(() => new Response(echoed.slice(0, 40), { status: 200 }), {
      retryBackoffMs: [],
    });
    await broken.batchIdentity([COINBASE]).catch((e) => messages.push(String(e?.message ?? e)));
    // As is a transport failure, whose own message can name the URL it failed to reach.
    const { c: dead } = client(() => {
      throw new Error(`connect ECONNREFUSED for ?api-key=${SENTINEL_KEY}`);
    }, { retryBackoffMs: [] });
    await dead.identity(COINBASE).catch((e) => messages.push(String(e?.message ?? e)));

    expect(messages.length).toBe(7);
    for (const m of messages) expect(m, m).not.toContain(SENTINEL_KEY);
    // Redacted rather than dropped: the excerpt is still there, minus the credential.
    expect(messages.slice(0, 5).join('\n')).toContain('<not shown>');
    expect(messages.slice(0, 5).join('\n')).toContain('bad request for');
  });

  it('redacts a key even when the excerpt would have been truncated through it', () => {
    // Truncating first can leave a usable prefix of the key behind, so the redaction runs first.
    const long = `${'x'.repeat(190)} ${SENTINEL_KEY}`;
    expect(redactKey(long, SENTINEL_KEY).slice(0, 200)).not.toContain(SENTINEL_KEY.slice(0, 12));
    expect(redactKey(`a${encodeURIComponent('a b/c')}z`, 'a b/c')).toBe('a<not shown>z');
    expect(redactKey('nothing to strike', SENTINEL_KEY)).toBe('nothing to strike');
  });

  it('exits on the credential rather than reporting an unknown address', async () => {
    const lines: string[] = [];
    const fetchImpl = vi.fn();
    const code = await main(['--live', COINBASE], {}, (l) => lines.push(l), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(EXIT.credential);
    expect(lines.join('\n')).toMatch(/is not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('spending is bounded, and a plan that does not fit is refused before it is paid', () => {
  it('prices the plan in credits and refuses one over the ceiling, having sent nothing', () => {
    const tooMany = Array.from({ length: BOUNDS.budget.maxAddressesPerRun + 1 }, (_, i) => fakeAddress(i));
    const plan = planLookups(tooMany, PLAN_BOUNDS);
    expect(plan.refusals.join(' ')).toMatch(/above the pinned ceiling/);

    const tightCredits = planLookups([COINBASE, RELAY_WALL], { ...PLAN_BOUNDS, maxCreditsPerRun: 100 });
    expect(tightCredits.refusals.join(' ')).toMatch(/worst case of 300 credits/);

    const tightRequests = planLookups([COINBASE, RELAY_WALL], { ...PLAN_BOUNDS, maxRequestsPerRun: 2 });
    expect(tightRequests.refusals.join(' ')).toMatch(/above the pinned\s+ceiling of 2/);

    expect(planLookups([], PLAN_BOUNDS).refusals.join(' ')).toMatch(/No address to look up/);
  });

  it('refuses through the CLI before the first request, and says so', async () => {
    const lines: string[] = [];
    const fetchImpl = vi.fn();
    const code = await main(['--live', 'not-an-address'], { HELIUS_API_KEY: SENTINEL_KEY }, (l) => lines.push(l), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(EXIT.refused);
    expect(lines.join('\n')).toMatch(/REFUSED before any request was issued/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('counts every ATTEMPT as billed, retries included', async () => {
    // The vendor publishes nothing about whether a shed request is billed, and a bill we cannot see
    // is assumed to have happened. Over-stating a spend against a ceiling fails towards not
    // spending, which is the only safe direction on a metered surface.
    let n = 0;
    const { c } = client(() => (n++ < 2 ? new Response('', { status: 429 }) : json([namedRow(COINBASE)])));
    await c.batchIdentity([COINBASE]);
    expect(c.issued()).toBe(3);
    expect(c.shed()).toBe(2);
    expect(c.creditsSpent()).toBe(3 * CREDITS_PER_REQUEST);
  });

  it('stops at the request ceiling and at the credit ceiling, each in its own words', async () => {
    const { c } = client(() => json([]), { maxRequests: 1 });
    await c.batchIdentity([COINBASE]);
    await expect(c.batchIdentity([COINBASE])).rejects.toMatchObject({ kind: 'requests' });

    const { c: c2 } = client(() => json([]), { maxRequests: 9, maxCredits: 100 });
    await c2.batchIdentity([COINBASE]);
    await expect(c2.batchIdentity([COINBASE])).rejects.toBeInstanceOf(CeilingReached);
  });

  it('never retries a terminal status, and does retry a shed one', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { c, calls } = client(() => new Response('', { status }));
      await expect(c.batchIdentity([COINBASE])).rejects.toMatchObject({ terminal: true, status });
      expect(calls.length, `HTTP ${status} must not be retried`).toBe(1);
    }
    for (const status of [429, 500, 502]) {
      const { c, calls } = client(() => new Response('', { status }));
      await expect(c.batchIdentity([COINBASE])).rejects.toBeInstanceOf(HeliusRefused);
      expect(calls.length, `HTTP ${status} must be retried`).toBe(RETRY_BACKOFF_MS.length + 1);
    }
  });

  it('refuses a served-but-unreadable body rather than reading it as an empty answer', async () => {
    const { c, calls } = client(() => new Response('<html>', { status: 200 }));
    await expect(c.batchIdentity([COINBASE])).rejects.toMatchObject({ terminal: true });
    expect(calls.length).toBe(1);
  });

  it('sends the field the server wants, on the method it wants', async () => {
    // The published docs implied `wallets`; the live API rejects that with a 400 and requires
    // `addresses`. It is the one place the vendor's documentation and its server are known to
    // disagree, so it is asserted rather than remembered.
    const { c, fetchImpl } = client(() => json([namedRow(COINBASE)]));
    await c.batchIdentity([COINBASE, RELAY_WALL]);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ addresses: [COINBASE, RELAY_WALL] });

    const { c: c2, calls } = client(() => json(namedRow(COINBASE)));
    await c2.identity(COINBASE);
    expect(calls[0]).toContain(IDENTITY_PATH.replace('{address}', COINBASE));
  });

  it('says what a status means, and does not confuse a rejected key with an unknown address', () => {
    expect(describeHeliusStatus(401, '')).toMatch(/rejected the key/);
    expect(describeHeliusStatus(401, '')).toMatch(/NOT an "unknown" result/);
    expect(describeHeliusStatus(403, '')).toMatch(/not entitled to the Wallet API/);
    expect(describeHeliusStatus(429, '')).toMatch(/retried/);
    expect(describeHeliusStatus(400, '')).toMatch(/`addresses`, not `wallets`/);
  });
});

describe('the CLI plans before it spends', () => {
  it('parses its arguments and refuses nonsense rather than guessing', () => {
    expect(parseArgs(['--live', COINBASE]).live).toBe(true);
    expect(parseArgs([COINBASE]).live).toBe(false);
    expect(parseArgs(['--dry-run', COINBASE]).errors).toEqual([]);
    expect(parseArgs(['--wat']).errors[0]).toMatch(/unknown argument/);
    expect(parseArgs(['--out']).errors[0]).toMatch(/needs a path/);
    expect(parseArgs(['--out', '--json']).errors[0]).toMatch(/needs a path/);
    expect(parseArgs(['--out', 'x.json', COINBASE]).out).toBe('x.json');
  });

  it('reads an address list from a file, ignoring comments and blanks', () => {
    expect(parseAddressFile(`# walls\n${COINBASE}\n\n  ${RELAY_WALL}  # the relay\n`)).toEqual([
      COINBASE,
      RELAY_WALL,
    ]);
  });

  it('issues nothing at all without --live, on a machine holding no key', async () => {
    const lines: string[] = [];
    const fetchImpl = vi.fn();
    const code = await main([COINBASE, RELAY_WALL], {}, (l) => lines.push(l), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(EXIT.ok);
    expect(fetchImpl).not.toHaveBeenCalled();
    const text = lines.join('\n');
    // The cost, before the spend, on the free surface.
    expect(text).toMatch(/credits\s+100 planned, 300 worst case/);
    expect(text).not.toMatch(/resolved \(/);
  });

  it('runs the whole live path over a stubbed transport, in ONE batch request', async () => {
    const lines: string[] = [];
    const written: [string, string][] = [];
    const fetchImpl = vi.fn(async () =>
      json([
        namedRow(COINBASE),
        { address: RELAY_WALL, type: UNKNOWN_TYPE },
        namedRow(PUMPFUN_FEES, { type: 'protocol', name: 'Pump.fun AMM Fees 2', category: 'Fees', tags: ['Squads Multisig v4'] }),
      ]),
    );
    const code = await main(
      ['--live', '--out', 'out.json', COINBASE, RELAY_WALL, PUMPFUN_FEES],
      { HELIUS_API_KEY: SENTINEL_KEY },
      (l) => lines.push(l),
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: async () => undefined,
        nowIso: READ_AT,
        writeImpl: (p, t) => written.push([p, t]),
      },
    );
    expect(code).toBe(EXIT.ok);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // three addresses, ONE request, 100 credits
    expect(lines.join('\n')).toMatch(
      /2 named, 1 unknown \(the vendor's own answer\), 0 typed but unnamed \(an incomplete answer, not a declined one\), 0 unreadable, 0 unanswered/,
    );
    expect(lines.join('\n')).toMatch(/1 request\(s\), 100 credits assumed spent/);

    const record = JSON.parse(String(written[0]?.[1]));
    expect(written[0]?.[0]).toBe('out.json');
    expect(record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(record.spend).toEqual({ requests: 1, creditsAssumedSpent: 100, shed: 0, transportFailures: 0 });
  });

  it('reports a vendor refusal as a refusal, never as an unknown address', async () => {
    const lines: string[] = [];
    const code = await main(['--live', COINBASE], { HELIUS_API_KEY: SENTINEL_KEY }, (l) => lines.push(l), {
      fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    expect(code).toBe(EXIT.vendor);
    const text = lines.join('\n');
    expect(text).toMatch(/vendor refused/);
    expect(text).toMatch(/NOT an "unknown" result for any address/);
  });

  it('reports OUR OWN per-run ceiling as ours, never as a Helius refusal', () => {
    // A ceiling pinned in this repository's bounds.json is not a vendor verdict, and printing it as
    // one sends an operator to Helius to debug a number that is in the tree. Driven directly rather
    // than through a run, because the ceiling is unreachable from one — see the assertion below.
    const ceiling: string[] = [];
    reportRunStopped(new CeilingReached('credits', 1200), (l) => ceiling.push(l), 4, 400);
    const text = ceiling.join('\n');
    expect(text).toMatch(/OUR OWN per-run credits ceiling/);
    expect(text).toMatch(/Helius refused nothing/);
    expect(text).toMatch(/bounds\.json/);
    expect(text).not.toMatch(/vendor refused/);
    // It still says spend may have happened, which is why it shares the vendor exit code.
    expect(text).toMatch(/4 request\(s\) issued, 400 credits assumed spent/);
    expect(text).toMatch(/NOT an "unknown" result for any address/);

    // A real vendor refusal keeps its own wording and claims nothing about our bounds.
    const refused: string[] = [];
    reportRunStopped(new HeliusRefused(401, describeHeliusStatus(401, ''), true), (l) => refused.push(l), 1, 100);
    const vendorText = refused.join('\n');
    expect(vendorText).toMatch(/vendor refused/);
    expect(vendorText).not.toMatch(/OUR OWN/);
    expect(vendorText).not.toMatch(/bounds\.json/);
  });

  it('cannot reach that ceiling from a real run, because the plan is priced at the retry depth', () => {
    // Why the report above is driven directly. `planLookups` prices a plan at the client's own retry
    // depth and refuses it before the first request, so the client's ceiling is a backstop against a
    // future bounds change rather than a state a current run can enter. If this stops holding, the
    // ceiling becomes live and its sentence starts being read by operators.
    const attempts = RETRY_BACKOFF_MS.length + 1;
    const full = Array.from({ length: BOUNDS.budget.maxAddressesPerRun }, (_, i) => fakeAddress(i));
    const plan = planLookups(full, { ...PLAN_BOUNDS, attemptsPerRequest: attempts });
    expect(plan.refusals).toEqual([]);
    // The worst case a permitted plan can spend is exactly what the client is allowed to spend.
    expect(plan.requests.length * attempts).toBeLessThanOrEqual(BOUNDS.budget.maxRequestsPerRun);
    expect(plan.creditsIfEveryRequestRetried).toBeLessThanOrEqual(BOUNDS.budget.maxCreditsPerRun);
  });
});

describe('the bounds are pinned, and each says why', () => {
  it('gives every pinned parameter a stated reason', () => {
    // The 2026-08-02 provenance audit on the screen found eight values with no stated reason at all.
    // "No measurement backs this, and here is what would" is acceptable; inventing an anchor is not.
    for (const group of ['lookup', 'budget'] as const) {
      for (const key of Object.keys(BOUNDS[group])) {
        const reason = BOUNDS.justification[`${group}.${key}`];
        expect(typeof reason, `${group}.${key} has no justification`).toBe('string');
        expect(String(reason).length, `${group}.${key}'s justification is a stub`).toBeGreaterThan(80);
      }
    }
    // Nothing may quote curve_last_tx_s, which is a non-timing.
    expect(JSON.stringify(BOUNDS.justification)).not.toContain('curve_last_tx_s');
  });

  it('keeps the vendor facts and our ceilings in agreement', () => {
    expect(BOUNDS.lookup.creditsPerRequest).toBe(CREDITS_PER_REQUEST);
    expect(BOUNDS.lookup.batchMaxAddresses).toBe(BATCH_MAX_ADDRESSES);
    // The credit ceiling IS the request ceiling priced, rather than a second number free to drift.
    expect(BOUNDS.budget.maxCreditsPerRun).toBe(BOUNDS.budget.maxRequestsPerRun * CREDITS_PER_REQUEST);
    // And the address ceiling has to be reachable within the request ceiling at full retry depth.
    const worstRequests = Math.ceil(BOUNDS.budget.maxAddressesPerRun / BATCH_MAX_ADDRESSES) * (RETRY_BACKOFF_MS.length + 1);
    expect(worstRequests).toBeLessThanOrEqual(BOUNDS.budget.maxRequestsPerRun);
  });
});

describe('the committed record is evidence, and it still agrees with itself', () => {
  const recordPath = join(TOOL_DIR, 'runs', '2026-08-07-funding-walls.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));

  // The record's key set PER VERSION. Committed records are never retro-edited, so a record stays
  // legal at the version it was written under while a later build writes a wider shape. The VERSION
  // decides whether to assert, never the block's presence.
  const TOP_LEVEL_KEYS = [
    'schemaVersion',
    'tool',
    'source',
    'readAtUtc',
    'citationRule',
    'authoritativeRecord',
    'summary',
    'labels',
    'unanswered',
    'spend',
    'bounds',
  ];
  const KEYS_BY_SCHEMA: Record<number, string[]> = { 1: TOP_LEVEL_KEYS, 2: TOP_LEVEL_KEYS };
  // The summary's key set is what moved at 2 (captain decision 372a added `typedUnnamed`), so it is
  // pinned per version too. A committed schema-1 record stays legal at the version it was written
  // under; nothing in it is edited to match a shape that did not exist when it was read.
  const SUMMARY_KEYS_BY_SCHEMA: Record<number, string[]> = {
    1: ['requested', 'named', 'unknown', 'unreadable', 'missing'],
    2: ['requested', 'named', 'unknown', 'typedUnnamed', 'unreadable', 'missing'],
  };
  const LABEL_KEYS = [
    'address',
    'type',
    'name',
    'category',
    'tags',
    'website',
    'named',
    'readAtUtc',
    'source',
    'citation',
    'caveats',
  ];

  it('pins the exact key set the record carries for its schema version', () => {
    expect(KEYS_BY_SCHEMA[record.schemaVersion], 'the committed record declares an unknown schema').toBeDefined();
    expect(Object.keys(record).sort()).toEqual([...KEYS_BY_SCHEMA[record.schemaVersion]!].sort());
    for (const label of record.labels) expect(Object.keys(label).sort()).toEqual([...LABEL_KEYS].sort());
    expect(SUMMARY_KEYS_BY_SCHEMA[record.schemaVersion], 'no summary key set for that schema').toBeDefined();
    expect(Object.keys(record.summary).sort()).toEqual(
      [...SUMMARY_KEYS_BY_SCHEMA[record.schemaVersion]!].sort(),
    );
    expect(Object.keys(record.unanswered).sort()).toEqual(
      ['missing', 'unreadableRows', 'unexpected', 'refusedByShape', 'duplicatesDropped'].sort(),
    );
    expect(Object.keys(record.spend).sort()).toEqual(
      ['requests', 'creditsAssumedSpent', 'shed', 'transportFailures'].sort(),
    );
  });

  it('pins what THIS build writes, which no committed record can show until one is re-run', () => {
    // The committed record above is evidence of a real, dated read and may never be edited to match
    // a newer shape. So the current version's shape is asserted against `buildRecord`'s own output
    // — otherwise a key added at the current version would be pinned by nothing at all until
    // somebody spent 100 credits, which is the wrong incentive on a metered surface.
    const plan = planLookups([COINBASE], PLAN_BOUNDS);
    const built = buildRecord({
      readAtUtc: READ_AT,
      plan,
      reading: readIdentityResponse([namedRow(COINBASE)], plan.addresses, READ_AT),
      spend: { requests: 1, creditsAssumedSpent: 100, shed: 0, transportFailures: 0 },
      bounds: {},
    });
    expect(built['schemaVersion']).toBe(RECORD_SCHEMA_VERSION);
    expect(KEYS_BY_SCHEMA[RECORD_SCHEMA_VERSION], 'the current version has no pinned key set').toBeDefined();
    expect(Object.keys(built).sort()).toEqual([...KEYS_BY_SCHEMA[RECORD_SCHEMA_VERSION]!].sort());
    expect(
      SUMMARY_KEYS_BY_SCHEMA[RECORD_SCHEMA_VERSION],
      'the current version has no pinned summary key set',
    ).toBeDefined();
    expect(Object.keys(built['summary'] as object).sort()).toEqual(
      [...SUMMARY_KEYS_BY_SCHEMA[RECORD_SCHEMA_VERSION]!].sort(),
    );
    // The record moved; the committed evidence did not, and it is still read at its own version.
    expect(record.schemaVersion).toBeLessThan(RECORD_SCHEMA_VERSION);
  });

  it('cost one request and named five of six, with the sixth honestly unknown', () => {
    expect(record.spend).toEqual({ requests: 1, creditsAssumedSpent: 100, shed: 0, transportFailures: 0 });
    expect(record.summary).toEqual({ requested: 6, named: 5, unknown: 1, unreadable: 0, missing: 0 });
    // Six addresses for ONE request's worth of credits is the whole point of the batch path.
    expect(record.spend.creditsAssumedSpent).toBe(CREDITS_PER_REQUEST);
  });

  it('re-derives its own summary from the labels it carries', () => {
    const reading = readIdentityResponse(
      record.labels,
      record.labels.map((l: { address: string }) => l.address),
      record.readAtUtc,
    );
    const derived = summariseLabels(record.labels.map((l: { address: string }) => l.address), reading);
    // Every count the record was written with still re-derives from its own rows. `typedUnnamed`
    // did not exist at schema 1, so it is asserted separately rather than by editing the evidence:
    // no row of that read carries a type without a name, which is why the split changes nothing here.
    expect(derived).toMatchObject(record.summary);
    expect(derived.typedUnnamed).toBe(0);
    expect(Object.keys(record.summary)).not.toContain('typedUnnamed');
  });

  it('holds the two rows the authorising investigation turns on', () => {
    const byAddress = new Map<string, Record<string, unknown>>(
      record.labels.map((l: Record<string, unknown>) => [l['address'], l]),
    );
    // The blind corroboration: an earlier investigation reached "pump.fun protocol infrastructure"
    // by structural argument with no label surface available, and an independent vendor label
    // obtained by a different route agrees. It is the strongest evidence these labels are real, and
    // it is still n = 1 — which is why the vendor-claim caveat rides on the row regardless.
    expect(byAddress.get(PUMPFUN_FEES)?.['name']).toBe('Pump.fun AMM Fees 2');
    expect(byAddress.get(PUMPFUN_FEES)?.['type']).toBe('protocol');
    // The honest miss: the relay wall is declined rather than confabulated, and it is preserved as
    // `unknown` with a null name in the committed evidence, not as a blank or a guess.
    expect(byAddress.get(RELAY_WALL)?.['type']).toBe(UNKNOWN_TYPE);
    expect(byAddress.get(RELAY_WALL)?.['name']).toBeNull();
    expect(byAddress.get(RELAY_WALL)?.['named']).toBe(false);
    // And the contradictory row carries its own note rather than reading as a settled fact.
    expect(byAddress.get(BITSTAMP_TAGGED)?.['tags']).toEqual(['Bitstamp Deposit']);
    expect(byAddress.get(BITSTAMP_TAGGED)?.['caveats']).toContain(TAGS_CAVEAT);
  });

  it('dates every claim it holds', () => {
    // Clause 1 of the citation rule, as a property of the file rather than a habit of its author.
    expect(record.readAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const label of record.labels) {
      expect(label.readAtUtc).toBe(record.readAtUtc);
      expect(label.citation).toContain(record.readAtUtc);
      for (const clause of CITATION_RULE) expect(label.caveats).toContain(clause);
    }
  });
});

describe('the boundary holds around this tool', () => {
  it('opens a socket in exactly one file', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/venue-label/')) {
      if (file === 'tools/venue-label/client.mjs') continue;
      expect(/\bfetch\s*\(/.test(text), `${file} must not call fetch directly`).toBe(false);
    }
  });

  it('reaches exactly one host, and never a dead or unrelated metered one', () => {
    const urls = new Set<string>();
    for (const text of readAll(TOOL_DIR, 'tools/venue-label/', /\.(mjs|js)$/).values()) {
      for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) urls.add(m[0]);
    }
    expect([...urls]).toEqual([WALLET_API_HOST]);
    expect(WALLET_API_HOST).toBe('https://api.helius.xyz');
    for (const [file, text] of readAll(TOOL_DIR, 'tools/venue-label/', /\.(mjs|js|md|json)$/)) {
      // `solana-rpc.publicnode.com` 403s this repository's clients on every request and the retry
      // backoff hides it. No other metered vendor is needed here and none may be reached.
      expect(/https?:\/\/[^\s'"]*publicnode/.test(text), `${file} must not build a publicnode URL`).toBe(false);
      expect(
        /https?:\/\/[^\s'"]*(madeonsol|api\.dune\.com|solscan)/i.test(text),
        `${file} must not reach another vendor`,
      ).toBe(false);
    }
  });

  it('holds no key-shaped string and assigns no credential, in any committed file', () => {
    // EVERY committed file, not just the sources: bounds.json, README.md and runs/*.json are the
    // likeliest places a real key gets pasted by accident. A Helius key is a lowercase UUID, so
    // that shape is checked here as well as the fleet's msk_ one.
    const HELIUS_KEY_SHAPED = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
    const all = readAll(TOOL_DIR, 'tools/venue-label/', /./);
    expect([...all.keys()]).toContain('tools/venue-label/README.md');
    expect([...all.keys()]).toContain('tools/venue-label/bounds.json');
    expect([...all.keys()].some((f) => f.startsWith('tools/venue-label/runs/'))).toBe(true);
    for (const [file, text] of all) {
      expect(KEY_SHAPED.test(text), `${file} may contain a real key`).toBe(false);
      expect(HELIUS_KEY_SHAPED.test(text), `${file} may contain a real Helius key`).toBe(false);
      expect(
        /(?:MADEONSOL_API_KEY|HELIUS_API_KEY|DUNE_API_KEY)\s*=\s*['"`]?[A-Za-z0-9_-]{12,}/.test(text),
        `${file} may assign a real key to a credential variable`,
      ).toBe(false);
    }
  });

  it('does not import src/, analysis/ or another tool, and is not imported by them', () => {
    for (const [file, text] of readAll(TOOL_DIR, 'tools/venue-label/')) {
      expect(text, `${file} must not import from src/`).not.toMatch(/from\s+['"](\.\.\/)+src\//);
      expect(text, `${file} must not import from analysis/`).not.toMatch(/from\s+['"].*analysis\//);
      expect(text, `${file} must not import from another tool`).not.toMatch(
        /from\s+['"][^'"]*(deployer-screen|graduated-life-tape|arrival-rate-walk|window-decay-tripwire|creation-census)/,
      );
    }
    for (const [file, text] of readAll(SRC_DIR, 'src/')) {
      expect(text, `${file} must not import from tools/`).not.toMatch(/from\s+['"].*tools\//);
    }
    // And nothing else in tools/ reaches into this one: it is a leaf, and a lane that wanted its
    // labels would read a committed record rather than couple to a metered client.
    const toolsDir = fileURLToPath(new URL('../tools/', import.meta.url));
    for (const [file, text] of readAll(toolsDir, 'tools/')) {
      if (file.startsWith('tools/venue-label/')) continue;
      expect(text, `${file} must not import from tools/venue-label/`).not.toMatch(/from\s+['"][^'"]*venue-label/);
    }
  });

  it('ships its method and its bounds beside the code', () => {
    const files = [...readAll(TOOL_DIR, 'tools/venue-label/', /./).keys()];
    expect(files).toContain('tools/venue-label/README.md');
    expect(files).toContain('tools/venue-label/bounds.json');
    const readme = readFileSync(join(TOOL_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/## What this tool cannot answer/);
    // The rule is quoted verbatim in the README, allowing only for markdown blockquote wrapping, so
    // the two copies cannot drift into saying different things about the same claim.
    const unwrapped = readme.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
    for (const clause of CITATION_RULE) expect(unwrapped).toContain(clause.replace(/\s+/g, ' '));
  });
});
