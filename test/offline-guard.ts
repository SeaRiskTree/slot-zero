/**
 * The one list of things an offline area of this repo may not contain.
 *
 * Two areas are held to it — `src/` (test/loader.test.ts) and `analysis/`
 * (test/window-population.test.ts) — and they are held to the *same* list on purpose: the
 * guarantee both make is identical, so a pattern added for one must apply to the other. Two
 * hand-maintained copies drifted once already, which is why this file exists.
 *
 * `tools/deployer-screen/` is the repo's only network-capable area and is governed separately by
 * test/deployer-screen.test.ts, which asserts the *other* half of that boundary.
 */

/** Anything that could open a socket, directly or through a client library. */
export const NETWORK_PATTERNS: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /from\s+['"]node:(https?|net|tls|dgram|dns)['"]/,
  /require\(['"](https?|net|tls|dgram|dns|axios|node-fetch|undici)['"]\)/,
  /from\s+['"](axios|node-fetch|undici|got)['"]/,
];

/** Anything that could read a credential, or be one. */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /process\.env/,
  /API_KEY|SECRET|_TOKEN\b|Bearer /i,
];

/** A MadeOnSol-shaped key, checked over prose and fixtures as well as code. */
export const KEY_SHAPED = /msk_[A-Za-z0-9_-]{20,}/;
