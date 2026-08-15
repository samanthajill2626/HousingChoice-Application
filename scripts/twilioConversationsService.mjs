// Twilio Conversations Service - idempotent create-or-reconcile. Powers:
//   npm run twilio:conversations -- <dev|prod> [--webhook-base <url>] [--check]
//
// WHY THIS SCRIPT EXISTS: same reasoning as twilioVi.mjs - Twilio's first-party
// Terraform provider is deprecated/archived, so the handful of Twilio resources
// we manage as code live in idempotent operator scripts instead of a
// third-party provider with split-brain state. Eventual full Twilio IaC is
// tracked in docs/issues/twilio-config-into-terraform.md; retire this then.
//
// WHAT IT MANAGES: the Conversations SERVICE that native group-texting rails are
// created under (app config TWILIO_CONVERSATIONS_SERVICE_SID), plus that
// service's post-webhook configuration.
//
// WHY A PER-ENV SERVICE AT ALL: a Conversations service owns BOTH its webhook
// configuration and its UniqueName namespace, and the account's DEFAULT service
// is one per ACCOUNT. Two envs sharing a Twilio account and both on the default
// therefore share ONE post-webhook URL (only one env can receive
// onDeliveryUpdated / onMessageAdded) AND one UniqueName namespace - and a
// rail's UniqueName IS our conversationId (uuidv5 over the roster minus our own
// numbers), so the SAME people in both envs derive the SAME UniqueName and one
// env silently ADOPTS the other's live rail. Giving each env its own service
// separates both.
//
// IDENTITY IS friendly_name, NOT unique_name. Unlike Voice Intelligence
// services, the Conversations Services API has NO unique_name field - create
// takes FriendlyName only, and nothing stops two services sharing one. So this
// script keys on friendly_name and REFUSES on a duplicate rather than guessing
// which one is ours; picking wrong would point an env's rails at a service whose
// webhook belongs to something else.
//
// TEMPLATE-FIRST (same rule as twilioVi.mjs / vapidKeys.mjs): this script does
// NOT write .env.<env>. It prints `TWILIO_CONVERSATIONS_SERVICE_SID=IS...` to
// stdout for the operator to paste into .env.<env> (gitignored), then:
//   npm run secrets:push -- <env>     # lands it in Parameter Store
//   npm run deploy:<env>              # hydrates it onto the instance
// Leaving TWILIO_CONVERSATIONS_SERVICE_SID unset keeps that env on the account
// DEFAULT service (the historical behavior). No AWS is touched, so no account
// guard.
//
// --check is READ-ONLY: it reports the current service + any webhook drift and
// writes nothing (exit 0 in-sync, 2 drift/absent, 1 error).
//
// NOT IN SCOPE: clearing the DEFAULT service's webhook configuration. Once an
// env moves onto its own service, the default service's old rails would still
// post to whatever URL it carries - an operator step, deliberately left manual
// because it affects every env on the account at once.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STACK_ENVS } from './lib/hcAws.mjs';
import { parseDotenv } from './lib/secretsCore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node scripts/twilioConversationsService.mjs <dev|prod> [--webhook-base <url>]
                 [--friendly-name <name>] [--check]
  (via npm: npm run twilio:conversations -- dev)
  Ensures this env's Conversations service exists with our post-webhook wired,
  and prints its ISxxxx sid (create-or-reconcile). Resolves the service by the
  TWILIO_CONVERSATIONS_SERVICE_SID already in .env.<env> when present, else by
  friendly name.
  --webhook-base <url>   base for the post-webhook (default: PUBLIC_BASE_URL from
                         .env.<env>). Full URL is <base>/webhooks/twilio/conversations.
  --friendly-name <name> override the friendly name used to find/create the
                         service (default: "HC <Env> Conversation Service").
  --check                read-only: report state + drift, write nothing (exit 2 on drift)`;

const WEBHOOK_PATH = '/webhooks/twilio/conversations';
const CONVERSATIONS_BASE = 'https://conversations.twilio.com/v1';

// BOTH filters, on the ONE post-webhook URL. onDeliveryUpdated is the only
// source of group delivery state (classic status callbacks do NOT fire for
// Conversations-originated sends - proved live), and onMessageAdded is the
// cross-check guardrail's entire input. Dropping either is silent: group
// delivery state simply stops updating, or the guardrail alarms on healthy
// traffic. Sorted so the drift comparison is order-insensitive.
const DESIRED_FILTERS = ['onDeliveryUpdated', 'onMessageAdded'];

// A controlled failure: carries a human message + exit code. THROWN, never
// process.exit - a forced exit while an undici keep-alive handle is still open
// trips a libuv assertion on Windows and clobbers the exit code. main() lets the
// event loop drain, then sets process.exitCode.
class ExitError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const fail = (message) => {
  throw new ExitError(message, 1);
};

const sortedFilters = (list) => [...new Set(list ?? [])].sort();
const sameFilters = (a, b) => {
  const x = sortedFilters(a);
  const y = sortedFilters(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

async function main() {
  // --- argv --------------------------------------------------------------------
  const args = process.argv.slice(2);
  const env = args.shift();
  if (!STACK_ENVS.includes(env ?? '')) fail(USAGE);

  let checkOnly = false;
  let webhookBase;
  let friendlyNameArg;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--check') {
      checkOnly = true;
    } else if (arg === '--webhook-base') {
      webhookBase = args.shift();
      if (!webhookBase) fail(`--webhook-base needs a URL.\n${USAGE}`);
    } else if (arg === '--friendly-name') {
      friendlyNameArg = args.shift();
      if (!friendlyNameArg) fail(`--friendly-name needs a value.\n${USAGE}`);
    } else {
      fail(`Unknown argument "${arg}".\n${USAGE}`);
    }
  }

  // --- read .env.<env> for Twilio creds + (optionally) the webhook base --------
  const envFileName = `.env.${env}`;
  const envFile = path.join(repoRoot, envFileName);
  if (!existsSync(envFile)) {
    fail(`[twilio:conversations] ${envFileName} not found at the repo root.`);
  }

  let entries;
  try {
    entries = parseDotenv(readFileSync(envFile, 'utf8'));
  } catch (err) {
    fail(`[twilio:conversations] ${envFileName} is not valid dotenv - ${err.message}`);
  }

  const accountSid = entries.TWILIO_ACCOUNT_SID;
  const authToken = entries.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    fail(
      `[twilio:conversations] ${envFileName} must define TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.`,
    );
  }

  // PUBLIC_BASE_URL is normally ABSENT here: it is Terraform/deploy-managed and
  // secrets:push REFUSES it in .env.<env>, so --webhook-base is the ordinary
  // path rather than an override. The fallback is kept for a local .env that
  // happens to carry one.
  const wbBase = (webhookBase ?? entries.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!wbBase) {
    fail(
      `[twilio:conversations] no webhook base. Pass --webhook-base <url> - e.g.\n` +
        `  npm run twilio:conversations -- ${env} --webhook-base https://${
          env === 'prod' ? 'app' : 'dev.app'
        }.housingchoice.org\n` +
        `(PUBLIC_BASE_URL is Terraform-managed and is deliberately NOT in ${envFileName}, so there ` +
        `is nothing to read it from. A wrong base means every group delivery receipt lands ` +
        `somewhere else, so this never guesses.)`,
    );
  }
  let webhookUrl;
  try {
    // CONCATENATE, do not URL-resolve: new URL('/abs/path', base) DISCARDS the
    // base's own path segments, so a --webhook-base ending in /nowhere would
    // silently produce the canonical URL and report "in sync" (the twilioVi.mjs
    // lesson, 2026-07-20). Concat preserves any base path; new URL() then just
    // validates/normalizes.
    webhookUrl = new URL(`${wbBase}${WEBHOOK_PATH}`).toString();
  } catch {
    fail(`[twilio:conversations] webhook base "${wbBase}" is not a valid URL.`);
  }

  // Matches the services created by hand on 2026-08-15 ("HC Dev Conversation
  // Service" / "HC Prod Conversation Service"). Overridable because friendly
  // names are free text and a mismatch is dangerous: the script would find
  // nothing and CREATE A SECOND service, leaving the env pointed at one while
  // the webhook lives on the other.
  const friendlyName =
    friendlyNameArg ?? `HC ${env.charAt(0).toUpperCase()}${env.slice(1)} Conversation Service`;
  const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  // --- Twilio REST helpers (Account SID + Auth Token basic auth) ---------------
  /** GET/POST the Conversations API; returns parsed JSON or throws the Twilio error.
   *  An ARRAY form value is appended once per element - Twilio's repeated-key
   *  encoding for Filters. URLSearchParams would otherwise join an array with
   *  commas into ONE value, which Twilio rejects (or worse, stores verbatim). */
  async function twilio(method, url, form, opts = {}) {
    // Connection: close - no keep-alive socket lingers after the response, so the
    // event loop drains and the process exits promptly with the right code.
    const init = { method, headers: { Authorization: authHeader, Connection: 'close' } };
    if (form) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        if (Array.isArray(value)) for (const v of value) params.append(key, v);
        else params.append(key, value);
      }
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = params.toString();
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      fail(`[twilio:conversations] network error calling Twilio (${method} ${url}): ${err.message}`);
    }
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      // allow404 returns null for a genuine "not there" ONLY. Every other status
      // - 401 on a bad token, 429, a 5xx - still fails loudly, so a credential
      // or outage problem can never be misreported as a missing resource.
      if (opts.allow404 && res.status === 404) return null;
      const code = body.code ? ` code=${body.code}` : '';
      const detail = body.message ?? body.raw ?? res.statusText;
      fail(`[twilio:conversations] Twilio ${method} ${url} -> ${res.status}${code}: ${detail}`);
    }
    return body;
  }

  /** Find our service by friendly_name, paging through the list. Returns it, or
   *  null. REFUSES on more than one match: identity here is a non-unique display
   *  name, so "pick the first" could silently point this env's rails at a service
   *  configured for something else. */
  async function findService() {
    const matches = [];
    let url = `${CONVERSATIONS_BASE}/Services?PageSize=50`;
    while (url) {
      const page = await twilio('GET', url);
      for (const s of page.services ?? []) {
        if (s.friendly_name === friendlyName) matches.push(s);
      }
      const next = page.meta?.next_page_url;
      url = next && next !== 'null' ? next : null;
    }
    if (matches.length > 1) {
      fail(
        `[twilio:conversations] AMBIGUOUS: ${matches.length} services are named "${friendlyName}" ` +
          `(${matches.map((s) => s.sid).join(', ')}). Conversations services have no unique_name, so ` +
          `this cannot tell which is ours. Delete or rename the extras in the Twilio console, then ` +
          `re-run.`,
      );
    }
    return matches[0] ?? null;
  }

  /** Read a service's post-webhook configuration. */
  async function readWebhook(serviceSid) {
    return twilio('GET', `${CONVERSATIONS_BASE}/Services/${serviceSid}/Configuration/Webhooks`);
  }

  /** Emit the pasteable sid line (stdout) + operator next-steps (stderr).
   *  The push/deploy steps apply ONLY when the sid is not yet in .env.<env> -
   *  webhook changes live on the Twilio service and take effect immediately,
   *  with nothing app-side to push. */
  function report(sid) {
    console.error('');
    if (entries.TWILIO_CONVERSATIONS_SERVICE_SID === sid) {
      console.error(
        `[twilio:conversations] ${envFileName} already carries this sid. Twilio-side changes ` +
          `(webhook URL / filters) are live immediately - NO secrets:push / deploy needed.`,
      );
    } else {
      console.error(`Paste this into ${envFileName} (gitignored), then:`);
      console.error(`  npm run secrets:push -- ${env}     # lands it in Parameter Store`);
      console.error(`  npm run deploy:${env}              # hydrates it onto the instance`);
      console.error('');
      console.error(
        `[twilio:conversations] REMINDER: once this env is on its own service, clear the ACCOUNT ` +
          `DEFAULT service's post-webhook in the console - its old rails otherwise keep posting. ` +
          `Existing rails on the default service are ORPHANED by the switch and are re-created on ` +
          `next use.`,
      );
      console.error(
        `[twilio:conversations] NOTE: with this set, the app acknowledges-and-IGNORES (200, logged ` +
          `at ERROR so it alarms) any Conversations event whose ChatServiceSid does not match - so ` +
          `a mis-pointed webhook is loud instead of silently filing another environment's events.`,
      );
    }
    console.log(`TWILIO_CONVERSATIONS_SERVICE_SID=${sid}`);
  }

  // --- 1. locate ---------------------------------------------------------------
  // SID FIRST, name second. Once .env.<env> carries a sid that IS the identity -
  // exact, and immune to the friendly name having been typed differently in the
  // console than this script expects. Name matching is only for the
  // not-yet-created case; relying on it when a sid exists risks "found nothing,
  // create a second service" while the env keeps pointing at the first.
  const configuredSid = (entries.TWILIO_CONVERSATIONS_SERVICE_SID ?? '').trim();
  console.error(
    `[twilio:conversations] env=${env}  ` +
      (configuredSid
        ? `resolving by sid from ${envFileName}: ${configuredSid}`
        : `resolving by friendlyName="${friendlyName}"`),
  );
  console.error(
    `[twilio:conversations] desired webhook: POST ${webhookUrl} filters=[${DESIRED_FILTERS.join(', ')}]`,
  );

  let existing = null;
  if (configuredSid) {
    const found = await twilio(
      'GET',
      `${CONVERSATIONS_BASE}/Services/${encodeURIComponent(configuredSid)}`,
      undefined,
      { allow404: true },
    );
    if (!found) {
      fail(
        `[twilio:conversations] ${envFileName} names service ${configuredSid} but Twilio does not ` +
          `have it. That env is configured to create rails under a service that does not exist. ` +
          `Fix the sid in ${envFileName}, or remove it and re-run to create a fresh service.`,
      );
    }
    existing = found;
    if (found.friendly_name !== friendlyName) {
      console.error(
        `[twilio:conversations] note: its friendly name is "${found.friendly_name}", not ` +
          `"${friendlyName}" - using the sid, which is authoritative.`,
      );
    }
  } else {
    existing = await findService();
  }

  // --- 2. reconcile or create --------------------------------------------------
  if (existing) {
    console.error(`[twilio:conversations] found existing service ${existing.sid}`);
    const hook = await readWebhook(existing.sid);
    const haveUrl = hook.post_webhook_url ?? '';
    const haveMethod = (hook.method ?? '').toUpperCase();
    const haveFilters = hook.filters ?? [];
    const drift =
      haveUrl !== webhookUrl || haveMethod !== 'POST' || !sameFilters(haveFilters, DESIRED_FILTERS);

    if (!drift) {
      console.error('[twilio:conversations] webhook already in sync - nothing to reconcile.');
      report(existing.sid);
      return 0;
    }
    console.error(
      `[twilio:conversations] webhook DRIFT: have [${haveMethod || '(none)'} ` +
        `${haveUrl || '(none)'} filters=[${sortedFilters(haveFilters).join(', ') || '(none)'}]], ` +
        `want [POST ${webhookUrl} filters=[${DESIRED_FILTERS.join(', ')}]].`,
    );
    if (checkOnly) {
      console.error('[twilio:conversations] --check: not reconciling. Re-run without --check to fix.');
      return 2;
    }
    await twilio('POST', `${CONVERSATIONS_BASE}/Services/${existing.sid}/Configuration/Webhooks`, {
      PostWebhookUrl: webhookUrl,
      Method: 'POST',
      Filters: DESIRED_FILTERS,
    });
    console.error('[twilio:conversations] webhook reconciled.');
    report(existing.sid);
    return 0;
  }

  // Not found.
  if (checkOnly) {
    console.error(
      `[twilio:conversations] --check: no service named "${friendlyName}" yet - re-run without ` +
        `--check to create it.`,
    );
    return 2;
  }
  console.error('[twilio:conversations] creating service...');
  const created = await twilio('POST', `${CONVERSATIONS_BASE}/Services`, {
    FriendlyName: friendlyName,
  });
  console.error(`[twilio:conversations] created service ${created.sid}. Wiring the post-webhook...`);
  // The webhook is a SEPARATE resource from the service, so a create is always
  // two calls. If this second call fails the service EXISTS but is deaf - re-run
  // is safe and idempotent (findService adopts it and reconciles the webhook).
  await twilio('POST', `${CONVERSATIONS_BASE}/Services/${created.sid}/Configuration/Webhooks`, {
    PostWebhookUrl: webhookUrl,
    Method: 'POST',
    Filters: DESIRED_FILTERS,
  });
  console.error('[twilio:conversations] post-webhook wired.');
  report(created.sid);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    if (err instanceof ExitError) {
      console.error(err.message);
      process.exitCode = err.code;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  });
