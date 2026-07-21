// Email-channel B3 - the Today NON-REGRESSION pin (plan Task B3 / spec
// Decision 4 / invariant item 12): unmatched_email rows CANNOT reach Today's
// inputs. today.ts aggregates over conversations / contacts / placements /
// placementDeadlines / tours / ai_extraction - it has NO unmatched-email dep,
// and this test pins that structurally: build the REAL Today route over REAL
// repos on a shared DynamoDB Local prefix, capture its output, then flood the
// SAME prefix's unmatched_email table with rows in every status (+ a blocklist
// pointer) and assert the output is IDENTICAL. If anyone ever wires the
// side-door into a Today input, this pin goes red.
//
// Deliberately INTEGRATION-shaped (not fakes): the point is that the real
// route over the real database cannot observe the rows, not that a fake
// ignores them. Self-skipping without DynamoDB Local like the other
// integration suites (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createPlacementsRepo } from '../src/repos/placementsRepo.js';
import { createPlacementDeadlinesRepo } from '../src/repos/placementDeadlinesRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createExtractionRepo } from '../src/repos/extractionRepo.js';
import { createUnmatchedEmailRepo } from '../src/repos/unmatchedEmailRepo.js';
import { createTodayRouter } from '../src/routes/today.js';
import type { NewUnmatchedEmail } from '../src/services/inboundEmail.js';
import { createLogCapture } from './helpers/logCapture.js';

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
    `[todayUnmatchedNonRegression.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

/** Every table the Today aggregation queries, plus the side-door itself. */
const TODAY_TABLES = [
  'conversations',
  'contacts',
  'placements',
  'placementDeadlines',
  'tours',
  'ai_extraction',
  'unmatched_email',
] as const;

function unmatchedRow(overrides: Partial<NewUnmatchedEmail> = {}): NewUnmatchedEmail {
  return {
    status: 'unmatched',
    from: { name: 'Stranger Dane', address: 'stranger@example.com' },
    subject: 'Do you have any 2BR units?',
    snippet: 'Do you have any 2BR units available right now?',
    text: 'Do you have any 2BR units available right now?',
    raw_ref: { bucket: 'inbound-bucket', key: `raw/${randomUUID()}` },
    attachments_meta: [],
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

describe.skipIf(!reachable)('Today non-regression: unmatched_email rows never reach Today (B3)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const conversations = createConversationsRepo(repoDeps);
  const contacts = createContactsRepo(repoDeps);
  const unmatched = createUnmatchedEmailRepo(repoDeps);

  const app = express();
  app.use(
    '/api/today',
    createTodayRouter({
      logger,
      conversationsRepo: conversations,
      contactsRepo: contacts,
      placementsRepo: createPlacementsRepo(repoDeps),
      placementDeadlinesRepo: createPlacementDeadlinesRepo(repoDeps),
      toursRepo: createToursRepo(repoDeps),
      extractionRepo: createExtractionRepo(repoDeps),
    }),
  );

  beforeAll(async () => {
    await Promise.all(
      TODAY_TABLES.map((base) =>
        ensureTable(client, getTableSpec(base), tableName(base, testEnv)),
      ),
    );
    // Real Today content, so "identical" is a non-trivial assertion:
    // an untriaged unknown contact (needs_you_now) + an unread tenant 1:1
    // thread (unreplied).
    await contacts.create({
      type: 'unknown',
      status: 'needs_review',
      firstName: 'Ursula',
      phone: '+15550001111',
    });
    const conv = await conversations.createOrGetByParticipantPhone('+15550002222', 'tenant_1to1');
    await conversations.incrementUnread(conv.conversationId);
    await conversations.touchLastActivity(
      conv.conversationId,
      'hi, checking in',
      new Date().toISOString(),
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all(
      TODAY_TABLES.map((base) => deleteTableIfExists(client, tableName(base, testEnv))),
    );
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('Today output is byte-identical before/after unmatched rows land in the table', async () => {
    const before = await request(app).get('/api/today?day=2026-07-20');
    expect(before.status).toBe(200);
    // The world above must actually surface work - an empty-vs-empty compare
    // would prove nothing.
    expect(before.body.items.length).toBeGreaterThan(0);
    expect(
      before.body.items.map((i: { group: string }) => i.group).sort(),
    ).toEqual(['needs_you_now', 'unreplied']);

    // Flood the side-door: one row per status the ingestion can write, plus a
    // route-transition status and a blocklist pointer - ALL invisible to Today.
    await unmatched.putUnmatched(unmatchedRow());
    await unmatched.putUnmatched(unmatchedRow({ status: 'quarantined', spam_verdict: 'FAIL' }));
    await unmatched.putUnmatched(unmatchedRow({ status: 'dismissed' }));
    const linked = await unmatched.putUnmatched(unmatchedRow());
    await unmatched.setStatus(linked.unmatchedId, 'linked', { linkedContactId: 'contact-x' });
    await unmatched.putBlock('stranger@example.com');
    expect(await unmatched.unreadCount()).toBeGreaterThan(0); // rows really exist

    const after = await request(app).get('/api/today?day=2026-07-20');
    expect(after.status).toBe(200);
    // generatedAt is a timestamp; the CONTENT must be identical.
    expect(after.body.items).toEqual(before.body.items);
    expect(after.body.relayCloseNags).toEqual(before.body.relayCloseNags);
  });
});
