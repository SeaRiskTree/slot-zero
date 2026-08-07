/**
 * The pure half of the venue-labelling tool: what a vendor label IS, how a response is read, how a
 * lookup is planned so it takes the cheap path, and — first-class, not a footnote — **the citation
 * rule that travels with every label this tool emits.**
 *
 * ---
 *
 * # THE CITATION RULE
 *
 * Captain decision 366a adopted Helius Wallet Identity as this lab's standing venue-labelling
 * route, and made the citation rule part of the decision rather than a nicety. It has three
 * clauses, all of them from `slot-zero-attribution-product-pricing` §5 (held in firstmate's
 * records, not in this repo):
 *
 * 1. **A venue name is a VENDOR'S CLAIM READ ON A DATE.** It is unaudited, has no published
 *    methodology and no error rate. Every label this tool produces carries the date it was read on,
 *    and anything that publishes one presents it as a vendor claim rather than a property of the
 *    chain.
 * 2. **NAMING A WALL DOES NOT LET ANYONE SEE THROUGH IT.** This lab traces funding into launcher
 *    wallets and stops at every custodial wall, permanently. Two wallets that both touched Coinbase
 *    are not thereby related; two that touched different exchanges are not thereby unrelated. The
 *    permanent ceiling on the method — `README.md` → "The ceiling of the method: shared custodial
 *    venues" — is completely unaffected by a name.
 * 3. **Cheap venue names make that misreading EASIER, not harder.** Which is why the caveat travels
 *    with the label, in the record and in the rendered output, rather than living only in a
 *    document someone might not read.
 *
 * {@link CITATION_RULE} is that rule as strings, {@link labelCitation} puts it on a single row so a
 * label copied out of a table takes its framing with it, and `test/venue-label.test.ts` asserts it
 * reaches every emitted surface. **Do not publish a label without it.**
 *
 * ---
 *
 * ## Three outcomes, and they are not interchangeable
 *
 * - **named** — the vendor returned a `type` and a `name`.
 * - **unknown** — the vendor returned `type: "unknown"`. **That is the correct answer and it is
 *   preserved as "unknown"**, never smoothed into a guess, a blank or an empty string. It is
 *   information: it says the address is not a venue this vendor knows, which is a different object
 *   from one it does.
 * - **unreadable** — the row was missing, or was there and could not be parsed. **That is OUR
 *   failure, not the vendor's answer**, and it is kept apart from `unknown` for the same reason
 *   every other lane in this repository keeps "no evidence" apart from "evidence of no": an address
 *   whose row never arrived has not been declined, it has not been asked.
 */

/**
 * Base58 shape a Solana address takes. Checked before an address is sent, because it lands inside a
 * URL path on the single-address route and inside a JSON body on the batch one. The rule is the
 * fleet's, one vendor over: an operator-supplied identifier reaching a vendor's parser is checked
 * for shape first (`tools/deployer-screen/dune.mjs` → `WALLET_SHAPE` is the sibling copy).
 */
export const ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Addresses one batch request resolves, from the vendor's documentation. */
export const BATCH_MAX_ADDRESSES = 100;

/** The `type` the vendor returns for an address it declines to name. Preserved, never rewritten. */
export const UNKNOWN_TYPE = 'unknown';

/** What produced a label. Recorded on every row so a pooled table stays legible. */
export const LABEL_SOURCE = 'helius-wallet-identity';

/**
 * Where the argument for all of this is written down. **A pointer, deliberately, rather than a copy
 * of the prose** — the record moves and a copy would not.
 */
export const AUTHORITATIVE_RECORD =
  '`slot-zero-attribution-product-pricing` §5 and captain decision 366a ' +
  '(both held in firstmate\'s records, not in this repo)';

/** Clause 1. */
export const VENDOR_CLAIM_CAVEAT =
  'A VENUE NAME IS A VENDOR CLAIM READ ON A DATE, NOT A PROPERTY OF THE CHAIN. It is unaudited, ' +
  'with no published methodology and no error rate. Cite it as "Helius Wallet Identity, read ' +
  '<date>" and never as a fact about the address.';

/** Clause 2 — the one the standing custodial-wall order rests on. */
export const WALL_CAVEAT =
  'NAMING A WALL DOES NOT LET YOU SEE THROUGH IT. This lab never traces past a custodial wall. ' +
  'Two wallets that both touched Coinbase are NOT thereby related, and two that touched different ' +
  'exchanges are NOT thereby unrelated; the permanent ceiling on this method is unchanged by any ' +
  'name. Cheap venue names make that misreading EASIER, which is why this sentence travels with ' +
  'the label.';

/**
 * Clause 3's concrete instance, attached to any row that carries tags.
 *
 * `H8sMJSCQ…` came back `name: "Coinbase Hot Wallet 12"` carrying `tags: ["Bitstamp Deposit"]` —
 * two venues on one address. That is a real Coinbase-to-Bitstamp relationship, a stale tag, or a
 * labelling error, and the pricing report could not tell which. It is the single most concrete
 * reason to treat these labels as assertions rather than facts, so a row with tags says so rather
 * than leaving a reader to notice.
 */
export const TAGS_CAVEAT =
  'THIS ROW CARRIES TAGS AS WELL AS A NAME AND THEY MAY NAME DIFFERENT VENUES. One measured row ' +
  'reads name "Coinbase Hot Wallet 12" with tag "Bitstamp Deposit"; whether that is a real ' +
  'relationship, a stale tag or a labelling error is unresolved. Publish the tags with the name.';

/** The citation rule as it reaches a record, a rendered block and a reader. */
export const CITATION_RULE = Object.freeze([VENDOR_CLAIM_CAVEAT, WALL_CAVEAT]);

/** Bump, never retro-edit — a committed record is evidence of what was read and when. */
export const RECORD_SCHEMA_VERSION = 1;

/**
 * @typedef {object} VenueLabel
 * @property {string} address
 * @property {string} type      The vendor's own `type`, verbatim. {@link UNKNOWN_TYPE} when it
 *   declined to name the address, and that value is never rewritten.
 * @property {string | null} name     `null` on an unknown address. **Never `''`** — a blank reads
 *   as a name nobody typed.
 * @property {string | null} category `null` when absent.
 * @property {readonly string[]} tags Verbatim, possibly empty. Read them: see {@link TAGS_CAVEAT}.
 * @property {string | null} website  `null` when absent.
 * @property {boolean} named          Whether the vendor named it. `false` on unknown.
 * @property {string} readAtUtc       **When this claim was read.** On the row, not only on the run,
 *   because a row copied into a table has to take its date with it.
 * @property {string} source          {@link LABEL_SOURCE}.
 * @property {string} citation        One sentence carrying clauses 1 and 2 and the pointer.
 * @property {readonly string[]} caveats Every caveat that applies to THIS row.
 */

/**
 * The one-line framing that travels on a row. Built rather than stored so the date cannot drift
 * away from the claim it dates.
 *
 * @param {string} readAtUtc
 * @returns {string}
 */
export function labelCitation(readAtUtc) {
  return (
    `Helius Wallet Identity, read ${readAtUtc} — a vendor claim on that date, not a property of ` +
    `the chain, and naming a wall does not let you see through it. Rule: ${AUTHORITATIVE_RECORD}.`
  );
}

/** @param {unknown} v @returns {string | null} */
function readString(v) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  // An empty string is not a name. Folding it to `null` is what stops a blank cell reading as an
  // answer further downstream, which is the same defect as smoothing `unknown` into ''.
  return trimmed === '' ? null : trimmed;
}

/**
 * Read one row of a vendor response into a label.
 *
 * @param {unknown} row
 * @param {string} readAtUtc
 * @returns {VenueLabel | null} `null` when the row cannot be read — which is OUR failure and is
 *   never folded into {@link UNKNOWN_TYPE}.
 */
export function readIdentityRow(row, readAtUtc) {
  if (row === null || typeof row !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const address = readString(r['address']);
  const type = readString(r['type']);
  if (address === null || type === null) return null;

  const name = readString(r['name']);
  const tags = Array.isArray(r['tags'])
    ? r['tags'].map(readString).filter(/** @returns {t is string} */ (t) => t !== null)
    : [];
  // The vendor's own answer decides this, never the presence of a name: a `type` we have never seen
  // before is still a claim it made, and reading it as unknown would silently discard a label.
  const named = type !== UNKNOWN_TYPE && name !== null;

  /** @type {string[]} */
  const caveats = [...CITATION_RULE];
  if (tags.length > 0) caveats.push(TAGS_CAVEAT);

  return {
    address,
    type,
    name,
    category: readString(r['category']),
    tags: Object.freeze(tags),
    website: readString(r['website']),
    named,
    readAtUtc,
    source: LABEL_SOURCE,
    citation: labelCitation(readAtUtc),
    caveats: Object.freeze(caveats),
  };
}

/**
 * @typedef {object} IdentityReading
 * @property {ReadonlyMap<string, VenueLabel>} byAddress Keyed by address, never by position.
 * @property {readonly string[]} missing    Requested and not answered at all. **Refused, not read
 *   as unknown.**
 * @property {number} unreadableRows        Rows present that could not be parsed.
 * @property {readonly string[]} unexpected Answered but never asked for.
 */

/**
 * Read a whole response — a batch array, or the single-address object — against what was requested.
 *
 * **Keyed by address, never by position.** The vendor happens to answer in request order today and
 * nothing promises it will; reading by index would silently attach one address's venue to another,
 * which on this surface is the worst failure available.
 *
 * @param {unknown} body
 * @param {readonly string[]} requested
 * @param {string} readAtUtc
 * @returns {IdentityReading}
 */
export function readIdentityResponse(body, requested, readAtUtc) {
  const rows = Array.isArray(body) ? body : [body];
  /** @type {Map<string, VenueLabel>} */
  const byAddress = new Map();
  const wanted = new Set(requested);
  /** @type {string[]} */
  const unexpected = [];
  let unreadableRows = 0;

  for (const row of rows) {
    const label = readIdentityRow(row, readAtUtc);
    if (label === null) {
      unreadableRows += 1;
      continue;
    }
    if (!wanted.has(label.address)) {
      unexpected.push(label.address);
      continue;
    }
    byAddress.set(label.address, label);
  }

  return {
    byAddress,
    missing: requested.filter((a) => !byAddress.has(a)),
    unreadableRows,
    unexpected,
  };
}

/**
 * @typedef {object} LookupRequest
 * @property {'batch' | 'single'} kind
 * @property {readonly string[]} addresses
 */

/**
 * @typedef {object} LookupPlan
 * @property {readonly string[]} addresses    Deduplicated, in first-seen order.
 * @property {readonly string[]} refusedByShape Not base58-shaped; never sent.
 * @property {number} duplicatesDropped
 * @property {readonly LookupRequest[]} requests
 * @property {number} credits                 What the plan costs if nothing is retried.
 * @property {number} creditsIfEveryRequestRetried Worst case at the client's retry depth.
 * @property {readonly string[]} refusals     Non-empty means the plan must not run.
 */

/**
 * Plan the lookups. **This is what makes the cheap path the default rather than a choice.**
 *
 * More than one address is ALWAYS resolved in batches of {@link BATCH_MAX_ADDRESSES}, because both
 * endpoints cost the same per request: 100 addresses one at a time is 10,000 credits and the same
 * 100 together is 100. A single address takes the single-address route, which costs exactly the
 * same as a batch of one — so there is no configuration of this planner in which the expensive path
 * is reachable, and a test pins that.
 *
 * @param {readonly string[]} input
 * @param {object} bounds
 * @param {number} bounds.maxAddressesPerRun
 * @param {number} bounds.maxRequestsPerRun
 * @param {number} bounds.maxCreditsPerRun
 * @param {number} bounds.creditsPerRequest
 * @param {number} [bounds.attemptsPerRequest] Retry depth, for the worst case. Default 1.
 * @returns {LookupPlan}
 */
export function planLookups(input, bounds) {
  /** @type {string[]} */
  const addresses = [];
  /** @type {string[]} */
  const refusedByShape = [];
  const seen = new Set();
  let duplicatesDropped = 0;

  for (const raw of input) {
    const address = typeof raw === 'string' ? raw.trim() : '';
    if (!ADDRESS_SHAPE.test(address)) {
      refusedByShape.push(address);
      continue;
    }
    if (seen.has(address)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(address);
    addresses.push(address);
  }

  /** @type {LookupRequest[]} */
  const requests = [];
  if (addresses.length === 1) {
    requests.push({ kind: 'single', addresses: [/** @type {string} */ (addresses[0])] });
  } else {
    for (let i = 0; i < addresses.length; i += BATCH_MAX_ADDRESSES) {
      requests.push({ kind: 'batch', addresses: addresses.slice(i, i + BATCH_MAX_ADDRESSES) });
    }
  }

  const attempts = bounds.attemptsPerRequest ?? 1;
  const credits = requests.length * bounds.creditsPerRequest;
  const worstCase = credits * attempts;

  /** @type {string[]} */
  const refusals = [];
  if (addresses.length === 0) {
    refusals.push('No address to look up. Nothing was sent.');
  }
  if (addresses.length > bounds.maxAddressesPerRun) {
    refusals.push(
      `${addresses.length} addresses is above the pinned ceiling of ${bounds.maxAddressesPerRun} ` +
        `for one run. Split the list; the ceiling is a spend bound, not a vendor limit.`,
    );
  }
  if (requests.length * attempts > bounds.maxRequestsPerRun) {
    refusals.push(
      `${requests.length} request(s) at up to ${attempts} attempt(s) each is above the pinned ` +
        `ceiling of ${bounds.maxRequestsPerRun} for one run.`,
    );
  }
  if (worstCase > bounds.maxCreditsPerRun) {
    refusals.push(
      `A worst case of ${worstCase} credits is above the pinned ceiling of ` +
        `${bounds.maxCreditsPerRun} for one run. Every attempt is counted as billed.`,
    );
  }

  return {
    addresses,
    refusedByShape,
    duplicatesDropped,
    requests,
    credits,
    creditsIfEveryRequestRetried: worstCase,
    refusals,
  };
}

/**
 * @typedef {object} LabelSummary
 * @property {number} requested
 * @property {number} named
 * @property {number} unknown     The vendor's own answer. NOT a failure.
 * @property {number} unreadable  Our failure: a row that could not be parsed.
 * @property {number} missing     Requested and never answered. Also our failure, not an answer.
 */

/**
 * @param {readonly string[]} requested
 * @param {IdentityReading} reading
 * @returns {LabelSummary}
 */
export function summariseLabels(requested, reading) {
  let named = 0;
  let unknown = 0;
  for (const address of requested) {
    const label = reading.byAddress.get(address);
    if (label === undefined) continue;
    if (label.named) named += 1;
    else unknown += 1;
  }
  return {
    requested: requested.length,
    named,
    unknown,
    unreadable: reading.unreadableRows,
    missing: reading.missing.length,
  };
}

/**
 * @typedef {object} RecordInput
 * @property {string} readAtUtc
 * @property {LookupPlan} plan
 * @property {IdentityReading} reading
 * @property {object} spend
 * @property {number} spend.requests
 * @property {number} spend.creditsAssumedSpent
 * @property {number} spend.shed
 * @property {number} spend.transportFailures
 * @property {object} bounds
 */

/**
 * Build the run record. A versioned contract: **bump, never retro-edit**, because a committed
 * record is the dated evidence clause 1 of the citation rule requires — the label and the date it
 * was read on, together, in a file.
 *
 * @param {RecordInput} input
 * @returns {Record<string, unknown>}
 */
export function buildRecord(input) {
  const labels = input.plan.addresses.map((address) => input.reading.byAddress.get(address) ?? null);
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    tool: 'tools/venue-label',
    source: LABEL_SOURCE,
    readAtUtc: input.readAtUtc,
    citationRule: [...CITATION_RULE],
    authoritativeRecord: AUTHORITATIVE_RECORD,
    summary: summariseLabels(input.plan.addresses, input.reading),
    labels,
    unanswered: {
      missing: [...input.reading.missing],
      unreadableRows: input.reading.unreadableRows,
      unexpected: [...input.reading.unexpected],
      refusedByShape: input.plan.refusedByShape.length,
      duplicatesDropped: input.plan.duplicatesDropped,
    },
    spend: { ...input.spend },
    bounds: { ...input.bounds },
  };
}

/**
 * Render labels for a human. Every block carries the date and the rule; the rule is printed once at
 * the end in full and pointed at from each row, which is the shape that keeps a long list readable
 * without letting a row travel bare.
 *
 * @param {readonly (VenueLabel | null)[]} labels
 * @param {readonly string[]} addresses Parallel to `labels`; used to name an unanswered address.
 * @returns {string[]}
 */
export function renderLabels(labels, addresses) {
  /** @type {string[]} */
  const lines = [];
  let anyTags = false;
  labels.forEach((label, i) => {
    const address = addresses[i] ?? '(unknown address)';
    if (label === null) {
      lines.push(`${address}  NO ANSWER — the vendor returned no readable row for this address.`);
      lines.push('    That is not "unknown": it was not declined, it was not answered.');
      return;
    }
    if (!label.named) {
      lines.push(`${address}  unknown  (vendor type: ${label.type}, read ${label.readAtUtc})`);
      lines.push('    The vendor declines to name this address. That IS the answer, and it says');
      lines.push('    the address is not a venue it knows — not that it is unlabelled by mistake.');
      return;
    }
    const parts = [label.name ?? '', label.category === null ? '' : `[${label.category}]`]
      .filter((p) => p !== '')
      .join(' ');
    lines.push(`${address}  ${parts}  (type: ${label.type}, read ${label.readAtUtc})`);
    if (label.tags.length > 0) {
      anyTags = true;
      lines.push(`    tags: ${label.tags.join(', ')}   <- read these, see the note below`);
    }
    if (label.website !== null) lines.push(`    website: ${label.website}`);
  });

  lines.push('');
  for (const clause of CITATION_RULE) lines.push(`  ${clause}`);
  if (anyTags) lines.push(`  ${TAGS_CAVEAT}`);
  lines.push(`  Rule: ${AUTHORITATIVE_RECORD}.`);
  return lines;
}
