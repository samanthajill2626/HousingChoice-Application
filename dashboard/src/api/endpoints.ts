// Typed endpoint functions � one per route. Every function returns a typed
// result and throws ApiError on non-2xx (see api/client.ts). Components import
// these (via api/index.ts) and never construct fetch calls by hand.
import { request } from './client.js';
import type {
  PlacementItem,
  PlacementsPage,
  PlacementStage,
  Contact,
  ContactCreate,
  ContactMediaItem,
  ContactPatch,
  ContactsPage,
  ContactTimelinePage,
  ContactType,
  ContactVocabulary,
  ConversationsPage,
  DevLoginResult,
  HistoryRow,
  InboxFilter,
  InboxPage,
  InspectionOutcome,
  ListingSendRow,
  ListingStatus,
  LostReason,
  Me,
  Message,
  RelatedUnit,
  SendMessageResult,
  SimilarUnit,
  TenantStatus,
  TodayResponse,
  TransitionSource,
  UnitItem,
  UnitsPage,
} from './types.js';

// --- Auth (/auth) -----------------------------------------------------------

/** GET /auth/me � the current principal, or throws ApiError(401) when anonymous. */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return request<Me>('/auth/me', { ...(signal !== undefined && { signal }) });
}

/** POST /auth/logout � global session revocation (204). */
export function logout(): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST' });
}

/** The login URL � a plain navigation (the server drives the OAuth dance).
 *  Not a fetch: use it as an <a href> / window.location.assign(loginUrl()). */
export function loginUrl(): string {
  return '/auth/login';
}

// --- Today (/api) -----------------------------------------------------------
// The server-assembled action queue (�API Contract C7). When the backend slice
// isn't live yet this 404s; useToday catches ApiError(404) and assembles the
// same shape client-side from getPlacements() + getConversations().

/** GET /api/today � the server-assembled Today queue, or throws ApiError(404)
 *  until the backend slice lands (the caller falls back to the client build).
 *  `day` = the operator's LOCAL calendar date (YYYY-MM-DD); the timezone-agnostic
 *  server uses it ONLY to choose the tours_today group (omitting it makes the
 *  server use the UTC date). Compute `day` from local fields (see localYmd),
 *  never toISOString(). A malformed `day` returns 400. */
export function getToday(day?: string, signal?: AbortSignal): Promise<TodayResponse> {
  const path = day !== undefined ? `/api/today?day=${encodeURIComponent(day)}` : '/api/today';
  return request<TodayResponse>(path, { ...(signal !== undefined && { signal }) });
}

/** GET /api/placements � the placement board (the Today fallback's deadline/tour/attention
 *  source). The server pages; pass `cursor` to fetch the next page (the
 *  placement board pages through ALL of them � see usePlacements). Other callers
 *  (Today / listing / contact-file) read only the first page (no cursor). */
export function getPlacements(signal?: AbortSignal, cursor?: string): Promise<PlacementsPage> {
  return request<PlacementsPage>('/api/placements', {
    query: { cursor },
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/placements/:placementId � a single placement record (the placement detail page + the
 *  history view). Wrapped under { placement } on the wire; unwrapped here. */
export async function getPlacement(placementId: string, signal?: AbortSignal): Promise<PlacementItem> {
  const res = await request<{ placement: PlacementItem }>(`/api/placements/${encodeURIComponent(placementId)}`, {
    ...(signal !== undefined && { signal }),
  });
  return res.placement;
}

/** POST /api/placements � create a placement (one deal: this tenant on this unit).
 *  The backend derives the tenant + listing coarse statuses for the initial stage
 *  (�7). Returns the new placement (unwrapped from { placement }). */
export async function createPlacement(body: {
  tenantId: string;
  unitId: string;
  stage: PlacementStage;
  placement_tag?: string;
}): Promise<PlacementItem> {
  const res = await request<{ placement: PlacementItem }>('/api/placements', {
    method: 'POST',
    body,
  });
  return res.placement;
}

/** GET /api/placements?tenantId= / ?unitId= � the placements on a tenant OR a unit
 *  (the overlap check for manual creation). Exactly one of tenantId/unitId is sent;
 *  the server honors the most-specific filter. First page only (overlap needs only
 *  active rows; the pipeline per party is small). Returns the page's placements. */
export async function getPlacementsBy(
  params: { tenantId?: string; unitId?: string },
  signal?: AbortSignal,
): Promise<PlacementItem[]> {
  const res = await request<PlacementsPage>('/api/placements', {
    query: {
      ...(params.tenantId !== undefined && { tenantId: params.tenantId }),
      ...(params.unitId !== undefined && { unitId: params.unitId }),
    },
    ...(signal !== undefined && { signal }),
  });
  return res.placements;
}

// --- Status-model transitions (the ONE transition surface) ------------------
// The four routes over the backend status-transition service. Stage/tenant/
// listing writes MUST go through these (NOT a plain PATCH) so provenance +
// derivation are applied server-side.

/** Input to a placement stage transition. */
export interface TransitionInput {
  toStage: PlacementStage;
  source: TransitionSource;
  reason?: string;
  lostReason?: LostReason;
  /** Written only on the move OUT of awaiting_rent_acceptance (>0). */
  finalRent?: number;
  /** Written only on the move OUT of awaiting_inspection. */
  inspectionOutcome?: InspectionOutcome;
}

/** True when a lost reason is acceptable to the backend: a category OR non-empty
 *  trimmed free text (else the server returns 400). Client-side fast-fail so a
 *  lost move never round-trips just to bounce. */
export function validateLostReason(lr: LostReason | undefined): boolean {
  if (lr === undefined) return false;
  if (lr.category !== undefined) return true;
  return typeof lr.text === 'string' && lr.text.trim().length > 0;
}

/** Build the transition request body, OMITTING undefined fields (so finalRent /
 *  inspectionOutcome / lostReason / reason only appear when actually set). Pure. */
export function buildTransitionBody(input: TransitionInput): Record<string, unknown> {
  return {
    toStage: input.toStage,
    source: input.source,
    ...(input.reason !== undefined && { reason: input.reason }),
    ...(input.lostReason !== undefined && { lostReason: input.lostReason }),
    ...(input.finalRent !== undefined && { finalRent: input.finalRent }),
    ...(input.inspectionOutcome !== undefined && { inspectionOutcome: input.inspectionOutcome }),
  };
}

/** POST /api/placements/:placementId/transition � move a placement to a new stage through
 *  the transition service. A `lost` move requires lostReason.category OR
 *  non-empty text (validated client-side, then server-side). Returns the updated
 *  placement (unwrapped from { placement }). */
export async function transitionPlacement(
  placementId: string,
  input: TransitionInput,
): Promise<PlacementItem> {
  if (input.toStage === 'lost' && !validateLostReason(input.lostReason)) {
    throw new Error('A lost move requires a reason: pick a category or write a note.');
  }
  const res = await request<{ placement: PlacementItem }>(
    `/api/placements/${encodeURIComponent(placementId)}/transition`,
    { method: 'POST', body: buildTransitionBody(input) },
  );
  return res.placement;
}

/** GET /api/placements/:placementId/history � the placement's provenance trail (newest
 *  first). Unwrapped from { history }. */
export async function getPlacementHistory(
  placementId: string,
  opts: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<HistoryRow[]> {
  const res = await request<{ history: HistoryRow[] }>(
    `/api/placements/${encodeURIComponent(placementId)}/history`,
    {
      query: { limit: opts.limit, before: opts.before },
      ...(signal !== undefined && { signal }),
    },
  );
  return res.history;
}

/** PATCH /api/contacts/:contactId/tenant-status � set a tenant's lifecycle
 *  status through the transition service (applies provenance/derivation �
 *  NEVER use a plain contact PATCH for tenant lifecycle). Returns the updated
 *  contact (unwrapped from { contact }). */
export async function setTenantStatus(
  contactId: string,
  input: { toStatus: TenantStatus; source: TransitionSource; reason?: string; porting?: boolean },
): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/tenant-status`,
    {
      method: 'PATCH',
      body: {
        toStatus: input.toStatus,
        source: input.source,
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.porting !== undefined && { porting: input.porting }),
      },
    },
  );
  return res.contact;
}

/** PATCH /api/units/:unitId/listing-status � set a listing's lifecycle status
 *  through the transition service (status is NOT writable via a plain unit
 *  PATCH). Returns the updated unit (unwrapped from { unit }). */
export async function setListingStatus(
  unitId: string,
  input: { toStatus: ListingStatus; source: TransitionSource; reason?: string },
): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}/listing-status`,
    {
      method: 'PATCH',
      body: {
        toStatus: input.toStatus,
        source: input.source,
        ...(input.reason !== undefined && { reason: input.reason }),
      },
    },
  );
  return res.unit;
}

/** GET /api/conversations � the inbox rows (the Today fallback's unread +
 *  untriaged source). */
export function getConversations(signal?: AbortSignal): Promise<ConversationsPage> {
  return request<ConversationsPage>('/api/conversations', {
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/conversations/:id/messages � newest-first page of a conversation's
 *  messages (the contact timeline FALLBACK's source). The server wraps the page
 *  under { messages }; we unwrap it here so callers get a plain Message[]. */
export async function getConversationMessages(
  conversationId: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  const res = await request<{ messages: Message[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.messages;
}

/** POST /api/conversations/:id/messages � a manual human send (the reply box). */
export function sendMessage(
  conversationId: string,
  body: { body?: string; mediaUrls?: string[] },
): Promise<SendMessageResult> {
  return request<SendMessageResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: 'POST', body },
  );
}

/** POST /api/conversations/:id/messages/:providerSid/retry � re-send a FAILED
 *  outbound message (the Retry button). The server re-reads the original by its
 *  provider SID (resending body + media correctly) and stamps `retry_of` so the
 *  timeline collapses the stale failed bubble. */
export function retryMessage(
  conversationId: string,
  providerSid: string,
): Promise<SendMessageResult> {
  return request<SendMessageResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(
      providerSid,
    )}/retry`,
    { method: 'POST' },
  );
}

/** GET /api/units � the unit records. The landlord file filters this by
 *  landlordId === contactId to show the landlord's own listings; the listing
 *  page reuses it for "Related listings" (same landlord). `deleted: true` returns
 *  ONLY soft-deleted listings (the Listings "Deleted" view); omitted = exclude them. */
export function getUnits(
  params: { deleted?: boolean; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<UnitsPage> {
  return request<UnitsPage>('/api/units', {
    query: {
      ...(params.cursor !== undefined && { cursor: params.cursor }),
      ...(params.deleted === true && { deleted: 'true' }),
    },
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/units/:id � a single unit record (the listing detail page header +
 *  details + photos). Wrapped under { unit } on the wire; unwrapped here. */
export async function getUnit(unitId: string, signal?: AbortSignal): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(`/api/units/${encodeURIComponent(unitId)}`, {
    ...(signal !== undefined && { signal }),
  });
  return res.unit;
}

/** PATCH /api/units/:id � partial update (SET-merge; only changed fields sent).
 *  The server validates against a strict field allowlist + types. Returns the
 *  updated unit (wrapped under { unit }). */
export async function updateUnit(
  unitId: string,
  patch: Record<string, unknown>,
): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(`/api/units/${encodeURIComponent(unitId)}`, {
    method: 'PATCH',
    body: patch,
  });
  return res.unit;
}

/** DELETE /api/units/:id � SOFT-delete the listing (stamp deleted_at). The record
 *  + all data are retained; it's hidden from the lists and can be restored.
 *  Returns the updated (deleted) unit. */
export async function deleteUnit(unitId: string): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(`/api/units/${encodeURIComponent(unitId)}`, {
    method: 'DELETE',
  });
  return res.unit;
}

/** POST /api/units/:id/restore � clear deleted_at, bringing a soft-deleted listing
 *  back into the normal views. Returns the updated unit. */
export async function restoreUnit(unitId: string): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}/restore`,
    { method: 'POST' },
  );
  return res.unit;
}

/** GET /api/units/:id/related (�C3) � duplex-sibling / same-landlord listings.
 *  404s until BE3 lands ? the listing page degrades to a same-landlord FALLBACK
 *  it derives from getUnits(). */
export async function getUnitRelated(
  unitId: string,
  signal?: AbortSignal,
): Promise<RelatedUnit[]> {
  const res = await request<{ related: RelatedUnit[] }>(
    `/api/units/${encodeURIComponent(unitId)}/related`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.related;
}

/** GET /api/units/:id/recipients (�C4) � the "Sent to tenants" rows (recipients
 *  + responses). 404s until BE4 lands ? the panel renders a "pending backend"
 *  state. */
export async function getUnitRecipients(
  unitId: string,
  signal?: AbortSignal,
): Promise<ListingSendRow[]> {
  const res = await request<{ recipients: ListingSendRow[] }>(
    `/api/units/${encodeURIComponent(unitId)}/recipients`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.recipients;
}

/** GET /api/units/:id/similar (�C6) � available comps ranked by similarity.
 *  404s until BE6 lands ? the "Similar listings" panel renders a "pending
 *  backend" state. */
export async function getUnitSimilar(
  unitId: string,
  signal?: AbortSignal,
): Promise<SimilarUnit[]> {
  const res = await request<{ similar: SimilarUnit[] }>(
    `/api/units/${encodeURIComponent(unitId)}/similar`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.similar;
}

// --- Contacts (/api/contacts) -----------------------------------------------
// The contact detail page (B2 tenant / B3 landlord). getContact exists today
// (legacy Contact, single `phone`); the timeline / listings-sent / media slices
// (C2/C4/C5) 404 until BE1�BE5 land, so callers degrade gracefully.

/** GET /api/contacts � the records list (the Contacts list views' source). The
 *  server REQUIRES a `type` filter (unless an exact `phone` lookup is given), so
 *  callers fetch one type at a time; the "all Contacts" view fans out per type
 *  and merges. First page only (the server pages via nextCursor) � the list
 *  views note this transitional limitation. */
export function getContacts(
  params: { type?: ContactType; status?: string; cursor?: string; deleted?: boolean } = {},
  signal?: AbortSignal,
): Promise<ContactsPage> {
  return request<ContactsPage>('/api/contacts', {
    query: {
      type: params.type,
      status: params.status,
      cursor: params.cursor,
      // ?deleted=true ? the Deleted view (only soft-deleted); omit otherwise.
      ...(params.deleted === true && { deleted: 'true' }),
    },
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/contacts/:id � the contact record (the detail page header + file).
 *  Wrapped under { contact } on the wire; unwrapped here. */
export async function getContact(contactId: string, signal?: AbortSignal): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.contact;
}

/** GET /api/contacts/:id/timeline (�C2) � the server-merged person-centric
 *  timeline. 404s until BE2 lands; useContactTimeline catches that and assembles
 *  a message-only fallback from the contact's conversations. `kinds` filters
 *  (e.g. 'message,call' for the "Comms only" toggle). */
export function getContactTimeline(
  contactId: string,
  opts: { kinds?: string } = {},
  signal?: AbortSignal,
): Promise<ContactTimelinePage> {
  return request<ContactTimelinePage>(
    `/api/contacts/${encodeURIComponent(contactId)}/timeline`,
    {
      query: { kinds: opts.kinds },
      ...(signal !== undefined && { signal }),
    },
  );
}

/** GET /api/contacts/:id/listings-sent (�C4) � the "Listings sent" rows. 404s
 *  until BE4 lands ? the panel renders a "pending backend" state. */
export async function getContactListingsSent(
  contactId: string,
  signal?: AbortSignal,
): Promise<ListingSendRow[]> {
  const res = await request<{ sent: ListingSendRow[] }>(
    `/api/contacts/${encodeURIComponent(contactId)}/listings-sent`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.sent;
}

/** GET /api/contacts/:id/media (�C5) � aggregated comms media. 404s until BE5
 *  lands ? the "Media from comms" panel renders a "pending backend" state. */
export async function getContactMedia(
  contactId: string,
  signal?: AbortSignal,
): Promise<ContactMediaItem[]> {
  const res = await request<{ media: ContactMediaItem[] }>(
    `/api/contacts/${encodeURIComponent(contactId)}/media`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.media;
}

// --- Contact mutations (edit / triage / phones / opt-out) -------------------

/** PATCH /api/contacts/:id � edit/triage a contact. Send only the changed fields
 *  (the server SET-merges). Returns the updated contact (unwrapped). */
export async function updateContact(contactId: string, patch: ContactPatch): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}`,
    { method: 'PATCH', body: patch },
  );
  return res.contact;
}

/** POST /api/contacts � create a brand-new contact record. Returns the new
 *  contact (unwrapped from { contact }). */
export async function createContact(body: ContactCreate): Promise<Contact> {
  const res = await request<{ contact: Contact }>('/api/contacts', { method: 'POST', body });
  return res.contact;
}

/** GET /api/contacts/vocabulary � the operator-configured pick-lists used by
 *  the contact creation form (roles, relationship roles, custom field labels).
 *  Unwrapped from { vocabulary }. */
export async function getContactVocabulary(signal?: AbortSignal): Promise<ContactVocabulary> {
  const res = await request<{ vocabulary: ContactVocabulary }>('/api/contacts/vocabulary', {
    ...(signal !== undefined && { signal }),
  });
  return res.vocabulary;
}

/** POST /api/contacts/:id/phones � add a number to the contact's roster (idempotent
 *  upsert). Returns the updated contact with the canonical `phones[]`. */
export async function addContactPhone(
  contactId: string,
  phone: string,
  label?: string,
): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/phones`,
    { method: 'POST', body: { phone, ...(label !== undefined && { label }) } },
  );
  return res.contact;
}

/** PATCH /api/contacts/:id/phones/:phone � set a number primary and/or relabel it.
 *  Returns the updated contact with the canonical `phones[]`. */
export async function updateContactPhone(
  contactId: string,
  phone: string,
  opts: { primary?: boolean; label?: string },
): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/phones/${encodeURIComponent(phone)}`,
    { method: 'PATCH', body: opts },
  );
  return res.contact;
}

/** DELETE /api/contacts/:id/phones/:phone � remove a non-primary number. Returns
 *  the updated contact with the canonical `phones[]`. */
export async function removeContactPhone(contactId: string, phone: string): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/phones/${encodeURIComponent(phone)}`,
    { method: 'DELETE' },
  );
  return res.contact;
}

/** POST /api/contacts/:id/opt-out � mark the contact Do-Not-Contact (sms_opt_out)
 *  or clear it. Returns the updated contact. */
export async function setContactOptOut(contactId: string, optOut: boolean): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/opt-out`,
    { method: 'POST', body: { optOut } },
  );
  return res.contact;
}

/** DELETE /api/contacts/:id � SOFT-delete the contact (stamp deleted_at). The
 *  record + all data are retained; it's hidden from lists/inbox/today and can be
 *  restored. Returns the updated (deleted) contact. */
export async function deleteContact(contactId: string): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}`,
    { method: 'DELETE' },
  );
  return res.contact;
}

/** POST /api/contacts/:id/restore � clear deleted_at, bringing a soft-deleted
 *  contact back into the normal views. Returns the updated contact. */
export async function restoreContact(contactId: string): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/restore`,
    { method: 'POST' },
  );
  return res.contact;
}

// --- Dev-only auth (/__dev, /auth/dev-login) --------------------------------
// These reach the hermetic-LOCAL dev router, mounted ONLY in the local dev/e2e
// stack and 404 (router absent) in every deployed env. The UI uses devPing() to
// decide whether to surface the dev-login affordance at all; it MUST fail closed
// (any non-200 / non-{dev:true} / error ? unavailable).

/** GET /__dev/ping � availability probe for the hermetic dev router. Resolves
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

/** POST /auth/dev-login � log in as a dev user (sets the session cookie). The
 *  server auto-provisions the user if missing, so this works on an unseeded
 *  local DB too (known personas keep their role; others default to admin). */
export function devLogin(email = 'va@example.com'): Promise<DevLoginResult> {
  return request<DevLoginResult>('/auth/dev-login', { method: 'POST', body: { email } });
}

// --- Inbox (/api/inbox) (�API Contract C8) ----------------------------------
// The entity-centric inbox feed + its read/assign mutations. GET 404s until the
// BE7/C8 backend slice lands ? useInbox catches that and degrades to 'pending'.

/** GET /api/inbox � one page of inbox rows for a filter (newest-activity-first,
 *  one row per contact). Throws ApiError(404) until the backend slice lands. */
export function getInbox(
  params: { filter?: InboxFilter; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<InboxPage> {
  return request<InboxPage>('/api/inbox', {
    query: { filter: params.filter, cursor: params.cursor, limit: params.limit },
    ...(signal !== undefined && { signal }),
  });
}

/** POST /api/inbox/:contactId/read (contact rows) � or POST /api/inbox/read
 *  { phone } (unknown rows, keyed by number) � mark the comms read. */
export function markInboxRead(
  target: { contactId: string } | { phone: string },
  signal?: AbortSignal,
): Promise<void> {
  if ('contactId' in target) {
    return request<void>(`/api/inbox/${encodeURIComponent(target.contactId)}/read`, {
      method: 'POST',
      ...(signal !== undefined && { signal }),
    });
  }
  return request<void>('/api/inbox/read', {
    method: 'POST',
    body: { phone: target.phone },
    ...(signal !== undefined && { signal }),
  });
}

/** POST /api/inbox/:contactId/assign { userId } � set (userId) or clear
 *  (userId=null) the contact row's assignment. */
export function assignInbox(
  contactId: string,
  userId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  return request<void>(`/api/inbox/${encodeURIComponent(contactId)}/assign`, {
    method: 'POST',
    body: { userId },
    ...(signal !== undefined && { signal }),
  });
}
