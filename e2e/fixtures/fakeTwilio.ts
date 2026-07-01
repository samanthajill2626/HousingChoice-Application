import { createHmac } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

// Control-plane helpers for the fake-twilio host (:8889). `send-as-party` makes the
// fake emit a REAL-signed inbound webhook to the app (exercising the signature
// middleware + inbound pipeline); `threads` is the proof-of-send surface for
// outbound replies + their delivery state. (Restored for the new-dashboard comms
// e2e after the legacy-only specs were removed in 40bd4f0; the control API is
// unchanged.)
const FAKE_BASE = process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889';

// --- Direct inbound webhook (test-support only, for TwiML-reply assertions) ---
//
// The fake's `send-as-party` fires a signed inbound /sms webhook at the app but
// DISCARDS the response body (it only checks the status). The A2P keyword replies
// (STOP/HELP/opt-in) are returned by the webhook as TwiML `<Message>` in that
// response body — NOT as an outbound thread message the fake records — so to
// assert them we must POST the inbound webhook OURSELVES and read the TwiML back.
//
// This mirrors the fake's own signer (fake-twilio/src/engine/signer.ts) +
// dispatcher exactly: HMAC-SHA1(authToken, signedUrl + sorted key/value params),
// base64; POST form-encoded to the app's REAL address while SIGNING against the
// app's PUBLIC_BASE_URL (what its signature middleware reconstructs). The hermetic
// launcher's deterministic defaults are used when the values aren't in the Playwright
// process env (scripts/e2e-session.mjs sets the same fallbacks on the app + fake).
const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:8080';
const APP_PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? 'hermetic-shared-twilio-token';
const ORIGIN_SECRET = process.env.CF_ORIGIN_SECRET ?? 'dev-placeholder-not-a-secret';
/** The app number the fake uses as OUR_PHONE_NUMBERS (send-as-party's default `to`). */
export const APP_NUMBER = process.env.OUR_PHONE_NUMBERS?.split(',')[0] ?? '+15550009999';

/** Sign X-Twilio-Signature exactly as Twilio does (matches signer.ts): URL, then
 *  each POST param key+value sorted by key, HMAC-SHA1 with the auth token, base64. */
function signTwilio(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  return createHmac('sha1', TWILIO_AUTH_TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/**
 * POST a signed inbound SMS webhook DIRECTLY to the app and return the raw TwiML
 * response body — the mechanism for asserting the A2P keyword replies (the webhook
 * answers a matched STOP/HELP/opt-in keyword with a TwiML `<Message>`, which the
 * fake's send-as-party would otherwise swallow). `messageSid` MUST be unique per
 * call (the inbound is deduped by SID). Returns `{ status, body }`.
 */
export async function postInboundSms(
  request: APIRequestContext,
  input: { from: string; body: string; messageSid: string; to?: string },
): Promise<{ status: number; body: string }> {
  const params: Record<string, string> = {
    MessageSid: input.messageSid,
    From: input.from,
    To: input.to ?? APP_NUMBER,
    Body: input.body,
    SmsStatus: 'received',
    ApiVersion: '2010-04-01',
    NumMedia: '0',
  };
  const path = '/webhooks/twilio/sms';
  const signature = signTwilio(`${APP_PUBLIC_BASE_URL}${path}`, params);
  const res = await request.post(`${APP_URL}${path}`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
      'x-origin-verify': ORIGIN_SECRET,
    },
    form: params,
  });
  return { status: res.status(), body: await res.text() };
}

/** XML-unescape a TwiML text node (the webhook XML-escapes filed copy: & < > " ').
 *  Reverses `escapeXml` in app/src/routes/webhooks/twilio.ts so a filed constant
 *  with raw `&`/`'` (e.g. "Msg & data", "You're") compares equal to the reply. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Extract the (XML-unescaped) `<Message>` reply body from a TwiML response, or
 *  `undefined` when the response is the empty `<Response/>` ack (no keyword reply). */
export function twimlMessageBody(twiml: string): string | undefined {
  const m = twiml.match(/<Message>([\s\S]*?)<\/Message>/);
  return m ? unescapeXml(m[1]!) : undefined;
}

export interface FakeThread {
  partyNumber: string;
  messages: Array<{
    sid: string;
    direction: 'inbound' | 'outbound';
    body?: string;
    state: string;
    mediaUrls?: string[];
  }>;
}

/**
 * Register an ad-hoc party persona on the fake. `send-as-party` REJECTS an
 * unregistered `from` number (`{"error":"unknown party number"}`), so a scenario
 * using a fresh, per-run-unique tenant number must register it first. Idempotent
 * from the caller's view: a duplicate registration (the fake 409s "already exists")
 * is swallowed so a tenant who calls-then-texts registers exactly once safely.
 */
export async function registerParty(
  request: APIRequestContext,
  input: { label: string; role: 'tenant' | 'landlord' | 'pm' | 'staff'; number: string },
): Promise<void> {
  const res = await request.post(`${FAKE_BASE}/control/personas/ad-hoc`, { data: input });
  if (!res.ok() && res.status() !== 409) {
    const body = await res.text();
    if (!/already exists/i.test(body)) {
      throw new Error(`register-party failed: ${res.status()} ${body}`);
    }
  }
}

export async function sendAsParty(
  request: APIRequestContext,
  input: { from: string; body?: string; to?: string; mediaUrls?: string[] },
): Promise<string> {
  const res = await request.post(`${FAKE_BASE}/control/send-as-party`, { data: input });
  if (!res.ok()) throw new Error(`send-as-party failed: ${res.status()}`);
  return (await res.json()).sid as string;
}

export async function listThreads(request: APIRequestContext): Promise<FakeThread[]> {
  const res = await request.get(`${FAKE_BASE}/control/threads`);
  if (!res.ok()) throw new Error(`threads failed: ${res.status()}`);
  return (await res.json()).threads as FakeThread[];
}

export async function resetFake(request: APIRequestContext): Promise<void> {
  await request.post(`${FAKE_BASE}/control/reset`, { data: {} });
}
