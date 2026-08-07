/**
 * A YAML reader for the one machine-consumed declarative artifact this repo owns:
 * `.github/workflows/ci.yml`.
 *
 * The workflow is a CONTRACT with GitHub Actions — which step runs, under which condition, in which
 * order — and the properties captain decision 354a requires of it (the suite runs unconditionally,
 * the data source is validated before anything depends on it, a fetch is never reached without its
 * verification) are properties of that contract rather than of the file's text. Matching the raw
 * text asserts neither: re-indenting a step or moving a script into a block scalar breaks the match
 * with no behaviour change, while a `continue-on-error:` or a job-level `if:` slips past it
 * untouched.
 *
 * So the file is parsed into a semantic model and the assertions are made against that. There is no
 * YAML parser to reach for: this repo has no runtime dependencies at all and its three dev ones are
 * TypeScript, `@types/node` and vitest, so a parser would be a new dependency bought for one test on
 * a toolchain deliberately pinned to the Node 20 engines floor. This reads the subset the workflow
 * is written in — block mappings, block sequences, block scalars, flow sequences, comments and
 * quoted scalars — and REFUSES a line it does not understand, so a future workflow using more of
 * YAML fails here rather than being silently half-read. That is the same rule
 * `config/verify-data-root.mjs` → `parseManifest` applies to a manifest line.
 */

/** A parsed YAML value: a scalar, a sequence, or a mapping. */
export type YamlNode = string | YamlNode[] | { [key: string]: YamlNode };

const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/;

/** Drop a trailing `#` comment, respecting quotes so a `#` inside a string survives. */
function stripComment(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1] as string))) break;
    out += c;
  }
  return out.trimEnd();
}

function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse the subset of YAML the CI workflow is written in.
 *
 * @throws on any line the subset does not cover, rather than skipping it.
 */
export function parseWorkflowYaml(text: string): YamlNode {
  const lines = text.split('\n');
  let cursor = 0;

  const indentOf = (line: string): number => line.length - line.trimStart().length;
  const skippable = (line: string): boolean => {
    const t = line.trim();
    return t === '' || t.startsWith('#') || t === '---';
  };
  const seek = (): boolean => {
    while (cursor < lines.length && skippable(lines[cursor] as string)) cursor += 1;
    return cursor < lines.length;
  };

  const scalar = (raw: string, line: number): YamlNode => {
    if (raw.startsWith('[')) {
      if (!raw.endsWith(']')) throw new Error(`ci workflow line ${line}: unterminated flow sequence`);
      const inner = raw.slice(1, -1).trim();
      return inner === '' ? [] : inner.split(',').map((item) => unquote(item.trim()));
    }
    if (raw.startsWith('{')) throw new Error(`ci workflow line ${line}: flow mappings are not read here`);
    return unquote(raw);
  };

  /** A `|`/`>` block scalar: every line indented past its key, dedented, comments intact. */
  const blockScalar = (indent: number, chomp: string): string => {
    const body: string[] = [];
    let base = -1;
    while (cursor < lines.length) {
      const line = lines[cursor] as string;
      if (line.trim() !== '' && indentOf(line) <= indent) break;
      if (line.trim() !== '' && base < 0) base = indentOf(line);
      body.push(line.trim() === '' ? '' : line.slice(base < 0 ? indent + 2 : base));
      cursor += 1;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return chomp === '-' ? body.join('\n') : `${body.join('\n')}\n`;
  };

  const parseNode = (indent: number): YamlNode => {
    if (!seek()) throw new Error('ci workflow ends where a value was expected');
    const trimmed = (lines[cursor] as string).trim();
    return trimmed === '-' || trimmed.startsWith('- ') ? parseSequence(indent) : parseMapping(indent);
  };

  const parseMapping = (indent: number): YamlNode => {
    const map: { [key: string]: YamlNode } = {};
    while (seek()) {
      const raw = lines[cursor] as string;
      const at = indentOf(raw);
      if (at < indent) break;
      const lineNo = cursor + 1;
      const content = stripComment(raw.trim());
      const match = KEY.exec(content);
      if (match === null) throw new Error(`ci workflow line ${lineNo}: not a mapping entry: ${content.slice(0, 60)}`);
      const key = match[1] as string;
      const value = (match[2] ?? '').trim();
      cursor += 1;
      if (value === '' || value === '|' || value === '|-' || value === '>' || value === '>-') {
        if (value === '') {
          if (!seek() || indentOf(lines[cursor] as string) <= at) {
            map[key] = '';
            continue;
          }
          map[key] = parseNode(indentOf(lines[cursor] as string));
        } else {
          map[key] = blockScalar(at, value.slice(1));
        }
        continue;
      }
      map[key] = scalar(value, lineNo);
    }
    return map;
  };

  const parseSequence = (indent: number): YamlNode => {
    const items: YamlNode[] = [];
    while (seek()) {
      const raw = lines[cursor] as string;
      const at = indentOf(raw);
      if (at < indent) break;
      const trimmed = stripComment(raw.trim());
      if (trimmed !== '-' && !trimmed.startsWith('- ')) break;
      const rest = trimmed === '-' ? '' : trimmed.slice(2);
      if (rest === '') {
        cursor += 1;
        items.push(parseNode(at + 2));
        continue;
      }
      // Re-write the item's first line as an ordinary entry two columns in, so the rest of the
      // item — which is already written at that indent — parses as one mapping with it.
      lines[cursor] = `${' '.repeat(at + 2)}${rest}`;
      items.push(KEY.test(rest) ? parseMapping(at + 2) : scalar(rest, cursor + 1));
      if (!KEY.test(rest)) cursor += 1;
    }
    return items;
  };

  const document = parseNode(0);
  if (seek()) throw new Error(`ci workflow line ${cursor + 1}: content outside the document root`);
  return document;
}

/** Narrow a node to a mapping, naming the path so a shape change reads as one clear failure. */
export function mapAt(node: YamlNode | undefined, where: string): { [key: string]: YamlNode } {
  if (node === undefined || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${where} is not a mapping`);
  }
  return node;
}

/** Narrow a node to a sequence. */
export function seqAt(node: YamlNode | undefined, where: string): YamlNode[] {
  if (!Array.isArray(node)) throw new Error(`${where} is not a sequence`);
  return node;
}

/** Narrow a node to a scalar, or `undefined` when the key is absent. */
export function textAt(node: YamlNode | undefined, where: string): string | undefined {
  if (node === undefined) return undefined;
  if (typeof node !== 'string') throw new Error(`${where} is not a scalar`);
  return node;
}
