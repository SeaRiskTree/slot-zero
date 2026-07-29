import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/**
 * The raw trade tape: `window/{mint}.jsonl.gz`, one JSON object per fill, oldest first,
 * from the mint to mint + `window_ms`. 107,439 fills across 235 launches.
 *
 * Every derived table in the dataset is a projection of these files. They are the primary
 * record, and `report.md` §9.1 validated them against the chain — 46,023 tape transactions
 * over 94 launches, **zero** absent from the chain.
 *
 * Amounts arrive as decimal strings with far more precision than a double carries (`psol`
 * is quoted to 47 significant figures). They are parsed to `number` here, which is the
 * precision every derived CSV in the dataset already uses; {@link WindowTrade.raw} keeps
 * the original strings for anyone who needs them exactly.
 */
export interface WindowTrade {
  readonly slot: number;
  /** pump.fun's `slotIndexId` — the within-slot ordering key. First 12 digits are the slot. */
  readonly sid: string;
  readonly tx: string;
  /** ISO timestamp, second resolution. */
  readonly ts: string;
  /** The **swapping** wallet. In a bundled transaction this is not the fee payer. */
  readonly wallet: string;
  readonly side: 'buy' | 'sell';
  /** `pump` = the bonding curve, `pump_amm` = the graduated PumpSwap pool. */
  readonly venue: 'pump' | 'pump_amm';
  /** Swap quote SOL. **Gross of the venue fee and of this transaction's priority fee.** */
  readonly solGrossOfFees: number;
  readonly tokens: number;
  /** Price per token in SOL at this fill. */
  readonly priceSol: number;
  readonly priceUsd: number;
  readonly raw: Readonly<Record<string, string>>;
}

/** `window/{mint}.meta.json`. A launch counts as covered only when `reached_mint` is true. */
export interface WindowMeta {
  readonly mint: string;
  readonly symbol: string;
  readonly createdTimestamp: number;
  readonly windowMs: number;
  readonly n: number;
  readonly pages: number;
  readonly complete: boolean;
  readonly reachedMint: boolean;
}

export function parseWindowTape(gzipped: Buffer): WindowTrade[] {
  const text = gunzipSync(gzipped).toString('utf8');
  const out: WindowTrade[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const t = JSON.parse(line) as Record<string, string | number>;
    out.push({
      slot: Number(t['slot']),
      sid: String(t['sid']),
      tx: String(t['tx']),
      ts: String(t['ts']),
      wallet: String(t['u']),
      side: t['k'] === 'sell' ? 'sell' : 'buy',
      venue: t['p'] === 'pump_amm' ? 'pump_amm' : 'pump',
      solGrossOfFees: Number(t['sol']),
      tokens: Number(t['base']),
      priceSol: Number(t['psol']),
      priceUsd: Number(t['pusd']),
      raw: t as Readonly<Record<string, string>>,
    });
  }
  return out;
}

export function readWindowTape(path: string): WindowTrade[] {
  return parseWindowTape(readFileSync(path));
}

export function readWindowMeta(path: string): WindowMeta {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return {
    mint: String(m['mint']),
    symbol: String(m['symbol']),
    createdTimestamp: Number(m['created_timestamp']),
    windowMs: Number(m['window_ms']),
    n: Number(m['n']),
    pages: Number(m['pages']),
    complete: m['complete'] === true,
    reachedMint: m['reached_mint'] === true,
  };
}
