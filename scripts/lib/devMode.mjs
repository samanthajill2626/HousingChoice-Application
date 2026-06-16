// Pure mode/env resolution for the local dev loop (scripts/dev.mjs). No AWS,
// no filesystem — unit-tested offline in app/test/devMode.test.ts.
//
// Two modes:
//   live  (default)  app + worker on this machine against the REAL dev
//                    backend: hc-dev- DynamoDB tables in us-east-1 via the
//                    housingchoice profile. Account-guarded by dev.mjs.
//   local (--local)  hermetic loop: DynamoDB Local + hc-local- tables, dummy
//                    creds, no AWS needed. Also selected whenever
//                    DYNAMODB_ENDPOINT is set (env or .env).

/** Default table prefix for live mode — the real dev stack's tables. */
export const LIVE_TABLE_PREFIX = 'hc-dev-';

/** Default AWS profile for live mode (see scripts/lib/hcAws.mjs). */
export const LIVE_AWS_PROFILE = 'housingchoice';

/** Default table prefix for the hermetic loop (matches app config default). */
export const LOCAL_TABLE_PREFIX = 'hc-local-';

/**
 * Decide the dev mode and build the env overlay for child processes.
 *
 * Precedence: real environment > .env file > mode defaults. The returned
 * overlay is meant to be spread AFTER process.env into the child env, so it
 * only ever contains .env-file values not already set in the environment,
 * plus mode defaults set in neither.
 *
 * @param {{ local?: boolean,
 *           processEnv: Record<string, string|undefined>,
 *           fileEnv: Record<string, string>,
 *           localEndpoint: string }} opts
 * @returns {{ mode: 'live'|'local', overlay: Record<string, string> }}
 */
export function resolveDevEnv({ local = false, processEnv, fileEnv, localEndpoint }) {
  /** @type {Record<string, string>} */
  const overlay = {};
  for (const [key, value] of Object.entries(fileEnv)) {
    if (processEnv[key] === undefined) overlay[key] = value;
  }
  const get = (key) => processEnv[key] ?? overlay[key];

  const mode = local || get('DYNAMODB_ENDPOINT') !== undefined ? 'local' : 'live';

  if (mode === 'local') {
    if (get('DYNAMODB_ENDPOINT') === undefined) overlay.DYNAMODB_ENDPOINT = localEndpoint;
    if (get('TABLE_PREFIX') === undefined) overlay.TABLE_PREFIX = LOCAL_TABLE_PREFIX;
    // Mount the dev auth router (/auth/dev-login + /__dev/ping) so the dashboard
    // dev-login button works in the hermetic loop. Safe ONLY here: local mode
    // always points at DynamoDB Local, never prod, and the app still requires
    // a non-production NODE_ENV + a set DYNAMODB_ENDPOINT before mounting it.
    // Never set in live mode (pointless — no dynamodbEndpoint there — and the
    // requirement forbids it). Respect an explicit env value (e.g. '0').
    if (get('DEV_AUTH_ENABLED') === undefined) overlay.DEV_AUTH_ENABLED = '1';
  } else {
    if (get('TABLE_PREFIX') === undefined) overlay.TABLE_PREFIX = LIVE_TABLE_PREFIX;
    if (get('AWS_PROFILE') === undefined) overlay.AWS_PROFILE = LIVE_AWS_PROFILE;
    if (get('TABLE_PREFIX') === 'hc-prod-') {
      throw new Error(
        'refusing to start: TABLE_PREFIX=hc-prod- would point the local dev loop at PROD tables',
      );
    }
  }

  return { mode, overlay };
}
