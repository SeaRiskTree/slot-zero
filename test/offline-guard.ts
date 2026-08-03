/**
 * The one list of things an offline area of this repo may not contain.
 *
 * Two areas are held to it — `src/` (test/loader.test.ts) and `analysis/`
 * (test/window-population.test.ts) — and they are held to the *same* list on purpose: the
 * guarantee both make is identical, so a pattern added for one must apply to the other. Two
 * hand-maintained copies drifted once already, which is why this file exists.
 *
 * The network-capable area is `tools/`, and the boundary is the directory. Each tool there is
 * governed separately, by a test that asserts the *other* half of the boundary:
 * `tools/deployer-screen/` by test/deployer-screen.test.ts (which has a keyed client and an allowed
 * list of files that may name the credential), `tools/graduated-life-tape/` by
 * test/graduated-life-tape.test.ts and `tools/arrival-rate-walk/` by test/arrival-rate-walk.test.ts
 * (both keyless throughout, so both allowed lists are empty).
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
