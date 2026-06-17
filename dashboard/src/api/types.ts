// API entity types — the dashboard's view of the wire shapes it exchanges with
// the backend (/api, /auth). Mirrors the server contract exactly. This file
// starts with the auth shapes (B0.3); page phases extend it with the legacy
// reuse + the §API Contract types (C1–C7) from the build plan.

/** Team role. admin = the founder role; va = virtual assistant. */
export type UserRole = 'admin' | 'va';

/** GET /auth/me — the authenticated principal (returned unwrapped, not under a key). */
export interface Me {
  userId: string;
  email: string;
  role: UserRole;
}

/** POST /auth/dev-login — the seeded dev principal (hermetic-LOCAL only). */
export interface DevLoginResult {
  userId: string;
  email: string;
  role: UserRole;
}

// --- Today action queue (§API Contract C7) ----------------------------------
// The prioritized "what needs the navigator now" queue. The backend serves it at
// GET /api/today (TodayResponse); the B1 frontend assembles the SAME shape
// client-side from /api/cases + /api/conversations when that endpoint 404s (see
// routes/today/buildToday.ts). Copied verbatim from the build plan §C7.

export type TodayGroup = 'needs_you_now' | 'tours_today' | 'unreplied' | 'follow_ups';
export interface TodayItem {
  group: TodayGroup;
  refType: 'case' | 'contact' | 'conversation';
  refId: string;
  who: string; // display name / phone
  why: string; // "RTA window closing"
  urgency?: string; // "2h left"
  tag?: string; // "Case · Touring"
  attention?: boolean;
}
export interface TodayResponse {
  items: TodayItem[];
  generatedAt: string;
}

// --- Conversations (legacy reuse — verbatim from the proven contract) --------
// Copied unchanged from dashboard-legacy/src/api/types.ts; field names match the
// wire JSON the server emits (the Today fallback reads `unread_count`,
// `participant_display_name`, `preview`, `participant_phone`, `type`).

/** Conversation thread type. `unknown_1to1` is the honest-identity value: a
 *  thread whose participant has not been triaged to tenant/landlord yet.
 *  `relay_group` (M1.7) is a multi-party masked thread fronted by a pool number:
 *  inbound on the pool number fans out to the other members. */
export type ConversationType =
  | 'tenant_1to1'
  | 'landlord_1to1'
  | 'unknown_1to1'
  | 'relay_group';

/** A linked external participant: contact + phone pair. */
export interface ConversationParticipant {
  contactId: string;
  phone: string;
  /** Sender-prefix display name (relay groups); resolved from the contact, may be absent. */
  name?: string;
}

/** One inbox row (GET /api/conversations). Field names are the server's
 *  denormalized summary shape (toConversationSummary). */
export interface ConversationSummary {
  conversationId: string;
  type: ConversationType;
  /** External participant's phone, E.164. */
  participant_phone: string;
  participants: ConversationParticipant[];
  /** Latest-message preview (truncated) or null. */
  preview: string | null;
  /** ISO 8601. */
  last_activity_at: string;
  unread_count: number;
  /** Assigned team member's userId, or null when unassigned. */
  assignment: string | null;
  sms_opt_out: boolean;
  /** Resolved contact name denormalized onto the conversation, or null when the
   *  participant is un-triaged (we never fabricate a name — fall back to phone). */
  participant_display_name: string | null;
  /** Relay group (M1.7): the masked pool number fronting the thread, when the
   *  server projects it onto the summary. Absent on 1:1 rows. */
  pool_number?: string | null;
}

/** Inbox page (GET /api/conversations). */
export interface ConversationsPage {
  conversations: ConversationSummary[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

// --- Cases / boards (M1.10) (legacy reuse — verbatim) -----------------------
// Copied unchanged from dashboard-legacy/src/api/types.ts. The Today fallback
// reads `stage`, `tour_date`, `next_deadline_type`, `next_deadline_at`,
// `attention`, `tenantId`, `unitId`.

/**
 * The stage ladder (doc §5), one deal from tour-interest to move-in. `porting`
 * is the portability branch; `moved_in` is the happy terminal and `lost` the
 * negative one (reachable from any stage). An ordered list, not a strict state
 * machine — Phase 1 is manual (the operator sets the stage).
 */
export type CaseStage =
  | 'interested'
  | 'porting'
  | 'touring'
  | 'applied'
  | 'rta_submitted'
  | 'inspection'
  | 'rent_determined'
  | 'lease'
  | 'moved_in'
  | 'lost';

/** The ordered case stages, for the kanban columns + the stage <select>. */
export const CASE_STAGES: readonly CaseStage[] = [
  'interested',
  'porting',
  'touring',
  'applied',
  'rta_submitted',
  'inspection',
  'rent_determined',
  'lease',
  'moved_in',
  'lost',
];

/** The business-clock deadline types (doc §5): the single most-urgent pending
 *  clock a case carries. */
export type CaseDeadlineType =
  | 'tour_reminder'
  | 'rta_window'
  | 'voucher_expiration'
  | 'stuck_case'
  | 'follow_up';

/** A scheduled tour on a case, current or historical. */
export interface CaseTour {
  /** YYYY-MM-DD. */
  date: string;
  outcome?: string;
  notes?: string;
}

/** Escalation flag (doc §7.1): a failed send on an active case → a human calls. */
export interface CaseAttention {
  reason: string;
  /** ISO 8601 — when the flag was raised. */
  at: string;
}

/** A case record (GET /api/cases → { cases }, GET /api/cases/:caseId →
 *  { case }). Flexible document on the server; the contractual fields are typed
 *  and the index signature carries anything extra. */
export interface CaseItem {
  caseId: string;
  /** The tenant contact this deal is for. */
  tenantId: string;
  /** The unit this deal is on. */
  unitId: string;
  /** The stage ladder position (the kanban column). */
  stage: CaseStage;
  /** The CURRENT scheduled tour date, YYYY-MM-DD (absent when none scheduled). */
  tour_date?: string;
  /** The next-deadline composite (set/cleared together via the deadline route). */
  next_deadline_type?: CaseDeadlineType;
  /** The next-deadline instant, ISO 8601. */
  next_deadline_at?: string;
  /** The placement's relay-group conversationId (set when the relay is set up). */
  group_thread?: string;
  /** Operator label, mirrored onto the relay pool number. */
  placement_tag?: string;
  /** Tour history (the current tour is also reflected in tour_date). */
  tours?: CaseTour[];
  /** The four-rung application ladder — free-form object. */
  application?: Record<string, unknown>;
  /** RTA/approval data — free-form object. */
  rta?: Record<string, unknown>;
  /** Why a `lost` case was lost. */
  lost_reason?: string;
  lease_date?: string;
  move_in_date?: string;
  /** Free-text case-level note the operator keeps on the board. */
  notes?: string;
  /** Escalation flag (doc §7.1) — cleared via updateCase({ attention: null }). */
  attention?: CaseAttention;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** GET /api/cases page. */
export interface CasesPage {
  cases: CaseItem[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

// --- SSE (legacy reuse — verbatim) ------------------------------------------
// Copied unchanged from dashboard-legacy/src/api/types.ts. useEventStream
// dispatches these; useToday refetches on case.updated + conversation.updated.

/** Message direction relative to the platform. */
export type MessageDirection = 'inbound' | 'outbound';

/** Outbound delivery state machine (doc §7.1). `sent` is NOT `delivered`. */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/** GET /api/events 'conversation.updated' payload. */
export interface ConversationUpdatedEvent {
  conversationId: string;
  last_activity_at: string;
  unread_count: number;
  preview?: string;
  /** Conversation type carried on the event so the inbox can re-evaluate the
   *  needs-review chip live (e.g. unknown_1to1 → tenant_1to1 after triage). */
  type: ConversationType;
  /** Assigned team member's userId, or null when unassigned — so the Assigned
   *  chip re-evaluates live. */
  assignment: string | null;
  /** Resolved contact name (or null) — so the inbox shows the name and clears
   *  the review chip the instant a contact is triaged, without a reload. */
  participant_display_name: string | null;
  /**
   * Relay group (M1.7): `open` | `closed` for relay_group threads; null/absent
   * for 1:1 (implicitly open). Lets the relay UI grey out a closed thread live.
   */
  status?: string | null;
  /**
   * Relay group (M1.7): the masked pool number (E.164), or null/absent on 1:1
   * threads. Cleared on close, re-set (fresh) on reopen.
   */
  pool_number?: string | null;
  /**
   * Relay group (M1.7): the live member roster, or null/absent on 1:1 threads.
   * Carried on the event so the relay UI updates rosters in place on add/remove
   * WITHOUT a refetch. Each entry carries contactId/phone/name (name optional).
   */
  members?: ConversationParticipant[] | null;
}

/** GET /api/events 'case.updated' payload (M1.10). Carries the board-relevant
 *  projection so a kanban card can move stage / flip its attention dot / refresh
 *  its tour + deadline live, without a refetch. `attention` is a BOOLEAN here
 *  (the full CaseItem carries the CaseAttention object). NO PII — never logged.
 *  `stage` is the wire string (one of CASE_STAGES). */
export interface CaseUpdatedEvent {
  caseId: string;
  tenantId: string;
  unitId: string;
  stage: string;
  tour_date: string | null;
  next_deadline_type: string | null;
  next_deadline_at: string | null;
  /** The linked relay-group conversationId, or null. */
  group_thread: string | null;
  /** True when the case carries an escalation attention flag. */
  attention: boolean;
  lost_reason: string | null;
  updated_at: string | null;
}
