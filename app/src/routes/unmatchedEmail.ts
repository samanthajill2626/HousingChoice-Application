// /api/unmatched-email - the unknown-sender email triage surface (email-
// channel B3). Read + act on the side-door rows the inbound ingestion (B2)
// stores when mail matches no contact/thread or is quarantined by verdicts.
//
// AUTH: mounted under /api in api.ts, so every route sits behind
// sessionMiddleware + requireAuth exactly like its siblings - VAs triage the
// side-door, no admin gate.
//
// Wire contract (B6 hand-mirrors these in dashboard/src/api/types.ts):
//   GET  /                       ?filter=unmatched|quarantine&cursor&limit
//        -> { rows: UnmatchedEmailRow[], nextCursor: string|null, unreadCount }
//        List rows carry snippet + meta but NEVER text/html_sanitized
//        (payload-size adjudication) and never raw_ref (raw MIME pointers
//        stay server-side, plan F18).
//   GET  /:id                    -> { row } - the FULL row (text +
//        html_sanitized) for the expanded/detail view. Still no raw_ref.
//   POST /:id/read               -> { row }
//   POST /:id/link               { contactId } -> { conversationId }
//   POST /:id/create-contact     { name, type: tenant|landlord|partner }
//                                -> { conversationId, contactId }
//   POST /:id/spam               -> { row }  (blocklist sender + dismiss)
//   POST /:id/release            -> { row }  (quarantined -> unmatched only)
//   POST /:id/dismiss            -> { row }
//   Unknown/pointer ids -> 404 { error: 'unmatched_not_found' }.
//
// The link/create-contact RE-INGEST (B2's recipe): addEmail the sender to the
// contact FIRST, then ingestInboundEmail with the STORED raw_ref + verdicts
// and { reingest: true } (skips only the level-1 object marker; level-2 rfc
// dedupe still guards double-threading). Outcome 'threaded' flips the row to
// 'linked' and returns the conversationId for the UI redirect.
//
// Every successful mutation emits `unmatched_email.updated` { unmatchedId }
// (the event B2 registered; B6's badge + page refetch on it).
//
// PII (plan F18): addresses/subjects/bodies are response DATA for the authed
// client but NEVER appear in log lines - ids/statuses/outcomes only.
import { Router } from 'express';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { appEvents, type EventBus } from '../lib/events.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createMediaStore, createInboundMailRawStore, type MediaStore } from '../adapters/mediaStore.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import { createMessagesRepo, type MessagesRepo } from '../repos/messagesRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../repos/extractionRepo.js';
import {
  createUnmatchedEmailRepo,
  type UnmatchedEmailItem,
  type UnmatchedEmailRepo,
  type UnmatchedListFilter,
} from '../repos/unmatchedEmailRepo.js';
import {
  ingestInboundEmail,
  type IngestOptions,
  type IngestResult,
  type InboundEmailNotice,
} from '../services/inboundEmail.js';

/** Page-size bounds (the shared /api list convention). */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

const LIST_FILTERS: readonly UnmatchedListFilter[] = ['unmatched', 'quarantine'];

/** The create-contact types staff may mint from the triage page (plan B3). */
const CREATE_CONTACT_TYPES = ['tenant', 'landlord', 'partner'] as const;
type CreateContactType = (typeof CREATE_CONTACT_TYPES)[number];

export interface UnmatchedEmailRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Injected in tests (in-memory fake); defaults to the real repo. */
  unmatchedEmailRepo?: UnmatchedEmailRepo;
  contactsRepo?: Pick<
    ContactsRepo,
    'getById' | 'findByEmail' | 'addEmail' | 'create' | 'touchEmailLastSeen'
  >;
  auditRepo?: Pick<AuditRepo, 'append'>;
  events?: EventBus;
  /**
   * The link/create-contact re-ingest seam. The ROUTE always passes
   * { reingest: true }; tests inject a spy and assert exactly that. Defaults
   * to ingestInboundEmail over real deps - undefined (-> 503) when the
   * inbound-mail bucket is unconfigured, since the stored raw MIME is
   * unreachable then.
   */
  reingest?: (notice: InboundEmailNotice, opts: IngestOptions) => Promise<IngestResult>;
  /** Deps for the DEFAULT reingest construction (unused when it is injected). */
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  extractionRepo?: ExtractionRepo;
  mediaStore?: MediaStore;
}

// --- Opaque cursor (the api.ts inbox convention) -----------------------------
// base64url(JSON) of the byStatus Query's LastEvaluatedKey. Clients echo it
// back via ?cursor=; it is never constructed by hand.

function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Decode + validate a cursor against the EXACT ExclusiveStartKey shape for
 * byStatus: { unmatchedId, status, received_at }, all strings, nothing else.
 * Anything off-shape is a 400 upstream - a tampered cursor must never reach
 * DynamoDB as a malformed key.
 */
function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const key = parsed as Record<string, unknown>;
      const expected = ['unmatchedId', 'status', 'received_at'];
      if (
        Object.keys(key).length === expected.length &&
        expected.every((field) => typeof key[field] === 'string')
      ) {
        return key;
      }
    }
  } catch {
    // fall through - malformed cursors are a 400, not a crash
  }
  return undefined;
}

/** Parse ?limit= into 1..MAX_PAGE_LIMIT (default). undefined => 400 upstream. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

// --- Wire serialization ------------------------------------------------------

/**
 * The LIST row: meta + snippet, deliberately WITHOUT the body fields
 * (text/html_sanitized - the /:id detail serves those) and WITHOUT raw_ref
 * (an internal S3 pointer; raw MIME is never served - plan F18).
 */
function toListRow(item: UnmatchedEmailItem): Record<string, unknown> {
  return {
    unmatchedId: item.unmatchedId,
    status: item.status,
    from: item.from,
    subject: item.subject,
    snippet: item.snippet,
    attachments_meta: item.attachments_meta,
    ...(item.spam_verdict !== undefined && { spam_verdict: item.spam_verdict }),
    ...(item.virus_verdict !== undefined && { virus_verdict: item.virus_verdict }),
    received_at: item.received_at,
    read: item.read,
    ...(item.linked_contact_id !== undefined && { linked_contact_id: item.linked_contact_id }),
    ...(item.parse_skipped !== undefined && { parse_skipped: item.parse_skipped }),
  };
}

/** The DETAIL row: the list row + the full body fields (B6's expanded view). */
function toDetailRow(item: UnmatchedEmailItem): Record<string, unknown> {
  return {
    ...toListRow(item),
    text: item.text,
    ...(item.html_sanitized !== undefined && { html_sanitized: item.html_sanitized }),
  };
}

export function createUnmatchedEmailRouter(deps: UnmatchedEmailRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const repo = deps.unmatchedEmailRepo ?? createUnmatchedEmailRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;

  // Default re-ingest: the REAL ingestion service over real deps (B2's recipe).
  // The inbound raw store is undefined when INBOUND_MAIL_BUCKET is unset (e.g.
  // a local loop without the fake-SES stack) - the link routes then 503, since
  // the stored raw MIME cannot be re-read.
  let reingest = deps.reingest;
  if (reingest === undefined) {
    const rawStore = createInboundMailRawStore({ config });
    if (rawStore !== undefined) {
      const conversations =
        deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
      const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
      const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
      const mediaStore = deps.mediaStore ?? createMediaStore({ config });
      reingest = (notice, opts) =>
        ingestInboundEmail(
          notice,
          {
            config,
            ...(deps.logger !== undefined && { logger: deps.logger }),
            rawStore,
            unmatchedStore: repo,
            conversations,
            messages,
            contacts,
            extraction,
            events,
            ...(mediaStore !== undefined && { mediaStore }),
          },
          opts,
        );
    }
  }

  const router = Router();

  /** Load a real row or answer 404 (unknown ids and block# pointers alike). */
  const requireRow = async (
    req: AuthedRequest,
    res: Parameters<Parameters<Router['post']>[1]>[1],
  ): Promise<UnmatchedEmailItem | undefined> => {
    const unmatchedId = String(req.params['unmatchedId'] ?? '');
    const row = await repo.getById(unmatchedId);
    if (!row) {
      res.status(404).json({ error: 'unmatched_not_found' });
      return undefined;
    }
    return row;
  };

  // GET /api/unmatched-email?filter=unmatched|quarantine&cursor=&limit=
  // -> { rows, nextCursor, unreadCount }. unreadCount is the capped (100)
  // first-page count of unread UNMATCHED rows regardless of the active filter
  // (it feeds the nav badge).
  router.get('/', async (req, res) => {
    const rawFilter = req.query['filter'] ?? 'unmatched';
    if (typeof rawFilter !== 'string' || !(LIST_FILTERS as readonly string[]).includes(rawFilter)) {
      res.status(400).json({ error: `filter must be one of: ${LIST_FILTERS.join(', ')}` });
      return;
    }
    const filter = rawFilter as UnmatchedListFilter;
    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }
    const rawCursor = req.query['cursor'];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (typeof rawCursor === 'string' && rawCursor.length > 0) {
      exclusiveStartKey = decodeCursor(rawCursor);
      if (exclusiveStartKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }

    const [page, unreadCount] = await Promise.all([
      repo.listByStatus(filter, {
        limit,
        ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
      }),
      repo.unreadCount(),
    ]);
    res.json({
      rows: page.items.map(toListRow),
      nextCursor:
        page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
      unreadCount,
    });
  });

  // GET /api/unmatched-email/:unmatchedId -> { row } (the FULL row - text +
  // html_sanitized - for the expanded/detail view).
  router.get('/:unmatchedId', async (req: AuthedRequest, res) => {
    const row = await requireRow(req, res);
    if (!row) return;
    res.json({ row: toDetailRow(row) });
  });

  // POST /api/unmatched-email/:unmatchedId/read -> { row }
  router.post('/:unmatchedId/read', async (req: AuthedRequest, res) => {
    const unmatchedId = String(req.params['unmatchedId'] ?? '');
    const updated = await repo.markRead(unmatchedId);
    if (!updated) {
      res.status(404).json({ error: 'unmatched_not_found' });
      return;
    }
    events.emit('unmatched_email.updated', { unmatchedId });
    res.json({ row: toDetailRow(updated) });
  });

  /**
   * The shared link tail (link + create-contact): attach the sender address
   * to the contact (idempotent when already on it), re-ingest the stored raw
   * mail ({ reingest: true }), and on 'threaded' flip the row to 'linked'.
   * Responds on every path; returns the conversationId on success so callers
   * can shape their envelope.
   */
  const linkRowToContact = async (
    row: UnmatchedEmailItem,
    contactId: string,
    res: Parameters<Parameters<Router['post']>[1]>[1],
  ): Promise<string | undefined> => {
    if (reingest === undefined) {
      // No inbound raw store configured - the stored MIME is unreachable, so
      // a re-ingest cannot run (mirrors the mediaStore 503 posture).
      res.status(503).json({ error: 'email_ingest_unavailable' });
      return undefined;
    }
    try {
      await contacts.addEmail(contactId, { email: row.from.address });
    } catch (err) {
      // The repo's requireContact conditional: the contact vanished between
      // our existence check and the write.
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_not_found' });
        return undefined;
      }
      throw err;
    }

    const result = await reingest(
      {
        bucket: row.raw_ref.bucket,
        key: row.raw_ref.key,
        ...(row.spam_verdict !== undefined && { spamVerdict: row.spam_verdict }),
        ...(row.virus_verdict !== undefined && { virusVerdict: row.virus_verdict }),
      },
      { reingest: true },
    );

    if (result.outcome === 'threaded' && result.conversationId !== undefined) {
      await repo.setStatus(row.unmatchedId, 'linked', { linkedContactId: contactId });
      events.emit('unmatched_email.updated', { unmatchedId: row.unmatchedId });
      log.info(
        { unmatchedId: row.unmatchedId, contactId, conversationId: result.conversationId },
        'unmatched email linked to contact',
      );
      return result.conversationId;
    }
    if (result.outcome === 'duplicate') {
      // The mail already lives in a thread (level-2 rfc dedupe) - e.g. a
      // double-click on Link. The first link owns the status flip.
      log.info({ unmatchedId: row.unmatchedId }, 'unmatched email link: already threaded');
      res.status(409).json({ error: 'already_threaded' });
      return undefined;
    }
    // Should not happen: the address is on the contact now, so tier 6 must
    // thread. Log ids only (PII rule) and surface a 500 for investigation.
    log.error(
      { unmatchedId: row.unmatchedId, contactId, outcome: result.outcome },
      'unmatched email re-ingest did not thread',
    );
    res.status(500).json({ error: 'reingest_failed' });
    return undefined;
  };

  /**
   * Shared pre-flight for both link flows: the row must carry a sender
   * address (parse_skipped rows have none) and must not be virus-flagged (a
   * re-ingest would only mint a duplicate quarantine row - tier 2 wins).
   */
  const linkPreflight = (
    row: UnmatchedEmailItem,
    res: Parameters<Parameters<Router['post']>[1]>[1],
  ): boolean => {
    if (row.from.address === '') {
      res.status(400).json({ error: 'no_sender_address' });
      return false;
    }
    if (row.virus_verdict === 'FAIL') {
      res.status(409).json({ error: 'virus_flagged' });
      return false;
    }
    return true;
  };

  // POST /api/unmatched-email/:unmatchedId/link { contactId }
  // -> { conversationId } (the UI redirect target).
  router.post('/:unmatchedId/link', async (req: AuthedRequest, res) => {
    const row = await requireRow(req, res);
    if (!row) return;
    const payload = (req.body ?? {}) as { contactId?: unknown };
    if (typeof payload.contactId !== 'string' || payload.contactId.length === 0) {
      res.status(400).json({ error: 'contactId is required' });
      return;
    }
    const contactId = payload.contactId;
    if (!linkPreflight(row, res)) return;

    const contact = await contacts.getById(contactId);
    // Pointer items (phone_ref/email_ref) are internal routing records, never
    // link targets (the contacts-route guard, mirrored).
    if (!contact || contact.phone_ref === true || contact.email_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    // Cross-contact conflict guard (the A1 email-CRUD pattern): owned by
    // ANOTHER contact -> 409 with the owner; owned by THIS contact -> fine
    // (addEmail is an idempotent no-op then).
    const owner = await contacts.findByEmail(row.from.address);
    if (owner && owner.contactId !== contactId) {
      res.status(409).json({ error: 'email_in_use', contact: owner });
      return;
    }

    const conversationId = await linkRowToContact(row, contactId, res);
    if (conversationId === undefined) return;
    res.json({ conversationId });
  });

  // POST /api/unmatched-email/:unmatchedId/create-contact { name, type }
  // -> { conversationId, contactId }. Creates the typed contact WITH the
  // sender address (the manual-create mirror: split name, type-scoped status
  // default, contact_created audit), then the same link tail.
  router.post('/:unmatchedId/create-contact', async (req: AuthedRequest, res) => {
    const row = await requireRow(req, res);
    if (!row) return;
    const payload = (req.body ?? {}) as { name?: unknown; type?: unknown };
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (name.length === 0) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (
      typeof payload.type !== 'string' ||
      !(CREATE_CONTACT_TYPES as readonly string[]).includes(payload.type)
    ) {
      res.status(400).json({ error: `type must be one of: ${CREATE_CONTACT_TYPES.join(', ')}` });
      return;
    }
    const type = payload.type as CreateContactType;
    if (!linkPreflight(row, res)) return;

    // No orphan contacts: refuse BEFORE creating when the address is already
    // owned (any owner - there is no "same contact" yet).
    const owner = await contacts.findByEmail(row.from.address);
    if (owner) {
      res.status(409).json({ error: 'email_in_use', contact: owner });
      return;
    }

    // "First Last" split (the KindPicker/manual-create convention: first
    // token -> firstName, remainder -> lastName) + the type-scoped status
    // default the manual-create route applies (tenant -> onboarding,
    // landlord -> interested, else active).
    const [firstName = '', ...rest] = name.split(/\s+/);
    const lastName = rest.join(' ');
    const status = type === 'tenant' ? 'onboarding' : type === 'landlord' ? 'interested' : 'active';
    const contact = await contacts.create({
      type,
      firstName,
      ...(lastName.length > 0 && { lastName }),
      email: row.from.address,
      status,
    } as Partial<ContactItem> & { type: CreateContactType });
    await audit.append(`contacts#${contact.contactId}`, 'contact_created', {
      actor: (req as AuthedRequest).user?.userId,
      type: contact.type,
      source: 'unmatched_email',
    });
    log.info(
      { contactId: contact.contactId, type: contact.type, unmatchedId: row.unmatchedId },
      'contact created from unmatched email',
    );

    const conversationId = await linkRowToContact(row, contact.contactId, res);
    if (conversationId === undefined) return;
    res.json({ conversationId, contactId: contact.contactId });
  });

  // POST /api/unmatched-email/:unmatchedId/spam -> { row }. A human "never
  // again": blocklist the sender (B2 tier 3 consumes it) + dismiss the row
  // (F19 TTL). No-sender rows (parse_skipped) just dismiss - there is no
  // address to block.
  router.post('/:unmatchedId/spam', async (req: AuthedRequest, res) => {
    const row = await requireRow(req, res);
    if (!row) return;
    if (row.from.address !== '') {
      await repo.putBlock(row.from.address);
    }
    const updated = await repo.setStatus(row.unmatchedId, 'dismissed');
    if (!updated) {
      res.status(404).json({ error: 'unmatched_not_found' });
      return;
    }
    events.emit('unmatched_email.updated', { unmatchedId: row.unmatchedId });
    log.info({ unmatchedId: row.unmatchedId }, 'unmatched email marked spam (sender blocklisted)');
    res.json({ row: toDetailRow(updated) });
  });

  // POST /api/unmatched-email/:unmatchedId/release -> { row }. The ONE
  // state-checked transition: quarantined -> unmatched (clears the TTL - the
  // row awaits action again).
  router.post('/:unmatchedId/release', async (req: AuthedRequest, res) => {
    const row = await requireRow(req, res);
    if (!row) return;
    if (row.status !== 'quarantined') {
      res.status(409).json({ error: 'not_quarantined' });
      return;
    }
    const updated = await repo.setStatus(row.unmatchedId, 'unmatched');
    if (!updated) {
      res.status(404).json({ error: 'unmatched_not_found' });
      return;
    }
    events.emit('unmatched_email.updated', { unmatchedId: row.unmatchedId });
    log.info({ unmatchedId: row.unmatchedId }, 'unmatched email released from quarantine');
    res.json({ row: toDetailRow(updated) });
  });

  // POST /api/unmatched-email/:unmatchedId/dismiss -> { row } (F19 TTL).
  router.post('/:unmatchedId/dismiss', async (req: AuthedRequest, res) => {
    const row = await requireRow(req, res);
    if (!row) return;
    const updated = await repo.setStatus(row.unmatchedId, 'dismissed');
    if (!updated) {
      res.status(404).json({ error: 'unmatched_not_found' });
      return;
    }
    events.emit('unmatched_email.updated', { unmatchedId: row.unmatchedId });
    log.info({ unmatchedId: row.unmatchedId }, 'unmatched email dismissed');
    res.json({ row: toDetailRow(updated) });
  });

  return router;
}
