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
import { createContactsRepo, PrimaryPhoneRemovalError } from '../src/repos/contactsRepo.js';
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
});
