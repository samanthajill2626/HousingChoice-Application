// Pure core of the secrets sync (scripts/secrets.mjs): dotenv parsing, value
// masking, and the managed-by-others denylist. NOTHING here touches AWS or the
// filesystem — every export is unit-tested offline in
// app/test/secretsCore.test.ts.

/**
 * Params under /hc/<env>/app/ owned by Terraform (the params module) or the
 * deploy script (DEPLOYED_TAG). They must NEVER appear in .env.dev/.env.prod,
 * and the secrets script must never overwrite them.
 */
export const MANAGED_BY_OTHERS = Object.freeze([
  'CF_ORIGIN_SECRET',
  'DEPLOYED_TAG',
  'EMAIL_CONFIGURATION_SET',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_SENDER_DOMAIN',
  'INBOUND_MAIL_BUCKET',
  'INBOUND_MAIL_QUEUE_URL',
  'JOBS_QUEUE_URL',
  'LOG_LEVEL',
  'MEDIA_BUCKET',
  'NODE_ENV',
  'PORT',
  'PUBLIC_BASE_URL',
  'SCHEDULER_ROLE_ARN',
  'SCHEDULER_TARGET_ARN',
  'SESSION_SECRET',
  'TABLE_PREFIX',
]);

/**
 * Parse dotenv text into a plain { KEY: value } object.
 *
 * Supported (the format of .env.dev/.env.prod): `KEY=value` lines, blank
 * lines, full-line `#` comments, optional single/double quotes around values,
 * whitespace trimmed around keys and unquoted values. Deliberately NOT
 * supported: interpolation, escape sequences, multi-line values, and inline
 * comments (secrets may legitimately contain `#`). Malformed lines and
 * duplicate keys throw — error messages carry line numbers only, never line
 * content (it may be a secret).
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotenv(text) {
  /** @type {Record<string, string>} */
  const entries = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) {
      throw new Error(
        `line ${i + 1}: expected KEY=value (key chars [A-Za-z0-9_], comments start with #)`,
      );
    }
    const key = match[1];
    if (Object.hasOwn(entries, key)) {
      throw new Error(`line ${i + 1}: duplicate key ${key}`);
    }
    let value = match[2].trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    entries[key] = value;
  }
  return entries;
}

/**
 * Mask a secret for display: at most the first 2 + last 4 chars (`AC…1234`).
 * Values too short to keep at least 6 chars hidden are fully masked, with a
 * fixed-width mask so even the length is not leaked.
 *
 * @param {string} value
 * @returns {string}
 */
export function maskValue(value) {
  const v = String(value ?? '');
  if (v.length === 0) return '(empty)';
  if (v.length < 12) return '****';
  return `${v.slice(0, 2)}…${v.slice(-4)}`;
}

/**
 * The subset of `keys` that collide with MANAGED_BY_OTHERS (the
 * Terraform/deploy-managed denylist). Empty array = file is safe to push.
 *
 * @param {string[]} keys
 * @returns {string[]}
 */
export function findDenylistedKeys(keys) {
  return keys.filter((key) => MANAGED_BY_OTHERS.includes(key));
}

/**
 * SSM param keys under /hc/<env>/app/ that are no longer backed by .env.<env> —
 * orphans left behind when a key is removed from the file (push only ever
 * creates/updates, never deletes). Excludes Terraform/deploy-managed params
 * (MANAGED_BY_OTHERS): those live in SSM by design and must NEVER be pruned.
 * Returned sorted. This is the delete set for `secrets:prune` and the same set
 * `secrets:check` reports under "extra params" (both call this — one source of
 * truth for "what is an orphan").
 *
 * @param {string[]} ssmKeys keys present under the SSM path (basename only)
 * @param {string[]} envKeys keys present in .env.<env>
 * @returns {string[]} sorted keys in SSM but neither in the file nor managed
 */
export function findOrphanParams(ssmKeys, envKeys) {
  const envSet = new Set(envKeys);
  return ssmKeys.filter((key) => !envSet.has(key) && !MANAGED_BY_OTHERS.includes(key)).sort();
}

/**
 * Key-set drift between a real .env.<env> file and its committed
 * .env.<env>.example template (values are irrelevant — the template holds
 * placeholders). The example is the source of truth for STRUCTURE: new keys
 * are added template-first, then merged into the real file.
 *
 * @param {string[]} realKeys    keys present in .env.<env>
 * @param {string[]} exampleKeys keys present in .env.<env>.example
 * @returns {{ missing: string[], extra: string[] }} missing = in the example
 *   but not the real file; extra = in the real file but not the example.
 */
export function diffKeySets(realKeys, exampleKeys) {
  return {
    missing: exampleKeys.filter((key) => !realKeys.includes(key)).sort(),
    extra: realKeys.filter((key) => !exampleKeys.includes(key)).sort(),
  };
}

// Heading for the trailing block of keys that exist in the real file but not
// in the template (drift). It is regenerated on every sync, so syncing a file
// that already carries this block must NOT nest a second copy — the parser
// below treats it like any other comment, and the section is rebuilt from the
// freshly-computed extra-key set.
const EXTRA_KEYS_HEADER = '# --- Keys not in the template (review/remove) ---';

/**
 * Extract the VERBATIM right-hand side (everything after the FIRST `=`) of a
 * `KEY=...` line, keyed by KEY, from raw dotenv text. Unlike parseDotenv this
 * does NOT trim or strip quotes — it preserves the exact bytes of the value so
 * a sync can carry a secret across untouched (quotes, inner `=`, leading and
 * trailing spaces, etc.). Comment/blank lines are skipped; the matcher mirrors
 * parseDotenv's key grammar so the two agree on what a KEY line is. parseDotenv
 * is the validator/duplicate-detector — this is only used after it has passed.
 *
 * @param {string} text
 * @returns {Map<string, string>} KEY -> raw RHS bytes (insertion order)
 */
function rawRhsByKey(text) {
  /** @type {Map<string, string>} */
  const raw = new Map();
  const lines = String(text).split(/\r?\n/);
  for (const rawLine of lines) {
    // Match a leading KEY then capture EVERYTHING after the first `=` verbatim
    // (no .trim() on the value — leading/trailing spaces are part of it). The
    // `^\s*` allows the key itself to be indented, matching parseDotenv which
    // trims the line before matching.
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s.exec(rawLine);
    if (!match) continue; // blank line, comment, or a malformed line
    const key = match[1];
    if (key === undefined) continue;
    if (!raw.has(key)) raw.set(key, match[2] ?? '');
  }
  return raw;
}

/**
 * Make a real `.env.<env>` mirror the COMMENTS and STRUCTURE of its committed
 * template `.env.<env>.example` while PRESERVING the real file's existing
 * secret VALUES. The reliable mechanism behind the template-first rule: the
 * example is the source of truth for comments + structure + key-set; the real
 * file holds values.
 *
 * Algorithm — walk `exampleText` line by line IN ORDER:
 *   - Comment lines (`#…`) and blank lines are emitted VERBATIM from the
 *     example (this is how comment edits and new-key comments propagate).
 *   - For a `KEY=...` line, emit `KEY=<rawValue>` where `<rawValue>` is the
 *     VERBATIM right-hand side of that KEY as it appears in `realText` if the
 *     key exists there; otherwise empty (`KEY=`). The real value's exact bytes
 *     are preserved — NO round-trip through parse/unquote.
 * Keys in `realText` but NOT in the example are "extra" (drift): they are
 * NEVER dropped — after the example-derived body they are appended under a
 * clearly-generated heading and listed in `summary.extraKeys`.
 *
 * The output EOL style matches the example (CRLF vs LF, detected from the
 * example text). The summary carries KEY NAMES ONLY — never any value.
 *
 * Idempotent: syncing an already-synced file yields byte-identical output.
 *
 * @param {string} exampleText  the committed .env.<env>.example (source of truth)
 * @param {string} realText     the current .env.<env> (source of values)
 * @returns {{
 *   output: string,
 *   summary: {
 *     newKeys: string[],
 *     preservedKeys: string[],
 *     extraKeys: string[],
 *     changed: boolean,
 *   },
 * }}
 * @throws if the example or the real file is not valid dotenv (via parseDotenv:
 *   line numbers only, never content), or if the example contains a
 *   Terraform/deploy-managed (denylisted) key — the example must never have one.
 */
export function syncEnvFromExample(exampleText, realText) {
  // Validate + extract key sets (parseDotenv throws on malformed lines or
  // duplicate keys, with line numbers only — never content).
  const exampleKeys = Object.keys(parseDotenv(exampleText));
  const realKeys = Object.keys(parseDotenv(realText));

  // Defensive: the example is committed and must never carry a managed secret.
  const denylisted = findDenylistedKeys(exampleKeys);
  if (denylisted.length > 0) {
    throw new Error(
      `template contains Terraform/deploy-managed key(s): ${denylisted.join(', ')} — ` +
        `those are owned by plan/apply and the deploy script and must never be in the example`,
    );
  }

  // Raw (un-trimmed, un-unquoted) values from the real file, for byte-exact
  // preservation. The real file is the ONLY source of values.
  const realRaw = rawRhsByKey(realText);
  const exampleKeySet = new Set(exampleKeys);

  // Match the example's EOL so we never flip a Windows file to LF or vice versa.
  const eol = exampleText.includes('\r\n') ? '\r\n' : '\n';

  // Walk the example verbatim; substitute real values on KEY lines. We split on
  // the example's own newline grammar (\r?\n) and re-join with the detected EOL
  // so a mixed-EOL example is normalized to its dominant style.
  const exampleLines = String(exampleText).split(/\r?\n/);
  /** @type {string[]} */
  const out = [];
  for (const line of exampleLines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s.exec(line);
    if (!match) {
      // Comment or blank line — emit VERBATIM (this carries comment edits).
      out.push(line);
      continue;
    }
    const key = match[1];
    // Emit `KEY=<rawValue>` — the real file's verbatim RHS, or empty for a new
    // key. The KEY is taken from the example (canonical, un-indented) so the
    // output key form is the template's, while the value bytes are the real
    // file's.
    const rawValue = realRaw.has(key) ? realRaw.get(key) : '';
    out.push(`${key}=${rawValue}`);
  }

  // Extra keys: in the real file but not the template. Never dropped — appended
  // under a regenerated, clearly-labelled section. Order follows the real file.
  const extraKeys = realKeys.filter((key) => !exampleKeySet.has(key));
  if (extraKeys.length > 0) {
    out.push('');
    out.push(EXTRA_KEYS_HEADER);
    for (const key of extraKeys) {
      out.push(`${key}=${realRaw.get(key) ?? ''}`);
    }
  }

  const output = out.join(eol);

  const newKeys = exampleKeys.filter((key) => !realRaw.has(key));
  const preservedKeys = exampleKeys.filter((key) => realRaw.has(key));

  return {
    output,
    summary: {
      newKeys,
      preservedKeys,
      extraKeys,
      changed: output !== realText,
    },
  };
}
