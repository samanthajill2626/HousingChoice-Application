// The caseworker-review routes (caseworkers spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D22; plan 3.5), registered on the contacts router BEFORE its
// /:contactId handlers (createContactsRouter calls this right after
// GET /vocabulary), so the literal `possible-caseworkers` segment is never
// captured as a contact id.
//
//   GET  /api/contacts/possible-caseworkers                  -> { rows }
//   GET  /api/contacts/:contactId/caseworker-review/preview  -> CaseworkerPreview
//   POST /api/contacts/:contactId/caseworker-review
//        { action: 'make', organization? }                   -> { contact }
//        { action: 'dismiss' }                               -> { contact }
//
// Open to every signed-in user (D19), as the edit form's type change is.
// Errors are `{ error: code, ...extras }`; the dashboard owns every sentence.
import type { Response, Router } from 'express';
import { mergeContext } from '../lib/context.js';
import type { Logger } from '../lib/logger.js';
import type { AuthedRequest } from '../middleware/auth.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
import {
  CaseworkerReviewError,
  type CaseworkerConversionService,
} from '../services/caseworkerConversion.js';
import { listPossibleCaseworkers } from '../services/possibleCaseworkers.js';

export interface CaseworkerRoutesDeps {
  contacts: ContactsRepo;
  conversion: CaseworkerConversionService;
  logger: Logger;
}

type ReviewBody = { action: 'make'; organization?: string } | { action: 'dismiss' };

/** Strict: only `action` (+ `organization` for make); anything else is invalid_body. */
function parseReviewBody(body: unknown): ReviewBody | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (b['action'] === 'dismiss') {
    return keys.every((k) => k === 'action') ? { action: 'dismiss' } : undefined;
  }
  if (b['action'] !== 'make') return undefined;
  if (!keys.every((k) => k === 'action' || k === 'organization')) return undefined;
  if (!('organization' in b)) return { action: 'make' };
  const organization = b['organization'];
  return typeof organization === 'string' ? { action: 'make', organization } : undefined;
}

/** A CaseworkerReviewError becomes its status + `{ error, ...extras }`; anything else rethrows (500). */
function sendReviewError(res: Response, err: unknown): void {
  if (!(err instanceof CaseworkerReviewError)) throw err;
  res.status(err.status).json({ error: err.code, ...err.extras });
}

export function registerCaseworkerRoutes(router: Router, deps: CaseworkerRoutesDeps): void {
  const log = deps.logger;

  router.get('/possible-caseworkers', async (_req, res) => {
    const rows = await listPossibleCaseworkers({ contacts: deps.contacts });
    res.json({ rows });
  });

  router.get('/:contactId/caseworker-review/preview', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    try {
      res.json(await deps.conversion.preview(contactId));
    } catch (err) {
      sendReviewError(res, err);
    }
  });

  router.post('/:contactId/caseworker-review', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const body = parseReviewBody(req.body);
    if (body === undefined) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    // The actor is the session userId - the audit's `actor` and
    // caseworker_conversion.by (plan 3.2: a userId, never an email).
    const actor = req.user?.userId ?? 'unknown';
    try {
      const contact = body.action === 'make'
        ? await deps.conversion.make(contactId, {
            actor,
            ...(body.organization !== undefined && { organization: body.organization }),
          })
        : await deps.conversion.dismiss(contactId, actor);
      log.info({ contactId, action: body.action, actor }, 'caseworker review applied');
      res.json({ contact });
    } catch (err) {
      sendReviewError(res, err);
    }
  });
}
