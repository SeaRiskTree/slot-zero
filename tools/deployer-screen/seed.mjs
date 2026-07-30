/**
 * Stage 1a — enumerate candidate deployers from MadeOnSol's free endpoints.
 *
 * The vendor is a **seed**, not a measurement. Everything downstream recomputes what it needs from
 * per-token records and nothing inherits an aggregate. But the *selection* is unavoidably theirs,
 * and that has consequences worth stating rather than burying.
 *
 * ## Why the leaderboard alone is the wrong seed — measured, 2026-07-29
 *
 * Both useful leaderboard orderings are **degenerate at the extreme this tool would read**:
 *
 * - `sort=bonding_rate` DESC returns a wall of wallets with `total_tokens_deployed: 1`,
 *   `total_bonded: 1`, `bonding_rate: 1.0`. That is their `rising` tier by definition — *"1-3
 *   deploys with 100% bond rate"* — and the ones we sampled last deployed in **May 2024**. A
 *   perfect rate over one launch two years ago.
 * - `sort=total_bonded` DESC returns industrial spam: 8,518 deployed / 127 bonded = **0.0149**,
 *   then 2,660/100, then 4,324/89. Every one graded `cold`.
 *
 * So sorting by rate finds n=1 flukes and sorting by volume finds spammers, and a first run against
 * the leaderboard alone gated twelve wallets that were all a single token. The gate rejected all
 * twelve correctly, which is how the seed problem became visible.
 *
 * ## What this enumerates instead
 *
 * Endpoints that surface **currently active** deployers rather than the tails of a ranking, each
 * of which embeds a deployer block we can pre-filter on:
 *
 * - `recent-bonds` — tokens that graduated recently, from tracked deployers. The single best seed
 *   available: a deployer appearing here is bonding curves *now*.
 * - `alerts` — recent launches from profiled deployers. Catches active deployers whose latest
 *   launches have not bonded, which `recent-bonds` structurally cannot.
 * - `leaderboard?sort=total_bonded` — kept as a third, different ordering so the pool is not purely
 *   recency-selected. Its top is spam, and the pre-filter below is what makes it survivable.
 *
 * ## The pre-filter, and the one place a vendor aggregate is allowed to be read
 *
 * {@link prefilterReason} reads `total_tokens_deployed` and `total_bonded` off the embedded block
 * **solely to avoid spending a request** on a wallet that cannot possibly clear the gate. It never
 * reaches a verdict, a rate, or an output number. The distinction matters and it is enforced by
 * the tests: a wallet the pre-filter admits is still measured from scratch.
 *
 * Its bias is stated rather than hidden: because their counters are a trailing ~7.5-day window,
 * a floor on them is a **cadence** filter. A deployer that launches steadily but slowly can be
 * filtered out. That is a real limitation of using their enumeration and it is why the floor is set
 * low — low enough to remove only the one-token wallets that made the first run useless.
 */

/** `recent-bonds` `limit` maximum. */
export const RECENT_BONDS_MAX_LIMIT = 50;
/** `alerts` `limit` maximum. */
export const ALERTS_MAX_LIMIT = 100;
/** `leaderboard` `limit` maximum. */
export const LEADERBOARD_MAX_LIMIT = 50;

/**
 * Minimum trailing-window deploy count for a wallet to be worth a profile request.
 *
 * Deliberately low. Our subject deployer reads `total_tokens_deployed: 20` in that window and
 * yields 70 records from `pump_tokens`, so 5 is far below anything that could exclude a genuine
 * candidate while still removing the `rising`-tier one-token wallets that consumed an entire first
 * run.
 */
export const PREFILTER_MIN_DEPLOYED = 5;

/**
 * @typedef {object} SeedPlanEntry
 * @property {string} path
 * @property {Record<string, string | number>} query
 * @property {string} label Provenance, recorded against every wallet this query surfaces.
 */

/**
 * @typedef {object} SeedCandidate
 * @property {string} wallet
 * @property {string[]} seededBy
 * @property {number} bestRank
 * @property {number | null} vendorDeployed Trailing-window count, for the pre-filter only.
 * @property {number | null} vendorBonded   Trailing-window count, for the pre-filter only.
 */

/**
 * Build the enumeration request plan.
 *
 * Pure and deterministic, which is what makes `--dry-run` an honest preview rather than an
 * approximation: the plan the dry run prints is built by this same function.
 *
 * @param {object} options
 * @param {number} options.limit Rows per page, clamped per endpoint.
 * @param {string} [options.tier] Optional tier filter — `elite|good|moderate|rising|cold`.
 * @returns {SeedPlanEntry[]}
 */
export function buildSeedPlan(options) {
  const want = Math.max(1, Math.floor(options.limit));
  const tier = options.tier;

  /** @type {SeedPlanEntry[]} */
  const plan = [];

  // Ordered best-seed-first, so a run that hits its ceiling early still spent it on the good ones.
  plan.push({
    path: '/deployer-hunter/recent-bonds',
    query: {
      limit: Math.min(want, RECENT_BONDS_MAX_LIMIT),
      ...(tier === undefined ? {} : { tier }),
    },
    label: `recent-bonds${tier === undefined ? '' : `:${tier}`}`,
  });

  plan.push({
    path: '/deployer-hunter/alerts',
    query: {
      limit: Math.min(Math.max(want, 50), ALERTS_MAX_LIMIT),
      ...(tier === undefined ? {} : { tier }),
    },
    label: `alerts${tier === undefined ? '' : `:${tier}`}`,
  });

  plan.push({
    path: '/deployer-hunter/leaderboard',
    query: {
      sort: 'total_bonded',
      limit: Math.min(want, LEADERBOARD_MAX_LIMIT),
      ...(tier === undefined ? {} : { tier }),
    },
    label: `leaderboard:total_bonded${tier === undefined ? '' : `:${tier}`}`,
  });

  return plan;
}

/**
 * Pull the rows out of whichever envelope arrived.
 *
 * Their OpenAPI document declares no response schemas at all — every operation is
 * `200: {description: "OK"}` — so the shape is discovered rather than contracted. Unknown shapes
 * yield nothing rather than a guess.
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>[]}
 */
export function extractRows(body) {
  if (Array.isArray(body)) return /** @type {Record<string, unknown>[]} */ (body);
  if (typeof body !== 'object' || body === null) return [];
  const obj = /** @type {Record<string, unknown>} */ (body);
  for (const key of ['deployers', 'leaderboard', 'bonds', 'alerts', 'tokens', 'data', 'items', 'results']) {
    const v = obj[key];
    if (Array.isArray(v)) return /** @type {Record<string, unknown>[]} */ (v);
  }
  return [];
}

/**
 * @typedef {object} ExtractedWallet
 * @property {string} wallet
 * @property {number | null} vendorDeployed
 * @property {number | null} vendorBonded
 */

/**
 * Read wallets, and the embedded deployer block where one is present, out of a seed response.
 *
 * `recent-bonds` and `alerts` nest the block under `deployer`; the leaderboard puts the fields on
 * the row itself. Both are handled, and a row carrying neither still yields its wallet — the
 * pre-filter treats an absent count as unknown rather than as zero, so a shape change costs
 * requests instead of silently emptying the candidate list.
 *
 * @param {unknown} body
 * @returns {ExtractedWallet[]}
 */
export function extractWallets(body) {
  /** @type {ExtractedWallet[]} */
  const out = [];

  for (const row of extractRows(body)) {
    if (typeof row === 'string') {
      out.push({ wallet: row, vendorDeployed: null, vendorBonded: null });
      continue;
    }
    if (typeof row !== 'object' || row === null) continue;

    const nested = row['deployer'];
    const block =
      typeof nested === 'object' && nested !== null ? /** @type {Record<string, unknown>} */ (nested) : row;

    const raw =
      block['wallet_address'] ??
      block['wallet'] ??
      block['address'] ??
      row['wallet_address'] ??
      row['deployer_wallet'] ??
      row['creator'];
    if (typeof raw !== 'string' || raw.length === 0) continue;

    const deployed = Number(block['total_tokens_deployed']);
    const bonded = Number(block['total_bonded']);
    out.push({
      wallet: raw,
      vendorDeployed: Number.isFinite(deployed) ? deployed : null,
      vendorBonded: Number.isFinite(bonded) ? bonded : null,
    });
  }
  return out;
}

/**
 * Decide whether a seeded wallet is worth spending a profile request on.
 *
 * **This is the only place a vendor aggregate is read, and it can only ever cause us to skip a
 * request — never to produce, adjust or order an output number.** An unknown count admits the
 * wallet: paying a request to find out is the right side to err on.
 *
 * @param {SeedCandidate} c
 * @param {number} [minDeployed]
 * @returns {string | null} A reason to skip, or `null` to proceed.
 */
export function prefilterReason(c, minDeployed = PREFILTER_MIN_DEPLOYED) {
  if (c.vendorDeployed === null) return null;
  if (c.vendorDeployed < minDeployed) {
    return (
      `vendor's trailing-window count is ${c.vendorDeployed} deploy${c.vendorDeployed === 1 ? '' : 's'}` +
      `${c.vendorBonded === null ? '' : ` / ${c.vendorBonded} bonded`}, below the ${minDeployed} ` +
      `worth a request — this is their 'rising' tier, a perfect rate over a handful of launches`
    );
  }
  return null;
}

/**
 * Merge enumeration results into a deduplicated, provenance-carrying candidate list.
 *
 * Order is deterministic: wallets seen by more queries first (a name that recurs across three
 * different endpoints is a better use of a request than one that appears on a single list), then by
 * first-seen position, then by address. Determinism matters because the candidate cap truncates
 * this list, and a non-deterministic order would make two runs spend quota on different wallets for
 * no reason.
 *
 * @param {readonly { label: string, wallets: readonly ExtractedWallet[] }[]} results
 * @returns {SeedCandidate[]}
 */
export function mergeSeeds(results) {
  /** @type {Map<string, SeedCandidate>} */
  const seen = new Map();

  for (const { label, wallets } of results) {
    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i];
      if (w === undefined) continue;
      const entry = seen.get(w.wallet);
      if (entry === undefined) {
        seen.set(w.wallet, {
          wallet: w.wallet,
          seededBy: [label],
          bestRank: i,
          vendorDeployed: w.vendorDeployed,
          vendorBonded: w.vendorBonded,
        });
      } else {
        if (!entry.seededBy.includes(label)) entry.seededBy.push(label);
        if (i < entry.bestRank) entry.bestRank = i;
        // Keep the largest counter seen: different endpoints embed blocks refreshed at different
        // times, and the pre-filter should err towards spending a request.
        if (w.vendorDeployed !== null) {
          entry.vendorDeployed =
            entry.vendorDeployed === null ? w.vendorDeployed : Math.max(entry.vendorDeployed, w.vendorDeployed);
        }
        if (w.vendorBonded !== null) {
          entry.vendorBonded =
            entry.vendorBonded === null ? w.vendorBonded : Math.max(entry.vendorBonded, w.vendorBonded);
        }
      }
    }
  }

  return [...seen.values()].sort((a, b) => {
    if (a.seededBy.length !== b.seededBy.length) return b.seededBy.length - a.seededBy.length;
    // Then the most active by the vendor's own trailing count — a request-allocation heuristic, not
    // a ranking. The gate still measures everything from scratch.
    const ad = a.vendorDeployed ?? -1;
    const bd = b.vendorDeployed ?? -1;
    if (ad !== bd) return bd - ad;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });
}
