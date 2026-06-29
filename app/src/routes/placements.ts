// Placements CRUD + boards router (M1.10) — mounted under /api/placements,
// behind requireAuth via the /api mount (app.ts). VAs run the boards day-to-day,
// so NO admin gate (same posture as units/contacts).
//
//   GET   /api/placements?stage=&tenantId=&unitId=&tourDate=&deadlineType=&before=&limit=&cursor=
//                                       → { placements, nextCursor }
//   POST  /api/placements { tenantId, unitId, stage?, placement_tag? }   → 201 { placement }
//   GET   /api/placements/:placementId            → { placement } | 404
//   PATCH /api/placements/:placementId { partial} → { placement } | 404
//   POST  /api/placements/:placementId/deadline { type, at } | { clear:true }  → { placement } | 404
//
// A placement is "one deal, tour-interest → move-in" (doc §5). This router owns
// the manual board lifecycle (Phase 1 is hand-touched parity — the operator sets
// the stage, schedules tours, sets deadlines); the relay-on-placement seam
// (POST /:placementId/relay) and the masked-call wiring come in M1.10c-d.
//
// Validation: a FIXED field allowlist (the H2-review fix — the route owns the
// stage/key allowlist; the repo trusts it). stage is allowlisted (a GSI
// partition key); the next_deadline composite key is REFUSED here and routed to
// /deadline (it must move both-or-neither — placementsRepo.setNextDeadline).
//
// PII (doc §9): responses carry full placement docs to the authenticated client;
// LOG LINES are placementId/stage/counts only — never the placement_tag (a name).
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
  type PlacementDeadline,
  type PlacementsPage,
  type PlacementsRepo,
  ConditionalCheckFailedException,
  createPlacementsRepo,
  isPlacementDeadlineType,
  type ListPlacementsOpts,
} from '../repos/placementsRepo.js';
import {
  createConversationsRepo,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
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
  type PlacementTour,
} from '../repos/placementsRepo.js';
import { isPlacementStage, STAGE_LABELS } from '../lib/statusModel.js';

export interface PlacementsRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  placementsRepo?: PlacementsRepo;
  auditRepo?: AuditRepo;
  events?: EventBus;
  /** M1.10c relay-on-placement — the placement-scoped "Set up relay thread" action. */
  conversationsRepo?: ConversationsRepo;
  unitsRepo?: UnitsRepo;
  contactsRepo?: ContactsRepo;
  poolNumbersService?: PoolNumbersService;
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

/**
 * Count tours that carry a (non-empty) outcome. A tour gaining an outcome
 * (count increases) is the `tour_took_place` signal.
 */
function outcomeTourCount(tours: PlacementTour[] | undefined): number {
  if (!Array.isArray(tours)) return 0;
  return tours.filter((t) => typeof t?.outcome === 'string' && t.outcome.length > 0).length;
}

/** The newest tour outcome (for the tour_took_place label), or undefined. */
function latestTourOutcome(tours: PlacementTour[] | undefined): string | undefined {
  if (!Array.isArray(tours)) return undefined;
  for (let i = tours.length - 1; i >= 0; i--) {
    const o = tours[i]?.outcome;
    if (typeof o === 'string' && o.length > 0) return o;
  }
  return undefined;
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
// small flat object of string key attributes (placementId + maybe a GSI key, up
// to 3 for the byNextDeadline composite). We validate the SHAPE (1..3 scalar
// keys), not exact keys, since it varies by which index produced it — a
// client-tampered cursor must never reach DynamoDB as a malformed key.
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

/** Validate POST /placements/:placementId/deadline → a PlacementDeadline or null (clear). */
function validateDeadline(body: unknown): Validation<PlacementDeadline | null> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (b['clear'] === true) return { ok: true, fields: null };
  if (!isPlacementDeadlineType(b['type'])) {
    return { ok: false, error: 'type must be one of the placement deadline types (or send { clear: true })' };
  }
  const at = b['at'];
  if (typeof at !== 'string' || at.length === 0 || Number.isNaN(Date.parse(at))) {
    return { ok: false, error: 'at must be an ISO 8601 timestamp' };
  }
  // Canonicalize so the byNextDeadline range key sorts lexicographically.
  return { ok: true, fields: { type: b['type'], at: new Date(at).toISOString() } };
}

export function createPlacementsRouter(deps: PlacementsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const activityEvents =
    deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const poolNumbers =
    deps.poolNumbersService ?? createPoolNumbersService({ config, logger: deps.logger });
  // §7 derive-on-create: the transition service's derive helpers stamp the
  // tenant + property coarse statuses on create (override-gated, source 'derived').
  // Self-construct from the SAME repos this router already builds when not injected.
  const transitions =
    deps.statusTransitionService ??
    createStatusTransitionService({
      placementsRepo: placements,
      unitsRepo: units,
      contactsRepo: contacts,
      auditRepo: audit,
      events,
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });

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
  // specific first: deadlineType(+before) > tourDate > stage > tenantId >
  // unitId; with no filter, a paginated Scan (the "all placements" kanban
  // fallback). Each path is a single bounded Query (or the Scan), never an
  // unbounded fan.
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
    const deadlineType = req.query['deadlineType'];
    const before = req.query['before'];

    let page: PlacementsPage;
    if (typeof deadlineType === 'string' && deadlineType.length > 0) {
      if (!isPlacementDeadlineType(deadlineType)) {
        res.status(400).json({ error: 'deadlineType must be a known placement deadline type' });
        return;
      }
      // The "due by" bound feeds the byNextDeadline RANGE key, which sorts
      // LEXICOGRAPHICALLY — so it must be canonicalized to the SAME ISO 8601
      // shape the writes use (placements set next_deadline_at via new Date().toISOString()).
      // A bare-date or offset cutoff would otherwise mis-sort and silently drop
      // same-day deadlines. Validate + canonicalize; 400 on a bad value.
      let beforeAt: string | undefined;
      if (before !== undefined) {
        if (typeof before !== 'string' || before.length === 0 || Number.isNaN(Date.parse(before))) {
          res.status(400).json({ error: 'before must be an ISO 8601 timestamp' });
          return;
        }
        beforeAt = new Date(before).toISOString();
      }
      page = await placements.listByNextDeadline(deadlineType, {
        ...opts,
        ...(beforeAt !== undefined && { beforeAt }),
      });
    } else if (typeof tourDate === 'string' && tourDate.length > 0) {
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

    res.json({
      placements: page.items,
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
    events.emit('placement.updated', toPlacementUpdatedEvent(created));
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
    res.status(201).json({ placement: created });
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
    res.json({ placement: item });
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
      // A tour gained an OUTCOME (the count of outcome-bearing tours rose) →
      // tour_took_place (label incl. the new outcome).
      if (outcomeTourCount(item.tours) > outcomeTourCount(before.tours)) {
        const outcome = latestTourOutcome(item.tours);
        await recordPlacementMilestone(
          tenantId,
          'tour_took_place',
          outcome !== undefined ? `Tour took place · ${stageLabel(outcome)}` : 'Tour took place',
          placementId,
        );
      }
    }

    events.emit('placement.updated', toPlacementUpdatedEvent(item));
    log.info(
      { placementId, fields: Object.keys(validation.fields).length, actor: req.user?.userId },
      'placement updated via api',
    );
    res.json({ placement: item });
  });

  // POST /api/placements/:placementId/deadline — set/clear the next business-clock
  // deadline (the byNextDeadline composite key; both-or-neither via the repo).
  router.post('/:placementId/deadline', async (req: AuthedRequest, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const validation = validateDeadline(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    let item;
    try {
      item = await placements.setNextDeadline(placementId, validation.fields);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'placement_not_found' });
        return;
      }
      throw err;
    }
    await audit.append(`placements#${placementId}`, validation.fields === null ? 'placement_deadline_cleared' : 'placement_deadline_set', {
      actor: req.user?.userId,
      ...(validation.fields !== null && { deadlineType: validation.fields.type }),
    });
    events.emit('placement.updated', toPlacementUpdatedEvent(item));
    log.info(
      { placementId, deadlineType: validation.fields?.type ?? null, actor: req.user?.userId },
      validation.fields === null ? 'placement deadline cleared via api' : 'placement deadline set via api',
    );
    res.json({ placement: item });
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
    events.emit('placement.updated', toPlacementUpdatedEvent(updatedPlacement));
    log.info(
      { placementId, conversationId: conversation.conversationId, actor },
      'placement relay thread provisioned via api',
    );
    res.status(201).json({ conversation, placement: updatedPlacement });
  });

  return router;
}
