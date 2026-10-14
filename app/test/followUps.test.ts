// Follow-ups builder (last-heard-from spec 5.6 + 14.4): eligibility, the QUIET
// and LOOKBACK thresholds, ordering, byUnit, labels, the one contacts batch,
// and the capped available-unit walk. Pure - every repo is a fake.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError, type ContactItem, type RecipientDisplay } from '../src/repos/contactsRepo.js';
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { ListUnitsOpts, UnitItem, UnitsPage } from '../src/repos/unitsRepo.js';
import { buildFollowUps, FOLLOW_UPS_UNIT_CAP, type FollowUpsDeps } from '../src/services/followUps.js';
import { createLogCapture } from './helpers/logCapture.js';

const NOW = Date.parse('2026-10-12T15:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

interface World {
  units: UnitItem[];
  sends: ListingSendItem[];
  tours: TourItem[];
  contacts: ContactItem[];
}
const emptyWorld = (): World => ({ units: [], sends: [], tours: [], contacts: [] });

function unit(unitId: string, over: Partial<UnitItem> = {}): UnitItem {
  return { unitId, landlordId: 'c-ll', status: 'available', ...over };
}
function tenant(contactId: string, over: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'tenant', status: 'searching', phone: '+15550100000', firstName: 'Ten', lastName: contactId, ...over };
}
function send(unitId: string, contactId: string, sentAt: string, over: Partial<ListingSendItem> = {}): ListingSendItem {
  return { unitId, contactId, sentAt, via: 'individual', counted: true, created_at: sentAt, updated_at: sentAt, ...over };
}
function requestedTour(unitId: string, tenantId: string, createdAt: string): TourItem {
  return { tourId: `t-${unitId}-${tenantId}`, tenantId, unitId, _schedPartition: 'tours', tourType: 'self_guided', status: 'requested', createdAt, updatedAt: createdAt };
}

/** What the REAL getRecipientDisplaysByIds returns: RECIPIENT_PROJECTION's
 *  attributes only (repos/contactsRepo.ts), so every case below runs on
 *  projected data - a builder reading an unprojected attribute would see
 *  undefined (review ADV-2). */
const RECIPIENT_ATTRS = ['contactId', 'firstName', 'lastName', 'phone', 'deleted_at', 'type', 'role', 'status', 'last_heard_from_at', 'sms_opt_out', 'sms_unreachable'] as const;
function projectRecipient(contact: ContactItem): RecipientDisplay {
  const picked = Object.fromEntries(RECIPIENT_ATTRS.filter((key) => contact[key] !== undefined).map((key) => [key, contact[key]]));
  return { ...picked, contactId: contact.contactId } as RecipientDisplay;
}

/** Fakes over `world`. `pageSize` forces short unit pages (the real byStatus
 *  page is shortened by the soft-delete filter); the fake returns deleted units
 *  too, so the builder must skip them itself. */
function depsFor(world: World, pageSize = Number.POSITIVE_INFINITY) {
  const calls = {
    listByStatus: [] as ListUnitsOpts[],
    listByUnit: [] as string[],
    toursByUnit: [] as string[],
    batches: [] as Array<{ ids: string[]; requireComplete: boolean | undefined }>,
    wholeItemBatches: [] as string[][],
  };
  const capture = createLogCapture();
  const deps: FollowUpsDeps = {
    units: {
      async listByStatus(status: string, o: ListUnitsOpts = {}): Promise<UnitsPage> {
        calls.listByStatus.push(o);
        const all = world.units.filter((u) => u.status === status);
        const cursor = (o.exclusiveStartKey as { unitId?: string } | undefined)?.unitId;
        const start = cursor === undefined ? 0 : all.findIndex((u) => u.unitId === cursor) + 1;
        const limit = Math.min(o.limit ?? all.length, pageSize);
        const items = all.slice(start, start + limit);
        const last = items[items.length - 1];
        return { items, ...(start + limit < all.length && last !== undefined && { lastEvaluatedKey: { unitId: last.unitId } }) };
      },
    },
    listingSends: {
      async listByUnit(unitId: string) {
        calls.listByUnit.push(unitId);
        return world.sends.filter((s) => s.unitId === unitId);
      },
    },
    tours: {
      async listByUnit(unitId: string) {
        calls.toursByUnit.push(unitId);
        return world.tours.filter((t) => t.unitId === unitId);
      },
    },
    contacts: {
      async getRecipientDisplaysByIds(ids: string[], o?: { requireComplete?: boolean }) {
        calls.batches.push({ ids: [...ids], requireComplete: o?.requireComplete });
        return new Map(world.contacts.filter((c) => ids.includes(c.contactId)).map((c) => [c.contactId, projectRecipient(c)] as const));
      },
      // Review ADV-2 guard: the builder never reads WHOLE contact items.
      async getManyByIds(ids: string[]) {
        calls.wholeItemBatches.push([...ids]);
        return new Map(world.contacts.filter((c) => ids.includes(c.contactId)).map((c) => [c.contactId, c] as const));
      },
    } as FollowUpsDeps['contacts'],
    log: createLogger({ destination: capture.stream }),
    now: NOW,
  };
  return { deps, calls, capture };
}

describe('buildFollowUps (last-heard-from 5.6)', () => {
  it('keeps a no-reply send quiet for 24h+; drops one still inside the QUIET window', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c1'), tenant('c2'));
    w.sends.push(send('u1', 'c1', ago(2 * DAY)), send('u1', 'c2', ago(2 * HOUR)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items).toEqual([
      {
        unitId: 'u1',
        unitLabel: 'u1',
        contactId: 'c1',
        name: 'Ten c1',
        type: 'tenant',
        sentAt: ago(2 * DAY),
        outcome: 'no_reply',
        interestedSupported: true,
        interestedMode: 'form',
        waitingSince: ago(2 * DAY),
      },
    ]);
    expect(out.byUnit).toEqual({ u1: 1 });
    expect(out.truncated).toBe(false);
  });

  it('LOOKBACK: a send 15 days old drops off; 13 days old stays', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c-old'), tenant('c-in'));
    w.sends.push(send('u1', 'c-old', ago(15 * DAY)), send('u1', 'c-in', ago(13 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => i.contactId)).toEqual(['c-in']);
  });

  it('replied-then-quiet appears (waiting since the reply); a fresh reply hides the row', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c-quiet', { last_heard_from_at: ago(3 * DAY) }), tenant('c-fresh', { last_heard_from_at: ago(2 * HOUR) }));
    w.sends.push(send('u1', 'c-quiet', ago(5 * DAY)), send('u1', 'c-fresh', ago(5 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ contactId: 'c-quiet', outcome: 'replied', lastHeardFromAt: ago(3 * DAY), waitingSince: ago(3 * DAY) });
  });

  it('drops Interested (a qualifying tour) and Not interested (an effective decline)', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c-tour'), tenant('c-no'), tenant('c-wait'));
    w.sends.push(
      send('u1', 'c-tour', ago(3 * DAY)),
      send('u1', 'c-no', ago(3 * DAY), { declined: { at: ago(2 * DAY), by: 'staff', staffId: 'user-0002' } }),
      send('u1', 'c-wait', ago(3 * DAY)),
    );
    w.tours.push(requestedTour('u1', 'c-tour', ago(1 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => i.contactId)).toEqual(['c-wait']);
  });

  it('eligibility: drops deleted, opted-out, unreachable, phone-less and inactive/placed tenants; keeps a partner', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    const noPhone = tenant('c-nophone');
    delete noPhone.phone;
    w.contacts.push(
      tenant('c-del', { deleted_at: '2026-10-01T00:00:00.000Z' }),
      tenant('c-stop', { sms_opt_out: true }),
      tenant('c-unreach', { sms_unreachable: true }),
      noPhone,
      tenant('c-inactive', { status: 'inactive' }),
      tenant('c-placed', { status: 'placed' }),
      tenant('c-ok'),
      { contactId: 'p-1', type: 'partner', status: 'active', phone: '+15550100099', firstName: 'Renee', lastName: 'Carter', role: 'Case worker' } as ContactItem,
    );
    for (const c of w.contacts) w.sends.push(send('u1', c.contactId, ago(3 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => i.contactId).sort()).toEqual(['c-ok', 'p-1']);
    expect(out.items.find((i) => i.contactId === 'p-1')).toMatchObject({ type: 'partner', role: 'Case worker', interestedSupported: false, name: 'Renee Carter' });
  });

  // The id rung of the fallback is unreachable for a KEPT row (eligibility
  // requires a phone); it exists because FollowUpItem.name is required.
  it('a nameless contact falls back to the phone; names are part-wise trimmed', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    const byPhone = tenant('c-phone', { phone: '+15550100042' });
    delete byPhone['firstName'];
    delete byPhone['lastName'];
    const padded = tenant('c-padded', { firstName: '  Ann ', lastName: '   ' });
    w.contacts.push(byPhone, padded);
    w.sends.push(send('u1', 'c-phone', ago(3 * DAY)), send('u1', 'c-padded', ago(4 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => [i.contactId, i.name])).toEqual([
      ['c-padded', 'Ann'],
      ['c-phone', '+15550100042'],
    ]);
  });

  it('drops a row whose contact is gone (no Text action could work)', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.sends.push(send('u1', 'c-gone', ago(3 * DAY)));
    expect((await buildFollowUps(depsFor(w).deps)).items).toEqual([]);
  });

  it('drops a row whose projected contact carries no type (the required FollowUpItem.type cannot be filled)', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    const typeless = tenant('c-typeless');
    delete (typeless as Partial<ContactItem>).type;
    w.contacts.push(typeless, tenant('c-ok'));
    w.sends.push(send('u1', 'c-typeless', ago(3 * DAY)), send('u1', 'c-ok', ago(3 * DAY)));
    expect((await buildFollowUps(depsFor(w).deps)).items.map((i) => i.contactId)).toEqual(['c-ok']);
  });

  it('orders longest-waiting first across properties; byUnit, unitLabel and interestedMode per property', async () => {
    const w = emptyWorld();
    w.units.push(
      unit('u1', { address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' }, tour_type: 'self_guided' }),
      unit('u2'),
    );
    w.contacts.push(tenant('c1'), tenant('c2'), tenant('c3'));
    w.sends.push(send('u1', 'c1', ago(3 * DAY)), send('u2', 'c2', ago(6 * DAY)), send('u1', 'c3', ago(8 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => `${i.unitId}/${i.contactId}`)).toEqual(['u1/c3', 'u2/c2', 'u1/c1']);
    expect(out.byUnit).toEqual({ u1: 2, u2: 1 });
    expect(out.items[0]).toMatchObject({ unitLabel: '12 Oak St, Atlanta, GA 30303', interestedMode: 'route' });
    expect(out.items[1]).toMatchObject({ unitLabel: 'u2', interestedMode: 'form' });
  });

  it('ONE requireComplete contacts batch of unique ids, through the RECIPIENT projection - never whole items (review ADV-2); no tours read for a property with no sends', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'), unit('u2'), unit('u3'));
    w.contacts.push(tenant('c1'), tenant('c2'));
    w.sends.push(send('u1', 'c1', ago(3 * DAY)), send('u2', 'c1', ago(3 * DAY)), send('u2', 'c2', ago(3 * DAY)));
    const { deps, calls } = depsFor(w);
    await buildFollowUps(deps);
    expect(calls.batches).toHaveLength(1);
    expect(calls.batches[0]!.ids.sort()).toEqual(['c1', 'c2']);
    expect(calls.batches[0]!.requireComplete).toBe(true);
    expect(calls.wholeItemBatches).toEqual([]);
    expect(calls.toursByUnit.sort()).toEqual(['u1', 'u2']);
  });

  it('walks byStatus pages on lastEvaluatedKey and skips soft-deleted properties', async () => {
    const w = emptyWorld();
    const del = { deleted_at: '2026-10-01T00:00:00.000Z' };
    w.units.push(unit('d1', del), unit('live1'), unit('d2', del), unit('d3', del), unit('live2'));
    const { deps, calls } = depsFor(w, 2);
    const out = await buildFollowUps(deps);
    expect(calls.listByStatus).toHaveLength(3);
    expect(calls.listByUnit).toEqual(['live1', 'live2']);
    expect(out.truncated).toBe(false);
  });

  it('caps the walk at 100 KEPT properties: a 101st sets truncated and WARNs', async () => {
    const w = emptyWorld();
    for (let i = 0; i < FOLLOW_UPS_UNIT_CAP + 1; i += 1) w.units.push(unit(`u${String(i).padStart(3, '0')}`));
    const { deps, calls, capture } = depsFor(w, 50);
    const out = await buildFollowUps(deps);
    expect(calls.listByUnit).toHaveLength(FOLLOW_UPS_UNIT_CAP);
    expect(out.truncated).toBe(true);
    expect(capture.atLevel(40).filter((l) => String(l['msg'] ?? '').includes('cap'))).toHaveLength(1);
  });

  it('exactly 100 kept properties (plus deleted ones) is NOT truncated', async () => {
    const w = emptyWorld();
    for (let i = 0; i < FOLLOW_UPS_UNIT_CAP; i += 1) w.units.push(unit(`u${String(i).padStart(3, '0')}`));
    w.units.push(unit('zz-deleted', { deleted_at: '2026-10-01T00:00:00.000Z' }));
    const { deps, capture } = depsFor(w, 50);
    const out = await buildFollowUps(deps);
    expect(out.truncated).toBe(false);
    expect(capture.atLevel(40)).toHaveLength(0);
  });

  it('a failed required read REJECTS (the route answers 503) - sends, tours or contacts', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c1'));
    w.sends.push(send('u1', 'c1', ago(3 * DAY)));
    const a = depsFor(w).deps;
    a.listingSends = { listByUnit: async () => { throw new Error('throttled'); } };
    await expect(buildFollowUps(a)).rejects.toThrow('throttled');
    const b = depsFor(w).deps;
    b.tours = { listByUnit: async () => { throw new Error('throttled'); } };
    await expect(buildFollowUps(b)).rejects.toThrow('throttled');
    const c = depsFor(w).deps;
    c.contacts = { getRecipientDisplaysByIds: async () => { throw new IncompleteBatchReadError(1, 1); } };
    await expect(buildFollowUps(c)).rejects.toThrow(IncompleteBatchReadError);
  });
});
