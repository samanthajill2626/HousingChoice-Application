// /api/organizations - the housing authority and agency lists (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// section 6, D10-D13; plan sections 3.4b, 3.5, 3.6). Mounted by
// createApiRouter, so every route sits behind csrfOrigin -> session ->
// requireAuth.
//
//   GET    /                                   -> { version, entries, lastRewrite? }
//   GET    /usage                              -> { usage }
//   GET    /not-on-list                        -> { rows }
//   GET    /not-on-list/records?field=&value=  -> { records }
//   POST   /check  { kind, text, spellingFor? }  -> OrgCheckResult (text <= 200 chars, else 400)
//   POST   /       { kind, name, notes? }        -> 201 { entry }
//   PATCH  /:orgId { notes }                     -> { entry }
//          ADMIN   { spellings, confirmShared? } -> { entry }
//          ADMIN   { name }                      -> 202 { entry, lastRewrite, skippedSpellings }
//          ADMIN   { kind }                      -> { entry }
//          exactly ONE of the four keys (400 one_change_per_request)
//   POST   /:orgId/merge         ADMIN { intoOrgId } -> 202 { lastRewrite }
//   DELETE /:orgId               ADMIN               -> 204
//   POST   /not-on-list/resolve  ADMIN { field, value, action, name?, agencyName?, rememberSpelling?, kind? }
//                                                    -> 202 { lastRewrite, skippedSpellings }
//   POST   /rewrite/run-again    ADMIN               -> 202 { lastRewrite }
//
// Viewing, adding an entry and editing notes are open to every signed-in
// user; everything marked ADMIN is enforced HERE (requireRole('admin'), or the
// inline role check on the mixed PATCH) - a hidden dashboard button is not
// authorization. Org refusals are `{ error: code, ...extras }` (plan 3.5);
// body-shape 400s carry a human message, as the other routers' do. The
// services log; this router logs nothing of its own.
import { Router, type Response } from 'express';
import type { Logger } from '../lib/logger.js';
import type { OrgEntry, OrgKind } from '../lib/orgNames.js';
import { requireRole, type AuthedRequest } from '../middleware/auth.js';
import type { OrgRecordField } from '../repos/orgListRepo.js';
import {
  asOrgHttpError,
  createOrgNamesService,
  OrgHttpError,
  type OrgNamesService,
} from '../services/orgNames.js';
import { createOrgRecordsService, type OrgRecordsService } from '../services/orgRecords.js';
import { createOrgRewriteService, type OrgRewriteService } from '../services/orgRewrite.js';

/** Plan 3.4b: the instances under these keys; each defaults to a fresh real one. */
export interface OrganizationsRouterDeps {
  logger?: Logger;
  orgNamesService?: OrgNamesService;
  orgRecordsService?: OrgRecordsService;
  orgRewriteService?: OrgRewriteService;
}

const KINDS: readonly OrgKind[] = ['housing_authority', 'agency'];
/** PATCH /:orgId takes exactly ONE of these per request (plan 3.6). */
const PATCH_KEYS = ['notes', 'spellings', 'name', 'kind'] as const;
const RESOLVE_ACTIONS = ['use', 'move_to_agency', 'move_to_housing_authority', 'split', 'add', 'clear'] as const;
type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

function isResolveAction(value: unknown): value is ResolveAction {
  return typeof value === 'string' && (RESOLVE_ACTIONS as readonly string[]).includes(value);
}
const RECORD_FIELDS: readonly OrgRecordField[] = ['housingAuthority', 'agency', 'accepted_authorities', 'organization'];
/** POST /check refuses a longer text with 400 (spec section 6). */
const ORG_CHECK_TEXT_MAX = 200;

function isKind(value: unknown): value is OrgKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function isRecordField(value: unknown): value is OrgRecordField {
  return typeof value === 'string' && (RECORD_FIELDS as readonly string[]).includes(value);
}

/** The JSON body as a plain object, or undefined. */
function bodyOf(req: AuthedRequest): Record<string, unknown> | undefined {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

type Handler = (req: AuthedRequest, res: Response) => Promise<void>;

/** Answer an org refusal (plan 3.5) with its status and body; anything else goes on to the app's error handler. */
function handle(fn: Handler): Handler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const refusal = asOrgHttpError(err);
      if (refusal === undefined) throw err;
      res.status(refusal.status).json(refusal.body);
    }
  };
}

export function createOrganizationsRouter(deps: OrganizationsRouterDeps = {}): Router {
  const orgNames = deps.orgNamesService ?? createOrgNamesService({ logger: deps.logger });
  const orgRecords = deps.orgRecordsService ?? createOrgRecordsService({ logger: deps.logger });
  const orgRewrite = deps.orgRewriteService ?? createOrgRewriteService({ logger: deps.logger });

  /** The acting user - requireAuth (mounted upstream) guarantees one. */
  const actorOf = (req: AuthedRequest): string => req.user?.userId ?? 'unknown';

  async function entryOr404(orgId: string): Promise<OrgEntry> {
    const entry = (await orgNames.read()).entries.find((e) => e.orgId === orgId);
    if (entry === undefined) throw new OrgHttpError(404, { error: 'org_not_found' });
    return entry;
  }

  /**
   * 409 org_in_use while a record - deleted ones included (D10) - holds the
   * entry's name. 'delete': DISTINCT records in any field, a contact's
   * organization included; 'kind': DISTINCT records in a field of the entry's
   * kind - an organization holder stays valid under either kind, so it never
   * blocks a kind change (spec D17; R2-F1). OrgNamesService has no record
   * access (plan 3.4b), so the delete and kind-change routes ask here first
   * (plan 3.5). The count and the list write are two steps: a record written
   * in between can end up holding the removed name - it then shows in "Not on
   * the list" (the accepted race, plan watch items).
   */
  async function refuseWhileUsed(entry: OrgEntry, mode: 'delete' | 'kind'): Promise<void> {
    const u = (await orgRecords.usage([entry]))[entry.orgId];
    const total = mode === 'delete' ? u?.inUse : u?.kindLocked;
    const uses = { active: total?.active ?? 0, deleted: total?.deleted ?? 0 };
    if (uses.active + uses.deleted > 0) throw new OrgHttpError(409, { error: 'org_in_use', uses });
  }

  const router = Router();

  router.get(
    '/',
    handle(async (_req, res) => {
      const item = await orgNames.read();
      res.json({
        version: item.version,
        entries: item.entries,
        ...(item.lastRewrite !== undefined && { lastRewrite: item.lastRewrite }),
      });
    }),
  );

  router.get(
    '/usage',
    handle(async (_req, res) => {
      const { entries } = await orgNames.read();
      res.json({ usage: await orgRecords.usage(entries) });
    }),
  );

  router.get(
    '/not-on-list',
    handle(async (_req, res) => {
      const { entries } = await orgNames.read();
      res.json({ rows: await orgRecords.notOnList(entries) });
    }),
  );

  router.get(
    '/not-on-list/records',
    handle(async (req, res) => {
      const field = req.query['field'];
      const value = req.query['value'];
      if (!isRecordField(field)) {
        res.status(400).json({ error: 'field must be housingAuthority, agency, accepted_authorities or organization' });
        return;
      }
      if (typeof value !== 'string' || value === '') {
        res.status(400).json({ error: 'value is required' });
        return;
      }
      res.json({ records: await orgRecords.holders(field, value) });
    }),
  );

  router.post(
    '/check',
    handle(async (req, res) => {
      const body = bodyOf(req) ?? {};
      const kind = body['kind'];
      const text = body['text'];
      const spellingFor = body['spellingFor'];
      if (!isKind(kind)) {
        res.status(400).json({ error: 'kind must be housing_authority or agency' });
        return;
      }
      if (typeof text !== 'string') {
        res.status(400).json({ error: 'text must be a string' });
        return;
      }
      // Spec section 6: no name or spelling exceeds 120 characters, and every
      // check scores close names against the whole list - an unbounded text
      // (express.json takes up to 100 KB) never reaches it.
      if (text.length > ORG_CHECK_TEXT_MAX) {
        res.status(400).json({ error: `text must be at most ${ORG_CHECK_TEXT_MAX} characters` });
        return;
      }
      if (spellingFor !== undefined && typeof spellingFor !== 'string') {
        res.status(400).json({ error: 'spellingFor must be an entry id' });
        return;
      }
      res.json(await orgNames.check({ kind, text, ...(spellingFor !== undefined && { spellingFor }) }));
    }),
  );

  router.post(
    '/',
    handle(async (req, res) => {
      const body = bodyOf(req) ?? {};
      const kind = body['kind'];
      const name = body['name'];
      const notes = body['notes'];
      if (!isKind(kind)) {
        res.status(400).json({ error: 'kind must be housing_authority or agency' });
        return;
      }
      if (typeof name !== 'string') {
        res.status(400).json({ error: 'name must be a string' });
        return;
      }
      if (notes !== undefined && typeof notes !== 'string') {
        res.status(400).json({ error: 'notes must be a string' });
        return;
      }
      const entry = await orgNames.add({ kind, name, ...(notes !== undefined && { notes }), actor: actorOf(req) });
      res.status(201).json({ entry });
    }),
  );

  router.patch(
    '/:orgId',
    handle(async (req, res) => {
      const orgId = String(req.params['orgId'] ?? '');
      const body = bodyOf(req) ?? {};
      const present = PATCH_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
      const [key] = present;
      if (key === undefined || present.length !== 1) {
        res.status(400).json({ error: 'one_change_per_request' });
        return;
      }
      // Notes are everyone's; spellings, name and kind are admin-only (spec
      // D10). The one route that mixes both, so the role check is inline - the
      // same 403 body requireRole answers.
      if (key !== 'notes' && req.user?.role !== 'admin') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const actor = actorOf(req);
      switch (key) {
        case 'notes': {
          const notes = body['notes'];
          if (typeof notes !== 'string') {
            res.status(400).json({ error: 'notes must be a string' });
            return;
          }
          res.json({ entry: await orgNames.updateNotes(orgId, notes, actor) });
          return;
        }
        case 'spellings': {
          const spellings = body['spellings'];
          const confirmShared = body['confirmShared'];
          if (!Array.isArray(spellings) || !spellings.every((s): s is string => typeof s === 'string')) {
            res.status(400).json({ error: 'spellings must be a list of strings' });
            return;
          }
          if (confirmShared !== undefined && typeof confirmShared !== 'boolean') {
            res.status(400).json({ error: 'confirmShared must be true or false' });
            return;
          }
          const entry = await orgNames.updateSpellings(orgId, spellings, { confirmShared: confirmShared === true, actor });
          res.json({ entry });
          return;
        }
        case 'name': {
          const name = body['name'];
          if (typeof name !== 'string') {
            res.status(400).json({ error: 'name must be a string' });
            return;
          }
          // A rename starts a rewrite (D11): 202 with the running (or, when the
          // job could not be queued, failed) lastRewrite.
          res.status(202).json(await orgRewrite.rename(orgId, name, actor));
          return;
        }
        case 'kind': {
          const kind = body['kind'];
          if (!isKind(kind)) {
            res.status(400).json({ error: 'kind must be housing_authority or agency' });
            return;
          }
          const entry = await entryOr404(orgId);
          if (entry.kind !== kind) await refuseWhileUsed(entry, 'kind');
          res.json({ entry: await orgNames.changeKind(orgId, kind, actor) });
          return;
        }
      }
    }),
  );

  router.delete(
    '/:orgId',
    requireRole('admin'),
    handle(async (req, res) => {
      const orgId = String(req.params['orgId'] ?? '');
      await refuseWhileUsed(await entryOr404(orgId), 'delete');
      await orgNames.remove(orgId, actorOf(req));
      res.status(204).end();
    }),
  );

  router.post(
    '/:orgId/merge',
    requireRole('admin'),
    handle(async (req, res) => {
      const orgId = String(req.params['orgId'] ?? '');
      const intoOrgId = bodyOf(req)?.['intoOrgId'];
      if (typeof intoOrgId !== 'string' || intoOrgId === '') {
        res.status(400).json({ error: 'intoOrgId is required' });
        return;
      }
      res.status(202).json(await orgRewrite.merge(orgId, intoOrgId, actorOf(req)));
    }),
  );

  router.post(
    '/not-on-list/resolve',
    requireRole('admin'),
    handle(async (req, res) => {
      const body = bodyOf(req) ?? {};
      const field = body['field'];
      const value = body['value'];
      const action = body['action'];
      const name = body['name'];
      const agencyName = body['agencyName'];
      const rememberSpelling = body['rememberSpelling'];
      const kind = body['kind'];
      if (!isRecordField(field)) {
        res.status(400).json({ error: 'field must be housingAuthority, agency, accepted_authorities or organization' });
        return;
      }
      if (typeof value !== 'string' || value === '') {
        res.status(400).json({ error: 'value is required' });
        return;
      }
      if (!isResolveAction(action)) {
        res.status(400).json({ error: 'action must be use, move_to_agency, move_to_housing_authority, split, add or clear' });
        return;
      }
      if ((name !== undefined && typeof name !== 'string') || (agencyName !== undefined && typeof agencyName !== 'string')) {
        res.status(400).json({ error: 'name and agencyName must be strings' });
        return;
      }
      if (rememberSpelling !== undefined && typeof rememberSpelling !== 'boolean') {
        res.status(400).json({ error: 'rememberSpelling must be true or false' });
        return;
      }
      if (kind !== undefined && !isKind(kind)) {
        res.status(400).json({ error: 'kind must be housing_authority or agency' });
        return;
      }
      res.status(202).json(
        await orgRewrite.resolveNotOnList({
          field,
          value,
          action,
          ...(name !== undefined && { name }),
          ...(agencyName !== undefined && { agencyName }),
          ...(rememberSpelling !== undefined && { rememberSpelling }),
          ...(kind !== undefined && { kind }),
          actor: actorOf(req),
        }),
      );
    }),
  );

  router.post(
    '/rewrite/run-again',
    requireRole('admin'),
    handle(async (req, res) => {
      res.status(202).json(await orgRewrite.runAgain(actorOf(req)));
    }),
  );

  return router;
}
