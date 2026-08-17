// Twilio Programmable Messaging webhooks (M1.1 Builder B, doc §7.1):
//   POST /webhooks/twilio/sms     — the Messaging Service's inbound webhook
//   POST /webhooks/twilio/status  — its delivery status callback
// Both arrive as application/x-www-form-urlencoded (parsed by the locked
// chain's urlencoded parser, raw bytes on req.rawBody) and are signature-
// verified by twilioSignatureMiddleware before any handler runs.
//
// PII (doc §9): message bodies and media URLs are NEVER logged — log lines
// carry SIDs/IDs/lengths only, correlated via the pino mixin.
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { Router } from 'express';
import type { MediaStore } from '../../adapters/mediaStore.js';
import { createMediaStore } from '../../adapters/mediaStore.js';
import {
  createMessagingAdapter,
  mapTwilioStatus,
  type MessagingAdapter,
} from '../../adapters/messaging.js';
import { mergeContext } from '../../lib/context.js';
import { normalizeStoredMediaType } from '../../lib/mediaTypes.js';
import { loadConfig, type AppConfig } from '../../lib/config.js';
import {
  appEvents,
  toPlacementUpdatedEvent,
  toConversationUpdatedEvent,
  type EventBus,
} from '../../lib/events.js';
// FIX 4: the relay roster fields now live in toConversationUpdatedEvent — the
// inbound relay path uses the one shared builder (no separate relay builder).
import { summarizeError } from '../../lib/errors.js';
import { logger as defaultLogger, type Logger } from '../../lib/logger.js';
import { classifyInboundKeyword } from '../../lib/smsCompliance.js';
import { twilioSignatureMiddleware } from '../../middleware/twilioSignature.js';
import type { PoolNumbersService } from '../../services/poolNumbers.js';
import { createAuditRepo, type AuditRepo } from '../../repos/auditRepo.js';
import {
  createBroadcastsRepo,
  deriveBroadcastStats,
  type BroadcastRecipient,
  type BroadcastsRepo,
} from '../../repos/broadcastsRepo.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../../repos/contactsRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../../repos/extractionRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../../repos/settingsRepo.js';
import { createPlacementsRepo, type PlacementsRepo, TERMINAL_STAGES } from '../../repos/placementsRepo.js';
import {
  createPlacementDeadlinesRepo,
  soonestDeadline,
  type PlacementDeadlinesRepo,
} from '../../repos/placementDeadlinesRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationParticipant,
  type ConversationsRepo,
  type ConversationType,
} from '../../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  relayMemberKey,
  type DeliveryStatus,
  type MediaAttachment,
  type MessagesRepo,
} from '../../repos/messagesRepo.js';
import { createContactCapture } from '../../services/contactCapture.js';
import { createOurNumberKind } from '../../services/ourNumberKind.js';
import { isMemberSuppressed, logSafeMemberKey } from '../../services/relayAnnouncements.js';
import { applyNumberSuppression } from '../../services/numberSuppression.js';
import {
  hasOtherRecipientsBeyondCap,
  isMissingEnvelopeGroupShape,
  MAX_OTHER_RECIPIENTS_INDEX,
  parseOtherRecipients,
} from '../../services/groupEnvelope.js';
import { groupIdentity, type GroupExclusionSet } from '../../services/groupIdentity.js';
import { groupMemberKey, resolveGroupMembers } from '../../services/groupMembers.js';
import {
  hasActiveGroupRail,
  MAX_RAIL_MEMBERS,
  type GroupRailEnqueuer,
} from '../../services/groupRail.js';
import { createGroupRailEnqueuer } from '../../jobs/groupRail.js';
import { createGroupCrossCheck, type GroupCrossCheck } from '../../services/groupCrossCheck.js';
import { convertConnectingRelayGroupToGroupText } from '../../services/groupConvert.js';
import { createPoolNumbersRepo, type PoolNumbersRepo } from '../../repos/poolNumbersRepo.js';
import { GROUP_RAILED_INBOUND_LAST_AT_ID } from '../../repos/settingsRepo.js';
import { createRateLimitedWarn } from '../../lib/rateLimitedWarn.js';
import { formatPhoneForDisplay, normalizeToE164 } from '../../lib/phone.js';
import { conversationIdForGroup } from '../../lib/import/ids.js';
import { capPushText, PUSH_BODY_MAX, PUSH_TITLE_MAX } from '../../lib/pushText.js';
import { contactDisplayName } from '../../lib/contactName.js';
import { groupThreadLabel, relayThreadLabel } from '../../lib/groupTitle.js';
import { createPushService, type PushService } from '../../services/pushService.js';
import {
  enqueueSendRetry,
  MAX_SEND_RETRY_ATTEMPTS,
} from '../../jobs/retrySend.js';
import { enqueueImmediate } from '../../jobs/jobs.js';
import { RELAY_FANOUT_JOB } from '../../jobs/relayFanOut.js';

/** Empty TwiML acknowledgment — "received, no reply instructions". */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

// THERE IS NO KEYWORD-REPLY TwiML ANY MORE (2026-08-12, Cameron's ruling; issue
// twilio-standard-optout-double-reply). This module used to carry a
// `messageTwiml(body)` helper because "WE own the keyword replies (spec 6):
// Twilio Advanced Opt-Out auto-reply is OFF (operator step)". A live dev test
// on the real messaging service disproved every clause of that premise:
//
//   - HELP never reached this webhook at all. Twilio consumed it and answered.
//   - Our STOP confirmation was refused with error 21610 (send to an opted-out
//     number) because Twilio had ALREADY applied the block. It has never once
//     been delivered - the "must ride the TwiML response, not the gated send
//     wrapper" reasoning was correct about the gate and wrong about the outcome.
//   - START drew Twilio's own confirmation ON TOP of our welcome: a double text.
//
// The resolution is the opposite configuration: Advanced Opt-Out is turned ON
// and configured, in the console, with OUR filed copy (messages/catalog.ts stays
// the source of truth; see RUNBOOK "Keyword auto-replies (Advanced Opt-Out)").
// The app keeps ALL the keyword machinery - classification, suppression and
// consent bookkeeping, the audit trail, the relay annotations - and emits NO
// reply, so every inbound now acks with the empty TwiML below.
//
// ONE LIVE CONSEQUENCE TO KNOW ABOUT: with Advanced Opt-Out ON, Twilio stamps
// `OptOutType` on the inbound, and `classifyInboundKeyword` already PREFERS it
// over the body. That is now the LIVE classification path, not a hypothetical.
// It matches on the exact keyword message, which the dev keyword canary verifies
// with a sentence probe ("please stop sending tour reminders" must NOT classify).

// Opt-out / opt-in keyword sets + the filed replies now live in the SINGLE
// SOURCE OF TRUTH (lib/smsCompliance.ts) so they can never drift from the
// approved A2P campaign. OPT_OUT_KEYWORDS adds OPTOUT+REVOKE; OPT_IN_KEYWORDS
// adds JOIN+HOME (keeps UNSTOP). HELP is detected separately below.

/** The webhook form fields this module reads (all optional strings). */
type WebhookParams = Record<string, string | undefined>;

function asParams(body: unknown): WebhookParams {
  return (typeof body === 'object' && body !== null ? body : {}) as WebhookParams;
}

/**
 * Conversation typing is as honest as contact typing (operator mandate,
 * 2026-06-12): only a RESOLVED contact type yields a typed thread. No contact
 * yet, or a contact whose type is 'unknown'/'team_member', is
 * `unknown_1to1` — never a guess.
 *
 * When the team sets a contact's real type, the conversation-type propagation
 * (unknown_1to1 → tenant_1to1/landlord_1to1) is handled where triage happens —
 * see app/src/routes/contacts.ts (the PATCH handler's propagatedConversations).
 */
function conversationTypeFor(contact: ContactItem | undefined): ConversationType {
  switch (contact?.type) {
    case 'landlord':
      return 'landlord_1to1';
    case 'tenant':
      return 'tenant_1to1';
    case 'partner':
      return 'partner_1to1';
    default:
      return 'unknown_1to1';
  }
}

/**
 * Sort relay groups NEWEST-first by created_at (missing created_at sorts last).
 * Used to break ties in (To, From) resolution: at most one OPEN group should
 * match by the burn invariant, but a corrupt-many is disambiguated to the
 * newest (never a crash), and a sender in several CLOSED groups on one number
 * routes to the newest for provenance.
 */
/**
 * Seen keys for the delivery-error DEGRADATION logs (the arms that flag nothing
 * and only report: sms_unreachable with no contact, and the 21610 arms). Twilio
 * redelivers a status callback until it is acked, and a group leg has no contact
 * to flag, so without this one undeliverable message could log the same line
 * dozens of times and swamp the signal.
 *
 * Keyed `<code>:<sid>` so the 21610 and 30005/30006 arms cannot swallow each
 * other's first line for the same message.
 *
 * Bounded FIFO: this is a log-noise damper, not a correctness mechanism, so
 * forgetting the oldest keys is fine - the worst case is one extra line.
 */
const DEGRADATION_LOGGED_KEYS = new Set<string>();
const DEGRADATION_LOGGED_MAX = 500;

/** Run `emit` at most once per (error code, provider SID) (within the bound above). */
function logDegradationOnce(key: string, emit: () => void): void {
  if (DEGRADATION_LOGGED_KEYS.has(key)) return;
  if (DEGRADATION_LOGGED_KEYS.size >= DEGRADATION_LOGGED_MAX) {
    const oldest = DEGRADATION_LOGGED_KEYS.values().next().value;
    if (oldest !== undefined) DEGRADATION_LOGGED_KEYS.delete(oldest);
  }
  DEGRADATION_LOGGED_KEYS.add(key);
  emit();
}

function byNewestCreated(a: ConversationItem, b: ConversationItem): number {
  const aC = a.created_at ?? '';
  const bC = b.created_at ?? '';
  return aC < bC ? 1 : aC > bC ? -1 : 0;
}

export interface TwilioWebhookDeps {
  config?: AppConfig;
  logger?: Logger;
  adapter?: MessagingAdapter;
  mediaStore?: MediaStore;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  auditRepo?: AuditRepo;
  /** M1.10c failed-send escalation: flag the linked placement's attention flag. */
  placementsRepo?: PlacementsRepo;
  /**
   * First-class placement deadlines (placement-deadline-model): the escalation
   * emit recomputes the placement's soonest deadline so the event PRESERVES the
   * pending deadline chip instead of nulling it. Injected in tests.
   */
  placementDeadlinesRepo?: PlacementDeadlinesRepo;
  /** Share-broadcast results rollup (M1.8a); the real repo by default. */
  broadcastsRepo?: BroadcastsRepo;
  /**
   * Org settings - the group cross-check / railed-inbound liveness high-water
   * marks are written through it. (It used to also resolve the operator's
   * `welcomeText` override for the opt-in keyword reply; that reply is Twilio's
   * now.) Injectable in tests; the real repo otherwise.
   */
  settingsRepo?: SettingsRepo;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
  /**
   * Conversation fact extraction (AI): a fresh inbound on a tenant/unknown 1:1
   * thread schedules a debounced extraction run (sliding due upsert). Injectable
   * in tests; the real singleton by default. Gated on config.aiExtractionEnabled.
   */
  extractionRepo?: ExtractionRepo;
  /**
   * How long the status callback waits before retrying an unknown-SID lookup
   * once (the send/append race window). Injectable for tests; default 2500ms.
   */
  statusUnknownSidRetryDelayMs?: number;
  /**
   * Relay pool-numbers service - consumed by the Event Streams sink router
   * (createTwilioEventsRouter) to promote a `warming` number to `active` on a
   * registration event (T3). Part of TwilioWebhookDeps so the shared webhooks
   * deps (index.ts) thread it in; the real service by default. Injectable in tests.
   */
  poolNumbersService?: PoolNumbersService;
  /**
   * Pool-number inventory (native group texting): the cached exclusion-set read
   * that keeps a relay number out of a derived group roster. Read-only here;
   * the real repo by default, injectable in tests.
   */
  poolNumbersRepo?: Pick<PoolNumbersRepo, 'listActive'>;
  /**
   * The group-text RAIL seam (spec 6.1 DETECTION). Detection ENQUEUES rail
   * creation rather than calling Twilio inline (the 5s webhook budget).
   * Defaults to the real `groupRail.ensure` producer (T6.6(a)).
   */
  groupRailEnqueuer?: GroupRailEnqueuer;
  /**
   * The guardrail cross-check (T6.6(d)). Filing a group inbound onto a RAILED
   * thread is the classic half of the (rail, author) match, so this call is what
   * keeps a healthy channel from alarming. Defaults to the real service.
   */
  groupCrossCheck?: Pick<GroupCrossCheck, 'recordClassicInbound'>;
  /**
   * Inbound-message push broadcast (spec: inbound-message-push). Every FRESH
   * inbound message row fans a `message` push out to every subscribed staff
   * device. The real service by default (it no-ops when VAPID is unset); the
   * test harness injects a recorder.
   */
  pushService?: PushService;
}

/** Default wait before the one unknown-SID retry in /status (see above). */
const STATUS_UNKNOWN_SID_RETRY_DELAY_MS = 2_500;

// --- Delivery-failure severity taxonomy --------------------------------------
// Policy: a message that ends UNDELIVERED and won't be retried is a TERMINAL
// failure → log at ERROR (it degraded a real send, is operator-actionable, and
// feeds the hc-<env>-error-logs alarm + the Recent Errors panel). Two carve-outs
// stay WARN: a transient code we're still auto-retrying (not yet terminal), and a
// provider-side opt-out (21610 = correctly honoring STOP — the platform working,
// not a failure). See docs/GLOSSARY / the error-vs-warn decision rule.
const TRANSIENT_RETRYING_DELIVERY_CODES = new Set(['30003']);
const EXPECTED_NONFAILURE_DELIVERY_CODES = new Set(['21610']);

/**
 * True when an undelivered/failed delivery callback is a TERMINAL, operator-
 * actionable failure (→ log at ERROR). False for a transient code we auto-retry
 * (30003) or a provider-side opt-out (21610), which stay WARN. A failure with no
 * code, or any unrecognized code, is treated as terminal (fail loud, not silent).
 */
export function isTerminalDeliveryFailure(errorCode: string | undefined): boolean {
  if (errorCode !== undefined && EXPECTED_NONFAILURE_DELIVERY_CODES.has(errorCode)) return false;
  if (errorCode !== undefined && TRANSIENT_RETRYING_DELIVERY_CODES.has(errorCode)) return false;
  return true;
}

/**
 * The sender label for group/relay push bodies: roster name -> contact display
 * name -> formatted phone -> the raw From (spec 3.4 fallback chain). All three
 * inputs are already in scope at every persist point, so a push adds NO repo
 * lookup to the hot path. Pure, no I/O, no logging.
 */
function pushSenderLabel(
  rosterName: string | undefined,
  senderContact: ContactItem | undefined,
  from: string,
): string {
  const roster = typeof rosterName === 'string' ? rosterName.trim() : '';
  if (roster.length > 0) return roster;
  return contactDisplayName(senderContact) ?? formatPhoneForDisplay(from) ?? from;
}

/**
 * The push body for an inbound SMS/MMS (spec 3.4): the text when present, the
 * attachment line for a media-only message, and - when there is NEITHER text
 * nor media - empty on a 1:1 (the SW renders title-only) or the sender label
 * alone on a group/relay row, so the alert still says who acted. `sender`
 * prefixes group/relay bodies and is undefined for 1:1. Pure, no I/O.
 */
function pushMessageBody(body: string | undefined, mediaCount: number, sender?: string): string {
  const text = body !== undefined && body.length > 0 ? body : undefined;
  if (sender !== undefined) {
    if (text !== undefined) return capPushText(`${sender}: ${text}`, PUSH_BODY_MAX);
    if (mediaCount > 0) return capPushText(`${sender} sent an attachment.`, PUSH_BODY_MAX);
    return capPushText(sender, PUSH_BODY_MAX);
  }
  if (text !== undefined) return capPushText(text, PUSH_BODY_MAX);
  if (mediaCount > 0) return 'Sent an attachment.';
  return '';
}

export function createTwilioWebhookRouter(deps: TwilioWebhookDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const broadcasts = deps.broadcastsRepo ?? createBroadcastsRepo({ logger: deps.logger });
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const placementDeadlines =
    deps.placementDeadlinesRepo ?? createPlacementDeadlinesRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
  const poolNumbers = deps.poolNumbersRepo ?? createPoolNumbersRepo({ logger: deps.logger });
  const groupRail = deps.groupRailEnqueuer ?? createGroupRailEnqueuer({ logger: log });
  const groupCrossCheck = deps.groupCrossCheck ?? createGroupCrossCheck({ logger: log });
  const pushService = deps.pushService ?? createPushService({ config, logger: deps.logger });

  // (M1.10c) Failed-send escalation (doc §7.1): a delivery failure on a
  // placement-linked conversation (a relay/placement thread carries
  // conversation.placementId) raises that placement's attention flag so the boards
  // prompt a human to call — "the message failing must not mean the communication
  // fails, especially against voucher and RTA deadlines." Only ACTIVE
  // (non-terminal) placements escalate. Best-effort: a failure here NEVER 5xxs the
  // webhook. (1:1 threads aren't placement-linked today; escalating a 1:1 failure
  // to the tenant's placement is a later refinement — it needs picking among a
  // tenant's placements, a product decision.)
  async function flagPlacementAttention(conversationId: string, reason: string): Promise<void> {
    try {
      const conv = await conversations.getById(conversationId);
      const placementId =
        typeof conv?.placementId === 'string' && conv.placementId.length > 0 ? conv.placementId : undefined;
      if (placementId === undefined) return;
      const c = await placements.getById(placementId);
      if (!c || TERMINAL_STAGES.has(c.stage)) return; // only active placements escalate
      const updated = await placements.update(placementId, { attention: { reason, at: new Date().toISOString() } });
      // Recompute the soonest deadline so the event PRESERVES the placement's
      // pending rta_window/voucher_expiration chip. This escalation only raises
      // `attention` — it never arms/retires a deadline — so emitting with NO
      // `next` (null) would blank a live chip on the dashboard's in-place patch.
      const ds = await placementDeadlines.listByPlacement(placementId);
      events.emit('placement.updated', toPlacementUpdatedEvent(updated, soonestDeadline(ds)));
      log.warn(
        { event: 'placement_escalation', placementId, conversationId, reason },
        'failed send on an active placement — attention flag raised',
      );
    } catch (err) {
      log.error({ err, conversationId }, 'placement escalation: flagging attention failed (non-fatal)');
    }
  }
  const captureContact = createContactCapture({
    contactsRepo: contacts,
    conversationsRepo: conversations,
    auditRepo: audit,
    logger: deps.logger,
  });
  const ourNumberKind = createOurNumberKind({ config, conversations });
  const statusRetryDelayMs = deps.statusUnknownSidRetryDelayMs ?? STATUS_UNKNOWN_SID_RETRY_DELAY_MS;

  /**
   * Fire-and-forget inbound-message push broadcast (spec D11): the promise is
   * deliberately NOT awaited, so a slow or failing push can never delay or fail
   * the webhook ack (the same pattern as the pre-ring voice push). The payload
   * is FLAT - the service worker reads kind/conversationId at the JSON root.
   */
  function emitMessagePush(title: string, body: string, conversationId: string): void {
    void pushService
      .sendToAll({
        kind: 'message',
        payload: {
          title: capPushText(title, PUSH_TITLE_MAX),
          body,
          kind: 'message',
          conversationId,
        },
      })
      .catch((err: unknown) => {
        log.warn({ err, conversationId }, 'inbound message push failed (fire-and-forget)');
      });
  }

  const router = Router();
  const verifySignature = twilioSignatureMiddleware({
    authToken: config.twilioAuthToken,
    publicBaseUrl: config.publicBaseUrl,
    nodeEnv: config.nodeEnv,
    logger: log,
  });

  // ---------------------------------------------------------------------
  // Relay-group inbound (M1.7): To is a pool number → persist ONCE on the
  // relay thread + enqueue fan-out to the OTHER members. Never the 1:1 path.
  // Side-effect failures NEVER 5xx (a redelivery dedupes at the append and
  // re-runs the idempotent steps); failures are ERROR-logged + alarmed.
  // ---------------------------------------------------------------------
  /** Parse Twilio's NumMedia / MediaUrl{i} form fields into a list of URLs. */
  function parseInboundMediaUrls(params: WebhookParams): string[] {
    const numMedia = Number(params['NumMedia'] ?? 0) || 0;
    const urls: string[] = [];
    for (let i = 0; i < numMedia; i++) {
      const url = params[`MediaUrl${i}`];
      if (typeof url === 'string' && url.length > 0) urls.push(url);
    }
    return urls;
  }

  /**
   * Mirror inbound MMS media into S3 under media/<conversationId>/<MessageSid>/<i>
   * (streams only) and record the resulting {s3Key, contentType} attachments on
   * the message (media_attachments), which the authed
   * GET /api/messages/:sid/media/:idx endpoint serves. SHARED by
   * the 1:1 and relay inbound paths. Best-effort: MEDIA_BUCKET unset → log + skip;
   * a per-attachment failure leaves a usable message (provider URLs stay on the
   * item) + a correlated ERROR — never a crash. PII (doc §9): SIDs/indexes/counts
   * only, never the URL or the bytes.
   */
  async function mirrorInboundMedia(input: {
    mediaUrls: string[];
    messageSid: string;
    conversationId: string;
    tsMsgId: string;
    params: WebhookParams;
  }): Promise<void> {
    const { mediaUrls, messageSid, conversationId, tsMsgId, params } = input;
    if (mediaUrls.length === 0) return;
    if (!mediaStore) {
      const line = 'inbound MMS media NOT mirrored — MEDIA_BUCKET is not configured';
      if (config.nodeEnv === 'production') log.error({ providerSid: messageSid, mediaCount: mediaUrls.length }, line);
      else log.warn({ providerSid: messageSid, mediaCount: mediaUrls.length }, line);
      return;
    }
    const attachments: MediaAttachment[] = [];
    for (const [i, url] of mediaUrls.entries()) {
      const key = `media/${conversationId}/${messageSid}/${i}`;
      let stream: Readable | undefined;
      try {
        stream = await adapter.getMediaStream(url);
        // Normalize the SENDER-supplied MediaContentType before storing: keep it
        // only if it's an allowlisted inline type, else store octet-stream — so
        // a dangerous type (text/html, image/svg+xml) never enters S3 metadata
        // (defense-in-depth with the serve-time allowlist). Stored-XSS guard.
        // The same normalized type is recorded on the message (key+type together).
        const contentType = normalizeStoredMediaType(params[`MediaContentType${i}`]);
        await mediaStore.put(key, stream, contentType);
        attachments.push({ s3Key: key, contentType });
      } catch (err) {
        // Destroy the source stream so a failed put (S3 5xx, network drop) doesn't
        // leak the upstream socket/handle — lib-storage won't on a caller stream.
        if (stream !== undefined && !stream.destroyed) stream.destroy();
        log.error(
          { err, providerSid: messageSid, mediaIndex: i },
          'media mirror failed — message record keeps the provider URL',
        );
      }
    }
    if (attachments.length > 0) {
      try {
        await messages.annotateMessage(conversationId, tsMsgId, { mediaAttachments: attachments });
      } catch (err) {
        log.error({ err, providerSid: messageSid }, 'failed to record mirrored media keys on the message');
      }
    }
  }

  async function handleRelayInbound(
    relay: ConversationItem,
    msg: {
      MessageSid: string;
      From: string;
      To: string;
      Body: string | undefined;
      params: WebhookParams;
    },
  ): Promise<void> {
    const { MessageSid, From, Body } = msg;
    mergeContext({ conversationId: relay.conversationId });

    // Inbound MMS into a relay thread (tenant<->landlord photos/docs). Capture
    // the provider media URLs so the message records the attachment, and mirror
    // them to S3 below (the 1:1 path does the same). The relay fan-out reads the
    // mirrored media_attachments off this source message and forwards them ON to
    // the other members (presigned per leg) - media relay is now real in both
    // directions (jobs/relayFanOut.ts).
    const mediaUrls = parseInboundMediaUrls(msg.params);

    // Identify the sender = the member whose phone == From. A former member
    // (removed mid-thread) is NOT found here — we still persist for the audit
    // trail but do NOT fan out (the message reached a number they were once
    // on). The member key is contactId-or-phone (relayMemberKey).
    const roster = relay.participants ?? [];
    const sender = roster.find((m) => m.phone === From);
    const senderKey = sender ? relayMemberKey(sender) : `phone#${From}`;

    // Author honesty: only a reviewed contact type claims tenant/landlord;
    // a stub/unknown sender is `unknown` (same rule as the 1:1 path).
    const senderContact = sender?.contactId ? await contacts.getById(sender.contactId) : undefined;
    const author =
      senderContact?.type === 'landlord' ||
      senderContact?.type === 'tenant' ||
      senderContact?.type === 'partner'
        ? senderContact.type
        : 'unknown';

    const isClosed = relay.status !== 'open';
    const providerTs = new Date().toISOString();
    // Persist the relay message ONCE on the relay thread (idempotent MessageSid
    // append). Direction inbound; relay_sender_key records who sent it. Seed an
    // EMPTY delivery_recipients map on the SOURCE message so the fan-out's
    // child-only setRecipientDelivery has a parent map to write into (DynamoDB
    // forbids seeding a map and a child in one expression). The fan-out resolves
    // current membership at run time, so the per-member slots are filled there.
    const appended = await messages.append({
      conversationId: relay.conversationId,
      providerSid: MessageSid,
      providerTs,
      type: mediaUrls.length > 0 ? 'mms' : 'sms',
      direction: 'inbound',
      author,
      deliveryStatus: 'delivered',
      relaySenderKey: senderKey,
      deliveryRecipients: {},
      ...(Body !== undefined && Body.length > 0 && { body: Body }),
      ...(mediaUrls.length > 0 && { mediaUrls }),
    });

    // Mirror MMS media to S3 on the FIRST delivery only (a redelivery is deduped
    // → already mirrored). Best-effort (mirrorInboundMedia never throws).
    if (!appended.deduped) {
      await mirrorInboundMedia({
        mediaUrls,
        messageSid: MessageSid,
        conversationId: relay.conversationId,
        tsMsgId: appended.tsMsgId,
        params: msg.params,
      });
    }

    // Classify the inbound body/OptOutType ONCE via the shared detector (spec
    // 3.1). STOP-family and HELP are ALWAYS commands to the SYSTEM: they SKIP
    // the fan-out below and are processed against the sender's own 1:1 further
    // down - never relayed to the other members. A body that merely CONTAINS a
    // keyword is undefined here and relays exactly as today.
    //
    // W3 (human ruling 2026-07-18): a bare OPT-IN keyword (YES/HOME/START/JOIN/
    // UNSTOP) is a command ONLY from a CURRENTLY-SUPPRESSED sender (a genuine
    // re-subscribe). From an UNSUPPRESSED sender it is ORDINARY GROUP CONTENT -
    // in a tour-scheduling group "Yes" is the single most common one-word reply -
    // so it relays exactly like a non-keyword message (no keyword processing, no
    // reply, no flag writes, no annotation). ONE decision is computed here and
    // used by BOTH the fan-out guard AND the keyword-processing block below so
    // they can never diverge.
    //
    // W4 (SF-2) OptOutType coupling, REWRITTEN 2026-08-12 - the premise flipped.
    // Advanced Opt-Out is now ON, configured with OUR filed copy (RUNBOOK
    // "Keyword auto-replies (Advanced Opt-Out)"), so classifyInboundKeyword
    // trusting OptOutType is the LIVE intended path here, not a hypothetical.
    // It is bounded because Twilio stamps OptOutType on EXACT keyword messages
    // only (Twilio docs, and the dev keyword canary's sentence probe): a full
    // sentence like "stop the listings but keep the tour" is NOT stamped, so it
    // is not reclassified and still fans out as ordinary group content. The W3
    // narrowing above additionally guards the bare-YES opt-in case.
    //
    // Operators must NOT turn Advanced Opt-Out back OFF: it is the ONLY source
    // of keyword confirmations now - the app composes and sends none - so
    // flipping it off silently removes every STOP/HELP/START reply while this
    // code keeps recording as if nothing changed.
    const kind = classifyInboundKeyword(Body, msg.params['OptOutType']);
    // A keyword is a command by default; an opt-in narrows to command ONLY when
    // the sender is currently suppressed. This ONE boolean drives both the
    // fan-out guard and the keyword-processing block (they must never diverge).
    let isCommand = kind !== undefined;
    if (kind === 'opt_in') {
      // For a roster member check the member; for a non-member/unknown sender
      // synthesize a minimal participant carrying just the phone (contactId ''
      // -> the shared predicate resolves by phone, the honest lookup for a
      // non-roster sender).
      const member: ConversationParticipant = sender ?? { contactId: '', phone: From };
      try {
        isCommand = await isMemberSuppressed(contacts, conversations, member);
      } catch (err) {
        // Fail CLOSED: an indeterminate suppression state must never cause a
        // relay, so treat the opt-in as a command (not fanned out) - consistent
        // with every other suppression read in this codebase. PII: SID + kind
        // only, never a phone.
        log.error(
          { err, providerSid: MessageSid, kind },
          'relay opt-in suppression check failed - treating as a command (fail closed, not relayed)',
        );
        isCommand = true;
      }
    }

    // Closed-group defensive guard: the router only reaches this branch on the
    // unknown-sender fallback (a member's late text is intercepted into the 1:1
    // before this). Persist for the record, NEVER fan out - the group is over.
    if (isClosed) {
      log.info({ providerSid: MessageSid }, 'relay inbound on a CLOSED thread — persisted, no fan-out');
    } else if (!sender) {
      // Removed-member reply: persisted for the audit trail, no fan-out (they
      // are no longer a current participant).
      log.info({ providerSid: MessageSid }, 'relay inbound from a non-member — persisted, no fan-out');
    } else if (isCommand) {
      // A command keyword (STOP-family, HELP, or an opt-in from a suppressed
      // sender - see the isCommand narrowing above) is a message to the SYSTEM,
      // not group content: persisted above for the audit trail, processed below,
      // and NEVER relayed to the other members. (An opt-in from an unsuppressed
      // sender has isCommand=false and falls through to the fan-out below.)
      log.info(
        { providerSid: MessageSid, kind },
        'relay inbound keyword - processed, not fanned out',
      );
    } else if (!appended.deduped) {
      // Current member, open thread, fresh message → fan out immediately
      // (enqueueImmediate → SQS DelaySeconds 0, no EventBridge 60s floor). A
      // redelivery (deduped) does NOT re-enqueue: the original fan-out is
      // guarded by its own job marker + per-recipient terminal skips.
      try {
        await enqueueImmediate(RELAY_FANOUT_JOB, {
          relayConversationId: relay.conversationId,
          sourceTsMsgId: appended.tsMsgId,
          senderKey,
        });
      } catch (err) {
        log.error({ err, providerSid: MessageSid }, 'relay fan-out enqueue failed — message persisted, not relayed');
      }
    }

    // Inbox touch + unread + SSE — reuse the shared helpers (fresh-append only,
    // same as the 1:1 path: a redelivery must not double-count/re-emit).
    let touched: ConversationItem | undefined;
    try {
      if (!appended.deduped) await conversations.incrementUnread(relay.conversationId);
      touched = await conversations.touchLastActivity(relay.conversationId, Body || undefined, providerTs);
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'relay touchLastActivity/unread failed — message persisted, inbox stale');
    }
    if (!appended.deduped) {
      events.emit('message.persisted', {
        conversationId: relay.conversationId,
        tsMsgId: appended.tsMsgId,
        direction: 'inbound',
        deliveryStatus: 'delivered',
      });
      if (touched) events.emit('conversation.updated', toConversationUpdatedEvent(touched));
      // Inbound-message push. A SIBLING of the braceless `if (touched)` above -
      // NEVER nested under it: a touchLastActivity failure must not suppress the
      // alert. Every relay arm (closed / removed-member / keyword / fresh) falls
      // through to this one block, so one emit covers every persisted relay row.
      emitMessagePush(
        relayThreadLabel(relay),
        pushMessageBody(Body, mediaUrls.length, pushSenderLabel(sender?.name, senderContact, From)),
        relay.conversationId,
      );
    }

    // Keyword processing (spec 3.2): the SHARED seam runs against the sender's
    // OWN 1:1 (closed-intercept idiom) - the conversation opt-out flag must land
    // on their per-phone thread, NEVER on the relay group. The keyword message
    // itself stays on the relay thread (persisted above for the audit trail).
    // Gated on isCommand (NOT kind): an unsuppressed opt-in is content and was
    // already fanned out above, so it must skip keyword processing entirely.
    if (isCommand) {
      const effectiveContact = senderContact ?? (await contacts.findByPhone(From));
      const oneToOne = await conversations.createOrGetByParticipantPhone(
        From,
        conversationTypeFor(effectiveContact),
      );
      await processInboundKeywords({
        conversation: oneToOne,
        effectiveContact,
        From,
        Body,
        OptOutType: msg.params['OptOutType'],
        MessageSid,
      });
      // Immediate staff visibility (spec 3.4): a display/attention ANNOTATION for
      // a CURRENT roster member only; suppression truth lives in the flags (3.3),
      // never in this map. Best-effort - a failure NEVER crashes the webhook (the
      // message is persisted and the compliance flags are already written).
      if (sender) {
        try {
          if (kind === 'opt_out') {
            await conversations.setRelayMemberOptedOut(relay.conversationId, senderKey, {
              ...(sender.contactId !== undefined &&
                sender.contactId.length > 0 && { contactId: sender.contactId }),
              phone: sender.phone,
              ...(sender.name !== undefined && { name: sender.name }),
              at: new Date().toISOString(),
            });
          } else if (kind === 'opt_in') {
            await conversations.clearRelayMemberOptedOut(relay.conversationId, senderKey);
          }
        } catch (err) {
          log.error(
            { err, providerSid: MessageSid, memberKey: logSafeMemberKey(sender) },
            'relay keyword annotation failed - flags recorded, attention item stale until next fan-out',
          );
        }
      }
    }

    log.info(
      {
        providerSid: MessageSid,
        direction: 'inbound',
        bodyLength: Body?.length ?? 0,
        closed: isClosed,
        fannedOut: !isClosed && Boolean(sender) && !appended.deduped && !isCommand,
        keyword: isCommand,
      },
      'twilio relay inbound message processed',
    );
  }

  // ---------------------------------------------------------------------
  // Keyword handling (STOP / HELP / opt-in) - spec sec 6, TWILIO owns the replies.
  // Extracted from the /sms handler so the closed-group intercept can REUSE the
  // SAME logic path (relay-number-lifecycle AF-4: a closed-group member's STOP
  // to the pool number must suppress exactly like a STOP to the main number did
  // pre-feature, when a closed group's cleared number fell through to the 1:1).
  // Suppression writes go through the SHARED number-scoped seam
  // (services/numberSuppression.ts): conversation flag always, CONTACT flag only
  // on the primary number (BE1 number-scope). This function keeps the consent
  // stamps and the audit source tag. It composes NO reply - Twilio's Advanced
  // Opt-Out answers STOP/HELP/START with the copy filed in messages/catalog.ts
  // (module header). Best-effort: a repo failure is logged and NEVER crashes the
  // webhook (the message is already persisted). PII: SIDs/IDs only.
  //
  // GROUP TEXTING (spec 4.4): the target conversation may be a LAZY THUNK. The
  // group path runs this seam on EVERY group inbound - the plain-inbound
  // contact-level consent stamp lives here - but must NOT mint the sender's 1:1
  // thread for a plain inbound or a HELP, which would leave an empty
  // needs-triage inbox row per group member. The thunk is therefore called only
  // inside the opt-out/opt-in block, where setSmsOptOut genuinely needs a
  // target. Passing a ConversationItem (every 1:1/relay caller) is unchanged.
  // ---------------------------------------------------------------------
  async function processInboundKeywords(input: {
    conversation: ConversationItem | (() => Promise<ConversationItem>);
    effectiveContact: ContactItem | undefined;
    From: string;
    Body: string | undefined;
    OptOutType: string | undefined;
    MessageSid: string;
    /** Extra audit detail (group provenance, spec 4.4). Absent on 1:1. */
    auditContext?: Record<string, unknown>;
  }): Promise<void> {
    const {
      conversation,
      effectiveContact,
      From,
      Body,
      OptOutType,
      MessageSid,
      auditContext,
    } = input;
    try {
      const kind = classifyInboundKeyword(Body, OptOutType);
      const isHelp = kind === 'help';
      const optedOut = kind === 'opt_out';
      const optedIn = kind === 'opt_in';

      // Spec sec 3.2: ANY customer-initiated inbound confers inbound_text consent,
      // so a later staff reply is never JIT-gated ("a reply in a contact-started
      // conversation is always allowed"). A brand-new unknown phone is already
      // stamped when its stub is minted (services/contactCapture.ts); the gap this
      // closes is an EXISTING contact (e.g. one added via the contact form with no
      // consent) who then texts in - stamp them here too. Restricted to a PLAIN
      // inbound: an opt-out is a revocation (don't stamp), and the opt-in branch
      // below does its own primary-number-scoped stamp. Idempotent - only when
      // consent_method is absent (never overwrites a web_form/verbal record).
      if (
        effectiveContact &&
        !effectiveContact.consent_method &&
        !isHelp &&
        !optedOut &&
        !optedIn
      ) {
        await contacts.update(effectiveContact.contactId, {
          consent_method: 'inbound_text',
          consent_at: new Date().toISOString(),
        });
      }

      // HELP has NO branch of its own any more. It never changed suppression and
      // it no longer draws a reply (Twilio answers HELP - on the live service it
      // usually consumes the message before this webhook sees it at all), so the
      // only thing HELP still does here is EXCLUDE itself from the plain-inbound
      // consent stamp above. That exclusion is why `isHelp` survives, and why no
      // conversation is resolved on a HELP - which is exactly what the lazy thunk
      // below exists for.
      if (optedOut || optedIn) {
        const source =
          OptOutType === 'STOP' || OptOutType === 'START' ? 'OptOutType' : 'keyword';
        // The one number-scoped suppression writer (BE1): the CONVERSATION flag
        // always - a STOP from a phone with no contact record yet (auto-capture
        // is M1.2) must still suppress every later send - and the CONTACT flag
        // only when the keyword arrived on the contact's PRIMARY number. A STOP
        // on an ATTACHED secondary number must not contaminate the primary.
        // This is where the lazy target is finally resolved.
        const applied = await applyNumberSuppression(
          { contactsRepo: contacts, conversationsRepo: conversations, auditRepo: audit, logger: log },
          {
            phone: From,
            suppressed: optedOut,
            contact: effectiveContact,
            conversation:
              typeof conversation === 'function' ? conversation : async () => conversation,
            source,
            providerSid: MessageSid,
            ...(auditContext !== undefined && { auditContext }),
          },
        );
        // Opt-in (START/JOIN/HOME/YES/UNSTOP) is a documented affirmative
        // opt-in (spec sec 6): if this (primary-number) contact has NO
        // consent_method yet, stamp inbound_text so proactive sends aren't
        // JIT-gated. Idempotent - only stamped when absent (never overwrites
        // a web_form / verbal record). Best-effort inside the same try.
        if (optedIn && effectiveContact && applied.scope === 'primary' && !effectiveContact.consent_method) {
          await contacts.update(effectiveContact.contactId, {
            consent_method: 'inbound_text',
            consent_at: new Date().toISOString(),
          });
        }
        // NO REPLY IS COMPOSED HERE. `keyword.stop` and `welcome.sms` remain the
        // filed copy Twilio's Advanced Opt-Out is configured WITH; the app sends
        // neither (see the module header).
      }
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'opt-out recording failed - message persisted, flag NOT updated');
    }
  }

  // ---------------------------------------------------------------------
  // Late text on a CLOSED relay group (relay-number-lifecycle, spec 3.1 step
  // 3): the sender is only on a CLOSED group's roster for this pool number, so
  // instead of appending to the dead group, deliver the message into their OWN
  // 1:1 tenant/landlord thread (the public-intake idiom) tagged with
  // via_closed_group provenance. No fan-out to old members, no auto-reply; the
  // closed GROUP transcript receives nothing (the 1:1-with-provenance is
  // strictly more useful and never pollutes group history). STOP/opt-out IS
  // processed here (AF-4) via the shared processInboundKeywords path so a
  // closed-group member's STOP suppresses exactly like a STOP to the main
  // number does. Neither path replies any more (module header).
  // ---------------------------------------------------------------------
  async function handleClosedGroupInbound(
    group: ConversationItem,
    msg: {
      MessageSid: string;
      From: string;
      Body: string | undefined;
      params: WebhookParams;
    },
  ): Promise<void> {
    const { MessageSid, From, Body } = msg;
    const mediaUrls = parseInboundMediaUrls(msg.params);

    // INVARIANT 13.1, THE FIFTH FILING PATH. This intercept runs at step (1.5),
    // BEFORE the group block at (1.75) computes an envelope at all - so a
    // carrier-group message that happens to include a RETIRED POOL NUMBER (the
    // population `docs/issues/group-mms-including-pool-numbers.md` describes)
    // lands here and is filed as ONE contact's 1:1 speech. The ROUTING decision
    // stays exactly as it is (relay behavior is unchanged - invariant 13.6);
    // what changes is that the filing is no longer silent. `parseOtherRecipients`
    // is pure property access on the already-parsed body, so this costs no I/O.
    const envelopeBearing = parseOtherRecipients(msg.params).length > 0;
    if (envelopeBearing) {
      warnEnvelopeViaClosedRelay(
        { event: 'group_envelope_via_closed_relay_group', providerSid: MessageSid },
        'a carrier group envelope arrived on a pool number whose groups are all CLOSED - intercepted into the sender 1:1, no native thread minted',
      );
    }

    // Resolve the sender's 1:1 thread exactly as the public-intake path does:
    // honest conversation typing (only a reviewed contact type yields a typed
    // thread), then createOrGetByParticipantPhone.
    const contact = await contacts.findByPhone(From);
    const conversation = await conversations.createOrGetByParticipantPhone(
      From,
      conversationTypeFor(contact),
    );
    mergeContext({ conversationId: conversation.conversationId });

    const providerTs = new Date().toISOString();
    const appended = await messages.append({
      conversationId: conversation.conversationId,
      providerSid: MessageSid,
      providerTs,
      type: mediaUrls.length > 0 ? 'mms' : 'sms',
      direction: 'inbound',
      // Same honesty rule as the 1:1 path: only a reviewed contact type may
      // claim tenant/landlord/partner authorship; everything else is `unknown`.
      author:
        contact?.type === 'landlord' || contact?.type === 'tenant' || contact?.type === 'partner'
          ? contact.type
          : 'unknown',
      // Inbound messages are received by definition.
      deliveryStatus: 'delivered',
      // Provenance: the pool number this reached only matches From on the CLOSED
      // group <group.conversationId>. The dashboard badges the 1:1 bubble off it.
      viaClosedGroup: group.conversationId,
      // THE EXTRACTION MARKER STAYS ON THIS PATH (fix wave 2, contest X1;
      // re-review conformance F1 overturned wave 1's removal). Spec 13.1
      // enumerates FIVE exceptions and says all five are "alarmed, marked with
      // `group_ambiguous_origin`, and extraction-suppressed" - (e) is this path.
      // The spec also answers the invariant-6 objection wave 1 raised, in its
      // own words: "(d) and (e) are ROUTING decisions that predate this feature
      // and are deliberately unchanged (invariant 6); what fix waves 2 and 4
      // changed is that the filing is no longer silent."
      //
      // The marker has exactly ONE consumer - jobs/extraction.ts's transcript
      // filter - so it changes no relay routing, no relay message, no relay UI
      // and no relay delivery; 13.6 is untouched. And this path carries POSITIVE
      // proof of group content (parseOtherRecipients already returned members),
      // unlike the tripwire heuristic, whose separate ruling stays with
      // docs/issues/tripwire-extraction-scope.md. Without the marker a carrier
      // group that happens to include a retired pool number is fed to AI fact
      // extraction as ONE contact's own words - the exact harm the marker
      // exists to prevent. DO NOT REMOVE IT AGAIN without amending spec 13.1.
      ...(envelopeBearing && { groupAmbiguousOrigin: true }),
      ...(Body !== undefined && Body.length > 0 && { body: Body }),
      ...(mediaUrls.length > 0 && { mediaUrls }),
    });

    // Mirror MMS media on the FIRST delivery only (a redelivery is deduped ->
    // already mirrored). Best-effort (mirrorInboundMedia never throws).
    if (!appended.deduped) {
      await mirrorInboundMedia({
        mediaUrls,
        messageSid: MessageSid,
        conversationId: conversation.conversationId,
        tsMsgId: appended.tsMsgId,
        params: msg.params,
      });
    }

    // Inbox touch + unread + SSE - the minimal 1:1 subset (fresh-append only, so
    // a redelivery never double-counts/re-emits). Side-effect failures never
    // crash the webhook.
    let touched: ConversationItem | undefined;
    try {
      if (!appended.deduped) await conversations.incrementUnread(conversation.conversationId);
      touched = await conversations.touchLastActivity(
        conversation.conversationId,
        Body || undefined,
        providerTs,
      );
    } catch (err) {
      log.error(
        { err, providerSid: MessageSid },
        'closed-group late text touchLastActivity/unread failed - message persisted, inbox stale',
      );
    }
    if (!appended.deduped) {
      events.emit('message.persisted', {
        conversationId: conversation.conversationId,
        tsMsgId: appended.tsMsgId,
        direction: 'inbound',
        deliveryStatus: 'delivered',
      });
      if (touched) events.emit('conversation.updated', toConversationUpdatedEvent(touched));
      // Inbound-message push, 1:1 semantics (the row filed into the SENDER's own
      // 1:1, not the dead group): no sender prefix, and the deep link goes to
      // that 1:1. A SIBLING of the braceless `if (touched)` above, never nested.
      emitMessagePush(
        contactDisplayName(contact) ??
          (typeof conversation.participant_display_name === 'string' &&
          conversation.participant_display_name.length > 0
            ? conversation.participant_display_name
            : undefined) ??
          formatPhoneForDisplay(From) ??
          From,
        pushMessageBody(Body, mediaUrls.length),
        conversation.conversationId,
      );
    }
    // PII (doc sec 9): IDs only - never the sender phone. viaGroup = the closed
    // group's id; conversationId = the 1:1 the text was intercepted into.
    log.info(
      { conversationId: conversation.conversationId, viaGroup: group.conversationId },
      'relay late text on closed group - delivered to 1:1 with provenance',
    );

    // AF-4: process STOP / HELP / opt-in on the 1:1 the text landed in, using the
    // SAME keyword path as the main-number 1:1 inbound. A closed-group member's
    // STOP must register the opt-out (conversation + primary-number contact
    // flags) so later 1:1/relay sends are gated - restoring the pre-feature
    // behavior (a closed group's cleared number fell through to the 1:1 STOP
    // block). The message already landed above.
    //
    // THE MARKER/REPLY DISAGREEMENT THIS COMMENT USED TO EXPLAIN IS GONE (fix
    // wave 4 item 10, retired 2026-08-12). The extraction MARKER is still set
    // only for an envelope-bearing inbound - it asks "might this text be group
    // content?", it is extraction hygiene, and it has exactly one consumer
    // (jobs/extraction.ts's transcript filter). The keyword REPLY that used to
    // ride this path unconditionally no longer exists on ANY path, so there is
    // nothing left for the two to disagree about. That IS a relay-visible
    // change - a closed-group member's STOP used to draw the app's confirmation
    // here - and it is deliberate: Twilio now sends that confirmation itself,
    // and keeping ours would double it (which invariant 13.6 never asked for).
    await processInboundKeywords({
      conversation,
      effectiveContact: contact,
      From,
      Body,
      OptOutType: msg.params['OptOutType'],
      MessageSid,
    });
  }

  // ---------------------------------------------------------------------
  // NATIVE GROUP TEXT detection (group-texting spec 5).
  //
  // A carrier group text to the business number arrives at THIS webhook looking
  // exactly like a 1:1 except for the undocumented `OtherRecipients{N}` params.
  // Everything below turns that envelope into a native `group_text` thread.
  // ---------------------------------------------------------------------

  /** How long the pool-number list is reused before re-reading (spec 4.1). */
  const GROUP_EXCLUSION_CACHE_TTL_MS = 60_000;
  /** Minimum gap between tripwire WARNs (spec 8.1 - the signal is the RATE). */
  const GROUP_ENVELOPE_MISSING_WARN_INTERVAL_MS = 5 * 60_000;
  /**
   * Minimum gap between rail re-enqueues for a thread whose last attempt FAILED
   * (fix wave 5, adversarial 35). Long enough that a chatty group cannot flood
   * the shared jobs queue with certain-to-fail work, short enough that a genuine
   * transient (a 429 during a migration burst) still heals within a few minutes.
   */
  const RAIL_REQUEUE_BACKOFF_MS = 5 * 60_000;

  /**
   * Threads already reported as structurally unrailable (fix wave 2, adversarial
   * 15). The condition is permanent, so the line is worth exactly once per
   * thread per process - and the durable reader is the migration convergence
   * report, not this log. Bounded so the set cannot grow without limit; past the
   * bound it STOPS REMEMBERING rather than forgetting what it knows (see the
   * call site).
   */
  const unrailableRostersLogged = new Set<string>();
  const UNRAILABLE_LOG_MEMORY = 500;

  let poolNumberCache: { at: number; numbers: string[] } | undefined;
  const warnEnvelopeMissing = createRateLimitedWarn({
    logger: log,
    intervalMs: GROUP_ENVELOPE_MISSING_WARN_INTERVAL_MS,
  });
  /**
   * PER-EVENT DAMPERS (fix wave 5, adversarial 15). These three say completely
   * different things and must not share one throttle. They used to: ONE closure
   * served `group_envelope_via_closed_relay_group`,
   * `group_detection_unconfigured` and `group_envelope_off_business_number`, and
   * `group_detection_unconfigured` IS the chatty one - an unset
   * BUSINESS_PHONE_NUMBER fires it on every envelope-bearing inbound. Its
   * emissions refreshed the shared `lastEmittedAt`, so for the whole window the
   * other two - the events that say "a group envelope landed on a number we do
   * not own" - were never emitted at all, and whichever event next won carried
   * the COMBINED `suppressedCount`, mis-attributing hundreds of occurrences to
   * the wrong event. This is the same reasoning that already gave the tripwire
   * its own damper, applied inside the unminted family.
   */
  const warnEnvelopeViaClosedRelay = createRateLimitedWarn({
    logger: log,
    intervalMs: GROUP_ENVELOPE_MISSING_WARN_INTERVAL_MS,
  });
  const warnDetectionUnconfigured = createRateLimitedWarn({
    logger: log,
    intervalMs: GROUP_ENVELOPE_MISSING_WARN_INTERVAL_MS,
  });
  const warnEnvelopeOffBusinessNumber = createRateLimitedWarn({
    logger: log,
    intervalMs: GROUP_ENVELOPE_MISSING_WARN_INTERVAL_MS,
  });

  /**
   * The exclusion set group identity subtracts (spec 4.1): our business number,
   * every relay pool number, and the deploy-fixed config list.
   *
   * `groupIdentity` is deliberately PURE, so assembling this is the caller's
   * job. The pool list is the only part that needs I/O; it is cached because it
   * changes on the order of weeks and this runs on every group inbound.
   * STALE-IF-ERROR: a refresh failure reuses the last good list rather than
   * silently shrinking the exclusion set, which would fork every id derived
   * while the read is broken.
   *
   * COLD START HAS NO STALE LIST, so there is nothing to be stale-if-error
   * WITH. Installing an empty one would do the exact thing the paragraph above
   * forbids - and it would ALSO silence `poolNumbersInEnvelope`, the one signal
   * that says a pool number is in this roster, because that anomaly is computed
   * from the same set. A wrong id is permanent data; a 1:1 refile is
   * recoverable. So a cold-start failure THROWS and the caller refuses the
   * group branch for this inbound.
   */
  async function groupExclusions(): Promise<GroupExclusionSet> {
    const now = Date.now();
    if (poolNumberCache === undefined || now - poolNumberCache.at >= GROUP_EXCLUSION_CACHE_TTL_MS) {
      try {
        const active = await poolNumbers.listActive();
        poolNumberCache = { at: now, numbers: active.map((p) => p.poolNumber) };
      } catch (err) {
        if (poolNumberCache === undefined) {
          log.error(
            { err, hadCache: false },
            'group identity: pool-number read failed with NO cached list - refusing to derive a group id from an incomplete exclusion set',
          );
          throw err;
        }
        log.error(
          { err, hadCache: true },
          'group identity: pool-number read failed - reusing the last known list for the exclusion set',
        );
        // Keep the stale entry but do not re-stamp `at`, so the next inbound retries.
      }
    }
    const cached = poolNumberCache;
    if (cached === undefined) {
      // Unreachable: the try either assigns or (cold) throws above.
      throw new Error('group identity: pool-number exclusion list unavailable');
    }
    return {
      businessPhoneNumber: config.businessPhoneNumber,
      poolNumbers: cached.numbers,
      configuredNumbers: config.groupIdentityExcludedNumbers,
    };
  }

  /** Best-effort rail (re-)enqueue. NEVER crashes the webhook (spec 15.3). */
  async function ensureRailEnqueued(
    thread: ConversationItem,
    reason: 'created' | 'rail_missing',
    providerSid: string,
  ): Promise<void> {
    if (reason === 'rail_missing' && hasActiveGroupRail(thread)) return;
    // BACK-OFF ON A KNOWN-FAILING RAIL (fix wave 5, adversarial 35). Branch (b)
    // re-enqueues on EVERY inbound to a rail-less group thread, which is exactly
    // right for the create-then-crash window it exists to close - but for a
    // thread whose rail can never be built (a landline member -> Twilio 50407,
    // a roster past the participant cap) it fed a certain-to-fail job into the
    // SHARED jobs queue that relay fan-out, broadcasts and tour reminders use,
    // once per inbound, forever, with no back-off at all.
    //
    // This is also the READER `rail_failed` never had (adversarial 10). It only
    // means anything now that a successful finalize CLEARS the field, so a
    // healed thread is not held back by a failure it recovered from.
    if (reason === 'rail_missing') {
      const roster = thread.participants ?? [];
      if (roster.length === 0 || roster.length > MAX_RAIL_MEMBERS) {
        // STRUCTURAL: no retry can change this, so do not queue one at all. The
        // thread stays inbound-only and the thread view says so.
        //
        // ONCE PER THREAD, NOT ONCE PER INBOUND (fix wave 2, adversarial 15).
        // The condition is permanent, so repeating the line on every message to
        // an active group buries everything around it. The READER that makes
        // this thread visible to a human is the migration convergence report,
        // which lists a structurally unrailable roster as ADJUDICATION-REQUIRED
        // (lib/import/convertGroups.ts); this line is the live-traffic echo of
        // the same fact, and one is enough.
        if (!unrailableRostersLogged.has(thread.conversationId)) {
          // AT THE CAP WE STOP REMEMBERING; WE DO NOT FORGET EVERYTHING (fix
          // wave 4, item 10). Clearing the set turned the bound into a
          // PERIODIC FLUSH: past 500 unrailable threads, every 501st one wiped
          // the memory of the other 500, and each of them logged again on its
          // next inbound - so on a stack that has passed the cap the line goes
          // from "once per thread" back to something close to once per message,
          // which is exactly what this guard exists to prevent. Not adding past
          // the cap degrades honestly instead: the first 500 stay quiet and only
          // the tail repeats.
          if (unrailableRostersLogged.size < UNRAILABLE_LOG_MEMORY) {
            unrailableRostersLogged.add(thread.conversationId);
          }
          log.info(
            {
              event: 'group_rail_requeue_skipped',
              conversationId: thread.conversationId,
              reason: 'roster_unrailable',
              memberCount: roster.length,
            },
            'group rail not re-enqueued - the roster can never be railed (the migration convergence report lists this thread as ADJUDICATION-REQUIRED)',
          );
        }
        return;
      }
      const failedAt = Date.parse(String(thread.rail_failed?.at ?? ''));
      if (Number.isFinite(failedAt) && Date.now() - failedAt < RAIL_REQUEUE_BACKOFF_MS) {
        log.info(
          {
            event: 'group_rail_requeue_backoff',
            conversationId: thread.conversationId,
            sinceFailureMs: Date.now() - failedAt,
          },
          'group rail re-enqueue skipped - a recent attempt failed and the back-off has not elapsed',
        );
        return;
      }
    }
    try {
      const outcome = await groupRail.enqueueGroupRail({
        conversationId: thread.conversationId,
        members: thread.participants ?? [],
        reason,
      });
      if (outcome.status !== 'enqueued') {
        log.warn(
          {
            providerSid,
            conversationId: thread.conversationId,
            railStatus: outcome.status,
            reason: outcome.reason,
          },
          'group rail not enqueued - the thread is inbound-only until a rail exists',
        );
      }
    } catch (err) {
      log.error(
        { err, providerSid, conversationId: thread.conversationId },
        'group rail enqueue threw - message persisted, thread stays inbound-only',
      );
    }
  }

  /**
   * The outcome of classifying + filing ONE group-envelope inbound.
   *
   * `handled: false` means "this message belongs in the sender's 1:1 after all"
   * - the collapsed-roster rule and the corrupt-shape branch (spec 13.1's two
   * non-tripwire exceptions). The caller then runs the ordinary 1:1 pipeline
   * with the extraction marker set; NOTHING is persisted here in that case, so
   * the message can never land twice.
   */
  interface GroupInboundOutcome {
    handled: boolean;
    // THIS OUTCOME USED TO CARRY A SECOND FIELD, `semantically1to1` (fix wave 2,
    // contest X2), which told the 1:1 pipeline whether to withhold OUR filed
    // keyword reply: a COLLAPSED roster is "semantically a 1:1" (spec 13.1(c))
    // and kept its replies, while every other decline was a GROUP reason and did
    // not. It had exactly one consumer and no other meaning, and since
    // 2026-08-12 the app emits no keyword reply on ANY path (module header), so
    // there is nothing left for the distinction to decide. The collapsed-roster
    // ruling itself still stands - it is what the extraction marker and the
    // filing target are argued from - it just no longer branches here.
  }

  async function handleGroupInbound(msg: {
    MessageSid: string;
    From: string;
    To: string;
    Body: string | undefined;
    OptOutType: string | undefined;
    params: WebhookParams;
    others: string[];
  }): Promise<GroupInboundOutcome> {
    const { MessageSid, From, To, Body, params } = msg;

    // (0) THE EXCLUSION SET, or nothing. A cold-start pool-number read failure
    // throws here rather than deriving an id from a set known to be incomplete
    // (that id would be permanent, wrong, and unrecoverable). Refuse the group
    // branch instead: the caller files 1:1 WITH the extraction marker, which is
    // recoverable, and invariant 13.3 still holds because nothing is lost.
    let exclusions: GroupExclusionSet;
    try {
      exclusions = await groupExclusions();
    } catch (err) {
      log.error(
        { err, event: 'group_exclusions_unavailable', providerSid: MessageSid },
        'group exclusion set unavailable - refusing to derive a group id, filed to the sender 1:1 with the extraction marker',
      );
      // A REDELIVERY OF AN ALREADY-FILED GROUP MESSAGE MUST NOT BE RE-FILED 1:1
      // (fix wave 5, adversarial 18). This cold-start refusal is the ONE
      // transient fail-open path in the feature, and the (ii.5) redelivery guard
      // sits BELOW it - so delivery 1 could classify the message as a group,
      // append it to thread G, and then 5xx downstream (media mirroring runs
      // before the ack), and delivery 2 - hitting a cold pool cache - fell
      // straight through to the 1:1 pipeline. That pipeline calls
      // `createOrGetByParticipantPhone` unconditionally, MATERIALIZING an empty
      // needs-triage 1:1 for the group sender (the exact row numberSuppression
      // and the group path both go out of their way never to create), and it
      // ran the keyword handler on that phantom row. (It also drew a TwiML
      // keyword reply the group path never sent; no path replies now.)
      //
      // The sid pointer already knows. If this message lives on a GROUP thread,
      // the first delivery's filing stands: ack and stop. Best effort - a failed
      // pointer read falls through to the pre-fix behaviour, never a lost
      // message (invariant 13.3).
      try {
        const filed = await messages.getByProviderSid(MessageSid);
        if (filed !== undefined) {
          const where = await conversations.getById(filed.conversationId);
          if (where?.type === 'group_text') {
            log.warn(
              {
                event: 'group_inbound_redelivery_already_group_filed',
                providerSid: MessageSid,
                conversationId: filed.conversationId,
              },
              'group exclusion set unavailable on a REDELIVERY of a message already filed to its group thread - acking without minting a 1:1',
            );
            // A STOP MAY NEVER GO UNRECORDED (fix wave 2, adversarial 7). This
            // ack skips the whole pipeline, and the group path's keyword step
            // runs AFTER media mirroring - so delivery 1 can append the message
            // and then die before recording anything, leaving THIS delivery as
            // the only pass that will ever see the keyword. Run the same shared
            // seam the group path runs (lazy 1:1 target, so a plain inbound or a
            // HELP still mints nothing). Idempotent by construction, so
            // re-running it after a delivery that already recorded is a no-op
            // on the same flags.
            //
            // ONE contact read, not two (fix wave 4, item 10). The sender was
            // being resolved twice - once for the lazy conversation factory and
            // once for `effectiveContact` - on a path that runs while the pool
            // table is already unavailable. Two reads of the same row cannot
            // disagree usefully here; they can only cost.
            //
            // THE AUDIT ROW IS WRITTEN AGAIN ON A REDELIVERY, deliberately and
            // consistently with the rest of this webhook. `processInboundKeywords`
            // is idempotent on the FLAGS (same value, same row) but its audit
            // append is not deduped by provider sid - and neither is the 1:1
            // keyword path's, which has always re-audited a redelivered STOP. A
            // duplicate audit row is a true record of a webhook delivery that
            // really happened; a MISSING opt-out is not recoverable. The
            // precedent is what settles it, not an accident.
            try {
              const sender = await contacts.findByPhone(From);
              await processInboundKeywords({
                conversation: async () =>
                  conversations.createOrGetByParticipantPhone(From, conversationTypeFor(sender)),
                effectiveContact: sender,
                From,
                Body,
                OptOutType: msg.OptOutType,
                MessageSid,
                auditContext: { groupConversationId: filed.conversationId, via: 'group_text' },
              });
            } catch (keywordErr) {
              // SUMMARIZED, like every other catch that can see a vendor error on
              // this route (fix wave 4, item 10): a raw `err` here serializes
              // every enumerable key of whatever threw, and an AxiosError carries
              // the Authorization header and the request body.
              log.error(
                { err: summarizeError(keywordErr), providerSid: MessageSid },
                'group inbound redelivery guard: keyword bookkeeping failed - message stays filed, suppression flags NOT updated',
              );
            }
            return { handled: true };
          }
        }
      } catch (readErr) {
        log.error(
          { err: summarizeError(readErr), providerSid: MessageSid },
          'group inbound: redelivery pre-check failed after an exclusion-set failure - falling through to the 1:1 pipeline',
        );
      }
      return { handled: false };
    }

    // (0b) ENVELOPE CAP - REFUSAL, not just a tripwire. `parseOtherRecipients`
    // stops at MAX_OTHER_RECIPIENTS_INDEX, so an envelope that keeps going
    // yields a SHORT roster - and a short roster is a DIFFERENT
    // conversationId, i.e. a forked thread under an id this code would itself
    // call wrong. The two sibling roster-SHRINKING conditions already state the
    // rule: an unparseable address refuses ("deriving an id from the survivors
    // would give a 3-person group the id of a 2-person one") and so does a
    // cold-start exclusion failure ("a wrong id is permanent data; a 1:1 refile
    // is recoverable"). This is the same fact pattern and now gets the same
    // answer - WARN (not ERROR: the level is F13's ruling, and a subject-only
    // shape must not page anyone) and file to the sender's 1:1 with the marker.
    if (hasOtherRecipientsBeyondCap(params)) {
      log.warn(
        {
          event: 'group_envelope_truncated',
          providerSid: MessageSid,
          scannedCount: msg.others.length,
          maxIndex: MAX_OTHER_RECIPIENTS_INDEX,
        },
        'group envelope carries an OtherRecipients index past the scan cap - the derived roster would be SHORT and the thread id therefore WRONG, so no thread was minted; filed to the sender 1:1 with the extraction marker',
      );
      return { handled: false };
    }

    const identity = groupIdentity(From, To, msg.others, exclusions, { logger: log });

    // (i) CORRUPT ENVELOPE: an address we cannot canonicalize. Deriving an id
    // from the survivors would give a 3-person group the id of a 2-person one -
    // a silently WRONG thread. File 1:1, mark, and say so loudly.
    if (identity.unparseable.length > 0) {
      log.error(
        { event: 'group_envelope_unparseable', providerSid: MessageSid, unparseableCount: identity.unparseable.length },
        'group envelope carries an address that is not a valid phone number - filed to the sender 1:1, NOT as a group',
      );
      return { handled: false };
    }

    // (ii) COLLAPSED ROSTER (spec 5.1): fewer than two outside members after
    // exclusion. Us-plus-one-person IS a 1:1, so filing it there is also the
    // semantically right answer - but the body may name the other parties, so
    // it still carries the extraction marker.
    if (identity.collapsed) {
      log.warn(
        { event: 'group_roster_collapsed', providerSid: MessageSid, rosterSize: identity.roster.length },
        'group envelope collapsed to fewer than two outside members - filed to the sender 1:1 (semantically a 1:1)',
      );
      // The ONE decline that is not group content: 13.1(c) says this IS a 1:1.
      // It keeps full 1:1 keyword semantics, which since 2026-08-12 means the
      // same "record everything, reply nothing" every other path gets. The
      // extraction marker still rides along - the body may name the other
      // parties.
      return { handled: false };
    }

    // (ii.5) A REDELIVERY NEVER RE-CLASSIFIES. The cold-start refusal at (0) is
    // the one TRANSIENT fail-open path in this feature, so one MessageSid can be
    // classified 1:1 on its first delivery (pool read down) and group on a
    // redelivery (pool read healthy) - and Twilio only redelivers when the first
    // delivery 5xx'd AFTER the append. Without this check the second delivery
    // MINTS the group thread, then `messages.append` dedupes against the row in
    // the sender's 1:1: a group thread carrying a preview and ZERO messages,
    // with nothing logged.
    //
    // The sid pointer is the authority on where this message already lives. If
    // it lives somewhere other than the id we just derived, the FIRST delivery's
    // filing stands and this delivery's job is to finish it - so refuse the
    // group branch and let the 1:1 pipeline re-run its idempotent side effects
    // (it adopts `persistedConversationId` from the same read). One point read
    // on the group branch only; the 1:1 path is untouched (invariant 13.2).
    let alreadyFiledElsewhere = false;
    try {
      const alreadyFiled = await messages.getByProviderSid(MessageSid);
      alreadyFiledElsewhere =
        alreadyFiled !== undefined && alreadyFiled.conversationId !== identity.conversationId;
      if (alreadyFiledElsewhere) {
        log.error(
          {
            event: 'group_inbound_already_filed_elsewhere',
            providerSid: MessageSid,
            conversationId: identity.conversationId,
          },
          'this MessageSid already persisted on a DIFFERENT conversation (a first delivery classified it 1:1) - refusing to mint a group thread for a message that lives elsewhere; completing the original filing instead',
        );
      }
    } catch (err) {
      // A failed pointer read must not lose the message. Fall through: the worst
      // case is the pre-fix behavior, and the post-append guard below still
      // keeps a diverged row from dressing this thread.
      log.error(
        { err, providerSid: MessageSid },
        'group inbound: sid-pointer pre-check failed - proceeding, the post-append divergence guard still applies',
      );
    }
    if (alreadyFiledElsewhere) return { handled: false };

    // (iii) Resolve the thread at the derived id. THREE legal shapes.
    const existing = await conversations.getById(identity.conversationId);
    let thread: ConversationItem;
    if (existing === undefined) {
      // (a) NOT FOUND -> create. Members first: every ConversationParticipant
      // carries a REQUIRED contactId, and the stubs must NOT go through
      // captureContact (adjudication A7 - it would stamp consent_method).
      const resolution = await resolveGroupMembers(identity.roster, {
        contactsRepo: contacts,
        logger: log,
      });
      const { item, created } = await conversations.createGroupTextThread({
        conversationId: identity.conversationId,
        members: resolution.members,
        ...(Body !== undefined && Body.length > 0 && { preview: Body }),
      });
      thread = item;
      // Created -> enqueue the rail. Adopted (lost the create race) -> the
      // winner already enqueued, so only heal a genuinely rail-less thread.
      await ensureRailEnqueued(thread, created ? 'created' : 'rail_missing', MessageSid);
    } else if (existing.type === 'group_text') {
      // (b) FOUND, already native. Re-enqueue the rail when there is none: this
      // is what closes the create-then-crash-before-enqueue window (spec 15.3).
      thread = existing;
      await ensureRailEnqueued(thread, 'rail_missing', MessageSid);
    } else if (
      existing.type === 'relay_group' &&
      existing.status === 'connecting' &&
      !(typeof existing.pool_number === 'string' && existing.pool_number.length > 0)
    ) {
      // (c) FOUND, an IMPORTED row nobody converted yet -> AUTO-CONVERT inline
      // (Cameron's gate ruling). Called WITHOUT ownNumbers: exclusion-set parity
      // belongs to the bulk migration entry, which has the import context; this
      // caller is guarded by boot validation plus the identity fingerprint.
      const converted = await convertConnectingRelayGroupToGroupText(identity.conversationId, {
        conversationsRepo: conversations,
        contactsRepo: contacts,
        logger: log,
      });
      if (converted.outcome === 'refused') {
        log.error(
          { event: 'group_autoconvert_refused', providerSid: MessageSid, conversationId: identity.conversationId, refusal: converted.refusal },
          'inline auto-convert refused an imported group row - filed to the sender 1:1, never guessed',
        );
        return { handled: false };
      }
      const reread = await conversations.getById(identity.conversationId);
      if (reread === undefined || reread.type !== 'group_text') {
        log.error(
          { event: 'group_autoconvert_unreadable', providerSid: MessageSid, conversationId: identity.conversationId },
          'inline auto-convert reported success but the thread does not read back as a group text - filed to the sender 1:1',
        );
        return { handled: false };
      }
      thread = reread;
      log.warn(
        { event: 'group_autoconvert_self_heal', providerSid: MessageSid, conversationId: identity.conversationId, outcome: converted.outcome },
        'inbound group message SELF-HEALED an unconverted imported relay row into a native group text (the migration should have done this before go-live)',
      );
      await ensureRailEnqueued(thread, 'rail_missing', MessageSid);
    } else {
      // ANY OTHER SHAPE: an open/connected relay group with a pool number at a
      // DERIVED GROUP ID. The importer cannot produce this, so it means the row
      // is corrupt or an id collided. Never guess - file 1:1 and alarm.
      log.error(
        { event: 'group_id_wrong_shape', providerSid: MessageSid, conversationId: identity.conversationId, foundType: existing.type, foundStatus: existing.status },
        'the derived group id resolves to a thread that is neither a group text nor a convertible imported row - filed to the sender 1:1',
      );
      return { handled: false };
    }

    // --- From here the message IS a group message -------------------------
    mergeContext({ conversationId: thread.conversationId });

    // ROSTER/ID DIVERGENCE TRIPWIRE. The thread's id is uuidv5 over its roster,
    // so the roster STORED on the thread must hash back to the id we resolved
    // it by. A row written by a path that truncated the roster while keeping
    // the full-set id (a workbook `drop` on an imported group is the known
    // producer) breaks that: the sender can then be a NON-MEMBER of the thread
    // its own message lands on - no member chip, no sender attribution, no
    // stub, and a Conversations rail built from `participants` would omit a
    // real handset.
    //
    // REPORT ONLY, never repair. Re-keying the roster to match the id (or the
    // id to match the roster) changes thread identity and orphans history; the
    // migration refuses such a row so a human adjudicates it (groupConvert's
    // `roster_id_mismatch`). Here the message is already correctly filed by id,
    // so the honest action is to say the roster is wrong and keep going.
    //
    // EXCLUSION-SET-AWARE (fix wave 2). An ABSENT sender is only a signal when
    // the roster is supposed to contain them. When the founder or staff texts
    // one of their own groups from ANOTHER ORG NUMBER, the exclusion set
    // correctly subtracts that number and the sender is correctly not on the
    // roster - spec 4.1 (r3 finding 9) calls that "the correctly-configured
    // steady state, not a signal". It is also a designed-for workflow that
    // recurs across every group, so alarming on it at ERROR - the channel that
    // feeds the production alarm - would bury the real corruption signal on day
    // one. Skip those; keep the ERROR for a sender absent for any OTHER reason.
    const senderE164 = normalizeToE164(From);
    const rosterPhones = (thread.participants ?? []).map((p) => p.phone);
    if (senderE164 !== undefined && !rosterPhones.includes(senderE164) && !identity.senderExcluded) {
      log.error(
        {
          event: 'group_sender_not_on_roster',
          providerSid: MessageSid,
          conversationId: thread.conversationId,
          rosterSize: rosterPhones.length,
          derivedRosterSize: identity.roster.length,
          rosterMatchesId: conversationIdForGroup(rosterPhones) === thread.conversationId,
        },
        'the sender of a group message is NOT on the resolved thread roster - the stored roster does not describe this group (member chips, attribution and the rail will all be short)',
      );
    }

    // T3.4a: group member keys are PHONE-SCOPED, ALWAYS. relayMemberKey prefers
    // contactId, which would collapse two numbers of ONE contact into a single
    // delivery/attribution slot (spec 15.6) - so it is deliberately not used.
    const senderKey = groupMemberKey(normalizeToE164(From) ?? From);
    // THE SENDER'S CONTACT, RESOLVED THROUGH THE ROSTER - NOT THROUGH `byPhone`.
    //
    // `contacts.findByPhone` is a QUERY on the byPhone GSI, and a GSI is
    // EVENTUALLY consistent. On the create branch above, the sender's own stub
    // was minted MOMENTS AGO in THIS SAME REQUEST (resolveGroupMembers), so that
    // query legitimately comes back empty. Live dev proved it: the first-contact
    // sender was left with `group_participation_at` and NO `consent_method`,
    // because the plain-inbound consent stamp inside processInboundKeywords is
    // guarded on `effectiveContact &&` and therefore silently no-opped - and
    // `author` fell to `unknown` off the same undefined read. Spec 4.4/5 says a
    // group sender gets NORMAL inbound consent semantics; without the stamp the
    // next proactive 1:1 to them is JIT-gated for consent they already gave.
    //
    // No test could see it: every fake resolves byPhone consistently, so this
    // read always hit. Only real DynamoDB exhibits the lag.
    //
    // The thread's roster already carries the sender's contactId - the create
    // branch just wrote it, and branches (b)/(c) read a persisted one - and
    // `getById` with `consistentRead` is a strongly-consistent POINT read with
    // no index to lag behind. `findByPhone` stays as the fallback for a sender
    // who is legitimately NOT a roster member (the exclusion-set case: staff
    // texting one of their own groups from another org number), and for a roster
    // slot whose derived id has no row behind it - neither races a just-written
    // item. This is inside the group branch only; the 1:1-classified path gains
    // no I/O (invariant 13.2).
    const senderRosterContactId =
      senderE164 === undefined
        ? undefined
        : (thread.participants ?? []).find((p) => p.phone === senderE164)?.contactId;
    const senderContact =
      senderRosterContactId === undefined
        ? await contacts.findByPhone(From)
        : ((await contacts.getById(senderRosterContactId, { consistentRead: true })) ??
          (await contacts.findByPhone(From)));
    // Author honesty: only a reviewed contact type claims tenant/landlord.
    const author =
      senderContact?.type === 'landlord' ||
      senderContact?.type === 'tenant' ||
      senderContact?.type === 'partner'
        ? senderContact.type
        : 'unknown';

    const mediaUrls = parseInboundMediaUrls(params);
    const providerTs = new Date().toISOString();
    // Dedupe rides the EXISTING MessageSid sid-pointer transaction. The repo
    // returns the FIRST delivery's tsMsgId from the pointer, so the keys below
    // address the persisted row either way - and a redelivery RE-ENTERS media
    // mirroring when the first pass stored fewer attachments than the envelope
    // carried (see the completeness gate below; the 1:1 path does the same).
    //
    // NO `deliveryRecipients` seed: the relay path seeds an empty map because a
    // fan-out job writes per-recipient child fields into the SOURCE message. A
    // carrier group needs no fan-out (the carrier already delivered to every
    // handset), so an inbound group message has no per-recipient delivery map.
    const appended = await messages.append({
      conversationId: thread.conversationId,
      providerSid: MessageSid,
      providerTs,
      type: mediaUrls.length > 0 ? 'mms' : 'sms',
      direction: 'inbound',
      author,
      deliveryStatus: 'delivered',
      relaySenderKey: senderKey,
      ...(Body !== undefined && Body.length > 0 && { body: Body }),
      ...(mediaUrls.length > 0 && { mediaUrls }),
    });

    // Media (T3.6): the SHARED mirror, under the GROUP conversationId.
    //
    // REDELIVERY RECOVERY, identical to the 1:1 path's completeness gate.
    // `mirrorInboundMedia` never throws - it catches PER ATTACHMENT - so a
    // Twilio media 404 or an S3 5xx leaves the row with fewer attachments than
    // `NumMedia` and still returns 200. Twilio's media URLs expire, so a
    // redelivery that skipped the mirror outright would lose the photo
    // PERMANENTLY. Gate on completeness (not on `deduped`): re-putting an
    // already-stored key is an idempotent same-bytes no-op.
    let groupMediaAlreadyMirrored = false;
    if (appended.deduped) {
      try {
        const persisted = await messages.getByProviderSid(MessageSid);
        // THE CONCURRENT HALF of the (ii.5) guard: two deliveries in flight at
        // once can both pass the pre-check and still dedupe against each other.
        // Nothing was persisted by THIS pass, so refusing here is safe and the
        // 1:1 pipeline finishes the filing that actually won - which also keeps
        // the media mirror pointed at the row that exists.
        if (persisted !== undefined && persisted.conversationId !== thread.conversationId) {
          log.error(
            {
              event: 'group_inbound_already_filed_elsewhere',
              providerSid: MessageSid,
              conversationId: thread.conversationId,
            },
            'group inbound deduped against a message persisted on a DIFFERENT conversation - leaving this thread untouched and completing the original filing',
          );
          return { handled: false };
        }
        groupMediaAlreadyMirrored =
          mediaUrls.length > 0 &&
          persisted !== undefined &&
          mediaAttachmentsOf(persisted).length >= mediaUrls.length;
        if (persisted === undefined) {
          // The append deduped, so the SID pointer exists - failing to read the
          // message back is never expected. Carry on under the keys we have
          // rather than dropping the media.
          log.error(
            { providerSid: MessageSid },
            'group inbound deduped but the persisted message could not be read back - re-mirroring any media under the append keys',
          );
        }
      } catch (err) {
        log.error(
          { err, providerSid: MessageSid },
          'group inbound dedupe read-back failed - re-entering the mirror rather than risking a permanent media loss',
        );
      }
    }
    if (!groupMediaAlreadyMirrored) {
      await mirrorInboundMedia({
        mediaUrls,
        messageSid: MessageSid,
        conversationId: thread.conversationId,
        tsMsgId: appended.tsMsgId,
        params,
      });
    }

    // Sender attribution across a second handset - the same touch a 1:1 does
    // (it is sender attribution, not a 1:1-ism). Best-effort.
    if (senderContact) {
      try {
        await contacts.touchPhoneLastSeen(senderContact.contactId, From, providerTs);
      } catch (err) {
        log.error(
          { err, providerSid: MessageSid },
          'phone lastSeenAt touch failed - message persisted, lastSeenAt stale',
        );
      }
    }

    // Inbox touch + unread + SSE, on the GROUP conversationId. touchLastActivity
    // takes NO special parameters: S2's repo guard keeps the row in its own
    // `group_open` byLastActivity partition.
    let touched: ConversationItem | undefined;
    try {
      if (!appended.deduped) await conversations.incrementUnread(thread.conversationId);
      touched = await conversations.touchLastActivity(
        thread.conversationId,
        Body || undefined,
        providerTs,
      );
    } catch (err) {
      log.error(
        { err, providerSid: MessageSid },
        'group touchLastActivity/unread failed - message persisted, inbox stale',
      );
    }
    if (!appended.deduped) {
      events.emit('message.persisted', {
        conversationId: thread.conversationId,
        tsMsgId: appended.tsMsgId,
        direction: 'inbound',
        deliveryStatus: 'delivered',
      });
      if (touched) events.emit('conversation.updated', toConversationUpdatedEvent(touched));
      // Inbound-message push on the GROUP thread. A SIBLING of the braceless
      // `if (touched)` above, never nested under it.
      emitMessagePush(
        groupThreadLabel(thread.participants),
        pushMessageBody(
          Body,
          mediaUrls.length,
          pushSenderLabel(
            (thread.participants ?? []).find((p) => p.phone === senderE164)?.name,
            senderContact,
            From,
          ),
        ),
        thread.conversationId,
      );
    }

    // Keywords (spec 4.4): the SHARED seam runs on EVERY group inbound, because
    // the plain-inbound contact-level consent stamp for the SENDER lives there.
    // The target conversation is a THUNK - the sender's 1:1 is materialized ONLY
    // if an opt-out/opt-in actually needs a target, never for plain inbound and
    // never for HELP. Suppression is scoped to the sender (contact + their own
    // 1:1), NEVER the group thread. The app SENDS NOTHING here - which is now
    // true of every path, so it costs no parameter.
    await processInboundKeywords({
      conversation: async () =>
        conversations.createOrGetByParticipantPhone(From, conversationTypeFor(senderContact)),
      effectiveContact: senderContact,
      From,
      Body,
      OptOutType: msg.OptOutType,
      MessageSid,
      auditContext: { groupConversationId: thread.conversationId, via: 'group_text' },
    });

    // Cross-check liveness (spec 8.2): record that a RAILED group thread took
    // classic-webhook inbound. Paired with the cross-check endpoint's own
    // high-water mark, that is what makes "the monitor went quiet" detectable.
    if (hasActiveGroupRail(thread)) {
      try {
        await settings.putGroupTimestamp(GROUP_RAILED_INBOUND_LAST_AT_ID, providerTs);
      } catch (err) {
        log.warn(
          { err, providerSid: MessageSid },
          'group railed-inbound liveness stamp failed - message persisted, cross-check high-water mark stale',
        );
      }
      // T6.6(d): this filing is the CLASSIC half of the cross-check's
      // (rail, author) match. Without it every Conversations event would sit
      // unmatched and alarm at its grace deadline - i.e. a perfectly healthy
      // channel would look like the failure the guardrail exists to detect.
      // recordClassicInbound never throws; a bookkeeping problem is its own WARN.
      //
      // DELIBERATELY NOT GATED ON `appended.deduped`. This step used to be
      // non-idempotent, and a redelivery banked a phantom credit that later
      // absorbed a genuinely unmatched event - the guardrail reporting health
      // while detection was down. The fix is a per-provider-SID dedupe marker
      // INSIDE recordClassicInbound, not a gate here: a first delivery that died
      // after the append but before this line leaves no marker, and its
      // redelivery (which appends as `deduped`) is the only chance to file the
      // classic half. Gating on the flag would convert that recovery into a
      // false `group_crosscheck_inbound_missing` ERROR on healthy traffic.
      //
      // The RAW `From` is passed on purpose: the ledger's ONE key builder
      // normalizes it, so the two halves cannot drift (spec 4.1).
      await groupCrossCheck.recordClassicInbound({
        conversationSid: thread.twilio_conversation_sid as string,
        author: From,
        providerSid: MessageSid,
      });
    }

    log.info(
      {
        providerSid: MessageSid,
        direction: 'inbound',
        conversationId: thread.conversationId,
        memberCount: (thread.participants ?? []).length,
        bodyLength: Body?.length ?? 0,
        mediaCount: mediaUrls.length,
        deduped: appended.deduped,
      },
      'twilio inbound group message processed',
    );
    return { handled: true };
  }

  // ---------------------------------------------------------------------
  // Inbound message webhook — pipeline order per doc §7.1.
  // ---------------------------------------------------------------------
  router.post('/sms', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const { MessageSid, From, To, Body, OptOutType } = params;
    if (!MessageSid || !From) {
      log.warn(
        { hasMessageSid: Boolean(MessageSid), hasFrom: Boolean(From) },
        'twilio inbound webhook missing MessageSid/From — rejected',
      );
      res.status(400).json({ error: 'bad request' });
      return;
    }

    // (1) Echo/author check FIRST (doc §7.1 defense 1): From matching one of
    // OUR numbers means this is our own outbound projected back — acknowledge
    // and STOP, no side-effect pipeline. From-match is the deterministic
    // core; Direction/SmsStatus params can corroborate but are not relied on.
    // M1.7: pool numbers are ALSO "ours" — a relay fan-out (From = pool
    // number) projected back must drop here too, before any relay routing.
    const kind = await ourNumberKind(From);
    if (kind === 'business') {
      log.info({ providerSid: MessageSid }, 'twilio webhook echo (From is our number) — acknowledged, dropped');
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }
    // Multiplexing: a pool number fronts MANY groups (open + closed), and the
    // pool arm of ourNumberKind still matches ANY of them. It reads
    // getByPoolNumber (ONE Query) where this guard used to page
    // getAllByPoolNumber; as a MEMBERSHIP test the two are equivalent - same
    // unfiltered byPoolNumber query, and getByPoolNumber returns
    // `items.find(open) ?? items[0]`, so it is truthy exactly when the GSI
    // holds any item, open or closed. This is NOT a regression to
    // one-group-per-number; it only avoids paging a whole partition to answer
    // a yes/no. ROUTING below keeps getAllByPoolNumber, which needs every group.
    if (kind === 'pool') {
      log.info({ providerSid: MessageSid }, 'twilio webhook echo (From is a pool number) — acknowledged, dropped');
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }

    // (1.5) Relay routing (relay-number-lifecycle): a pool number now fronts
    // MANY participant-disjoint groups (concurrently + over time), so inbound
    // resolves on (To, From) via getAllByPoolNumber (open + closed - pool_number
    // is never cleared). The byPoolNumber GSI read is still the cheap lookup
    // (never a scan). Zero groups on To -> fall through to the normal 1:1 path.
    if (To !== undefined && To.length > 0) {
      const groups = await conversations.getAllByPoolNumber(To);
      if (groups.length > 0) {
        // (a) OPEN group whose roster contains the sender -> today's relay path
        //     (fan-out, DLR pointers, STOP handling all unchanged). The burn
        //     invariant guarantees at most one; a corrupt-many routes to the
        //     newest and logs an error (never crashes the webhook).
        const openMatches = groups.filter(
          (g) => g.status === 'open' && (g.participants ?? []).some((m) => m.phone === From),
        );
        if (openMatches.length > 1) {
          log.error(
            { providerSid: MessageSid, matchCount: openMatches.length },
            'multiple OPEN relay groups on one pool number match the sender (burn invariant violated) - routing to the newest',
          );
        }
        const openMatch = openMatches.sort(byNewestCreated)[0];
        if (openMatch) {
          // Empty ack, keyword or not: the open path processes STOP/HELP/opt-in
          // and Twilio's Advanced Opt-Out sends the confirmation.
          await handleRelayInbound(openMatch, { MessageSid, From, To, Body, params });
          res.type('text/xml').send(EMPTY_TWIML);
          return;
        }
        // (b) Else a CLOSED group whose roster contains the sender -> deliver
        //     the late text into the sender's OWN 1:1 thread with provenance
        //     (newest of several - a person can be in several closed groups on
        //     one number over the years). No fan-out, no group append.
        const closedMatch = groups
          .filter((g) => g.status !== 'open' && (g.participants ?? []).some((m) => m.phone === From))
          .sort(byNewestCreated)[0];
        if (closedMatch) {
          // AF-4: the intercept processes STOP/opt-out; the confirmation is
          // Twilio's, so the ack is empty.
          await handleClosedGroupInbound(closedMatch, {
            MessageSid,
            From,
            Body,
            params,
          });
          res.type('text/xml').send(EMPTY_TWIML);
          return;
        }
        // (c) Unknown sender (on NO roster) texting a pool number.
        //   - If any OPEN group exists: keep today's non-member behavior
        //     (persist on the newest OPEN group for the record, no fan-out).
        //   - If ALL groups are closed (AF-5): do NOT bury the text in a dead
        //     group transcript (it could hide a real message - a stranger, a
        //     second phone, or a member from a NEW phone). Fall THROUGH to the
        //     normal 1:1 intake path below (pre-feature behavior: a cleared
        //     number fell to 1:1). No via_closed_group - they are not a
        //     closed-roster member (that interception is branch (b) above).
        const openFallback = groups.filter((g) => g.status === 'open').sort(byNewestCreated)[0];
        if (openFallback) {
          // Same contract as the open-roster match above (an unknown-sender STOP
          // is still recorded; Twilio still confirms it).
          await handleRelayInbound(openFallback, { MessageSid, From, To, Body, params });
          res.type('text/xml').send(EMPTY_TWIML);
          return;
        }
        // else: every group on this number is closed -> fall through to (2).
      }
    }

    // (1.75) NATIVE GROUP TEXT detection (group-texting spec 5). Sits AFTER both
    // echo drops and ALL relay routing, and BEFORE any 1:1 I/O - the envelope
    // read below is pure property access on an already-parsed body, so an
    // envelope-less inbound reaches (2) with a byte-identical call sequence
    // (invariant 13.2).
    //
    // GATED ON THE BUSINESS NUMBER (adjudication A6). Spec 5 puts this "in the
    // main-number branch", and the gate is what makes that true: the relay block
    // above FALLS THROUGH when every group on a pool number is closed, so
    // without it a group-origin inbound addressed to a POOL number would mint a
    // native thread and quietly change relay behavior (invariant 13.6).
    const others = parseOtherRecipients(params);
    const onBusinessNumber =
      To !== undefined &&
      config.businessPhoneNumber !== undefined &&
      To === config.businessPhoneNumber;
    // Set when a fail-open path files a possibly-group message into a 1:1
    // thread. AI fact extraction excludes marked messages from every transcript
    // window it builds (spec 5.4).
    let groupAmbiguousOrigin = false;
    if (others.length > 0 && onBusinessNumber) {
      const outcome = await handleGroupInbound({
        MessageSid,
        From,
        To: To as string,
        Body,
        OptOutType,
        params,
        others,
      });
      if (outcome.handled) {
        // The app SENDS NOTHING on a group inbound (spec 4.4), keywords
        // included - which is now the whole stack's posture, not this branch's
        // exception (issue twilio-standard-optout-double-reply, RESOLVED).
        res.type('text/xml').send(EMPTY_TWIML);
        return;
      }
      // Collapsed roster or corrupt shape: fall through to the 1:1 pipeline
      // below, MARKED. Nothing was persisted above, so no double-filing.
      groupAmbiguousOrigin = true;
    } else if (others.length > 0) {
      // EVERY OTHER ENVELOPE-BEARING INBOUND. We have POSITIVE proof this is
      // carrier-group content (the envelope is right here) but we are NOT
      // minting a native thread for it - either BUSINESS_PHONE_NUMBER is unset
      // (detection is structurally off) or the message landed on one of our
      // OTHER numbers, which for a pool number is A6's deliberate fall-through
      // keeping relay behavior byte-identical (invariant 13.6).
      //
      // The DECISION not to mint a thread is separate from the MARKER. Filing
      // group content into a 1:1 UNMARKED hands it to AI fact extraction as
      // that one contact's own speech - the precise harm the marker exists to
      // prevent - so invariant 13.1's rule holds here too: EVERY envelope-
      // bearing inbound filed 1:1 carries the marker AND alarms. Rate-limited
      // because a misconfigured stack matches on every group inbound at once
      // and the flood would bury the signal.
      //
      // THE KEYWORD REPLY ARGUMENT THAT USED TO SIT HERE (fix wave 4, item 9)
      // IS MOOT. It weighed whether this branch should withhold OUR filed
      // confirmation; the app no longer has one to withhold, on any branch, and
      // Twilio confirms every keyword itself. What survives from it is the part
      // that was never about the reply: a person who texts STOP to a number
      // where detection is off still has their opt-out RECORDED here, which the
      // shared seam below does unconditionally.
      //
      // The MARKER is a separate decision and still applies: the envelope is
      // positive proof of group content, and filed unmarked it would reach AI
      // fact extraction as this one contact's own speech.
      groupAmbiguousOrigin = true;
      if (config.businessPhoneNumber === undefined) {
        warnDetectionUnconfigured(
          { event: 'group_detection_unconfigured', providerSid: MessageSid },
          'a group envelope arrived but BUSINESS_PHONE_NUMBER is unset - group detection is OFF, filed as 1:1 WITH the extraction marker',
        );
      } else {
        warnEnvelopeOffBusinessNumber(
          { event: 'group_envelope_off_business_number', providerSid: MessageSid },
          'a carrier group envelope arrived on a NON-business number (pool or other org number) - filed as 1:1 WITH the extraction marker, no native thread minted (A6)',
        );
      }
    } else if (onBusinessNumber && isMissingEnvelopeGroupShape(MessageSid, params)) {
      // (1.8) TRIPWIRE (spec 8.1). An MM-prefixed SID with no media and no
      // envelope is what a SILENTLY REMOVED `OtherRecipients` contract looks
      // like from in here. FAIL OPEN - file as a 1:1, never lose a message -
      // and WARN, deliberately NOT error: a subject-only 1:1 MMS legitimately
      // matches this shape, and the ERROR channel feeds the production alarm.
      // Rate-limited because if the contract really did disappear, EVERY group
      // inbound matches at once and the flood would bury the signal.
      groupAmbiguousOrigin = true;
      warnEnvelopeMissing(
        { event: 'group_envelope_missing', providerSid: MessageSid },
        'MM-shaped inbound with no media and no OtherRecipients envelope - filed as 1:1 (possible group-detection outage)',
      );
    }

    // (2) Resolve contact + conversation. Unknown phones still get a
    // conversation (auto-capture of contacts is M1.2).
    const contact = await contacts.findByPhone(From);
    const conversation = await conversations.createOrGetByParticipantPhone(
      From,
      conversationTypeFor(contact),
    );
    mergeContext({ conversationId: conversation.conversationId });

    const mediaUrls = parseInboundMediaUrls(params);

    // (3) Idempotency by MessageSid (doc §7.1 defense 2): the conditional
    // append dedupes Twilio redeliveries AND the webhook copy of our own
    // sends (persisted at send time by the send wrapper) — layer 2 behind
    // the From-match. Inbound webhooks carry no provider timestamp, so
    // provider_ts is first-seen receipt time; dedupe stays exact regardless
    // because the SID-pointer write in the same transaction collides.
    const providerTs = new Date().toISOString();
    const appended = await messages.append({
      conversationId: conversation.conversationId,
      providerSid: MessageSid,
      providerTs,
      type: mediaUrls.length > 0 ? 'mms' : 'sms',
      direction: 'inbound',
      // Same honesty rule as conversation typing: only a reviewed contact
      // type may claim tenant/landlord/partner authorship; everything else is
      // `unknown` until a human types the contact (M1.4/M1.5).
      author:
        contact?.type === 'landlord' || contact?.type === 'tenant' || contact?.type === 'partner'
          ? contact.type
          : 'unknown',
      // Inbound messages are received by definition; the outbound delivery
      // machine never transitions them.
      deliveryStatus: 'delivered',
      // Fail-open group filing (spec 5.4): this message MAY be carrier-group
      // content, so AI fact extraction must not attribute it to this contact.
      ...(groupAmbiguousOrigin && { groupAmbiguousOrigin: true }),
      ...(Body !== undefined && Body.length > 0 && { body: Body }),
      ...(mediaUrls.length > 0 && { mediaUrls }),
    });
    // Where the persisted message actually lives (== the fresh append unless
    // deduped, where the FIRST delivery's keys win) + whether media was
    // already mirrored.
    let persistedConversationId = conversation.conversationId;
    let persistedTsMsgId = appended.tsMsgId;
    let mediaAlreadyMirrored = false;
    if (appended.deduped) {
      // Dedupe must NOT skip the side effects below: a redelivery usually
      // means the FIRST delivery 5xx'd/crashed AFTER the append but before
      // finishing this pipeline. Every remaining step is idempotent — STOP
      // recording re-sets the same flags, media mirroring is skipped when the
      // persisted message already has its keys, touchLastActivity re-stamps —
      // so re-running them completes the crashed delivery. (For the
      // echo-of-our-own-send dedupe these are harmless no-ops by design; the
      // From-check above stays the true first gate for echoes.)
      const persisted = await messages.getByProviderSid(MessageSid);
      if (!persisted) {
        // The append deduped, so the SID pointer exists — failing to read the
        // message back is never expected. ERROR (alarmed) + ack so Twilio
        // stops redelivering into a broken read path.
        log.error(
          { providerSid: MessageSid },
          'twilio inbound webhook deduped but the persisted message could not be read back — acknowledged',
        );
        res.type('text/xml').send(EMPTY_TWIML);
        return;
      }
      persistedConversationId = persisted.conversationId;
      persistedTsMsgId = persisted.tsMsgId;
      // Skip re-mirroring only when ALL attachments are already stored. Gating on
      // completeness (not mere presence) recovers a PARTIAL first mirror: if the
      // first delivery stored 1 of 2 (the other's fetch/put threw) and then 5xx'd
      // downstream, the redelivery re-enters mirroring and captures the missing
      // one (re-putting the already-stored key is an idempotent same-bytes no-op).
      mediaAlreadyMirrored = mediaAttachmentsOf(persisted).length >= mediaUrls.length;
      mergeContext({ conversationId: persistedConversationId });
      log.info(
        { providerSid: MessageSid },
        'twilio inbound webhook deduped (redelivery or send-time copy) — re-running idempotent side effects',
      );
    }

    // From here on the message is persisted: side-effect failures must never
    // crash the webhook — a 5xx would trigger a redelivery, which dedupes at
    // the append and RE-RUNS these idempotent steps. Failures are still
    // ERROR-logged + alarmed (Twilio's redelivery is best-effort backup, not
    // the recovery plan).

    // (3.5) Contact auto-capture (M1.2): every inbound conversation ends up
    // linked to a contact — a stub is created for unknown phones (race-safe
    // via the conversation's participants claim; see
    // services/contactCapture.ts) and the link is backfilled for known ones.
    // Idempotent, so the dedupe path re-runs it harmlessly (no double
    // capture). The captured contact also serves the STOP recording below,
    // so an opt-out from a previously unknown phone flags the contact too.
    let effectiveContact = contact;
    try {
      effectiveContact = await captureContact(conversation, contact);
    } catch (err) {
      log.error(
        { err, providerSid: MessageSid },
        'contact auto-capture failed — message persisted, conversation not linked',
      );
    }

    // (3.6) Multi-phone lastSeenAt touch (BE1/C1). Because findByPhone is now
    // pointer-aware, an inbound from an ALREADY-ATTACHED second number resolved
    // to the owner above (no new stub minted). Bump that number's lastSeenAt so
    // "most recent number" stays accurate. Best-effort + no-op when phones[] is
    // absent (a legacy/stub contact is NOT churn-seeded). NEVER auto-attaches a
    // brand-new unknown number to an existing contact (honest-identity mandate:
    // an unknown phone gets its own stub via captureContact above). Failure here
    // never 5xxs the webhook (Twilio redelivery re-runs it idempotently).
    if (effectiveContact) {
      try {
        await contacts.touchPhoneLastSeen(effectiveContact.contactId, From, providerTs);
      } catch (err) {
        log.error(
          { err, providerSid: MessageSid },
          'phone lastSeenAt touch failed — message persisted, lastSeenAt stale',
        );
      }
    }

    // (4) STOP / HELP / START keyword handling (spec 6 - TWILIO owns the
    // replies since 2026-08-12; see the module header and RUNBOOK "Keyword
    // auto-replies (Advanced Opt-Out)"). The message itself stays on the
    // timeline either way (persisted above). What THIS still does:
    //   - opt-out keyword -> suppress (conversation always, contact on primary);
    //   - HELP            -> nothing (no flag change, no thread minted);
    //   - opt-in keyword  -> clear suppression, stamp inbound_text consent if the
    //                       contact has none.
    // Shared with the closed-group intercept (AF-4) and the group path so every
    // inbound path honors STOP identically. The handler emits no reply, so this
    // returns nothing and the ack at the end of the handler is always empty.
    await processInboundKeywords({
      conversation,
      effectiveContact,
      From,
      Body,
      OptOutType,
      MessageSid,
    });

    // (5) MMS media — mirror each MediaUrl{i} into S3 (streams only). Runs before
    // the ack on purpose (decision): counts are tiny (<=10) and well inside
    // Twilio's 15s webhook window. Skipped when an earlier delivery already
    // mirrored (idempotent). The shared helper logs + degrades on failure.
    if (!mediaAlreadyMirrored) {
      await mirrorInboundMedia({
        mediaUrls,
        messageSid: MessageSid,
        conversationId: persistedConversationId,
        tsMsgId: persistedTsMsgId,
        params,
      });
    }

    // (6) Inbox touch + unread + SSE live updates, then acknowledge with
    // empty TwiML. unread_count increments ONLY on a fresh append — a
    // redelivered webhook (dedupe) must never double-count the same message.
    // The increment runs BEFORE the touch so the touch's ALL_NEW snapshot
    // carries the new count into the conversation.updated event.
    let touched: ConversationItem | undefined;
    try {
      // Accepted risk (M1.2): the increment is skipped on dedupe re-runs, so
      // a crash between append and increment permanently undercounts by one
      // (per-message increment markers would fix it if it ever matters).
      if (!appended.deduped) await conversations.incrementUnread(persistedConversationId);
      touched = await conversations.touchLastActivity(
        persistedConversationId,
        Body || undefined,
        providerTs,
      );
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'touchLastActivity/unread failed — message persisted, inbox stale');
    }
    if (!appended.deduped) {
      // SSE emits are fresh-append-only: a redelivery would push a duplicate
      // UI event for a message the dashboard already rendered (clients
      // reconcile via GET /api/conversations anyway).
      events.emit('message.persisted', {
        conversationId: persistedConversationId,
        tsMsgId: persistedTsMsgId,
        direction: 'inbound',
        deliveryStatus: 'delivered',
      });
      if (touched) {
        events.emit('conversation.updated', toConversationUpdatedEvent(touched));
      }
      // Inbound-message push. Uses `contact` (the pre-capture findByPhone at the
      // top of the handler), NOT `effectiveContact`: an auto-captured stub never
      // carries a name, so both resolve identically and this one is free.
      emitMessagePush(
        contactDisplayName(contact) ??
          (typeof conversation.participant_display_name === 'string' &&
          conversation.participant_display_name.length > 0
            ? conversation.participant_display_name
            : undefined) ??
          formatPhoneForDisplay(From) ??
          From,
        pushMessageBody(Body, mediaUrls.length),
        persistedConversationId,
      );
      // Conversation fact extraction (AI): a fresh inbound on a tenant/unknown 1:1
      // thread schedules a debounced extraction run. The sliding upsert collapses
      // a burst of inbounds into ONE run at the latest dueAt (now + debounce).
      // Relay/landlord threads are NOT extraction sources in v1 (the relay path
      // never reaches this block; the type gate excludes landlord_1to1). Gated on
      // the kill switch (config.aiExtractionEnabled). Best-effort: a schedule
      // failure NEVER fails the webhook ack (a WARN is logged and the next inbound
      // re-arms the run).
      if (
        config.aiExtractionEnabled &&
        (touched?.type === 'tenant_1to1' || touched?.type === 'unknown_1to1')
      ) {
        try {
          await extraction.scheduleExtraction(
            persistedConversationId,
            'sms',
            new Date(Date.now() + config.aiExtractionDebounceMs).toISOString(),
          );
        } catch (err) {
          log.warn(
            { err, providerSid: MessageSid },
            'extraction schedule failed - message persisted, extraction not scheduled',
          );
        }
      }
    }
    log.info(
      {
        providerSid: MessageSid,
        direction: 'inbound',
        bodyLength: Body?.length ?? 0,
        mediaCount: mediaUrls.length,
      },
      'twilio inbound message processed',
    );
    // EVERY inbound acks with the empty TwiML, keyword or not (module header).
    res.type('text/xml').send(EMPTY_TWIML);
  });

  // ---------------------------------------------------------------------
  // Delivery status callback — error-class-aware handling (doc §7.1).
  // ---------------------------------------------------------------------
  router.post('/status', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const { MessageSid, MessageStatus, ErrorCode } = params;
    if (!MessageSid || !MessageStatus) {
      log.warn(
        { hasMessageSid: Boolean(MessageSid), hasMessageStatus: Boolean(MessageStatus) },
        'twilio status callback missing MessageSid/MessageStatus — rejected',
      );
      res.status(400).json({ error: 'bad request' });
      return;
    }

    // Per-recipient relay handling (doc §9): a relay-group fan-out sends N
    // outbound provider messages but persists NONE as their own message — each
    // leg lives as a delivery_recipients slot on the source message, found via
    // the relaysid pointer. Runs identically whether the pointer resolved on the
    // first lookup or only after the retry below.
    const handleRelayRecipientStatus = async (ptr: {
      conversationId: string;
      tsMsgId: string;
      memberKey: string;
    }): Promise<void> => {
      mergeContext({ conversationId: ptr.conversationId });
      const mapped = mapTwilioStatus(MessageStatus);
      const transitioned = await messages.updateRecipientDeliveryStatus(
        ptr.conversationId,
        ptr.tsMsgId,
        ptr.memberKey,
        mapped,
        ErrorCode,
      );
      log.info(
        { providerSid: MessageSid, providerStatus: MessageStatus, errorCode: ErrorCode, transitioned, relay: true },
        'twilio relay-recipient delivery status callback processed',
      );
      // Delivery-failure marker (doc §9): a relay fan-out leg that resolved
      // undelivered/failed is a countable failed delivery. Severity follows the
      // taxonomy — a terminal failure is an ERROR (feeds the error-logs alarm +
      // Recent Errors panel); a transient-retrying / opt-out leg stays WARN. The
      // `event` field is unchanged either way, so the DeliveryFailures count
      // metric (which keys on `event`, not level) is unaffected. IDs/codes only.
      if (mapped === 'undelivered' || mapped === 'failed') {
        const failure = {
          event: 'delivery_failed',
          providerSid: MessageSid,
          errorCode: ErrorCode,
          providerStatus: MessageStatus,
          relay: true,
        };
        const failureMsg = 'twilio relay-recipient delivery failed (undelivered/failed)';
        if (isTerminalDeliveryFailure(ErrorCode)) log.error(failure, failureMsg);
        else log.warn(failure, failureMsg);
      }
      if (transitioned) {
        // Refresh the UI: a per-recipient delivery move re-renders the relay
        // thread (the source message's delivery_recipients changed).
        events.emit('message.persisted', {
          conversationId: ptr.conversationId,
          tsMsgId: ptr.tsMsgId,
          direction: 'inbound',
          deliveryStatus: mapped,
        });
        // (M1.10c) A failed relay leg is a failed send on the placement
        // (the relay thread carries conversation.placementId) → escalate.
        if (mapped === 'undelivered' || mapped === 'failed') {
          await flagPlacementAttention(ptr.conversationId, 'send_failed');
        }
      }
    };

    // Context recovery by lookup (doc §9): status callbacks cannot carry the
    // correlation envelope — MessageSid → message → conversation.
    let message = await messages.getByProviderSid(MessageSid);
    let relayPtr = message ? undefined : await messages.getRelaySidPointer(MessageSid);
    // System sends (syssid# markers — e.g. the cell-verification code) are real
    // outbound SMS deliberately NOT persisted as messages; their receipts must
    // ack quietly, never trip the ERROR backstop below.
    let systemMarker =
      message || relayPtr ? undefined : await messages.getSystemSidMarker(MessageSid);
    if (!message && !relayPtr && !systemMarker) {
      // Nothing resolved on the first lookup. THREE independent write-after-send
      // races land here, and the ONE retry below must cover ALL of them —
      // re-checking only one leaks the others:
      //  - send/append: a 1:1 / broadcast callback outran the send wrapper's
      //    messages.append (Twilio can fire the first status before it commits).
      //  - relay fan-out: the relaysid pointer is written AFTER the provider
      //    send returns (relayFanOut send → markRecipient + putRelaySidPointer),
      //    so a fast delivery callback (fake-twilio fires 'sent' at +150ms; real
      //    Twilio can be just as fast) can arrive before the pointer lands.
      //  - system sends: verify-start writes the syssid# marker AFTER the
      //    adapter send returns — the same outrun window.
      // Wait once, then retry the lookups before declaring the outcome lost.
      await delay(statusRetryDelayMs);
      message = await messages.getByProviderSid(MessageSid);
      if (!message) relayPtr = await messages.getRelaySidPointer(MessageSid);
      if (!message && !relayPtr) systemMarker = await messages.getSystemSidMarker(MessageSid);
    }
    if (relayPtr) {
      await handleRelayRecipientStatus(relayPtr);
      res.status(200).end();
      return;
    }
    if (systemMarker) {
      // A known system send (no message row BY DESIGN — e.g. a cell-verification
      // code). INFO, never the alarm-feeding ERROR: the loop is closed, there is
      // just nothing to attach the outcome to.
      log.info(
        { providerSid: MessageSid, providerStatus: MessageStatus, kind: systemMarker.kind },
        'delivery receipt for a system send — acked (no message row by design)',
      );
      res.status(200).end();
      return;
    }
    if (!message) {
      // Still unknown after the retry: either the send/append race lasted
      // longer than the window, or the process crashed between provider send
      // and append (the crash-orphan window) — a delivery outcome we cannot
      // attach to any message. ERROR on purpose (feeds the
      // hc-<env>-error-logs alarm): this is the §7.1 "closing the loop"
      // backstop — a silently dropped status would otherwise hide a failed
      // send forever. Still ack 200 so Twilio doesn't redeliver into the
      // same gap.
      log.error(
        { providerSid: MessageSid, providerStatus: MessageStatus },
        'status callback for unknown provider SID after retry — delivery outcome dropped',
      );
      res.status(200).end();
      return;
    }
    mergeContext({ conversationId: message.conversationId });

    // Forward-only transition; false = regression/duplicate → side effects
    // are SKIPPED, which also makes redelivered failure callbacks enqueue
    // exactly one retry.
    const mappedStatus = mapTwilioStatus(MessageStatus);
    const transitioned = await messages.updateDeliveryStatus(MessageSid, mappedStatus, ErrorCode);
    log.info(
      { providerSid: MessageSid, providerStatus: MessageStatus, errorCode: ErrorCode, transitioned },
      'twilio delivery status callback processed',
    );

    // Delivery-failure marker (doc §9 "Send failures / delivery errors"): a
    // callback that resolves to undelivered/failed is a countable failed
    // delivery. Severity follows the taxonomy — a TERMINAL failure is an ERROR
    // (feeds the error-logs alarm + Recent Errors panel); a transient-retrying /
    // opt-out (21610) callback stays WARN. The `event` field is unchanged, so the
    // DeliveryFailures count metric (keyed on `event`, not level) is unaffected.
    // IDs/codes only, never the body (PII).
    if (mappedStatus === 'undelivered' || mappedStatus === 'failed') {
      const failure = {
        event: 'delivery_failed',
        providerSid: MessageSid,
        errorCode: ErrorCode,
        providerStatus: MessageStatus,
      };
      const failureMsg = 'twilio delivery failed (undelivered/failed)';
      if (isTerminalDeliveryFailure(ErrorCode)) log.error(failure, failureMsg);
      else log.warn(failure, failureMsg);
    }

    if (transitioned) {
      // SSE (M1.2): a REAL transition updates delivery badges live.
      // Regressions/duplicates were no-ops above and emit nothing — so a
      // redelivered callback never re-fires the dashboard.
      events.emit('message.persisted', {
        conversationId: message.conversationId,
        tsMsgId: message.tsMsgId,
        direction: message.direction,
        deliveryStatus: mappedStatus,
      });

      // (M1.8a) Share-broadcast rollup: when THIS message belongs to a
      // broadcast, fold its delivered/failed terminal status into the
      // broadcast's recipient slot (forward-only) + stats, and emit the
      // broadcast.updated SSE event. O(1): the message carries broadcast_id +
      // its own conversationId/tsMsgId, so we load the broadcast by id and
      // find the matching recipient slot by those keys (no new GSI). Only
      // terminal transitions move the rollup — a sent→delivered (no failed)
      // bumps `delivered`; *→failed bumps `failed`. Never 5xx the callback.
      if (typeof message.broadcast_id === 'string' && message.broadcast_id.length > 0) {
        try {
          await rollIntoBroadcast(
            broadcasts,
            events,
            log,
            message.broadcast_id,
            message.conversationId,
            message.tsMsgId,
            mappedStatus,
            ErrorCode,
            statusRetryDelayMs,
          );
        } catch (err) {
          log.error({ err, providerSid: MessageSid, broadcastId: message.broadcast_id }, 'broadcast delivery rollup failed — message status recorded, broadcast stats stale');
        }
      }

      // (M1.10c) Escalation (doc §7.1): a failed send on a placement-linked
      // conversation raises the placement's attention flag so a human calls. Gated
      // on the failure CLASS (undelivered/failed), NOT on ErrorCode — a failed/
      // canceled callback may carry no error code — mirroring the relay-leg
      // branch above. Today 1:1 threads aren't placement-linked → this is a no-op on
      // the 1:1 path (the dominant relay-leg failures escalate at the relay-
      // recipient branch); kept here so a future placement-linked 1:1 escalates with
      // no extra wiring. Best-effort (flagPlacementAttention never throws/5xxs).
      if (mappedStatus === 'undelivered' || mappedStatus === 'failed') {
        await flagPlacementAttention(message.conversationId, 'send_failed');
      }
    }

    if (transitioned && ErrorCode) {
      // Error-class-aware handling (doc §7.1): transient retry (30003) / contact
      // flag (30005/30006/21610) / suppression-confirm. Placement escalation is
      // handled ABOVE on the failure-class gate (not here — a failed/canceled
      // callback may carry no ErrorCode).
      try {
        switch (ErrorCode) {
          case '30003': {
            // Transient (handset unreachable): ONE scheduled retry with
            // backoff, capped chain (attempt count rides the job payload).
            const priorAttempt = message.retry_attempt ?? 0;
            if (priorAttempt >= MAX_SEND_RETRY_ATTEMPTS) {
              // Retries exhausted → the transient failure is now TERMINAL, so it
              // graduates to an error (the delivery_failed marker above logged
              // this callback at warn, as 30003 is in the transient set).
              log.error(
                { providerSid: MessageSid, attempt: priorAttempt, errorCode: ErrorCode },
                'transient delivery failure exhausted retries — terminal, giving up',
              );
              break;
            }
            await enqueueSendRetry({
              providerSid: MessageSid,
              conversationId: message.conversationId,
              attempt: priorAttempt + 1,
            });
            break;
          }
          case '30005':
          case '30006': {
            // Permanent (invalid number / landline): flag the CONTACT, not
            // the message — prompt voice instead. Never retry. BE1 number-scoped:
            // only flag when the failing number IS the contact's PRIMARY
            // (participant_phone === contact.phone) — an unreachable SECONDARY
            // number must not suppress the contact's good primary.
            const conversation = await conversations.getById(message.conversationId);
            // NATIVE GROUP TEXTS ARE REACHABLE HERE. A classic status callback
            // for a group leg in the pre-marker window resolves to the GROUP
            // thread, which carries NO participant_phone - so the lookup below
            // finds no contact and the whole case degrades to a log line. That
            // outcome is CORRECT (there is no single member to flag: a group
            // failure says nothing about any one number), but it is a distinct
            // situation from "we have a number and no contact record", so it
            // says so and logs ONCE per sid instead of on every redelivery.
            if (conversation?.type === 'group_text') {
              logDegradationOnce(`${ErrorCode}:${MessageSid}`, () => {
                log.warn(
                  { providerSid: MessageSid, errorCode: ErrorCode },
                  'sms_unreachable on a group_text thread - no single member to flag (group legs report per-recipient)',
                );
              });
              break;
            }
            const convPhone = conversation?.participant_phone;
            const contact = convPhone !== undefined ? await contacts.findByPhone(convPhone) : undefined;
            if (contact && convPhone === contact.phone) {
              await contacts.setFlag(contact.contactId, 'sms_unreachable');
            } else if (contact) {
              log.warn(
                { providerSid: MessageSid, errorCode: ErrorCode },
                'sms_unreachable on a non-primary attached number — contact flag NOT set (number-scoped)',
              );
            } else {
              logDegradationOnce(`${ErrorCode}:${MessageSid}`, () => {
                log.warn(
                  { providerSid: MessageSid, errorCode: ErrorCode },
                  'sms_unreachable: no contact record to flag',
                );
              });
            }
            break;
          }
          case '30007': {
            // Carrier filtering: NEVER retry (re-sending filtered content
            // compounds reputation damage). The delivery_failed marker above
            // already logged this at ERROR (30007 is terminal) and carries the
            // alarm; this is the no-retry context note (WARN to avoid a
            // duplicate error line/alarm count for the same event).
            log.warn(
              { providerSid: MessageSid, errorCode: ErrorCode },
              'carrier filtering (30007) — message suppressed by carrier, not retried',
            );
            break;
          }
          case '21610': {
            // Provider-side opt-out suppression: confirm our suppression
            // state + audit. Never retry. BE1 number-scoped: only flag + audit
            // on the contact when the suppressed number IS the contact's PRIMARY
            // (participant_phone === contact.phone) — a 21610 on a SECONDARY
            // number must not suppress the contact's good primary.
            const conversation = await conversations.getById(message.conversationId);
            // NATIVE GROUP TEXTS ARE REACHABLE HERE, exactly as on the
            // 30005/30006 twin above: a classic status callback for a group leg
            // resolves to the GROUP thread, which carries no participant_phone.
            // RULING (invariant 13.8): this arm writes NOTHING for a group
            // thread. A 21610 on a group leg is per-RECIPIENT information that
            // the classic callback does not carry, so there is no number to
            // scope the suppression to and guessing would suppress the wrong
            // handset. Spec 15.8's receipts-side 21610 bookkeeping (the
            // per-member map on the Conversations rail) is S5/T5.3's job and
            // builds on this branch; until then, say so ONCE per sid instead of
            // falling into "no contact record to flag" on every redelivery.
            if (conversation?.type === 'group_text') {
              logDegradationOnce(`${ErrorCode}:${MessageSid}`, () => {
                log.warn(
                  { providerSid: MessageSid, errorCode: ErrorCode },
                  '21610 suppression on a group_text thread - no single member to scope it to, nothing flagged (per-member receipts land in S5)',
                );
              });
              break;
            }
            const convPhone = conversation?.participant_phone;
            const contact = convPhone !== undefined ? await contacts.findByPhone(convPhone) : undefined;
            if (contact && convPhone === contact.phone) {
              await contacts.setFlag(contact.contactId, 'sms_opt_out');
              await audit.append(`contacts#${contact.contactId}`, 'sms_opt_out_recorded', {
                providerSid: MessageSid,
                conversationId: message.conversationId,
                source: 'twilio_21610',
              });
            } else if (contact) {
              log.warn(
                { providerSid: MessageSid, errorCode: ErrorCode },
                '21610 suppression on a non-primary attached number — contact flag NOT set (number-scoped)',
              );
            } else {
              logDegradationOnce(`${ErrorCode}:${MessageSid}`, () => {
                log.warn({ providerSid: MessageSid, errorCode: ErrorCode }, '21610 suppression: no contact record to flag');
              });
            }
            break;
          }
          default:
            log.warn(
              { providerSid: MessageSid, errorCode: ErrorCode },
              'unhandled delivery error code — recorded on the message, no automated action',
            );
        }
      } catch (err) {
        // Side-effect failures never 5xx the callback: Twilio's redelivery
        // would no-op at the status transition anyway. ERROR = alarmed.
        log.error({ err, providerSid: MessageSid, errorCode: ErrorCode }, 'delivery-error side effect failed');
      }
    }

    res.status(200).end();
  });

  return router;
}

/**
 * Forward-only terminal transitions for a broadcast recipient slot — mirrors
 * the messages delivery-status machine but over the broadcast slot's smaller
 * state set ('queued'|'sent'|'delivered'|'failed'|'skipped'). Only `delivered`
 * and `failed` are reachable here (delivery callbacks), and a terminal slot
 * (delivered/failed/skipped) never regresses.
 */
function broadcastSlotMayTransition(current: BroadcastRecipient['status'] | undefined): boolean {
  // A terminal slot (delivered/failed/skipped) never regresses; queued or sent
  // → delivered/failed are both forward moves.
  return current !== 'delivered' && current !== 'failed' && current !== 'skipped';
}

/**
 * (M1.8a) Roll a 1:1 delivery-status transition into the owning broadcast: find
 * the recipient slot whose persisted conversationId+tsMsgId match this message,
 * apply the forward-only terminal status, bump the broadcast's delivered/failed
 * counter, and emit broadcast.updated. O(1) load-by-id; the slot is found by
 * scanning the broadcast's (bounded) recipients map for the matching keys.
 */
async function rollIntoBroadcast(
  broadcasts: BroadcastsRepo,
  events: EventBus,
  log: Logger,
  broadcastId: string,
  conversationId: string,
  tsMsgId: string,
  deliveryStatus: DeliveryStatus,
  errorCode: string | undefined,
  statusRetryDelayMs: number,
): Promise<void> {
  // Terminal outcomes (delivered/failed) transition the slot + stats. The
  // carrier's NON-terminal 'sent' instead stamps the carrierSentAt marker: the
  // fan-out's dispatch already claimed the slot as status 'sent' (its
  // idempotency claim - it must NOT start at 'queued', a continuation pass
  // re-sends queued slots), but until the carrier confirms, every read surface
  // presents that slot as in-flight ("Sending...") so the recipient row agrees
  // with the message's own 1:1 bubble at every instant. Other intermediates
  // (queued) have nothing to add.
  const next: 'delivered' | 'failed' | undefined =
    deliveryStatus === 'delivered'
      ? 'delivered'
      : deliveryStatus === 'failed' || deliveryStatus === 'undelivered'
        ? 'failed'
        : undefined;
  if (next === undefined && deliveryStatus !== 'sent') return;

  const broadcast = await broadcasts.getById(broadcastId);
  if (!broadcast) {
    log.warn({ broadcastId }, 'broadcast delivery rollup: broadcast not found — ignored');
    return;
  }
  // Find the recipient slot for THIS message (matched by the persisted
  // conversationId + tsMsgId stamped at send time).
  const matchesSlot = (r: BroadcastRecipient): boolean =>
    r.conversationId === conversationId && r.tsMsgId === tsMsgId;
  let entry = Object.entries(broadcast.recipients ?? {}).find(([, r]) => matchesSlot(r));
  if (!entry) {
    // The fan-out persists the recipient slot a beat AFTER the provider send
    // (post-send A2P pacing), so a fast delivery callback can arrive before the
    // slot lands. Re-load the broadcast ONCE after a short wait before declaring
    // the outcome lost — same delay seam as the /status unknown-SID retry.
    // Worst case a callback that misses BOTH lookups (message, then slot) acks
    // after ~2x statusRetryDelayMs (~5s default) — bounded, well under Twilio's
    // webhook timeout, and only on the genuine-miss path.
    await delay(statusRetryDelayMs);
    const reloaded = await broadcasts.getById(broadcastId);
    entry = reloaded
      ? Object.entries(reloaded.recipients ?? {}).find(([, r]) => matchesSlot(r))
      : undefined;
    if (!entry) {
      log.warn({ broadcastId, conversationId }, 'broadcast delivery rollup: no matching recipient slot — ignored');
      return;
    }
  }
  const [contactKey, slot] = entry;
  if (!broadcastSlotMayTransition(slot.status)) {
    // Forward-only: a terminal slot never regresses (out-of-order/duplicate
    // callbacks). No stat change, no emit.
    return;
  }

  if (next === undefined) {
    // deliveryStatus === 'sent': stamp the carrier-confirmed marker. No stats
    // bump (the persisted counters keep their dispatch semantics - the fan-out
    // already counted this leg); the emit's DERIVED stats move the slot from
    // the in-flight bucket to `sent`, flipping the row "Sending..." -> "Sent"
    // live. The message state machine gates redeliveries upstream
    // (`transitioned`), and the marker guard below makes a late duplicate a
    // silent no-op rather than a re-stamp.
    if (slot.status !== 'sent' || slot.carrierSentAt !== undefined) return;
    const applied = await broadcasts.setRecipient(
      broadcastId,
      contactKey,
      { ...slot, carrierSentAt: new Date().toISOString() },
      ['sent'],
    );
    if (!applied) return;
    const item = await broadcasts.getById(broadcastId);
    if (item) {
      events.emit('broadcast.updated', {
        broadcastId,
        status: item.status,
        stats: deriveBroadcastStats(item),
      });
    }
    log.info({ broadcastId }, 'broadcast recipient carrier-sent marker rolled in');
    return;
  }

  // Atomic forward-only transition: condition the slot write on the slot still
  // being in a non-terminal predecessor state (queued|sent). Two concurrent
  // callbacks for the same SID both read the same `slot` above and both pass the
  // in-memory check — but only ONE wins this conditional write; the other
  // returns false and is skipped, so `delivered`/`failed` is bumped exactly
  // once per recipient transition (no double-increment race).
  const applied = await broadcasts.setRecipient(
    broadcastId,
    contactKey,
    {
      ...slot,
      status: next,
      ...(errorCode !== undefined && { errorCode }),
    },
    ['queued', 'sent'],
  );
  if (!applied) {
    // Another callback already transitioned this slot — do NOT bump stats.
    return;
  }
  // Stats (S4 disjoint model, persisted-counter hygiene): a sent->delivered move
  // bumps `delivered` AND decrements `sent` (the recipient moves buckets, it is
  // not double-counted) - mirroring the *->failed case. A *->failed move bumps
  // `failed`; if the slot was 'sent', decrement `sent` too. This keeps the
  // persisted counters consistent with the disjoint model on new broadcasts;
  // historical rows keep their old cumulative counters but STILL display
  // correctly because every read path derives from the recipients map.
  const fromSent = slot.status === 'sent';
  const delta =
    next === 'delivered'
      ? { delivered: 1, ...(fromSent && { sent: -1 }) }
      : { failed: 1, ...(fromSent && { sent: -1 }) };
  const updated = await broadcasts.bumpStats(broadcastId, delta);
  // The emit carries DERIVED disjoint stats from the ALL_NEW item (zero extra
  // reads), so the dashboard chips reconcile to the recipients map.
  events.emit('broadcast.updated', {
    broadcastId,
    status: updated.status,
    stats: deriveBroadcastStats(updated),
  });
  log.info({ broadcastId, deliveryStatus: next }, 'broadcast delivery rolled into stats');
}
