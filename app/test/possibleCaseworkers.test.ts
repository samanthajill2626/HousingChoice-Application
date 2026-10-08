// The Possible caseworkers read (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D22; plan 3.4) on contactsPartitionFake, which models the byTypeStatus
// GSI as DynamoDB runs it (Limit before the deleted filter, pointer rows
// invisible), so the paging below is the production paging.
import { describe, expect, it } from 'vitest';
import type { ContactItem, ContactType, ListContactsOpts } from '../src/repos/contactsRepo.js';
import { listPossibleCaseworkers } from '../src/services/possibleCaseworkers.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';

const AI_LINE = '[Auto - Oct 7] Identified as a caseworker at Hope Atlanta';

function depsOver(seed: ContactItem[]) {
  const calls: Array<{ type: ContactType } & ListContactsOpts> = [];
  const deps = {
    contacts: {
      async listByType(type: ContactType, opts: ListContactsOpts = {}) {
        calls.push({ type, ...opts });
        // Explicit page size: the fake models Limit, not the real 1 MB boundary.
        return listByTypeFromContacts(seed, type, { limit: 50, ...opts });
      },
    },
  };
  return { deps, calls };
}

function c(contactId: string, type: ContactType, over: Partial<ContactItem> = {}): ContactItem {
  const status = type === 'tenant' ? 'onboarding' : type === 'landlord' ? 'interested' : 'active';
  return { contactId, type, status, ...over } as ContactItem;
}

describe('listPossibleCaseworkers', () => {
  it('finds each signal on the right base, in signal declaration order', async () => {
    const { deps } = depsOver([
      c('t-role', 'tenant', { role: 'Case Manager', lastName: 'A' }),
      c('l-role', 'landlord', { role: 'caseworker - DCA', lastName: 'B' }),
      c('t-ai', 'tenant', { notes: `Moved in March\n${AI_LINE}`, lastName: 'C' }),
      c('t-both', 'tenant', { role: 'Case Worker', notes: AI_LINE, lastName: 'D' }),
      c('t-linked', 'tenant', { lastName: 'E' }),
      c('p-none', 'partner', { lastName: 'F' }),
      // linkers: one relationship row that counts, three that do not
      c('l-linker', 'landlord', {
        relationships: [
          { role: 'Case worker', name: 'E', contactId: 't-linked' },
          { role: 'Sister', name: 'X', contactId: 't-role' },
          { role: 'Caseworker', name: 'No link' },
          { role: 'Caseworker', name: 'A landlord', contactId: 'l-role' },
        ],
        role: 'Owner',
        lastName: 'Z',
      }),
    ]);
    const rows = await listPossibleCaseworkers(deps);
    expect(rows.map((r) => [r.contactId, r.signals])).toEqual([
      ['t-role', ['role_mentions']],
      ['l-role', ['role_mentions']],
      ['t-ai', ['ai_note']],
      ['t-both', ['role_mentions', 'ai_note']],
      ['t-linked', ['relationship']],
      ['p-none', ['partner_no_role']],
    ]);
  });

  it('does not count: an AI line without the prefix, role_title, a partner with any role, an AI line or link on a landlord', async () => {
    const { deps } = depsOver([
      c('t-plain', 'tenant', { notes: 'Identified as a caseworker at Hope Atlanta' }),
      c('t-title', 'tenant', { role_title: 'Caseworker' }),
      c('p-cm', 'partner', { role: 'Case Manager' }),
      c('p-insp', 'partner', { role: 'Inspector' }),
      c('l-ai', 'landlord', { notes: AI_LINE }),
    ]);
    expect(await listPossibleCaseworkers(deps)).toEqual([]);
  });

  it('excludes caseworkers, dismissed and deleted contacts', async () => {
    const { deps } = depsOver([
      c('p-cw', 'partner', { role: 'Caseworker' }),
      c('p-cw2', 'partner', { role: 'case worker' }),
      c('p-dis', 'partner', { caseworker_review: 'dismissed' }),
      c('t-dis', 'tenant', { role: 'Case Manager', caseworker_review: 'dismissed' }),
      c('p-del', 'partner', { deleted_at: '2026-10-05T00:00:00.000Z' }),
    ]);
    expect(await listPossibleCaseworkers(deps)).toEqual([]);
  });

  it('reads the tenant, landlord and partner partitions to exhaustion, and nothing else', async () => {
    const partners = Array.from({ length: 120 }, (_, i) => c(`p-${String(i).padStart(3, '0')}`, 'partner'));
    const { deps, calls } = depsOver([...partners, c('u-1', 'unknown'), c('tm-1', 'team_member', { role: 'Caseworker' })]);
    const rows = await listPossibleCaseworkers(deps);
    expect(rows).toHaveLength(120);
    expect([...new Set(calls.map((x) => x.type))].sort()).toEqual(['landlord', 'partner', 'tenant']);
  });

  it('sorts by last name, first name, contactId (case-insensitive), and shapes the row', async () => {
    const { deps } = depsOver([
      c('p-2', 'partner', { firstName: 'Bo', lastName: 'smith', phone: '+15550107040' }),
      c('p-1', 'partner', { firstName: 'Al', lastName: 'Smith' }),
      c('p-3', 'partner', { firstName: 'Al', lastName: 'Smith' }),
      c('t-1', 'tenant', { firstName: 'Cy', lastName: 'Adams', role: 'Case Manager' }),
      c('p-0', 'partner'),
    ]);
    const rows = await listPossibleCaseworkers(deps);
    expect(rows.map((r) => r.contactId)).toEqual(['p-0', 't-1', 'p-1', 'p-3', 'p-2']);
    expect(rows[1]).toEqual({
      contactId: 't-1', firstName: 'Cy', lastName: 'Adams', type: 'tenant', role: 'Case Manager', signals: ['role_mentions'],
    });
    expect(rows[4]).toEqual({
      contactId: 'p-2', firstName: 'Bo', lastName: 'smith', phone: '+15550107040', type: 'partner', signals: ['partner_no_role'],
    });
  });
});

describe('partition and signal boundaries', () => {
  it('continues after empty deleted pages using the full partition cursor', async () => {
    const deleted = Array.from({ length: 100 }, (_, i) => c('p-' + String(i).padStart(3, '0'), 'partner', { deleted_at: '2026-10-01T00:00:00.000Z' }));
    const sparse = c('sparse', 'partner');
    delete sparse.status;
    const { deps, calls } = depsOver([
      ...deleted, c('p-visible', 'partner'), sparse,
      c('phone-pointer', 'partner', { phone_ref: true }),
      c('email-pointer', 'partner', { email_ref: true }),
    ]);
    expect((await listPossibleCaseworkers(deps)).map((row) => row.contactId)).toEqual(['p-visible']);
    expect(calls.filter((call) => call.type === 'partner')).toEqual([
      { type: 'partner' },
      { type: 'partner', exclusiveStartKey: { type: 'partner', status: 'active', contactId: 'p-049' } },
      { type: 'partner', exclusiveStartKey: { type: 'partner', status: 'active', contactId: 'p-099' } },
    ]);
  });

  it('reads the extra empty page when a partition exactly fills its limit', async () => {
    const seed = Array.from({ length: 50 }, (_, i) => c('p-' + i, 'partner'));
    const { deps, calls } = depsOver(seed);
    expect(await listPossibleCaseworkers(deps)).toHaveLength(50);
    expect(calls.filter((call) => call.type === 'partner')).toHaveLength(2);
  });

  it('orders all tenant signals and ignores relationships held outside the three live partitions', async () => {
    const { deps } = depsOver([
      c('combined', 'tenant', { role: 'Case manager', notes: AI_LINE }),
      c('unknown-linked', 'tenant'), c('team-linked', 'tenant'), c('deleted-linked', 'tenant'),
      c('staff-note', 'tenant', { staff_notes: AI_LINE }),
      c('holder', 'landlord', { relationships: [{ role: 'Lead case worker', name: 'Combined', contactId: 'combined' }] }),
      c('unknown-holder', 'unknown', { relationships: [{ role: 'Caseworker', name: 'Unknown link', contactId: 'unknown-linked' }] }),
      c('team-holder', 'team_member', { relationships: [{ role: 'Caseworker', name: 'Team link', contactId: 'team-linked' }] }),
      c('deleted-holder', 'partner', { deleted_at: '2026-10-01T00:00:00.000Z', relationships: [{ role: 'Caseworker', name: 'Deleted link', contactId: 'deleted-linked' }] }),
    ]);
    expect((await listPossibleCaseworkers(deps)).map((row) => [row.contactId, row.signals])).toEqual([
      ['combined', ['role_mentions', 'ai_note', 'relationship']],
    ]);
  });
});

// C3: parseRelationships permits self-links; D19 requires another holder.
describe('relationship holder identity', () => {
  it('does not treat a self-link as another contact linking this tenant', async () => {
    const { deps } = depsOver([
      c('self', 'tenant', { relationships: [{ role: 'Caseworker', name: 'Self', contactId: 'self' }] }),
      c('other-linked', 'tenant'),
      c('linker', 'landlord', { relationships: [{ role: 'Caseworker', name: 'Other', contactId: 'other-linked' }] }),
    ]);
    expect((await listPossibleCaseworkers(deps)).map((row) => [row.contactId, row.signals])).toEqual([
      ['other-linked', ['relationship']],
    ]);
  });
});
