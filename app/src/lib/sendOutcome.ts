// app/src/lib/sendOutcome.ts
// Send-outcome vocabulary (spec D1-D2, D10, D13a). Pure. Imports ONLY the
// adapter's error leaf, so adapters/messaging.ts may import these constants
// at module init without a cycle.
import { SmsSendingDisabledError } from '../adapters/messagingErrors.js';

export type SendFailureKind = 'rejected' | 'retryable' | 'unknown';
export interface SendFailureClassification {
  kind: SendFailureKind;
  code?: string;
  status?: number;
}

export const SEND_UNCONFIRMED_CODE = 'send_unconfirmed';
export const SEND_RETRYABLE_CODE = 'send_retryable';
export const REDRIVE_REFUSED_CODE = 'redrive_refused';
export const SMS_SENDING_DISABLED_CODE = 'sms_sending_disabled';
export const TRANSIENT_CAP_CODE = 'transient_cap';
export const ENQUEUE_FAILED_CODE = 'enqueue_failed';
/**
 * The send-attempt claim TTL (spec D8a). It EQUALS the provider request
 * timeout: adapters/messaging.ts pins TWILIO_REQUEST_TIMEOUT_MS to this value,
 * so a claim older than this can only belong to a dead or overrunning call.
 */
export const SEND_CLAIM_TTL_MS = 30_000;
export const RECONCILE_CHECK_DELAYS_MS: readonly number[] = [5_000, 30_000, 240_000];
export const RECONCILE_WINDOW_LEAD_MS = 60_000;
export const RECONCILE_LIST_PAGE_SIZE = 1000;
export const RECONCILE_MAX_PAGES = 5;
export const OUTAGE_BRAKE_UNKNOWN_STREAK = 3;

// Codes the send sites ALREADY recognize classify by code whatever the status
// says or omits (D1's one precedence rule), so the existing arms keep their
// behavior and their status-less test fixtures.
const KNOWN_REJECTED_CODES = new Set(['30007', '30005', '30006']);
const KNOWN_RETRYABLE_CODES = new Set(['429', '30022']);
// A connection that never opened: nothing reached the provider (D1).
const NETWORK_RETRYABLE = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);

/** A Twilio numeric code, safe to write into a slot's errorCode (D6). */
export function isProviderCode(code: string | undefined): boolean {
  return code !== undefined && /^[0-9]+$/.test(code);
}

// `0` is no code: twilio-node defaults a missing code to 0 on some paths.
function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && code !== 0) return String(code);
  if (typeof code === 'string' && code.length > 0 && code !== '0') return code;
  return undefined;
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * Classify one provider send failure (spec D1). Pure, no I/O. Precedence: a
 * recognized code first (30007 / 30005 / 30006 rejected; 429 / 30022
 * retryable); then the HTTP status (5xx unknown, 429 retryable, other 4xx
 * rejected - with or without a code); then the network code (a connection
 * that never opened is retryable); everything else, timeouts and dropped
 * sockets included, is unknown (D2: a wrong `unknown` costs one reconcile, a
 * wrong `rejected` invites a manual resend).
 */
export function classifySendFailure(err: unknown): SendFailureClassification {
  if (err instanceof SmsSendingDisabledError) return { kind: 'rejected', code: SMS_SENDING_DISABLED_CODE };
  const code = codeOf(err);
  const status = statusOf(err);
  const withMeta = (kind: SendFailureKind): SendFailureClassification => ({
    kind,
    ...(code !== undefined && { code }),
    ...(status !== undefined && { status }),
  });
  if (code !== undefined && KNOWN_REJECTED_CODES.has(code)) return withMeta('rejected');
  if (code !== undefined && KNOWN_RETRYABLE_CODES.has(code)) return withMeta('retryable');
  if (status !== undefined) {
    if (status >= 500) return withMeta('unknown');
    if (status === 429) return withMeta('retryable');
    if (status >= 400) return withMeta('rejected');
  }
  if (code !== undefined && NETWORK_RETRYABLE.has(code)) return withMeta('retryable');
  return withMeta('unknown');
}
