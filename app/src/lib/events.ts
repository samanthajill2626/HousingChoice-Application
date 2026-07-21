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
   * Relay group status (M1.7): `open` | `closed` for relay_group threads;
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
   * Relay group roster (M1.7), or null on 1:1 threads. The live member list so
   * the relay UI updates rosters in place on add/remove. Each entry carries
   * contactId/phone/name (name optional). 1:1 behavior is unchanged — this is
   * null there.
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
 * PATCH /api/tours/:tourId, POST /api/tours/:tourId/relay, and the from-tour
 * conversion (placements.ts). ID + status only: the page re-reads the tour
 * itself, so the event never carries names/phones/labels (PII, doc section 9).
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

export interface AppEventMap {
  'conversation.updated': ConversationUpdatedEvent;
  'message.persisted': MessagePersistedEvent;
  'broadcast.updated': BroadcastUpdatedEvent;
  'placement.updated': PlacementUpdatedEvent;
  'scheduled.updated': ScheduledUpdatedEvent;
  'tour.updated': TourUpdatedEvent;
  'suggestion.updated': SuggestionUpdatedEvent;
  'unmatched_email.updated': UnmatchedEmailUpdatedEvent;
}

export type AppEventName = keyof AppEventMap;

// Every event name, as a VALUE (the bridge + internal route iterate/validate
// at runtime; AppEventMap is types-only). Record<AppEventName, true> makes this
// exhaustive BY CONSTRUCTION: adding an eighth event to AppEventMap without
// listing it here is a compile error - which is what keeps a future event from
// silently missing the cross-process bridge (lib/eventBridge.ts).
const ALL_APP_EVENTS: Record<AppEventName, true> = {
  'conversation.updated': true,
  'message.persisted': true,
  'broadcast.updated': true,
  'placement.updated': true,
  'scheduled.updated': true,
  'tour.updated': true,
  'suggestion.updated': true,
  'unmatched_email.updated': true,
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
