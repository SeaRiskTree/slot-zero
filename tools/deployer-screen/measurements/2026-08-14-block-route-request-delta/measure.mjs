/**
 * What captain decision 500a's unconditional block route COSTS, and what it BUYS — measured, not
 * projected.
 *
 * `pumpfun.mjs` → `readCreateSlotCosts` used to read the create slot's whole block only when two or
 * more of the launch's own transactions were in it, which is the point at which one `getBlock`
 * strictly beats the `getTransaction` calls it replaces. That floor is a pure request-count argument
 * and it was the right one until captain decision 466 made the same response the ONLY source of the
 * two create-slot rows of `bounds.mjs` → `costLedger`. 500a moves the trigger to the MINT.
 *
 * This harness measures the consequence over the committed tape, offline and keyless. It is run
 * TWICE — once with `pumpfun.mjs` at the pre-500a revision and once after — and the two `result.json`
 * files are differenced. **Nothing here holds a copy of the rule**: the route decision, the pricing
 * and the ledger are the production functions, called unchanged, so a run on either revision is a
 * measurement of that revision rather than of a model of it.
 *
 * ## What it can and cannot measure
 *
 * The transport is a stub `fetchImpl` handed to the production `SolanaRpcClient`, so no socket is
 * opened and no credential is read. The stub serves, for each launch:
 *
 *  - `getBlock(createSlot)` → a full block carrying exactly the create-slot transactions the tape
 *    knows about for that launch;
 *  - `getTransaction(sig)` → the same row.
 *
 * That makes **request counts, route selection and ledger population exact** — they are functions of
 * the launch shapes and of production control flow, both real here. It makes the ledger's
 * MAGNITUDES vacuous: the tape's window tape holds no landed-but-failed transactions and no tip
 * transfers, so every observation reads `failedAttempts: 0` and `tipSol: 0`. This measurement is
 * therefore about **whether a bound exists**, which is what 500a is about, and says nothing about how
 * large the bounds are on a live slot.
 *
 * A candidate here is a window of `stage2_entry.maxLaunchesPerCandidate` consecutive taped launches,
 * priced through `rpc-costs.mjs` → `rpcCostSource` so the per-candidate route LATCH is the
 * production one. The tape is one deployer (n = 1), which is this population's standing limit.
 *
 * `node measure.mjs [--out <path>]`. Reads `SLOT_ZERO_DATA_ROOT` through `config/data-root.mjs`.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { POPULATION_TAPE, POPULATION_TAPE_DIR, requireDataset } from '../../../../config/data-root.mjs';
import { entryCostTargets, scoreEntry } from '../../entry.mjs';
import { SolanaRpcClient } from '../../pumpfun.mjs';
import { rpcCostSource } from '../../rpc-costs.mjs';
import { measureSubjectLaunches } from '../../stage0.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREEN = join(HERE, '..', '..');

const LAMPORTS = 1_000_000_000;
/** A flat, obviously synthetic fee. Request counts and route choices do not read it. */
const STUB_FEE_LAMPORTS = 5_000;

/**
 * A `getTransaction`-shaped row for one of the tape's transactions.
 *
 * `pumpfun.mjs` → `parseTransactionCosts` is the consumer and its requirements are exact: matching
 * `preBalances`/`postBalances`/`accountKeys` lengths, distinct keys, a signature, `err: null`.
 *
 * @param {import('../../measure.mjs').WalletTransaction} t
 * @returns {object}
 */
function stubTransactionRow(t) {
  const keys = t.wallets.map((w) => ({ pubkey: w.wallet }));
  const pre = t.wallets.map(() => 100 * LAMPORTS);
  const post = t.wallets.map((w) => Math.round((100 - w.quotedSol) * LAMPORTS));
  // A block needs at least one account and a transaction with no wallets cannot be priced at all;
  // the tape does not produce one, and if it ever did the row would be refused rather than invented.
  return {
    transaction: { signatures: [t.tx], message: { accountKeys: keys } },
    meta: { err: null, fee: STUB_FEE_LAMPORTS, preBalances: pre, postBalances: post },
  };
}

/**
 * The stub transport for one launch's walk.
 *
 * `blockServes` false is the OTHER arm of the measurement: `getBlock` answering `null`, which is
 * how this endpoint load-sheds and is the one shape that makes the new trigger cost a request it
 * cannot recover. `rpc-costs.mjs` → `rpcCostSource` latches the route off after one such probe, so
 * this arm measures the worst case rather than a per-launch penalty.
 *
 * @param {readonly import('../../measure.mjs').WalletTransaction[]} targets
 * @param {number} createSlot
 * @param {boolean} blockServes
 */
function stubFetchFor(targets, createSlot, blockServes) {
  const byTx = new Map(targets.map((t) => [t.tx, stubTransactionRow(t)]));
  const inSlot = targets.filter((t) => t.slot === createSlot);
  /** @type {string[]} */
  const methods = [];
  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ _url, /** @type {{ body: string }} */ init) => {
        const req = JSON.parse(init.body);
        methods.push(req.method);
        const result =
          req.method === 'getBlock'
            ? blockServes
              ? { transactions: inSlot.map((t) => byTx.get(t.tx)) }
              : null
            : (byTx.get(req.params[0]) ?? null);
        return {
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: '2.0', id: req.id, result }),
        };
      }
    )
  );
  return { methods, fetchImpl };
}

async function main() {
  const blockServes = !process.argv.includes('--block-unserved');
  const outArg = process.argv.indexOf('--out');
  const outPath = outArg === -1 ? join(HERE, 'result.json') : (process.argv[outArg + 1] ?? '');
  if (outPath === '') throw new Error('--out needs a path');

  const T = JSON.parse(readFileSync(join(SCREEN, 'thresholds.json'), 'utf8'));
  const entryThresholds = { ...T['stage2_entry'] };
  const costBounds = T['stage2_cost'];
  const windowCap = entryThresholds.maxLaunchesPerCandidate;

  const launches = measureSubjectLaunches(requireDataset(POPULATION_TAPE, POPULATION_TAPE_DIR));

  /** @type {{ createSlotRowsBounded: boolean, [k: string]: unknown }[]} */
  const candidates = [];
  let requestsTotal = 0;
  let launchesWalked = 0;
  let launchesObserved = 0;
  let verdictsCompared = 0;
  let verdictsMoved = 0;

  for (let i = 0; i + windowCap <= launches.length; i += windowCap) {
    const window = launches.slice(i, i + windowCap);
    // One client per candidate, exactly as `screen.mjs` builds it: the ceiling and the route latch
    // are both per candidate.
    /** @type {string[]} */
    const methods = [];
    /** The launch currently in flight. Reassigned per launch; the client is per candidate. */
    let current = /** @type {typeof fetch} */ (
      /** @type {unknown} */ (async () => {
        throw new Error('no launch in flight');
      })
    );
    const rpc = new SolanaRpcClient({
      maxRequests: costBounds.maxRpcRequestsPerCandidate,
      minIntervalMs: 0,
      sleepImpl: async () => {},
      fetchImpl: /** @type {typeof fetch} */ (
        /** @type {unknown} */ (
          async (/** @type {string} */ url, /** @type {{ body: string }} */ init) => {
            const req = JSON.parse(init.body);
            methods.push(req.method);
            return current(url, init);
          }
        )
      ),
    });

    const source = rpcCostSource(rpc, { preferBlockRoute: costBounds.preferBlockRoute });
    /** @type {Map<import('../../entry.mjs').LaunchEntry, import('../../bounds.mjs').CreateSlotCostObservation>} */
    const observations = new Map();
    /** @type {import('../../entry.mjs').LaunchEntry[]} */
    const priced = [];
    let observedHere = 0;
    let walkedHere = 0;
    const issuedBefore = rpc.issued();

    for (const l of window) {
      /** @type {import('../../entry.mjs').LaunchEntry} */
      const entry = { createSlot: l.createSlot, field: l.field };
      const targets = entryCostTargets(l.fills, entry);
      priced.push(entry);
      if (targets.length === 0) continue;
      const stub = stubFetchFor(targets, l.createSlot.slot, blockServes);
      current = stub.fetchImpl;
      walkedHere += 1;
      const walk = await source.priceLaunch({
        transactions: targets,
        createSlot: l.createSlot.slot,
        mint: l.mint,
      });
      if (walk.slotCosts !== null) {
        observedHere += 1;
        observations.set(entry, walk.slotCosts);
      }
    }

    // NO VERDICT MOVES — DEMONSTRATED RATHER THAN ASSERTED. The same launches are scored twice
    // through the production `scoreEntry`, once with the observations this walk produced and once
    // with none; `entry.verdict` and every published figure must be identical, because the ledger
    // rows gate nothing (captain decision 466).
    const withObs = scoreEntry(priced, entryThresholds, {
      createSlotCostObservations: observations,
    });
    const without = scoreEntry(priced, entryThresholds, {});
    const moved = withObs.verdict !== without.verdict;
    verdictsCompared += 1;
    if (moved) verdictsMoved += 1;

    const requests = rpc.issued() - issuedBefore;
    requestsTotal += requests;
    launchesWalked += walkedHere;
    launchesObserved += observedHere;

    const ledgerRows = Object.fromEntries(
      withObs.costLedger.map((r) => [r.name, r.worstCaseSol]),
    );
    candidates.push({
      firstLaunchIndex: i,
      launchesInWindow: window.length,
      launchesWalked: walkedHere,
      launchesScored: withObs.launchesSampled,
      launchesObserved: observedHere,
      requests,
      getBlockRequests: methods.filter((m) => m === 'getBlock').length,
      getTransactionRequests: methods.filter((m) => m === 'getTransaction').length,
      createSlotRowsBounded:
        ledgerRows['landing-tip-create-slot'] !== null &&
        ledgerRows['failed-attempts-create-slot'] !== null,
      exitVerdict: withObs.exitVerdict,
      entryVerdict: withObs.verdict,
      entryVerdictWithoutObservations: without.verdict,
      entryVerdictMoved: moved,
    });
  }

  const boundedCandidates = candidates.filter((c) => c.createSlotRowsBounded).length;
  const out = {
    generatedFrom: POPULATION_TAPE,
    blockServes,
    windowCap,
    candidates: candidates.length,
    launchesWalked,
    launchesObserved,
    requestsTotal,
    candidatesWithBothCreateSlotRowsBounded: boundedCandidates,
    verdictsCompared,
    verdictsMoved,
    perCandidate: candidates,
  };
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(
    `${blockServes ? 'getBlock SERVES' : 'getBlock SHEDS'}: ${candidates.length} candidate(s), ${launchesWalked} launch(es) walked, ` +
      `${requestsTotal} RPC request(s), ${launchesObserved} launch(es) with a create-slot ` +
      `observation, ${boundedCandidates} candidate(s) with BOTH create-slot ledger rows bounded, ` +
      `${verdictsMoved} of ${verdictsCompared} entry verdict(s) moved.\n`,
  );
}

await main();
