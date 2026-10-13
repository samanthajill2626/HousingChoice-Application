// primary-contact-integrity (spec 2026-10-12 section 4.4, P2, Cameron
// 2026-10-13): the real unitsRepo.addContact against DynamoDB Local. A roster
// write for contact X - an add, or an edit of X's own row - makes X, and only
// X, the primary contact when X is eligible for automatic routing and the
// attempt's own read has no LIVE flagged primary and no LIVE landlord of
// record (soft-deleted or missing counts as absent; the liveness read is the
// caller's opts.readContacts, called per attempt). A soft-deleted flagged
// primary that nobody replaces keeps its flag AND the scalar; with no row
// flagged after the write a stale scalar is REMOVEd; unknown liveness writes
// unpromoted; a soft-deleted contact is never made primary unless its row
// already is (PrimaryContactDeletedError).
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createUnitsRepo,
  PrimaryContactDeletedError,
  type UnitContact,
  type UnitItem,
} from '../src/repos/unitsRepo.js';
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
    `[unitsRepoPrimaryOnAdd.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const GONE = '2026-10-01T09:00:00.000Z';
/** ContactListFacts for a live contact typed landlord (eligible for automatic routing). */
const LANDLORD_FACTS = { caseworker: false, landlordTyped: true, autoPrimaryEligible: true };
/** ...for a contact of another type (a tenant): never promoted automatically. */
const NOT_LANDLORD_FACTS = { caseworker: false, landlordTyped: false, autoPrimaryEligible: false };
/** ...for a SOFT-DELETED contact typed landlord. */
const DELETED_LANDLORD_FACTS = {
  caseworker: false,
  landlordTyped: true,
  autoPrimaryEligible: false,
  contactDeleted: true,
};

/** A contact record, typed landlord unless overridden. */
function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

/**
 * A liveness read (lib/propertyContact.ts RosterContactsRead) answering from
 * `known` - an id it does not know is MISSING, exactly as a complete batch
 * read of an absent contact - recording the ids of every call.
 */
function livenessFrom(known: ContactItem[]): {
  read: (ids: string[]) => Promise<RosterContactsRead>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const byId = new Map(known.map((c) => [c.contactId, c] as const));
  return {
    calls,
    read: async (ids) => {
      calls.push([...ids]);
      const found = new Map<string, ContactItem>();
      for (const id of ids) {
        const contact = byId.get(id);
        if (contact !== undefined) found.set(id, contact);
      }
      return { ok: true, byId: found };
    },
  };
}

/** A liveness read that failed (either shape - readRosterContacts answers both as { ok: false }). */
const failedRead = async (): Promise<RosterContactsRead> => ({ ok: false });

describe.skipIf(!reachable)('unitsRepo.addContact - P2 widened (spec 4.4) against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** An OWNERLESS unit (landlordId REMOVEd) with the given stored list and scalar. */
  async function ownerlessUnit(contacts?: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    await units.update(created.unitId, {
      landlordId: null,
      ...(contacts !== undefined && { contacts }),
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  /** A unit owned by `landlordId`, with the given stored list and scalar when supplied. */
  async function ownedUnit(landlordId: string, contacts?: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({
      landlordId,
      status: 'available',
      ...(contacts !== undefined && { contacts }),
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
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

  /** A repo whose FIRST read of `unitId` is followed by `race` (on the raw client). */
  function racingRepo(unitId: string, race: () => Promise<unknown>) {
    let raced = false;
    const racingDoc = Object.create(doc) as typeof doc;
    racingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      const result = await doc.send(command);
      if (!raced && command instanceof GetCommand && command.input.Key?.['unitId'] === unitId) {
        raced = true;
        await race();
      }
      return result;
    }) as typeof doc.send;
    return createUnitsRepo({ doc: racingDoc, env: testEnv, logger });
  }

  const primaries = (unit: UnitItem | undefined): string[] =>
    (unit?.contacts ?? []).filter((c) => c.primaryContact === true).map((c) => c.contactId);

  it('a soft-deleted flagged primary on an ownerless property: an eligible add becomes the primary, the deleted row is demoted', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');
    const liveness = livenessFrom([person('c-dead', { deleted_at: GONE })]);

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'pm', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-new');
    expect(liveness.calls).toEqual([['c-dead']]);
  });

  it('a flagged primary whose contact record is MISSING counts as absent', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-gone', role: 'pm', primaryContact: true }], 'c-gone');

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'owner' }, LANDLORD_FACTS, {
      readContacts: livenessFrom([]).read,
    });

    expect(primaries(updated)).toEqual(['c-new']);
    expect(updated.primary_contact).toBe('c-new');
  });

  it('a soft-deleted landlord of record and no flagged row: an eligible add becomes the primary; landlordId stays', async () => {
    const unitId = await ownedUnit('c-ll', [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }]);
    const liveness = livenessFrom([person('c-ll', { deleted_at: GONE })]);

    const updated = await units.addContact(unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    expect(updated.landlordId).toBe('c-ll');
    expect(liveness.calls).toEqual([['c-ll']]);
  });

  it('a landlord-only unit whose landlord of record is soft-deleted: the derived landlord row is demoted, the add is the primary', async () => {
    const unitId = await ownedUnit('c-ll');
    const liveness = livenessFrom([person('c-ll', { deleted_at: GONE })]);

    const updated = await units.addContact(unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    // The derived landlord row is BOTH the flagged primary and the landlord of record: read once.
    expect(liveness.calls).toEqual([['c-ll']]);
  });

  it('(PIN) a LIVE flagged primary: the add joins non-primary, the primary and the scalar are untouched', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-first', role: 'pm', primaryContact: true }], 'c-first');

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: livenessFrom([person('c-first')]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-first', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-first');
  });

  it('(PIN) a LIVE landlord of record beside a soft-deleted flagged primary: nothing promoted - the deleted row keeps its flag AND the scalar', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
      ],
      'c-dead',
    );

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: livenessFrom([person('c-ll'), person('c-dead', { deleted_at: GONE })]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('a contact NOT eligible for automatic routing: nobody is promoted and nothing is read - the soft-deleted primary keeps its flag and the scalar', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');
    const liveness = livenessFrom([person('c-dead', { deleted_at: GONE })]);

    const updated = await units.addContact(unitId, { contactId: 'c-ten', role: 'other' }, NOT_LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-dead');
    expect(liveness.calls).toEqual([]);
  });

  it('a write for one contact never promotes ANOTHER - an eligible row already on the list stays non-primary', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-eligible', role: 'pm', primaryContact: false },
      ],
      'c-dead',
    );

    const updated = await units.addContact(unitId, { contactId: 'c-ten', role: 'other' }, NOT_LANDLORD_FACTS, {
      readContacts: livenessFrom([person('c-dead', { deleted_at: GONE }), person('c-eligible')]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-eligible', role: 'pm', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('an edit of a seated contact (a role change) on a property with a soft-deleted primary makes THAT contact the primary', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-mark', role: 'pm', primaryContact: false },
      ],
      'c-dead',
    );

    const updated = await units.addContact(
      unitId,
      { contactId: 'c-mark', role: 'owner', primaryContact: false },
      LANDLORD_FACTS,
      { readContacts: livenessFrom([person('c-dead', { deleted_at: GONE })]).read },
    );

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
      { contactId: 'c-mark', role: 'owner', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-mark');
  });

  it('liveness unknown (the read failed): the add succeeds without a promotion - the deleted primary keeps its flag and the scalar', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: failedRead,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('(PIN) no readContacts supplied: main rule only - a flagged row blocks the promotion', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS);

    expect(primaries(updated)).toEqual(['c-dead']);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('no row flagged after the write: a stale primary_contact scalar is REMOVEd', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }],
      'c-gone',
    );

    const updated = await units.addContact(unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: livenessFrom([person('c-ll')]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBeUndefined();
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.primary_contact).toBeUndefined();
  });

  it('an explicit primaryContact false on the only primary row demotes it and REMOVEs the scalar', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-first', role: 'pm', primaryContact: true }], 'c-first');

    const updated = await units.addContact(
      unitId,
      { contactId: 'c-first', role: 'pm', primaryContact: false },
      LANDLORD_FACTS,
    );

    expect(updated.contacts).toEqual([{ contactId: 'c-first', role: 'pm', primaryContact: false }]);
    expect(updated.primary_contact).toBeUndefined();
  });

  it('a soft-deleted contact asked to be primary on a row that is not the primary: PrimaryContactDeletedError, nothing written', async () => {
    const unitId = await ownedUnit('c-ll');
    const { repo, counter } = countingRepo(unitId);

    await expect(
      repo.addContact(unitId, { contactId: 'c-dead', role: 'pm', primaryContact: true }, DELETED_LANDLORD_FACTS),
    ).rejects.toBeInstanceOf(PrimaryContactDeletedError);

    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toBeUndefined();
    expect(stored?.landlordId).toBe('c-ll');
  });

  it('a soft-deleted contact whose row IS already the primary: re-sending primaryContact true is not refused and changes nothing', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');

    const updated = await units.addContact(
      unitId,
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      DELETED_LANDLORD_FACTS,
    );

    expect(updated.contacts).toEqual([{ contactId: 'c-dead', role: 'pm', primaryContact: true }]);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('(PIN) a soft-deleted contact added NON-primary stays allowed', async () => {
    const unitId = await ownedUnit('c-ll');

    const updated = await units.addContact(unitId, { contactId: 'c-dead', role: 'pm' }, DELETED_LANDLORD_FACTS);

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true },
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-ll');
  });

  it('the liveness read is refreshed on every attempt: a live primary that lands after attempt 1 blocks the promotion on the retry', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');
    // Staff B makes c-live the primary right after attempt 1's read: attempt
    // 1 decides "promote" from its read, its write loses the roster
    // condition, and attempt 2 re-reads the unit AND the liveness.
    const racing = racingRepo(unitId, () =>
      doc.send(
        new UpdateCommand({
          TableName: tableName('units', testEnv),
          Key: { unitId },
          UpdateExpression: 'SET #c = :c, #p = :p',
          ExpressionAttributeNames: { '#c': 'contacts', '#p': 'primary_contact' },
          ExpressionAttributeValues: {
            ':c': [
              { contactId: 'c-dead', role: 'pm', primaryContact: false },
              { contactId: 'c-live', role: 'pm', primaryContact: true },
            ],
            ':p': 'c-live',
          },
        }),
      ),
    );
    const liveness = livenessFrom([person('c-dead', { deleted_at: GONE }), person('c-live')]);

    const updated = await racing.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(liveness.calls).toEqual([['c-dead'], ['c-live']]);
    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
      { contactId: 'c-live', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-live');
  });
});
