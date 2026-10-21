// property requirements (spec 2026-10-20 D5, D1, D13; plan 2.4): PATCH
// /api/units/:unitId keeps requirement_sources. A body touching a requirement
// key or naming a landlordId reads the unit and its landlord CONSISTENTLY and
// classifies every item whose interpreted value it changes against the
// landlord's CURRENT values (no landlord -> set_here); a landlord change
// REMOVEs the map first and classifies against the NEW landlord. A stored
// legacy pets boolean is rewritten into the new shape with its meaning;
// deposit_conflict is decided against the stored record. The write is fenced
// on the landlordId and map it read: a race re-reads and recomputes, three
// lost races answer 409 property_changed, a vanished unit 404, and a slow
// PATCH never writes its map back over a restore's or a claim's REMOVE.
// requirement_sources is asserted on the HTTP response.
import { describe, expect, it, vi } from 'vitest';
import { emailRefId, phoneRefId } from '../src/repos/contactsRepo.js';
import {
  getUnit,
  patchUnit,
  patchUnitRaw,
  postRequirementsApply,
  REQ_STAMP,
  seedContact,
  seedLandlord,
  seedUnit,
  unitUpdatedEvents,
} from './helpers/requirementsFixtures.js';
import { makeWebhookHarness, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const LANDLORD_FACTS = { caseworker: false, landlordTyped: true, autoPrimaryEligible: true };

/** AR9: a contacts ROUTING POINTER row (phone or email) - a routing record, never a contact. */
const POINTER_ROWS: Array<[string, string, Record<string, unknown>]> = [
  ['a phone', phoneRefId('+15550001111'), { phone: '+15550001111', phone_ref: true, phone_ref_owner: 'c-ll' }],
  ['an email', emailRefId('lee@example.com'), { email: 'lee@example.com', email_ref: true, email_ref_owner: 'c-ll' }],
];

function auditFieldsOf(world: FakeWorld, index = 0): unknown {
  return unitUpdatedEvents(world)[index]?.payload?.['fields'];
}

describe('PATCH /api/units/:id - where each requirement value came from (D5)', () => {
  it('an edit that makes an item differ is set here; editing it back to the landlord value makes it a copy again', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_income_requirements: '3x rent' });
    seedUnit(world, 'u-1');
    const differ = await patchUnit(app, 'u-1', { income_requirements: '2.5x rent' });
    expect(differ.status).toBe(200);
    expect(differ.body.unit.requirement_sources).toEqual({ income_requirements: 'set_here' });
    const back = await patchUnit(app, 'u-1', { income_requirements: '3x rent' });
    expect(back.status).toBe(200);
    expect(back.body.unit.requirement_sources).toEqual({ income_requirements: 'copied' });
    expect((await getUnit(app, 'u-1')).body.unit.requirement_sources).toEqual({ income_requirements: 'copied' });
    expect(auditFieldsOf(world, 0)).toEqual(['income_requirements']);
    expect(auditFieldsOf(world, 1)).toEqual(['income_requirements']);
  });

  it('a PATCH of one Deposit key classifies the whole Deposit item', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_deposit_one_month: true, req_deposit_flexible: true });
    seedUnit(world, 'u-1', { deposit_flexible: true });
    const copied = await patchUnit(app, 'u-1', { deposit_one_month: true });
    expect(copied.status).toBe(200);
    expect(copied.body.unit.requirement_sources).toEqual({ deposit: 'copied' });
    const setHere = await patchUnit(app, 'u-1', { deposit_notes: 'Three payments' });
    expect(setHere.status).toBe(200);
    expect(setHere.body.unit.requirement_sources).toEqual({ deposit: 'set_here' });
  });

  it('a raw boolean pets write is stored in the new shape and classifies the Pets item', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_no_pets: true });
    seedUnit(world, 'u-1', { pets: 'Cats OK' });
    const res = await patchUnit(app, 'u-1', { pets: false });
    expect(res.status).toBe(200);
    expect(res.body.unit.no_pets).toBe(true);
    expect(res.body.unit).not.toHaveProperty('pets');
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'copied' });
    expect([...(auditFieldsOf(world) as string[])].sort()).toEqual(['no_pets', 'pets']);
  });

  it('pet_fee alone on a legacy pets:false property: No pets and the details keep what they read; the partner keys are listed', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_no_pets: true, req_pet_fee: '$300' });
    seedUnit(world, 'u-1', { pets: false });
    const res = await patchUnit(app, 'u-1', { pet_fee: '$300' });
    expect(res.status).toBe(200);
    expect(res.body.unit).toMatchObject({ no_pets: true, pet_fee: '$300' });
    expect(res.body.unit).not.toHaveProperty('pets');
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'copied' });
    expect(auditFieldsOf(world)).toEqual(['pet_fee', 'no_pets', 'pets']);
  });

  it('pet_fee alone on a legacy pets:true property: the details read Allowed', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_pets: 'Allowed', req_pet_fee: '$50' });
    seedUnit(world, 'u-1', { pets: true });
    const res = await patchUnit(app, 'u-1', { pet_fee: '$50' });
    expect(res.status).toBe(200);
    expect(res.body.unit).toMatchObject({ pets: 'Allowed', pet_fee: '$50' });
    expect(res.body.unit).not.toHaveProperty('no_pets');
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'copied' });
    expect(auditFieldsOf(world)).toEqual(['pet_fee', 'pets']);
  });

  it('a raw pets:true on a legacy pets:true property is not a change: the item stays never touched, and no_pets (never held) is not an audit field', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_no_pets: true });
    seedUnit(world, 'u-1', { pets: true });
    const res = await patchUnit(app, 'u-1', { pets: true });
    expect(res.status).toBe(200);
    expect(res.body.unit.pets).toBe('Allowed');
    expect(res.body.unit).not.toHaveProperty('requirement_sources');
    expect(auditFieldsOf(world)).toEqual(['pets']);
  });

  it('audit fields: a key re-sent with its stored value is not listed (D13, PR1-10)', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_income_requirements: '3x rent' });
    seedUnit(world, 'u-1', { beds: 2, income_requirements: '2x rent' });
    const res = await patchUnit(app, 'u-1', { beds: 2, income_requirements: '3x rent' });
    expect(res.status).toBe(200);
    expect(res.body.unit.requirement_sources).toEqual({ income_requirements: 'copied' });
    expect(auditFieldsOf(world)).toEqual(['income_requirements']);
  });

  it('every key re-sent unchanged on the fenced path: 200, updated_at stamped, but no unit_updated row (PR1-10a)', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_income_requirements: '3x rent' });
    seedUnit(world, 'u-1', {
      beds: 2,
      income_requirements: '3x rent',
      requirement_sources: { income_requirements: 'copied' },
    });
    const fenced = vi.spyOn(world.unitsRepo, 'updateIfRequirementsCurrent');
    const res = await patchUnit(app, 'u-1', { beds: 2, income_requirements: '3x rent' });
    expect(res.status).toBe(200);
    expect(fenced).toHaveBeenCalledTimes(1);
    expect(res.body.unit.requirement_sources).toEqual({ income_requirements: 'copied' });
    expect(res.body.unit.updated_at).not.toBe(REQ_STAMP);
    expect(world.units.get('u-1')?.updated_at).not.toBe(REQ_STAMP);
    expect(unitUpdatedEvents(world)).toHaveLength(0);
  });

  it('deposit_conflict is decided against the STORED record; sending the amount as null in the same save clears it', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedUnit(world, 'u-1', { deposit: 1200 });
    const refused = await patchUnit(app, 'u-1', { deposit_one_month: true });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'deposit_conflict' });
    const unchanged = world.units.get('u-1');
    expect(unchanged?.deposit).toBe(1200);
    expect(unchanged).not.toHaveProperty('deposit_one_month');
    expect(unchanged?.updated_at).toBe(REQ_STAMP);
    expect(unitUpdatedEvents(world)).toHaveLength(0);
    const ok = await patchUnit(app, 'u-1', { deposit_one_month: true, deposit: null });
    expect(ok.status).toBe(200);
    expect(ok.body.unit.deposit_one_month).toBe(true);
    expect(ok.body.unit).not.toHaveProperty('deposit');
    expect(ok.body.unit.requirement_sources).toEqual({ deposit: 'set_here' });
    expect([...(auditFieldsOf(world) as string[])].sort()).toEqual(['deposit', 'deposit_one_month']);
  });

  it('changing landlordId REMOVEs the map', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedLandlord(world, 'c-ll-2', { req_no_pets: true });
    seedUnit(world, 'u-1', { pets: 'Cats OK', requirement_sources: { pets: 'set_here', credit_requirements: 'copied' } });
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ll-2' });
    expect(res.status).toBe(200);
    expect(res.body.unit.landlordId).toBe('c-ll-2');
    expect(res.body.unit).not.toHaveProperty('requirement_sources');
    expect(world.units.get('u-1')).not.toHaveProperty('requirement_sources');
    expect(auditFieldsOf(world)).toEqual(['landlordId']);
  });

  it('changing landlordId and touching an item: reset first, then classified against the NEW landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_income_requirements: '2x rent' });
    seedLandlord(world, 'c-ll-2', { req_income_requirements: '3x rent' });
    seedUnit(world, 'u-1', { pets: 'Cats OK', requirement_sources: { pets: 'set_here' } });
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ll-2', income_requirements: '3x rent' });
    expect(res.status).toBe(200);
    expect(res.body.unit.requirement_sources).toEqual({ income_requirements: 'copied' });
  });

  it('a property with no landlord classifies every touched item as set here', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', { landlordId: undefined });
    const res = await patchUnit(app, 'u-1', { credit_requirements: 'Score 600+' });
    expect(res.status).toBe(200);
    expect(res.body.unit.requirement_sources).toEqual({ credit_requirements: 'set_here' });
  });

  it('a landlord of record whose contact record is gone counts as no landlord (a cleared item is set here, not copied)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', { landlordId: 'c-gone', credit_requirements: 'Score 600+' });
    const res = await patchUnit(app, 'u-1', { credit_requirements: null });
    expect(res.status).toBe(200);
    expect(res.body.unit).not.toHaveProperty('credit_requirements');
    expect(res.body.unit.requirement_sources).toEqual({ credit_requirements: 'set_here' });
  });

  // AR9: read as a contact, a pointer row would hold a blank value for every
  // item, so the cleared item below would read as copied from it.
  it.each(POINTER_ROWS)(
    'a landlord of record that is %s routing-pointer row counts as no landlord (a cleared item is set here, not copied)',
    async (_kind, pointerId, pointer) => {
      const { app, world } = makeWebhookHarness();
      seedContact(world, pointerId, pointer);
      seedUnit(world, 'u-1', { landlordId: pointerId, credit_requirements: 'Score 600+' });
      const res = await patchUnit(app, 'u-1', { credit_requirements: null });
      expect(res.status).toBe(200);
      expect(res.body.unit).not.toHaveProperty('credit_requirements');
      expect(res.body.unit.requirement_sources).toEqual({ credit_requirements: 'set_here' });
    },
  );

  it('(PIN) re-saving the stored landlordId with no requirement field keeps the map', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedUnit(world, 'u-1', { requirement_sources: { pets: 'set_here' } });
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ll', beds: 3 });
    expect(res.status).toBe(200);
    expect(res.body.unit.beds).toBe(3);
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'set_here' });
    // No requirement key and no landlord change: the PLAIN path's audit list (PR1-10).
    expect(auditFieldsOf(world)).toEqual(['landlordId', 'beds']);
  });

  // Code review RA-7: such a body classifies nothing, so the fenced path reads
  // no landlord contact - and a contacts-table fault cannot fail the save.
  it('re-saving the stored landlordId with no requirement field reads no contact (RA-7)', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedUnit(world, 'u-1', { requirement_sources: { pets: 'set_here' } });
    const contactRead = vi.spyOn(world.contactsRepo, 'getById').mockRejectedValue(new Error('contacts table down'));
    const fenced = vi.spyOn(world.unitsRepo, 'updateIfRequirementsCurrent');
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ll', beds: 3 });
    expect(res.status).toBe(200);
    expect(contactRead).not.toHaveBeenCalled();
    expect(fenced).toHaveBeenCalledTimes(1);
    expect(res.body.unit.beds).toBe(3);
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'set_here' });
  });

  it('(PIN) a plain PATCH never reads the landlord and keeps the map', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedUnit(world, 'u-1', { requirement_sources: { pets: 'set_here' } });
    const contactRead = vi.spyOn(world.contactsRepo, 'getById');
    const res = await patchUnit(app, 'u-1', { beds: 3 });
    expect(res.status).toBe(200);
    expect(contactRead).not.toHaveBeenCalled();
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'set_here' });
  });

  it('a requirement PATCH reads the unit and its landlord CONSISTENTLY and writes through the fence, never the plain update', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedUnit(world, 'u-1');
    const unitRead = vi.spyOn(world.unitsRepo, 'getById');
    const contactRead = vi.spyOn(world.contactsRepo, 'getById');
    const plain = vi.spyOn(world.unitsRepo, 'update');
    const fenced = vi.spyOn(world.unitsRepo, 'updateIfRequirementsCurrent');
    const res = await patchUnit(app, 'u-1', { credit_requirements: 'Score 600+' });
    expect(res.status).toBe(200);
    expect(unitRead).toHaveBeenCalledWith('u-1', { consistentRead: true });
    expect(contactRead).toHaveBeenCalledWith('c-ll', { consistentRead: true });
    expect(plain).not.toHaveBeenCalled();
    expect(fenced).toHaveBeenCalledTimes(1);
  });

  // Code review RA-3: an inherited allowlist lookup let `__proto__` through
  // the validator; through the prototype it then faked a landlordId CHANGE,
  // and the fenced write REMOVEd the map with no landlord change and no trace.
  it.each<[string, string]>([
    ['__proto__', '{"__proto__":{"landlordId":"c-ll-2"},"notes":"x"}'],
    ['toString', '{"toString":"x","notes":"x"}'],
  ])('a body key inherited from Object.prototype (%s) is a 400 unknown field - the unit and its map are kept (RA-3)', async (key, json) => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedLandlord(world, 'c-ll-2');
    seedUnit(world, 'u-1', { notes: 'kept', requirement_sources: { pets: 'set_here' } });
    const before = structuredClone(world.units.get('u-1'));
    const res = await patchUnitRaw(app, 'u-1', json);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: `unknown field: ${key}` });
    expect(world.units.get('u-1')).toEqual(before);
    expect(unitUpdatedEvents(world)).toHaveLength(0);
  });

  it('(PIN) requirement_sources is not client-writable', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    const res = await patchUnit(app, 'u-1', { requirement_sources: { pets: 'copied' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown field: requirement_sources' });
  });

  it('(PIN) a requirement PATCH of an unknown unit is a 404 - no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await patchUnit(app, 'nope', { credit_requirements: 'Score 600+' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
    expect(world.auditEvents).toHaveLength(0);
  });
});

describe('PATCH /api/units/:id - the requirements fence (D5)', () => {
  it('a map changed under the write: re-read, recompute, write - the racing entry is kept', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_income_requirements: '3x rent' });
    seedUnit(world, 'u-1');
    const fenced = world.unitsRepo.updateIfRequirementsCurrent.bind(world.unitsRepo);
    let calls = 0;
    world.unitsRepo.updateIfRequirementsCurrent = async (read, patch) => {
      calls += 1;
      // Staff B's edit of another item lands between this attempt's read and its write.
      if (calls === 1) world.units.get('u-1')!.requirement_sources = { credit_requirements: 'set_here' };
      return fenced(read, patch);
    };
    const res = await patchUnit(app, 'u-1', { income_requirements: '3x rent' });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(res.body.unit.requirement_sources).toEqual({ credit_requirements: 'set_here', income_requirements: 'copied' });
    expect(unitUpdatedEvents(world)).toHaveLength(1);
  });

  it('three lost races: 409 property_changed, nothing of this PATCH written, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_income_requirements: '3x rent' });
    seedUnit(world, 'u-1');
    const fenced = world.unitsRepo.updateIfRequirementsCurrent.bind(world.unitsRepo);
    let calls = 0;
    world.unitsRepo.updateIfRequirementsCurrent = async (read, patch) => {
      calls += 1;
      world.units.get('u-1')!.requirement_sources = { credit_requirements: calls % 2 === 1 ? 'set_here' : 'copied' };
      return fenced(read, patch);
    };
    const res = await patchUnit(app, 'u-1', { income_requirements: '3x rent' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'property_changed' });
    expect(calls).toBe(3);
    const stored = world.units.get('u-1');
    expect(stored).not.toHaveProperty('income_requirements');
    expect(stored?.updated_at).toBe(REQ_STAMP);
    expect(unitUpdatedEvents(world)).toHaveLength(0);
  });

  it('the unit vanished under the write: 404 unit_not_found, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedUnit(world, 'u-1');
    const fenced = world.unitsRepo.updateIfRequirementsCurrent.bind(world.unitsRepo);
    world.unitsRepo.updateIfRequirementsCurrent = async (read, patch) => {
      world.units.delete('u-1');
      return fenced(read, patch);
    };
    const res = await patchUnit(app, 'u-1', { income_requirements: '3x rent' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
    expect(world.auditEvents).toHaveLength(0);
  });

  it("a slow PATCH never writes its map back over a roster claim's REMOVE: recomputed against the claimed landlord", async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-new', { req_credit_requirements: 'Score 600+' });
    seedUnit(world, 'u-1', {
      landlordId: undefined,
      contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }],
      primary_contact: 'c-pm',
      requirement_sources: { pets: 'set_here' },
    });
    const fenced = world.unitsRepo.updateIfRequirementsCurrent.bind(world.unitsRepo);
    let raced = false;
    world.unitsRepo.updateIfRequirementsCurrent = async (read, patch) => {
      if (!raced) {
        raced = true;
        await world.unitsRepo.addContact('u-1', { contactId: 'c-new', role: 'landlord' }, LANDLORD_FACTS);
      }
      return fenced(read, patch);
    };
    const res = await patchUnit(app, 'u-1', { credit_requirements: 'Score 600+' });
    expect(res.status).toBe(200);
    expect(res.body.unit.landlordId).toBe('c-new');
    expect(res.body.unit.requirement_sources).toEqual({ credit_requirements: 'copied' });
    expect(world.units.get('u-1')?.requirement_sources).toEqual({ credit_requirements: 'copied' });
  });

  // Code review RA-1 / OR-29: the fence also holds every key of each item the
  // write touches, as read. Each race lands a colleague's save of the SAME
  // item, through the route, inside this PATCH's first write; the colleague's
  // save leaves the map as it was, so only the item fence can see it.
  it("a colleague's save of another key of the same item between the read and the write: re-read and reclassified, never a wrong copied record - and Apply then keeps the colleague's value (RA-1a)", async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_pets: 'Cats OK' });
    seedUnit(world, 'u-1', { pets: 'Cats OK', pet_fee: '$25', requirement_sources: { pets: 'set_here' } });
    const fenced = world.unitsRepo.updateIfRequirementsCurrent.bind(world.unitsRepo);
    let calls = 0;
    let colleague: number | undefined;
    world.unitsRepo.updateIfRequirementsCurrent = async (read, patch) => {
      calls += 1;
      if (calls === 1) colleague = (await patchUnit(app, 'u-1', { pets: 'Dogs OK' })).status;
      return fenced(read, patch);
    };
    const res = await patchUnit(app, 'u-1', { pet_fee: null });
    expect(colleague).toBe(200);
    expect(res.status).toBe(200);
    // Pets 'Dogs OK' differs from the landlord's 'Cats OK': set here, not copied.
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'set_here' });
    expect(res.body.unit.pets).toBe('Dogs OK');
    expect(res.body.unit).not.toHaveProperty('pet_fee');
    expect(calls).toBe(3); // this PATCH, the colleague's, this PATCH's retry
    // D6 / D8: the colleague's value is an own value, so an Apply that did not
    // accept it skips the property instead of overwriting it unseen.
    const applied = await postRequirementsApply(app, 'c-ll', {
      items: ['pets'],
      expected: { pets: { no_pets: null, pets: 'Cats OK', pet_fee: null } },
      units: [{ unitId: 'u-1', ownItems: [], seen: {} }],
    });
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ updated: [], skipped: [{ unitId: 'u-1', reason: 'changed_since_opened' }] });
    expect(world.units.get('u-1')?.pets).toBe('Dogs OK');
  });

  it("a colleague's One month's rent between the read and the write: the amount is re-checked and refused, never both deposit forms (RA-1b)", async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedUnit(world, 'u-1', { deposit_notes: 'Three payments', requirement_sources: { deposit: 'set_here' } });
    const fenced = world.unitsRepo.updateIfRequirementsCurrent.bind(world.unitsRepo);
    let calls = 0;
    let colleague: number | undefined;
    world.unitsRepo.updateIfRequirementsCurrent = async (read, patch) => {
      calls += 1;
      // The dashboard's One-month save: the amount goes as null in the same save.
      if (calls === 1) colleague = (await patchUnit(app, 'u-1', { deposit_one_month: true, deposit: null })).status;
      return fenced(read, patch);
    };
    const res = await patchUnit(app, 'u-1', { deposit: 900 });
    expect(colleague).toBe(200);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'deposit_conflict' });
    const stored = world.units.get('u-1');
    expect(stored?.deposit_one_month).toBe(true);
    expect(stored).not.toHaveProperty('deposit');
    // Nothing wedged: a later save of another Deposit key lands.
    const notes = await patchUnit(app, 'u-1', { deposit_notes: 'Two payments' });
    expect(notes.status).toBe(200);
    expect(notes.body.unit).toMatchObject({ deposit_one_month: true, deposit_notes: 'Two payments' });
  });

  it("a slow PATCH never writes its map back over a restore's REMOVE: recomputed against the restored landlord", async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-new', { req_pet_fee: '$300' });
    seedUnit(world, 'u-1', {
      landlordId: 'c-old',
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      primary_contact: 'c-pm',
      deleted_at: REQ_STAMP,
      requirement_sources: { pets: 'set_here', credit_requirements: 'set_here' },
    });
    const fenced = world.unitsRepo.updateIfRequirementsCurrent.bind(world.unitsRepo);
    let raced = false;
    world.unitsRepo.updateIfRequirementsCurrent = async (read, patch) => {
      if (!raced) {
        raced = true;
        await world.unitsRepo.restoreWithLandlord('u-1', { expectLandlordId: 'c-old', next: { contactId: 'c-new' } });
      }
      return fenced(read, patch);
    };
    const res = await patchUnit(app, 'u-1', { pet_fee: '$300' });
    expect(res.status).toBe(200);
    expect(res.body.unit.landlordId).toBe('c-new');
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'copied' });
  });
});
