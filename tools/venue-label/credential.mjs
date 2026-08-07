/**
 * Credential resolution for the venue-labelling tool. **This is the only module in this directory
 * that may name a key's environment variable**, and `test/venue-label.test.ts` pins that.
 *
 * One credential lives here: `HELIUS_API_KEY`, the paid Developer-plan key this project already
 * holds. Unlike the deployer screen's use of the same key it is **not optional** — the Wallet
 * Identity endpoints are the only surface reachable from here that names a venue at all, and every
 * priced alternative was refused (captain decision 366a). So an absent key stops this lane rather
 * than degrading it, and it says so in a sentence rather than reporting an empty result.
 *
 * The rules are the other keyed tools' rules, unchanged, and none of them is negotiable:
 *
 * - The key is read from the environment and from nowhere else. No file in this repository is ever
 *   read for a credential and no path outside it is hard-coded.
 * - The value is never returned to anything that renders, never logged, never written to disk and
 *   never put in an error message. {@link describeKey} is the only thing said about it out loud,
 *   and it reports a length and a shape.
 * - **Store the bare key, never a composed URL.** Helius's address is a host plus the key as a
 *   query parameter, so this is the one vendor in the fleet where a pasted URL both fits any
 *   plausible length band and would be composed a second time. It is refused on SHAPE.
 *   {@link walletIdentityUrl} is the ONE place a key ever reaches a URL, and it returns the safe
 *   spelling beside the fetched one so the two cannot drift.
 * - A missing key and a malformed key are two different sentences, because "no label" that is
 *   really "no credential" is the failure this repository refuses everywhere else.
 */

/** Environment variable the Helius key is read from. The only one. */
export const KEY_ENV_VAR = 'HELIUS_API_KEY';

/**
 * Helius's Wallet API host, **without the key**. The only host this tool contacts.
 *
 * This bare host is the only form that may be printed: it is what every log line, error message and
 * run record shows, which is what makes "the key never reaches a log" a property of the shapes
 * rather than a habit — see {@link walletIdentityUrl}.
 */
export const WALLET_API_HOST = 'https://api.helius.xyz';

/**
 * Plausible length band for a Helius key. The one we hold is 36 characters — a lowercase UUID,
 * which is the shape Helius issues. The band is deliberately wide: it exists to catch a truncated
 * paste or a shell-quoting accident, not to assert a format the vendor never promised.
 */
export const KEY_MIN_LENGTH = 24;
/** Upper end of the plausible length band. See {@link KEY_MIN_LENGTH}. */
export const KEY_MAX_LENGTH = 128;

/** The UUID shape Helius issues. A **shape** test, and the only thing said out loud about a key. */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * What may be said about a key out loud.
 *
 * @typedef {object} KeyDescription
 * @property {number} length              Character count. Safe to print.
 * @property {boolean} hasDocumentedShape Whether it is UUID-shaped, which is what Helius issues.
 */

/**
 * Describe a key without disclosing it. Length and shape only — the two facts that let a human
 * debug a bad key without either of us ever seeing its value.
 *
 * @param {string} key
 * @returns {KeyDescription}
 */
export function describeKey(key) {
  return { length: key.length, hasDocumentedShape: UUID_SHAPE.test(key) };
}

/**
 * @typedef {object} CredentialResolution
 * @property {'ok' | 'missing' | 'malformed'} outcome
 * @property {string | null} key   Present only on `ok`. Held by the client's closure and nowhere
 *   else, used for exactly one thing — composing a request URL in {@link walletIdentityUrl}.
 * @property {string} label        The host, with no credential in it. Every human-facing string and
 *   every persisted field uses THIS.
 * @property {KeyDescription | null} keyDescription `null` when no key was present.
 * @property {string} keyEnvVar    The variable the key is read from. It travels with the resolution
 *   because the renderer has to name the variable in the dry run and is not allowed to spell it.
 * @property {string} message      A whole sentence, safe to print. Never quotes the value.
 */

/**
 * Resolve the Helius credential from an environment-like object.
 *
 * The environment is passed in rather than read from `process.env` at the call site so a test can
 * drive every branch without mutating the process, and so a test can never accidentally pick up a
 * real key from the machine it runs on — the same seam the other keyed tools' credential modules
 * use.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {CredentialResolution}
 */
export function resolveHeliusCredential(env) {
  const raw = env[KEY_ENV_VAR];
  if (raw === undefined || raw.trim() === '') {
    return {
      outcome: 'missing',
      key: null,
      label: WALLET_API_HOST,
      keyDescription: null,
      keyEnvVar: KEY_ENV_VAR,
      message:
        `${KEY_ENV_VAR} is not set. There is no keyless route to a venue label — every priced ` +
        `alternative was refused and this endpoint requires a paid plan — so this run issued no ` +
        `request and named nothing. That is an ABSENT answer, never an unknown one: an address ` +
        `this tool never asked about is not an address the vendor declined to name.`,
    };
  }

  const key = raw.trim();
  // **A COMPOSED URL PASTED HERE IS THE ONE MALFORMED VALUE THE LENGTH BAND CANNOT CATCH.** This
  // host plus a UUID key sits comfortably inside the 24-128 band, so it would be accepted and then
  // composed a second time; every request then fails on a credential that has already been written
  // into a string anything may format. Refused on SHAPE, and the message names the shape only.
  if (key.includes('://') || key.includes('api-key=')) {
    return {
      outcome: 'malformed',
      key: null,
      label: WALLET_API_HOST,
      keyDescription: null,
      keyEnvVar: KEY_ENV_VAR,
      message:
        `${KEY_ENV_VAR} looks like a composed URL rather than a bare key, so it was NOT used and ` +
        `nothing was sent. Store the KEY ALONE — the address is built from it in exactly one ` +
        `place, and a URL in an environment variable is a credential that leaks the moment ` +
        `anything formats it into a message. The value is not shown, here or anywhere.`,
    };
  }
  if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH) {
    return {
      outcome: 'malformed',
      key: null,
      label: WALLET_API_HOST,
      keyDescription: null,
      keyEnvVar: KEY_ENV_VAR,
      message:
        `${KEY_ENV_VAR} is ${key.length} characters, outside the plausible band of ` +
        `${KEY_MIN_LENGTH}-${KEY_MAX_LENGTH}, so it was NOT used and nothing was sent. That is ` +
        `the shape of a truncated paste, a shell-quoting slip, or a whole dotenv line captured ` +
        `instead of the value. The value is not shown, here or anywhere.`,
    };
  }

  return {
    outcome: 'ok',
    key,
    label: WALLET_API_HOST,
    keyDescription: describeKey(key),
    keyEnvVar: KEY_ENV_VAR,
    message: `${KEY_ENV_VAR} resolved (${key.length} characters).`,
  };
}

/**
 * @typedef {object} ComposedUrl
 * @property {string} url  The address to request. **It carries the key.** It is passed to `fetch`
 *   and used for exactly that; no code may format it into a message, a log line or a record.
 * @property {string} safe The same address with no credential in it. Every human-facing string,
 *   every thrown error and every persisted field uses THIS.
 */

/**
 * Compose a Wallet API URL. **The one place in this repository's labelling lane where a key reaches
 * a URL**, and it hands back the printable spelling in the same breath so nothing downstream has to
 * build one — a second spelling of an address is how a credential ends up in a log.
 *
 * @param {string} key  The bare key.
 * @param {string} path Absolute path beginning with `/`, e.g. `/v1/wallet/batch-identity`.
 * @returns {ComposedUrl}
 */
export function walletIdentityUrl(key, path) {
  if (!path.startsWith('/')) throw new TypeError('path must begin with "/"');
  return {
    url: `${WALLET_API_HOST}${path}?api-key=${encodeURIComponent(key)}`,
    safe: `${WALLET_API_HOST}${path}?api-key=<not shown>`,
  };
}
