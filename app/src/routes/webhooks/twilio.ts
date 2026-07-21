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
import { logger as defaultLogger, type Logger } from '../../lib/logger.js';
import { classifyInboundKeyword } from '../../lib/smsCompliance.js';
import { resolveMessage, resolveWithSettings } from '../../messages/index.js';
import { twilioSignatureMiddleware } from '../../middleware/twilioSignature.js';
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
import { isMemberSuppressed, logSafeMemberKey } from '../../services/relayAnnouncements.js';
import {
  enqueueSendRetry,
  MAX_SEND_RETRY_ATTEMPTS,
} from '../../jobs/retrySend.js';
import { enqueueImmediate } from '../../jobs/jobs.js';
import { RELAY_FANOUT_JOB } from '../../jobs/relayFanOut.js';

/** Empty TwiML acknowledgment — "received, no reply instructions". */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/**
 * TwiML wrapper for a single reply message — the idiomatic Twilio mechanism for
 * a webhook to answer inbound SMS. WE own the keyword replies now (spec §6):
 * Twilio Advanced Opt-Out auto-reply is OFF (operator step), so a matched
 * keyword's filed reply is returned HERE. Critically, the STOP confirmation goes
 * to a JUST-opted-out number, so it must ride the TwiML response — NOT the
 * opt-out-GATED sendMessage wrapper (which would refuse it). XML-escape the body
 * so filed copy can never break the TwiML.
 */
function messageTwiml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(body)}</Message></Response>`;
}

/** Minimal XML entity escaping for a TwiML text node (filed copy is trusted, but
 *  ampersands/angle brackets must still be escaped to stay well-formed). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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
   * Org settings — read at the START/opt-in keyword reply so it honors the
   * operator's `welcomeText` override (resolveWithSettings('welcome.sms')),
   * matching the housing-fair path. Injectable in tests; the real repo otherwise.
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
}

/** Default wait before the one unknown-SID retry in /status (see above). */
const STATUS_UNKNOWN_SID_RETRY_DELAY_MS = 2_500;

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
  const ourNumbers = new Set(config.ourPhoneNumbers);
  const statusRetryDelayMs = deps.statusUnknownSidRetryDelayMs ?? STATUS_UNKNOWN_SID_RETRY_DELAY_MS;

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
  ): Promise<string | undefined> {
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
      senderContact?.type === 'landlord' || senderContact?.type === 'tenant'
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
    // W4 (SF-2) OptOutType coupling: we run with Twilio Advanced Opt-Out OFF
    // (A2P checklist). classifyInboundKeyword returns a kind on OptOutType alone
    // regardless of body; were Advanced Opt-Out ever flipped ON, a full sentence
    // "stop the listings but keep the tour" would carry OptOutType=STOP and be
    // treated as a command here, swallowing it from the group. That is the
    // compliance-correct direction (Twilio also actions the opt-out itself), and
    // the W3 narrowing already guards the opt-in (YES) case - keep Advanced
    // Opt-Out OFF so human sentences are never reclassified.
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
    }

    // Keyword processing (spec 3.2): the SHARED seam runs against the sender's
    // OWN 1:1 (closed-intercept idiom) - the conversation opt-out flag must land
    // on their per-phone thread, NEVER on the relay group. The keyword message
    // itself stays on the relay thread (persisted above for the audit trail).
    // Gated on isCommand (NOT kind): an unsuppressed opt-in is content and was
    // already fanned out above, so it must skip keyword processing entirely.
    let keywordReply: string | undefined;
    if (isCommand) {
      const effectiveContact = senderContact ?? (await contacts.findByPhone(From));
      const oneToOne = await conversations.createOrGetByParticipantPhone(
        From,
        conversationTypeFor(effectiveContact),
      );
      keywordReply = await processInboundKeywords({
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
    return keywordReply;
  }

  // ---------------------------------------------------------------------
  // Keyword handling (STOP / HELP / opt-in) - spec sec 6, WE own the replies.
  // Extracted from the /sms handler so the closed-group intercept can REUSE the
  // SAME logic path (relay-number-lifecycle AF-4: a closed-group member's STOP
  // to the pool number must suppress exactly like a STOP to the main number did
  // pre-feature, when a closed group's cleared number fell through to the 1:1).
  // Sets the conversation opt-out flag, the CONTACT flag only on the primary
  // number (BE1 number-scope), stamps inbound_text consent, audits, and returns
  // the filed reply (STOP confirmation / HELP / welcome) to ride the TwiML
  // response. Best-effort: a repo failure is logged and NEVER crashes the
  // webhook (the message is already persisted). PII: SIDs/IDs only.
  // ---------------------------------------------------------------------
  async function processInboundKeywords(input: {
    conversation: ConversationItem;
    effectiveContact: ContactItem | undefined;
    From: string;
    Body: string | undefined;
    OptOutType: string | undefined;
    MessageSid: string;
  }): Promise<string | undefined> {
    const { conversation, effectiveContact, From, Body, OptOutType, MessageSid } = input;
    let keywordReply: string | undefined;
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

      if (isHelp) {
        // HELP: no suppression change. Reply the filed HELP copy (declares no
        // phone number - verified in lib/smsCompliance.ts + its test).
        keywordReply = resolveMessage('keyword.help');
      } else if (optedOut || optedIn) {
        // The CONVERSATION flag is always written - a STOP from a phone with
        // no contact record yet (auto-capture is M1.2) must still suppress
        // every later send. The send wrapper gates on either flag.
        await conversations.setSmsOptOut(conversation.conversationId, optedOut);
        const eventType = optedOut ? 'sms_opt_out_recorded' : 'sms_opt_out_cleared';
        const source =
          OptOutType === 'STOP' || OptOutType === 'START' ? 'OptOutType' : 'keyword';
        // BE1 number-scoped consent: the CONTACT-level flag (which suppresses the
        // contact's GOOD primary number across broadcasts + 1:1 sends) is set ONLY
        // when the STOP/START arrived on the contact's PRIMARY number (From ===
        // contact.phone). A STOP on an ATTACHED secondary number must NOT
        // contaminate the primary - the conversation-level flag above already
        // suppresses this thread (the correct per-number scope).
        const isPrimaryNumber =
          effectiveContact !== undefined && From === effectiveContact.phone;
        if (effectiveContact && isPrimaryNumber) {
          if (optedOut) await contacts.setFlag(effectiveContact.contactId, 'sms_opt_out');
          else await contacts.clearFlag(effectiveContact.contactId, 'sms_opt_out');
          await audit.append(`contacts#${effectiveContact.contactId}`, eventType, {
            providerSid: MessageSid,
            conversationId: conversation.conversationId,
            source,
          });
          // Opt-in (START/JOIN/HOME/YES/UNSTOP) is a documented affirmative
          // opt-in (spec sec 6): if this (primary-number) contact has NO
          // consent_method yet, stamp inbound_text so proactive sends aren't
          // JIT-gated. Idempotent - only stamped when absent (never overwrites
          // a web_form / verbal record). Best-effort inside the same try.
          if (optedIn && !effectiveContact.consent_method) {
            await contacts.update(effectiveContact.contactId, {
              consent_method: 'inbound_text',
              consent_at: new Date().toISOString(),
            });
          }
        } else if (effectiveContact) {
          // Non-primary (attached) number: the contact flag is NOT touched (per-
          // number scope) - only this conversation is suppressed (above). Audit on
          // the conversation so the trail records the number-scoped opt-out/in.
          log.info(
            { providerSid: MessageSid, optOut: optedOut },
            'opt-out/in on a non-primary attached number - conversation suppressed, contact flag NOT changed (number-scoped)',
          );
          await audit.append(`conversations#${conversation.conversationId}`, eventType, {
            providerSid: MessageSid,
            conversationId: conversation.conversationId,
            source,
          });
        } else {
          // Only reachable when auto-capture itself failed above - the
          // conversation flag still suppresses every later send.
          log.warn(
            { providerSid: MessageSid, optOut: optedOut },
            'opt-out/in from a phone with no contact record - conversation flagged, no contact to flag (auto-capture failed)',
          );
          await audit.append(`conversations#${conversation.conversationId}`, eventType, {
            providerSid: MessageSid,
            conversationId: conversation.conversationId,
            source,
          });
        }
        // The filed reply for the matched keyword (rides the TwiML response).
        // STOP -> the compliance-locked confirmation; opt-in/START -> the welcome,
        // resolved through settings so an operator `welcomeText` override is
        // honored (sec 7 - matches the housing-fair path; today's raw-constant use
        // ignored the override).
        keywordReply = optedOut
          ? resolveMessage('keyword.stop')
          : await resolveWithSettings('welcome.sms', undefined, { settingsRepo: settings });
      }
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'opt-out recording failed - message persisted, flag NOT updated');
    }
    return keywordReply;
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
  // number - the filed reply is returned to the caller to ride the TwiML.
  // ---------------------------------------------------------------------
  async function handleClosedGroupInbound(
    group: ConversationItem,
    msg: {
      MessageSid: string;
      From: string;
      Body: string | undefined;
      params: WebhookParams;
    },
  ): Promise<string | undefined> {
    const { MessageSid, From, Body } = msg;
    const mediaUrls = parseInboundMediaUrls(msg.params);

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
      // claim tenant/landlord authorship; everything else is `unknown`.
      author:
        contact?.type === 'landlord' || contact?.type === 'tenant' ? contact.type : 'unknown',
      // Inbound messages are received by definition.
      deliveryStatus: 'delivered',
      // Provenance: the pool number this reached only matches From on the CLOSED
      // group <group.conversationId>. The dashboard badges the 1:1 bubble off it.
      viaClosedGroup: group.conversationId,
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
    // block). The message already landed above; the returned reply rides the
    // TwiML the caller sends.
    return processInboundKeywords({
      conversation,
      effectiveContact: contact,
      From,
      Body,
      OptOutType: msg.params['OptOutType'],
      MessageSid,
    });
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
    if (ourNumbers.has(From)) {
      log.info({ providerSid: MessageSid }, 'twilio webhook echo (From is our number) — acknowledged, dropped');
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }
    // Multiplexing: a pool number fronts MANY groups (open + closed), so the
    // echo guard checks getAllByPoolNumber (any group, open or closed). The
    // voice-only getByPoolNumber wrapper is no longer used on the SMS path.
    if ((await conversations.getAllByPoolNumber(From)).length > 0) {
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
          // Parity with the closed intercept: an open-path keyword (STOP/HELP/
          // opt-in) returns its filed reply to ride the TwiML; a normal relay
          // returns undefined -> empty ack.
          const relayReply = await handleRelayInbound(openMatch, { MessageSid, From, To, Body, params });
          res.type('text/xml').send(
            relayReply !== undefined ? messageTwiml(relayReply) : EMPTY_TWIML,
          );
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
          // AF-4: the intercept processes STOP/opt-out and returns the filed
          // reply (STOP confirmation / HELP / welcome), which rides the TwiML.
          const closedReply = await handleClosedGroupInbound(closedMatch, {
            MessageSid,
            From,
            Body,
            params,
          });
          res.type('text/xml').send(
            closedReply !== undefined ? messageTwiml(closedReply) : EMPTY_TWIML,
          );
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
          // Same reply-riding-TwiML contract as the open-roster match above (an
          // unknown-sender STOP still gets its confirmation).
          const relayReply = await handleRelayInbound(openFallback, { MessageSid, From, To, Body, params });
          res.type('text/xml').send(
            relayReply !== undefined ? messageTwiml(relayReply) : EMPTY_TWIML,
          );
          return;
        }
        // else: every group on this number is closed -> fall through to (2).
      }
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
      // type may claim tenant/landlord authorship; everything else is
      // `unknown` until a human types the contact (M1.4/M1.5).
      author:
        contact?.type === 'landlord' || contact?.type === 'tenant' ? contact.type : 'unknown',
      // Inbound messages are received by definition; the outbound delivery
      // machine never transitions them.
      deliveryStatus: 'delivered',
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

    // (4) STOP / HELP / START keyword handling (spec §6 — WE own the replies).
    // Twilio Advanced Opt-Out auto-reply is OFF (operator step) so no double
    // confirmations; the filed reply is returned as TwiML at the ack below. The
    // message itself stays on the timeline either way (persisted above).
    //   - opt-out keyword → suppress + reply STOP_CONFIRMATION;
    //   - HELP           → reply HELP_REPLY (no flag change);
    //   - opt-in keyword → clear suppression, stamp inbound_text consent if the
    //                      contact has none, reply WELCOME_SMS.
    // `keywordReply` is captured here and emitted as the TwiML response at the
    // end of the handler. The STOP confirmation MUST ride this TwiML response,
    // NOT the opt-out-gated sendMessage wrapper (which would refuse a send to a
    // just-opted-out number).
    // Shared with the closed-group intercept (AF-4) so both inbound paths honor
    // STOP identically. keywordReply rides the TwiML response at the ack below.
    const keywordReply = await processInboundKeywords({
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
        keywordReply: keywordReply !== undefined,
      },
      'twilio inbound message processed',
    );
    // A matched keyword (STOP/HELP/opt-in) returns its filed reply as a TwiML
    // <Message>; every other inbound acks with empty TwiML. NO PII in the body
    // (all filed copy). The STOP confirmation reaching a just-opted-out number
    // is exactly why this rides the TwiML response, not the gated send wrapper.
    res.type('text/xml').send(keywordReply !== undefined ? messageTwiml(keywordReply) : EMPTY_TWIML);
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
      // undelivered/failed is also a countable failed delivery. Same `event`
      // field the DeliveryFailures metric filter keys on; IDs/codes only.
      if (mapped === 'undelivered' || mapped === 'failed') {
        log.warn(
          { event: 'delivery_failed', providerSid: MessageSid, errorCode: ErrorCode, providerStatus: MessageStatus, relay: true },
          'twilio relay-recipient delivery failed (undelivered/failed)',
        );
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
    // delivery. The `event` field is what the observability DeliveryFailures
    // metric filter keys on; IDs/codes only, never the body (PII). 30007
    // additionally ERROR-logs below — this WARN marker is the countable signal,
    // so both fire (the alarm counts deliveries, not error severity).
    if (mappedStatus === 'undelivered' || mappedStatus === 'failed') {
      log.warn(
        { event: 'delivery_failed', providerSid: MessageSid, errorCode: ErrorCode, providerStatus: MessageStatus },
        'twilio delivery failed (undelivered/failed)',
      );
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
              log.warn(
                { providerSid: MessageSid, attempt: priorAttempt },
                'transient delivery failure but retry cap reached — giving up',
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
            const contact = conversation ? await contacts.findByPhone(conversation.participant_phone) : undefined;
            if (contact && conversation?.participant_phone === contact.phone) {
              await contacts.setFlag(contact.contactId, 'sms_unreachable');
            } else if (contact) {
              log.warn(
                { providerSid: MessageSid, errorCode: ErrorCode },
                'sms_unreachable on a non-primary attached number — contact flag NOT set (number-scoped)',
              );
            } else {
              log.warn({ providerSid: MessageSid, errorCode: ErrorCode }, 'sms_unreachable: no contact record to flag');
            }
            break;
          }
          case '30007': {
            // Carrier filtering: NEVER retry (re-sending filtered content
            // compounds reputation damage). ERROR feeds the
            // hc-<env>-error-logs alarm; a dedicated deliverability alarm
            // (filtered-rate metric) is future work.
            log.error(
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
            const contact = conversation ? await contacts.findByPhone(conversation.participant_phone) : undefined;
            if (contact && conversation?.participant_phone === contact.phone) {
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
              log.warn({ providerSid: MessageSid, errorCode: ErrorCode }, '21610 suppression: no contact record to flag');
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
