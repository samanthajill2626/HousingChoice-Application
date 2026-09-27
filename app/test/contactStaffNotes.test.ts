// Staff notes (Sam's item 22, spec 2026-09-26-staff-notes-past-tours-design.md
// sections 3.1-3.4): the hand-written box on the tenant file.
//   PATCH /api/contacts/:id { staff_notes } -> stored, staff_notes_updated_at
//                                              server-stamped, notes untouched
//   POST  /api/contacts { staff_notes }     -> ignored (create paths never set it)
//   toProfile / applyExtraction             -> the AI neither reads nor writes it
// Runs on the shared in-memory world (makeWebhookHarness), like contactsCrud.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { toProfile } from '../src/jobs/extraction.js';
import { applyExtraction, type ApplyDeps } from '../src/services/extraction/apply.js';
import { createLogger } from '../src/lib/logger.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

type World = ReturnType<typeof createFakeWorld>;

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function seedTenant(world: World, over: Partial<ContactItem> = {}): void {
  world.contacts.push({
    contactId: 'c-sn-1',
    type: 'tenant',
    status: 'searching',
    firstName: 'Tasha',
    lastName: 'Nguyen',
    phone: '+15550100001',
    notes: 'prefers mornings',
    ...over,
  });
}

function stored(world: World): ContactItem {
  const c = world.contacts.find((x) => x.contactId === 'c-sn-1');
  if (!c) throw new Error('seed missing');
  return c;
}

describe('PATCH /api/contacts/:id - staff_notes (spec 3.1, 3.2)', () => {
  it('stores the text, stamps staff_notes_updated_at, leaves notes alone, audits the field', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'Has a service dog - call before visits',
    });

    expect(res.status).toBe(200);
    expect(res.body.contact.staff_notes).toBe('Has a service dog - call before visits');
    expect(res.body.contact.staff_notes_updated_at).toMatch(ISO);
    expect(res.body.contact.notes).toBe('prefers mornings');
    expect(stored(world).staff_notes).toBe('Has a service dog - call before visits');
    expect(stored(world).staff_notes_updated_at).toMatch(ISO);
    expect(stored(world).notes).toBe('prefers mornings');
    // No provenance marker is ever written for this field.
    expect('staff_notes_source' in stored(world)).toBe(false);

    const audit = world.auditEvents.find((e) => e.event_type === 'contact_updated');
    expect(audit?.entityKey).toBe('contacts#c-sn-1');
    expect(audit?.payload).toMatchObject({ fields: ['staff_notes'] });
  });

  it('an empty string clears the text and re-stamps the instant', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, {
      staff_notes: 'old',
      staff_notes_updated_at: '2020-01-01T00:00:00.000Z',
    });

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({ staff_notes: '' });

    expect(res.status).toBe(200);
    expect(stored(world).staff_notes).toBe('');
    expect(stored(world).staff_notes_updated_at).toMatch(ISO);
    expect(stored(world).staff_notes_updated_at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('400s a non-string', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({ staff_notes: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('staff_notes must be a string');
    expect('staff_notes' in stored(world)).toBe(false);
  });

  it('ignores a client-supplied staff_notes_updated_at: alone it changes nothing (400), beside staff_notes the server stamp wins', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const alone = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes_updated_at: '2020-01-01T00:00:00.000Z',
    });
    expect(alone.status).toBe(400);
    expect(alone.body.error).toBe('no updatable fields supplied');
    expect('staff_notes_updated_at' in stored(world)).toBe(false);

    const beside = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'x',
      staff_notes_updated_at: '2020-01-01T00:00:00.000Z',
    });
    expect(beside.status).toBe(200);
    expect(stored(world).staff_notes_updated_at).toMatch(ISO);
    expect(stored(world).staff_notes_updated_at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('a notes-only PATCH does not stamp or touch staff_notes', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { staff_notes: 'keep me', staff_notes_updated_at: '2020-01-01T00:00:00.000Z' });

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({ notes: 'new notes' });

    expect(res.status).toBe(200);
    expect(stored(world).notes).toBe('new notes');
    expect(stored(world).staff_notes).toBe('keep me');
    expect(stored(world).staff_notes_updated_at).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('PATCH /api/contacts/:id - the Staff notes stale-save guard (spec 3.9)', () => {
  const STAMP = '2026-09-27T10:00:00.000Z';

  it('with the stamp the editor opened with, the save lands and re-stamps', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { staff_notes: 'theirs', staff_notes_updated_at: STAMP });

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'mine',
      staff_notes_expected_updated_at: STAMP,
    });

    expect(res.status).toBe(200);
    expect(stored(world).staff_notes).toBe('mine');
    expect(stored(world).staff_notes_updated_at).toMatch(ISO);
    expect(stored(world).staff_notes_updated_at).not.toBe(STAMP);
    // The expectation is a guard, never a stored field.
    expect('staff_notes_expected_updated_at' in stored(world)).toBe(false);
  });

  it('a stale stamp is refused 409 staff_notes_stale with the CURRENT contact; nothing is written or audited', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { staff_notes: 'newer, from a colleague', staff_notes_updated_at: STAMP });

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'mine, typed on a stale page',
      staff_notes_expected_updated_at: '2026-09-27T09:00:00.000Z',
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('staff_notes_stale');
    expect(res.body.contact.staff_notes).toBe('newer, from a colleague');
    expect(res.body.contact.staff_notes_updated_at).toBe(STAMP);
    expect(stored(world).staff_notes).toBe('newer, from a colleague');
    expect(stored(world).staff_notes_updated_at).toBe(STAMP);
    expect(world.auditEvents.find((e) => e.event_type === 'contact_updated')).toBeUndefined();
  });

  it('expected null lands on a never-set box, and is refused once a stamp exists', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const first = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'first',
      staff_notes_expected_updated_at: null,
    });
    expect(first.status).toBe(200);
    expect(stored(world).staff_notes).toBe('first');

    const second = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'second, from a page loaded before the first save',
      staff_notes_expected_updated_at: null,
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('staff_notes_stale');
    expect(second.body.contact.staff_notes).toBe('first');
    expect(stored(world).staff_notes).toBe('first');
  });

  it('a cleared box keeps its stamp, so a stale save after a colleague CLEARED is refused too', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { staff_notes: '', staff_notes_updated_at: STAMP });

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'mine',
      staff_notes_expected_updated_at: null,
    });
    expect(res.status).toBe(409);
    expect(res.body.contact.staff_notes).toBe('');
  });

  it('400s an expectation that is neither a string nor null', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'x',
      staff_notes_expected_updated_at: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('staff_notes_expected_updated_at must be a string or null');
    expect('staff_notes' in stored(world)).toBe(false);
  });

  it('without the expectation the PATCH stays last-write-wins (every other caller is unchanged)', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { staff_notes: 'theirs', staff_notes_updated_at: STAMP });

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({ staff_notes: 'mine' });
    expect(res.status).toBe(200);
    expect(stored(world).staff_notes).toBe('mine');
  });

  it('an expectation WITHOUT staff_notes guards nothing (the body still needs a known field)', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { staff_notes: 'theirs', staff_notes_updated_at: STAMP });

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      notes: 'prefs only',
      staff_notes_expected_updated_at: '2020-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(stored(world).notes).toBe('prefs only');
    expect(stored(world).staff_notes).toBe('theirs');
  });

  it('an unknown contact with an expectation is still 404, never 409', async () => {
    const { app } = makeWebhookHarness();

    const res = await auth(request(app).patch('/api/contacts/c-missing')).send({
      staff_notes: 'x',
      staff_notes_expected_updated_at: null,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contact_not_found');
  });
});

describe('POST /api/contacts - staff_notes is never set on create (spec 3.3)', () => {
  it('drops staff_notes from a manual-create body', async () => {
    const { app, world } = makeWebhookHarness();

    const res = await auth(request(app).post('/api/contacts')).send({
      type: 'tenant',
      firstName: 'Pat',
      lastName: 'Renter',
      phone: '(555) 010-7000',
      staff_notes: 'should be dropped',
    });

    expect(res.status).toBe(201);
    expect('staff_notes' in res.body.contact).toBe(false);
    expect('staff_notes_updated_at' in res.body.contact).toBe(false);
    const created = world.contacts.find((c) => c.contactId === res.body.contact.contactId);
    expect(created).toBeDefined();
    expect('staff_notes' in created!).toBe(false);
  });
});

describe('the AI neither reads nor writes staff_notes (spec 3.4)', () => {
  it('toProfile omits staff_notes even though it carries notes', () => {
    const profile = toProfile({
      contactId: 'c-sn-1',
      type: 'tenant',
      notes: 'profile notes',
      staff_notes: 'staff only',
    } as ContactItem);

    expect(profile.notes).toBe('profile notes');
    expect('staff_notes' in profile).toBe(false);
    expect(JSON.stringify(profile)).not.toContain('staff only');
  });

  it('applyExtraction direct-writes a field and appends a note line, and NO update call carries staff_notes', async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const logCapture = createLogCapture();
    const deps: ApplyDeps = {
      contacts: {
        getById: vi.fn(async () => undefined),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          return { contactId: id, type: 'tenant', ...patch } as ContactItem;
        }),
        addPhone: vi.fn(async (id: string) => ({ contactId: id, type: 'tenant' }) as ContactItem),
        findByPhone: vi.fn(async () => undefined),
      },
      extraction: {
        putSuggestion: vi.fn(async () => ({ state: 'stored' }) as never),
        deleteSuggestion: vi.fn(async () => undefined),
        deleteTypeSuggestionIfCurrentAtContactRevision: vi.fn(async () => 'deleted' as never),
        hasDismissal: vi.fn(async () => false),
      } as unknown as ApplyDeps['extraction'],
      audit: { append: vi.fn(async () => undefined) },
      events: { emit: vi.fn() },
      logger: createLogger({ destination: logCapture.stream, level: 'debug' }),
      now: () => '2026-09-26T15:00:00.000Z',
    };

    const contact = {
      contactId: 'c-sn-1',
      type: 'tenant',
      notes: 'existing',
      staff_notes: 'staff only',
    } as ContactItem;

    const outcome = await applyExtraction(deps, {
      contact,
      conversationId: 'conv-1',
      cursorTsMsgId: 'ts-1',
      // One direct field write (the schema-keyed patch, apply.ts:455-460) AND
      // one note line (the notes append, apply.ts:704): two update calls.
      result: { fields: { pets: { op: 'write', value: 'has a dog' } }, noteLines: ['stairs are a problem'] },
    });

    expect(outcome.wrote).toEqual(['pets']);
    expect(outcome.notedLines).toBe(1);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    // Across EVERY update the apply made, neither staff key ever appears.
    for (const u of updates) {
      expect('staff_notes' in u.patch).toBe(false);
      expect('staff_notes_updated_at' in u.patch).toBe(false);
    }
    expect(updates.some((u) => u.patch['pets'] === 'has a dog')).toBe(true);
    expect(updates.some((u) => u.patch['notes'] === 'existing\n[Auto - Sep 26] stairs are a problem')).toBe(true);
    expect(contact.staff_notes).toBe('staff only');
  });
});
