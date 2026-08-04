/**
 * Credential resolution for the creation census. **This is the only module in this directory that
 * may name a key's environment variable**, and `test/creation-census.test.ts` pins that.
 *
 * One credential lives here: `DUNE_API_KEY`, the Free-tier key the census executes on. Unlike the
 * deployer screen's, it is **not optional** — there is no keyless route to a census. Nothing else
 * enumerates *strangers* by creation month: the vendor feeds answer "who did we profile", the
 * pump.fun coins list reaches back 55 minutes and attributes to the current owner, and a keyless RPC
 * block scan is ~6x short of real time (`data/slot-zero-discovery-widen-operations/report.md`
 * §2.2–2.5). So an absent key stops this lane rather than degrading it.
 *
 * The rules are the screen's, unchanged, and none of them is negotiable:
 *
 * - The key is read from the environment and from nowhere else. No file in this repository is ever
 *   read for a credential and no path outside it is hard-coded.
 * - The value is never returned to anything that renders, never logged, never written to disk and
 *   never put in an error message. {@link describeKey} is the only thing said about it out loud,
 *   and it reports a length and a shape.
 * - A missing key and a malformed key are two different sentences, because "no candidates" that is
 *   really "no credential" is the failure this repository refuses everywhere else.
 */

/** Environment variable the Dune key is read from. The only one. */
export const KEY_ENV_VAR = 'DUNE_API_KEY';

/**
 * Plausible length band for a Dune key. The one we hold is 32 characters. The band is deliberately
 * wide: it exists to catch a truncated paste or a shell-quoting accident, not to assert a format the
 * vendor never promised.
 */
export const KEY_MIN_LENGTH = 16;
/** Upper end of the plausible length band. See {@link KEY_MIN_LENGTH}. */
export const KEY_MAX_LENGTH = 128;

/**
 * What may be said about a key out loud.
 *
 * @typedef {object} KeyDescription
 * @property {number} length Character count. Safe to print.
 */

/**
 * @param {string} key
 * @returns {KeyDescription}
 */
export function describeKey(key) {
  return { length: key.length };
}

/**
 * @typedef {object} CredentialResolution
 * @property {'ok' | 'missing' | 'malformed'} outcome
 * @property {string | null} key Present only on `ok`. Held by the client's closure and nowhere else.
 * @property {string} message A whole sentence, safe to print. Never quotes the value.
 */

/**
 * Resolve the Dune key from an environment.
 *
 * The environment is passed in rather than read from `process.env` at the call site so a test can
 * drive every branch without mutating the process — the same seam the screen's credential module
 * uses.
 *
 * **A key that looks like a URL is refused, not accepted.** Dune's address is a host plus a header,
 * and a URL pasted into a key variable is a credential that leaks the moment anything formats it
 * into a message. The screen learned this against Helius, whose address really does carry the key as
 * a query parameter; the rule is cheap and it travels.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {CredentialResolution}
 */
export function resolveDuneCredential(env) {
  const raw = env[KEY_ENV_VAR];
  if (raw === undefined || raw.trim() === '') {
    return {
      outcome: 'missing',
      key: null,
      message:
        `${KEY_ENV_VAR} is not set. The creation census has no keyless route — nothing else ` +
        `enumerates strangers by creation month — so this run issued no request and produced no ` +
        `cohort. That is an absent answer, never an empty one.`,
    };
  }
  const key = raw.trim();
  if (key.includes('://') || key.includes('/')) {
    return {
      outcome: 'malformed',
      key: null,
      message:
        `${KEY_ENV_VAR} looks like a URL rather than a bare key. Store the key alone: Dune ` +
        `authenticates with an \`X-Dune-API-Key\` header, so nothing here needs an address, and a ` +
        `URL in a key variable leaks the credential the first time anything formats it.`,
    };
  }
  if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH) {
    return {
      outcome: 'malformed',
      key: null,
      message:
        `${KEY_ENV_VAR} is ${key.length} characters, outside the plausible band of ` +
        `${KEY_MIN_LENGTH}–${KEY_MAX_LENGTH}. That is the shape of a truncated paste or a shell ` +
        `quoting accident. Nothing was sent.`,
    };
  }
  return {
    outcome: 'ok',
    key,
    message: `${KEY_ENV_VAR} resolved (${key.length} characters).`,
  };
}
