// The two machine writers the org rewrite and the cleanup script use (plan
// 3.7): contactsRepo.rewriteOrgFields and unitsRepo.rewriteAcceptedAuthorities.
// Every case runs against BOTH the real repos (DynamoDB Local) and the harness
// world fakes and must answer the same - a fake that disagrees with its repo
// lets the rewrite suites pass against behavior production never has (the
// twilioWebhookHarnessRepoAdditions.integration.test.ts idiom). The fake half
// runs without Docker; the real half self-skips.
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createContactsRepo,
  EmptyIndexKeyError,
  type ContactItem,
  type ContactsRepo,
} from '../src/repos/contactsRepo.js';
import { quietLogger } from './helpers/orgFixtures.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

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
    `[orgRecordWriters.integration] DynamoDB Local half SKIPPED - nothing at ${endpoint}. ` +
      'Run `npm run db:start` to exercise it.',
  );
}

const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const contactsTable = tableName('contacts', testEnv);

beforeAll(async () => {
  if (!reachable) return;
  await ensureTable(client, getTableSpec('contacts'), contactsTable);
}, 120_000);

afterAll(async () => {
  if (reachable) {
    await deleteTableIfExists(client, contactsTable);
  }
  doc.destroy();
  client.destroy();
}, 120_000);

/** One implementation under test: the writers plus raw seed/read access. */
interface Writers {
  contacts: Pick<ContactsRepo, 'rewriteOrgFields'>;
  putContact(item: ContactItem): Promise<void>;
  readContact(contactId: string): Promise<ContactItem | undefined>;
}

function realWriters(): Writers {
  const logger = quietLogger();
  return {
    contacts: createContactsRepo({ doc, env: testEnv, logger }),
    async putContact(item) {
      await doc.send(new PutCommand({ TableName: contactsTable, Item: item }));
    },
    async readContact(contactId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: contactsTable, Key: { contactId }, ConsistentRead: true }),
      );
      return Item as ContactItem | undefined;
    },
  };
}

function fakeWriters(): Writers {
  const world = createFakeWorld();
  return {
    contacts: world.contactsRepo,
    async putContact(item) {
      world.contacts.push(structuredClone(item));
    },
    async readContact(contactId) {
      const hit = world.contacts.find((c) => c.contactId === contactId);
      return hit === undefined ? undefined : structuredClone(hit);
    },
  };
}

/** One case against the harness fake (always) and DynamoDB Local (when reachable). */
function parity(name: string, run: (w: Writers, id: string) => Promise<void>): void {
  it(`${name} [harness fake]`, async () => {
    await run(fakeWriters(), `fake-${randomUUID().slice(0, 8)}`);
  });
  it.skipIf(!reachable)(`${name} [DynamoDB Local]`, async () => {
    await run(realWriters(), `real-${randomUUID().slice(0, 8)}`);
  });
}

describe('contactsRepo.rewriteOrgFields (plan 3.7)', () => {
  parity('SETs a field while it still holds the expected text, and touches nothing else', async (w, id) => {
    await w.putContact({
      contactId: id,
      type: 'tenant',
      status: 'searching',
      housingAuthority: 'AHA',
      classification_revision: 3,
      firstName: 'Tia',
    });
    expect(
      await w.contacts.rewriteOrgFields(id, { housingAuthority: 'AHA' }, { housingAuthority: 'Atlanta Housing Authority' }),
    ).toBe('written');
    // No classification fence bump, no stamps: a machine rewrite is not a triage.
    expect(await w.readContact(id)).toEqual({
      contactId: id,
      type: 'tenant',
      status: 'searching',
      housingAuthority: 'Atlanta Housing Authority',
      classification_revision: 3,
      firstName: 'Tia',
    });
  });

  parity('skips, writing nothing, when the record no longer holds the expected text', async (w, id) => {
    await w.putContact({ contactId: id, type: 'tenant', status: 'searching', housingAuthority: 'Edited Meanwhile' });
    expect(
      await w.contacts.rewriteOrgFields(id, { housingAuthority: 'AHA' }, { housingAuthority: 'Atlanta Housing Authority' }),
    ).toBe('skipped');
    expect((await w.readContact(id))?.['housingAuthority']).toBe('Edited Meanwhile');
  });

  parity('REMOVEs housingAuthority on null, and refuses an empty string before any write', async (w, id) => {
    await w.putContact({ contactId: id, type: 'tenant', status: 'searching', housingAuthority: 'Bad' });
    await expect(
      w.contacts.rewriteOrgFields(id, { housingAuthority: 'Bad' }, { housingAuthority: '' }),
    ).rejects.toBeInstanceOf(EmptyIndexKeyError);
    expect((await w.readContact(id))?.['housingAuthority']).toBe('Bad');
    expect(await w.contacts.rewriteOrgFields(id, { housingAuthority: 'Bad' }, { housingAuthority: null })).toBe('written');
    expect(await w.readContact(id)).not.toHaveProperty('housingAuthority');
  });

  parity('guards BOTH attributes - null means absent, so an empty agency is not absent', async (w, id) => {
    const a = `${id}-a`;
    const b = `${id}-b`;
    await w.putContact({ contactId: a, type: 'tenant', status: 'searching', housingAuthority: 'HUD VASH' });
    await w.putContact({ contactId: b, type: 'tenant', status: 'searching', housingAuthority: 'HUD VASH', agency: '' });
    const move = { housingAuthority: null, agency: 'HUD-VASH Program' };
    expect(await w.contacts.rewriteOrgFields(a, { housingAuthority: 'HUD VASH', agency: null }, move)).toBe('written');
    const movedA = await w.readContact(a);
    expect(movedA).not.toHaveProperty('housingAuthority');
    expect(movedA?.['agency']).toBe('HUD-VASH Program');
    expect(await w.contacts.rewriteOrgFields(b, { housingAuthority: 'HUD VASH', agency: null }, move)).toBe('skipped');
    expect(await w.contacts.rewriteOrgFields(b, { housingAuthority: 'HUD VASH', agency: '' }, move)).toBe('written');
  });

  parity('stores a cleared agency as an empty string (spec D5)', async (w, id) => {
    await w.putContact({ contactId: id, type: 'partner', status: 'active', agency: 'Steps' });
    expect(await w.contacts.rewriteOrgFields(id, { agency: 'Steps' }, { agency: '' })).toBe('written');
    expect((await w.readContact(id))?.['agency']).toBe('');
  });

  parity('skips an unknown contact', async (w, id) => {
    expect(
      await w.contacts.rewriteOrgFields(`${id}-missing`, { housingAuthority: 'AHA' }, { housingAuthority: 'X' }),
    ).toBe('skipped');
  });
});
