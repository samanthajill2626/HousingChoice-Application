// BE1/C1 integration tests against DynamoDB Local — the contacts repo's
// multi-phone primitives: addPhone (pointer + phones[] seed/append),
// pointer-aware findByPhone (a non-primary number resolves to the owner),
// setPhone (promote primary: scalar swap + pointer reconciliation,
// exactly-one-primary), removePhone (non-primary drops its pointer; primary is
// rejected), and touchPhoneLastSeen.
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
import {
  createContactsRepo,
  EmptyIndexKeyError,
  INDEX_KEY_ATTRIBUTES,
  IndexKeyWriteError,
  PrimaryPhoneRemovalError,
  REQUIRED_INDEX_KEY_ATTRIBUTES,
  RequiredIndexKeyRemovalError,
} from '../src/repos/contactsRepo.js';
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
    `[contactsRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

// Unique numbers per test (the table is shared across the suite; reusing a
// number would collide with a prior test's phone-pointer item on byPhone).
let phoneSeq = 100;
const nextPhone = (): string => `+1555010${String(++phoneSeq).padStart(4, '0')}`;

describe.skipIf(!reachable)('contactsRepo multi-phone against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const contacts = createContactsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('contacts'), tableName('contacts', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('contacts', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('addPhone promotes a FIRST number to primary, mirrors the scalar, and writes no pointer', async () => {
    // A phone-less contact has no primary to defer to. Appending the first
    // number as non-primary left phones[] with ZERO primaries and the scalar
    // unset, contradicting the ContactPhone contract ("Exactly one entry is
    // primary: true") - every reader had been compensating with
    // `find(p => p.primary) ?? phones[0]`. Dropping the `isFirst` promotion in
    // addPhone turns this red.
    const A = nextPhone();
    const created = await contacts.create({ type: 'tenant' });
    expect(created.phone).toBeUndefined();

    const after = await contacts.addPhone(created.contactId, { phone: A, label: 'cell' });

    expect(after.phones).toEqual([
      expect.objectContaining({ phone: A, primary: true, label: 'cell' }),
    ]);
    // The scalar is the byPhone-indexed attribute; it must mirror the primary.
    expect(after.phone).toBe(A);
    // A primary resolves through the scalar's GSI entry, so it takes no pointer.
    const owner = await contacts.findByPhone(A);
    expect(owner?.contactId).toBe(created.contactId);
  });

  it('display reads return only label fields and omit missing ids', async () => {
    const first = await contacts.create({
      type: 'tenant',
      firstName: 'Ada',
      email: 'ada.display-projection@example.com',
    });
    const second = await contacts.create({ type: 'tenant', firstName: 'Grace' });

    expect(await contacts.getDisplayById(first.contactId)).toEqual({
      contactId: first.contactId,
      firstName: 'Ada',
    });

    const found = await contacts.getDisplaysByIds([
      first.contactId,
      'contact-missing',
      first.contactId,
      second.contactId,
    ]);

    expect([...found.keys()].sort()).toEqual([first.contactId, second.contactId].sort());
    expect(found.get(first.contactId)).toEqual({ contactId: first.contactId, firstName: 'Ada' });
    expect(found.get(second.contactId)).toEqual({ contactId: second.contactId, firstName: 'Grace' });
  });

  it('display reads retain a soft-delete stamp without widening the projection', async () => {
    const contact = await contacts.create({
      type: 'tenant',
      firstName: 'Deleted',
      lastName: 'Display',
      phone: nextPhone(),
    });
    await contacts.softDelete(contact.contactId, '2026-08-28T16:21:16.000Z');

    const expected = {
      contactId: contact.contactId,
      firstName: 'Deleted',
      lastName: 'Display',
      phone: contact.phone,
      deleted_at: '2026-08-28T16:21:16.000Z',
    };
    expect(await contacts.getDisplayById(contact.contactId)).toEqual(expected);
    expect((await contacts.getDisplaysByIds([contact.contactId])).get(contact.contactId)).toEqual(expected);
  });

  it('getManyByIds batch-reads WHOLE items, de-dupes ids, and omits missing ones', async () => {
    const first = await contacts.create({
      type: 'landlord',
      firstName: 'Ida',
      email: 'ida.batch-whole@example.com',
      company: 'Keystone Properties',
    });
    const second = await contacts.create({ type: 'tenant', firstName: 'Jo', status: 'searching' });

    const found = await contacts.getManyByIds([
      first.contactId,
      'contact-missing',
      first.contactId,
      second.contactId,
    ]);

    expect([...found.keys()].sort()).toEqual([first.contactId, second.contactId].sort());
    // WHOLE items - the attributes the display projection drops are exactly why
    // this method exists (the unit roster reads `company`, the broadcast send
    // path re-fences on `type`).
    expect(found.get(first.contactId)).toMatchObject({
      contactId: first.contactId,
      type: 'landlord',
      firstName: 'Ida',
      company: 'Keystone Properties',
    });
    expect(found.get(second.contactId)).toMatchObject({ type: 'tenant', status: 'searching' });
  });

  it('getManyByIds pages past the 100-key BatchGetItem limit', async () => {
    // 101 ids forces a second chunk; the map must carry every created contact.
    const created = await Promise.all(
      Array.from({ length: 101 }, (_, i) =>
        contacts.create({ type: 'tenant', firstName: `Batch${i}` }),
      ),
    );

    const found = await contacts.getManyByIds(created.map((c) => c.contactId));

    expect(found.size).toBe(101);
    for (const contact of created) {
      expect(found.get(contact.contactId)?.firstName).toBe(contact.firstName);
    }
  });

  it('getManyByIds returns an empty map for no ids without calling DynamoDB', async () => {
    expect(await contacts.getManyByIds([])).toEqual(new Map());
  });

  it('addPhone seeds phones[] from the scalar, attaches a second number via a pointer, and findByPhone resolves the owner', async () => {
    const A = nextPhone();
    const B = nextPhone();
    const created = await contacts.create({ type: 'tenant', phone: A });

    const afterAdd = await contacts.addPhone(created.contactId, { phone: B, label: 'work' });
    // phones[] was seeded from the scalar (primary) and the new number appended.
    expect(afterAdd.phones).toEqual([
      expect.objectContaining({ phone: A, primary: true }),
      expect.objectContaining({ phone: B, primary: false, label: 'work' }),
    ]);
    // The legacy scalar phone is still the primary.
    expect(afterAdd.phone).toBe(A);

    // The non-primary number resolves to the SAME contact via its pointer.
    const viaB = await contacts.findByPhone(B);
    expect(viaB?.contactId).toBe(created.contactId);
    // The pointer item itself is not a real contact.
    expect(viaB?.phone_ref).toBeUndefined();

    // The primary still resolves via the scalar byPhone (no pointer).
    const viaA = await contacts.findByPhone(A);
    expect(viaA?.contactId).toBe(created.contactId);

    // addPhone is idempotent for an already-present number.
    const again = await contacts.addPhone(created.contactId, { phone: B });
    expect(again.phones?.filter((p) => p.phone === B)).toHaveLength(1);
  });

  it('setPhone promotes a number to primary: scalar swaps, pointers reconcile, exactly one primary', async () => {
    const A = nextPhone();
    const B = nextPhone();
    const created = await contacts.create({ type: 'tenant', phone: A });
    await contacts.addPhone(created.contactId, { phone: B });

    const promoted = await contacts.setPhone(created.contactId, B, { primary: true });
    expect(promoted.phone).toBe(B); // scalar swapped to the new primary
    const primaries = (promoted.phones ?? []).filter((p) => p.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.phone).toBe(B);

    // The new primary (B) resolves via the scalar; the OLD primary (A) now
    // resolves via its freshly-created pointer.
    expect((await contacts.findByPhone(B))?.contactId).toBe(created.contactId);
    expect((await contacts.findByPhone(A))?.contactId).toBe(created.contactId);

    // setPhone can update only the label without touching primary.
    const labeled = await contacts.setPhone(created.contactId, A, { label: 'old cell' });
    expect(labeled.phones?.find((p) => p.phone === A)?.label).toBe('old cell');
  });

  it('removePhone drops a non-primary number + its pointer; removing the primary is rejected', async () => {
    const A = nextPhone();
    const B = nextPhone();
    const created = await contacts.create({ type: 'tenant', phone: A });
    await contacts.addPhone(created.contactId, { phone: B });

    const afterRemove = await contacts.removePhone(created.contactId, B);
    expect(afterRemove.phones?.map((p) => p.phone)).toEqual([A]);
    // The pointer is gone — B no longer resolves.
    expect(await contacts.findByPhone(B)).toBeUndefined();

    // Removing the primary (A) is rejected — never leave zero primary.
    await expect(contacts.removePhone(created.contactId, A)).rejects.toBeInstanceOf(
      PrimaryPhoneRemovalError,
    );
  });

  it('setPhone / removePhone / addPhone throw ConditionalCheckFailed for an unknown contact or phone', async () => {
    const A = nextPhone();
    const B = nextPhone();
    await expect(contacts.addPhone('contact-ghost', { phone: A })).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
    const created = await contacts.create({ type: 'tenant', phone: A });
    await expect(contacts.setPhone(created.contactId, B, { primary: true })).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
    await expect(contacts.removePhone(created.contactId, B)).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('touchPhoneLastSeen updates the right entry, and is a no-op when phones[] is absent', async () => {
    const A = nextPhone();
    const B = nextPhone();
    const created = await contacts.create({ type: 'tenant', phone: A });
    await contacts.addPhone(created.contactId, { phone: B });

    const at = '2026-06-16T12:00:00.000Z';
    await contacts.touchPhoneLastSeen(created.contactId, B, at);
    const read = await contacts.getById(created.contactId);
    expect(read?.phones?.find((p) => p.phone === B)?.lastSeenAt).toBe(at);
    // A's entry is untouched by the B touch.
    expect(read?.phones?.find((p) => p.phone === A)?.lastSeenAt).not.toBe(at);

    // A legacy contact (scalar only, no phones[]) is not churn-seeded on touch.
    const legacyPhone = nextPhone();
    const legacy = await contacts.create({ type: 'tenant', phone: legacyPhone });
    await contacts.touchPhoneLastSeen(legacy.contactId, legacyPhone, at);
    const legacyRead = await contacts.getById(legacy.contactId);
    expect(legacyRead?.phones).toBeUndefined();
  });

  // Voice Phase 1 (spec §8): the voice_opt_out do-not-call flag routes through
  // the generic setFlag/clearFlag, INDEPENDENT of the sms flags.
  it('setFlag/clearFlag handle voice_opt_out independently of sms_opt_out', async () => {
    const created = await contacts.create({ type: 'landlord', phone: nextPhone() });

    await contacts.setFlag(created.contactId, 'voice_opt_out');
    let read = await contacts.getById(created.contactId);
    expect(read?.voice_opt_out).toBe(true);
    expect(read?.sms_opt_out).toBeUndefined(); // independent — untouched

    // Setting the sms flag does not disturb voice_opt_out.
    await contacts.setFlag(created.contactId, 'sms_opt_out');
    read = await contacts.getById(created.contactId);
    expect(read?.voice_opt_out).toBe(true);
    expect(read?.sms_opt_out).toBe(true);

    // Clearing voice_opt_out leaves sms_opt_out set.
    await contacts.clearFlag(created.contactId, 'voice_opt_out');
    read = await contacts.getById(created.contactId);
    expect(read?.voice_opt_out).toBe(false);
    expect(read?.sms_opt_out).toBe(true);
  });

  // Clearing a GSI KEY attribute. Real DynamoDB is the only place these two
  // assertions mean anything: the fake repos accept '' happily, so the
  // ValidationException only ever showed up in a live request.
  it('update with null REMOVEs housingAuthority and drops the contact out of the byHousingAuthority index', async () => {
    const authority = `test_authority_${randomUUID().slice(0, 8)}`;
    const created = await contacts.create({ type: 'tenant', phone: nextPhone(), housingAuthority: authority });

    const indexedBefore = await contacts.listByHousingAuthority(authority);
    expect(indexedBefore.items.map((c) => c.contactId)).toContain(created.contactId);

    const cleared = await contacts.update(created.contactId, { housingAuthority: null });

    expect(cleared.housingAuthority).toBeUndefined();
    const read = await contacts.getById(created.contactId, { consistentRead: true });
    expect(read?.housingAuthority).toBeUndefined();
    // Sparse index: with the key attribute gone the item leaves the partition.
    const indexedAfter = await contacts.listByHousingAuthority(authority);
    expect(indexedAfter.items.map((c) => c.contactId)).not.toContain(created.contactId);
  });

  it('update REFUSES an empty string on a GSI key attribute instead of letting DynamoDB reject it', async () => {
    // Layer-2 backstop for the edit-form bug: '' on an index key attribute is
    // a ValidationException from DynamoDB with a stack that points at the SDK,
    // not at the caller that meant "clear this". Fail at the seam, named, so
    // the next field that joins an index cannot repeat it silently.
    const created = await contacts.create({ type: 'tenant', phone: nextPhone(), housingAuthority: 'atlanta_housing' });

    await expect(
      contacts.update(created.contactId, { housingAuthority: '' }),
    ).rejects.toBeInstanceOf(EmptyIndexKeyError);

    // The refusal is total — nothing in the patch landed.
    const read = await contacts.getById(created.contactId, { consistentRead: true });
    expect(read?.housingAuthority).toBe('atlanta_housing');

    // A non-key attribute keeps the '' clears-it convention (DynamoDB has
    // allowed empty strings on non-key attributes since 2020).
    const ok = await contacts.update(created.contactId, { notes: '' });
    expect(ok.notes).toBe('');
  });

  it('increments classification_revision only in the same type or role update', async () => {
    const created = await contacts.create({ type: 'unknown', firstName: 'Revision' });
    expect(created.classification_revision).toBeUndefined();

    const noteOnly = await contacts.update(created.contactId, { notes: 'unchanged kind' });
    expect(noteOnly.classification_revision).toBeUndefined();

    const tenant = await contacts.update(created.contactId, { type: 'tenant' });
    expect(tenant.classification_revision).toBe(1);

    const roleCleared = await contacts.update(created.contactId, { role: null });
    expect(roleCleared.classification_revision).toBe(2);

    const unknownAgain = await contacts.update(created.contactId, { type: 'unknown' });
    expect(unknownAgain.classification_revision).toBe(3);
  });

  it('increments classification_revision atomically for concurrent classification updates', async () => {
    const created = await contacts.create({ type: 'unknown', firstName: 'Concurrent Revision' });

    const updates = await Promise.all([
      contacts.update(created.contactId, { type: 'tenant' }),
      contacts.update(created.contactId, { role: 'Property Manager' }),
    ]);

    expect(updates.map((contact) => contact.classification_revision).sort()).toEqual([1, 2]);
    const stored = await contacts.getById(created.contactId, { consistentRead: true });
    expect(stored?.classification_revision).toBe(2);
  });

  it('update REFUSES a null REMOVE of status, which would make the contact invisible to listByType', async () => {
    // The OTHER half of the guard above, and the reason it exists: '' was
    // refused while null - the documented REMOVE path - was waved through in
    // the adjacent line. A REMOVE of a byTypeStatus key does not error and does
    // not empty the row; it un-indexes it, so the contact reads back perfectly
    // by id and is gone from the Unknown tab forever. Without the guard this
    // test fails TWICE: the rejects assertion (nothing throws) and the
    // still-listed assertion (the row vanishes from the partition).
    const created = await contacts.create({
      type: 'unknown',
      status: 'needs_review',
      phone: nextPhone(),
    });

    const before = await contacts.listByType('unknown', { status: 'needs_review' });
    expect(before.items.map((c) => c.contactId)).toContain(created.contactId);

    await expect(
      contacts.update(created.contactId, { status: null }),
    ).rejects.toBeInstanceOf(RequiredIndexKeyRemovalError);

    // Total refusal: a companion field in the SAME patch must not land either.
    await expect(
      contacts.update(created.contactId, { notes: 'triaged', status: null }),
    ).rejects.toBeInstanceOf(RequiredIndexKeyRemovalError);

    const read = await contacts.getById(created.contactId, { consistentRead: true });
    expect(read?.status).toBe('needs_review');
    expect(read?.notes).toBeUndefined();

    // Still in the partition every triage read queries.
    const after = await contacts.listByType('unknown', { status: 'needs_review' });
    expect(after.items.map((c) => c.contactId)).toContain(created.contactId);
  });

  it('update REFUSES a null REMOVE of type for the same reason', async () => {
    const created = await contacts.create({
      type: 'unknown',
      status: 'needs_review',
      phone: nextPhone(),
    });
    await expect(
      contacts.update(created.contactId, { type: null }),
    ).rejects.toBeInstanceOf(RequiredIndexKeyRemovalError);
    const read = await contacts.getById(created.contactId, { consistentRead: true });
    expect(read?.type).toBe('unknown');
  });

  it('update still CLEARS housingAuthority with null - the sparse lookup keys stay clearable', async () => {
    // The narrowness of the guard is the load-bearing part. PATCH
    // /api/contacts/:id sends `housingAuthority: null` whenever the edit form's
    // authority field is emptied (routes/contacts.ts), and leaving the sparse
    // partition is the CORRECT semantics there. A guard over all of
    // INDEX_KEY_ATTRIBUTES would 500 that form - the exact bug the null
    // convention was introduced to fix.
    const authority = `test_authority_${randomUUID().slice(0, 8)}`;
    const created = await contacts.create({
      type: 'tenant',
      status: 'onboarding',
      phone: nextPhone(),
      housingAuthority: authority,
    });

    const cleared = await contacts.update(created.contactId, { housingAuthority: null });
    expect(cleared.housingAuthority).toBeUndefined();
    // And the contact is still a tenant on byTypeStatus - only the sparse
    // authority partition was left.
    const listed = await contacts.listByType('tenant', { status: 'onboarding' });
    expect(listed.items.map((c) => c.contactId)).toContain(created.contactId);
  });
});

// Constant-only; runs with or without DynamoDB Local. The guard is only as good
// as this set, and the set is derived by INDEX NAME - so a rename of the
// byTypeStatus GSI would silently empty it and disarm the guard rather than
// breaking a build. Pin it here, next to the behaviour it protects.
describe('contacts index-key guard sets', () => {
  it('REQUIRED_INDEX_KEY_ATTRIBUTES is exactly the byTypeStatus keys, and a subset of INDEX_KEY_ATTRIBUTES', () => {
    expect([...REQUIRED_INDEX_KEY_ATTRIBUTES].sort()).toEqual(['status', 'type']);
    for (const attribute of REQUIRED_INDEX_KEY_ATTRIBUTES) {
      expect(INDEX_KEY_ATTRIBUTES.has(attribute)).toBe(true);
    }
    // The sparse lookup keys must stay OUT: clearing them with null is a
    // supported operation, not a defect.
    for (const attribute of ['phone', 'email', 'housingAuthority']) {
      expect(INDEX_KEY_ATTRIBUTES.has(attribute)).toBe(true);
      expect(REQUIRED_INDEX_KEY_ATTRIBUTES.has(attribute)).toBe(false);
    }
  });

  it('both index-key refusals are one catchable family', () => {
    expect(new EmptyIndexKeyError('status')).toBeInstanceOf(IndexKeyWriteError);
    expect(new RequiredIndexKeyRemovalError('status', 'contact-1')).toBeInstanceOf(
      IndexKeyWriteError,
    );
    // The message has to say what to do instead - the sibling's does.
    expect(new RequiredIndexKeyRemovalError('status', 'contact-1').message).toContain(
      'Write a real value instead',
    );
  });
});
