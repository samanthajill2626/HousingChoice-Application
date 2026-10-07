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
//   POST   /not-on-list/resolve  ADMIN { field, value, action, name?, agencyName?, rememberSpelling? }
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
import type { OrgKind } from '../lib/orgNames.js';
import type { AuthedRequest } from '../middleware/auth.js';
import type { OrgRecordField } from '../repos/orgListRepo.js';
import { asOrgHttpError, createOrgNamesService, type OrgNamesService } from '../services/orgNames.js';
import { createOrgRecordsService, type OrgRecordsService } from '../services/orgRecords.js';
import type { OrgRewriteService } from '../services/orgRewrite.js';

/** Plan 3.4b: the instances under these keys; each defaults to a fresh real one. */
export interface OrganizationsRouterDeps {
  logger?: Logger;
  orgNamesService?: OrgNamesService;
  orgRecordsService?: OrgRecordsService;
  orgRewriteService?: OrgRewriteService;
}

const KINDS: readonly OrgKind[] = ['housing_authority', 'agency'];
const RECORD_FIELDS: readonly OrgRecordField[] = ['housingAuthority', 'agency', 'accepted_authorities'];
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
        res.status(400).json({ error: 'field must be housingAuthority, agency or accepted_authorities' });
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

  return router;
}
