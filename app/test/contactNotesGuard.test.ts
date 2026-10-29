// WP1 B2a spec D14.3 (plan S1.6, S1.8): the Notes box's per-box stamp
// `notes_updated_at` and its stale-save guard - the Staff notes rule
// (contactStaffNotes.test.ts; staff-notes spec 3.9) applied to `notes`.
//   PATCH /api/contacts/:id { notes }                             -> notes_updated_at stamped
//   PATCH /api/contacts/:id { notes, notes_expected_updated_at }  -> 409 notes_stale when the stamp moved
//   POST  /api/contacts { notes }                                 -> notes_updated_at stamped
// Runs on the shared in-memory world (makeWebhookHarness), like contactStaffNotes.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

type World = ReturnType<typeof createFakeWorld>;

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OLD = '2020-01-01T00:00:00.000Z';

function seedTenant(world: World, over: Partial<ContactItem> = {}): void {
  world.contacts.push({
    contactId: 'c-nb-1',
    type: 'tenant',
    status: 'searching',
    firstName: 'Tasha',
    lastName: 'Nguyen',
    phone: '+15550100011',
    notes: 'prefers mornings',
    ...over,
  });
}

function stored(world: World): ContactItem {
  const c = world.contacts.find((x) => x.contactId === 'c-nb-1');
  if (!c) throw new Error('seed missing');
  return c;
}

describe('notes_updated_at - the contacts routes stamp every Notes write (D14.3)', () => {
  it('a PATCH of notes stamps notes_updated_at in the same write, and returns it', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const res = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ notes: 'works nights downtown' });

    expect(res.status).toBe(200);
    expect(stored(world).notes).toBe('works nights downtown');
    expect(stored(world).notes_updated_at).toMatch(ISO);
    expect(res.body.contact.notes_updated_at).toBe(stored(world).notes_updated_at);
    // The stamp is not a changed field of its own: the audit names notes only.
    const audit = world.auditEvents.find((e) => e.event_type === 'contact_updated');
    expect(audit?.payload).toMatchObject({ fields: ['notes'] });
  });

  it('a clear stamps too, replacing an older stamp', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { notes_updated_at: OLD });

    const res = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ notes: '' });

    expect(res.status).toBe(200);
    expect(stored(world).notes).toBe('');
    expect(stored(world).notes_updated_at).toMatch(ISO);
    expect(stored(world).notes_updated_at).not.toBe(OLD);
  });

  it('(PIN) a PATCH that does not carry notes leaves the stamp alone - a staff_notes save included', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { notes_updated_at: OLD });

    const name = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ firstName: 'Tash' });
    expect(name.status).toBe(200);
    expect(stored(world).notes_updated_at).toBe(OLD);

    const staff = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ staff_notes: 'call before visits' });
    expect(staff.status).toBe(200);
    expect(stored(world).staff_notes_updated_at).toMatch(ISO);
    expect(stored(world).notes_updated_at).toBe(OLD);
  });

  it('a manual create with notes stamps notes_updated_at; a create without notes carries none', async () => {
    const { app, world } = makeWebhookHarness();

    const withNotes = await auth(request(app).post('/api/contacts')).send({
      type: 'tenant', firstName: 'Pat', lastName: 'Renter', phone: '(555) 010-7101', notes: 'likes townhomes',
    });
    expect(withNotes.status).toBe(201);
    expect(withNotes.body.contact.notes).toBe('likes townhomes');
    expect(withNotes.body.contact.notes_updated_at).toMatch(ISO);
    const created = world.contacts.find((c) => c.contactId === withNotes.body.contact.contactId);
    expect(created?.notes_updated_at).toBe(withNotes.body.contact.notes_updated_at);

    const without = await auth(request(app).post('/api/contacts')).send({
      type: 'tenant', firstName: 'Lee', lastName: 'Renter', phone: '(555) 010-7102',
    });
    expect(without.status).toBe(201);
    expect('notes_updated_at' in without.body.contact).toBe(false);
  });
});

// WP1 B2a spec D14.3: the Notes stale-save guard. The PATCH accepts
// notes_expected_updated_at (a non-empty string, or null = "never stamped",
// which becomes attribute_not_exists), applied only when the patch carries
// notes, through the same expect guards and conflict re-read as Staff notes.
describe('PATCH /api/contacts/:id - the Notes stale-save guard (D14.3)', () => {
  const STAMP = '2026-10-28T10:00:00.000Z';
  const LATER = '2026-10-28T11:00:00.000Z';
  const THEIRS = 'prefers mornings\n[Auto - Oct 28] works nights downtown';

  it('(PIN) with the stamp the form opened with, the save lands and re-stamps; the expectation is never stored', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { notes_updated_at: STAMP });

    const res = await auth(request(app).patch('/api/contacts/c-nb-1')).send({
      notes: 'mine', notes_expected_updated_at: STAMP,
    });

    expect(res.status).toBe(200);
    expect(stored(world).notes).toBe('mine');
    expect(stored(world).notes_updated_at).toMatch(ISO);
    expect(stored(world).notes_updated_at).not.toBe(STAMP);
    expect('notes_expected_updated_at' in stored(world)).toBe(false);
  });

  it('a stale stamp is refused 409 notes_stale with the CURRENT contact; nothing in the save is written or audited', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { notes: THEIRS, notes_updated_at: LATER });

    const res = await auth(request(app).patch('/api/contacts/c-nb-1')).send({
      notes: 'mine, typed on a stale form', firstName: 'Natasha', notes_expected_updated_at: STAMP,
    });

    expect([res.status, res.body.error]).toEqual([409, 'notes_stale']);
    expect(res.body.contact).toEqual(stored(world));
    expect(stored(world)).toMatchObject({ notes: THEIRS, notes_updated_at: LATER, firstName: 'Tasha' });
    expect(world.auditEvents.find((e) => e.event_type === 'contact_updated')).toBeUndefined();
  });

  it('expected null lands on a never-stamped box, and is refused once a stamp exists', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const first = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ notes: 'first', notes_expected_updated_at: null });
    expect(first.status).toBe(200);
    expect(stored(world).notes).toBe('first');

    const second = await auth(request(app).patch('/api/contacts/c-nb-1')).send({
      notes: 'second, from a form opened before the first save', notes_expected_updated_at: null,
    });
    expect([second.status, second.body.error]).toEqual([409, 'notes_stale']);
    expect(second.body.contact.notes).toBe('first');
    expect(stored(world).notes).toBe('first');
  });

  it('a cleared box keeps its stamp, so a null expectation after a clear is refused too', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { notes: '', notes_updated_at: STAMP });

    const res = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ notes: 'mine', notes_expected_updated_at: null });

    expect([res.status, res.body.error]).toEqual([409, 'notes_stale']);
    expect(res.body.contact.notes).toBe('');
  });

  it('400s an expectation that is neither a non-empty string nor null', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const five = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ notes: 'x', notes_expected_updated_at: 5 });
    expect(five.status).toBe(400);
    expect(five.body.error).toBe('notes_expected_updated_at must be a non-empty string or null');
    expect(stored(world).notes).toBe('prefers mornings');

    // '' can never match a real stamp, so it is refused too (not a 409 loop).
    const empty = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ notes: 'x', notes_expected_updated_at: '' });
    expect(empty.status).toBe(400);
    expect(stored(world).notes).toBe('prefers mornings');
  });

  it('(PIN) without the expectation the PATCH stays last-write-wins (every other caller is unchanged)', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { notes: THEIRS, notes_updated_at: LATER });

    const res = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ notes: 'mine' });
    expect(res.status).toBe(200);
    expect(stored(world).notes).toBe('mine');
  });

  it('(PIN) an expectation WITHOUT notes guards nothing (the body still needs a known field)', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { notes_updated_at: LATER });

    const withName = await auth(request(app).patch('/api/contacts/c-nb-1')).send({
      firstName: 'Natasha', notes_expected_updated_at: STAMP,
    });
    expect(withName.status).toBe(200);
    expect(stored(world).firstName).toBe('Natasha');

    const alone = await auth(request(app).patch('/api/contacts/c-nb-1')).send({ notes_expected_updated_at: STAMP });
    expect(alone.status).toBe(400);
    expect(alone.body.error).toBe('no updatable fields supplied');
  });

  it('an unknown contact with an expectation is still 404, never 409', async () => {
    const { app } = makeWebhookHarness();

    const res = await auth(request(app).patch('/api/contacts/c-missing')).send({ notes: 'x', notes_expected_updated_at: null });
    expect([res.status, res.body.error]).toEqual([404, 'contact_not_found']);
  });

  // With ANOTHER guard present (the classification guard a role change
  // brings), the Notes box is stale only when its stamp actually moved.
  for (const expected of [null, STAMP]) {
    for (const [label, classificationChanged, notesChanged, error] of [
      ['both current', false, false, undefined],
      ['classification alone changed', true, false, 'contact_changed'],
      ['notes alone changed', false, true, 'notes_stale'],
      ['both changed', true, true, 'notes_stale'],
    ] as const) {
      it(`composes the classification and Notes guards: ${label}, expected ${expected ?? 'absent'}`, async () => {
        const { app, world } = makeWebhookHarness();
        seedTenant(world, {
          classification_revision: 3,
          ...(expected !== null && { notes_updated_at: expected }),
        });
        const update = world.contactsRepo.update.bind(world.contactsRepo);
        world.contactsRepo.update = async (id, patch, opts) => {
          if (classificationChanged) await update(id, { type: 'partner', status: 'active' });
          if (notesChanged) await update(id, { notes: THEIRS, notes_updated_at: LATER });
          return update(id, patch, opts);
        };

        const res = await auth(request(app).patch('/api/contacts/c-nb-1')).send({
          role: 'Inspector', notes: 'my notes', notes_expected_updated_at: expected, firstName: 'My edit',
        });

        if (error === undefined) {
          expect(res.status).toBe(200);
          expect(stored(world)).toMatchObject({
            role: 'Inspector', notes: 'my notes', classification_revision: 4, firstName: 'My edit',
          });
          expect(stored(world).notes_updated_at).toMatch(ISO);
        } else {
          expect([res.status, res.body.error]).toEqual([409, error]);
          expect(res.body.contact).toEqual(stored(world));
          expect(stored(world)).toMatchObject({
            type: classificationChanged ? 'partner' : 'tenant',
            notes: notesChanged ? THEIRS : 'prefers mornings',
            firstName: 'Tasha',
          });
          expect(stored(world).role).toBeUndefined();
          expect(world.auditEvents.filter((e) => e.event_type === 'contact_updated')).toEqual([]);
        }
      });
    }
  }

  // One save carrying BOTH boxes, each with its expectation: each box is
  // stale only when its own stamp moved, and Staff notes wins when both did
  // (the Staff notes card's existing contract).
  for (const [label, staffMoved, notesMoved, error] of [
    ['both boxes current', false, false, undefined],
    ['Staff notes alone moved', true, false, 'staff_notes_stale'],
    ['Notes alone moved', false, true, 'notes_stale'],
    ['both moved', true, true, 'staff_notes_stale'],
  ] as const) {
    it(`a save of both boxes: ${label}`, async () => {
      const { app, world } = makeWebhookHarness();
      seedTenant(world, { staff_notes: 'theirs', staff_notes_updated_at: STAMP, notes_updated_at: STAMP });
      const update = world.contactsRepo.update.bind(world.contactsRepo);
      world.contactsRepo.update = async (id, patch, opts) => {
        if (staffMoved) await update(id, { staff_notes: 'newer staff note', staff_notes_updated_at: LATER });
        if (notesMoved) await update(id, { notes: THEIRS, notes_updated_at: LATER });
        return update(id, patch, opts);
      };

      const res = await auth(request(app).patch('/api/contacts/c-nb-1')).send({
        staff_notes: 'my staff note', staff_notes_expected_updated_at: STAMP,
        notes: 'my notes', notes_expected_updated_at: STAMP,
      });

      if (error === undefined) {
        expect(res.status).toBe(200);
        expect(stored(world)).toMatchObject({ staff_notes: 'my staff note', notes: 'my notes' });
      } else {
        expect([res.status, res.body.error]).toEqual([409, error]);
        expect(res.body.contact).toEqual(stored(world));
        expect(stored(world)).toMatchObject({
          staff_notes: staffMoved ? 'newer staff note' : 'theirs',
          notes: notesMoved ? THEIRS : 'prefers mornings',
        });
      }
    });
  }
});
