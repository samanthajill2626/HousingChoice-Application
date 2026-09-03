// Spec D16 - the STATUS-PRESERVING activity bump, against DynamoDB Local.
//
// A relay 30003 retry lands 60-240 seconds after its own open-group gate.
// `touchLastActivity` writes `status = 'open'` on any non-group-text row, so
// bumping through it would resurrect a group closed during that backoff -
// contradicting the "this group chat is now closed" message already sent and
// re-arming every open-gated path. `touchLastActivityPreservingStatus` is the
// sibling that never writes `status`; on a closed group its observable effect
// is a re-sort WITHIN the `closed` partition of the byLastActivity GSI
// (hash `status`, range `last_activity_at` - `src/lib/tables.ts:166-171`).
//
// Harness copied from `relayRepos.integration.test.ts` (the conversations-repo
// harness): a throwaway TABLE_PREFIX, ensure/delete around the suite, and the
// self-skip so `npm test` stays green without Docker (`npm run db:start` to
// exercise it for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
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
    `[conversationsRepoActivityBump.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('touchLastActivityPreservingStatus (D16)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const conversations = createConversationsRepo({ doc, env: testEnv, logger });

  let nextPhone = 0;
  function memberPhone(): string {
    nextPhone += 1;
    return `+1555060${String(nextPhone).padStart(4, '0')}`;
  }

  async function newGroup(): Promise<string> {
    const created = await conversations.createRelayGroup({
      poolNumber: `+1555061${String(nextPhone).padStart(4, '0')}`,
      members: [{ contactId: `c${nextPhone}`, phone: memberPhone(), name: 'A' }],
    });
    return created.conversationId;
  }

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('conversations'), tableName('conversations', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('conversations', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('bumps activity without reopening a closed relay group', async () => {
    const conversationId = await newGroup();
    // THREE args - `expectedCurrent` is required (conversationsRepo.ts:850-854).
    await conversations.setRelayStatus(conversationId, 'closed', 'open');
    const before = await conversations.getById(conversationId);
    expect(before?.status).toBe('closed');

    const at = new Date(Date.now() + 60_000).toISOString();
    const returned = await conversations.touchLastActivityPreservingStatus(
      conversationId,
      'the original text',
      at,
    );

    // ALL_NEW, like the sibling: the caller gets the post-update row back.
    expect(returned.status).toBe('closed');
    expect(returned.last_activity_at).toBe(at);

    const after = await conversations.getById(conversationId);
    expect(after?.status).toBe('closed');
    expect(after?.last_activity_at).toBe(at);
    expect(after?.last_activity_at).not.toBe(before?.last_activity_at);
  });

  it('leaves an open group open', async () => {
    const conversationId = await newGroup();
    const at = new Date(Date.now() + 60_000).toISOString();
    await conversations.touchLastActivityPreservingStatus(conversationId, 'the original text', at);
    const after = await conversations.getById(conversationId);
    expect(after?.status).toBe('open');
    expect(after?.last_activity_at).toBe(at);
  });

  // Adjudication S3: the retry job passes `undefined`. D16 is about ORDERING,
  // and the preview belongs to the thread's NEWEST message - which a retry is
  // not, whenever anything arrived during the 60-240s backoff. An `undefined`
  // preview must therefore leave the stored preview exactly as it found it.
  it('with an undefined preview bumps activity and leaves the preview untouched', async () => {
    const conversationId = await newGroup();
    const seeded = new Date(Date.now() + 1_000).toISOString();
    await conversations.touchLastActivity(conversationId, 'a newer message arrived', seeded);
    const before = await conversations.getById(conversationId);
    expect(before?.last_message_preview).toBe('a newer message arrived');

    const at = new Date(Date.now() + 60_000).toISOString();
    await conversations.touchLastActivityPreservingStatus(conversationId, undefined, at);

    const after = await conversations.getById(conversationId);
    expect(after?.last_message_preview).toBe('a newer message arrived');
    expect(after?.last_activity_at).toBe(at);
  });

  it('with a string preview updates the stored preview', async () => {
    const conversationId = await newGroup();
    const seeded = new Date(Date.now() + 1_000).toISOString();
    await conversations.touchLastActivity(conversationId, 'the first preview', seeded);

    const at = new Date(Date.now() + 60_000).toISOString();
    await conversations.touchLastActivityPreservingStatus(conversationId, 'the retry preview', at);

    const after = await conversations.getById(conversationId);
    expect(after?.last_message_preview).toBe('the retry preview');
    expect(after?.last_activity_at).toBe(at);
  });

  // Same contract as the sibling, whose docblock is explicit that BOTH of its
  // commands require the row to exist so no call site can phantom-upsert.
  it('throws for an unknown conversation rather than upserting one', async () => {
    const missingId = `conv-missing-${randomUUID()}`;
    await expect(
      conversations.touchLastActivityPreservingStatus(
        missingId,
        'the original text',
        new Date().toISOString(),
      ),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    await expect(conversations.getById(missingId)).resolves.toBeUndefined();
  });
});
