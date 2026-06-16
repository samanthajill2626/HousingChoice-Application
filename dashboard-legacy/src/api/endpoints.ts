// Typed endpoint functions — one per route in the API contract. Every function
// returns a typed result and throws ApiError on non-2xx (see api/client.ts).
// Feature agents import these (via api/index.ts) and never construct fetch
// calls by hand.
import { request } from './client.js';
import type {
  AdminUser,
  BroadcastPreviewResult,
  BroadcastResults,
  BroadcastsPage,
  BroadcastStatus,
  CallResponse,
  CaseDeadlineType,
  CaseItem,
  CasesPage,
  CaseStage,
  ChangeRoleResult,
  Contact,
  ContactPatch,
  ContactsPage,
  ContactType,
  Conversation,
  ConversationParticipant,
  ConversationsPage,
  CreateBroadcastBody,
  CreateBroadcastResult,
  CreateContactBody,
  CreateRelayGroupBody,
  CreateUnitBody,
  DevLoginResult,
  HousingFairSignup,
  InviteUserResult,
  Me,
  Message,
  OrgSettings,
  OrgSettingsPatch,
  PushTestResult,
  RelayMemberInput,
  SendBroadcastResult,
  SendMessageResult,
  UnitFlyer,
  UnitItem,
  UnitPatch,
  UnitsPage,
  UnitStatus,
  UserRole,
} from './types.js';

// --- Auth (/auth) -----------------------------------------------------------

/** GET /auth/me — the current principal, or throws ApiError(401) when anonymous. */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return request<Me>('/auth/me', { ...(signal !== undefined && { signal }) });
}

/** POST /auth/logout — global session revocation (204). */
export function logout(): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST' });
}

/** The login URL — a plain navigation (the server drives the OAuth dance).
 *  Not a fetch: use `window.location.assign(loginUrl())` / an <a href>. */
export function loginUrl(): string {
  return '/auth/login';
}

// --- Dev-only auth (/__dev, /auth/dev-login) --------------------------------
// These reach the hermetic-LOCAL dev router, which is mounted ONLY in the local
// dev/e2e stack and is 404 (router absent) in every deployed env. The UI uses
// devPing() to decide whether to surface the dev-login affordance at all; it
// MUST fail closed (any non-200 / non-{dev:true} / error → unavailable).

/** GET /__dev/ping — availability probe for the hermetic dev router. Resolves
 *  `true` only on 200 with a `{ dev: true }` body; resolves `false` for any
 *  non-200, network/transport error, or malformed body (never throws). */
export async function devPing(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await request<{ dev?: unknown }>('/__dev/ping', {
      ...(signal !== undefined && { signal }),
    });
    return res !== null && typeof res === 'object' && res.dev === true;
  } catch {
    return false;
  }
}

/** POST /auth/dev-login — log in as a dev user (sets the session cookie). The
 *  server auto-provisions the user if missing, so this works on an unseeded
 *  local DB too (known personas keep their role; others default to admin). */
export function devLogin(email = 'va@example.com'): Promise<DevLoginResult> {
  return request<DevLoginResult>('/auth/dev-login', { method: 'POST', body: { email } });
}

// --- Conversations (/api/conversations) -------------------------------------

export interface ListConversationsParams {
  status?: string;
  limit?: number;
  cursor?: string | null;
}

/** GET /api/conversations — the inbox, newest-activity-first, paged. */
export function listConversations(
  params: ListConversationsParams = {},
  signal?: AbortSignal,
): Promise<ConversationsPage> {
  return request<ConversationsPage>('/api/conversations', {
    query: {
      status: params.status,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
    },
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/conversations/:id — one thread header. */
export async function getConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<Conversation> {
  const res = await request<{ conversation: Conversation }>(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.conversation;
}

export interface ListMessagesParams {
  limit?: number;
  /** Exclusive upper bound on tsMsgId — pass the oldest seen key to page back. */
  before?: string;
}

/** GET /api/conversations/:id/messages — newest-first page of the timeline. */
export async function listMessages(
  conversationId: string,
  params: ListMessagesParams = {},
  signal?: AbortSignal,
): Promise<Message[]> {
  const res = await request<{ messages: Message[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      query: { limit: params.limit, before: params.before },
      ...(signal !== undefined && { signal }),
    },
  );
  return res.messages;
}

export interface SendMessageBody {
  body?: string;
  mediaUrls?: string[];
}

/** POST /api/conversations/:id/messages — a manual human send. */
export function sendMessage(
  conversationId: string,
  payload: SendMessageBody,
): Promise<SendMessageResult> {
  return request<SendMessageResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: 'POST', body: payload },
  );
}

/** POST /api/conversations/:id/read — zero the unread counter. */
export async function markRead(conversationId: string): Promise<Conversation> {
  const res = await request<{ conversation: Conversation }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/read`,
    { method: 'POST' },
  );
  return res.conversation;
}

/** PATCH /api/conversations/:id/assignment — assign (userId) or unassign (null). */
export async function setAssignment(
  conversationId: string,
  assigneeUserId: string | null,
): Promise<Conversation> {
  const res = await request<{ conversation: Conversation }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/assignment`,
    { method: 'PATCH', body: { assigneeUserId } },
  );
  return res.conversation;
}

// --- Calls (M1.9) -----------------------------------------------------------

/** GET /api/calls/:callId — resolve a call (by Twilio CallSid == provider_sid)
 *  to its metadata-only call entry + the conversation it belongs to. The
 *  conversation is null when the call's thread no longer exists (the server
 *  surfaces the call alone). Throws ApiError(404,'call_not_found') when the
 *  CallSid is unknown / not a call. The quick-reply seam uses this to map a
 *  missed-call deep link (callId) to its conversation. */
export function getCall(callId: string, signal?: AbortSignal): Promise<CallResponse> {
  return request<CallResponse>(`/api/calls/${encodeURIComponent(callId)}`, {
    ...(signal !== undefined && { signal }),
  });
}

/**
 * The auth-gated, SAME-ORIGIN URL that streams a founder-bridge call's recording
 * (audio/mpeg) for playback. NOT a fetch helper: feed it straight to an
 * <audio controls src=…> — the browser request carries the session cookie
 * (same-origin), so the PII audio never transits a public/presigned URL. Only
 * use it when the call entry actually carries a recording_s3_key.
 */
export function callRecordingUrl(callId: string): string {
  return `/api/calls/${encodeURIComponent(callId)}/recording`;
}

// --- Relay groups (M1.7) ----------------------------------------------------
// VAs run relay threads day-to-day (no admin gate). The team-send into a relay
// reuses sendMessage() above — the server routes by conversation type, fanning
// the one message out to every member from the pool number.

/** POST /api/relay-groups — create a relay group (provisions a pool number +
 *  sends the intro), returning the new conversation. → 201 { conversation }.
 *  Throws ApiError(503,'pool_number_unavailable') when no voice number is free. */
export async function createRelayGroup(body: CreateRelayGroupBody): Promise<Conversation> {
  const res = await request<{ conversation: Conversation }>('/api/relay-groups', {
    method: 'POST',
    body,
  });
  return res.conversation;
}

/** GET /api/conversations/:id/members — the current relay roster. Throws
 *  ApiError(404,'relay_group_not_found') for a 1:1 / unknown conversation. */
export async function getRelayMembers(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationParticipant[]> {
  const res = await request<{ members: ConversationParticipant[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.members;
}

/** POST /api/conversations/:id/members — idempotent add; returns the new roster.
 *  Throws ApiError(409,'roster_conflict') on a concurrency conflict. */
export async function addRelayMember(
  conversationId: string,
  member: RelayMemberInput,
): Promise<ConversationParticipant[]> {
  const res = await request<{ members: ConversationParticipant[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members`,
    { method: 'POST', body: member },
  );
  return res.members;
}

/** DELETE /api/conversations/:id/members/:phone — idempotent remove; returns the
 *  new roster. The phone is the member's E.164 (path-segment encoded). */
export async function removeRelayMember(
  conversationId: string,
  phone: string,
): Promise<ConversationParticipant[]> {
  const res = await request<{ members: ConversationParticipant[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(phone)}`,
    { method: 'DELETE' },
  );
  return res.members;
}

/** PATCH /api/conversations/:id/close — close (release the pool number) or
 *  reopen (provision a fresh one). Returns the updated conversation. */
export async function setRelayClosed(
  conversationId: string,
  closed: boolean,
): Promise<Conversation> {
  const res = await request<{ conversation: Conversation }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/close`,
    { method: 'PATCH', body: { closed } },
  );
  return res.conversation;
}

// --- Contacts (/api/contacts) -----------------------------------------------

export interface ListContactsParams {
  /** Required by the backend UNLESS `phone` (exact lookup) is supplied. */
  type?: ContactType;
  status?: string;
  /** Exact-match phone lookup (E.164); skips the type requirement. */
  phone?: string;
  limit?: number;
  cursor?: string | null;
}

/** GET /api/contacts — the records list. `type` is required by the server
 *  unless `phone` (exact lookup) is given. */
export function listContacts(
  params: ListContactsParams = {},
  signal?: AbortSignal,
): Promise<ContactsPage> {
  return request<ContactsPage>('/api/contacts', {
    query: {
      type: params.type,
      status: params.status,
      phone: params.phone,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
    },
    ...(signal !== undefined && { signal }),
  });
}

/** POST /api/contacts — create a contact. Throws ApiError(409,'contact_exists')
 *  on a phone dedupe; the existing contact rides on `err.body.contact`. */
export async function createContact(body: CreateContactBody): Promise<Contact> {
  const res = await request<{ contact: Contact }>('/api/contacts', {
    method: 'POST',
    body,
  });
  return res.contact;
}

/** GET /api/contacts/:id — the side-panel contact item. */
export async function getContact(contactId: string, signal?: AbortSignal): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.contact;
}

/** PATCH /api/contacts/:id — triage an existing contact. */
export async function updateContact(contactId: string, patch: ContactPatch): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}`,
    { method: 'PATCH', body: patch },
  );
  return res.contact;
}

// --- Settings (/api/settings) -----------------------------------------------

/** GET /api/settings — VAs may view; admins may edit. */
export async function getSettings(signal?: AbortSignal): Promise<OrgSettings> {
  const res = await request<{ settings: OrgSettings }>('/api/settings', {
    ...(signal !== undefined && { signal }),
  });
  return res.settings;
}

/** PUT /api/settings — admin only (throws ApiError(403,'forbidden') for va). */
export async function updateSettings(patch: OrgSettingsPatch): Promise<OrgSettings> {
  const res = await request<{ settings: OrgSettings }>('/api/settings', {
    method: 'PUT',
    body: patch,
  });
  return res.settings;
}

// --- Users (/api/users, admin) ----------------------------------------------

/** GET /api/users — admin only. */
export async function listUsers(signal?: AbortSignal): Promise<AdminUser[]> {
  const res = await request<{ users: AdminUser[] }>('/api/users', {
    ...(signal !== undefined && { signal }),
  });
  return res.users;
}

/** POST /api/users — invite a user (admin only; idempotent → 201). */
export function inviteUser(email: string, role: UserRole): Promise<InviteUserResult> {
  return request<InviteUserResult>('/api/users', { method: 'POST', body: { email, role } });
}

/** PATCH /api/users/:userId/role — promote/demote (admin only). Throws
 *  ApiError(409,'cannot_demote_last_admin'|'cannot_demote_self') on a guard hit. */
export function changeUserRole(userId: string, role: UserRole): Promise<ChangeRoleResult> {
  return request<ChangeRoleResult>(
    `/api/users/${encodeURIComponent(userId)}/role`,
    { method: 'PATCH', body: { role } },
  );
}

// --- Push (/api/push) -------------------------------------------------------

/** GET /api/push/vapid-public-key — throws ApiError(503,'push_not_configured') when off. */
export async function getVapidPublicKey(): Promise<string> {
  const res = await request<{ publicKey: string }>('/api/push/vapid-public-key');
  return res.publicKey;
}

/** POST /api/push/subscriptions — store this device's subscription. */
export async function createPushSubscription(
  subscription: PushSubscriptionJSON,
): Promise<number> {
  const res = await request<{ subscriptionCount: number }>('/api/push/subscriptions', {
    method: 'POST',
    body: { subscription },
  });
  return res.subscriptionCount;
}

/** DELETE /api/push/subscriptions — remove one device by endpoint (204). */
export function deletePushSubscription(endpoint: string): Promise<void> {
  return request<void>('/api/push/subscriptions', { method: 'DELETE', body: { endpoint } });
}

/** POST /api/push/test — send a test notification to the caller's own devices. */
export function sendPushTest(): Promise<PushTestResult> {
  return request<PushTestResult>('/api/push/test', { method: 'POST' });
}

// --- Units (/api/units, requireAuth) ----------------------------------------

export interface ListUnitsParams {
  status?: UnitStatus;
  jurisdiction?: string;
  landlordId?: string;
  limit?: number;
  cursor?: string | null;
}

/** GET /api/units — the units list, paged. */
export function listUnits(
  params: ListUnitsParams = {},
  signal?: AbortSignal,
): Promise<UnitsPage> {
  return request<UnitsPage>('/api/units', {
    query: {
      status: params.status,
      jurisdiction: params.jurisdiction,
      landlordId: params.landlordId,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
    },
    ...(signal !== undefined && { signal }),
  });
}

/** POST /api/units — create a unit (landlordId required). → 201 { unit }. */
export async function createUnit(body: CreateUnitBody): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>('/api/units', { method: 'POST', body });
  return res.unit;
}

/** GET /api/units/:id — one unit, or throws ApiError(404,'unit_not_found'). */
export async function getUnit(unitId: string, signal?: AbortSignal): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.unit;
}

/** PATCH /api/units/:id — partial update. → { unit } | 404. */
export async function updateUnit(unitId: string, patch: UnitPatch): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}`,
    { method: 'PATCH', body: patch },
  );
  return res.unit;
}

// --- Broadcasts (/api/broadcasts, M1.8 "Share Listings", requireAuth) -------
// VAs run share broadcasts day-to-day (no admin gate). The lifecycle is
// create-draft → preview → send; results carry the per-recipient delivery map,
// and the `broadcast.updated` SSE event drives live stat updates.

/** POST /api/broadcasts — create a DRAFT + estimate the audience. → 201. */
export function createBroadcast(body: CreateBroadcastBody): Promise<CreateBroadcastResult> {
  return request<CreateBroadcastResult>('/api/broadcasts', { method: 'POST', body });
}

/** POST /api/broadcasts/:id/preview — re-resolve the audience count + a sample.
 *  Throws ApiError(404,'broadcast_not_found'). */
export function previewBroadcast(broadcastId: string): Promise<BroadcastPreviewResult> {
  return request<BroadcastPreviewResult>(
    `/api/broadcasts/${encodeURIComponent(broadcastId)}/preview`,
    { method: 'POST' },
  );
}

/** POST /api/broadcasts/:id/send — snapshot the audience + start the fan-out.
 *  Throws ApiError(400,'audience_too_large') (err.body is AudienceTooLargeError),
 *  ApiError(400,'empty_audience'), or ApiError(409,'broadcast_not_draft'). */
export function sendBroadcast(broadcastId: string): Promise<SendBroadcastResult> {
  return request<SendBroadcastResult>(
    `/api/broadcasts/${encodeURIComponent(broadcastId)}/send`,
    { method: 'POST' },
  );
}

/** GET /api/broadcasts/:id/results — stats + per-recipient delivery map.
 *  Throws ApiError(404,'broadcast_not_found'). */
export function getBroadcastResults(
  broadcastId: string,
  signal?: AbortSignal,
): Promise<BroadcastResults> {
  return request<BroadcastResults>(
    `/api/broadcasts/${encodeURIComponent(broadcastId)}/results`,
    { ...(signal !== undefined && { signal }) },
  );
}

export interface ListBroadcastsParams {
  status?: BroadcastStatus;
  limit?: number;
  cursor?: string | null;
}

/** GET /api/broadcasts — list (by status, else the caller's), newest-first. */
export function listBroadcasts(
  params: ListBroadcastsParams = {},
  signal?: AbortSignal,
): Promise<BroadcastsPage> {
  return request<BroadcastsPage>('/api/broadcasts', {
    query: {
      status: params.status,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
    },
    ...(signal !== undefined && { signal }),
  });
}

// --- Cases / boards (/api/cases, M1.10, requireAuth) ------------------------
// VAs run the boards day-to-day (no admin gate). A case is one tenant↔unit deal
// moving through the stage ladder; the `case.updated` SSE event drives live
// board updates. The relay-on-placement action (setUpCaseRelay) provisions the
// placement's masked relay thread from the case's parties.

export interface ListCasesParams {
  stage?: CaseStage;
  tenantId?: string;
  unitId?: string;
  /** YYYY-MM-DD — cases whose CURRENT tour is on this date. */
  tourDate?: string;
  deadlineType?: CaseDeadlineType;
  /** ISO 8601 "due by" bound (only with deadlineType). */
  before?: string;
  limit?: number;
  cursor?: string | null;
}

/** GET /api/cases — the boards' read, paged. Exactly one filter is honored
 *  server-side (most-specific first); with none, a paginated scan. */
export function listCases(
  params: ListCasesParams = {},
  signal?: AbortSignal,
): Promise<CasesPage> {
  return request<CasesPage>('/api/cases', {
    query: {
      stage: params.stage,
      tenantId: params.tenantId,
      unitId: params.unitId,
      tourDate: params.tourDate,
      deadlineType: params.deadlineType,
      before: params.before,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
    },
    ...(signal !== undefined && { signal }),
  });
}

export interface CreateCaseBody {
  tenantId: string;
  unitId: string;
  stage?: CaseStage;
  placement_tag?: string;
}

/** POST /api/cases — open a case (tenantId + unitId required; stage defaults to
 *  'interested' server-side). → 201 { case }. */
export async function createCase(body: CreateCaseBody): Promise<CaseItem> {
  const res = await request<{ case: CaseItem }>('/api/cases', { method: 'POST', body });
  return res.case;
}

/** GET /api/cases/:caseId — one case, or throws ApiError(404,'case_not_found'). */
export async function getCase(caseId: string, signal?: AbortSignal): Promise<CaseItem> {
  const res = await request<{ case: CaseItem }>(
    `/api/cases/${encodeURIComponent(caseId)}`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.case;
}

/** PATCH /api/cases/:caseId body — partial update (SET-merge; an explicit `null`
 *  clears tour_date / attention). The next_deadline pair moves via the deadline
 *  route, never here. */
export interface CasePatch {
  stage?: CaseStage;
  /** YYYY-MM-DD, or null to clear the scheduled tour. */
  tour_date?: string | null;
  placement_tag?: string | null;
  lost_reason?: string | null;
  lease_date?: string | null;
  move_in_date?: string | null;
  notes?: string | null;
  /** Only `null` is accepted — clear (acknowledge) the escalation flag. */
  attention?: null;
}

/** PATCH /api/cases/:caseId — partial update. → { case } | 404. */
export async function updateCase(caseId: string, patch: CasePatch): Promise<CaseItem> {
  const res = await request<{ case: CaseItem }>(
    `/api/cases/${encodeURIComponent(caseId)}`,
    { method: 'PATCH', body: patch },
  );
  return res.case;
}

/** POST /api/cases/:caseId/deadline body — set ({ type, at }) or clear
 *  ({ clear: true }) the next business-clock deadline. `at` is ISO 8601. */
export type SetCaseDeadlineBody = { type: CaseDeadlineType; at: string } | { clear: true };

/** POST /api/cases/:caseId/deadline — set/clear the next deadline. → { case }. */
export async function setCaseDeadline(
  caseId: string,
  body: SetCaseDeadlineBody,
): Promise<CaseItem> {
  const res = await request<{ case: CaseItem }>(
    `/api/cases/${encodeURIComponent(caseId)}/deadline`,
    { method: 'POST', body },
  );
  return res.case;
}

/** POST /api/cases/:caseId/relay — set up the placement's masked relay thread
 *  (roster derived from the case: tenant + the unit's landlord). → 201
 *  { conversation, case }. Throws ApiError on 409 'relay_exists' (err.body carries
 *  the existing { conversation }), 400 'tenant_unreachable'|'landlord_unreachable'|
 *  'unit_not_found', 503 'relay_provisioning_disabled'|'pool_number_unavailable',
 *  or 404 'case_not_found'. */
export function setUpCaseRelay(
  caseId: string,
): Promise<{ conversation: Conversation; case: CaseItem }> {
  return request<{ conversation: Conversation; case: CaseItem }>(
    `/api/cases/${encodeURIComponent(caseId)}/relay`,
    { method: 'POST' },
  );
}

// --- Public (/public, NO auth — rate-limited) -------------------------------
// These reach the backend WITHOUT a session (the dev Vite proxy stamps the
// origin-secret header; see vite.config.ts). They still go through the shared
// `request` transport (credentials: 'same-origin' is harmless when no cookie
// exists) so they share the ApiError handling — never assume a logged-in user.

/** POST /public/housing-fair — the public housing-fair signup. → { ok: true };
 *  ApiError(400,'invalid request') on bad input; ApiError(429,'rate_limited'). */
export function submitHousingFair(body: HousingFairSignup): Promise<{ ok: true }> {
  return request<{ ok: true }>('/public/housing-fair', { method: 'POST', body });
}

/** GET /public/units/:unitId/flyer — the shareable flyer. → { flyer } |
 *  ApiError(404,'not_found'). */
export async function getUnitFlyer(unitId: string, signal?: AbortSignal): Promise<UnitFlyer> {
  const res = await request<{ flyer: UnitFlyer }>(
    `/public/units/${encodeURIComponent(unitId)}/flyer`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.flyer;
}
