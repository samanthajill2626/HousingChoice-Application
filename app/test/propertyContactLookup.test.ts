// Unit tests for the ONE property-contact lookup (primary-contact-integrity
// spec 4.1, plan contract 2.1 / C1): decidePropertyContact (PURE, over reads
// the caller already holds) and resolvePropertyContact (async, LAZY getById).
// Every case runs through BOTH, so the two walks cannot drift: the same
// answer, and the same candidate reads in the same order. PURE - no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  decidePropertyContact,
  resolvePropertyContact,
  type PropertyContactResult,
} from '../src/lib/propertyContact.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

type LookupUnit = Pick<UnitItem, 'contacts' | 'landlordId'>;
const DELETED_AT = '2026-10-01T00:00:00.000Z';
const contact = (o: Record<string, unknown>): ContactItem => o as unknown as ContactItem;
const unit = (o: Record<string, unknown>): LookupUnit => o as unknown as LookupUnit;

const PM = contact({ contactId: 'c-pm', type: 'landlord', firstName: 'Dana' });
const PM_DELETED = contact({ contactId: 'c-pm', type: 'landlord', firstName: 'Dana', deleted_at: DELETED_AT });
const LL = contact({ contactId: 'c-ll', type: 'landlord', firstName: 'Lee' });
const LL_DELETED = contact({ contactId: 'c-ll', type: 'landlord', firstName: 'Lee', deleted_at: DELETED_AT });
const TENANT_RECORD = contact({ contactId: 'c-t', type: 'tenant', firstName: 'Alice' });

/** A PM flagged primary next to the landlord of record (the PM-property shape). */
const PM_PRIMARY = unit({
  landlordId: 'c-ll',
  contacts: [
    { contactId: 'c-ll', role: 'landlord', primaryContact: false },
    { contactId: 'c-pm', role: 'pm', primaryContact: true },
  ],
});

interface Case {
  name: string;
  unit: LookupUnit;
  tenantId?: string;
  /** contactId -> record. An id absent here has NO record (hard-deleted). */
  records: Record<string, ContactItem>;
  /** ids whose read THROWS. */
  throwing?: string[];
  expected: PropertyContactResult;
  /** The candidate reads the walk makes, in order. */
  reads: string[];
}

const CASES: Case[] = [
  {
    name: 'a live flagged primary is found - the landlord of record is never read',
    unit: PM_PRIMARY,
    records: { 'c-pm': PM, 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-pm', contact: PM },
    reads: ['c-pm'],
  },
  {
    name: 'zero-primary falls back to the live landlord of record',
    unit: unit({
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
    }),
    records: { 'c-pm': PM, 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-ll'],
  },
  {
    name: 'a landlord-only unit resolves its landlord through the DERIVED row, read once',
    unit: unit({ landlordId: 'c-ll' }),
    records: { 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-ll'],
  },
  {
    name: 'a DELETED primary is skipped to the live landlord of record',
    unit: PM_PRIMARY,
    records: { 'c-pm': PM_DELETED, 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-pm', 'c-ll'],
  },
  {
    name: 'a primary with NO record (an import retract hard-deletes) is skipped like a deleted one',
    unit: PM_PRIMARY,
    records: { 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-pm', 'c-ll'],
  },
  {
    name: 'a deleted primary and a deleted landlord of record: nobody, reason deleted',
    unit: PM_PRIMARY,
    records: { 'c-pm': PM_DELETED, 'c-ll': LL_DELETED },
    expected: { kind: 'nobody', reason: 'deleted' },
    reads: ['c-pm', 'c-ll'],
  },
  {
    name: 'a deleted SOLE primary with no landlord of record: nobody, reason deleted',
    unit: unit({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }] }),
    records: { 'c-pm': PM_DELETED },
    expected: { kind: 'nobody', reason: 'deleted' },
    reads: ['c-pm'],
  },
  {
    name: 'a deleted landlord-only unit is ONE candidate (the derived row IS the landlord): read once',
    unit: unit({ landlordId: 'c-ll' }),
    records: { 'c-ll': LL_DELETED },
    expected: { kind: 'nobody', reason: 'deleted' },
    reads: ['c-ll'],
  },
  {
    name: 'no flagged row and no landlord of record (the imported no-landlord shape): nobody, reason none, nothing read',
    unit: unit({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }] }),
    records: { 'c-pm': PM },
    expected: { kind: 'nobody', reason: 'none' },
    reads: [],
  },
  {
    name: 'an EMPTY-STRING landlordId is no candidate - never read',
    unit: unit({ landlordId: '', contacts: [] }),
    records: {},
    expected: { kind: 'nobody', reason: 'none' },
    reads: [],
  },
  {
    name: 'a flagged row with an EMPTY contactId is no candidate - the landlord of record answers',
    unit: unit({
      landlordId: 'c-ll',
      contacts: [
        { contactId: '', role: 'pm', primaryContact: true },
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      ],
    }),
    records: { 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-ll'],
  },
  {
    name: 'the primary IS the tenant: STOP is_tenant before any read - no fall-through to a live landlord',
    unit: unit({
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-t', role: 'other', primaryContact: true },
      ],
    }),
    tenantId: 'c-t',
    records: { 'c-ll': LL, 'c-t': TENANT_RECORD },
    expected: { kind: 'nobody', reason: 'is_tenant' },
    reads: [],
  },
  {
    name: 'a deleted primary, then the landlord of record IS the tenant: is_tenant',
    unit: unit({
      landlordId: 'c-t',
      contacts: [
        { contactId: 'c-t', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
    }),
    tenantId: 'c-t',
    records: { 'c-pm': PM_DELETED, 'c-t': TENANT_RECORD },
    expected: { kind: 'nobody', reason: 'is_tenant' },
    reads: ['c-pm'],
  },
  {
    name: 'no tenant given: no tenant test at all',
    unit: unit({ landlordId: 'c-t' }),
    records: { 'c-t': TENANT_RECORD },
    expected: { kind: 'found', contactId: 'c-t', contact: TENANT_RECORD },
    reads: ['c-t'],
  },
  {
    name: 'an EMPTY tenant id is no tenant: no tenant test at all',
    unit: unit({ landlordId: 'c-t' }),
    tenantId: '',
    records: { 'c-t': TENANT_RECORD },
    expected: { kind: 'found', contactId: 'c-t', contact: TENANT_RECORD },
    reads: ['c-t'],
  },
  {
    name: 'a THROWING primary read STOPS the walk: read_failed names it, the landlord is never read',
    unit: PM_PRIMARY,
    records: { 'c-ll': LL },
    throwing: ['c-pm'],
    expected: { kind: 'read_failed', candidateId: 'c-pm' },
    reads: ['c-pm'],
  },
  {
    name: 'a deleted primary and a THROWING landlord read: read_failed names the landlord',
    unit: PM_PRIMARY,
    records: { 'c-pm': PM_DELETED },
    throwing: ['c-ll'],
    expected: { kind: 'read_failed', candidateId: 'c-ll' },
    reads: ['c-pm', 'c-ll'],
  },
];

describe('the property-contact lookup (spec 4.1) - decide and resolve give ONE answer', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const syncReads: string[] = [];
      const decided = decidePropertyContact({
        unit: c.unit,
        tenantId: c.tenantId,
        lookup: (contactId) => {
          syncReads.push(contactId);
          if (c.throwing?.includes(contactId) === true) return { ok: false };
          return { ok: true, contact: c.records[contactId] };
        },
      });
      expect(decided).toEqual(c.expected);
      expect(syncReads).toEqual(c.reads);

      const asyncReads: string[] = [];
      const resolved = await resolvePropertyContact({
        unit: c.unit,
        tenantId: c.tenantId,
        contactsRepo: {
          getById: async (contactId: string) => {
            asyncReads.push(contactId);
            if (c.throwing?.includes(contactId) === true) {
              throw new Error('dynamodb: ProvisionedThroughputExceededException');
            }
            return c.records[contactId];
          },
        },
        logger: createLogger({ destination: createLogCapture().stream }),
      });
      expect(resolved).toEqual(c.expected);
      expect(asyncReads).toEqual(c.reads);
    });
  }
});

describe('resolvePropertyContact - a failed read is an ANSWER, never a throw', () => {
  it('logs the failed candidate with ids only and returns read_failed', async () => {
    const capture = createLogCapture();
    const result = await resolvePropertyContact({
      unit: PM_PRIMARY,
      tenantId: 'c-t',
      contactsRepo: {
        getById: async () => {
          throw new Error('dynamodb: ProvisionedThroughputExceededException');
        },
      },
      logger: createLogger({ destination: capture.stream }),
    });
    expect(result).toEqual({ kind: 'read_failed', candidateId: 'c-pm' });
    const warns = capture.atLevel(40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      msg: 'property contact: candidate read failed - lookup stops',
      candidateId: 'c-pm',
    });
  });
});
