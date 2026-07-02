// Typed endpoint functions � one per route. Every function returns a typed
// result and throws ApiError on non-2xx (see api/client.ts). Components import
// these (via api/index.ts) and never construct fetch calls by hand.
import { request } from './client.js';
import type {
  AdminUserView,
  AudienceFilter,
  BroadcastResults,
  BroadcastsPage,
  BroadcastStatus,
  PreviewResponse,
  SettingsPatch,
  SettingsResponse,
  UserRole,
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
  MeUser,
  Message,
  RelatedUnit,
  SendMessageResult,
  SimilarUnit,
  SystemAlarmsResult,
  SystemErrorsResult,
  SystemFlags,
  TenantStatus,
  TodayResponse,
  TransitionSource,
  Tour,
  TourOutcome,
  TourStatus,
  TourType,
  ToursPage,
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
export function getToday(
  day?: string,
  signal?: AbortSignal,
  toursWindow?: { from: string; to: string },
): Promise<TodayResponse> {
  const params = new URLSearchParams();
  if (day !== undefined) params.set('day', day);
  if (toursWindow !== undefined) {
    // The browser's local-day boundaries as instants — tours_today is built from
    // Tour scheduledAt instants, so the caller supplies its own day window (the
    // server's fallback is the UTC window of `day`, which can bucket an evening
    // tour a day off; real UI code always passes the window).
    params.set('toursFrom', toursWindow.from);
    params.set('toursTo', toursWindow.to);
  }
  const qs = params.toString();
  const path = qs.length > 0 ? `/api/today?${qs}` : '/api/today';
  return request<TodayResponse>(path, { ...(signal !== undefined && { signal }) });
}

/** GET /api/placements � the placement board (the Today fallback's deadline/tour/attention
 *  source). The server pages; pass `cursor` to fetch the next page (the
 *  placement board pages through ALL of them � see usePlacements). Other callers
 *  (Today / property / contact-file) read only the first page (no cursor). */
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

/** POST /api/placements — create a placement (one deal: this tenant on this unit).
 *  The backend derives the tenant + property coarse statuses for the initial stage
 *  (§7). Returns the new placement (unwrapped from { placement }). */
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

/** GET /api/placements?tenantId= / ?unitId= — the placements on a tenant OR a unit
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
// property writes MUST go through these (NOT a plain PATCH) so provenance +
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

/** PATCH /api/units/:unitId/listing-status � set a property's lifecycle status
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

/** POST /api/units � create a unit (property) under a landlord. The body carries
 *  the owning landlordId plus the writable unit fields; the server validates them
 *  against a strict allowlist + types and stamps the initial status ('setup').
 *  Returns the created unit (unwrapped from { unit }). */
export async function createUnit(body: Record<string, unknown>): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>('/api/units', { method: 'POST', body });
  return res.unit;
}

/** GET /api/units � the unit records. The landlord file filters this by
 *  landlordId === contactId to show the landlord's own properties; the property
 *  page reuses it for "Related properties" (same landlord). `deleted: true` returns
 *  ONLY soft-deleted properties (the Properties "Deleted" view); omitted = exclude them. */
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

/** GET /api/units/:id � a single unit record (the property detail page header +
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

/** DELETE /api/units/:id � SOFT-delete the property (stamp deleted_at). The record
 *  + all data are retained; it's hidden from the lists and can be restored.
 *  Returns the updated (deleted) unit. */
export async function deleteUnit(unitId: string): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(`/api/units/${encodeURIComponent(unitId)}`, {
    method: 'DELETE',
  });
  return res.unit;
}

/** POST /api/units/:id/restore � clear deleted_at, bringing a soft-deleted property
 *  back into the normal views. Returns the updated unit. */
export async function restoreUnit(unitId: string): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}/restore`,
    { method: 'POST' },
  );
  return res.unit;
}

/** GET /api/units/:id/related (�C3) � duplex-sibling / same-landlord properties.
 *  404s until BE3 lands ? the property page degrades to a same-landlord FALLBACK
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
 *  404s until BE6 lands ? the "Similar properties" panel renders a "pending
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

/** GET /api/contacts/:id/listings-sent (�C4) � the "Properties sent" rows. 404s
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

/** POST /api/contacts/:id/voice-opt-out (Voice Phase 1 §8) — set/clear the
 *  company do-not-CALL flag. INDEPENDENT of the SMS opt-out above (someone may
 *  allow texts but not calls). Returns the updated contact (unwrapped). */
export async function setContactVoiceOptOut(contactId: string, optOut: boolean): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/voice-opt-out`,
    { method: 'POST', body: { optOut } },
  );
  return res.contact;
}

// --- Voice: outbound masked calling (Voice Phase 1 §5) ----------------------
// The dashboard-initiated masked-call originate. The session identifies the
// CALLING navigator → their verified cell rings first, then bridges to the
// target with the business caller ID (the contact never sees the navigator's
// cell). Throws ApiError on the guards: 409 cell_not_verified (the navigator has
// no verified cell → prompt them to set one), 409 contact_voice_opted_out (the
// contact is do-not-call), 404 contact_not_found, 400 invalid_phone.

/** POST /api/contacts/:contactId/call { phone? } → { callSid }. `phone` picks
 *  WHICH of the contact's numbers to dial (defaults to the primary server-side).
 *  Throws ApiError — the caller branches on `.code` (cell_not_verified /
 *  contact_voice_opted_out / …). */
export async function originateCall(
  contactId: string,
  opts: { phone?: string } = {},
): Promise<{ callSid: string }> {
  return request<{ callSid: string }>(`/api/contacts/${encodeURIComponent(contactId)}/call`, {
    method: 'POST',
    body: { ...(opts.phone !== undefined && { phone: opts.phone }) },
  });
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

// --- Broadcasts (/api/broadcasts) -------------------------------------------
// The "Share properties to tenants" surface: draft → preview (full annotated
// candidate list) → send-by-explicit-selection → live results, plus a list and
// a draft-delete. VA-accessible (no admin gate). The dashboard ALWAYS sends the
// explicit `recipientContactIds` curated list on send.

/** GET /api/broadcasts?status=&limit=&cursor= — the broadcasts list (newest-first).
 *  No `status` → the acting user's broadcasts; a `status` → that status's rows. */
export function listBroadcasts(
  params: { status?: BroadcastStatus; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<BroadcastsPage> {
  return request<BroadcastsPage>('/api/broadcasts', {
    query: { status: params.status, cursor: params.cursor, limit: params.limit },
    ...(signal !== undefined && { signal }),
  });
}

/** POST /api/broadcasts — create a DRAFT + estimate the audience reach. Returns
 *  the new draft's id, the estimated reach, and `truncated` (the estimate hit
 *  the page cap → incomplete). The client sends the `audience_filter` client
 *  shape (contact_type/housing_authority?/bedroomSize?); the server adds the
 *  always-on opt-out/unreachable fences. */
export function createBroadcast(body: {
  unitId?: string;
  body_template: string;
  audience_filter: AudienceFilter;
}): Promise<{ broadcastId: string; status: 'draft'; estimatedCount: number; truncated: boolean }> {
  return request<{
    broadcastId: string;
    status: 'draft';
    estimatedCount: number;
    truncated: boolean;
  }>('/api/broadcasts', { method: 'POST', body });
}

/** POST /api/broadcasts/:id/preview — re-resolve the audience + return the FULL
 *  annotated candidate list (bounded by the recipient cap) + the prior-recipients
 *  set for the unit (so a manually-added tenant can be flagged client-side). */
export function previewBroadcast(broadcastId: string): Promise<PreviewResponse> {
  return request<PreviewResponse>(
    `/api/broadcasts/${encodeURIComponent(broadcastId)}/preview`,
    { method: 'POST' },
  );
}

/** POST /api/broadcasts/:id/send — send to the explicit curated selection.
 *  The server snapshots, re-enforces opt-out/unreachable + the recipient cap,
 *  marks sending, and enqueues the fan-out. Throws ApiError on 400 empty_audience
 *  / 400 over-cap (message matches /cap/i) / 409 broadcast_not_draft. */
export function sendBroadcast(
  broadcastId: string,
  recipientContactIds: string[],
): Promise<{ broadcastId: string; status: 'sending'; count: number }> {
  return request<{ broadcastId: string; status: 'sending'; count: number }>(
    `/api/broadcasts/${encodeURIComponent(broadcastId)}/send`,
    { method: 'POST', body: { recipientContactIds } },
  );
}

/** GET /api/broadcasts/:id/results — stats + the per-recipient delivery map. */
export function getBroadcastResults(
  broadcastId: string,
  signal?: AbortSignal,
): Promise<BroadcastResults> {
  return request<BroadcastResults>(
    `/api/broadcasts/${encodeURIComponent(broadcastId)}/results`,
    { ...(signal !== undefined && { signal }) },
  );
}

/** DELETE /api/broadcasts/:id — delete an UNSENT draft. 200 { deleted:true } on
 *  success; throws ApiError(404 broadcast_not_found) when missing, or
 *  ApiError(409 broadcast_not_draft) when already sending/sent/failed (the
 *  caller falls back to the Results view). */
export function deleteBroadcast(broadcastId: string): Promise<{ deleted: true }> {
  return request<{ deleted: true }>(`/api/broadcasts/${encodeURIComponent(broadcastId)}`, {
    method: 'DELETE',
  });
}

// --- Settings ▸ Team (/api/users) (admin-only on the server) ----------------
// The in-app team-management surface (replaces the CLI ops scripts). Every
// route is requireRole('admin') upstream; a VA never reaches this section.

/** GET /api/users — the team roster (unwrapped from { users }). */
export async function listUsers(signal?: AbortSignal): Promise<AdminUserView[]> {
  const res = await request<{ users: AdminUserView[] }>('/api/users', {
    ...(signal !== undefined && { signal }),
  });
  return res.users;
}

/** POST /api/users { email, role } — invite (idempotent). `created` is false when
 *  the email was already on the team (surface as a friendly no-op, not an error). */
export function inviteUser(body: {
  email: string;
  role: UserRole;
}): Promise<{ user: AdminUserView; created: boolean }> {
  return request<{ user: AdminUserView; created: boolean }>('/api/users', {
    method: 'POST',
    body,
  });
}

/** PATCH /api/users/:userId/role { role } — promote/demote. 409
 *  cannot_demote_self / cannot_demote_last_admin on a lockout (revert + inline). */
export function setUserRole(
  userId: string,
  role: UserRole,
): Promise<{ user: AdminUserView; changed: boolean }> {
  return request<{ user: AdminUserView; changed: boolean }>(
    `/api/users/${encodeURIComponent(userId)}/role`,
    { method: 'PATCH', body: { role } },
  );
}

// --- Voice: inbound-voice-line assignment (admin, Voice Phase 1 §6) ----------
// The single "Inbound voice line" holder — exactly one user at a time. Assigning
// MOVES it (the server clears any prior holder). The user must have a VERIFIED
// cell (else 409 cell_not_verified). Both return the updated user (unwrapped).

/** POST /api/users/:userId/inbound-voice-line (admin) — make this user the single
 *  inbound-voice-line holder (moves it off any prior holder). 409 cell_not_verified
 *  when the user has no verified cell. Returns the updated user (unwrapped). */
export async function assignInboundVoiceLine(userId: string): Promise<AdminUserView> {
  const res = await request<{ user: AdminUserView }>(
    `/api/users/${encodeURIComponent(userId)}/inbound-voice-line`,
    { method: 'POST' },
  );
  return res.user;
}

/** DELETE /api/users/:userId/inbound-voice-line (admin) — clear the holder (no
 *  inbound line, inbound degrades to the "text us" fallback). Returns the
 *  updated user (unwrapped). */
export async function clearInboundVoiceLine(userId: string): Promise<AdminUserView> {
  const res = await request<{ user: AdminUserView }>(
    `/api/users/${encodeURIComponent(userId)}/inbound-voice-line`,
    { method: 'DELETE' },
  );
  return res.user;
}

// --- Voice: self cell verification (Voice Phase 1 §7) -----------------------
// Self-service: any logged-in user attaches + verifies their OWN cell (their
// outbound bridge leg). An unverified cell is never dialed. The self view carries
// the voice fields (cell/cell_verified_at/inbound_voice_line) the CLI/auth `Me`
// does not.

/** GET /api/users/me → { user } — the current navigator's self view WITH the
 *  voice fields (cell/cell_verified_at/inbound_voice_line). Unwrapped from
 *  { user }. */
export async function getVoiceMe(signal?: AbortSignal): Promise<MeUser> {
  const res = await request<{ user: MeUser }>('/api/users/me', {
    ...(signal !== undefined && { signal }),
  });
  return res.user;
}

/** POST /api/users/me/cell/verify-start { cell } → { ok:true } — send a 6-digit
 *  code by SMS to the entered cell. Throws ApiError 400 invalid_cell / 503
 *  sms_unavailable. */
export function startCellVerify(cell: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/users/me/cell/verify-start', {
    method: 'POST',
    body: { cell },
  });
}

/** POST /api/users/me/cell/verify-confirm { code } → { ok:true, cell_verified_at }
 *  — confirm the code, stamping cell_verified_at on success. Throws ApiError 400
 *  invalid_code / 410 code_expired / 429 too_many_attempts. */
export function confirmCellVerify(code: string): Promise<{ ok: true; cell_verified_at: string }> {
  return request<{ ok: true; cell_verified_at: string }>('/api/users/me/cell/verify-confirm', {
    method: 'POST',
    body: { code },
  });
}

// --- Settings ▸ Templates (/api/settings) -----------------------------------
// VAs may VIEW (GET requireAuth); only admins EDIT (PUT requireRole('admin')).

/** GET /api/settings — the founder-editable templates plus `welcomeTextDefault`
 *  (the read-only built-in welcome body, shown so admins see what "blank" sends). */
export function getSettings(signal?: AbortSignal): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings', {
    ...(signal !== undefined && { signal }),
  });
}

/** PUT /api/settings { ...patch } — admin-only edit; send ONLY changed fields.
 *  Returns the merged settings (+ welcomeTextDefault). 400 on a validation
 *  failure. `welcomeText: null` is an explicit CLEAR (revert to the default). */
export function putSettings(patch: SettingsPatch): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings', {
    method: 'PUT',
    body: patch,
  });
}

// --- Settings ▸ Notifications (/api/push) -----------------------------------
// This-device push. Every route 503s `push_not_configured` when VAPID is
// unconfigured in the environment — callers must handle that gracefully.

/** GET /api/push/vapid-public-key — the key the SW passes to pushManager.subscribe
 *  (unwrapped from { publicKey }). 503 push_not_configured when VAPID is unset. */
export async function getVapidPublicKey(signal?: AbortSignal): Promise<string> {
  const res = await request<{ publicKey: string }>('/api/push/vapid-public-key', {
    ...(signal !== undefined && { signal }),
  });
  return res.publicKey;
}

/** POST /api/push/subscriptions { subscription } — store THIS device's
 *  subscription on the caller's user. Returns the device count. */
export function subscribePush(
  subscription: PushSubscriptionJSON | PushSubscription,
): Promise<{ subscriptionCount: number }> {
  return request<{ subscriptionCount: number }>('/api/push/subscriptions', {
    method: 'POST',
    body: { subscription },
  });
}

/** DELETE /api/push/subscriptions { endpoint } — remove THIS device (204). */
export function unsubscribePush(endpoint: string): Promise<void> {
  return request<void>('/api/push/subscriptions', {
    method: 'DELETE',
    body: { endpoint },
  });
}

/** POST /api/push/test — self-test send to the caller's own devices; returns the
 *  per-call tally. 503 push_not_configured when VAPID is unset. */
export function sendPushTest(): Promise<{ sent: number; failed: number; [k: string]: unknown }> {
  return request<{ sent: number; failed: number; [k: string]: unknown }>('/api/push/test', {
    method: 'POST',
  });
}

// --- Settings ▸ System Status (/api/system) (admin-only on the server) -------
// Admin-only (403 a VA upstream); the tab is admin-only + route-guarded too.
// Flags always load (config only). Alarms/errors degrade to { available: false,
// reason } (still HTTP 200) when AWS is unreachable (local/hermetic).

/** GET /api/system/flags — go-live readiness from runtime config (always loads). */
export function getSystemFlags(signal?: AbortSignal): Promise<SystemFlags> {
  return request<SystemFlags>('/api/system/flags', { ...(signal !== undefined && { signal }) });
}

/** GET /api/system/alarms — CloudWatch alarms (ALARM-first) or { available:false, reason }. */
export function getSystemAlarms(signal?: AbortSignal): Promise<SystemAlarmsResult> {
  return request<SystemAlarmsResult>('/api/system/alarms', {
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/system/errors?since= — recent error events (PII-safe) or { available:false, reason }. */
export function getSystemErrors(
  since: '1h' | '24h' | '7d',
  signal?: AbortSignal,
): Promise<SystemErrorsResult> {
  return request<SystemErrorsResult>('/api/system/errors', {
    query: { since },
    ...(signal !== undefined && { signal }),
  });
}

// --- Tours (/api/tours) -------------------------------------------------------
// First-class Tour entity (Tours feature). Tours are separate from placements —
// scheduling a tour does NOT change tenant status or create a placement.
// The exit gate (PATCH { outcome, moveForward }) records the navigator decision;
// tour becomes `convertible` when moveForward is true. Conversion is downstream.

/** POST /api/tours — schedule a new tour.
 *  When `scheduledAt` is present → status 'scheduled' (reminders armed).
 *  When `scheduledAt` is absent  → status 'requested' (time-less tour request;
 *  no reminders). Returns the created tour (unwrapped from { tour }). */
export async function createTour(body: {
  tenantId: string;
  unitId: string;
  /** Omit to create a time-less `requested` tour; include a future ISO 8601
   *  datetime to create a `scheduled` tour with reminders armed. */
  scheduledAt?: string;
  tourType: TourType;
}): Promise<Tour> {
  const res = await request<{ tour: Tour }>('/api/tours', { method: 'POST', body });
  return res.tour;
}

/** GET /api/tours/:tourId — one tour record. Throws ApiError(404) when not found.
 *  Returns the tour (unwrapped from { tour }). */
export async function getTour(tourId: string, signal?: AbortSignal): Promise<Tour> {
  const res = await request<{ tour: Tour }>(`/api/tours/${encodeURIComponent(tourId)}`, {
    ...(signal !== undefined && { signal }),
  });
  return res.tour;
}

/** GET /api/tours?tenantId=&unitId=&from=&to=&status= — list tours by filter.
 *  Exactly one of tenantId / unitId / (from+to) / status must be provided
 *  (server enforces). `status` may be supplied as a sole filter (e.g. 'requested'
 *  to fetch all time-less tour requests). Returns the tours array (unwrapped from
 *  { tours }). */
export async function getTours(
  params: {
    tenantId?: string;
    unitId?: string;
    from?: string;
    to?: string;
    /** Optional sole-filter status, e.g. 'requested' to fetch unscheduled tours. */
    status?: TourStatus;
  },
  signal?: AbortSignal,
): Promise<Tour[]> {
  const res = await request<ToursPage>('/api/tours', {
    query: {
      ...(params.tenantId !== undefined && { tenantId: params.tenantId }),
      ...(params.unitId !== undefined && { unitId: params.unitId }),
      ...(params.from !== undefined && { from: params.from }),
      ...(params.to !== undefined && { to: params.to }),
      ...(params.status !== undefined && { status: params.status }),
    },
    ...(signal !== undefined && { signal }),
  });
  return res.tours;
}

/** PATCH /api/tours/:tourId — partial update: reschedule, change status, or
 *  record the exit-gate decision (outcome + moveForward). Sending
 *  { outcome, moveForward } closes the tour and sets convertible.
 *  Returns the updated tour (unwrapped from { tour }). */
export async function patchTour(
  tourId: string,
  patch: {
    scheduledAt?: string;
    status?: TourStatus;
    outcome?: TourOutcome;
    moveForward?: boolean;
  },
): Promise<Tour> {
  const res = await request<{ tour: Tour }>(`/api/tours/${encodeURIComponent(tourId)}`, {
    method: 'PATCH',
    body: patch,
  });
  return res.tour;
}

/** POST /api/tours/:tourId/relay { members } — provision a masked relay group
 *  thread for the tour. Stamps groupThreadId back on the tour.
 *  Returns the updated tour + the new conversation (unwrapped). */
export async function createTourRelay(
  tourId: string,
  members: Array<{ phone: string; contactId?: string; name?: string }>,
): Promise<{ tour: Tour; conversation: unknown }> {
  return request<{ tour: Tour; conversation: unknown }>(
    `/api/tours/${encodeURIComponent(tourId)}/relay`,
    { method: 'POST', body: { members } },
  );
}
