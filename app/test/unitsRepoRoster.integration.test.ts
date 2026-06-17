// BE3/C3 integration tests against DynamoDB Local — the unit roster + property
// siblings: addContact (append + upsert + single-primaryVoice invariant), the
// legacy landlordId staying represented in the roster, removeContact (non-
// landlord), the primary-landlord-stays guard, the byProperty GSI siblings
// query, and the voice-routing field (primary_voice_contact) staying consistent
// with the roster's ☎ primary.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { CannotRemovePrimaryLandlordError, createUnitsRepo } from '../src/repos/unitsRepo.js';
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
    `[unitsRepoRoster.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('unitsRepo roster + property (BE3) against DynamoDB Local', () => {
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

  it('addContact seeds the roster from the legacy landlordId and keeps the landlord present', async () => {
    const unit = await units.create({ landlordId: 'c-ll-1', status: 'available' });
    // The landlord starts as the implicit primaryVoice (back-compat serializer).
    const updated = await units.addContact(unit.unitId, { contactId: 'c-pm-1', role: 'pm' });
    const roster = updated.contacts ?? [];
    expect(roster.map((c) => c.contactId).sort()).toEqual(['c-ll-1', 'c-pm-1']);
    const landlord = roster.find((c) => c.contactId === 'c-ll-1');
    expect(landlord).toMatchObject({ role: 'landlord', primaryVoice: true });
    // A non-primaryVoice add leaves the landlord as the ☎ primary + voice field.
    expect(roster.find((c) => c.contactId === 'c-pm-1')?.primaryVoice).toBe(false);
    expect(updated.primary_voice_contact).toBe('c-ll-1');
  });

  it('addContact with primaryVoice demotes others (single-primaryVoice) and updates the voice field', async () => {
    const unit = await units.create({ landlordId: 'c-ll-2', status: 'available' });
    await units.addContact(unit.unitId, { contactId: 'c-pm-2', role: 'pm', primaryVoice: true });
    const after = await units.getById(unit.unitId);
    const roster = after?.contacts ?? [];
    const primaries = roster.filter((c) => c.primaryVoice);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.contactId).toBe('c-pm-2');
    // The voice-routing field tracks the roster ☎ primary.
    expect(after?.primary_voice_contact).toBe('c-pm-2');
  });

  it('addContact is idempotent on (unitId, contactId): updates role/primaryVoice/name/company in place', async () => {
    const unit = await units.create({ landlordId: 'c-ll-3', status: 'available' });
    await units.addContact(unit.unitId, { contactId: 'c-x', role: 'other', name: 'Old', company: 'Co' });
    const updated = await units.addContact(unit.unitId, {
      contactId: 'c-x',
      role: 'owner',
      primaryVoice: true,
      name: 'New',
    });
    const roster = updated.contacts ?? [];
    expect(roster.filter((c) => c.contactId === 'c-x')).toHaveLength(1); // no dup
    const row = roster.find((c) => c.contactId === 'c-x');
    expect(row).toMatchObject({ role: 'owner', primaryVoice: true, name: 'New', company: 'Co' });
    expect(updated.primary_voice_contact).toBe('c-x');
  });

  it('removeContact removes a non-landlord and falls the voice field back to landlordId when it was the ☎ primary', async () => {
    const unit = await units.create({ landlordId: 'c-ll-4', status: 'available' });
    await units.addContact(unit.unitId, { contactId: 'c-pm-4', role: 'pm', primaryVoice: true });
    const removed = await units.removeContact(unit.unitId, 'c-pm-4');
    expect((removed.contacts ?? []).map((c) => c.contactId)).toEqual(['c-ll-4']);
    // The removed contact was the ☎ primary → voice field falls back to landlordId.
    expect(removed.primary_voice_contact).toBe('c-ll-4');
  });

  it('removeContact of the ☎-primary pm: exactly one primaryVoice (the landlord) AND scalar === landlordId (FIX B)', async () => {
    const unit = await units.create({ landlordId: 'c-ll-b1', status: 'available' });
    // pm becomes the ☎ primary (landlord demoted to primaryVoice:false).
    await units.addContact(unit.unitId, { contactId: 'c-pm-b1', role: 'pm', primaryVoice: true });
    const removed = await units.removeContact(unit.unitId, 'c-pm-b1');
    const roster = removed.contacts ?? [];
    // Exactly one primaryVoice — the landlord — and the scalar AGREES.
    const primaries = roster.filter((c) => c.primaryVoice);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.contactId).toBe('c-ll-b1');
    expect(removed.primary_voice_contact).toBe('c-ll-b1');
  });

  it('removeContact of the ☎-primary with NO landlordId clears the scalar (no dangling) and leaves no primaryVoice (FIX B)', async () => {
    // A landlord-less unit. landlordId is the byLandlord GSI hash key, so an
    // empty string is illegal at write time — create with a real landlordId,
    // then REMOVE it (null→REMOVE) to reach the no-landlord state, then seed the
    // roster + the ☎-primary scalar.
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    const unit = await units.update(created.unitId, {
      landlordId: null,
      contacts: [
        { contactId: 'c-a', role: 'owner', primaryVoice: false },
        { contactId: 'c-b', role: 'pm', primaryVoice: true },
      ],
      primary_voice_contact: 'c-b',
    });
    expect(unit.landlordId).toBeUndefined();
    const removed = await units.removeContact(unit.unitId, 'c-b');
    const roster = removed.contacts ?? [];
    expect(roster.map((c) => c.contactId)).toEqual(['c-a']);
    // No landlord to promote → no primaryVoice and the scalar is CLEARED (not
    // left dangling at the removed contact).
    expect(roster.filter((c) => c.primaryVoice)).toHaveLength(0);
    expect(removed.primary_voice_contact).toBeUndefined();
  });

  it('addContact pins the owning landlord row to role:landlord even when added as a non-landlord role (FIX C)', async () => {
    const unit = await units.create({ landlordId: 'c-ll-c1', status: 'available' });
    // Add the landlord's own contactId but (mistakenly) as a 'pm'.
    const updated = await units.addContact(unit.unitId, { contactId: 'c-ll-c1', role: 'pm' });
    const landlord = (updated.contacts ?? []).find((c) => c.contactId === 'c-ll-c1');
    expect(landlord?.role).toBe('landlord'); // pinned, not 'pm'
  });

  it('removeContact rejects removing the primary landlord (CannotRemovePrimaryLandlordError)', async () => {
    const unit = await units.create({ landlordId: 'c-ll-5', status: 'available' });
    await expect(units.removeContact(unit.unitId, 'c-ll-5')).rejects.toBeInstanceOf(
      CannotRemovePrimaryLandlordError,
    );
  });

  it('removeContact throws ConditionalCheckFailedException for a contact not on the roster', async () => {
    const unit = await units.create({ landlordId: 'c-ll-6', status: 'available' });
    await expect(units.removeContact(unit.unitId, 'c-ghost')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('addContact throws ConditionalCheckFailedException for an unknown unit', async () => {
    await expect(
      units.addContact('unit-ghost', { contactId: 'c-z', role: 'pm' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('listByProperty returns same-property siblings via the sparse byProperty GSI', async () => {
    const propertyId = `prop-${randomUUID().slice(0, 6)}`;
    const a = await units.create({ landlordId: 'c-ll-7', status: 'available', propertyId });
    const b = await units.create({ landlordId: 'c-ll-7', status: 'placed', propertyId });
    // A unit without propertyId must NOT appear (sparse index).
    await units.create({ landlordId: 'c-ll-7', status: 'available' });
    const page = await units.listByProperty(propertyId);
    expect(page.items.map((u) => u.unitId).sort()).toEqual([a.unitId, b.unitId].sort());
  });
});
