// Audience resolution - the share-broadcast (Matching blast) filter resolver.
//
// matching-blast-rules (spec 2026-10-14) D1, D2, D10: a FILTER audience reads
// ONLY the byTypeStatus partitions (tenant, searching) and then (tenant,
// onboarding) - searching FIRST, under one page bound - and narrows by an
// any-of housing authority list IN MEMORY; the byHousingAuthority GSI is kept
// but never read here. Caseworkers (partners) never resolve. The fences that
// predate it are pinned too: opt-out, unreachable, phone, exact voucher size,
// the per-candidate consent flag, the page cap.
//
// listByType is served by helpers/contactsPartitionFake.ts, which models the
// GSI as DynamoDB runs it (status partitions, range-key order, the
// limit-reached cursor). The harness fake returns seed order, so it could not
// show the read order at all.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem, ContactsRepo, ListContactsOpts } from '../src/repos/contactsRepo.js';
import type { AudienceFilter } from '../src/repos/broadcastsRepo.js';
import { createAudienceResolutionService } from '../src/services/audienceResolution.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';
import { createLogCapture } from './helpers/logCapture.js';

const logger = createLogger({ destination: createLogCapture().stream });

function tenant(overrides: Partial<ContactItem>): ContactItem {
  return {
    contactId: `c-${Math.random().toString(36).slice(2, 8)}`,
    type: 'tenant',
    // D1: a filter audience reads only searching and onboarding tenants, so
    // the default is one of them; a case about another status says so.
    status: 'searching',
    phone: `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    ...overrides,
  };
}

interface TypeQuery {
  type: string;
  status: string | undefined;
}

/**
 * A contactsRepo whose listByType is contactsPartitionFake - or, with
 * `leaky`, a BROKEN index that hands back every item on every call whatever
 * the type and status, to pin the resolver's own in-memory fences. Records
 * each listByType call (type + status) and each listByHousingAuthority call.
 */
function fakeContacts(
  items: ContactItem[],
  opts: { leaky?: boolean } = {},
): ContactsRepo & { typeQueries: TypeQuery[]; haQueries: string[] } {
  const typeQueries: TypeQuery[] = [];
  const haQueries: string[] = [];
  return {
    typeQueries,
    haQueries,
    async listByType(type, listOpts: ListContactsOpts = {}) {
      typeQueries.push({ type, status: listOpts.status });
      if (opts.leaky === true) return { items: [...items] };
      return listByTypeFromContacts(items, type, listOpts);
    },
    async listByHousingAuthority(ha) {
      haQueries.push(ha);
      return { items: items.filter((c) => c['housingAuthority'] === ha) };
    },
    async findByPhone() {
      return undefined;
    },
    async getById() {
      return undefined;
    },
    async getDisplayById() {
      return undefined;
    },
    async getDisplaysByIds() {
      return new Map();
    },
    async getManyByIds() {
      return new Map();
    },
    async create() {
      throw new Error('unused');
    },
    async createIfAbsent() {
      return true;
    },
    async setFlag() {},
    async clearFlag() {},
    async softDelete(contactId) {
      return { contactId, type: 'tenant' };
    },
    async restore(contactId) {
      return { contactId, type: 'tenant' };
    },
    async update(contactId) {
      return { contactId, type: 'tenant' };
    },
    async addPhone(contactId) {
      return { contactId, type: 'tenant' };
    },
    async setPhone(contactId) {
      return { contactId, type: 'tenant' };
    },
    async removePhone(contactId) {
      return { contactId, type: 'tenant' };
    },
    async touchPhoneLastSeen() {},
    // Email-channel A1 primitives - unused by audience resolution.
    async findByEmail() {
      return undefined;
    },
    async addEmail(contactId) {
      return { contactId, type: 'tenant' };
    },
    async setPrimaryEmail(contactId) {
      return { contactId, type: 'tenant' };
    },
    async removeEmail(contactId) {
      return { contactId, type: 'tenant' };
    },
    async touchEmailLastSeen() {},
    stampGroupParticipation: async () => {
      throw new Error('stampGroupParticipation: not used in this suite');
    },
    rewriteOrgFields: async () => {
      throw new Error('rewriteOrgFields: not used in this suite');
    },
    getRecipientDisplaysByIds: async () => {
      throw new Error('getRecipientDisplaysByIds: not used in this suite');
    },
    findAllByPhone: async () => {
      throw new Error('findAllByPhone: not used in this suite');
    },
    findAllByEmail: async () => {
      throw new Error('findAllByEmail: not used in this suite');
    },
    touchLastHeardFrom: async () => {
      throw new Error('touchLastHeardFrom: not used in this suite');
    },
  };
}

const ALWAYS_EXCLUDE = { excludeOptedOut: true, excludeUnreachable: true } as const;
const TENANTS: AudienceFilter = { contact_type: 'tenant', ...ALWAYS_EXCLUDE };

describe('audience resolution - D1: only searching and onboarding, searching first', () => {
  it('resolves ONLY searching and onboarding tenants, whatever other statuses exist', async () => {
    const statuses = ['needs_review', 'onboarding', 'searching', 'placing', 'placed', 'on_hold', 'inactive'];
    const items = statuses.map((status) => tenant({ contactId: `c-${status}`, status }));
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-searching', 'c-onboarding']);
    expect(out.count).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('reads the searching partition FIRST, then onboarding - never an un-narrowed read, never byHousingAuthority', async () => {
    // Range-key order is ascending and 'onboarding' < 'searching', so an
    // un-narrowed read (or onboarding read first) puts the onboarding rows first.
    const items = [
      tenant({ contactId: 'c-a', status: 'onboarding', housingAuthority: 'HA-A' }),
      tenant({ contactId: 'c-b', status: 'searching', housingAuthority: 'HA-A' }),
      tenant({ contactId: 'c-c', status: 'onboarding', housingAuthority: 'HA-A' }),
      tenant({ contactId: 'c-d', status: 'searching', housingAuthority: 'HA-A' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger });

    const all = await resolve(TENANTS);
    expect(all.contactIds).toEqual(['c-b', 'c-d', 'c-a', 'c-c']);
    const listed = await resolve({ ...TENANTS, housing_authorities: ['HA-A'] });
    expect(listed.contactIds).toEqual(['c-b', 'c-d', 'c-a', 'c-c']);

    expect(contacts.typeQueries).toEqual([
      { type: 'tenant', status: 'searching' },
      { type: 'tenant', status: 'onboarding' },
      { type: 'tenant', status: 'searching' },
      { type: 'tenant', status: 'onboarding' },
    ]);
    expect(contacts.haQueries).toEqual([]);
  });

  it('the page bound cuts ONBOARDING, never searching: searching is read to its end first', async () => {
    // pageSize 2, maxPages 2: searching takes both pages ([s1,s2] then [s3]),
    // so the onboarding partition is left unread - truncated.
    const items = [
      tenant({ contactId: 'c-s1', status: 'searching' }),
      tenant({ contactId: 'c-s2', status: 'searching' }),
      tenant({ contactId: 'c-s3', status: 'searching' }),
      tenant({ contactId: 'c-o1', status: 'onboarding' }),
      tenant({ contactId: 'c-o2', status: 'onboarding' }),
      tenant({ contactId: 'c-o3', status: 'onboarding' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger, pageSize: 2, maxPages: 2 });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-s1', 'c-s2', 'c-s3']);
    expect(out.truncated).toBe(true);
    expect(contacts.typeQueries.map((q) => q.status)).toEqual(['searching', 'searching']);
  });

  it('a cut inside searching never reads onboarding at all', async () => {
    const items = [
      ...['c-s1', 'c-s2', 'c-s3', 'c-s4', 'c-s5'].map((contactId) => tenant({ contactId, status: 'searching' })),
      tenant({ contactId: 'c-o1', status: 'onboarding' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger, pageSize: 2, maxPages: 2 });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-s1', 'c-s2', 'c-s3', 'c-s4']);
    expect(out.truncated).toBe(true);
    expect(contacts.typeQueries.map((q) => q.status)).toEqual(['searching', 'searching']);
  });

  it('maxPages counts the TOTAL pages across both partitions', async () => {
    // pageSize 2, maxPages 3. searching: [s1,s2] reaches the limit, so the
    // index answers a cursor and an EMPTY second page (2 pages); onboarding:
    // [o1,o2] is page 3 and reaches the limit - a page is still unread.
    const items = [
      tenant({ contactId: 'c-s1', status: 'searching' }),
      tenant({ contactId: 'c-s2', status: 'searching' }),
      tenant({ contactId: 'c-o1', status: 'onboarding' }),
      tenant({ contactId: 'c-o2', status: 'onboarding' }),
      tenant({ contactId: 'c-o3', status: 'onboarding' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger, pageSize: 2, maxPages: 3 });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-s1', 'c-s2', 'c-o1', 'c-o2']);
    expect(out.truncated).toBe(true);
    expect(contacts.typeQueries.map((q) => q.status)).toEqual(['searching', 'searching', 'onboarding']);
  });

  it('a cap met exactly at the end of the LAST partition is complete, not truncated', async () => {
    const items = [
      tenant({ contactId: 'c-s1', status: 'searching' }),
      tenant({ contactId: 'c-o1', status: 'onboarding' }),
    ];
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items),
      logger,
      pageSize: 2,
      maxPages: 2,
    });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-s1', 'c-o1']);
    expect(out.truncated).toBe(false);
  });

  it('ADV-5: a tenant moved searching -> onboarding between the two partition reads resolves ONCE, the searching row', async () => {
    // The two partition reads are not a snapshot. The searching walk returns
    // the mover; a staff PATCH then moves them to onboarding; the onboarding
    // walk returns them AGAIN, now with that partition's own status, so the
    // status belt keeps that row too.
    const items = [
      tenant({ contactId: 'c-mover', status: 'searching' }),
      tenant({ contactId: 'c-o1', status: 'onboarding' }),
    ];
    const contacts = fakeContacts(items);
    const read = contacts.listByType;
    contacts.listByType = async (type, listOpts) => {
      const page = await read(type, listOpts);
      // The PATCH lands right after the searching read.
      if (listOpts?.status === 'searching') items[0] = { ...items[0]!, status: 'onboarding' };
      return page;
    };
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger });
    const out = await resolve(TENANTS);
    expect(contacts.typeQueries.map((q) => q.status)).toEqual(['searching', 'onboarding']);
    expect(out.contactIds).toEqual(['c-mover', 'c-o1']);
    expect(out.count).toBe(2);
    expect(out.contacts).toHaveLength(2);
    // First row wins: the searching read's row, read first.
    expect(out.contacts[0]).toMatchObject({ contactId: 'c-mover', status: 'searching' });
  });

  it('(PIN) a soft-deleted tenant stays hidden (listByType default scope)', async () => {
    const items = [
      tenant({ contactId: 'c-live' }),
      tenant({ contactId: 'c-gone', deleted_at: '2026-10-01T00:00:00.000Z' }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    expect((await resolve(TENANTS)).contactIds).toEqual(['c-live']);
  });
});

describe('audience resolution - D2: the housing authority list, any-of, in memory', () => {
  const items = [
    tenant({ contactId: 'c-a', housingAuthority: 'HA-A' }),
    tenant({ contactId: 'c-b', housingAuthority: '  HA-B ' }),
    tenant({ contactId: 'c-c', housingAuthority: 'HA-C' }),
    tenant({ contactId: 'c-none' }),
    tenant({ contactId: 'c-blank', housingAuthority: '   ' }),
  ];

  it('matches ANY member against the trimmed housingAuthority; missing, blank and non-member tenants are left out', async () => {
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({ ...TENANTS, housing_authorities: ['HA-A', 'HA-B'] });
    expect(out.contactIds).toEqual(['c-a', 'c-b']);
    // The row shows the trimmed value.
    expect(out.contacts.find((c) => c.contactId === 'c-b')?.housingAuthority).toBe('HA-B');
  });

  it('an EMPTY list, or none, is no authority filter: every authority and none resolve', async () => {
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const everyone = ['c-a', 'c-b', 'c-blank', 'c-c', 'c-none'];
    expect((await resolve({ ...TENANTS, housing_authorities: [] })).contactIds).toEqual(everyone);
    expect((await resolve(TENANTS)).contactIds).toEqual(everyone);
  });

  it('LEGACY stored string: housing_authority is read as a one-member list', async () => {
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger });
    const out = await resolve({ ...TENANTS, housing_authority: 'HA-A' });
    expect(out.contactIds).toEqual(['c-a']);
    expect(contacts.haQueries).toEqual([]);
  });

  it('members are read like any stored list (authoritiesOfFilter): trimmed, blanks ignored', async () => {
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({ ...TENANTS, housing_authorities: [' HA-C ', '', '  '] });
    expect(out.contactIds).toEqual(['c-c']);
  });

  it('combines the list with bedroomSize', async () => {
    const sized = [
      tenant({ contactId: 'a2', housingAuthority: 'HA-A', voucherSize: 2 }),
      tenant({ contactId: 'a3', housingAuthority: 'HA-A', voucherSize: 3 }),
      tenant({ contactId: 'b2', housingAuthority: 'HA-B', voucherSize: 2 }),
      tenant({ contactId: 'c2', housingAuthority: 'HA-C', voucherSize: 2 }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(sized), logger });
    const out = await resolve({ ...TENANTS, housing_authorities: ['HA-A', 'HA-B'], bedroomSize: 2 });
    expect(out.contactIds).toEqual(['a2', 'b2']);
  });
});

describe('audience resolution - D10: caseworkers and other types never resolve', () => {
  it('a partner with a matching authority never resolves, whatever its status', async () => {
    const items = [
      tenant({ contactId: 'c-t', housingAuthority: 'HA-A' }),
      ...['active', 'needs_review', 'searching', 'onboarding'].map((status) =>
        tenant({ contactId: `c-p-${status}`, type: 'partner', status, housingAuthority: 'HA-A' }),
      ),
      tenant({ contactId: 'c-ll', type: 'landlord', status: 'searching', housingAuthority: 'HA-A' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger });
    expect((await resolve({ ...TENANTS, housing_authorities: ['HA-A'] })).contactIds).toEqual(['c-t']);
    expect((await resolve(TENANTS)).contactIds).toEqual(['c-t']);
    expect(contacts.typeQueries.every((q) => q.type === 'tenant')).toBe(true);
    expect(contacts.haQueries).toEqual([]);
  });

  it('the in-memory fences hold even when the index hands back the wrong rows (type and status)', async () => {
    const items = [
      tenant({ contactId: 'c-s', status: 'searching' }),
      tenant({ contactId: 'c-o', status: 'onboarding' }),
      tenant({ contactId: 'c-placing', status: 'placing' }),
      tenant({ contactId: 'c-partner', type: 'partner', status: 'searching' }),
      tenant({ contactId: 'c-ll', type: 'landlord', status: 'onboarding' }),
    ];
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items, { leaky: true }),
      logger,
    });
    // Each partition read returns all five rows; only the row whose status IS
    // that partition's, and whose type is tenant, survives - once.
    expect((await resolve(TENANTS)).contactIds).toEqual(['c-s', 'c-o']);
  });
});

describe('audience resolution - the fences that predate the blast rules', () => {
  it('excludes opted-out AND unreachable contacts (the first TCPA fence) and a missing phone', async () => {
    const items = [
      tenant({ contactId: 'ok' }),
      tenant({ contactId: 'stopped', sms_opt_out: true }),
      tenant({ contactId: 'dead', sms_unreachable: true }),
      tenant({ contactId: 'nophone', phone: undefined }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['ok']);
  });

  it('bedroomSize filters on the contact voucherSize (exact match), in memory', async () => {
    const items = [
      tenant({ contactId: 'two', voucherSize: 2 }),
      tenant({ contactId: 'three', voucherSize: 3 }),
      tenant({ contactId: 'none' }), // no voucherSize
      tenant({ contactId: 'twoB', voucherSize: 2 }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({ ...TENANTS, bedroomSize: 2 });
    expect(out.contactIds.sort()).toEqual(['two', 'twoB']);
  });

  it('carries firstName + lastName + phone + status through (merge field / the review rows FULL name)', async () => {
    const items = [
      tenant({ contactId: 'c-1', firstName: 'Ann', lastName: 'Osei', phone: '+15551230001' }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    // has_consent:false here - this tenant has no recorded consent (A2P section 4).
    expect(out.contacts).toEqual([
      { contactId: 'c-1', phone: '+15551230001', firstName: 'Ann', lastName: 'Osei', has_consent: false, status: 'searching' },
    ]);
  });

  it('annotates each candidate with has_consent (A2P/CTIA - LOCKED CONTRACT 3)', async () => {
    const items = [
      tenant({ contactId: 'with', phone: '+15551230001', consent_method: 'inbound_text' }),
      tenant({ contactId: 'without', phone: '+15551230002' }), // no consent
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    const byId = Object.fromEntries(out.contacts.map((c) => [c.contactId, c.has_consent]));
    expect(byId).toEqual({ with: true, without: false });
  });

  it('last-heard-from 5.3: carries the tenant status and lastHeardFromAt (absent when the contact has none)', async () => {
    const items = [
      tenant({ contactId: 'c-1', status: 'searching', last_heard_from_at: '2026-10-05T16:20:00.000Z' }),
      tenant({ contactId: 'c-2', status: 'onboarding' }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    const byId = Object.fromEntries(out.contacts.map((c) => [c.contactId, c]));
    expect(byId['c-1']).toMatchObject({ status: 'searching', lastHeardFromAt: '2026-10-05T16:20:00.000Z' });
    expect(byId['c-2']).toMatchObject({ status: 'onboarding' });
    expect(byId['c-2']).not.toHaveProperty('lastHeardFromAt');
  });

  // group-texting A8, consumer 5 of 6 (audienceResolution.ts - staff display 1).
  it('shows has_consent FALSE for a silent group member (group_participation_at is not consent)', async () => {
    const items = [
      tenant({
        contactId: 'groupmember',
        phone: '+15551230003',
        group_participation_at: '2026-08-10T12:00:00.000Z',
      }),
      tenant({
        contactId: 'both',
        phone: '+15551230004',
        group_participation_at: '2026-08-10T12:00:00.000Z',
        consent_method: 'inbound_text',
      }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    const byId = Object.fromEntries(out.contacts.map((c) => [c.contactId, c.has_consent]));
    expect(byId).toEqual({ groupmember: false, both: true });
  });

  it('resolves cleanly within the page cap -> truncated:false (FIX 3)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => tenant({ contactId: `c-${i}` }));
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items),
      logger,
      pageSize: 2,
      maxPages: 50, // plenty of pages to exhaust 5 items
    });
    const out = await resolve(TENANTS);
    expect(out.count).toBe(5);
    expect(out.truncated).toBe(false);
  });

  it('hits the page cap with more candidates -> truncated:true (FIX 3)', async () => {
    // 10 candidates, pageSize 2, maxPages 2 -> only 4 resolved, more remain.
    const items = Array.from({ length: 10 }, (_, i) => tenant({ contactId: `c-${i}` }));
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items),
      logger,
      pageSize: 2,
      maxPages: 2,
    });
    const out = await resolve(TENANTS);
    expect(out.count).toBe(4); // 2 pages x 2
    expect(out.truncated).toBe(true);
  });

  it('logs counts only: `authorities` is the list size and the byHousingAuthority field is gone', async () => {
    const capture = createLogCapture();
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts([
        tenant({ contactId: 'c-a', housingAuthority: 'HA-A', firstName: 'Quillonette', phone: '+15559870001' }),
      ]),
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });
    await resolve({ ...TENANTS, housing_authorities: ['HA-A', 'HA-B'] });
    const line = capture.lines.find((l) => l['msg'] === 'broadcast audience resolved');
    expect(line).toMatchObject({ count: 1, authorities: 2, bedroomSizeFilter: null, truncated: false });
    expect(line).not.toHaveProperty('byHousingAuthority');
    // PII (doc section 9): counts only - no name, no phone.
    const dump = JSON.stringify(capture.lines);
    expect(dump).not.toContain('Quillonette');
    expect(dump).not.toContain('+15559870001');
  });
});
