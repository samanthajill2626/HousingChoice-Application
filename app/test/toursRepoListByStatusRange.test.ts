// toursRepo.listByStatus `createdAtFrom` (matching-blast-rules plan 2.3, spec
// D5): the open-tours read bounds the `requested` partition by the byStatus
// RANGE key (createdAt >= now - 14 days) in the KEY condition, so the index
// itself limits the read. Without the option the Query must be byte-for-byte
// today's unbounded one (tour auto-close and GET /api/tours?status= use it).
//
// The real repo is driven through a recording doc client (the
// repoPagingWiring.test.ts pattern - no DynamoDB); the harness fake, which
// every broadcastApi preview case runs against, must model the same bound.
// The DynamoDB Local twin is in toursRepo.integration.test.ts.
import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';

const logger = createLogger({ destination: createLogCapture().stream });

interface Page {
  Items: Record<string, unknown>[];
  LastEvaluatedKey?: Record<string, unknown>;
}

/** A doc client that serves `pages` in order and records every Query input. */
function recordingDoc(pages: Page[]) {
  const inputs: Array<Record<string, unknown>> = [];
  let call = 0;
  const doc = {
    send: async (cmd: { input: Record<string, unknown> }) => {
      inputs.push(cmd.input);
      const page = pages[call] ?? { Items: [] };
      call += 1;
      return page;
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, inputs };
}

const FROM = '2026-09-30T12:00:00.000Z';

describe('toursRepo.listByStatus createdAtFrom (plan 2.3)', () => {
  it('(PIN) without opts the Query is exactly the unbounded byStatus read', async () => {
    const { doc, inputs } = recordingDoc([{ Items: [{ tourId: 't1' }] }]);
    const repo = createToursRepo({ doc, logger });
    const rows = await repo.listByStatus('scheduled');
    expect(rows.map((r) => r.tourId)).toEqual(['t1']);
    expect(inputs).toHaveLength(1);
    const { TableName, ...rest } = inputs[0]!;
    expect(typeof TableName).toBe('string');
    expect(rest).toEqual({
      IndexName: 'byStatus',
      KeyConditionExpression: '#st = :st',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':st': 'scheduled' },
    });
  });

  it('with createdAtFrom the KEY condition bounds the range key: createdAt >= from', async () => {
    const { doc, inputs } = recordingDoc([{ Items: [{ tourId: 't1' }] }]);
    const repo = createToursRepo({ doc, logger });
    await repo.listByStatus('requested', { createdAtFrom: FROM });
    const { TableName, ...rest } = inputs[0]!;
    expect(typeof TableName).toBe('string');
    expect(rest).toEqual({
      IndexName: 'byStatus',
      KeyConditionExpression: '#st = :st AND #ca >= :from',
      ExpressionAttributeNames: { '#st': 'status', '#ca': 'createdAt' },
      ExpressionAttributeValues: { ':st': 'requested', ':from': FROM },
    });
  });

  it('with createdAtFrom it still walks EVERY page, the bound on each', async () => {
    const { doc, inputs } = recordingDoc([
      { Items: [{ tourId: 't1' }], LastEvaluatedKey: { k: 1 } },
      { Items: [{ tourId: 't2' }] },
    ]);
    const repo = createToursRepo({ doc, logger });
    const rows = await repo.listByStatus('requested', { createdAtFrom: FROM });
    expect(rows.map((r) => r.tourId)).toEqual(['t1', 't2']);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!['ExclusiveStartKey']).toBeUndefined();
    expect(inputs[1]).toMatchObject({
      KeyConditionExpression: '#st = :st AND #ca >= :from',
      ExpressionAttributeValues: { ':st': 'requested', ':from': FROM },
      ExclusiveStartKey: { k: 1 },
    });
  });

  it('the harness fake models the bound: createdAt >= from (inclusive), in createdAt order', async () => {
    const world = createFakeWorld();
    const make = (createdAt: string) =>
      world.toursRepo.create({ tenantId: 'c-range', unitId: 'u-range', tourType: 'self_guided', createdAt });
    const after = await make('2026-10-05T12:00:00.000Z');
    const before = await make('2026-09-30T11:59:59.999Z');
    const atBound = await make(FROM);
    const bounded = await world.toursRepo.listByStatus('requested', { createdAtFrom: FROM });
    expect(bounded.map((t) => t.tourId)).toEqual([atBound.tourId, after.tourId]);
    const all = await world.toursRepo.listByStatus('requested');
    expect(all.map((t) => t.tourId)).toEqual([before.tourId, atBound.tourId, after.tourId]);
  });
});
