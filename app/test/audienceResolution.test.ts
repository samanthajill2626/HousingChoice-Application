// Audience resolution (M1.8a) — the share-broadcast audience filter resolver.
// Asserts the housing-authority Query path, the byTypeStatus fallback, the
// in-memory bedroomSize/opt-out/unreachable filtering, and that opted-out +
// unreachable contacts are ALWAYS excluded (the first TCPA fence).
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem, ContactsRepo, ListContactsOpts } from '../src/repos/contactsRepo.js';
import type { AudienceFilter } from '../src/repos/broadcastsRepo.js';
import { createAudienceResolutionService } from '../src/services/audienceResolution.js';
import { createLogCapture } from './helpers/logCapture.js';

const logger = createLogger({ destination: createLogCapture().stream });

function tenant(overrides: Partial<ContactItem>): ContactItem {
  return {
    contactId: `c-${Math.random().toString(36).slice(2, 8)}`,
    type: 'tenant',
    status: 'active',
    phone: `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    ...overrides,
  };
}

/** A contactsRepo backed by a list, tracking which GSI method was queried. */
function fakeContacts(items: ContactItem[]): ContactsRepo & {
  typeQueries: string[];
  haQueries: string[];
} {
  const typeQueries: string[] = [];
  const haQueries: string[] = [];
  // Keyset paging by contactId so maxPages/truncation can be exercised: a page
  // resumes after the cursor and returns lastEvaluatedKey when more remain
  // (mirrors the GSI's ExclusiveStartKey/LastEvaluatedKey contract).
  const page = (arr: ContactItem[], opts: ListContactsOpts) => {
    let start = 0;
    const cursorId = (opts.exclusiveStartKey as { contactId?: string } | undefined)?.contactId;
    if (typeof cursorId === 'string') {
      const idx = arr.findIndex((c) => c.contactId === cursorId);
      if (idx >= 0) start = idx + 1;
    }
    const limit = opts.limit ?? 50;
    const window = arr.slice(start, start + limit);
    const hasMore = start + limit < arr.length;
    const last = window[window.length - 1];
    return {
      items: window,
      ...(hasMore && last !== undefined && { lastEvaluatedKey: { contactId: last.contactId } }),
    };
  };
  return {
    typeQueries,
    haQueries,
    async listByType(type, opts = {}) {
      typeQueries.push(type);
      return page(items.filter((c) => c.type === type), opts);
    },
    async listByHousingAuthority(ha, opts = {}) {
      haQueries.push(ha);
      return page(items.filter((c) => c['housingAuthority'] === ha), opts);
    },
    async findByPhone() {
      return undefined;
    },
    async getById() {
      return undefined;
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
  };
}

const ALWAYS_EXCLUDE = { excludeOptedOut: true, excludeUnreachable: true } as const;

describe('audience resolution (M1.8a)', () => {
  it('housing_authority set → Queries byHousingAuthority (never byTypeStatus)', async () => {
    const items = [
      tenant({ contactId: 'c-1', housingAuthority: 'HA-A', firstName: 'Ann' }),
      tenant({ contactId: 'c-2', housingAuthority: 'HA-A', firstName: 'Bo' }),
      tenant({ contactId: 'c-3', housingAuthority: 'HA-B' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger });
    const filter: AudienceFilter = { contact_type: 'tenant', housing_authority: 'HA-A', ...ALWAYS_EXCLUDE };
    const out = await resolve(filter);
    expect(out.count).toBe(2);
    expect(out.contactIds.sort()).toEqual(['c-1', 'c-2']);
    expect(contacts.haQueries).toEqual(['HA-A']);
  });

  it('no housing_authority → Queries byTypeStatus (type=tenant)', async () => {
    const items = [
      tenant({ contactId: 'c-1', firstName: 'Ann' }),
      tenant({ contactId: 'c-2' }),
      { ...tenant({ contactId: 'c-3' }), type: 'landlord' as const },
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger });
    const out = await resolve({ contact_type: 'tenant', ...ALWAYS_EXCLUDE });
    // Only tenants — the landlord is excluded.
    expect(out.contactIds.sort()).toEqual(['c-1', 'c-2']);
    expect(contacts.haQueries).toEqual([]);
  });

  it('excludes opted-out AND unreachable contacts (the first TCPA fence)', async () => {
    const items = [
      tenant({ contactId: 'ok' }),
      tenant({ contactId: 'stopped', sms_opt_out: true }),
      tenant({ contactId: 'dead', sms_unreachable: true }),
      tenant({ contactId: 'nophone', phone: undefined }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({ contact_type: 'tenant', ...ALWAYS_EXCLUDE });
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
    const out = await resolve({ contact_type: 'tenant', bedroomSize: 2, ...ALWAYS_EXCLUDE });
    expect(out.contactIds.sort()).toEqual(['two', 'twoB']);
  });

  it('carries firstName + phone through for the per-recipient merge field / send', async () => {
    const items = [tenant({ contactId: 'c-1', firstName: 'Ann', phone: '+15551230001' })];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({ contact_type: 'tenant', ...ALWAYS_EXCLUDE });
    expect(out.contacts).toEqual([{ contactId: 'c-1', phone: '+15551230001', firstName: 'Ann' }]);
  });

  it('combines housing_authority + bedroomSize', async () => {
    const items = [
      tenant({ contactId: 'a2', housingAuthority: 'HA-A', voucherSize: 2 }),
      tenant({ contactId: 'a3', housingAuthority: 'HA-A', voucherSize: 3 }),
      tenant({ contactId: 'b2', housingAuthority: 'HA-B', voucherSize: 2 }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({
      contact_type: 'tenant',
      housing_authority: 'HA-A',
      bedroomSize: 2,
      ...ALWAYS_EXCLUDE,
    });
    expect(out.contactIds).toEqual(['a2']);
  });

  it('resolves cleanly within the page cap → truncated:false (FIX 3)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => tenant({ contactId: `c-${i}` }));
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items),
      logger,
      pageSize: 2,
      maxPages: 50, // plenty of pages to exhaust 5 items
    });
    const out = await resolve({ contact_type: 'tenant', ...ALWAYS_EXCLUDE });
    expect(out.count).toBe(5);
    expect(out.truncated).toBe(false);
  });

  it('hits the page cap with more candidates → truncated:true (FIX 3)', async () => {
    // 10 candidates, pageSize 2, maxPages 2 → only 4 resolved, more remain.
    const items = Array.from({ length: 10 }, (_, i) => tenant({ contactId: `c-${i}` }));
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items),
      logger,
      pageSize: 2,
      maxPages: 2,
    });
    const out = await resolve({ contact_type: 'tenant', ...ALWAYS_EXCLUDE });
    expect(out.count).toBe(4); // 2 pages × 2
    expect(out.truncated).toBe(true);
  });
});
