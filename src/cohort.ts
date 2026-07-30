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
 * **That they are part of the operation** was an inference when the tape report was written
 * and the funding graph has since turned it into an artefact
 * (`kol-cohort-vs-outsider-funding/report.md`). `2CHrnc2L…` is listed by pump.fun as the
 * current creator of **36 coins, every one on the operator's own metadata host
 * `meta.uxento.io`, one citing `genyrational` — the deployer's own promo handle** (§6.3);
 * and `43x1zWzj…` and `5P8A9bG…` have a genesis byte-identical to the deployer's own — the
 * same 3.500000000 SOL from a custodial hot wallet in the same instruction envelope, then a
 * pump.fun create-and-buy crediting the identical 3.0014616 SOL through the same tool fee
 * accounts, minutes later (§2.1).
 *
 * **Common ownership is still not formally established.** `?creator=` lists by *current*
 * creator (see AGENTS.md), so the 36 may mean "launched it" or "was given it", and nothing
 * on-chain proves ownership. This constant remains a measured grouping.
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

// ---------------------------------------------------------------------------------
// The outsiders — the whole positive strategy result
// ---------------------------------------------------------------------------------

/*
 * `5brv79eF…` and `EgQX9R3Q…` are the two unaffiliated wallets that win at scale, and
 * **the whole positive strategy result in `report.md` §5.7, out of 20,388 counterparties.**
 * They pay 2.0–2.3× where the cohort pays 1.08–1.22×, bid real priority fees where the
 * cohort pays none, miss launches, and one of them appears in the control. Net of every
 * fee, on the launches priced exactly: +47.8 and +47.1 SOL.
 *
 * ## The question this module used to encode is answered
 *
 * `UNSETTLED_OUTSIDERS` stood here because "outsider" was every discriminator's answer and
 * none of them was the funding graph. That graph has since been built —
 * `kol-cohort-vs-outsider-funding/report.md`, read-only and keyless — and it settles both
 * wallets as **genuine outsiders, confidence high**: neither one's money touches the
 * deployer or any of the six cohort wallets, tested against **complete signature sets for
 * the deployer and all six** so that any such transaction is necessarily inside them (§4.2,
 * §4.5), and each traces to a distinct funding channel the operation never uses (§5). The
 * positive case survives. It does **not** follow that the strategy works; that report
 * answers whose money it is and says so explicitly (its §7, §10).
 *
 * **What "outsider" means here, exactly:** no on-chain relationship on complete sets — not
 * provably unrelated. See {@link IndependentOutsider.outsiderConfidence} and the README's
 * "The ceiling of the method: shared custodial venues", which owns that limit and is
 * deliberately not restated here.
 *
 * ## What replaced it, and why it is a type rather than a comment
 *
 * `EgQX9R3Q…` is **not an individual trader**. It is one wallet of a sniping book of at
 * least five run out of a single bankroll, and {@link GROSS_NET_SIGN_FLIP_WALLET} — this
 * dataset's own worked example of a wallet that looks profitable and is not, at −12.2 SOL —
 * is in the same book (§8.1). Its +47.1 SOL and that wallet's −12.2 SOL are the same
 * operator's P&L, so a counterparty table that lists them as two rows is listing one trader
 * twice. **The book itself is not measured here** — it has since been measured by
 * `slot-zero-bankroll-book-pnl/report.md`, whose figures are another lane's to import.
 *
 * The two are therefore not the same kind of object, and this module stops pretending they
 * are. {@link IndependentOutsider} has a `wallet`; {@link BookMemberOutsider} does not —
 * only {@link BookMemberOutsider.oneWalletOfAnUnmeasuredBook}, beside the book it belongs
 * to and a pointer to the measurement this repo does not hold. Reading an address off the
 * {@link Outsider} union without discriminating is a compile error, which is the point:
 * the filter that reads `EgQX9R3Q…`'s figures as an independent observation cannot be
 * written by accident. See this repo's README, "What is open".
 */

/**
 * A settled outsider whose **wallet is the whole trading unit**. Nothing else in the funding
 * graph shares its bankroll, so the P&L this dataset measures for it is a complete result
 * for whoever runs it, and reads as one independent observation.
 */
export interface IndependentOutsider {
  readonly unit: 'wallet';
  /** The address. Safe to filter a P&L table by: this wallet is the unit. */
  readonly wallet: string;
  /** Its genesis funder. Shared with no other wallet in the funding graph (§2). */
  readonly fundedBy: string;
  /** What that funder is. **Inference**, labelled as such in the funding report §7. */
  readonly fundingChannel: string;
  /**
   * The funding report's verdict block. This value means *no on-chain relationship on complete
   * sets*, not *provably unrelated*. The README's "The ceiling of the method: shared custodial
   * venues" owns that limit, its evidence and the decision taken on it; do not read this field
   * as broader than what it says.
   */
  readonly outsiderConfidence: 'high';
  /**
   * The observation date on which the funding report saw this wallet still trading — §6.2,
   * balance 239.34 SOL. **A snapshot, not a present-tense fact:** this repo is offline by
   * construction and can never refresh it, so past this date the wallet's status is unknown
   * and only a new run of the funding report can move it. Contrast
   * {@link BookMemberOutsider.retiredUtc}, which is permanent.
   */
  readonly stillTradingAsOfObservation: string;
}

/**
 * A settled outsider that is **one wallet of a book**: it shares a bankroll with other
 * trading wallets, so the P&L this dataset measures for it is one leg of a total nobody has
 * measured. There is deliberately no `wallet` field — see {@link SETTLED_OUTSIDERS}.
 */
export interface BookMemberOutsider {
  readonly unit: 'book';
  /**
   * The address, under a name that cannot be mistaken for a trading unit. It is an identity,
   * not a row of a league table: a P&L read off it alone is incomplete by construction.
   */
  readonly oneWalletOfAnUnmeasuredBook: string;
  /** The bankroll that funds the book at genesis and receives its sweeps (§3.2, §8.1). */
  readonly bankroll: string;
  /**
   * The other wallets funded by the same bankroll — **including
   * {@link GROSS_NET_SIGN_FLIP_WALLET}**, whose −12.2 SOL belongs to the same operator as
   * this wallet's +47.1. Sampled, so a lower bound (§8.2).
   */
  readonly bookMates: readonly string[];
  /** Same address as {@link bankroll}: funded by, and returns to, one place (§3.2). */
  readonly fundedBy: string;
  /**
   * Same ceiling as {@link IndependentOutsider.outsiderConfidence}, and this is the wallet on
   * which it is *measured*: the bankroll and the operation demonstrably hold accounts at one
   * custodial venue. The negative holds regardless, but it is **complete on the bankroll side**
   * rather than on this wallet's: no complete signature set for the wallet itself exists
   * (~1,000,000 entries, walk abandoned at 550,000 —
   * `kol-cohort-vs-outsider-funding/report.md` §10.2), so it rests on the operation's complete
   * signature sets for the deployer and all six cohort wallets plus the `9BhkaAyb…` bankroll's
   * complete set. That is sufficient: an intersection test needs one complete side, not two.
   * Evidence and decision: the README's "The ceiling of the method: shared custodial venues";
   * which side each negative is complete on, and how it differs from
   * {@link INDEPENDENT_OUTSIDER}'s: the README's "What is open".
   */
  readonly outsiderConfidence: 'high';
  /**
   * The whole book was drained in one batch here — two book-mates stopped within two
   * seconds of it. **This corrects `report.md` §4.3's "ran March–May and stopped"**, which
   * is what its window into *this deployer's* launches shows; on-chain the wallet ran to
   * this timestamp (funding report §6.1). See
   * `data/population-tape-2026-07-29/IMPORT.md`, "Corrections".
   */
  readonly retiredUtc: string;
  /** Where the measurement that closes this lives; its figures are not imported here. */
  readonly seeAlso: 'the book is unmeasured here, and measured in slot-zero-bankroll-book-pnl/report.md — kol-cohort-vs-outsider-funding/report.md §8.1, §10.1';
}

export type Outsider = IndependentOutsider | BookMemberOutsider;

/** `5brv79eF…` — settled outsider, and its own trading unit. */
export const INDEPENDENT_OUTSIDER: IndependentOutsider = {
  unit: 'wallet',
  wallet: '5brv79eFZ2rGprXNvqgVJBkBptkkw8GJX1XydJyZLyAr',
  fundedBy: 'Bukt1ztP1AetQPdfHKUjFp7cVJPFusCNi98bvZcL7Ug5',
  fundingChannel:
    'cross-chain relay/settlement service; its first-ever instruction is a Circle CCTP v2 receive',
  outsiderConfidence: 'high',
  stillTradingAsOfObservation: '2026-07-29',
};

/** `EgQX9R3Q…` — settled outsider, and one leg of the `9BhkaAyb…` book. */
export const BOOK_MEMBER_OUTSIDER: BookMemberOutsider = {
  unit: 'book',
  oneWalletOfAnUnmeasuredBook: 'EgQX9R3Qph1dPHE1Ysou1auSYqRGomCNmLDC28Yg77aq',
  bankroll: '9BhkaAybG824w5Hk2A1Np22ZwYN74f6kisJtLEK9C6Ns',
  bookMates: [
    'HugksxcSGZnhfTuLuwnP38E94FX3HjWZfiNjiXSdx6Yh',
    'Gpb9EZXGBEvURHUJu5sLVUPerduzwafyEu7VjhhdPRS1',
    'BVGAeaRhQp8GxpfDraCSjPtF4GfgAeNYKgMyMkP8GLr8',
    '2CQgjcdNEo7WtbQLpJTAVcC3Ga61pNvRDTgP5grzctFG',
  ],
  fundedBy: '9BhkaAybG824w5Hk2A1Np22ZwYN74f6kisJtLEK9C6Ns',
  outsiderConfidence: 'high',
  retiredUtc: '2026-07-06T19:25:32Z',
  seeAlso:
    'the book is unmeasured here, and measured in slot-zero-bankroll-book-pnl/report.md — kol-cohort-vs-outsider-funding/report.md §8.1, §10.1',
};

/**
 * Both settled outsiders, as the two different kinds of object they are. Discriminate on
 * `unit` before reading an address: only {@link IndependentOutsider} has a `wallet`.
 */
export const SETTLED_OUTSIDERS: readonly Outsider[] = [INDEPENDENT_OUTSIDER, BOOK_MEMBER_OUTSIDER];

/**
 * The outsider addresses whose measured P&L reads as an independent observation. **One, not
 * two** — `EgQX9R3Q…` is absent on purpose, and adding it back is the mistake this module
 * exists to prevent.
 */
export const independentOutsiderWallets = (): readonly string[] =>
  SETTLED_OUTSIDERS.filter((o): o is IndependentOutsider => o.unit === 'wallet').map(
    (o) => o.wallet,
  );

/**
 * The wallet that is +31.2 SOL on the tape and −12.2 SOL in reality, after 11.9 SOL of
 * priority fees bidding for create-slot inclusion (`report.md` §5.5). Kept here because it
 * is the canonical regression case for the gross/net distinction: any analysis that ranks
 * this wallet as a winner has read a gross column as money.
 *
 * **It is also in `EgQX9R3Q…`'s book** (`kol-cohort-vs-outsider-funding/report.md` §8.1):
 * its −12.2 SOL and that wallet's +47.1 are the same operator's, which is why
 * {@link BOOK_MEMBER_OUTSIDER}`.bookMates` lists it and why the two are not independent
 * rows of `report.md` §4.2's counterparty table.
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
