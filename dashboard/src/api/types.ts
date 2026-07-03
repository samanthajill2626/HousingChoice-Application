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

/** GET /api/users/me → { user } (Voice Phase 1 §7). The self view the current
 *  navigator reads to know whether they have a VERIFIED cell (their outbound
 *  bridge leg) — a superset of `Me` with the voice fields. MIRRORS the app's
 *  self-user projection; keep in sync. `cell`/`cell_verified_at` are absent until
 *  set/verified; `inbound_voice_line` is true only on the single holder. */
export interface MeUser {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  /** The user's OWN cell (E.164), their outbound bridge leg. Absent until set. */
  cell?: string;
  /** ISO 8601 when `cell` passed verification; absent = unverified (never dialed). */
  cell_verified_at?: string;
  /** True when this user holds the single inbound voice line. */
  inbound_voice_line?: boolean;
}

// --- Settings: Team (admin user management) ---------------------------------
// MIRRORS app/src/routes/adminUsers.ts `toAdminUserView` — the admin-list
// projection of a user (NO google_sub / push_subscriptions). The dashboard is a
// separate package and cannot import from app/src, so this is duplicated; keep
// it in sync with the source when the projection changes.

/** GET /api/users → { users: AdminUserView[] }; the team roster row. `status`
 *  and `last_login_at` are null when unset. */
export interface AdminUserView {
  userId: string;
  email: string;
  /** Display name (Google profile name, else a humanized fallback). */
  name: string;
  role: UserRole;
  status: string | null;
  created_at: string;
  last_login_at: string | null;
  /** Voice Phase 1 (spec §4): the user's OWN verified cell (E.164) — their
   *  outbound bridge leg. Absent until set. MIRRORS UserItem.cell. */
  cell?: string;
  /** Voice Phase 1: ISO 8601 when `cell` passed verification; absent = unverified
   *  (never dialed). MIRRORS UserItem.cell_verified_at. */
  cell_verified_at?: string;
  /** Voice Phase 1 (spec §6): true on the single inbound-voice-line holder.
   *  MIRRORS UserItem.inbound_voice_line. */
  inbound_voice_line?: boolean;
}

// --- Settings: OrgSettings (founder-editable call-triage templates) ----------
// MIRRORS app/src/repos/settingsRepo.ts `OrgSettings`. The dashboard cannot
// import from app/src, so the shape is duplicated; keep it in sync. `welcomeText`
// is OPTIONAL (absent until the operator sets it — the backend falls back to its
// WELCOME_TEXT_TEMPLATE constant).

/** GET /api/settings → { settings }, PUT /api/settings { patch } → { settings }. */
export interface OrgSettings {
  /** The zero-tap missed-call auto-text body (1..320 chars). */
  missedCallAutoText: string;
  /** Whether the missed-call auto-text fires at all. */
  missedCallAutoTextEnabled: boolean;
  /** The missed-call quick-reply buttons (≤10, each 1..320 chars). */
  quickReplies: string[];
  /** The pre-ring <Pause> before the founder-bridge dial (whole seconds, 0..10). */
  preRingPauseSeconds: number;
  /** OPTIONAL housing-fair welcome SMS body; {firstName} is interpolated.
   *  Absent → the backend falls back to WELCOME_TEXT_TEMPLATE. */
  welcomeText?: string;
}

/** The PUT /api/settings patch: only the changed fields. `welcomeText` accepts
 *  an explicit `null` to CLEAR a previously-set value (revert to the built-in
 *  default) — the backend deletes the stored attribute. Every other field keeps
 *  its OrgSettings type. */
export type SettingsPatch = Partial<Omit<OrgSettings, 'welcomeText'>> & {
  welcomeText?: string | null;
};

/** GET/PUT /api/settings response. `welcomeTextDefault` rides alongside the
 *  settings (read-only, never patchable): the exact welcome body the backend
 *  sends when `welcomeText` is unset, so the UI can show the admin what "the
 *  default" actually says. */
export interface SettingsResponse {
  settings: OrgSettings;
  welcomeTextDefault: string;
}

// --- Settings: System Status (admin-only) -----------------------------------
// MIRRORS app/src/services/systemStatus.ts (getFlags) + app/src/adapters/
// cloudwatch.ts (AlarmView / ErrorEventView) + the /api/system route shapes.
// The dashboard cannot import from app/src, so these are duplicated; keep them
// in sync with the backend contract.

/** GET /api/system/flags → go-live readiness (booleans/enums/strings — never secrets). */
export interface SystemFlags {
  /** Deploy env name (local | dev | prod). */
  env: string;
  /** A2P kill-switch: outbound SMS enabled (false = expected pre-A2P). */
  smsSendingEnabled: boolean;
  /** A2P kill-switch: relay number provisioning enabled (false = expected pre-A2P). */
  relayLiveProvisioning: boolean;
  /** Whether Web Push (VAPID) is configured in this env. */
  pushConfigured: boolean;
  /** Outbound messaging driver as displayed. `mock` = the twilio driver
   *  redirected to a fake host (local `--mock` loop); never appears deployed. */
  messagingDriver: 'twilio' | 'console' | 'mock';
}

/** A CloudWatch alarm's state (DescribeAlarms StateValue, mapped). */
export type SystemAlarmState = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';

/** GET /api/system/alarms → one alarm row. */
export interface SystemAlarm {
  name: string;
  state: SystemAlarmState;
  /** ISO 8601 of the last state transition, or '' when absent. */
  stateUpdatedAt: string;
}

/** GET /api/system/errors → one error event (PII-safe projection ONLY). */
export interface SystemErrorEvent {
  /** ISO 8601 of the log event. */
  timestamp: string;
  /** pino numeric level (≥ 50 = error/fatal). */
  level: number;
  /** The log's short message — never a body/PII payload. */
  message: string;
  /** The correlation id, or null when the event carried none. */
  correlationId: string | null;
}

/** GET /api/system/alarms response — degrades to { available: false, reason }. */
export interface SystemAlarmsResult {
  available: boolean;
  alarms?: SystemAlarm[];
  reason?: string;
}

/** GET /api/system/errors response — degrades to { available: false, reason }. */
export interface SystemErrorsResult {
  available: boolean;
  events?: SystemErrorEvent[];
  reason?: string;
}

// --- Today action queue (§API Contract C7) ----------------------------------
// The prioritized "what needs the navigator now" queue. The backend serves it at
// GET /api/today (TodayResponse); the B1 frontend assembles the SAME shape
// client-side from /api/placements + /api/conversations when that endpoint 404s (see
// routes/today/buildToday.ts). Copied verbatim from the build plan §C7.

export type TodayGroup = 'needs_you_now' | 'tours_today' | 'unreplied' | 'follow_ups';
export interface TodayItem {
  group: TodayGroup;
  refType: 'placement' | 'contact' | 'conversation' | 'tour';
  refId: string;
  who: string; // display name / phone
  why: string; // "RTA window closing"
  urgency?: string; // "2h left"
  tag?: string; // "Placement · Touring"
  attention?: boolean;
}
export interface TodayResponse {
  items: TodayItem[];
  generatedAt: string;
}

// --- Conversations (legacy reuse — verbatim from the proven contract) --------
// Copied unchanged from the legacy dashboard; field names match the
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

// --- Placements / boards (M1.10) (legacy reuse — verbatim) ------------------
// Copied unchanged from the legacy dashboard. The Today fallback
// reads `stage`, `tour_date`, `next_deadline_type`, `next_deadline_at`,
// `attention`, `tenantId`, `unitId`.

// ============================================================================
// MIRRORS app/src/lib/statusModel.ts — keep in sync.
// The dashboard is a separate package and cannot import from app/src, so the
// status-model constants/labels/enums are DUPLICATED here. When the source of
// truth (app/src/lib/statusModel.ts) changes, mirror the change here too.
// ============================================================================

// --- Placement phases (board columns; Title Case display) -------------------
export const PLACEMENT_PHASES = [
  'Application',
  'RTA',
  'Inspection',
  'Rent Determination',
  'Contract',
  'Administrative',
  'Closure',
] as const;

export type PlacementPhase = (typeof PLACEMENT_PHASES)[number];

// --- Placement stages (THE ordered stage list; snake_case stored keys) ------
// One flat ordered ladder. NOT a strict state machine — stages can be
// skipped/jumped, and `lost` is reachable from ANY stage. The two terminals
// (`moved_in`, `lost`) sit at the end.
export const PLACEMENT_STAGES = [
  // Application
  'send_application',
  'awaiting_receipt',
  'awaiting_completion',
  'awaiting_approval',
  // RTA
  'collect_rta',
  'review_rta',
  'send_rta_to_landlord',
  'awaiting_landlord_submission',
  'awaiting_authority_approval',
  // Inspection
  'schedule_inspection',
  'awaiting_inspection',
  // Rent Determination
  'determine_rent',
  'awaiting_rent_acceptance',
  // Contract
  'awaiting_hap_contract',
  // Administrative
  'complete_paperwork',
  // Closure
  'awaiting_move_in',
  'moved_in', // ✓ terminal
  'lost', // ✕ terminal (reachable from any stage)
] as const;

export type PlacementStage = (typeof PLACEMENT_STAGES)[number];

/** stage → its phase (the board column it belongs to). */
export const STAGE_PHASE: Readonly<Record<PlacementStage, PlacementPhase>> = {
  send_application: 'Application',
  awaiting_receipt: 'Application',
  awaiting_completion: 'Application',
  awaiting_approval: 'Application',
  collect_rta: 'RTA',
  review_rta: 'RTA',
  send_rta_to_landlord: 'RTA',
  awaiting_landlord_submission: 'RTA',
  awaiting_authority_approval: 'RTA',
  schedule_inspection: 'Inspection',
  awaiting_inspection: 'Inspection',
  determine_rent: 'Rent Determination',
  awaiting_rent_acceptance: 'Rent Determination',
  awaiting_hap_contract: 'Contract',
  complete_paperwork: 'Administrative',
  awaiting_move_in: 'Closure',
  moved_in: 'Closure',
  lost: 'Closure',
};

/** stage → sentence-case display label. Only `RTA`/`HAP` stay all-caps. */
export const STAGE_LABELS: Readonly<Record<PlacementStage, string>> = {
  send_application: 'Send application',
  awaiting_receipt: 'Awaiting receipt',
  awaiting_completion: 'Awaiting completion',
  awaiting_approval: 'Awaiting approval',
  collect_rta: 'Collect RTA',
  review_rta: 'Review RTA',
  send_rta_to_landlord: 'Send RTA to landlord',
  awaiting_landlord_submission: 'Awaiting landlord submission',
  awaiting_authority_approval: 'Awaiting authority approval',
  schedule_inspection: 'Schedule inspection',
  awaiting_inspection: 'Awaiting inspection',
  determine_rent: 'Determine rent',
  awaiting_rent_acceptance: 'Awaiting rent acceptance',
  awaiting_hap_contract: 'Awaiting HAP contract',
  complete_paperwork: 'Complete paperwork',
  awaiting_move_in: 'Awaiting move-in',
  moved_in: 'Moved in',
  lost: 'Lost',
};

/** Terminal stages — a placement here is no longer active on the boards. */
export const TERMINAL_STAGES: ReadonlySet<PlacementStage> = new Set<PlacementStage>([
  'moved_in',
  'lost',
]);

// --- Inspection outcome (the Inspection phase carries a pass/fail) ----------
export const INSPECTION_OUTCOMES = ['pass', 'fail'] as const;
export type InspectionOutcome = (typeof INSPECTION_OUTCOMES)[number];

// --- Tenant lifecycle (coarse) ----------------------------------------------
// The values a TENANT contact's single `status` field holds. Non-tenant
// contacts use needs_review|active instead. `porting` is a SEPARATE boolean
// flag on the tenant, never a status value.
export const TENANT_STATUSES = [
  'needs_review',
  'onboarding',
  'searching',
  'placing',
  'placed',
  'on_hold',
  'inactive',
] as const;

export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const TENANT_STATUS_LABELS: Readonly<Record<TenantStatus, string>> = {
  needs_review: 'Needs review',
  onboarding: 'Onboarding',
  searching: 'Searching',
  placing: 'Placing',
  placed: 'Placed',
  on_hold: 'On hold',
  inactive: 'Inactive',
};

// --- Landlord lead lifecycle (type=landlord) --------------------------------
// A landlord contact carries its own lead lifecycle on the SAME `status` field
// tenants use (type-scoped — MIRRORS app/src/lib/statusModel.ts LANDLORD_STATUSES).
// `needs_review` is the triage front door; a lead worth pursuing is `interested`;
// an onboarded landlord is `active`; a declined/not-a-fit/never-signed lead is the
// terminal `parked` (with a `park_reason` captured on the move).
export const LANDLORD_STATUSES = ['needs_review', 'interested', 'active', 'parked'] as const;

export type LandlordStatus = (typeof LANDLORD_STATUSES)[number];

export const LANDLORD_STATUS_LABELS: Readonly<Record<LandlordStatus, string>> = {
  needs_review: 'Needs review',
  interested: 'Interested',
  active: 'Active',
  parked: 'Parked',
};

// --- Property lifecycle (coarse, mostly derived) -----------------------------
export const LISTING_STATUSES = [
  'setup',
  'available',
  'under_application',
  'finalizing',
  'occupied',
  'on_hold',
  'off_market',
] as const;

export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const LISTING_STATUS_LABELS: Readonly<Record<ListingStatus, string>> = {
  setup: 'Setup',
  available: 'Available',
  under_application: 'Under application',
  finalizing: 'Finalizing',
  occupied: 'Occupied',
  on_hold: 'On hold',
  off_market: 'Off market',
};

/** The ONLY publicly-shareable property status (`available` gates the public flyer). */
export const SHAREABLE: ReadonlySet<ListingStatus> = new Set<ListingStatus>(['available']);

// --- Transition sources -----------------------------------------------------
export const TRANSITION_SOURCES = ['derived', 'import', 'automation', 'ai', 'manual'] as const;
export type TransitionSource = (typeof TRANSITION_SOURCES)[number];

// --- Lost reason categories (pick OR free-write) ----------------------------
export const LOST_REASON_CATEGORIES = [
  'stalled',
  'no_contact',
  'landlord_lost_rent',
  'landlord_lost_inspection',
  'tenant_withdrew',
  'voucher_expired',
  'other',
] as const;

export type LostReasonCategory = (typeof LOST_REASON_CATEGORIES)[number];

/**
 * DASHBOARD-ONLY readable phrasings for the lost-reason categories (the source
 * model carries only the enum, no display map — these are the UI's wording).
 */
export const LOST_REASON_CATEGORY_LABELS: Readonly<Record<LostReasonCategory, string>> = {
  stalled: 'Stalled out',
  no_contact: 'Lost contact',
  landlord_lost_rent: "Landlord couldn't get rent",
  landlord_lost_inspection: 'Failed inspection',
  tenant_withdrew: 'Tenant withdrew',
  voucher_expired: 'Voucher expired',
  other: 'Other',
};

/** Structured Lost reason: a category pick AND/OR free text. */
export interface LostReason {
  category?: LostReasonCategory;
  text?: string;
}

/**
 * A human-readable label for a structured lost reason: the category's readable
 * phrasing, the free text, or both joined ("Category — free text"). Empty when
 * the reason carries neither. Render `lost_reason` through this (it is an object
 * now, never a bare string).
 */
export function formatLostReason(lr: LostReason | undefined): string {
  if (lr === undefined) return '';
  const cat = lr.category !== undefined ? LOST_REASON_CATEGORY_LABELS[lr.category] : '';
  const text = typeof lr.text === 'string' ? lr.text.trim() : '';
  if (cat && text) return `${cat} — ${text}`;
  return cat || text;
}

/** The business-clock deadline types (doc §5): the single most-urgent pending
 *  clock a placement carries. */
export type PlacementDeadlineType =
  | 'tour_reminder'
  | 'rta_window'
  | 'voucher_expiration'
  | 'stuck_placement'
  | 'follow_up';

// NOTE: PlacementTour is retired — placement.tours[] has no real data and is
// being removed. Use the first-class Tour entity (Tour / getTours / getTour etc.)
// for all tour data going forward.

// --- First-class Tour entity (Tours feature) ---------------------------------

/** The three valid tour types (mirrors app/src/repos/toursRepo.ts TourType). */
export type TourType = 'self_guided' | 'landlord_led' | 'pm_team';

/** Human-readable labels for tour types (staff-facing). */
export const TOUR_TYPE_LABELS: Readonly<Record<TourType, string>> = {
  self_guided: 'Self-guided',
  landlord_led: 'Landlord-led',
  pm_team: 'PM team',
};

/** Tour status values (mirrors app/src/lib/toursModel.ts TOUR_STATUSES). */
export type TourStatus =
  | 'requested'
  | 'scheduled'
  | 'confirmed'
  | 'toured'
  | 'no_show'
  | 'canceled'
  | 'closed';

/** Human-readable labels for tour statuses (staff-facing). */
export const TOUR_STATUS_LABELS: Readonly<Record<TourStatus, string>> = {
  requested: 'Requested',
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
  toured: 'Toured',
  no_show: 'No show',
  canceled: 'Canceled',
  closed: 'Closed',
};

/** Exit-gate outcome (mirrors app/src/lib/toursModel.ts TourOutcome). */
export type TourOutcome = 'move_forward' | 'not_a_fit';

/** Human-readable labels for tour outcomes (staff-facing). */
export const TOUR_OUTCOME_LABELS: Readonly<Record<TourOutcome, string>> = {
  move_forward: 'Move forward',
  not_a_fit: 'Not a fit',
};

/**
 * A first-class Tour entity (GET /api/tours/:tourId → { tour }).
 * Tours are separate from placements — scheduling a tour does NOT change tenant
 * status or create a placement. The exit gate (outcome + moveForward) records the
 * navigator decision; conversion is a downstream step.
 */
export interface Tour {
  tourId: string;
  /** The tenant this tour is for. */
  tenantId: string;
  /** The unit being toured. */
  unitId: string;
  /** ISO 8601 datetime the tour is scheduled for. Absent on a 'requested' (timeless) tour. */
  scheduledAt?: string;
  tourType: TourType;
  status: TourStatus;
  /** The relay-group conversationId, set when POST /api/tours/:tourId/relay is called. */
  groupThreadId?: string;
  /** Exit-gate decision (set via PATCH { outcome, moveForward }). */
  outcome?: TourOutcome;
  /** True when the navigator decided to move forward after the tour. */
  moveForward?: boolean;
  /** True when outcome+moveForward have been set and moveForward is true. */
  convertible?: boolean;
  /** The placementId this tour was converted into (Post-Tour & Application).
   *  Set by POST /api/placements/from-tour; presence means the tour is spent. */
  convertedPlacementId?: string;
  /** ISO 8601 — when the tour was created. camelCase to match the server's TourItem shape. */
  createdAt?: string;
  /** ISO 8601 — when the tour was last updated. camelCase to match the server's TourItem shape. */
  updatedAt?: string;
  [key: string]: unknown;
}

/** GET /api/tours response. */
export interface ToursPage {
  tours: Tour[];
}

// --- Tour reminder ladder (scheduled-message-visibility) ---------------------

/** The five reminder rungs of a tour's ladder (mirrors the app-side ReminderKind). */
export type ReminderKind =
  | 'confirmation'
  | 'day_before'
  | 'morning_of'
  | 'en_route'
  | 'no_show_checkin';

/**
 * One rung of a tour's reminder ladder (GET /api/tours/:tourId/reminders).
 * Mirrors the server's TourReminderView shape verbatim (Task 2).
 */
export interface TourReminderView {
  reminderId: string;
  kind: ReminderKind;
  /** ISO 8601 — when the rung is due to fire. */
  dueAt: string;
  state: 'upcoming' | 'sent' | 'canceled';
  /** ISO 8601 — when it was sent (present when state === 'sent'). */
  sentAt?: string;
  /** ISO 8601 — when it was canceled (present when state === 'canceled'). */
  canceledAt?: string;
  body: string;
  /** Present when the rung is armed but will be skipped at fire time. */
  suppression?: { reason: 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage' };
}

/** GET /api/tours/:tourId/reminders response: the ladder + the NEXT rung to fire. */
export interface TourRemindersPage {
  reminders: TourReminderView[];
  /** The next reminder due to fire (highlight it in the UI). Absent when none upcoming. */
  next?: TourReminderView;
}

/** Human-readable labels for the reminder rungs (staff-facing). */
export const REMINDER_KIND_LABELS: Readonly<Record<ReminderKind, string>> = {
  confirmation: 'Confirmation',
  day_before: 'Day before',
  morning_of: 'Morning of',
  en_route: 'En route',
  no_show_checkin: 'No-show check-in',
};

/** Human-readable phrasings for why an armed rung will be skipped (staff-facing). */
export const REMINDER_SUPPRESSION_LABELS: Readonly<
  Record<NonNullable<TourReminderView['suppression']>['reason'], string>
> = {
  sms_sending_disabled: 'SMS sending is off',
  contact_opted_out: 'contact opted out',
  manual_mode: 'manual mode',
  stale_stage: 'tour no longer at this stage',
};

/** Escalation flag (doc §7.1): a failed send on an active placement → a human calls. */
export interface PlacementAttention {
  reason: string;
  /** ISO 8601 — when the flag was raised. */
  at: string;
}

/** A placement record (GET /api/placements → { placements }, GET /api/placements/:placementId →
 *  { placement }). Flexible document on the server; the contractual fields are typed
 *  and the index signature carries anything extra. */
export interface PlacementItem {
  placementId: string;
  /** The tenant contact this deal is for. */
  tenantId: string;
  /** The unit this deal is on. */
  unitId: string;
  /** The tour this placement was converted from, when born via the Post-Tour &
   *  Application conversion (POST /api/placements/from-tour). Absent on manually
   *  created placements. */
  fromTourId?: string;
  /** The stage ladder position (the kanban column). */
  stage: PlacementStage;
  /** When the placement last entered its current stage (ISO 8601). */
  stage_entered_at?: string;
  /** Provenance of the last stage write. */
  stage_source?: TransitionSource;
  /** Inspection pass/fail recorded on the move OUT of awaiting_inspection. */
  inspection_outcome?: InspectionOutcome;
  /** The CURRENT scheduled tour date, YYYY-MM-DD (absent when none scheduled). */
  tour_date?: string;
  /** The next-deadline composite (set/cleared together via the deadline route). */
  next_deadline_type?: PlacementDeadlineType;
  /** The next-deadline instant, ISO 8601. */
  next_deadline_at?: string;
  /** The placement's relay-group conversationId (set when the relay is set up). */
  group_thread?: string;
  /** Operator label, mirrored onto the relay pool number. */
  placement_tag?: string;
  /** The four-rung application ladder — free-form object. */
  application?: Record<string, unknown>;
  /** RTA/approval data — free-form object. */
  rta?: Record<string, unknown>;
  /** Why a `lost` placement was lost — a structured { category?, text? } object. */
  lost_reason?: LostReason;
  lease_date?: string;
  move_in_date?: string;
  /** Free-text placement-level note the operator keeps on the board. */
  notes?: string;
  /** Escalation flag (doc §7.1) — cleared via updatePlacement({ attention: null }). */
  attention?: PlacementAttention;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** One provenance/audit row from GET /api/placements/:placementId/history
 *  (auditRepo.listByEntity). `payload` is the recorded transition detail. */
export interface HistoryRow {
  entityKey: string;
  event_type: string;
  ts: string;
  actorId?: string;
  payload?: Record<string, unknown>;
}

/** GET /api/placements page. */
export interface PlacementsPage {
  placements: PlacementItem[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

// --- SSE (legacy reuse — verbatim) ------------------------------------------
// Copied unchanged from the legacy dashboard. useEventStream
// dispatches these; useToday refetches on placement.updated + conversation.updated.

/** Message direction relative to the platform. */
export type MessageDirection = 'inbound' | 'outbound';

/** Who authored a message. `unknown` = from an un-triaged contact (never guessed). */
export type MessageAuthor = 'tenant' | 'landlord' | 'teammate' | 'ai' | 'unknown';

/** Message transport. `call` is a metadata-only voice-call timeline entry. */
export type MessageType = 'sms' | 'mms' | 'call';

/** Coarse human-facing call outcome: `answered` (a leg connected), `missed`
 *  (nobody answered / busy / failed), `voicemail` (founder-bridge seam). */
export type CallOutcome = 'answered' | 'missed' | 'voicemail';

/** Contact identity type. `unknown` = auto-captured, awaiting human triage. */
export type ContactType = 'tenant' | 'landlord' | 'team_member' | 'unknown';

/**
 * A2P/CTIA consent method (spec §2 + client_inbound/inbound_call). MIRROR of the
 * app's lib/smsCompliance.ts ConsentMethod — the dashboard can't import from
 * app/, so keep the two in sync by hand. web_form/inbound_text/inbound_call are
 * stamped automatically; the rest are only ever set by a human (client_inbound =
 * staff attests the client texted or called us first, historically).
 */
export type ConsentMethod =
  | 'web_form'
  | 'inbound_text'
  | 'inbound_call'
  | 'client_inbound'
  | 'verbal_phone'
  | 'verbal_in_person'
  | 'paper_form'
  | 'imported';

/** Outbound delivery state machine (doc §7.1). `sent` is NOT `delivered`. */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/**
 * Per-recipient delivery slot on a relay-group source message (M1.7). MIRRORS
 * app/src/repos/messagesRepo.ts `RelayRecipientDelivery` — the dashboard can't
 * import from app/, so keep it in sync by hand. Keyed by member key
 * (contactId, else `phone#<E164>`) in the message's `delivery_recipients` map;
 * a `status:'failed'` + `errorCode:'contact_opted_out'` slot means that member
 * opted out and was NOT relayed to (surfaced as a subtle Timeline note). */
export interface RelayRecipientDelivery {
  status: DeliveryStatus;
  sid?: string;
  errorCode?: string;
  sentAt?: string;
  deliveredAt?: string;
}

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

/** GET /api/events 'placement.updated' payload (M1.10). Carries the board-relevant
 *  projection so a kanban card can move stage / flip its attention dot / refresh
 *  its tour + deadline live, without a refetch. `attention` is a BOOLEAN here
 *  (the full PlacementItem carries the PlacementAttention object). NO PII — never logged.
 *  `stage` is the wire string (one of PLACEMENT_STAGES). */
export interface PlacementUpdatedEvent {
  placementId: string;
  tenantId: string;
  unitId: string;
  stage: string;
  tour_date: string | null;
  next_deadline_type: string | null;
  next_deadline_at: string | null;
  /** The linked relay-group conversationId, or null. */
  group_thread: string | null;
  /** True when the placement carries an escalation attention flag. */
  attention: boolean;
  /** The lost-reason CATEGORY only — the SSE emitter sends the bounded category
   *  string (the free `text` is withheld as potential PII; see
   *  app/src/lib/events.ts). NOT the full LostReason object. */
  lost_reason: LostReasonCategory | null;
  updated_at: string | null;
}

/** GET /api/events 'message.persisted' payload (legacy reuse — verbatim). The
 *  contact timeline refetches on this so a new inbound/outbound shows up live. */
export interface MessagePersistedEvent {
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  deliveryStatus: DeliveryStatus;
}

// --- Contact creation / vocabulary (extensible create flow) ------------------

/** A relationship link on a contact (e.g. spouse, employer, property manager). */
export interface Relationship {
  role: string;
  name: string;
  contactId?: string;
}

/** A freeform key→value pair stored on a contact (custom intake fields). */
export interface CustomField {
  label: string;
  value: string;
}

/** GET /api/contacts/vocabulary — the operator-configured pick-lists used by the
 *  contact creation form. */
export interface ContactVocabulary {
  roles: string[];
  relationshipRoles: string[];
  fieldLabels: string[];
}

/** POST /api/contacts — create a brand-new contact record. The optional
 *  `consent_*` fields let staff record text consent at create time (CONTRACT 4);
 *  `consent_method` is a HUMAN value only (the server stamps consent_captured_by).
 *  Left blank → nothing sent (the just-in-time gate catches it later). */
export interface ContactCreate {
  type: ContactType;
  firstName?: string;
  lastName?: string;
  phone?: string;
  voucherSize?: number;
  company?: string;
  /** Landlord preference defaults (person-level policies). */
  accepts_programs?: string[];
  lease_terms?: string;
  pet_policy?: string;
  role?: string;
  relationships?: Relationship[];
  customFields?: CustomField[];
  /** A2P/CTIA consent captured at create time — a HUMAN method only. */
  consent_method?: 'client_inbound' | 'verbal_phone' | 'verbal_in_person' | 'paper_form' | 'imported';
  /** When consent was obtained (ISO 8601). */
  consent_at?: string;
  /** Optional free-text note ("said OK to texts at fair"). */
  consent_note?: string;
}

// --- Contacts (legacy reuse — verbatim from the proven contract) -------------
// Copied from the legacy dashboard. The contact detail page reads
// type/status/phone/firstName/lastName/voucherSize/notes off this flexible doc.

/** A contact (GET /api/contacts/:id → { contact }). Flexible document. C1 adds
 *  an optional `phones[]`; when absent, synthesize [{phone, primary:true}]. */
export interface Contact {
  contactId: string;
  type: ContactType;
  status?: string;
  /** Tenant portability flag (a SEPARATE boolean, never a status value). */
  porting?: boolean;
  /** Landlord lead lifecycle: the reason captured when a landlord is moved to
   *  the terminal `parked` status (declined / not-a-fit / never-signed). */
  park_reason?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  voucherSize?: number;
  notes?: string;
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  /** Voice Phase 1 (spec §8): staff-set company do-not-call. INDEPENDENT of
   *  sms_opt_out. MIRRORS ContactItem.voice_opt_out. */
  voice_opt_out?: boolean;
  /** Soft-delete marker (ISO 8601). Present → the contact is "deleted": hidden
   *  from the normal lists/inbox/today but fully retained (restore clears it). */
  deleted_at?: string;
  capture_source?: string;
  captured_at?: string;
  created_at?: string;
  /** A2P/CTIA consent model (spec §2) — all optional. "Has SMS consent" =
   *  a non-empty `consent_method`. */
  consent_method?: ConsentMethod;
  /** When consent was obtained (ISO 8601) — may differ from created_at. */
  consent_at?: string;
  /** The disclosure version shown on the web form (e.g. `ctia-2026-06`). */
  consent_version?: string;
  /** Optional free-text note ("said OK to texts at fair"). */
  consent_note?: string;
  /** Actor userId when staff-entered; unset for automatic methods. */
  consent_captured_by?: string;
  /** C1: when the backend ships multiple numbers (BE1). Absent on legacy. */
  phones?: ContactPhone[];
  /** Landlord/PM company name (editable). */
  company?: string;
  /** Tenant housing authority (camelCase — the byHousingAuthority GSI key). */
  housingAuthority?: string;
  /** Eligibility intake (free-text answers + a boolean LIF flag). */
  pets?: string;
  evictions?: string;
  tenure?: string;
  lifEligible?: boolean;
  /** Structured landlord deal terms + approval criteria (onboarding call). First-class
   *  optional fields; not type-gated. `contract_status` records whether the external
   *  DocuSign contract was signed. */
  contract_status?: 'unsigned' | 'signed';
  /** Expected contract rent (dollars, >= 0). */
  expected_rent?: number;
  registered_landlord?: boolean;
  rta_within_48h?: boolean;
  pass_inspection_first_try?: boolean;
  income_includes_voucher?: boolean;
  /** Landlord preference DEFAULTS — person-level policies across their properties
   *  (the per-unit facts stay on UnitItem.accepted_programs etc.). `pet_policy`
   *  is distinct from `pets` (the TENANT intake answer above). */
  accepts_programs?: string[];
  /** Free-text lease-terms policy ("12-month minimum, month-to-month after"). */
  lease_terms?: string;
  /** Free-text pet policy ("small dogs OK, $300 deposit"). */
  pet_policy?: string;
  /** Structured postal address, or a plain string on pre-contract dev records. */
  address?: Address | string;
  /** Contact's role within the organisation (e.g. case manager, property manager). */
  role?: string;
  /** Linked contacts (relationships) stored on this record. */
  relationships?: Relationship[];
  /** Operator-defined custom fields stored on this record. */
  customFields?: CustomField[];
  [key: string]: unknown;
}

/** Editable contact fields (PATCH /api/contacts/:id). Every field is optional —
 *  only the changed ones are sent; the server SET-merges (absent leaves a value
 *  untouched; an empty string clears it). `type` doubles as the triage action. */
export interface ContactPatch {
  type?: ContactType;
  firstName?: string;
  lastName?: string;
  voucherSize?: number;
  status?: string;
  notes?: string;
  company?: string;
  housingAuthority?: string;
  pets?: string;
  evictions?: string;
  tenure?: string;
  lifEligible?: boolean;
  /** Structured landlord deal terms + approval criteria (onboarding call). */
  contract_status?: 'unsigned' | 'signed';
  expected_rent?: number;
  registered_landlord?: boolean;
  rta_within_48h?: boolean;
  pass_inspection_first_try?: boolean;
  income_includes_voucher?: boolean;
  /** Landlord preference defaults (person-level policies). An empty array /
   *  empty string clears the field. */
  accepts_programs?: string[];
  lease_terms?: string;
  pet_policy?: string;
  /** Landlord lead lifecycle: the reason captured when a landlord is parked. */
  park_reason?: string;
  /** Structured address; the server stores only the non-empty parts. */
  address?: Address;
  /** Contact's role within the organisation (e.g. case manager, property manager). */
  role?: string;
  /** Linked contacts (relationships) stored on this record. */
  relationships?: Relationship[];
  /** Operator-defined custom fields stored on this record. */
  customFields?: CustomField[];
  /** A2P/CTIA consent capture (CONTRACT 2) — a HUMAN method only. Sent by the
   *  just-in-time consent-capture modal; the server stamps consent_captured_by. */
  consent_method?: 'client_inbound' | 'verbal_phone' | 'verbal_in_person' | 'paper_form' | 'imported';
  /** When consent was obtained (ISO 8601). */
  consent_at?: string;
  /** Optional free-text note ("said OK to texts at fair"). */
  consent_note?: string;
}

/** GET /api/contacts page (the records list — the Contacts list views read the
 *  first page). Mirrors the proven legacy contract. */
export interface ContactsPage {
  contacts: Contact[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

// --- Units (legacy reuse — verbatim) ----------------------------------------

/** A structured US postal address. Every part is optional — intake is
 *  partial-by-design. */
export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  /** 2-letter US state. */
  state?: string;
  zip?: string;
}

/** A unit's lifecycle status. Kept as an ALIAS of the 7-value `ListingStatus`
 *  so existing importers don't churn. */
export type UnitStatus = ListingStatus;

/** A unit record (GET /api/units → { units }, GET /api/units/:id → { unit }).
 *  Flexible document; the landlord file reads landlordId/status/address/beds. */
export interface UnitItem {
  unitId: string;
  landlordId: string;
  status: UnitStatus;
  /** Provenance of the last property-status write. */
  status_source?: TransitionSource;
  /** The accepted contract rent, written on the move OUT of awaiting_rent_acceptance. */
  final_rent?: number;
  jurisdiction?: string;
  /** Structured street address, or a plain string on pre-contract dev records. */
  address?: Address | string;
  accepted_programs?: string[];
  beds?: number;
  baths?: number;
  area?: string;
  subzone?: string;
  rent_min?: number;
  rent_max?: number;
  payment_standard?: number;
  deposit?: number;
  /** Utilities arrangement, e.g. "Tenant-paid". */
  utilities?: string;
  /** Accessibility note, e.g. "Ground floor". */
  accessibility?: string;
  /** Pet policy, e.g. "Cats only". */
  pets?: string;
  /** S3 keys / URLs of property media (the Photos gallery + hero). */
  media?: string[];
  listing_link?: string;
  /** Public flyer details (public-pages §3): a tour video link. */
  video_url?: string;
  /** Public flyer details (public-pages §3): the application fee in dollars (>= 0). */
  application_fee?: number;
  /** Public flyer details (public-pages §3): same-day RTA available. */
  same_day_rta?: boolean;
  /** Landlord-onboarding: the voucher (bedroom) size this unit ACCEPTS — a
   *  stored number, DISTINCT from `beds` and from the derived read-only
   *  voucher_size. Feeds matching. Internal (not on the public flyer). */
  voucher_size_accepted?: number;
  /** C3: the landlord/PM roster (BE3). Absent on legacy → fall back to the
   *  single `landlordId` for a one-row roster. */
  contacts?: UnitContact[];
  /** Free-text "how to tour" copy (the property page's process card). */
  tour_process?: string;
  /** Free-text "how to apply" copy (the property page's process card). */
  application_process?: string;
  primary_voice_contact?: string;
  /** Soft-delete marker (ISO 8601). Present → the property is "deleted": hidden
   *  from the property lists + landlord card but fully retained (restore clears it). */
  deleted_at?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** GET /api/units page. */
export interface UnitsPage {
  units: UnitItem[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

// --- Messages (legacy reuse — verbatim) -------------------------------------
// Copied from the legacy dashboard. The timeline fallback maps
// these into TimelineMessage; the relay/voice fields are carried but unused here.

/** One timeline message (GET /api/conversations/:id/messages → { messages }).
 *  Newest-first. Field names are the server's persisted shape. */
export interface Message {
  conversationId: string;
  /** Sort key: `<providerTs>#<providerSid>`; unique per message. */
  tsMsgId: string;
  type: MessageType;
  direction: MessageDirection;
  author: MessageAuthor;
  body?: string;
  /** Provider media URLs (MMS, inbound). */
  mediaUrls?: string[];
  /** Mirrored MMS attachments (key + stored content-type, together). */
  media_attachments?: { s3Key: string; contentType: string }[];
  /** @deprecated Legacy parallel key array (pre-media_attachments). */
  media_s3_keys?: string[];
  provider_sid: string;
  provider_ts: string;
  delivery_status: DeliveryStatus;
  error_code?: string;
  /** Relay group (M1.7): per-recipient delivery slots on a relay SOURCE message
   *  (keyed by member key). Present on relay-thread messages; absent on 1:1. */
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
  // --- Voice call — present only on a type:'call' entry --------------------
  call_outcome?: CallOutcome;
  started_at?: string;
  call_duration?: number;
  /** S3 key of the mirrored recording (founder-bridge calls only). */
  recording_s3_key?: string;
  /** VERBATIM call transcript (founder-bridge calls only). */
  transcript?: string;
  created_at: string;
  [key: string]: unknown;
}

// --- C1: Contact ↔ multiple phone numbers (§API Contract C1) ----------------
// Copied verbatim from the build plan §C1. Extends Contact with phones[].

export interface ContactPhone {
  phone: string; // E.164
  label?: string; // "cell", "work", operator note
  primary: boolean; // exactly one true
  firstSeenAt?: string; // ISO; when first observed
  lastSeenAt?: string; // ISO; most recent inbound/outbound
}

// --- C2: Person-centric merged timeline (§API Contract C2) ------------------
// Copied verbatim from the build plan §C2. The blended stream the contact
// detail page renders: message bubbles + collapsed call cards + milestone pins.

export type TimelineMilestoneType =
  | 'placement_opened'
  | 'placement_closed'
  | 'listing_sent'
  | 'listing_reviewed'
  | 'tour_scheduled'
  | 'tour_took_place'
  | 'stage_changed'
  | 'number_added'
  | 'added_to_group_text'
  | 'removed_from_group_text';

interface TimelineBase {
  id: string;
  at: string; /* ISO, sort key */
}

export interface TimelineMessage extends TimelineBase {
  kind: 'message';
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection; // reuse legacy
  author: MessageAuthor; // reuse legacy
  type: 'sms' | 'mms';
  body?: string; // FULL body (no server truncation)
  media_attachments?: { s3Key: string; contentType: string }[];
  delivery_status: DeliveryStatus; // reuse legacy
  error_code?: string; // Twilio error code on a failure → human-readable reason
  /** tsMsgId of the FAILED message this one supersedes (a retry). The timeline
   *  hides the superseded predecessor so a delivered retry replaces it. */
  retry_of?: string;
  fromPhone?: string;
  toPhone?: string; // which number this used
  /** Relay group (M1.7): per-recipient delivery slots on a relay SOURCE message,
   *  keyed by member key. A `contact_opted_out` failed slot means that member
   *  opted out and wasn't relayed to — the bubble renders a subtle note. Absent
   *  on 1:1 messages. */
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
}
export interface TimelineCall extends TimelineBase {
  kind: 'call';
  conversationId?: string;
  call_outcome: CallOutcome; // reuse legacy
  call_duration?: number;
  party_phone?: string; // which number
  recording_s3_key?: string; // present ⇒ playable
  transcript?: string; // present ⇒ collapsible (never auto-shown)
}
export interface TimelineMilestone extends TimelineBase {
  kind: 'milestone';
  type: TimelineMilestoneType;
  label: string; // human text, e.g. "Tour took place · Toured"
  refType?: 'placement' | 'unit' | 'conversation' | 'broadcast' | 'tour';
  refId?: string; // deep-link target (links out, no inline content)
}
/**
 * A not-yet-sent scheduled message for this contact's 1:1 thread — the pinned
 * "Upcoming" bucket the server ships alongside the timeline (scheduled-message-
 * visibility). Mirrors the server contract VERBATIM. NEVER appears in the main
 * `items` stream (only in `ContactTimelinePage.upcoming`); it renders as a
 * distinct dashed/muted card, visibly NOT a sent message. `at` is the fire time.
 */
export interface TimelineScheduled extends TimelineBase {
  kind: 'scheduled';
  /** Absent for a landlord nudge with no 1:1 yet. */
  conversationId?: string;
  source: 'tour_reminder' | 'placement_nudge';
  reminderKind?: 'confirmation' | 'day_before' | 'morning_of' | 'en_route' | 'no_show_checkin';
  nudgeKind?: 'receipt_check' | 'completion_check' | 'approval_check' | 'rta_window_closing';
  body: string;
  /** Present when the message is armed but will be skipped at fire time. */
  suppression?: { reason: 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage' };
  refType: 'tour' | 'placement';
  refId: string;
}
export type TimelineItem = TimelineMessage | TimelineCall | TimelineMilestone | TimelineScheduled;

export interface ContactTimelinePage {
  items: TimelineItem[]; // chronological; client renders oldest→newest
  nextCursor: string | null;
  /** Not-yet-sent scheduled messages (the pinned "Upcoming" section). Absent on
   *  an older backend that predates the bucket → the client defaults to []. */
  upcoming?: TimelineScheduled[];
}

// --- C4: Sent-to-tenants / listings-sent (§API Contract C4) -----------------
// Copied verbatim from the build plan §C4. The tenant file's "Properties sent".

export type ListingResponse = 'interested' | 'not_a_fit' | 'no_reply';
export interface ListingSendRow {
  contactId: string;
  unitId: string;
  response: ListingResponse;
  sentAt: string; // ISO
  via: 'broadcast' | 'individual';
  broadcastId?: string;
}

/** Result of POST /api/conversations/:id/messages (legacy reuse). */
export interface SendMessageResult {
  conversationId: string;
  providerSid: string;
  tsMsgId: string;
  status: DeliveryStatus;
}

// --- C5: Media aggregation (§API Contract C5) -------------------------------
// Copied verbatim from the build plan §C5. The "Media from comms" card.

export interface ContactMediaItem {
  s3Key: string;
  contentType: string;
  at: string;
  conversationId: string;
}

// --- Relay-group memberships (the contact file's "Group texts" card) --------
// Copied verbatim from the backend wire shape (routes/contacts.ts
// RelayGroupRow — GET /api/contacts/:id/relay-groups). One row per relay_group
// thread whose roster includes this contact (matched server-side by contactId
// OR any of the contact's numbers), open AND closed, newest-activity-first.

export interface RelayGroupRow {
  conversationId: string;
  /** A closed group released its pool number; the membership remains context. */
  status: 'open' | 'closed';
  /** The pool number fronting the thread — absent once closed. */
  poolNumber?: string;
  memberCount: number;
  lastActivityAt: string; // ISO
  /** The owning entity — the card's link target (tour/placement detail).
   *  `{ type: null }` = a standalone group (no link). */
  owner: { type: 'tour' | 'placement' | null; id?: string };
  /** Operator label stamped at provisioning (e.g. the placement tag). */
  tag?: string;
  /** The OTHER members' resolved display names (known names only — no phones). */
  otherMemberNames: string[];
}

// --- C3: Unit ↔ contacts roster + related (§API Contract C3) ----------------
// Copied verbatim from the build plan §C3. The property page's Contacts roster
// (landlord/PM, each opening their contact page) + Related-properties panel.
// UnitItem gains an optional `contacts[]` (BE3); legacy `landlordId` stays = the
// primary landlord, which the page uses as a single-row FALLBACK until BE3 lands.

export interface UnitContact {
  contactId: string;
  role: 'landlord' | 'pm' | 'owner' | 'other';
  primaryVoice: boolean; // the ☎ primary
  name?: string;
  company?: string; // denormalized for the roster row
}
// UnitItem gains: contacts?: UnitContact[]   (legacy landlordId stays = the primary landlord)
export interface RelatedUnit {
  unitId: string;
  address?: Address | string; // reuse legacy
  status: UnitStatus; // reuse legacy
  relation: 'same_property' | 'same_landlord';
  label?: string; // "Same building (duplex)"
}

// --- C6: Similar properties (§API Contract C6) --------------------------------
// Copied verbatim from the build plan §C6. The property page's "Similar properties"
// comps panel. 404s until BE6 lands → an honest pending state.

export interface SimilarUnit {
  unitId: string;
  address?: Address | string;
  status: UnitStatus;
  matchPct: number;
  summary: string;
}

// --- Unit activity (the property page's Activity card) -----------------------
// MIRRORS app/src/routes/units.ts UnitActivityEvent — one unit AUDIT-trail row
// projected onto the wire (fixed-key whitelist, never the raw audit payload).
// 404s on older deployed backends → an honest pending state.

/** One property Activity row. `type` is the audit event_type — an OPEN set;
 *  today: unit_created, unit_updated, unit_contact_added, unit_contact_removed,
 *  listing_response_set, listing_status_changed, unit_deleted, unit_restored.
 *  Unknown types must still render (humanized), never blank. */
export interface UnitActivityEvent {
  /** The audit ts sort key — unique within the unit (a stable React key). */
  id: string;
  /** ISO 8601 — when the event happened. */
  at: string;
  type: string;
  /** The acting user, when the event wasn't a system action. */
  actorId?: string;
  contactId?: string;
  /** Server-resolved display name (best-effort) — absent when unknown. */
  contactName?: string;
  role?: string;
  response?: string;
  fields?: string[];
  from?: string;
  to?: string;
  source?: string;
}

// --- Broadcasts (the "Share properties to tenants" surface) -----------------
// MIRRORS app/src/routes/broadcasts.ts + app/src/repos/broadcastsRepo.ts — the
// wire shapes the broadcasts router exchanges. The dashboard is a separate
// package and cannot import from app/src, so these are duplicated; keep them in
// sync when the backend contract changes. PII: the preview/results responses
// carry phones (authed/internal — the operator must see the audience); never
// console.log a phone/name/body (rendering them in the UI is fine).

/** The CLIENT send shape for an audience filter — contact_type is fixed
 *  'tenant' (M1.8 targets tenants only); housing_authority/bedroomSize are
 *  optional narrowers. The server FILLS excludeOptedOut/excludeUnreachable
 *  (always-on hard fences) — the client never sends them. */
export interface AudienceFilter {
  contact_type: 'tenant';
  /** Tenant housing authority (the byHousingAuthority GSI key). */
  housing_authority?: string;
  /** Approved bedroom size to match against the tenant's voucherSize (0=Studio). */
  bedroomSize?: number;
}

/** The merge-field tokens the message editor can insert (interpolated at send
 *  time by the backend's mergeFields). [FlyerLink] resolves only when the
 *  broadcast carries a unitId. */
export const BROADCAST_MERGE_FIELDS = [
  '[TenantName]',
  '[Beds]',
  '[Address]',
  '[Rent]',
  '[FlyerLink]',
] as const;
export type BroadcastMergeField = (typeof BROADCAST_MERGE_FIELDS)[number];

/** A broadcast's lifecycle status (byStatus GSI partition values). */
export type BroadcastStatus = 'draft' | 'sending' | 'sent' | 'failed';

/** The delivery rollup carried on a summary / results row. */
export interface BroadcastStats {
  /** The resolved audience size at send time. */
  audience: number;
  sent: number;
  delivered: number;
  failed: number;
  /** Recipients dropped because they opted out between resolve + send. */
  skipped_opted_out: number;
  queued: number;
}

/** GET /api/broadcasts → one list-row summary (no recipients map). */
export interface BroadcastSummary {
  broadcastId: string;
  status: BroadcastStatus;
  /** The property this broadcast is about, or null (audience-only broadcast). */
  unitId: string | null;
  audience_filter: AudienceFilter;
  stats: BroadcastStats;
  created_at: string;
  /** The userId that created the broadcast. */
  created_by: string;
}

/** GET /api/broadcasts page. */
export interface BroadcastsPage {
  broadcasts: BroadcastSummary[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

/** The per-recipient delivery slot in the results map (keyed by contactKey —
 *  the contactId, else `phone#<E164>` for a phone-only recipient). */
export interface BroadcastRecipient {
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped';
  conversationId?: string;
  tsMsgId?: string;
  /** Twilio error class on a failure (mapped to a reason for display). */
  errorCode?: string;
}

/** GET /api/broadcasts/:id/results — stats + the per-recipient delivery map. */
export interface BroadcastResults {
  broadcastId: string;
  status: BroadcastStatus;
  unitId: string | null;
  audience_filter: AudienceFilter;
  stats: BroadcastStats;
  /** contactKey → delivery slot. Key is the contactId (usual) else `phone#<E164>`. */
  recipients: Record<string, BroadcastRecipient>;
  last_error?: string;
  created_at: string;
}

/** A flattened recipient row for rendering (the results map entries, with the
 *  contactKey split into its contactId / phone form). A `contactId` row links
 *  to /contacts/:contactId; a `phone`-only row renders without a link. */
export interface BroadcastRecipientView {
  /** The raw map key (contactId or `phone#<E164>`). */
  contactKey: string;
  /** Present when the key is a real contactId (links to the contact's comms). */
  contactId?: string;
  /** Present when the key is `phone#<E164>` (a contact-less recipient). */
  phone?: string;
  status: BroadcastRecipient['status'];
  errorCode?: string;
  conversationId?: string;
}

/** POST /api/broadcasts/:id/preview → one candidate row (the full annotated
 *  list, bounded by the recipient cap). `alreadySentThisProperty` is a SOFT
 *  flag (a prior sent/sending broadcast for this unit already included them). */
export interface PreviewCandidate {
  contactId: string;
  firstName?: string;
  phone: string;
  voucherSize?: number;
  housingAuthority?: string;
  alreadySentThisProperty: boolean;
  /** A2P/CTIA consent (CONTRACT 3): whether this candidate has recorded SMS
   *  consent. `false` → the row is fenced out of the send + surfaced for staff to
   *  resolve (a broadcast can't pop a modal mid-fan-out). */
  has_consent: boolean;
}

/** POST /api/broadcasts/:id/preview response. `priorRecipientContactIds` is the
 *  set already sent for this unit (so a MANUALLY-added tenant can be annotated
 *  client-side). `truncated` warns the audience hit the page/recipient cap. */
export interface PreviewResponse {
  count: number;
  truncated: boolean;
  candidates: PreviewCandidate[];
  priorRecipientContactIds: string[];
}

/** GET /api/events 'broadcast.updated' payload. The send job + delivery rollup
 *  emit this with the live status + stats (NO per-recipient detail — the
 *  Results view refetches getBroadcastResults to pick up recipient changes).
 *  NO PII — never logged. */
export interface BroadcastUpdatedEvent {
  broadcastId: string;
  status: BroadcastStatus;
  stats: BroadcastStats;
}

// --- C8: Inbox feed (§API Contract C8) --------------------------------------
// Copied verbatim from the spec (2026-06-17-inbox-design.md §C8). The entity-
// centric inbox: ONE row per contact (or one untriaged unknown number),
// newest-activity-first, aggregating all of a contact's numbers. GET /api/inbox
// 404s until the BE7/C8 slice lands → useInbox degrades to an honest 'pending'.

export type InboxFilter = 'all' | 'unread' | 'unknown' | 'mine';
export type InboxChannel = 'sms' | 'mms' | 'call';

export interface InboxRow {
  kind: 'contact' | 'unknown';
  contactId?: string; // present when kind='contact'
  phone?: string; // E.164; the number (esp. for unknown rows)
  name: string; // contact name, or formatted number when unknown
  role?: 'tenant' | 'landlord' | 'unknown';
  placementContext?: { placementId: string; label: string }; // e.g. "Touring" — optional
  unreadCount: number; // aggregate across ALL of the contact's numbers
  preview: string; // latest item's text as a preview (UI shows one line, ellipsized)
  channel: InboxChannel; // channel of the latest item
  direction: 'inbound' | 'outbound'; // 'outbound' → render "You: …"
  lastActivityAt: string; // ISO; sort key (newest first)
  assignment?: { userId: string; name: string }; // the Assigned chip
  needsTriage: boolean; // true for untriaged unknowns
}

export interface InboxPage {
  rows: InboxRow[]; // newest-activity-first; ONE row per contact
  nextCursor: string | null;
}
