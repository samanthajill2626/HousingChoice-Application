// caseworker-integrity (spec 2026-10-12 section 4 "Contact list (I4)" and
// "Landlord of record (I3)"; R1 code review backend finding 1, fix wave 2 item
// FW2-1): the real unitsRepo.addContact against DynamoDB Local re-decides the
// two contact-list rules on EACH attempt's own read of the unit, from the
// facts the caller read about the contact, so a property change landing
// between the route's read and the roster write cannot slip past them:
//   I4 - a caseworker never takes a NEW seat: no row for the contact on the
//        attempt's read -> ContactListCaseworkerError (route 409
//        contact_list_caseworker), nothing written;
//   I3 - a role-landlord add that claims the vacant landlord slot (no
//        landlordId attribute on the attempt's read) needs a contact typed
//        landlord -> LandlordClaimNotLandlordError (route 409
//        landlord_not_landlord), and the slot stays vacant.
// Each race runs `race` on the raw client right after the FIRST read of the
// unit through the racing client: the caller's (route's) read when the test
// makes it, else the add's own first read. Each attempt's own read is
// CONSISTENT (final review A7, fix wave FWF-5), and so is the re-read after a
// lost write (final review round 2 R2-4): the three PINs at the end.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createUnitsRepo, type UnitContact } from '../src/repos/unitsRepo.js';
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
    `[unitsRepoContactListRules.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

/** What the route reads about the contact being added (isCaseworker, type ===
 *  'landlord', eligible for automatic routing). */
const CASEWORKER_FACTS = { caseworker: true, landlordTyped: false, autoPrimaryEligible: false };
const TENANT_FACTS = { caseworker: false, landlordTyped: false, autoPrimaryEligible: false };

describe.skipIf(!reachable)('unitsRepo.addContact contact-list rules per attempt against DynamoDB Local', () => {
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

  /**
   * A repo whose FIRST read of `unitId` is followed by `race` (on the raw
   * client, so the racer's own writes are not counted), counting the
   * UpdateCommands it sends for the unit and how many lost their condition,
   * and recording each GetCommand's ConsistentRead for the unit, in order.
   */
  function racingRepo(unitId: string, race: () => Promise<unknown>) {
    let raced = false;
    const counter = { writes: 0, lostWrites: 0, unitReads: [] as Array<boolean | undefined> };
    const racingDoc = Object.create(doc) as typeof doc;
    racingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) {
        counter.writes += 1;
        try {
          return await doc.send(command);
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) counter.lostWrites += 1;
          throw err;
        }
      }
      const result = await doc.send(command);
      if (command instanceof GetCommand && command.input.Key?.['unitId'] === unitId) {
        counter.unitReads.push(command.input.ConsistentRead);
        if (!raced) {
          raced = true;
          await race();
        }
      }
      return result;
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: racingDoc, env: testEnv, logger }), counter };
  }

  const OWNER_ROW: UnitContact = { contactId: 'c-owner', role: 'landlord', primaryContact: true };
  const CW_ROW: UnitContact = { contactId: 'c-cw', role: 'other', primaryContact: false };

  /** A property owned by c-owner (its primary) where caseworker c-cw holds a seat from before the rule (L2). */
  async function unitWithCaseworkerSeat(): Promise<string> {
    const created = await units.create({
      landlordId: 'c-owner',
      status: 'available',
      contacts: [OWNER_ROW, CW_ROW],
      primary_contact: 'c-owner',
    });
    return created.unitId;
  }

  it("I4: a caseworker's seat removed after the route's read is not re-created as a NEW seat - ContactListCaseworkerError, nothing written", async () => {
    const unitId = await unitWithCaseworkerSeat();
    // Staff B's removal of the seat lands right after the route's read, which
    // still showed it - so the route's own pre-check let the role edit through.
    const { repo, counter } = racingRepo(unitId, () => units.removeContact(unitId, 'c-cw'));
    const routeRead = await repo.getById(unitId, { consistentRead: true });
    expect(routeRead?.contacts).toContainEqual(CW_ROW);

    await expect(
      repo.addContact(unitId, { contactId: 'c-cw', role: 'pm', primaryContact: true }, CASEWORKER_FACTS),
    ).rejects.toMatchObject({ name: 'ContactListCaseworkerError' });

    // Refused on the add's own read: no write sent, B's removal stands.
    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual([OWNER_ROW]);
    expect(stored?.primary_contact).toBe('c-owner');
  });

  it("I4 per attempt: a seat removed between the add's own read and its write - the write loses, the add re-reads and refuses", async () => {
    const unitId = await unitWithCaseworkerSeat();
    // The first read through the racing client is the add's attempt-1 read:
    // the seat is there, so attempt 1 upserts it and writes; B's removal has
    // landed by then, so that write loses its roster condition and the add
    // re-reads. Attempt 2 sees no seat: a NEW seat for a caseworker.
    const { repo, counter } = racingRepo(unitId, () => units.removeContact(unitId, 'c-cw'));

    await expect(
      repo.addContact(unitId, { contactId: 'c-cw', role: 'pm', primaryContact: true }, CASEWORKER_FACTS),
    ).rejects.toMatchObject({ name: 'ContactListCaseworkerError' });

    expect(counter.writes).toBe(1);
    expect(counter.lostWrites).toBe(1);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual([OWNER_ROW]);
    expect(stored?.primary_contact).toBe('c-owner');
  });

  it("I3: the landlord of record cleared after the route's read - a tenant's landlord-role add does not claim the vacant slot", async () => {
    const created = await units.create({
      landlordId: 'c-old',
      status: 'available',
      contacts: [{ contactId: 'c-old', role: 'landlord', primaryContact: true }],
      primary_contact: 'c-old',
    });
    const unitId = created.unitId;
    // Staff B's "Restore without a landlord" write (landlordId REMOVEd, the old
    // landlord's row dropped, primary_contact REMOVEd) lands right after the
    // route's read, which still showed an owner - so the add was not a claim
    // there and no type check ran.
    const { repo, counter } = racingRepo(unitId, () =>
      units.update(unitId, { landlordId: null, contacts: [], primary_contact: null }),
    );
    const routeRead = await repo.getById(unitId, { consistentRead: true });
    expect(routeRead?.landlordId).toBe('c-old');

    await expect(
      repo.addContact(unitId, { contactId: 'c-ten', role: 'landlord', primaryContact: false }, TENANT_FACTS),
    ).rejects.toMatchObject({ name: 'LandlordClaimNotLandlordError' });

    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored !== undefined && Object.prototype.hasOwnProperty.call(stored, 'landlordId')).toBe(false);
    expect(stored?.contacts).toEqual([]);
    expect(stored?.primary_contact).toBeUndefined();
  });

  // Final review A7 (fix wave FWF-5): the refusals above are thrown on the
  // add's OWN per-attempt read of the unit - a refusal writes nothing, so no
  // conditional write ever confirms what that read saw. The read is therefore
  // CONSISTENT: a lagging replica must never answer a 409 for a state the
  // route's consistent read already saw as allowed.
  it("(PIN) a refusal is decided on a CONSISTENT read of the unit - attempt 1's own read", async () => {
    const unitId = await unitWithCaseworkerSeat();
    const { repo, counter } = racingRepo(unitId, async () => undefined);

    // A caseworker with no seat here: refused on the add's first read.
    await expect(
      repo.addContact(unitId, { contactId: 'c-cw-2', role: 'pm', primaryContact: false }, CASEWORKER_FACTS),
    ).rejects.toMatchObject({ name: 'ContactListCaseworkerError' });

    expect(counter.unitReads).toEqual([true]);
    expect(counter.writes).toBe(0);
  });

  it("(PIN) every attempt reads the unit CONSISTENTLY - the retry's read the refusal is decided on included", async () => {
    const unitId = await unitWithCaseworkerSeat();
    // B's removal lands right after attempt 1's read: attempt 1's write loses,
    // and attempt 2 re-reads and refuses (the per-attempt case above).
    const { repo, counter } = racingRepo(unitId, () => units.removeContact(unitId, 'c-cw'));

    await expect(
      repo.addContact(unitId, { contactId: 'c-cw', role: 'pm', primaryContact: true }, CASEWORKER_FACTS),
    ).rejects.toMatchObject({ name: 'ContactListCaseworkerError' });

    expect(counter.lostWrites).toBe(1);
    // Attempt 1's read and the last read - attempt 2's, which refused.
    expect(counter.unitReads[0]).toBe(true);
    expect(counter.unitReads.at(-1)).toBe(true);
  });

  // Final review round 2 R2-4: after a lost conditional write, addContact
  // re-reads the unit and can refuse from THAT read -
  // LandlordReassignmentRequiredError when the property now has another
  // landlord of record - before any retry. Nothing confirms that refusal
  // either, so the re-read is CONSISTENT too: a lagging replica must not
  // answer 409 landlord_reassignment_required for a slot that is vacant.
  it('(PIN) the re-read after a lost write is CONSISTENT - the reassignment refusal decided on it included', async () => {
    // Ownerless (no landlordId attribute), one property manager on the list.
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    const unitId = created.unitId;
    const pmRow: UnitContact = { contactId: 'c-pm', role: 'pm', primaryContact: false };
    await units.update(unitId, { landlordId: null, contacts: [pmRow] });
    const claimed: UnitContact[] = [pmRow, { contactId: 'c-other', role: 'landlord', primaryContact: true }];
    // Staff B claims the vacant landlord slot right after attempt 1's read,
    // so attempt 1's claim loses its no-landlord condition and the add
    // re-reads: another landlord of record now, so it refuses from there.
    const { repo, counter } = racingRepo(unitId, () =>
      units.update(unitId, { landlordId: 'c-other', contacts: claimed, primary_contact: 'c-other' }),
    );

    await expect(
      repo.addContact(
        unitId,
        { contactId: 'c-new', role: 'landlord', primaryContact: false },
        { caseworker: false, landlordTyped: true, autoPrimaryEligible: true },
      ),
    ).rejects.toMatchObject({ name: 'LandlordReassignmentRequiredError' });

    expect(counter.writes).toBe(1);
    expect(counter.lostWrites).toBe(1);
    // Attempt 1's read, then the re-read the refusal was decided on.
    expect(counter.unitReads).toEqual([true, true]);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.landlordId).toBe('c-other');
    expect(stored?.contacts).toEqual(claimed);
  });
});
