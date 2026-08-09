/**
 * Credential resolution for the deployer screen. **This is the only module that may name a key's
 * environment variable** — `screen.mjs` is on the allow-list too, for its help text, and
 * `test/deployer-screen.test.ts` pins both lists.
 *
 * Three credentials live here and they are unrelated to each other:
 *
 * - `MADEONSOL_API_KEY` — the vendor key the competence gate runs on. **Ultra tier and EXCLUSIVE to
 *   slot-zero since 2026-08-05** (captain): metered at 100,000 requests/day resetting at 00:00Z,
 *   and shared with nothing. It was Free tier, ~200/day and shared, which is the tier every bound
 *   in this tool was originally sized against; captain decision 267a re-derived them and
 *   `thresholds.json` → `budget` owns the result. **Whether the Free tier's 30-day key expiry
 *   applies on Ultra is UNVERIFIED** — see {@link classifyAuthFailure}, which is where it matters.
 * - `DUNE_API_KEY` — the Free-tier key the **creation enumeration** runs on, which since captain
 *   decision 156a is the PRIMARY answer to "which mints did this wallet create". **Optional**: with
 *   it absent the enumeration falls back to the Solana RPC creation walk below and every number is
 *   what it was before. See {@link resolveDuneCredential}.
 * - `HELIUS_API_KEY` — the paid Solana RPC key. It is the FALLBACK for creation enumeration and
 *   PRIMARY for everything transaction-level, including Stage 2's entry-cost leg, which reads
 *   `meta.fee` and pre/post balances per transaction — Dune's decoded tables do not serve that.
 *   **Optional**: with it absent the walk falls back to the keyless public endpoint and behaves
 *   exactly as it did before this key existed. See {@link resolveSolanaRpcEndpoint}.
 *
 * The rules this module exists to enforce, all of them from the task brief and none of them
 * negotiable:
 *
 * - A key is read from the environment. Nothing else is consulted; in particular no file inside
 *   this repository is ever read for a credential, and no path outside it is hard-coded.
 * - The value is **never** returned to a caller that renders, never logged, never written to
 *   disk, and never included in an error message. {@link describeKey} is the only thing this
 *   module will say about a key out loud, and it reports a length and a prefix shape.
 * - Every failure mode gets its own named outcome, because the one thing worse than no
 *   ranking is an empty ranking that looks like a real negative result. A missing key, a
 *   malformed key and a rejected key are three different sentences, and the caller exits
 *   non-zero on all three.
 *
 * Nothing local can see an expiry date on any of the three, so expiry is only ever observable as a
 * rejection at request time — see {@link classifyAuthFailure}. On MadeOnSol the Free tier expired
 * keys every 30 days; **whether that still holds on Ultra is UNVERIFIED here and is neither assumed
 * nor deleted**, because both errors are costly in opposite directions: dropping it would leave a
 * 401 with no likely cause named, and keeping it as fact would send an operator to reissue a key
 * that is working. It is stated as unverified wherever it is stated at all.
 */

/** Environment variable the MadeOnSol key is read from. The only one. */
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
        `${KEY_ENV_VAR} is not set. This tool needs a MadeOnSol API key.\n` +
        `  This lane's key is **Ultra** and exclusive to slot-zero — 100,000 requests/day — and the\n` +
        `  pinned bounds are sized against that. No ENDPOINT this tool calls needs a paid tier, but\n` +
        `  a full default run now plans 201 keyed requests, so on a ~200/day Free-tier key it would\n` +
        `  have to be bounded with --candidates.\n` +
        `  Get one at https://madeonsol.com/developer, then point the tool\n` +
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

// --- the Solana RPC credential, and the endpoint it selects -----------------------------------

/**
 * Environment variable the Helius key is read from. The only one.
 *
 * **Optional, unlike {@link KEY_ENV_VAR}.** Its absence is a supported configuration, not a fault:
 * the creation walk falls back to the keyless public endpoint and the run is byte-for-byte what it
 * was before this key existed. So nothing here produces a "credential missing" exit — see
 * {@link resolveSolanaRpcEndpoint}.
 */
export const HELIUS_KEY_ENV_VAR = 'HELIUS_API_KEY';

/**
 * Helius's mainnet RPC host, **without the key**.
 *
 * The address is this host plus the key as a single query parameter, composed in
 * {@link resolveSolanaRpcEndpoint}, never stored composed and never written down anywhere. This
 * bare host is the only form that may be printed: it is what every log line, error message and run
 * record shows, which is what makes "the key never reaches a log" a property of the types rather
 * than a habit — see {@link SolanaRpcEndpoint.label}.
 */
export const HELIUS_RPC_HOST = 'https://mainnet.helius-rpc.com';

/**
 * The keyless Solana RPC endpoint, and the fallback when no Helius key is present.
 *
 * Declared here rather than imported from `pumpfun.mjs` so the endpoint decision lives entirely in
 * one module; `pumpfun.mjs` exports the same constant for its own default and a test pins the two
 * together, because two spellings of one host is how a job ends up sending half its requests
 * somewhere else.
 */
export const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Plausible length band for a Helius key. The one we hold is 36 characters — a lowercase UUID,
 * which is the shape Helius issues. The band is wide for the same reason the MadeOnSol one is: it
 * exists to catch a truncated paste or a shell-quoting accident, not to assert a format the vendor
 * never promised. A key outside the band is refused with a message that names neither its value nor
 * any part of it.
 */
export const HELIUS_KEY_MIN_LENGTH = 24;
/** Upper end of the plausible length band. See {@link HELIUS_KEY_MIN_LENGTH}. */
export const HELIUS_KEY_MAX_LENGTH = 128;

/** The UUID shape Helius issues. A **shape** test, and the only thing said out loud about a key. */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * @typedef {object} HeliusKeyDescription
 * @property {number} length               Character count. Safe to print.
 * @property {boolean} hasDocumentedShape  Whether it is UUID-shaped, which is what Helius issues.
 */

/**
 * Describe a Helius key without disclosing it. Length and shape only — the two facts that let a
 * human debug a bad key without either of us ever seeing its value.
 *
 * @param {string} key
 * @returns {HeliusKeyDescription}
 */
export function describeHeliusKey(key) {
  return { length: key.length, hasDocumentedShape: UUID_SHAPE.test(key) };
}

/**
 * @typedef {object} SolanaRpcEndpoint
 * What the Solana RPC clients are pointed at, and everything they are allowed to say about it.
 *
 * @property {'helius' | 'public'} provider Which endpoint was selected, and therefore which walk
 *   `screen.mjs` runs: `helius` takes the indexed route, `public` the signature-scan fallback.
 * @property {string} url   The address to POST to. **On `helius` this carries the key.** It is
 *   passed to the client and used for exactly one thing — `fetch` — and no code may format it into
 *   a message, a log line or a record. `label` exists so nothing ever has to.
 * @property {string} label The same endpoint with no credential in it. Every human-facing string,
 *   every thrown error and every persisted field uses THIS. A test constructs a client against a
 *   sentinel-bearing URL, drives every failure path, and asserts the sentinel reaches none of them.
 * @property {string} authRemedy What to do when the endpoint rejects the credential, as a whole
 *   sentence. It travels with the endpoint because `pumpfun.mjs` may not name a key variable and so
 *   cannot write this itself.
 * @property {string | null} keyEnvVar The variable this endpoint's credential is read from, `null`
 *   on the keyless one. It travels with the endpoint for the same reason `authRemedy` does:
 *   `render.mjs` has to name the variable in the dry run and is not allowed to spell it, so it
 *   prints this field instead of holding a second copy of the string.
 * @property {HeliusKeyDescription | null} keyDescription `null` on the keyless endpoint.
 * @property {string | null} rejected When a key was PRESENT but malformed: why, in a sentence. The
 *   endpoint then falls back to `public`, because a malformed key must not silently become a
 *   keyless run that reads as a keyed one — the caller prints this.
 */

/**
 * Choose the Solana RPC endpoint from the environment.
 *
 * **The absence of a key is a configuration, not a failure.** With `HELIUS_API_KEY` unset this
 * returns the public endpoint and the run is exactly what it was before Helius existed: the
 * signature-scan walk, its own pinned pacing, its own ceilings. With the key present the creation
 * walk switches to Helius's indexed route, which is the same measurement over a cheaper index —
 * `pumpfun.mjs` → `readCreatedHistoryIndexed` owns that claim and Stage 0 is untouched by either.
 *
 * A key that is present but malformed falls back to the public endpoint **and says so**. Refusing
 * to run would be worse (the keyless route works), and running silently would be worse still: a
 * reader seeing a slow run and a `provider: "public"` record with no reason would have to guess.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {SolanaRpcEndpoint}
 */
export function resolveSolanaRpcEndpoint(env) {
  /** @type {SolanaRpcEndpoint} */
  const keyless = {
    provider: 'public',
    url: PUBLIC_SOLANA_RPC,
    label: PUBLIC_SOLANA_RPC,
    authRemedy:
      `This endpoint takes no credential, so a rejection here is the host refusing this client ` +
      `outright rather than an expired key. Nothing to rotate.`,
    keyDescription: null,
    keyEnvVar: null,
    rejected: null,
  };

  const raw = env[HELIUS_KEY_ENV_VAR];
  if (raw === undefined || raw.trim().length === 0) return keyless;

  const description = describeHeliusKey(raw);
  // **A COMPOSED URL PASTED HERE IS THE ONE MALFORMED VALUE THE LENGTH BAND CANNOT CATCH.** This
  // host plus a UUID key is 76 characters, comfortably inside the 24-128 band, so it would be
  // accepted and then composed a second time — every request 401s, and before this fail-fast landed
  // that degraded all 195 candidates to an ownership-only reading while the shared MadeOnSol
  // allowance drained. Refused on SHAPE, and the message names the shape only: the offending value
  // is a credential and is not quoted, here or anywhere.
  if (raw.includes('://') || raw.includes('api-key=')) {
    return {
      ...keyless,
      rejected:
        `${HELIUS_KEY_ENV_VAR} looks like a composed URL rather than a bare key, so it was NOT used ` +
        `and the walk fell back to the keyless public endpoint. Store the KEY ALONE — the address is ` +
        `built from it in exactly one place, and a URL in an environment variable is a credential ` +
        `that leaks the moment anything formats it into a message. The value is not shown, here or ` +
        `anywhere.`,
    };
  }
  if (raw.length < HELIUS_KEY_MIN_LENGTH || raw.length > HELIUS_KEY_MAX_LENGTH) {
    return {
      ...keyless,
      rejected:
        `${HELIUS_KEY_ENV_VAR} is ${raw.length} characters, outside the ` +
        `${HELIUS_KEY_MIN_LENGTH}-${HELIUS_KEY_MAX_LENGTH} band for a plausible Helius key, so it was ` +
        `NOT used and the walk fell back to the keyless public endpoint. That usually means a ` +
        `truncated paste, a shell-quoting slip, or a whole dotenv line captured instead of the value. ` +
        `The value is not shown, here or anywhere.`,
    };
  }

  return {
    provider: 'helius',
    // Composed here and nowhere else. Never stored composed, never logged, never recorded.
    url: `${HELIUS_RPC_HOST}/?api-key=${raw}`,
    label: HELIUS_RPC_HOST,
    authRemedy:
      `Helius answers a bad or missing key with HTTP 401 and a plain-text body, so this is the key ` +
      `and not the query. Re-export ${HELIUS_KEY_ENV_VAR} from the credential file and rerun; unset ` +
      `it entirely to fall back to the keyless public endpoint, which needs no credential and is ` +
      `slower rather than wrong.`,
    keyDescription: description,
    keyEnvVar: HELIUS_KEY_ENV_VAR,
    rejected: null,
  };
}

// --- the Dune credential, and why its absence is not a fault ----------------------------------

/**
 * Environment variable the Dune key is read from. The only one.
 *
 * **Optional, like {@link HELIUS_KEY_ENV_VAR} and unlike {@link KEY_ENV_VAR}.** Creation
 * enumeration is PRIMARY on Dune since captain decision 156a, but a missing key is a supported
 * configuration rather than a failure: the enumeration falls back to the Solana RPC creation walk,
 * which is the route every committed run before that decision used. So nothing here produces a
 * "credential missing" exit — see {@link resolveDuneCredential}.
 */
export const DUNE_KEY_ENV_VAR = 'DUNE_API_KEY';

/**
 * Dune's API host, **without the key**.
 *
 * Unlike Helius, Dune authenticates on a HEADER (`X-Dune-API-Key`, never `Bearer`), so no
 * credential is ever composed into a URL here and there is nothing for a log line to leak. That is
 * the easy shape; the rule that the key is stored bare and composed nowhere still holds, and this
 * constant is what makes it structural rather than a habit.
 */
export const DUNE_API_BASE = 'https://api.dune.com/api/v1';

/**
 * Plausible length band for a Dune key. The one we hold is 32 alphanumeric characters. The band is
 * wide for the same reason the other two are: it exists to catch a truncated paste or a
 * shell-quoting accident, not to assert a format the vendor never promised.
 */
export const DUNE_KEY_MIN_LENGTH = 16;
/** Upper end of the plausible length band. See {@link DUNE_KEY_MIN_LENGTH}. */
export const DUNE_KEY_MAX_LENGTH = 128;

/** The alphanumeric shape Dune issues. A **shape** test, and the only thing said out loud. */
const DUNE_KEY_SHAPE = /^[A-Za-z0-9]+$/;

/**
 * @typedef {object} DuneKeyDescription
 * @property {number} length              Character count. Safe to print.
 * @property {boolean} hasDocumentedShape Whether it is alphanumeric, which is what Dune issues.
 */

/**
 * Describe a Dune key without disclosing it. Length and shape only.
 *
 * @param {string} key
 * @returns {DuneKeyDescription}
 */
export function describeDuneKey(key) {
  return { length: key.length, hasDocumentedShape: DUNE_KEY_SHAPE.test(key) };
}

/**
 * @typedef {object} DuneCredential
 * @property {boolean} available   Whether the creation enumeration may take the Dune route.
 * @property {string | null} key   The bare key, `null` when unavailable. Passed to the client and
 *   used for exactly one thing — a request header. No code may format it into a message.
 * @property {string} label        The host, with no credential in it. Every human-facing string and
 *   every persisted field uses THIS.
 * @property {DuneKeyDescription | null} keyDescription `null` when no key was present.
 * @property {string | null} keyEnvVar The variable this credential is read from, `null` when
 *   absent. It travels with the credential because `render.mjs` has to name the variable in the dry
 *   run and is not allowed to spell it.
 * @property {string | null} rejected When a key was PRESENT but malformed: why, in a sentence. The
 *   enumeration then falls back to the RPC walk, because a malformed key must not silently become a
 *   walk-derived run that reads as a Dune-derived one — the caller prints this.
 */

/**
 * Resolve the Dune credential from an environment-like object.
 *
 * **The absence of a key is a configuration, not a failure**, and the fallback it selects is the
 * route the repo already had. A key that is present but malformed falls back **and says so**:
 * refusing to run would be worse (the walk works), and running silently would be worse still, since
 * a reader seeing a slow run and an `enumerationSource: "creation-walk"` record with no reason
 * would have to guess.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {DuneCredential}
 */
export function resolveDuneCredential(env) {
  /** @type {DuneCredential} */
  const absent = {
    available: false,
    key: null,
    label: DUNE_API_BASE,
    keyDescription: null,
    keyEnvVar: null,
    rejected: null,
  };

  const raw = env[DUNE_KEY_ENV_VAR];
  if (raw === undefined || raw.trim().length === 0) return absent;

  // Same fail-fast as the Helius key, for the same reason: a pasted URL sits comfortably inside any
  // plausible length band, so length alone cannot catch it. Dune takes its credential in a header,
  // so a URL here could never work at all — it is refused rather than sent.
  if (raw.includes('://') || raw.includes('api.dune.com')) {
    return {
      ...absent,
      keyEnvVar: DUNE_KEY_ENV_VAR,
      rejected:
        `${DUNE_KEY_ENV_VAR} looks like a URL rather than a bare key, so it was NOT used and the ` +
        `creation enumeration fell back to the Solana RPC walk. Store the KEY ALONE — Dune ` +
        `authenticates on a header, so a URL here cannot work, and a URL in an environment ` +
        `variable is a credential that leaks the moment anything formats it into a message. The ` +
        `value is not shown, here or anywhere.`,
    };
  }
  if (raw.length < DUNE_KEY_MIN_LENGTH || raw.length > DUNE_KEY_MAX_LENGTH) {
    return {
      ...absent,
      keyEnvVar: DUNE_KEY_ENV_VAR,
      rejected:
        `${DUNE_KEY_ENV_VAR} is ${raw.length} characters, outside the ` +
        `${DUNE_KEY_MIN_LENGTH}-${DUNE_KEY_MAX_LENGTH} band for a plausible Dune key, so it was ` +
        `NOT used and the creation enumeration fell back to the Solana RPC walk. That usually ` +
        `means a truncated paste, a shell-quoting slip, or a whole dotenv line captured instead of ` +
        `the value. The value is not shown, here or anywhere.`,
    };
  }

  return {
    available: true,
    key: raw,
    label: DUNE_API_BASE,
    keyDescription: describeDuneKey(raw),
    keyEnvVar: DUNE_KEY_ENV_VAR,
    rejected: null,
  };
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
 * `401` still leads with expiry rather than with "invalid" — but it now says the expiry is
 * UNVERIFIED on this tier rather than asserting it. The Free tier expired keys every 30 days, which
 * made expiry much the likelier cause of a 401; **nothing has verified that on Ultra**, and neither
 * error is free. Deleting the clause leaves a 401 with no likely cause named; keeping it as fact
 * sends an operator to reissue a key that is working. So the message names both readings and puts
 * the cheap check (re-export, then reissue) first.
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
        `  MadeOnSol's Free tier expired keys every 30 days. This lane's key is **Ultra** and\n` +
        `  WHETHER THAT EXPIRY APPLIES HERE IS UNVERIFIED, so treat expiry as likely but not\n` +
        `  established: first re-export ${KEY_ENV_VAR} in case the value was lost or truncated,\n` +
        `  then issue a fresh key at https://madeonsol.com/developer if it still 401s.\n` +
        `  This is NOT a negative result: no deployer was screened.${tail}`,
    };
  }

  if (status === 403) {
    return {
      kind: 'wrong-tier',
      message:
        `HTTP 403 — the key is recognised but not entitled to this endpoint.\n` +
        `  Every endpoint this tool calls is reachable on the **Free tier**, and this lane's key is\n` +
        `  **Ultra** (captain, 2026-08-05), so a 403 here should be impossible. It therefore means\n` +
        `  the key was downgraded or revoked, or the vendor moved a formerly-free endpoint behind a\n` +
        `  plan. Either way it is a BUG TO REPORT, not a prompt to upgrade: the tier is the\n` +
        `  captain's to set and no run may widen it.\n` +
        `  This is NOT a negative result: no deployer was screened.${tail}`,
    };
  }

  if (status === 429) {
    return {
      kind: 'quota-exhausted',
      message:
        `HTTP 429 — rate-limited or out of daily quota.\n` +
        `  This lane's key is **Ultra**: 100,000 requests/day, resetting at 00:00Z, and EXCLUSIVE\n` +
        `  to slot-zero, so nothing else is spending it. A full run plans ~201 requests, and a\n` +
        `  ladder measured 2026-08-05 shed nothing even back-to-back — so a 429 here is a surprise\n` +
        `  and worth reading the vendor's own counter for rather than waiting it out blind:\n` +
        `      curl -sD- -o/dev/null -H "authorization: Bearer $${KEY_ENV_VAR}" \\\n` +
        `        'https://madeonsol.com/api/v1/deployer-hunter/leaderboard?sort=total_bonded&limit=1' \\\n` +
        `        | grep -i ratelimit\n` +
        `  x-ratelimit-remaining and x-ratelimit-reset say whether the day is actually spent. A\n` +
        `  rerun costs no more than the first run did: nothing here is priced on what an earlier\n` +
        `  run spent.\n` +
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
