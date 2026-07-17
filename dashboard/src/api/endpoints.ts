// Typed endpoint functions - one per route. Every function returns a typed
// result and throws ApiError on non-2xx (see api/client.ts). Components import
// these (via api/index.ts) and never construct fetch calls by hand.
import { ApiError, request } from './client.js';
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
  ConversationHeader,
  ConversationParticipant,
  ConversationsPage,
  DevLoginResult,
  HistoryRow,
  InboxFilter,
  InboxPage,
  InspectionOutcome,
  LandlordStatus,
  ListingSendRow,
  ListingStatus,
  LostReason,
  Me,
  MeUser,
  Message,
  PhotoPresignGrant,
  PlacementNudgeView,
  RelatedUnit,
  RelayGroupRow,
  SendMessageResult,
  SimilarUnit,
  SystemAlarmsResult,
  SystemErrorsResult,
  SystemFlags,
  TenantStatus,
  TodayResponse,
  TimelineScheduled,
  TransitionSource,
  Tour,
  TourActivityEvent,
  TourOutcome,
  TourStatus,
  TourType,
  ToursPage,
  TourRemindersPage,
  TourReminderView,
  UnitActivityEvent,
  UnitItem,
  UnitsPage,
  MmsMediaAttachment,
} from './types.js';

// --- Auth (/auth) -----------------------------------------------------------

/** GET /auth/me - the current principal, or throws ApiError(401) when anonymous. */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return request<Me>('/auth/me', { ...(signal !== undefined && { signal }) });
}

/** POST /auth/logout - global session revocation (204). */
export function logout(): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST' });
}

/** The login URL - a plain navigation (the server drives the OAuth dance).
 *  Not a fetch: use it as an <a href> / window.location.assign(loginUrl()). */
export function loginUrl(): string {
  return '/auth/login';
}

// --- Today (/api) -----------------------------------------------------------
// The server-assembled action queue (API Contract C7). When the backend slice
// isn't live yet this 404s; useToday catches ApiError(404) and assembles the
// same shape client-side from getPlacements() + getConversations().

/** GET /api/today - the server-assembled Today queue, or throws ApiError(404)
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

/** GET /api/placements - the placement board (the Today fallback's deadline/tour/attention
 *  source). The server pages; pass `cursor` to fetch the next page (the
 *  placement board pages through ALL of them - see usePlacements). Other callers
 *  (Today / property / contact-file) read only the first page (no cursor). */
export function getPlacements(signal?: AbortSignal, cursor?: string): Promise<PlacementsPage> {
  return request<PlacementsPage>('/api/placements', {
    query: { cursor },
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/placements/:placementId - a single placement record (the placement detail page + the
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

/** POST /api/placements/from-tour — the Post-Tour & Application conversion: turn a
 *  CONVERTIBLE tour into a placement. The backend reuses the placement-create path,
 *  finalizes the tour (closed + convertedPlacementId + reminders canceled) and
 *  re-parents the tour's masked relay thread to the new placement. Body { tourId }.
 *  Returns the { placement, tour } envelope as-is (the new placement + the finalized
 *  tour). Throws ApiError on non-2xx — 409 tour_not_convertible / tour_already_converted,
 *  404 tour_not_found / tenant_not_found / unit_not_found. */
export function createPlacementFromTour(
  tourId: string,
): Promise<{ placement: PlacementItem; tour: Tour }> {
  return request<{ placement: PlacementItem; tour: Tour }>('/api/placements/from-tour', {
    method: 'POST',
    body: { tourId },
  });
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
  /** Inspection date (YYYY-MM-DD), written on the move OUT of awaiting_inspection. */
  inspectionDate?: string;
  /** Determined rent (>0), written on the move OUT of determine_rent. */
  rentDetermined?: number;
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
    ...(input.inspectionDate !== undefined && { inspectionDate: input.inspectionDate }),
    ...(input.rentDetermined !== undefined && { rentDetermined: input.rentDetermined }),
  };
}

/** POST /api/placements/:placementId/transition - move a placement to a new stage through
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

/** PATCH /api/placements/:id - partial update (SET-merge; only changed fields
 *  sent). Used for the complete-paperwork checklist toggles (lease_signed / lif /
 *  move_in_details). Returns the updated placement (unwrapped from { placement }). */
export async function updatePlacement(
  placementId: string,
  patch: {
    lease_signed?: boolean;
    lif?: boolean;
    move_in_details?: boolean;
    // In-place stage-data (Approval & Move-in) — the server 409s any of these
    // written at the wrong stage; value shapes match the placement fields.
    inspection_date?: string;
    rent_determined?: number;
    inspection_outcome?: InspectionOutcome;
  },
): Promise<PlacementItem> {
  const res = await request<{ placement: PlacementItem }>(
    `/api/placements/${encodeURIComponent(placementId)}`,
    { method: 'PATCH', body: patch },
  );
  return res.placement;
}

/** GET /api/placements/:placementId/history - the placement's provenance trail (newest
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

/** GET /api/placements/:placementId/nudges — the armed application-nudge rungs
 *  (receipt/completion/approval checks + rta_window_closing), each with its state
 *  (upcoming - sent - canceled) and derived recipient. The server wraps the list
 *  under { nudges }; unwrapped here so callers get a plain PlacementNudgeView[]. */
export async function getPlacementNudges(
  placementId: string,
  signal?: AbortSignal,
): Promise<PlacementNudgeView[]> {
  const res = await request<{ nudges: PlacementNudgeView[] }>(
    `/api/placements/${encodeURIComponent(placementId)}/nudges`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.nudges;
}

/** PATCH /api/placements/:placementId/nudges/:nudgeId { canceled } — cancel one
 *  upcoming nudge, or restore (un-cancel) a canceled one. 409 when the rung is
 *  already sent or the transition raced the send poll — the response carries the
 *  honest current state either way. Returns the updated nudge (unwrapped from
 *  { nudge }). */
export async function patchPlacementNudge(
  placementId: string,
  nudgeId: string,
  canceled: boolean,
): Promise<PlacementNudgeView> {
  const res = await request<{ nudge: PlacementNudgeView }>(
    `/api/placements/${encodeURIComponent(placementId)}/nudges/${encodeURIComponent(nudgeId)}`,
    { method: 'PATCH', body: { canceled } },
  );
  return res.nudge;
}

/** POST /api/placements/:placementId/relay — provision the placement's masked
 *  relay group thread (tenant + the unit's landlord, by their SMS numbers) and
 *  link placement.group_thread. Idempotent: 409 relay_exists when an OPEN relay
 *  already fronts the placement; 503 relay_provisioning_disabled (kill-switch) /
 *  pool_number_unavailable; 400 tenant_unreachable / landlord_unreachable /
 *  unit_not_found; 404 placement_not_found. The server responds 201
 *  { conversation, placement }; we unwrap the new thread's id. */
export async function provisionPlacementRelay(
  placementId: string,
): Promise<{ conversationId: string }> {
  const res = await request<{ conversation: { conversationId: string }; placement: PlacementItem }>(
    `/api/placements/${encodeURIComponent(placementId)}/relay`,
    { method: 'POST' },
  );
  return { conversationId: res.conversation.conversationId };
}

/** POST /api/placements/:placementId/deadline { type:'follow_up', at } — arm the
 *  placement's MANUAL follow-up deadline (a first-class placementDeadlines item;
 *  system-managed rta_window/voucher_expiration are off-limits here). The server
 *  returns { placement }; we ignore it (callers refetch on placement.updated).
 *  404 placement_not_found; 400 on a bad/missing `at`. */
export async function setPlacementFollowUp(placementId: string, at: string): Promise<void> {
  await request<{ placement: PlacementItem }>(
    `/api/placements/${encodeURIComponent(placementId)}/deadline`,
    { method: 'POST', body: { type: 'follow_up', at } },
  );
}

/** POST /api/placements/:placementId/deadline { clear:true } — retire the
 *  placement's manual follow-up deadline. The server returns { placement }; we
 *  ignore it (callers refetch on placement.updated). 404 placement_not_found. */
export async function clearPlacementFollowUp(placementId: string): Promise<void> {
  await request<{ placement: PlacementItem }>(
    `/api/placements/${encodeURIComponent(placementId)}/deadline`,
    { method: 'POST', body: { clear: true } },
  );
}

/** PATCH /api/contacts/:contactId/tenant-status - set a contact's lifecycle
 *  status through the transition service (applies provenance/derivation -
 *  NEVER use a plain contact PATCH for lifecycle status). Despite the historic
 *  name, the route serves ALL contact types: it validates `toStatus` against
 *  the STORED contact's own type-scoped allowlist (tenant lifecycle vs the
 *  landlord lead lifecycle), so the input type is the union. Returns the
 *  updated contact (unwrapped from { contact }). */
export async function setTenantStatus(
  contactId: string,
  input: {
    toStatus: TenantStatus | LandlordStatus;
    source: TransitionSource;
    reason?: string;
    porting?: boolean;
  },
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

/** PATCH /api/units/:unitId/listing-status - set a property's lifecycle status
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

/** GET /api/conversations - the inbox rows (the Today fallback's unread +
 *  untriaged source). */
export function getConversations(signal?: AbortSignal): Promise<ConversationsPage> {
  return request<ConversationsPage>('/api/conversations', {
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/conversations/:id/messages - newest-first page of a conversation's
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

/** GET /api/conversations/:id/scheduled - the group thread's "Upcoming" bucket:
 *  the not-yet-sent tour-reminder rungs that will route to this masked group
 *  (same TimelineScheduled shape the contact timeline ships). Empty for 1:1
 *  conversations (their upcoming lives on the contact timeline). */
export async function getConversationScheduled(
  conversationId: string,
  signal?: AbortSignal,
): Promise<TimelineScheduled[]> {
  const res = await request<{ scheduled: TimelineScheduled[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/scheduled`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.scheduled;
}

/** POST /api/conversations/:id/messages - a manual human send (the reply box).
 *  `attachmentKeys` are the deliverable rendition keys confirmMmsMedia() returned;
 *  `attachmentOriginalKeys` (index-aligned) are the pristine uploads (RCS-forward).
 *  The server presigns + persists them as media_attachments (the dashboard never
 *  passes raw mediaUrls - that seam stays internal/e2e-only). */
export function sendMessage(
  conversationId: string,
  body: {
    body?: string;
    mediaUrls?: string[];
    attachmentKeys?: string[];
    attachmentOriginalKeys?: string[];
  },
): Promise<SendMessageResult> {
  return request<SendMessageResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: 'POST', body },
  );
}

/** POST /api/media/presign { contentType } - mint a direct-to-S3 grant for one MMS
 *  attachment. The browser then uploadToPresignedPost()s the file, then confirms.
 *  Throws ApiError (400 unsupported_media_type, 503 media_storage_unavailable). */
export function presignMmsMedia(
  contentType: string,
): Promise<{ key: string; post: { url: string; fields: Record<string, string> } }> {
  return request<{ key: string; post: { url: string; fields: Record<string, string> } }>(
    '/api/media/presign',
    { method: 'POST', body: { contentType } },
  );
}

/** POST /api/media/confirm { key } - server validates/transcodes the uploaded
 *  original and returns the deliverable MMS attachment (jpeg for webp/pdf/oversized;
 *  the original for gif/small jpeg-png). Throws ApiError (400 transcode_failed with
 *  a `detail`, unknown_attachment, file_too_large_after_fit; 503 transcode_busy). */
export async function confirmMmsMedia(key: string): Promise<MmsMediaAttachment> {
  const res = await request<{ attachment: MmsMediaAttachment }>(
    '/api/media/confirm',
    { method: 'POST', body: { key } },
  );
  return res.attachment;
}

/** POST /api/conversations/:id/messages/:providerSid/retry - re-send a FAILED
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

// --- Conversation header + relay-group management (/api/conversations) ------
// The relay-group conversation view (/conversations/:id). GET the rich header,
// read/manage the roster, and close/reopen. The header is the RAW ConversationItem
// (ConversationHeader) — NOT the denormalized ConversationSummary. The roster
// routes live on the relay-groups router (mounted at /api); a non-relay id 404s
// the member/close routes (relay_group_not_found).

/** GET /api/conversations/:id → { conversation }. The rich header (type / status /
 *  pool_number / owner / placement_tag / participants) the relay-group view reads;
 *  unwrapped here. Throws ApiError(404) when the conversation is missing. */
export async function getConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationHeader> {
  const res = await request<{ conversation: ConversationHeader }>(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.conversation;
}

/** GET /api/conversations/:id/members → { members }. The relay group's current
 *  roster (unwrapped). 404 relay_group_not_found for a non-relay / missing id. */
export async function getConversationMembers(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationParticipant[]> {
  const res = await request<{ members: ConversationParticipant[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.members;
}

/** POST /api/conversations/:id/members { phone, contactId?, name? } → { members }.
 *  Idempotent add; returns the updated roster. Throws ApiError(409 roster_conflict)
 *  on an optimistic-concurrency collision (the caller refetches the roster). */
export async function addConversationMember(
  conversationId: string,
  member: { phone: string; contactId?: string; name?: string },
): Promise<ConversationParticipant[]> {
  const res = await request<{ members: ConversationParticipant[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members`,
    {
      method: 'POST',
      body: {
        phone: member.phone,
        ...(member.contactId !== undefined && { contactId: member.contactId }),
        ...(member.name !== undefined && { name: member.name }),
      },
    },
  );
  return res.members;
}

/** DELETE /api/conversations/:id/members/:phone → { members }. Idempotent remove;
 *  returns the updated roster. Throws ApiError(409 roster_conflict) on a collision. */
export async function removeConversationMember(
  conversationId: string,
  phone: string,
): Promise<ConversationParticipant[]> {
  const res = await request<{ members: ConversationParticipant[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(phone)}`,
    { method: 'DELETE' },
  );
  return res.members;
}

/** PATCH /api/conversations/:id/close { closed } → { conversation }. Closing
 *  KEEPS the pool number (the closed group still intercepts late texts from
 *  still-rostered members into their 1:1) and sends one final "group is closed"
 *  message; reopening (closed=false) flips the status back on the SAME number and
 *  provisions nothing. Returns the updated header. */
export async function closeConversation(
  conversationId: string,
  closed: boolean,
): Promise<ConversationHeader> {
  const res = await request<{ conversation: ConversationHeader }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/close`,
    { method: 'PATCH', body: { closed } },
  );
  return res.conversation;
}

/** POST /api/conversations/:id/close-nag/defer - "Keep open" on a relay group's
 *  close nag: the server pushes the next nag out 28 days (fixed, no body). Returns
 *  the updated header (carrying the fresh close_nag_next_at). Throws
 *  ApiError(404 relay_group_not_found) for a non-relay / missing id. */
export async function deferCloseNag(conversationId: string): Promise<ConversationHeader> {
  const res = await request<{ conversation: ConversationHeader }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/close-nag/defer`,
    { method: 'POST' },
  );
  return res.conversation;
}

/** POST /api/conversations/:id/read — zero the conversation's unread counter
 *  (the operator opened the thread). Used by the relay-group view on view; the
 *  1:1 mark-read stays the contact fan-out (markInboxRead). */
export function markConversationRead(conversationId: string, signal?: AbortSignal): Promise<void> {
  return request<void>(`/api/conversations/${encodeURIComponent(conversationId)}/read`, {
    method: 'POST',
    ...(signal !== undefined && { signal }),
  });
}

/** POST /api/units - create a unit (property) under a landlord. The body carries
 *  the owning landlordId plus the writable unit fields; the server validates them
 *  against a strict allowlist + types and stamps the initial status ('setup').
 *  Returns the created unit (unwrapped from { unit }). */
export async function createUnit(body: Record<string, unknown>): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>('/api/units', { method: 'POST', body });
  return res.unit;
}

/** GET /api/units - the unit records. The landlord file filters this by
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

/** GET /api/units/:id - a single unit record (the property detail page header +
 *  details + photos). Wrapped under { unit } on the wire; unwrapped here. */
export async function getUnit(unitId: string, signal?: AbortSignal): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(`/api/units/${encodeURIComponent(unitId)}`, {
    ...(signal !== undefined && { signal }),
  });
  return res.unit;
}

/** PATCH /api/units/:id - partial update (SET-merge; only changed fields sent).
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

/** DELETE /api/units/:id - SOFT-delete the property (stamp deleted_at). The record
 *  + all data are retained; it's hidden from the lists and can be restored.
 *  Returns the updated (deleted) unit. */
export async function deleteUnit(unitId: string): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(`/api/units/${encodeURIComponent(unitId)}`, {
    method: 'DELETE',
  });
  return res.unit;
}

/** POST /api/units/:id/restore - clear deleted_at, bringing a soft-deleted property
 *  back into the normal views. Returns the updated unit. */
export async function restoreUnit(unitId: string): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}/restore`,
    { method: 'POST' },
  );
  return res.unit;
}

/** GET /api/units/:id/related (C3) - duplex-sibling / same-landlord properties.
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

/** GET /api/units/:id/recipients (C4) - the "Sent to tenants" rows (recipients,
 *  each with an optional derived tour signal). 404s until BE4 lands ? the panel
 *  renders a "pending backend" state. */
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

/** GET /api/units/:id/similar (C6) - available comps ranked by similarity.
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

/** GET /api/units/:id/activity — the property's audit-trail Activity rows,
 *  newest-first. 404s on an older deployed backend → the Activity card renders
 *  a "pending backend" state. */
export async function getUnitActivity(
  unitId: string,
  signal?: AbortSignal,
): Promise<UnitActivityEvent[]> {
  const res = await request<{ events: UnitActivityEvent[] }>(
    `/api/units/${encodeURIComponent(unitId)}/activity`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.events;
}

/** POST /api/units/:id/photos/presign { count, contentTypes[] } - mint one
 *  direct-upload grant per chosen file (unit-photos direct-upload R4). The
 *  browser derives count + content types from the Files; the server returns a
 *  presigned S3/MinIO POST per file so the BYTES go browser->S3 directly, never
 *  through the app. This CAN use request() (it is a plain JSON call). Throws
 *  ApiError on the guards (400 unsupported_media_type / photo_cap_exceeded,
 *  404 unit_not_found, 503 media_storage_unavailable). Grants come back in the
 *  same order as `files`. */
export async function presignUnitPhotos(
  unitId: string,
  files: File[],
): Promise<PhotoPresignGrant[]> {
  const res = await request<{ uploads: PhotoPresignGrant[] }>(
    `/api/units/${encodeURIComponent(unitId)}/photos/presign`,
    { method: 'POST', body: { count: files.length, contentTypes: files.map((f) => f.type) } },
  );
  return res.uploads;
}

/** POST a single file DIRECTLY to its presigned S3/MinIO target (unit-photos
 *  direct-upload R4). This must NOT go through request() / a credentialed fetch:
 *  it targets S3 CROSS-ORIGIN and must carry NO session cookie and NO CSRF
 *  header (an extra signed-out header would break the POST policy). S3 requires
 *  the policy `fields` FIRST and the File LAST, under the field name `file`
 *  (S3 ignores any part after `file`). Resolves on 2xx (S3 returns 204 No
 *  Content); rejects (ApiError) on any non-2xx or network error so the caller
 *  can count per-file failures. When `onProgress` (0..1) is supplied the upload
 *  runs via XHR to report real per-file progress; otherwise a plain fetch. */
export async function uploadToPresignedPost(
  post: { url: string; fields: Record<string, string> },
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const form = new FormData();
  // Field order matters: every policy field precedes the file, and `file` is LAST.
  for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
  form.append('file', file);

  if (onProgress !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', post.url);
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable && ev.total > 0) onProgress(ev.loaded / ev.total);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new ApiError(xhr.status, 's3_upload_failed', `S3 upload failed (${xhr.status})`));
      });
      xhr.addEventListener('error', () =>
        reject(new ApiError(0, 'network_error', 'Network request failed')),
      );
      xhr.send(form);
    });
    return;
  }

  let res: Response;
  try {
    // credentials 'omit': never leak the dashboard session cookie to S3.
    res = await fetch(post.url, { method: 'POST', body: form, credentials: 'omit' });
  } catch {
    throw new ApiError(0, 'network_error', 'Network request failed');
  }
  if (!res.ok) {
    throw new ApiError(res.status, 's3_upload_failed', `S3 upload failed (${res.status})`);
  }
}

/** POST /api/units/:id/photos/confirm { keys[] } - record the keys that uploaded
 *  OK to S3 (unit-photos direct-upload R4). The server re-verifies each key
 *  (own-prefix scope + HeadObject type/size), drops the invalid, atomically
 *  appends the survivors under the 100-cap re-guard, and returns the updated unit
 *  (WITH mediaDisplay). A plain JSON call. Throws ApiError (400 no_valid_photos /
 *  photo_cap_exceeded, 503 media_storage_unavailable). */
export async function confirmUnitPhotos(unitId: string, keys: string[]): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}/photos/confirm`,
    { method: 'POST', body: { keys } },
  );
  return res.unit;
}

/** DELETE /api/units/:id/photos { entry } - drop one photo (the array entry only;
 *  no S3 object deletion). 404 unit_or_photo_not_found on an unknown entry. Returns
 *  the updated unit (WITH mediaDisplay), unwrapped from { unit }. */
export async function removeUnitPhoto(unitId: string, entry: string): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}/photos`,
    { method: 'DELETE', body: { entry } },
  );
  return res.unit;
}

/** PUT /api/units/:id/photos/cover { entry } - make `entry` the cover (move to the
 *  front = hero + flyer lead photo). No-op success when it is already the cover;
 *  404 unit_or_photo_not_found on an unknown entry. Returns the updated unit (WITH
 *  mediaDisplay), unwrapped from { unit }. */
export async function setUnitPhotoCover(unitId: string, entry: string): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}/photos/cover`,
    { method: 'PUT', body: { entry } },
  );
  return res.unit;
}

// --- Contacts (/api/contacts) -----------------------------------------------
// The contact detail page (B2 tenant / B3 landlord). getContact exists today
// (legacy Contact, single `phone`); the timeline / listings-sent / media slices
// (C2/C4/C5) 404 until BE1-BE5 land, so callers degrade gracefully.

/** GET /api/contacts - the records list (the Contacts list views' source). The
 *  server REQUIRES a `type` filter (unless an exact `phone` lookup is given), so
 *  callers fetch one type at a time; the "all Contacts" view fans out per type
 *  and merges. First page only (the server pages via nextCursor) - the list
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

/** GET /api/contacts/:id - the contact record (the detail page header + file).
 *  Wrapped under { contact } on the wire; unwrapped here. */
export async function getContact(contactId: string, signal?: AbortSignal): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.contact;
}

/** GET /api/contacts/:id/timeline (C2) - the server-merged person-centric
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

/** GET /api/contacts/:id/listings-sent (C4) - the "Properties sent" rows. 404s
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

/** GET /api/contacts/:id/media (C5) - aggregated comms media. 404s until BE5
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

/** GET /api/contacts/:id/relay-groups — the contact's group-text (relay)
 *  memberships, open + closed, newest-activity-first. 404s on a backend
 *  without the route → the "Group texts" card renders its pending state. */
export async function getContactRelayGroups(
  contactId: string,
  signal?: AbortSignal,
): Promise<RelayGroupRow[]> {
  const res = await request<{ groups: RelayGroupRow[] }>(
    `/api/contacts/${encodeURIComponent(contactId)}/relay-groups`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.groups;
}

// --- Contact mutations (edit / triage / phones / opt-out) -------------------

/** PATCH /api/contacts/:id - edit/triage a contact. Send only the changed fields
 *  (the server SET-merges). Returns the updated contact (unwrapped). */
export async function updateContact(contactId: string, patch: ContactPatch): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}`,
    { method: 'PATCH', body: patch },
  );
  return res.contact;
}

/** POST /api/contacts - create a brand-new contact record. Returns the new
 *  contact (unwrapped from { contact }). */
export async function createContact(body: ContactCreate): Promise<Contact> {
  const res = await request<{ contact: Contact }>('/api/contacts', { method: 'POST', body });
  return res.contact;
}

/** GET /api/contacts/vocabulary - the operator-configured pick-lists used by
 *  the contact creation form (roles, relationship roles, custom field labels).
 *  Unwrapped from { vocabulary }. */
export async function getContactVocabulary(signal?: AbortSignal): Promise<ContactVocabulary> {
  const res = await request<{ vocabulary: ContactVocabulary }>('/api/contacts/vocabulary', {
    ...(signal !== undefined && { signal }),
  });
  return res.vocabulary;
}

/** POST /api/contacts/:id/phones - add a number to the contact's roster (idempotent
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

/** PATCH /api/contacts/:id/phones/:phone - set a number primary and/or relabel it.
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

/** DELETE /api/contacts/:id/phones/:phone - remove a non-primary number. Returns
 *  the updated contact with the canonical `phones[]`. */
export async function removeContactPhone(contactId: string, phone: string): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/phones/${encodeURIComponent(phone)}`,
    { method: 'DELETE' },
  );
  return res.contact;
}

/** POST /api/contacts/:id/opt-out - mark the contact Do-Not-Contact (sms_opt_out)
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

/** DELETE /api/contacts/:id - SOFT-delete the contact (stamp deleted_at). The
 *  record + all data are retained; it's hidden from lists/inbox/today and can be
 *  restored. Returns the updated (deleted) contact. */
export async function deleteContact(contactId: string): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}`,
    { method: 'DELETE' },
  );
  return res.contact;
}

/** POST /api/contacts/:id/conversation — create-or-get the 1:1 thread for the
 *  contact's PRIMARY number (idempotent), so a brand-new contact can be texted
 *  before they've ever messaged us. Returns the conversationId to send into. */
export async function ensureContactConversation(contactId: string): Promise<string> {
  const res = await request<{ conversation: { conversationId: string } }>(
    `/api/contacts/${encodeURIComponent(contactId)}/conversation`,
    { method: 'POST' },
  );
  return res.conversation.conversationId;
}

/** POST /api/contacts/:id/restore - clear deleted_at, bringing a soft-deleted
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

/** GET /__dev/ping - availability probe for the hermetic dev router. Resolves
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

/** POST /auth/dev-login - log in as a dev user (sets the session cookie). The
 *  server auto-provisions the user if missing, so this works on an unseeded
 *  local DB too (known personas keep their role; others default to admin). */
export function devLogin(email = 'va@example.com'): Promise<DevLoginResult> {
  return request<DevLoginResult>('/auth/dev-login', { method: 'POST', body: { email } });
}

// --- Inbox (/api/inbox) (API Contract C8) ----------------------------------
// The entity-centric inbox feed + its read mutations. GET 404s until the
// BE7/C8 backend slice lands ? useInbox catches that and degrades to 'pending'.

/** GET /api/inbox - one page of inbox rows for a filter (newest-activity-first,
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

/** POST /api/inbox/:contactId/read (contact rows) - or POST /api/inbox/read
 *  { phone } (unknown rows, keyed by number) - mark the comms read. */
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
 *  always-on opt-out/unreachable fences. Matching sends: `audience_filter` is
 *  now OPTIONAL — omitting it while passing `seedContactIds` creates a
 *  seeds_only draft (the seeded 1:1/1:N entry) instead of the whole tenant
 *  base; `flyerUrl` on the response is present only when `unitId` was given. */
export function createBroadcast(body: {
  unitId?: string;
  body_template: string;
  audience_filter?: AudienceFilter;
  seedContactIds?: string[];
}): Promise<{
  broadcastId: string;
  status: 'draft';
  estimatedCount: number;
  truncated: boolean;
  flyerUrl?: string;
}> {
  return request<{
    broadcastId: string;
    status: 'draft';
    estimatedCount: number;
    truncated: boolean;
    flyerUrl?: string;
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

/** PATCH /api/broadcasts/:id - replace the draft's hand-picked seed list. */
export async function updateBroadcastSeeds(
  broadcastId: string,
  seedContactIds: string[],
): Promise<{ broadcastId: string; seedContactIds: string[] }> {
  return request(`/api/broadcasts/${encodeURIComponent(broadcastId)}`, {
    method: 'PATCH',
    body: { seedContactIds },
  });
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

/** DELETE /api/users/:userId (admin) -- remove a team member (hard delete). 409
 *  cannot_remove_last_admin / cannot_remove_self / voice_line_assigned on a
 *  guard (surfaced inline). 200 { removed:true } on success. */
export function removeUser(userId: string): Promise<{ removed: true }> {
  return request<{ removed: true }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
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

/** POST /api/tours — create a new tour. `scheduledAt` is OPTIONAL: with it the
 *  tour is created 'scheduled' (the reminder ladder arms server-side); without
 *  it the tour is created time-less — status 'requested', NO reminders — and
 *  booked later (a PATCH that sets scheduledAt flips it to 'scheduled' and arms
 *  reminders exactly once). The key is OMITTED from the wire body when absent
 *  (never sent as undefined). Returns the created tour (unwrapped from { tour }). */
export async function createTour(body: {
  tenantId: string;
  unitId: string;
  /** Omit to create a time-less `requested` tour; include a future ISO 8601
   *  datetime to create a `scheduled` tour with reminders armed. */
  scheduledAt?: string;
  tourType: TourType;
}): Promise<Tour> {
  const { scheduledAt, ...rest } = body;
  const res = await request<{ tour: Tour }>('/api/tours', {
    method: 'POST',
    body: { ...rest, ...(scheduledAt !== undefined && { scheduledAt }) },
  });
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

/** GET /api/tours/:tourId/reminders — the armed reminder ladder for a tour
 *  (confirmation / day_before / morning_of / en_route / no_show_checkin), each
 *  rung's state (upcoming - sent - canceled) plus the NEXT rung to fire. Returns
 *  { reminders, next? } as-is (no unwrap). */
export async function getTourReminders(
  tourId: string,
  signal?: AbortSignal,
): Promise<TourRemindersPage> {
  return request<TourRemindersPage>(
    `/api/tours/${encodeURIComponent(tourId)}/reminders`,
    { ...(signal !== undefined && { signal }) },
  );
}

/** PATCH /api/tours/:tourId/reminders/:reminderId { canceled } — cancel one
 *  upcoming rung, or restore (un-cancel) a canceled one. 409 when the rung is
 *  already sent/skipped or the transition raced the send poll — the response
 *  carries the honest current state either way. */
export async function patchTourReminder(
  tourId: string,
  reminderId: string,
  canceled: boolean,
): Promise<TourReminderView> {
  const res = await request<{ reminder: TourReminderView }>(
    `/api/tours/${encodeURIComponent(tourId)}/reminders/${encodeURIComponent(reminderId)}`,
    { method: 'PATCH', body: { canceled } },
  );
  return res.reminder;
}

/** GET /api/tours/:tourId/activity?limit=&before= - the tour's OWN lifecycle
 *  history (newest-first), for the Activity card. Mirrors getPlacementHistory:
 *  `limit` bounds the page, `before` (a prior row's `id`) pages older. The server
 *  wraps the page under { events }; we unwrap it so callers get a plain
 *  TourActivityEvent[]. */
export async function getTourActivity(
  tourId: string,
  opts: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<TourActivityEvent[]> {
  const res = await request<{ events: TourActivityEvent[] }>(
    `/api/tours/${encodeURIComponent(tourId)}/activity`,
    {
      query: { limit: opts.limit, before: opts.before },
      ...(signal !== undefined && { signal }),
    },
  );
  return res.events;
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

/** POST /api/tours/:tourId/relay — provision a masked relay group thread for
 *  the tour. `members` is optional: when omitted the server auto-resolves
 *  [tenant contact, unit's landlord contact] (phones + names). Stamps
 *  groupThreadId back on the tour. Errors: 409 relay_already_provisioned when
 *  the tour already has a group; 400 relay_member_unresolvable (with `detail`)
 *  when a member can't resolve. Returns the updated tour + the new
 *  conversation (unwrapped). */
export async function createTourRelay(
  tourId: string,
  members?: Array<{ phone: string; contactId?: string; name?: string }>,
): Promise<{ tour: Tour; conversation: unknown }> {
  return request<{ tour: Tour; conversation: unknown }>(
    `/api/tours/${encodeURIComponent(tourId)}/relay`,
    // Omit the members key entirely when not given (server auto-resolves) —
    // never send members: undefined.
    { method: 'POST', body: members !== undefined ? { members } : {} },
  );
}
