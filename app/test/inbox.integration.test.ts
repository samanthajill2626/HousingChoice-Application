// Inbox feed integration tests against DynamoDB Local — exercises the REAL
// repos, the real aggregateInbox paging logic, and the mark-read fan-out
// over genuine DynamoDB conditional writes.
//
// Self-skipping: when nothing answers at DYNAMODB_ENDPOINT (default
// http://localhost:8000) the suite is skipped so `npm test` stays green
// without Docker (`npm run db:start && npm run db:create` to run for real).
//
// KEY ASSERTION — cursor paging is split-proof: a contact with TWO numbers
// must appear exactly ONCE across all pages (no split, no duplicate), even
// when a small limit forces many round-trips. This closes the gap that Task 1's
// in-memory fake could not cover (the fake's listByLastActivity ignores
// exclusiveStartKey and never returns a LastEvaluatedKey).
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName, DEV_SESSION_SECRET_DEFAULT, loadConfig } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createEventBus } from '../src/lib/events.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createMessagesRepo } from '../src/repos/messagesRepo.js';
import { buildApp } from '../src/app.js';
import { createLogCapture } from './helpers/logCapture.js';
import { makeFakeUsersRepo, testUserItem, adminUserItem, TEST_SESSION_COOKIE } from './helpers/authSession.js';

const ORIGIN_SECRET = 'test-origin-secret';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[inbox.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('Inbox feed integration against DynamoDB Local (throwaway prefix)', () => {
  // Throwaway prefix so this suite never touches hc-local-* dev data.
  const prefix = `hc-test-inbox-${randomUUID().slice(0, 8)}-`;
  const testEnv = { TABLE_PREFIX: prefix };
  const dynamo = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const capture = createLogCapture();
  const logger = createLogger({ destination: capture.stream });
  const repoDeps = { doc, env: testEnv, logger };

  const conversations = createConversationsRepo(repoDeps);
  const contacts = createContactsRepo(repoDeps);
  const audit = createAuditRepo(repoDeps);
  const messages = createMessagesRepo(repoDeps);
  const events = createEventBus();

  // Tables needed for the inbox feed.
  const bases = ['contacts', 'conversations', 'audit_events', 'messages'] as const;

  // HTTP server wrapping the real app (so we can hit it with fetch).
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // Create throwaway tables.
    for (const b of bases) {
      await ensureTable(dynamo, getTableSpec(b), tableName(b, testEnv));
    }

    // Build the real app wired to the throwaway-prefix repos via injected deps.
    const fakeUsers = makeFakeUsersRepo([testUserItem(), adminUserItem()]);
    const config = loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: ORIGIN_SECRET,
      MESSAGING_DRIVER: 'console',
      SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT,
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      OAUTH_ALLOWED_DOMAINS: 'housingchoice.org,abt-industries.com',
      OUR_PHONE_NUMBERS: '+15550009999',
      DYNAMODB_ENDPOINT: endpoint,
      TABLE_PREFIX: prefix,
    } as NodeJS.ProcessEnv);

    const app = buildApp({
      config,
      logger,
      auth: { usersRepo: fakeUsers.repo },
      api: {
        conversationsRepo: conversations,
        messagesRepo: messages,
        auditRepo: audit,
        contactsRepo: contacts,
        usersRepo: fakeUsers.repo,
        events,
      },
    });

    await new Promise<void>((resolve) => {
      server = createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const b of bases) {
      await deleteTableIfExists(dynamo, tableName(b, testEnv));
    }
    doc.destroy();
    dynamo.destroy();
  }, 120_000);

  /** Authed GET helper. */
  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: {
        'x-origin-verify': ORIGIN_SECRET,
        cookie: TEST_SESSION_COOKIE,
      },
    });

  /** Authed POST helper with JSON body. */
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'x-origin-verify': ORIGIN_SECRET,
        cookie: TEST_SESSION_COOKIE,
        'content-type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  /** Seed a minimal open conversation and set its last_activity_at + optional unread. */
  async function seedConv(opts: {
    phone: string;
    lastActivityAt: string;
    type?: string;
    unread?: number;
  }) {
    const conv = await conversations.createOrGetByParticipantPhone(
      opts.phone,
      (opts.type as never) ?? 'tenant_1to1',
    );
    await conversations.touchLastActivity(conv.conversationId, 'hey', opts.lastActivityAt);
    if (opts.unread && opts.unread > 0) {
      for (let i = 0; i < opts.unread; i++) {
        await conversations.incrementUnread(conv.conversationId);
      }
    }
    return (await conversations.getById(conv.conversationId))!;
  }

  // ---------------------------------------------------------------------------
  // Seed data (seeded in beforeAll; each run uses a fresh prefix)
  //
  // Topology:
  //   contact A — two numbers (PHONE_A1, PHONE_A2):
  //     conv-A1: last_activity_at T01, unread 2  ← OLDER conv for A
  //     conv-A2: last_activity_at T05, unread 3  ← NEWEST conv for A (represents A's row)
  //   contact B — one number (PHONE_B):
  //     conv-B:  last_activity_at T03, unread 0
  //   contact C — one number (PHONE_C):
  //     conv-C:  last_activity_at T08, unread 1  ← newest overall
  //   unknown (PHONE_UNK): no contact
  //     conv-UNK: last_activity_at T06, unread 1
  //
  // Sort (newest first): C(T08) > UNK(T06) > A(T05) > B(T03)
  // conv-A1(T01) is OLDER — it must be skipped (A already emitted at conv-A2).
  //
  // With limit=1 we expect 4 pages; A appears exactly ONCE even though it
  // owns two conversations — that's the split-proof assertion.
  // ---------------------------------------------------------------------------

  const PHONE_A1 = '+15561001001';
  const PHONE_A2 = '+15561001002';
  const PHONE_B  = '+15561001003';
  const PHONE_C  = '+15561001004';
  const PHONE_UNK = '+15561001005';

  let contactAId: string;
  let contactBId: string;
  let contactCId: string;
  let convA1Id: string;
  let convA2Id: string;
  let convBId: string;
  let convUnkId: string;

  beforeAll(async () => {
    // Create contacts.
    await contacts.createIfAbsent({
      contactId: 'it-contact-a',
      type: 'tenant',
      status: 'active',
      phone: PHONE_A1,
      firstName: 'Alice',
      lastName: 'Abt',
    });
    contactAId = 'it-contact-a';
    // Add second phone to contact A.
    await contacts.addPhone(contactAId, { phone: PHONE_A2 });

    await contacts.createIfAbsent({
      contactId: 'it-contact-b',
      type: 'landlord',
      status: 'active',
      phone: PHONE_B,
      firstName: 'Bob',
      lastName: 'Builder',
    });
    contactBId = 'it-contact-b';

    await contacts.createIfAbsent({
      contactId: 'it-contact-c',
      type: 'tenant',
      status: 'active',
      phone: PHONE_C,
      firstName: 'Carol',
      lastName: 'Chen',
    });
    contactCId = 'it-contact-c';

    // Seed conversations.
    const cA1 = await seedConv({ phone: PHONE_A1, lastActivityAt: '2026-06-17T01:00:00.000Z', unread: 2 });
    convA1Id = cA1.conversationId;
    const cA2 = await seedConv({ phone: PHONE_A2, lastActivityAt: '2026-06-17T05:00:00.000Z', unread: 3 });
    convA2Id = cA2.conversationId;
    const cB  = await seedConv({ phone: PHONE_B,  lastActivityAt: '2026-06-17T03:00:00.000Z' });
    convBId = cB.conversationId;
    await seedConv({ phone: PHONE_C,  lastActivityAt: '2026-06-17T08:00:00.000Z', unread: 1 });
    const cUnk = await seedConv({ phone: PHONE_UNK, lastActivityAt: '2026-06-17T06:00:00.000Z', unread: 1 });
    convUnkId = cUnk.conversationId;

    // Seed a real inbound MMS on conv-A2 (the representative/newest conv for
    // contact A). This exercises the real message-derived channel/direction/
    // preview path in aggregateInbox → latestMessageOf → deriveLatest.
    // providerTs matches lastActivityAt so the SK sorts as the newest item.
    await messages.append({
      conversationId: convA2Id,
      providerSid: 'SM-it-inbound-mms-a2',
      providerTs: '2026-06-17T05:00:00.000Z',
      type: 'mms',
      direction: 'inbound',
      author: 'unknown',
      body: 'Here is my photo',
      mediaUrls: ['https://api.twilio.com/fake-media/photo.jpg'],
      deliveryStatus: 'delivered',
    });
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Test: GET /api/inbox aggregates correctly
  // ---------------------------------------------------------------------------

  it('GET /api/inbox returns one row per contact with summed unread + unknown row', async () => {
    const resp = await get('/api/inbox');
    expect(resp.status).toBe(200);
    const body = await resp.json() as { rows: Array<Record<string, unknown>>; nextCursor: null | string };

    // 4 rows: C, UNK, A, B (newest-activity-first).
    expect(body.rows).toHaveLength(4);

    const rowA = body.rows.find((r) => r['contactId'] === contactAId);
    expect(rowA).toBeDefined();
    expect(rowA!['kind']).toBe('contact');
    expect(rowA!['name']).toBe('Alice Abt');
    expect(rowA!['unreadCount']).toBe(5); // 2 + 3 across both numbers
    expect(rowA!['needsTriage']).toBe(false);

    const rowB = body.rows.find((r) => r['contactId'] === contactBId);
    expect(rowB).toBeDefined();
    expect(rowB!['role']).toBe('landlord');

    const rowC = body.rows.find((r) => r['contactId'] === contactCId);
    expect(rowC).toBeDefined();

    const rowUnk = body.rows.find((r) => r['kind'] === 'unknown');
    expect(rowUnk).toBeDefined();
    expect(rowUnk!['needsTriage']).toBe(true);
    expect(rowUnk!['phone']).toBe(PHONE_UNK);
  });

  it('contact A row derives channel=mms, direction=inbound, non-empty preview from real seeded message', async () => {
    const resp = await get('/api/inbox');
    expect(resp.status).toBe(200);
    const body = await resp.json() as { rows: Array<Record<string, unknown>> };

    const rowA = body.rows.find((r) => r['contactId'] === contactAId);
    expect(rowA).toBeDefined();
    // These fields are derived from the real inbound MMS we seeded on conv-A2.
    expect(rowA!['channel']).toBe('mms');
    expect(rowA!['direction']).toBe('inbound');
    expect(typeof rowA!['preview']).toBe('string');
    expect((rowA!['preview'] as string).length).toBeGreaterThan(0);
  });

  it('filter=unread returns only rows with unreadCount > 0 (A, C, UNK)', async () => {
    const resp = await get('/api/inbox?filter=unread');
    expect(resp.status).toBe(200);
    const { rows } = await resp.json() as { rows: Array<Record<string, unknown>> };
    expect(rows.every((r) => (r['unreadCount'] as number) > 0)).toBe(true);
    const ids = rows.map((r) => r['contactId'] ?? r['phone']).sort();
    expect(ids).toContain(contactAId);
    expect(ids).toContain(contactCId);
    expect(ids).toContain(PHONE_UNK);
    expect(ids).not.toContain(contactBId);
  });

  it('filter=unknown returns only needsTriage rows', async () => {
    const resp = await get('/api/inbox?filter=unknown');
    expect(resp.status).toBe(200);
    const { rows } = await resp.json() as { rows: Array<Record<string, unknown>> };
    expect(rows.every((r) => r['needsTriage'] === true)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['phone']).toBe(PHONE_UNK);
  });

  // ---------------------------------------------------------------------------
  // KEY TEST: cursor paging is split-proof (contact A appears exactly once)
  // ---------------------------------------------------------------------------

  it('pages through the entire feed with limit=1 — each contact appears exactly once, no split, no duplicate', async () => {
    const collectedIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = cursor
        ? `/api/inbox?limit=1&cursor=${encodeURIComponent(cursor)}`
        : '/api/inbox?limit=1';
      const resp = await get(url);
      expect(resp.status).toBe(200);
      const page = await resp.json() as {
        rows: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
      expect(page.rows.length).toBeLessThanOrEqual(1);

      for (const row of page.rows) {
        const id = (row['contactId'] ?? row['phone']) as string;
        collectedIds.push(id);
      }

      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20); // guard against infinite loops
    } while (cursor !== null);

    // Every contact/unknown appears exactly once — no split, no duplicate.
    const sorted = [...collectedIds].sort();
    const expectedSorted = [contactAId, contactBId, contactCId, PHONE_UNK].sort();
    expect(sorted).toEqual(expectedSorted);

    // We really paginated (at least 4 pages for 4 rows at limit=1).
    expect(pages).toBeGreaterThanOrEqual(4);

    // nextCursor is null at exhaustion.
    expect(cursor).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test: POST /api/inbox/:contactId/read zeroes unread on BOTH conversations
  // ---------------------------------------------------------------------------

  it('POST /:contactId/read zeroes unread on ALL of contact A\'s conversations', async () => {
    // Verify pre-condition.
    const preA1 = await conversations.getById(convA1Id);
    const preA2 = await conversations.getById(convA2Id);
    expect(preA1?.unread_count).toBeGreaterThan(0);
    expect(preA2?.unread_count).toBeGreaterThan(0);

    const emitted: unknown[] = [];
    const handler = (p: unknown) => emitted.push(p);
    events.on('conversation.updated', handler);

    const resp = await post(`/api/inbox/${contactAId}/read`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    events.off('conversation.updated', handler);

    // Both conversations zeroed.
    const afterA1 = await conversations.getById(convA1Id);
    const afterA2 = await conversations.getById(convA2Id);
    expect(afterA1?.unread_count).toBe(0);
    expect(afterA2?.unread_count).toBe(0);

    // conversation.updated emitted for each.
    const emittedIds = emitted
      .map((p) => (p as { conversationId: string }).conversationId)
      .sort();
    expect(emittedIds).toContain(convA1Id);
    expect(emittedIds).toContain(convA2Id);
  });

  it('POST /read { phone } zeroes unread on the unknown number\'s conversation', async () => {
    const preUnk = await conversations.getById(convUnkId);
    expect(preUnk?.unread_count).toBeGreaterThan(0);

    const resp = await post('/api/inbox/read', { phone: PHONE_UNK });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    const afterUnk = await conversations.getById(convUnkId);
    expect(afterUnk?.unread_count).toBe(0);
  });

  it('POST /:contactId/read returns 404 for unknown contact', async () => {
    const resp = await post('/api/inbox/no-such-contact/read');
    expect(resp.status).toBe(404);
  });

  it('POST /read returns 404 when no conversation exists for the phone', async () => {
    const resp = await post('/api/inbox/read', { phone: '+15569999999' });
    expect(resp.status).toBe(404);
  });
});
