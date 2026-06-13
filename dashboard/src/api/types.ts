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
 *  thread whose participant has not been triaged to tenant/landlord yet. */
export type ConversationType = 'tenant_1to1' | 'landlord_1to1' | 'unknown_1to1';

/** Contact identity type. `unknown` = auto-captured, awaiting human triage. */
export type ContactType = 'tenant' | 'landlord' | 'pm' | 'team_member' | 'unknown';

/** Message transport. */
export type MessageType = 'sms' | 'mms';

/** Message direction relative to the platform. */
export type MessageDirection = 'inbound' | 'outbound';

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

// --- Conversations ----------------------------------------------------------

/** A linked external participant: contact + phone pair. */
export interface ConversationParticipant {
  contactId: string;
  phone: string;
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
  status: string;
  last_activity_at: string;
  type: ConversationType;
  ai_mode: 'auto' | 'manual';
  sms_opt_out?: boolean;
  last_message_preview?: string;
  participants?: ConversationParticipant[];
  unread_count?: number;
  assignment?: string;
  created_at: string;
  [key: string]: unknown;
}

// --- Messages ---------------------------------------------------------------

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
  /** S3 keys of mirrored MMS media. */
  media_s3_keys?: string[];
  provider_sid: string;
  provider_ts: string;
  delivery_status: DeliveryStatus;
  /** Twilio error code on a failed/undelivered send (e.g. '30005'). */
  error_code?: string;
  /** Set on a retry send: the tsMsgId of the message being retried. */
  retry_of?: string;
  retry_attempt?: number;
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
}

/** GET /api/events 'message.persisted' payload. */
export interface MessagePersistedEvent {
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  deliveryStatus: DeliveryStatus;
}
