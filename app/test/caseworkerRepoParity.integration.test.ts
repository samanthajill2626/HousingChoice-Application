// Caseworkers (branch B) repo primitives - real repo vs harness fake (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D21, D22; plan 3.3; rulings R1-F3, R1-F15, R3-F4, R5-F17). The
// caseworker conversion commits through a multi-clause update guard, decides
// "own thread" with an all-holders phone/email read, re-types threads
// conditionally, and scans units without the soft-delete filter; the shares
// recipients route reads a second display projection. Every case runs
// against BOTH the real repos (DynamoDB Local) and the harness world fakes and
// must answer the same - a fake that disagrees with its repo lets the service
// suites pass against behavior production never has. The fake half runs
// without Docker; the real half self-skips.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createContactsRepo,
  emailRefId,
  phoneRefId,
  type CaseworkerConversionRecord,
  type ContactItem,
  type ContactsRepo,
} from '../src/repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
import { createUnitsRepo, type UnitItem, type UnitsPage, type UnitsRepo } from '../src/repos/unitsRepo.js';
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
    `[caseworkerRepoParity.integration] DynamoDB Local half SKIPPED - nothing at ${endpoint}. ` +
      'Run `npm run db:start` to exercise it.',
  );
}

const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const contactsTable = tableName('contacts', testEnv);
const conversationsTable = tableName('conversations', testEnv);
const unitsTable = tableName('units', testEnv);

beforeAll(async () => {
  if (!reachable) return;
  await ensureTable(client, getTableSpec('contacts'), contactsTable);
  await ensureTable(client, getTableSpec('conversations'), conversationsTable);
  await ensureTable(client, getTableSpec('units'), unitsTable);
}, 120_000);

afterAll(async () => {
  if (reachable) {
    await deleteTableIfExists(client, contactsTable);
    await deleteTableIfExists(client, conversationsTable);
    await deleteTableIfExists(client, unitsTable);
  }
  doc.destroy();
  client.destroy();
}, 120_000);

// Phones are unique across the whole run: the real tables are shared by every
// case, and a reused number would meet an earlier case's rows on byPhone.
let phoneSeq = 2000;
const nextPhone = (): string => `+1555020${String(++phoneSeq).padStart(4, '0')}`;

/** One implementation under test: the repos plus raw seed/read access. */
interface World {
  contacts: ContactsRepo;
  conversations: ConversationsRepo;
  units: UnitsRepo;
  putContact(item: ContactItem): Promise<void>;
  readContact(contactId: string): Promise<ContactItem | undefined>;
  /** A pointer row as each implementation stores one (the real row has NO type; the fake's carries the 'unknown' sentinel). */
  putPointer(kind: 'phone' | 'email', value: string, ownerId: string): Promise<void>;
  putConversation(item: Record<string, unknown> & { conversationId: string }): Promise<void>;
  readConversation(conversationId: string): Promise<ConversationItem | undefined>;
  putUnit(item: UnitItem): Promise<void>;
}

function realWorld(): World {
  const logger = quietLogger();
  return {
    contacts: createContactsRepo({ doc, env: testEnv, logger }),
    conversations: createConversationsRepo({ doc, env: testEnv, logger }),
    units: createUnitsRepo({ doc, env: testEnv, logger }),
    async putContact(item) {
      await doc.send(new PutCommand({ TableName: contactsTable, Item: item }));
    },
    async readContact(contactId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: contactsTable, Key: { contactId }, ConsistentRead: true }),
      );
      return Item as ContactItem | undefined;
    },
    async putPointer(kind, value, ownerId) {
      const Item =
        kind === 'phone'
          ? { contactId: phoneRefId(value), phone: value, phone_ref: true, phone_ref_owner: ownerId }
          : { contactId: emailRefId(value), email: value, email_ref: true, email_ref_owner: ownerId };
      await doc.send(new PutCommand({ TableName: contactsTable, Item }));
    },
    async putConversation(item) {
      await doc.send(new PutCommand({ TableName: conversationsTable, Item: item }));
    },
    async readConversation(conversationId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: conversationsTable, Key: { conversationId }, ConsistentRead: true }),
      );
      return Item as ConversationItem | undefined;
    },
    async putUnit(item) {
      await doc.send(new PutCommand({ TableName: unitsTable, Item: item }));
    },
  };
}

function fakeWorld(): World {
  const world = createFakeWorld();
  return {
    contacts: world.contactsRepo,
    conversations: world.conversationsRepo,
    units: world.unitsRepo,
    async putContact(item) {
      world.contacts.push(structuredClone(item));
    },
    async readContact(contactId) {
      const hit = world.contacts.find((c) => c.contactId === contactId);
      return hit === undefined ? undefined : structuredClone(hit);
    },
    async putPointer(kind, value, ownerId) {
      world.contacts.push(
        (kind === 'phone'
          ? { contactId: phoneRefId(value), type: 'unknown', phone: value, phone_ref: true, phone_ref_owner: ownerId }
          : { contactId: emailRefId(value), type: 'unknown', email: value, email_ref: true, email_ref_owner: ownerId }) as ContactItem,
      );
    },
    async putConversation(item) {
      world.conversations.set(item.conversationId, structuredClone(item) as unknown as ConversationItem);
    },
    async readConversation(conversationId) {
      const hit = world.conversations.get(conversationId);
      return hit === undefined ? undefined : structuredClone(hit);
    },
    async putUnit(item) {
      world.units.set(item.unitId, structuredClone(item));
    },
  };
}

/** One case against the harness fake (always) and DynamoDB Local (when reachable). */
function parity(name: string, run: (w: World, id: string) => Promise<void>): void {
  it(`${name} [harness fake]`, async () => {
    await run(fakeWorld(), `fake-${randomUUID().slice(0, 8)}`);
  });
  it.skipIf(!reachable)(`${name} [DynamoDB Local]`, async () => {
    await run(realWorld(), `real-${randomUUID().slice(0, 8)}`);
  });
}

describe('contactsRepo.update guards - expect clauses and notDeleted (plan 3.3)', () => {
  parity('(PIN) the single-object expect form still guards one attribute', async (w, id) => {
    await w.putContact({ contactId: id, type: 'tenant', status: 'onboarding', staff_notes_updated_at: 'T1' });
    await expect(
      w.contacts.update(id, { staff_notes: 'lost' }, { expect: { attr: 'staff_notes_updated_at', value: 'T0' } }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const ok = await w.contacts.update(id, { staff_notes: 'kept' }, { expect: { attr: 'staff_notes_updated_at', value: 'T1' } });
    expect(ok.staff_notes).toBe('kept');
  });

  parity('writes when EVERY clause holds - number, string, empty string, absent - and REMOVEs a guarded attribute in the same write', async (w, id) => {
    await w.putContact({
      contactId: id,
      type: 'tenant',
      status: 'searching',
      classification_revision: 4,
      housingAuthority: 'Atlanta Housing Authority',
      housingAuthority_source: 'ai',
      agency: '',
      firstName: 'Pat',
    });
    const updated = await w.contacts.update(
      id,
      { type: 'partner', role: 'Caseworker', status: 'active', housingAuthority: null, housingAuthority_source: null, agency: '' },
      {
        expect: [
          { attr: 'classification_revision', value: 4 },
          { attr: 'housingAuthority', value: 'Atlanta Housing Authority' },
          { attr: 'agency', value: '' },
          { attr: 'organization', value: null },
        ],
        notDeleted: true,
      },
    );
    expect(updated.type).toBe('partner');
    const stored = await w.readContact(id);
    expect(stored).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      status: 'active',
      agency: '',
      classification_revision: 5,
      firstName: 'Pat',
    });
    expect(stored).not.toHaveProperty('housingAuthority');
    expect(stored).not.toHaveProperty('housingAuthority_source');
  });

  parity('refuses when ANY one clause is lost, writing nothing', async (w, id) => {
    const base: ContactItem = { contactId: id, type: 'tenant', status: 'searching', classification_revision: 2, agency: 'Step Up' };
    await w.putContact(base);
    const lost: Array<[number, string | null]> = [
      [1, 'Step Up'], // a stale revision
      [2, 'Other'], // another agency
      [2, null], // "absent" is not a held value
      [2, ''], // '' is not 'Step Up'
    ];
    for (const [revision, agency] of lost) {
      await expect(
        w.contacts.update(
          id,
          { firstName: 'Lost' },
          { expect: [{ attr: 'classification_revision', value: revision }, { attr: 'agency', value: agency }] },
        ),
      ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    }
    expect(await w.readContact(id)).toEqual(base);
  });

  parity('guards the RAW revision: an absent fence matches null, never the folded 0 (R1-F3)', async (w, id) => {
    await w.putContact({ contactId: id, type: 'unknown', status: 'needs_review' });
    const patch = { type: 'partner', role: 'Caseworker', status: 'active' };
    await expect(
      w.contacts.update(id, patch, { expect: [{ attr: 'classification_revision', value: 0 }] }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const updated = await w.contacts.update(id, patch, { expect: [{ attr: 'classification_revision', value: null }] });
    expect(updated.classification_revision).toBe(1);
  });

  parity('notDeleted refuses a soft-deleted contact even when every clause holds (D22)', async (w, id) => {
    await w.putContact({ contactId: id, type: 'tenant', status: 'searching', agency: 'Step Up', deleted_at: '2026-10-07T09:00:00.000Z' });
    await expect(
      w.contacts.update(id, { agency: '' }, { expect: [{ attr: 'agency', value: 'Step Up' }], notDeleted: true }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect((await w.readContact(id))?.['agency']).toBe('Step Up');
    // Deletion is not an IMPLIED guard: without notDeleted the same write lands.
    await w.contacts.update(id, { agency: '' }, { expect: [{ attr: 'agency', value: 'Step Up' }] });
    expect((await w.readContact(id))?.['agency']).toBe('');
  });

  parity('a no-op update evaluates every clause and notDeleted', async (w, id) => {
    await w.putContact({ contactId: id, type: 'partner', status: 'active', classification_revision: 3 });
    await expect(
      w.contacts.update(id, {}, { expect: [{ attr: 'classification_revision', value: 3 }, { attr: 'organization', value: 'X' }] }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const same = await w.contacts.update(
      id,
      {},
      { expect: [{ attr: 'classification_revision', value: 3 }, { attr: 'organization', value: null }], notDeleted: true },
    );
    expect(same.contactId).toBe(id);
    const deletedId = `${id}-deleted`;
    await w.putContact({ contactId: deletedId, type: 'partner', status: 'active', deleted_at: '2026-10-07T09:00:00.000Z' });
    await expect(w.contacts.update(deletedId, {}, { notDeleted: true })).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  parity('the caseworker fields round-trip typed (ContactItem, plan 3.2)', async (w, id) => {
    await w.putContact({ contactId: id, type: 'tenant', status: 'searching' });
    const record: CaseworkerConversionRecord = {
      at: '2026-10-07T10:00:00.000Z',
      by: 'user-caseworker-parity',
      fromType: 'tenant',
      fromRole: 'Case worker',
      housingAuthority: 'Atlanta Housing Authority',
      agency: 'Step Up',
    };
    await w.contacts.update(id, {
      organization: 'Step Up',
      caseworker_conversion: record,
      type_source: 'manual',
      caseworker_review: 'dismissed',
    });
    const stored = await w.readContact(id);
    // Typed reads: these four lines are what `npm run typecheck` checks.
    const organization: string | undefined = stored?.organization;
    const conversion: CaseworkerConversionRecord | undefined = stored?.caseworker_conversion;
    const typeSource: 'manual' | undefined = stored?.type_source;
    const review: 'dismissed' | undefined = stored?.caseworker_review;
    expect({ organization, conversion, typeSource, review }).toEqual({
      organization: 'Step Up',
      conversion: record,
      typeSource: 'manual',
      review: 'dismissed',
    });
  });
});

const idsOf = (contacts: ContactItem[]): string[] => contacts.map((c) => c.contactId).sort();

describe('contactsRepo.findAllByPhone / findAllByEmail (plan 3.3; D21 "own thread")', () => {
  parity('returns EVERY live holder of a phone - duplicate primaries and a pointer owner - as whole contacts', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({ contactId: `${id}-a`, type: 'tenant', status: 'searching', phone, firstName: 'Ana' });
    await w.putContact({ contactId: `${id}-b`, type: 'unknown', status: 'needs_review', phone });
    await w.putContact({ contactId: `${id}-c`, type: 'partner', status: 'active', phone: nextPhone() });
    await w.putPointer('phone', phone, `${id}-c`);
    const holders = await w.contacts.findAllByPhone(phone);
    expect(idsOf(holders)).toEqual([`${id}-a`, `${id}-b`, `${id}-c`]);
    expect(holders.some((c) => c.phone_ref === true)).toBe(false);
    expect(holders.find((c) => c.contactId === `${id}-a`)?.firstName).toBe('Ana');
  });

  parity('lists a holder once when it is reached as a primary AND through a pointer', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({ contactId: `${id}-a`, type: 'tenant', status: 'searching', phone });
    await w.putPointer('phone', phone, `${id}-a`);
    expect(idsOf(await w.contacts.findAllByPhone(phone))).toEqual([`${id}-a`]);
  });

  parity('drops soft-deleted holders and dangling pointers; an unknown phone answers []', async (w, id) => {
    const deletedAt = '2026-10-07T09:00:00.000Z';
    const phone = nextPhone();
    await w.putContact({ contactId: `${id}-live`, type: 'tenant', status: 'searching', phone });
    await w.putContact({ contactId: `${id}-gone`, type: 'tenant', status: 'searching', phone, deleted_at: deletedAt });
    expect(idsOf(await w.contacts.findAllByPhone(phone))).toEqual([`${id}-live`]);

    const dangling = nextPhone();
    await w.putPointer('phone', dangling, `${id}-missing`);
    expect(await w.contacts.findAllByPhone(dangling)).toEqual([]);

    const deletedOwner = nextPhone();
    await w.putContact({ contactId: `${id}-del-owner`, type: 'partner', status: 'active', phone: nextPhone(), deleted_at: deletedAt });
    await w.putPointer('phone', deletedOwner, `${id}-del-owner`);
    expect(await w.contacts.findAllByPhone(deletedOwner)).toEqual([]);

    expect(await w.contacts.findAllByPhone(nextPhone())).toEqual([]);
  });

  parity('(PIN) findByPhone still answers ONE holder of a shared phone', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({ contactId: `${id}-a`, type: 'tenant', status: 'searching', phone });
    await w.putContact({ contactId: `${id}-b`, type: 'tenant', status: 'searching', phone });
    const one = await w.contacts.findByPhone(phone);
    expect([`${id}-a`, `${id}-b`]).toContain(one?.contactId);
  });

  parity('findAllByEmail: the same contract on the byEmail index', async (w, id) => {
    const shared = `${id}-shared@example.test`;
    await w.putContact({ contactId: `${id}-a`, type: 'tenant', status: 'searching', email: shared });
    await w.putContact({ contactId: `${id}-gone`, type: 'tenant', status: 'searching', email: shared, deleted_at: '2026-10-07T09:00:00.000Z' });
    await w.putContact({ contactId: `${id}-c`, type: 'landlord', status: 'active', email: `${id}-c@example.test` });
    await w.putPointer('email', shared, `${id}-c`);
    expect(idsOf(await w.contacts.findAllByEmail(shared))).toEqual([`${id}-a`, `${id}-c`]);
    expect(await w.contacts.findAllByEmail(`${id}-nobody@example.test`)).toEqual([]);
  });
});

describe('contactsRepo.getRecipientDisplaysByIds (plan 3.3; R3-F4)', () => {
  parity('projects the display fields plus type and role - nothing else; a missing id is absent', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({
      contactId: `${id}-p`,
      type: 'partner',
      status: 'active',
      firstName: 'Pat',
      lastName: 'Lee',
      phone,
      role: 'Caseworker',
      organization: 'Step Up',
      housingAuthority: 'Atlanta Housing Authority',
      notes: 'not projected',
    });
    await w.putContact({
      contactId: `${id}-t`,
      type: 'tenant',
      status: 'searching',
      firstName: 'Tia',
      deleted_at: '2026-10-07T09:00:00.000Z',
    });
    const map = await w.contacts.getRecipientDisplaysByIds([`${id}-p`, `${id}-t`, `${id}-missing`]);
    expect(map.get(`${id}-p`)).toEqual({
      contactId: `${id}-p`,
      firstName: 'Pat',
      lastName: 'Lee',
      phone,
      type: 'partner',
      role: 'Caseworker',
    });
    expect(map.get(`${id}-t`)).toEqual({
      contactId: `${id}-t`,
      firstName: 'Tia',
      type: 'tenant',
      deleted_at: '2026-10-07T09:00:00.000Z',
    });
    expect(map.has(`${id}-missing`)).toBe(false);
  });

  parity('(PIN) getDisplaysByIds keeps its narrower projection - no type, no role', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({ contactId: id, type: 'partner', status: 'active', firstName: 'Pat', phone, role: 'Caseworker' });
    expect((await w.contacts.getDisplaysByIds([id])).get(id)).toEqual({ contactId: id, firstName: 'Pat', phone });
  });
});

describe('conversationsRepo.setTypeIfCurrent (plan 3.3 as amended; D21)', () => {
  parity('re-types while the stored type is the expected one, writes the display name, and answers the fresh row', async (w) => {
    const phone = nextPhone();
    const conv = await w.conversations.createOrGetByParticipantPhone(phone, 'unknown_1to1');
    const result = await w.conversations.setTypeIfCurrent(conv.conversationId, 'unknown_1to1', 'partner_1to1', 'Pat Lee');
    expect(result.outcome).toBe('updated');
    if (result.outcome === 'updated') {
      expect(result.conversation).toMatchObject({
        conversationId: conv.conversationId,
        type: 'partner_1to1',
        participant_display_name: 'Pat Lee',
        participant_phone: phone,
      });
    }
    expect(await w.readConversation(conv.conversationId)).toMatchObject({
      type: 'partner_1to1',
      participant_display_name: 'Pat Lee',
      participant_phone: phone,
      status: 'open',
    });
  });

  parity('skips - writing nothing, never throwing - when the stored type is no longer the expected one', async (w) => {
    const conv = await w.conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    expect(
      await w.conversations.setTypeIfCurrent(conv.conversationId, 'unknown_1to1', 'partner_1to1', 'Pat Lee'),
    ).toEqual({ outcome: 'skipped' });
    const stored = await w.readConversation(conv.conversationId);
    expect(stored?.type).toBe('tenant_1to1');
    expect(stored).not.toHaveProperty('participant_display_name');
  });

  parity('a null displayName leaves the stored name untouched', async (w) => {
    const conv = await w.conversations.createOrGetByParticipantPhone(nextPhone(), 'unknown_1to1');
    await w.conversations.applyTriage(conv.conversationId, { displayName: 'Old Name' });
    const result = await w.conversations.setTypeIfCurrent(conv.conversationId, 'unknown_1to1', 'partner_1to1', null);
    expect(result.outcome).toBe('updated');
    expect(await w.readConversation(conv.conversationId)).toMatchObject({
      type: 'partner_1to1',
      participant_display_name: 'Old Name',
    });
  });

  parity('a type-less legacy row and a missing conversation both skip', async (w, id) => {
    await w.putConversation({
      conversationId: `${id}-legacy`,
      participant_phone: nextPhone(),
      status: 'open',
      last_activity_at: '2026-10-07T09:00:00.000Z',
      ai_mode: 'auto',
      created_at: '2026-10-07T09:00:00.000Z',
    });
    expect(
      await w.conversations.setTypeIfCurrent(`${id}-legacy`, 'unknown_1to1', 'partner_1to1', null),
    ).toEqual({ outcome: 'skipped' });
    expect(await w.readConversation(`${id}-legacy`)).not.toHaveProperty('type');
    expect(
      await w.conversations.setTypeIfCurrent(`${id}-missing`, 'unknown_1to1', 'partner_1to1', null),
    ).toEqual({ outcome: 'skipped' });
    expect(await w.readConversation(`${id}-missing`)).toBeUndefined();
  });
});

const DELETED_AT = '2026-10-07T09:00:00.000Z';

function unitRow(unitId: string, extra: Partial<UnitItem> = {}): UnitItem {
  return { unitId, landlordId: 'contact-landlord-parity', status: 'available', ...extra };
}

/** Walk every page of a unit list - the caller-side cursor loop the roster refusal runs. */
async function walk(page: (cursor: Record<string, unknown> | undefined) => Promise<UnitsPage>): Promise<UnitItem[]> {
  const out: UnitItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const p = await page(cursor);
    out.push(...p.items);
    cursor = p.lastEvaluatedKey;
    pages += 1;
  } while (cursor !== undefined && pages < 1_000);
  return out;
}

/** This case's unit ids, sorted (the real table holds every real case's units). */
const mine = (units: UnitItem[], id: string): string[] =>
  units.map((u) => u.unitId).filter((unitId) => unitId.startsWith(`${id}-`)).sort();

describe('unit lists - paging and the deleted scope (plan 3.3 as amended)', () => {
  parity('a no-limit walk of list() returns EVERY live unit - no silent 50 cap', async (w, id) => {
    const ids = Array.from({ length: 55 }, (_, i) => `${id}-u${String(i).padStart(2, '0')}`);
    await Promise.all(ids.map((unitId) => w.putUnit(unitRow(unitId))));
    const seen = await walk((cursor) => w.units.list({ ...(cursor !== undefined && { exclusiveStartKey: cursor }) }));
    expect(mine(seen, id)).toEqual(ids);
  });

  parity('a limit-2 walk of list() follows the cursor to every live unit', async (w, id) => {
    const ids = [`${id}-a`, `${id}-b`, `${id}-c`, `${id}-d`, `${id}-e`];
    for (const unitId of ids) await w.putUnit(unitRow(unitId));
    const seen = await walk((cursor) =>
      w.units.list({ limit: 2, ...(cursor !== undefined && { exclusiveStartKey: cursor }) }),
    );
    expect(mine(seen, id)).toEqual(ids);
  });

  parity("list(): deleted 'any' returns live AND deleted; the default and true scopes are unchanged", async (w, id) => {
    await w.putUnit(unitRow(`${id}-live`));
    await w.putUnit(unitRow(`${id}-gone`, { deleted_at: DELETED_AT }));
    const scope = (deleted: boolean | 'any' | undefined) =>
      walk((cursor) =>
        w.units.list({
          ...(deleted !== undefined && { deleted }),
          ...(cursor !== undefined && { exclusiveStartKey: cursor }),
        }),
      );
    expect(mine(await scope(undefined), id)).toEqual([`${id}-live`]);
    expect(mine(await scope(true), id)).toEqual([`${id}-gone`]);
    expect(mine(await scope('any'), id)).toEqual([`${id}-gone`, `${id}-live`]);
  });

  parity("listByLandlord: deleted 'any' returns the landlord's live AND deleted units", async (w, id) => {
    const landlordId = `${id}-landlord`;
    await w.putUnit(unitRow(`${id}-live`, { landlordId }));
    await w.putUnit(unitRow(`${id}-gone`, { landlordId, deleted_at: DELETED_AT }));
    await w.putUnit(unitRow(`${id}-other`, { landlordId: `${id}-someone-else` }));
    const any = await walk((cursor) =>
      w.units.listByLandlord(landlordId, { deleted: 'any', ...(cursor !== undefined && { exclusiveStartKey: cursor }) }),
    );
    expect(mine(any, id)).toEqual([`${id}-gone`, `${id}-live`]);
    const live = await walk((cursor) =>
      w.units.listByLandlord(landlordId, { ...(cursor !== undefined && { exclusiveStartKey: cursor }) }),
    );
    expect(mine(live, id)).toEqual([`${id}-live`]);
  });
});

// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
