// messages repo — the append-only conversation log (doc §5).
//
// SK shape: `<ISO ts>#<msgId>` where ts is the PROVIDER's message timestamp
// (stable across Twilio redeliveries) and msgId is the provider SID — so the
// same provider message always computes the same key, and the conditional
// append makes redeliveries/echoes a no-op. This is the §7.1 MessageSid
// idempotency primitive: outbound messages persist at send time, so the
// webhook echo of our own send dedupes here instead of re-entering pipelines.
//
// SID→location pointer: every append also writes `{ PK: sid#<providerSid>,
// SK: ptr }` carrying conversationId + tsMsgId, in the SAME transaction —
// Twilio status callbacks identify messages by SID alone and recover context
// by lookup (doc §9). Pointer partitions (`sid#…`, and the `job#…` execution
// markers below) never collide with real conversation partitions, so
// listByConversation never sees them.
//
// PII: message bodies must NEVER be logged (doc §9) — IDs and lengths only.
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

export type MessageType = 'sms' | 'mms' | 'call' | 'email';
export type MessageDirection = 'inbound' | 'outbound';

/**
 * Voice call lifecycle (M1.9a, doc §7.1 masked calling). Mirrors Twilio's
 * CallStatus values verbatim so the status-callback mapping is identity. A
 * call entry is a metadata-only timeline item — masked calls are NEVER
 * recorded/transcribed (recording_s3_key/transcript stay UNPOPULATED here).
 */
export type CallStatus =
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'no-answer'
  | 'busy'
  | 'failed'
  | 'canceled';

/**
 * Coarse human-facing outcome derived from CallStatus + whether a leg
 * connected (M1.9a): `answered` (a leg picked up), `missed` (nobody answered /
 * busy / failed), `voicemail` (reserved — masked calls press-1-gate to block
 * carrier voicemail, so this is the founder-bridge seam, unused here).
 */
export type CallOutcome = 'answered' | 'missed' | 'voicemail';

/**
 * Transcript lifecycle status on a call entity (voice-transcription spec 3.7),
 * driving the in-flight "Transcribing..." indicator on the call bubble. ABSENT
 * when no transcript will ever be requested (masked calls, VI unconfigured,
 * pre-feature calls): 'pending' is stamped the moment a transcript WILL be
 * requested, 'completed' is stamped atomically by setCallTranscript, 'failed'
 * when the pipeline gives up. A late successful persist may upgrade
 * failed -> completed; completed is terminal.
 */
export type TranscriptStatus = 'pending' | 'completed' | 'failed';

/** Forward-only CallStatus progression: which prior statuses each may overwrite. */
const ALLOWED_PRIOR_CALL_STATUS: Record<CallStatus, CallStatus[]> = {
  // Non-terminal: ringing may only be the first write (nothing transitions INTO it).
  ringing: [],
  // in-progress (answered) can follow ringing.
  'in-progress': ['ringing'],
  // Terminal states may follow either non-terminal state; terminals never regress.
  completed: ['ringing', 'in-progress'],
  'no-answer': ['ringing', 'in-progress'],
  busy: ['ringing', 'in-progress'],
  failed: ['ringing', 'in-progress'],
  canceled: ['ringing', 'in-progress'],
};

export function allowedPriorCallStatuses(next: CallStatus): CallStatus[] {
  return ALLOWED_PRIOR_CALL_STATUS[next];
}
/**
 * Who authored the message (doc §5; `ai` is Phase 2). `unknown` is the
 * operator-mandated honesty value (deviations table 2026-06-12): inbound from
 * an unreviewed contact must not be recorded as a guessed `tenant` — it
 * resolves when the contact is typed in the M1.4/M1.5 review flows. `system`
 * is an app-authored relay announcement (relay intro / tour reminder rung —
 * services/relayAnnouncements.ts): no human wrote it, so neither `teammate`
 * nor `ai` would be honest.
 */
export type MessageAuthor = 'tenant' | 'landlord' | 'partner' | 'teammate' | 'ai' | 'unknown' | 'system';

/**
 * Outbound delivery status machine (doc §7.1):
 * queued → sent → delivered | undelivered | failed. Terminal states never
 * regress (a delivered message stays delivered).
 */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/** Statuses a given new status may overwrite — forward-only transitions. */
const ALLOWED_PRIOR: Record<DeliveryStatus, DeliveryStatus[]> = {
  queued: [],
  sent: ['queued'],
  delivered: ['queued', 'sent'],
  undelivered: ['queued', 'sent'],
  failed: ['queued', 'sent'],
};

export function allowedPriorStatuses(next: DeliveryStatus): DeliveryStatus[] {
  return ALLOWED_PRIOR[next];
}

/**
 * Per-recipient delivery state for a relay-group fan-out (M1.7). The relayed
 * message is stored ONCE (the inbound source message); this map records the
 * outbound delivery to each OTHER member, keyed by member key
 * (relayMemberKey() below). Each entry runs the SAME forward-only status
 * machine as 1:1 delivery_status, independently per recipient.
 */
export interface RelayRecipientDelivery {
  status: DeliveryStatus;
  /** Provider SID of the per-recipient outbound send (Twilio SMxxx). */
  sid?: string;
  errorCode?: string;
  sentAt?: string;
  deliveredAt?: string;
}

/**
 * Stable member key for relay delivery maps + relaysid pointers: the
 * contactId when the member has one, else `phone#<E164>`. Used as the
 * delivery_recipients map key and stored on the relaysid pointer so a
 * delivery callback can find the right recipient slot to update.
 */
export function relayMemberKey(member: { contactId?: string; phone: string }): string {
  return member.contactId && member.contactId.length > 0
    ? member.contactId
    : `phone#${member.phone}`;
}

/** Deterministic SK: same provider message → same key, every delivery. */
export function buildTsMsgId(providerTs: string, providerSid: string): string {
  return `${providerTs}#${providerSid}`;
}

export interface NewMessage {
  conversationId: string;
  /** Provider message SID (Twilio SMxxx/MMxxx) — the idempotency key. */
  providerSid: string;
  /** PROVIDER timestamp (ISO 8601) — stable across redeliveries. */
  providerTs: string;
  type: MessageType;
  direction: MessageDirection;
  author: MessageAuthor;
  body?: string;
  /** Provider media URLs (MMS); S3 mirroring is Builder B's webhook path. */
  mediaUrls?: string[];
  /**
   * Outbound MMS attachments (design gap #3): the durable {s3Key, contentType}
   * pairs behind an outbound send, persisted so sent media renders through the
   * existing authed serve endpoint + timeline. Distinct from mediaUrls (which
   * for an outbound send are the presigned, EXPIRING provider-fetch URLs). The
   * inbound mirror sets media_attachments from its mirrored keys; this lets the
   * SEND path close the same asymmetry. Absent on text-only sends.
   */
  mediaAttachments?: MediaAttachment[];
  deliveryStatus: DeliveryStatus;
  errorCode?: string;
  /** Relay group (M1.7): sender member key on an inbound relay message. */
  relaySenderKey?: string;
  /** Relay group (M1.7): inbound landed on a closed relay thread (no fan-out).
   *  Retained for the VOICE masked-call path (webhooks/voice.ts); the SMS relay
   *  path no longer sets it (a late text is intercepted into the 1:1 instead -
   *  see viaClosedGroup). */
  receivedOnClosedThread?: boolean;
  /**
   * Relay group (relay-number-lifecycle): a LATE text to a pool number whose
   * only roster match for the sender is a CLOSED group is delivered into the
   * sender's 1:1 thread; this records that closed group's conversationId so the
   * dashboard can badge the message's provenance ("via the closed group chat").
   * Absent on every other message.
   */
  viaClosedGroup?: string;
  /**
   * Relay group (M1.7): SEED the per-recipient delivery map on the SOURCE
   * message at append time. The fan-out's setRecipientDelivery is a CHILD-ONLY
   * SET (DynamoDB forbids seeding a map and a child in one expression), so the
   * parent map MUST already exist before the first per-recipient write. Pass an
   * EMPTY map `{}` on the relay INBOUND path (the fan-out resolves current
   * membership at run time); team-send seeds per-member 'queued' slots via this
   * field too. Absent on 1:1 messages.
   */
  deliveryRecipients?: Record<string, RelayRecipientDelivery>;
  /**
   * Share-broadcast id (M1.8a): when set, the persisted message is tagged with
   * `broadcast_id` so the delivery-status callback rollup can resolve which
   * broadcast's recipient slot to update by the provider SID alone.
   */
  broadcastId?: string;
  /**
   * Manual retry (dashboard Retry button): the tsMsgId of the FAILED message this
   * send supersedes. Stamped as `retry_of` at append so the timeline can collapse
   * the stale failed bubble atomically (no annotate-after race). The 30003
   * auto-retry job sets retry_of via annotateMessage instead (it also writes
   * retry_attempt for the chain cap).
   */
  retryOf?: string;

  // --- Voice calls (M1.9a) -------------------------------------------------
  // A `type:'call'` message is a metadata-only timeline entry for a masked
  // (pool-number) call. `providerSid` carries the Twilio CallSid (the dedupe
  // key — same append conditional + a parallel callsid pointer for the status
  // callback). PII (doc §9): NEVER the raw counterpart phone — the label below
  // is a role/name only.
  /** Voice call lifecycle status (absent on sms/mms). */
  callStatus?: CallStatus;
  /** Coarse outcome (set/refined by the status callback). */
  callOutcome?: CallOutcome;
  /** When the call leg was first seen (ISO 8601). */
  startedAt?: string;
  /** When a leg connected (ISO 8601); absent until answered. */
  answeredAt?: string;
  /** When the call ended (ISO 8601); absent until completion. */
  endedAt?: string;
  /** Billable/connected duration in whole seconds (from Twilio CallDuration). */
  callDuration?: number;
  /** True for masked relay-pool calls — they are NEVER recorded/transcribed. */
  masked?: boolean;
  /**
   * A MASKED party label for the timeline: the COUNTERPART's role ("Tenant"/
   * "Landlord"/"Team") or contact name — NEVER the raw counterpart phone (PII).
   */
  callPartyLabel?: string;

  // --- Email channel v1 (type:'email' items) -------------------------------
  // Provider-id convention (plan F5/F14): INBOUND providerSid = the RFC
  // Message-ID (the sid# pointer IS the threading lookup); OUTBOUND providerSid
  // = the SES MessageId and `email_message_id` is our own <hc-...@domain> id -
  // set `rfcMessageIdPointer` to that RFC id and append() writes a THIRD
  // emailmsgid#<rfcId> pointer so getByRfcMessageId can follow it.
  /** Email subject line. */
  subject?: string;
  /** RFC From address (normalized). */
  email_from?: string;
  /** RFC To addresses (normalized). */
  email_to?: string[];
  /** RFC Cc addresses (normalized). */
  email_cc?: string[];
  /** The RFC Message-ID (ours on outbound `<hc-...>`, the sender's on inbound). */
  email_message_id?: string;
  /**
   * INBOUND email: the References chain from the mail's headers (bracketed RFC
   * ids), persisted so an outbound staff REPLY can build its own References (this
   * chain + the inbound's own Message-ID, capped) for recipient-MUA threading.
   * Absent on outbound + non-email.
   */
  email_references?: string[];
  /** Sanitized inbound HTML body (Phase B B7 renders it; absent on outbound). */
  email_html_sanitized?: string;
  /** S3 ref to the raw MIME (inbound only; NEVER presigned/served unauthed). */
  email_raw_ref?: { bucket: string; key: string };
  /**
   * INBOUND email (B2 tier 5): the message threaded via a reply token or
   * References match, but the From-address is NOT on the resolved contact -
   * the UI renders a "New address" chip; ADDING the address to the contact
   * stays a staff action (Decision 4 - never auto-attached). Absent otherwise.
   */
  email_new_address?: boolean;
  /**
   * INBOUND email (B2 DoS caps): some parsed attachments were NOT stored -
   * over the 50-attachment cap, past the 25MB per-message total, or no media
   * store was configured. The raw MIME (email_raw_ref) remains the full-
   * fidelity record. Absent when every attachment stored.
   */
  attachments_truncated?: boolean;
  /**
   * INBOUND email (B2 DoS caps): a sender-controlled stored array was capped so
   * the assembled item stays under DynamoDB's 400 KB ceiling - the To/Cc
   * recipient lists (count + summed bytes), the References chain (last-N), or an
   * attachment filename (summed bytes). Long Cc/References are ROUTINE on
   * forwarded / mailing-list mail, so this is not just an adversarial guard. The
   * raw MIME (email_raw_ref) keeps the full header set. Absent when nothing
   * capped.
   */
  headers_truncated?: boolean;
  /**
   * OUTBOUND email only: our own RFC Message-ID (`<hc-...@domain>`). When set,
   * append() adds a THIRD emailmsgid#<rfcId> pointer to the transaction so an
   * inbound reply's In-Reply-To/References can resolve this message via
   * getByRfcMessageId (the SES providerSid differs from our RFC id).
   */
  rfcMessageIdPointer?: string;
  /**
   * Recording/transcript seams (later decision; UNUSED for masked calls —
   * masked calls never record). Included so M1.9b/founder-bridge can populate
   * them without a schema change.
   */
  recordingS3Key?: string;
  transcript?: string;
  /**
   * Source-attributed channel->role map for a dual-channel bridge recording
   * (voice-extraction Layer 1). Keys = VI mediaChannel ints as strings ("1"/"2"),
   * values = the KNOWN speaker role for that channel. Stamped at call-append time
   * by the two dial sites (inbound founder bridge / outbound originate), where
   * leg orientation is deterministic at ring time. Persisted as the snake_case
   * attr `transcript_channel_roles`. Call-only; absent on sms/mms and on
   * voicemail (single-channel, no dial).
   */
  transcriptChannelRoles?: Record<string, 'staff' | 'client'>;
}

/** One mirrored MMS attachment: its S3 key + the normalized stored Content-Type. */
export interface MediaAttachment {
  s3Key: string;
  contentType: string;
  /**
   * The pristine uploaded original (RCS-forward, spec Sec 5). `s3Key` is the
   * MMS-deliverable rendition actually sent; `originalKey` is the full-fidelity
   * asset a future RCS channel can send instead. Absent on inbound-mirrored and
   * legacy attachments (they carry only the delivered key).
   */
  originalKey?: string;
  /**
   * The original client-supplied filename (email-channel v1). Carried from the
   * composer through the send so the outbound MIME part and the timeline gallery
   * show `lease.pdf` rather than a synthesized `attachment-1.pdf`. Optional -
   * MMS/inbound/legacy attachments have none.
   */
  filename?: string;
}

export interface MessageItem {
  conversationId: string;
  tsMsgId: string;
  type: MessageType;
  direction: MessageDirection;
  author: MessageAuthor;
  body?: string;
  mediaUrls?: string[];
  provider_sid: string;
  provider_ts: string;
  delivery_status: DeliveryStatus;
  error_code?: string;
  created_at: string;
  /**
   * Mirrored MMS attachments (M1.1 webhook path): each carries its S3 key AND
   * the normalized stored Content-Type, together, so key and type can never
   * drift. Index `i` is the same attachment the `…/media/:i` serve URL selects.
   * Supersedes `media_s3_keys`; read via `mediaAttachmentsOf()` for compat.
   */
  media_attachments?: MediaAttachment[];
  /** @deprecated Legacy parallel key array (pre-`media_attachments`). Read via
   *  `mediaAttachmentsOf()`, which folds it into the new shape as octet-stream.
   *  Removal tracked: docs/issues/remove-media-s3-keys-legacy.md (gated on data migration). */
  media_s3_keys?: string[];
  /** Set on a 30003 retry send: the tsMsgId of the message being retried. */
  retry_of?: string;
  /** 1-based retry attempt number (caps the 30003 retry chain, doc §7.1). */
  retry_attempt?: number;
  /**
   * Relay group (M1.7): on an INBOUND relay message, the member key
   * (relayMemberKey) of the sender — which member texted the pool number.
   * Absent on 1:1 messages.
   */
  relay_sender_key?: string;
  /**
   * Relay group (M1.7): true when this inbound arrived on a CLOSED relay
   * thread — persisted for the audit trail but NOT fanned out. Absent
   * otherwise. Set today only by the VOICE masked-call path (webhooks/voice.ts);
   * the SMS relay path intercepts late texts into the 1:1 (via_closed_group).
   */
  received_on_closed_thread?: boolean;
  /**
   * Relay group (relay-number-lifecycle): the conversationId of the CLOSED
   * relay group a late text was intercepted from. Present ONLY on a 1:1 message
   * delivered by the closed-group interception path; the dashboard renders a
   * "via the closed group chat" provenance badge off it. Absent otherwise.
   */
  via_closed_group?: string;
  /**
   * Relay group (M1.7): per-recipient delivery state for the fan-out of THIS
   * (inbound source) message to the other members, keyed by member key. The
   * relayed message is stored once; fan-out only updates this map. Absent on
   * 1:1 messages (the single `delivery_status` is unchanged for those).
   */
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
  /**
   * Share-broadcast id (M1.8a): set on an outbound broadcast send so the
   * delivery-status callback can roll delivered/failed into the broadcast's
   * stats by SID lookup. Absent on 1:1 / relay messages.
   */
  broadcast_id?: string;

  // --- Voice calls (M1.9a) — present only on type:'call' items -------------
  /** Twilio CallStatus (lifecycle); the status callback advances it forward-only. */
  call_status?: CallStatus;
  /** Coarse outcome (answered/missed/voicemail) — refined by the status callback. */
  call_outcome?: CallOutcome;
  /** First-seen time of the call leg (ISO 8601). */
  started_at?: string;
  /** When a leg connected (ISO 8601); absent until answered. */
  answered_at?: string;
  /** When the call ended (ISO 8601); absent until completion. */
  ended_at?: string;
  /** Connected duration in whole seconds (Twilio CallDuration). */
  call_duration?: number;
  /** True for masked relay-pool calls (NEVER recorded/transcribed). */
  masked?: boolean;
  /** MASKED party label (counterpart role/name) — NEVER a raw phone (PII). */
  call_party_label?: string;

  // --- Email channel v1 - present only on type:'email' items ---------------
  /** Email subject line. */
  subject?: string;
  /** RFC From address (normalized). */
  email_from?: string;
  /** RFC To addresses (normalized). */
  email_to?: string[];
  /** RFC Cc addresses (normalized). */
  email_cc?: string[];
  /** RFC Message-ID (ours on outbound, the sender's on inbound). */
  email_message_id?: string;
  /** INBOUND email References chain (see NewMessage.email_references). */
  email_references?: string[];
  /**
   * OUTBOUND email (A5): the SES MessageId returned by adapter.send, stamped by
   * recordProviderSidAlias AFTER send. Distinct from provider_sid (which is our
   * own RFC id, known before send) - the correlation key SES delivery/bounce/
   * complaint events (B5) arrive under. Absent on inbound + non-email messages.
   */
  ses_message_id?: string;
  /** Sanitized inbound HTML body (Phase B rendering; absent on outbound). */
  email_html_sanitized?: string;
  /** S3 ref to the raw MIME (inbound only; NEVER presigned/served unauthed). */
  email_raw_ref?: { bucket: string; key: string };
  /** Inbound tier-5 "new address" flag (see NewMessage.email_new_address). */
  email_new_address?: boolean;
  /** Inbound attachment-cap note (see NewMessage.attachments_truncated). */
  attachments_truncated?: boolean;
  /** Inbound stored-array cap note (see NewMessage.headers_truncated). */
  headers_truncated?: boolean;
  /**
   * S3 key of the mirrored recording (M1.9c founder-bridge calls only; UNUSED
   * for masked calls, which are never recorded). Set by the recording callback.
   */
  recording_s3_key?: string;
  /**
   * RecordingSid of the stored recording (M1.9c) — the idempotency key for the
   * recordingStatusCallback: a redelivered callback carrying the SAME
   * RecordingSid is a no-op (no re-fetch, no re-store). Set alongside
   * recording_s3_key.
   */
  recording_sid?: string;
  /** Recording duration in whole seconds (M1.9c; from Twilio RecordingDuration). */
  recording_duration?: number;
  /**
   * VERBATIM call transcript (M1.9c founder-bridge calls only; UNUSED for
   * masked calls). Populated when the transcription ENGINE (Twilio Voice
   * Intelligence, operator-configured) POSTs to the transcription callback. NO
   * AI / structured extraction — that is Phase 2.
   */
  transcript?: string;
  /**
   * Transcript lifecycle status (voice-transcription spec 3.7) - drives the
   * in-flight "Transcribing..." indicator on the call bubble. Absent until the
   * recording handler's create leg stamps 'pending'; see TranscriptStatus.
   */
  transcript_status?: TranscriptStatus;
  /**
   * Source-attributed channel->role map (voice-extraction Layer 1) - a
   * flexible-doc attr `transcript_channel_roles?: Record<string,'staff'|'client'>`
   * stamped at call-append time on dual-channel bridge recordings: keys = VI
   * mediaChannel ints as strings, values = that channel's KNOWN speaker role.
   * Read back via the index signature below (no explicit typed field) by
   * joinViSentences to render `Staff: `/`Client: ` prefixes. Absent on sms/mms
   * and on voicemail (single-channel, no dial).
   */
  [key: string]: unknown;
}

/**
 * Post-append annotations (M1.1 Builder B). The timeline stays append-only in
 * the doc-§5 sense — content (body/author/direction) is never rewritten;
 * these add operational metadata the same way delivery_status updates do.
 */
export interface MessageAnnotations {
  mediaAttachments?: MediaAttachment[];
  retryOf?: string;
  retryAttempt?: number;
}

/**
 * Normalized attachment list for a stored message. Prefers `media_attachments`;
 * falls back to legacy `media_s3_keys` (type unknown → `application/octet-stream`
 * → the serve endpoint forces a safe download). The media-serve endpoint and the
 * dashboard both read through this so old and new messages render uniformly.
 */
export function mediaAttachmentsOf(
  item: Pick<MessageItem, 'media_attachments' | 'media_s3_keys'>,
): MediaAttachment[] {
  if (Array.isArray(item.media_attachments)) return item.media_attachments;
  if (Array.isArray(item.media_s3_keys)) {
    return item.media_s3_keys.map((s3Key) => ({ s3Key, contentType: 'application/octet-stream' }));
  }
  return [];
}

export interface AppendResult {
  /** False = fresh write; true = this provider SID was already persisted. */
  deduped: boolean;
  /** The PERSISTED message's SK — on dedupe, the FIRST write's key (which can differ from this call's providerTs). */
  tsMsgId: string;
}

export interface ListByConversationOptions {
  limit?: number;
  /** Exclusive upper bound on tsMsgId — pass the oldest seen key to page back. */
  before?: string;
}

/**
 * A parked SES delivery event (email-channel B5 orphan parking, plan F12). An
 * outbound email persists under our OWN RFC id and only gets a `sid#<sesId>`
 * alias AFTER adapter.send returns - so a fast Bounce/Complaint/Delivery can
 * arrive before that alias exists (getByProviderSid(sesId) misses). Rather than
 * drop it, applyEmailEvent PARKS it under the `emailevent#<sesId>` pointer
 * partition; A5's post-send applyParkedEmailEvents then applies + consumes it.
 * Only the three fields the applier needs are stored (never message content).
 */
export interface ParkedEmailEvent {
  /** 'Bounce' | 'Complaint' | 'Delivery'. */
  eventType: string;
  sesMessageId: string;
  bounceType?: string;
}

export interface MessagesRepo {
  /** Conditional append + SID pointer in one transaction; dedupe is a no-op. */
  append(message: NewMessage): Promise<AppendResult>;
  /** Resolve a provider SID to its message via the pointer item (doc §9). */
  getByProviderSid(sid: string): Promise<MessageItem | undefined>;
  /**
   * Email channel v1 - resolve an RFC Message-ID to its message. Checks the
   * emailmsgid#<id> pointer (OUTBOUND: our own <hc-...> id, distinct from the SES
   * providerSid) FIRST, then falls back to sid#<id> (INBOUND: providerSid IS the
   * RFC Message-ID). The In-Reply-To/References threading lookup for inbound
   * replies. Undefined when neither pointer resolves.
   */
  getByRfcMessageId(messageId: string): Promise<MessageItem | undefined>;
  /**
   * Apply a status-callback transition. Returns false (no-op) when the
   * message is unknown or the transition would move backwards — delivery
   * callbacks arrive out of order and redelivered (doc §7.1).
   */
  updateDeliveryStatus(sid: string, status: DeliveryStatus, errorCode?: string): Promise<boolean>;
  /**
   * Email channel v1 (A5): alias a provider SID to an ALREADY-persisted message.
   * An outbound email persists under our own RFC Message-ID as `provider_sid`
   * (we do not know the SES MessageId until adapter.send returns), so this writes
   * a second `sid#<providerSid>` pointer to that message AND stamps
   * `ses_message_id`. A later SES delivery/bounce/complaint event (B5) - keyed on
   * the SES MessageId - then resolves the message via getByProviderSid(sesId) and
   * runs the SAME forward-only updateDeliveryStatus machine. Idempotent: a
   * duplicate alias writes the same pointer + field (harmless).
   */
  recordProviderSidAlias(
    providerSid: string,
    ref: { conversationId: string; tsMsgId: string },
  ): Promise<void>;
  /**
   * Voice call (M1.9a): apply a call status-callback transition to a
   * `type:'call'` item, found by CallSid (== provider_sid). Forward-only on
   * call_status (a redelivered/out-of-order callback can never regress a
   * terminal call), and idempotently stamps the supplied lifecycle fields
   * (answered_at/ended_at/call_duration/call_outcome). Returns false (no-op)
   * when the call is unknown or the transition would regress — so a redelivered
   * webhook never double-writes or double-counts. PII (doc §9): IDs/labels only.
   */
  updateCallStatus(
    callSid: string,
    fields: {
      callStatus: CallStatus;
      callOutcome?: CallOutcome;
      answeredAt?: string;
      endedAt?: string;
      callDuration?: number;
    },
  ): Promise<boolean>;
  /**
   * Voice call recording (M1.9c): stamp recording_s3_key (+ recording_sid +
   * recording_duration) onto a `type:'call'` item found by CallSid. IDEMPOTENT
   * per RecordingSid — the write is conditioned on the call NOT already carrying
   * a recording_sid (a redelivered recordingStatusCallback with the same
   * RecordingSid is a no-op). Returns true on the first store, false when a
   * recording is already present (so the callback skips re-fetch/re-store) or
   * the CallSid is unknown. PII (doc §9): IDs/keys/durations only — never the
   * RecordingUrl content.
   */
  setCallRecording(
    callSid: string,
    recording: { recordingSid: string; recordingS3Key: string; recordingDuration?: number },
  ): Promise<boolean>;
  /**
   * Voice call recording (M1.9c, FIX 4 — claim rollback): RELEASE a recording
   * claim made by setCallRecording when the subsequent media fetch/put fails, so
   * the call entry does not keep a recording_s3_key/recording_sid pointing at an
   * S3 object that was never written (and Twilio's redelivery can re-claim +
   * re-fetch). Clears recording_sid/recording_s3_key/recording_duration CONDI-
   * TIONALLY on recording_sid still equalling the one we claimed, so it never
   * clobbers a different concurrent writer. Best-effort + idempotent: a no-op
   * (unknown CallSid, or the claim already superseded) never throws.
   */
  releaseCallRecording(callSid: string, recordingSid: string): Promise<void>;
  /**
   * Voice call transcript (M1.9c): save the VERBATIM transcript onto a
   * `type:'call'` item found by CallSid. IDEMPOTENT — the write is conditioned
   * on the call NOT already carrying a (non-empty) transcript, so a redelivered
   * transcription callback never overwrites a completed transcript (and an empty
   * redelivery is refused upstream too). Returns true on the first save, false
   * when a transcript already exists or the CallSid is unknown. PII (doc §9):
   * NEVER log the transcript text.
   */
  setCallTranscript(callSid: string, transcript: string): Promise<boolean>;
  /**
   * Voice transcription lifecycle (voice-transcription spec 3.7): stamp
   * transcript_status = 'pending' the moment a transcript WILL be requested
   * (recording persisted, founder-bridge, VI configured). Conditional on no
   * transcript_status existing yet, so a redelivered recording callback is a
   * no-op. Returns true on the first stamp, false when already stamped or the
   * CallSid is unknown.
   */
  setTranscriptPending(callSid: string): Promise<boolean>;
  /**
   * Voice transcription lifecycle (spec 3.7): stamp transcript_status =
   * 'failed' when the pipeline gives up (VI reports failed / reconcile exhausts
   * attempts). Conditional on the status still being 'pending', so a saved
   * transcript ('completed') is never regressed - completed is terminal.
   * Returns true when it flips a pending call to failed, false otherwise
   * (already completed/failed, never pending, or the CallSid is unknown).
   */
  setTranscriptFailed(callSid: string): Promise<boolean>;
  /**
   * Platform voicemail (voice-transcription spec 4.2): upgrade a call outcome
   * 'missed' -> 'voicemail' via a conditional write (only-if-currently-missed),
   * which also makes redelivered recording callbacks idempotent. Returns true
   * on the first upgrade, false when the call is not currently 'missed'
   * (already voicemail/answered) or the CallSid is unknown.
   */
  upgradeCallOutcomeToVoicemail(callSid: string): Promise<boolean>;
  /** Newest-first page of a conversation's log. */
  listByConversation(conversationId: string, opts?: ListByConversationOptions): Promise<MessageItem[]>;
  /** Stamp operational metadata (media S3 keys / retry lineage) onto a message. */
  annotateMessage(conversationId: string, tsMsgId: string, annotations: MessageAnnotations): Promise<void>;
  /**
   * Execution guard for duplicate-sensitive jobs (M1.2): conditionally
   * record that the job with this envelope jobId ran — `{ PK: job#<jobId>,
   * SK: ran }`, the same pointer-partition trick as the SID items. True =
   * first execution (proceed); false = this jobId already ran (an SQS
   * redelivery — suppress the side effect).
   */
  putJobExecutionMarker(jobId: string, conversationId: string): Promise<boolean>;
  /**
   * READ a job-execution marker (the inbound-email object-key dedupe FAST PATH,
   * email-channel fix-wave B): true = this jobId already ran to a terminal
   * durable write. Correctness never rests on it - the durable writes are
   * independently idempotent - it only lets a clean redelivery skip the work.
   */
  getJobExecutionMarker(jobId: string): Promise<boolean>;

  // --- Email orphan-event parking lot (email-channel B5, plan F12) ----------

  /**
   * Park a SES event whose sesMessageId has no message yet (a fast bounce before
   * the A5 post-send alias write). Stored under `emailevent#<sesMessageId>` with
   * an `expires_at` (epoch seconds) TTL backstop. Idempotent UPSERT: a redelivery
   * before the alias exists overwrites the identical item (harmless). The
   * authoritative cleanup is deleteParkedEmailEvent (the consume), NOT the TTL -
   * the messages table has no TTL configured today; expires_at is forward-
   * compatible (reaps only if/when TTL is enabled on the table).
   */
  putParkedEmailEvent(event: ParkedEmailEvent, opts: { receivedAt: string; expiresAt: number }): Promise<void>;
  /** The parked event for a sesMessageId, or undefined (nothing parked). */
  getParkedEmailEvent(sesMessageId: string): Promise<ParkedEmailEvent | undefined>;
  /**
   * Consume (delete) the parked event - the exactly-once marker. Conditional on
   * the item still existing (attribute_exists); a concurrent consumer that
   * already deleted it makes this a no-op (ConditionalCheckFailed swallowed).
   */
  deleteParkedEmailEvent(sesMessageId: string): Promise<void>;

  // --- Relay groups (M1.7) -------------------------------------------------

  /**
   * Record the per-recipient send result on the SOURCE message's
   * delivery_recipients map (relay fan-out): sets `status` (+ optional sid /
   * sentAt / errorCode) for `memberKey`. A blind SET on the nested map slot —
   * the fan-out owns the initial queued→sent write per recipient; the
   * forward-only state machine is enforced by updateRecipientDeliveryStatus
   * (the callback path). No-op semantics are the caller's (idempotency check).
   */
  setRecipientDelivery(
    conversationId: string,
    tsMsgId: string,
    memberKey: string,
    delivery: RelayRecipientDelivery,
  ): Promise<void>;
  /**
   * Apply a delivery-callback transition to ONE recipient slot of a relay
   * source message: forward-only (same machine as updateDeliveryStatus),
   * keyed by memberKey, found via the relaysid pointer. Returns false (no-op)
   * when the slot is unknown or the transition would regress.
   */
  updateRecipientDeliveryStatus(
    conversationId: string,
    tsMsgId: string,
    memberKey: string,
    status: DeliveryStatus,
    errorCode?: string,
  ): Promise<boolean>;
  /**
   * Write the relaysid pointer for a per-recipient fan-out send: `{ PK:
   * relaysid#<providerSid>, SK: ptr }` → conversationId + tsMsgId + memberKey.
   * Delivery callbacks carry only the SID, so this is how a relay-recipient
   * callback recovers WHICH source message + recipient slot to update. Same
   * marker-partition convention as the sid# pointers (never collides with
   * real conversation partitions). Conditional create — a redelivered
   * fan-out never clobbers an existing pointer.
   */
  putRelaySidPointer(
    providerSid: string,
    ref: { conversationId: string; tsMsgId: string; memberKey: string },
  ): Promise<void>;
  /** Resolve a relay-recipient provider SID to its source message + member slot. */
  getRelaySidPointer(
    providerSid: string,
  ): Promise<{ conversationId: string; tsMsgId: string; memberKey: string } | undefined>;
  /**
   * Mark a provider SID as a SYSTEM send: a real outbound SMS deliberately NOT
   * persisted as a conversation message (e.g. the cell-verification code,
   * routes/voiceApi.ts verify-start). The /status webhook checks this marker
   * before its unknown-SID ERROR backstop so the send's delivery receipts ack
   * at INFO instead of feeding the error alarm
   * (docs/issues/verification-sms-receipts-trip-error-alarm.md). Same
   * marker-partition convention as sid#/job#/relaysid# (`syssid#<sid>`).
   * Unconditional put - a redelivered write is the same content.
   */
  putSystemSidMarker(providerSid: string, kind: string): Promise<void>;
  /** The system-send marker for a provider SID, or undefined. */
  getSystemSidMarker(providerSid: string): Promise<{ kind: string } | undefined>;
}

const DEFAULT_PAGE_LIMIT = 50;

/** Pointer partition key for a provider SID. */
function sidPk(providerSid: string): string {
  return `sid#${providerSid}`;
}

/**
 * Pointer partition key for an OUTBOUND email's own RFC Message-ID (email
 * channel v1). Written as a THIRD append item when rfcMessageIdPointer is set;
 * getByRfcMessageId checks it before the sid# fallback. Never collides with
 * real conversation partitions.
 */
function emailMsgIdPk(rfcMessageId: string): string {
  return `emailmsgid#${rfcMessageId}`;
}

/** Marker partition key for a job execution (see putJobExecutionMarker). */
function jobPk(jobId: string): string {
  return `job#${jobId}`;
}

/** Pointer partition key for a relay-recipient provider SID (M1.7). */
function relaySidPk(providerSid: string): string {
  return `relaysid#${providerSid}`;
}

/** Marker partition key for a system (non-conversation) send's provider SID. */
function sysSidPk(providerSid: string): string {
  return `syssid#${providerSid}`;
}

/** Pointer partition key for a PARKED SES event (email-channel B5, plan F12). */
function emailEventPk(sesMessageId: string): string {
  return `emailevent#${sesMessageId}`;
}

export function createMessagesRepo(deps: RepoDeps = {}): MessagesRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('messages', deps.env);
  const log = deps.logger ?? defaultLogger;

  /** Read the SID pointer item: where the persisted message actually lives. */
  async function getSidPointer(
    sid: string,
  ): Promise<{ ref_conversationId: string; ref_tsMsgId: string } | undefined> {
    const pointer = await doc.send(
      new GetCommand({ TableName: table, Key: { conversationId: sidPk(sid), tsMsgId: 'ptr' } }),
    );
    return pointer.Item as { ref_conversationId: string; ref_tsMsgId: string } | undefined;
  }

  async function getByProviderSid(sid: string): Promise<MessageItem | undefined> {
    const ptr = await getSidPointer(sid);
    if (!ptr) return undefined;
    const { Item } = await doc.send(
      new GetCommand({
        TableName: table,
        Key: { conversationId: ptr.ref_conversationId, tsMsgId: ptr.ref_tsMsgId },
      }),
    );
    return Item as MessageItem | undefined;
  }

  return {
    getByProviderSid,

    async getByRfcMessageId(messageId) {
      // OUTBOUND: emailmsgid#<rfcId> maps our own RFC id -> the message (the SES
      // providerSid differs). INBOUND: no emailmsgid pointer - providerSid IS the
      // RFC id, so fall back to sid#<rfcId>. Both pointer shapes are
      // {ref_conversationId, ref_tsMsgId}.
      const emailPtrRes = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: emailMsgIdPk(messageId), tsMsgId: 'ptr' } }),
      );
      const emailPtr = emailPtrRes.Item as
        | { ref_conversationId: string; ref_tsMsgId: string }
        | undefined;
      const ptr = emailPtr ?? (await getSidPointer(messageId));
      if (!ptr) return undefined;
      const { Item } = await doc.send(
        new GetCommand({
          TableName: table,
          Key: { conversationId: ptr.ref_conversationId, tsMsgId: ptr.ref_tsMsgId },
        }),
      );
      return Item as MessageItem | undefined;
    },

    async append(message) {
      const tsMsgId = buildTsMsgId(message.providerTs, message.providerSid);
      const now = new Date().toISOString();
      const item: MessageItem = {
        conversationId: message.conversationId,
        tsMsgId,
        type: message.type,
        direction: message.direction,
        author: message.author,
        body: message.body,
        mediaUrls: message.mediaUrls,
        provider_sid: message.providerSid,
        provider_ts: message.providerTs,
        delivery_status: message.deliveryStatus,
        error_code: message.errorCode,
        created_at: now,
        // Outbound MMS: persist the durable attachment keys so sent media
        // renders through the authed serve endpoint (gap #3). Only when present.
        ...(message.mediaAttachments !== undefined &&
          message.mediaAttachments.length > 0 && { media_attachments: message.mediaAttachments }),
        ...(message.relaySenderKey !== undefined && { relay_sender_key: message.relaySenderKey }),
        ...(message.receivedOnClosedThread === true && { received_on_closed_thread: true }),
        ...(message.viaClosedGroup !== undefined && { via_closed_group: message.viaClosedGroup }),
        // Seed the per-recipient delivery map (possibly empty) so the fan-out's
        // child-only setRecipientDelivery has a parent map to write into.
        ...(message.deliveryRecipients !== undefined && {
          delivery_recipients: message.deliveryRecipients,
        }),
        ...(message.broadcastId !== undefined && { broadcast_id: message.broadcastId }),
        // Manual retry (dashboard Retry button): stamp retry_of AT APPEND so the
        // new message carries its lineage atomically — no annotate-after race. The
        // 30003 auto-retry still annotates post-send (it also needs retry_attempt).
        ...(message.retryOf !== undefined && { retry_of: message.retryOf }),
        // Voice call (M1.9a): metadata-only fields on a type:'call' item. The
        // same sid#<CallSid> pointer the append already writes lets the status
        // callback recover context via getByProviderSid(CallSid). Masked calls
        // never populate recording_s3_key/transcript (asserted in tests).
        ...(message.callStatus !== undefined && { call_status: message.callStatus }),
        ...(message.callOutcome !== undefined && { call_outcome: message.callOutcome }),
        ...(message.startedAt !== undefined && { started_at: message.startedAt }),
        ...(message.answeredAt !== undefined && { answered_at: message.answeredAt }),
        ...(message.endedAt !== undefined && { ended_at: message.endedAt }),
        ...(message.callDuration !== undefined && { call_duration: message.callDuration }),
        ...(message.masked === true && { masked: true }),
        ...(message.callPartyLabel !== undefined && { call_party_label: message.callPartyLabel }),
        ...(message.recordingS3Key !== undefined && { recording_s3_key: message.recordingS3Key }),
        ...(message.transcript !== undefined && { transcript: message.transcript }),
        // Voice-extraction Layer 1: source-attributed channel->role map for the
        // call's dual-channel recording (keys = VI mediaChannel ints as strings).
        // Stamped by the two dial sites; read back by joinViSentences via the
        // MessageItem index signature. Call-only; absent on sms/mms/voicemail.
        ...(message.transcriptChannelRoles !== undefined && {
          transcript_channel_roles: message.transcriptChannelRoles,
        }),
        // Email channel v1 (type:'email'): the email fields land beside the
        // broadcastId pattern above. Only-when-present so non-email messages are
        // byte-identical to before.
        ...(message.subject !== undefined && { subject: message.subject }),
        ...(message.email_from !== undefined && { email_from: message.email_from }),
        ...(message.email_to !== undefined && { email_to: message.email_to }),
        ...(message.email_cc !== undefined && { email_cc: message.email_cc }),
        ...(message.email_message_id !== undefined && { email_message_id: message.email_message_id }),
        ...(message.email_references !== undefined &&
          message.email_references.length > 0 && { email_references: message.email_references }),
        ...(message.email_html_sanitized !== undefined && {
          email_html_sanitized: message.email_html_sanitized,
        }),
        ...(message.email_raw_ref !== undefined && { email_raw_ref: message.email_raw_ref }),
        ...(message.email_new_address === true && { email_new_address: true }),
        ...(message.attachments_truncated === true && { attachments_truncated: true }),
        ...(message.headers_truncated === true && { headers_truncated: true }),
      };
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table,
                  Item: item,
                  // §7.1 idempotency primitive: same provider message never
                  // persists twice (PK exists, so condition the SK).
                  ConditionExpression: 'attribute_not_exists(tsMsgId)',
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: {
                    conversationId: sidPk(message.providerSid),
                    tsMsgId: 'ptr',
                    ref_conversationId: message.conversationId,
                    ref_tsMsgId: tsMsgId,
                  },
                  ConditionExpression: 'attribute_not_exists(tsMsgId)',
                },
              },
              // Email channel v1: an OUTBOUND email carries its own RFC
              // Message-ID (distinct from the SES providerSid) - write a THIRD
              // emailmsgid#<rfcId> pointer so an inbound reply's In-Reply-To
              // resolves this message via getByRfcMessageId. Only when set
              // (INBOUND uses providerSid == the RFC id, so its sid# pointer is
              // already the threading lookup - no third item).
              ...(message.rfcMessageIdPointer !== undefined
                ? [
                    {
                      Put: {
                        TableName: table,
                        Item: {
                          conversationId: emailMsgIdPk(message.rfcMessageIdPointer),
                          tsMsgId: 'ptr',
                          ref_conversationId: message.conversationId,
                          ref_tsMsgId: tsMsgId,
                        },
                        ConditionExpression: 'attribute_not_exists(tsMsgId)',
                      },
                    },
                  ]
                : []),
            ],
          }),
        );
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const conditionFailed = err.CancellationReasons?.some(
            (r) => r.Code === 'ConditionalCheckFailed',
          );
          if (conditionFailed) {
            // The PERSISTED tsMsgId can differ from the one computed above:
            // inbound redeliveries carry no provider timestamp, so a
            // redelivered webhook computes a NEW first-seen providerTs.
            // Resolve the real key via the SID pointer (written in the same
            // transaction as the original message, so it must exist here).
            const ptr = await getSidPointer(message.providerSid);
            log.info(
              { conversationId: message.conversationId, providerSid: message.providerSid },
              'message append deduped (provider SID already persisted)',
            );
            return { deduped: true, tsMsgId: ptr?.ref_tsMsgId ?? tsMsgId };
          }
        }
        throw err;
      }
      log.info(
        {
          conversationId: message.conversationId,
          providerSid: message.providerSid,
          direction: message.direction,
          type: message.type,
          bodyLength: message.body?.length ?? 0,
          mediaCount: message.mediaUrls?.length ?? 0,
        },
        'message appended',
      );
      return { deduped: false, tsMsgId };
    },

    async updateDeliveryStatus(sid, status, errorCode) {
      const existing = await getByProviderSid(sid);
      if (!existing) {
        log.warn({ providerSid: sid, status }, 'delivery status for unknown provider SID ignored');
        return false;
      }
      const allowed = allowedPriorStatuses(status);
      if (allowed.length === 0) return false; // nothing may transition INTO queued
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression:
              errorCode !== undefined
                ? 'SET delivery_status = :s, error_code = :e'
                : 'SET delivery_status = :s',
            // Forward-only: the write commits only from an allowed prior
            // status, so out-of-order callbacks can never regress `delivered`.
            ConditionExpression: `delivery_status IN (${allowed.map((_, i) => `:p${i}`).join(', ')})`,
            ExpressionAttributeValues: {
              ':s': status,
              ...(errorCode !== undefined && { ':e': errorCode }),
              ...Object.fromEntries(allowed.map((p, i) => [`:p${i}`, p])),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { providerSid: sid, status, currentStatus: existing.delivery_status },
            'delivery status transition skipped (would regress)',
          );
          return false;
        }
        throw err;
      }
      log.info({ providerSid: sid, status, errorCode }, 'delivery status updated');
      return true;
    },

    async recordProviderSidAlias(providerSid, ref) {
      // (1) sid#<providerSid> -> the message: the SAME pointer shape append
      // writes, so getByProviderSid(sesMessageId) / updateDeliveryStatus resolve
      // it. Unconditional Put: a redelivery writes the identical ref (harmless).
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            conversationId: sidPk(providerSid),
            tsMsgId: 'ptr',
            ref_conversationId: ref.conversationId,
            ref_tsMsgId: ref.tsMsgId,
          },
        }),
      );
      // (2) Stamp the SES id on the message for correlation/display. Best-effort
      // idempotent SET (no condition - re-writing the same id is a no-op).
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId: ref.conversationId, tsMsgId: ref.tsMsgId },
          UpdateExpression: 'SET ses_message_id = :m',
          ExpressionAttributeValues: { ':m': providerSid },
        }),
      );
      log.info({ providerSid, conversationId: ref.conversationId }, 'email provider-sid alias recorded');
    },

    async updateCallStatus(callSid, fields) {
      // CallSid == provider_sid, so the same sid# pointer the call append wrote
      // resolves the item — no separate callsid partition needed.
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid, callStatus: fields.callStatus }, 'call status for unknown CallSid ignored');
        return false;
      }
      const allowed = allowedPriorCallStatuses(fields.callStatus);
      if (allowed.length === 0) return false; // nothing transitions INTO ringing
      const sets = ['call_status = :s'];
      const values: Record<string, unknown> = { ':s': fields.callStatus };
      if (fields.callOutcome !== undefined) {
        sets.push('call_outcome = :o');
        values[':o'] = fields.callOutcome;
      }
      if (fields.answeredAt !== undefined) {
        sets.push('answered_at = :a');
        values[':a'] = fields.answeredAt;
      }
      if (fields.endedAt !== undefined) {
        sets.push('ended_at = :e');
        values[':e'] = fields.endedAt;
      }
      if (fields.callDuration !== undefined) {
        sets.push('call_duration = :d');
        values[':d'] = fields.callDuration;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            // Forward-only: commit only from an allowed prior call_status, so an
            // out-of-order/redelivered callback can never regress a terminal call.
            ConditionExpression: `call_status IN (${allowed.map((_, i) => `:p${i}`).join(', ')})`,
            ExpressionAttributeValues: {
              ...values,
              ...Object.fromEntries(allowed.map((p, i) => [`:p${i}`, p])),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { callSid, callStatus: fields.callStatus, currentStatus: existing.call_status },
            'call status transition skipped (would regress)',
          );
          return false;
        }
        throw err;
      }
      log.info({ callSid, callStatus: fields.callStatus }, 'call status updated');
      return true;
    },

    async setCallRecording(callSid, recording) {
      // CallSid == provider_sid, so the sid# pointer the call append wrote
      // resolves the item (same as updateCallStatus). PII (doc §9): IDs/keys/
      // durations only — never the RecordingUrl/content.
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid, recordingSid: recording.recordingSid }, 'recording for unknown CallSid ignored');
        return false;
      }
      const sets = ['recording_s3_key = :k', 'recording_sid = :rsid'];
      const values: Record<string, unknown> = {
        ':k': recording.recordingS3Key,
        ':rsid': recording.recordingSid,
      };
      if (recording.recordingDuration !== undefined) {
        sets.push('recording_duration = :d');
        values[':d'] = recording.recordingDuration;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            // Idempotent per RecordingSid: commit ONLY when no recording is yet
            // stored, so a redelivered recordingStatusCallback (same or a later
            // RecordingSid) never re-stores or overwrites the first one.
            ConditionExpression: 'attribute_not_exists(recording_sid)',
            ExpressionAttributeValues: values,
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { callSid, recordingSid: recording.recordingSid },
            'recording store skipped (already recorded)',
          );
          return false;
        }
        throw err;
      }
      log.info(
        { callSid, recordingSid: recording.recordingSid, recordingDuration: recording.recordingDuration },
        'call recording stored',
      );
      return true;
    },

    async releaseCallRecording(callSid, recordingSid) {
      // FIX 4: roll back a claim whose media fetch/put failed. CallSid ==
      // provider_sid (same pointer lookup as setCallRecording).
      const existing = await getByProviderSid(callSid);
      if (!existing) return;
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: 'REMOVE recording_sid, recording_s3_key, recording_duration',
            // Only release OUR claim — never clobber a different concurrent
            // writer that has since stored a (different) RecordingSid.
            ConditionExpression: 'recording_sid = :rsid',
            ExpressionAttributeValues: { ':rsid': recordingSid },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // The claim was already superseded/cleared — nothing to release.
          log.info({ callSid, recordingSid }, 'recording claim release skipped (claim superseded)');
          return;
        }
        throw err;
      }
      log.info({ callSid, recordingSid }, 'call recording claim released (mirror failed)');
    },

    async setCallTranscript(callSid, transcript) {
      // CallSid == provider_sid (same pointer lookup). PII (doc §9): NEVER log
      // the transcript text — length only.
      //
      // PHASE 1 DECISION — "first verbatim wins": the write is conditioned on no
      // (non-empty) transcript existing, so the FIRST transcript to land is
      // permanent. There is NO transcription-SID idempotency, so a CORRECTED
      // re-POST from Voice Intelligence (same call, revised text) is DROPPED, not
      // applied. Accepted for Phase 1 (verbatim capture only; no transcript
      // versioning / structured extraction — that is Phase 2).
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid }, 'transcript for unknown CallSid ignored');
        return false;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            // Also stamp transcript_status = 'completed' atomically (spec 3.7).
            // The condition is on `transcript` (NOT status), so a late webhook
            // still upgrades a 'failed' call to completed; completed is terminal.
            UpdateExpression: 'SET transcript = :t, transcript_status = :c',
            // Idempotent: commit ONLY when no (non-empty) transcript exists yet,
            // so a redelivered transcription callback never overwrites a saved
            // transcript. (An empty redelivery is refused at the callback too.)
            ConditionExpression: 'attribute_not_exists(transcript) OR transcript = :empty',
            ExpressionAttributeValues: { ':t': transcript, ':empty': '', ':c': 'completed' },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ callSid }, 'transcript save skipped (already transcribed)');
          return false;
        }
        throw err;
      }
      log.info({ callSid, transcriptLength: transcript.length }, 'call transcript saved');
      return true;
    },

    async setTranscriptPending(callSid) {
      // Voice transcription lifecycle (spec 3.7): stamp 'pending' the moment a
      // transcript WILL be requested. CallSid == provider_sid (same pointer
      // lookup). Conditional on no transcript_status yet, so a redelivered
      // recording callback never re-stamps. PII: sids only.
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid }, 'transcript-pending for unknown CallSid ignored');
        return false;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: 'SET transcript_status = :p',
            ConditionExpression: 'attribute_not_exists(transcript_status)',
            ExpressionAttributeValues: { ':p': 'pending' },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ callSid }, 'transcript-pending stamp skipped (already stamped)');
          return false;
        }
        throw err;
      }
      log.info({ callSid }, 'transcript status set to pending');
      return true;
    },

    async setTranscriptFailed(callSid) {
      // Voice transcription lifecycle (spec 3.7): flip 'pending' to 'failed'
      // when the pipeline gives up. Conditional on the status still being
      // 'pending' so a 'completed' transcript is never regressed (completed is
      // terminal). PII: sids only.
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid }, 'transcript-failed for unknown CallSid ignored');
        return false;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: 'SET transcript_status = :f',
            ConditionExpression: 'transcript_status = :p',
            ExpressionAttributeValues: { ':f': 'failed', ':p': 'pending' },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ callSid }, 'transcript-failed stamp skipped (not pending)');
          return false;
        }
        throw err;
      }
      log.info({ callSid }, 'transcript status set to failed');
      return true;
    },

    async upgradeCallOutcomeToVoicemail(callSid) {
      // Platform voicemail (spec 4.2): upgrade 'missed' to 'voicemail' on the
      // completed recording. Conditional on the outcome still being 'missed', so
      // a redelivered recording callback is idempotent (only the first wins).
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid }, 'voicemail outcome upgrade for unknown CallSid ignored');
        return false;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: 'SET call_outcome = :v',
            ConditionExpression: 'call_outcome = :m',
            ExpressionAttributeValues: { ':v': 'voicemail', ':m': 'missed' },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ callSid }, 'voicemail outcome upgrade skipped (not currently missed)');
          return false;
        }
        throw err;
      }
      log.info({ callSid }, 'call outcome upgraded from missed to voicemail');
      return true;
    },

    async annotateMessage(conversationId, tsMsgId, annotations) {
      const sets: string[] = [];
      const values: Record<string, unknown> = {};
      if (annotations.mediaAttachments !== undefined) {
        sets.push('media_attachments = :mediaAttachments');
        values[':mediaAttachments'] = annotations.mediaAttachments;
      }
      if (annotations.retryOf !== undefined) {
        sets.push('retry_of = :retryOf');
        values[':retryOf'] = annotations.retryOf;
      }
      if (annotations.retryAttempt !== undefined) {
        sets.push('retry_attempt = :retryAttempt');
        values[':retryAttempt'] = annotations.retryAttempt;
      }
      if (sets.length === 0) return;
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId, tsMsgId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(tsMsgId)',
          ExpressionAttributeValues: values,
        }),
      );
      log.info(
        {
          conversationId,
          tsMsgId,
          mediaKeyCount: annotations.mediaAttachments?.length,
          retryOf: annotations.retryOf,
          retryAttempt: annotations.retryAttempt,
        },
        'message annotated',
      );
    },

    async putJobExecutionMarker(jobId, conversationId) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              conversationId: jobPk(jobId),
              tsMsgId: 'ran',
              ref_conversationId: conversationId,
              executed_at: new Date().toISOString(),
            },
            ConditionExpression: 'attribute_not_exists(tsMsgId)',
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
      return true;
    },

    async getJobExecutionMarker(jobId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: jobPk(jobId), tsMsgId: 'ran' } }),
      );
      return Item !== undefined;
    },

    async putParkedEmailEvent(event, opts) {
      // Unconditional UPSERT: a redelivery before the alias exists overwrites the
      // identical item (idempotent). The pointer-partition family (sid#/job#).
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            conversationId: emailEventPk(event.sesMessageId),
            tsMsgId: 'parked',
            event_type: event.eventType,
            ses_message_id: event.sesMessageId,
            ...(event.bounceType !== undefined && { bounce_type: event.bounceType }),
            received_at: opts.receivedAt,
            expires_at: opts.expiresAt,
          },
        }),
      );
      log.info({ sesMessageId: event.sesMessageId, eventType: event.eventType }, 'SES event parked');
    },

    async getParkedEmailEvent(sesMessageId) {
      const { Item } = await doc.send(
        new GetCommand({
          TableName: table,
          Key: { conversationId: emailEventPk(sesMessageId), tsMsgId: 'parked' },
        }),
      );
      if (!Item) return undefined;
      const eventType = Item['event_type'];
      const storedId = Item['ses_message_id'];
      if (typeof eventType !== 'string' || typeof storedId !== 'string') return undefined;
      const bounceType = Item['bounce_type'];
      return {
        eventType,
        sesMessageId: storedId,
        ...(typeof bounceType === 'string' && { bounceType }),
      };
    },

    async deleteParkedEmailEvent(sesMessageId) {
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { conversationId: emailEventPk(sesMessageId), tsMsgId: 'parked' },
            // The consume marker: exactly-once even under a concurrent double-apply.
            ConditionExpression: 'attribute_exists(tsMsgId)',
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return;
        throw err;
      }
      log.info({ sesMessageId }, 'parked SES event consumed');
    },

    async listByConversation(conversationId, opts = {}) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: opts.before
            ? 'conversationId = :c AND tsMsgId < :before'
            : 'conversationId = :c',
          ExpressionAttributeValues: {
            ':c': conversationId,
            ...(opts.before && { ':before': opts.before }),
          },
          ScanIndexForward: false, // newest-first
          Limit: opts.limit ?? DEFAULT_PAGE_LIMIT,
        }),
      );
      return (Items ?? []) as MessageItem[];
    },

    // --- Relay groups (M1.7) -----------------------------------------------

    async setRecipientDelivery(conversationId, tsMsgId, memberKey, delivery) {
      // CHILD-ONLY SET of the recipient slot (delivery_recipients.<memberKey>).
      // The parent `delivery_recipients` map is always pre-seeded on the source
      // message at append time (team-send seeds per-member 'queued'; the relay
      // inbound path seeds an empty map) — so it always exists when the fan-out
      // calls this. DynamoDB rejects an UpdateExpression that SETs both a map
      // and a child of that map in one statement (overlapping document paths),
      // so we must NOT also seed the parent here. memberKey is attacker-free
      // (derived from our own roster) but may contain `#` (phone keys) — bind it
      // as a value, address the map slot via an aliased name to avoid
      // dotted-path parsing issues.
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId, tsMsgId },
          UpdateExpression: 'SET delivery_recipients.#mk = :d',
          ConditionExpression: 'attribute_exists(tsMsgId)',
          ExpressionAttributeNames: { '#mk': memberKey },
          ExpressionAttributeValues: { ':d': delivery },
        }),
      );
    },

    async updateRecipientDeliveryStatus(conversationId, tsMsgId, memberKey, status, errorCode) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId, tsMsgId } }),
      );
      const message = Item as MessageItem | undefined;
      const slot = message?.delivery_recipients?.[memberKey];
      if (!slot) {
        log.warn(
          { conversationId, tsMsgId, status },
          'relay recipient delivery status for unknown recipient slot ignored',
        );
        return false;
      }
      const allowed = allowedPriorStatuses(status);
      if (!allowed.includes(slot.status)) {
        log.info(
          { conversationId, tsMsgId, status, currentStatus: slot.status },
          'relay recipient delivery status transition skipped (would regress)',
        );
        return false;
      }
      const now = new Date().toISOString();
      const next: RelayRecipientDelivery = {
        ...slot,
        status,
        ...(errorCode !== undefined && { errorCode }),
        ...(status === 'delivered' && { deliveredAt: now }),
      };
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId, tsMsgId },
            UpdateExpression: 'SET delivery_recipients.#mk = :d',
            // Guard the read-modify-write: only commit if the slot is still on
            // the status we just read (forward-only under concurrent callbacks).
            ConditionExpression: 'delivery_recipients.#mk.#st = :prev',
            ExpressionAttributeNames: { '#mk': memberKey, '#st': 'status' },
            ExpressionAttributeValues: { ':d': next, ':prev': slot.status },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { conversationId, tsMsgId, status },
            'relay recipient delivery status transition lost a race (regressed)',
          );
          return false;
        }
        throw err;
      }
      log.info({ conversationId, tsMsgId, status, errorCode }, 'relay recipient delivery updated');
      return true;
    },

    async putRelaySidPointer(providerSid, ref) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              conversationId: relaySidPk(providerSid),
              tsMsgId: 'ptr',
              ref_conversationId: ref.conversationId,
              ref_tsMsgId: ref.tsMsgId,
              ref_member_key: ref.memberKey,
            },
            ConditionExpression: 'attribute_not_exists(tsMsgId)',
          }),
        );
      } catch (err) {
        // A redelivered fan-out re-sends to the same recipient under a NEW
        // provider SID, so a collision here is unexpected — but never fatal:
        // the existing pointer already routes the callback correctly.
        if (err instanceof ConditionalCheckFailedException) return;
        throw err;
      }
    },

    async getRelaySidPointer(providerSid) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: relaySidPk(providerSid), tsMsgId: 'ptr' } }),
      );
      const ptr = Item as
        | { ref_conversationId: string; ref_tsMsgId: string; ref_member_key: string }
        | undefined;
      if (!ptr) return undefined;
      return {
        conversationId: ptr.ref_conversationId,
        tsMsgId: ptr.ref_tsMsgId,
        memberKey: ptr.ref_member_key,
      };
    },

    async putSystemSidMarker(providerSid, kind) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            conversationId: sysSidPk(providerSid),
            tsMsgId: 'ptr',
            kind,
            created_at: new Date().toISOString(),
          },
        }),
      );
      log.info({ providerSid, kind }, 'system-send SID marker written');
    },

    async getSystemSidMarker(providerSid) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: sysSidPk(providerSid), tsMsgId: 'ptr' } }),
      );
      if (!Item) return undefined;
      return { kind: (Item as { kind?: string }).kind ?? 'unknown' };
    },
  };
}
