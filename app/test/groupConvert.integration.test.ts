// The conversion claims that need REAL conditional writes (S7 / spec 9, 15.4):
// the atomic type transition, the bulk-vs-inbound-auto-convert race, the
// removal of every relay-only field, and the first-write-wins consent stamp.
//
// Self-skipping like the other integration suites (`npm run db:start`).
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { convertConnectingRelayGroupToGroupText } from '../src/services/groupConvert.js';
import { contactIdForPhone } from '../src/lib/import/ids.js';
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
    `[groupConvert.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const MEMBER_A = '+15550100008';
const MEMBER_B = '+15550100004';
const AT = '2026-08-17T12:00:00.000Z';

describe.skipIf(!reachable)('convertConnectingRelayGroupToGroupText against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const conversationsRepo = createConversationsRepo({ doc, env: testEnv, logger });
  const contactsRepo = createContactsRepo({ doc, env: testEnv, logger });
  const opts = { conversationsRepo, contactsRepo, at: AT, logger };
  const conversationsTable = tableName('conversations', testEnv);
  const contactsTable = tableName('contacts', testEnv);

  let seq = 0;
  const nextId = (): string => `gc-test-${++seq}-${randomUUID().slice(0, 8)}`;

  /** The row exactly as the importer writes it, plus whatever the case needs. */
  const seedImportedGroup = async (
    conversationId: string,
    over: Record<string, unknown> = {},
  ): Promise<void> => {
    await doc.send(
      new PutCommand({
        TableName: conversationsTable,
        Item: {
          conversationId,
          type: 'relay_group',
          status: 'connecting',
          relay_status: 'relay_group#connecting',
          last_activity_at: '2026-07-26T10:00:00.000Z',
          created_at: '2026-07-25T10:00:00.000Z',
          ai_mode: 'manual',
          participants: [
            { contactId: '', phone: MEMBER_A },
            { contactId: '', phone: MEMBER_B },
          ],
          imported_from: 'quo-airtable-import',
          imported_at: '2026-08-05T00:00:00.000Z',
          ...over,
        },
      }),
    );
  };

  const seedContact = async (phone: string): Promise<string> => {
    const contactId = contactIdForPhone(phone);
    await doc.send(
      new PutCommand({
        TableName: contactsTable,
        Item: { contactId, phone, type: 'unknown', status: 'needs_review' },
      }),
    );
    return contactId;
  };

  const readConversation = async (conversationId: string): Promise<Record<string, unknown>> => {
    const { Item } = await doc.send(
      new GetCommand({ TableName: conversationsTable, Key: { conversationId } }),
    );
    return Item as Record<string, unknown>;
  };

  beforeAll(async () => {
    for (const t of ['conversations', 'contacts'] as const) {
      await ensureTable(client, getTableSpec(t), tableName(t, testEnv));
    }
  }, 60_000);

  afterAll(async () => {
    for (const t of ['conversations', 'contacts'] as const) {
      await deleteTableIfExists(client, tableName(t, testEnv));
    }
    client.destroy();
  }, 60_000);

  it('strips every relay-only field in the same write as the type flip', async () => {
    const id = nextId();
    await seedImportedGroup(id, {
      participants_version: 3,
      relay_opted_out_members: { 'phone#+15550100008': { at: AT } },
      close_nag_next_at: '2026-09-01T00:00:00.000Z',
      close_announced_at: '2026-08-01T00:00:00.000Z',
      participant_phone: '+15550199999',
      placementId: 'placement-1',
      owner: { type: 'placement', id: 'placement-1' },
    });
    await seedContact(MEMBER_A);
    await seedContact(MEMBER_B);

    const result = await convertConnectingRelayGroupToGroupText(id, opts);
    expect(result.outcome).toBe('converted');

    const stored = await readConversation(id);
    expect(stored.type).toBe('group_text');
    expect(stored.status).toBe('group_open');
    for (const relayOnly of [
      'relay_status',
      'pool_number',
      'participant_phone',
      'participants_version',
      'relay_opted_out_members',
      'close_nag_next_at',
      'close_announced_at',
      'ever_member_phones',
      'placementId',
      'owner',
    ]) {
      expect(stored[relayOnly]).toBeUndefined();
    }
    // Import provenance is KEPT: it is what makes the connect flag reportable on
    // a re-run, and it is not a relay mechanism.
    expect(stored.imported_from).toBe('quo-airtable-import');
    expect(stored.participants).toEqual([
      { contactId: contactIdForPhone(MEMBER_A), phone: MEMBER_A },
      { contactId: contactIdForPhone(MEMBER_B), phone: MEMBER_B },
    ]);
  });

  it('lets exactly one of two concurrent converters win, and the loser converges', async () => {
    // Bulk migration vs inbound auto-convert on the same thread at the same
    // instant. Both callers must end up reporting a converged thread.
    const id = nextId();
    await seedImportedGroup(id);
    await seedContact(MEMBER_A);
    await seedContact(MEMBER_B);

    const [left, right] = await Promise.all([
      convertConnectingRelayGroupToGroupText(id, opts),
      convertConnectingRelayGroupToGroupText(id, opts),
    ]);

    const outcomes = [left.outcome, right.outcome].sort();
    expect(outcomes).toEqual(['already_converted', 'converted']);
    const stored = await readConversation(id);
    expect(stored.type).toBe('group_text');
    expect(stored.relay_status).toBeUndefined();
    // Whoever lost still finished the job: the stamp exists exactly once.
    const contact = await doc.send(
      new GetCommand({
        TableName: contactsTable,
        Key: { contactId: contactIdForPhone(MEMBER_A) },
      }),
    );
    expect(contact.Item!.group_participation_at).toBe(AT);
  });

  it('never rewrites an existing group_participation_at', async () => {
    const id = nextId();
    await seedImportedGroup(id);
    const contactId = await seedContact(MEMBER_A);
    await seedContact(MEMBER_B);
    expect(await contactsRepo.stampGroupParticipation(contactId, '2026-01-01T00:00:00.000Z')).toBe(
      'stamped',
    );

    const result = await convertConnectingRelayGroupToGroupText(id, opts);
    expect(result.membersAlreadyStamped).toBeGreaterThanOrEqual(1);
    const contact = await doc.send(
      new GetCommand({ TableName: contactsTable, Key: { contactId } }),
    );
    expect(contact.Item!.group_participation_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('reports a missing contact rather than creating one', async () => {
    // Its own phones: the suite shares tables, and MEMBER_A/MEMBER_B already
    // have contacts from the cases above.
    const known = '+15550100301';
    const orphan = '+15550100302';
    const id = nextId();
    await seedImportedGroup(id, {
      participants: [
        { contactId: '', phone: known },
        { contactId: '', phone: orphan },
      ],
    });
    await seedContact(known);

    const result = await convertConnectingRelayGroupToGroupText(id, opts);
    expect(result.membersMissing).toEqual([contactIdForPhone(orphan)]);
    const contact = await doc.send(
      new GetCommand({
        TableName: contactsTable,
        Key: { contactId: contactIdForPhone(orphan) },
      }),
    );
    expect(contact.Item).toBeUndefined();
  });

  it('refuses a connected relay group and leaves the row untouched', async () => {
    const id = nextId();
    await seedImportedGroup(id, {
      status: 'open',
      relay_status: 'relay_group#open',
      pool_number: '+15550199999',
    });

    const result = await convertConnectingRelayGroupToGroupText(id, opts);
    expect(result.outcome).toBe('refused');
    const stored = await readConversation(id);
    expect(stored.type).toBe('relay_group');
    expect(stored.status).toBe('open');
    expect(stored.pool_number).toBe('+15550199999');
  });
});
