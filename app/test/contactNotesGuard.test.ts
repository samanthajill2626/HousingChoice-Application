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
