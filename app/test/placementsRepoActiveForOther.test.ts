// placementsRepo.hasActivePlacementForOtherTenant (WP1 B2a spec D1; PR5): the
// paging (stub client) and the harness fake's parity. The real-engine cases
// are placementsRepoActiveForOther.integration.test.ts.
import { QueryCommand, type DynamoDBDocumentClient, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createPlacementsRepo } from '../src/repos/placementsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

type Page = { items: Record<string, unknown>[]; last?: Record<string, unknown> };

function stubQueryDoc(pages: Page[]) {
  const requests: QueryCommandInput[] = [];
  const doc = {
    async send(command: unknown) {
      if (!(command instanceof QueryCommand)) throw new Error('stub: expected a QueryCommand');
      requests.push(command.input);
      const page = pages[requests.length - 1];
      if (page === undefined) throw new Error('stub: no page scripted');
      return { Items: page.items, ...(page.last !== undefined && { LastEvaluatedKey: page.last }) };
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, requests };
}

function makeRepo(doc: DynamoDBDocumentClient) {
  const logger = createLogger({ destination: createLogCapture().stream });
  return createPlacementsRepo({ doc, env: { TABLE_PREFIX: 'hc-test-x-' }, logger });
}

const placement = (placementId: string, tenantId: string, stage: string) => ({
  placementId,
  tenantId,
  unitId: 'unit-1',
  stage,
});

describe('placementsRepo.hasActivePlacementForOtherTenant (stub client)', () => {
  it('queries byUnit for the unit and pages to the end', async () => {
    const { doc, requests } = stubQueryDoc([
      { items: [placement('p1', 'anchor', 'send_application'), placement('p2', 'other', 'moved_in')], last: { placementId: 'p2' } },
      { items: [placement('p3', 'other', 'awaiting_inspection')] },
    ]);

    expect(await makeRepo(doc).hasActivePlacementForOtherTenant('unit-1', 'anchor')).toBe(true);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.IndexName).toBe('byUnit');
      expect(request.ExpressionAttributeValues).toEqual({ ':v': 'unit-1' });
    }
    expect(requests[1]!.ExclusiveStartKey).toEqual({ placementId: 'p2' });
  });

  it('stops at the first page that answers', async () => {
    const { doc, requests } = stubQueryDoc([
      { items: [placement('p1', 'other', 'send_application')], last: { placementId: 'p1' } },
    ]);

    expect(await makeRepo(doc).hasActivePlacementForOtherTenant('unit-1', 'anchor')).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('false after every page when only the anchor or terminal placements exist', async () => {
    const { doc, requests } = stubQueryDoc([
      { items: [placement('p1', 'anchor', 'awaiting_move_in')], last: { placementId: 'p1' } },
      { items: [placement('p2', 'other', 'lost'), placement('p3', 'other', 'moved_in')] },
    ]);

    expect(await makeRepo(doc).hasActivePlacementForOtherTenant('unit-1', 'anchor')).toBe(false);
    expect(requests).toHaveLength(2);
  });
});

describe('the harness fake mirrors the repo', () => {
  it('own placement never counts; terminal never counts; another tenant active counts', async () => {
    const world = createFakeWorld();
    const placements = world.placementsRepo;
    await placements.create({ tenantId: 'anchor', unitId: 'unit-f', stage: 'send_application' });
    await placements.create({ tenantId: 'other', unitId: 'unit-f', stage: 'moved_in' });
    await placements.create({ tenantId: 'other', unitId: 'unit-f', stage: 'lost' });
    expect(await placements.hasActivePlacementForOtherTenant('unit-f', 'anchor')).toBe(false);

    await placements.create({ tenantId: 'other', unitId: 'unit-f', stage: 'awaiting_inspection' });
    expect(await placements.hasActivePlacementForOtherTenant('unit-f', 'anchor')).toBe(true);
    expect(await placements.hasActivePlacementForOtherTenant('unit-f', 'other')).toBe(true);
    expect(await placements.hasActivePlacementForOtherTenant('unit-none', 'anchor')).toBe(false);
  });
});
