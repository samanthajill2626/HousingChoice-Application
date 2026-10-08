// /api/organizations (spec 2026-10-06 section 6, D10-D13; plan 3.4b, 3.5,
// 3.6): supertest over the shared harness with real sealed cookies - a VA
// (TEST_SESSION_COOKIE) and an admin (TEST_ADMIN_COOKIE) - and the world fakes
// (contacts, units, audit, the in-memory org list). Task 5.3 runs rewrites
// through the REAL in-process queue and the registered org.rewrite job (the
// broadcastApi.test.ts pattern): a 202, then settle(), then the records.
import request, { type Test } from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySchedulerAdapter, InProcessOutboundQueueAdapter } from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import { registerOrgRewriteJobHandler } from '../src/jobs/orgRewrite.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import { STARTING_ORG_LIST } from '../src/lib/orgStartingList.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { OrgListBusyError, OrgListFullError } from '../src/repos/orgListRepo.js';
import { TEST_ADMIN_COOKIE, TEST_ADMIN_USER, TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import {
  ATLANTA,
  AUGUSTA,
  DCA,
  STEP_UP,
  orgListItem,
  orgRef,
  quietLogger,
  runningRewrite,
} from './helpers/orgFixtures.js';
import { makeWebhookHarness, ORIGIN_SECRET, type Harness } from './helpers/twilioWebhookHarness.js';

const BASE = '/api/organizations';
const DELETED_AT = '2026-10-01T00:00:00.000Z';

/** Calls as one session (the CloudFront header and the session cookie set). */
function as(h: Harness, cookie: string) {
  const authed = (t: Test): Test => t.set('x-origin-verify', ORIGIN_SECRET).set('cookie', cookie);
  return {
    get: (path = '') => authed(request(h.app).get(`${BASE}${path}`)),
    post: (path: string, body: object = {}) => authed(request(h.app).post(`${BASE}${path}`)).send(body),
    patch: (path: string, body: object) => authed(request(h.app).patch(`${BASE}${path}`)).send(body),
    del: (path: string) => authed(request(h.app).delete(`${BASE}${path}`)),
  };
}

/** A harness whose org list is the five-entry fixture. */
async function harness(): Promise<Harness> {
  const h = makeWebhookHarness();
  await h.world.orgListRepo.putForSeed(orgListItem());
  return h;
}

function tenant(contactId: string, extra: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'tenant', status: 'searching', ...extra };
}

function property(unitId: string, extra: Partial<UnitItem> = {}): UnitItem {
  return { unitId, landlordId: 'l-1', status: 'available', ...extra };
}

describe('GET /api/organizations - both lists, for everyone', () => {
  it('a VA reads the lists; an empty store answers with the starting list', async () => {
    const h = makeWebhookHarness();
    const res = await as(h, TEST_SESSION_COOKIE).get();
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual(STARTING_ORG_LIST.map((s) => s.name));
    expect(res.body).not.toHaveProperty('lastRewrite');
  });

  it('carries lastRewrite once one exists', async () => {
    const h = makeWebhookHarness();
    const last = runningRewrite({ action: 'clear', field: 'agency', fromTexts: ['x'] });
    await h.world.orgListRepo.putForSeed(orgListItem(undefined, { lastRewrite: last }));
    expect((await as(h, TEST_SESSION_COOKIE).get()).body.lastRewrite).toEqual(last);
  });

  it('(PIN) sits behind requireAuth', async () => {
    const h = makeWebhookHarness();
    expect((await request(h.app).get(BASE).set('x-origin-verify', ORIGIN_SECRET)).status).toBe(401);
  });
});

describe('GET /api/organizations/usage', () => {
  it('counts the records whose field of the entry kind holds the exact name, deleted ones beside them', async () => {
    const h = await harness();
    h.world.contacts.push(
      tenant('t-1', { housingAuthority: ATLANTA.name }),
      tenant('t-2', { housingAuthority: ATLANTA.name, deleted_at: DELETED_AT }),
      { contactId: 'p-1', type: 'partner', status: 'active', agency: STEP_UP.name },
    );
    h.world.units.set('u-1', property('u-1', { accepted_authorities: [ATLANTA.name] }));
    const res = await as(h, TEST_SESSION_COOKIE).get('/usage');
    expect(res.status).toBe(200);
    expect(res.body.usage['org-atl']).toEqual({
      tenants: 1,
      otherContacts: 0,
      properties: 1,
      organization: 0,
      deleted: 1,
      inUse: { active: 2, deleted: 1 },
      kindLocked: { active: 2, deleted: 1 },
    });
    expect(res.body.usage['org-stepup']).toEqual({
      tenants: 0,
      otherContacts: 1,
      properties: 0,
      organization: 0,
      deleted: 0,
      inUse: { active: 1, deleted: 0 },
      kindLocked: { active: 1, deleted: 0 },
    });
  });
});

describe('GET /api/organizations/not-on-list (+ /records) - for everyone', () => {
  it('lists the off-list values with their resolution and expands one value into its records', async () => {
    const h = await harness();
    h.world.contacts.push(tenant('t-1', { firstName: 'Tia', lastName: 'One', housingAuthority: 'AHA' }));
    h.world.units.set('u-1', property('u-1', { accepted_authorities: ['DCA'] }));
    const va = as(h, TEST_SESSION_COOKIE);
    const rows = await va.get('/not-on-list');
    expect(rows.status).toBe(200);
    expect(rows.body.rows).toEqual([
      {
        field: 'housingAuthority',
        value: 'AHA',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'ambiguous', candidates: [orgRef(ATLANTA), orgRef(AUGUSTA)] },
      },
      {
        field: 'accepted_authorities',
        value: 'DCA',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'match', match: orgRef(DCA) },
      },
    ]);
    const records = await va.get('/not-on-list/records').query({ field: 'housingAuthority', value: 'AHA' });
    expect(records.status).toBe(200);
    expect(records.body.records).toEqual([
      { kind: 'contact', contactId: 't-1', name: 'Tia One', type: 'tenant', deleted: false },
    ]);
  });

  it('a records request needs a known field and a value', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    expect((await va.get('/not-on-list/records').query({ field: 'type', value: 'x' })).status).toBe(400);
    expect((await va.get('/not-on-list/records').query({ field: 'agency' })).status).toBe(400);
  });
});

describe('POST /api/organizations/check - for everyone', () => {
  it('answers the D4 resolution with the new-name and spelling problems', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    const res = await va.post('/check', { kind: 'housing_authority', text: 'AHA', spellingFor: 'org-dca' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      candidates: [orgRef(ATLANTA), orgRef(AUGUSTA)],
      close: [],
      nameProblem: 'org_name_taken',
      spellingProblem: 'shared_same_kind',
    });
  });

  it('400s a bad kind or text and 404s an unknown spellingFor', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    expect((await va.post('/check', { kind: 'county', text: 'x' })).status).toBe(400);
    expect((await va.post('/check', { kind: 'agency', text: 7 })).status).toBe(400);
    const missing = await va.post('/check', { kind: 'agency', text: 'x', spellingFor: 'org-nope' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'org_not_found' });
  });

  it('refuses a text over 200 characters before any check runs (spec section 6)', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    expect((await va.post('/check', { kind: 'agency', text: 'x'.repeat(201) })).status).toBe(400);
    expect((await va.post('/check', { kind: 'agency', text: 'x'.repeat(200) })).status).toBe(200);
  });
});

describe('POST /api/organizations - add, for everyone (spec D6, D10)', () => {
  it('a VA adds an entry with notes: 201 and the entry', async () => {
    const h = await harness();
    const res = await as(h, TEST_SESSION_COOKIE).post('', { kind: 'agency', name: 'Mercy Care', notes: 'Clinic partner' });
    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({
      kind: 'agency',
      name: 'Mercy Care',
      notes: 'Clinic partner',
      spellings: [],
      createdBy: TEST_SESSION_USER.userId,
    });
    const list = await as(h, TEST_SESSION_COOKIE).get();
    expect(list.body.entries.at(-1)).toEqual(res.body.entry);
  });

  it('answers each refusal with its plan-3.5 code', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    const taken = await va.post('', { kind: 'housing_authority', name: 'aha' });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: 'org_name_taken', entry: orgRef(ATLANTA) });
    const invalid = await va.post('', { kind: 'agency', name: `Mercy${String.fromCharCode(10)}Care` });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'org_name_invalid' });
    const tooLong = await va.post('', { kind: 'agency', name: 'Mercy Care', notes: 'n'.repeat(501) });
    expect(tooLong.body).toEqual({ error: 'org_notes_too_long' });
    expect((await va.post('', { kind: 'county', name: 'x' })).status).toBe(400);
    expect((await va.post('', { kind: 'agency' })).status).toBe(400);
  });

  it('409 org_rewrite_running while a running rewrite has the name among its from-texts (review R1-ADV-BE-1)', async () => {
    const h = makeWebhookHarness();
    const clearing = runningRewrite({
      action: 'clear',
      field: 'housingAuthority',
      fromTexts: ['Metro HA'],
      heartbeatAt: new Date().toISOString(),
    });
    await h.world.orgListRepo.putForSeed(orgListItem(undefined, { lastRewrite: clearing }));
    const va = as(h, TEST_SESSION_COOKIE);
    const refused = await va.post('', { kind: 'housing_authority', name: 'Metro HA' });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'org_rewrite_running', lastRewrite: clearing });
    // Any other name is added as usual while that rewrite runs.
    expect((await va.post('', { kind: 'housing_authority', name: 'Fulton County Housing Authority' })).status).toBe(201);
  });

  it('maps a busy or full list store to 503 org_list_busy and 409 org_list_full', async () => {
    const h = await harness();
    vi.spyOn(h.world.orgListRepo, 'mutate')
      .mockRejectedValueOnce(new OrgListBusyError())
      .mockRejectedValueOnce(new OrgListFullError());
    const va = as(h, TEST_SESSION_COOKIE);
    const busy = await va.post('', { kind: 'agency', name: 'Mercy Care' });
    expect(busy.status).toBe(503);
    expect(busy.body).toEqual({ error: 'org_list_busy' });
    const full = await va.post('', { kind: 'agency', name: 'Mercy Care' });
    expect(full.status).toBe(409);
    expect(full.body).toEqual({ error: 'org_list_full' });
  });
});

describe('PATCH /api/organizations/:orgId (plan 3.6)', () => {
  it('notes are open to everyone; exactly one change per request; an unknown id is 404', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    const ok = await va.patch('/org-dca', { notes: 'Statewide vouchers' });
    expect(ok.status).toBe(200);
    expect(ok.body.entry).toMatchObject({ orgId: 'org-dca', notes: 'Statewide vouchers', updatedBy: TEST_SESSION_USER.userId });
    const two = await va.patch('/org-dca', { notes: 'a', name: 'b' });
    expect(two.status).toBe(400);
    expect(two.body).toEqual({ error: 'one_change_per_request' });
    expect((await va.patch('/org-dca', {})).body).toEqual({ error: 'one_change_per_request' });
    const missing = await va.patch('/org-nope', { notes: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'org_not_found' });
  });

  it('spellings, name and kind are admin-only - the inline check answers 403 forbidden', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    for (const body of [{ spellings: ['DCA'] }, { name: 'Georgia Community Affairs' }, { kind: 'agency' }]) {
      const res = await va.patch('/org-dca', body);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
    }
  });

  it('an admin edits spellings; a same-kind share needs confirmShared', async () => {
    const admin = as(await harness(), TEST_ADMIN_COOKIE);
    const edited = await admin.patch('/org-dca', { spellings: ['DCA', 'Georgia DCA', 'GA DCA'] });
    expect(edited.status).toBe(200);
    expect(edited.body.entry.spellings).toEqual(['DCA', 'Georgia DCA', 'GA DCA']);
    const shared = await admin.patch('/org-dca', { spellings: ['DCA', 'AHA'] });
    expect(shared.status).toBe(409);
    expect(shared.body).toEqual({ error: 'org_spelling_shared', spelling: 'AHA', entries: [orgRef(ATLANTA), orgRef(AUGUSTA)] });
    const confirmed = await admin.patch('/org-dca', { spellings: ['DCA', 'AHA'], confirmShared: true });
    expect(confirmed.body.entry.spellings).toEqual(['DCA', 'AHA']);
  });

  it('a kind change is refused while any record - deleted included - uses the entry', async () => {
    const h = await harness();
    h.world.contacts.push({ contactId: 'p-1', type: 'partner', status: 'active', agency: STEP_UP.name, deleted_at: DELETED_AT });
    const admin = as(h, TEST_ADMIN_COOKIE);
    const used = await admin.patch('/org-stepup', { kind: 'housing_authority' });
    expect(used.status).toBe(409);
    expect(used.body).toEqual({ error: 'org_in_use', uses: { active: 0, deleted: 1 } });
    const free = await admin.patch('/org-vash', { kind: 'housing_authority' });
    expect(free.status).toBe(200);
    expect(free.body.entry).toMatchObject({ orgId: 'org-vash', kind: 'housing_authority' });
  });
});

describe('DELETE /api/organizations/:orgId (admin)', () => {
  it('is admin-only, refused while used, 204 when unused, 404 when unknown', async () => {
    const h = await harness();
    h.world.contacts.push(tenant('t-1', { housingAuthority: DCA.name }));
    expect((await as(h, TEST_SESSION_COOKIE).del('/org-stepup')).status).toBe(403);
    const admin = as(h, TEST_ADMIN_COOKIE);
    const used = await admin.del('/org-dca');
    expect(used.status).toBe(409);
    expect(used.body).toEqual({ error: 'org_in_use', uses: { active: 1, deleted: 0 } });
    expect((await admin.del('/org-stepup')).status).toBe(204);
    expect((await as(h, TEST_SESSION_COOKIE).get()).body.entries.map((e: { orgId: string }) => e.orgId)).not.toContain('org-stepup');
    const missing = await admin.del('/org-stepup');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'org_not_found' });
  });
});

describe('rewrites through the real in-process queue and the org.rewrite job (spec D10, D11)', () => {
  // The in-process queue DEFERS immediate dispatch (SQS semantics): a 202
  // returns before the job runs, so each case awaits queue.settle(). The reset
  // sits in `finally` so a slow drain can never poison the next test
  // (docs/issues/broadcast-fanout-tests-blow-default-hooktimeout.md).
  let queue: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(quietLogger());
    configureScheduler(new InMemorySchedulerAdapter());
    queue = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queue);
  });

  afterEach(async () => {
    try {
      await queue.settle();
    } finally {
      _resetForTests();
    }
  });

  /** The org.rewrite job over the SAME world fakes the routes use. */
  function wireRewriteJob(h: Harness): void {
    registerOrgRewriteJobHandler({
      orgListRepo: h.world.orgListRepo,
      contactsRepo: h.world.contactsRepo,
      unitsRepo: h.world.unitsRepo,
      auditRepo: h.world.auditRepo,
      logger: quietLogger(),
    });
  }

  it('(PIN) an admin rename answers 202, then the job rewrites every holder and records done', async () => {
    const h = await harness();
    wireRewriteJob(h);
    h.world.contacts.push(
      tenant('t-1', { housingAuthority: ATLANTA.name }),
      tenant('t-2', { housingAuthority: ATLANTA.name, deleted_at: DELETED_AT }),
    );
    h.world.units.set('u-1', property('u-1', { accepted_authorities: [ATLANTA.name] }));
    const NEW = 'Housing Authority of the City of Atlanta';
    const admin = as(h, TEST_ADMIN_COOKIE);
    const started = await admin.patch('/org-atl', { name: NEW });
    expect(started.status).toBe(202);
    expect(started.body.entry).toMatchObject({ name: NEW, spellings: ['AHA', 'Atlanta Housing', 'Atlanta (AHA)', ATLANTA.name] });
    expect(started.body.skippedSpellings).toEqual([]);
    expect(started.body.lastRewrite).toMatchObject({
      action: 'rename',
      fromTexts: [ATLANTA.name],
      toName: NEW,
      status: 'running',
      startedBy: TEST_ADMIN_USER.userId,
    });
    await queue.settle();
    expect(h.world.contacts.map((c) => c['housingAuthority'])).toEqual([NEW, NEW]);
    expect(h.world.units.get('u-1')?.accepted_authorities).toEqual([NEW]);
    const after = await admin.get();
    expect(after.body.lastRewrite).toMatchObject({
      jobId: started.body.lastRewrite.jobId,
      status: 'done',
      counts: { housingAuthority: 2, agency: 0, accepted_authorities: 1, organization: 0, skipped: 0, conflicts: 0 },
    });
    const audits = h.world.auditEvents.filter((e) => e.event_type === 'org_name_rewrite');
    expect(audits).toHaveLength(3);
    expect(audits.every((e) => e.actorId === TEST_ADMIN_USER.userId)).toBe(true);
  });

  it('the job payload carries the rewrite id - never the envelope id - and a second rewrite waits for the first', async () => {
    const h = await harness();
    const recorded: JobEnvelope[] = [];
    configureOutboundQueue({
      enqueue: async (envelope) => {
        recorded.push(envelope);
      },
    });
    const admin = as(h, TEST_ADMIN_COOKIE);
    const started = await admin.patch('/org-dca', { name: 'Georgia Community Affairs' });
    expect(started.status).toBe(202);
    const { jobId } = started.body.lastRewrite;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.jobName).toBe('org.rewrite');
    expect(recorded[0]?.payload).toEqual({ jobId });
    expect(recorded[0]?.jobId).not.toBe(jobId);
    const merge = await admin.post('/org-aug/merge', { intoOrgId: 'org-atl' });
    expect(merge.status).toBe(409);
    expect(merge.body).toMatchObject({ error: 'org_rewrite_running', lastRewrite: { jobId, status: 'running' } });
    expect((await admin.post('/rewrite/run-again')).body).toMatchObject({ error: 'org_rewrite_running' });
    expect((await admin.post('/not-on-list/resolve', { field: 'agency', value: 'Steps', action: 'clear' })).status).toBe(409);
  });

  it('an admin merge moves the merged name onto the target and the job rewrites its holders', async () => {
    const h = await harness();
    wireRewriteJob(h);
    h.world.contacts.push(
      tenant('t-1', { housingAuthority: AUGUSTA.name }),
      tenant('t-2', { housingAuthority: 'AHA' }), // shared with Atlanta: no from-text, left for Settings
    );
    const admin = as(h, TEST_ADMIN_COOKIE);
    const started = await admin.post('/org-aug/merge', { intoOrgId: 'org-atl' });
    expect(started.status).toBe(202);
    expect(started.body.lastRewrite).toMatchObject({ action: 'merge', fromTexts: [AUGUSTA.name], toName: ATLANTA.name });
    await queue.settle();
    expect(h.world.contacts.map((c) => c['housingAuthority'])).toEqual([ATLANTA.name, 'AHA']);
    const list = await admin.get();
    expect(list.body.entries.map((e: { orgId: string }) => e.orgId)).not.toContain('org-aug');
    expect(list.body.entries[0].spellings).toEqual(['AHA', 'Atlanta Housing', 'Atlanta (AHA)', AUGUSTA.name]);
    expect(list.body.lastRewrite).toMatchObject({ status: 'done' });
  });

  it('an admin settles a Not-on-the-list value with Use + Remember, and the row is gone', async () => {
    const h = await harness();
    wireRewriteJob(h);
    h.world.contacts.push(tenant('t-1', { housingAuthority: 'Atlanta Hsg Auth' }));
    const admin = as(h, TEST_ADMIN_COOKIE);
    const started = await admin.post('/not-on-list/resolve', {
      field: 'housingAuthority',
      value: 'Atlanta Hsg Auth',
      action: 'use',
      name: ATLANTA.name,
      rememberSpelling: true,
    });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ lastRewrite: { action: 'use', field: 'housingAuthority' }, skippedSpellings: [] });
    await queue.settle();
    expect(h.world.contacts[0]?.['housingAuthority']).toBe(ATLANTA.name);
    expect((await admin.get('/not-on-list')).body.rows).toEqual([]);
    expect((await admin.get()).body.entries[0].spellings).toContain('Atlanta Hsg Auth');
  });

  it('resolve and merge are admin-only, and their bodies are validated', async () => {
    const h = await harness();
    const va = as(h, TEST_SESSION_COOKIE);
    expect((await va.post('/not-on-list/resolve', { field: 'agency', value: 'Steps', action: 'clear' })).status).toBe(403);
    expect((await va.post('/org-aug/merge', { intoOrgId: 'org-atl' })).status).toBe(403);
    expect((await va.post('/rewrite/run-again')).status).toBe(403);
    const admin = as(h, TEST_ADMIN_COOKIE);
    expect((await admin.post('/not-on-list/resolve', { field: 'agency', value: 'Steps', action: 'delete' })).status).toBe(400);
    expect((await admin.post('/not-on-list/resolve', { field: 'agency', action: 'clear' })).status).toBe(400);
    expect((await admin.post('/not-on-list/resolve', { field: 'type', value: 'x', action: 'clear' })).status).toBe(400);
    expect((await admin.post('/org-aug/merge', {})).status).toBe(400);
  });

  it('a name variant is settled only with Use <its entry>: 409 org_value_is_name_variant names the entry (spec D10)', async () => {
    const h = await harness();
    h.world.contacts.push(tenant('t-1', { housingAuthority: 'atlanta housing authority' }));
    const res = await as(h, TEST_ADMIN_COOKIE).post('/not-on-list/resolve', {
      field: 'housingAuthority',
      value: 'atlanta housing authority',
      action: 'clear',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'org_value_is_name_variant', entry: orgRef(ATLANTA) });
    expect(h.world.contacts[0]?.['housingAuthority']).toBe('atlanta housing authority');
  });

  it('an enqueue failure answers 202 with the rewrite failed; Run again restarts it under a new id', async () => {
    const h = await harness();
    h.world.contacts.push(tenant('t-1', { housingAuthority: DCA.name }));
    configureOutboundQueue({
      enqueue: async () => {
        throw new Error('queue down');
      },
    });
    const admin = as(h, TEST_ADMIN_COOKIE);
    const failed = await admin.patch('/org-dca', { name: 'Georgia Community Affairs' });
    expect(failed.status).toBe(202);
    expect(failed.body.lastRewrite).toMatchObject({ status: 'failed', error: 'enqueue_failed' });
    // The list change stands: the rename happened, only its records pass did not.
    expect((await admin.get()).body.entries[2].name).toBe('Georgia Community Affairs');
    configureOutboundQueue(queue);
    wireRewriteJob(h);
    const again = await admin.post('/rewrite/run-again');
    expect(again.status).toBe(202);
    expect(again.body.lastRewrite.status).toBe('running');
    expect(again.body.lastRewrite.jobId).not.toBe(failed.body.lastRewrite.jobId);
    await queue.settle();
    expect(h.world.contacts[0]?.['housingAuthority']).toBe('Georgia Community Affairs');
    expect((await admin.get()).body.lastRewrite).toMatchObject({ status: 'done' });
  });

  it('Run again with nothing failed or stalled is 409 org_rewrite_not_rerunnable', async () => {
    const admin = as(await harness(), TEST_ADMIN_COOKIE);
    const res = await admin.post('/rewrite/run-again');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'org_rewrite_not_rerunnable' });
  });
});

describe('organization holders and the two refusals (spec D10, D17; R2-F1)', () => {
  it('Delete counts DISTINCT records in any field, organization included; a kind change ignores organization-only holders', async () => {
    const h = await harness();
    h.world.contacts.push(
      tenant('t-1', { housingAuthority: DCA.name, organization: DCA.name }), // two columns, ONE record
      { contactId: 'p-1', type: 'partner', status: 'active', role: 'Caseworker', organization: STEP_UP.name },
      { contactId: 'p-2', type: 'partner', status: 'active', organization: STEP_UP.name, deleted_at: DELETED_AT },
    );
    const admin = as(h, TEST_ADMIN_COOKIE);
    const { usage } = (await admin.get('/usage')).body;
    expect(usage['org-dca']).toMatchObject({ tenants: 1, organization: 1, inUse: { active: 1, deleted: 0 } });
    expect(usage['org-stepup']).toMatchObject({ organization: 1, deleted: 1, kindLocked: { active: 0, deleted: 0 } });
    const delDca = await admin.del('/org-dca');
    expect(delDca.status).toBe(409);
    expect(delDca.body).toEqual({ error: 'org_in_use', uses: { active: 1, deleted: 0 } });
    const delStep = await admin.del('/org-stepup');
    expect(delStep.status).toBe(409);
    expect(delStep.body).toEqual({ error: 'org_in_use', uses: { active: 1, deleted: 1 } });
    const rekindDca = await admin.patch('/org-dca', { kind: 'agency' });
    expect(rekindDca.status).toBe(409);
    expect(rekindDca.body).toEqual({ error: 'org_in_use', uses: { active: 1, deleted: 0 } });
    const rekindStep = await admin.patch('/org-stepup', { kind: 'housing_authority' });
    expect(rekindStep.status).toBe(200);
    expect(rekindStep.body.entry).toMatchObject({ orgId: 'org-stepup', kind: 'housing_authority' });
  });
});
