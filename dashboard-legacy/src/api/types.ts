// API entity types — the single source of truth for every shape the dashboard
// exchanges with the backend (/api, /auth). Mirrors the server contract exactly
// (app/src/routes/*, app/src/repos/*). Feature agents IMPORT from here and
// MUST NOT edit this file.
//
// Field names match the wire JSON the server actually emits (verified against
// the route serializers), NOT a normalized client model — e.g. the inbox
// summary's preview field is `preview`, delivery state is `delivery_status`.

// --- Enums / unions ---------------------------------------------------------

/** Conversation thread type. `unknown_1to1` is the honest-identity value: a
 *  thread whose participant has not been triaged to tenant/landlord yet.
 *  `relay_group` (M1.7) is a multi-party masked thread fronted by a pool number:
 *  inbound on the pool number fans out to the other members. */
export type ConversationType =
  | 'tenant_1to1'
  | 'landlord_1to1'
  | 'unknown_1to1'
  | 'relay_group';

/** A relay group's lifecycle status (M1.7). `closed` released its pool number. */
export type RelayStatus = 'open' | 'closed';

/** Contact identity type. `unknown` = auto-captured, awaiting human triage. */
export type ContactType = 'tenant' | 'landlord' | 'pm' | 'team_member' | 'unknown';

/** Message transport. `call` (M1.9) is a metadata-only voice-call timeline entry
 *  (not an SMS/MMS body) — see the call-specific fields on Message. */
export type MessageType = 'sms' | 'mms' | 'call';

/** Message direction relative to the platform. */
export type MessageDirection = 'inbound' | 'outbound';

/**
 * Voice call lifecycle (M1.9). Mirrors Twilio's CallStatus values verbatim, so
 * the server's status-callback mapping is identity. Present only on a
 * `type:'call'` Message.
 */
export type CallStatus =
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'no-answer'
  | 'busy'
  | 'failed'
  | 'canceled';

/**
 * Coarse human-facing call outcome (M1.9): `answered` (a leg connected),
 * `missed` (nobody answered / busy / failed), `voicemail` (founder-bridge seam).
 * This is what the timeline badge renders.
 */
export type CallOutcome = 'answered' | 'missed' | 'voicemail';

/** Who authored a message. `unknown` = from an un-triaged contact (never guessed). */
export type MessageAuthor = 'tenant' | 'landlord' | 'teammate' | 'ai' | 'unknown';

/** Outbound delivery state machine (doc §7.1). `sent` is NOT `delivered`. */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/** Team role. admin = the founder role; va = virtual assistant. */
export type UserRole = 'admin' | 'va';

/** User lifecycle. `invited` = pre-created, never signed in; `active` = has logged in. */
export type UserStatus = 'invited' | 'active';

// --- Auth -------------------------------------------------------------------

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

// --- Conversations ----------------------------------------------------------

/** A linked external participant: contact + phone pair. For relay groups (M1.7)
 *  this array is the mutable member roster and each member may carry an optional
 *  `name` (the sender-prefix display name resolved from the contact at add time;
 *  absent when no name is known — honest identity falls back to the phone). */
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

/** A full conversation item (GET /api/conversations/:id → { conversation }).
 *  Flexible document on the server; the contractual/commonly read fields are
 *  typed, the index signature carries the rest. */
export interface Conversation {
  conversationId: string;
  participant_phone: string;
  /** 1:1 threads only ever write `open`; relay_group threads use `open` |
   *  `closed` (see RelayStatus). Typed as string to match the flexible wire. */
  status: string;
  last_activity_at: string;
  type: ConversationType;
  ai_mode: 'auto' | 'manual';
  sms_opt_out?: boolean;
  last_message_preview?: string;
  participants?: ConversationParticipant[];
  unread_count?: number;
  assignment?: string;
  /** Relay group (M1.7): the masked pool number fronting the thread (E.164),
   *  present only while a relay_group is open; cleared on close. Absent on 1:1. */
  pool_number?: string;
  created_at: string;
  [key: string]: unknown;
}

// --- Messages ---------------------------------------------------------------

/**
 * Per-recipient delivery state for a relay-group fan-out (M1.7). A relayed
 * message is stored ONCE; this records the outbound delivery to each OTHER
 * member, keyed by member key (contactId else `phone#<E164>`). Each entry runs
 * the same forward-only status machine as 1:1 `delivery_status`, independently.
 */
export interface RelayRecipientDelivery {
  status: DeliveryStatus;
  /** Provider SID of the per-recipient outbound send (Twilio SMxxx). */
  sid?: string;
  errorCode?: string;
  sentAt?: string;
  deliveredAt?: string;
}

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
  /** Mirrored MMS attachments (key + stored content-type, together). Supersedes
   *  media_s3_keys; the type drives inline-image vs PDF vs download rendering. */
  media_attachments?: { s3Key: string; contentType: string }[];
  /** @deprecated Legacy parallel key array (pre-media_attachments). */
  media_s3_keys?: string[];
  provider_sid: string;
  provider_ts: string;
  delivery_status: DeliveryStatus;
  /** Twilio error code on a failed/undelivered send (e.g. '30005'). */
  error_code?: string;
  /** Set on a retry send: the tsMsgId of the message being retried. */
  retry_of?: string;
  retry_attempt?: number;
  /**
   * Relay group (M1.7): on an INBOUND relay message, the member key
   * (contactId else `phone#<E164>`) of the sender — which member texted the
   * pool number. Attribution resolves this against the roster (never the body).
   * Absent on 1:1 messages.
   */
  relay_sender_key?: string;
  /**
   * Relay group (M1.7): true when this inbound arrived on a CLOSED relay thread
   * (a late reply, persisted but not fanned out). Absent otherwise.
   */
  received_on_closed_thread?: boolean;
  /**
   * Relay group (M1.7): per-recipient fan-out delivery state of THIS message to
   * the other members, keyed by member key. Present on relayed inbound + team
   * messages; absent on 1:1 (whose single `delivery_status` is unchanged).
   */
  delivery_recipients?: Record<string, RelayRecipientDelivery>;

  // --- Voice call (M1.9) — present only on a type:'call' entry --------------
  // A call entry is a metadata-only timeline item. `provider_sid` carries the
  // Twilio CallSid. PII (doc §9): NEVER a raw counterpart phone — the masked
  // call_party_label below is a role/name only, and the recording is served
  // through the auth-gated /api/calls/:callId/recording endpoint (never a URL
  // here). The recording/transcript fields appear ONLY on masked:false
  // founder-bridge calls — masked relay calls are never recorded/transcribed.
  /** Twilio call lifecycle status (the status callback advances it forward-only). */
  call_status?: CallStatus;
  /** Coarse outcome (answered/missed/voicemail) — drives the timeline badge. */
  call_outcome?: CallOutcome;
  /** When the call leg was first seen (ISO 8601). */
  started_at?: string;
  /** When a leg connected (ISO 8601); absent until answered. */
  answered_at?: string;
  /** When the call ended (ISO 8601); absent until completion. */
  ended_at?: string;
  /** Connected duration in whole seconds (Twilio CallDuration). */
  call_duration?: number;
  /** True for masked relay-pool calls (NEVER recorded/transcribed). */
  masked?: boolean;
  /** MASKED party label (counterpart role/name) — NEVER a raw phone (PII). */
  call_party_label?: string;
  /**
   * S3 key of the mirrored recording (founder-bridge calls only). Its PRESENCE
   * is the signal that a playable recording exists — render the player only when
   * set; the bytes are fetched via callRecordingUrl()/the auth-gated endpoint.
   */
  recording_s3_key?: string;
  /** Recording duration in whole seconds (founder-bridge calls only). */
  recording_duration?: number;
  /**
   * VERBATIM call transcript (founder-bridge calls only; never on masked calls).
   * Render the collapsible transcript section only when present.
   */
  transcript?: string;
  created_at: string;
  [key: string]: unknown;
}

/** Result of POST /api/conversations/:id/messages. */
export interface SendMessageResult {
  conversationId: string;
  providerSid: string;
  tsMsgId: string;
  status: DeliveryStatus;
}

// --- Calls (M1.9) -----------------------------------------------------------

/**
 * GET /api/calls/:callId → { call, conversation }. `callId` is the Twilio
 * CallSid (== the call entry's provider_sid). `call` is the metadata-only
 * `type:'call'` Message; `conversation` is the thread it belongs to, or null
 * when the call entry points at a conversation that no longer exists (the
 * server surfaces the call alone rather than a hard 404). The quick-reply seam
 * reads conversation.conversationId to resolve a missed-call deep link.
 */
export interface CallResponse {
  call: Message;
  conversation: Conversation | null;
}

// --- Relay groups (M1.7) ----------------------------------------------------

/** One member in a create-relay-group / add-member request. `phone` is required;
 *  `contactId` links an existing contact; `name` is the optional display name. */
export interface RelayMemberInput {
  phone: string;
  contactId?: string;
  name?: string;
}

/** POST /api/relay-groups body. At least one member is required. `tag` is an
 *  optional placement label stored for operators. */
export interface CreateRelayGroupBody {
  members: RelayMemberInput[];
  tag?: string;
}

/** POST /api/relay-groups result → { conversation }. */
export interface CreateRelayGroupResult {
  conversation: Conversation;
}

/** GET /api/conversations/:id/members and the add/remove mutations →
 *  { members }. The current roster after the operation. */
export interface RelayMembersResult {
  members: ConversationParticipant[];
}

/** PATCH /api/conversations/:id/close body. */
export interface SetRelayClosedBody {
  closed: boolean;
}

// --- Contacts ---------------------------------------------------------------

/** A contact (GET /api/contacts/:id → { contact }). Flexible document. */
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
  [key: string]: unknown;
}

/** PATCH /api/contacts/:id body. Send EITHER structured fields OR a raw
 *  "First Last - N Bed" string via contactName (the server parses it). */
export interface ContactPatch {
  type?: ContactType;
  firstName?: string;
  lastName?: string;
  voucherSize?: number;
  status?: string;
  notes?: string;
  /** "First Last - N Bed" convention string; parsed server-side. */
  contactName?: string;
}

/** GET /api/contacts page (the records list). */
export interface ContactsPage {
  contacts: Contact[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

/** POST /api/contacts body. `type` is required; the rest are optional. */
export interface CreateContactBody {
  type: ContactType;
  firstName?: string;
  lastName?: string;
  phone?: string;
  voucherSize?: number;
  notes?: string;
  status?: string;
  /** "First Last - N Bed" convenience string; parsed server-side. */
  contactName?: string;
}

// --- Units -------------------------------------------------------------------

/** A structured US postal address. Every part is optional — intake is
 *  partial-by-design. Shared shape: tenant/contact addresses can adopt it.
 *  Matches the backend contract exactly. */
export interface Address {
  /** Street address line 1. */
  line1?: string;
  /** Unit / apt #. */
  line2?: string;
  city?: string;
  /** 2-letter US state. */
  state?: string;
  zip?: string;
}

/** A unit's lifecycle status. */
export type UnitStatus = 'available' | 'placed' | 'inactive';

/** A unit record (GET /api/units → { units }, GET /api/units/:id →
 *  { unit }). Flexible document on the server; the contractual fields are typed
 *  and the index signature carries anything extra. Most fields are free-form /
 *  optional because intake is partial-by-design. */
export interface UnitItem {
  unitId: string;
  landlordId: string;
  status: UnitStatus;
  jurisdiction?: string;
  /** Structured street address. A pre-contract dev record may still carry a
   *  plain string here — read views tolerate that (see AddressDisplay). */
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
  lif?: string;
  utilities?: string;
  accessibility?: string;
  pets?: string;
  priority?: string;
  /** S3 keys / URLs of listing media. */
  media?: string[];
  listing_link?: string;
  tour_process?: string;
  application_process?: string;
  /** contactId of the landlord/pm to call (pending confirmation). */
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

/** POST /api/units body — landlordId is required, status defaults to
 *  'available' server-side; every other field is an optional intake field. */
export interface CreateUnitBody {
  landlordId: string;
  status?: UnitStatus;
  jurisdiction?: string;
  address?: Address;
  accepted_programs?: string[];
  beds?: number;
  baths?: number;
  area?: string;
  subzone?: string;
  rent_min?: number;
  rent_max?: number;
  payment_standard?: number;
  deposit?: number;
  lif?: string;
  utilities?: string;
  accessibility?: string;
  pets?: string;
  priority?: string;
  media?: string[];
  listing_link?: string;
  tour_process?: string;
  application_process?: string;
  primary_voice_contact?: string;
}

/** PATCH /api/units/:id body — any subset of the create fields. */
export type UnitPatch = Partial<CreateUnitBody>;

// --- Public (no auth) -------------------------------------------------------

/** GET /public/units/:unitId/flyer → { flyer }. The shareable public subset of
 *  a unit (no internal fields). */
export interface UnitFlyer {
  unitId: string;
  media: string[];
  beds?: number;
  baths?: number;
  area?: string;
  subzone?: string;
  voucher_size?: number;
  accepted_programs: string[];
  listing_link?: string;
  rent_min?: number;
  rent_max?: number;
}

/** POST /public/housing-fair body — the public housing-fair signup. */
export interface HousingFairSignup {
  firstName: string;
  lastName: string;
  phone: string;
  voucherSize?: number;
}

// --- Users (admin) ----------------------------------------------------------

/** The admin-list projection of a user (GET /api/users). No secrets. */
export interface AdminUser {
  userId: string;
  email: string;
  role: UserRole;
  status: UserStatus | null;
  created_at: string;
  last_login_at: string | null;
}

/** POST /api/users result. `created` is false when the invite already existed. */
export interface InviteUserResult {
  user: AdminUser;
  created: boolean;
}

/** PATCH /api/users/:userId/role result. `changed` is false on a no-op. */
export interface ChangeRoleResult {
  user: AdminUser;
  changed: boolean;
}

// --- Settings ---------------------------------------------------------------

/** Founder-editable org settings (GET/PUT /api/settings → { settings }). */
export interface OrgSettings {
  missedCallAutoText: string;
  missedCallAutoTextEnabled: boolean;
  quickReplies: string[];
  /**
   * LOAD-BEARING founder call-triage timing (M1.9b): the <Pause> (whole seconds)
   * before the founder's cell is dialed, so the pre-ring push lands ~this-many
   * seconds AHEAD of the ring. Editable in the Settings panel; range 0..10.
   */
  preRingPauseSeconds: number;
}

export type OrgSettingsPatch = Partial<OrgSettings>;

// --- Push -------------------------------------------------------------------

/** POST /api/push/test result. */
export interface PushTestResult {
  configured: boolean;
  attempted: number;
  sent: number;
  pruned: number;
  failed: number;
}

// --- SSE --------------------------------------------------------------------

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

/** GET /api/events 'message.persisted' payload. */
export interface MessagePersistedEvent {
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  deliveryStatus: DeliveryStatus;
}

/** GET /api/events 'broadcast.updated' payload (M1.8). Emitted from the
 *  broadcast.send job (on completion) and the delivery-callback rollup so the
 *  results view updates the lifecycle status + rolled-up stats live. NO PII
 *  (counts only) — never logged. */
export interface BroadcastUpdatedEvent {
  broadcastId: string;
  status: BroadcastStatus;
  stats: BroadcastStats;
}

// --- Broadcasts (M1.8 "Share Listings") -------------------------------------
// The filtered share-broadcast: text a unit's flyer to a filtered set of
// tenant 1:1 contacts. Mirrors app/src/repos/broadcastsRepo.ts +
// app/src/routes/broadcasts.ts + app/src/services/audienceResolution.ts.

/** Broadcast lifecycle status (byStatus GSI hash on the server). */
export type BroadcastStatus = 'draft' | 'sending' | 'sent' | 'failed';

/** Per-recipient delivery status on a broadcast (its own forward-only machine;
 *  `skipped` = dropped at send for opt-out/unreachable, no token spent). */
export type BroadcastRecipientStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped';

/**
 * The audience filter snapshot (M1.8). contact_type is fixed 'tenant' (never
 * relay rosters); housing_authority + bedroomSize are optional narrowers;
 * excludeOptedOut + excludeUnreachable are ALWAYS true (the server enforces it
 * — the booleans record the intent for the audit trail).
 */
export interface AudienceFilter {
  contact_type: 'tenant';
  housing_authority?: string;
  bedroomSize?: number;
  excludeOptedOut: boolean;
  excludeUnreachable: boolean;
}

/** Rolled-up send/delivery counters the results view renders. */
export interface BroadcastStats {
  /** Resolved audience size at send time. */
  audience: number;
  /** Provider-accepted sends (queued/sent at the adapter). */
  sent: number;
  /** Delivery callbacks that reached `delivered`. */
  delivered: number;
  /** Sends that failed (carrier filter / invalid number / cap). */
  failed: number;
  /** Recipients skipped at send time for opt-out/unreachable (no token spent). */
  skipped_opted_out: number;
  /** Recipients still queued (pre-send seed / transient deferral). */
  queued: number;
}

/** Per-recipient delivery slot on a broadcast (keyed by contactKey = contactId
 *  else `phone#<E164>`). */
export interface BroadcastRecipient {
  status: BroadcastRecipientStatus;
  /** The tenant's 1:1 conversation the message landed in (set at send). */
  conversationId?: string;
  /** The persisted message's SK (delivery-callback rollup target). */
  tsMsgId?: string;
  errorCode?: string;
}

/** A broadcast list-row summary (GET /api/broadcasts → broadcasts[]). No
 *  recipients map — that lives on the results view. */
export interface BroadcastSummary {
  broadcastId: string;
  status: BroadcastStatus;
  /** The shared unit, or null for a unit-less broadcast. */
  unitId: string | null;
  audience_filter: AudienceFilter;
  stats: BroadcastStats;
  /** ISO 8601. */
  created_at: string;
  /** The acting user's userId. */
  created_by: string;
}

/** The results-view projection of a broadcast (GET /api/broadcasts/:id/results). */
export interface BroadcastResults {
  broadcastId: string;
  status: BroadcastStatus;
  /** The shared unit, or null. */
  unitId: string | null;
  audience_filter: AudienceFilter;
  stats: BroadcastStats;
  /** contactKey → per-recipient delivery slot. */
  recipients: Record<string, BroadcastRecipient>;
  last_error?: string;
  created_at: string;
}

/** GET /api/broadcasts page. */
export interface BroadcastsPage {
  broadcasts: BroadcastSummary[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

/** POST /api/broadcasts body — body_template is required; unitId +
 *  audience_filter narrowers are optional. */
export interface CreateBroadcastBody {
  body_template: string;
  unitId?: string;
  audience_filter?: {
    housing_authority?: string;
    bedroomSize?: number;
  };
}

/** POST /api/broadcasts result → 201 (a fresh draft + audience estimate). */
export interface CreateBroadcastResult {
  broadcastId: string;
  status: 'draft';
  /** The estimated audience reach at draft time. */
  estimatedCount: number;
  /** True when resolution hit the page cap — the estimate is INCOMPLETE. */
  truncated: boolean;
}

/** One sampled contact in a preview response. Honest identity: firstName may be
 *  absent — fall back to the formatted phone. */
export interface BroadcastPreviewSample {
  contactId: string;
  firstName?: string;
  phone: string;
}

/** POST /api/broadcasts/:id/preview result — the live audience count + a sample. */
export interface BroadcastPreviewResult {
  count: number;
  /** True when resolution hit the page cap — the set is INCOMPLETE / over-cap. */
  truncated: boolean;
  sample: BroadcastPreviewSample[];
}

/** POST /api/broadcasts/:id/send result (200). */
export interface SendBroadcastResult {
  broadcastId: string;
  status: 'sending';
  count: number;
}

/** The 400 `audience_too_large` error body (over the recipient cap OR truncated). */
export interface AudienceTooLargeError {
  error: 'audience_too_large';
  message: string;
  count: number;
  truncated: boolean;
}

// --- Cases / boards (M1.10) -------------------------------------------------
// A "case" is one tenant↔unit deal moving through a stage ladder (the boards
// are staff-facing). Mirrors app/src/repos/casesRepo.ts +
// app/src/routes/cases.ts + app/src/lib/events.ts. Field names are the wire JSON
// the server emits (snake_case where shown: tour_date, next_deadline_type,
// next_deadline_at, group_thread, placement_tag, lost_reason, lease_date,
// move_in_date) — NOT a normalized client model.

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
