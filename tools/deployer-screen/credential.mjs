/**
 * Credential resolution for the MadeOnSol deployer screen.
 *
 * The rules this module exists to enforce, all of them from the task brief and none of them
 * negotiable:
 *
 * - The key is read from `MADEONSOL_API_KEY` in the environment. Nothing else is consulted;
 *   in particular no file inside this repository is ever read for a credential, and no path
 *   outside it is hard-coded.
 * - The value is **never** returned to a caller that renders, never logged, never written to
 *   disk, and never included in an error message. {@link describeKey} is the only thing this
 *   module will say about a key out loud, and it reports a length and a prefix shape.
 * - Every failure mode gets its own named outcome, because the one thing worse than no
 *   ranking is an empty ranking that looks like a real negative result. A missing key, a
 *   malformed key and a rejected key are three different sentences, and the caller exits
 *   non-zero on all three.
 *
 * Free-tier keys expire every 30 days and nothing local can see an expiry date, so expiry is
 * only observable as a rejection at request time — see {@link classifyAuthFailure}.
 */

/** Environment variable the key is read from. The only one. */
export const KEY_ENV_VAR = 'MADEONSOL_API_KEY';

/**
 * Documented prefix for a MadeOnSol key, from their own OpenAPI document
 * (`components.securitySchemes.BearerAuth.bearerFormat: "msk_..."`).
 */
export const KEY_PREFIX = 'msk_';

/**
 * Plausible length band for a live key. The one we hold is 47 characters. The band is
 * deliberately wide: it exists to catch a truncated paste or a shell-quoting accident, not to
 * assert a format the vendor never promised.
 */
export const KEY_MIN_LENGTH = 24;
/** Upper end of the plausible length band. See {@link KEY_MIN_LENGTH}. */
export const KEY_MAX_LENGTH = 128;

/**
 * @typedef {object} KeyDescription
 * @property {number} length             Character count. Safe to print.
 * @property {boolean} hasDocumentedPrefix Whether it starts with {@link KEY_PREFIX}.
 */

/**
 * @typedef {{ ok: true, key: string, description: KeyDescription }
 *          | { ok: false, reason: 'missing' | 'blank' | 'too-short' | 'too-long' | 'wrong-prefix',
 *              message: string, description: KeyDescription | null }} KeyResolution
 */

/**
 * Describe a key without disclosing it. Length and prefix-shape only — the two facts that
 * let a human debug a bad key without either of us ever seeing its value.
 *
 * @param {string} key
 * @returns {KeyDescription}
 */
export function describeKey(key) {
  return { length: key.length, hasDocumentedPrefix: key.startsWith(KEY_PREFIX) };
}

/**
 * Resolve the key from an environment-like object.
 *
 * Takes the environment as a parameter rather than reaching for `process.env` so the whole
 * module is testable without mutating the real environment, and so a test can never
 * accidentally pick up a real key from the machine it runs on.
 *
 * A wrong prefix is a warning, not a failure: the vendor documents `msk_` but has never
 * promised it, and refusing to run against a key that would have worked is the worse error.
 * The caller surfaces the warning; see {@link KeyResolution.description}.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {KeyResolution}
 */
export function resolveKey(env) {
  const raw = env[KEY_ENV_VAR];

  if (raw === undefined) {
    return {
      ok: false,
      reason: 'missing',
      description: null,
      message:
        `${KEY_ENV_VAR} is not set. This tool needs a MadeOnSol **Free tier** API key.\n` +
        `  Get one at https://madeonsol.com/developer (free, no card), then point the tool\n` +
        `  at it without copying it into this repository:\n` +
        `      export ${KEY_ENV_VAR}="$(your-secret-manager read madeonsol)"\n` +
        `  or, if it already lives in a dotenv file outside the repo:\n` +
        `      set -a; . /path/to/your/.env; set +a\n` +
        `  Never commit a key, and never add one to this repository — see tools/deployer-screen/README.md.`,
    };
  }

  // Trim only for the emptiness check. A key is used exactly as supplied; silently trimming
  // a credential hides a paste error rather than reporting it.
  if (raw.trim().length === 0) {
    return {
      ok: false,
      reason: 'blank',
      description: describeKey(raw),
      message: `${KEY_ENV_VAR} is set but empty (length ${raw.length}). It was probably assigned from an unset variable.`,
    };
  }

  const description = describeKey(raw);

  if (raw.length < KEY_MIN_LENGTH) {
    return {
      ok: false,
      reason: 'too-short',
      description,
      message:
        `${KEY_ENV_VAR} is ${raw.length} characters, below the ${KEY_MIN_LENGTH}-character minimum for a\n` +
        `  plausible MadeOnSol key. This usually means a truncated paste or a shell-quoting slip.\n` +
        `  The value is not shown, here or anywhere.`,
    };
  }

  if (raw.length > KEY_MAX_LENGTH) {
    return {
      ok: false,
      reason: 'too-long',
      description,
      message:
        `${KEY_ENV_VAR} is ${raw.length} characters, above the ${KEY_MAX_LENGTH}-character maximum for a\n` +
        `  plausible MadeOnSol key. Check that the variable holds only the key — a common cause is\n` +
        `  capturing a whole dotenv line, or a trailing newline from a here-doc.`,
    };
  }

  return { ok: true, key: raw, description };
}

/**
 * @typedef {'expired-or-revoked' | 'wrong-tier' | 'quota-exhausted' | 'malformed-request'} AuthFailureKind
 */

/**
 * @typedef {object} AuthFailure
 * @property {AuthFailureKind} kind
 * @property {string} message  Human-facing, actionable, and free of any credential value.
 */

/**
 * Turn an HTTP status from the vendor into a specific, actionable sentence.
 *
 * The distinction that matters most here is 401/403 versus 429. A rejected key and an
 * exhausted quota both stop the run, but they call for opposite responses — renew the key
 * versus wait for the window — and a tool that blurs them wastes a day.
 *
 * Free-tier keys expire every 30 days, which is why `401` leads with expiry rather than with
 * "invalid": on this vendor, on this tier, an expired key is much the likelier cause than a
 * wrong one.
 *
 * @param {number} status
 * @param {string} [bodyExcerpt] A short, already-truncated excerpt of the response body.
 * @returns {AuthFailure | null} `null` when the status is not an auth or quota failure.
 */
export function classifyAuthFailure(status, bodyExcerpt) {
  const tail = bodyExcerpt && bodyExcerpt.trim().length > 0 ? `\n  Vendor said: ${bodyExcerpt.trim()}` : '';

  if (status === 401) {
    return {
      kind: 'expired-or-revoked',
      message:
        `HTTP 401 — the vendor rejected the key.\n` +
        `  On MadeOnSol's Free tier keys expire every 30 days, so the most likely cause is\n` +
        `  **expiry**, not a wrong value. Issue a fresh key at https://madeonsol.com/developer\n` +
        `  and re-export ${KEY_ENV_VAR}.\n` +
        `  This is NOT a negative result: no deployer was screened.${tail}`,
    };
  }

  if (status === 403) {
    return {
      kind: 'wrong-tier',
      message:
        `HTTP 403 — the key is recognised but not entitled to this endpoint.\n` +
        `  This tool is designed for the **Free tier** only and must never need Pro, Ultra or\n` +
        `  Business. A 403 therefore means either the key was downgraded, or an endpoint that\n` +
        `  used to be free is now gated. Do not "fix" this by upgrading the plan — paid tiers are\n` +
        `  refused standing policy. Report it instead.\n` +
        `  This is NOT a negative result: no deployer was screened.${tail}`,
    };
  }

  if (status === 429) {
    return {
      kind: 'quota-exhausted',
      message:
        `HTTP 429 — rate-limited or out of daily quota.\n` +
        `  The Free tier allows roughly 200 requests/day and 10/minute, and the allowance is\n` +
        `  SHARED with whatever else uses this key. Wait for the window to reset and rerun; the\n` +
        `  screen is stateless, so a rerun costs no more than the first run did.\n` +
        `  This is NOT a negative result: the run stopped early.${tail}`,
    };
  }

  if (status === 400) {
    return {
      kind: 'malformed-request',
      message:
        `HTTP 400 — the vendor rejected the query parameters.\n` +
        `  Their OpenAPI document and their validator disagree in at least one known place:\n` +
        `  the spec advertises limit<=100 on /deployer-hunter/{wallet}/tokens while the server\n` +
        `  rejects anything above 50. If this fires after a vendor change, re-read the spec\n` +
        `  before widening any limit.${tail}`,
    };
  }

  return null;
}
