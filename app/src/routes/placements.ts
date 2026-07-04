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
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { mergeContext } from '../lib/context.js';
import { appEvents, toPlacementUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { VoiceCapabilityError } from '../adapters/messaging.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { provisionRelayGroup } from '../services/relayProvisioning.js';
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
import {
  createConversationsRepo,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import { createToursRepo, type ToursRepo } from '../repos/toursRepo.js';
import { createTourRemindersRepo, type TourRemindersRepo } from '../repos/tourRemindersRepo.js';
import { cancelTourReminders } from '../jobs/tourReminders.js';
import {
  createPoolNumbersService,
  RelayProvisioningDisabledError,
  type PoolNumbersService,
} from '../services/poolNumbers.js';
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
import { isPlacementStage, STAGE_LABELS } from '../lib/statusModel.js';

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
  /** BE2/C2: emit placement_opened/placement_closed/stage_changed/tour_* milestones. */
  activityEventsRepo?: ActivityEventsRepo;
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

  // BE2/C2: record one placement milestone against the tenant contact.
  // Best-effort — a log failure must NEVER fail the operator's board action (the
  // placement is already persisted); follows the neighbors' try/catch+log
  // convention.
  async function recordPlacementMilestone(
    tenantId: string,
    type: 'placement_opened' | 'placement_closed' | 'stage_changed' | 'tour_scheduled' | 'tour_took_place',
    label: string,
    placementId: string,
  ): Promise<void> {
    if (typeof tenantId !== 'string' || tenantId.length === 0) return;
    try {
      await activityEvents.record({ contactId: tenantId, type, label, refType: 'placement', refId: placementId });
    } catch (err) {
      log.error({ err, placementId, type }, 'placement milestone record failed (best-effort)');
    }
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
    // BE2/C2: a new placement is a "placement opened" milestone on the tenant's timeline.
    await recordPlacementMilestone(created.tenantId, 'placement_opened', 'Placement opened', created.placementId);
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
  // finalizes the tour (closed + convertedPlacementId + reminders canceled) and
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
    //   2. claimConversion(sentinel)                — CCFE → 409 (race loser).
    //   3. cancelTourReminders                      — fail → release + rethrow.
    //   4. placements.create                        — fail → release + rethrow.
    //   5. finalize patch (replace sentinel w/ id)  — fail → release + LOUD log.
    //   6. best-effort tail (rebind/audit/…)        — never fails the 201.
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

    // The tour is now CLAIMED (convertedPlacementId = sentinel). Cancel reminders
    // BEFORE creating/finalizing: canceling reminders on a still-unconverted tour
    // is benign retry residue, but a live reminder firing on a CONVERTED tour
    // would not be — so cancel must precede finalize. Fail → release + rethrow.
    try {
      await cancelTourReminders(tour.tourId, { tourRemindersRepo: reminders, logger: log });
    } catch (err) {
      await tours.releaseConversionClaim(tour.tourId, sentinel);
      throw err;
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
    try {
      await tours.patch(tour.tourId, { status: 'closed', convertedPlacementId: created.placementId });
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
        { err, tourId: tour.tourId, orphanPlacementId: created.placementId },
        'convert: FINALIZE FAILED after placement created — ORPHAN placement (findable via fromTourId)',
      );
      throw err;
    }

    // Re-parent the masked relay thread (metadata-only; pool + members preserved).
    if (typeof tour.groupThreadId === 'string') {
      try {
        await conversations.rebindOwner(tour.groupThreadId, { type: 'placement', id: created.placementId });
      } catch (err) {
        log.error({ err, placementId: created.placementId }, 'convert: thread rebind failed (best-effort)');
      }
    }

    await audit.append(`placements#${created.placementId}`, 'placement_created', {
      actor: req.user?.userId,
      tenantId: created.tenantId,
      unitId: created.unitId,
      stage: created.stage,
      fromTourId: tour.tourId,
    });
    await recordPlacementMilestone(created.tenantId, 'placement_opened', 'Placement opened', created.placementId);
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
          const reason = reasonText.length > 0 ? ` · ${reasonText}` : '';
          await recordPlacementMilestone(
            tenantId,
            'placement_closed',
            `Placement closed · ${stageLabel(item.stage)}${reason}`,
            placementId,
          );
        } else {
          await recordPlacementMilestone(tenantId, 'stage_changed', `Stage → ${stageLabel(item.stage)}`, placementId);
        }
      }
      // tour_date NEWLY set (absent/changed → a value) → tour_scheduled.
      if (
        typeof item.tour_date === 'string' &&
        item.tour_date.length > 0 &&
        item.tour_date !== before.tour_date
      ) {
        await recordPlacementMilestone(tenantId, 'tour_scheduled', `Tour scheduled · ${item.tour_date}`, placementId);
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

  // POST /api/placements/:placementId/relay — set up the placement's masked relay
  // thread. The explicit operator "Set up relay thread" action (Phase 1 is
  // hand-touched parity — no auto-trigger). The roster is derived FROM the
  // placement: the tenant + the unit's landlord, by their SMS numbers (the
  // masked-CALL landlord leg resolves unit.primary_voice_contact at call time,
  // M1.10d). Reuses the shared provisioning primitive and links
  // placement.group_thread ↔ conversation.placementId. Idempotent: refuses (409)
  // if the placement already has an OPEN relay so a double-click never buys a
  // second pool number.
  router.post('/:placementId/relay', async (req: AuthedRequest, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const actor = req.user?.userId;

    const item = await placements.getById(placementId);
    if (!item) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    // Idempotency: an OPEN relay already fronts this placement → never double-provision.
    if (typeof item.group_thread === 'string' && item.group_thread.length > 0) {
      const existing = await conversations.getById(item.group_thread);
      if (existing && existing.type === 'relay_group' && existing.status === 'open') {
        res.status(409).json({ error: 'relay_exists', conversation: existing });
        return;
      }
    }

    // Resolve the roster from the placement: tenant + the unit's landlord side.
    // Both need an SMS number to be in the relay (texts fan out to these). A
    // missing party/phone is a 400 — never provision a half-roster relay.
    const tenant = await contacts.getById(item.tenantId);
    if (!tenant || typeof tenant.phone !== 'string' || tenant.phone.length === 0) {
      res.status(400).json({ error: 'tenant_unreachable', message: 'the placement tenant has no phone on file' });
      return;
    }
    const unit = await units.getById(item.unitId);
    if (!unit) {
      res.status(400).json({ error: 'unit_not_found' });
      return;
    }
    const landlord = await contacts.getById(unit.landlordId);
    if (!landlord || typeof landlord.phone !== 'string' || landlord.phone.length === 0) {
      res.status(400).json({ error: 'landlord_unreachable', message: 'the unit landlord has no phone on file' });
      return;
    }

    const tenantName = nameFromContact(tenant);
    const landlordName = nameFromContact(landlord);
    const members: ConversationParticipant[] = [
      { phone: tenant.phone, contactId: item.tenantId, ...(tenantName !== undefined && { name: tenantName }) },
    ];
    // De-dupe if the landlord-side number is somehow the same phone as the tenant.
    if (landlord.phone !== tenant.phone) {
      members.push({
        phone: landlord.phone,
        contactId: unit.landlordId,
        ...(landlordName !== undefined && { name: landlordName }),
      });
    }

    const tag =
      typeof item.placement_tag === 'string' && item.placement_tag.length > 0
        ? item.placement_tag
        : undefined;

    let conversation;
    try {
      conversation = await provisionRelayGroup(
        { conversationsRepo: conversations, poolNumbersService: poolNumbers, auditRepo: audit, events, logger: log },
        { members, placementId, ...(tag !== undefined && { tag }), ...(actor !== undefined && { actor }) },
      );
    } catch (err) {
      // Kill-switch (M1.7): live provisioning is off pre-A2P — no number bought.
      if (err instanceof RelayProvisioningDisabledError) {
        log.warn({ err: { name: err.name }, placementId, actor }, 'placement relay: number provisioning disabled');
        await audit.append(`placements#${placementId}`, 'relay_provisioning_disabled', { actor, reason: 'placement' });
        res.status(503).json({ error: 'relay_provisioning_disabled', message: err.message });
        return;
      }
      if (err instanceof VoiceCapabilityError) {
        log.error({ err: { name: err.name }, placementId }, 'placement relay: no voice-capable pool number available');
        res.status(503).json({ error: 'pool_number_unavailable' });
        return;
      }
      throw err;
    }

    // Link the placement → its relay thread. The conversation already carries
    // placementId (the back-reference, set at createRelayGroup); a link-write
    // failure is logged, not fatal (the conversation.placementId back-ref still
    // resolves it).
    let updatedPlacement = item;
    try {
      updatedPlacement = await placements.update(placementId, { group_thread: conversation.conversationId });
    } catch (err) {
      log.error(
        { err, placementId, conversationId: conversation.conversationId },
        'placement relay: linking group_thread failed — relay created',
      );
    }
    await audit.append(`placements#${placementId}`, 'placement_relay_provisioned', {
      actor,
      conversationId: conversation.conversationId,
    });
    await emitPlacementUpdated(updatedPlacement);
    log.info(
      { placementId, conversationId: conversation.conversationId, actor },
      'placement relay thread provisioned via api',
    );
    res.status(201).json({ conversation, placement: updatedPlacement });
  });

  return router;
}
