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

/** Who authored a message. `unknown` = from an un-triaged contact (never guessed). */
export type MessageAuthor = 'tenant' | 'landlord' | 'teammate' | 'ai' | 'unknown';

/** Message transport. `call` is a metadata-only voice-call timeline entry. */
export type MessageType = 'sms' | 'mms' | 'call';

/** Coarse human-facing call outcome: `answered` (a leg connected), `missed`
 *  (nobody answered / busy / failed), `voicemail` (founder-bridge seam). */
export type CallOutcome = 'answered' | 'missed' | 'voicemail';

/** Contact identity type. `unknown` = auto-captured, awaiting human triage. */
export type ContactType = 'tenant' | 'landlord' | 'team_member' | 'unknown';

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

/** POST /api/contacts — create a brand-new contact record. */
export interface ContactCreate {
  type: ContactType;
  firstName?: string;
  lastName?: string;
  phone?: string;
  voucherSize?: number;
  company?: string;
  role?: string;
  relationships?: Relationship[];
  customFields?: CustomField[];
}

// --- Contacts (legacy reuse — verbatim from the proven contract) -------------
// Copied from dashboard-legacy/src/api/types.ts. The contact detail page reads
// type/status/phone/firstName/lastName/voucherSize/notes off this flexible doc.

/** A contact (GET /api/contacts/:id → { contact }). Flexible document. C1 adds
 *  an optional `phones[]`; when absent, synthesize [{phone, primary:true}]. */
export interface Contact {
  contactId: string;
  type: ContactType;
  status?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  voucherSize?: number;
  notes?: string;
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  capture_source?: string;
  captured_at?: string;
  created_at?: string;
  /** C1: when the backend ships multiple numbers (BE1). Absent on legacy. */
  phones?: ContactPhone[];
  /** Landlord/PM company name (editable). */
  company?: string;
  /** Tenant housing authority (camelCase — the byHousingAuthority GSI key). */
  housingAuthority?: string;
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
  /** Structured address; the server stores only the non-empty parts. */
  address?: Address;
  /** Contact's role within the organisation (e.g. case manager, property manager). */
  role?: string;
  /** Linked contacts (relationships) stored on this record. */
  relationships?: Relationship[];
  /** Operator-defined custom fields stored on this record. */
  customFields?: CustomField[];
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

/** A unit's lifecycle status. */
export type UnitStatus = 'available' | 'placed' | 'inactive';

/** A unit record (GET /api/units → { units }, GET /api/units/:id → { unit }).
 *  Flexible document; the landlord file reads landlordId/status/address/beds. */
export interface UnitItem {
  unitId: string;
  landlordId: string;
  status: UnitStatus;
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
  /** S3 keys / URLs of listing media (the Photos gallery + hero). */
  media?: string[];
  listing_link?: string;
  /** C3: the landlord/PM roster (BE3). Absent on legacy → fall back to the
   *  single `landlordId` for a one-row roster. */
  contacts?: UnitContact[];
  /** Free-text "how to tour" copy (the listing page's process card). */
  tour_process?: string;
  /** Free-text "how to apply" copy (the listing page's process card). */
  application_process?: string;
  primary_voice_contact?: string;
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
// Copied from dashboard-legacy/src/api/types.ts. The timeline fallback maps
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
  | 'case_opened'
  | 'case_closed'
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
  refType?: 'case' | 'unit' | 'conversation' | 'broadcast';
  refId?: string; // deep-link target (links out, no inline content)
}
export type TimelineItem = TimelineMessage | TimelineCall | TimelineMilestone;

export interface ContactTimelinePage {
  items: TimelineItem[]; // chronological; client renders oldest→newest
  nextCursor: string | null;
}

// --- C4: Sent-to-tenants / listings-sent (§API Contract C4) -----------------
// Copied verbatim from the build plan §C4. The tenant file's "Listings sent".

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

// --- C3: Unit ↔ contacts roster + related (§API Contract C3) ----------------
// Copied verbatim from the build plan §C3. The listing page's Contacts roster
// (landlord/PM, each opening their contact page) + Related-listings panel.
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

// --- C6: Similar listings (§API Contract C6) --------------------------------
// Copied verbatim from the build plan §C6. The listing page's "Similar listings"
// comps panel. 404s until BE6 lands → an honest pending state.

export interface SimilarUnit {
  unitId: string;
  address?: Address | string;
  status: UnitStatus;
  matchPct: number;
  summary: string;
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
  caseContext?: { caseId: string; label: string }; // e.g. "Touring" — optional
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
