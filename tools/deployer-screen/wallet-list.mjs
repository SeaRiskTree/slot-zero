/**
 * Stage 1a, the OTHER way in — a wallet list this project already enumerated somewhere else.
 *
 * `seed.mjs` asks MadeOnSol *which deployers exist*. This module asks nobody: it reads a file of
 * addresses and hands them to the same gate, in the same shape, through the same loop.
 *
 * ## Why it exists — captain decision 398a, 2026-08-09
 *
 * Supply, not measuring capacity, is what binds the captain's floor of 1,000 distinct usable
 * windows a month. The reachable population yields ~309 a month against a capacity of ~1,160 — both
 * at the pooled usable fraction of 0.5526, which
 * `measurements/2026-08-09-widened-usable-fraction/` has since SUPERSEDED for this population at
 * 0.1810, restating those two as ~101 and ~380 and finding the ladder short of the 1,000 floor. The
 * argument for this input is unaffected and the arithmetic below is left as 398a was decided on;
 * cite that measurement for any sizing. And
 * **37 of the 58 pump.fun deployers that passed the committed competence gate in 2026-07 — 64% of
 * them — are invisible to every discovery source this repo has**, worth 1,442 distinct windows a
 * month between them.
 *
 * The finding that makes this a three-hundred-line change rather than a lane of its own, measured
 * 2026-08-09: **the vendor gatekeeps ENUMERATION, not measurement.**
 * `/deployer-hunter/{wallet}` returned a full 70-record `pump_tokens` profile for two wallets the
 * vendor's own hunter feeds have never surfaced, identical in shape to a known tier wallet's — n=2
 * plus one control, an observation rather than a rate, and it is the observation this whole change
 * rests on. So Stage 2 already has everything it needs for such a wallet the moment Stage 1 has
 * paid for its profile; what was missing was only a way to hand the screen a list.
 * `slot-zero-discovery-beyond-madeonsol` → `report.md` §5.1 owns the measurement, held in
 * firstmate's records, not in this repo.
 *
 * ## THE SAFETY CONSTRAINT THE CAPTAIN'S CHOICE CARRIES
 *
 * 398a chose the UNRESTRICTED input over an offered variant that would have accepted only addresses
 * this project's own enumeration produced. That makes {@link WALLET_LIST_IS_A_SEED} a hard
 * requirement of the implementation rather than a principle: a listed wallet is gated exactly as a
 * vendor-seeded one is, and there is no path by which a listed address reaches Stage 2 without a
 * verdict. The concrete reason, rather than the general one: the creation census measured its own
 * bonding reading and the screen's creation-derived merged history agreeing on 488 of 490 wallets,
 * but **not robustly on the high-volume wallets the gate actually admits** — which is precisely the
 * population a supplied list adds.
 *
 * ## The format, and why every failure is loud
 *
 * One address per line. Everything from a `#` to the end of the line is a comment — base58 excludes
 * `#`, so no address can be truncated by that rule. Blank lines are skipped.
 *
 * A malformed entry, a line carrying two tokens, a duplicate, or an empty list all REFUSE the run
 * with the line number rather than being dropped. That is the same asymmetry the rest of this tool
 * is built on, one stage earlier: a silently dropped address is a deployer that was never measured
 * and never reported as unmeasured, which is the invisible false rejection the screen exists to
 * remove — and here it would be invisible to the operator who typed the list.
 */

/**
 * Base58, 32–44 characters — a Solana address's shape and nothing narrower.
 *
 * **A DELIBERATE COPY of `dune.mjs` → `WALLET_SHAPE`, and `test/deployer-screen.test.ts` pins the
 * two equal.** Not an import: that constant is documented as the guard on wallets reaching a QUERY
 * LANGUAGE, and this one is the guard on an operator's own file reaching the gate. They agree today
 * because a Solana address has one shape; they answer different questions, and a future narrowing of
 * either has to be argued about the other rather than inherited by it.
 *
 * It is a SHAPE check and not an existence check. Nothing here can say whether an address is a
 * pump.fun deployer, a wallet at all, or a typo that happens to be base58 — the gate answers that,
 * for real, one stage later.
 */
export const WALLET_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The one sentence 398a's safety constraint is carried by, printed once per run and persisted.
 *
 * It is a constant rather than a paragraph in a README for the same reason `identity.mjs` →
 * `CITATION_RULE` is: a caveat that lives only in documentation travels nowhere, and this one has to
 * reach the operator who supplied the list and the reader of the record it produced. A test asserts
 * it reaches both.
 */
export const WALLET_LIST_IS_A_SEED =
  'A supplied wallet list is a SEED, never a substitute for the gate: every listed wallet is ' +
  'measured by the committed Stage 1 competence bars exactly as a vendor-seeded one is, and a ' +
  'listed wallet that fails them is rejected and never scored.';

/** Provenance label prefix. Every listed candidate's `seededBy` carries `<prefix>:<file>`. */
export const WALLET_LIST_LABEL_PREFIX = 'wallet-list';

/**
 * The provenance label a listed candidate is recorded under.
 *
 * The file's own base name, so a record says WHICH list produced a candidate rather than only that
 * some list did — two lists in one week is the normal case for a lane that is fed by other lanes.
 * The label shares `seededBy` with the vendor seeds' labels and cannot collide with one: those are
 * endpoint names (`recent-bonds:good`, `leaderboard:total_bonded`) and this one is prefixed.
 *
 * @param {string} path
 * @returns {string}
 */
export function walletListLabel(path) {
  const base = path.split(/[\\/]/).filter((s) => s.length > 0).pop() ?? path;
  return `${WALLET_LIST_LABEL_PREFIX}:${base}`;
}

/**
 * @typedef {object} WalletListRead
 * @property {true} ok
 * @property {string[]} wallets      In file order, deduplicated by construction (a duplicate refuses).
 * @property {number} entriesRead    Non-blank, non-comment lines. Equal to `wallets.length`, and both
 *   are recorded so a reader can see the file held nothing else.
 * @property {string} label          {@link walletListLabel} of the source path.
 */

/**
 * @typedef {{ ok: false, message: string }} WalletListRefusal
 */

/** How many bad lines are named before the message summarises the rest. */
const MAX_REPORTED = 10;

/**
 * Read a wallet list, or refuse it with every reason at once.
 *
 * **Every problem in the file is reported in one message**, not the first one. An operator fixing a
 * hand-assembled list one refusal per run is an operator who eventually stops reading them, and this
 * check costs nothing to do exhaustively.
 *
 * @param {string} text Raw file contents.
 * @param {string} source The path, for the label and for the message.
 * @returns {WalletListRead | WalletListRefusal}
 */
export function readWalletList(text, source) {
  /** @type {string[]} */
  const wallets = [];
  /** @type {Map<string, number>} */
  const firstSeen = new Map();
  /** @type {string[]} */
  const problems = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i] ?? '';
    // base58 excludes `#`, so cutting at the first one can never truncate an address.
    const hash = raw.indexOf('#');
    const body = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (body.length === 0) continue;

    const tokens = body.split(/\s+/);
    if (tokens.length > 1) {
      problems.push(
        `line ${lineNo}: ${tokens.length} tokens on one line — this format is ONE address per line, ` +
          `and a line holding more is refused rather than guessed at`,
      );
      continue;
    }
    const wallet = tokens[0] ?? '';
    if (!WALLET_SHAPE.test(wallet)) {
      problems.push(
        `line ${lineNo}: not a base58 Solana address (${wallet.length} character(s)) — ` +
          `checked for SHAPE only, so this one is not even the right kind of string`,
      );
      continue;
    }
    const seen = firstSeen.get(wallet);
    if (seen !== undefined) {
      problems.push(
        `line ${lineNo}: duplicate of line ${seen} — a repeated address would be gated twice and ` +
          `charged twice, so it is refused rather than deduplicated silently`,
      );
      continue;
    }
    firstSeen.set(wallet, lineNo);
    wallets.push(wallet);
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_REPORTED);
    const rest = problems.length - shown.length;
    return {
      ok: false,
      message:
        `${source} holds ${problems.length} unusable entr${problems.length === 1 ? 'y' : 'ies'}, and ` +
        `NONE of the file was used — a list is taken whole or not at all, because a partially read ` +
        `list is a set of deployers nobody knows went unmeasured:\n` +
        `${shown.map((p) => `  ${p}`).join('\n')}` +
        (rest > 0 ? `\n  ... and ${rest} more` : ''),
    };
  }

  if (wallets.length === 0) {
    return {
      ok: false,
      message:
        `${source} holds no address at all. An empty list is refused rather than run as a screen ` +
        `of nobody, which would complete, exit 0 and record zero candidates — indistinguishable ` +
        `from a population that was measured and found empty.`,
    };
  }

  return { ok: true, wallets, entriesRead: wallets.length, label: walletListLabel(source) };
}

/**
 * Turn a read list into the candidate shape Stage 1 already consumes.
 *
 * The point of returning `seed.mjs`'s own {@link import('./seed.mjs').SeedCandidate} is that the
 * gate loop cannot tell the difference — there is one gating path, not two, which is what makes
 * "nothing bypasses a bar" a property of the control flow rather than a claim about it.
 *
 * **`vendorDeployed`/`vendorBonded` are `null` and that is not a gap.** They exist for
 * `seed.mjs` → `prefilterReason`, whose whole job is to avoid spending a request on a wallet the
 * vendor's own trailing counters already show cannot clear the gate. A listed wallet has no vendor
 * block — the vendor never surfaced it, which is the entire reason it is on the list — and an
 * unknown count admits, so the pre-filter is a no-op here and no vendor aggregate touches a listed
 * candidate at any point. That is deliberate: the operator has already decided to spend the request.
 *
 * `bestRank` is file order, which is what makes a run over a fixed list deterministic in exactly the
 * way a run over the seeds is.
 *
 * @param {readonly string[]} wallets
 * @param {string} label
 * @returns {import('./seed.mjs').SeedCandidate[]}
 */
export function toListedCandidates(wallets, label) {
  return wallets.map((wallet, i) => ({
    wallet,
    seededBy: [label],
    bestRank: i,
    vendorDeployed: null,
    vendorBonded: null,
    candidateSource: /** @type {const} */ ('wallet-list'),
  }));
}
