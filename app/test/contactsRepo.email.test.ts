// Email-channel A1 integration tests against DynamoDB Local - the contacts
// repo's email primitives (the exact analog of contactsRepo.integration.test.ts's
// multi-phone suite): addEmail (pointer + emails[] seed/append), pointer-aware
// findByEmail (a non-primary address resolves to the owner - the byEmail claim
// the route's email_in_use conflict guard reads), setPrimaryEmail (promote:
// scalar swap + pointer reconciliation, exactly-one-primary), removeEmail
// (non-primary drops its pointer; primary is rejected), and touchEmailLastSeen.
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
import { createContactsRepo, PrimaryEmailRemovalError } from '../src/repos/contactsRepo.js';
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
    `[contactsRepo.email.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

// Unique addresses per test (the table is shared across the suite; reusing an
// address would collide with a prior test's email-pointer item on byEmail).
let emailSeq = 100;
const nextEmail = (): string => `user${++emailSeq}@example.com`;

describe.skipIf(!reachable)('contactsRepo email against DynamoDB Local (throwaway prefix)', () => {
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

  it('addEmail seeds emails[] from the scalar, attaches a second address via a pointer, and findByEmail resolves the owner', async () => {
    const A = nextEmail();
    const B = nextEmail();
    const created = await contacts.create({ type: 'tenant', email: A });

    const afterAdd = await contacts.addEmail(created.contactId, { email: B, label: 'work' });
    // emails[] was seeded from the scalar (primary) and the new address appended.
    expect(afterAdd.emails).toEqual([
      expect.objectContaining({ email: A, primary: true }),
      expect.objectContaining({ email: B, primary: false, label: 'work' }),
    ]);
    // The scalar email is still the primary.
    expect(afterAdd.email).toBe(A);

    // The non-primary address resolves to the SAME contact via its pointer.
    const viaB = await contacts.findByEmail(B);
    expect(viaB?.contactId).toBe(created.contactId);
    // The pointer item itself is not a real contact.
    expect(viaB?.email_ref).toBeUndefined();

    // The primary still resolves via the scalar byEmail (no pointer).
    const viaA = await contacts.findByEmail(A);
    expect(viaA?.contactId).toBe(created.contactId);

    // addEmail is idempotent for an already-present address.
    const again = await contacts.addEmail(created.contactId, { email: B });
    expect(again.emails?.filter((e) => e.email === B)).toHaveLength(1);
  });

  it('findByEmail on a secondary is the byEmail claim the route reads for email_in_use (resolves to the OWNER, not a bystander)', async () => {
    const A = nextEmail();
    const B = nextEmail();
    const owner = await contacts.create({ type: 'landlord', email: A });
    await contacts.addEmail(owner.contactId, { email: B });
    // A different contact exists but does NOT own B.
    const bystander = await contacts.create({ type: 'tenant', email: nextEmail() });

    const claim = await contacts.findByEmail(B);
    expect(claim?.contactId).toBe(owner.contactId);
    expect(claim?.contactId).not.toBe(bystander.contactId);
    // A never-seen address resolves to nobody.
    expect(await contacts.findByEmail(nextEmail())).toBeUndefined();
  });

  it('setPrimaryEmail promotes an address to primary: scalar swaps, pointers reconcile, exactly one primary', async () => {
    const A = nextEmail();
    const B = nextEmail();
    const created = await contacts.create({ type: 'tenant', email: A });
    await contacts.addEmail(created.contactId, { email: B });

    const promoted = await contacts.setPrimaryEmail(created.contactId, B, { primary: true });
    expect(promoted.email).toBe(B); // scalar swapped to the new primary
    const primaries = (promoted.emails ?? []).filter((e) => e.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.email).toBe(B);

    // The new primary (B) resolves via the scalar; the OLD primary (A) now
    // resolves via its freshly-created pointer.
    expect((await contacts.findByEmail(B))?.contactId).toBe(created.contactId);
    expect((await contacts.findByEmail(A))?.contactId).toBe(created.contactId);

    // setPrimaryEmail can update only the label without touching primary.
    const labeled = await contacts.setPrimaryEmail(created.contactId, A, { label: 'old address' });
    expect(labeled.emails?.find((e) => e.email === A)?.label).toBe('old address');
    // Still exactly one primary, and it is still B.
    expect((labeled.emails ?? []).filter((e) => e.primary).map((e) => e.email)).toEqual([B]);
  });

  it('removeEmail drops a non-primary address + its pointer; removing the primary is rejected', async () => {
    const A = nextEmail();
    const B = nextEmail();
    const created = await contacts.create({ type: 'tenant', email: A });
    await contacts.addEmail(created.contactId, { email: B });

    const afterRemove = await contacts.removeEmail(created.contactId, B);
    expect(afterRemove.emails?.map((e) => e.email)).toEqual([A]);
    // The pointer is gone - B no longer resolves.
    expect(await contacts.findByEmail(B)).toBeUndefined();

    // Removing the primary (A) is rejected - never leave zero primary.
    await expect(contacts.removeEmail(created.contactId, A)).rejects.toBeInstanceOf(
      PrimaryEmailRemovalError,
    );
  });

  it('setPrimaryEmail / removeEmail / addEmail throw ConditionalCheckFailed for an unknown contact or address', async () => {
    const A = nextEmail();
    const B = nextEmail();
    await expect(contacts.addEmail('contact-ghost', { email: A })).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
    const created = await contacts.create({ type: 'tenant', email: A });
    await expect(
      contacts.setPrimaryEmail(created.contactId, B, { primary: true }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    await expect(contacts.removeEmail(created.contactId, B)).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('touchEmailLastSeen updates the right entry, and is a no-op when emails[] is absent', async () => {
    const A = nextEmail();
    const B = nextEmail();
    const created = await contacts.create({ type: 'tenant', email: A });
    await contacts.addEmail(created.contactId, { email: B });

    const at = '2026-07-20T12:00:00.000Z';
    await contacts.touchEmailLastSeen(created.contactId, B, at);
    const read = await contacts.getById(created.contactId);
    expect(read?.emails?.find((e) => e.email === B)?.lastSeenAt).toBe(at);
    // A's entry is untouched by the B touch.
    expect(read?.emails?.find((e) => e.email === A)?.lastSeenAt).not.toBe(at);

    // A scalar-only contact (no emails[]) is not churn-seeded on touch.
    const scalarOnlyEmail = nextEmail();
    const scalarOnly = await contacts.create({ type: 'tenant', email: scalarOnlyEmail });
    await contacts.touchEmailLastSeen(scalarOnly.contactId, scalarOnlyEmail, at);
    const scalarRead = await contacts.getById(scalarOnly.contactId);
    expect(scalarRead?.emails).toBeUndefined();
  });
});
