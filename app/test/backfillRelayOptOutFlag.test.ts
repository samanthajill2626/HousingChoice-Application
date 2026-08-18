// backfill:relay-optout-flag (2026-08-18) - the one-time stamp that brings
// legacy relay groups onto the byRelayOptOut invariant: the flag exists IFF an
// OPEN relay group's relay_opted_out_members map is non-empty. The planner is
// pure and pinned first; the runner is then proven against DynamoDB Local with
// the real conditional writes (`size(map)` in particular), self-skipping when
// no local endpoint is up, like the other integration suites.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import {
  backfillRelayOptOutFlag,
  planRelayOptOutBackfill,
} from '../scripts/backfill-relay-optout-flag.js';

const OPTED = { c1: { contactId: 'c1', at: '2026-08-10T00:00:00.000Z' } };

describe('planRelayOptOutBackfill', () => {
  it('stamps an OPEN relay group with a non-empty map and no flag', () => {
    expect(planRelayOptOutBackfill({ type: 'relay_group', status: 'open', relay_opted_out_members: OPTED })).toBe('stamp');
  });
  it('skips one already flagged', () => {
    expect(
      planRelayOptOutBackfill({ type: 'relay_group', status: 'open', relay_opted_out_members: OPTED, relay_optout_flag: 'attention' }),
    ).toBe('skip');
  });
  it('removes a stray flag from a CLOSED group, an EMPTY map, or a non-relay row', () => {
    expect(
      planRelayOptOutBackfill({ type: 'relay_group', status: 'closed', relay_opted_out_members: OPTED, relay_optout_flag: 'attention' }),
    ).toBe('remove');
    expect(planRelayOptOutBackfill({ type: 'relay_group', status: 'open', relay_opted_out_members: {}, relay_optout_flag: 'attention' })).toBe(
      'remove',
    );
    expect(planRelayOptOutBackfill({ type: 'tenant_1to1', status: 'open', relay_optout_flag: 'attention' })).toBe('remove');
  });
  it('skips everything else - a relay group nobody opted out of, a closed group without a flag, a 1:1', () => {
    expect(planRelayOptOutBackfill({ type: 'relay_group', status: 'open' })).toBe('skip');
    expect(planRelayOptOutBackfill({ type: 'relay_group', status: 'closed', relay_opted_out_members: OPTED })).toBe('skip');
    expect(planRelayOptOutBackfill({ type: 'tenant_1to1', status: 'open' })).toBe('skip');
  });
});

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

describe.skipIf(!reachable)('backfillRelayOptOutFlag against DynamoDB Local', () => {
  const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const table = tableName('conversations', env);
  const conversations = createConversationsRepo({ doc, env });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('conversations'), table);
  }, 120_000);
  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('stamps legacy rows, removes stray flags, is idempotent, and the dry run writes nothing', async () => {
    // A legacy OPEN relay group whose member opted out before the index existed
    // (map present, no flag) - written the way the OLD primitive left it.
    const legacy = await conversations.createRelayGroup({
      poolNumber: '+15550600001',
      members: [{ contactId: 'c1', phone: '+15550100301' }],
    });
    await conversations.setRelayMemberOptedOut(legacy.conversationId, 'c1', OPTED.c1);
    // Strip the flag the NEW primitive stamped, to model the legacy row.
    await doc.send(
      new (await import('@aws-sdk/lib-dynamodb')).UpdateCommand({
        TableName: table,
        Key: { conversationId: legacy.conversationId },
        UpdateExpression: 'REMOVE relay_optout_flag',
      }),
    );
    // A CLOSED group wrongly carrying the flag (a lost race).
    const closed = await conversations.createRelayGroup({
      poolNumber: '+15550600002',
      members: [{ contactId: 'c2', phone: '+15550100302' }],
    });
    await conversations.setRelayMemberOptedOut(closed.conversationId, 'c2', { contactId: 'c2', at: OPTED.c1.at });
    await doc.send(
      new (await import('@aws-sdk/lib-dynamodb')).UpdateCommand({
        TableName: table,
        Key: { conversationId: closed.conversationId },
        UpdateExpression: 'SET #s = :closed, relay_status = :rs, relay_optout_flag = :flag',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':closed': 'closed', ':rs': 'relay_group#closed', ':flag': 'attention' },
      }),
    );
    // A healthy relay group nobody opted out of.
    await conversations.createRelayGroup({ poolNumber: '+15550600003', members: [{ contactId: 'c3', phone: '+15550100303' }] });

    const dry = await backfillRelayOptOutFlag({ dryRun: true, doc, env });
    expect(dry).toMatchObject({ stamped: 1, removed: 1, skipped: 1 });
    expect((await conversations.getById(legacy.conversationId))?.relay_optout_flag).toBeUndefined();

    const live = await backfillRelayOptOutFlag({ doc, env });
    expect(live).toMatchObject({ stamped: 1, removed: 1, skipped: 1, skippedOnCondition: { stamp: 0, remove: 0 } });
    expect((await conversations.getById(legacy.conversationId))?.relay_optout_flag).toBe('attention');
    expect((await conversations.getById(closed.conversationId))?.relay_optout_flag).toBeUndefined();
    // Now on the index, exactly the legacy row.
    const onIndex = (await conversations.listRelayOptOutAttention({ limit: 100 })).items.map((c) => c.conversationId);
    expect(onIndex).toEqual([legacy.conversationId]);

    const again = await backfillRelayOptOutFlag({ doc, env });
    expect(again).toMatchObject({ stamped: 0, removed: 0, skipped: 3 });
  });
});
