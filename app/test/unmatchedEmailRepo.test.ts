// Email-channel B3 integration tests against DynamoDB Local - the
// unmatched_email store (the unknown-sender side-door) + sender blocklist:
//   - putUnmatched stamps `um-<uuid>` + read:false and applies the F19 TTL
//     matrix at insert (quarantined/dismissed -> expires_at now+90d epoch
//     seconds; unmatched -> NO expires_at: rows awaiting action never expire).
//   - setStatus transitions re-apply the matrix (linked/dismissed -> +90d;
//     quarantined->unmatched release REMOVES expires_at).
//   - listByStatus pages the byStatus GSI newest-first (received_at DESC) with
//     the repo-level lastEvaluatedKey/exclusiveStartKey convention (the
//     contactsRepo.listByType shape; routes opaque-cursor it).
//   - unreadCount is a CAPPED first-page count (the inbox 100-cap pattern) of
//     read:false rows in the 'unmatched' partition - never a Scan.
//   - blocklist rows are `block#<address>` pointer items in the SAME table,
//     invisible to the feeds (no status/received_at -> never in the GSI).
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { NewUnmatchedEmail } from '../src/services/inboundEmail.js';
import {
  createUnmatchedEmailRepo,
  UNMATCHED_EMAIL_TTL_SECONDS,
  UNMATCHED_UNREAD_COUNT_CAP,
} from '../src/repos/unmatchedEmailRepo.js';
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
    `[unmatchedEmailRepo.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

/** A well-formed side-door row (B2's NewUnmatchedEmail shape). */
function baseRow(overrides: Partial<NewUnmatchedEmail> = {}): NewUnmatchedEmail {
  return {
    status: 'unmatched',
    from: { name: 'Pat Doe', address: 'pat@example.com' },
    subject: 'About the listing',
    snippet: 'Hi, is the unit still available?',
    text: 'Hi, is the unit still available?\n\nThanks,\nPat',
    raw_ref: { bucket: 'inbound-bucket', key: 'raw/key-1' },
    attachments_meta: [{ filename: 'doc.pdf', contentType: 'application/pdf', size: 1234 }],
    received_at: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

/** Assert an epoch-seconds TTL is ~now+90d (60s tolerance around the call). */
function expectNinetyDaysOut(expiresAt: unknown): void {
  const nowSec = Math.floor(Date.now() / 1000);
  expect(typeof expiresAt).toBe('number');
  expect(expiresAt as number).toBeGreaterThanOrEqual(nowSec + UNMATCHED_EMAIL_TTL_SECONDS - 60);
  expect(expiresAt as number).toBeLessThanOrEqual(nowSec + UNMATCHED_EMAIL_TTL_SECONDS + 60);
}

describe.skipIf(!reachable)('unmatchedEmailRepo rows + F19 TTL matrix (DynamoDB Local)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createUnmatchedEmailRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('unmatched_email'), tableName('unmatched_email', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('unmatched_email', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('putUnmatched stamps um-<uuid> + read:false and round-trips the row; unmatched rows get NO expires_at', async () => {
    const row = baseRow();
    const { unmatchedId } = await repo.putUnmatched(row);
    expect(unmatchedId).toMatch(/^um-/);

    const stored = await repo.getById(unmatchedId);
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      unmatchedId,
      status: 'unmatched',
      from: { name: 'Pat Doe', address: 'pat@example.com' },
      subject: 'About the listing',
      snippet: 'Hi, is the unit still available?',
      raw_ref: { bucket: 'inbound-bucket', key: 'raw/key-1' },
      received_at: '2026-07-20T10:00:00.000Z',
      read: false,
    });
    expect(stored?.attachments_meta).toEqual(row.attachments_meta);
    // F19: rows awaiting action never expire.
    expect(stored?.expires_at).toBeUndefined();
  });

  it('quarantined at insert -> expires_at = now+90d (epoch seconds)', async () => {
    const { unmatchedId } = await repo.putUnmatched(
      baseRow({ status: 'quarantined', spam_verdict: 'FAIL' }),
    );
    const stored = await repo.getById(unmatchedId);
    expect(stored?.status).toBe('quarantined');
    expect(stored?.spam_verdict).toBe('FAIL');
    expectNinetyDaysOut(stored?.expires_at);
  });

  it('dismissed at insert (a blocked sender arriving) -> expires_at = now+90d', async () => {
    const { unmatchedId } = await repo.putUnmatched(baseRow({ status: 'dismissed' }));
    const stored = await repo.getById(unmatchedId);
    expect(stored?.status).toBe('dismissed');
    expectNinetyDaysOut(stored?.expires_at);
  });

  it('round-trips a parse_skipped quarantine row (empty from/subject/text)', async () => {
    const { unmatchedId } = await repo.putUnmatched(
      baseRow({
        status: 'quarantined',
        from: { address: '' },
        subject: '',
        snippet: '',
        text: '',
        attachments_meta: [],
        parse_skipped: 'oversize',
      }),
    );
    const stored = await repo.getById(unmatchedId);
    expect(stored?.parse_skipped).toBe('oversize');
    expect(stored?.from).toEqual({ address: '' });
    expectNinetyDaysOut(stored?.expires_at);
  });

  it('markRead flips read to true and returns the row; unknown id -> undefined', async () => {
    const { unmatchedId } = await repo.putUnmatched(baseRow());
    const updated = await repo.markRead(unmatchedId);
    expect(updated?.read).toBe(true);
    expect((await repo.getById(unmatchedId))?.read).toBe(true);

    expect(await repo.markRead('um-ghost')).toBeUndefined();
  });

  it('setStatus linked stamps linked_contact_id + expires_at (+90d)', async () => {
    const { unmatchedId } = await repo.putUnmatched(baseRow());
    const updated = await repo.setStatus(unmatchedId, 'linked', { linkedContactId: 'contact-1' });
    expect(updated?.status).toBe('linked');
    expect(updated?.linked_contact_id).toBe('contact-1');
    expectNinetyDaysOut(updated?.expires_at);
  });

  it('setStatus dismissed stamps expires_at (+90d)', async () => {
    const { unmatchedId } = await repo.putUnmatched(baseRow());
    const updated = await repo.setStatus(unmatchedId, 'dismissed');
    expect(updated?.status).toBe('dismissed');
    expectNinetyDaysOut(updated?.expires_at);
  });

  it('release (quarantined -> unmatched) REMOVES expires_at', async () => {
    const { unmatchedId } = await repo.putUnmatched(baseRow({ status: 'quarantined' }));
    expectNinetyDaysOut((await repo.getById(unmatchedId))?.expires_at);

    const released = await repo.setStatus(unmatchedId, 'unmatched');
    expect(released?.status).toBe('unmatched');
    expect(released?.expires_at).toBeUndefined();
    expect((await repo.getById(unmatchedId))?.expires_at).toBeUndefined();
  });

  it('setStatus on an unknown id -> undefined', async () => {
    expect(await repo.setStatus('um-ghost', 'dismissed')).toBeUndefined();
  });
});

describe.skipIf(!reachable)('unmatchedEmailRepo list + cursor + unreadCount (DynamoDB Local)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createUnmatchedEmailRepo({ doc, env: testEnv, logger });

  let r1 = '';
  let r2 = '';
  let r3 = '';
  let q1 = '';

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('unmatched_email'), tableName('unmatched_email', testEnv));
    // Three unmatched rows (10:00 / 11:00 / 12:00) + one quarantined (10:30).
    r1 = (await repo.putUnmatched(baseRow({ received_at: '2026-07-20T10:00:00.000Z' }))).unmatchedId;
    r2 = (await repo.putUnmatched(baseRow({ received_at: '2026-07-20T11:00:00.000Z' }))).unmatchedId;
    r3 = (await repo.putUnmatched(baseRow({ received_at: '2026-07-20T12:00:00.000Z' }))).unmatchedId;
    q1 = (
      await repo.putUnmatched(
        baseRow({ status: 'quarantined', received_at: '2026-07-20T10:30:00.000Z' }),
      )
    ).unmatchedId;
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('unmatched_email', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('listByStatus(unmatched) returns only unmatched rows, newest-first', async () => {
    const page = await repo.listByStatus('unmatched');
    expect(page.items.map((i) => i.unmatchedId)).toEqual([r3, r2, r1]);
    expect(page.lastEvaluatedKey).toBeUndefined();
  });

  it('listByStatus(quarantine) returns the quarantined partition', async () => {
    const page = await repo.listByStatus('quarantine');
    expect(page.items.map((i) => i.unmatchedId)).toEqual([q1]);
  });

  it('pages with limit + exclusiveStartKey (newest 2, then the rest)', async () => {
    const first = await repo.listByStatus('unmatched', { limit: 2 });
    expect(first.items.map((i) => i.unmatchedId)).toEqual([r3, r2]);
    expect(first.lastEvaluatedKey).toBeDefined();

    const second = await repo.listByStatus('unmatched', {
      limit: 2,
      exclusiveStartKey: first.lastEvaluatedKey as Record<string, unknown>,
    });
    expect(second.items.map((i) => i.unmatchedId)).toEqual([r1]);
    expect(second.lastEvaluatedKey).toBeUndefined();
  });

  it('unreadCount counts read:false UNMATCHED rows only (quarantine/read excluded)', async () => {
    expect(await repo.unreadCount()).toBe(3); // r1..r3; q1 is quarantined
    await repo.markRead(r2);
    expect(await repo.unreadCount()).toBe(2);
  });

  it(`caps at the first page (${UNMATCHED_UNREAD_COUNT_CAP}) - never a full count/scan`, async () => {
    // Flood the partition past the cap with NEWER unread rows: the capped
    // first-page count saturates at the cap even though more unread rows exist.
    const puts: Promise<unknown>[] = [];
    for (let i = 0; i < UNMATCHED_UNREAD_COUNT_CAP; i++) {
      const minute = String(i % 60).padStart(2, '0');
      const hour = String(13 + Math.floor(i / 60)).padStart(2, '0');
      puts.push(
        repo.putUnmatched(baseRow({ received_at: `2026-07-20T${hour}:${minute}:00.000Z` })),
      );
      if (puts.length >= 25) {
        await Promise.all(puts);
        puts.length = 0;
      }
    }
    await Promise.all(puts);
    expect(await repo.unreadCount()).toBe(UNMATCHED_UNREAD_COUNT_CAP);
  }, 60_000);
});

describe.skipIf(!reachable)('unmatchedEmailRepo sender blocklist (DynamoDB Local)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createUnmatchedEmailRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('unmatched_email'), tableName('unmatched_email', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('unmatched_email', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('putBlock -> isBlocked true; removeBlock -> false again', async () => {
    expect(await repo.isBlocked('spammer@example.com')).toBe(false);
    await repo.putBlock('spammer@example.com');
    expect(await repo.isBlocked('spammer@example.com')).toBe(true);
    // A different address is unaffected.
    expect(await repo.isBlocked('other@example.com')).toBe(false);

    await repo.removeBlock('spammer@example.com');
    expect(await repo.isBlocked('spammer@example.com')).toBe(false);
  });

  it('putBlock is idempotent', async () => {
    await repo.putBlock('twice@example.com');
    await repo.putBlock('twice@example.com');
    expect(await repo.isBlocked('twice@example.com')).toBe(true);
  });

  it('block pointer rows never surface as unmatched rows (no GSI keys, getById guard)', async () => {
    await repo.putBlock('hidden@example.com');
    const { unmatchedId } = await repo.putUnmatched(baseRow());

    const page = await repo.listByStatus('unmatched');
    expect(page.items.map((i) => i.unmatchedId)).toEqual([unmatchedId]);
    // getById on a block pointer id resolves to undefined (not a row).
    expect(await repo.getById('block#hidden@example.com')).toBeUndefined();
  });
});
