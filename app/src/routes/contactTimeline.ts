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
import { createUnitsRepo, type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';
import type { Address } from '../lib/address.js';
import {
  assessNamesReadFailure,
  composeTourReminderBody,
  UncomposableReminderError,
  type TourContactNames,
} from '../messages/tourCopy.js';
import { resolveTourContactNames, type ResolvedTourNames } from '../lib/tourContacts.js';
import {
  flushComposeFailTally,
  newComposeFailTally,
  recordComposeFail,
  type ComposeFailTally,
} from '../lib/composeFailTally.js';
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import { conversationsForContact } from '../lib/contactThreads.js';
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
  type CallStatus,
  type DeliveryStatus,
  type RelayRecipientDelivery,
} from '../repos/messagesRepo.js';
import type { PlacementStage } from '../lib/statusModel.js';
import type { MessageTransport } from '../lib/messageTransport.js';
import { LISTING_STATUS_LABELS } from '../lib/statusModel.js';
import {
  resolveUsableGroup,
  DISCONTINUED_REMINDER_KINDS,
  MANUAL_ONLY_REMINDER_KINDS,
  type RunDueTourRemindersDeps,
} from '../jobs/tourReminders.js';
import { MANUAL_ONLY_NUDGE_KINDS, NUDGE_RUNGS } from '../jobs/placementNudges.js';
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
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import { readQuietHoursWindow } from '../jobs/tourReminders.js';
import { isQuietTime } from '../lib/quietHours.js';
import { isSupersededRung } from '../lib/ladderPointer.js';

export interface ContactTimelineRouterDeps {
  logger?: Logger;
  config?: AppConfig;
  /** Quiet-hours window source for the `upcoming[]` suppression preview - it
   *  covers BOTH ladders here (narrow read-only shape, the
   *  `resolveWithSettings` precedent). */
  settingsRepo?: Pick<SettingsRepo, 'getOrgSettings'>;
  /**
   * Reminder kinds the POLL holds back, mirrored onto this surface's tour rungs
   * so a rung the poll will never claim chips `paused` here too. Defaults to
   * MANUAL_ONLY_REMINDER_KINDS, which is EMPTY today (2026-08-31, Phase B), so
   * this is now the seam a suite uses to INJECT pause-mode behaviour that
   * production no longer exhibits by default - see the twin on
   * routes/tourReminders.ts. Never a route for DISCONTINUED_REMINDER_KINDS,
   * which is permanent and not injectable anywhere.
   */
  manualOnlyReminderKinds?: ReadonlySet<ReminderKind>;
  /** As above, for the placement-nudge ladder. Defaults to
   *  MANUAL_ONLY_NUDGE_KINDS. */
  manualOnlyNudgeKinds?: ReadonlySet<NudgeKind>;
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
  type: 'sms' | 'mms' | 'email';
  transport_schema_version?: 1;
  requested_transport?: MessageTransport;
  actual_transport?: MessageTransport;
  body?: string;
  media_attachments?: MediaAttachment[];
  delivery_status: DeliveryStatus;
  error_code?: string;
  /** tsMsgId of the FAILED message a retry supersedes — the client hides the
   *  superseded predecessor so a delivered retry replaces the stale bubble. */
  retry_of?: string;
  fromPhone?: string;
  toPhone?: string;
  // --- Email channel v1 (type:'email' items) -----------------------------------
  /** Email subject line. */
  subject?: string;
  /** RFC From address. */
  email_from?: string;
  /** RFC To addresses. */
  email_to?: string[];
  /** RFC Cc addresses. */
  email_cc?: string[];
  /** Inbound reply arrived from an address not yet on the contact (B2 sets it;
   *  the field is declared now so the wire type is stable - the client renders a
   *  "New address" chip). Absent on outbound + known-address inbound. */
  email_new_address?: boolean;
  /** Sanitized inbound HTML body (B2 stores it; B7 renders it in a sandboxed,
   *  CSP-framed iframe behind "View original formatting"). Absent on outbound +
   *  plain-text inbound. */
  email_html_sanitized?: string;
  /** Relay group (M1.7): per-recipient delivery slots on a relay SOURCE message.
   *  Surfaces the "N member(s) opted out" note. (relay_group threads are
   *  excluded from THIS server timeline today, so this is carried for
   *  completeness + future-proofing; the client fallback is the live path.) */
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
  /** Relay number lifecycle: on a 1:1 bubble that was a late text intercepted
   *  from a CLOSED relay group, the closed group's conversationId - the client
   *  renders a "via the closed group chat" provenance badge. Absent otherwise. */
  via_closed_group?: string;
  /** This row is pre-go-live history carried in by the importer, not something we
   *  sent. Present ONLY when true. The client suppresses the age-derived
   *  "Sent - not confirmed" cue on it: the importer writes `sent` because the
   *  export has no per-message receipts, so there was never a receipt to miss. */
  imported?: boolean;
}
interface TimelineCall extends TimelineBase {
  kind: 'call';
  conversationId?: string;
  /** Who placed the call. REQUIRED - every stored call row carries it, and the
   *  card renders the side/arrow from it (no backfill needed). */
  direction: MessageDirection;
  /** Twilio call lifecycle. ABSENT on imported rows (the importer writes no
   *  status) and on any row whose stored value is not a union member. */
  call_status?: CallStatus;
  /** Coarse human-facing outcome. OPTIONAL: absent means "no terminal outcome is
   *  known", which the client renders honestly (no chip / a status-derived
   *  label). The server no longer invents 'missed' for a row that has none. */
  call_outcome?: CallOutcome;
  call_duration?: number;
  party_phone?: string;
  recording_s3_key?: string;
  transcript?: string;
  /** Transcript lifecycle (voice-transcription 3.7): drives the "Transcribing..."
   *  / "Transcript unavailable" indicator. ABSENT = no transcript will be
   *  requested (masked, VI unconfigured, pre-feature). Never on masked calls. */
  transcript_status?: 'pending' | 'completed' | 'failed';
  /** The BARE CallSid (== provider_sid) - NOT `id` (the composite tsMsgId). The
   *  audio player points GET /api/calls/:callId/recording at this; `id` would
   *  404 there. Never on masked calls (masked calls carry no recording). */
  call_sid?: string;
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
 *
 * The tour_* types are DELIBERATELY absent (contact-comms-pane, 2026-08-03): a
 * landlord's own activity feed now carries every tour lifecycle event directly
 * (dual-party writes in routes/tours.ts), so interleaving the property-audit
 * copy too would pin the same tour twice. What stays here is exactly what has
 * NO direct-event equivalent.
 *
 * Two consequences, both accepted. PERMANENT: landlord tour pins are now
 * point-in-time. This interleave walks the CURRENT owner's units, so while it
 * carried tours, re-assigning `unit.landlordId` handed that unit's whole tour
 * history to the new owner and took it off the old one's page. Direct
 * dual-party events do not move: the landlord who owned the unit at event time
 * keeps those pins forever, and the new owner's contact page shows no tour that
 * happened before the re-assignment (see lib/personEvents.ts for the same rule
 * on the write side). ONE-TIME: tours recorded BEFORE that change exist only as
 * audit rows and no longer show on a landlord's page (dev-only history,
 * regenerated on reseed).
 */
const LANDLORD_FEED_TYPES: ReadonlySet<string> = new Set([
  'broadcast_sent',
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
 * the configured BUSINESS_PHONE_NUMBER (the dashboard sends/receives on
 * it). Absent when unconfigured (tests/local) → those fields are simply omitted.
 */
function ourNumberOf(config: AppConfig): string | undefined {
  return config.businessPhoneNumber;
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
  // Email channel v1: an email item carries NO phones (subject + addresses
  // instead). The contact's OWN number on a phone thread (participant_phone) +
  // our org number are the ONLY phones we expose - never another counterpart.
  const isEmail = m.type === 'email';
  const contactPhone = conversation?.participant_phone;
  const fromPhone = isEmail ? undefined : m.direction === 'inbound' ? contactPhone : ourNumber;
  const toPhone = isEmail ? undefined : m.direction === 'inbound' ? ourNumber : contactPhone;
  const media = mediaAttachmentsOf(m);
  const type: 'sms' | 'mms' | 'email' = isEmail ? 'email' : m.type === 'mms' ? 'mms' : 'sms';
  return {
    kind: 'message',
    id: m.tsMsgId,
    at: atOf(m.tsMsgId, m.provider_ts),
    conversationId: m.conversationId,
    tsMsgId: m.tsMsgId,
    direction: m.direction,
    author: m.author,
    type,
    ...(!isEmail && m.transport_schema_version !== undefined && {
      transport_schema_version: m.transport_schema_version,
    }),
    ...(!isEmail && m.requested_transport !== undefined && {
      requested_transport: m.requested_transport,
    }),
    ...(!isEmail && m.actual_transport !== undefined && {
      actual_transport: m.actual_transport,
    }),
    ...(m.body !== undefined && { body: m.body }),
    ...(media.length > 0 && { media_attachments: media }),
    delivery_status: m.delivery_status,
    ...(m.error_code !== undefined && { error_code: m.error_code }),
    ...(m.retry_of !== undefined && { retry_of: m.retry_of }),
    ...(m.delivery_recipients !== undefined && { delivery_recipients: m.delivery_recipients }),
    ...(typeof m.via_closed_group === 'string' && { via_closed_group: m.via_closed_group }),
    // `imported_from` is an undeclared rider the importer PUTs on the item
    // (lib/import/apply.ts), same as `call_duration_seconds` above - hence the
    // bracket read. Projected as a bare boolean: the client needs only "did we
    // send this", never which export it came from.
    ...(typeof m['imported_from'] === 'string' && { imported: true }),
    ...(fromPhone !== undefined && { fromPhone }),
    ...(toPhone !== undefined && { toPhone }),
    // Email channel v1: subject + addresses + sanitized HTML (body is the trimmed
    // text; B7's EmailHtmlFrame renders email_html_sanitized in a sandboxed iframe).
    ...(isEmail && typeof m.subject === 'string' && { subject: m.subject }),
    ...(isEmail && typeof m.email_from === 'string' && { email_from: m.email_from }),
    ...(isEmail && Array.isArray(m.email_to) && { email_to: m.email_to }),
    ...(isEmail && Array.isArray(m.email_cc) && { email_cc: m.email_cc }),
    ...(isEmail && m.email_new_address === true && { email_new_address: true }),
    ...(isEmail &&
      typeof m.email_html_sanitized === 'string' && {
        email_html_sanitized: m.email_html_sanitized,
      }),
  };
}

/** CallStatus membership, deliberately duplicated from inbox.ts's private copy:
 *  the normalization for this projection has ONE home here, and promoting the
 *  inbox's guards would touch a surface this mission scopes out. The
 *  `satisfies Record<CallStatus, true>` form keeps the copy honest if the union
 *  grows - a hand-written array would silently drift. */
const CALL_STATUS_MAP = {
  ringing: true,
  'in-progress': true,
  completed: true,
  'no-answer': true,
  busy: true,
  failed: true,
  canceled: true,
} satisfies Record<CallStatus, true>;
function isCallStatus(v: unknown): v is CallStatus {
  return typeof v === 'string' && Object.hasOwn(CALL_STATUS_MAP, v);
}

/** MessageDirection membership, same deliberate duplication as CALL_STATUS_MAP. */
const CALL_DIRECTION_MAP = {
  inbound: true,
  outbound: true,
} satisfies Record<MessageDirection, true>;
function isMessageDirection(v: unknown): v is MessageDirection {
  return typeof v === 'string' && Object.hasOwn(CALL_DIRECTION_MAP, v);
}

/** CallOutcome membership, same deliberate duplication as CALL_STATUS_MAP above. */
const CALL_OUTCOME_MAP = {
  answered: true,
  missed: true,
  voicemail: true,
} satisfies Record<CallOutcome, true>;
function isCallOutcome(v: unknown): v is CallOutcome {
  return typeof v === 'string' && Object.hasOwn(CALL_OUTCOME_MAP, v);
}

/** The Quo importer writes two OUT-OF-UNION outcome strings straight through
 *  `messageBatch.put` (`lib/import/apply.ts`), bypassing the typed `append`:
 *  `no_answer` and `completed`. They mean the same two things our union spells
 *  differently, so map them FIRST and membership-test AFTER. */
const IMPORTED_CALL_OUTCOME: Record<string, CallOutcome> = {
  no_answer: 'missed',
  completed: 'answered',
};

/**
 * A stored outcome -> the wire outcome, or undefined. Order matters: normalize
 * the importer's two strings, THEN test membership. Anything still unrecognized
 * is DROPPED rather than cast through `as CallOutcome` - a call with a direction
 * and a time and no chip is honest, and better than a confidently wrong one.
 */
function normalizeCallOutcome(v: unknown): CallOutcome | undefined {
  if (typeof v !== 'string') return undefined;
  const mapped = IMPORTED_CALL_OUTCOME[v] ?? v;
  return isCallOutcome(mapped) ? mapped : undefined;
}

/**
 * Connected duration in seconds. Native rows carry `call_duration`; IMPORTED
 * rows carry `call_duration_seconds`, which is not a declared MessageItem field
 * at all - it is reachable only through the interface's index signature, so it
 * needs an explicit runtime narrow rather than a property read.
 *
 * A NON-POSITIVE duration is treated as ABSENT, on BOTH fields. The importer
 * derives its outcome FROM the duration (`lib/import/apply.ts`), so every
 * imported MISS carries a literal `0` alongside `no_answer`; projecting that
 * renders "Missed - 0s", because `formatDuration(0)` returns the truthy string
 * "0s". The NATIVE path reaches it too: voice.ts /status emits `callDuration`
 * whenever the mapped Dial summary is `completed`, so a `DialCallDuration` of
 * '0' parses to 0 and IS stored on a completed outbound call. This drop is
 * therefore a READ-SIDE normalization the write side does NOT share - not an
 * agreement with it. The INBOX still renders such a row as "Outgoing call - 0s";
 * that divergence is recorded in
 * docs/issues/inbox-imported-call-outcome-normalization.md.
 */
function callDurationOf(m: MessageItem): number | undefined {
  if (typeof m.call_duration === 'number') return m.call_duration > 0 ? m.call_duration : undefined;
  const imported = m['call_duration_seconds'];
  return typeof imported === 'number' && imported > 0 ? imported : undefined;
}

/**
 * PER-REQUEST tally of call rows whose stored `direction` is out of union,
 * flushed as ONE warn by the route (see reportDirectionAnomalies).
 *
 * The condition is a PERMANENT property of a stored row, and this surface
 * refetches on every message.persisted / conversation.updated /
 * scheduled.updated (debounced 300ms) - so a per-row warn turns one corrupt row
 * on a busy thread into a sustained WARN stream for as long as anyone leaves
 * that contact open. Count + one example instead, the shape the orphan-logs
 * work established for its per-poll-tick rollup.
 */
interface DirectionAnomalies {
  count: number;
  exampleConversationId?: string;
  exampleTsMsgId?: string;
}

/** One warn per REQUEST, or none at all. IDs + a count only - never a phone. */
function reportDirectionAnomalies(anomalies: DirectionAnomalies, log: Logger): void {
  if (anomalies.count === 0) return;
  log.warn(
    {
      count: anomalies.count,
      ...(anomalies.exampleConversationId !== undefined && {
        exampleConversationId: anomalies.exampleConversationId,
      }),
      ...(anomalies.exampleTsMsgId !== undefined && { exampleTsMsgId: anomalies.exampleTsMsgId }),
    },
    'contact timeline: call rows have an out-of-union direction - emitting the stored values unchanged',
  );
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
  anomalies: DirectionAnomalies,
): TimelineCall {
  const masked = m.masked === true;
  // OBSERVABILITY ONLY - do NOT "tidy" this into a drop or a default.
  // `direction` is REQUIRED on the wire, so omitting it would type-check clean
  // and fail only in the browser (the required-key mirror test exists for
  // exactly that failure mode), and substituting a default would INVENT the
  // very data this feature exists to stop inventing. The client's check is
  // `=== 'outbound'`, so a bad or absent stored value silently renders
  // "Incoming call". Narrowing here changes NOTHING about what is emitted; it
  // only makes the silent case visible. TALLIED, not logged per row - see
  // DirectionAnomalies. IDs only - never a phone.
  if (!isMessageDirection(m.direction)) {
    anomalies.count += 1;
    anomalies.exampleConversationId ??= m.conversationId;
    anomalies.exampleTsMsgId ??= m.tsMsgId;
  }
  // at == sort-key == cursor: all provider_ts. The merge/sort + cursor use
  // globalKey = m.tsMsgId (`<provider_ts>#<sid>`) and messagesRepo paginates on
  // tsMsgId, so the displayed `at` MUST be provider_ts (which append always sets)
  // to stay consistent with what the server sorts/paginates by — same as
  // TimelineMessage. (started_at is the call's first-seen time, not a sort key.)
  const partyPhone = masked ? undefined : conversation?.participant_phone;
  const callOutcome = normalizeCallOutcome(m.call_outcome);
  const callDuration = callDurationOf(m);
  return {
    kind: 'call',
    id: m.tsMsgId,
    at: atOf(m.tsMsgId, m.provider_ts),
    ...(m.conversationId !== undefined && { conversationId: m.conversationId }),
    // Direction + lifecycle status are METADATA, not content: they are emitted
    // for masked rows too (I4 strips content, and is untouched here). An
    // unrecognized stored status is dropped rather than cast onto the wire.
    direction: m.direction,
    ...(isCallStatus(m.call_status) && { call_status: m.call_status }),
    // call_outcome is OPTIONAL on the wire and there is NO default. A row with
    // no recorded outcome (a ringing metadata row, or a D12 gate-refusal stamp)
    // emits none, and the client derives an honest label from call_status
    // instead of reading a server-invented "Missed".
    ...(callOutcome !== undefined && { call_outcome: callOutcome }),
    ...(callDuration !== undefined && { call_duration: callDuration }),
    ...(partyPhone !== undefined && { party_phone: partyPhone }),
    // Masked calls are NEVER recorded/transcribed — never expose these.
    ...(!masked && typeof m.recording_s3_key === 'string' && { recording_s3_key: m.recording_s3_key }),
    ...(!masked && typeof m.transcript === 'string' && { transcript: m.transcript }),
    ...(!masked && m.transcript_status !== undefined && { transcript_status: m.transcript_status }),
    // The bare CallSid for the recording endpoint (D2): `id` is the composite
    // tsMsgId, which would 404 at GET /api/calls/:callId/recording.
    ...(!masked && typeof m.provider_sid === 'string' && { call_sid: m.provider_sid }),
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
 * Map ONE owned-unit audit row → a `TimelineMilestone` for the landlord's
 * timeline, or `null` when the row is not a surfaced lifecycle type. The milestone
 * `type` REUSES an existing `ActivityEventType` (colour/link only); the `label`
 * carries the human wording; `refType`/`refId` deep-link out (broadcast → the
 * broadcast, else the property/unit). PII-safe: labels/ids only,
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
        // A UNIT-CONTACT event borrowing the add/remove MILESTONE KIND - not a
        // group text and not a relay group. The kind is a display bucket here
        // (the dashboard switches a colour on it, Timeline.tsx); the label and
        // `refType: 'unit'` below carry the real meaning. Named before the
        // native `group_text` conversation type existed and deliberately NOT
        // renamed - these strings are persisted on historical rows, so a rename
        // is a data migration (adjudication on ActivityEventType).
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
 * One tour-reminder rung's preview body, composed exactly the way the send path
 * composes it (the shared composer is the only source of this string).
 *
 * READ-PATH CONTAINMENT (spec F1): a tour with no usable scheduledAt makes the
 * body uncomposable. An uncontained throw here does NOT 500 - it lands in the
 * gather's own catch and EMPTIES the whole `upcoming` bucket, silently taking
 * every other tour AND both nudge walks with it. So one bad rung degrades to
 * `body: ''` and the bucket survives.
 *
 * A SENT rung renders its claim-time snapshot; today this walk filters sent
 * rungs out entirely, so the branch is a guard for future callers, not dead
 * weight - the shape is identical on every preview surface.
 */
// DUPLICATED SHAPE (3 copies, keep in sync) - twins in routes/tourReminders.ts
// (bodyFor) and routes/relayGroups.ts (the scheduled-bucket map). See the note
// on bodyFor for why they are deliberately not consolidated. TWO `body: ''`
// rules now live in each copy: the entry-fork WITHHOLD below and the
// UncomposableReminderError containment under it - change either one here and
// change it in all three.
//
// THE THREE COPIES DIFFER IN BRANCH ORDER: relayGroups has NO sentBody
// snapshot branch (its bucket is pending-only), so its withhold check is
// unconditionally first; here and on the reminders route the snapshot renders
// above both.
//
// NAME RESOLUTION IS HOISTED TO THE CALLER on all three copies (spec 6.3a):
// the composer is synchronous, so the names arrive already resolved - here
// from namesOnce, memoized per unitId inside gatherUpcoming, which carries the
// three failure flags with them.
function tourReminderBodyOrEmpty(
  row: TourReminderItem,
  tour: TourItem,
  timezone: string,
  address: Address | string | undefined,
  names: TourContactNames,
  flags: {
    tenantReadFailed: boolean;
    propertyReadFailed: boolean;
    unitReadFailed: boolean;
  },
  tally: ComposeFailTally,
): string {
  if (row.sentAt !== undefined && typeof row.sentBody === 'string') return row.sentBody;
  // Spec 6.3a "never a different ENTRY": a failed read that would change WHICH
  // ENTRY composes renders NO body rather than a wrong one. A failure that
  // merely blanks a token does NOT withhold - per 6.3b the preview degrades to
  // the absence fallbacks while the SEND side waits. No warn: the resolver and
  // unitOnce already logged the underlying failure once per request.
  if (
    assessNamesReadFailure({
      kind: row.kind,
      tourType: tour.tourType,
      tenantReadFailed: flags.tenantReadFailed,
      propertyReadFailed: flags.propertyReadFailed,
      unitReadFailed: flags.unitReadFailed,
    }).withholdPreview
  ) {
    return '';
  }
  try {
    return composeTourReminderBody({
      kind: row.kind,
      scheduledAt: tour.scheduledAt ?? '',
      timezone,
      tourType: tour.tourType,
      names,
      ...(address !== undefined && { address }),
    });
  } catch (err) {
    if (err instanceof UncomposableReminderError) {
      // RECORD, do not warn: this runs per rung inside a per-tour walk, and the
      // timeline is refetched on every SSE burst. The caller flushes ONE warn.
      recordComposeFail(tally, row, tour);
      return '';
    }
    throw err;
  }
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
  /** The PROPERTY contact behind {propertyContactFirstName} in landlord-led
   *  reminder copy (spec 6.3a). Threaded the same way conversationsRepo is -
   *  the gather's repo bundle is the FIVE scheduled-walk repos and this is not
   *  one of them. The TENANT costs no read here: it IS `contact`. */
  contactsRepo: Pick<ContactsRepo, 'getById'>;
  repos: ScheduledGatherRepos;
  /** Will quiet hours hold a rung due at `dueAt`? The caller builds it once per
   *  request from the org window + the wall clock (this gather stays
   *  clock-free); see routes/tourReminders.ts for the formula's rationale. */
  quietFor: (dueAt: string) => boolean;
  /** The ORG's composing zone (window.timezone), read once by the caller. Tour
   *  reminder copy renders the tour time in it - never a raw settings.timezone
   *  (spec D8). */
  timezone: string;
  /** Reminder kinds held back from automatic sending (the manual-only pause). */
  manualOnlyReminderKinds: ReadonlySet<ReminderKind>;
  /** Nudge kinds held back from automatic sending (the OTHER manual-only pause,
   *  2026-08-18 - an independent list on an independent ladder). */
  manualOnlyNudgeKinds: ReadonlySet<NudgeKind>;
  log: Logger;
}): Promise<TimelineScheduled[]> {
  const {
    contact,
    config,
    conversationsRepo,
    contactsRepo,
    repos,
    quietFor,
    timezone,
    manualOnlyReminderKinds,
    manualOnlyNudgeKinds,
    log,
  } = params;
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

  /**
   * Preview suppression against a 1:1 thread (+ optional nudge stale-stage).
   *
   * `quietExempt` is a PRE-COMPUTED boolean the caller supplies; this helper
   * stays kind-blind on purpose. It is SHARED with the placement-nudge walk
   * below, and `quietFor` is shared more widely still, so the en_route
   * exemption (Phase B spec 6) must be decided at the reminder call site: a
   * kind test in here would strip quiet suppression from placement nudges too.
   * Only the QUIET operand is forced - every other reason still evaluates.
   */
  const suppressionFor = (
    conv: ConversationItem | undefined,
    staleStage: boolean,
    dueAt: string,
    paused = false,
    quietExempt = false,
  ): ScheduledSuppression | undefined =>
    evaluateScheduledSendSuppression({
      smsSendingEnabled: config.smsSendingEnabled,
      convOptOut: conv?.sms_opt_out,
      contactOptOut,
      aiMode: conv?.ai_mode,
      staleStage,
      paused,
      // Quiet hours (spec 2026-08-03): the timeline is the THIRD evaluator
      // caller, so a deferred rung reads the same here as on the tour /
      // placement panels - including the per-RUNG scoping.
      quietNow: !quietExempt && quietFor(dueAt),
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
      // Manual-only hold-back on the OTHER ladder (2026-08-18): same reasoning
      // as the tour walk below - a rung the poll will never claim must not
      // advertise a fire time here. Derived from the nudge kinds, which are
      // independent of the tour hold-back.
      const suppression = suppressionFor(
        conv,
        placement.stage !== info.stage,
        row.dueAt,
        manualOnlyNudgeKinds.has(row.kind),
      );
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

  // One unit read PER UNIT (not per tour): a contact with several tours at the
  // same property must not pay for the same address twice on a page load. The
  // promise is memoized, so parallel walkers share the single in-flight read.
  // The memo carries the FAILURE distinctly (spec 6.3a): swallowing a failed
  // read into `undefined` collapses failure into absence, and a failed read
  // feeding name resolution would compose the SELF-GUIDED entry for a
  // landlord-led tour - a preview disagreeing with the send. Task 5 consumes
  // `failed` through namesOnce; Task 4 only carries it.
  interface UnitRead {
    unit: UnitItem | undefined;
    failed: boolean;
  }
  const unitReads = new Map<string, Promise<UnitRead>>();
  const unitOnce = (unitId: string): Promise<UnitRead> => {
    let pending = unitReads.get(unitId);
    if (pending === undefined) {
      pending = repos.unitsRepo
        .getById(unitId)
        .then((unit): UnitRead => ({ unit, failed: false }))
        .catch((err: unknown): UnitRead => {
          log.warn({ err, unitId }, 'contact timeline: unit read failed - composing without an address');
          return { unit: undefined, failed: true };
        });
      unitReads.set(unitId, pending);
    }
    return pending;
  };

  // The two NAMES behind this unit's reminder copy, memoized per UNIT (spec
  // 6.3a): the property contact varies per tour, so one per-request value
  // would stamp one name onto every row. The TENANT is constant for this
  // request - it IS the contact whose timeline this is, already in hand, so it
  // costs zero reads.
  //
  // KEYED BY unitId ONLY, while assessNamesReadFailure also takes a
  // tourType and this walk admits tours of DIFFERENT types at the SAME unit.
  // Safe because the RESOLVER does not branch on tour type - only the flags
  // and the names are memoized here, and the assessor is called per TOUR. A
  // future resolver that does branch on tour type must key this map on the
  // pair, or two tours at one property will cross-contaminate.
  type UnitNames = ResolvedTourNames & { unitReadFailed: boolean };
  const nameReads = new Map<string, Promise<UnitNames>>();
  const namesOnce = (unitId: string): Promise<UnitNames> => {
    let pending = nameReads.get(unitId);
    if (pending === undefined) {
      pending = unitOnce(unitId).then((read) =>
        resolveTourContactNames({
          tenantId: contactId,
          unit: read.unit,
          tenantContact: contact,
          contactsRepo,
          logger: log,
        }).then((r): UnitNames => ({ ...r, unitReadFailed: read.failed })),
      );
      nameReads.set(unitId, pending);
    }
    return pending;
  };

  // Walk 1 — tenant tours → 1:1-routed tour reminders.
  const composeFails = newComposeFailTally();
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
          // structural view is all it needs (cast documented). unitsRepo is
          // listed BY HAND because the cast swallows every required field: the
          // compiler cannot tell us when RunDueTourRemindersDeps grows one.
          const groupDeps = {
            conversationsRepo,
            unitsRepo: repos.unitsRepo,
          } as unknown as RunDueTourRemindersDeps;
          const group = await resolveUsableGroup(tour, upcomingRows[0]!, groupDeps, log);
          routes1to1 = group === undefined;
        }
        if (!routes1to1) return [];
        const read = await unitOnce(tour.unitId);
        const address = read.unit?.address;
        // `read.failed` is the same boolean as the memo's `unitReadFailed` -
        // take the MEMO's, so the assessor sees exactly one source.
        const { names, ...nameFlags } = await namesOnce(tour.unitId);
        return upcomingRows.map((row: TourReminderItem): TimelineScheduled => {
          // The manual-only hold-back rides the shared evaluator here too, so a
          // rung the poll will never pick up cannot chip "sends in 3h" on the
          // contact page while the tour panel calls it paused. Only the
          // 1:1-routed tours reach this walk (group-routed ones return [] just
          // above), so the evaluator always runs - no bare-`paused` fallback is
          // needed on this surface.
          //
          // A DISCONTINUED kind short-circuits AHEAD of the evaluator (spec
          // 3.1a): it is terminal and outranks every reason the ladder ranks -
          // including the opt-out - because a rung nothing will ever send is not
          // something a harder reason should override. This surface has its OWN
          // read of the set rather than inheriting the tour panel's answer, and
          // that is the point: without it the contact page would keep promising
          // "sends in 3h" on a rung the panel one click away calls retired.
          //
          // en_route is EXEMPT FROM QUIET HOURS (spec 6): the poll neither
          // clamps it at arm time nor defers it at fire time, so this surface
          // must not chip "Will wait" on it either. The exemption is passed IN
          // rather than decided inside suppressionFor / quietFor, which the
          // placement-nudge walk above shares.
          //
          // SUPERSEDED short-circuits AHEAD of both (spec 3.3, S6 T6.2). The
          // tour is already in hand from the walk above, so the pointer compare
          // costs no read, and it outranks the kind-level fact because it is a
          // fact about THIS row's storage: a rung of a ladder the tour has
          // replaced is one both send paths already refuse. This surface is the
          // furthest from the tour - a navigator reading a contact page has no
          // way to know the tour was rescheduled - and `listDue` only picks a
          // row up at `dueAt <= now`, so the "sends in 3h" promise would stand
          // for days. The compare is the SHARED one (lib/ladderPointer.ts), the
          // same function the poll and the other two surfaces call, including
          // its pre-migration exemption: a legacy rung on a pointerless tour is
          // NOT superseded, or this line would retire every rung armed before
          // the feature on its first read.
          //
          // CONVERSION IN FLIGHT short-circuits next (review round NEW-3), and
          // it is the same tour this walk already holds - no extra read. While
          // the `pending:` sentinel stands the poll defers every rung of this
          // tour and Send now answers 409, so a live "sends in 3h" here would be
          // a promise both send paths refuse. BELOW the two TERMINAL reasons
          // above (this one resolves) and ABOVE the recipient-state estimate
          // (the claim is what gates the next tick). The PREFIX is the
          // predicate: the finalize writes a real placementId to the same field.
          const suppression = isSupersededRung(row, tour)
            ? ({ reason: 'superseded' } as const)
            : DISCONTINUED_REMINDER_KINDS.has(row.kind)
              ? ({ reason: 'discontinued' } as const)
              : typeof tour.convertedPlacementId === 'string' &&
                  tour.convertedPlacementId.startsWith('pending:')
                ? ({ reason: 'conversion_in_progress' } as const)
                : suppressionFor(
                  tenantConv,
                  false,
                  row.dueAt,
                  manualOnlyReminderKinds.has(row.kind),
                  row.kind === 'en_route',
                );
          return {
            kind: 'scheduled',
            id: `sched#tour_reminder#${row.reminderId}`,
            at: row.dueAt,
            source: 'tour_reminder',
            reminderKind: row.kind,
            body: tourReminderBodyOrEmpty(
              row,
              tour,
              timezone,
              address,
              names,
              nameFlags,
              composeFails,
            ),
            ...(tenantConv !== undefined && { conversationId: tenantConv.conversationId }),
            ...(suppression !== undefined && { suppression }),
            refType: 'tour',
            refId: tour.tourId,
          };
        });
      }),
    );
    flushComposeFailTally(composeFails, log, 'contact_timeline_upcoming');
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
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const manualOnlyReminderKinds = deps.manualOnlyReminderKinds ?? MANUAL_ONLY_REMINDER_KINDS;
  const manualOnlyNudgeKinds = deps.manualOnlyNudgeKinds ?? MANUAL_ONLY_NUDGE_KINDS;

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

    // 3. Resolve the contact's threads (BE1) -> the deduped set of 1:1
    // conversationIds. Email channel v1 (invariant rule): resolve across BOTH
    // their phone numbers AND email addresses, so an email-only thread's
    // messages appear in the merged timeline. relay_group threads front a pool
    // number (never the contact's real phone/email), so they are excluded -
    // relay-group activity surfaces as milestones, never inlined content.
    const convById = new Map<string, ConversationItem>();
    for (const conv of await conversationsForContact(contact, conversations)) {
      // Multi-party threads are excluded by NAME, never by "not relay_group"
      // (invariant 13.6). A native group_text carries no participant_phone or
      // participant_email, so conversationsForContact cannot return one today -
      // the explicit case keeps that true if it ever can.
      if (conv.type === 'relay_group' || conv.type === 'group_text') continue;
      convById.set(conv.conversationId, conv);
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

    // Tallied across every thread in THIS request, then flushed once below.
    const directionAnomalies: DirectionAnomalies = { count: 0 };
    if (wantMessage || wantCall) {
      for (const conv of convById.values()) {
        const page = await messages.listByConversation(conv.conversationId, {
          limit: limit + 1,
          ...(boundaryKey !== undefined && { before: boundaryKey }),
        });
        for (const m of page) {
          if (m.type === 'call') {
            if (!wantCall) continue;
            candidates.push({
              globalKey: m.tsMsgId,
              item: toTimelineCall(m, conv, directionAnomalies),
            });
          } else {
            if (!wantMessage) continue;
            candidates.push({ globalKey: m.tsMsgId, item: toTimelineMessage(m, conv, ourNumber) });
          }
        }
      }
      reportDirectionAnomalies(directionAnomalies, log);
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
    // The COMPOSING ZONE of the gathered bodies, emitted only when we gathered.
    let timezone: string | undefined;
    if (boundaryKey === undefined && kinds.has('scheduled') && scheduledRepos !== undefined) {
      // The org window is read under the SAME condition as the gather - this is
      // one of the hottest read paths in the dashboard (the contact page and both
      // 1:1 comms tabs refetch it on every debounced SSE burst), and a cursor
      // page, a kinds filter without `scheduled`, or a deployment without the
      // scheduled repos gathers nothing, so it must not pay a settings GetItem
      // for a zone describing an always-empty bucket.
      // It stays ABOVE the try/catch: a gather FAILURE falls back to an empty
      // bucket but must not lose the zone. readQuietHoursWindow never throws - a
      // settings failure falls back to the defaults.
      const window = await readQuietHoursWindow(settings, log);
      timezone = window.timezone;
      try {
        // Quiet hours (spec 2026-08-03): evaluated PER ROW - the rung's own
        // dueAt falls inside an occurrence of the daily-recurring window, or it
        // is already due while the window is running. Full rationale at the same
        // call site in routes/tourReminders.ts; the tour-reminder and
        // placement-nudge panels use the same formula.
        const nowIso = new Date().toISOString();
        const wallClockQuiet = isQuietTime(nowIso, window);
        upcoming = await gatherUpcoming({
          contact,
          config,
          conversationsRepo: conversations,
          contactsRepo: contacts,
          repos: scheduledRepos,
          quietFor: (dueAt: string) =>
            (dueAt > nowIso && isQuietTime(dueAt, window)) || (wallClockQuiet && dueAt <= nowIso),
          timezone: window.timezone,
          manualOnlyReminderKinds,
          manualOnlyNudgeKinds,
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
    // `timezone` is the zone the `upcoming` BODIES were composed in (spec D8),
    // so the client can render each card's fire time in the same zone the body
    // quotes instead of the navigator's browser zone. Present exactly when the
    // gather ran (including when it FAILED into an empty bucket) - a response
    // that can carry no scheduled item at all describes no zone. The dashboard
    // type is `timezone?` and every consumer falls back to the browser zone.
    res.json({
      items: page.map((c) => c.item).reverse(),
      nextCursor,
      upcoming,
      ...(timezone !== undefined && { timezone }),
    });
  });

  return router;
}
