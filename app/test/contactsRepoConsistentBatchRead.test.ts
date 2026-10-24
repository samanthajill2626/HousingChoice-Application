// contactsRepo.getManyByIds({ consistentRead }) - primary-contact-integrity
// planner fix wave F5a (Cameron 2026-10-13): the restore paths ("Restore
// without a landlord" and the landlord swap) read contact liveness STRONGLY
// CONSISTENT again. Asked for it, batchGetByIds sends `ConsistentRead: true`
// in the contacts table's RequestItems entry - on EVERY request it makes, a
// second 100-key chunk and an UnprocessedKeys retry included. Not asked, the
// read is what it always was: eventually consistent, no ConsistentRead at
// all - every other caller (the property GET, the roster writes, the delete
// fan-out, the backfill script) and every display read stays there.
//
// Pure: a stub DocumentClient records every BatchGetCommand input (the
// unitsRepoDisplays.test.ts pattern). DynamoDB Local's acceptance of the
// consistent BatchGet is pinned in contactsRepo.integration.test.ts.
import { BatchGetCommand, type BatchGetCommandInput, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

/** tableName('contacts', env) is TABLE_PREFIX + 'contacts'. */
const TABLE = 'hc-test-x-contacts';

type Key = { contactId: string };

/**
 * A table that serves every key it is asked for - except, on the FIRST
 * request only, its last `withholdOnce` keys, left in UnprocessedKeys (one
 * throttle the walk's retry then clears).
 */
function stubDoc(withholdOnce = 0) {
  const requests: BatchGetCommandInput[] = [];
  const doc = {
    async send(command: unknown) {
      if (!(command instanceof BatchGetCommand)) throw new Error('stub: expected a BatchGetCommand');
      requests.push(command.input);
      const keys = (command.input.RequestItems?.[TABLE]?.Keys ?? []) as Key[];
      const withheld = requests.length === 1 ? keys.slice(keys.length - withholdOnce) : [];
      const served = keys.slice(0, keys.length - withheld.length);
      return {
        Responses: { [TABLE]: served.map(({ contactId }) => ({ contactId, type: 'landlord' })) },
        ...(withheld.length > 0 && { UnprocessedKeys: { [TABLE]: { Keys: withheld } } }),
      };
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, requests };
}

function makeRepo(doc: DynamoDBDocumentClient) {
  const logger = createLogger({ destination: createLogCapture().stream });
  return createContactsRepo({ doc, env: { TABLE_PREFIX: 'hc-test-x-' }, logger });
}

/** The contacts table's RequestItems entry of one recorded request. */
const entryOf = (request: BatchGetCommandInput | undefined) => request?.RequestItems?.[TABLE];

describe('contactsRepo.getManyByIds - consistentRead (primary-contact-integrity fix wave F5a)', () => {
  it('asked for it: ConsistentRead true in the contacts table entry, beside the keys', async () => {
    const { doc, requests } = stubDoc();
    const contacts = makeRepo(doc);

    const found = await contacts.getManyByIds(['c-1', 'c-2'], { requireComplete: true, consistentRead: true });

    expect(found.size).toBe(2);
    expect(requests).toHaveLength(1);
    expect(entryOf(requests[0])).toEqual({
      Keys: [{ contactId: 'c-1' }, { contactId: 'c-2' }],
      ConsistentRead: true,
    });
  });

  it('every request carries it: a second 100-key chunk and an UnprocessedKeys retry', async () => {
    const { doc, requests } = stubDoc(1);
    const contacts = makeRepo(doc);
    const ids = Array.from({ length: 150 }, (_, i) => `c-${String(i).padStart(3, '0')}`);

    const found = await contacts.getManyByIds(ids, { requireComplete: true, consistentRead: true });

    expect(found.size).toBe(150);
    // Chunk 1 (one key withheld), its retry of that key, then chunk 2.
    expect(requests.map((request) => entryOf(request)?.Keys?.length)).toEqual([100, 1, 50]);
    for (const request of requests) expect(entryOf(request)).toMatchObject({ ConsistentRead: true });
  });

  it('not asked (the default, requireComplete alone, or false): no ConsistentRead at all', async () => {
    const { doc, requests } = stubDoc();
    const contacts = makeRepo(doc);

    await contacts.getManyByIds(['c-1']);
    await contacts.getManyByIds(['c-1'], { requireComplete: true });
    await contacts.getManyByIds(['c-1'], { requireComplete: true, consistentRead: false });

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(entryOf(request)).toEqual({ Keys: [{ contactId: 'c-1' }] });
    }
  });

  it('the display reads never send it', async () => {
    const { doc, requests } = stubDoc();
    const contacts = makeRepo(doc);

    await contacts.getDisplaysByIds(['c-1']);
    await contacts.getRecipientDisplaysByIds(['c-1'], { requireComplete: true });

    expect(requests).toHaveLength(2);
    for (const request of requests) expect(entryOf(request)).not.toHaveProperty('ConsistentRead');
  });
});

// today-checklist spec 6.1 (plan ruling PR3): Today's quiet-shares read asks
// the RECIPIENT projection for a consistent batch, so the refetch a stamp's
// event triggers sees the stamp. The same walk, so the same every-request
// rule; the projection rides along unchanged.
describe('contactsRepo.getRecipientDisplaysByIds - consistentRead (today-checklist PR3)', () => {
  it('asked for it: ConsistentRead true beside the recipient projection, on every request', async () => {
    const { doc, requests } = stubDoc(1);
    const contacts = makeRepo(doc);
    const ids = Array.from({ length: 150 }, (_, i) => `c-${String(i).padStart(3, '0')}`);

    const found = await contacts.getRecipientDisplaysByIds(ids, { requireComplete: true, consistentRead: true });

    expect(found.size).toBe(150);
    // Chunk 1 (one key withheld), its retry of that key, then chunk 2.
    expect(requests.map((request) => entryOf(request)?.Keys?.length)).toEqual([100, 1, 50]);
    for (const request of requests) {
      expect(entryOf(request)).toMatchObject({
        ConsistentRead: true,
        ProjectionExpression: expect.stringContaining('#lastReachedOutAt'),
      });
    }
  });

  it('(PIN) consistentRead false or absent: no ConsistentRead at all', async () => {
    const { doc, requests } = stubDoc();
    const contacts = makeRepo(doc);

    await contacts.getRecipientDisplaysByIds(['c-1']);
    await contacts.getRecipientDisplaysByIds(['c-1'], { requireComplete: true, consistentRead: false });

    expect(requests).toHaveLength(2);
    for (const request of requests) expect(entryOf(request)).not.toHaveProperty('ConsistentRead');
  });
});
