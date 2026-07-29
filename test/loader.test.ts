import { beforeAll, describe, expect, it } from 'vitest';

import {
  CREATE_SLOT_COHORT,
  DEPLOYER,
  Tape,
  medianGross,
  percentile,
  sumGross,
  type ClosedPair,
  type OpenPair,
} from '../src/index.js';

let tape: Tape;
beforeAll(() => {
  tape = Tape.load();
});

describe('the three traps, enforced', () => {
  it('an open pair carries no realised P&L field at all', () => {
    // The type says so; asserted at runtime so a refactor cannot quietly reintroduce it.
    const open = tape.openPairs();
    expect(open.length).toBe(24_220);
    for (const p of open.slice(0, 500)) {
      expect(p).not.toHaveProperty('realisedSolGrossOfFees');
      expect(p).toHaveProperty('incompleteRealisedSolGrossOfFees');
      // Both residual bounds are present — report §4.1 says to read them as a pair.
      expect(p).toHaveProperty('residualMarkWindowSolGrossOfFees');
      expect(p).toHaveProperty('residualMarkNowSolGrossOfFees');
    }
  });

  it('summing open pairs as if they were closed fabricates a loss', () => {
    // Why the field is absent, demonstrated. The open population is 52% of all pairs and
    // 89% of it never sells inside the window, so its truncated "realised" is nearly all
    // buys — a large negative that is not a loss anyone took.
    const open = tape.openPairs();
    const naive = sumGross(open.map((p) => p.incompleteRealisedSolGrossOfFees)) as number;
    const honest = sumGross(tape.closedRoundTrips().map((p) => p.realisedSolGrossOfFees)) as number;
    expect(naive).toBeLessThan(-5_000);
    expect(honest).toBeGreaterThan(0);
  });

  it('open pairs are late, small and holding (report §4.1)', () => {
    const open = tape.openPairs();
    const closed = tape.closedRoundTrips();
    const medStake = (ps: readonly (ClosedPair | OpenPair)[]) =>
      medianGross(ps.map((p) => p.solInGrossOfFees)) as number;
    const medEntry = (ps: readonly (ClosedPair | OpenPair)[]) => {
      const v = ps.map((p) => p.firstTS).sort((a, b) => a - b);
      return v[v.length >> 1] as number;
    };
    expect(medStake(open)).toBeCloseTo(0.244, 2);
    expect(medStake(closed)).toBeCloseTo(0.474, 2);
    expect(medEntry(open)).toBeCloseTo(30, 0);
    expect(medEntry(closed)).toBeCloseTo(11, 0);
    expect(open.filter((p) => p.nSells === 0).length / open.length).toBeCloseTo(0.89, 2);
  });

  it('create-slot pairs are 81% closed — the finding depends least on the assumption', () => {
    // report §4.1: the 48%-closed limitation bites least exactly where §5's finding lives.
    const cs = tape.pairs().filter((p) => p.inCreateSlot);
    expect(cs.filter((p) => p.closedInWindow).length / cs.length).toBeCloseTo(0.81, 2);
  });

  it('a truncated dev exit exposes no complete net figure', () => {
    for (const l of tape.launchesWithTruncatedDevExit()) {
      expect(l.dev.complete).toBe(false);
      expect(Object.keys(l.dev)).not.toContain('netSolGrossOfFees');
      expect(Object.keys(l.dev)).not.toContain('zeroS');
      expect(Object.keys(l.dev)).toContain('windowTruncatedNetSolGrossOfFees');
    }
  });

  it('gross and net never mix: only onchain_* produces NetSol', () => {
    // A structural check on the source, not on values: every `NetSol` in the loader is
    // minted by `lamportsToNetSol` or `netSol`, and both are only reachable from the
    // onchain readers. Asserted by grepping the sources, which is cheap and honest.
    const src = readSources();
    for (const [file, text] of src) {
      if (file === 'src/units.ts' || file === 'src/tape.ts') continue;
      expect(text, `${file} must not mint NetSol`).not.toMatch(/\bnetSol\(/);
    }
    const tapeSrc = src.get('src/tape.ts') as string;
    // The only NetSol minting in tape.ts is inside the onchain readers.
    expect(tapeSrc.match(/lamportsToNetSol\(/g)?.length).toBe(2);
  });
});

describe('derived views', () => {
  it('slotsAfterCreate is derived and non-negative where a create slot is known', () => {
    const withSlot = tape.pairs().filter((p) => p.slotsAfterCreate !== null);
    expect(withSlot.length).toBe(tape.pairs().length); // all 235 taped launches have one
    expect(withSlot.every((p) => (p.slotsAfterCreate as number) >= 0)).toBe(true);
    // `in_create_slot` and a derived offset of 0 must agree exactly.
    for (const p of tape.pairs()) {
      expect(p.inCreateSlot, `${p.mint}/${p.wallet}`).toBe(p.slotsAfterCreate === 0);
    }
  });

  it('the create slot is unambiguous on every taped launch', () => {
    expect(tape.createSlotByMint().size).toBe(235);
  });

  it('the deployer never appears as a counterparty', () => {
    // wallet_launch_pnl.csv is counterparties only; the deployer's own ladder is in
    // launches.csv and dev_exit_ladder.csv.
    expect(tape.pairs().some((p) => p.wallet === DEPLOYER)).toBe(false);
    expect(tape.wallet(DEPLOYER)).toBeUndefined();
  });

  it('per-wallet aggregates agree with the per-pair rows they summarise', () => {
    // A cross-file consistency check: counterparties.csv should be a fold of
    // wallet_launch_pnl.csv. If the two ever drift, this catches it.
    const byWallet = new Map<string, ClosedPair[]>();
    for (const p of tape.closedRoundTrips()) {
      const list = byWallet.get(p.wallet);
      if (list) list.push(p);
      else byWallet.set(p.wallet, [p]);
    }
    for (const wallet of [...CREATE_SLOT_COHORT, '2CQgjcdNEo7WtbQLpJTAVcC3Ga61pNvRDTgP5grzctFG']) {
      const agg = tape.wallet(wallet);
      const pairs = byWallet.get(wallet) ?? [];
      expect(agg?.launchesClosedInWindow, wallet).toBe(pairs.length);
      expect(agg?.pnlClosedSolGrossOfFees as number, wallet).toBeCloseTo(
        sumGross(pairs.map((p) => p.realisedSolGrossOfFees)) as number,
        2,
      );
    }
  });

  it('the four un-taped launches expose no trade-derived fields', () => {
    for (const l of tape.launches().filter((l) => l.tape === 'none')) {
      expect(l.dev).toBeNull();
      expect(l.tapeWindowS).toBeNull();
      expect(l).not.toHaveProperty('nTrades');
      // ...but the on-chain census is independent of the tape and is still there.
      expect(l.chainTxTotal === null || l.chainTxTotal > 0).toBe(true);
    }
  });
});

describe('data hazards this dataset actually contains', () => {
  it('symbols are NOT unique — mint is the key', () => {
    // Two launches are called `maxxing`, one of them the operator's best result ever.
    // A `find(l => l.symbol === …)` returns whichever comes first in the file.
    const bySymbol = new Map<string, number>();
    for (const l of tape.launches()) bySymbol.set(l.symbol, (bySymbol.get(l.symbol) ?? 0) + 1);
    const dupes = [...bySymbol].filter(([, n]) => n > 1);
    expect(dupes.length).toBeGreaterThan(0);
    expect(dupes.map(([s]) => s)).toContain('maxxing');
    // Mints, by contrast, are unique across all three tables.
    expect(new Set(tape.launches().map((l) => l.mint)).size).toBe(239);
  });

  it('the CSV reader handles quoted fields containing commas', () => {
    // Two token names in launches.csv are quoted and contain a comma. A naive split(',')
    // shifts every later column on those rows — a silent corruption, not a crash.
    const quoted = tape.launches().filter((l) => l.name.includes(','));
    expect(quoted.length).toBe(2);
    for (const l of quoted) {
      expect(l.mint).toMatch(/pump$/);
      expect(l.createdUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number.isFinite(l.graduated ? 1 : 0)).toBe(true);
    }
  });

  it('percentiles use the linear convention the report used', () => {
    // Nearest-rank gives −0.2372 where the report publishes −0.238.
    const v = tape.onchainRoundTrips().filter((t) => t.isCohort).map((t) => t.netSol);
    expect(percentile(v, 0.25)).toBeCloseTo(-0.238, 3);
    expect(percentile(v, 0.75)).toBeCloseTo(2.068, 3);
  });
});

describe('the raw window tape', () => {
  it('reads back a launch fill-by-fill, with the deployer buy first', () => {
    // shrek — the launch report kol-dev-wallet-sell-side §2.1 walks transaction by
    // transaction. Its first tape row is the deployer's own create+dev-buy.
    const trades = tape.windowTape('EiAsJvYospNxVPtUoGbjUreXNbWcxdpKaiqeJNk6pump');
    expect(trades).toBeDefined();
    const first = (trades as NonNullable<typeof trades>)[0];
    expect(first?.wallet).toBe(DEPLOYER);
    expect(first?.side).toBe('buy');
    expect(first?.venue).toBe('pump');
    // The fixed preset: 354,710,743.772565 tokens for 14.814814814 SOL.
    expect(first?.tokens).toBeCloseTo(354_710_743.772565, 4);
    expect(first?.solGrossOfFees).toBeCloseTo(14.814814814, 6);
  });

  it('meta says a launch is covered only when it reached the mint', () => {
    const meta = tape.windowMeta('EiAsJvYospNxVPtUoGbjUreXNbWcxdpKaiqeJNk6pump');
    expect(meta?.reachedMint).toBe(true);
    expect(meta?.complete).toBe(true);
    expect(meta?.windowMs).toBeGreaterThanOrEqual(60_000);
  });

  it('the four un-taped launches yield no window tape, despite having a window file', () => {
    // All 239 mints have a `.jsonl.gz` and a `.meta.json`. For these four the walk never
    // reached the mint, and the file holds unrelated later trading — `Marciana`'s 1,000
    // rows are PumpSwap fills from 2026-07-20, six days after it launched. A reader that
    // gated on file existence rather than `reached_mint` would serve those as a launch
    // window. That is exactly the bug this test exists to prevent.
    const untaped = tape.launches().filter((l) => l.tape === 'none');
    expect(untaped).toHaveLength(4);
    for (const l of untaped) {
      expect(tape.windowMeta(l.mint)?.reachedMint, l.symbol).toBe(false);
      expect(tape.windowTape(l.mint), l.symbol).toBeUndefined();
      // The partial walk is still reachable, under a name that says what it is.
      expect(tape.incompleteWindowTape(l.mint)?.length, l.symbol).toBeGreaterThan(0);
    }
  });

  it('every taped launch has reached_mint, and every un-taped one does not', () => {
    for (const l of tape.launches()) {
      expect(tape.windowMeta(l.mint)?.reachedMint, l.symbol).toBe(l.tape !== 'none');
    }
  });

  it('window fill counts agree with n_trades in launches.csv', () => {
    // Sampled rather than exhaustive: 235 gunzips is slow and this is a spot check.
    for (const l of tape.tapedLaunches().slice(0, 12)) {
      const trades = tape.windowTape(l.mint);
      expect(trades?.length, l.symbol).toBe(l.nTrades);
    }
  });
});

// --------------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

function readSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(SRC_DIR)) {
    if (f.endsWith('.ts')) out.set(`src/${f}`, readFileSync(join(SRC_DIR, f), 'utf8'));
  }
  return out;
}

describe('this repo does not reach the network and reads no credential', () => {
  it('no source file performs a network call', () => {
    // The spend bound is structural, not a promise. Everything the loader needs is on
    // disk; nothing in src/ may open a socket.
    const forbidden = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /from\s+['"]node:(https?|net|tls|dgram|dns)['"]/,
      /require\(['"](https?|net|tls|dgram|dns|axios|node-fetch|undici)['"]\)/,
      /from\s+['"](axios|node-fetch|undici|got)['"]/,
    ];
    for (const [file, text] of readSources()) {
      for (const re of forbidden) {
        expect(re.test(text), `${file} matches ${re}`).toBe(false);
      }
    }
  });

  it('no source file reads an API key or any environment variable', () => {
    for (const [file, text] of readSources()) {
      expect(/process\.env/.test(text), `${file} reads process.env`).toBe(false);
      expect(/API_KEY|SECRET|_TOKEN\b|Bearer /i.test(text), `${file} mentions a credential`).toBe(
        false,
      );
    }
  });

  it('the package declares no runtime dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
