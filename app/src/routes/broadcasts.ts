// Share-broadcast ("Share Properties") router (M1.8a) — mounted under /api,
// behind requireAuth + CSRF via the /api mount (app.ts). VAs run share
// broadcasts day-to-day, so NO admin gate (same posture as contacts/units/
// relay-groups).
//
//   POST /api/broadcasts                 { unitId?, body_template, audience_filter?, seedContactIds? } -> 201 { broadcastId, status:'draft', estimatedCount?, audience_filter, truncated, flyerUrl? }
//   POST /api/broadcasts/:id/preview                                                 -> { count, truncated, candidates, priorRecipientContactIds, seedContactIds, unresolvedSeedIds, declinedContactIds, tourHolds, audienceRulesUnavailable? } | 503 audience_rules_unavailable
//   POST /api/broadcasts/:id/send        { recipientContactIds? }                    -> { broadcastId, status:'sending', count } | 400 empty_audience | 503 audience_rules_unavailable
//   GET  /api/broadcasts/:id/results                                                 → { broadcastId, status, stats, recipients }
//   GET  /api/broadcasts/:id/results?view=stats                                      -> { broadcastId, status, unitId, stats, created_at }
//   GET  /api/broadcasts?status=&limit=                                              → { broadcasts:[...], nextCursor }
//   GET  /api/broadcasts/follow-ups                                                  -> { items, byUnit, truncated } | 503 outcome_unavailable
//
// Audience: a FILTER resolves TENANT 1:1 contacts ONLY (never relay-group
// rosters), and only tenants in Onboarding or Searching (matching-blast-rules
// D1), narrowed by ANY of a list of housing authorities (D2) and/or exact
// bedroom size; hand-picked seeds and an explicit recipient list may also
// name PARTNERS, of any status (spec 2026-10-06 D20).
// Opted-out + unreachable are ALWAYS excluded. A tenant with an unresolved
// tour (D4) or a #27 decline is listed for review but not checked by default
// (checkedByDefault, D5), and the no-body filter send (c) leaves them out
// (D6); a failed tours or decline read fails a filter preview and that send
// closed (503 audience_rules_unavailable). The send fans out through the
// SHARED A2P throttle (the broadcast.send job + worker a2pBucket).
//
// Organization names (spec 2026-10-06 D5; matching-blast-rules D2): POST
// answers 422 org_not_on_list (field `audience_filter`, `text` = the FIRST
// failing member) when a member of audience_filter.housing_authorities - or
// the LEGACY one-string housing_authority, read as a one-member list - is not
// a housing authority on the stored org list; a unique spelling is stored as
// the entry's exact name, and the 201 echoes the stored filter in the wire
// shape (wireAudienceFilter: housing_authorities, never housing_authority),
// as do the results and list views. Preview of a DRAFT and the
// filter-resolving send (no recipientContactIds, not seeds_only) re-check
// EVERY member of the STORED list (D7; authoritiesOfFilter, so a legacy row's
// string is its one member): each must be EXACTLY a listed name, else the
// same 422 for the first that is not, where a stored spelling names its entry
// as the one candidate. The curated send, seeds_only drafts and non-draft
// previews are never re-checked; nothing rewrites a broadcast.
//
// PII (doc §9): the preview RESPONSE carries phones (authed/internal — the
// operator needs to see who's in the audience), but LOG LINES never do — IDs/
// counts only. Bodies/templates are never logged.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { mergeContext } from '../lib/context.js';
import { type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { flyerUrl } from '../lib/mergeFields.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createUserRateLimit } from '../middleware/rateLimit.js';
import { enqueueImmediate } from '../jobs/jobs.js';
import { BROADCAST_SEND_JOB } from '../jobs/broadcastFanOut.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createBroadcastsRepo,
  deriveBroadcastStats,
  MAX_BROADCAST_RECIPIENTS,
  type AudienceFilter,
  type BroadcastAudienceMode,
  type BroadcastItem,
  type BroadcastRecipient,
  type BroadcastsRepo,
  type BroadcastStats,
  type BroadcastStatus,
} from '../repos/broadcastsRepo.js';
import { createUnitsRepo, SHAREABLE_STATUSES, isDeleted, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createContactsRepo,
  type ContactDisplayItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import { createMessagesRepo, type MessagesRepo } from '../repos/messagesRepo.js';
import { createSendAttemptsRepo, type SendAttemptsRepo } from '../repos/sendAttemptsRepo.js';
import { createListingSendsRepo, type ListingSendsRepo } from '../repos/listingSendsRepo.js';
import { createToursRepo, type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import { deriveTourActivityAt, deriveTourSignal } from '../lib/listingSendTour.js';
import { deriveListingSendOutcome } from '../lib/listingSendOutcome.js';
import {
  createAudienceResolutionService,
  type AudienceResolutionService,
  type ResolvedContact,
} from '../services/audienceResolution.js';
import {
  priorRecipientKeys,
  resolveRecipientStates,
  retryPendingCount,
  unconfirmedByRow,
  type ClassifiedRecipient,
} from '../services/shareRecipientState.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { checkScalarWrite, isOnListFor, KINDS_FOR_FIELD, type OrgNotOnList } from '../lib/orgNames.js';
import {
  authoritiesOfFilter,
  checkedByDefault as isCheckedByDefault,
  MAX_FILTER_AUTHORITIES,
  TOUR_REQUEST_HOLD_MS,
  tourHoldsByTenant,
  type TourHold,
  wireAudienceFilter,
} from '../lib/blastAudienceRules.js';
import { createOrgNamesService, type OrgNamesService } from '../services/orgNames.js';
import { buildFollowUps } from '../services/followUps.js';

/** The lifecycle statuses ?status= may filter on (byStatus GSI partition). */
const BROADCAST_STATUSES: ReadonlySet<string> = new Set<BroadcastStatus>([
  'draft',
  'sending',
  'sent',
  'failed',
]);

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
/** Sane cap so a template body can't be used to store a huge blob. */
const MAX_TEMPLATE_LEN = 1600;

export interface BroadcastsRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  broadcastsRepo?: BroadcastsRepo;
  unitsRepo?: UnitsRepo;
  contactsRepo?: ContactsRepo;
  /**
   * share-sent-outcome D1: the recipient state reads a young failed-30003
   * slot's newest attempt row (its retry promise and chain end).
   */
  messagesRepo?: MessagesRepo;
  /**
   * share-sent-outcome D1: the composer flag ALONE reads a queued slot's
   * send-attempt record (in flight vs stranded) - through buildReviewRows,
   * which the preview and, since matching-blast-rules D8, draft create both
   * call; no other route reads it.
   */
  sendAttemptsRepo?: SendAttemptsRepo;
  auditRepo?: AuditRepo;
  audienceResolutionService?: AudienceResolutionService;
  /**
   * Organization names (spec 2026-10-06): the housing authority filter is
   * checked against the stored org list. Built ONCE in createApiRouter and
   * threaded down.
   */
  orgNamesService?: OrgNamesService;
  events?: EventBus;
  /**
   * last-heard-from (spec 5.3, 5.6, 14.4 A5): the listing-send record - the
   * preview's not-interested labels and the follow-ups list; since
   * matching-blast-rules also the #27 decline read of buildReviewRows (preview
   * and the create estimate) and send path (c). api.ts passes the SHARED
   * instance (the one the units router reads).
   */
  listingSendsRepo?: ListingSendsRepo;
  /**
   * last-heard-from: the tours a decline (and a follow-up row) is measured
   * against; since matching-blast-rules also the open-tour holds (D4) read by
   * buildReviewRows (preview and the create estimate) and send path (c).
   */
  toursRepo?: ToursRepo;
}

/**
 * Parse + validate an audience_filter from the request body. contact_type is
 * fixed 'tenant' for M1.8 (any other value is rejected — never relay rosters);
 * housing_authorities (matching-blast-rules D2: any-of, an array of at most
 * MAX_FILTER_AUTHORITIES strings; the LEGACY one-string housing_authority is
 * read as a one-member list while the list is absent, and both keys at once
 * is a 400; null reads as absent) and bedroomSize are optional narrowers;
 * opt-out + unreachable are ALWAYS excluded regardless of the request.
 * Members are trimmed, blanks dropped and de-duplicated here
 * (authoritiesOfFilter); the route then checks them against the org list.
 * The result NEVER carries housing_authority, and carries housing_authorities
 * only when non-empty.
 */
function parseAudienceFilter(raw: unknown): AudienceFilter | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'audience_filter must be an object' };
  }
  const f = raw as Record<string, unknown>;
  // contact_type defaults to 'tenant'; if present it MUST be 'tenant'.
  if (f['contact_type'] !== undefined && f['contact_type'] !== 'tenant') {
    return { error: 'audience_filter.contact_type must be "tenant" (M1.8 targets tenants only)' };
  }
  const rawList = f['housing_authorities'];
  const rawLegacy = f['housing_authority'];
  const listGiven = rawList !== undefined && rawList !== null;
  const legacyGiven = rawLegacy !== undefined && rawLegacy !== null;
  if (listGiven && legacyGiven) {
    return { error: 'audience_filter: use housing_authorities only' };
  }
  let given: string[] | undefined;
  if (listGiven) {
    const listError = `audience_filter.housing_authorities must be an array of at most ${MAX_FILTER_AUTHORITIES} strings`;
    if (!Array.isArray(rawList) || rawList.length > MAX_FILTER_AUTHORITIES) return { error: listError };
    given = [];
    for (const member of rawList as unknown[]) {
      if (typeof member !== 'string') return { error: listError };
      given.push(member);
    }
  } else if (legacyGiven) {
    // LEGACY body (an old open dashboard tab or an API client): today's rule.
    if (typeof rawLegacy !== 'string' || rawLegacy.trim().length === 0) {
      return { error: 'audience_filter.housing_authority must be a non-empty string' };
    }
    given = [rawLegacy];
  }
  // Trimmed, blanks dropped, de-duplicated (first wins) - the ONE normalizer.
  // An empty result is no housing authority filter: no key is stored.
  const housing_authorities = authoritiesOfFilter({ housing_authorities: given });
  let bedroomSize: number | undefined;
  if (f['bedroomSize'] !== undefined && f['bedroomSize'] !== null) {
    const v = f['bedroomSize'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { error: 'audience_filter.bedroomSize must be an integer 0..12' };
    }
    bedroomSize = v;
  }
  return {
    contact_type: 'tenant',
    ...(housing_authorities.length > 0 && { housing_authorities }),
    ...(bedroomSize !== undefined && { bedroomSize }),
    excludeOptedOut: true,
    excludeUnreachable: true,
  };
}

/**
 * Parse an optional `recipientContactIds` send body. Returns:
 *  - `undefined` when the field is absent/null → keep the filter-resolve path.
 *  - `{ ids }` (de-duped, non-empty) when a valid non-empty string array.
 *  - `{ error }` when malformed (not an array, a non-string/empty element, or
 *    over the recipient cap defensively).
 * Empty-after-dedupe is surfaced as `{ error }` too (the send refuses an empty
 * effective set with 400 empty_audience; an empty explicit list is the same
 * intent — but we let the caller map it, returning `{ ids: [] }` here so the
 * route emits the consistent empty_audience shape).
 */
function parseRecipientContactIds(
  raw: unknown,
): { ids: string[] } | { error: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    return { error: 'recipientContactIds must be an array of non-empty strings' };
  }
  if (raw.length > MAX_BROADCAST_RECIPIENTS) {
    return {
      error: `recipientContactIds exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap`,
    };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const el of raw) {
    if (typeof el !== 'string' || el.trim().length === 0) {
      return { error: 'recipientContactIds must be an array of non-empty strings' };
    }
    const id = el.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids };
}

/** Parse an optional ?limit= into 1..MAX_PAGE_LIMIT, or undefined when invalid. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

/** Opaque base64url cursor over a DynamoDB LastEvaluatedKey (contacts.ts pattern). */
function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Decode a broadcasts-list cursor. The ExclusiveStartKey is the base-table key
 * (broadcastId) plus the queried GSI's keys (byStatus: status; byCreatedAt:
 * created_by, created_at) — a small flat scalar object (1..3 string attrs).
 * Validate the SHAPE before it becomes a DynamoDB key; a tampered cursor must
 * never reach DynamoDB malformed (returns undefined → 400 upstream).
 */
function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const key = parsed as Record<string, unknown>;
    const entries = Object.entries(key);
    if (entries.length < 1 || entries.length > 3) return undefined;
    for (const [, v] of entries) if (typeof v !== 'string') return undefined;
    return key;
  } catch {
    return undefined;
  }
}

/**
 * A recipient slot as returned to the dashboard: the persisted delivery slot
 * PLUS optional raw identity (S5). Raw fields only - the dashboard composes the
 * display name (contactDisplayName), so no name is composed server-side.
 *
 * share-sent-outcome D3: plus the newest attempt's promise facts, read from
 * that attempt's own message row (the ONE source, I5) for a young failed-30003
 * slot and passed through as the row holds them - the page judges liveness on
 * the server clock. `latestAttempt` rides the slot itself. `retryPending` marks
 * a recipient whose D1 state is `pending` (deviation 14): a row read that
 * failed is pending on the safe side with no due instant, and the page's
 * ticker recount must still count it.
 */
interface EnrichedRecipient extends BroadcastRecipient {
  firstName?: string;
  lastName?: string;
  phone?: string;
  retryDueAt?: string;
  retryOutcome?: string;
  retryPending?: boolean;
}

/** share-sent-outcome D3: the promise facts a recipient's D1 state carries onto the wire (only when present). */
function promiseFields(state: ClassifiedRecipient | undefined): Partial<EnrichedRecipient> {
  if (state === undefined) return {};
  return {
    ...(state.retryDueAt !== undefined && { retryDueAt: state.retryDueAt }),
    ...(state.retryOutcome !== undefined && { retryOutcome: state.retryOutcome }),
    ...(state.latestAttempt !== undefined && { latestAttempt: state.latestAttempt }),
    ...(state.state === 'pending' && { retryPending: true }),
  };
}

/**
 * share-sent-outcome D4: the share's derived stats with the TRUE retry_pending
 * (always present on the results and list payloads - the routes are the truth)
 * and a slot whose row says its chain ended unresolved counted Not confirmed,
 * not Failed.
 */
function statsWithStates(b: BroadcastItem, states: Map<string, ClassifiedRecipient>): BroadcastStats {
  return deriveBroadcastStats(b, {
    retryPending: retryPendingCount(states),
    unconfirmedKeys: unconfirmedByRow(states, b),
  });
}

/** Optional-string reader off a flexible contact attribute (trimmed). */
function trimmedField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * S5: enrich each recipients-map entry with OPTIONAL raw firstName/lastName/
 * phone so the results view can show the tenant's name + number (and keep
 * linking to /contacts/:id).
 * - contactId keys: ONE contacts.getDisplaysByIds BatchGet for the whole map
 *   (was a getById per recipient, chunked 50-wide - up to ~1,500 reads on a
 *   capped send). The display projection is EXACTLY the three fields below, so
 *   this also stops pulling whole contact documents over the wire.
 * - phone#<E164> keys: phone comes from the key (no lookup).
 * - deleted/unresolvable contacts: omit the fields (never leak the raw key);
 *   the dashboard falls back to its neutral "Recipient" label. A partial batch (keys
 *   the table never served) degrades the same way - identity is a label here,
 *   so a short map is survivable. There is NO catch: a rejected read still
 *   500s this endpoint, exactly as a rejected getById did.
 * Cost is bounded by MAX_BROADCAST_RECIPIENTS, only on this endpoint (no cache).
 * `states` (share-sent-outcome D3) adds each recipient's promise facts.
 */
async function enrichRecipients(
  contacts: ContactsRepo,
  recipients: Record<string, BroadcastRecipient>,
  states?: Map<string, ClassifiedRecipient>,
): Promise<Record<string, EnrichedRecipient>> {
  const keys = Object.keys(recipients);
  const contactIdKeys = keys.filter((k) => !k.startsWith('phone#'));
  let resolvedById = new Map<string, ContactDisplayItem>();
  if (contactIdKeys.length > 0) {
    resolvedById = await contacts.getDisplaysByIds(contactIdKeys);
  }
  const out: Record<string, EnrichedRecipient> = {};
  for (const key of keys) {
    const slot = { ...recipients[key]!, ...promiseFields(states?.get(key)) };
    if (key.startsWith('phone#')) {
      // The phone is the key itself - no lookup, no identity leak beyond it.
      out[key] = { ...slot, phone: key.slice('phone#'.length) };
      continue;
    }
    const contact = resolvedById.get(key);
    if (!contact) {
      // Deleted / unresolvable - omit identity; never echo the raw contactKey.
      out[key] = { ...slot };
      continue;
    }
    const firstName = trimmedField(contact.firstName);
    const lastName = trimmedField(contact.lastName);
    const phone = typeof contact.phone === 'string' && contact.phone.length > 0 ? contact.phone : undefined;
    out[key] = {
      ...slot,
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(phone !== undefined && { phone }),
    };
  }
  return out;
}

/**
 * Spec 2026-10-06 D20 (caseworkers): the contact types a share may text BY
 * NAME - a seed or an explicitly checked recipient. ONE predicate for
 * resolveSeeds and the explicit-selection send path, so the two cannot drift.
 * Filter-resolved audiences stay tenant-only (parseAudienceFilter and the
 * audience resolver), and the dashboard's recipient search stays tenant-only.
 * Deleted contacts are NOT fenced here (pre-existing; the fan-out skips them
 * as contact_deleted).
 */
function isDirectShareRecipientType(type: unknown): boolean {
  return type === 'tenant' || type === 'partner';
}

/**
 * Build the recipients map from a list of already-sendable contacts: one
 * `{ status: 'queued' }` slot per contact, keyed by the shared contactKey
 * convention (contactId when present, else `phone#<E164>`). The map naturally
 * de-dupes by key. Shared by the explicit-selection send path (post-fence
 * survivors) and the seeds_only no-body path (resolved seeds) so both produce
 * the identical stored shape.
 */
function buildRecipientsFrom(
  list: Array<{ contactId?: string; phone: string }>,
): Record<string, BroadcastRecipient> {
  const recipients: Record<string, BroadcastRecipient> = {};
  for (const c of list) {
    const contactKey = c.contactId && c.contactId.length > 0 ? c.contactId : `phone#${c.phone}`;
    recipients[contactKey] = { status: 'queued' };
  }
  return recipients;
}

/** The results-view projection of a broadcast (stats + recipients + lifecycle). */
function toBroadcastResults(
  b: BroadcastItem,
  recipients: Record<string, EnrichedRecipient>,
  stats: BroadcastStats,
): Record<string, unknown> {
  return {
    broadcastId: b.broadcastId,
    status: b.status,
    unitId: b.unitId ?? null,
    // matching-blast-rules D2: the wire shape (a legacy row's string becomes
    // a one-member housing_authorities; never housing_authority).
    audience_filter: wireAudienceFilter(b.audience_filter),
    // Matching sends: surface the draft's audience mode when set so the composer
    // can render the seeds_only (1:1) vs filter (1:N) affordances.
    ...(b.audience_mode !== undefined && { audience_mode: b.audience_mode }),
    // S4: disjoint buckets derived from the recipients map (historical rows too);
    // share-sent-outcome D4: with the true retry_pending (statsWithStates).
    stats,
    recipients,
    ...(b.last_error !== undefined && { last_error: b.last_error }),
    created_at: b.created_at,
  };
}

/**
 * share-sent-outcome D4: the stats-only view (`?view=stats`, Cameron's ruling
 * of 2026-09-27) - the share and its derived stats, WITHOUT the recipient list
 * and its contact reads: the list page's refetch of one finished share.
 */
function toBroadcastStatsView(b: BroadcastItem, stats: BroadcastStats): Record<string, unknown> {
  return { broadcastId: b.broadcastId, status: b.status, unitId: b.unitId ?? null, stats, created_at: b.created_at };
}

/** The list-row summary (no recipients map - that's the results view). */
function toBroadcastSummary(b: BroadcastItem, stats: BroadcastStats): Record<string, unknown> {
  return {
    broadcastId: b.broadcastId,
    status: b.status,
    unitId: b.unitId ?? null,
    // matching-blast-rules D2: the wire shape, as on the results view.
    audience_filter: wireAudienceFilter(b.audience_filter),
    // Matching sends: pass the audience mode through on list rows too (dashboard
    // Task 5 reads it on BroadcastSummary).
    ...(b.audience_mode !== undefined && { audience_mode: b.audience_mode }),
    // S4: derived disjoint stats (the byCreated GSI projects the map);
    // share-sent-outcome D4: with the true retry_pending (statsWithStates).
    stats,
    created_at: b.created_at,
    created_by: b.created_by,
  };
}

/**
 * matching-blast-rules D5/D6/D8: thrown by buildReviewRows when the open-tours
 * read or the #27 decline read fails for a FILTER draft. The preview answers
 * 503 audience_rules_unavailable; draft create omits its estimate. `truncated`
 * carries the audience resolution's flag (the resolution ran before the
 * failed read), so create still reports it.
 */
class AudienceRulesUnavailableError extends Error {
  readonly truncated: boolean;
  constructor(truncated: boolean, options?: ErrorOptions) {
    super('audience rules unavailable: a tours or decline read failed', options);
    this.name = 'AudienceRulesUnavailableError';
    this.truncated = truncated;
  }
}

/** What buildReviewRows needs from a draft (or from POST create's body). */
interface ReviewInput {
  audienceMode: BroadcastAudienceMode;
  filter: AudienceFilter;
  seedContactIds: string[];
  unitId?: string;
}

/** One review row: a resolved contact plus its D5 flags. */
interface ReviewRow extends ResolvedContact {
  seeded: boolean;
  alreadySent: boolean;
  declined: boolean;
  tourHold?: TourHold;
  checkedByDefault: boolean;
}

interface ReviewRowsResult {
  /** The resolved audience minus seeded contacts (resolver order), then every
   *  resolved seed (seed order): a contact in both sits at the seed position,
   *  with the seed's fields, flagged seeded. */
  rows: ReviewRow[];
  truncated: boolean;
  unresolvedSeedIds: string[];
  /** contactKeys (contactId or phone#<E164>) that MAY have received this property. */
  priorRecipients: Set<string>;
  /** Effective #27 declines of the property (empty without one). */
  declinedIds: Set<string>;
  /** EVERY held contact, in the rows or not (tourHolds on the wire). */
  tourHolds: Map<string, TourHold>;
  /** True only for a seeds_only preview whose rules reads threw. */
  rulesUnavailable: boolean;
}

export function createBroadcastsRouter(deps: BroadcastsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const broadcasts = deps.broadcastsRepo ?? createBroadcastsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const attempts = deps.sendAttemptsRepo ?? createSendAttemptsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const resolveAudience =
    deps.audienceResolutionService ?? createAudienceResolutionService({ logger: deps.logger });
  const orgNames = deps.orgNamesService ?? createOrgNamesService({ logger: deps.logger });
  const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  // NOTE: broadcast.updated SSE events are emitted from the broadcast.send job
  // (on completion) and the delivery-callback rollup — NOT this router — so the
  // `events` dep is accepted for API symmetry but not used here.

  /**
   * last-heard-from (spec 5.3, D11): the contactIds whose decline of `unitId` is
   * EFFECTIVE. Reads, in order: the unit's LISTED rows (listByUnit already drops
   * un-counted rows, so a pair whose every share failed shows no label - "LISTED
   * only"); then, ONLY when some row carries a `declined` record, the unit's
   * tours (one byUnit read, grouped by tenant - the units recipients pattern)
   * and those rows' contacts in one requireComplete batch (their type decides
   * whether tours count, spec 5.4). Throws on any failed read. Since
   * matching-blast-rules D5 a decline UNCHECKS a filter row by default, so its
   * callers fail closed (readAudienceRules): a filter preview and the no-body
   * filter send answer 503 audience_rules_unavailable, draft create omits its
   * estimate, and only a seeds_only preview is served without the labels.
   */
  async function effectiveDeclines(unitId: string): Promise<Set<string>> {
    const declinedRows = (await listingSends.listByUnit(unitId)).filter((r) => r.declined !== undefined);
    const out = new Set<string>();
    if (declinedRows.length === 0) return out;
    const [unitTours, byId] = await Promise.all([
      tours.listByUnit(unitId),
      contacts.getManyByIds(declinedRows.map((r) => r.contactId), { requireComplete: true }),
    ]);
    const toursByTenant = new Map<string, TourItem[]>();
    for (const t of unitTours) {
      const arr = toursByTenant.get(t.tenantId);
      if (arr === undefined) toursByTenant.set(t.tenantId, [t]);
      else arr.push(t);
    }
    for (const row of declinedRows) {
      const contact = byId.get(row.contactId);
      const pairTours = toursByTenant.get(row.contactId) ?? [];
      const outcome = deriveListingSendOutcome({
        row,
        recipientType: contact?.type,
        lastHeardFromAt: contact?.last_heard_from_at,
        tour: deriveTourSignal(pairTours),
        tourActivityAt: deriveTourActivityAt(pairTours),
      });
      if (outcome === 'not_interested') out.add(row.contactId);
    }
    return out;
  }

  /** Resolve seed contact ids to sendable recipients using the SAME fences as
   *  the explicit-selection send path: exists, type tenant OR partner
   *  (isDirectShareRecipientType - spec 2026-10-06 D20), has phone, not
   *  sms_opt_out, not sms_unreachable. Anything else lands in `unresolved`.
   *  Seeds are few (1..handful), so per-id getById is fine. */
  async function resolveSeeds(
    ids: string[],
  ): Promise<{ contacts: ResolvedContact[]; unresolved: string[] }> {
    const resolved: ResolvedContact[] = [];
    const unresolved: string[] = [];
    for (const id of ids) {
      const c = await contacts.getById(id);
      if (
        !c ||
        !isDirectShareRecipientType(c.type) ||
        typeof c.phone !== 'string' ||
        c.phone.length === 0 ||
        c.sms_opt_out === true ||
        c.sms_unreachable === true
      ) {
        unresolved.push(id);
        continue;
      }
      resolved.push({
        contactId: c.contactId,
        phone: c.phone,
        ...(typeof c.firstName === 'string' && { firstName: c.firstName }),
        ...(typeof c.lastName === 'string' && { lastName: c.lastName }),
        // Spec 2026-10-06 D20: voucher facts describe a TENANT's voucher. A
        // partner's leftover housing authority is not one, so a partner seed
        // carries neither field (the preview candidate copies only what is here).
        ...(c.type === 'tenant' && typeof c.voucherSize === 'number' && { voucherSize: c.voucherSize }),
        ...(c.type === 'tenant' &&
          typeof c.housingAuthority === 'string' && { housingAuthority: c.housingAuthority }),
        // last-heard-from (spec 5.3): a TENANT seed's lifecycle status; a
        // partner seed carries none (StatusBadge kind="tenant" must never see
        // it). Last heard from is any type's.
        ...(c.type === 'tenant' && typeof c.status === 'string' && c.status.length > 0 && { status: c.status }),
        ...(typeof c.last_heard_from_at === 'string' && { lastHeardFromAt: c.last_heard_from_at }),
        has_consent: hasSmsConsent(c),
      });
    }
    return { contacts: resolved, unresolved };
  }

  /**
   * Spec 2026-10-06 D7 (matching-blast-rules D2): the STORED housing authority
   * filter of a draft is re-checked before it is resolved - at preview of a
   * DRAFT and in the send branch that re-resolves the filter. EVERY member of
   * the stored list (authoritiesOfFilter - a legacy row's one string is its
   * one member) must be EXACTLY the name of a housing authority entry (D3),
   * checked in order; the first that is not is answered. Nothing rewrites a
   * broadcast, so a stored spelling or slug that resolves to one entry is
   * still refused, naming that entry as the one candidate so the composer can
   * offer it (ruling R2 decision 2). Returns the 422 body, or undefined when
   * the filter names no housing authority or only exact names. One list read,
   * and only when the list is non-empty.
   */
  async function storedFilterRefusal(
    filter: AudienceFilter | undefined,
  ): Promise<OrgNotOnList | undefined> {
    const members = authoritiesOfFilter(filter);
    if (members.length === 0) return undefined;
    const { entries } = await orgNames.read();
    const kinds = KINDS_FOR_FIELD.audience_filter;
    for (const text of members) {
      if (isOnListFor(entries, text, kinds)) continue;
      const check = checkScalarWrite(entries, 'audience_filter', text, undefined);
      if (!check.ok) return check.error;
      // The one entry the stored text resolves to (a spelling or slug of it).
      const resolvedName = check.value;
      const match = entries.find((e) => kinds.includes(e.kind) && e.name === resolvedName);
      return {
        error: 'org_not_on_list',
        field: 'audience_filter',
        text,
        candidates: match === undefined ? [] : [{ orgId: match.orgId, kind: match.kind, name: match.name }],
        close: [],
      };
    }
    return undefined;
  }

  /**
   * matching-blast-rules D5: the open-tours read - ONE read per call,
   * independent of audience size. The byStatus partitions `scheduled`,
   * `toured` and `no_show` are walked to the end (the same unbounded reads the
   * auto-close sweep makes every 15 minutes, jobs/tourAutoClose.ts); the
   * `requested` partition is bounded by its range key to the requests created
   * in the last 14 days - the only ones that can hold (D4) - because it grows
   * with every unbooked request. Grouped by tenantId in memory, one picked
   * hold per contact (any contact type: older tours may name a non-tenant).
   * Throws on any failed read; the caller decides what that means.
   */
  async function readOpenTourHolds(nowMs: number): Promise<Map<string, TourHold>> {
    const requestedFrom = new Date(nowMs - TOUR_REQUEST_HOLD_MS).toISOString();
    const [scheduled, toured, noShow, requested] = await Promise.all([
      tours.listByStatus('scheduled'),
      tours.listByStatus('toured'),
      tours.listByStatus('no_show'),
      tours.listByStatus('requested', { createdAtFrom: requestedFrom }),
    ]);
    return tourHoldsByTenant([...scheduled, ...toured, ...noShow, ...requested], nowMs);
  }

  /**
   * matching-blast-rules D5/D6: the two reads that fail CLOSED - the open-tour
   * holds and, with a property, its effective #27 declines - in parallel.
   * Throws the first failure as it came; callers decide (503 for a filter
   * preview and send path (c), no estimate at create, a label-less seeds_only
   * preview).
   */
  async function readAudienceRules(
    unitId: string | undefined,
    nowMs: number,
  ): Promise<{ tourHolds: Map<string, TourHold>; declinedIds: Set<string> }> {
    const [tourHolds, declinedIds] = await Promise.all([
      readOpenTourHolds(nowMs),
      unitId !== undefined ? effectiveDeclines(unitId) : Promise.resolve(new Set<string>()),
    ]);
    return { tourHolds, declinedIds };
  }

  /**
   * matching-blast-rules D5 (and D8): the ONE rule that builds a draft's review
   * rows - the preview serves them, POST create counts the checkedByDefault
   * ones as "Reaches N recipients".
   *  - filter draft: the resolved audience (D1, D2) united with the seeds
   *    (the audience minus seeded contacts, then every resolved seed; a
   *    contact in both is ONE row, at the seed position with the seed's
   *    fields, flagged seeded), the rules reads (readAudienceRules), then
   *    the already-sent set. A thrown tours or decline read throws
   *    AudienceRulesUnavailableError - never a list the rules did not check.
   *  - seeds_only + 'preview': the seeds alone, the same reads; a thrown rules
   *    read serves the rows WITHOUT tour or decline flags and sets
   *    rulesUnavailable (a direct send is never blocked by these reads).
   *  - seeds_only + 'estimate': NO rules or already-sent reads - every row is a
   *    seed, so checkedByDefault is has_consent (D8).
   * checkedByDefault = has_consent && (seeded || (!alreadySent && !declined && !held)).
   * The already-sent set (priorRecipientKeys) never throws: a failed page keeps
   * what it resolved - a soft hint by design, so a throttled read can leave an
   * already-sent tenant checked. It reads a queued slot's send-attempt record
   * (in flight vs stranded) with `recordReads: true`; this function is the ONLY
   * place those records are read - the preview and draft create call it, no
   * other route does (share-sent-outcome D1).
   */
  async function buildReviewRows(input: ReviewInput, mode: 'preview' | 'estimate'): Promise<ReviewRowsResult> {
    const seeds =
      input.seedContactIds.length > 0
        ? await resolveSeeds(input.seedContactIds)
        : { contacts: [], unresolved: [] };
    const seedIdSet = new Set(seeds.contacts.map((c) => c.contactId));
    const seedsOnly = input.audienceMode === 'seeds_only';
    if (seedsOnly && mode === 'estimate') {
      const seedRows: ReviewRow[] = seeds.contacts.map((c) => ({
        ...c,
        seeded: true,
        alreadySent: false,
        declined: false,
        checkedByDefault: isCheckedByDefault({
          hasConsent: c.has_consent,
          seeded: true,
          alreadySent: false,
          declined: false,
          held: false,
        }),
      }));
      return {
        rows: seedRows,
        truncated: false,
        unresolvedSeedIds: seeds.unresolved,
        priorRecipients: new Set<string>(),
        declinedIds: new Set<string>(),
        tourHolds: new Map<string, TourHold>(),
        rulesUnavailable: false,
      };
    }
    const audience: { contacts: ResolvedContact[]; truncated: boolean } = seedsOnly
      ? { contacts: [], truncated: false }
      : await resolveAudience(input.filter);
    const combined = [...audience.contacts.filter((c) => !seedIdSet.has(c.contactId)), ...seeds.contacts];
    let tourHolds = new Map<string, TourHold>();
    let declinedIds = new Set<string>();
    let rulesUnavailable = false;
    try {
      const rules = await readAudienceRules(input.unitId, Date.now());
      tourHolds = rules.tourHolds;
      declinedIds = rules.declinedIds;
    } catch (err) {
      log.warn(
        { err, audienceMode: input.audienceMode, mode, ...(input.unitId !== undefined && { unitId: input.unitId }) },
        'broadcast audience rules unavailable: a tours or decline read failed',
      );
      if (!seedsOnly) throw new AudienceRulesUnavailableError(audience.truncated, { cause: err });
      rulesUnavailable = true;
    }
    const priorRecipients =
      input.unitId !== undefined
        ? await priorRecipientKeys({ broadcasts, messages, attempts, log }, input.unitId)
        : new Set<string>();
    const rows: ReviewRow[] = combined.map((c) => {
      const seeded = seedIdSet.has(c.contactId);
      // The set is contactKeys - contactId OR `phone#<E164>` (a phone-only
      // recipient at the prior share's send time) - so match on EITHER key.
      const alreadySent =
        input.unitId !== undefined &&
        (priorRecipients.has(c.contactId) || priorRecipients.has(`phone#${c.phone}`));
      const declined = declinedIds.has(c.contactId);
      const tourHold = tourHolds.get(c.contactId);
      return {
        ...c,
        seeded,
        alreadySent,
        declined,
        ...(tourHold !== undefined && { tourHold }),
        checkedByDefault: isCheckedByDefault({
          hasConsent: c.has_consent,
          seeded,
          alreadySent,
          declined,
          held: tourHold !== undefined,
        }),
      };
    });
    return {
      rows,
      truncated: audience.truncated,
      unresolvedSeedIds: seeds.unresolved,
      priorRecipients,
      declinedIds,
      tourHolds,
      rulesUnavailable,
    };
  }

  const router = Router();

  // POST /api/broadcasts — create a DRAFT + estimate the audience (save-for-later).
  router.post('/broadcasts', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId ?? 'unknown';
    const body = (req.body ?? {}) as {
      unitId?: unknown;
      body_template?: unknown;
      audience_filter?: unknown;
    };

    const template =
      typeof body.body_template === 'string' && body.body_template.trim().length > 0
        ? body.body_template
        : undefined;
    if (template === undefined) {
      res.status(400).json({ error: 'body_template (non-empty string) is required' });
      return;
    }
    if (template.length > MAX_TEMPLATE_LEN) {
      res.status(400).json({ error: `body_template exceeds ${MAX_TEMPLATE_LEN} chars` });
      return;
    }
    const filter = parseAudienceFilter(body.audience_filter ?? {});
    if ('error' in filter) {
      res.status(400).json({ error: filter.error });
      return;
    }
    let unitId: string | undefined;
    let flyer_url: string | undefined;
    if (body.unitId !== undefined && body.unitId !== null) {
      if (typeof body.unitId !== 'string' || body.unitId.length === 0) {
        res.status(400).json({ error: 'unitId must be a non-empty string' });
        return;
      }
      const unit = await units.getById(body.unitId);
      if (!unit) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      unitId = unit.unitId;
      flyer_url = flyerUrl(config.publicBaseUrl, unit.unitId);
    }

    // Optional seed recipients attached to the draft (the seeded 1:1 entry, or
    // hand-picked additions). Parsed with the same shape/cap guard as the send
    // path's recipientContactIds.
    const parsedSeeds = parseRecipientContactIds(
      (req.body as Record<string, unknown> | undefined)?.['seedContactIds'],
    );
    if (parsedSeeds !== undefined && 'error' in parsedSeeds) {
      res.status(400).json({ error: parsedSeeds.error });
      return;
    }
    // An EMPTY parsed seed list behaves exactly like an absent one: no seeds
    // stored, and the draft stays in filter mode (never flipped to seeds_only).
    const seedContactIds =
      parsedSeeds !== undefined && parsedSeeds.ids.length > 0 ? parsedSeeds.ids : undefined;
    // A draft carrying seeds but NO explicit audience_filter is a seeds_only
    // draft (the seeded 1:1 entry) - the default tenant filter would otherwise
    // propose every tenant. Any explicit filter keeps it in filter mode.
    const rawFilterProvided =
      (req.body as Record<string, unknown> | undefined)?.['audience_filter'] !== undefined;
    const audienceMode: BroadcastAudienceMode =
      seedContactIds !== undefined && !rawFilterProvided ? 'seeds_only' : 'filter';

    // ORGANIZATION NAMES (spec 2026-10-06 D5; matching-blast-rules D2): EVERY
    // member of the housing authority list must name a housing authority on
    // the stored org list (orgNames.checkList: trimmed, blanks dropped,
    // de-duplicated, a unique spelling stored as the entry's exact name).
    // Checked AFTER every 400 shape check and the unit 404 above, and BEFORE
    // the estimate, so the estimate and the stored row both use the entries'
    // exact names. The FIRST member that is not on the list is the 422 (field
    // `audience_filter`, `text` = that member) with no row and no audit. One
    // list read, and only when the parsed list is non-empty. A seeds_only
    // draft parsed `{}` and never carries a housing authority.
    if (filter.housing_authorities !== undefined) {
      const check = await orgNames.checkList('audience_filter', filter.housing_authorities, undefined, undefined);
      if (!check.ok) {
        log.info({ actor }, 'broadcast draft refused: a housing authority filter member is not on the list');
        res.status(422).json(check.error);
        return;
      }
      filter.housing_authorities = check.value;
    }

    // matching-blast-rules D8: "Reaches N recipients" is the number of rows that
    // will START CHECKED on the review step - the SAME buildReviewRows the
    // preview serves, counted by checkedByDefault (held, declined, already-sent
    // and no-consent rows are left out; seeds with recorded consent count). A
    // seeds_only draft makes NO rules reads (every row is a seed). A filter
    // draft reads tours, declines and the already-sent set on every create -
    // the draft key includes the message body, so a pause in typing repeats
    // them (a few small Query pages, the same reads as one Preview click). A
    // thrown tours or decline read never blocks the draft: the estimate is
    // omitted (stats.audience stays 0) and the composer shows "Reach estimate
    // unavailable" until the draft is recreated. The preview lists at most
    // MAX_BROADCAST_RECIPIENTS rows; this counts them all.
    let estimatedAudience: number | undefined;
    let truncated = false;
    try {
      const review = await buildReviewRows(
        {
          audienceMode,
          filter,
          seedContactIds: seedContactIds ?? [],
          ...(unitId !== undefined && { unitId }),
        },
        'estimate',
      );
      estimatedAudience = review.rows.filter((r) => r.checkedByDefault).length;
      truncated = review.truncated;
    } catch (err) {
      if (!(err instanceof AudienceRulesUnavailableError)) throw err;
      truncated = err.truncated;
    }

    const created = await broadcasts.create({
      created_by: actor,
      // share-skip-fix D4: only an authenticated staff session reaches this
      // route (sessionMiddleware + requireAuth on /api), so the share is a
      // person's share - recorded here, ONCE, so the send job never has to look
      // the creator up. A removed teammate's draft keeps the record.
      createdVia: 'dashboard',
      audience_filter: filter,
      body_template: template,
      ...(estimatedAudience !== undefined && { estimatedAudience }),
      audienceMode,
      ...(unitId !== undefined && { unitId }),
      ...(flyer_url !== undefined && { flyer_url }),
      ...(seedContactIds !== undefined && { seedContactIds }),
    });
    await audit.append(`broadcasts#${created.broadcastId}`, 'broadcast_created', {
      actor,
      ...(unitId !== undefined && { unitId }),
      ...(estimatedAudience !== undefined && { estimatedCount: estimatedAudience }),
    });
    log.info(
      { broadcastId: created.broadcastId, estimatedCount: estimatedAudience ?? null, actor },
      'broadcast draft created via api',
    );
    res.status(201).json({
      broadcastId: created.broadcastId,
      status: 'draft',
      // matching-blast-rules D8: omitted when a rules read threw.
      ...(estimatedAudience !== undefined && { estimatedCount: estimatedAudience }),
      // Spec 2026-10-06 D5 (ruling R2 decision 5): echo the STORED filter, so a
      // caller that sent a spelling sees the list name it was stored as - in
      // the wire shape (matching-blast-rules D2: housing_authorities, never
      // housing_authority).
      audience_filter: wireAudienceFilter(created.audience_filter),
      // FIX 3+4: surface whether the estimate was truncated (page cap hit) so
      // the operator knows the draft's reach is incomplete before sending.
      truncated,
      ...(flyer_url !== undefined && { flyerUrl: flyer_url }),
    });
  });

  // POST /api/broadcasts/:id/preview - re-resolve the audience + return the FULL
  // annotated candidate list (bounded by the recipient cap, NOT the old 25-row
  // sample) so the composer can render an editable curated recipient list. Each
  // candidate carries voucherSize/housingAuthority for the row (tenants only,
  // spec 2026-10-06 D20), plus
  // `alreadySentThisProperty` (SOFT - an earlier share of this unit MAY have
  // reached the tenant: the SAFE reading of share-sent-outcome D1's recipient
  // state, whatever that share's stored status). `priorRecipientContactIds`
  // lets the composer annotate MANUALLY-added tenants locally too.
  // last-heard-from: per candidate status? / lastHeardFromAt? / declinedThisProperty, plus declinedContactIds.
  // matching-blast-rules D5/D7: per candidate tourHold? / checkedByDefault, plus tourHolds and, for a
  // seeds_only draft whose rules reads failed, audienceRulesUnavailable; a filter draft whose tours or
  // decline read fails is 503 audience_rules_unavailable.
  router.post('/broadcasts/:broadcastId/preview', async (req, res) => {
    const { broadcastId } = req.params;
    mergeContext({});
    const broadcast = await broadcasts.getById(broadcastId);
    if (!broadcast) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    // Spec 2026-10-06 D7: a DRAFT's stored housing authority filter is
    // re-checked before it is resolved (storedFilterRefusal). A sent, sending
    // or failed share keeps its historical filter and previews as before
    // (ruling R2 decision 3), and a seeds_only draft never resolves its filter.
    if (broadcast.status === 'draft' && broadcast.audience_mode !== 'seeds_only') {
      const refusal = await storedFilterRefusal(broadcast.audience_filter);
      if (refusal !== undefined) {
        log.info({ broadcastId }, 'broadcast preview refused: stored housing authority filter not on the list');
        res.status(422).json(refusal);
        return;
      }
    }
    // matching-blast-rules D5: ONE server function builds the review rows (the
    // filter rows united with the hand-picked seeds - a seeds_only draft, the
    // seeded 1:1 entry, skips the filter so preview returns ONLY its seeds),
    // each flagged with the one checkedByDefault rule the composer applies.
    // A filter draft whose tours or decline read throws is 503
    // audience_rules_unavailable with NO list - serving one would check people
    // the rules leave out; a seeds_only draft is served without those labels
    // and says so (audienceRulesUnavailable).
    const seedIds = broadcast.seed_contact_ids ?? [];
    let review: ReviewRowsResult;
    try {
      review = await buildReviewRows(
        {
          audienceMode: broadcast.audience_mode ?? 'filter',
          filter: broadcast.audience_filter,
          seedContactIds: seedIds,
          ...(broadcast.unitId !== undefined && { unitId: broadcast.unitId }),
        },
        'preview',
      );
    } catch (err) {
      if (!(err instanceof AudienceRulesUnavailableError)) throw err;
      log.info({ broadcastId }, 'broadcast preview refused: audience rules unavailable - 503');
      res.status(503).json({ error: 'audience_rules_unavailable' });
      return;
    }
    // The candidate list carries phones - authed/internal response only; the
    // log line below stays IDs/counts only (NEVER phones/names/bodies).
    const candidates = review.rows.slice(0, MAX_BROADCAST_RECIPIENTS).map((r) => ({
      contactId: r.contactId,
      ...(r.firstName !== undefined && { firstName: r.firstName }),
      // Full name for the review rows (same authed/internal PII class as
      // firstName + phone).
      ...(r.lastName !== undefined && { lastName: r.lastName }),
      phone: r.phone,
      ...(r.voucherSize !== undefined && { voucherSize: r.voucherSize }),
      ...(r.housingAuthority !== undefined && { housingAuthority: r.housingAuthority }),
      // last-heard-from (spec 5.3): tenant status (absent for a partner seed)
      // and last heard from, for the review row's columns and order.
      ...(r.status !== undefined && { status: r.status }),
      ...(r.lastHeardFromAt !== undefined && { lastHeardFromAt: r.lastHeardFromAt }),
      // A2P/CTIA (LOCKED CONTRACT 3): whether this candidate has recorded SMS
      // consent. The composer surfaces "consent not recorded" for `false` +
      // a count; the fan-out EXCLUDES !has_consent recipients (broadcastFanOut).
      has_consent: r.has_consent,
      // SOFT - an earlier share of this unit MAY have reached the tenant
      // (share-sent-outcome D1's safe reading), matched on contactId OR the
      // `phone#<E164>` key.
      // TODO(broadcasts): the manually-added-tenant client-side annotation (the
      // dashboard matches `priorRecipientContactIds` by contactId) has the same
      // rare phone-only edge - a manually-added tenant prior-texted under a
      // `phone#<E164>` key won't be flagged client-side. Not addressed here.
      alreadySentThisProperty: r.alreadySent,
      // Whether this row came from the draft's seed_contact_ids (a hand-picked
      // recipient, or the seeded 1:1 entry). A contact in BOTH audience and
      // seeds is ONE row flagged seeded.
      seeded: r.seeded,
      // last-heard-from D11: an EFFECTIVE decline of this property.
      declinedThisProperty: r.declined,
      // matching-blast-rules D4/D7: the ONE unresolved tour shown for this
      // contact (any property), when there is one.
      ...(r.tourHold !== undefined && { tourHold: r.tourHold }),
      // D5: whether the review step starts this row checked (Select all
      // re-applies it); the dashboard reads it instead of computing a rule.
      checkedByDefault: r.checkedByDefault,
    }));
    // count/truncated derive from the post-union, pre-slice list (+ the audience
    // truncation flag) so the operator sees the true unioned reach.
    log.info(
      {
        broadcastId,
        count: review.rows.length,
        truncated: review.truncated,
        checkedByDefault: review.rows.filter((r) => r.checkedByDefault).length,
        heldContacts: review.tourHolds.size,
        rulesUnavailable: review.rulesUnavailable,
      },
      'broadcast audience previewed',
    );
    // Surface `truncated` (FIX 3+4) so the operator sees an incomplete/over-cap
    // audience BEFORE sending (and the dashboard can warn). seedContactIds (as
    // stored) + unresolvedSeedIds let the composer show which seeds dropped.
    res.json({
      count: review.rows.length,
      truncated: review.truncated,
      candidates,
      priorRecipientContactIds: [...review.priorRecipients],
      seedContactIds: seedIds,
      unresolvedSeedIds: review.unresolvedSeedIds,
      // last-heard-from (spec 5.3): the analog of priorRecipientContactIds -
      // annotates a hand-added row outside the audience client-side.
      declinedContactIds: [...review.declinedIds],
      // matching-blast-rules D7: EVERY held contact (the same analog), so Add a
      // tenant can label a tenant outside the candidates.
      tourHolds: [...review.tourHolds].map(([contactId, hold]) => ({ contactId, ...hold })),
      // D5: a seeds_only draft whose rules reads threw - served without the
      // tour and Not interested labels. Absent otherwise.
      ...(review.rulesUnavailable && { audienceRulesUnavailable: true as const }),
    });
  });

  // POST /api/broadcasts/:id/send — snapshot the audience, mark sending, enqueue.
  //
  // Per-user spend fence (2026-07-02 hardening): each request triggers a whole
  // audience fan-out — the most expensive single click in the app — so the send
  // POST (and only the send POST; draft/preview/results stay unmetered) sits
  // behind a sliding-window per-user limiter. ONE instance, created with the
  // router.
  const broadcastSendLimiter = createUserRateLimit({
    routeKey: 'broadcast_send',
    max: config.rateLimitBroadcastSendPerMin,
    windowMs: 60_000,
    logger: log,
  });
  router.post('/broadcasts/:broadcastId/send', broadcastSendLimiter, async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId ?? 'unknown';
    // NOTE: with a middleware ahead of the handler, Express's typings no longer
    // narrow req.params from the path literal — coerce like voiceApi.ts does.
    const broadcastId = String(req.params['broadcastId'] ?? '');
    mergeContext({});
    const broadcast = await broadcasts.getById(broadcastId);
    if (!broadcast) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    if (broadcast.status !== 'draft') {
      // Only a draft may be sent — a sending/sent broadcast is not re-sendable.
      res.status(409).json({ error: 'broadcast_not_draft', status: broadcast.status });
      return;
    }

    // Availability guard (spec 2026-07-10): the flyer link stamped into every
    // recipient's message only resolves while the unit is SHAREABLE (only
    // 'available' - the same gate public.ts serves). Re-check at SEND time,
    // not create time - a draft can outlive a status change. Missing and
    // soft-deleted units get the same refusal (the link is equally dead).
    // The dashboard maps this 400 to its make-available dialog.
    if (broadcast.unitId !== undefined) {
      const unit = await units.getById(broadcast.unitId);
      if (!unit || isDeleted(unit) || !SHAREABLE_STATUSES.has(unit.status)) {
        res.status(400).json({ error: 'unit_not_available' });
        return;
      }
    }

    // Two send paths share the rest of the flow once they've produced a bounded
    // `recipients` map + count:
    //  (a) explicit selection — the dashboard's curated checked list (a body
    //      `recipientContactIds`): resolve EACH contact + RE-ENFORCE the same
    //      hard fences the audience resolver applies, except that a partner
    //      passes too (D20) - drop unknown ids, any other type, opted-out,
    //      unreachable, phone-less. The already-sent flag is a
    //      preview hint only — NEVER excluded here.
    //  (b) seeds_only no-body - a seeded 1:1/1:N draft (the seeded entry): the
    //      draft carries seed_contact_ids and audience_mode 'seeds_only', so
    //      resolve THOSE seeds (same fences) instead of the default filter.
    //  (c) filter-resolve (API only - no body): the resolved audience minus
    //      tour holds and #27 declines (matching-blast-rules D6).
    let recipients: Record<string, BroadcastRecipient> = {};
    let count: number;

    const selection = parseRecipientContactIds(
      (req.body as { recipientContactIds?: unknown } | undefined)?.recipientContactIds,
    );
    if (selection !== undefined && 'error' in selection) {
      res.status(400).json({ error: selection.error });
      return;
    }

    if (selection !== undefined) {
      // (a) Explicit selection. Build recipients from THIS set — re-fence each.
      // ONE getManyByIds BatchGet resolves the whole selection (was a 50-wide
      // getById fan-out; sequential awaits before that were 7-15s on a 1500-id
      // send). WHOLE items, not the display projection: the fences below read
      // `type` and both suppression flags. The raw list is already capped at
      // MAX_BROADCAST_RECIPIENTS pre-fetch (parse guard). An id with no contact
      // is simply absent from the map and drops exactly as an undefined getById
      // did, so the fences, de-dupe, contactKey convention, empty -> 400, and cap
      // below are unchanged.
      //
      // requireComplete is LOAD-BEARING here (adversarial review r1 finding 1).
      // A short map has two causes - the contact does not exist, or we failed to
      // read it - and only the first may drop a recipient. Without this flag a
      // throttled BatchGet would quietly shrink the send and still report 200,
      // which is exactly what the truncated-audience branch below refuses to do.
      // Throwing leaves the broadcast a DRAFT the operator can re-send, which is
      // what the pre-batch getById fan-out did when a read failed.
      const byId = await contacts.getManyByIds(selection.ids, { requireComplete: true });
      const fetched = selection.ids.map((id) => byId.get(id));
      const survivors: Array<{ contactId?: string; phone: string }> = [];
      for (const contact of fetched) {
        if (!contact) continue; // unknown id — drop
        if (!isDirectShareRecipientType(contact.type)) continue; // tenant or partner only (D20)
        if (contact.sms_opt_out === true) continue; // HARD exclusion (re-enforced)
        if (contact.sms_unreachable === true) continue; // HARD exclusion (re-enforced)
        if (typeof contact.phone !== 'string' || contact.phone.length === 0) continue; // unsendable
        survivors.push({ contactId: contact.contactId, phone: contact.phone });
      }
      // Same contactKey convention (contactId else phone#<E164>) + de-dupe - here
      // ids are real contactIds, so keys are the contactIds.
      recipients = buildRecipientsFrom(survivors);
      count = Object.keys(recipients).length;
      if (count === 0) {
        // Nothing survived the fences (all dropped) — refuse clearly, leave the
        // draft for the operator to adjust.
        res.status(400).json({ error: 'empty_audience' });
        return;
      }
      if (count > MAX_BROADCAST_RECIPIENTS) {
        log.warn(
          { broadcastId, count, cap: MAX_BROADCAST_RECIPIENTS },
          'broadcast send refused: explicit selection too large',
        );
        res.status(400).json({
          error: 'audience_too_large',
          message: `audience of ${count} exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap — remove recipients`,
          count,
          truncated: false,
        });
        return;
      }
    } else if (broadcast.audience_mode === 'seeds_only') {
      // (b) seeds_only no-body - resolve the draft's seed_contact_ids (same
      // fences as resolveSeeds), NOT the default tenant filter (which would
      // otherwise send to every tenant). Reuse the explicit-path recipient build.
      const seeds = await resolveSeeds(broadcast.seed_contact_ids ?? []);
      if (seeds.contacts.length === 0) {
        // Every seed dropped (unknown / not a tenant or partner / opted-out / unreachable /
        // phone-less) - refuse clearly, leave the draft for the operator.
        res.status(400).json({ error: 'empty_audience' });
        return;
      }
      recipients = buildRecipientsFrom(seeds.contacts);
      count = Object.keys(recipients).length;
    } else {
      // (c) Filter draft, no body (API only - the dashboard always posts an
      // explicit list, path (a)). Re-resolve the audience at send time (the
      // source of truth - the draft estimate may be stale), then apply
      // matching-blast-rules D6: the resolved audience (D1 status, D2 housing
      // authorities) MINUS tenants held by an unresolved tour (D4, evaluated
      // now) MINUS effective #27 declines of this property. Already-sent
      // tenants and tenants without recorded consent are NOT subtracted (the
      // fan-out skips a no-consent recipient and counts it skipped_no_consent),
      // and seeds stay out of this path, as before. The recipients map is keyed
      // by contactKey (contactId else phone#<E164>, the shared convention), all
      // 'queued'.
      // Spec 2026-10-06 D7: re-check the stored housing authority filter HERE,
      // inside the one branch that re-resolves it - an explicit selection (a)
      // and a seeds_only draft (b) never read the filter, so they are never
      // refused for it. Every refusal below leaves the draft a draft: nothing
      // is marked sending and nothing is enqueued.
      const refusal = await storedFilterRefusal(broadcast.audience_filter);
      if (refusal !== undefined) {
        log.info({ broadcastId }, 'broadcast send refused: stored housing authority filter not on the list');
        res.status(422).json(refusal);
        return;
      }
      const audience = await resolveAudience(broadcast.audience_filter);
      // D6: the tours and decline reads fail CLOSED - sending without them
      // would text tenants the rules leave out.
      let rules: { tourHolds: Map<string, TourHold>; declinedIds: Set<string> };
      try {
        rules = await readAudienceRules(broadcast.unitId, Date.now());
      } catch (err) {
        log.warn({ err, broadcastId }, 'broadcast send refused: audience rules unavailable - 503');
        res.status(503).json({ error: 'audience_rules_unavailable' });
        return;
      }
      const finalContacts = audience.contacts.filter(
        (c) => !rules.tourHolds.has(c.contactId) && !rules.declinedIds.has(c.contactId),
      );
      if (finalContacts.length === 0) {
        // Nobody left to send to: refuse clearly, leave it a draft.
        res.status(400).json({ error: 'empty_audience' });
        return;
      }
      // Bound the audience (FIX 3+4): refuse when the FINAL set (after the D6
      // exclusions) exceeds the recipients-map item-size cap, OR when the
      // resolution was truncated (page cap hit - the set is INCOMPLETE and
      // sending would silently under-deliver). Either way leave the broadcast a
      // DRAFT and do NOT enqueue.
      if (finalContacts.length > MAX_BROADCAST_RECIPIENTS || audience.truncated) {
        log.warn(
          {
            broadcastId,
            count: finalContacts.length,
            resolved: audience.contacts.length,
            truncated: audience.truncated,
            cap: MAX_BROADCAST_RECIPIENTS,
          },
          'broadcast send refused: audience too large',
        );
        res.status(400).json({
          error: 'audience_too_large',
          message: audience.truncated
            ? 'audience resolution was truncated - the audience could not be read completely'
            : `audience of ${finalContacts.length} exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap - narrow the housing authority and/or bedroom-size filter`,
          count: finalContacts.length,
          truncated: audience.truncated,
        });
        return;
      }
      log.info(
        { broadcastId, resolved: audience.contacts.length, sending: finalContacts.length },
        'broadcast filter send: held and declined tenants left out',
      );
      recipients = buildRecipientsFrom(finalContacts);
      count = Object.keys(recipients).length;
    }

    let sending: BroadcastItem;
    try {
      sending = await broadcasts.markSending(broadcastId, recipients);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // markSending is conditional on status='draft'. A concurrent/duplicate
        // send won the flip between our read above and here — return the same
        // idempotent-clean 409 as the draft-state guard (NOT an uncaught 500),
        // and do NOT enqueue (the winning send owns the fan-out).
        log.info({ broadcastId }, 'broadcast send raced a concurrent send — not a draft, 409');
        res.status(409).json({ error: 'broadcast_not_draft' });
        return;
      }
      throw err;
    }

    try {
      await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId });
    } catch (err) {
      // Enqueue failed AFTER markSending — the broadcast is 'sending' but no job
      // runs. Mark it failed so the operator sees the honest outcome (no silent
      // stuck-sending). Surface 500 so the client can retry.
      log.error({ err, broadcastId }, 'broadcast send: enqueue failed — marking failed');
      try {
        await broadcasts.markFailed(broadcastId, 'enqueue failed');
      } catch (markErr) {
        log.error({ err: markErr, broadcastId }, 'broadcast send: markFailed also failed');
      }
      res.status(500).json({ error: 'enqueue_failed' });
      return;
    }

    await audit.append(`broadcasts#${broadcastId}`, 'broadcast_sent', {
      actor,
      count,
    });
    log.info({ broadcastId, count, actor }, 'broadcast send started via api');
    res.json({ broadcastId, status: sending.status, count });
  });

  // GET /api/broadcasts/follow-ups - the waiting list behind Matching's Follow
  // up tab and the Properties list pill (last-heard-from spec 5.6, 14.4).
  // { items, byUnit, truncated }; 503 outcome_unavailable when a required read
  // fails (D12 - an outcome shown with buttons is never guessed). Registered
  // ABOVE every /broadcasts/:broadcastId route so a future
  // GET /broadcasts/:broadcastId cannot answer this path. Mounted under /api
  // (all methods at the edge already) - no CloudFront change.
  router.get('/broadcasts/follow-ups', async (_req, res) => {
    mergeContext({});
    try {
      const out = await buildFollowUps({ units, listingSends, tours, contacts, log, now: Date.now() });
      log.info(
        { items: out.items.length, units: Object.keys(out.byUnit).length, truncated: out.truncated },
        'follow-ups served',
      );
      res.json(out);
    } catch (err) {
      log.warn({ err }, 'follow-ups: a required read failed - 503');
      res.status(503).json({ error: 'outcome_unavailable' });
    }
  });

  // GET /api/broadcasts/:id/results - stats + per-recipient delivery map.
  // ?view=stats (share-sent-outcome D4, the ONLY accepted value; anything else
  // is 400 invalid_view) returns the share and its stats alone - no recipient
  // list, no contact reads.
  router.get('/broadcasts/:broadcastId/results', async (req, res) => {
    const { broadcastId } = req.params;
    const view = req.query['view'];
    if (view !== undefined && view !== 'stats') {
      res.status(400).json({ error: 'invalid_view' });
      return;
    }
    // A CONSISTENT read, in both views (code review R2-1): the list's stats
    // refetch and the results page's post-event refetch run about 400 ms after
    // the write whose event triggered them - at a chain's end no later event
    // follows, so a replica that had not applied that write would lock in the
    // pre-write label. The row reads beside it are consistent too.
    const broadcast = await broadcasts.getByIdConsistent(broadcastId);
    if (!broadcast) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    // share-sent-outcome D1/D3: each recipient's state, WITHOUT record reads
    // (deviation 12 - the record only tells in flight from stranded, which this
    // page does not show; the composer flag alone reads it, through
    // buildReviewRows at preview and draft create). Only a young failed-30003
    // slot reads its newest attempt's row, 8 at a time.
    const states = await resolveRecipientStates({ messages, attempts, log }, broadcast);
    const stats = statsWithStates(broadcast, states);
    if (view === 'stats') {
      res.json(toBroadcastStatsView(broadcast, stats));
      return;
    }
    // S5: resolve raw identity (firstName/lastName/phone) for each recipient so
    // the results rows are human-readable. IDs/counts only in logs (never here).
    const recipients = await enrichRecipients(contacts, broadcast.recipients ?? {}, states);
    res.json(toBroadcastResults(broadcast, recipients, stats));
  });

  // GET /api/broadcasts?status=&limit= — the TEAM-WIDE list (optionally status-
  // filtered), newest-first. Both branches read the same byCreated GSI, so the
  // dashboard's All tab and its status tabs see the SAME population (they used
  // to diverge: no-filter was scoped to the acting user, 2026-07-08 bug).
  router.get('/broadcasts', async (req, res) => {
    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }
    // Optional opaque cursor → ExclusiveStartKey (FIX 5). A tampered/invalid
    // cursor is a 400 (never handed to DynamoDB malformed).
    let exclusiveStartKey: Record<string, unknown> | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      exclusiveStartKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (exclusiveStartKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }
    const opts = { limit, ...(exclusiveStartKey !== undefined && { exclusiveStartKey }) };

    const rawStatus = req.query['status'];
    let page;
    if (typeof rawStatus === 'string' && rawStatus.length > 0) {
      if (!BROADCAST_STATUSES.has(rawStatus)) {
        res.status(400).json({ error: `status must be one of: ${[...BROADCAST_STATUSES].join(', ')}` });
        return;
      }
      // Filtered pages can come back SHORT (Limit precedes the filter) while
      // still carrying a cursor — the client pages until nextCursor is null.
      page = await broadcasts.listByStatus(rawStatus as BroadcastStatus, opts);
    } else {
      page = await broadcasts.list(opts);
    }
    // share-sent-outcome D4: each row's stats carry the true retry_pending and
    // the results page's Not-confirmed re-bucketing, so the two agree. One
    // state resolution per row, no record reads (deviation 12); rows run one
    // after another so reads stay 8 in flight, and a row with no young
    // failed-30003 slot reads nothing - a page of ordinary shares costs what
    // it cost before.
    const summaries: Array<Record<string, unknown>> = [];
    for (const b of page.items) {
      const states = await resolveRecipientStates({ messages, attempts, log }, b);
      summaries.push(toBroadcastSummary(b, statsWithStates(b, states)));
    }
    res.json({
      broadcasts: summaries,
      nextCursor:
        page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  // PATCH /api/broadcasts/:id — replace the draft's hand-picked seed_contact_ids
  // (the review step's curated additions / the seeded 1:1 entry). Draft-only:
  // the repo's conditional write refuses a sending/sent/failed broadcast (409).
  // An EMPTY array is VALID here (it CLEARS the seed list) — unlike create, where
  // an empty list is treated as absent. Absent/malformed body → 400 bad_request.
  // VA-accessible (same posture as the rest of the router).
  router.patch('/broadcasts/:broadcastId', async (req, res) => {
    const broadcastId = String(req.params['broadcastId'] ?? '');
    const parsed = parseRecipientContactIds(
      (req.body as Record<string, unknown> | undefined)?.['seedContactIds'],
    );
    // Absent (undefined) OR malformed ({ error }) → a clean 400. An empty array
    // is a valid clear and parses to { ids: [] } (never undefined/error).
    if (parsed === undefined || 'error' in parsed) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const existing = await broadcasts.getById(broadcastId);
    if (!existing) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    try {
      await broadcasts.setSeedContactIds(broadcastId, parsed.ids);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // The broadcast is no longer a draft (a concurrent send flipped it, or it
        // was already sending/sent/failed) — its recipients are frozen.
        res.status(409).json({ error: 'broadcast_not_draft' });
        return;
      }
      throw err;
    }
    log.info({ broadcastId, seedCount: parsed.ids.length }, 'broadcast seeds updated via api');
    res.status(200).json({ broadcastId, seedContactIds: parsed.ids });
  });

  // DELETE /api/broadcasts/:id — delete an UNSENT draft only. A sending/sent/
  // failed broadcast is permanent (409). The repo's conditional delete is the
  // race guard — a concurrent send that flips draft→sending mid-call yields 409,
  // never a silent delete of a sent broadcast. Audited IDs-only (NEVER the body/
  // audience). VA-accessible (same posture as the rest of the router).
  router.delete('/broadcasts/:broadcastId', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId ?? 'unknown';
    const { broadcastId } = req.params;
    const result = await broadcasts.delete(broadcastId);
    if (result.deleted) {
      await audit.append(`broadcasts#${broadcastId}`, 'broadcast_deleted', { actor });
      log.info({ broadcastId, actor }, 'broadcast draft deleted via api');
      res.status(200).json({ deleted: true });
      return;
    }
    if (result.reason === 'not_found') {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    // not_draft: re-read the current status so the client can fall back to the
    // results view (the row is already sending/sent/failed).
    const current = await broadcasts.getById(broadcastId);
    res.status(409).json({
      error: 'broadcast_not_draft',
      ...(current !== undefined && { status: current.status }),
    });
  });

  return router;
}
