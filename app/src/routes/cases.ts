// Cases CRUD + boards router (M1.10) — mounted under /api/cases, behind
// requireAuth via the /api mount (app.ts). VAs run the boards day-to-day, so NO
// admin gate (same posture as units/contacts).
//
//   GET   /api/cases?stage=&tenantId=&unitId=&tourDate=&deadlineType=&before=&limit=&cursor=
//                                       → { cases, nextCursor }
//   POST  /api/cases { tenantId, unitId, stage?, placement_tag? }   → 201 { case }
//   GET   /api/cases/:caseId            → { case } | 404
//   PATCH /api/cases/:caseId { partial} → { case } | 404
//   POST  /api/cases/:caseId/deadline { type, at } | { clear:true }  → { case } | 404
//
// A case is "one deal, tour-interest → move-in" (doc §5). This router owns the
// manual board lifecycle (Phase 1 is hand-touched parity — the operator sets
// the stage, schedules tours, sets deadlines); the relay-on-placement seam
// (POST /:caseId/relay) and the masked-call wiring come in M1.10c-d.
//
// Validation: a FIXED field allowlist (the H2-review fix — the route owns the
// stage/key allowlist; the repo trusts it). stage is allowlisted (a GSI
// partition key); the next_deadline composite key is REFUSED here and routed to
// /deadline (it must move both-or-neither — casesRepo.setNextDeadline).
//
// PII (doc §9): responses carry full case docs to the authenticated client;
// LOG LINES are caseId/stage/counts only — never the placement_tag (a name).
import { Router } from 'express';
import { mergeContext } from '../lib/context.js';
import { appEvents, toCaseUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  type CaseDeadline,
  type CasesPage,
  type CasesRepo,
  ConditionalCheckFailedException,
  createCasesRepo,
  isCaseDeadlineType,
  isCaseStage,
  type ListCasesOpts,
} from '../repos/casesRepo.js';

export interface CasesRouterDeps {
  logger?: Logger;
  casesRepo?: CasesRepo;
  auditRepo?: AuditRepo;
  events?: EventBus;
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
// base64url(JSON) of the Query/Scan LastEvaluatedKey. A case cursor is a small
// flat object of string key attributes (caseId + maybe a GSI key, up to 3 for
// the byNextDeadline composite). We validate the SHAPE (1..3 scalar keys), not
// exact keys, since it varies by which index produced it — a client-tampered
// cursor must never reach DynamoDB as a malformed key.
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

/** Validate POST /cases. tenantId + unitId required; stage/placement_tag optional. */
function validateCaseCreate(
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
  let stage = 'interested';
  if (b['stage'] !== undefined) {
    if (!isCaseStage(b['stage'])) {
      return { ok: false, error: `stage must be one of the case stages` };
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
 * Updatable fields and their validators. Immutable keys (caseId/tenantId/unitId)
 * and the managed group_thread/created_at are NOT here (a deal's parties don't
 * change — make a new case). The next_deadline composite key is refused below.
 * `null` clears a field (REMOVE in the repo) — the only way to clear tour_date
 * (a sparse key) or the attention flag.
 */
const STRING_FIELDS = ['placement_tag', 'lost_reason', 'lease_date', 'move_in_date', 'notes'] as const;
const OBJECT_FIELDS = ['application', 'rta'] as const;

/** Validate PATCH /cases/:caseId. Allowlist + per-field type checks. */
function validateCaseUpdate(body: unknown): Validation<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    if (key === 'next_deadline_type' || key === 'next_deadline_at') {
      return { ok: false, error: 'set the deadline via POST /cases/:caseId/deadline' };
    }
    if (key === 'stage') {
      if (!isCaseStage(value)) return { ok: false, error: 'stage must be one of the case stages' };
      fields['stage'] = value;
      continue;
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

/** Validate POST /cases/:caseId/deadline → a CaseDeadline or null (clear). */
function validateDeadline(body: unknown): Validation<CaseDeadline | null> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (b['clear'] === true) return { ok: true, fields: null };
  if (!isCaseDeadlineType(b['type'])) {
    return { ok: false, error: 'type must be one of the case deadline types (or send { clear: true })' };
  }
  const at = b['at'];
  if (typeof at !== 'string' || at.length === 0 || Number.isNaN(Date.parse(at))) {
    return { ok: false, error: 'at must be an ISO 8601 timestamp' };
  }
  // Canonicalize so the byNextDeadline range key sorts lexicographically.
  return { ok: true, fields: { type: b['type'], at: new Date(at).toISOString() } };
}

export function createCasesRouter(deps: CasesRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const cases = deps.casesRepo ?? createCasesRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;

  const router = Router();

  // GET /api/cases — the boards' read. Exactly one filter is honored, most-
  // specific first: deadlineType(+before) > tourDate > stage > tenantId >
  // unitId; with no filter, a paginated Scan (the "all cases" kanban fallback).
  // Each path is a single bounded Query (or the Scan), never an unbounded fan.
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
    const opts: ListCasesOpts = {
      limit,
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    };

    const stage = req.query['stage'];
    const tenantId = req.query['tenantId'];
    const unitId = req.query['unitId'];
    const tourDate = req.query['tourDate'];
    const deadlineType = req.query['deadlineType'];
    const before = req.query['before'];

    let page: CasesPage;
    if (typeof deadlineType === 'string' && deadlineType.length > 0) {
      if (!isCaseDeadlineType(deadlineType)) {
        res.status(400).json({ error: 'deadlineType must be a known case deadline type' });
        return;
      }
      // The "due by" bound feeds the byNextDeadline RANGE key, which sorts
      // LEXICOGRAPHICALLY — so it must be canonicalized to the SAME ISO 8601
      // shape the writes use (cases set next_deadline_at via new Date().toISOString()).
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
      page = await cases.listByNextDeadline(deadlineType, {
        ...opts,
        ...(beforeAt !== undefined && { beforeAt }),
      });
    } else if (typeof tourDate === 'string' && tourDate.length > 0) {
      if (!isValidYmd(tourDate)) {
        res.status(400).json({ error: 'tourDate must be a valid YYYY-MM-DD date' });
        return;
      }
      page = await cases.listByTourDate(tourDate, opts);
    } else if (typeof stage === 'string' && stage.length > 0) {
      if (!isCaseStage(stage)) {
        res.status(400).json({ error: 'stage must be a known case stage' });
        return;
      }
      page = await cases.listByStage(stage, opts);
    } else if (typeof tenantId === 'string' && tenantId.length > 0) {
      page = await cases.listByTenant(tenantId, opts);
    } else if (typeof unitId === 'string' && unitId.length > 0) {
      page = await cases.listByUnit(unitId, opts);
    } else {
      page = await cases.list(opts);
    }

    res.json({
      cases: page.items,
      nextCursor: page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  // POST /api/cases — open a case (one deal: this tenant on this unit).
  router.post('/', async (req: AuthedRequest, res) => {
    const validation = validateCaseCreate(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const created = await cases.create({
      tenantId: validation.fields.tenantId,
      unitId: validation.fields.unitId,
      stage: validation.fields.stage as Parameters<CasesRepo['create']>[0]['stage'],
      ...(validation.fields.placement_tag !== undefined && {
        placement_tag: validation.fields.placement_tag,
      }),
    });
    mergeContext({ caseId: created.caseId });
    await audit.append(`cases#${created.caseId}`, 'case_created', {
      actor: req.user?.userId,
      tenantId: created.tenantId,
      unitId: created.unitId,
      stage: created.stage,
    });
    events.emit('case.updated', toCaseUpdatedEvent(created));
    log.info(
      { caseId: created.caseId, stage: created.stage, actor: req.user?.userId },
      'case created via api',
    );
    res.status(201).json({ case: created });
  });

  // GET /api/cases/:caseId — one case.
  router.get('/:caseId', async (req, res) => {
    const caseId = String(req.params['caseId'] ?? '');
    mergeContext({ caseId });
    const item = await cases.getById(caseId);
    if (!item) {
      res.status(404).json({ error: 'case_not_found' });
      return;
    }
    res.json({ case: item });
  });

  // PATCH /api/cases/:caseId — partial update (SET-merge; null clears a field).
  router.patch('/:caseId', async (req: AuthedRequest, res) => {
    const caseId = String(req.params['caseId'] ?? '');
    mergeContext({ caseId });
    const validation = validateCaseUpdate(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    let item;
    try {
      item = await cases.update(caseId, validation.fields);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'case_not_found' });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
    await audit.append(`cases#${caseId}`, 'case_updated', {
      actor: req.user?.userId,
      fields: Object.keys(validation.fields),
      ...(typeof validation.fields['stage'] === 'string' && { stage: validation.fields['stage'] }),
    });
    events.emit('case.updated', toCaseUpdatedEvent(item));
    log.info(
      { caseId, fields: Object.keys(validation.fields).length, actor: req.user?.userId },
      'case updated via api',
    );
    res.json({ case: item });
  });

  // POST /api/cases/:caseId/deadline — set/clear the next business-clock
  // deadline (the byNextDeadline composite key; both-or-neither via the repo).
  router.post('/:caseId/deadline', async (req: AuthedRequest, res) => {
    const caseId = String(req.params['caseId'] ?? '');
    mergeContext({ caseId });
    const validation = validateDeadline(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    let item;
    try {
      item = await cases.setNextDeadline(caseId, validation.fields);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'case_not_found' });
        return;
      }
      throw err;
    }
    await audit.append(`cases#${caseId}`, validation.fields === null ? 'case_deadline_cleared' : 'case_deadline_set', {
      actor: req.user?.userId,
      ...(validation.fields !== null && { deadlineType: validation.fields.type }),
    });
    events.emit('case.updated', toCaseUpdatedEvent(item));
    log.info(
      { caseId, deadlineType: validation.fields?.type ?? null, actor: req.user?.userId },
      validation.fields === null ? 'case deadline cleared via api' : 'case deadline set via api',
    );
    res.json({ case: item });
  });

  return router;
}
