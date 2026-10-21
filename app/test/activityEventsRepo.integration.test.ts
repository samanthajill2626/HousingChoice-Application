// BE2/C2 integration tests against DynamoDB Local — the activity-events repo:
// record() several milestones for a contact, listByContact() returns them
// newest-first, the `before` bound paginates with no dups/skips, and events for
// a different contact are fully isolated (the PK partition).
// flyer-leads D6 adds hasEventSince, the public sign-up's repeat check: the
// window edge, the type filter, ref vs no ref, the partition, paging to the
// end of the window, and a throw on a DynamoDB error.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createActivityEventsRepo } from '../src/repos/activityEventsRepo.js';
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
    `[activityEventsRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('activityEventsRepo against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createActivityEventsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(
      client,
      getTableSpec('activity_events'),
      tableName('activity_events', testEnv),
    );
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('activity_events', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('record generates ids + tsEventId and returns the stored item', async () => {
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    const item = await repo.record({
      contactId,
      type: 'placement_opened',
      label: 'Placement opened',
      refType: 'placement',
      refId: 'placement-1',
      at: '2026-06-16T10:00:00.000Z',
    });
    expect(item.eventId).toMatch(/^evt-/);
    expect(item.tsEventId).toBe(`2026-06-16T10:00:00.000Z#${item.eventId}`);
    expect(item.type).toBe('placement_opened');
    expect(item.refType).toBe('placement');
    expect(item.refId).toBe('placement-1');
    expect(item.created_at).toBeDefined();
    expect(item).not.toHaveProperty('broadcastId');
  });

  it('share-sent-outcome D6: record stores a listing_sent milestone share id, and the read returns it', async () => {
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    const item = await repo.record({
      contactId,
      type: 'listing_sent',
      label: 'Property sent',
      refType: 'unit',
      refId: 'unit-1',
      broadcastId: 'bcast-1',
      at: '2026-06-16T10:00:00.000Z',
    });
    expect(item.broadcastId).toBe('bcast-1');
    const { items } = await repo.listByContact(contactId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'listing_sent', refType: 'unit', refId: 'unit-1', broadcastId: 'bcast-1' });
  });

  it('listByContact returns events newest-first', async () => {
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    await repo.record({ contactId, type: 'placement_opened', label: 'a', at: '2026-06-16T10:00:00.000Z' });
    await repo.record({ contactId, type: 'tour_scheduled', label: 'b', at: '2026-06-16T11:00:00.000Z' });
    await repo.record({ contactId, type: 'stage_changed', label: 'c', at: '2026-06-16T12:00:00.000Z' });

    const { items } = await repo.listByContact(contactId);
    expect(items.map((e) => e.type)).toEqual(['stage_changed', 'tour_scheduled', 'placement_opened']);
  });

  it('before paginates backward with no dups or skips', async () => {
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) {
      await repo.record({
        contactId,
        type: 'stage_changed',
        label: `s${i}`,
        // Distinct, sortable timestamps (oldest first by i).
        at: `2026-06-16T1${i}:00:00.000Z`,
      });
    }
    const collected: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = await repo.listByContact(contactId, {
        limit: 2,
        ...(before !== undefined && { before }),
      });
      collected.push(...page.items.map((e) => e.tsEventId));
      before = page.items.at(-1)?.tsEventId;
      pages += 1;
      if (page.items.length < 2) break;
    } while (before !== undefined && pages < 10);

    expect(new Set(collected).size).toBe(5); // no dups or skips
    expect(pages).toBeGreaterThanOrEqual(3); // really paginated (2+2+1)
    // Whole set is descending across the pages.
    const sorted = [...collected].sort().reverse();
    expect(collected).toEqual(sorted);
  });

  it('isolates events by contact (the PK partition)', async () => {
    const a = `contact-${randomUUID().slice(0, 8)}`;
    const b = `contact-${randomUUID().slice(0, 8)}`;
    await repo.record({ contactId: a, type: 'number_added', label: 'a1' });
    await repo.record({ contactId: b, type: 'number_added', label: 'b1' });
    await repo.record({ contactId: b, type: 'placement_closed', label: 'b2' });

    const aPage = await repo.listByContact(a);
    const bPage = await repo.listByContact(b);
    expect(aPage.items).toHaveLength(1);
    expect(bPage.items).toHaveLength(2);
    expect(aPage.items.every((e) => e.contactId === a)).toBe(true);
    expect(bPage.items.every((e) => e.contactId === b)).toBe(true);
  });

  // flyer-leads D6: hasEventSince - one pin per contact per source per 24
  // hours. sinceIso bounds the `<ISO at>#<eventId>` key EXCLUSIVELY, so an
  // event AT sinceIso (its key extends the bound) is inside the window and
  // one a millisecond before sinceIso is not.
  describe('hasEventSince (flyer-leads D6)', () => {
    const T0 = '2026-10-21T12:00:00.000Z';
    const BEFORE = '2026-10-21T11:59:59.999Z';
    const AFTER = '2026-10-21T12:00:00.001Z';
    const newContact = (): string => `contact-${randomUUID().slice(0, 8)}`;

    it('the window edge: an event AT sinceIso counts; one a millisecond before sinceIso does not', async () => {
      const contactId = newContact();
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(false);
      await repo.record({
        contactId,
        type: 'signed_up',
        label: 'Signed up from the flyer for 1 Main St as Ann Lee',
        refType: 'unit',
        refId: 'unit-1',
        at: T0,
      });
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(true);
      expect(await repo.hasEventSince(contactId, 'signed_up', T0, 'unit-1')).toBe(true);
      expect(await repo.hasEventSince(contactId, 'signed_up', AFTER, 'unit-1')).toBe(false);
    });

    it('the type filter: another milestone type with the same ref never counts', async () => {
      const contactId = newContact();
      await repo.record({ contactId, type: 'listing_sent', label: 'Property sent', refType: 'unit', refId: 'unit-1', at: T0 });
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(false);
      expect(await repo.hasEventSince(contactId, 'listing_sent', BEFORE, 'unit-1')).toBe(true);
    });

    it('ref vs no ref: undefined matches only an event with NO refId; a refId matches only its own', async () => {
      const contactId = newContact();
      await repo.record({
        contactId,
        type: 'signed_up',
        label: 'Signed up from the flyer for 2 Elm St as Ann Lee',
        refType: 'unit',
        refId: 'unit-2',
        at: T0,
      });
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, undefined)).toBe(false);
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(false);
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-2')).toBe(true);
      await repo.record({ contactId, type: 'signed_up', label: 'Signed up on the join page as Ann Lee', at: T0 });
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, undefined)).toBe(true);
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(false);
    });

    it('the contact partition: another contact event never counts', async () => {
      const a = newContact();
      const b = newContact();
      await repo.record({ contactId: a, type: 'signed_up', label: 'Signed up on the join page as Ann Lee', at: T0 });
      expect(await repo.hasEventSince(b, 'signed_up', BEFORE, undefined)).toBe(false);
      expect(await repo.hasEventSince(a, 'signed_up', BEFORE, undefined)).toBe(true);
    });

    it('pages to the END of the window: a match between filtered-out rows is found at one row per page', async () => {
      const contactId = newContact();
      const at = (second: number): string => `2026-10-21T12:00:0${second}.000Z`;
      await repo.record({ contactId, type: 'listing_sent', label: 'Property sent', refType: 'unit', refId: 'unit-1', at: at(1) });
      await repo.record({ contactId, type: 'stage_changed', label: 's', at: at(2) });
      await repo.record({ contactId, type: 'signed_up', label: 'Signed up on the join page as Ann Lee', at: at(3) });
      await repo.record({ contactId, type: 'listing_sent', label: 'Property sent', refType: 'unit', refId: 'unit-1', at: at(4) });
      await repo.record({ contactId, type: 'stage_changed', label: 's', at: at(5) });
      // Limit 1 on EVERY Query the repo sends: a read that stops after one
      // page sees only the first (or, newest-first, the last) row - neither
      // matches - and answers false. The match is the third row.
      let queries = 0;
      const onePerPageDoc = {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) {
            queries += 1;
            return doc.send(new QueryCommand({ ...command.input, Limit: 1 }));
          }
          return doc.send(command as never);
        },
      } as unknown as DynamoDBDocumentClient;
      const pagingRepo = createActivityEventsRepo({ doc: onePerPageDoc, env: testEnv, logger });
      expect(await pagingRepo.hasEventSince(contactId, 'signed_up', T0, undefined)).toBe(true);
      expect(queries).toBeGreaterThanOrEqual(3);
    });

    it('throws on a DynamoDB error (the sign-up handler is the one that fails open)', async () => {
      const failingDoc = {
        send: async () => {
          throw new Error('dynamo unavailable');
        },
      } as unknown as DynamoDBDocumentClient;
      const failingRepo = createActivityEventsRepo({ doc: failingDoc, env: testEnv, logger });
      await expect(failingRepo.hasEventSince('contact-x', 'signed_up', T0, undefined)).rejects.toThrow('dynamo unavailable');
    });
  });
});
