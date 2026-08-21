// A BatchGet that leaves keys UNPROCESSED is not the same thing as a contact
// that does not exist - and the difference decides whether a broadcast reaches
// everyone the operator selected.
//
// Adversarial review r1 finding 1: `batchGetByIds` retries `UnprocessedKeys`
// four times and then drops what is left, returning a SHORT map. That policy is
// right for the five display-enrichment callers (a row renders without a name)
// and WRONG for the broadcast send path, where an absent key means the tenant
// never receives the message. The pre-batch code could not do this: a
// persistently throttled GetItem exhausted the SDK's retries and THREW, so the
// route 500'd and left the broadcast a re-sendable draft.
//
// The route's own sibling branch already refuses to send an incomplete set
// ("resolution was truncated -> the set is INCOMPLETE; sending would silently
// under-deliver"), so silently accepting one here contradicted the endpoint's
// stated posture.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  defineJobHandler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import { createLogger } from '../src/lib/logger.js';
import {
  createContactsRepo,
  IncompleteBatchReadError,
  type ContactItem,
} from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const testEnv = { TABLE_PREFIX: 'hc-batchtest-' };

/**
 * A DocumentClient stub that answers BatchGet with whatever the caller asked
 * for MINUS `withhold` keys per request, reporting those as UnprocessedKeys -
 * i.e. a table that is throttling and never catches up.
 */
function stubDoc(opts: { withholdPerRequest: number; items?: ContactItem[] }) {
  const calls: number[] = [];
  const doc = {
    async send(command: { input: Record<string, unknown> }) {
      const requestItems = command.input['RequestItems'] as Record<
        string,
        { Keys: Array<{ contactId: string }> }
      >;
      const table = Object.keys(requestItems)[0]!;
      const keys = requestItems[table]!.Keys;
      calls.push(keys.length);
      const served = keys.slice(0, Math.max(0, keys.length - opts.withholdPerRequest));
      const withheld = keys.slice(served.length);
      return {
        Responses: {
          [table]: served.map(
            ({ contactId }) =>
              opts.items?.find((c) => c.contactId === contactId) ?? {
                contactId,
                type: 'tenant',
                phone: `+1555030${contactId.slice(-4).padStart(4, '0')}`,
              },
          ),
        },
        ...(withheld.length > 0 && { UnprocessedKeys: { [table]: { Keys: withheld } } }),
      };
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, calls };
}

describe('contactsRepo.getManyByIds - incomplete batch reads', () => {
  const logger = createLogger({ destination: createLogCapture().stream });

  it('DROPS unprocessed keys by default, so display callers degrade instead of throwing', async () => {
    const { doc } = stubDoc({ withholdPerRequest: 2 });
    const contacts = createContactsRepo({ doc, env: testEnv, logger });

    const found = await contacts.getManyByIds(['c-1', 'c-2', 'c-3', 'c-4', 'c-5']);

    // Two keys never came back; the caller sees a short map, not an error.
    expect(found.size).toBe(3);
  });

  it('THROWS under requireComplete, so a caller that cannot tolerate a short map finds out', async () => {
    const { doc } = stubDoc({ withholdPerRequest: 2 });
    const contacts = createContactsRepo({ doc, env: testEnv, logger });

    await expect(
      contacts.getManyByIds(['c-1', 'c-2', 'c-3', 'c-4', 'c-5'], { requireComplete: true }),
    ).rejects.toBeInstanceOf(IncompleteBatchReadError);
  });

  it('does NOT throw under requireComplete when every key is served', async () => {
    const { doc } = stubDoc({ withholdPerRequest: 0 });
    const contacts = createContactsRepo({ doc, env: testEnv, logger });

    const found = await contacts.getManyByIds(['c-1', 'c-2'], { requireComplete: true });

    expect(found.size).toBe(2);
  });

  it('a genuinely MISSING contact is not an incomplete read - requireComplete stays quiet', async () => {
    // The table answers every key it was asked for; 'c-ghost' simply has no row.
    const doc = {
      async send(command: { input: Record<string, unknown> }) {
        const requestItems = command.input['RequestItems'] as Record<
          string,
          { Keys: Array<{ contactId: string }> }
        >;
        const table = Object.keys(requestItems)[0]!;
        const keys = requestItems[table]!.Keys;
        return {
          Responses: {
            [table]: keys
              .filter(({ contactId }) => contactId !== 'c-ghost')
              .map(({ contactId }) => ({ contactId, type: 'tenant' })),
          },
        };
      },
    } as unknown as DynamoDBDocumentClient;
    const contacts = createContactsRepo({ doc, env: testEnv, logger });

    const found = await contacts.getManyByIds(['c-1', 'c-ghost'], { requireComplete: true });

    expect(found.size).toBe(1);
    expect(found.has('c-ghost')).toBe(false);
  });

  it('a chunk that THROWS mid-walk keeps the chunks that already succeeded', async () => {
    // Adversarial review r1 finding 2: `found` was function-local, so a reject
    // on chunk N discarded every name chunks 1..N-1 had already resolved.
    let call = 0;
    const doc = {
      async send(command: { input: Record<string, unknown> }) {
        call += 1;
        if (call === 2) throw new Error('dynamo throttled');
        const requestItems = command.input['RequestItems'] as Record<
          string,
          { Keys: Array<{ contactId: string }> }
        >;
        const table = Object.keys(requestItems)[0]!;
        return {
          Responses: {
            [table]: requestItems[table]!.Keys.map(({ contactId }) => ({
              contactId,
              type: 'tenant',
            })),
          },
        };
      },
    } as unknown as DynamoDBDocumentClient;
    const contacts = createContactsRepo({ doc, env: testEnv, logger });

    // 150 ids = two chunks; the second one throws.
    const ids = Array.from({ length: 150 }, (_, i) => `c-${i}`);
    const found = await contacts.getManyByIds(ids);

    // The first chunk's 100 survive rather than being thrown away with the second.
    expect(found.size).toBe(100);
  });
});

describe('broadcast send refuses a partial selection read', () => {
  let world: FakeWorld;
  let queueAdapter: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(createLogger({ destination: createLogCapture().stream }));
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    queueAdapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queueAdapter);
    defineJobHandler('broadcast.send', async () => {});
  });

  it('never turns a short contact read into a short send - the draft survives, re-sendable', async () => {
    for (const contactId of ['c-a', 'c-b', 'c-c']) {
      world.contacts.push({
        contactId,
        type: 'tenant',
        status: 'searching',
        phone: `+1555040000${contactId.slice(-1)}`,
        consent_method: 'inbound_text',
      } as ContactItem);
    }
    world.units.set('unit-1', {
      unitId: 'unit-1',
      landlordId: 'c-ll',
      status: 'available',
      beds: 2,
      rent_min: 1200,
      rent_max: 1400,
    });
    const { app } = makeWebhookHarness({ world });
    const draft = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        unitId: 'unit-1',
        body_template: 'hi',
        audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      });
    const broadcastId = draft.body.broadcastId as string;

    // The read cannot complete: one selected tenant's key stayed unprocessed.
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(
      new IncompleteBatchReadError(1, 3),
    );

    const res = await request(app)
      .post(`/api/broadcasts/${broadcastId}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-a', 'c-b', 'c-c'] });

    // Loudly refused - NOT a 200 reporting a send of 2.
    expect(res.status).toBeGreaterThanOrEqual(500);

    // And the broadcast is still a draft the operator can re-send: no recipients
    // snapshot was written, so nobody got a partial blast.
    const after = await world.broadcastsRepo.getById(broadcastId);
    expect(after?.status).toBe('draft');
    // markSending was never reached, so the recipients map is still the empty
    // one a draft is created with - nobody received a partial blast.
    expect(Object.keys(after?.recipients ?? {})).toEqual([]);
    await queueAdapter.settle();
  });
});
