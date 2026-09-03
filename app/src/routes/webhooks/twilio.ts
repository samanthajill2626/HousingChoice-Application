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
import { Router } from 'express';
import type { MediaStore } from '../../adapters/mediaStore.js';
import { createMediaStore } from '../../adapters/mediaStore.js';
import {
  createMessagingAdapter,
  mapTwilioStatus,
  type MessagingAdapter,
} from '../../adapters/messaging.js';
import { nativeGroupInboundActualTransport } from '../../adapters/groupConversations.js';
import {
  normalizeTwilioTransportEvidence,
  type NormalizedTransportEvidence,
  type TwilioTransportEvidenceInput,
} from '../../adapters/twilioMessageTransport.js';
import { mergeContext } from '../../lib/context.js';
import {
  TRANSPORT_SCHEMA_VERSION,
  type MessageTransport,
} from '../../lib/messageTransport.js';
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
import {
  createContactsRepo,
  isDeleted,
  type ContactItem,
  type ContactsRepo,
} from '../../repos/contactsRepo.js';
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
import { resolveRelayInbound } from '../../services/relayInboundResolution.js';
import {
  isMemberSuppressed,
  logSafeMemberKey,
  SYSTEM_SENDER_KEY,
} from '../../services/relayAnnouncements.js';
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
import {
  INLINE_MIRROR_DELAYS_MS,
  mirrorMediaSet,
  type MediaMirrorTarget,
} from '../../services/mediaMirror.js';
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
import {
  enqueueMediaMirror,
  mediaMirrorBackoffMs,
  type MediaMirrorPayload,
} from '../../jobs/mediaMirror.js';
import {
  composeRelayBody,
  persistRelayRecipientResult,
  RELAY_FANOUT_JOB,
  setVersionedAggregationState,
  TEAM_SENDER_KEY,
  TEAM_SENDER_LABEL,
  type RelayLegPayload,
  type RelayTransportMode,
} from '../../jobs/relayFanOut.js';
import { enqueueRelayRetryLeg } from '../../jobs/relayRetryLeg.js';
import {
  MAX_RELAY_RETRY_ATTEMPTS,
  relayRetryDigest,
  relayRetryProviderSid,
  type RelayRetryClaimOutcome,
} from '../../lib/relayRetryClaim.js';
import { resolveMessage } from '../../messages/index.js';

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
//
// READ THIS BEFORE TRUSTING THE 30003 CARVE-OUT. "still auto-retrying" is a
// claim about the path the leg is on, and it is NOT true on every path:
//
//   - NATIVE GROUP TEXT: the 30003 arm below enqueues messaging.retrySend, whose
//     handler goes through sendMessage, which REFUSES a group_text conversation
//     outright (GroupTextSendNotSupportedError, services/sendMessage.ts:298-300).
//     The retry is enqueued and never sends, so the WARN records a promise the
//     repo already disproves. Tracked, unverified end to end, in
//     docs/issues/group-text-30003-leg-retry-promise-unverified.md - which is
//     where a fix belongs; do not "fix" it by widening this set.
//   - RELAY: this set no longer decides relay severity at all. The relay branch
//     reads isTerminalRelayLegFailure below, which is attempt-aware - WARN while
//     a rung is actually claimed or the leg's own slot is already SETTLED on
//     some other end state (slot_settled), ERROR once the ladder is a real dead
//     end - including the internal anomaly where the slot is missing or was
//     never written (slot_ineligible).
//
// The set's VALUES are unchanged, and the 1:1 path they still govern is the one
// path where the promise holds.
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

/** The one carrier code that claims a relay retry (spec D8, global constraint). */
const RELAY_RETRY_TRIGGER_CODE = '30003';

/**
 * `relayFanOut.ts`'s own anonymous-sender label (`:109`), mirrored here because
 * it is module-private there and the claim path has to reproduce a leg copy
 * BYTE FOR BYTE (spec D12). Kept beside the composition it belongs to so a
 * change on either side is visible as a diff on the other.
 */
const RELAY_ANONYMOUS_SENDER_LABEL = 'A member';

/**
 * The relay failure marker's message, for the outcomes that are OURS rather
 * than the carrier's. Every other outcome takes the shared carrier-shaped line;
 * these three would be misread as one more unreachable handset, which is
 * exactly the misattribution D23's `retryClaim` field exists to prevent.
 *
 * A PARTIAL record on purpose - `Object.prototype` is not reachable here (the
 * key is our own closed union, never wire data), and the caller's `??` supplies
 * the shared message for everything absent.
 */
const RELAY_ANOMALY_FAILURE_MESSAGES: Partial<Record<RelayRetryClaimOutcome, string>> = {
  source_unreadable:
    'twilio relay-recipient delivery failed - source message row unreadable, no retry claimed',
  claim_failed:
    'twilio relay-recipient delivery failed - the retry claim itself threw, no retry claimed',
  slot_ineligible:
    'twilio relay-recipient delivery failed - the member delivery slot is missing or was never written, no retry claimed',
};

/** What the claim decided, plus the rung it claimed (for the failure log). */
interface RelayRetryClaimResult {
  outcome: RelayRetryClaimOutcome;
  /** The 1-based rung, present only where a retry ROW exists for it. */
  attempt?: number;
}

/**
 * The RELAY branch's own severity call (spec D23), attempt-aware ON TOP of the
 * shared carve-outs rather than instead of them. A relay leg logs WARN while a
 * retry is actually claimed and ERROR once the chain is a real dead end.
 *
 * Four properties are load-bearing and none is obvious:
 *
 *   - 21610 keeps its carve-out. A purely attempt-aware rule would alarm on the
 *     platform correctly honoring STOP, which is a strictly larger increase than
 *     the one the founder approved.
 *   - An ANNOUNCEMENT leg (`fenced_announcement`) stays WARN. No retry is ever
 *     claimed for a relay intro, member-added, group-closed or tour-reminder
 *     rung, so "ERROR whenever no retry was claimed" would alarm every one of
 *     them - unrequested blast radius from a mission that fences that file out.
 *   - `slot_settled` stays WARN (code review R1 F1, NARROWED by R2 W1). The
 *     founder approved ERROR for a leg that "ends terminally on 30003", and this
 *     outcome is exactly the leg that did NOT: the slot already reads
 *     `delivered` (a duplicate or out-of-order callback that `ALLOWED_PRIOR`
 *     correctly refused), or it already reads another terminal code such as
 *     30007 - which was logged at ITS own severity when it landed. A later
 *     contradictory 30003 is not a new dead end, and today's main logs the same
 *     callback at WARN. Alarming it makes the shipped set strictly larger than
 *     the approved one, in the direction of false positives.
 *
 *     ONLY those two shapes. The first fix wave whitelisted the whole
 *     `slot_ineligible` value, which ALSO covered an ABSENT slot and a slot
 *     whose write was refused and still reads `sent` - two internal anomalies
 *     on a leg that DID end terminally on 30003, silenced on a brand-new alarm.
 *     They are a separate outcome now and they ERROR.
 *   - Every OTHER terminal 30003 on a fan-out or team leg is ERROR, whether the
 *     ladder ran to its cap, was refused at a gate, or was never claimed at all
 *     (`to_missing`, `to_malformed`, `source_unreadable`, `slot_ineligible`,
 *     `enqueue_failed`, `claim_failed`). What matters is the PRODUCT the leg
 *     belongs to, not whether the ladder happened to start - that whole set is
 *     what was approved.
 *
 * This function is the relay branch's ONLY severity reader; the shared set above
 * still decides the 1:1 and native-group-text paths, which are fenced.
 */
function isTerminalRelayLegFailure(
  errorCode: string | undefined,
  claim: RelayRetryClaimOutcome,
): boolean {
  if (isTerminalDeliveryFailure(errorCode)) return true;
  if (errorCode !== RELAY_RETRY_TRIGGER_CODE) return false;
  return (
    claim !== 'claimed' &&
    claim !== 'already_claimed' &&
    claim !== 'fenced_announcement' &&
    claim !== 'slot_settled'
  );
}

/**
 * PII (doc S9): the log-safe rendering of a STORED relay member key.
 * `relayMemberKey` falls back to `phone#<E164>` for a contact-less member, so
 * the raw stored key can carry a handset. The twin of `logSafeMemberKey`, taking
 * the string rather than a roster member - the claim path has no member object.
 */
function logSafeStoredRelayMemberKey(memberKey: string): string {
  return memberKey.startsWith('phone#') ? 'phone-only-member' : memberKey;
}

/**
 * The sender label for group/relay push bodies: NON-DELETED contact display
 * name -> roster name -> formatted phone -> the raw From. Contact-first since
 * 2026-09-01 (the roster name is a creation-time snapshot). All three inputs
 * are already in scope at every persist point, so a push adds NO repo lookup to
 * the hot path. Pure, no I/O, no logging.
 *
 * The isDeleted guard is the same rung lib/participantNames.ts withLiveNames
 * enforces: a soft-deleted contact supplies NO name. Neither reader upstream
 * filters one out - findByPhone deliberately returns deleted rows so inbound
 * routing still resolves them - so the refusal has to happen here.
 */
function pushSenderLabel(
  rosterName: string | undefined,
  senderContact: ContactItem | undefined,
  from: string,
): string {
  const live =
    senderContact !== undefined && !isDeleted(senderContact)
      ? contactDisplayName(senderContact)
      : undefined;
  if (live !== undefined) return live;
  const roster = typeof rosterName === 'string' ? rosterName.trim() : '';
  if (roster.length > 0) return roster;
  return formatPhoneForDisplay(from) ?? from;
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
  const normalizeTransportEvidence = (
    input: TwilioTransportEvidenceInput,
  ): NormalizedTransportEvidence => {
    const evidence = normalizeTwilioTransportEvidence(input);
    if (evidence.kind === 'conflict') {
      log.warn(
        {
          event: 'message_transport_evidence_conflict',
          providerSid: input.messageSid,
          ...(input.requestedTransport !== undefined && {
            requestedTransport: input.requestedTransport,
          }),
          evidenceSource: evidence.source,
          ...evidence.safeFacts,
        },
        'twilio webhook carried conflicting transport evidence',
      );
    }
    return evidence;
  };
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

  /**
   * The EXACT outbound leg copy a retry must resend (spec D12), composed ONCE at
   * rung 1 and then stored verbatim on the row so no later rung re-resolves a
   * sender whose display name changed between attempts.
   *
   * It mirrors `relayFanOut`'s own three-arm composition rather than only its
   * text arm: a MEDIA-ONLY relay leg was sent as the catalog's media-only
   * sentence, and composing `"<name>: "` for one would resend a different -
   * empty - message than the one that failed. The sender resolves the way the
   * fan-out resolves it: the TEAM sentinel takes the neutral team label (the
   * only value any caller ever passes as `senderNameOverride`), and a member
   * sender takes the roster name for its key.
   */
  async function composeRelayLegCopy(
    conversationId: string,
    senderKey: string,
    rawBody: string,
    mediaCount: number,
  ): Promise<string> {
    let senderName: string | undefined;
    if (senderKey === TEAM_SENDER_KEY) {
      senderName = TEAM_SENDER_LABEL;
    } else {
      const conv = await conversations.getById(conversationId);
      const roster = (conv?.participants ?? []) as ConversationParticipant[];
      senderName = roster.find((member) => relayMemberKey(member) === senderKey)?.name;
    }
    if (rawBody.length > 0) return composeRelayBody(senderName, rawBody);
    if (mediaCount > 0) {
      const label =
        senderName !== undefined && senderName.trim().length > 0
          ? senderName
          : RELAY_ANONYMOUS_SENDER_LABEL;
      return resolveMessage('relay.media_only', { name: label });
    }
    // Unreachable in practice: a source with neither text nor media relays
    // nothing, so no leg exists to fail. Composed anyway so the field is always
    // a string (the retry job throws on a non-string leg body).
    return composeRelayBody(senderName, rawBody);
  }

  /**
   * D14: close a just-claimed retry leg terminally when its rung could not be
   * enqueued. `enqueue_failed`, never the cap's `transient_cap` - one code for
   * both would tell an operator retries ran when none did. The write goes
   * through the fan-out's EXPORTED transport-aware persist path, so a legacy
   * retry row still takes `markRecipient`'s whole-slot write while a versioned
   * one takes `applyRecipientSendResult`; the pre-send shape (aggregation
   * `excluded`, then the failed slot) mirrors the extraction's own refusal arm.
   */
  async function closeRetryLegEnqueueFailed(
    conversationId: string,
    retryTsMsgId: string,
    memberKey: string,
    versioned: boolean,
    requestedTransport: MessageTransport | undefined,
  ): Promise<void> {
    const legPayload: RelayLegPayload = {
      relayConversationId: conversationId,
      sourceTsMsgId: retryTsMsgId,
      attempt: 1,
    };
    // `intent` is structurally required by RelayTransportMode but is never READ
    // on this path (`persistRelayRecipientResult` branches on `kind` alone), so
    // the slot's own requested transport is the honest value to carry.
    const transport: RelayTransportMode = versioned
      ? { kind: 'versioned', intent: { requestedTransport: requestedTransport ?? 'sms' } }
      : { kind: 'legacy' };
    if (transport.kind === 'versioned') {
      await setVersionedAggregationState(messages, legPayload, memberKey, 'excluded', [
        'excluded',
        'attempted',
      ]);
    }
    await persistRelayRecipientResult(
      messages,
      legPayload,
      memberKey,
      { status: 'failed', errorCode: 'enqueue_failed' },
      transport,
    );
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
          // Capped here too even though every caller already caps via
          // pushMessageBody: this helper is the choke point, capping an
          // already-capped string is idempotent, and an oversize payload is
          // REJECTED by the push service, so the notification would be lost
          // silently and on every retry.
          body: capPushText(body, PUSH_BODY_MAX),
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
   * the 1:1 and relay inbound paths. Best-effort: MEDIA_BUCKET unset -> log + skip;
   * a per-attachment failure leaves a usable message (provider URLs stay on the
   * item) - never a crash. PII (doc 9): SIDs/indexes/counts only, never the URL
   * or the bytes.
   *
   * RETRIED, THEN DEFERRED (prod incident 2026-08-17/18). Twilio serves an
   * inbound MMS's media a beat AFTER it fires this webhook: a single fetch here
   * 404'd on 2 of the day's 6 inbound MMS (~140ms after the message existed,
   * media present on re-read) and the photo was lost from the thread for good,
   * because the dashboard never renders the provider URL. The shared mirror
   * (services/mediaMirror.ts) now retries a TRANSIENT failure a few times
   * inline - fast, inside the 15s Twilio waits for this ack - and anything
   * still failing is handed to the media.mirror job, which retries for minutes
   * (+5s, +15s, +45s, +2min) and appends what lands. Only a PERMANENT refusal,
   * or the job's last rung, is an ERROR.
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
      const line = 'inbound MMS media NOT mirrored - MEDIA_BUCKET is not configured';
      if (config.nodeEnv === 'production') log.error({ providerSid: messageSid, mediaCount: mediaUrls.length }, line);
      else log.warn({ providerSid: messageSid, mediaCount: mediaUrls.length }, line);
      return;
    }
    const targets: MediaMirrorTarget[] = mediaUrls.map((url, index) => ({
      index,
      url,
      contentType: params[`MediaContentType${index}`],
    }));
    const outcome = await mirrorMediaSet(
      { adapter, mediaStore, logger: log },
      { conversationId, messageSid, targets, delaysMs: INLINE_MIRROR_DELAYS_MS },
    );

    if (outcome.attachments.length > 0) {
      const attachments: MediaAttachment[] = outcome.attachments.map((a) => a.attachment);
      try {
        await messages.annotateMessage(conversationId, tsMsgId, { mediaAttachments: attachments });
      } catch (err) {
        log.error({ err, providerSid: messageSid }, 'failed to record mirrored media keys on the message');
      }
    }

    for (const f of outcome.failed.filter((x) => !x.retryable)) {
      log.error(
        { providerSid: messageSid, mediaIndex: f.index, event: 'media_mirror_refused' },
        'media mirror refused permanently - message record keeps the provider URL',
      );
    }
    const transient = outcome.failed.filter((x) => x.retryable);
    if (transient.length === 0) return;
    const payload: MediaMirrorPayload = {
      conversationId,
      tsMsgId,
      messageSid,
      media: targets.filter((t) => transient.some((f) => f.index === t.index)),
      attempt: 1,
    };
    const runAt = new Date(Date.now() + mediaMirrorBackoffMs(1));
    try {
      await enqueueMediaMirror(payload, runAt);
      log.warn(
        {
          providerSid: messageSid,
          mediaIndexes: payload.media.map((m) => m.index),
          runAt: runAt.toISOString(),
          event: 'media_mirror_deferred',
        },
        'media mirror: attachments not fetchable yet - deferred to the media.mirror job',
      );
    } catch (err) {
      // The deferral itself failed (no queue wired, a producer fault): this is
      // the one case left where the photo is lost, so it keeps the ERROR.
      log.error(
        { err, providerSid: messageSid, mediaIndexes: payload.media.map((m) => m.index) },
        'media mirror failed and could not be deferred - message record keeps the provider URL',
      );
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
      actualTransport: MessageTransport | undefined;
    },
  ): Promise<void> {
    const { MessageSid, From, Body, actualTransport } = msg;
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
      transportSchemaVersion: TRANSPORT_SCHEMA_VERSION,
      ...(actualTransport !== undefined && { actualTransport }),
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
      actualTransport: MessageTransport | undefined;
    },
  ): Promise<void> {
    const { MessageSid, From, Body, actualTransport } = msg;
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
      transportSchemaVersion: TRANSPORT_SCHEMA_VERSION,
      ...(actualTransport !== undefined && { actualTransport }),
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
      transportSchemaVersion: TRANSPORT_SCHEMA_VERSION,
      actualTransport: nativeGroupInboundActualTransport(),
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

    const inboundEvidence = normalizeTransportEvidence({
      direction: 'inbound',
      messageSid: MessageSid,
      from: From,
      ...(To !== undefined && { to: To }),
      ...(params['ChannelPrefix'] !== undefined && {
        channelPrefix: params['ChannelPrefix'],
      }),
      ...(params['ChannelMetadata'] !== undefined && {
        channelMetadata: params['ChannelMetadata'],
      }),
      authenticatedProviderTraffic: true,
    });
    const inboundActualTransport =
      inboundEvidence.kind === 'observed' ? inboundEvidence.transport : undefined;

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
    // is never cleared) through the shared ladder in
    // services/relayInboundResolution.ts (one policy for SMS and voice - the
    // rung rationale lives there). The byPoolNumber GSI read is still the
    // cheap lookup (never a scan). Zero groups on To -> fall through to the
    // normal 1:1 path.
    if (To !== undefined && To.length > 0) {
      const groups = await conversations.getAllByPoolNumber(To);
      const resolution = resolveRelayInbound(groups, From);
      if (resolution !== undefined && resolution.kind === 'open_member') {
        // (a) OPEN group whose roster contains the sender -> today's relay path
        //     (fan-out, DLR pointers, STOP handling all unchanged).
        if (resolution.violatingOpenMatchIds) {
          log.error(
            {
              providerSid: MessageSid,
              matchCount: resolution.violatingOpenMatchIds.length,
              conversationIds: resolution.violatingOpenMatchIds,
            },
            'multiple OPEN relay groups on one pool number match the sender (burn invariant violated) - routing to the newest',
          );
        }
        // Empty ack, keyword or not: the open path processes STOP/HELP/opt-in
        // and Twilio's Advanced Opt-Out sends the confirmation.
        await handleRelayInbound(resolution.group, {
          MessageSid,
          From,
          To,
          Body,
          params,
          actualTransport: inboundActualTransport,
        });
        res.type('text/xml').send(EMPTY_TWIML);
        return;
      }
      if (resolution !== undefined && resolution.kind === 'closed_member') {
        // (b) CLOSED group whose roster contains the sender -> deliver the late
        //     text into the sender's OWN 1:1 thread with provenance. No
        //     fan-out, no group append. AF-4: the intercept processes
        //     STOP/opt-out; the confirmation is Twilio's, so the ack is empty.
        await handleClosedGroupInbound(resolution.group, {
          MessageSid,
          From,
          Body,
          params,
          actualTransport: inboundActualTransport,
        });
        res.type('text/xml').send(EMPTY_TWIML);
        return;
      }
      if (resolution !== undefined && resolution.kind === 'non_member_open') {
        // (c) Unknown sender (on NO roster) with an OPEN group present ->
        //     persist on the newest open group for the record, no fan-out.
        //     Same contract as the open-roster match above (an unknown-sender
        //     STOP is still recorded; Twilio still confirms it).
        await handleRelayInbound(resolution.group, {
          MessageSid,
          From,
          To,
          Body,
          params,
          actualTransport: inboundActualTransport,
        });
        res.type('text/xml').send(EMPTY_TWIML);
        return;
      }
      // (d) all_closed_non_member (AF-5: do NOT bury the text in a dead group
      //     transcript - it could hide a real message from a stranger, a
      //     second phone, or a member from a NEW phone; no via_closed_group -
      //     they are not a closed-roster member) or undefined (no groups on
      //     To) -> fall through to the normal 1:1 intake path below.
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
      transportSchemaVersion: TRANSPORT_SCHEMA_VERSION,
      ...(inboundActualTransport !== undefined && {
        actualTransport: inboundActualTransport,
      }),
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

    /**
     * Claim ONE rung of the 30003 retry ladder for the relay leg this callback
     * is about (spec D3/D5/D6/D7/D8/D12/D13/D14/D16).
     *
     * A retry is a NEW single-recipient source row, never a promotion of the
     * failed slot (D1), and the row's `sid#<providerSid>` pointer create IS the
     * atomic claim - a duplicate, redelivered or concurrent callback loses that
     * create and claims nothing.
     *
     * THIS FUNCTION NEVER RETURNS OUT OF ITS CALLER. It reports an outcome and
     * control always falls through to the handler's tail, because that tail
     * carries three things a claim must not skip: the delivery-failure marker,
     * the existing SSE emit and the placement escalation. An early `return` on
     * the `fenced_announcement` exit alone would stop an announcement leg
     * escalating on a placement-linked thread, which it does today, and no test
     * in this plan could see it.
     */
    const claimRelayRetry = async (
      ptr: { conversationId: string; tsMsgId: string; memberKey: string },
      mapped: DeliveryStatus,
    ): Promise<RelayRetryClaimResult> => {
      // 1. The trigger is narrow: a FAILURE callback carrying 30003, and only
      // 30003. Every other relay failure line still gets a cause, which is what
      // makes the alarm self-describing (D23 / adjudication S2a).
      if (mapped !== 'undelivered' && mapped !== 'failed') return { outcome: 'code_not_retryable' };
      if (ErrorCode !== RELAY_RETRY_TRIGGER_CODE) return { outcome: 'code_not_retryable' };

      // 2. Re-read the source CONSISTENTLY (D7), AFTER the slot write above, so
      // step 5 sees the POST-write slot. `updateRecipientDeliveryStatus` returns
      // a bare boolean and `getByTsMsgId` is eventually consistent, so a naive
      // re-read intermittently sees the PRE-write slot and drops the retry -
      // silently, load-dependently, and past any test. This is deliberately NOT
      // the read at the top of the handler: that one runs on every relay status
      // callback and only needs `requestedTransport`.
      const src = await messages.getByTsMsgIdConsistent(ptr.conversationId, ptr.tsMsgId);
      if (!src) {
        // Fail-CLOSED, permanently (Sec 9). After the consistent read an absent
        // row is genuinely absent - a real internal anomaly - so it alarms with
        // its own cause and its own message rather than as a carrier failure.
        return { outcome: 'source_unreadable' };
      }

      // 3. The fence is POSITIVE (D7): present, carrying a sender key, and that
      // key is not the system value. A NEGATIVE fence ("not system") passes on
      // an unreadable source and would claim a retry against a tour-reminder
      // rung. `SYSTEM_SENDER_KEY` has ONE writer - the single append behind all
      // four announcement callers - so this cleanly separates fan-out and team
      // legs from announcement legs.
      const senderKey = src.relay_sender_key;
      if (typeof senderKey !== 'string' || senderKey.length === 0) {
        return { outcome: 'fenced_announcement' };
      }
      if (senderKey === SYSTEM_SENDER_KEY) return { outcome: 'fenced_announcement' };

      // 4. The ladder is keyed on the DESTINATION handset (D5), not on the
      // member key: one contact on two numbers collapses into one slot, and a
      // retry must stay unambiguous about which handset it is retrying. Missing
      // or malformed means DO NOT CLAIM - a silently different digest would mint
      // a parallel ladder.
      const rawTo = params['To'];
      if (rawTo === undefined || rawTo.length === 0) return { outcome: 'to_missing' };
      const toE164 = normalizeToE164(rawTo);
      if (toE164 === undefined) return { outcome: 'to_malformed' };

      // 5. The gate is the slot's POST-WRITE STATE, never whether THIS callback
      // transitioned it (D8). A transition gate is wrong twice over: its
      // justification does not exist (a leg the fan-out closed without sending
      // has no provider SID, so no callback can ever resolve to it), and it makes
      // a crash between the slot write and the claim permanently unrecoverable -
      // the redelivered callback transitions nothing and would refuse for ever.
      // The slot's own code must still be 30003 or ABSENT: absent is the reachable
      // code-less-`canceled`-landed-first case, and a slot already reading 30007
      // is the one real contradiction this keeps closed.
      //
      // TWO OUTCOMES, not one (code review R2, W1). Both decline the claim; they
      // differ in what they MEAN, and therefore in severity. `slot_settled` is a
      // leg whose own end state is already recorded - `delivered`, or terminal
      // on another code - so this 30003 is a duplicate or a contradiction and
      // nothing new failed. `slot_ineligible` is an ANOMALY: the pointer
      // resolved and the leg really did end terminally on 30003, and yet the
      // slot is absent, or is still `queued`/`sent` after this callback's own
      // write was refused. Nothing should leave a slot in that state, so it
      // alarms with its own message (see `isTerminalRelayLegFailure`).
      const slot = src.delivery_recipients?.[ptr.memberKey];
      if (slot === undefined) return { outcome: 'slot_ineligible' };
      if (slot.status === 'delivered') return { outcome: 'slot_settled' };
      if (slot.status !== 'failed' && slot.status !== 'undelivered') {
        return { outcome: 'slot_ineligible' };
      }
      if (slot.errorCode !== undefined && slot.errorCode !== RELAY_RETRY_TRIGGER_CODE) {
        return { outcome: 'slot_settled' };
      }

      // 6. Attempt arithmetic (D6). Every rung points at the ROOT, so rung 2
      // chains to the original and not to rung 1 - the thread-level join buckets
      // on that key.
      const prior = typeof src.relay_retry_attempt === 'number' ? src.relay_retry_attempt : 0;
      const attempt = prior + 1;
      if (attempt > MAX_RELAY_RETRY_ATTEMPTS) return { outcome: 'cap_exhausted' };
      const rootTsMsgId =
        typeof src.relay_retry_of === 'string' && src.relay_retry_of.length > 0
          ? src.relay_retry_of
          : ptr.tsMsgId;

      // 7. The claim itself. `providerTs` is a WALL CLOCK, never derived from the
      // root (D3): at an identical timestamp `<ts>#relayretry-...` sorts BELOW
      // `<ts>#team-...` and would land inside the fan-out's five-row window.
      const destDigest = relayRetryDigest(rootTsMsgId, toE164);
      const providerSid = relayRetryProviderSid(destDigest, attempt);
      const providerTs = new Date().toISOString();
      const versioned = src.transport_schema_version === TRANSPORT_SCHEMA_VERSION;
      const requestedTransport = slot.requestedTransport;
      const sourceMedia = mediaAttachmentsOf(src);
      const rawBody = typeof src.body === 'string' ? src.body : '';
      const legBody =
        typeof src.relay_retry_leg_body === 'string'
          ? // Rungs 2+ copy the stored copy VERBATIM (D12): a sender renamed
            // mid-ladder must not change the wording of what is being retried.
            src.relay_retry_leg_body
          : await composeRelayLegCopy(ptr.conversationId, senderKey, rawBody, sourceMedia.length);
      const appended = await messages.append({
        conversationId: ptr.conversationId,
        providerSid,
        providerTs,
        // D2: MIRROR the original's shape. A team original yields an outbound
        // retry row, a member-originated one an inbound row; both shapes already
        // exist in the product. `type` follows the original so the transport
        // assertions see a carrier message. Rungs 2+ read the previous retry row,
        // which mirrored the root - transitively identical.
        type: src.type === 'mms' ? 'mms' : 'sms',
        direction: src.direction === 'inbound' ? 'inbound' : 'outbound',
        author: src.author,
        relaySenderKey: senderKey,
        deliveryStatus: 'queued',
        // The MODE follows the original, which is usually LEGACY - every relay
        // source written before 2026-09-02 is. A versioned slot on a legacy row
        // would drive `markRecipient`'s blind whole-slot write and erase the
        // `planned` state the very first send needs. NOTE the distinction: the
        // inbound prohibition is on the MESSAGE's requestedTransport, never on
        // the SLOT's, which is permitted and required.
        ...(versioned && { transportSchemaVersion: TRANSPORT_SCHEMA_VERSION }),
        deliveryRecipients: {
          [ptr.memberKey]: versioned
            ? {
                status: 'queued' as const,
                ...(requestedTransport !== undefined && { requestedTransport }),
                // `attempted` is reachable ONLY from `planned`, so a slot seeded
                // without it throws on the first retry send.
                transportAggregationState: 'planned' as const,
              }
            : { status: 'queued' as const },
        },
        // The RAW body on the row, the composed leg copy beside it (D12): the row
        // body is what is persisted, previewed and inherited by the inbox
        // preview, while the sender prefix belongs to the outbound LEG only.
        ...(rawBody.length > 0 && { body: rawBody }),
        // Durable s3Keys, re-presigned per attempt (D13). `append` suppresses the
        // media-POINTER rows for a retry row itself.
        ...(sourceMedia.length > 0 && { mediaAttachments: sourceMedia }),
        relayRetryOf: rootTsMsgId,
        relayRetryMemberKey: ptr.memberKey,
        relayRetryAttempt: attempt,
        relayRetryDestDigest: destDigest,
        relayRetryOriginDirection:
          src.relay_retry_origin_direction ?? (src.direction === 'inbound' ? 'inbound' : 'outbound'),
        relayRetryLegBody: legBody,
        // DELIBERATELY no `retryOf`: stamping it would add the ORIGINAL to the
        // timeline's supersededIds and DELETE the bubble this retry is meant to
        // render beside - the display contract, inverted.
      });
      if (appended.deduped) {
        // A sibling callback won the create. The ladder is running; claim nothing
        // further and do not re-emit for it.
        return { outcome: 'already_claimed', attempt };
      }

      // 8. Hand the rung to the queue. The claim defeats duplicate CALLBACKS;
      // the job's own execution marker defeats duplicate DELIVERIES.
      const retryTsMsgId = appended.tsMsgId;
      let outcome: RelayRetryClaimOutcome = 'claimed';
      try {
        await enqueueRelayRetryLeg(
          { relayConversationId: ptr.conversationId, retryTsMsgId },
          attempt,
        );
      } catch (err) {
        // D14: close the retry leg with `enqueue_failed`, NOT the cap's
        // `transient_cap` - one code for both would tell an operator retries ran
        // when none did. The close goes through the exported transport-aware
        // path so a legacy row still takes the whole-slot write.
        outcome = 'enqueue_failed';
        // The close is guarded SEPARATELY (code review R2, W2). Unguarded, a
        // throw from it escaped to the outer catch and reported
        // `claim_failed` - "threw before deciding, no retry claimed" - about a
        // claim that HAD decided and whose row exists, stranded at `queued`
        // with no close code. The outcome stays `enqueue_failed` because a row
        // is what the operator has to go and look at; the close's own failure
        // rides the same line so the missing close code is diagnosable.
        let closeErr: unknown;
        try {
          await closeRetryLegEnqueueFailed(
            ptr.conversationId,
            retryTsMsgId,
            ptr.memberKey,
            versioned,
            requestedTransport,
          );
        } catch (e) {
          closeErr = e;
        }
        log.error(
          {
            err,
            // `summarizeError`, not the raw value: only `err`/`error`/`cause`/
            // `reason` get the safe serializer, and a second raw Error under any
            // other key serialises to `{}`.
            ...(closeErr !== undefined && { closeErr: summarizeError(closeErr) }),
            conversationId: ptr.conversationId,
            retryTsMsgId,
            rootTsMsgId,
            attempt,
            memberKey: logSafeStoredRelayMemberKey(ptr.memberKey),
            retryClaim: 'enqueue_failed',
            // `closeCode` appears only where a close was actually WRITTEN.
            ...(closeErr === undefined && { closeCode: 'enqueue_failed' as const }),
          },
          closeErr === undefined
            ? 'relay retry claim: enqueueing the rung failed - retry leg closed'
            : 'relay retry claim: enqueueing the rung failed and the close failed too - retry leg left open',
        );
      }

      // 9. SSE on the CLAIM, not only after the send (D16). The row exists on
      // both paths, and without this the chip reads "1 failed" for the whole
      // first backoff interval - a false terminal state, for at least 60 seconds,
      // on the surface this feature exists to make truthful. The payload
      // addresses the ROOT (adjudication S4): the existing emit below carries
      // `ptr.tsMsgId`, which on rungs 2-3 is a retry row, and does not fire at
      // all in the crash-recovery case where nothing transitioned.
      events.emit('message.persisted', {
        conversationId: ptr.conversationId,
        tsMsgId: rootTsMsgId,
        direction: 'inbound',
        deliveryStatus: mapped,
      });
      return { outcome, attempt };
    };

    // The claim error the relay branch rethrows below, kept where its CALL SITE
    // can recognise it (code review R3, X1). The call site answers the 5xx
    // itself, and it must answer only for THIS error: an unrelated fault out of
    // the same branch - a throttled slot write, a throttled roster read - emits
    // no marker of its own, so it still has to reach the generic Express handler
    // and be logged there. Identity is the discriminator because the rethrow is
    // `throw claimError` unchanged (W2), and a request runs this branch at most
    // once.
    let relayClaimError: unknown;
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
      const source = await messages.getByTsMsgId(ptr.conversationId, ptr.tsMsgId);
      const requestedTransport =
        source?.delivery_recipients?.[ptr.memberKey]?.requestedTransport;
      const transportEvidence = normalizeTransportEvidence({
        direction: 'outbound',
        ...(requestedTransport !== undefined && { requestedTransport }),
        messageSid: MessageSid,
        ...(params['From'] !== undefined && { from: params['From'] }),
        ...(params['To'] !== undefined && { to: params['To'] }),
        ...(params['ChannelPrefix'] !== undefined && {
          channelPrefix: params['ChannelPrefix'],
        }),
        ...(params['ChannelMetadata'] !== undefined && {
          channelMetadata: params['ChannelMetadata'],
        }),
        authenticatedProviderTraffic: true,
      });
      const transitioned = await messages.updateRecipientDeliveryStatus(
        ptr.conversationId,
        ptr.tsMsgId,
        ptr.memberKey,
        mapped,
        ErrorCode,
      );
      const transportOutcome =
        transportEvidence.kind === 'observed'
          ? await messages.setRecipientActualTransport(
              ptr.conversationId,
              ptr.tsMsgId,
              ptr.memberKey,
              transportEvidence.transport,
            )
          : undefined;
      const transportUpdated = transportOutcome === 'updated';
      // The 30003 retry claim (spec D8) sits HERE, after the slot write and the
      // transport write and BEFORE the failure marker, for two reasons: its
      // consistent re-read must see the POST-write slot, and the marker below
      // has to be able to carry the outcome as its cause and its severity. It
      // returns a value and never returns out of this function - the tail runs
      // on every path.
      //
      // The try/catch closes the other half of that promise (code review R1,
      // F2). The helper cannot RETURN out of this function, but it can THROW:
      // it performs a consistent read, a roster read and an `append` that
      // rethrows a condition failure, and any of the three can fail on a
      // DynamoDB throttle or timeout. A rejection escaping HERE would skip the
      // whole tail - and on Twilio's redelivery nothing transitions, so
      // `flagPlacementAttention` would never run for that leg again. A failed
      // relay leg on a placement-linked thread would silently lose its
      // escalation to a human, which is precisely what the M1.10c comment above
      // says must not happen.
      //
      // BUT THE CATCH DOES NOT SWALLOW IT (code review R2, W2). The captured
      // error is RETHROWN after the tail, so the callback still 5xxs and Twilio
      // still redelivers - the call site catches the rethrow and answers 500
      // itself (code review R3, X1), which changes no status code and costs the
      // generic handler's second, unattributable ERROR line. That redelivery is
      // the ladder's only recovery: D8 gates the claim on the SLOT'S POST-WRITE
      // STATE rather than on `transitioned` precisely so a redelivered callback
      // - which transitions nothing - still reads terminal-plus-30003 and
      // claims. Acking 200 here would trade that away, and a single DynamoDB
      // throttle on the consistent read, the roster read or the `append` would
      // lose the member's message for good.
      //
      // WHAT IS TRADED FOR IT: the tail runs on EVERY redelivery, so the
      // failure marker and the SSE repeat while the fault lasts. Both are
      // idempotent-by-shape (one more log line, one more refresh of the same
      // state) and the escalation is not repeated at all - it is gated on
      // `transitioned`, which is false on a redelivery of a callback that
      // already wrote the slot. Losing the send is the strictly worse failure.
      let retryClaim: RelayRetryClaimResult;
      let claimError: unknown;
      try {
        retryClaim = await claimRelayRetry(ptr, mapped);
      } catch (err) {
        retryClaim = { outcome: 'claim_failed' };
        claimError = err;
      }
      log.info(
        {
          providerSid: MessageSid,
          providerStatus: MessageStatus,
          errorCode: ErrorCode,
          transitioned,
          transportOutcome,
          relay: true,
        },
        'twilio relay-recipient delivery status callback processed',
      );
      // Delivery-failure marker (doc §9): a relay fan-out leg that resolved
      // undelivered/failed is a countable failed delivery. Severity follows the
      // taxonomy — a terminal failure is an ERROR (feeds the error-logs alarm +
      // Recent Errors panel); a transient-retrying / opt-out leg stays WARN. The
      // `event` field is unchanged either way, so this SEVERITY change does not
      // move the DeliveryFailures count metric, which keys on `event` and not on
      // level. IDs/codes only.
      //
      // THE FEATURE DOES MOVE THAT METRIC, and the old comment here said
      // otherwise (code review R2, W9c). Every rung's own send writes its own
      // `relaysid#` pointer, so every rung's failed callback re-enters this
      // handler and emits its own `delivery_failed` - up to FOUR per relayed
      // message per permanently dead handset (root + three rungs) where main
      // emitted one. That is the relay ladder now counting the way the 1:1
      // ladder already does. `hc-<env>-delivery-failures` is a raw Sum over a
      // single 5-minute period, and root/rung1/rung2 land inside about three
      // minutes, so the threshold is a decision the human owes (open question
      // Q4). Nothing on this branch changes the metric or the alarm.
      //
      // ONE MORE MULTIPLIER, on top of the four (code review R3, X2): this
      // marker sits BEFORE the claim's rethrow, so a callback whose claim throws
      // emits it on the 5xx AND again on the redelivery that the 5xx triggers,
      // once per redelivery for as long as the fault lasts. That is not new with
      // this branch - a redelivered failure callback has always re-entered this
      // handler and re-emitted `delivery_failed` - but Q4's number is per
      // MESSAGE, and this is the term that makes it unbounded rather than four.
      if (mapped === 'undelivered' || mapped === 'failed') {
        const failure = {
          event: 'delivery_failed',
          providerSid: MessageSid,
          errorCode: ErrorCode,
          providerStatus: MessageStatus,
          relay: true,
          // The claim's own fault rides THIS line rather than a second one
          // (code review R2, W2/2.5): a diagnostic ERROR with no `event` fed
          // `ErrorLogs` but not `DeliveryFailures`, so one throttled claim
          // contributed two datapoints to the alarm that pages on three
          // consecutive buckets, one of them unclassifiable. One line, one
          // `event`, the cause attached.
          //
          // THAT IS TRUE ONLY BECAUSE THE CALL SITE ANSWERS THE 5xx (code
          // review R3, X1). W2 folded this line and then rethrew, and the
          // rethrow reached `createExpressErrorHandler`, which logged its own
          // generic ERROR - so the count was two again, with the second the
          // less attributable of the pair. The catch at the call site is what
          // makes "one line" a property of the code rather than a claim about
          // it; it is pinned by a test that counts EVERY ERROR line in the
          // capture, not only the markers.
          ...(claimError !== undefined && {
            err: claimError,
            memberKey: logSafeStoredRelayMemberKey(ptr.memberKey),
          }),
          // D23: WHY no retry is running. This is the difference between an
          // operator diagnosing a carrier problem and diagnosing ours - an ERROR
          // reading `source_unreadable` is an internal fault and says so, one
          // reading `cap_exhausted` is a genuine unreachable handset, and
          // without the field both render as the same "relay leg undelivered,
          // 30003" with the internal fault the one nobody expects.
          retryClaim: retryClaim.outcome,
          ...(retryClaim.attempt !== undefined && { retryAttempt: retryClaim.attempt }),
        };
        // The three INTERNAL ANOMALIES take their own message rather than the
        // shared carrier-shaped one, so each alarm names its own cause instead
        // of reading as one more unreachable handset. `slot_ineligible` joined
        // them in code review R2 (W1): it is the same class as
        // `source_unreadable` - the pointer resolved, the leg ended terminally
        // on 30003, and the row it belongs on is missing or was never written.
        const failureMsg =
          RELAY_ANOMALY_FAILURE_MESSAGES[retryClaim.outcome] ??
          'twilio relay-recipient delivery failed (undelivered/failed)';
        if (isTerminalRelayLegFailure(ErrorCode, retryClaim.outcome)) log.error(failure, failureMsg);
        else log.warn(failure, failureMsg);
      }
      if (transitioned || transportUpdated) {
        // Refresh the UI: a per-recipient delivery move re-renders the relay
        // thread (the source message's delivery_recipients changed).
        events.emit('message.persisted', {
          conversationId: ptr.conversationId,
          tsMsgId: ptr.tsMsgId,
          direction: 'inbound',
          deliveryStatus: mapped,
        });
      }
      if (transitioned) {
        // (M1.10c) A failed relay leg is a failed send on the placement
        // (the relay thread carries conversation.placementId) → escalate.
        //
        // ONCE per failed leg, on the ROOT's callback only. Every rung of a retry
        // ladder re-enters this same handler, so leaving it alone is NOT
        // "unchanged behavior": a three-rung ladder would escalate FOUR times,
        // and each call rewrites `attention.at`, re-emits `placement.updated`
        // and logs another `placement_escalation` - so the triage clock a human
        // reads would reset at +60s, +180s and +420s and the leg would look
        // newly failed each time. Deferring instead until the chain is terminal
        // would DELETE the escalation for three of the four terminal outcomes
        // (gate refusal, enqueue failure and the transient cap all end inside the
        // JOB, which cannot reach this closure).
        //
        // The discriminator is the SOURCE ROW, not the thread: "any retry row in
        // this conversation" would silently swallow a SECOND member's failure.
        // It reads the EVENTUALLY-consistent `source` above deliberately - that
        // read runs on every failure path, while the claim's consistent re-read
        // only runs on 30003. Two properties make that safe: a read miss leaves
        // `source` undefined, so the condition is false and the leg still
        // escalates (it fails OPEN), and `relay_retry_of` is written at append
        // time, so an eventually-consistent read cannot lose it on a row old
        // enough to have a delivery callback. It is also false for every row
        // written before this branch, which makes "unchanged for everything
        // shipped today" structural rather than empirical.
        if (mapped === 'undelivered' || mapped === 'failed') {
          if (source?.relay_retry_of === undefined) {
            await flagPlacementAttention(ptr.conversationId, 'send_failed');
          }
        }
      }
      // LAST, and only after the whole tail has run (code review R2, W2). The
      // rethrow gives Twilio a 5xx so it redelivers, and D8's state gate claims
      // on that redelivery; the tail above has already emitted the marker, the
      // SSE and - once - the escalation, which is what F2 existed to guarantee.
      // Both halves, in the only order that gets both.
      //
      // The CALL SITE catches it and answers the 5xx (code review R3, X1);
      // publishing it here is what lets that catch tell this error apart from
      // any other fault out of this branch.
      if (claimError !== undefined) {
        relayClaimError = claimError;
        throw claimError;
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
      try {
        await handleRelayRecipientStatus(relayPtr);
      } catch (err) {
        // A thrown claim answers its own 5xx HERE (code review R3, X1) instead
        // of travelling to `createExpressErrorHandler`, which would log a SECOND
        // ERROR - one with no `event`, no `retryClaim` and no `memberKey`, so it
        // fed the ErrorLogs alarm exactly like the marker while being strictly
        // harder to attribute. The marker the branch already emitted is the one
        // ERROR line, and nothing new is logged here.
        //
        // The RESPONSE is unchanged in the only way that matters: Twilio
        // redelivers on ANY 5xx, and D8's state gate re-claims on that
        // redelivery (the slot is already terminal-plus-30003), which is the
        // whole reason W2 rethrows rather than acking.
        //
        // Anything else that escapes this branch is NOT ours to swallow: it
        // emitted no marker, so it keeps travelling and the generic handler logs
        // it, exactly as before.
        if (err !== relayClaimError) throw err;
        res.status(500).end();
        return;
      }
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
    const transportEvidence = normalizeTransportEvidence({
      direction: 'outbound',
      ...(message.requested_transport !== undefined && {
        requestedTransport: message.requested_transport,
      }),
      messageSid: MessageSid,
      ...(params['From'] !== undefined && { from: params['From'] }),
      ...(params['To'] !== undefined && { to: params['To'] }),
      ...(params['ChannelPrefix'] !== undefined && {
        channelPrefix: params['ChannelPrefix'],
      }),
      ...(params['ChannelMetadata'] !== undefined && {
        channelMetadata: params['ChannelMetadata'],
      }),
      authenticatedProviderTraffic: true,
    });
    const transitioned = await messages.updateDeliveryStatus(MessageSid, mappedStatus, ErrorCode);
    const transportOutcome =
      transportEvidence.kind === 'observed'
        ? await messages.setMessageActualTransport(
            message.conversationId,
            message.tsMsgId,
            transportEvidence.transport,
          )
        : undefined;
    const transportUpdated = transportOutcome === 'updated';
    log.info(
      {
        providerSid: MessageSid,
        providerStatus: MessageStatus,
        errorCode: ErrorCode,
        transitioned,
        transportOutcome,
      },
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

    if (transitioned || transportUpdated) {
      // SSE (M1.2): a REAL transition updates delivery badges live.
      // Regressions/duplicates were no-ops above and emit nothing — so a
      // redelivered callback never re-fires the dashboard.
      events.emit('message.persisted', {
        conversationId: message.conversationId,
        tsMsgId: message.tsMsgId,
        direction: message.direction,
        deliveryStatus: mappedStatus,
      });
    }

    if (transitioned) {
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
            //
            // MMS-SCOPED, BOTH CODES (prod 2026-08-24): a leg that carried media
            // may never write `sms_unreachable`. The flag asserts SMS
            // reachability, and neither code establishes that from an MMS leg.
            //
            //   30005 "unknown destination handset" is PROVEN ambiguous here. A
            //   Verizon mobile delivered 10/10 texts and 8 inbound the same week
            //   6/6 of its MMS died 30005, each rejected in under a second,
            //   while 26 other MMS from this same sender delivered - including
            //   to three other Verizon 310/012 lines. Something destination-side
            //   has no MMS path for that number; which element is UNKNOWN.
            //
            //   30006 "landline OR UNREACHABLE CARRIER" is a disjunction, and
            //   only the first half is a line-type fact. "Unreachable carrier"
            //   is inherently message-type-specific - SMS and MMS traverse
            //   different interconnects, which is this whole bug. We have ZERO
            //   observations of a 30006 on an MMS leg, either way: every 30006
            //   in the prod audit came from an SMS leg. That is silence about
            //   this case, NOT evidence for it, and an earlier revision of this
            //   comment wrongly read it as evidence.
            //
            // The asymmetry decides it. Scoping costs at most ONE broadcast:
            // every consumer of this flag (routes/broadcasts.ts,
            // services/audienceResolution.ts, jobs/broadcastFanOut.ts) sends
            // TEXT-ONLY, so a landline that slipped through is flagged by its
            // next leg, which is SMS - and non-tenants are excluded by those
            // fences anyway, so the flag never mattered for them. NOT scoping
            // risks a permanent, invisible false exclusion: nothing ever clears
            // `sms_unreachable` and it has no contact-page surface, which is
            // exactly why two wrong flags sat unnoticed for days in prod. A
            // recoverable miss beats an unrecoverable false positive.
            //
            // The per-MMS truth stays on the message row (error_code + type);
            // the durable "this line can't take attachments" signal and the
            // SMS-link fallback are tracked in
            // docs/issues/mms-silent-drop-dish-textnow.md.
            if (message.type === 'mms') {
              log.warn(
                { providerSid: MessageSid, errorCode: ErrorCode },
                'attachment did not get through - MMS-only failure, SMS reachability untouched',
              );
              break;
            }
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
