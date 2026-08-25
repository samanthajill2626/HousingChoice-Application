import { createHmac } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { fakeUrl, appUrl, publicBaseUrl } from '../support/urls.js';

// Control-plane helpers for the fake-twilio host (:8889). `send-as-party` makes the
// fake emit a REAL-signed inbound webhook to the app (exercising the signature
// middleware + inbound pipeline); `threads` is the proof-of-send surface for
// outbound replies + their delivery state. (Restored for the new-dashboard comms
// e2e after the legacy-only specs were removed in 40bd4f0; the control API is
// unchanged.)
const FAKE_BASE = fakeUrl;

// --- Direct inbound webhook (test-support only, for TwiML-reply assertions) ---
//
// The fake's `send-as-party` fires a signed inbound /sms webhook at the app but
// DISCARDS the response body (it only checks the status). Asserting what the app
// answers an inbound with therefore means POSTing the inbound webhook OURSELVES and
// reading the TwiML back. Since 2026-08-12 the app answers EVERY inbound - keywords
// included - with the empty `<Response/>` ack (Twilio's Advanced Opt-Out owns the
// STOP/HELP/opt-in replies), so this helper's job is now proving the ABSENCE of a
// `<Message>` rather than its contents.
//
// This mirrors the fake's own signer (fake-twilio/src/engine/signer.ts) +
// dispatcher exactly: HMAC-SHA1(authToken, signedUrl + sorted key/value params),
// base64; POST form-encoded to the app's REAL address while SIGNING against the
// app's PUBLIC_BASE_URL (what its signature middleware reconstructs). The hermetic
// launcher's deterministic defaults are used when the values aren't in the Playwright
// process env (scripts/e2e-session.mjs sets the same fallbacks on the app + fake).
const APP_URL = appUrl;
const APP_PUBLIC_BASE_URL = publicBaseUrl;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? 'hermetic-shared-twilio-token';
const ORIGIN_SECRET = process.env.CF_ORIGIN_SECRET ?? 'dev-placeholder-not-a-secret';
/** The app number the fake uses as BUSINESS_PHONE_NUMBER (send-as-party's default
 *  `to`). The env read is a courtesy: the launcher sets the var on its spawned
 *  children only, never on the Playwright process, so the literal is the value
 *  that actually applies here. */
export const APP_NUMBER = process.env.BUSINESS_PHONE_NUMBER ?? '+15550009999';

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
 * response body - the mechanism for asserting what the webhook answers an inbound
 * with, which the fake's send-as-party would otherwise swallow. `messageSid` MUST be
 * unique per call (the inbound is deduped by SID). Returns `{ status, body }`.
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

/** XML-unescape a TwiML text node (& < > " ').
 *  Historically the reverse of the webhook's `escapeXml` (removed with the
 *  keyword-reply path, 2026-08-12); retained because voice TwiML and other
 *  XML-escaped fixtures still flow through the fake's assertions. */
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

export interface FakeThreadMessage {
  sid: string;
  direction: 'inbound' | 'outbound';
  /** Sender E.164 — the app/pool number for outbound, the party for inbound.
   *  Always on the wire (fake-twilio ThreadMessage); surfaced so tour-group
   *  assertions can prove a send came FROM the masked pool number. */
  from: string;
  /** Recipient E.164 — always on the wire (see `from`). */
  to: string;
  body?: string;
  state: string;
  mediaUrls?: string[];
  /** Twilio ErrorCode, present only once the message resolved to a failure state. */
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FakeThread {
  partyNumber: string;
  messages: FakeThreadMessage[];
}

/**
 * The proof-of-send read: every outbound message the app dispatched to `to`,
 * oldest-first, straight from the fake's thread store. The replacement for the
 * removed `/__dev/outbox` (`getOutbox`) — same `{ to, since }` ergonomics, same
 * `createdAt >= since` filter — but wire-level: it also sees TwiML auto-replies
 * and Conversations fan-out legs, which the app-side outbox was structurally
 * blind to, and each message carries its live delivery `state`.
 */
export async function getOutboundTo(
  request: APIRequestContext,
  opts: { to: string; since?: string },
): Promise<FakeThreadMessage[]> {
  const threads = await listThreads(request);
  const thread = threads.find((t) => t.partyNumber === opts.to);
  if (!thread) return [];
  return thread.messages.filter(
    (m) => m.direction === 'outbound' && (!opts.since || m.createdAt >= opts.since),
  );
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
  input: {
    from: string;
    body?: string;
    to?: string;
    mediaUrls?: string[];
    /**
     * Force the provider SID prefix. The fake otherwise derives it from media
     * presence alone, so `MM` with `NumMedia=0` - the group-texting TRIPWIRE
     * shape (adjudication A28) - has no other way to exist.
     */
    sidShape?: 'SM' | 'MM';
  },
): Promise<string> {
  const res = await request.post(`${FAKE_BASE}/control/send-as-party`, { data: input });
  if (!res.ok()) throw new Error(`send-as-party failed: ${res.status()}`);
  return (await res.json()).sid as string;
}

// --- Native carrier group texting (group-texting spec 5.1 / 7) --------------
//
// DISTINCT FROM `sendAsParty` + `to: <pool>`, which is a RELAY group leg. A
// carrier group text goes to the BUSINESS number like any 1:1 and is
// distinguished only by the undocumented `OtherRecipients` envelope. Everything
// here says "carrier group" so no helper reads ambiguously against relay.

export interface SendGroupAsPartyInput {
  from: string;
  /** The OTHER handsets on the thread. */
  otherRecipients: string[];
  body?: string;
  mediaUrls?: string[];
  /** `indexed` (the live shape, default) or `single` (the bare defensive key). */
  otherRecipientsShape?: 'indexed' | 'single';
  /** Force the provider SID prefix - the tripwire needs MM with NumMedia=0. */
  sidShape?: 'SM' | 'MM';
  /**
   * Set false to suppress the Conversations `onMessageAdded` the fake would
   * otherwise fire when the sender is on a rail. This is the ONLY way to
   * manufacture the guardrail's target failure: a classic inbound that the
   * Conversations channel never reported.
   */
  railEvent?: boolean;
}

/** Inject an inbound CARRIER group text. Returns the classic provider SID plus
 *  the rail ids when the roster already had a Conversations rail. */
export async function sendGroupAsParty(
  request: APIRequestContext,
  input: SendGroupAsPartyInput,
): Promise<{ sid: string; conversationSid?: string; conversationMessageSid?: string }> {
  const res = await request.post(`${FAKE_BASE}/control/send-group-as-party`, { data: input });
  if (!res.ok()) throw new Error(`send-group-as-party failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { sid: string; conversationSid?: string };
}

export interface FakeConversation {
  /** CHxx. */
  sid: string;
  /** Our conversationId. */
  uniqueName?: string;
  state: string;
  participants: { sid: string; address?: string; projectedAddress?: string }[];
  messages: {
    sid: string;
    author?: string;
    body?: string;
    index: number;
    source: 'API' | 'SMS';
    legs?: { participantSid: string; address: string; channelMessageSid: string; state: string }[];
  }[];
}

/** The rails the fake currently holds - the proof a thread got a Conversation. */
export async function listConversations(request: APIRequestContext): Promise<FakeConversation[]> {
  const res = await request.get(`${FAKE_BASE}/control/conversations`);
  if (!res.ok()) throw new Error(`conversations failed: ${res.status()}`);
  return (await res.json()).conversations as FakeConversation[];
}

/** Fire an `onMessageAdded` with NO classic counterpart - the guardrail's target
 *  failure, and the only way to produce it. `source: 'API'` exercises the
 *  cross-check's `Source === 'SMS'` filter for real. */
export async function injectConversationEvent(
  request: APIRequestContext,
  input: {
    conversationSid?: string;
    uniqueName?: string;
    author?: string;
    body?: string;
    source?: 'SMS' | 'API' | 'SDK';
    messageSid?: string;
  },
): Promise<{ messageSid: string; conversationSid: string }> {
  const res = await request.post(`${FAKE_BASE}/control/conversations/inject-event`, { data: input });
  if (!res.ok()) throw new Error(`inject-event failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { messageSid: string; conversationSid: string };
}

/**
 * CLOSE A RAIL the way Twilio does - its own auto-close timer, or an operator in
 * the console. A closed Conversation KEEPS its UniqueName and refuses every
 * post, which is exactly the state the app's closed-rail heal has to survive:
 * our UniqueName is the conversationId, so a naive retry re-adopts the same dead
 * resource forever (fix wave 4, H1). There is no other way to manufacture it.
 */
export async function setConversationState(
  request: APIRequestContext,
  input: { conversationSid?: string; uniqueName?: string; state?: 'closed' | 'active' | 'failed' },
): Promise<{ conversationSid: string; state: string }> {
  const res = await request.post(`${FAKE_BASE}/control/conversations/set-state`, { data: input });
  if (!res.ok()) throw new Error(`set-state failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { conversationSid: string; state: string };
}

/**
 * Arm the NEXT message to one handset with a delivery outcome. ONE control API
 * serves both a 1:1 send and a carrier-group leg, so this is also how a
 * per-member 21610 (a STOPped handset) is simulated on a group send.
 */
export async function setDeliveryOutcome(
  request: APIRequestContext,
  input: {
    partyNumber: string;
    profile: { kind: 'normal' | 'stall' | 'fail'; failState?: string; errorCode?: string };
  },
): Promise<void> {
  const res = await request.post(`${FAKE_BASE}/control/delivery-outcome`, { data: input });
  if (!res.ok()) throw new Error(`delivery-outcome failed: ${res.status()}`);
}

export async function listThreads(request: APIRequestContext): Promise<FakeThread[]> {
  const res = await request.get(`${FAKE_BASE}/control/threads`);
  if (!res.ok()) throw new Error(`threads failed: ${res.status()}`);
  return (await res.json()).threads as FakeThread[];
}

export async function resetFake(request: APIRequestContext): Promise<void> {
  await request.post(`${FAKE_BASE}/control/reset`, { data: {} });
}
