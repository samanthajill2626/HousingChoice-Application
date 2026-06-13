// Typed endpoint functions — one per route in the API contract. Every function
// returns a typed result and throws ApiError on non-2xx (see api/client.ts).
// Feature agents import these (via api/index.ts) and never construct fetch
// calls by hand.
import { request } from './client.js';
import type {
  AdminUser,
  ChangeRoleResult,
  Contact,
  ContactPatch,
  ContactsPage,
  ContactType,
  Conversation,
  ConversationsPage,
  CreateContactBody,
  CreateUnitBody,
  HousingFairSignup,
  InviteUserResult,
  Me,
  Message,
  OrgSettings,
  OrgSettingsPatch,
  PushTestResult,
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

// --- Units / properties (/api/units, requireAuth) ---------------------------

export interface ListUnitsParams {
  status?: UnitStatus;
  jurisdiction?: string;
  landlordId?: string;
  limit?: number;
  cursor?: string | null;
}

/** GET /api/units — the properties list, paged. */
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
