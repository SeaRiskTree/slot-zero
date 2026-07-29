/**
 * Named wallets. Every one of these is a measured fact with a source; nothing here is a
 * guess about ownership.
 */

/** The deployer under study. `report.md`, subject line. */
export const DEPLOYER = '7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL';

/**
 * The six wallets in the create slot of essentially every launch (`report.md` §4.3, §5.4).
 *
 * **Evidence**: presence on every launch across eight months; entry as two three-signer
 * transactions paying 0.0009 SOL of fees; fills at 1.08–1.41× the deployer's own price
 * where outsiders pay 2–3×; and **zero appearances across 70 other deployers' launches**
 * (`report.md` §6) while genuine general-purpose snipers appear on 9 and 8 of them.
 *
 * **Inference, and the report labels it as such**: that they are part of the operation
 * rather than independent traders. Common ownership is *not* established — a funding or
 * cluster analysis would settle it and has not been run. This constant is a measured
 * grouping, not an ownership claim.
 *
 * Ordered by create-slot presence: 235, 235, 235, 174, 173, 88 of 235 taped launches.
 */
export const CREATE_SLOT_COHORT: readonly string[] = [
  '2CHrnc2LyagAbMaMFgthiDWh7ZZ9zT9TF8WEJf7MNE71',
  'Atgx1JXsp8pTQ9Qsi74wF5pLMVwHwyQc6jJCu84evN7c',
  '8kzFH4rgFzy4ccz97AhgqRT7Qbt7HnD5oJCDK1Sxdarb',
  'GfJA84gwT9LpeyzeckeXkCsf8vdQuA64ZYQ91xoBawvt',
  '5P8A9bGUhroskpuA4hhRbybgt37TcTz7ft5zLAh8orpn',
  '43x1zWzjVWJbQErWM78m3Acx83FFuGSQEhmgyxUrPdQs',
];

const COHORT_SET: ReadonlySet<string> = new Set(CREATE_SLOT_COHORT);

export const isCohort = (wallet: string): boolean => COHORT_SET.has(wallet);

/**
 * The two unaffiliated wallets that win at scale — and **the whole positive strategy
 * result in `report.md` §5.7, out of 20,388 counterparties.**
 *
 * They pay 2.0–2.3× where the cohort pays 1.08–1.22×, bid real priority fees where the
 * cohort pays none, miss launches, and one of them appears in the control. Net of every
 * fee: +47.8 and +47.1 SOL.
 *
 * **Whether they are genuine outsiders is not settled** (`report.md` §7, §10.3). If they
 * turn out to be the operator's second book, the positive case collapses to zero. The
 * settling evidence is a funding graph nobody has built. Do not build a strategy on these
 * two before that question is answered — see this repo's README, "What is open".
 */
export const UNSETTLED_OUTSIDERS: readonly string[] = [
  '5brv79eFZ2rGprXNvqgVJBkBptkkw8GJX1XydJyZLyAr',
  'EgQX9R3Qph1dPHE1Ysou1auSYqRGomCNmLDC28Yg77aq',
];

/**
 * The wallet that is +31.2 SOL on the tape and −12.2 SOL in reality, after 11.9 SOL of
 * priority fees bidding for create-slot inclusion (`report.md` §5.5). Kept here because it
 * is the canonical regression case for the gross/net distinction: any analysis that ranks
 * this wallet as a winner has read a gross column as money.
 */
export const GROSS_NET_SIGN_FLIP_WALLET = '2CQgjcdNEo7WtbQLpJTAVcC3Ga61pNvRDTgP5grzctFG';

/**
 * The two wallets running the reacting-bot strategy at scale, and losing: 51 and 52
 * launches, median +1 s entry at ~3× the deployer's price, ~42 s hold, −106.8 and −100.0
 * SOL (`report.md` §5.6). The largest losers in the dataset.
 */
export const REPEAT_LOSERS: readonly string[] = [
  'C989QoG39etYt32zfE7mHYqJwFh1kJK4fBrmsySFjzaS',
  '4o9ndxqonUYamkzjHT6hCU6tNmg8VFcyhMqsxeTg4K37',
];
