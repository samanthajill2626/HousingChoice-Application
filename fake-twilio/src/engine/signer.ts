// fake-twilio/src/engine/signer.ts
import { createHmac } from 'node:crypto';

export type WebhookParams = Record<string, string>;

/** How the carrier-group envelope is laid out on the wire (group-texting 5.1).
 *  `indexed` is the shape the live spike observed (OtherRecipients0..N);
 *  `single` is the undocumented bare `OtherRecipients` the app's parser accepts
 *  defensively, and can only ever carry ONE address (a repeated form key is an
 *  ARRAY, which a Record<string,string> param set cannot express). */
export type OtherRecipientsShape = 'indexed' | 'single';

export interface BuildInboundSmsInput {
  messageSid: string;
  from: string;
  to: string;
  body?: string;
  mediaUrls?: string[];
  optOutType?: string;
  /** The OTHER handsets on a carrier group text. Absent = an ordinary 1:1. */
  otherRecipients?: string[];
  /** Defaults to `indexed`. */
  otherRecipientsShape?: OtherRecipientsShape;
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
  if (path.endsWith('.pdf')) return 'application/pdf';
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
  // The carrier-group ENVELOPE. Undocumented by Twilio and proven only by the
  // live spike, so both observed layouts are producible: the app's parser is
  // gap-tolerant and reads BOTH, and a spec must be able to exercise each.
  const others = input.otherRecipients ?? [];
  if (others.length > 0) {
    if ((input.otherRecipientsShape ?? 'indexed') === 'single') {
      // Single form: exactly one address under the bare key. Extra addresses
      // would need a repeated key, which this param shape cannot carry - so
      // producing a SHORT roster silently is refused rather than risked (a
      // short roster is a different conversationId, i.e. a forked thread).
      if (others.length > 1) {
        throw new Error(
          'buildInboundSmsParams: the single OtherRecipients shape carries exactly one address',
        );
      }
      params['OtherRecipients'] = others[0]!;
    } else {
      others.forEach((address, i) => {
        params[`OtherRecipients${i}`] = address;
      });
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Twilio Conversations webhook params (group-texting spec 7/16)
// ---------------------------------------------------------------------------
//
// ONE service-scoped webhook carries BOTH filters (spec 16.1), so both builders
// target the same path and differ only by EventType. Field names and casing are
// the ones captured LIVE on the dev account (spike addendum) and pinned in
// app/test/groupConversationsWebhook.test.ts - notably `Status` (not
// `DeliveryStatus`) on the receipt.

export interface BuildConversationsDeliveryInput {
  conversationSid: string;
  messageSid: string;
  participantSid: string;
  /** RAW Conversations status: sent | delivered | undelivered | failed | read. */
  status: string;
  errorCode?: string;
  /** The per-member carrier SID (SMxx) - the receipts path's second join key. */
  channelMessageSid?: string;
  chatServiceSid?: string;
  dateCreated?: string;
}

export function buildConversationsDeliveryParams(
  input: BuildConversationsDeliveryInput,
): WebhookParams {
  const params: WebhookParams = {
    AccountSid: FAKE_ACCOUNT_SID,
    ChatServiceSid: input.chatServiceSid ?? FAKE_CHAT_SERVICE_SID,
    ConversationSid: input.conversationSid,
    DateCreated: input.dateCreated ?? new Date().toISOString(),
    EventType: 'onDeliveryUpdated',
    MessageSid: input.messageSid,
    ParticipantSid: input.participantSid,
    RetryCount: '0',
    Status: input.status,
  };
  if (input.errorCode !== undefined) params['ErrorCode'] = input.errorCode;
  if (input.channelMessageSid !== undefined) params['ChannelMessageSid'] = input.channelMessageSid;
  return params;
}

export interface BuildConversationsMessageAddedInput {
  conversationSid: string;
  messageSid: string;
  participantSid?: string;
  author?: string;
  body?: string;
  index?: number;
  /** `SMS` = carrier-sourced (what the cross-check counts); `API` = our own post. */
  source?: string;
  chatServiceSid?: string;
  messagingServiceSid?: string;
  dateCreated?: string;
}

export function buildConversationsMessageAddedParams(
  input: BuildConversationsMessageAddedInput,
): WebhookParams {
  const params: WebhookParams = {
    AccountSid: FAKE_ACCOUNT_SID,
    Attributes: '{}',
    ChatServiceSid: input.chatServiceSid ?? FAKE_CHAT_SERVICE_SID,
    ConversationSid: input.conversationSid,
    DateCreated: input.dateCreated ?? new Date().toISOString(),
    EventType: 'onMessageAdded',
    Index: String(input.index ?? 0),
    MessageSid: input.messageSid,
    MessagingServiceSid: input.messagingServiceSid ?? FAKE_MESSAGING_SERVICE_SID,
    RetryCount: '0',
    Source: input.source ?? 'SMS',
  };
  if (input.author !== undefined) params['Author'] = input.author;
  if (input.body !== undefined) params['Body'] = input.body;
  if (input.participantSid !== undefined) params['ParticipantSid'] = input.participantSid;
  return params;
}

/** Cosmetic account/service SIDs stamped on Conversations webhooks. Nothing in
 *  the app correlates on them (the join keys are CH/IM/MB), but the real events
 *  carry them and a shape-faithful fake is the whole point. */
const FAKE_ACCOUNT_SID = 'ACfake000000000000000000000000000';

/** NO LONGER PURELY COSMETIC. When the app pins TWILIO_CONVERSATIONS_SERVICE_SID
 *  it REJECTS Conversations events whose ChatServiceSid differs (the cross-env
 *  fence in routes/webhooks/twilioConversations.ts), so the two sides have to
 *  agree. The fake process inherits the lane's childEnv, so reading the same var
 *  the app reads keeps them aligned automatically - the TWILIO_VI_SERVICE_SID
 *  pattern. Falls back to the literal when unset (the app's fence is inactive
 *  then, so any value passes). */
const FAKE_CHAT_SERVICE_SID =
  process.env['TWILIO_CONVERSATIONS_SERVICE_SID']?.trim() || 'ISfake000000000000000000000000000';
const FAKE_MESSAGING_SERVICE_SID = 'MGfake000000000000000000000000000';

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

export interface SignJsonInput {
  authToken: string;
  /** The exact URL the app reconstructs, INCLUDING the `?bodySHA256=<sha256hex(rawBody)>`
   *  query the JSON-webhook scheme carries: `${appPublicBaseUrl}${path}?bodySHA256=...`. */
  url: string;
}

/**
 * Compute X-Twilio-Signature for a JSON-bodied webhook (the Voice Intelligence
 * completion callback). Twilio's bodySHA256 scheme signs the FULL URL - which
 * carries a `?bodySHA256=<sha256hex(rawBody)>` query param - with NO form params:
 * base64(HMAC-SHA1(authToken, url)). This is signTwilioWebhook with empty params,
 * kept as a named sibling so the JSON path reads clearly. The app validates it via
 * twilio.validateRequestWithBody (validateRequest with {} params + a bodySHA256
 * hash check over the raw body) - voiceSigner.test.ts pins that agreement.
 */
export function signTwilioJsonWebhook(input: SignJsonInput): string {
  return createHmac('sha1', input.authToken).update(Buffer.from(input.url, 'utf-8')).digest('base64');
}

export interface BuildInboundVoiceInput { callSid: string; from: string; to: string; callStatus?: string; }
export function buildInboundVoiceParams(i: BuildInboundVoiceInput): WebhookParams {
  return { CallSid: i.callSid, From: i.from, To: i.to, CallStatus: i.callStatus ?? 'ringing', ApiVersion: '2010-04-01' };
}
export function buildWhisperGateParams(i: { callSid: string; digits: string }): WebhookParams {
  return { CallSid: i.callSid, Digits: i.digits, ApiVersion: '2010-04-01' };
}
export function buildDialStatusParams(i: { callSid: string; dialCallStatus: string; dialCallDuration?: number }): WebhookParams {
  return { CallSid: i.callSid, DialCallStatus: i.dialCallStatus, ...(i.dialCallDuration !== undefined && { DialCallDuration: String(i.dialCallDuration) }), ApiVersion: '2010-04-01' };
}
export function buildRecordingParams(i: { callSid: string; recordingSid: string; recordingUrl: string; durationSec?: number; status?: string }): WebhookParams {
  return { CallSid: i.callSid, RecordingSid: i.recordingSid, RecordingStatus: i.status ?? 'completed', RecordingUrl: i.recordingUrl, ...(i.durationSec !== undefined && { RecordingDuration: String(i.durationSec) }), ApiVersion: '2010-04-01' };
}
