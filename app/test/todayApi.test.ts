// BE6/C7 — Today action-queue endpoint (GET /api/today → TodayResponse).
// Runs on the shared in-memory world (the harness cases/conversations/contacts
// fakes), authed via the real sealed session cookie next to the origin secret.
//
// Coverage: the four groups (needs_you_now / tours_today / unreplied /
// follow_ups), urgency thresholds + most-urgent-first ordering, attention →
// needs_you_now with attention:true, de-dupe across groups (a case both
// attention AND due appears once), the UTC "today" date basis for tours_today,
// who/why hydration (incl. a missing contact degrading to the id, not a 500),
// a deterministic total order (same seed → same order), and the empty envelope.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import type { CaseItem } from '../src/repos/casesRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { urgencyOf, type TodayItem, type TodayResponse } from '../src/routes/today.js';

describe('today action-queue API (BE6/C7)', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
  });

  const authedGet = (path: string) =>
    request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

  // --- seed helpers ---------------------------------------------------------
  const seedTenant = (contactId: string, firstName: string, lastName: string): ContactItem => {
    const item: ContactItem = { contactId, type: 'tenant', status: 'active', firstName, lastName };
    world.contacts.push(item);
    return item;
  };
  const seedCase = (c: Partial<CaseItem> & { caseId: string; tenantId: string }): CaseItem => {
    const item: CaseItem = {
      stage: 'touring',
      unitId: 'unit-1',
      ...c,
    } as CaseItem;
    world.cases.set(item.caseId, item);
    return item;
  };
  const seedConversation = (conv: ConversationItem): ConversationItem => {
    world.conversations.set(conv.conversationId, conv);
    return conv;
  };

  const iso = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString();
  const todayYmd = (): string => new Date().toISOString().slice(0, 10);
  const tomorrowYmd = (): string => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  const getItems = async (): Promise<TodayItem[]> => {
    const res = await authedGet('/api/today');
    expect(res.status).toBe(200);
    const body = res.body as TodayResponse;
    return body.items;
  };

  it('urgencyOf (pure): thresholds — overdue / Nm left / Nh left / Nd left', () => {
    const now = Date.parse('2026-06-17T12:00:00.000Z');
    expect(urgencyOf('2026-06-17T11:00:00.000Z', now)).toBe('overdue'); // 1h ago
    expect(urgencyOf('2026-06-17T12:00:00.000Z', now)).toBe('overdue'); // exactly now
    expect(urgencyOf('2026-06-17T12:30:00.000Z', now)).toBe('30m left'); // < 60m
    expect(urgencyOf('2026-06-17T14:00:00.000Z', now)).toBe('2h left'); // < 48h
    expect(urgencyOf('2026-06-20T12:00:00.000Z', now)).toBe('3d left'); // >= 48h
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/today').set('x-origin-verify', ORIGIN_SECRET);
    expect([401, 403]).toContain(res.status);
  });

  it('returns { items: [], generatedAt } when nothing is pending (ISO generatedAt)', async () => {
    const res = await authedGet('/api/today');
    expect(res.status).toBe(200);
    const body = res.body as TodayResponse;
    expect(body.items).toEqual([]);
    expect(typeof body.generatedAt).toBe('string');
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
  });

  it('groups items into all four groups with refType/refId and populated who/why', async () => {
    seedTenant('t-1', 'Keisha', 'Brown');
    seedTenant('t-2', 'Maria', 'Lopez');
    seedTenant('t-3', 'Sam', 'Lee');
    seedTenant('t-4', 'Pat', 'Nguyen');

    // needs_you_now: a due hard-clock deadline (rta_window, overdue).
    seedCase({
      caseId: 'case-needs',
      tenantId: 't-1',
      stage: 'rta_submitted',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000), // 1h overdue
    });
    // tours_today: a case touring TODAY.
    seedCase({ caseId: 'case-tour', tenantId: 't-2', stage: 'touring', tour_date: todayYmd() });
    // follow_ups: a due follow_up deadline.
    seedCase({
      caseId: 'case-follow',
      tenantId: 't-3',
      stage: 'applied',
      next_deadline_type: 'follow_up',
      next_deadline_at: iso(-60_000),
    });
    // unreplied: an open tenant_1to1 conversation with unread.
    seedConversation({
      conversationId: 'conv-unreplied',
      participant_phone: '+15550100002',
      participant_display_name: 'Pat Nguyen',
      status: 'open',
      last_activity_at: iso(-120_000),
      type: 'tenant_1to1',
      ai_mode: 'auto',
      created_at: iso(-200_000),
      unread_count: 2,
    });

    const items = await getItems();
    const byGroup = (g: string) => items.filter((i) => i.group === g);

    const needs = byGroup('needs_you_now');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ refType: 'case', refId: 'case-needs', who: 'Keisha Brown' });
    expect(needs[0]!.why).toBe('RTA window closing');

    const tours = byGroup('tours_today');
    expect(tours).toHaveLength(1);
    expect(tours[0]).toMatchObject({ refType: 'case', refId: 'case-tour', who: 'Maria Lopez', why: 'Tour today' });

    const unrep = byGroup('unreplied');
    expect(unrep).toHaveLength(1);
    expect(unrep[0]).toMatchObject({
      refType: 'conversation',
      refId: 'conv-unreplied',
      who: 'Pat Nguyen',
      why: 'Unreplied',
    });

    const follow = byGroup('follow_ups');
    expect(follow).toHaveLength(1);
    expect(follow[0]).toMatchObject({ refType: 'case', refId: 'case-follow', who: 'Sam Lee', why: 'Follow-up due' });
  });

  it('untriaged inbounds (unknown_1to1 unread + unknown/needs_review contact) land in needs_you_now', async () => {
    // unknown_1to1 conversation with unread → needs_you_now (refType conversation).
    seedConversation({
      conversationId: 'conv-unknown',
      participant_phone: '+15550109999',
      status: 'open',
      last_activity_at: iso(-30_000),
      type: 'unknown_1to1',
      ai_mode: 'auto',
      created_at: iso(-60_000),
      unread_count: 1,
    });
    // unknown / needs_review contact → needs_you_now (refType contact).
    world.contacts.push({
      contactId: 'contact-unknown',
      type: 'unknown',
      status: 'needs_review',
      phone: '+15550108888',
    });

    const items = await getItems();
    const needs = items.filter((i) => i.group === 'needs_you_now');
    const conv = needs.find((i) => i.refType === 'conversation');
    const contact = needs.find((i) => i.refType === 'contact');
    expect(conv).toMatchObject({ refId: 'conv-unknown', who: '+15550109999', attention: true });
    expect(contact).toMatchObject({ refId: 'contact-unknown', who: '+15550108888', attention: true });
  });

  it('only due/overdue deadlines (<= now) enter needs_you_now; a future deadline does not', async () => {
    seedTenant('t-future', 'Fut', 'Ure');
    seedTenant('t-over', 'Over', 'Due');
    // A future (not-yet-due) deadline must NOT appear (spec: <= now).
    seedCase({
      caseId: 'case-future',
      tenantId: 't-future',
      stage: 'touring',
      next_deadline_type: 'tour_reminder',
      next_deadline_at: iso(2 * 3_600_000), // 2h out → not due yet
    });
    seedCase({
      caseId: 'case-over',
      tenantId: 't-over',
      stage: 'rta_submitted',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000), // overdue
    });

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    expect(needs.map((i) => i.refId)).toEqual(['case-over']); // only the overdue one
    expect(needs[0]!.urgency).toBe('overdue');
  });

  it('most-urgent-first ordering: the more-overdue deadline sorts before the less-overdue', async () => {
    seedTenant('t-1h', 'One', 'Hour');
    seedTenant('t-3h', 'Three', 'Hour');
    seedCase({
      caseId: 'case-1h',
      tenantId: 't-1h',
      stage: 'rta_submitted',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000), // 1h overdue
    });
    seedCase({
      caseId: 'case-3h',
      tenantId: 't-3h',
      stage: 'rta_submitted',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3 * 3_600_000), // 3h overdue (more urgent → earlier instant)
    });

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    expect(needs.map((i) => i.refId)).toEqual(['case-3h', 'case-1h']); // earliest deadline first
    expect(needs.every((i) => i.urgency === 'overdue')).toBe(true);
  });

  it('attention case sorts into needs_you_now with attention:true', async () => {
    seedTenant('t-esc', 'Esc', 'Alated');
    seedCase({
      caseId: 'case-attn',
      tenantId: 't-esc',
      stage: 'applied',
      attention: { reason: 'Failed send — call the landlord', at: iso(-10_000) },
    });

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    const attn = needs.find((i) => i.refId === 'case-attn');
    expect(attn).toBeDefined();
    expect(attn!.attention).toBe(true);
    expect(attn!.why).toBe('Failed send — call the landlord');
  });

  it('de-dupe: a case that is BOTH attention AND has a due deadline appears once (with attention:true)', async () => {
    seedTenant('t-both', 'Both', 'Flags');
    seedCase({
      caseId: 'case-both',
      tenantId: 't-both',
      stage: 'rta_submitted',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000),
      attention: { reason: 'Escalated', at: iso(-5_000) },
    });

    const items = await getItems();
    const matches = items.filter((i) => i.refId === 'case-both');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ group: 'needs_you_now', attention: true });
    // It kept the deadline `why` (the deadline placed it first), not blanked.
    expect(matches[0]!.why).toBe('RTA window closing');
  });

  it('tours_today uses the UTC "today" date basis (today appears, tomorrow does not)', async () => {
    seedTenant('t-today', 'To', 'Day');
    seedTenant('t-tom', 'To', 'Morrow');
    seedCase({ caseId: 'case-today', tenantId: 't-today', stage: 'touring', tour_date: todayYmd() });
    seedCase({ caseId: 'case-tomorrow', tenantId: 't-tom', stage: 'touring', tour_date: tomorrowYmd() });

    const tours = (await getItems()).filter((i) => i.group === 'tours_today');
    expect(tours.map((i) => i.refId)).toEqual(['case-today']);
  });

  it('best-effort hydration: a missing tenant contact degrades who to the id, never a 500', async () => {
    // No contact seeded for t-missing.
    seedCase({
      caseId: 'case-missing-who',
      tenantId: 't-missing',
      stage: 'touring',
      next_deadline_type: 'tour_reminder',
      next_deadline_at: iso(-1000),
    });
    const items = await getItems();
    const item = items.find((i) => i.refId === 'case-missing-who');
    expect(item).toBeDefined();
    expect(item!.who).toBe('t-missing');
  });

  it('deterministic total order: same seed → same order (tie-break by refId)', async () => {
    // Two attention-only cases (same urgency "now") + tie-break by refId.
    seedTenant('t-a', 'Aa', 'Aa');
    seedTenant('t-b', 'Bb', 'Bb');
    seedCase({ caseId: 'case-bbb', tenantId: 't-b', stage: 'applied', attention: { reason: 'x', at: iso(-1) } });
    seedCase({ caseId: 'case-aaa', tenantId: 't-a', stage: 'applied', attention: { reason: 'x', at: iso(-1) } });

    const first = (await getItems()).filter((i) => i.group === 'needs_you_now').map((i) => i.refId);
    const second = (await getItems()).filter((i) => i.group === 'needs_you_now').map((i) => i.refId);
    expect(first).toEqual(second);
    expect(first).toEqual(['case-aaa', 'case-bbb']); // tie-break by refId ascending
  });

  it('the envelope is { items, generatedAt } with an ISO generatedAt when items exist', async () => {
    seedTenant('t-env', 'En', 'Velope');
    seedCase({ caseId: 'case-env', tenantId: 't-env', stage: 'touring', tour_date: todayYmd() });
    const res = await authedGet('/api/today');
    const body = res.body as TodayResponse;
    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'items']);
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
    expect(body.items.length).toBeGreaterThan(0);
  });
});
