// fake-twilio/src/engine/signer.ts
import { createHmac } from 'node:crypto';

export type WebhookParams = Record<string, string>;

export interface BuildInboundSmsInput {
  messageSid: string;
  from: string;
  to: string;
  body?: string;
  mediaUrls?: string[];
  optOutType?: string;
}

/** Infer a Twilio-style MediaContentType from a media URL's file extension (FIX 7). */
function inferMediaContentType(url: string): string {
  const lower = url.toLowerCase();
  // Compare only the path, so a `?v=1` query or `#frag` doesn't defeat the suffix match.
  let path = lower;
  const q = path.search(/[?#]/);
  if (q !== -1) path = path.slice(0, q);
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

/** Build the application/x-www-form-urlencoded params Twilio sends for inbound SMS/MMS. */
export function buildInboundSmsParams(input: BuildInboundSmsInput): WebhookParams {
  const params: WebhookParams = {
    MessageSid: input.messageSid,
    From: input.from,
    To: input.to,
    SmsStatus: 'received',
    ApiVersion: '2010-04-01',
  };
  if (input.body !== undefined) params['Body'] = input.body;
  const media = input.mediaUrls ?? [];
  params['NumMedia'] = String(media.length);
  media.forEach((url, i) => {
    params[`MediaUrl${i}`] = url;
    params[`MediaContentType${i}`] = inferMediaContentType(url);
  });
  if (input.optOutType !== undefined) params['OptOutType'] = input.optOutType;
  return params;
}

export interface BuildStatusInput {
  messageSid: string;
  status: 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';
  errorCode?: string;
}

/** Build the params Twilio sends for a delivery status callback. */
export function buildStatusParams(input: BuildStatusInput): WebhookParams {
  const params: WebhookParams = {
    MessageSid: input.messageSid,
    MessageStatus: input.status,
    ApiVersion: '2010-04-01',
  };
  if (input.errorCode !== undefined) params['ErrorCode'] = input.errorCode;
  return params;
}

export interface SignInput {
  authToken: string;
  /** The exact URL the app reconstructs: `${PUBLIC_BASE_URL}${path}`. */
  url: string;
  params: WebhookParams;
}

/**
 * Compute X-Twilio-Signature exactly as Twilio does: start from the full URL,
 * append each POST param's key+value sorted by key, HMAC-SHA1 with the auth
 * token, base64. The signer.test.ts contract asserts twilio.validateRequest()
 * accepts the result — that is the real guarantee of correctness.
 */
export function signTwilioWebhook(input: SignInput): string {
  const sortedKeys = Object.keys(input.params).sort();
  let data = input.url;
  for (const key of sortedKeys) data += key + input.params[key];
  return createHmac('sha1', input.authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}
