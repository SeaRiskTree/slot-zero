#!/usr/bin/env node
/**
 * `node tools/venue-label/label.mjs <address>…` — name the venue behind a Solana address.
 *
 * **THE CITATION RULE BINDS EVERYTHING THIS PRINTS, and it is stated in full in `identity.mjs`'s
 * header.** In one line: a venue name is a vendor's claim read on a date, and naming a custodial
 * wall does not let anyone see through it — two wallets that both touched Coinbase are not thereby
 * related. This lane names walls; it never traces past one. The rule reaches every rendered block
 * and every persisted record, on purpose, because cheap names make the misreading easier.
 *
 * **The dry run is the default and it issues nothing.** `--live` is required to spend, for the same
 * reason `tools/creation-census/run.mjs` works that way: the unit here is 100 credits per request
 * and it cannot be taken back. The dry run prints the plan, the exact credit cost, every ceiling
 * and the citation rule, and it works on a machine holding no key.
 *
 * ```bash
 * node tools/venue-label/label.mjs <address> [<address>…]          # dry run: the plan and the cost
 * node tools/venue-label/label.mjs --live <address> [<address>…]   # one batch request, 100 credits
 * node tools/venue-label/label.mjs --live --from-file walls.txt --out runs/2026-08-07-walls.json
 * ```
 *
 * Exit codes: `0` ran, `1` usage, `2` refused before spending (a real answer about the plan, not a
 * fault), `3` credential, `4` the vendor refused — and on `4` the request may already have billed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveHeliusCredential } from './credential.mjs';
import { CeilingReached, HeliusRefused, RETRY_BACKOFF_MS, WalletIdentityClient } from './client.mjs';
import {
  AUTHORITATIVE_RECORD,
  BATCH_MAX_ADDRESSES,
  CITATION_RULE,
  buildRecord,
  planLookups,
  readIdentityResponse,
  renderLabels,
  summariseLabels,
} from './identity.mjs';

/** @typedef {(line: string) => void} Out */

export const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  refused: 2,
  credential: 3,
  vendor: 4,
});

/**
 * @typedef {object} Bounds
 * @property {string} version
 * @property {{ batchMaxAddresses: number, creditsPerRequest: number, minIntervalMs: number }} lookup
 * @property {{ maxAddressesPerRun: number, maxRequestsPerRun: number, maxCreditsPerRun: number }} budget
 * @property {Record<string, string>} justification
 */

/**
 * Read the pinned bounds. Every value carries a stated reason and a test enforces that.
 *
 * @returns {Bounds}
 */
export function readBounds() {
  const path = fileURLToPath(new URL('./bounds.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * @typedef {object} Args
 * @property {string[]} addresses
 * @property {string | null} fromFile
 * @property {boolean} live
 * @property {string | null} out
 * @property {boolean} json
 * @property {boolean} help
 * @property {string[]} errors
 */

/**
 * Parse the command line. Nonsense is refused rather than guessed at — an unknown flag on a tool
 * that spends is a typo away from spending on the wrong thing.
 *
 * @param {readonly string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {Args} */
  const args = {
    addresses: [],
    fromFile: null,
    live: false,
    out: null,
    json: false,
    help: false,
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--from-file' || a === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        args.errors.push(`${a} needs a path`);
        continue;
      }
      i += 1;
      if (a === '--out') args.out = value;
      else args.fromFile = value;
    } else if (a.startsWith('-')) args.errors.push(`unknown argument ${a}`);
    else args.addresses.push(a);
  }
  return args;
}

/**
 * Read an address list from a file: one per line, `#` comments and blank lines ignored.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseAddressFile(text) {
  return text
    .split('\n')
    .map((l) => l.split('#')[0]?.trim() ?? '')
    .filter((l) => l !== '');
}

/** @param {Out} out */
function printUsage(out) {
  out('Usage: node tools/venue-label/label.mjs [--live] [--from-file <path>] [--out <path>]');
  out('                                        [--json] <address> [<address>…]');
  out('');
  out('  Names the venue behind a Solana address, using the Helius Wallet Identity endpoint.');
  out('  The dry run is the default and issues nothing. --live spends 100 credits per request,');
  out(`  and one request resolves up to ${BATCH_MAX_ADDRESSES} addresses.`);
}

/** @param {Out} out */
function printCitationRule(out) {
  out('THE CITATION RULE — it travels with every label below, and with every label you publish:');
  for (const clause of CITATION_RULE) out(`  ${clause}`);
  out(`  Rule: ${AUTHORITATIVE_RECORD}.`);
}

/**
 * @typedef {object} Seam
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleepImpl]
 * @property {string} [nowIso]
 * @property {(path: string, text: string) => void} [writeImpl]
 */

/**
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {Out} out
 * @param {Seam} [seam]
 * @returns {Promise<number>}
 */
export async function main(argv, env, out, seam = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage(out);
    out('');
    printCitationRule(out);
    return EXIT.ok;
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) out(`error: ${e}`);
    out('');
    printUsage(out);
    return EXIT.usage;
  }

  const bounds = readBounds();
  /** @type {string[]} */
  let requested = [...args.addresses];
  if (args.fromFile !== null) {
    try {
      requested = [...requested, ...parseAddressFile(readFileSync(args.fromFile, 'utf8'))];
    } catch (cause) {
      out(`error: could not read ${args.fromFile}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return EXIT.usage;
    }
  }

  const attemptsPerRequest = RETRY_BACKOFF_MS.length + 1;
  const plan = planLookups(requested, {
    maxAddressesPerRun: bounds.budget.maxAddressesPerRun,
    maxRequestsPerRun: bounds.budget.maxRequestsPerRun,
    maxCreditsPerRun: bounds.budget.maxCreditsPerRun,
    creditsPerRequest: bounds.lookup.creditsPerRequest,
    attemptsPerRequest,
  });

  out(args.live ? 'venue-label — LIVE' : 'venue-label — DRY RUN (issues nothing; --live to spend)');
  out(`  addresses          ${plan.addresses.length}`);
  if (plan.duplicatesDropped > 0) out(`  duplicates dropped ${plan.duplicatesDropped}`);
  if (plan.refusedByShape.length > 0) {
    out(`  refused by shape   ${plan.refusedByShape.length} (not base58; never sent)`);
  }
  const batches = plan.requests.filter((r) => r.kind === 'batch').length;
  out(`  requests           ${plan.requests.length} (${batches} batch, ${plan.requests.length - batches} single)`);
  out(`  credits            ${plan.credits} planned, ${plan.creditsIfEveryRequestRetried} worst case`);
  out(`  ceilings           ${bounds.budget.maxRequestsPerRun} requests / ${bounds.budget.maxCreditsPerRun} credits per run`);
  out('');

  if (plan.refusals.length > 0) {
    out('REFUSED before any request was issued:');
    for (const r of plan.refusals) out(`  ${r}`);
    out('');
    printCitationRule(out);
    return EXIT.refused;
  }

  if (!args.live) {
    // Deliberately no credential is even resolved: a dry run has to work on a machine that holds
    // no key, and it is the mode a smoke test wants.
    printCitationRule(out);
    return EXIT.ok;
  }

  const credential = resolveHeliusCredential(env);
  if (credential.outcome !== 'ok' || credential.key === null) {
    out(credential.message);
    return EXIT.credential;
  }

  const readAtUtc = seam.nowIso ?? new Date().toISOString();
  const clientOptions = {
    key: credential.key,
    maxRequests: bounds.budget.maxRequestsPerRun,
    maxCredits: bounds.budget.maxCreditsPerRun,
    minIntervalMs: bounds.lookup.minIntervalMs,
    ...(seam.fetchImpl === undefined ? {} : { fetchImpl: seam.fetchImpl }),
    ...(seam.sleepImpl === undefined ? {} : { sleepImpl: seam.sleepImpl }),
  };
  const client = new WalletIdentityClient(clientOptions);

  /** @type {unknown[]} */
  const rows = [];
  try {
    for (const request of plan.requests) {
      const body =
        request.kind === 'batch'
          ? await client.batchIdentity(request.addresses)
          : await client.identity(/** @type {string} */ (request.addresses[0]));
      if (Array.isArray(body)) rows.push(...body);
      else rows.push(body);
    }
  } catch (cause) {
    if (cause instanceof HeliusRefused || cause instanceof CeilingReached) {
      out(`vendor refused: ${cause.message}`);
      out(`  ${client.issued()} request(s) issued, ${client.creditsSpent()} credits assumed spent.`);
      out('  Nothing was named. This is NOT an "unknown" result for any address.');
      return EXIT.vendor;
    }
    throw cause;
  }

  const reading = readIdentityResponse(rows, plan.addresses, readAtUtc);
  const labels = plan.addresses.map((a) => reading.byAddress.get(a) ?? null);
  for (const line of renderLabels(labels, plan.addresses)) out(line);

  const summary = summariseLabels(plan.addresses, reading);
  out('');
  out(
    `  ${summary.named} named, ${summary.unknown} unknown (the vendor's own answer), ` +
      `${summary.unreadable} unreadable, ${summary.missing} unanswered.`,
  );
  out(`  ${client.issued()} request(s), ${client.creditsSpent()} credits assumed spent.`);

  const record = buildRecord({
    readAtUtc,
    plan,
    reading,
    spend: {
      requests: client.issued(),
      creditsAssumedSpent: client.creditsSpent(),
      shed: client.shed(),
      transportFailures: client.transportFailures(),
    },
    bounds: { ...bounds.budget, ...bounds.lookup, version: bounds.version },
  });

  if (args.json) out(JSON.stringify(record, null, 2));
  if (args.out !== null) {
    const write = seam.writeImpl ?? ((path, text) => writeFileSync(path, text));
    write(args.out, `${JSON.stringify(record, null, 2)}\n`);
    out(`  record written to ${args.out}`);
  }
  return EXIT.ok;
}

/* c8 ignore start */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const code = await main(process.argv.slice(2), process.env, (l) => console.log(l));
  process.exitCode = code;
}
/* c8 ignore stop */
