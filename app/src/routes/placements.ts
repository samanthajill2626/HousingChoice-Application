// Placements CRUD + boards router (M1.10) — mounted under /api/placements,
// behind requireAuth via the /api mount (app.ts). VAs run the boards day-to-day,
// so NO admin gate (same posture as units/contacts).
//
//   GET   /api/placements?stage=&tenantId=&unitId=&tourDate=&limit=&cursor=
//                                       → { placements, nextCursor }
//   POST  /api/placements { tenantId, unitId, stage?, placement_tag? }   → 201 { placement }
//   GET   /api/placements/:placementId            → { placement } | 404
//   PATCH /api/placements/:placementId { partial} → { placement } | 404
//   POST  /api/placements/:placementId/deadline { type:'follow_up', at } | { clear:true }  → { placement } | 404
//
// A placement is "one deal, tour-interest → move-in" (doc §5). This router owns
// the manual board lifecycle (Phase 1 is hand-touched parity — the operator sets
// the stage, schedules tours, sets deadlines); the relay-on-placement seam
// (POST /:placementId/relay) and the masked-call wiring come in M1.10c-d.
//
// Validation: a FIXED field allowlist (the H2-review fix — the route owns the
// stage/key allowlist; the repo trusts it). stage is allowlisted (a GSI
// partition key); a legacy next_deadline_* key on the PATCH body is REFUSED here
// (deadlines are first-class placementDeadlines items now — set a manual
// `follow_up` via /deadline; rta_window/voucher_expiration are system-managed).
//
// PII (doc §9): responses carry full placement docs to the authenticated client;
// LOG LINES are placementId/stage/counts only — never the placement_tag (a name).
import { randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { mergeContext } from '../lib/context.js';
import { appEvents, toPlacementUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { parseIntroBody } from '../lib/relayIntroBody.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  type PlacementsPage,
  type PlacementsRepo,
  ConditionalCheckFailedException,
  createPlacementsRepo,
  type ListPlacementsOpts,
} from '../repos/placementsRepo.js';
import {
  createPlacementDeadlinesRepo,
  soonestDeadline,
  type PlacementDeadlineItem,
  type PlacementDeadlinesRepo,
  type SoonestDeadline,
} from '../repos/placementDeadlinesRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import { createToursRepo, type ToursRepo } from '../repos/toursRepo.js';
import { createTourRemindersRepo, type TourRemindersRepo } from '../repos/tourRemindersRepo.js';
import { createPoolNumbersService, type PoolNumbersService } from '../services/poolNumbers.js';
import {
  createStatusTransitionService,
  type StatusTransitionService,
} from '../services/statusTransition.js';
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
} from '../repos/activityEventsRepo.js';
import {
  TERMINAL_STAGES,
  type PlacementItem,
} from '../repos/placementsRepo.js';
import { isInspectionOutcome, isPlacementStage, STAGE_LABELS, type PlacementStage } from '../lib/statusModel.js';
import { recordPersonMilestone } from '../lib/personEvents.js';
import {
  describeRoster,
  type RosterOwner,
  type RosterResolutionDeps,
} from '../lib/rosterResolution.js';
import { readQuietHoursWindow } from '../jobs/tourReminders.js';
import { clampOutOfQuietHours, isQuietTime } from '../lib/quietHours.js';
import {
  openPlacementGroup,
  placementOpenDeferralRefusal,
  placementOpenGuard,
  type OpenPlacementGroupDeps,
} from '../services/rosterProvision.js';
import {
  applyPlacementRosterAction,
  type PlacementRosterActionDeps,
} from '../jobs/rosterActions.js';
import {
  createPendingRosterActionsRepo,
  rosterActionIdFor,
  type PendingRosterActionsRepo,
} from '../repos/pendingRosterActionsRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import {
  addMemberToRelay,
  removeMemberFromRelay,
  type RelayMemberDeps,
} from '../services/relayMembers.js';
import { findOpenGroupWithSamePhones } from '../services/relayGroupDuplicates.js';
import {
  applyRosterPlanEdit,
  buildAddPreview,
  buildOpenPreview,
  parseRosterEntryInput,
  resolveRosterCandidate,
  ROSTER_ACTION_NOT_READY,
  ROSTER_NO_THREAD,
  ROSTER_THREAD_EXISTS,
  ROSTER_UNAVAILABLE,
  type QuietHoursState,
  type RosterEditRefusal,
  type RosterPlanState,
  type RosterPlanStore,
} from '../services/rosterEdits.js';

export interface PlacementsRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  placementsRepo?: PlacementsRepo;
  /** First-class placement deadlines (placement-deadline-model): serialize + arm/retire. */
  placementDeadlinesRepo?: PlacementDeadlinesRepo;
  auditRepo?: AuditRepo;
  events?: EventBus;
  /** M1.10c relay-on-placement — the placement-scoped "Set up relay thread" action. */
  conversationsRepo?: ConversationsRepo;
  unitsRepo?: UnitsRepo;
  contactsRepo?: ContactsRepo;
  poolNumbersService?: PoolNumbersService;
  /** Post-Tour conversion (POST /from-tour): read/finalize the source tour. */
  toursRepo?: ToursRepo;
  /** Post-Tour conversion: cancel the tour's pending reminder rows on convert. */
  tourRemindersRepo?: TourRemindersRepo;
  /** Org quiet-hours window for the roster previews (contact-rosters Task 10). */
  settingsRepo?: SettingsRepo;
  /** BE2/C2: emit placement_opened/placement_closed/stage_changed/tour_* milestones. */
  activityEventsRepo?: ActivityEventsRepo;
  /** Quiet-hours deferrals (contact-rosters Task 13): the pending open/add rows. */
  pendingRosterActionsRepo?: PendingRosterActionsRepo;
  /**
   * Injected clock for the quiet-hours evaluation on the open / live-add paths
   * (contact-rosters Task 13) - defaults to the wall clock. Tests inject it to
   * assert exact dueAt values; production omits it.
   */
  now?: () => string;
  /**
   * Status-transition service — its derive helpers stamp tenant/property coarse
   * status on create (best-effort; §7). Defaulted to the real service below.
   */
  statusTransitionService?: StatusTransitionService;
}

/**
 * Human label for a stage value — the centralized STAGE_LABELS map (the single
 * source of display copy). Falls back to a title-cased key for any non-stage
 * value (e.g. a tour outcome reused by this helper).
 */
function stageLabel(stage: string): string {
  if (isPlacementStage(stage)) return STAGE_LABELS[stage];
  return stage
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}


/** Resolved "First Last" from a contact, or undefined (never a guess). */
function nameFromContact(contact: ContactItem | undefined): string | undefined {
  if (!contact) return undefined;
  const first = typeof contact['firstName'] === 'string' ? contact['firstName'] : '';
  const last = typeof contact['lastName'] === 'string' ? contact['lastName'] : '';
  const joined = `${first} ${last}`.trim();
  return joined.length > 0 ? joined : undefined;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A REAL calendar date in YYYY-MM-DD — rejects impossible dates the regex alone
 * lets through (2026-13-45, 2026-02-30) so a junk value never lands on the
 * byTourDate partition key. Used on BOTH write (tour_date) and read (?tourDate=).
 */
function isValidYmd(v: string): boolean {
  if (!YYYY_MM_DD.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Parse ?limit= into 1..MAX (default DEFAULT). undefined = invalid → 400. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

// --- Cursor (opaque to clients) --------------------------------------------
// base64url(JSON) of the Query/Scan LastEvaluatedKey. A placement cursor is a
// small flat object of string key attributes (placementId + maybe a GSI key). We
// validate the SHAPE (1..3 scalar keys), not exact keys, since it varies by which
// index produced it — a client-tampered cursor must never reach DynamoDB as a
// malformed key.
function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const key = parsed as Record<string, unknown>;
    const entries = Object.entries(key);
    if (entries.length < 1 || entries.length > 3) return undefined;
    for (const [, v] of entries) {
      if (typeof v !== 'string' && typeof v !== 'number') return undefined;
    }
    return key;
  } catch {
    return undefined;
  }
}

type Validation<T> = { ok: true; fields: T } | { ok: false; error: string };

/** Validate POST /placements. tenantId + unitId required; stage/placement_tag optional. */
function validatePlacementCreate(
  body: unknown,
): Validation<{ tenantId: string; unitId: string; stage: string; placement_tag?: string }> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const tenantId = b['tenantId'];
  const unitId = b['unitId'];
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return { ok: false, error: 'tenantId (non-empty string) is required' };
  }
  if (typeof unitId !== 'string' || unitId.length === 0) {
    return { ok: false, error: 'unitId (non-empty string) is required' };
  }
  // stage defaults to the ladder's first rung; if supplied it must be allowlisted
  // (it's the byStage GSI partition key).
  let stage = 'send_application';
  if (b['stage'] !== undefined) {
    if (!isPlacementStage(b['stage'])) {
      return { ok: false, error: `stage must be one of the placement stages` };
    }
    stage = b['stage'];
  }
  const fields: { tenantId: string; unitId: string; stage: string; placement_tag?: string } = {
    tenantId,
    unitId,
    stage,
  };
  if (b['placement_tag'] !== undefined) {
    if (typeof b['placement_tag'] !== 'string') {
      return { ok: false, error: 'placement_tag must be a string' };
    }
    fields.placement_tag = b['placement_tag'];
  }
  return { ok: true, fields };
}

/**
 * Updatable fields and their validators. Immutable keys (placementId/tenantId/
 * unitId) and the managed group_thread/created_at are NOT here (a deal's parties
 * don't change — make a new placement). The next_deadline composite key is
 * refused below. `null` clears a field (REMOVE in the repo) — the only way to
 * clear tour_date (a sparse key) or the attention flag.
 */
// NOTE: `lost_reason` is NOT here — it is the STRUCTURED `{category, text}`
// object written by the transition service (POST /api/placements/:id/transition
// on a `lost` move), never a free string set through this legacy CRUD PATCH.
const STRING_FIELDS = ['placement_tag', 'lease_date', 'move_in_date', 'notes'] as const;
const OBJECT_FIELDS = ['application', 'rta'] as const;
// The complete-paperwork checklist toggles (Approval & Move-in). Each optional.
const BOOL_FIELDS = ['lease_signed', 'lif', 'move_in_details'] as const;

/** Validate PATCH /placements/:placementId. Allowlist + per-field type checks. */
function validatePlacementUpdate(body: unknown): Validation<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    if (key === 'next_deadline_type' || key === 'next_deadline_at') {
      return { ok: false, error: 'set the deadline via POST /placements/:placementId/deadline' };
    }
    // `stage` is DELIBERATELY not writable here (§8: every placement-stage
    // transition routes through the ONE transition service so stage_entered_at/
    // stage_source/derivation/nudges are stamped). Use
    // POST /api/placements/:placementId/transition instead.
    if (key === 'stage') {
      return { ok: false, error: 'change the stage via POST /placements/:placementId/transition' };
    }
    if (key === 'tour_date') {
      if (value === null) {
        fields['tour_date'] = null; // clear → drops from the sparse byTourDate
        continue;
      }
      if (typeof value !== 'string' || !isValidYmd(value)) {
        return { ok: false, error: 'tour_date must be a valid YYYY-MM-DD date or null' };
      }
      fields['tour_date'] = value;
      continue;
    }
    if (key === 'attention') {
      // The escalation flag is SET server-side (the M1.10c twilio seam). Via
      // this route an operator may only CLEAR it (acknowledge) with null.
      if (value !== null) return { ok: false, error: 'attention can only be cleared (null) here' };
      fields['attention'] = null;
      continue;
    }
    if ((STRING_FIELDS as readonly string[]).includes(key)) {
      if (value !== null && typeof value !== 'string') {
        return { ok: false, error: `${key} must be a string or null` };
      }
      fields[key] = value;
      continue;
    }
    if ((OBJECT_FIELDS as readonly string[]).includes(key)) {
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        return { ok: false, error: `${key} must be an object or null` };
      }
      fields[key] = value;
      continue;
    }
    if ((BOOL_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') {
        return { ok: false, error: `${key} must be a boolean` };
      }
      fields[key] = value;
      continue;
    }
    // In-place stage-data (Approval & Move-in): the value-shape check lives here;
    // the STAGE guard (only settable at the field's own stage) is enforced in the
    // PATCH handler, which has the loaded placement. Mirrors the transition
    // service's captures (inspection_date / rent_determined / inspection_outcome).
    if (key === 'inspection_date') {
      if (typeof value !== 'string' || value.length === 0) {
        return { ok: false, error: 'inspection_date must be a non-empty date string' };
      }
      fields['inspection_date'] = value;
      continue;
    }
    if (key === 'rent_determined') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return { ok: false, error: 'rent_determined must be a finite number > 0' };
      }
      fields['rent_determined'] = value;
      continue;
    }
    if (key === 'inspection_outcome') {
      if (!isInspectionOutcome(value)) {
        return { ok: false, error: 'inspection_outcome must be pass or fail' };
      }
      fields['inspection_outcome'] = value;
      continue;
    }
    if (key === 'tours') {
      if (value !== null && !Array.isArray(value)) {
        return { ok: false, error: 'tours must be an array or null' };
      }
      fields['tours'] = value;
      continue;
    }
    return { ok: false, error: `unknown or immutable field: ${key}` };
  }

  if (Object.keys(fields).length === 0) {
    return { ok: false, error: 'no updatable fields supplied' };
  }
  return { ok: true, fields };
}

/**
 * Validate POST /placements/:placementId/deadline. Manual deadline setting is
 * restricted to `follow_up` ONLY: rta_window / voucher_expiration are
 * SYSTEM-managed (armed by the transition service / contact-edit sync) and are
 * off-limits to a manual set (placement-deadline-model §12). Returns the
 * follow_up deadline to arm, or null to clear it.
 */
function validateDeadline(body: unknown): Validation<{ type: 'follow_up'; at: string } | null> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (b['clear'] === true) return { ok: true, fields: null };
  if (b['type'] !== 'follow_up') {
    return { ok: false, error: 'type must be "follow_up" (or send { clear: true })' };
  }
  const at = b['at'];
  if (typeof at !== 'string' || at.length === 0 || Number.isNaN(Date.parse(at))) {
    return { ok: false, error: 'at must be an ISO 8601 timestamp' };
  }
  // Canonicalize so the byDueAt range key sorts lexicographically.
  return { ok: true, fields: { type: 'follow_up', at: new Date(at).toISOString() } };
}

export function createPlacementsRouter(deps: PlacementsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const placementDeadlines =
    deps.placementDeadlinesRepo ?? createPlacementDeadlinesRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const activityEvents =
    deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const poolNumbers =
    deps.poolNumbersService ?? createPoolNumbersService({ config, logger: deps.logger });
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const reminders = deps.tourRemindersRepo ?? createTourRemindersRepo({ logger: deps.logger });
  const settingsRepo = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const rosterActions =
    deps.pendingRosterActionsRepo ?? createPendingRosterActionsRepo({ logger: deps.logger });
  const getNow = deps.now ?? (() => new Date().toISOString());
  // §7 derive-on-create: the transition service's derive helpers stamp the
  // tenant + property coarse statuses on create (override-gated, source 'derived').
  // Self-construct from the SAME repos this router already builds when not injected.
  const transitions =
    deps.statusTransitionService ??
    createStatusTransitionService({
      placementsRepo: placements,
      placementDeadlinesRepo: placementDeadlines,
      unitsRepo: units,
      contactsRepo: contacts,
      auditRepo: audit,
      events,
      // D5 close-nag safety net (AF-1/CF-1): arm the nag on a terminal
      // (lost/moved_in) transition whose linked relay group is still open.
      conversationsRepo: conversations,
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });

  /**
   * Attach the COMPUTED soonest deadline onto a placement for a wire response.
   * The flat next_deadline_type/next_deadline_at shape is preserved; its source
   * is the placement's placementDeadlines items (no stored slot).
   */
  const withDeadline = (
    p: PlacementItem,
    soonest: SoonestDeadline | null,
  ): PlacementItem => {
    // Terminal-stage guard (parity with today.ts): a closed deal has NO live
    // deadline. A straggler deadline row (a partial clearForPlacement failure, or
    // a voucher-sync↔terminal-transition race) must NOT surface a chip on the
    // card/detail — treat a terminal placement as having no deadline.
    const effective = TERMINAL_STAGES.has(p.stage) ? null : soonest;
    return {
      ...p,
      next_deadline_type: effective?.type,
      next_deadline_at: effective?.at,
    };
  };

  /** Emit placement.updated with the recomputed soonest deadline (one query). */
  async function emitPlacementUpdated(placement: PlacementItem): Promise<void> {
    const ds = await placementDeadlines.listByPlacement(placement.placementId);
    events.emit('placement.updated', toPlacementUpdatedEvent(placement, soonestDeadline(ds)));
  }

  /**
   * Best-effort: arm the tenant's voucher_expiration deadline on a freshly
   * created placement, sourced from the tenant contact's voucher_expiration_date
   * (the tenant-level clock — placement-deadline-model §6). A failure never fails
   * the create (the placement is already persisted).
   */
  async function armVoucherFromTenant(placementId: string, tenantId: string): Promise<void> {
    try {
      const tenant = await contacts.getById(tenantId);
      const date = tenant?.voucher_expiration_date;
      if (typeof date === 'string' && date.length > 0) {
        await placementDeadlines.arm(placementId, 'voucher_expiration', date);
      }
    } catch (err) {
      log.error({ err, placementId }, 'create-path voucher arm failed (best-effort)');
    }
  }

  // BE2/C2: record one placement milestone against the tenant contact AND the
  // placement unit's landlord (contact-comms-pane dual-party - lib/personEvents
  // resolves unit.landlordId point-in-time and guards every write).
  // Best-effort — a log failure must NEVER fail the operator's board action (the
  // placement is already persisted); follows the neighbors' try/catch+log
  // convention.
  async function recordPlacementMilestone(
    tenantId: string,
    type: 'placement_opened' | 'placement_closed' | 'stage_changed' | 'tour_scheduled' | 'tour_took_place',
    label: string,
    placementId: string,
    unitId: string,
  ): Promise<void> {
    await recordPersonMilestone(
      { activityEvents, units, log },
      { tenantId, unitId, type, label, refType: 'placement', refId: placementId },
    );
  }

  const router = Router();

  // GET /api/placements — the boards' read. Exactly one filter is honored, most-
  // specific first: tourDate > stage > tenantId > unitId; with no filter, a
  // paginated Scan (the "all placements" kanban fallback). Each path is a single
  // bounded Query (or the Scan), never an unbounded fan. Each returned placement
  // carries its COMPUTED next_deadline_* (soonest of its placementDeadlines
  // items), joined via ONE listAllPending() query (a placementId→soonest map),
  // NOT one query per placement.
  router.get('/', async (req, res) => {
    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }
    let exclusiveStartKey: Record<string, unknown> | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      exclusiveStartKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (exclusiveStartKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }
    const opts: ListPlacementsOpts = {
      limit,
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    };

    const stage = req.query['stage'];
    const tenantId = req.query['tenantId'];
    const unitId = req.query['unitId'];
    const tourDate = req.query['tourDate'];

    let page: PlacementsPage;
    if (typeof tourDate === 'string' && tourDate.length > 0) {
      if (!isValidYmd(tourDate)) {
        res.status(400).json({ error: 'tourDate must be a valid YYYY-MM-DD date' });
        return;
      }
      page = await placements.listByTourDate(tourDate, opts);
    } else if (typeof stage === 'string' && stage.length > 0) {
      if (!isPlacementStage(stage)) {
        res.status(400).json({ error: 'stage must be a known placement stage' });
        return;
      }
      page = await placements.listByStage(stage, opts);
    } else if (typeof tenantId === 'string' && tenantId.length > 0) {
      page = await placements.listByTenant(tenantId, opts);
    } else if (typeof unitId === 'string' && unitId.length > 0) {
      page = await placements.listByUnit(unitId, opts);
    } else {
      page = await placements.list(opts);
    }

    // Compute each placement's soonest deadline from ONE listAllPending() query
    // (a placementId→soonest map), never one query per placement.
    const pending = await placementDeadlines.listAllPending();
    const byPlacement = new Map<string, PlacementDeadlineItem[]>();
    for (const d of pending) {
      const arr = byPlacement.get(d.placementId);
      if (arr) arr.push(d);
      else byPlacement.set(d.placementId, [d]);
    }
    const serialized = page.items.map((p) =>
      withDeadline(p, soonestDeadline(byPlacement.get(p.placementId) ?? [])),
    );

    res.json({
      placements: serialized,
      nextCursor: page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  // POST /api/placements — open a placement (one deal: this tenant on this unit).
  router.post('/', async (req: AuthedRequest, res) => {
    const validation = validatePlacementCreate(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    // Referential integrity: the tenant + unit must exist. The UI only offers real
    // entities, but a stale picker (an entity deleted between fetch and submit) or a
    // direct API caller could reference a ghost — refuse rather than persist a
    // dangling placement. 404 + a typed code, mirroring placement_not_found. (IDs only.)
    if (!(await contacts.getById(validation.fields.tenantId))) {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }
    if (!(await units.getById(validation.fields.unitId))) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    // Create is NOT a transition, but the denormalized provenance fields for the
    // INITIAL stage must be initialized (stage_entered_at + stage_source) so a
    // later `derived` write respects precedence (§8) and time-in-stage is
    // computable from the start. The initial stage is operator-set ⇒ 'manual'.
    const created = await placements.create({
      tenantId: validation.fields.tenantId,
      unitId: validation.fields.unitId,
      stage: validation.fields.stage as Parameters<PlacementsRepo['create']>[0]['stage'],
      stage_entered_at: new Date().toISOString(),
      stage_source: 'manual',
      ...(validation.fields.placement_tag !== undefined && {
        placement_tag: validation.fields.placement_tag,
      }),
    });
    mergeContext({ placementId: created.placementId });
    await audit.append(`placements#${created.placementId}`, 'placement_created', {
      actor: req.user?.userId,
      tenantId: created.tenantId,
      unitId: created.unitId,
      stage: created.stage,
    });
    // BE2/C2: a new placement is a "placement opened" milestone on the tenant's
    // timeline - and on the unit landlord's (dual-party).
    await recordPlacementMilestone(created.tenantId, 'placement_opened', 'Placement opened', created.placementId, created.unitId);
    // Arm the tenant's voucher_expiration deadline from the contact date (best-effort).
    await armVoucherFromTenant(created.placementId, created.tenantId);
    await emitPlacementUpdated(created);
    // §7 derive-on-create: stamp the tenant + property coarse statuses for the
    // initial stage (override-gated, source 'derived'). Best-effort — a derived
    // write failure must NEVER fail the 201 (the placement is already persisted).
    // deriveForStage is itself try/catch-internally; we still guard defensively.
    // IDs only in the log (NO placement_tag/names; matches recordPlacementMilestone).
    try {
      await transitions.deriveForStage(created.tenantId, created.unitId, created.stage);
    } catch (err) {
      log.error({ err, placementId: created.placementId }, 'derive-on-create failed (best-effort)');
    }
    log.info(
      { placementId: created.placementId, stage: created.stage, actor: req.user?.userId },
      'placement created via api',
    );
    const ds = await placementDeadlines.listByPlacement(created.placementId);
    res.status(201).json({ placement: withDeadline(created, soonestDeadline(ds)) });
  });

  // POST /api/placements/from-tour — the Post-Tour & Application conversion.
  // Creates the placement from a CONVERTIBLE tour (exit gate said move forward),
  // finalizes the tour (closed + convertedPlacementId + a ROTATED reminder-ladder
  // pointer, in one write), sweeps the tour's unsent reminder rungs away and
  // re-parents the tour's masked relay thread to the placement. QUIET: no
  // announcement message is sent (founder 2026-07-02). PII: log ids only.
  router.post('/from-tour', async (req: AuthedRequest, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const unknownFields = Object.keys(b).filter((k) => k !== 'tourId');
    if (unknownFields.length > 0) {
      res.status(400).json({ error: `unknown field(s): ${unknownFields.join(', ')}` });
      return;
    }
    if (typeof b['tourId'] !== 'string' || b['tourId'].length === 0) {
      res.status(400).json({ error: 'tourId (non-empty string) is required' });
      return;
    }
    const tourId = b['tourId'];
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    if (tour.convertible !== true) {
      res.status(409).json({ error: 'tour_not_convertible' });
      return;
    }
    // Fast-path 409: an already-converted (or mid-conversion) tour short-circuits
    // BEFORE any write — this saves the conditional claim below. `typeof string`
    // also matches the `pending:<uuid>` sentinel a concurrent claim writes, so a
    // convert racing behind a still-in-flight one still 409s here when it can.
    if (typeof tour['convertedPlacementId'] === 'string') {
      res.status(409).json({ error: 'tour_already_converted' });
      return;
    }
    // Referential integrity (same posture as POST /): the tenant + unit must
    // still exist. IDs only in the response codes.
    if (!(await contacts.getById(tour.tenantId))) {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }
    if (!(await units.getById(tour.unitId))) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }

    // ── ATOMIC CONVERSION CLAIM — closes the from-tour double-create race. ──
    // The fast-path read-check above is check-then-act: two concurrent POSTs can
    // BOTH read an unconverted tour and both proceed. The conditional claim
    // below (attribute_not_exists via toursRepo.claimConversion) lets exactly ONE
    // win; the loser's ConditionalCheckFailedException maps to 409. The sentinel
    // is UNIQUE per request so every release below is value-guarded — it can only
    // ever remove OUR OWN claim, never a co-winner's or the finalized id.
    //
    // Ordering (each pre-finalize failure RELEASES the claim so a retry is clean):
    //   1. Guards above (404s, convertible, fast-path 409).
    //   2. claimConversion(sentinel)                - CCFE -> 409 (race loser).
    //   3. placements.create                        - fail -> release + rethrow.
    //   4. finalize patch: sentinel -> real id,     - fail -> release + LOUD log.
    //      status closed, ROTATED currentLadderId
    //      (ONE write, see below).
    //   5. deleteSupersededForTour                  - best-effort, never fails the 201.
    //   6. best-effort tail (rebind/audit/...)      - never fails the 201.
    //
    // NOTHING retires this tour's reminders BEFORE the finalize (supersession
    // spec 3.2). A failed create or a failed finalize releases the claim and
    // leaves the tour scheduled and RETRYABLE by design, so any pre-finalize
    // disarm would have to be reversible - and neither of the two available ones
    // is: deleting a rung is final, and a claim-skip stamps skippedAt, which is
    // terminal (tourRemindersRepo), so releasing the claim could not bring the
    // ladder back. The reversible disarm is the claim the tour is already
    // carrying: while the `pending:` sentinel is stored, the poll DEFERS every
    // rung of this tour unclaimed (jobs/tourReminders.ts), so nothing fires
    // mid-conversion and nothing is stamped. AT the finalize the conversion is
    // real and there is nothing left to reverse, so the pointer rotation rides
    // that one write (step 4) and the sweep follows it (step 5).
    const sentinel = `pending:${randomUUID()}`;
    try {
      await tours.claimConversion(tour.tourId, sentinel);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // The loser of the race (or a second convert) lands here — one 201, one 409.
        res.status(409).json({ error: 'tour_already_converted' });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler (500).
    }

    // Create the placement at the ladder's first rung, carrying the tour
    // provenance (fromTourId) and — when the tour had a masked relay thread —
    // the group_thread link so the thread survives the conversion. Fail →
    // release the claim so a retry converts cleanly.
    let created;
    try {
      created = await placements.create({
        tenantId: tour.tenantId,
        unitId: tour.unitId,
        stage: 'send_application',
        stage_entered_at: new Date().toISOString(),
        stage_source: 'manual',
        fromTourId: tour.tourId,
        ...(typeof tour.groupThreadId === 'string' && { group_thread: tour.groupThreadId }),
        // ROSTER INHERITANCE (spec D4). A THREAD-BEARING tour needs no copy:
        // the participants ride the rebindOwner below and the placement reads
        // them like any other thread-bearing owner (a stale plan on such a tour
        // is inert and must NOT be resurrected here). A plan-only tour hands its
        // override over, so the placement opens with the people the operator
        // chose on the tour. The placement starts its own concurrency line.
        ...(typeof tour.groupThreadId !== 'string' &&
          Array.isArray(tour.roster) && { roster: tour.roster, rosterVersion: 1 }),
      });
    } catch (err) {
      await tours.releaseConversionClaim(tour.tourId, sentinel);
      throw err;
    }
    mergeContext({ placementId: created.placementId });

    // Finalize the tour: REPLACE the sentinel with the real placementId and close
    // it. On failure the placement already exists but the tour is left claimed by
    // the sentinel — attempt to release it (so a retry can re-convert) and log
    // LOUDLY with the orphan placementId. ACCEPTED RESIDUE: a retry after a
    // finalize-failure creates a SECOND placement; the orphan is findable via its
    // fromTourId + this loud log.
    //
    // The finalize ALSO ROTATES the reminder-ladder pointer (supersession spec
    // 3.2), in this same write and never as a second one: a separate rotation
    // reopens a window in which the tour is converted but still points at a live
    // ladder, and adds a rotation-failure branch nothing covers. After it, every
    // rung of the old ladder is refused by the poll and by Send now - which is
    // what makes the sweep below merely best-effort. Minted above the try so the
    // failure logs can name the value that did not land.
    const rotatedLadderId = randomUUID();
    try {
      await tours.patch(tour.tourId, {
        status: 'closed',
        convertedPlacementId: created.placementId,
        currentLadderId: rotatedLadderId,
      });
    } catch (err) {
      try {
        await tours.releaseConversionClaim(tour.tourId, sentinel);
      } catch (relErr) {
        log.error(
          { err: relErr, tourId: tour.tourId, orphanPlacementId: created.placementId },
          'convert: finalize-failure claim release ALSO failed',
        );
      }
      log.error(
        { err, tourId: tour.tourId, orphanPlacementId: created.placementId, rotatedLadderId },
        'convert: FINALIZE FAILED after placement created — ORPHAN placement (findable via fromTourId)',
      );
      throw err;
    }

    // RETIRE THE TOUR'S LADDER (supersession spec 3.2 / acceptance 7). The
    // finalize above rotated currentLadderId, so the unsent rungs are already
    // unreachable; this sweep is what stops them being SHOWN as promises the
    // tour can no longer keep. It hard-deletes the unsent rows only - anything
    // with a sentAt keeps its history.
    //
    // Best-effort by design (T8.4): the conversion is persisted and must not be
    // rolled back for a failed sweep, and the rotation is the backstop for
    // whatever the sweep misses. deleteSupersededForTour does not throw (it logs
    // per row and continues) - the try/catch is this tail's posture, not a claim
    // about that contract.
    //
    // T8.5, ACCEPTED: this route emits no `scheduled.updated` (only tour and
    // placement events, below), so the contact and group Upcoming buckets stay
    // stale until their next refetch. That is parity with the cancel path this
    // replaced, not a regression introduced here - the difference is that the
    // stale rows are now DELETED rather than canceled, so the refetch drops them
    // entirely instead of re-rendering them as canceled.
    // OWNERSHIP-GUARDED (spec 3.2 step 2, review round B1). The sweep is
    // generation-BLIND, so a concurrent reschedule that landed between the
    // finalize and here owns a LIVE ladder this sweep would delete outright.
    // Re-read and skip unless the finalize's own rotation still stands; the 201
    // stands either way - the conversion is persisted and is never rolled back
    // for a sweep decision.
    try {
      const owner = await tours.get(tour.tourId);
      if (owner?.currentLadderId !== rotatedLadderId) {
        log.error(
          {
            tourId: tour.tourId,
            placementId: created.placementId,
            rotatedLadderId,
            storedLadderId: owner?.currentLadderId,
          },
          'convert: a concurrent writer owns this ladder - skipping the superseded reminder sweep',
        );
      } else {
        await reminders.deleteSupersededForTour(tour.tourId, rotatedLadderId);
      }
    } catch (err) {
      log.error(
        { err, tourId: tour.tourId, placementId: created.placementId, rotatedLadderId },
        'convert: superseded tour reminder sweep failed (best-effort) - the rotated pointer keeps the rows harmless',
      );
    }

    // Re-parent the masked relay thread (metadata-only; pool + members preserved).
    if (typeof tour.groupThreadId === 'string') {
      try {
        await conversations.rebindOwner(tour.groupThreadId, { type: 'placement', id: created.placementId });
      } catch (err) {
        log.error({ err, placementId: created.placementId }, 'convert: thread rebind failed (best-effort)');
      }
    }

    // PENDING ROSTER ACTIONS MIGRATE with the roster (spec D4 / Task 13): a
    // quiet-hours deferral the operator confirmed on the TOUR still has to
    // happen, and after this the placement is the surface that shows it. Only
    // PENDING rows move - terminal notices belong to the tour's own history.
    // Best-effort, like every write in this tail: a failure must not fail a
    // conversion that is already persisted, and the orphan it leaves is exactly
    // what the poller's `converted` skip retires visibly.
    try {
      const migrated = await rosterActions.migrate(
        { ownerType: 'tour', ownerId: tour.tourId },
        { ownerType: 'placement', ownerId: created.placementId },
      );
      if (migrated.length > 0) {
        log.info(
          { tourId: tour.tourId, placementId: created.placementId, count: migrated.length },
          'convert: pending roster actions migrated to the placement',
        );
      }
    } catch (err) {
      log.error(
        { err, tourId: tour.tourId, placementId: created.placementId },
        'convert: migrating pending roster actions failed (best-effort) - the poller will retire the orphans as converted',
      );
    }

    await audit.append(`placements#${created.placementId}`, 'placement_created', {
      actor: req.user?.userId,
      tenantId: created.tenantId,
      unitId: created.unitId,
      stage: created.stage,
      fromTourId: tour.tourId,
    });
    // Tour-history milestone (tour-detail-page 1a): the conversion is the final
    // chapter of the tour's OWN story - a tours#<tourId> audit row carrying the
    // created placementId (the Activity card links it). Best-effort: a failed
    // write must never fail the 201 (the placement + finalize are persisted).
    try {
      await audit.append(`tours#${tour.tourId}`, 'tour_converted', {
        tourId: tour.tourId,
        placementId: created.placementId,
        ...(req.user?.userId !== undefined && { actor: req.user.userId }),
      });
    } catch (err) {
      log.error(
        { err, tourId: tour.tourId, placementId: created.placementId },
        'tour_converted tour audit failed (best-effort)',
      );
    }
    // ...and the same chapter on BOTH parties' contact timelines
    // (contact-comms-pane): the tenant's and the unit landlord's. refType 'tour'
    // - the pin points back at the tour that ended, not at the new placement
    // (placement_opened below is the placement's own pin). Best-effort.
    await recordPersonMilestone(
      { activityEvents, units, log },
      {
        tenantId: created.tenantId,
        unitId: created.unitId,
        type: 'tour_converted',
        label: 'Converted to placement',
        refType: 'tour',
        refId: tour.tourId,
      },
    );
    // Live tour-page refresh (tour-detail-page 1a): the finalize patch above
    // just closed the tour. ID + status only (no PII).
    events.emit('tour.updated', { tourId: tour.tourId, status: 'closed' });
    await recordPlacementMilestone(created.tenantId, 'placement_opened', 'Placement opened', created.placementId, created.unitId);
    // Arm the tenant's voucher_expiration deadline from the contact date (best-effort).
    await armVoucherFromTenant(created.placementId, created.tenantId);
    await emitPlacementUpdated(created);
    // §7 derive-on-create: stamp the tenant → placing (and property) coarse
    // statuses. Best-effort — a derived write failure must NEVER fail the 201.
    try {
      await transitions.deriveForStage(created.tenantId, created.unitId, created.stage);
    } catch (err) {
      log.error({ err, placementId: created.placementId }, 'derive-on-convert failed (best-effort)');
    }
    const finalTour = await tours.get(tour.tourId);
    log.info({ placementId: created.placementId, tourId: tour.tourId }, 'tour converted to placement');
    const ds = await placementDeadlines.listByPlacement(created.placementId);
    res.status(201).json({ placement: withDeadline(created, soonestDeadline(ds)), tour: finalTour });
  });

  // GET /api/placements/:placementId — one placement.
  router.get('/:placementId', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    // Attach the COMPUTED soonest deadline (its own placementDeadlines items).
    const ds = await placementDeadlines.listByPlacement(placementId);
    res.json({ placement: withDeadline(item, soonestDeadline(ds)) });
  });

  // GET /api/placements/:placementId/roster - the People card payload
  // (contact-rosters Task 5). The placement twin of the tour endpoint: the SAME
  // shared serializer (lib/rosterResolution.describeRoster), so both hubs render
  // one roster model. 404 unknown placement.
  //
  // PII (doc section 9): the RESPONSE carries names + phone last4 to the authed
  // client; the LOG line carries ids and counts only, and the full phone never
  // leaves the server.
  router.get('/:placementId/roster', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    // rosterDeps, NOT an inline subset: the deps carry the pendingRosterActions
    // repo, and a GET that omits it silently serves pending[]/skipped[] empty
    // (S6 regression - the card would only ever learn of deferrals from
    // mutation responses).
    const view = await describeRoster(rosterDeps, {
      type: 'placement',
      id: placementId,
      tenantId: item.tenantId,
      unitId: item.unitId,
      ...(typeof item.group_thread === 'string' && { groupThreadId: item.group_thread }),
      ...(item.roster !== undefined && { roster: item.roster }),
    });
    log.info(
      { placementId, source: view.source, memberCount: view.members.length },
      'placement roster served',
    );
    res.json(view);
  });

  // -------------------------------------------------------------------------
  // Roster EDITING (contact-rosters Task 10) - the placement twin of the tour
  // endpoints. Same engine (services/rosterEdits + services/relayMembers),
  // same tokens, same payload; only the pointer field (`group_thread`), the
  // repo and the 404 token differ. See routes/tours.ts for the full contract.
  // -------------------------------------------------------------------------

  const rosterDeps: RosterResolutionDeps = {
    conversations,
    units,
    contacts,
    // The seam that puts pending[]/skipped[] on every roster payload (Task 13).
    actions: rosterActions,
    // The OWNER-ROUTED intro's extra reads (Phase B spec 9.0): the previews must
    // show the same variant the intro job sends. `tours` rides along because
    // this factory holds it and a roster owner is typed 'tour' | 'placement'.
    tours,
    placements,
    settings: settingsRepo,
    log,
  };

  const memberDeps: RelayMemberDeps = {
    conversations,
    contacts,
    audit,
    activityEvents,
    poolNumbers,
    events,
    log,
  };

  function rosterOwnerOf(item: PlacementItem): RosterOwner {
    return {
      type: 'placement',
      id: item.placementId,
      tenantId: item.tenantId,
      unitId: item.unitId,
      ...(typeof item.group_thread === 'string' && { groupThreadId: item.group_thread }),
      ...(item.roster !== undefined && { roster: item.roster }),
    };
  }

  const planStateOf = (item: PlacementItem): RosterPlanState => ({
    ...(item.roster !== undefined && { roster: item.roster }),
    ...(item.rosterVersion !== undefined && { rosterVersion: item.rosterVersion }),
    // Carried so a lost MATERIALIZE can tell "someone else materialized first"
    // from "a relay group just opened" (the latter is 409 thread_exists).
    ...(typeof item.group_thread === 'string' && { groupThreadId: item.group_thread }),
  });

  const planStoreFor = (placementId: string): RosterPlanStore => ({
    reload: async () => {
      const fresh = await placements.getById(placementId);
      return fresh === undefined ? undefined : planStateOf(fresh);
    },
    setRoster: async (roster, expectedVersion) =>
      planStateOf(await placements.setRoster(placementId, roster, expectedVersion)),
    clearRoster: () => placements.clearRoster(placementId),
  });

  const threadIdOf = (item: PlacementItem): string | undefined =>
    typeof item.group_thread === 'string' && item.group_thread.length > 0
      ? item.group_thread
      : undefined;

  const sendRefusal = (res: Response, refusal: RosterEditRefusal): void => {
    res.status(refusal.status).json({
      error: refusal.error,
      ...(refusal.message !== undefined && { message: refusal.message }),
    });
  };

  /** Re-read + serialize - the 200 body of every mutating roster endpoint (202
   *  when the write was DEFERRED to quiet-end: same shape, different verdict). */
  async function respondWithRoster(res: Response, placementId: string, status = 200): Promise<void> {
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    const view = await describeRoster(rosterDeps, rosterOwnerOf(item));
    log.info(
      { placementId, source: view.source, memberCount: view.members.length },
      'placement roster edited',
    );
    res.status(status).json(view);
  }

  async function quietHoursState(): Promise<QuietHoursState> {
    return {
      nowIso: getNow(),
      window: await readQuietHoursWindow(settingsRepo, log),
    };
  }

  /** Everything the shared open (services/rosterProvision) touches. */
  const provisionDeps: OpenPlacementGroupDeps = {
    placements,
    placementDeadlines,
    conversations,
    contacts,
    units,
    audit,
    activityEvents,
    poolNumbers,
    events,
    log,
  };

  /** The deferral engine's deps - the SAME apply the poller runs (apply-now). */
  const actionDeps: PlacementRosterActionDeps = {
    ...provisionDeps,
    actions: rosterActions,
    // The kill-switch the deferred open is pre-checked against (MF1): with it
    // off, provisioning refuses from inside the open - too late to be visible.
    relayLiveProvisioning: config.relayLiveProvisioning,
    logger: log,
  };

  /** The dialog's explicit override: apply now despite quiet hours. */
  const isForceSendNow = (req: { query: Record<string, unknown> }): boolean =>
    String(req.query['force'] ?? '') === 'send_now';

  /**
   * Retire a pending action a HUMAN just performed by hand. `claimApply` is the
   * honest transition (it happened, just now and by a person) and it refuses
   * terminal rows, so a missing/resolved row is a benign false. Best-effort.
   */
  async function retirePendingAction(actionId: string): Promise<void> {
    try {
      await rosterActions.claimApply(actionId, getNow());
    } catch (err) {
      log.error({ err, actionId }, 'placement roster: retiring the superseded pending action failed');
    }
  }

  // --- PLAN writes (no thread) ---------------------------------------------

  router.post('/:placementId/roster/members', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    if (threadIdOf(item) !== undefined) {
      sendRefusal(res, ROSTER_THREAD_EXISTS);
      return;
    }
    const entry = parseRosterEntryInput(req.body);
    if ('error' in entry) {
      res.status(400).json({ error: 'invalid_member', message: entry.error });
      return;
    }
    const outcome = await applyRosterPlanEdit(rosterDeps, planStoreFor(placementId), {
      owner: {
        type: 'placement',
        id: item.placementId,
        tenantId: item.tenantId,
        unitId: item.unitId,
      },
      state: planStateOf(item),
      edit: { kind: 'add', entry },
      notFoundError: 'placement_not_found',
    });
    if (!outcome.ok) {
      sendRefusal(res, outcome.refusal);
      return;
    }
    await respondWithRoster(res, placementId);
  });

  router.delete('/:placementId/roster/members/:memberKey', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    if (threadIdOf(item) !== undefined) {
      sendRefusal(res, ROSTER_THREAD_EXISTS);
      return;
    }
    const outcome = await applyRosterPlanEdit(rosterDeps, planStoreFor(placementId), {
      owner: {
        type: 'placement',
        id: item.placementId,
        tenantId: item.tenantId,
        unitId: item.unitId,
      },
      state: planStateOf(item),
      edit: { kind: 'remove', memberKey: String(req.params['memberKey'] ?? '') },
      notFoundError: 'placement_not_found',
    });
    if (!outcome.ok) {
      sendRefusal(res, outcome.refusal);
      return;
    }
    await respondWithRoster(res, placementId);
  });

  router.post('/:placementId/roster/reset', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    if (threadIdOf(item) !== undefined) {
      sendRefusal(res, ROSTER_THREAD_EXISTS);
      return;
    }
    // clearRoster is conditional on the placement still existing, so one deleted
    // between the read above and this write throws instead of returning. Every
    // sibling path answers 404 for a gone placement - a 500 would be the odd one
    // out. Only a genuinely-missing placement is converted; anything else still
    // propagates.
    try {
      await placements.clearRoster(placementId);
    } catch (err) {
      if (!(await placements.getById(placementId))) {
        res.status(404).json({ error: 'placement_not_found' });
        return;
      }
      throw err;
    }
    await respondWithRoster(res, placementId);
  });

  // --- LIVE call-through (a thread exists, any status) ---------------------

  router.post('/:placementId/roster/live-members', async (req: AuthedRequest, res) => {
    const actor = req.user?.userId;
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    const threadId = threadIdOf(item);
    if (threadId === undefined) {
      sendRefusal(res, ROSTER_NO_THREAD);
      return;
    }
    const resolvedCandidate = await resolveRosterCandidate(contacts, req.body);
    if (!resolvedCandidate.ok) {
      sendRefusal(res, resolvedCandidate.refusal);
      return;
    }
    const conversation = await conversations.getById(threadId);
    if (!conversation) {
      sendRefusal(res, ROSTER_UNAVAILABLE);
      return;
    }
    // Spec section 7: a CLOSED thread's add is silent AND immediate - and
    // therefore never deferred (nobody is there to be announced to at 8 AM).
    const announce = conversation.status !== 'closed';

    // QUIET-HOURS DEFERRAL (D7): membership defers WITH the message.
    // `?force=send_now` is the dialog's "Send now anyway".
    if (announce && !isForceSendNow(req)) {
      const quiet = await quietHoursState();
      if (isQuietTime(quiet.nowIso, quiet.window)) {
        const dueAt = clampOutOfQuietHours(quiet.nowIso, quiet.window);
        await rosterActions.upsertPending({
          ownerType: 'placement',
          ownerId: placementId,
          action: 'add_member',
          contactId: resolvedCandidate.candidate.contactId,
          dueAt,
          createdAt: quiet.nowIso,
        });
        log.info({ placementId, dueAt }, 'placement roster add deferred to quiet-end (pending roster action)');
        await respondWithRoster(res, placementId, 202);
        return;
      }
    }

    const result = await addMemberToRelay(
      memberDeps,
      threadId,
      {
        contactId: resolvedCandidate.candidate.contactId,
        phone: resolvedCandidate.candidate.phone,
      },
      { announce, ...(actor !== undefined && { actor }) },
    );
    if (!result.ok) {
      sendRefusal(res, result.refusal);
      return;
    }
    // The human did it by hand - retire any pending add for the same person.
    await retirePendingAction(
      rosterActionIdFor({
        ownerType: 'placement',
        ownerId: placementId,
        action: 'add_member',
        contactId: resolvedCandidate.candidate.contactId,
      }),
    );
    await respondWithRoster(res, placementId);
  });

  router.delete('/:placementId/roster/live-members/:memberKey', async (req: AuthedRequest, res) => {
    const actor = req.user?.userId;
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    const threadId = threadIdOf(item);
    if (threadId === undefined) {
      sendRefusal(res, ROSTER_NO_THREAD);
      return;
    }
    const result = await removeMemberFromRelay(
      memberDeps,
      threadId,
      String(req.params['memberKey'] ?? ''),
      // refuseLastMember: the roster floor holds on live threads too (spec:
      // "a thread's participants never go empty") - the card disables the
      // last row's remove, this is the server backstop.
      { refuseLastMember: true, ...(actor !== undefined && { actor }) },
    );
    if (!result.ok) {
      sendRefusal(res, result.refusal);
      return;
    }
    await respondWithRoster(res, placementId);
  });

  // --- Previews ------------------------------------------------------------

  router.get('/:placementId/roster/preview-open', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    if (threadIdOf(item) !== undefined) {
      sendRefusal(res, { status: 409, error: 'relay_already_provisioned' });
      return;
    }
    const preview = await buildOpenPreview(
      rosterDeps,
      rosterOwnerOf(item),
      await quietHoursState(),
      (phones) => findOpenGroupWithSamePhones({ conversations, log }, phones),
    );
    if (!preview.ok) {
      sendRefusal(res, preview.refusal);
      return;
    }
    res.json(preview.preview);
  });

  router.post('/:placementId/roster/preview-add', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    if (threadIdOf(item) === undefined) {
      sendRefusal(res, ROSTER_NO_THREAD);
      return;
    }
    const resolvedCandidate = await resolveRosterCandidate(contacts, req.body);
    if (!resolvedCandidate.ok) {
      sendRefusal(res, resolvedCandidate.refusal);
      return;
    }
    const preview = await buildAddPreview(
      rosterDeps,
      rosterOwnerOf(item),
      resolvedCandidate.candidate,
      await quietHoursState(),
    );
    if (!preview.ok) {
      sendRefusal(res, preview.refusal);
      return;
    }
    res.json(preview.preview);
  });

  // PATCH /api/placements/:placementId — partial update (SET-merge; null clears a field).
  router.patch('/:placementId', async (req: AuthedRequest, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const validation = validatePlacementUpdate(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    // Load the BEFORE state so we can detect real transitions (a stage actually
    // changing, a tour_date newly set, a tour gaining an outcome) — milestones
    // are emitted only for genuine changes, never on a no-op write.
    const before: PlacementItem | undefined = await placements.getById(placementId);
    // In-place stage-data guard (Approval & Move-in): these fields are recordable
    // WITHOUT a stage move, but only while the placement sits at the stage they
    // belong to (mirrors the tour exit-gate's toured-only 409). Value shape was
    // validated above; here we reject a right-shaped value written at the wrong
    // stage. An absent `before` falls through to the update's 404.
    if (before !== undefined) {
      const STAGE_SCOPED: Record<string, PlacementStage> = {
        inspection_date: 'schedule_inspection',
        inspection_outcome: 'awaiting_inspection',
        rent_determined: 'determine_rent',
      };
      for (const [field, requiredStage] of Object.entries(STAGE_SCOPED)) {
        if (validation.fields[field] !== undefined && before.stage !== requiredStage) {
          res.status(409).json({
            error: 'illegal_stage_data',
            detail: `${field} can only be recorded while the placement is at ${STAGE_LABELS[requiredStage]} (current: ${STAGE_LABELS[before.stage]})`,
          });
          return;
        }
      }
    }
    let item;
    try {
      item = await placements.update(placementId, validation.fields);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'placement_not_found' });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
    await audit.append(`placements#${placementId}`, 'placement_updated', {
      actor: req.user?.userId,
      fields: Object.keys(validation.fields),
      ...(typeof validation.fields['stage'] === 'string' && { stage: validation.fields['stage'] }),
    });

    // BE2/C2 milestones — only on a REAL transition (before vs. after). All
    // best-effort (recordPlacementMilestone swallows + logs); they never block
    // the PATCH response.
    if (before !== undefined) {
      const tenantId = item.tenantId;
      // Stage change → placement_closed (terminal: moved_in/lost, label incl.
      // lost_reason on lost) else stage_changed.
      if (item.stage !== before.stage) {
        if (TERMINAL_STAGES.has(item.stage)) {
          // lost_reason is the structured { category, text } object (§7).
          // CATEGORY-ONLY discipline (same as the event wire): fold ONLY the
          // category into the milestone label — never the free text, which is
          // PII and must not be materialized into a stored label. When only free
          // text exists (no category), use a static "reason on file" marker.
          const lr = item.stage === 'lost' ? item.lost_reason : undefined;
          const reasonText =
            lr && typeof lr === 'object'
              ? (typeof lr.category === 'string' && lr.category.length > 0
                  ? lr.category
                  : typeof lr.text === 'string' && lr.text.length > 0
                    ? 'reason on file'
                    : '')
              : '';
          const reason = reasonText.length > 0 ? ` - ${reasonText}` : '';
          await recordPlacementMilestone(
            tenantId,
            'placement_closed',
            `Placement closed - ${stageLabel(item.stage)}${reason}`,
            placementId,
            item.unitId,
          );
        } else {
          await recordPlacementMilestone(tenantId, 'stage_changed', `Stage → ${stageLabel(item.stage)}`, placementId, item.unitId);
        }
      }
      // tour_date NEWLY set (absent/changed → a value) → tour_scheduled.
      if (
        typeof item.tour_date === 'string' &&
        item.tour_date.length > 0 &&
        item.tour_date !== before.tour_date
      ) {
        await recordPlacementMilestone(tenantId, 'tour_scheduled', `Tour scheduled - ${item.tour_date}`, placementId, item.unitId);
      }
      // NOTE: tour_took_place milestone was derived from placement.tours[], which
      // is retired. When re-implemented against the first-class tours API,
      // restore this milestone from a tour-status change event.
    }

    await emitPlacementUpdated(item);
    log.info(
      { placementId, fields: Object.keys(validation.fields).length, actor: req.user?.userId },
      'placement updated via api',
    );
    const ds = await placementDeadlines.listByPlacement(placementId);
    res.json({ placement: withDeadline(item, soonestDeadline(ds)) });
  });

  // POST /api/placements/:placementId/deadline — arm/clear a MANUAL `follow_up`
  // deadline (a first-class placementDeadlines item). System-managed
  // rta_window/voucher_expiration are off-limits here (validateDeadline gates to
  // follow_up only). { clear: true } retires the follow_up.
  router.post('/:placementId/deadline', async (req: AuthedRequest, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const validation = validateDeadline(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    // 404 an unknown placement (parity with the old setNextDeadline conditional).
    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    if (validation.fields === null) {
      await placementDeadlines.retire(placementId, 'follow_up');
    } else {
      await placementDeadlines.arm(placementId, 'follow_up', validation.fields.at);
    }
    await audit.append(`placements#${placementId}`, validation.fields === null ? 'placement_deadline_cleared' : 'placement_deadline_set', {
      actor: req.user?.userId,
      ...(validation.fields !== null && { deadlineType: validation.fields.type }),
    });
    const ds = await placementDeadlines.listByPlacement(placementId);
    const soonest = soonestDeadline(ds);
    events.emit('placement.updated', toPlacementUpdatedEvent(item, soonest));
    log.info(
      { placementId, deadlineType: validation.fields?.type ?? null, actor: req.user?.userId },
      validation.fields === null ? 'placement deadline cleared via api' : 'placement deadline set via api',
    );
    res.json({ placement: withDeadline(item, soonest) });
  });

  // POST /api/placements/:placementId/relay - set up the placement's masked
  // relay thread. The explicit operator "Set up relay thread" action (Phase 1 is
  // hand-touched parity - no auto-trigger). The FLOW ITSELF lives in
  // services/rosterProvision.ts (openPlacementGroup) because the quiet-hours
  // poller applies a DEFERRED open through the very same sequence - resolve the
  // roster at apply time, provision, link, consume the plan, pin the milestone.
  // Idempotent: 409 relay_exists when an OPEN/CONNECTING relay already fronts
  // the placement, so a double-click never buys a second pool number.
  //
  // QUIET HOURS (spec D7, Task 13): inside the org window the open is DEFERRED -
  // a pendingRosterActions row due at quiet-end, and 202 carrying the roster
  // payload (whose pending[] drives the card's "Opens at 8:00 AM" banner).
  // `?force=send_now` is the dialog's override and provisions immediately.
  //
  // Returns: 201 { conversation, placement } | 202 <RosterView> (deferred)
  router.post('/:placementId/relay', async (req: AuthedRequest, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const actor = req.user?.userId;

    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }

    // THE GUARDS RUN FIRST - BEFORE the quiet-hours evaluation, exactly as the
    // tours twin does (routes/tours.ts: tourOpenGuard, then the deferral).
    // Deferring first would answer 202 "Opens at 8:00 AM" to a click that is not
    // allowed AT ALL: a terminal placement would get a pending row instead of
    // 409 placement_not_active, and a placement whose relay is ALREADY OPEN
    // would get a banner about a group that exists (and, because upsertPending
    // is an unconditional Put, would resurrect a previously-resolved row).
    // Both are pure reads, so running them first costs nothing.
    const terminal = placementOpenGuard(item);
    if (terminal !== undefined) {
      res.status(terminal.status).json(terminal.body);
      return;
    }
    if (typeof item.group_thread === 'string' && item.group_thread.length > 0) {
      const existing = await conversations.getById(item.group_thread);
      if (
        existing &&
        existing.type === 'relay_group' &&
        (existing.status === 'open' || existing.status === 'connecting')
      ) {
        res.status(409).json({ error: 'relay_exists', conversation: existing });
        return;
      }
    }
    // openPlacementGroup re-applies both below - one definition, checked twice.

    // QUIET-HOURS DEFERRAL (D7) - membership and message defer together.
    if (!isForceSendNow(req)) {
      const quiet = await quietHoursState();
      if (isQuietTime(quiet.nowIso, quiet.window)) {
        // ...but only for a click that COULD be honored at quiet-end: the same
        // two pre-checks the poller runs before it claims (spec 6.2, tours
        // parity), answering the immediate path's exact refusal rather than a
        // 202 for work the server already knows it must refuse.
        const refusal = await placementOpenDeferralRefusal(
          provisionDeps,
          item,
          config.relayLiveProvisioning,
        );
        if (refusal !== undefined) {
          res.status(refusal.status).json(refusal.body);
          return;
        }
        const dueAt = clampOutOfQuietHours(quiet.nowIso, quiet.window);
        await rosterActions.upsertPending({
          ownerType: 'placement',
          ownerId: placementId,
          action: 'open_group',
          dueAt,
          createdAt: quiet.nowIso,
        });
        log.info({ placementId, dueAt }, 'placement relay open deferred to quiet-end (pending roster action)');
        await respondWithRoster(res, placementId, 202);
        return;
      }
    }

    // Operator-edited intro from the confirm dialog (2026-08-20). Absent on an
    // untouched preview, which keeps the composed default.
    const parsedIntro = parseIntroBody((req.body ?? {})['introBody']);
    if ('error' in parsedIntro) {
      res.status(400).json({ error: parsedIntro.error });
      return;
    }

    const result = await openPlacementGroup(provisionDeps, item, {
      ...(actor !== undefined && { actor }),
      ...(parsedIntro.body !== undefined && { introBody: parsedIntro.body }),
    });
    if (!result.ok) {
      res.status(result.refusal.status).json(result.refusal.body);
      return;
    }
    // An immediate open RETIRES any pending open for this owner (the operator
    // just did it) so it cannot fire again at 8 AM.
    await retirePendingAction(
      rosterActionIdFor({ ownerType: 'placement', ownerId: placementId, action: 'open_group' }),
    );
    res.status(201).json({ conversation: result.conversation, placement: result.placement });
  });

  // --- Pending roster actions (quiet-hours deferrals, Task 13) -------------
  //
  //   POST /:placementId/roster/pending/:actionId/cancel     pending -> canceled
  //   POST /:placementId/roster/pending/:actionId/apply-now  apply it RIGHT NOW
  //   POST /:placementId/roster/pending/:actionId/dismiss    terminal -> gone
  //
  // The tour mirrors, verbatim (see routes/tours.ts): same tokens, same
  // ownership rule (the deterministic actionId embeds its owner), and all three
  // answer with the SAME roster payload every other endpoint serves.

  /** Load + own-check one action row, or refuse (404). */
  async function loadOwnedAction(
    res: Response,
    placementId: string,
    actionId: string,
  ): Promise<Awaited<ReturnType<PendingRosterActionsRepo['getById']>> | undefined> {
    const row = await rosterActions.getById(actionId);
    if (!row || row.ownerType !== 'placement' || row.ownerId !== placementId) {
      res.status(404).json({ error: 'pending_action_not_found' });
      return undefined;
    }
    return row;
  }

  router.post('/:placementId/roster/pending/:actionId/cancel', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    if (!(await placements.getById(placementId))) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    const row = await loadOwnedAction(res, placementId, String(req.params['actionId'] ?? ''));
    if (row === undefined) return;
    if (!(await rosterActions.cancel(row.actionId, getNow()))) {
      res.status(409).json({ error: 'action_not_pending' });
      return;
    }
    log.info({ placementId, actionId: row.actionId }, 'pending roster action canceled by operator');
    // Poke the hubs: this operator gets the fresh payload in the response, but
    // every OTHER open placement page is still showing "Opens at 8:00 AM" for a
    // row that is now a canceled notice (PL5). Cancel touches nothing else, so
    // this is the only signal there is.
    const canceledPlacement = await placements.getById(placementId);
    if (canceledPlacement) await emitPlacementUpdated(canceledPlacement);
    await respondWithRoster(res, placementId);
  });

  router.post('/:placementId/roster/pending/:actionId/apply-now', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    if (!(await placements.getById(placementId))) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    const row = await loadOwnedAction(res, placementId, String(req.params['actionId'] ?? ''));
    if (row === undefined) return;
    // The SAME apply the poller runs, claim-and-skip discipline included.
    const outcome = await applyPlacementRosterAction(row, getNow(), actionDeps);
    if (outcome.result === 'lost') {
      res.status(409).json({ error: 'action_not_pending' });
      return;
    }
    // 'waiting' = unreadable world, nothing claimed and nothing done (the tours
    // twin): an honest refusal rather than a 200 that reads as success.
    if (outcome.result === 'waiting') {
      sendRefusal(res, ROSTER_ACTION_NOT_READY);
      return;
    }
    log.info(
      { placementId, actionId: row.actionId, outcome: outcome.result },
      'pending roster action applied by operator',
    );
    await respondWithRoster(res, placementId);
  });

  router.post('/:placementId/roster/pending/:actionId/dismiss', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    if (!(await placements.getById(placementId))) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    const row = await loadOwnedAction(res, placementId, String(req.params['actionId'] ?? ''));
    if (row === undefined) return;
    // Dismiss is for a TERMINAL row's notice only (spec 6.5).
    if (!(await rosterActions.dismiss(row.actionId, getNow()))) {
      res.status(409).json({ error: 'action_not_dismissable' });
      return;
    }
    await respondWithRoster(res, placementId);
  });

  return router;
}
