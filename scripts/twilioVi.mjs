// Twilio Voice Intelligence service - idempotent create-or-reconcile. Powers:
//   npm run twilio:vi -- <dev|prod> [--webhook-base <url>] [--check]
//
// WHY THIS SCRIPT EXISTS (and why it is not Terraform): Twilio's first-party
// Terraform provider is deprecated/archived, and this is the ONLY Twilio
// resource we would manage as code today - everything else Twilio (numbers,
// Messaging Service, voice webhooks, A2P) is console-managed. A single
// idempotent operator script matches the repo's existing pattern
// (vapidKeys.mjs, bootstrap.mjs) without a third-party provider or split-brain
// state. We DO want to move ALL Twilio config into IaC eventually - tracked in
// docs/issues/twilio-config-into-terraform.md; retire this script then.
//
// WHAT IT DOES: ensures a Voice Intelligence Service named
// hc-<env>-voice-transcription exists with our completion webhook wired, and
// prints its GAxxxx sid. Safe to re-run: an existing service is REUSED (its
// uniqueName/languageCode are immutable) and only a drifted webhook URL/method
// is reconciled. It creates NOTHING we do not use - no operators, no capture
// rules, no Conversation Orchestrator, and autoTranscribe stays OFF (the app
// creates one transcript per recording via the Transcripts API; auto-transcribe
// would double-transcribe every account recording).
//
// TEMPLATE-FIRST (same rule as vapidKeys.mjs): this script does NOT write
// .env.<env>. It prints `TWILIO_VI_SERVICE_SID=GA...` to stdout for the
// operator to paste into .env.<env> (gitignored), then:
//   npm run secrets:push -- <env>     # lands it in Parameter Store
//   npm run deploy:<env>              # hydrates it onto the instance
// Leaving TWILIO_VI_SERVICE_SID unset keeps transcription OFF for that env
// (recordings + voicemail still work). No AWS is touched, so no account guard.
//
// --check is READ-ONLY: it reports the current service + any webhook drift and
// writes nothing (exit 0 in-sync/creatable, 2 drift, 1 error).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STACK_ENVS } from './lib/hcAws.mjs';
import { parseDotenv } from './lib/secretsCore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node scripts/twilioVi.mjs <dev|prod> [--webhook-base <url>] [--check]
  (via npm: npm run twilio:vi -- dev)
  Ensures the hc-<env>-voice-transcription Voice Intelligence service exists with
  our completion webhook wired, and prints its GAxxxx sid (create-or-reconcile).
  --webhook-base <url>  base for the completion webhook (default: PUBLIC_BASE_URL
                        from .env.<env>). Full URL is <base>/webhooks/twilio/voice/intelligence.
  --check               read-only: report state + drift, write nothing (exit 2 on drift)`;

const WEBHOOK_PATH = '/webhooks/twilio/voice/intelligence';
const INTELLIGENCE_BASE = 'https://intelligence.twilio.com/v2';

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

async function main() {
  // --- argv --------------------------------------------------------------------
  const args = process.argv.slice(2);
  const env = args.shift();
  if (!STACK_ENVS.includes(env ?? '')) fail(USAGE);

  let checkOnly = false;
  let webhookBase;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--check') {
      checkOnly = true;
    } else if (arg === '--webhook-base') {
      webhookBase = args.shift();
      if (!webhookBase) fail(`--webhook-base needs a URL.\n${USAGE}`);
    } else {
      fail(`Unknown argument "${arg}".\n${USAGE}`);
    }
  }

  // --- read .env.<env> for Twilio creds + (optionally) the webhook base --------
  const envFileName = `.env.${env}`;
  const envFile = path.join(repoRoot, envFileName);
  if (!existsSync(envFile)) fail(`[twilio:vi] ${envFileName} not found at the repo root.`);

  let entries;
  try {
    entries = parseDotenv(readFileSync(envFile, 'utf8'));
  } catch (err) {
    fail(`[twilio:vi] ${envFileName} is not valid dotenv - ${err.message}`);
  }

  const accountSid = entries.TWILIO_ACCOUNT_SID;
  const authToken = entries.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    fail(`[twilio:vi] ${envFileName} must define TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.`);
  }

  const wbBase = (webhookBase ?? entries.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!wbBase) {
    fail(
      `[twilio:vi] no webhook base - set PUBLIC_BASE_URL in ${envFileName} or pass ` +
        `--webhook-base <url> (e.g. https://dev.app.housingchoice.org). A wrong base ` +
        `makes every completion webhook fail signature validation, so this never guesses.`,
    );
  }
  let webhookUrl;
  try {
    // CONCATENATE, do not URL-resolve: new URL('/abs/path', base) DISCARDS the
    // base's own path segments, so a --webhook-base ending in /nowhere silently
    // produced the canonical URL and reported "in sync" (bit us 2026-07-20 when
    // deliberately mis-pointing the webhook to exercise the reconcile fallback).
    // Concat preserves any base path; new URL() then just validates/normalizes.
    webhookUrl = new URL(`${wbBase}${WEBHOOK_PATH}`).toString();
  } catch {
    fail(`[twilio:vi] webhook base "${wbBase}" is not a valid URL.`);
  }

  const uniqueName = `hc-${env}-voice-transcription`;
  const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  // --- Twilio REST helpers (Account SID + Auth Token basic auth) ---------------
  /** GET/POST the Intelligence API; returns parsed JSON or throws the Twilio error. */
  async function twilio(method, url, form) {
    // Connection: close - no keep-alive socket lingers after the response, so the
    // event loop drains and the process exits promptly with the right code.
    const init = { method, headers: { Authorization: authHeader, Connection: 'close' } };
    if (form) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(form).toString();
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      fail(`[twilio:vi] network error calling Twilio (${method} ${url}): ${err.message}`);
    }
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
      fail(`[twilio:vi] Twilio ${method} ${url} -> ${res.status}${code}: ${detail}`);
    }
    return body;
  }

  /** Find our service by uniqueName, paging through the list. Returns it or null. */
  async function findService() {
    let url = `${INTELLIGENCE_BASE}/Services?PageSize=50`;
    while (url) {
      const page = await twilio('GET', url);
      const hit = (page.services ?? []).find((s) => s.unique_name === uniqueName);
      if (hit) return hit;
      const next = page.meta?.next_page_url;
      url = next && next !== 'null' ? next : null;
    }
    return null;
  }

  /** Emit the pasteable sid line (stdout) + operator next-steps (stderr).
   * The push/deploy steps apply ONLY when the sid is not yet in .env.<env> -
   * webhook changes live on the Twilio service and are effective immediately,
   * with nothing app-side to push (a real operator confusion, 2026-07-20). */
  function report(sid) {
    console.error('');
    if (entries.TWILIO_VI_SERVICE_SID === sid) {
      console.error(
        `[twilio:vi] ${envFileName} already carries this sid. Twilio-side changes ` +
          `(webhook URL) are live immediately - NO secrets:push / deploy needed.`,
      );
    } else {
      console.error(`Paste this into .env.${env} (gitignored), then:`);
      console.error(`  npm run secrets:push -- ${env}     # lands it in Parameter Store`);
      console.error(`  npm run deploy:${env}              # hydrates it onto the instance`);
    }
    console.log(`TWILIO_VI_SERVICE_SID=${sid}`);
  }

  // --- 1. locate ---------------------------------------------------------------
  console.error(`[twilio:vi] env=${env}  service uniqueName=${uniqueName}`);
  console.error(`[twilio:vi] desired webhook: POST ${webhookUrl}`);
  const existing = await findService();

  // --- 2. reconcile or create --------------------------------------------------
  if (existing) {
    console.error(`[twilio:vi] found existing service ${existing.sid} (language=${existing.language_code})`);
    if (existing.auto_transcribe === true) {
      console.error(
        `[twilio:vi] WARNING: this service has auto_transcribe=ON - it will double-transcribe ` +
          `every account recording alongside our per-recording creates. Turn it OFF in the console.`,
      );
    }
    const webhookDrift =
      existing.webhook_url !== webhookUrl ||
      (existing.webhook_http_method ?? 'POST').toUpperCase() !== 'POST';
    if (!webhookDrift) {
      console.error('[twilio:vi] webhook already in sync - nothing to reconcile.');
      report(existing.sid);
      return 0;
    }
    console.error(
      `[twilio:vi] webhook DRIFT: have [${existing.webhook_http_method ?? '(none)'} ` +
        `${existing.webhook_url ?? '(none)'}], want [POST ${webhookUrl}].`,
    );
    if (checkOnly) {
      console.error('[twilio:vi] --check: not reconciling. Re-run without --check to fix.');
      return 2;
    }
    await twilio('POST', `${INTELLIGENCE_BASE}/Services/${existing.sid}`, {
      WebhookUrl: webhookUrl,
      WebhookHttpMethod: 'POST',
    });
    console.error('[twilio:vi] webhook reconciled.');
    report(existing.sid);
    return 0;
  }

  // Not found.
  if (checkOnly) {
    console.error(`[twilio:vi] --check: no service named ${uniqueName} yet - re-run without --check to create it.`);
    return 2;
  }
  console.error('[twilio:vi] creating service (autoTranscribe OFF, en-US, no operators/capture)...');
  const created = await twilio('POST', `${INTELLIGENCE_BASE}/Services`, {
    UniqueName: uniqueName,
    FriendlyName: `HousingChoice ${env} voice transcription`,
    LanguageCode: 'en-US',
    AutoTranscribe: 'false',
    WebhookUrl: webhookUrl,
    WebhookHttpMethod: 'POST',
  });
  console.error(`[twilio:vi] created service ${created.sid}.`);
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
