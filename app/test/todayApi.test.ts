// BE6/C7 — Today action-queue endpoint (GET /api/today → TodayResponse).
// Runs on the shared in-memory world (the harness placements/conversations/contacts
// fakes), authed via the real sealed session cookie next to the origin secret.
//
// Coverage: the four groups (needs_you_now / tours_today / unreplied /
// follow_ups), urgency thresholds + most-urgent-first ordering, attention →
// needs_you_now with attention:true, de-dupe across groups (a placement both
// attention AND due appears once), the UTC "today" date basis for tours_today,
// who/why hydration (incl. a missing contact degrading to the id, not a 500),
// a deterministic total order (same seed → same order), and the empty envelope.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
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
  const seedPlacement = (c: Partial<PlacementItem> & { placementId: string; tenantId: string }): PlacementItem => {
    const item: PlacementItem = {
      stage: 'awaiting_inspection',
      unitId: 'unit-1',
      ...c,
    } as PlacementItem;
    world.placements.set(item.placementId, item);
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
    seedPlacement({
      placementId: 'placement-needs',
      tenantId: 't-1',
      stage: 'awaiting_authority_approval',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000), // 1h overdue
    });
    // tours_today: a placement touring TODAY.
    seedPlacement({ placementId: 'placement-tour', tenantId: 't-2', stage: 'awaiting_inspection', tour_date: todayYmd() });
    // follow_ups: a due follow_up deadline.
    seedPlacement({
      placementId: 'placement-follow',
      tenantId: 't-3',
      stage: 'awaiting_approval',
      next_deadline_type: 'follow_up',
      next_deadline_at: iso(-60_000),
    });
    // unreplied: an open tenant_1to1 conversation with unread.
    seedConversation({
      conversationId: 'conv-unreplied',
      participant_phone: '+15550100002',
      participant_display_name: 'Pat Nguyen',
      participants: [{ contactId: 'ct-pat', phone: '+15550100002' }],
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
    expect(needs[0]).toMatchObject({ refType: 'placement', refId: 'placement-needs', who: 'Keisha Brown' });
    expect(needs[0]!.why).toBe('RTA window closing');

    const tours = byGroup('tours_today');
    expect(tours).toHaveLength(1);
    expect(tours[0]).toMatchObject({ refType: 'placement', refId: 'placement-tour', who: 'Maria Lopez', why: 'Tour today' });

    const unrep = byGroup('unreplied');
    expect(unrep).toHaveLength(1);
    // Links to the participant's CONTACT page, not /conversations/:id.
    expect(unrep[0]).toMatchObject({
      refType: 'contact',
      refId: 'ct-pat',
      who: 'Pat Nguyen',
      why: 'Unreplied',
    });

    const follow = byGroup('follow_ups');
    expect(follow).toHaveLength(1);
    expect(follow[0]).toMatchObject({ refType: 'placement', refId: 'placement-follow', who: 'Sam Lee', why: 'Follow-up due' });
  });

  it('untriaged inbounds (unknown_1to1 unread + unknown/needs_review contact) land in needs_you_now, linking to the contact page', async () => {
    // unknown_1to1 conversation with unread → needs_you_now linking to the
    // auto-captured contact (its participant roster), NOT /conversations/:id.
    seedConversation({
      conversationId: 'conv-unknown',
      participant_phone: '+15550109999',
      participants: [{ contactId: 'contact-from-conv', phone: '+15550109999' }],
      status: 'open',
      last_activity_at: iso(-30_000),
      type: 'unknown_1to1',
      ai_mode: 'auto',
      created_at: iso(-60_000),
      unread_count: 1,
    });
    // A SEPARATE unknown / needs_review contact (different phone) → its own row.
    world.contacts.push({
      contactId: 'contact-unknown',
      type: 'unknown',
      status: 'needs_review',
      phone: '+15550108888',
    });

    const items = await getItems();
    const needs = items.filter((i) => i.group === 'needs_you_now');
    // BOTH untriaged rows link to a contact page (never a dead conversation ref).
    expect(needs.every((i) => i.refType === 'contact')).toBe(true);
    const fromConv = needs.find((i) => i.refId === 'contact-from-conv');
    const fromContact = needs.find((i) => i.refId === 'contact-unknown');
    expect(fromConv).toMatchObject({ who: '+15550109999', attention: true });
    expect(fromContact).toMatchObject({ who: '+15550108888', attention: true });
  });

  it('only due/overdue deadlines (<= now) enter needs_you_now; a future deadline does not', async () => {
    seedTenant('t-future', 'Fut', 'Ure');
    seedTenant('t-over', 'Over', 'Due');
    // A future (not-yet-due) deadline must NOT appear (spec: <= now).
    seedPlacement({
      placementId: 'placement-future',
      tenantId: 't-future',
      stage: 'awaiting_inspection',
      next_deadline_type: 'tour_reminder',
      next_deadline_at: iso(2 * 3_600_000), // 2h out → not due yet
    });
    seedPlacement({
      placementId: 'placement-over',
      tenantId: 't-over',
      stage: 'awaiting_authority_approval',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000), // overdue
    });

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    expect(needs.map((i) => i.refId)).toEqual(['placement-over']); // only the overdue one
    expect(needs[0]!.urgency).toBe('overdue');
  });

  it('most-urgent-first ordering: the more-overdue deadline sorts before the less-overdue', async () => {
    seedTenant('t-1h', 'One', 'Hour');
    seedTenant('t-3h', 'Three', 'Hour');
    seedPlacement({
      placementId: 'placement-1h',
      tenantId: 't-1h',
      stage: 'awaiting_authority_approval',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000), // 1h overdue
    });
    seedPlacement({
      placementId: 'placement-3h',
      tenantId: 't-3h',
      stage: 'awaiting_authority_approval',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3 * 3_600_000), // 3h overdue (more urgent → earlier instant)
    });

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    expect(needs.map((i) => i.refId)).toEqual(['placement-3h', 'placement-1h']); // earliest deadline first
    expect(needs.every((i) => i.urgency === 'overdue')).toBe(true);
  });

  it('attention placement sorts into needs_you_now with attention:true', async () => {
    seedTenant('t-esc', 'Esc', 'Alated');
    seedPlacement({
      placementId: 'placement-attn',
      tenantId: 't-esc',
      stage: 'awaiting_approval',
      attention: { reason: 'Failed send — call the landlord', at: iso(-10_000) },
    });

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    const attn = needs.find((i) => i.refId === 'placement-attn');
    expect(attn).toBeDefined();
    expect(attn!.attention).toBe(true);
    expect(attn!.why).toBe('Failed send — call the landlord');
  });

  it('de-dupe: a placement that is BOTH attention AND has a due deadline appears once (with attention:true)', async () => {
    seedTenant('t-both', 'Both', 'Flags');
    seedPlacement({
      placementId: 'placement-both',
      tenantId: 't-both',
      stage: 'awaiting_authority_approval',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000),
      attention: { reason: 'Escalated', at: iso(-5_000) },
    });

    const items = await getItems();
    const matches = items.filter((i) => i.refId === 'placement-both');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ group: 'needs_you_now', attention: true });
    // It kept the deadline `why` (the deadline placed it first), not blanked.
    expect(matches[0]!.why).toBe('RTA window closing');
  });

  it('tours_today uses the UTC "today" date basis (today appears, tomorrow does not)', async () => {
    seedTenant('t-today', 'To', 'Day');
    seedTenant('t-tom', 'To', 'Morrow');
    seedPlacement({ placementId: 'placement-today', tenantId: 't-today', stage: 'awaiting_inspection', tour_date: todayYmd() });
    seedPlacement({ placementId: 'placement-tomorrow', tenantId: 't-tom', stage: 'awaiting_inspection', tour_date: tomorrowYmd() });

    const tours = (await getItems()).filter((i) => i.group === 'tours_today');
    expect(tours.map((i) => i.refId)).toEqual(['placement-today']);
  });

  it('?day= scopes tours_today to the caller\'s day (backend tz-agnostic; browser passes its local date)', async () => {
    // Two tours on distinct FAR-FUTURE days so neither collides with UTC-today.
    seedTenant('t-d2', 'Day', 'Two');
    seedTenant('t-d3', 'Day', 'Three');
    seedPlacement({ placementId: 'placement-d2', tenantId: 't-d2', stage: 'awaiting_inspection', tour_date: '2030-01-02' });
    seedPlacement({ placementId: 'placement-d3', tenantId: 't-d3', stage: 'awaiting_inspection', tour_date: '2030-01-03' });

    // Without ?day=, UTC-today is used → neither far-future tour appears.
    const noneByDefault = (await getItems()).filter((i) => i.group === 'tours_today');
    expect(noneByDefault).toEqual([]);

    // ?day=2030-01-02 → only that day's tour; ?day=2030-01-03 → only the other.
    const d2 = await authedGet('/api/today?day=2030-01-02');
    expect(d2.status).toBe(200);
    expect(
      (d2.body as TodayResponse).items.filter((i) => i.group === 'tours_today').map((i) => i.refId),
    ).toEqual(['placement-d2']);

    const d3 = await authedGet('/api/today?day=2030-01-03');
    expect(
      (d3.body as TodayResponse).items.filter((i) => i.group === 'tours_today').map((i) => i.refId),
    ).toEqual(['placement-d3']);
  });

  it('a malformed ?day= is a 400 (not a 500, not silently ignored)', async () => {
    for (const bad of ['garbage', '2026-13-40', '06-17-2026', '2026-6-7', '2026-06-17T00:00:00Z']) {
      const res = await authedGet(`/api/today?day=${encodeURIComponent(bad)}`);
      expect(res.status, `day=${bad}`).toBe(400);
    }
  });

  it('?day= scopes ONLY tours_today — the now-relative groups are unaffected', async () => {
    // A due deadline (needs_you_now) is "as of now" regardless of ?day=.
    seedTenant('t-dl', 'Dead', 'Line');
    seedPlacement({
      placementId: 'placement-dl',
      tenantId: 't-dl',
      stage: 'awaiting_authority_approval',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-1000),
    });
    const res = await authedGet('/api/today?day=2030-01-02');
    expect(res.status).toBe(200);
    const needs = (res.body as TodayResponse).items.filter((i) => i.group === 'needs_you_now');
    expect(needs.map((i) => i.refId)).toContain('placement-dl');
  });

  it('best-effort hydration: a missing tenant contact degrades who to the id, never a 500', async () => {
    // No contact seeded for t-missing.
    seedPlacement({
      placementId: 'placement-missing-who',
      tenantId: 't-missing',
      stage: 'awaiting_inspection',
      next_deadline_type: 'tour_reminder',
      next_deadline_at: iso(-1000),
    });
    const items = await getItems();
    const item = items.find((i) => i.refId === 'placement-missing-who');
    expect(item).toBeDefined();
    expect(item!.who).toBe('t-missing');
  });

  it('deterministic total order: same seed → same order (tie-break by refId)', async () => {
    // Two attention-only placements (same urgency "now") + tie-break by refId.
    seedTenant('t-a', 'Aa', 'Aa');
    seedTenant('t-b', 'Bb', 'Bb');
    seedPlacement({ placementId: 'placement-bbb', tenantId: 't-b', stage: 'awaiting_approval', attention: { reason: 'x', at: iso(-1) } });
    seedPlacement({ placementId: 'placement-aaa', tenantId: 't-a', stage: 'awaiting_approval', attention: { reason: 'x', at: iso(-1) } });

    const first = (await getItems()).filter((i) => i.group === 'needs_you_now').map((i) => i.refId);
    const second = (await getItems()).filter((i) => i.group === 'needs_you_now').map((i) => i.refId);
    expect(first).toEqual(second);
    expect(first).toEqual(['placement-aaa', 'placement-bbb']); // tie-break by refId ascending
  });

  // --- FIX A: terminal placements (moved_in/lost) never surface in placement-bearing groups -
  it('a lost placement with an overdue hard-clock deadline does NOT appear in needs_you_now (active one does)', async () => {
    seedTenant('t-lost', 'Lost', 'Case');
    seedTenant('t-live', 'Live', 'Case');
    seedPlacement({
      placementId: 'placement-lost-deadline',
      tenantId: 't-lost',
      stage: 'lost',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000), // overdue, but terminal
    });
    seedPlacement({
      placementId: 'placement-live-deadline',
      tenantId: 't-live',
      stage: 'awaiting_authority_approval',
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000), // same overdue deadline, but active
    });

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    const ids = needs.map((i) => i.refId);
    expect(ids).toContain('placement-live-deadline'); // stage-scoped, not deadline-scoped
    expect(ids).not.toContain('placement-lost-deadline');
  });

  it('a moved_in placement with today\'s tour_date does NOT appear in tours_today (active one does)', async () => {
    seedTenant('t-movedin', 'Moved', 'In');
    seedTenant('t-touring', 'Still', 'Touring');
    seedPlacement({ placementId: 'placement-movedin-tour', tenantId: 't-movedin', stage: 'moved_in', tour_date: todayYmd() });
    seedPlacement({ placementId: 'placement-touring-tour', tenantId: 't-touring', stage: 'awaiting_inspection', tour_date: todayYmd() });

    const tours = (await getItems()).filter((i) => i.group === 'tours_today');
    const ids = tours.map((i) => i.refId);
    expect(ids).toContain('placement-touring-tour');
    expect(ids).not.toContain('placement-movedin-tour');
  });

  it('a lost placement with a due follow-up deadline does NOT appear in follow_ups (active one does)', async () => {
    seedTenant('t-lostfu', 'Lost', 'Followup');
    seedTenant('t-livefu', 'Live', 'Followup');
    seedPlacement({
      placementId: 'placement-lost-fu',
      tenantId: 't-lostfu',
      stage: 'lost',
      next_deadline_type: 'stuck_placement',
      next_deadline_at: iso(-60_000),
    });
    seedPlacement({
      placementId: 'placement-live-fu',
      tenantId: 't-livefu',
      stage: 'awaiting_approval',
      next_deadline_type: 'follow_up',
      next_deadline_at: iso(-60_000),
    });

    const follow = (await getItems()).filter((i) => i.group === 'follow_ups');
    const ids = follow.map((i) => i.refId);
    expect(ids).toContain('placement-live-fu');
    expect(ids).not.toContain('placement-lost-fu');
  });

  // --- FIX B: relay_group threads never surface in unreplied --------------------
  it('a relay_group conversation with unread does NOT appear in unreplied (a tenant_1to1 still does)', async () => {
    seedConversation({
      conversationId: 'conv-relay',
      participant_phone: '+15550107777', // synthetic pool number, no display name
      status: 'open',
      last_activity_at: iso(-90_000),
      type: 'relay_group',
      ai_mode: 'auto',
      created_at: iso(-200_000),
      unread_count: 3,
    });
    seedConversation({
      conversationId: 'conv-tenant',
      participant_phone: '+15550106666',
      participant_display_name: 'Real Tenant',
      status: 'open',
      last_activity_at: iso(-50_000),
      type: 'tenant_1to1',
      ai_mode: 'auto',
      created_at: iso(-200_000),
      unread_count: 1,
    });

    const items = await getItems();
    const unrep = items.filter((i) => i.group === 'unreplied');
    const ids = unrep.map((i) => i.refId);
    expect(ids).toContain('conv-tenant');
    expect(ids).not.toContain('conv-relay');
    // And the relay group is nowhere else either (not an unreplied or needs_you_now row).
    expect(items.some((i) => i.refId === 'conv-relay')).toBe(false);
  });

  // --- A2P: relay opt-out attention (a relay member on the Do-Not-Contact list) --
  const seedRelayWithOptOut = (memberContactId: string, memberPhone: string): void => {
    seedConversation({
      conversationId: 'conv-relay-optout',
      participant_phone: '+15550103333', // synthetic pool number
      status: 'open',
      last_activity_at: iso(-40_000),
      type: 'relay_group',
      ai_mode: 'manual',
      created_at: iso(-200_000),
      participants: [{ contactId: memberContactId, phone: memberPhone, name: 'Opted Member' }],
      relay_opted_out_members: {
        [memberContactId]: { contactId: memberContactId, phone: memberPhone, name: 'Opted Member', at: iso(-20_000) },
      },
    } as ConversationItem);
  };

  it('a still-opted-out relay member surfaces a needs_you_now item linking to the CONTACT page', async () => {
    world.contacts.push({
      contactId: 'c-optout',
      type: 'tenant',
      status: 'active',
      firstName: 'Opted',
      lastName: 'Out',
      phone: '+15550102222',
      sms_opt_out: true, // live-confirmed still opted out
    });
    seedRelayWithOptOut('c-optout', '+15550102222');

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    const item = needs.find((i) => i.refType === 'contact' && i.refId === 'c-optout');
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      group: 'needs_you_now',
      refType: 'contact',
      refId: 'c-optout',
      who: 'Opted Out',
      why: 'Opted out of a group text — not receiving messages',
      tag: 'Group text',
      attention: true,
    });
  });

  it('does NOT surface the item once the member has opted back in (sms_opt_out cleared) — live-confirmed', async () => {
    world.contacts.push({
      contactId: 'c-backin',
      type: 'tenant',
      status: 'active',
      firstName: 'Back',
      lastName: 'In',
      phone: '+15550102222',
      // sms_opt_out is NOT set → they opted back in; the stale conv flag must not surface.
    });
    seedRelayWithOptOut('c-backin', '+15550102222');

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    expect(needs.some((i) => i.refId === 'c-backin')).toBe(false);
  });

  it('does NOT surface the item when the member contact is deleted, or has no contactId', async () => {
    // Deleted contact → off the boards even though still opted out.
    world.contacts.push({
      contactId: 'c-del',
      type: 'tenant',
      phone: '+15550102222',
      sms_opt_out: true,
      deleted_at: iso(-5_000),
    });
    seedRelayWithOptOut('c-del', '+15550102222');
    // A second relay whose opted-out entry has NO contactId → can't link/confirm.
    seedConversation({
      conversationId: 'conv-relay-nocid',
      participant_phone: '+15550101111',
      status: 'open',
      last_activity_at: iso(-40_000),
      type: 'relay_group',
      ai_mode: 'manual',
      created_at: iso(-200_000),
      relay_opted_out_members: {
        'phone#+15550100000': { phone: '+15550100000', name: 'No Contact', at: iso(-20_000) },
      },
    } as ConversationItem);

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    expect(needs.some((i) => i.refId === 'c-del')).toBe(false);
    expect(needs.some((i) => i.refId === 'phone#+15550100000')).toBe(false);
  });

  // --- FIX C: de-dupe untriaged inbounds by phone (one item per person) ----------
  it('an unknown inbound (unknown_1to1 unread + needs_review contact, same phone) yields ONE needs_you_now item linking to the contact', async () => {
    const phone = '+15550105555';
    // No participant roster on the conversation (auto-capture race) → the
    // conversation defers to the contacts triage pass, which emits the contact
    // row. Still ONE item per person, now linking to the contact page.
    seedConversation({
      conversationId: 'conv-untriaged',
      participant_phone: phone,
      status: 'open',
      last_activity_at: iso(-30_000),
      type: 'unknown_1to1',
      ai_mode: 'auto',
      created_at: iso(-60_000),
      unread_count: 1,
    });
    world.contacts.push({
      contactId: 'contact-untriaged',
      type: 'unknown',
      status: 'needs_review',
      phone, // same phone as the unknown conversation
    });

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    const untriaged = needs.filter(
      (i) => i.refId === 'conv-untriaged' || i.refId === 'contact-untriaged',
    );
    expect(untriaged).toHaveLength(1); // one item per person
    // The contact row wins — never a dead /conversations/:id link.
    expect(untriaged[0]).toMatchObject({ refType: 'contact', refId: 'contact-untriaged' });
  });

  it('a needs_review contact whose phone has no unread unknown conversation still emits its own row', async () => {
    world.contacts.push({
      contactId: 'contact-only',
      type: 'unknown',
      status: 'needs_review',
      phone: '+15550104444',
    });

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    const contact = needs.find((i) => i.refType === 'contact' && i.refId === 'contact-only');
    expect(contact).toMatchObject({ refId: 'contact-only', who: '+15550104444', attention: true });
  });

  it('the envelope is { items, generatedAt } with an ISO generatedAt when items exist', async () => {
    seedTenant('t-env', 'En', 'Velope');
    seedPlacement({ placementId: 'placement-env', tenantId: 't-env', stage: 'awaiting_inspection', tour_date: todayYmd() });
    const res = await authedGet('/api/today');
    const body = res.body as TodayResponse;
    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'items']);
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
    expect(body.items.length).toBeGreaterThan(0);
  });
});
