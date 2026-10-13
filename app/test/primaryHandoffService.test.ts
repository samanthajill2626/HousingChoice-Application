// primary-contact-integrity (spec 2026-10-12 section 4.6, "Delete the
// contact"): services/primaryHandoff.ts on the FakeWorld repos. ONE
// consistent Scan over live AND soft-deleted units finds every unit whose
// flagged primary is the deleted contact; each is handed off through
// unitsRepo.handOffPrimaryFrom with the deleted contact excluded and never
// read: moved -> unit_primary_contact_assigned { reason: 'handoff_on_delete',
// from }; unchanged / not_primary -> nothing; unknown -> skipped with a WARN.
// Best-effort as a whole: a Scan failure, a unit whose hand-off throws and a
// failed audit append are logged and skipped - it never throws.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitContact, UnitItem } from '../src/repos/unitsRepo.js';
import { handOffPrimariesOfDeletedContact, type PrimaryHandoffDeps } from '../src/services/primaryHandoff.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';
const GONE = '2026-10-13T09:00:00.000Z';
const ACTOR = 'usr-deleter';

function setup(): {
  world: FakeWorld;
  deps: PrimaryHandoffDeps;
  capture: ReturnType<typeof createLogCapture>;
} {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const deps: PrimaryHandoffDeps = {
    units: world.unitsRepo,
    contacts: world.contactsRepo,
    audit: world.auditRepo,
    logger: createLogger({ destination: capture.stream }),
  };
  return { world, deps, capture };
}

/** A unit with NO landlordId unless `fields` sets one (fields are cloned: units never share a roster array). */
function seedUnit(world: FakeWorld, unitId: string, fields: Partial<UnitItem>): void {
  world.units.set(unitId, {
    unitId,
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...structuredClone(fields),
  } as UnitItem);
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', ...fields } as ContactItem);
}

/** c-d (the deleted contact) flagged primary, c-p an eligible second row. */
const D_PRIMARY: UnitContact[] = [
  { contactId: 'c-d', role: 'pm', primaryContact: true },
  { contactId: 'c-p', role: 'pm', primaryContact: false },
];

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');

const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 1)],
];

describe('handOffPrimariesOfDeletedContact (spec 4.6)', () => {
  it('follows every consistent Scan page over live and deleted units, hands each target off and audits each move', async () => {
    const { world, deps } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    seedUnit(world, 'u-other', {
      landlordId: 'c-ll',
      contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: true }],
    });
    seedUnit(world, 'u-2', { contacts: D_PRIMARY, primary_contact: 'c-d', deleted_at: STAMP });
    seedUnit(world, 'u-seat', {
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-d', role: 'pm', primaryContact: false },
      ],
    });
    seedUnit(world, 'u-3', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const realList = world.unitsRepo.list.bind(world.unitsRepo);
    const scan = vi.spyOn(world.unitsRepo, 'list').mockImplementation((options) => realList({ ...options, limit: 2 }));

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(scan).toHaveBeenCalledTimes(3);
    for (const [options] of scan.mock.calls) expect(options).toMatchObject({ deleted: 'any', consistentRead: true });
    expect(summary).toEqual({
      targets: ['u-1', 'u-2', 'u-3'],
      moved: ['u-1', 'u-2', 'u-3'],
      unchanged: [],
      notPrimary: [],
      unknown: [],
      failed: [],
      scanFailed: false,
    });
    for (const unitId of ['u-1', 'u-2', 'u-3']) {
      expect(world.units.get(unitId)?.contacts).toEqual([
        { contactId: 'c-d', role: 'pm', primaryContact: false },
        { contactId: 'c-p', role: 'pm', primaryContact: true },
      ]);
      expect(world.units.get(unitId)?.primary_contact).toBe('c-p');
    }
    expect(assigned(world)).toEqual(
      ['u-1', 'u-2', 'u-3'].map((unitId) => ({
        entityKey: `units#${unitId}`,
        event_type: 'unit_primary_contact_assigned',
        actorId: ACTOR,
        payload: { actor: ACTOR, contactId: 'c-p', reason: 'handoff_on_delete', from: 'c-d' },
      })),
    );
    // A unit where the contact merely holds a non-primary seat is not a target.
    expect(world.units.get('u-seat')?.contacts?.[0]?.primaryContact).toBe(true);
  });

  it('no heir: unchanged - nothing written, no audit', async () => {
    const { world, deps } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedUnit(world, 'u-1', {
      contacts: [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });
    const before = structuredClone(world.units.get('u-1'));

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.unchanged).toEqual(['u-1']);
    expect(world.units.get('u-1')).toEqual(before);
    expect(assigned(world)).toEqual([]);
  });

  it.each(READ_FAILURES)('liveness unknown (%s): the unit is skipped with a WARN, untouched', async (_shape, make) => {
    const { world, deps, capture } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const before = structuredClone(world.units.get('u-1'));
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.unknown).toEqual(['u-1']);
    expect(world.units.get('u-1')).toEqual(before);
    expect(assigned(world)).toEqual([]);
    expect(
      capture.atLevel(40).find((l) => l['msg'] === 'contact delete: primary handoff skipped - the liveness read failed'),
    ).toMatchObject({ contactId: 'c-d', unitId: 'u-1' });
  });

  it('a unit whose hand-off throws is logged and skipped; the others are handed off; it never throws', async () => {
    const { world, deps, capture } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-a', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    seedUnit(world, 'u-b', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const real = world.unitsRepo.handOffPrimaryFrom.bind(world.unitsRepo);
    vi.spyOn(world.unitsRepo, 'handOffPrimaryFrom').mockImplementation(async (unitId, from, read) => {
      if (unitId === 'u-a') throw new Error('boom');
      return real(unitId, from, read);
    });

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.failed).toEqual(['u-a']);
    expect(summary.moved).toEqual(['u-b']);
    expect(world.units.get('u-a')?.primary_contact).toBe('c-d');
    expect(world.units.get('u-b')?.primary_contact).toBe('c-p');
    expect(
      capture.atLevel(40).find((l) => l['msg'] === 'contact delete: primary handoff failed for a unit (best-effort)'),
    ).toMatchObject({ contactId: 'c-d', unitId: 'u-a' });
  });

  it('a Scan failure is logged and resolves; the targets found before it are still handed off', async () => {
    const { world, deps, capture } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    seedUnit(world, 'u-2', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const realList = world.unitsRepo.list.bind(world.unitsRepo);
    let pages = 0;
    vi.spyOn(world.unitsRepo, 'list').mockImplementation(async (options) => {
      pages += 1;
      if (pages > 1) throw new Error('scan throttled');
      return realList({ ...options, limit: 1 });
    });

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.scanFailed).toBe(true);
    expect(summary.targets).toEqual(['u-1']);
    expect(summary.moved).toEqual(['u-1']);
    expect(world.units.get('u-2')?.primary_contact).toBe('c-d');
    expect(
      capture.atLevel(40).find((l) => l['msg'] === 'contact delete: primary handoff scan failed (best-effort)'),
    ).toMatchObject({ contactId: 'c-d', found: 1 });
  });

  it('an audit append that fails is logged, never thrown; the move stands', async () => {
    const { world, deps, capture } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    world.failAuditAppendFor.add('unit_primary_contact_assigned');

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.moved).toEqual(['u-1']);
    expect(world.units.get('u-1')?.primary_contact).toBe('c-p');
    expect(
      capture.atLevel(40).find((l) => l['msg'] === 'contact delete: primary handoff audit append failed (best-effort)'),
    ).toMatchObject({ contactId: 'c-d', unitId: 'u-1' });
  });

  it('never reads the deleted contact for liveness', async () => {
    const { world, deps } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', {
      landlordId: 'c-d',
      contacts: [
        { contactId: 'c-d', role: 'landlord', primaryContact: true },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });
    const batchRead = vi.spyOn(world.contactsRepo, 'getManyByIds');

    await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(batchRead).toHaveBeenCalled();
    for (const [ids] of batchRead.mock.calls) expect(ids).not.toContain('c-d');
    // The deleted landlord of record is excluded at step 1, so the eligible row takes over.
    expect(world.units.get('u-1')?.primary_contact).toBe('c-p');
  });

  it('a primary someone else moved between the Scan and the hand-off is not_primary - left as they set it', async () => {
    const { world, deps } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedContact(world, 'c-other');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const realList = world.unitsRepo.list.bind(world.unitsRepo);
    vi.spyOn(world.unitsRepo, 'list').mockImplementation(async (options) => {
      const page = await realList(options);
      // Staff B moves the primary after the Scan read the unit (a NEW array,
      // so the Scan's copy still shows c-d as the primary).
      const live = world.units.get('u-1')!;
      live.contacts = [
        { contactId: 'c-d', role: 'pm', primaryContact: false },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
        { contactId: 'c-other', role: 'pm', primaryContact: true },
      ];
      live.primary_contact = 'c-other';
      return page;
    });

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.targets).toEqual(['u-1']);
    expect(summary.notPrimary).toEqual(['u-1']);
    expect(world.units.get('u-1')?.primary_contact).toBe('c-other');
    expect(assigned(world)).toEqual([]);
  });
});
