// In-process typed event bus (M1.2) — the live-update spine of the
// conversation hub: mutation paths emit, the GET /api/events SSE route
// subscribes and streams to dashboards.
//
// *** SSE SPINE: ONE APP PROCESS SERVES; THE WORKER BRIDGES IN ***
// The one app process on the one EC2 box serves the SSE stream, so an in-process
// EventEmitter reaches every connected dashboard client directly from the app's
// own mutation paths (Twilio webhooks, /api sends, delivery callbacks). Emits
// raised in the WORKER process (extraction/reminder/nudge polls, reconcile) run
// on the worker's own bus and reach these SSE clients via the CROSS-PROCESS
// BRIDGE: lib/eventBridge.ts fire-and-forgets POST /internal/events and
// routes/internal.ts re-emits here - same event names and payloads, zero
// frontend change. If the app ever scales past a single instance, THIS MODULE IS
// THE SEAM: replace the singleton with a consumer of the DynamoDB streams already
// enabled on the messages table (lib/tables.ts) and fan out from there. Emitters
// and the SSE route keep their contracts; only this module's internals change.
//
// PII note (doc §9): event payloads carry the denormalized inbox preview
// (already truncated by toPreview). They are DATA for authenticated dashboard
// clients — they must never be logged.
import { EventEmitter } from 'node:events';
import { logger as defaultLogger, type Logger } from './logger.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationType,
} from '../repos/conversationsRepo.js';
import type { DeliveryStatus, MessageDirection } from '../repos/messagesRepo.js';
import type { BroadcastStats, BroadcastStatus } from '../repos/broadcastsRepo.js';
import type { PlacementItem } from '../repos/placementsRepo.js';

/** An inbox row changed — re-sort/re-render one conversation summary. */
export interface ConversationUpdatedEvent {
  conversationId: string;
  last_activity_at: string;
  unread_count: number;
  /** Denormalized preview (truncated); absent when the conversation has none. */
  preview?: string;
  /**
   * Current thread type (M1.4 triage live-update): the inbox chip re-renders
   * when triage flips unknown_1to1 → tenant_1to1/landlord_1to1.
   */
  type: ConversationType;
  /**
   * Denormalized resolved contact name, or null when none is known. Carried on
   * the event so the inbox shows the name (and clears the review chip) the
   * instant a contact is triaged — including pm/team_member contacts whose
   * thread type never leaves unknown_1to1. Null → the inbox falls back to phone.
   */
  participant_display_name: string | null;
  /**
   * Multi-party thread status: `open` | `closed` for relay_group threads
   * (M1.7), `group_open` for a native group_text (group-texting spec 4.2);
   * null for 1:1 (whose status is always implicitly open). Lets the inbox
   * grey out a closed relay live.
   */
  status?: string | null;
  /**
   * Relay group pool number (M1.7; E.164), or null. The masked number
   * fronting the thread; absent/null on 1:1 threads.
   */
  pool_number?: string | null;
  /**
   * Multi-party roster, or null on 1:1 threads. For a relay_group (M1.7) the
   * live member list so the relay UI updates rosters in place on add/remove;
   * for a group_text the carrier group's roster, which the thread view resolves
   * sender chips against. Each entry carries contactId/phone/name (name
   * optional). 1:1 behavior is unchanged - this is null there.
   */
  members?: ConversationParticipant[] | null;
}

/**
 * THE ONE conversation.updated payload builder for a fresh ConversationItem —
 * every emit site uses this (api.ts /read + the relay-group send, the contacts
 * triage router, the relay-group routes, the inbound webhook) so the wire shape
 * stays identical across all of them.
 *
 * FIX 4: the relay fields (status / pool_number / members) live HERE so no
 * emit site can forget them on a relay thread. For a relay_group they carry
 * the live status, pool number, and roster; for a 1:1 thread they are
 * null/[]/absent — the same wire behavior 1:1 clients already saw (the fields
 * are optional/nullable, a strict superset). This is why /read on a relay
 * group now keeps the roster fresh without a dedicated builder.
 *
 * PII (doc §9): the payload carries the denormalized preview and display name
 * — it is DATA for authenticated dashboard clients, never logged.
 */
export function toConversationUpdatedEvent(item: ConversationItem): ConversationUpdatedEvent {
  const isRelay = item.type === 'relay_group';
  // Native group texting (T3.8): a `group_text` thread is multi-party too, so
  // the inbox and thread view need its live status + roster - but it NEVER
  // carries a pool number (spec 4.2 forbids the field on a group thread), so
  // this is a SEPARATE spread, not a widened relay one. The relay spread below
  // stays byte-identical (pinned by exact-equality tests).
  const isGroup = item.type === 'group_text';
  return {
    conversationId: item.conversationId,
    last_activity_at: item.last_activity_at,
    unread_count: item.unread_count ?? 0,
    ...(item.last_message_preview !== undefined && { preview: item.last_message_preview }),
    type: item.type,
    participant_display_name: item.participant_display_name ?? null,
    // Relay fields (FIX 4): present (live status/pool/roster) ONLY for a
    // relay_group; ABSENT on a 1:1 thread so the 1:1 wire shape is byte-for-byte
    // unchanged (the type marks them optional). One builder, no relay drift.
    ...(isRelay && {
      status: item.status ?? null,
      pool_number: item.pool_number ?? null,
      members: item.participants ?? [],
    }),
    // Group fields: the live status (`group_open`) and the roster the thread
    // view renders sender chips against. NO pool_number - a carrier group is
    // fronted by the business number, never a masked relay number.
    ...(isGroup && {
      status: item.status ?? null,
      members: item.participants ?? [],
    }),
  };
}

/**
 * @deprecated FIX 4 — kept as a thin alias so existing relay emit sites keep
 * compiling; the relay fields now live in toConversationUpdatedEvent itself.
 * Prefer toConversationUpdatedEvent at new call sites.
 * Removal tracked: docs/issues/remove-dead-relay-roster-alias.md (now zero callers).
 */
export function toRelayRosterEvent(item: ConversationItem): ConversationUpdatedEvent {
  return toConversationUpdatedEvent(item);
}

/** A message landed on the timeline, or its delivery status really moved. */
export interface MessagePersistedEvent {
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  deliveryStatus: DeliveryStatus;
}

/**
 * A share-broadcast (M1.8a "Share Properties") progressed — emitted from the
 * broadcast.send job (on completion) and the delivery-callback rollup so the
 * results view updates live. Carries the lifecycle status + the rolled-up
 * counters; NO PII (counts only).
 */
export interface BroadcastUpdatedEvent {
  broadcastId: string;
  status: BroadcastStatus;
  stats: BroadcastStats;
}

/**
 * A placement (M1.10) was created or changed — the boards re-render the card
 * live (move it between stage columns, refresh its tour/deadline/attention/relay
 * state). A compact, ID-only payload: the boards already render names from the
 * tenant/unit they hydrate, so a card move needs only the keys + state, never
 * PII. NO names/phones/bodies (the placement_tag — a name — is deliberately
 * NOT carried).
 */
export interface PlacementUpdatedEvent {
  placementId: string;
  tenantId: string;
  unitId: string;
  stage: string;
  tour_date: string | null;
  next_deadline_type: string | null;
  next_deadline_at: string | null;
  /** The linked relay-group conversationId, or null (set in M1.10c). */
  group_thread: string | null;
  /** True when the placement carries an escalation attention flag (doc §7.1). */
  attention: boolean;
  /**
   * The lost-reason CATEGORY only (STATUS-MODEL.md §7). lost_reason is stored as
   * a structured `{ category, text }` object; only the bounded category enum is
   * carried on the wire — the free `text` may contain PII and is deliberately
   * NOT emitted (doc §9).
   */
  lost_reason: string | null;
  updated_at: string | null;
}

/**
 * THE one placement.updated payload builder — every emit site uses it (no drift).
 *
 * The wire keeps the FLAT `next_deadline_type` / `next_deadline_at` shape the
 * dashboard consumes, but the SOURCE moved from a stored slot to a COMPUTED value
 * (placement-deadline-model refactor): callers pass `next` = the soonest of the
 * placement's placementDeadlines items (via placementDeadlinesRepo.soonestDeadline),
 * or null/omitted when there is none. No stored next_deadline_* fields survive.
 */
export function toPlacementUpdatedEvent(
  item: PlacementItem,
  next?: { type: string; at: string } | null,
): PlacementUpdatedEvent {
  return {
    placementId: item.placementId,
    tenantId: item.tenantId,
    unitId: item.unitId,
    stage: item.stage,
    tour_date: item.tour_date ?? null,
    next_deadline_type: next?.type ?? null,
    next_deadline_at: next?.at ?? null,
    group_thread: item.group_thread ?? null,
    // != null covers both absent (cleared → REMOVE) and a stray null. This
    // boolean is load-bearing: the boards flip a placement's attention badge live
    // when the M1.10c escalation seam raises it.
    attention: item.attention != null,
    // Category only — never the free `text` (potential PII). lost_reason is the
    // structured { category, text } object (§7).
    lost_reason:
      item.lost_reason && typeof item.lost_reason === 'object'
        ? (item.lost_reason.category ?? null)
        : null,
    updated_at: item.updated_at ?? null,
  };
}

/**
 * A scheduled-message ladder changed — a tour reminder or placement nudge was
 * armed, rescheduled, or canceled. The contact timeline's pinned "Upcoming"
 * section refetches on this so future/scheduled sends appear/disappear live
 * without a manual reload. ID-only, best-effort payload: `contactId` is the
 * affected person (a tour's tenantId / a placement's tenantId) and is ADVISORY
 * — the client refetches unconditionally, so a landlord-recipient nudge need
 * not resolve the landlord contact (no extra unit read). NO PII (never logged).
 */
export interface ScheduledUpdatedEvent {
  contactId?: string;
}

/**
 * A tour was mutated (tour-detail-page 1a) - the tour page refetches the
 * header + Activity card live. Emitted best-effort after a successful
 * PATCH /api/tours/:tourId, POST /api/tours/:tourId/relay, POST
 * /api/tours/:tourId/reopen, the from-tour conversion (placements.ts), and
 * each tour the auto-close sweep closes (jobs/tourAutoClose.ts - from the
 * worker poll, bridged to the app, and from the dev tick). ID + status only:
 * the page re-reads the tour itself, so the event never carries
 * names/phones/labels (PII, doc section 9).
 */
export interface TourUpdatedEvent {
  tourId: string;
  status: string;
}

/**
 * A contact's AI-extraction state changed (conversation-fact-extraction): a
 * field was auto-written, a pending suggestion was upserted, an auto note was
 * appended, or a suggestion was accepted/dismissed. The contact page's chips/
 * badges + the Today "AI suggestions" tile refetch on this. ID-only (never PII).
 *
 * CROSS-PROCESS BRIDGE (lib/eventBridge.ts): the extraction POLL runs in the
 * WORKER process; its poll-driven emit now crosses the bridge to the app's SSE
 * clients when EVENT_BRIDGE_URL is set (all deployed envs + local runners), so an
 * open contact page updates live. Bare unset-URL runs surface the change on the
 * next fetch. See jobs/extraction.ts.
 */
export interface SuggestionUpdatedEvent {
  contactId: string;
}

/**
 * One extraction run finished (manual-extraction-trigger 4.4b). Emitted for
 * EVERY run - applied, no_op, skipped and failed - because the skip and failure
 * cases are exactly what the contact page's running indicator has to explain.
 * `requestId` is present only when a human press started the run, and is what
 * correlates that press to THIS run: conversationId identifies the thread, not
 * the run, so it cannot do that job alone.
 *
 * PII: ids and counts only. Never a body, a phone number, or a field value.
 */
export interface AiRunCompletedEvent {
  conversationId: string;
  runId: string;
  requestId?: string;
  contactId?: string;
  outcome: 'applied' | 'no_op' | 'skipped' | 'failed';
  skipReason?: string;
  errorKind?: string;
  wrote: number;
  suggested: number;
  notedLines: number;
}

/**
 * An unmatched-email row changed (email-channel B2/B3): a mail from an unknown
 * sender landed in (or left) the unmatched/quarantine feeds. B2's ingestion
 * emits it when a row is stored; B3's triage routes emit it on status flips;
 * B6's nav badge + Email page refetch on it. ID-only, best-effort payload -
 * NEVER the address/subject/body (PII, doc section 9); consumers refetch the
 * feed regardless, so `unmatchedId` is advisory.
 */
export interface UnmatchedEmailUpdatedEvent {
  unmatchedId?: string;
}

/**
 * A contact's status or type changed (unknown-inactive spec D2, ruling AR3).
 * Emitted by the status transition (services/statusTransition.ts
 * setTenantStatus - every successful call: the header dropdown, the edit
 * form's status save when it changes no type, and the form's status write
 * after a type change to tenant when the shown status is not Onboarding or
 * porting changed), by PATCH /api/contacts/:contactId when that PATCH changed
 * `status` or `type` (the edit form's type changes, which carry a non-tenant
 * target's status, and a landlord's status with its park reason; the unknown
 * card's Mark as actions), and once by the caseworker conversion's commit
 * (services/caseworkerConversion.ts make, which changes both; code review R1
 * FW1-4). The Today page and the inbox refetch on it; the
 * contact page re-reads the contact when `contactId` is the one it shows. It
 * exists because the conversation.updated emits cover only linked threads
 * that flipped type or carry a name, so an unnamed or threadless contact got
 * no event at all. ID-only - NEVER a name, phone or status value (PII, doc
 * section 9); consumers re-read.
 *
 * Staff outreach (tracker #31; spec 2026-10-23-today-checklist-design.md
 * 7.3; plan PR8): it is ALSO the one live event of a one-to-one staff send
 * whose `last_reached_out_at` stamp was written - emitted AFTER the send's
 * own events, and only for a contactId recordStaffOutreach
 * (services/staffOutreach.ts) returned as written, so Today's Quiet shares
 * drops the person on the refetch. Emitters: services/sendMessage.ts (a send
 * carrying the `staffOutreach` option - the 1:1 route's first batch and the
 * staff Retry of a row that is neither a share, automated nor system copy,
 * plan PR104), services/sendEmailMessage.ts (after SES accepts),
 * routes/webhooks/voice.ts stampOutboundDial (the outbound whisper-gate dial,
 * after the TwiML is sent, handed to `afterResponse`), and routes/dev.ts
 * touchFixtureReachedOut (the dev fixture seams' outbound rows). Three
 * INBOUND paths emit it too, right after their `last_heard_from_at` touch
 * returns 'written', because their conversation.updated fires before that
 * touch or not at all: services/inboundEmail.ts, the founder-triage inbound
 * call (an abandoned ring has no Dial summary) and the masked relay call
 * paths (refused and bridged), both in routes/webhooks/voice.ts. A relay or
 * group post emits NO contact.updated per member: jobs/relayFanOut.ts (a team
 * post's legs) and services/relayAnnouncements.ts (a staff-edited intro) each
 * emit ONE conversation.updated after their member loop, through
 * stampRelayOutreach (services/relayAnnouncements.ts), built from a fresh
 * consistent read (conversationsRepo.getByIdConsistent); services/groupSend.ts
 * stamps BEFORE its existing conversation.updated.
 */
export interface ContactUpdatedEvent {
  contactId: string;
}

export interface AppEventMap {
  'conversation.updated': ConversationUpdatedEvent;
  'message.persisted': MessagePersistedEvent;
  'broadcast.updated': BroadcastUpdatedEvent;
  'placement.updated': PlacementUpdatedEvent;
  'scheduled.updated': ScheduledUpdatedEvent;
  'tour.updated': TourUpdatedEvent;
  'suggestion.updated': SuggestionUpdatedEvent;
  'unmatched_email.updated': UnmatchedEmailUpdatedEvent;
  'ai_run.completed': AiRunCompletedEvent;
  'contact.updated': ContactUpdatedEvent;
}

export type AppEventName = keyof AppEventMap;

// Every event name, as a VALUE (the bridge + internal route iterate/validate
// at runtime; AppEventMap is types-only). Record<AppEventName, true> makes this
// exhaustive BY CONSTRUCTION: adding ANY event to AppEventMap without listing
// it here is a compile error - which is what keeps a future event from
// silently missing the cross-process bridge (lib/eventBridge.ts). (Stated
// without a count on purpose: the ordinal this comment used to carry was
// already stale by one before ai_run.completed was added.)
const ALL_APP_EVENTS: Record<AppEventName, true> = {
  'conversation.updated': true,
  'message.persisted': true,
  'broadcast.updated': true,
  'placement.updated': true,
  'scheduled.updated': true,
  'tour.updated': true,
  'suggestion.updated': true,
  'unmatched_email.updated': true,
  'ai_run.completed': true,
  'contact.updated': true,
};
export const APP_EVENT_NAMES: readonly AppEventName[] = Object.keys(
  ALL_APP_EVENTS,
) as AppEventName[];

/** Typed wrapper over EventEmitter — payloads are checked per event name. */
export interface EventBus {
  emit<K extends AppEventName>(event: K, payload: AppEventMap[K]): void;
  on<K extends AppEventName>(event: K, listener: (payload: AppEventMap[K]) => void): void;
  off<K extends AppEventName>(event: K, listener: (payload: AppEventMap[K]) => void): void;
  /** Current listener count — disconnect-cleanup assertions in tests. */
  listenerCount(event: AppEventName): number;
}

/** Fresh isolated bus (tests); production shares the appEvents singleton. */
export function createEventBus(deps: { logger?: Logger } = {}): EventBus {
  const emitter = new EventEmitter();
  const log = deps.logger ?? defaultLogger;
  // One listener pair per connected SSE client: the default max-listeners
  // warning (10) would fire at five open dashboards. Uncapped is safe here —
  // the SSE route removes its listeners on every disconnect.
  emitter.setMaxListeners(0);
  return {
    emit(event, payload) {
      // Per-listener isolation: a throwing listener (e.g. one broken SSE
      // client's write) must never propagate into the EMITTER's caller —
      // the webhook/send pipelines — or starve the other listeners. ERROR
      // is correlated via the pino mixin (the emitter's active context);
      // the payload is never logged (it carries the preview — PII, doc §9).
      for (const listener of emitter.listeners(event)) {
        try {
          (listener as (p: AppEventMap[typeof event]) => void)(payload);
        } catch (err) {
          log.error({ err, event }, 'event bus listener threw — isolated, other listeners unaffected');
        }
      }
    },
    on(event, listener) {
      emitter.on(event, listener);
    },
    off(event, listener) {
      emitter.off(event, listener);
    },
    listenerCount(event) {
      return emitter.listenerCount(event);
    },
  };
}

/** The process-wide bus (see the SSE-spine note in the file header). */
export const appEvents: EventBus = createEventBus();
