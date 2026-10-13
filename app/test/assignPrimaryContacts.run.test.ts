// assign-primary-contacts (spec 2026-10-12 primary-contact-integrity, section
// 8; plan C12, task S5.3): the run against FAKE repos. A dry run counts and
// lists every outcome and writes nothing; an apply makes ONE conditional
// write per changed unit and appends one backfill audit event per assigned
// primary (none for a scalar alignment); a unit changed after the read is
// skipped and never overwritten; a failed contact read - in both shapes - is
// `unknown`, never "deleted"; a re-run plans nothing; and nothing it logs or
// prints names a person.
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError, type ContactItem, type ContactsRepo } from '../src/repos/contactsRepo.js';
import type { UnitContact, UnitItem, UnitsRepo } from '../src/repos/unitsRepo.js';
import {
  assignPrimaryContacts,
  formatAssignSummary,
  PRIMARY_ASSIGNED_EVENT,
  reportAssignRun,
  type AssignDeps,
  type AssignResult,
} from '../scripts/assign-primary-contacts.js';
import { createLogCapture } from './helpers/logCapture.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';

/** Names in the world below: none may reach a log line or the printed summary. */
const NAMES = ['Mark', 'Passmore', 'Olive', 'Gina', 'Tara', 'Paul'];

const CONTACTS: ContactItem[] = [
  { contactId: 'c-mark', type: 'landlord', status: 'active', firstName: 'Mark', lastName: 'Passmore' },
  { contactId: 'c-owner', type: 'landlord', status: 'active', firstName: 'Olive', lastName: 'Owner' },
  {
    contactId: 'c-gone',
    type: 'landlord',
    status: 'active',
    firstName: 'Gina',
    lastName: 'Gone',
    deleted_at: DELETED_AT,
  },
  { contactId: 'c-ten', type: 'tenant', status: 'searching', firstName: 'Tara', lastName: 'Tenant' },
  { contactId: 'c-pm', type: 'landlord', status: 'active', firstName: 'Paul', lastName: 'Manager' },
];

const row = (contactId: string, role: UnitContact['role'], primaryContact = false): UnitContact => ({
  contactId,
  role,
  primaryContact,
});
const unit = (unitId: string, fields: Partial<UnitItem>): UnitItem =>
  ({ unitId, status: 'available', ...fields }) as UnitItem;

/** One unit per outcome, in Scan order. */
function world(): UnitItem[] {
  return [
    // 470 Bolton: no primary, no landlord of record, one live landlord-typed contact.
    unit('u-bolton', { contacts: [row('c-mark', 'pm')] }),
    // A deleted primary next to a live landlord of record.
    unit('u-deleted-primary', {
      landlordId: 'c-owner',
      contacts: [row('c-owner', 'landlord'), row('c-gone', 'pm', true)],
      primary_contact: 'c-gone',
    }),
    // A soft-deleted PROPERTY in the 470 Bolton shape: read and repaired too.
    unit('u-soft-deleted', { contacts: [row('c-pm', 'pm')], deleted_at: DELETED_AT }),
    // A live flagged primary whose scalar was never written.
    unit('u-stale-scalar', { contacts: [row('c-pm', 'pm', true)] }),
    // Only a tenant on the list: nobody eligible - Sam chooses.
    unit('u-only-tenant', { contacts: [row('c-ten', 'other')] }),
    // A deleted sole contact: nobody can take over.
    unit('u-nobody', { contacts: [row('c-gone', 'pm', true)], primary_contact: 'c-gone' }),
    // A landlord-only unit: fine as it is.
    unit('u-fine', { landlordId: 'c-owner' }),
  ];
}

interface FakeUnits extends Pick<UnitsRepo, 'list' | 'assignPrimaryIfCurrent'> {
  stored: Map<string, UnitItem>;
  writes: string[];
}

interface FakeUnitHooks {
  /** Runs before each write attempt - a concurrent change lands here. */
  beforeWrite?: (unitId: string, stored: Map<string, UnitItem>) => void;
  /** Units whose write fails with an error that is not a lost condition. */
  failWrite?: ReadonlySet<string>;
  /** The Scan itself fails. */
  failList?: boolean;
}

function fakeUnits(units: UnitItem[], hooks: FakeUnitHooks = {}): FakeUnits {
  const stored = new Map(units.map((u) => [u.unitId, structuredClone(u)] as const));
  const writes: string[] = [];
  return {
    stored,
    writes,
    async list(opts = {}) {
      if (hooks.failList === true) throw new Error('scan failed');
      // The run must read EVERY unit, consistently (spec section 8).
      expect(opts.deleted).toBe('any');
      expect(opts.consistentRead).toBe(true);
      const all = [...stored.values()];
      const cursor = opts.exclusiveStartKey?.['unitId'];
      const start = typeof cursor === 'string' ? all.findIndex((u) => u.unitId === cursor) + 1 : 0;
      const window = opts.limit === undefined ? all.slice(start) : all.slice(start, start + opts.limit);
      const last = window[window.length - 1];
      const more = opts.limit !== undefined && start + opts.limit < all.length;
      return {
        items: window.map((u) => structuredClone(u)),
        ...(more && last !== undefined && { lastEvaluatedKey: { unitId: last.unitId } }),
      };
    },
    async assignPrimaryIfCurrent(read, next) {
      hooks.beforeWrite?.(read.unitId, stored);
      if (hooks.failWrite?.has(read.unitId) === true) throw new Error('throttled');
      const current = stored.get(read.unitId);
      // The real guard: landlordId AND contacts[] exactly as read.
      if (
        current === undefined ||
        current.landlordId !== read.landlordId ||
        !isDeepStrictEqual(current.contacts, read.contacts)
      ) {
        return 'skipped';
      }
      current.contacts = structuredClone(next.contacts);
      current.primary_contact = next.primaryContact;
      writes.push(read.unitId);
      return 'written';
    },
  };
}

function fakeContacts(failures: ReadonlyMap<string, Error> = new Map()) {
  const byId = new Map(CONTACTS.map((c) => [c.contactId, c] as const));
  const calls: Array<{ ids: string[]; requireComplete: boolean }> = [];
  const repo: Pick<ContactsRepo, 'getManyByIds'> = {
    async getManyByIds(ids, opts) {
      calls.push({ ids: [...ids], requireComplete: opts?.requireComplete === true });
      for (const id of ids) {
        const failure = failures.get(id);
        if (failure !== undefined) throw failure;
      }
      const found = new Map<string, ContactItem>();
      for (const id of ids) {
        const contact = byId.get(id);
        if (contact !== undefined) found.set(id, contact);
      }
      return found;
    },
  };
  return { repo, calls };
}

function fakeAudit(fail = false) {
  const events: Array<{ entityKey: string; eventType: string; payload: Record<string, unknown> | undefined }> = [];
  const repo: AssignDeps['audit'] = {
    async append(entityKey, eventType, payload) {
      if (fail) throw new Error('audit unavailable');
      events.push({ entityKey, eventType, payload });
    },
  };
  return { repo, events };
}

function harness(opts: { units?: FakeUnits; failures?: ReadonlyMap<string, Error>; auditFails?: boolean } = {}) {
  const units = opts.units ?? fakeUnits(world());
  const contacts = fakeContacts(opts.failures);
  const audit = fakeAudit(opts.auditFails === true);
  const capture = createLogCapture();
  const logger = createLogger({ level: 'info', destination: capture.stream });
  const deps: AssignDeps = { units, contacts: contacts.repo, audit: audit.repo };
  return { units, contacts, audit, capture, logger, deps };
}

/** What a dry run over world() reports. */
const DRY_RESULT: AssignResult = {
  unitsScanned: 7,
  deletedUnits: 1,
  targets: 3,
  targetsOnDeletedUnits: 1,
  assigned: 0,
  scalarAligned: 1,
  skippedOnCondition: 0,
  writeFailed: 0,
  noHeir: 1,
  noEligible: 1,
  unknown: 0,
  unchanged: 1,
  auditFailed: 0,
  targetUnitIds: ['u-bolton', 'u-deleted-primary', 'u-soft-deleted'],
  alignedUnitIds: ['u-stale-scalar'],
  noEligibleUnitIds: ['u-only-tenant'],
  unknownUnitIds: [],
  skippedUnitIds: [],
  failedUnitIds: [],
};

describe('assignPrimaryContacts - dry run', () => {
  it('counts and lists every outcome and writes NOTHING', async () => {
    const h = harness();
    const before = structuredClone([...h.units.stored.values()]);
    const result = await assignPrimaryContacts(h.deps, { apply: false, logger: h.logger });
    expect(result).toEqual(DRY_RESULT);
    expect(h.units.writes).toEqual([]);
    expect([...h.units.stored.values()]).toEqual(before);
    expect(h.audit.events).toEqual([]);
    // ONE complete contact read per unit (spec 4.2: requireComplete).
    expect(h.contacts.calls).toHaveLength(7);
    expect(h.contacts.calls.every((c) => c.requireComplete)).toBe(true);
    expect(reportAssignRun(result, false, h.logger)).toBe(0);
  });

  it('pages through the Scan: two units a page reaches the same result', async () => {
    const h = harness();
    expect(await assignPrimaryContacts(h.deps, { apply: false, logger: h.logger, scanLimit: 2 })).toEqual(DRY_RESULT);
  });
});

describe('assignPrimaryContacts - apply', () => {
  it('assigns each target its heir in ONE conditional write with one backfill audit event, and aligns the scalar with none', async () => {
    const h = harness();
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toEqual({ ...DRY_RESULT, assigned: 3 });
    expect(h.units.writes).toEqual(['u-bolton', 'u-deleted-primary', 'u-soft-deleted', 'u-stale-scalar']);
    expect(h.units.stored.get('u-bolton')).toMatchObject({
      contacts: [row('c-mark', 'pm', true)],
      primary_contact: 'c-mark',
    });
    expect(h.units.stored.get('u-deleted-primary')).toMatchObject({
      landlordId: 'c-owner',
      contacts: [row('c-owner', 'landlord', true), row('c-gone', 'pm')],
      primary_contact: 'c-owner',
    });
    expect(h.units.stored.get('u-soft-deleted')).toMatchObject({
      contacts: [row('c-pm', 'pm', true)],
      primary_contact: 'c-pm',
      deleted_at: DELETED_AT,
    });
    expect(h.units.stored.get('u-stale-scalar')).toMatchObject({
      contacts: [row('c-pm', 'pm', true)],
      primary_contact: 'c-pm',
    });
    // Counted only - never written.
    expect(h.units.stored.get('u-only-tenant')?.primary_contact).toBeUndefined();
    expect(h.units.stored.get('u-nobody')).toMatchObject({
      contacts: [row('c-gone', 'pm', true)],
      primary_contact: 'c-gone',
    });
    expect(PRIMARY_ASSIGNED_EVENT).toBe('unit_primary_contact_assigned');
    expect(h.audit.events).toEqual([
      {
        entityKey: 'units#u-bolton',
        eventType: PRIMARY_ASSIGNED_EVENT,
        payload: { contactId: 'c-mark', reason: 'backfill' },
      },
      {
        entityKey: 'units#u-deleted-primary',
        eventType: PRIMARY_ASSIGNED_EVENT,
        payload: { contactId: 'c-owner', reason: 'backfill', from: 'c-gone' },
      },
      {
        entityKey: 'units#u-soft-deleted',
        eventType: PRIMARY_ASSIGNED_EVENT,
        payload: { contactId: 'c-pm', reason: 'backfill' },
      },
    ]);
    expect(reportAssignRun(result, true, h.logger)).toBe(0);
  });

  it('is idempotent: a re-run of a completed apply plans nothing and writes nothing', async () => {
    const h = harness();
    await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    const writes = h.units.writes.length;
    const events = h.audit.events.length;
    const again = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(again).toMatchObject({
      targets: 0,
      assigned: 0,
      scalarAligned: 0,
      unchanged: 5,
      noHeir: 1,
      noEligible: 1,
      unknown: 0,
    });
    expect(h.units.writes).toHaveLength(writes);
    expect(h.audit.events).toHaveLength(events);
  });

  it('a unit changed after the read is SKIPPED - never overwritten, no audit event - and left for a re-run', async () => {
    const units = fakeUnits(world(), {
      beforeWrite(unitId, stored) {
        if (unitId !== 'u-bolton') return;
        // Staff added the owner as the primary contact after the Scan read the unit.
        const current = stored.get('u-bolton');
        if (current !== undefined) {
          current.contacts = [row('c-mark', 'pm'), row('c-owner', 'owner', true)];
          current.primary_contact = 'c-owner';
        }
      },
    });
    const h = harness({ units });
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toMatchObject({ targets: 3, assigned: 2, skippedOnCondition: 1, skippedUnitIds: ['u-bolton'] });
    expect(units.stored.get('u-bolton')).toMatchObject({
      contacts: [row('c-mark', 'pm'), row('c-owner', 'owner', true)],
      primary_contact: 'c-owner',
    });
    expect(h.audit.events.some((e) => e.entityKey === 'units#u-bolton')).toBe(false);
    // Exit 0 - but at WARN, so a level filter shows it.
    expect(reportAssignRun(result, true, h.logger)).toBe(0);
    expect(h.capture.lines.at(-1)).toMatchObject({ level: 40, skippedOnCondition: 1 });
  });

  it('a failed contact read is UNKNOWN in BOTH shapes - never "deleted": nothing written for that unit, exit 1', async () => {
    const h = harness({
      failures: new Map<string, Error>([
        ['c-mark', new Error('ProvisionedThroughputExceededException')],
        ['c-ten', new IncompleteBatchReadError(1, 1)],
      ]),
    });
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toMatchObject({
      unknown: 2,
      unknownUnitIds: ['u-bolton', 'u-only-tenant'],
      targets: 2,
      assigned: 2,
      noEligible: 0,
    });
    expect(h.units.writes).not.toContain('u-bolton');
    expect(reportAssignRun(result, true, h.logger)).toBe(1);
    expect(h.capture.lines.at(-1)).toMatchObject({ level: 40, unknown: 2 });
    expect(String(h.capture.lines.at(-1)?.['msg'])).toContain('COMPLETED WITH FAILURES');
  });

  it('a write that fails (not a lost condition) is counted and the run goes on; exit 1', async () => {
    const units = fakeUnits(world(), { failWrite: new Set(['u-bolton']) });
    const h = harness({ units });
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toMatchObject({ writeFailed: 1, failedUnitIds: ['u-bolton'], assigned: 2, scalarAligned: 1 });
    expect(h.audit.events.some((e) => e.entityKey === 'units#u-bolton')).toBe(false);
    expect(h.capture.atLevel(50).some((l) => l['unitId'] === 'u-bolton')).toBe(true);
    expect(reportAssignRun(result, true, h.logger)).toBe(1);
  });

  it('an audit append that fails after the write landed is counted, never thrown; exit 0 at WARN', async () => {
    const h = harness({ auditFails: true });
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toMatchObject({ assigned: 3, auditFailed: 3 });
    expect(reportAssignRun(result, true, h.logger)).toBe(0);
    expect(h.capture.lines.at(-1)).toMatchObject({ level: 40, auditFailed: 3 });
  });

  it('a Scan failure ABORTS with a PARTIAL report and rethrows', async () => {
    const h = harness({ units: fakeUnits(world(), { failList: true }) });
    await expect(assignPrimaryContacts(h.deps, { apply: true, logger: h.logger })).rejects.toThrow('scan failed');
    const partial = h.capture.atLevel(50).find((l) => String(l['msg']).includes('PARTIAL'));
    expect(partial).toMatchObject({ unitsScanned: 0, apply: true });
  });
});

describe('assignPrimaryContacts - what it prints and logs', () => {
  it('prints counts and unit ids only - never a name - and so do its log lines', async () => {
    const h = harness();
    const dry = await assignPrimaryContacts(h.deps, { apply: false, logger: h.logger });
    const dryLines = formatAssignSummary(dry, false);
    expect(dryLines[0]).toBe('Primary contacts - DRY RUN, nothing written:');
    expect(dryLines).toContain('  Would get a primary contact: 3 (1 on soft-deleted properties)');
    expect(dryLines).toContain('Properties that would get a primary contact: u-bolton, u-deleted-primary, u-soft-deleted');
    expect(dryLines).toContain(
      'Properties with no eligible contact (open each one and choose a primary contact): u-only-tenant',
    );
    expect(dryLines).toContain('Properties that could not be decided (re-run): none');
    const applied = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    const appliedLines = formatAssignSummary(applied, true);
    expect(appliedLines[0]).toBe('Primary contacts - APPLIED:');
    expect(appliedLines).toContain('  Primary contacts assigned: 3');
    expect(appliedLines).toContain('Properties whose write failed: none');
    // pino stamps the machine's hostname on every line - not ours to check.
    const logged = h.capture.lines.map(({ hostname: _hostname, ...line }) => line);
    const everything = JSON.stringify(logged) + dryLines.join('\n') + appliedLines.join('\n');
    for (const name of NAMES) expect(everything).not.toContain(name);
  });
});
