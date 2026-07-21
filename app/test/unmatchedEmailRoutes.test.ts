// Email-channel B3 route tests - /api/unmatched-email (the unknown-sender
// triage surface). In-memory fakes + supertest with the router mounted
// directly and req.user stamped (the research 9b convention; requireAuth
// itself lives on the /api mount in app.ts and is covered there).
//
// Covered: the list envelope { rows, nextCursor, unreadCount } (rows carry
// snippet + meta but NEVER text/html_sanitized - payload adjudication), the
// /:id detail (full row), cursor round-trip + tamper 400, read, the link flow
// (happy + same-contact idempotent + email-owned-elsewhere 409 + re-ingest
// spy asserting the {reingest:true} option + non-threaded outcomes + virus
// guard + no-sender 400), create-contact (validation + dedupe + create
// shape), spam (blocklist + dismiss), release (state-checked), dismiss,
// 404 unmatched_not_found everywhere, and the unmatched_email.updated SSE
// emit after every mutation.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { AuthedRequest } from '../src/middleware/auth.js';
import { createEventBus } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import type {
  IngestResult,
  InboundEmailNotice,
  NewUnmatchedEmail,
} from '../src/services/inboundEmail.js';
import {
  UNMATCHED_EMAIL_TTL_SECONDS,
  type ListUnmatchedOpts,
  type UnmatchedEmailItem,
  type UnmatchedEmailRepo,
  type UnmatchedStatus,
} from '../src/repos/unmatchedEmailRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createUnmatchedEmailRouter } from '../src/routes/unmatchedEmail.js';
import { createLogCapture } from './helpers/logCapture.js';

// ---------------------------------------------------------------------------
// In-memory fakes (working mirrors of the repo semantics the routes lean on)
// ---------------------------------------------------------------------------

interface MemoryUnmatchedRepo extends UnmatchedEmailRepo {
  rows: UnmatchedEmailItem[];
  blocks: Set<string>;
}

function createMemoryUnmatchedRepo(): MemoryUnmatchedRepo {
  const rows: UnmatchedEmailItem[] = [];
  const blocks = new Set<string>();
  let seq = 0;
  const ttlFor = (status: UnmatchedStatus): number | undefined =>
    status === 'unmatched'
      ? undefined
      : Math.floor(Date.now() / 1000) + UNMATCHED_EMAIL_TTL_SECONDS;
  return {
    rows,
    blocks,
    async putUnmatched(row: NewUnmatchedEmail) {
      const unmatchedId = `um-${++seq}`;
      const expiresAt = ttlFor(row.status);
      rows.push({
        ...row,
        unmatchedId,
        read: false,
        ...(expiresAt !== undefined && { expires_at: expiresAt }),
      });
      return { unmatchedId };
    },
    async isBlocked(address: string) {
      return blocks.has(address);
    },
    async getById(unmatchedId: string) {
      return rows.find((r) => r.unmatchedId === unmatchedId);
    },
    async listByStatus(filter, opts: ListUnmatchedOpts = {}) {
      const status = filter === 'quarantine' ? 'quarantined' : 'unmatched';
      const sorted = rows
        .filter((r) => r.status === status)
        .sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
      const startAfter = opts.exclusiveStartKey?.['unmatchedId'];
      const startIdx =
        typeof startAfter === 'string'
          ? sorted.findIndex((r) => r.unmatchedId === startAfter) + 1
          : 0;
      const limit = opts.limit ?? 50;
      const items = sorted.slice(startIdx, startIdx + limit);
      const last = items[items.length - 1];
      const more = startIdx + limit < sorted.length;
      return {
        items,
        ...(more && last !== undefined
          ? {
              lastEvaluatedKey: {
                unmatchedId: last.unmatchedId,
                status: last.status,
                received_at: last.received_at,
              },
            }
          : {}),
      };
    },
    async markRead(unmatchedId: string) {
      const row = rows.find((r) => r.unmatchedId === unmatchedId);
      if (!row) return undefined;
      row.read = true;
      return row;
    },
    async setStatus(unmatchedId, status, opts = {}) {
      const row = rows.find((r) => r.unmatchedId === unmatchedId);
      if (!row) return undefined;
      row.status = status;
      const expiresAt = ttlFor(status);
      if (expiresAt !== undefined) row.expires_at = expiresAt;
      else delete row.expires_at;
      if (opts.linkedContactId !== undefined) row.linked_contact_id = opts.linkedContactId;
      return row;
    },
    async unreadCount() {
      return rows.filter((r) => r.status === 'unmatched' && r.read === false).length;
    },
    async putBlock(address: string) {
      blocks.add(address);
    },
    async removeBlock(address: string) {
      blocks.delete(address);
    },
  };
}

interface MemoryContacts {
  contacts: ContactItem[];
  getById(contactId: string): Promise<ContactItem | undefined>;
  findByEmail(email: string): Promise<ContactItem | undefined>;
  addEmail(contactId: string, opts: { email: string; label?: string }): Promise<ContactItem>;
  create(input: Partial<ContactItem> & { type: ContactItem['type'] }): Promise<ContactItem>;
  touchEmailLastSeen(contactId: string, email: string, atIso: string): Promise<void>;
}

function createMemoryContacts(seed: ContactItem[] = []): MemoryContacts {
  const contacts = [...seed];
  let seq = 0;
  const emailsOf = (c: ContactItem): string[] => [
    ...(typeof c.email === 'string' && c.email.length > 0 ? [c.email] : []),
    ...(Array.isArray(c.emails) ? c.emails.map((e) => e.email) : []),
  ];
  return {
    contacts,
    async getById(contactId) {
      return contacts.find((c) => c.contactId === contactId);
    },
    async findByEmail(email) {
      return contacts.find((c) => emailsOf(c).includes(email));
    },
    async addEmail(contactId, { email, label }) {
      const contact = contacts.find((c) => c.contactId === contactId);
      if (!contact) throw new Error('contact missing (fake)');
      if (!emailsOf(contact).includes(email)) {
        contact.emails = [
          ...(contact.emails ?? []),
          { email, primary: false, ...(label !== undefined && { label }) },
        ];
      }
      return contact;
    },
    async create(input) {
      const contact = { ...input, contactId: `contact-${++seq}` } as ContactItem;
      contacts.push(contact);
      return contact;
    },
    async touchEmailLastSeen() {
      // not exercised by the routes (the re-ingest service owns it)
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeApp(opts: { seedContacts?: ContactItem[]; reingestResult?: IngestResult } = {}) {
  const repo = createMemoryUnmatchedRepo();
  const contacts = createMemoryContacts(opts.seedContacts ?? []);
  const events = createEventBus();
  const emitted: { unmatchedId?: string }[] = [];
  events.on('unmatched_email.updated', (p) => emitted.push(p));
  const audits: { entityKey: string; event_type: string; payload: unknown }[] = [];
  const auditRepo = {
    async append(entityKey: string, event_type: string, payload: unknown) {
      audits.push({ entityKey, event_type, payload });
    },
  };
  const reingest = vi.fn(
    async (_notice: InboundEmailNotice, _ingestOpts: { reingest?: boolean }) =>
      opts.reingestResult ?? ({ outcome: 'threaded', conversationId: 'conv-9' } as IngestResult),
  );
  const logger = createLogger({ destination: createLogCapture().stream });

  const router = createUnmatchedEmailRouter({
    logger,
    unmatchedEmailRepo: repo,
    contactsRepo: contacts,
    auditRepo,
    events,
    reingest,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthedRequest).user = { userId: 'user-1', email: 'va@example.com', role: 'va' };
    next();
  });
  app.use('/api/unmatched-email', router);
  return { app, repo, contacts, emitted, audits, reingest };
}

function baseRow(overrides: Partial<NewUnmatchedEmail> = {}): NewUnmatchedEmail {
  return {
    status: 'unmatched',
    from: { name: 'Pat Doe', address: 'pat@example.com' },
    subject: 'About the listing',
    snippet: 'Hi, is the unit still available?',
    text: 'Hi, is the unit still available?\n\nThanks,\nPat',
    html_sanitized: '<p>Hi, is the unit still available?</p>',
    raw_ref: { bucket: 'inbound-bucket', key: 'raw/key-1' },
    attachments_meta: [{ filename: 'doc.pdf', contentType: 'application/pdf', size: 1234 }],
    spam_verdict: 'PASS',
    received_at: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

const seedContact = (
  overrides: Partial<ContactItem> & { contactId: string; type: ContactItem['type'] },
): ContactItem => ({ status: 'active', ...overrides }) as ContactItem;

// ---------------------------------------------------------------------------
// GET / (list) + GET /:id (detail)
// ---------------------------------------------------------------------------

describe('GET /api/unmatched-email - the list envelope', () => {
  it('serves { rows, nextCursor, unreadCount }; rows are newest-first meta WITHOUT text/html_sanitized', async () => {
    const { app, repo } = makeApp();
    const a = (await repo.putUnmatched(baseRow({ received_at: '2026-07-20T10:00:00.000Z' })))
      .unmatchedId;
    const b = (await repo.putUnmatched(baseRow({ received_at: '2026-07-20T11:00:00.000Z' })))
      .unmatchedId;
    await repo.putUnmatched(baseRow({ status: 'quarantined' })); // other tab
    await repo.markRead(a);

    const res = await request(app).get('/api/unmatched-email');
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.unreadCount).toBe(1); // b unread; a read; quarantined excluded
    expect(res.body.rows.map((r: { unmatchedId: string }) => r.unmatchedId)).toEqual([b, a]);
    const row = res.body.rows[0];
    expect(row).toMatchObject({
      unmatchedId: b,
      status: 'unmatched',
      from: { name: 'Pat Doe', address: 'pat@example.com' },
      subject: 'About the listing',
      snippet: 'Hi, is the unit still available?',
      attachments_meta: [{ filename: 'doc.pdf', contentType: 'application/pdf', size: 1234 }],
      spam_verdict: 'PASS',
      received_at: '2026-07-20T11:00:00.000Z',
      read: false,
    });
    // Payload adjudication: list rows NEVER carry the body fields.
    expect(row.text).toBeUndefined();
    expect(row.html_sanitized).toBeUndefined();
    // Internal S3 pointer stays server-side (raw MIME is never served).
    expect(row.raw_ref).toBeUndefined();
  });

  it('?filter=quarantine serves the quarantined partition', async () => {
    const { app, repo } = makeApp();
    await repo.putUnmatched(baseRow());
    const q = (await repo.putUnmatched(baseRow({ status: 'quarantined', virus_verdict: 'FAIL' })))
      .unmatchedId;

    const res = await request(app).get('/api/unmatched-email?filter=quarantine');
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { unmatchedId: string }) => r.unmatchedId)).toEqual([q]);
    expect(res.body.rows[0].virus_verdict).toBe('FAIL');
  });

  it('400s an unknown filter', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/unmatched-email?filter=bogus');
    expect(res.status).toBe(400);
  });

  it('pages via the opaque cursor and 400s a tampered one', async () => {
    const { app, repo } = makeApp();
    const a = (await repo.putUnmatched(baseRow({ received_at: '2026-07-20T10:00:00.000Z' })))
      .unmatchedId;
    const b = (await repo.putUnmatched(baseRow({ received_at: '2026-07-20T11:00:00.000Z' })))
      .unmatchedId;

    const first = await request(app).get('/api/unmatched-email?limit=1');
    expect(first.body.rows.map((r: { unmatchedId: string }) => r.unmatchedId)).toEqual([b]);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(app).get(
      `/api/unmatched-email?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.body.rows.map((r: { unmatchedId: string }) => r.unmatchedId)).toEqual([a]);

    const tampered = await request(app).get('/api/unmatched-email?cursor=not-a-cursor');
    expect(tampered.status).toBe(400);
  });

  it('400s an invalid limit', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/api/unmatched-email?limit=0')).status).toBe(400);
    expect((await request(app).get('/api/unmatched-email?limit=101')).status).toBe(400);
  });
});

describe('GET /api/unmatched-email/:id - the detail row', () => {
  it('serves the FULL row (text + html_sanitized) for the expanded view', async () => {
    const { app, repo } = makeApp();
    const { unmatchedId } = await repo.putUnmatched(baseRow());

    const res = await request(app).get(`/api/unmatched-email/${unmatchedId}`);
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({
      unmatchedId,
      text: 'Hi, is the unit still available?\n\nThanks,\nPat',
      html_sanitized: '<p>Hi, is the unit still available?</p>',
    });
    expect(res.body.row.raw_ref).toBeUndefined(); // never served
  });

  it('404s an unknown id with unmatched_not_found', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/unmatched-email/um-ghost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unmatched_not_found');
  });
});

// ---------------------------------------------------------------------------
// POST /:id/read
// ---------------------------------------------------------------------------

describe('POST /api/unmatched-email/:id/read', () => {
  it('marks the row read and emits unmatched_email.updated', async () => {
    const { app, repo, emitted } = makeApp();
    const { unmatchedId } = await repo.putUnmatched(baseRow());

    const res = await request(app).post(`/api/unmatched-email/${unmatchedId}/read`);
    expect(res.status).toBe(200);
    expect(res.body.row.read).toBe(true);
    expect(emitted).toEqual([{ unmatchedId }]);
  });

  it('404s an unknown id', async () => {
    const { app, emitted } = makeApp();
    const res = await request(app).post('/api/unmatched-email/um-ghost/read');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unmatched_not_found');
    expect(emitted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/link
// ---------------------------------------------------------------------------

describe('POST /api/unmatched-email/:id/link', () => {
  it('happy path: addEmail + re-ingest (reingest:true) + status linked -> { conversationId }', async () => {
    const { app, repo, contacts, emitted, reingest } = makeApp({
      seedContacts: [seedContact({ contactId: 'c-1', type: 'tenant' })],
    });
    const { unmatchedId } = await repo.putUnmatched(baseRow());

    const res = await request(app)
      .post(`/api/unmatched-email/${unmatchedId}/link`)
      .send({ contactId: 'c-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ conversationId: 'conv-9' });

    // The address was attached to the contact BEFORE the re-ingest.
    expect(await contacts.findByEmail('pat@example.com')).toMatchObject({ contactId: 'c-1' });
    // The re-ingest got the stored raw ref + verdicts AND the reingest flag.
    expect(reingest).toHaveBeenCalledWith(
      { bucket: 'inbound-bucket', key: 'raw/key-1', spamVerdict: 'PASS' },
      { reingest: true },
    );
    // Row flipped to linked with provenance; SSE emitted.
    const row = await repo.getById(unmatchedId);
    expect(row?.status).toBe('linked');
    expect(row?.linked_contact_id).toBe('c-1');
    expect(row?.expires_at).toBeDefined(); // F19: linked rows expire
    expect(emitted).toEqual([{ unmatchedId }]);
  });

  it('tolerates the address already being on the SAME contact (idempotent addEmail)', async () => {
    const { app, repo } = makeApp({
      seedContacts: [seedContact({ contactId: 'c-1', type: 'tenant', email: 'pat@example.com' })],
    });
    const { unmatchedId } = await repo.putUnmatched(baseRow());

    const res = await request(app)
      .post(`/api/unmatched-email/${unmatchedId}/link`)
      .send({ contactId: 'c-1' });
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe('conv-9');
  });

  it('409s email_in_use (with the owner) when ANOTHER contact holds the address - no re-ingest', async () => {
    const { app, repo, reingest, emitted } = makeApp({
      seedContacts: [
        seedContact({ contactId: 'c-1', type: 'tenant' }),
        seedContact({ contactId: 'c-2', type: 'landlord', email: 'pat@example.com' }),
      ],
    });
    const { unmatchedId } = await repo.putUnmatched(baseRow());

    const res = await request(app)
      .post(`/api/unmatched-email/${unmatchedId}/link`)
      .send({ contactId: 'c-1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_in_use');
    expect(res.body.contact.contactId).toBe('c-2');
    expect(reingest).not.toHaveBeenCalled();
    expect((await repo.getById(unmatchedId))?.status).toBe('unmatched');
    expect(emitted).toEqual([]);
  });

  it('404s: unknown row -> unmatched_not_found; unknown contact -> contact_not_found', async () => {
    const { app, repo } = makeApp();
    const ghost = await request(app)
      .post('/api/unmatched-email/um-ghost/link')
      .send({ contactId: 'c-1' });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe('unmatched_not_found');

    const { unmatchedId } = await repo.putUnmatched(baseRow());
    const noContact = await request(app)
      .post(`/api/unmatched-email/${unmatchedId}/link`)
      .send({ contactId: 'c-ghost' });
    expect(noContact.status).toBe(404);
    expect(noContact.body.error).toBe('contact_not_found');
  });

  it('400s a missing contactId and a row with no sender address (parse_skipped)', async () => {
    const { app, repo } = makeApp({
      seedContacts: [seedContact({ contactId: 'c-1', type: 'tenant' })],
    });
    const { unmatchedId } = await repo.putUnmatched(baseRow());
    expect(
      (await request(app).post(`/api/unmatched-email/${unmatchedId}/link`).send({})).status,
    ).toBe(400);

    const skipped = await repo.putUnmatched(
      baseRow({
        status: 'quarantined',
        from: { address: '' },
        subject: '',
        snippet: '',
        text: '',
        parse_skipped: 'parse_failed',
      }),
    );
    const res = await request(app)
      .post(`/api/unmatched-email/${skipped.unmatchedId}/link`)
      .send({ contactId: 'c-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_sender_address');
  });

  it('refuses a virus-flagged row (409 virus_flagged) - re-ingest would only re-quarantine', async () => {
    const { app, repo, reingest } = makeApp({
      seedContacts: [seedContact({ contactId: 'c-1', type: 'tenant' })],
    });
    const { unmatchedId } = await repo.putUnmatched(
      baseRow({ status: 'quarantined', virus_verdict: 'FAIL' }),
    );
    const res = await request(app)
      .post(`/api/unmatched-email/${unmatchedId}/link`)
      .send({ contactId: 'c-1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('virus_flagged');
    expect(reingest).not.toHaveBeenCalled();
  });

  it('maps re-ingest outcome duplicate -> 409 already_threaded; other outcomes -> 500 reingest_failed (row NOT linked)', async () => {
    const dup = makeApp({
      seedContacts: [seedContact({ contactId: 'c-1', type: 'tenant' })],
      reingestResult: { outcome: 'duplicate' },
    });
    const dupRow = await dup.repo.putUnmatched(baseRow());
    const dupRes = await request(dup.app)
      .post(`/api/unmatched-email/${dupRow.unmatchedId}/link`)
      .send({ contactId: 'c-1' });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error).toBe('already_threaded');
    expect((await dup.repo.getById(dupRow.unmatchedId))?.status).toBe('unmatched');

    const bad = makeApp({
      seedContacts: [seedContact({ contactId: 'c-1', type: 'tenant' })],
      reingestResult: { outcome: 'unmatched', unmatchedId: 'um-new' },
    });
    const badRow = await bad.repo.putUnmatched(baseRow());
    const badRes = await request(bad.app)
      .post(`/api/unmatched-email/${badRow.unmatchedId}/link`)
      .send({ contactId: 'c-1' });
    expect(badRes.status).toBe(500);
    expect(badRes.body.error).toBe('reingest_failed');
    expect((await bad.repo.getById(badRow.unmatchedId))?.status).toBe('unmatched');
  });
});

// ---------------------------------------------------------------------------
// POST /:id/create-contact
// ---------------------------------------------------------------------------

describe('POST /api/unmatched-email/:id/create-contact', () => {
  it('creates the typed contact with the sender address, links, and returns { conversationId, contactId }', async () => {
    const { app, repo, contacts, audits, reingest, emitted } = makeApp();
    const { unmatchedId } = await repo.putUnmatched(baseRow());

    const res = await request(app)
      .post(`/api/unmatched-email/${unmatchedId}/create-contact`)
      .send({ name: 'Sam Vee', type: 'partner' });
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe('conv-9');
    const contactId = res.body.contactId as string;

    const created = await contacts.getById(contactId);
    expect(created).toMatchObject({
      type: 'partner',
      firstName: 'Sam',
      lastName: 'Vee',
      email: 'pat@example.com',
      status: 'active', // the type-scoped manual-create default (non-tenant/landlord)
    });
    expect(reingest).toHaveBeenCalledWith(expect.anything(), { reingest: true });
    const row = await repo.getById(unmatchedId);
    expect(row?.status).toBe('linked');
    expect(row?.linked_contact_id).toBe(contactId);
    expect(emitted).toEqual([{ unmatchedId }]);
    // The create is audited like the manual-create route (actor + source).
    expect(audits).toContainEqual(
      expect.objectContaining({
        entityKey: `contacts#${contactId}`,
        event_type: 'contact_created',
        payload: expect.objectContaining({ actor: 'user-1', source: 'unmatched_email' }),
      }),
    );
  });

  it('type-scoped status defaults: tenant -> onboarding, landlord -> interested', async () => {
    const { app, repo, contacts } = makeApp();
    const one = await repo.putUnmatched(baseRow({ from: { address: 't@example.com' } }));
    const two = await repo.putUnmatched(baseRow({ from: { address: 'l@example.com' } }));

    const tenant = await request(app)
      .post(`/api/unmatched-email/${one.unmatchedId}/create-contact`)
      .send({ name: 'Tia', type: 'tenant' });
    expect((await contacts.getById(tenant.body.contactId))?.status).toBe('onboarding');

    const landlord = await request(app)
      .post(`/api/unmatched-email/${two.unmatchedId}/create-contact`)
      .send({ name: 'Lee', type: 'landlord' });
    expect((await contacts.getById(landlord.body.contactId))?.status).toBe('interested');
  });

  it('400s validation: missing/empty name; type outside tenant|landlord|partner', async () => {
    const { app, repo } = makeApp();
    const { unmatchedId } = await repo.putUnmatched(baseRow());
    for (const body of [
      {},
      { name: '', type: 'tenant' },
      { name: 'Sam', type: 'team_member' },
      { name: 'Sam', type: 'unknown' },
      { name: 'Sam' },
    ]) {
      const res = await request(app)
        .post(`/api/unmatched-email/${unmatchedId}/create-contact`)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('409s email_in_use when the address already belongs to a contact (no orphan created)', async () => {
    const { app, repo, contacts } = makeApp({
      seedContacts: [seedContact({ contactId: 'c-2', type: 'landlord', email: 'pat@example.com' })],
    });
    const { unmatchedId } = await repo.putUnmatched(baseRow());
    const before = contacts.contacts.length;

    const res = await request(app)
      .post(`/api/unmatched-email/${unmatchedId}/create-contact`)
      .send({ name: 'Sam Vee', type: 'partner' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_in_use');
    expect(res.body.contact.contactId).toBe('c-2');
    expect(contacts.contacts.length).toBe(before);
  });

  it('404s an unknown row', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/unmatched-email/um-ghost/create-contact')
      .send({ name: 'Sam', type: 'tenant' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unmatched_not_found');
  });
});

// ---------------------------------------------------------------------------
// POST /:id/spam / /:id/release / /:id/dismiss
// ---------------------------------------------------------------------------

describe('POST /api/unmatched-email/:id/spam', () => {
  it('blocklists the sender + dismisses the row (TTL) + emits', async () => {
    const { app, repo, emitted } = makeApp();
    const { unmatchedId } = await repo.putUnmatched(baseRow());

    const res = await request(app).post(`/api/unmatched-email/${unmatchedId}/spam`);
    expect(res.status).toBe(200);
    expect(res.body.row.status).toBe('dismissed');
    expect(await repo.isBlocked('pat@example.com')).toBe(true);
    expect((await repo.getById(unmatchedId))?.expires_at).toBeDefined();
    expect(emitted).toEqual([{ unmatchedId }]);
  });

  it('dismisses a no-sender (parse_skipped) row WITHOUT writing a block', async () => {
    const { app, repo } = makeApp();
    const { unmatchedId } = await repo.putUnmatched(
      baseRow({ status: 'quarantined', from: { address: '' }, parse_skipped: 'oversize' }),
    );
    const res = await request(app).post(`/api/unmatched-email/${unmatchedId}/spam`);
    expect(res.status).toBe(200);
    expect(res.body.row.status).toBe('dismissed');
    expect(repo.blocks.size).toBe(0);
  });

  it('404s an unknown row', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/unmatched-email/um-ghost/spam');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unmatched_not_found');
  });
});

describe('POST /api/unmatched-email/:id/release', () => {
  it('releases a quarantined row back to unmatched (TTL cleared) + emits', async () => {
    const { app, repo, emitted } = makeApp();
    const { unmatchedId } = await repo.putUnmatched(baseRow({ status: 'quarantined' }));
    expect((await repo.getById(unmatchedId))?.expires_at).toBeDefined();

    const res = await request(app).post(`/api/unmatched-email/${unmatchedId}/release`);
    expect(res.status).toBe(200);
    expect(res.body.row.status).toBe('unmatched');
    expect((await repo.getById(unmatchedId))?.expires_at).toBeUndefined();
    expect(emitted).toEqual([{ unmatchedId }]);
  });

  it('409s not_quarantined for a row not in quarantine; 404s unknown', async () => {
    const { app, repo } = makeApp();
    const { unmatchedId } = await repo.putUnmatched(baseRow());
    const res = await request(app).post(`/api/unmatched-email/${unmatchedId}/release`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_quarantined');

    expect((await request(app).post('/api/unmatched-email/um-ghost/release')).status).toBe(404);
  });
});

describe('POST /api/unmatched-email/:id/dismiss', () => {
  it('dismisses the row (TTL) + emits; 404s unknown', async () => {
    const { app, repo, emitted } = makeApp();
    const { unmatchedId } = await repo.putUnmatched(baseRow());

    const res = await request(app).post(`/api/unmatched-email/${unmatchedId}/dismiss`);
    expect(res.status).toBe(200);
    expect(res.body.row.status).toBe('dismissed');
    expect((await repo.getById(unmatchedId))?.expires_at).toBeDefined();
    expect(emitted).toEqual([{ unmatchedId }]);

    expect((await request(app).post('/api/unmatched-email/um-ghost/dismiss')).status).toBe(404);
  });
});
