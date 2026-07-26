// Twilio Event Streams Sink (webhook) + Subscription - idempotent
// create-or-reconcile for the relay "connect-when-ready" number buying strategy
// (T10). Powers:
//   npm run twilio:events -- <dev|prod> [--app-host <host>] [--check]
//   npm run twilio:events -- <dev|prod> --destroy            (tear the sink down)
//
// WHY THIS SCRIPT EXISTS (and why it is NOT a Twilio Terraform provider): the
// same rationale as scripts/twilioVi.mjs. infra/ is AWS-only (hashicorp/aws +
// hashicorp/random); no Twilio provider is configured. Twilio's community TF
// provider (RJPearson94/twilio, v0.18.x) is in PILOT / unmaintained, pre-1.0,
// and has NO Event Streams Sink/Subscription resources (verified 2026-07-21).
// Adopting it for ONE resource = a deprecated provider + Twilio creds in TF
// state + split-brain. So account-scoped Twilio config stays in idempotent
// operator scripts (cf. twilioVi.mjs, vapidKeys.mjs). The twilio-events
// Terraform module wraps THIS script via a terraform_data local-exec so it is a
// per-env, wired-into-the-stack apply surface. Eventual full IaC is tracked in
// docs/issues/twilio-config-into-terraform.md.
//
// WHAT IT DOES: ensures a webhook Sink named hc-<env>-relay-events exists whose
// destination is https://<app-host>/webhooks/twilio/events WITH Basic-auth
// credentials in the URL user-info (Twilio forwards them as the Authorization
// header - decision D4), and a Subscription binding that Sink to the A2P
// compliance number-registration + number-deregistration event types at schema
// version 1 (decision D3). Safe to re-run: an existing Sink/Subscription found
// by description is REUSED (the webhook Sink configuration is IMMUTABLE in the
// Event Streams API, so a changed destination is REPORTED, not silently
// duplicated - the Terraform module handles a change by replacing the resource,
// which destroys then recreates; standalone, delete the sink first or use the
// console). --destroy deletes the Subscription then the Sink (missing = no-op).
//
// SECRET: the Basic-auth password embedded in the sink URL is the app's
// TWILIO_EVENTS_WEBHOOK_SECRET (config.twilioEventsWebhookSecret). The SAME
// value MUST be deployed to the app (secrets:push) BEFORE this runs, because
// Twilio validates a new webhook sink by POSTing to the destination and the app
// compares the forwarded password - a sink created before the app knows the
// secret fails validation. This script reads the secret from
// TWILIO_EVENTS_WEBHOOK_SECRET_OVERRIDE (the Terraform var path) if set, else
// from TWILIO_EVENTS_WEBHOOK_SECRET in .env.<env>. It is NEVER printed
// (destination logs show the password as ***). No AWS is touched (no account
// guard); Twilio creds (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN) come from
// .env.<env>, exactly like twilioVi.mjs.
//
// --check is READ-ONLY: reports the current Sink/Subscription + any drift and
// writes nothing (exit 0 in-sync/creatable, 2 drift, 1 error).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STACK_ENVS } from './lib/hcAws.mjs';
import { maskValue, parseDotenv } from './lib/secretsCore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node scripts/twilioEventsSink.mjs <dev|prod> [--app-host <host>] [--check] [--destroy]
  (via npm: npm run twilio:events -- dev)
  Ensures the hc-<env>-relay-events Event Streams webhook Sink + Subscription
  exist (create-or-reconcile). The sink POSTs to https://<host>/webhooks/twilio/events.
  --app-host <host>  canonical app host, no scheme (default: host of PUBLIC_BASE_URL
                     in .env.<env>). e.g. dev.app.housingchoice.org
  --check            read-only: report state + drift, write nothing (exit 2 on drift)
  --destroy          delete the Subscription then the Sink for this env (missing = no-op)
  (Terraform passes inputs via TWILIO_EVENTS_* env vars; see infra/modules/twilio-events.)`;

const WEBHOOK_PATH = '/webhooks/twilio/events';
const EVENTS_BASE = 'https://events.twilio.com/v1';

// The A2P compliance event types the Subscription binds at schema v1 (decision
// D3). Registration promotes warming -> active (T3 onNumberRegistered); the
// de-registration counterparts are log-only today (future retirement signalling).
const DEFAULT_TYPES = [
  'com.twilio.messaging.compliance.number-registration.successful',
  'com.twilio.messaging.compliance.number-registration.pending',
  'com.twilio.messaging.compliance.number-registration.failed',
  'com.twilio.messaging.compliance.number-deregistration.successful',
  'com.twilio.messaging.compliance.number-deregistration.pending',
  'com.twilio.messaging.compliance.number-deregistration.failed',
];

// A controlled failure carrying a human message + exit code. THROWN, never
// process.exit - a forced exit while an undici keep-alive handle is still open
// trips a libuv assertion on Windows and clobbers the exit code (same reason as
// twilioVi.mjs). main() lets the loop drain, then sets process.exitCode.
class ExitError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const fail = (message) => {
  throw new ExitError(message, 1);
};

async function main() {
  // --- argv --------------------------------------------------------------------
  // Terraform invokes with NO positional (env + inputs via TWILIO_EVENTS_* env
  // vars); an operator passes <env> positionally + flags.
  const args = process.argv.slice(2);
  let env = process.env.TWILIO_EVENTS_ENV;
  let checkOnly = false;
  let destroy = process.env.TWILIO_EVENTS_DESTROY === '1';
  let appHostArg;
  let webhookUserArg;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--check') {
      checkOnly = true;
    } else if (arg === '--destroy') {
      destroy = true;
    } else if (arg === '--app-host') {
      appHostArg = args.shift();
      if (!appHostArg) fail(`--app-host needs a host.\n${USAGE}`);
    } else if (arg === '--webhook-user') {
      webhookUserArg = args.shift();
      if (!webhookUserArg) fail(`--webhook-user needs a value.\n${USAGE}`);
    } else if (arg && !arg.startsWith('--') && !env) {
      env = arg; // positional <env>
    } else {
      fail(`Unknown argument "${arg}".\n${USAGE}`);
    }
  }
  if (!STACK_ENVS.includes(env ?? '')) fail(USAGE);

  // --- read .env.<env> for Twilio creds (+ optional secret / app host) ---------
  const envFileName = `.env.${env}`;
  const envFile = path.join(repoRoot, envFileName);
  if (!existsSync(envFile)) fail(`[twilio:events] ${envFileName} not found at the repo root.`);

  let entries;
  try {
    entries = parseDotenv(readFileSync(envFile, 'utf8'));
  } catch (err) {
    fail(`[twilio:events] ${envFileName} is not valid dotenv - ${err.message}`);
  }

  const accountSid = entries.TWILIO_ACCOUNT_SID;
  const authToken = entries.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    fail(`[twilio:events] ${envFileName} must define TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.`);
  }

  // App host: --app-host / TWILIO_EVENTS_APP_HOST / host of PUBLIC_BASE_URL.
  let appHost = (appHostArg ?? process.env.TWILIO_EVENTS_APP_HOST ?? '').trim();
  if (!appHost) {
    const pub = (entries.PUBLIC_BASE_URL ?? '').trim();
    if (pub) {
      try {
        appHost = new URL(pub).host;
      } catch {
        // fall through to the explicit error below
      }
    }
  }
  appHost = appHost.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!appHost) {
    fail(
      `[twilio:events] no app host - pass --app-host <host> or set PUBLIC_BASE_URL ` +
        `in ${envFileName} (e.g. dev.app.housingchoice.org). A wrong host makes ` +
        `every event POST 404 / land on the wrong stack, so this never guesses.`,
    );
  }

  const webhookUser = (webhookUserArg ?? process.env.TWILIO_EVENTS_WEBHOOK_USER ?? 'twilio-events').trim();
  const secret = (process.env.TWILIO_EVENTS_WEBHOOK_SECRET_OVERRIDE ?? entries.TWILIO_EVENTS_WEBHOOK_SECRET ?? '').trim();

  const typesRaw = (process.env.TWILIO_EVENTS_TYPES ?? '').trim();
  const eventTypes = typesRaw
    ? typesRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_TYPES;
  const schemaVersion = Number.parseInt(process.env.TWILIO_EVENTS_SCHEMA_VERSION ?? '1', 10) || 1;

  const description = `hc-${env}-relay-events`;
  const publicEndpoint = `https://${appHost}${WEBHOOK_PATH}`;
  const displayUrl = `https://${webhookUser}:***@${appHost}${WEBHOOK_PATH}`;
  const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  // --- Twilio REST helpers (Account SID + Auth Token basic auth) ---------------
  /** Call the Event Streams API; returns parsed JSON or throws the Twilio error.
   * `form` may be a plain object OR a URLSearchParams (repeated Types params). */
  async function twilio(method, url, form) {
    const init = { method, headers: { Authorization: authHeader, Connection: 'close' } };
    if (form) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString();
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      fail(`[twilio:events] network error calling Twilio (${method} ${url}): ${err.message}`);
    }
    if (method === 'DELETE' && (res.status === 204 || res.status === 404)) return {};
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const code = body.code ? ` code=${body.code}` : '';
      const detail = body.message ?? body.raw ?? res.statusText;
      fail(`[twilio:events] Twilio ${method} ${url} -> ${res.status}${code}: ${detail}`);
    }
    return body;
  }

  /** Page a list endpoint, returning the first item matching predicate, or null. */
  async function findByDescription(resource, key) {
    let url = `${EVENTS_BASE}/${resource}?PageSize=50`;
    while (url) {
      const page = await twilio('GET', url);
      const hit = (page[key] ?? []).find((item) => item.description === description);
      if (hit) return hit;
      const next = page.meta?.next_page_url;
      url = next && next !== 'null' ? next : null;
    }
    return null;
  }

  const findSink = () => findByDescription('Sinks', 'sinks');
  const findSubscription = () => findByDescription('Subscriptions', 'subscriptions');

  /** Compare two destination URLs by host + path only (Twilio may redact the
   * user-info secret in the returned sink_configuration, so never compare it). */
  function sameEndpoint(a, b) {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      return ua.host === ub.host && ua.pathname === ub.pathname;
    } catch {
      return false;
    }
  }

  console.error(`[twilio:events] env=${env}  description=${description}`);
  console.error(`[twilio:events] desired sink destination: POST ${displayUrl}`);
  console.error(`[twilio:events] desired subscription: ${eventTypes.length} type(s) @ schema v${schemaVersion}`);

  // --- destroy -----------------------------------------------------------------
  if (destroy) {
    const sub = await findSubscription();
    if (sub) {
      await twilio('DELETE', `${EVENTS_BASE}/Subscriptions/${sub.sid}`);
      console.error(`[twilio:events] deleted subscription ${sub.sid}.`);
    } else {
      console.error('[twilio:events] no subscription to delete (already absent).');
    }
    const sink = await findSink();
    if (sink) {
      await twilio('DELETE', `${EVENTS_BASE}/Sinks/${sink.sid}`);
      console.error(`[twilio:events] deleted sink ${sink.sid}.`);
    } else {
      console.error('[twilio:events] no sink to delete (already absent).');
    }
    console.error('[twilio:events] destroy complete.');
    return 0;
  }

  // A create needs the shared secret (an unauthenticated sink defeats decision
  // D4's Basic-auth defense-in-depth; the app enforces it only when set).
  if (!secret) {
    const where = process.env.TWILIO_EVENTS_WEBHOOK_SECRET_OVERRIDE !== undefined
      ? 'the twilio-events module webhook_secret var'
      : `TWILIO_EVENTS_WEBHOOK_SECRET in ${envFileName}`;
    fail(
      `[twilio:events] no webhook secret - set ${where}. It MUST equal the app's ` +
        `TWILIO_EVENTS_WEBHOOK_SECRET (deploy it with secrets:push FIRST, so the ` +
        `sink validates). Use a URL-safe (alphanumeric) value.`,
    );
  }
  const destinationUrl = `https://${encodeURIComponent(webhookUser)}:${encodeURIComponent(secret)}@${appHost}${WEBHOOK_PATH}`;
  console.error(`[twilio:events] using webhook secret ${maskValue(secret)} (never sent to logs in full).`);

  // --- 1. Sink (webhook) -------------------------------------------------------
  let sink = await findSink();
  if (sink) {
    // sink_configuration may come back as an object OR a JSON string - parse
    // defensively so an in-sync sink is never misread as drift.
    let cfg = sink.sink_configuration;
    if (typeof cfg === 'string') {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = {};
      }
    }
    const currentDest = cfg?.destination ?? '';
    const inSync = sameEndpoint(currentDest, publicEndpoint);
    console.error(
      `[twilio:events] found sink ${sink.sid} (status=${sink.status ?? '?'}, ` +
        `endpoint ${inSync ? 'in sync' : 'DRIFTED'}).`,
    );
    if (!inSync) {
      console.error(
        `[twilio:events] sink destination endpoint DRIFT: have host/path of ` +
          `[${currentDest || '(none)'}], want [${publicEndpoint}]. The webhook Sink ` +
          `configuration is IMMUTABLE - delete this sink (Twilio console or ` +
          `--destroy) and re-run, or let Terraform replace the module resource.`,
      );
      if (checkOnly) return 2;
      fail('[twilio:events] refusing to duplicate a drifted sink - see the message above.');
    }
  } else if (checkOnly) {
    console.error(`[twilio:events] --check: no sink named ${description} yet - re-run without --check to create it.`);
    return 2;
  } else {
    const sinkConfiguration = JSON.stringify({ destination: destinationUrl, method: 'POST', batch_events: true });
    sink = await twilio('POST', `${EVENTS_BASE}/Sinks`, {
      Description: description,
      SinkType: 'webhook',
      SinkConfiguration: sinkConfiguration,
    });
    console.error(`[twilio:events] created sink ${sink.sid} (status=${sink.status ?? '?'}).`);
    console.error(
      `[twilio:events] Twilio validates a new webhook sink by POSTing to the ` +
        `destination - the app must be deployed with the matching secret and ` +
        `return 200 for the sink to reach status=active.`,
    );
  }

  // --- 2. Subscription (bind the Sink to the compliance event types) -----------
  let sub = await findSubscription();
  if (sub) {
    const boundToSink = sub.sink_sid === sink.sid;
    console.error(
      `[twilio:events] found subscription ${sub.sid} (sink_sid=${sub.sink_sid ?? '?'}, ` +
        `${boundToSink ? 'bound to our sink' : 'bound to a DIFFERENT sink'}).`,
    );
    if (!boundToSink) {
      console.error(
        `[twilio:events] subscription DRIFT: it points at ${sub.sink_sid}, not our ` +
          `sink ${sink.sid}. Delete it (--destroy) and re-run, or let Terraform ` +
          `replace the module resource.`,
      );
      if (checkOnly) return 2;
      fail('[twilio:events] refusing to mutate a drifted subscription - see the message above.');
    }
    console.error(
      `[twilio:events] subscription exists and is bound to our sink. NOTE: this ` +
        `script does not diff the subscribed type list - to change the type set, ` +
        `--destroy and re-run (or edit in the Twilio console).`,
    );
  } else if (checkOnly) {
    console.error(`[twilio:events] --check: no subscription named ${description} yet - re-run without --check to create it.`);
    return 2;
  } else {
    const form = new URLSearchParams();
    form.set('Description', description);
    form.set('SinkSid', sink.sid);
    for (const type of eventTypes) {
      form.append('Types', JSON.stringify({ type, schema_version: schemaVersion }));
    }
    sub = await twilio('POST', `${EVENTS_BASE}/Subscriptions`, form);
    console.error(`[twilio:events] created subscription ${sub.sid} -> sink ${sink.sid} (${eventTypes.length} type(s)).`);
  }

  console.error('[twilio:events] done.');
  console.error(
    `[twilio:events] VERIFY: warm a number (RELAY_LIVE_PROVISIONING on) and watch ` +
      `for the number-registration.successful event promoting it warming -> active, ` +
      `or check the Twilio Console Event Streams delivery logs for ${description}.`,
  );
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
