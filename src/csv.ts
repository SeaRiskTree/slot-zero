import { readFileSync } from 'node:fs';

/**
 * A minimal RFC 4180 CSV reader. Two of the 239 rows in `launches.csv` carry a quoted
 * token name containing a comma (`"if i play, i play to win"`), so a naive `split(',')`
 * silently shifts every later column on those rows — which is exactly the class of
 * quiet corruption this repo exists to prevent. Hence a real parser rather than a split.
 *
 * Deliberately dependency-free: this repo has no runtime dependencies at all, so that
 * "does it reach the network?" is answerable by reading `src/`.
 */

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"' && field === '') {
      quoted = true;
      sawAnyChar = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      sawAnyChar = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (sawAnyChar || field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      sawAnyChar = false;
    } else {
      field += c;
      sawAnyChar = true;
    }
  }
  if (sawAnyChar || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type CsvRow = ReadonlyMap<string, string>;

/** Read a CSV file into header-keyed rows. Throws on a ragged row rather than guessing. */
export function readCsv(path: string): CsvRow[] {
  const rows = parseRows(readFileSync(path, 'utf8'));
  const header = rows[0];
  if (!header) throw new Error(`empty CSV: ${path}`);
  const out: CsvRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] as string[];
    if (r.length !== header.length) {
      throw new Error(`${path}:${i + 1}: expected ${header.length} fields, got ${r.length}`);
    }
    const m = new Map<string, string>();
    for (let j = 0; j < header.length; j++) m.set(header[j] as string, r[j] as string);
    out.push(m);
  }
  return out;
}

const missing = (row: CsvRow, col: string): never => {
  throw new Error(`column '${col}' absent; columns are: ${[...row.keys()].join(', ')}`);
};

/** Required string. Empty string is a legitimate value (e.g. a blank `twitter`). */
export function str(row: CsvRow, col: string): string {
  const v = row.get(col);
  return v === undefined ? missing(row, col) : v;
}

/** Required number. Blank is an error — use {@link numOrNull} for optional columns. */
export function num(row: CsvRow, col: string): number {
  const v = str(row, col);
  const n = Number(v);
  if (v === '' || Number.isNaN(n)) throw new Error(`column '${col}': '${v}' is not a number`);
  return n;
}

/**
 * Number, or `null` when the cell is blank. Blank is meaningful in this dataset: every
 * trade-derived column of `launches.csv` is blank when `tape = none` (the four launches
 * whose tape could not be reconstructed). Returning `null` rather than `0` is what keeps
 * those four out of an average.
 */
export function numOrNull(row: CsvRow, col: string): number | null {
  const v = str(row, col);
  if (v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`column '${col}': '${v}' is not a number`);
  return n;
}

/** `1`/`0` column as a boolean. Blank is an error; use {@link boolOrNull} if it may be blank. */
export function bool(row: CsvRow, col: string): boolean {
  const v = str(row, col);
  if (v === '1') return true;
  if (v === '0') return false;
  throw new Error(`column '${col}': '${v}' is not 0 or 1`);
}

export function boolOrNull(row: CsvRow, col: string): boolean | null {
  return str(row, col) === '' ? null : bool(row, col);
}
