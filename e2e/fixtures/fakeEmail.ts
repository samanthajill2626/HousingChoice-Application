// Email seam for e2e specs: thin wrappers over fake-twilio's fake-SES CONTROL API
// (fake-twilio/src/routes/sesControl.ts), the way fakeVoice.ts wraps the voice
// control API. `listEmails` reads what the app "sent" through the fake-SES REST
// surface; `resetMail` clears that store.
//
// Reset note: the SMS `/control/reset` (preflight + cleanSlate) does NOT touch the
// mail store - mail is a SEPARATE engine on a DISJOINT `/control/reset-mail` subpath
// (see sesControl.ts). Email specs call resetMail explicitly for a clean slate.
import type { APIRequestContext } from '@playwright/test';
import { fakeUrl } from '../support/urls.js';

const FAKE_BASE = fakeUrl;

/** One captured outbound email (fake-twilio StoredEmail). `rawMime` is the full
 *  decoded MIME the app POSTed; to/cc/subject/messageIdHeader are string-scanned
 *  from its top-level header block by the fake. */
export interface FakeEmail {
  sesMessageId: string;
  rawMime: string;
  to: string[];
  cc: string[];
  subject: string;
  messageIdHeader?: string;
  receivedAt: string;
  state: 'sent';
}

/** Every email the app has "sent" through the fake-SES surface, NEWEST FIRST. */
export async function listEmails(request: APIRequestContext): Promise<FakeEmail[]> {
  const res = await request.get(`${FAKE_BASE}/control/emails`);
  if (!res.ok()) throw new Error(`list emails failed: ${res.status()}`);
  return ((await res.json()) as { emails: FakeEmail[] }).emails;
}

/** Clear the fake-SES mail store (hermetic clean-slate for email specs). */
export async function resetMail(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${FAKE_BASE}/control/reset-mail`, { data: {} });
  if (!res.ok()) throw new Error(`reset-mail failed: ${res.status()} ${await res.text()}`);
}

/** One inbound attachment (base64) the fake wraps into the delivered MIME. */
export interface InboundAttachmentInput {
  filename: string;
  contentType: string;
  base64: string;
}

/** The control-plane inbound-send request (POST /control/send-inbound-email). */
export interface SendInboundEmailOpts {
  from: string;
  to?: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: InboundAttachmentInput[];
  spamVerdict?: 'PASS' | 'FAIL' | 'GRAY';
  virusVerdict?: 'PASS' | 'FAIL';
  /** Optional threading headers (reply-in-thread specs). */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

/** The fake's response after delivering one inbound email (email-channel B4). */
export interface SentInboundEmail {
  bucket: string;
  key: string;
  posted: boolean;
  /** The app webhook's response status to the SNS POST. */
  appStatus: number;
  sesMessageId: string;
}

/**
 * Deliver ONE inbound email (email-channel B4): the fake hand-rolls MIME, writes it
 * to MinIO INBOUND_MAIL_BUCKET, and POSTs an SNS-shaped receipt to the app's
 * /webhooks/ses/inbound (with x-origin-verify) - the whole prod inbound path minus
 * real SES. Returns the bucket/key + the app's response status.
 */
export async function sendInboundEmail(
  request: APIRequestContext,
  opts: SendInboundEmailOpts,
): Promise<SentInboundEmail> {
  const res = await request.post(`${FAKE_BASE}/control/send-inbound-email`, { data: opts });
  if (!res.ok()) throw new Error(`send-inbound-email failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as SentInboundEmail;
}

/** Every inbound email the fake delivered, NEWEST FIRST (test observability). */
export async function listInboundEmails(request: APIRequestContext): Promise<
  { key: string; bucket: string; from: string; to: string[]; subject: string; appStatus: number; receivedAt: string }[]
> {
  const res = await request.get(`${FAKE_BASE}/control/inbound-emails`);
  if (!res.ok()) throw new Error(`list inbound emails failed: ${res.status()}`);
  return (await res.json()).emails;
}

/** A simulated SES delivery/bounce/complaint outcome (email-channel B5). */
export interface EmailDeliveryOutcomeOpts {
  /** The SES MessageId the outbound send returned (read from the FakeEmail). */
  sesMessageId: string;
  outcome: 'delivered' | 'bounce' | 'complaint';
  /** Bounce only; defaults to 'Permanent' (which suppresses the address). */
  bounceType?: 'Permanent' | 'Transient';
}

/** The fake's response after posting one SES event (email-channel B5). */
export interface EmailDeliveryOutcomeResult {
  posted: boolean;
  /** The app webhook's response status to the SNS event POST (assert 200). */
  appStatus: number;
}

/**
 * Simulate a SES delivery/bounce/complaint EVENT for an already-sent message
 * (email-channel B5): the fake builds the SES event JSON wrapped in the SNS
 * envelope and POSTs it to the app's /webhooks/ses/inbound (with x-origin-verify)
 * - the whole prod event path minus real SES. A permanent Bounce lands
 * email_unreachable + fails the delivery chip; a Complaint lands email_opt_out.
 */
export async function emailDeliveryOutcome(
  request: APIRequestContext,
  opts: EmailDeliveryOutcomeOpts,
): Promise<EmailDeliveryOutcomeResult> {
  const res = await request.post(`${FAKE_BASE}/control/email-delivery-outcome`, { data: opts });
  if (!res.ok()) throw new Error(`email-delivery-outcome failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as EmailDeliveryOutcomeResult;
}
