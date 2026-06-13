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
