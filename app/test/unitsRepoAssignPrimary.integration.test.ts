// primary-contact-integrity (spec section 8; plan C12, task S5.1): the real
// unitsRepo.assignPrimaryIfCurrent - the one-time assign-primary-contacts
// script's write. It sets the contact list and the primary_contact scalar
// ONLY while landlordId AND contacts[] are exactly what the caller read (the
// updateRosterIfCurrent guard), answers 'skipped' on a lost condition after
// ONE attempt with no re-read (a primary someone set after the read is never
// overwritten), creates nothing for a unit that is gone, and lets any other
// error through.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createUnitsRepo, type CreateUnitInput, type UnitContact, type UnitItem } from '../src/repos/unitsRepo.js';
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
    `[unitsRepoAssignPrimary.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const MARK: UnitContact = { contactId: 'c-mark', role: 'pm', primaryContact: false };
const MARK_PRIMARY: UnitContact = { ...MARK, primaryContact: true };

describe('unitsRepo.assignPrimaryIfCurrent - an error that is not a lost condition', () => {
  it('is thrown, never reported as skipped', async () => {
    const failing = {
      send: async () => {
        throw new Error('throttled');
      },
    } as unknown as DynamoDBDocumentClient;
    const repo = createUnitsRepo({
      doc: failing,
      env: { TABLE_PREFIX: 'hc-test-unreachable-' },
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const read = { unitId: 'u-1', status: 'setup', contacts: [MARK] } as unknown as UnitItem;
    await expect(
      repo.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).rejects.toThrow('throttled');
  });
});

describe.skipIf(!reachable)('unitsRepo.assignPrimaryIfCurrent against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });
  const table = (): string => tableName('units', testEnv);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), table());
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table());
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** An OWNERLESS unit - no landlordId attribute, the imported shape - read back consistently. */
  async function ownerless(contacts: UnitContact[]): Promise<UnitItem> {
    const created = await units.create({ status: 'setup', contacts } as unknown as CreateUnitInput);
    const read = await units.getById(created.unitId, { consistentRead: true });
    if (read === undefined) throw new Error('the unit just created is missing');
    return read;
  }

  async function stored(unitId: string): Promise<UnitItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table(), Key: { unitId }, ConsistentRead: true }));
    return Item as UnitItem | undefined;
  }

  /** A repo that counts the UpdateCommands it sends for `unitId`. */
  function countingRepo(unitId: string) {
    const counter = { writes: 0 };
    const countingDoc = Object.create(doc) as typeof doc;
    countingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) counter.writes += 1;
      return doc.send(command);
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: countingDoc, env: testEnv, logger }), counter };
  }

  it('writes the contact list and the scalar while landlordId and contacts are as read', async () => {
    const read = await ownerless([MARK]);
    expect(
      await units.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('written');
    const after = await stored(read.unitId);
    expect(after?.contacts).toEqual([MARK_PRIMARY]);
    expect(after?.primary_contact).toBe('c-mark');
    expect(after !== undefined && Object.prototype.hasOwnProperty.call(after, 'landlordId')).toBe(false);
  });

  it('aligns the scalar alone when the contact list is written back unchanged', async () => {
    const read = await ownerless([MARK_PRIMARY]);
    expect(
      await units.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('written');
    const after = await stored(read.unitId);
    expect(after?.contacts).toEqual([MARK_PRIMARY]);
    expect(after?.primary_contact).toBe('c-mark');
  });

  it('skips after ONE attempt - nothing written - when the contact list changed after the read', async () => {
    const read = await ownerless([MARK]);
    // Staff added the owner as the primary contact after the script read the unit.
    const concurrent: UnitContact[] = [MARK, { contactId: 'c-owner', role: 'owner', primaryContact: true }];
    await doc.send(
      new UpdateCommand({
        TableName: table(),
        Key: { unitId: read.unitId },
        UpdateExpression: 'SET #c = :c, #p = :p',
        ExpressionAttributeNames: { '#c': 'contacts', '#p': 'primary_contact' },
        ExpressionAttributeValues: { ':c': concurrent, ':p': 'c-owner' },
      }),
    );
    const { repo, counter } = countingRepo(read.unitId);
    expect(
      await repo.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('skipped');
    expect(counter.writes).toBe(1);
    const after = await stored(read.unitId);
    expect(after?.contacts).toEqual(concurrent);
    expect(after?.primary_contact).toBe('c-owner');
  });

  it('skips when a landlord of record was set after the read', async () => {
    const read = await ownerless([MARK]);
    await doc.send(
      new UpdateCommand({
        TableName: table(),
        Key: { unitId: read.unitId },
        UpdateExpression: 'SET #l = :l',
        ExpressionAttributeNames: { '#l': 'landlordId' },
        ExpressionAttributeValues: { ':l': 'c-claim' },
      }),
    );
    expect(
      await units.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('skipped');
    const after = await stored(read.unitId);
    expect(after?.contacts).toEqual([MARK]);
    expect(after?.primary_contact).toBeUndefined();
  });

  it('skips a unit that no longer exists, and creates nothing', async () => {
    const read = { unitId: `u-gone-${randomUUID()}`, status: 'setup', contacts: [MARK] } as unknown as UnitItem;
    expect(
      await units.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('skipped');
    expect(await stored(read.unitId)).toBeUndefined();
  });
});
