// flyer-leads AR12 (plan 2.5, plan review R1 #5): hasEventSince - the public
// sign-up's repeat check - reads STRONGLY CONSISTENT, so a sign-up that starts
// after another's pin was written sees that pin (an eventually consistent
// Query could miss it and let both pin and bump). It stays a read, not a
// claim: two OVERLAPPING same-source sign-ups can still both pin
// (docs/issues/public-signup-abuse-hardening.md). Every page of the walk
// carries it.
//
// Pure: a stub DocumentClient records every QueryCommand input (the
// contactsRepoConsistentBatchRead.test.ts pattern). DynamoDB Local's
// acceptance of the consistent Query is exercised by
// activityEventsRepo.integration.test.ts.
import { QueryCommand, type DynamoDBDocumentClient, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createActivityEventsRepo } from '../src/repos/activityEventsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const SINCE = '2026-10-20T12:00:00.000Z';
const CURSOR = { contactId: 'c-1', tsEventId: '2026-10-21T12:00:00.000Z#evt-x' };

/** A table that answers two pages: an EMPTY first page that still carries a cursor, then nothing. */
function stubDoc() {
  const requests: QueryCommandInput[] = [];
  const doc = {
    async send(command: unknown) {
      if (!(command instanceof QueryCommand)) throw new Error('stub: expected a QueryCommand');
      requests.push(command.input);
      return requests.length === 1 ? { Items: [], LastEvaluatedKey: CURSOR } : { Items: [] };
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, requests };
}

function makeRepo(doc: DynamoDBDocumentClient) {
  const logger = createLogger({ destination: createLogCapture().stream });
  return createActivityEventsRepo({ doc, env: { TABLE_PREFIX: 'hc-test-x-' }, logger });
}

describe('activityEventsRepo.hasEventSince - ConsistentRead (flyer-leads AR12)', () => {
  it('every page of the window read is strongly consistent, on the key-range query plan 2.5 binds', async () => {
    const { doc, requests } = stubDoc();

    expect(await makeRepo(doc).hasEventSince('c-1', 'signed_up', SINCE, 'unit-1')).toBe(false);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        TableName: 'hc-test-x-activity_events',
        ConsistentRead: true,
        KeyConditionExpression: 'contactId = :c AND tsEventId > :since',
        FilterExpression: '#type = :type AND refId = :ref',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':c': 'c-1', ':since': SINCE, ':type': 'signed_up', ':ref': 'unit-1' },
      });
    }
    expect(requests[1]?.ExclusiveStartKey).toEqual(CURSOR);
  });

  it('the no-ref source filters on attribute_not_exists(refId), binds no :ref, and is consistent too', async () => {
    const { doc, requests } = stubDoc();

    await makeRepo(doc).hasEventSince('c-1', 'signed_up', SINCE, undefined);

    expect(requests[0]).toMatchObject({
      ConsistentRead: true,
      FilterExpression: '#type = :type AND attribute_not_exists(refId)',
    });
    expect(requests[0]?.ExpressionAttributeValues).not.toHaveProperty(':ref');
  });
});
