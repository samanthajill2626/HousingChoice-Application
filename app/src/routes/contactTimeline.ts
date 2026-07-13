// Contact timeline router (BE2/C2) — the person-centric MERGED timeline.
//
//   GET /api/contacts/:contactId/timeline?cursor=&kinds=&limit=
//        → { items: TimelineItem[], nextCursor: string | null }
//
// Mounted under /api/contacts (behind requireAuth via the /api mount). Merges,
// for ONE contact, every 1:1 conversation across ALL their phone numbers
// (messages + call entries) UNION the activity-event log (milestones), sorted
// newest-first by a global `<at>#<id>` key and paginated by an opaque cursor.
//
// ORDER (locked, C2): the response `items` are returned ASCENDING (oldest→
// newest) so the client renders them as-is. The CURSOR still pages BACKWARD in
// time (each nextCursor fetches the next-OLDER page) — internally we gather
// candidates, sort DESC, take the newest `limit`, derive nextCursor from the
// OLDEST item of that descending slice, and only THEN reverse the page to
// ascending for the wire. Keeping the merge/cursor descending makes the cursor
// boundary unambiguous with no dups/skips across pages; the final reverse is
// purely a presentation step.
//
// PII (doc §9) — load-bearing:
//   - messages: FULL body (no truncation); fromPhone/toPhone derive ONLY from
//     the contact's own number (the conversation's participant_phone) + our org
//     number — never another counterpart.
//   - calls: party_phone is the contact's OWN number for a 1:1 call; a MASKED
//     (relay-pool) call NEVER exposes recording_s3_key/transcript (omitted
//     entirely) — only founder-bridge (masked!==true) calls carry them.
//   - milestones: link-out only (refType/refId) — never inline content.
//   - log lines carry IDs/counts only — never bodies/phones/labels.
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createActivityEventsRepo,
  type ActivityEventItem,
  type ActivityEventRefType,
  type ActivityEventsRepo,
  type ActivityEventType,
} from '../repos/activityEventsRepo.js';
import { createAuditRepo, type AuditEvent, type AuditRepo } from '../repos/auditRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  contactPhones,
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MediaAttachment,
  type MessageDirection,
  type MessageAuthor,
  type MessageItem,
  type MessagesRepo,
  type CallOutcome,
  type DeliveryStatus,
  type RelayRecipientDelivery,
} from '../repos/messagesRepo.js';
import type { PlacementStage } from '../lib/statusModel.js';
import { LISTING_STATUS_LABELS } from '../lib/statusModel.js';
import {
  resolveUsableGroup,
  type RunDueTourRemindersDeps,
} from '../jobs/tourReminders.js';
import { NUDGE_RUNGS } from '../jobs/placementNudges.js';
import { resolveMessage } from '../messages/index.js';
import {
  type ReminderKind,
  type TourReminderItem,
  type TourRemindersRepo,
} from '../repos/tourRemindersRepo.js';
import { type NudgeKind, type PlacementNudgesRepo } from '../repos/placementNudgesRepo.js';
import { type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import { type PlacementItem, type PlacementsRepo } from '../repos/placementsRepo.js';
import {
  evaluateScheduledSendSuppression,
  type ScheduledSuppression,
} from '../services/scheduledSendSuppression.js';

export interface ContactTimelineRouterDeps {
  logger?: Logger;
  config?: AppConfig;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  activityEventsRepo?: ActivityEventsRepo;
  /** A landlord contact's owned units (byLandlord GSI) — shared by the
   *  property-activity interleave AND the scheduled-send landlord nudge walk. */
  unitsRepo?: UnitsRepo;
  /** Per-unit audit trail read (bounded Query per owned unit) — the landlord
   *  property-activity lifecycle source. */
  auditRepo?: AuditRepo;
  // Scheduled-send gather (Part B) — the not-yet-sent tour reminders + placement
  // nudges surfaced in the first-page `upcoming[]` bucket. All five must be
  // present for the gather to run; when any is absent the bucket is `[]` (the
  // gather never default-constructs a DynamoDB repo, so injecting-less callers —
  // e.g. the in-memory unit-test app — simply skip it). `unitsRepo` above is the
  // fifth (shared with the property-activity interleave).
  toursRepo?: ToursRepo;
  tourRemindersRepo?: TourRemindersRepo;
  placementNudgesRepo?: PlacementNudgesRepo;
  placementsRepo?: PlacementsRepo;
}

// --- C2 wire shapes (VERBATIM — the frontend imports identical field names) --

interface TimelineBase {
  id: string;
  /** ISO 8601 — the global sort key. */
  at: string;
}
interface TimelineMessage extends TimelineBase {
  kind: 'message';
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  author: MessageAuthor;
  type: 'sms' | 'mms';
  body?: string;
  media_attachments?: MediaAttachment[];
  delivery_status: DeliveryStatus;
  error_code?: string;
  /** tsMsgId of the FAILED message a retry supersedes — the client hides the
   *  superseded predecessor so a delivered retry replaces the stale bubble. */
  retry_of?: string;
  fromPhone?: string;
  toPhone?: string;
  /** Relay group (M1.7): per-recipient delivery slots on a relay SOURCE message.
   *  Surfaces the "N member(s) opted out" note. (relay_group threads are
   *  excluded from THIS server timeline today, so this is carried for
   *  completeness + future-proofing; the client fallback is the live path.) */
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
}
interface TimelineCall extends TimelineBase {
  kind: 'call';
  conversationId?: string;
  call_outcome: CallOutcome;
  call_duration?: number;
  party_phone?: string;
  recording_s3_key?: string;
  transcript?: string;
}
interface TimelineMilestone extends TimelineBase {
  kind: 'milestone';
  type: ActivityEventType;
  label: string;
  refType?: ActivityEventRefType;
  refId?: string;
}
type TimelineItem = TimelineMessage | TimelineCall | TimelineMilestone;

/**
 * A not-yet-sent scheduled outbound (tour reminder / placement nudge), surfaced
 * as a FUTURE item in the first-page `upcoming[]` bucket (never merged into the
 * DESC-take-limit `items` slice — a future `dueAt` would corrupt the cursor).
 * `at` = the row's `dueAt`; `id` = `sched#<source>#<rowId>`.
 */
interface TimelineScheduled extends TimelineBase {
  kind: 'scheduled';
  /** The resolved 1:1 thread if one already exists; ABSENT for a landlord nudge
   *  whose 1:1 is created on demand at fire time (item still shows — M4). */
  conversationId?: string;
  source: 'tour_reminder' | 'placement_nudge';
  reminderKind?: ReminderKind;
  nudgeKind?: NudgeKind;
  /** The canned template that WILL send (faithful preview). */
  body: string;
  /** Absent = will send; present = will be skipped + the reason. */
  suppression?: ScheduledSuppression;
  refType: 'tour' | 'placement';
  refId: string;
}

/** A candidate carries its global comparison key alongside the wire item. */
interface Candidate {
  /** `<at>#<id>` — the global, comparable boundary key. */
  globalKey: string;
  item: TimelineItem;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/** Bound the landlord property-activity fan-out (byLandlord Query limit + N cap). */
const MAX_LANDLORD_UNITS = 25;

/**
 * The property-audit event_types a LANDLORD's timeline surfaces (human decision,
 * 2026-07-03): lifecycle only. Routine field-edit churn
 * (`unit_created`/`unit_updated`/`unit_deleted`/`unit_restored`) stays in the
 * audit trail as provenance but is NEVER interleaved.
 */
const LANDLORD_FEED_TYPES: ReadonlySet<string> = new Set([
  'broadcast_sent',
  'tour_scheduled',
  'tour_rescheduled',
  'tour_took_place',
  'tour_no_show',
  'tour_canceled',
  'tour_outcome',
  'listing_status_changed',
  'unit_contact_added',
  'unit_contact_removed',
]);

const ALL_KINDS = ['message', 'call', 'milestone', 'scheduled'] as const;
type TimelineKind = (typeof ALL_KINDS)[number];

/** Cap the landlord unit walk (M2) — log when truncated (never a silent cap). */
const UNIT_WALK_CAP = 50;

/**
 * Reverse index: nudge `kind` → the stage that arms it + its recipient/body.
 * Derived from the exported `NUDGE_RUNGS` (stage → rung) so the gather can, per
 * nudge row, recover the rung's stage (for the `staleStage` suppression check),
 * its recipient (to scope tenant vs landlord rungs), and its canned body.
 */
interface NudgeRungInfo {
  stage: PlacementStage;
  recipient: 'tenant' | 'landlord';
  body: string;
}
const NUDGE_RUNG_BY_KIND: Map<NudgeKind, NudgeRungInfo> = (() => {
  const map = new Map<NudgeKind, NudgeRungInfo>();
  for (const [stage, rung] of Object.entries(NUDGE_RUNGS)) {
    if (rung === undefined) continue;
    map.set(rung.kind, {
      stage: stage as PlacementStage,
      recipient: rung.recipient,
      body: resolveMessage(`nudge.${rung.kind}`),
    });
  }
  return map;
})();

/** Parse ?limit= into 1..MAX (default). undefined ⇒ 400 upstream. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

/**
 * Parse ?kinds= (comma list of message|call|milestone). Absent/empty ⇒ all.
 * Returns the validated SET, or undefined for an invalid token (→ 400).
 */
function parseKinds(raw: unknown): Set<TimelineKind> | undefined {
  if (raw === undefined || raw === '') return new Set(ALL_KINDS);
  if (typeof raw !== 'string') return undefined;
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return new Set(ALL_KINDS);
  const set = new Set<TimelineKind>();
  for (const p of parts) {
    if (!(ALL_KINDS as readonly string[]).includes(p)) return undefined;
    set.add(p as TimelineKind);
  }
  return set;
}

/**
 * The opaque cursor is the base64url of a global boundary key (`<at>#<id>`),
 * an EXCLUSIVE upper bound. Validate the SHAPE (a non-empty string containing a
 * `#`) so a tampered cursor never silently widens/empties the page — a
 * malformed value is a 400, never a crash.
 */
function encodeCursor(boundaryKey: string): string {
  return Buffer.from(boundaryKey, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): string | undefined {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (decoded.length === 0 || !decoded.includes('#')) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

/**
 * Our org number to stamp on fromPhone/toPhone. Phase-1 single-number posture:
 * the first configured OUR_PHONE_NUMBERS entry (the dashboard sends/receives on
 * it). Absent when unconfigured (tests/local) → those fields are simply omitted.
 */
function ourNumberOf(config: AppConfig): string | undefined {
  return config.ourPhoneNumbers[0];
}

/**
 * The ISO `at` for a wire item, sourced from a `<ISO ts>#<id>` sort-key prefix.
 * The tsMsgId / tsEventId prefix IS the timestamp the server sorts + paginates
 * by, so deriving `at` from it makes `at` ALWAYS a non-empty ISO string AND
 * exactly equal to the sort/cursor key (provider_ts-less rows + milestones
 * included). Falls back to a supplied value, then the whole key, so `at` is
 * never empty/undefined.
 */
function atOf(sortKey: string, fallback?: string): string {
  const i = sortKey.indexOf('#');
  return i > 0 ? sortKey.slice(0, i) : (fallback ?? sortKey);
}

/** Map a stored message → a TimelineMessage (sms/mms). FULL body, no truncation. */
function toTimelineMessage(
  m: MessageItem,
  conversation: ConversationItem | undefined,
  ourNumber: string | undefined,
): TimelineMessage {
  // The contact's OWN number on this 1:1 thread (participant_phone) + our org
  // number are the ONLY phones we expose — never another counterpart (PII).
  const contactPhone = conversation?.participant_phone;
  const fromPhone =
    m.direction === 'inbound' ? contactPhone : ourNumber;
  const toPhone = m.direction === 'inbound' ? ourNumber : contactPhone;
  const media = mediaAttachmentsOf(m);
  return {
    kind: 'message',
    id: m.tsMsgId,
    at: atOf(m.tsMsgId, m.provider_ts),
    conversationId: m.conversationId,
    tsMsgId: m.tsMsgId,
    direction: m.direction,
    author: m.author,
    type: m.type === 'mms' ? 'mms' : 'sms',
    ...(m.body !== undefined && { body: m.body }),
    ...(media.length > 0 && { media_attachments: media }),
    delivery_status: m.delivery_status,
    ...(m.error_code !== undefined && { error_code: m.error_code }),
    ...(m.retry_of !== undefined && { retry_of: m.retry_of }),
    ...(m.delivery_recipients !== undefined && { delivery_recipients: m.delivery_recipients }),
    ...(fromPhone !== undefined && { fromPhone }),
    ...(toPhone !== undefined && { toPhone }),
  };
}

/**
 * Map a stored call → a TimelineCall. PII: recording_s3_key + transcript ONLY
 * when masked !== true (founder-bridge); a MASKED call omits both entirely.
 * party_phone is the contact's OWN number for a 1:1 call — never a masked
 * counterpart, so it is only set when the call is NOT masked AND a 1:1 thread
 * resolves the contact's number.
 */
function toTimelineCall(
  m: MessageItem,
  conversation: ConversationItem | undefined,
): TimelineCall {
  const masked = m.masked === true;
  // at == sort-key == cursor: all provider_ts. The merge/sort + cursor use
  // globalKey = m.tsMsgId (`<provider_ts>#<sid>`) and messagesRepo paginates on
  // tsMsgId, so the displayed `at` MUST be provider_ts (which append always sets)
  // to stay consistent with what the server sorts/paginates by — same as
  // TimelineMessage. (started_at is the call's first-seen time, not a sort key.)
  const partyPhone = masked ? undefined : conversation?.participant_phone;
  return {
    kind: 'call',
    id: m.tsMsgId,
    at: atOf(m.tsMsgId, m.provider_ts),
    ...(m.conversationId !== undefined && { conversationId: m.conversationId }),
    // call_outcome is required on the wire; default 'missed' when a call entry
    // has no recorded outcome yet (a ringing/unanswered metadata row).
    call_outcome: (m.call_outcome ?? 'missed') as CallOutcome,
    ...(typeof m.call_duration === 'number' && { call_duration: m.call_duration }),
    ...(partyPhone !== undefined && { party_phone: partyPhone }),
    // Masked calls are NEVER recorded/transcribed — never expose these.
    ...(!masked && typeof m.recording_s3_key === 'string' && { recording_s3_key: m.recording_s3_key }),
    ...(!masked && typeof m.transcript === 'string' && { transcript: m.transcript }),
  };
}

/** Map a stored activity event → a TimelineMilestone (link-out only). */
function toTimelineMilestone(e: ActivityEventItem): TimelineMilestone {
  return {
    kind: 'milestone',
    id: e.eventId,
    at: atOf(e.tsEventId, e.at),
    type: e.type,
    label: e.label,
    ...(e.refType !== undefined && { refType: e.refType }),
    ...(e.refId !== undefined && { refId: e.refId }),
  };
}

/**
 * Map a tour AUDIT `event_type` → the closest existing milestone
 * `ActivityEventType`. The frontend renders a milestone by its `type` (colour +
 * deep-link kind), so a milestone `type` MUST be an existing member — never a
 * raw audit string. `tour_rescheduled` has no dedicated member → reuse
 * `tour_scheduled`; the rest map 1:1 to the same-named member. The human wording
 * lives in the `label` (see `tourAuditLabel`).
 */
function mapTourAuditToMilestoneType(auditType: string): ActivityEventType {
  switch (auditType) {
    case 'tour_took_place':
      return 'tour_took_place';
    case 'tour_no_show':
      return 'tour_no_show';
    case 'tour_canceled':
      return 'tour_canceled';
    case 'tour_outcome':
      return 'tour_outcome';
    case 'tour_scheduled':
    case 'tour_rescheduled':
    default:
      return 'tour_scheduled';
  }
}

/** Human label for a tour AUDIT `event_type` (carries the wording; type drives colour). */
function tourAuditLabel(auditType: string): string {
  switch (auditType) {
    case 'tour_rescheduled':
      return 'Tour rescheduled';
    case 'tour_took_place':
      return 'Tour took place';
    case 'tour_no_show':
      return 'Tour no-show';
    case 'tour_canceled':
      return 'Tour canceled';
    case 'tour_outcome':
      return 'Tour outcome';
    case 'tour_scheduled':
    default:
      return 'Tour scheduled';
  }
}

/**
 * Map ONE owned-unit audit row → a `TimelineMilestone` for the landlord's
 * timeline, or `null` when the row is not a surfaced lifecycle type. The milestone
 * `type` REUSES an existing `ActivityEventType` (colour/link only); the `label`
 * carries the human wording; `refType`/`refId` deep-link out (broadcast → the
 * broadcast, tour → the tour, else the property/unit). PII-safe: labels/ids only,
 * never a phone/body. `id` = the raw audit SK (`<ISO>#<rand>`) so the merged
 * cursor lives in the SAME lexical space as the audit `before` bound (page-safe).
 */
function unitAuditToMilestone(unitId: string, e: AuditEvent): TimelineMilestone | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const at = typeof e.ts === 'string' ? atOf(e.ts) : '';
  const id = typeof e.ts === 'string' ? e.ts : `${unitId}-${e.event_type}`;
  const base = { kind: 'milestone' as const, id, at };
  switch (e.event_type) {
    case 'broadcast_sent': {
      const n = typeof p['tenantCount'] === 'number' ? p['tenantCount'] : 0;
      return {
        ...base,
        type: 'listing_sent',
        label: `Sent to ${n} ${n === 1 ? 'tenant' : 'tenants'}`,
        refType: 'broadcast',
        ...(typeof p['broadcastId'] === 'string' && { refId: p['broadcastId'] }),
      };
    }
    case 'tour_scheduled':
    case 'tour_rescheduled':
    case 'tour_took_place':
    case 'tour_no_show':
    case 'tour_canceled':
    case 'tour_outcome':
      return {
        ...base,
        type: mapTourAuditToMilestoneType(e.event_type),
        label: tourAuditLabel(e.event_type),
        refType: 'tour',
        ...(typeof p['tourId'] === 'string' && { refId: p['tourId'] }),
      };
    case 'listing_status_changed': {
      const to = typeof p['to'] === 'string' ? p['to'] : '';
      return {
        ...base,
        type: 'stage_changed',
        label: `Property status → ${(LISTING_STATUS_LABELS as Record<string, string>)[to] ?? to}`,
        refType: 'unit',
        refId: unitId,
      };
    }
    case 'unit_contact_added':
    case 'unit_contact_removed':
      return {
        ...base,
        type: e.event_type === 'unit_contact_added' ? 'added_to_group_text' : 'removed_from_group_text',
        label: e.event_type === 'unit_contact_added' ? 'Property contact added' : 'Property contact removed',
        refType: 'unit',
        refId: unitId,
      };
    default:
      return null;
  }
}

/** The five repos the scheduled-send gather walks. */
interface ScheduledGatherRepos {
  toursRepo: ToursRepo;
  tourRemindersRepo: TourRemindersRepo;
  placementsRepo: PlacementsRepo;
  placementNudgesRepo: PlacementNudgesRepo;
  unitsRepo: UnitsRepo;
}

/**
 * Gather this contact's not-yet-sent scheduled sends into the first-page
 * `upcoming[]` bucket. Three independent walks (M2 — all `Promise.all`-parallel,
 * internally and with each other), each index-backed (no scans):
 *   1. tenant tours → tour reminders that will route 1:1 (self_guided OR an
 *      UNUSABLE group per the EXACT poller `resolveUsableGroup`, M3);
 *   2. tenant placements → nudge rungs whose recipient is the tenant;
 *   3. landlord units → placements → nudge rungs whose recipient is the landlord
 *      (surfaced even with NO landlord 1:1 yet — `conversationId` absent, M4).
 * Every item's send-time suppression is previewed via the shared evaluator.
 * PII (doc §9): no bodies/phones logged — only IDs/counts.
 */
async function gatherUpcoming(params: {
  contact: ContactItem;
  config: AppConfig;
  conversationsRepo: ConversationsRepo;
  repos: ScheduledGatherRepos;
  log: Logger;
}): Promise<TimelineScheduled[]> {
  const { contact, config, conversationsRepo, repos, log } = params;
  const contactId = contact.contactId;

  // Resolve the contact's 1:1 threads the SAME way the pollers do — from the
  // scalar primary phone (not the multi-phone convById), first matching type.
  const phone = contact.phone;
  const convs =
    typeof phone === 'string' && phone.length > 0
      ? await conversationsRepo.findByParticipantPhone(phone)
      : [];
  const tenantConv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');
  const landlordConv = convs.find((c) => c.type === 'landlord_1to1' || c.type === 'unknown_1to1');
  const contactOptOut = contact.sms_opt_out === true;

  /** Preview suppression against a 1:1 thread (+ optional nudge stale-stage). */
  const suppressionFor = (
    conv: ConversationItem | undefined,
    staleStage: boolean,
  ): ScheduledSuppression | undefined =>
    evaluateScheduledSendSuppression({
      smsSendingEnabled: config.smsSendingEnabled,
      convOptOut: conv?.sms_opt_out,
      contactOptOut,
      aiMode: conv?.ai_mode,
      staleStage,
    });

  /** Map upcoming nudge rows of ONE recipient on ONE placement → items. */
  const nudgeItemsFor = (
    rows: Array<{ nudgeId: string; kind: NudgeKind; dueAt: string; sentAt?: string; canceledAt?: string }>,
    placement: PlacementItem,
    recipient: 'tenant' | 'landlord',
    conv: ConversationItem | undefined,
  ): TimelineScheduled[] => {
    const items: TimelineScheduled[] = [];
    for (const row of rows) {
      if (row.sentAt !== undefined || row.canceledAt !== undefined) continue; // upcoming only
      const info = NUDGE_RUNG_BY_KIND.get(row.kind);
      if (info === undefined || info.recipient !== recipient) continue; // scope to this recipient
      const suppression = suppressionFor(conv, placement.stage !== info.stage);
      items.push({
        kind: 'scheduled',
        id: `sched#placement_nudge#${row.nudgeId}`,
        at: row.dueAt,
        source: 'placement_nudge',
        nudgeKind: row.kind,
        body: info.body,
        ...(conv !== undefined && { conversationId: conv.conversationId }),
        ...(suppression !== undefined && { suppression }),
        refType: 'placement',
        refId: placement.placementId,
      });
    }
    return items;
  };

  // Walk 1 — tenant tours → 1:1-routed tour reminders.
  const tourWalk = (async (): Promise<TimelineScheduled[]> => {
    const tours = await repos.toursRepo.listByTenant(contactId);
    const perTour = await Promise.all(
      tours.map(async (tour: TourItem): Promise<TimelineScheduled[]> => {
        const rows = await repos.tourRemindersRepo.listByTour(tour.tourId);
        const upcomingRows = rows.filter(
          (r) => r.sentAt === undefined && r.canceledAt === undefined && r.skippedAt === undefined,
        );
        if (upcomingRows.length === 0) return [];
        // Route decision — mirror the poller EXACTLY: self_guided always 1:1;
        // any other type is 1:1 ONLY when its group is unusable (M3). A
        // group-routed rung has no 1:1 thread → it is dropped here.
        let routes1to1 = tour.tourType === 'self_guided';
        if (!routes1to1) {
          // resolveUsableGroup only reads `deps.conversationsRepo` — a narrow
          // structural view is all it needs (cast documented).
          const groupDeps = { conversationsRepo } as unknown as RunDueTourRemindersDeps;
          const group = await resolveUsableGroup(tour, upcomingRows[0]!, groupDeps, log);
          routes1to1 = group === undefined;
        }
        if (!routes1to1) return [];
        return upcomingRows.map((row: TourReminderItem): TimelineScheduled => {
          const suppression = suppressionFor(tenantConv, false);
          return {
            kind: 'scheduled',
            id: `sched#tour_reminder#${row.reminderId}`,
            at: row.dueAt,
            source: 'tour_reminder',
            reminderKind: row.kind,
            body: resolveMessage(`tour.${row.kind}`),
            ...(tenantConv !== undefined && { conversationId: tenantConv.conversationId }),
            ...(suppression !== undefined && { suppression }),
            refType: 'tour',
            refId: tour.tourId,
          };
        });
      }),
    );
    return perTour.flat();
  })();

  // Walk 2 — tenant placements → tenant-recipient nudge rungs.
  const tenantNudgeWalk = (async (): Promise<TimelineScheduled[]> => {
    const { items: placements } = await repos.placementsRepo.listByTenant(contactId);
    const perPlacement = await Promise.all(
      placements.map(async (placement): Promise<TimelineScheduled[]> => {
        const rows = await repos.placementNudgesRepo.listByPlacement(placement.placementId);
        return nudgeItemsFor(rows, placement, 'tenant', tenantConv);
      }),
    );
    return perPlacement.flat();
  })();

  // Walk 3 — landlord units → placements → landlord-recipient nudge rungs.
  const landlordNudgeWalk = (async (): Promise<TimelineScheduled[]> => {
    const unitsPage = await repos.unitsRepo.listByLandlord(contactId, { limit: UNIT_WALK_CAP });
    if (unitsPage.lastEvaluatedKey !== undefined) {
      log.info(
        { contactId, cap: UNIT_WALK_CAP },
        'contact timeline: landlord unit walk truncated at cap — some landlord nudges may be omitted',
      );
    }
    const perUnit = await Promise.all(
      unitsPage.items.map(async (unit): Promise<TimelineScheduled[]> => {
        const { items: placements } = await repos.placementsRepo.listByUnit(unit.unitId);
        const perPlacement = await Promise.all(
          placements.map(async (placement): Promise<TimelineScheduled[]> => {
            const rows = await repos.placementNudgesRepo.listByPlacement(placement.placementId);
            return nudgeItemsFor(rows, placement, 'landlord', landlordConv);
          }),
        );
        return perPlacement.flat();
      }),
    );
    return perUnit.flat();
  })();

  const [tourItems, tenantNudgeItems, landlordNudgeItems] = await Promise.all([
    tourWalk,
    tenantNudgeWalk,
    landlordNudgeWalk,
  ]);
  const upcoming = [...tourItems, ...tenantNudgeItems, ...landlordNudgeItems];
  // Ascending by dueAt (`at`) — a stable chronological order for the pinned section.
  upcoming.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return upcoming;
}

export function createContactTimelineRouter(deps: ContactTimelineRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const activityEvents = deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });

  // Scheduled-send gather repos (Part B): used ONLY when ALL are injected — we
  // deliberately do NOT default-construct them (a default would open a live
  // DynamoDB repo the in-memory unit-test app never provides). When any is
  // absent the `upcoming[]` bucket is simply `[]`.
  const scheduledRepos: ScheduledGatherRepos | undefined =
    deps.toursRepo !== undefined &&
    deps.tourRemindersRepo !== undefined &&
    deps.placementsRepo !== undefined &&
    deps.placementNudgesRepo !== undefined &&
    deps.unitsRepo !== undefined
      ? {
          toursRepo: deps.toursRepo,
          tourRemindersRepo: deps.tourRemindersRepo,
          placementsRepo: deps.placementsRepo,
          placementNudgesRepo: deps.placementNudgesRepo,
          unitsRepo: deps.unitsRepo,
        }
      : undefined;

  const router = Router();

  router.get('/:contactId/timeline', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    // 1. The contact must exist (and not be an internal phone-pointer item).
    const contact = await contacts.getById(contactId);
    if (!contact || contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    // 2. Parse kinds / cursor / limit (all validated → 400 on bad input).
    const kinds = parseKinds(req.query['kinds']);
    if (kinds === undefined) {
      res.status(400).json({ error: 'kinds must be a comma list of: message, call, milestone, scheduled' });
      return;
    }
    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }
    let boundaryKey: string | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      boundaryKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (boundaryKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }

    // 3. Resolve the contact's numbers (BE1) → the deduped set of 1:1
    // conversationIds. relay_group threads front a pool number (never the
    // contact's real phone), so they are naturally excluded — group-text
    // activity surfaces as milestones, never inlined content.
    const phones = contactPhones(contact).map((p) => p.phone);
    const convById = new Map<string, ConversationItem>();
    for (const phone of phones) {
      const linked = await conversations.findByParticipantPhone(phone);
      for (const conv of linked) {
        if (conv.type === 'relay_group') continue; // pool-number thread, not 1:1
        if (!convById.has(conv.conversationId)) convById.set(conv.conversationId, conv);
      }
    }

    const wantMessage = kinds.has('message');
    const wantCall = kinds.has('call');
    const wantMilestone = kinds.has('milestone');
    const ourNumber = ourNumberOf(config);

    // 4. Candidate gather — fetch limit+1 from EACH source, all bounded
    //    `< boundaryKey`, so the merge can decide whether more pages remain.
    //    Not-yet-sent scheduled sends are deliberately NOT gathered here (a
    //    future `dueAt` would corrupt this DESC-take-limit slice + cursor) — they
    //    are gathered into the separate first-page `upcoming[]` bucket in step 6.
    const candidates: Candidate[] = [];

    if (wantMessage || wantCall) {
      for (const conv of convById.values()) {
        const page = await messages.listByConversation(conv.conversationId, {
          limit: limit + 1,
          ...(boundaryKey !== undefined && { before: boundaryKey }),
        });
        for (const m of page) {
          if (m.type === 'call') {
            if (!wantCall) continue;
            candidates.push({ globalKey: m.tsMsgId, item: toTimelineCall(m, conv) });
          } else {
            if (!wantMessage) continue;
            candidates.push({ globalKey: m.tsMsgId, item: toTimelineMessage(m, conv, ourNumber) });
          }
        }
      }
    }

    if (wantMilestone) {
      const { items } = await activityEvents.listByContact(contactId, {
        limit: limit + 1,
        ...(boundaryKey !== undefined && { before: boundaryKey }),
      });
      for (const e of items) {
        candidates.push({ globalKey: e.tsEventId, item: toTimelineMilestone(e) });
      }

      // Landlord-only: interleave each OWNED property's LIFECYCLE audit as
      // milestone pins so staff see property events chronologically beside the
      // texts. Bounded N+1 fan-out (no scan): 1 byLandlord Query + 1 bounded
      // audit Query per unit, capped at MAX_LANDLORD_UNITS. Best-effort — a
      // failed per-unit read degrades that unit, never the whole timeline. Each
      // property candidate keys on the RAW audit SK (`r.ts`, `<ISO>#<rand>`) so
      // its merged cursor lives in the SAME lexical space as the audit `before`
      // bound below — a double-nested `${at}#${id}` would break page-2 paging.
      if (contact.type === 'landlord') {
        // Best-effort: a `listByLandlord` GSI failure (throttle/unavailable) must
        // degrade the property interleave to nothing, NEVER fail the whole timeline
        // — mirrors the scheduled-gather fallback below. PII-safe log (ids only).
        try {
          const owned = await units.listByLandlord(contactId, { limit: MAX_LANDLORD_UNITS });
          if (owned.items.length >= MAX_LANDLORD_UNITS) {
            log.warn({ contactId, count: owned.items.length }, 'landlord property fan-out capped');
          }
          for (const u of owned.items) {
            let rows: AuditEvent[];
            try {
              rows = await audit.listByEntity(`units#${u.unitId}`, {
                limit: limit + 1,
                ...(boundaryKey !== undefined && { before: boundaryKey }),
              });
            } catch (err) {
              log.error({ err, contactId, unitId: u.unitId }, 'landlord property audit read failed (best-effort)');
              continue;
            }
            for (const r of rows) {
              if (!LANDLORD_FEED_TYPES.has(r.event_type)) continue;
              const ms = unitAuditToMilestone(u.unitId, r);
              if (ms !== null && typeof r.ts === 'string') {
                candidates.push({ globalKey: r.ts, item: ms });
              }
            }
          }
        } catch (err) {
          log.error({ err, contactId }, 'landlord property interleave failed (best-effort) — timeline continues without property pins');
        }
      }
    }

    // 5. Merge: sort DESC by the global key, take the newest `limit`. If the
    //    candidate pool had MORE than `limit`, there is another (older) page →
    //    nextCursor = the last returned item's key (the next EXCLUSIVE bound).
    candidates.sort((a, b) => (a.globalKey < b.globalKey ? 1 : a.globalKey > b.globalKey ? -1 : 0));
    const page = candidates.slice(0, limit);
    const hasMore = candidates.length > limit;
    const nextCursor =
      hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.globalKey) : null;

    log.info(
      {
        contactId,
        conversationCount: convById.size,
        candidateCount: candidates.length,
        returned: page.length,
        hasMore,
      },
      'contact timeline page served',
    );

    // 6. Scheduled-send gather (Part B) — a SEPARATE first-page-only bucket. A
    //    future `dueAt` sorts newer than every message, so scheduled items must
    //    NOT enter the DESC-take-limit `candidates` slice / cursor math above.
    //    Run only on the first page (`cursor` absent) AND when the caller wants
    //    the `scheduled` kind. Failures never break the timeline — the bucket is
    //    supplementary, so a gather error logs + falls back to `[]`.
    let upcoming: TimelineScheduled[] = [];
    if (boundaryKey === undefined && kinds.has('scheduled') && scheduledRepos !== undefined) {
      try {
        upcoming = await gatherUpcoming({
          contact,
          config,
          conversationsRepo: conversations,
          repos: scheduledRepos,
          log,
        });
      } catch (err) {
        log.error({ err, contactId }, 'contact timeline: scheduled gather failed — returning empty upcoming');
        upcoming = [];
      }
    }

    // 7. Respond ASCENDING (oldest→newest) per C2: reverse the descending page
    //    for the wire. nextCursor was derived above from the descending slice's
    //    LAST element (the OLDEST returned item) BEFORE this reverse, so the
    //    cursor still pages backward in time (older) with no dups/skips.
    res.json({ items: page.map((c) => c.item).reverse(), nextCursor, upcoming });
  });

  return router;
}
