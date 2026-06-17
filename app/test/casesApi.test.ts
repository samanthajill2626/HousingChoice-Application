// Cases + boards API (M1.10b) — CRUD, the board list filters (by stage /
// tenant / unit / tourDate / deadlineType), stage advance + tour clear via
// PATCH, and the composite next-deadline endpoint. Runs on the shared in-memory
// world (the harness casesRepo fake), authed via the real sealed session cookie
// next to the origin secret.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { toCaseUpdatedEvent } from '../src/lib/events.js';
import type { CaseItem } from '../src/repos/casesRepo.js';

describe('cases API (M1.10b)', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
  });

  const authedGet = (path: string) =>
    request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
  const authedPost = (path: string, body: object) =>
    request(app)
      .post(path)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(body);
  const authedPatch = (path: string, body: object) =>
    request(app)
      .patch(path)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(body);

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/cases').set('x-origin-verify', ORIGIN_SECRET);
    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/cases opens a case (default stage interested), emits case.updated, audits — no PII on the wire', async () => {
    const res = await authedPost('/api/cases', {
      tenantId: 'c-tenant',
      unitId: 'unit-1',
      placement_tag: 'Keisha @ 123 Main',
    });
    expect(res.status).toBe(201);
    expect(res.body.case.caseId).toMatch(/^case-/);
    expect(res.body.case.stage).toBe('interested');
    expect(res.body.case.tenantId).toBe('c-tenant');
    expect(res.body.case.placement_tag).toBe('Keisha @ 123 Main');
    expect(world.cases.size).toBe(1);

    const evt = world.emitted.find((e) => e.event === 'case.updated');
    expect(evt).toBeDefined();
    // The compact event carries IDs/stage only — NEVER the placement_tag (a name).
    expect(JSON.stringify(evt!.payload)).not.toContain('Keisha');

    expect(world.auditEvents.some((a) => a.event_type === 'case_created')).toBe(true);
  });

  it('POST /api/cases rejects missing tenantId/unitId and a bad stage', async () => {
    expect((await authedPost('/api/cases', { unitId: 'unit-1' })).status).toBe(400);
    expect((await authedPost('/api/cases', { tenantId: 'c-1' })).status).toBe(400);
    expect((await authedPost('/api/cases', { tenantId: 'c-1', unitId: 'u-1', stage: 'bogus' })).status).toBe(400);
  });

  it('GET /api/cases/:caseId returns the case; 404 for unknown', async () => {
    const c = await world.casesRepo.create({ tenantId: 'c-1', unitId: 'u-1', stage: 'touring' });
    const res = await authedGet(`/api/cases/${c.caseId}`);
    expect(res.status).toBe(200);
    expect(res.body.case.stage).toBe('touring');
    expect((await authedGet('/api/cases/case-ghost')).status).toBe(404);
  });

  it('GET /api/cases filters by stage / tenant / unit / tourDate, lists all with no filter, 400s a bad allowlist value', async () => {
    await world.casesRepo.create({ tenantId: 't-1', unitId: 'u-1', stage: 'applied' });
    await world.casesRepo.create({ tenantId: 't-1', unitId: 'u-2', stage: 'touring', tour_date: '2026-07-01' });
    await world.casesRepo.create({ tenantId: 't-2', unitId: 'u-1', stage: 'applied' });

    expect((await authedGet('/api/cases')).body.cases).toHaveLength(3);
    expect((await authedGet('/api/cases?stage=applied')).body.cases).toHaveLength(2);
    expect((await authedGet('/api/cases?tenantId=t-1')).body.cases).toHaveLength(2);
    expect((await authedGet('/api/cases?unitId=u-1')).body.cases).toHaveLength(2);
    expect((await authedGet('/api/cases?tourDate=2026-07-01')).body.cases).toHaveLength(1);

    expect((await authedGet('/api/cases?stage=bogus')).status).toBe(400);
    expect((await authedGet('/api/cases?deadlineType=whenever')).status).toBe(400);
    expect((await authedGet('/api/cases?tourDate=2026-13-45')).status).toBe(400); // impossible date
    expect((await authedGet('/api/cases?limit=0')).status).toBe(400);
    expect((await authedGet('/api/cases?cursor=not-base64-json')).status).toBe(400);
  });

  it('GET /api/cases?deadlineType=&before= bounds the due-by window (canonicalized) and 400s a bad before', async () => {
    const due = await world.casesRepo.create({ tenantId: 't', unitId: 'u-due', stage: 'rta_submitted' });
    await world.casesRepo.setNextDeadline(due.caseId, { type: 'rta_window', at: '2026-06-16T08:00:00.000Z' });
    const later = await world.casesRepo.create({ tenantId: 't', unitId: 'u-later', stage: 'rta_submitted' });
    await world.casesRepo.setNextDeadline(later.caseId, { type: 'rta_window', at: '2026-06-20T00:00:00.000Z' });

    // Cutoff between the two → only the earlier (due) case is returned.
    const res = await authedGet('/api/cases?deadlineType=rta_window&before=2026-06-17T00:00:00.000Z');
    expect(res.status).toBe(200);
    expect(res.body.cases).toHaveLength(1);
    expect(res.body.cases[0].caseId).toBe(due.caseId);

    // A bad before → 400 (never a silently-wrong window).
    expect((await authedGet('/api/cases?deadlineType=rta_window&before=not-a-date')).status).toBe(400);
  });

  it('PATCH /api/cases/:caseId advances the stage, clears tour_date with null, and emits', async () => {
    const c = await world.casesRepo.create({
      tenantId: 't',
      unitId: 'u',
      stage: 'touring',
      tour_date: '2026-07-02',
    });
    const res = await authedPatch(`/api/cases/${c.caseId}`, { stage: 'applied', tour_date: null });
    expect(res.status).toBe(200);
    expect(res.body.case.stage).toBe('applied');
    expect(res.body.case.tour_date).toBeUndefined();
    expect(world.emitted.some((e) => e.event === 'case.updated')).toBe(true);
    expect(world.auditEvents.some((a) => a.event_type === 'case_updated')).toBe(true);
  });

  it('PATCH rejects a bad stage, the next_deadline_* keys, an immutable/unknown field, an attention SET, and 404s unknown', async () => {
    const c = await world.casesRepo.create({ tenantId: 't', unitId: 'u', stage: 'interested' });
    expect((await authedPatch(`/api/cases/${c.caseId}`, { stage: 'bogus' })).status).toBe(400);
    expect((await authedPatch(`/api/cases/${c.caseId}`, { next_deadline_at: '2026-07-01T00:00:00.000Z' })).status).toBe(400);
    expect((await authedPatch(`/api/cases/${c.caseId}`, { caseId: 'x' })).status).toBe(400); // immutable key
    expect((await authedPatch(`/api/cases/${c.caseId}`, { attention: { reason: 'x' } })).status).toBe(400); // set not allowed
    expect((await authedPatch(`/api/cases/${c.caseId}`, {})).status).toBe(400); // empty patch
    expect((await authedPatch('/api/cases/case-ghost', { stage: 'lost' })).status).toBe(404);
  });

  it('PATCH can CLEAR the attention flag with null (operator acknowledges an escalation)', async () => {
    const c = await world.casesRepo.create({
      tenantId: 't',
      unitId: 'u',
      stage: 'applied',
      attention: { reason: 'send_failed', at: '2026-06-14T00:00:00.000Z' },
    });
    const res = await authedPatch(`/api/cases/${c.caseId}`, { attention: null });
    expect(res.status).toBe(200);
    expect(res.body.case.attention).toBeUndefined();
    // The live event reflects the cleared flag → the boards drop the badge.
    const evt = world.emitted.filter((e) => e.event === 'case.updated').at(-1);
    expect((evt!.payload as { attention: boolean }).attention).toBe(false);
  });

  it('POST /api/cases/:caseId/deadline sets then clears the composite deadline, with validation + 404', async () => {
    const c = await world.casesRepo.create({ tenantId: 't', unitId: 'u', stage: 'rta_submitted' });

    const set = await authedPost(`/api/cases/${c.caseId}/deadline`, {
      type: 'rta_window',
      at: '2026-06-16T12:00:00.000Z',
    });
    expect(set.status).toBe(200);
    expect(set.body.case.next_deadline_type).toBe('rta_window');
    expect(set.body.case.next_deadline_at).toBe('2026-06-16T12:00:00.000Z');
    // Now queryable via the deadline board filter.
    expect((await authedGet('/api/cases?deadlineType=rta_window')).body.cases).toHaveLength(1);

    const clear = await authedPost(`/api/cases/${c.caseId}/deadline`, { clear: true });
    expect(clear.status).toBe(200);
    expect(clear.body.case.next_deadline_type).toBeUndefined();
    expect(clear.body.case.next_deadline_at).toBeUndefined();

    // Validation: bad type / bad timestamp.
    expect(
      (await authedPost(`/api/cases/${c.caseId}/deadline`, { type: 'whenever', at: '2026-06-16T12:00:00.000Z' })).status,
    ).toBe(400);
    expect((await authedPost(`/api/cases/${c.caseId}/deadline`, { type: 'rta_window', at: 'not-a-date' })).status).toBe(400);
    // 404 unknown case.
    expect((await authedPost('/api/cases/case-ghost/deadline', { clear: true })).status).toBe(404);
  });
});

describe('cases API — BE2/C2 activity milestones', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
  });

  const authedPost = (path: string, body: object) =>
    request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);
  const authedPatch = (path: string, body: object) =>
    request(app).patch(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);

  const milestonesFor = (tenantId: string) =>
    world.activityEvents.filter((e) => e.contactId === tenantId);

  it('case create emits case_opened against the tenant (refType case)', async () => {
    const res = await authedPost('/api/cases', { tenantId: 'c-keisha', unitId: 'unit-1' });
    const caseId = res.body.case.caseId;
    const ev = milestonesFor('c-keisha');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'case_opened', refType: 'case', refId: caseId });
  });

  it('a real stage change emits stage_changed (and NONE when the stage is unchanged)', async () => {
    const c = await world.casesRepo.create({ tenantId: 'c-t', unitId: 'u', stage: 'interested' });
    await authedPatch(`/api/cases/${c.caseId}`, { stage: 'touring' });
    let ev = world.activityEvents.filter((e) => e.type === 'stage_changed');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.label).toBe('Stage → Touring');

    // Re-PATCH a non-stage field → no new stage_changed milestone.
    await authedPatch(`/api/cases/${c.caseId}`, { notes: 'hi' });
    ev = world.activityEvents.filter((e) => e.type === 'stage_changed');
    expect(ev).toHaveLength(1); // unchanged
  });

  it('moving to a terminal stage emits case_closed (lost includes the lost_reason)', async () => {
    const c = await world.casesRepo.create({ tenantId: 'c-t', unitId: 'u', stage: 'applied' });
    await authedPatch(`/api/cases/${c.caseId}`, { stage: 'lost', lost_reason: 'changed_mind' });
    const ev = world.activityEvents.filter((e) => e.type === 'case_closed');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.label).toContain('changed_mind');
    // No spurious stage_changed for a terminal move.
    expect(world.activityEvents.filter((e) => e.type === 'stage_changed')).toHaveLength(0);
  });

  it('newly setting tour_date emits tour_scheduled', async () => {
    const c = await world.casesRepo.create({ tenantId: 'c-t', unitId: 'u', stage: 'touring' });
    await authedPatch(`/api/cases/${c.caseId}`, { tour_date: '2026-07-02' });
    const ev = world.activityEvents.filter((e) => e.type === 'tour_scheduled');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.label).toContain('2026-07-02');
  });

  it('a tour gaining an outcome emits tour_took_place (and NOT before the outcome lands)', async () => {
    const c = await world.casesRepo.create({
      tenantId: 'c-t',
      unitId: 'u',
      stage: 'touring',
      tours: [{ date: '2026-07-02' }],
    });
    // PATCH a tour WITHOUT an outcome yet → no tour_took_place.
    await authedPatch(`/api/cases/${c.caseId}`, { tours: [{ date: '2026-07-02' }] });
    expect(world.activityEvents.filter((e) => e.type === 'tour_took_place')).toHaveLength(0);

    // Now the tour gains an outcome → tour_took_place.
    await authedPatch(`/api/cases/${c.caseId}`, { tours: [{ date: '2026-07-02', outcome: 'attended' }] });
    const ev = world.activityEvents.filter((e) => e.type === 'tour_took_place');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.label).toContain('Attended');
  });
});

describe('toCaseUpdatedEvent (M1.10b live-update payload)', () => {
  it('maps attention to a boolean (both states) and never carries PII', () => {
    const base = { caseId: 'c', tenantId: 't', unitId: 'u', stage: 'applied' } as CaseItem;
    const withAttn = toCaseUpdatedEvent({
      ...base,
      attention: { reason: 'send_failed', at: '2026-06-14T00:00:00.000Z' },
      placement_tag: 'Keisha @ 123 Main',
    });
    expect(withAttn.attention).toBe(true); // load-bearing: M1.10c flips the board badge live
    // placement_tag (a name) is deliberately omitted from the wire payload (doc §9).
    expect(JSON.stringify(withAttn)).not.toContain('Keisha');
    expect(toCaseUpdatedEvent(base).attention).toBe(false);
  });
});
