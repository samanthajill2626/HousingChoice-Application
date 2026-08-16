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
import type { PlacementDeadlineType, PlacementItem } from '../src/repos/placementsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { GROUP_TEXT_STATUS, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { unreadFlagFor } from './helpers/unreadIndexFake.js';
import {
  urgencyOf,
  type RelayCloseNagItem,
  type TodayItem,
  type TodayResponse,
} from '../src/routes/today.js';

describe('today action-queue API (BE6/C7)', () => {
  let app: Express;
  let world: FakeWorld;
  /** The harness's log capture - the truncation WARNs are asserted through it. */
  let harness: ReturnType<typeof makeWebhookHarness>;

  beforeEach(() => {
    const h = makeWebhookHarness();
    harness = h;
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
  // Deadlines are first-class placementDeadlines items now: a `next_deadline_*`
  // shorthand on the seed arms a real item into the fake deadlines map (the
  // placement itself no longer stores a deadline slot).
  const seedPlacement = (
    c: Partial<PlacementItem> & {
      placementId: string;
      tenantId: string;
      next_deadline_type?: string;
      next_deadline_at?: string;
    },
  ): PlacementItem => {
    const { next_deadline_type, next_deadline_at, ...rest } = c;
    const item: PlacementItem = {
      stage: 'awaiting_inspection',
      unitId: 'unit-1',
      ...rest,
    } as PlacementItem;
    world.placements.set(item.placementId, item);
    if (typeof next_deadline_type === 'string' && typeof next_deadline_at === 'string') {
      const deadlineId = `${item.placementId}#${next_deadline_type}`;
      world.placementDeadlines.set(deadlineId, {
        deadlineId,
        placementId: item.placementId,
        type: next_deadline_type as PlacementDeadlineType,
        at: next_deadline_at,
        _deadlinePartition: 'deadlines',
        createdAt: next_deadline_at,
        updatedAt: next_deadline_at,
      });
    }
    return item;
  };
  const seedConversation = (conv: ConversationItem): ConversationItem => {
    // FLAG IFF COUNT>0, derived centrally (helpers/unreadIndexFake.ts): Today's
    // unread sections become index-fed, and the sparse byUnread index keys on
    // `unread_flag` - an unread fixture with no flag would make `unreplied` and
    // the untriaged-inbound `needs_you_now` rows silently EMPTY. An explicit
    // `unread_flag` on the fixture still wins.
    const item: ConversationItem = { ...unreadFlagFor(conv), ...conv };
    world.conversations.set(item.conversationId, item);
    return item;
  };

  const iso = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString();
  const todayYmd = (): string => new Date().toISOString().slice(0, 10);
  // Mid-UTC-day instants: safely inside the route's UTC-day fallback window for
  // "today"/"tomorrow" no matter what wall-clock time the test runs at.
  const todayNoonIso = (): string => `${todayYmd()}T12:00:00.000Z`;
  const tomorrowNoonIso = (): string =>
    `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T12:00:00.000Z`;

  // tours_today source: Tour ENTITIES (the placement.tour_date branch is retired).
  const seedTour = async (t: {
    tourId: string;
    tenantId: string;
    scheduledAt?: string;
    status?: string;
  }): Promise<void> => {
    await world.toursRepo.create({
      tourId: t.tourId,
      tenantId: t.tenantId,
      unitId: 'unit-1',
      tourType: 'self_guided',
      ...(t.scheduledAt !== undefined ? { scheduledAt: t.scheduledAt } : {}),
      ...(t.status !== undefined ? { status: t.status } : {}),
    } as Parameters<typeof world.toursRepo.create>[0]);
  };

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
    expect(body.relayCloseNags).toEqual([]);
    expect(typeof body.generatedAt).toBe('string');
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
  });

  // --- D5: relay close-nags (open relay groups whose 28-day nag is due) -------
  describe('relay close-nags (D5)', () => {
    const NAG_ALICE = '+15550100201';
    const NAG_BOB = '+15550100202';
    const NAG_POOL = '+15550100250';

    const seedRelayGroup = (o: {
      conversationId: string;
      poolNumber: string;
      status: 'open' | 'closed';
      closeNagNextAt?: string;
      participants: Array<{ contactId: string; phone: string; name?: string }>;
      tag?: string;
      owner?: { type: 'tour' | 'placement' | null; id?: string };
    }): void => {
      seedConversation({
        conversationId: o.conversationId,
        participant_phone: o.poolNumber,
        pool_number: o.poolNumber,
        status: o.status,
        relay_status: `relay_group#${o.status}`,
        last_activity_at: iso(-1000),
        type: 'relay_group',
        ai_mode: 'manual',
        created_at: iso(-1_000_000),
        participants: o.participants,
        ...(o.closeNagNextAt !== undefined && { close_nag_next_at: o.closeNagNextAt }),
        ...(o.tag !== undefined && { placement_tag: o.tag }),
        ...(o.owner !== undefined && { owner: o.owner }),
      } as ConversationItem);
    };

    const getNags = async (): Promise<RelayCloseNagItem[]> => {
      const res = await authedGet('/api/today');
      expect(res.status).toBe(200);
      return (res.body as TodayResponse).relayCloseNags;
    };

    it('surfaces exactly the DUE open nag with pool number, member names, tag + owner; future + closed are excluded', async () => {
      const dueAt = iso(-60_000); // 1m ago -> due
      seedRelayGroup({
        conversationId: 'conv-nag-due',
        poolNumber: NAG_POOL,
        status: 'open',
        closeNagNextAt: dueAt,
        participants: [
          { contactId: 'c-a', phone: NAG_ALICE, name: 'Alice' },
          { contactId: 'c-b', phone: NAG_BOB }, // no name -> phone as display DATA
        ],
        tag: 'Maple St tour',
        owner: { type: 'tour', id: 'tour-77' },
      });
      // Open group whose nag is in the FUTURE -> excluded by the timestamp filter.
      seedRelayGroup({
        conversationId: 'conv-nag-future',
        poolNumber: '+15550100260',
        status: 'open',
        closeNagNextAt: iso(3_600_000),
        participants: [{ contactId: 'c-c', phone: '+15550100203', name: 'Cara' }],
      });
      // CLOSED group with a stale (past) nag -> never appears (open-only source).
      seedRelayGroup({
        conversationId: 'conv-nag-closed',
        poolNumber: '+15550100270',
        status: 'closed',
        closeNagNextAt: iso(-60_000),
        participants: [{ contactId: 'c-d', phone: '+15550100204', name: 'Dan' }],
      });

      const nags = await getNags();
      expect(nags).toHaveLength(1);
      const nag = nags[0]!;
      expect(nag.conversationId).toBe('conv-nag-due');
      expect(nag.poolNumber).toBe(NAG_POOL);
      expect(nag.nagDueAt).toBe(dueAt);
      expect(nag.tag).toBe('Maple St tour');
      expect(nag.ownerType).toBe('tour');
      expect(nag.ownerId).toBe('tour-77');
      // memberNames: prefer name, else the phone (display DATA precedent).
      expect([...nag.memberNames].sort()).toEqual(['Alice', NAG_BOB].sort());
    });

    it('an open relay group with NO close_nag_next_at never appears', async () => {
      seedRelayGroup({
        conversationId: 'conv-no-nag',
        poolNumber: NAG_POOL,
        status: 'open',
        participants: [{ contactId: 'c-a', phone: NAG_ALICE, name: 'Alice' }],
      });
      expect(await getNags()).toEqual([]);
    });
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
    // tours_today: a Tour entity scheduled TODAY (mid-UTC-day instant).
    await seedTour({ tourId: 'tour-today', tenantId: 't-2', scheduledAt: todayNoonIso() });
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
    expect(tours[0]).toMatchObject({ refType: 'tour', refId: 'tour-today', who: 'Maria Lopez', why: 'Tour today' });

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
      next_deadline_type: 'voucher_expiration',
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

  it('tours_today folds in Tour entities on the UTC-today fallback window (tomorrow, requested, and legacy tour_date placements do not appear)', async () => {
    seedTenant('t-today', 'To', 'Day');
    seedTenant('t-tom', 'To', 'Morrow');
    await seedTour({ tourId: 'tour-today', tenantId: 't-today', scheduledAt: todayNoonIso() });
    await seedTour({ tourId: 'tour-tomorrow', tenantId: 't-tom', scheduledAt: tomorrowNoonIso() });
    // Time-less (requested) tours belong to the /tours "Needs booking" queue, never Today.
    await seedTour({ tourId: 'tour-requested', tenantId: 't-today' });
    // RETIREMENT: a placement with today's tour_date no longer yields a tours_today item.
    seedPlacement({ placementId: 'placement-legacy-tour', tenantId: 't-today', stage: 'awaiting_inspection', tour_date: todayYmd() });

    const tours = (await getItems()).filter((i) => i.group === 'tours_today');
    expect(tours.map((i) => i.refId)).toEqual(['tour-today']);
  });

  it('?day= scopes tours_today to the caller\'s day (backend tz-agnostic; browser passes its local date)', async () => {
    // Two tours on distinct FAR-FUTURE days so neither collides with UTC-today.
    seedTenant('t-d2', 'Day', 'Two');
    seedTenant('t-d3', 'Day', 'Three');
    await seedTour({ tourId: 'tour-d2', tenantId: 't-d2', scheduledAt: '2030-01-02T12:00:00.000Z' });
    await seedTour({ tourId: 'tour-d3', tenantId: 't-d3', scheduledAt: '2030-01-03T12:00:00.000Z' });

    // Without ?day=, UTC-today is used → neither far-future tour appears.
    const noneByDefault = (await getItems()).filter((i) => i.group === 'tours_today');
    expect(noneByDefault).toEqual([]);

    // ?day=2030-01-02 → only that day's tour; ?day=2030-01-03 → only the other.
    const d2 = await authedGet('/api/today?day=2030-01-02');
    expect(d2.status).toBe(200);
    expect(
      (d2.body as TodayResponse).items.filter((i) => i.group === 'tours_today').map((i) => i.refId),
    ).toEqual(['tour-d2']);

    const d3 = await authedGet('/api/today?day=2030-01-03');
    expect(
      (d3.body as TodayResponse).items.filter((i) => i.group === 'tours_today').map((i) => i.refId),
    ).toEqual(['tour-d3']);
  });

  it('?toursFrom/?toursTo supply the caller\'s LOCAL-day boundaries (an evening tour past the UTC boundary lands on the right local day)', async () => {
    // 2030-01-03T01:00Z = the EVENING of Jan 2 in UTC-5 (e.g. 8pm America/New_York).
    seedTenant('t-eve', 'Eve', 'Ning');
    await seedTour({ tourId: 'tour-evening', tenantId: 't-eve', scheduledAt: '2030-01-03T01:00:00.000Z' });

    // The plain UTC-day fallback for Jan 2 misses it (it's Jan 3 in UTC)…
    const utcDay = await authedGet('/api/today?day=2030-01-02');
    expect(
      (utcDay.body as TodayResponse).items.filter((i) => i.group === 'tours_today'),
    ).toEqual([]);

    // …but the browser's real local-day window for Jan 2 (UTC-5) includes it.
    const from = encodeURIComponent('2030-01-02T05:00:00.000Z');
    const to = encodeURIComponent('2030-01-03T04:59:59.999Z');
    const localDay = await authedGet(`/api/today?day=2030-01-02&toursFrom=${from}&toursTo=${to}`);
    expect(localDay.status).toBe(200);
    expect(
      (localDay.body as TodayResponse).items.filter((i) => i.group === 'tours_today').map((i) => i.refId),
    ).toEqual(['tour-evening']);
  });

  it('a malformed ?toursFrom/?toursTo pair is a 400 (one-sided, garbage, or inverted)', async () => {
    const cases = [
      '?toursFrom=2030-01-02T05:00:00.000Z', // one-sided
      '?toursFrom=garbage&toursTo=2030-01-03T00:00:00.000Z', // unparseable
      '?toursFrom=2030-01-03T00:00:00.000Z&toursTo=2030-01-02T00:00:00.000Z', // inverted
    ];
    for (const qs of cases) {
      const res = await authedGet(`/api/today${qs}`);
      expect(res.status, qs).toBe(400);
    }
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
      next_deadline_type: 'rta_window',
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

  it('tours_today is scheduled-ONLY: canceled and toured tours today do not appear', async () => {
    seedTenant('t-canceled', 'Cancel', 'Ed');
    seedTenant('t-touring', 'Still', 'Touring');
    seedTenant('t-toured', 'Al', 'Ready');
    await seedTour({ tourId: 'tour-canceled', tenantId: 't-canceled', scheduledAt: todayNoonIso(), status: 'canceled' });
    await seedTour({ tourId: 'tour-live', tenantId: 't-touring', scheduledAt: todayNoonIso() });
    // A tour that already happened today must not read as "Tour today" work.
    await seedTour({ tourId: 'tour-done', tenantId: 't-toured', scheduledAt: todayNoonIso(), status: 'toured' });

    const tours = (await getItems()).filter((i) => i.group === 'tours_today');
    const ids = tours.map((i) => i.refId);
    expect(ids).toContain('tour-live');
    expect(ids).not.toContain('tour-done');
    expect(ids).not.toContain('tour-canceled');
  });

  it('a lost placement with a due follow-up deadline does NOT appear in follow_ups (active one does)', async () => {
    seedTenant('t-lostfu', 'Lost', 'Followup');
    seedTenant('t-livefu', 'Live', 'Followup');
    seedPlacement({
      placementId: 'placement-lost-fu',
      tenantId: 't-lostfu',
      stage: 'lost',
      next_deadline_type: 'follow_up',
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

  // INVARIANT (placement-deadline-model): the DERIVED stuck signal is independent
  // of any hard clock — a placement past its stage threshold appears in follow_ups
  // REGARDLESS of a pending rta_window (so it can be in BOTH groups); a stale
  // placement with NO deadline appears only in follow_ups.
  it('derived-stuck coexists with a hard clock: a stuck placement with a due rta_window is in BOTH groups', async () => {
    seedTenant('t-both', 'Both', 'Groups');
    seedTenant('t-stale', 'Stale', 'Only');
    // send_application threshold is 3d — entered 5 days ago → stuck. Also a due rta_window.
    seedPlacement({
      placementId: 'placement-both',
      tenantId: 't-both',
      stage: 'send_application',
      stage_entered_at: iso(-5 * 86_400_000),
      next_deadline_type: 'rta_window',
      next_deadline_at: iso(-3_600_000), // overdue hard clock
    });
    // A stale placement with NO deadline → follow_ups (derived stuck) only.
    seedPlacement({
      placementId: 'placement-stale',
      tenantId: 't-stale',
      stage: 'send_application',
      stage_entered_at: iso(-5 * 86_400_000),
    });

    const items = await getItems();
    const needsIds = items.filter((i) => i.group === 'needs_you_now').map((i) => i.refId);
    const followIds = items.filter((i) => i.group === 'follow_ups').map((i) => i.refId);

    // placement-both is in needs_you_now (rta hard clock) AND follow_ups (stuck).
    expect(needsIds).toContain('placement-both');
    expect(followIds).toContain('placement-both');
    // placement-stale (no deadline) is ONLY in follow_ups, and NOT in needs_you_now.
    expect(followIds).toContain('placement-stale');
    expect(needsIds).not.toContain('placement-stale');
    // The stuck rows carry the flag-vs-nudge copy.
    const stuckRow = items.find((i) => i.refId === 'placement-stale')!;
    expect(stuckRow.why).toBe('Stuck — needs a check');
  });

  // --- A2: partner_1to1 joins the Unreplied gate (parity with tenant/landlord) ---
  it('a partner_1to1 conversation with unread surfaces in unreplied (A2 parity)', async () => {
    seedConversation({
      conversationId: 'conv-partner',
      participant_phone: '+15550105555',
      participant_display_name: 'Case Worker',
      status: 'open',
      last_activity_at: iso(-70_000),
      type: 'partner_1to1',
      ai_mode: 'auto',
      created_at: iso(-200_000),
      unread_count: 2,
    });

    const items = await getItems();
    const unrep = items.filter((i) => i.group === 'unreplied');
    expect(unrep.map((i) => i.refId)).toContain('conv-partner');
    expect(unrep.find((i) => i.refId === 'conv-partner')).toMatchObject({
      who: 'Case Worker',
      why: 'Unreplied',
    });
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
      why: 'Opted out of a relay group - not receiving messages',
      tag: 'Relay group',
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

  it('surfaces the item when suppression lives ONLY on the member phone 1:1 flag (secondary-number STOP, contact flag never set)', async () => {
    // The STOP arrived from a phone that is the contact's SECONDARY attached
    // number, so the contact flag was never settable (BE1 primary-scope). The
    // member is still silenced via the roster phone's own 1:1 conversation flag -
    // the exact corner this feature closed for sends. Today must honor that same
    // per-phone suppression truth, not the contact flag alone.
    world.contacts.push({
      contactId: 'c-secondary',
      type: 'tenant',
      status: 'active',
      firstName: 'Second',
      lastName: 'Number',
      phone: '+15550107777', // the contact PRIMARY; the roster phone below is secondary
    });
    // The roster phone's own 1:1 thread carries the opt-out flag (what STOP set).
    seedConversation({
      conversationId: 'conv-1to1-secondary',
      participant_phone: '+15550102222',
      status: 'open',
      last_activity_at: iso(-30_000),
      type: 'tenant_1to1',
      ai_mode: 'auto',
      created_at: iso(-60_000),
      sms_opt_out: true,
    } as ConversationItem);
    seedRelayWithOptOut('c-secondary', '+15550102222');

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    const item = needs.find((i) => i.refType === 'contact' && i.refId === 'c-secondary');
    // FAILS before the widened live-confirm: the old contact-flag-only staleness
    // check dropped this member because their contact flag is not set.
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      group: 'needs_you_now',
      refType: 'contact',
      refId: 'c-secondary',
      who: 'Second Number',
      tag: 'Relay group',
      attention: true,
    });
  });

  it('does NOT surface the item when neither the contact flag nor the phone 1:1 is opted out (per-phone auto-resolve)', async () => {
    world.contacts.push({
      contactId: 'c-clean',
      type: 'tenant',
      status: 'active',
      firstName: 'All',
      lastName: 'Clear',
      phone: '+15550108888',
    });
    // A 1:1 exists for the roster phone but is NOT opted out -> not suppressed on
    // either axis, so the stale annotation auto-resolves silently.
    seedConversation({
      conversationId: 'conv-1to1-clean',
      participant_phone: '+15550102222',
      status: 'open',
      last_activity_at: iso(-30_000),
      type: 'tenant_1to1',
      ai_mode: 'auto',
      created_at: iso(-60_000),
    } as ConversationItem);
    seedRelayWithOptOut('c-clean', '+15550102222');

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    expect(needs.some((i) => i.refId === 'c-clean')).toBe(false);
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

  // --- conversation-fact-extraction (T9): ai_suggestions group ------------------
  it('groups pending AI suggestions by contact into an ai_suggestions row (count = distinct contacts, why = n suggestion(s))', async () => {
    seedTenant('t-sug', 'Sug', 'Gest');
    seedTenant('t-one', 'One', 'Only');
    // Two pending suggestions for one contact + one for another.
    await world.extractionRepo.putSuggestion({
      ownerContactId: 't-sug',
      target: 'voucherSize',
      suggestedValue: '3',
      conversationId: 'conv-a',
    });
    await world.extractionRepo.putSuggestion({
      ownerContactId: 't-sug',
      target: 'pets',
      suggestedValue: 'yes',
      conversationId: 'conv-a',
    });
    await world.extractionRepo.putSuggestion({
      ownerContactId: 't-one',
      target: 'status',
      suggestedValue: 'searching',
      conversationId: 'conv-b',
    });

    const items = await getItems();
    const ai = items.filter((i) => i.group === 'ai_suggestions');
    expect(ai).toHaveLength(2); // one row per distinct contact
    const forSug = ai.find((i) => i.refId === 't-sug');
    expect(forSug).toMatchObject({ refType: 'contact', who: 'Sug Gest', why: '2 suggestion(s)' });
    const forOne = ai.find((i) => i.refId === 't-one');
    expect(forOne).toMatchObject({ refType: 'contact', who: 'One Only', why: '1 suggestion(s)' });
  });

  // THE DEFECT THIS PINS (fix wave 5, adversarial 30). Group detection mints a
  // contact for EVERY unseen roster member as (unknown, needs_review) - the
  // exact byTypeStatus partition Today reads as its human triage queue - and
  // group members deliberately get no 1:1 thread, so the conversation-row
  // de-dupe cannot see them. One inbound from a six-person carrier group put
  // five "New unknown contact" rows into needs_you_now in a single shot, and
  // past the hard page cap (whose GSI range key is the STATUS, not a timestamp,
  // so there is no recency ordering) genuinely new unknown contacts became
  // permanently invisible in that block.
  it('EXCLUDES group-detection contact stubs, and still shows a real unknown contact', async () => {
    world.contacts.push({
      contactId: 'c-groupstub',
      type: 'unknown',
      status: 'needs_review',
      phone: '+15551110001',
      origin: 'group_detection',
      group_participation_at: '2026-08-11T12:00:00.000Z',
    } as ContactItem);
    world.contacts.push({
      contactId: 'c-realunknown',
      type: 'unknown',
      status: 'needs_review',
      phone: '+15551110099',
    } as ContactItem);

    const rows = (await getItems()).filter(
      (i) => i.refType === 'contact' && i.why === 'New unknown contact',
    );

    expect(rows.map((r) => r.refId)).toEqual(['c-realunknown']);
  });

  it('a real unknown contact still surfaces behind MORE THAN A PAGE of group stubs', async () => {
    // THE DEFECT (fix wave 2, adversarial 6). Wave 1 filtered the stubs at
    // DISPLAY, but DynamoDB applies `Limit` at the index before anything
    // application-side runs - so 100 rows are drawn from the whole
    // `unknown#needs_review` partition and only then filtered. Every row in that
    // partition carries the identical sort key, so intra-partition order is
    // stable and the SAME 100 come back every time: once enough group stubs sort
    // ahead of the real unknowns, the block rendered ZERO rows, every time,
    // which reads as "nothing needs triage". Wave 1 turned a loud problem into a
    // silent one; the page has to be FILLED past the stubs, not merely cleaned.
    for (let i = 0; i < 120; i += 1) {
      world.contacts.push({
        contactId: `c-stub-${String(i).padStart(3, '0')}`,
        type: 'unknown',
        status: 'needs_review',
        phone: `+1555200${String(i).padStart(4, '0')}`,
        origin: 'group_detection',
        group_participation_at: '2026-08-11T12:00:00.000Z',
      } as ContactItem);
    }
    world.contacts.push({
      contactId: 'c-realunknown-behind',
      type: 'unknown',
      status: 'needs_review',
      phone: '+15551110098',
    } as ContactItem);

    const rows = (await getItems()).filter(
      (i) => i.refType === 'contact' && i.why === 'New unknown contact',
    );

    expect(rows.map((r) => r.refId)).toContain('c-realunknown-behind');
  });

  // THE TWO DEFECTS THESE PIN (fix wave 4, item 7). The fill loop that closed
  // adversarial 6 introduced both of them at its own edges.
  it('never emits MORE than the page cap - the fill loop could return 199 rows', async () => {
    // The loop breaks on `collected.length >= GROUP_FETCH_LIMIT`, so one
    // excluded row in the first page (99 real) followed by a full second page
    // (100 real) put 199 rows in a block every other group on this route caps at
    // 100 - and this block is a human worklist, not a report.
    world.contacts.push({
      contactId: 'c-stub-lead',
      type: 'unknown',
      status: 'needs_review',
      phone: '+15552990000',
      origin: 'group_detection',
    } as ContactItem);
    for (let i = 0; i < 199; i += 1) {
      world.contacts.push({
        contactId: `c-real-${String(i).padStart(3, '0')}`,
        type: 'unknown',
        status: 'needs_review',
        phone: `+1555300${String(i).padStart(4, '0')}`,
      } as ContactItem);
    }

    const rows = (await getItems()).filter(
      (i) => i.refType === 'contact' && i.why === 'New unknown contact',
    );

    expect(rows.length).toBe(100);
  });

  it('WARNS when the page budget runs out with rows still behind it, instead of a silent short block', async () => {
    // Every other truncation on this route is announced. This one was not: a
    // partition holding more excluded rows than the walk's whole budget
    // exhausts it with a short block, and a short block reads as "nothing needs
    // triage" - the loud-problem-turned-silent the fill loop exists to prevent,
    // one layer further out.
    for (let i = 0; i < 1005; i += 1) {
      world.contacts.push({
        contactId: `c-manystub-${String(i).padStart(4, '0')}`,
        type: 'unknown',
        status: 'needs_review',
        phone: `+1555400${String(i).padStart(4, '0')}`,
        origin: 'group_detection',
      } as ContactItem);
    }

    await getItems();

    const warned = harness.capture
      .atLevel(40)
      .filter((l) => String(l['msg'] ?? '').includes('ran out of pages before filling the block'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ group: 'contacts:triage', found: 0 });
  });

  it('the envelope is { items, relayCloseNags, generatedAt } with an ISO generatedAt when items exist', async () => {
    seedTenant('t-env', 'En', 'Velope');
    await seedTour({ tourId: 'tour-env', tenantId: 't-env', scheduledAt: todayNoonIso() });
    const res = await authedGet('/api/today');
    const body = res.body as TodayResponse;
    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'items', 'relayCloseNags']);
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
    expect(body.items.length).toBeGreaterThan(0);
  });

  // --- inbox-unread-index: the unread sections read byUnread, not the open walk --
  // Today's unread half used to ride the SAME hard-capped 100-row open-partition
  // Query the relay opt-out scan rides. Any unread thread ranking past that
  // window was silently missing from Today - a correctness bug, not a cost one.
  // The unread half now drives the sparse byUnread index (newest-activity-first)
  // while the relay opt-out scan stays on the open-partition loop, unchanged.
  describe('unread sections are fed by the byUnread index', () => {
    /** An open, READ 1:1 - fills the open partition without entering the index. */
    const seedReadOpen = (n: number): void => {
      seedConversation({
        conversationId: `conv-read-${String(n).padStart(4, '0')}`,
        participant_phone: `+1555020${String(n).padStart(4, '0')}`,
        status: 'open',
        last_activity_at: iso(-1_000 - n * 1_000),
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 0,
      });
    };

    it('surfaces an unread 1:1 that ranks BEYOND the old 100-row open-partition window', async () => {
      // 130 read threads all sort ahead of the target, so the open-partition
      // Query's first 100 rows never reach it. Before this change that thread
      // was invisible on Today no matter how long it sat unanswered.
      for (let n = 0; n < 130; n += 1) seedReadOpen(n);
      seedConversation({
        conversationId: 'conv-deep-unread',
        participant_phone: '+15550209999',
        participant_display_name: 'Deep Unread',
        status: 'open',
        last_activity_at: iso(-500_000), // oldest of them all -> ~131st
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 2,
      });

      const unrep = (await getItems()).filter((i) => i.group === 'unreplied');

      expect(unrep.map((i) => i.refId)).toEqual(['conv-deep-unread']);
      expect(unrep[0]).toMatchObject({ who: 'Deep Unread', why: 'Unreplied' });
    });

    it('still emits the relay opt-out attention item - that scan stays on the open-partition loop', async () => {
      // The relay thread carries NO unread, so it is structurally absent from
      // the byUnread index. If the opt-out scan had moved to the index pass with
      // the unread half, this item would vanish.
      world.contacts.push({
        contactId: 'c-loopintact',
        type: 'tenant',
        status: 'active',
        firstName: 'Loop',
        lastName: 'Intact',
        phone: '+15550211111',
        sms_opt_out: true,
      });
      seedConversation({
        conversationId: 'conv-relay-loopintact',
        participant_phone: '+15550213333', // synthetic pool number
        status: 'open',
        last_activity_at: iso(-40_000),
        type: 'relay_group',
        ai_mode: 'manual',
        created_at: iso(-200_000),
        participants: [{ contactId: 'c-loopintact', phone: '+15550211111', name: 'Loop Intact' }],
        relay_opted_out_members: {
          'c-loopintact': {
            contactId: 'c-loopintact',
            phone: '+15550211111',
            name: 'Loop Intact',
            at: iso(-20_000),
          },
        },
      } as ConversationItem);
      expect(world.conversations.get('conv-relay-loopintact')?.unread_flag).toBeUndefined();

      const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');

      expect(needs.find((i) => i.refId === 'c-loopintact')).toMatchObject({
        why: 'Opted out of a relay group - not receiving messages',
        tag: 'Relay group',
        attention: true,
      });
    });

    it('caps at 100 kept conversations and WARNS with the unread threshold, not the group-fetch one', async () => {
      for (let n = 0; n < 150; n += 1) {
        seedConversation({
          conversationId: `conv-many-${String(n).padStart(4, '0')}`,
          participant_phone: `+1555022${String(n).padStart(4, '0')}`,
          status: 'open',
          last_activity_at: iso(-1_000 - n * 1_000),
          type: 'tenant_1to1',
          ai_mode: 'auto',
          created_at: iso(-900_000),
          unread_count: 1,
        });
      }

      const unrep = (await getItems()).filter((i) => i.group === 'unreplied');

      expect(unrep).toHaveLength(100);
      const capWarns = harness.capture
        .atLevel(40)
        .filter((l) => l['group'] === 'unread' && String(l['msg'] ?? '').includes('hit the cap'));
      expect(capWarns).toHaveLength(1);
      // The LOGGED count is the unread cap, proving warnIfCapped now takes its
      // threshold as a parameter instead of hardcoding GROUP_FETCH_LIMIT.
      expect(capWarns[0]).toMatchObject({ group: 'unread', count: 100 });
    });

    it('FILTER-THEN-CAP: a burst of unread group threads cannot starve the 1:1 sections', async () => {
      // 120 group_text threads all sort NEWER than the three 1:1s. A
      // cap-then-filter walk would spend all 100 slots on rows Today never
      // shows and emit nothing; filter-then-cap keeps only 1:1-bucket rows.
      for (let n = 0; n < 120; n += 1) {
        seedConversation({
          conversationId: `conv-group-${String(n).padStart(4, '0')}`,
          status: GROUP_TEXT_STATUS,
          last_activity_at: iso(-1_000 - n * 100),
          type: 'group_text',
          ai_mode: 'manual',
          created_at: iso(-900_000),
          participants: [
            { contactId: 'c-g1', phone: '+15550230001' },
            { contactId: 'c-g2', phone: '+15550230002' },
          ],
          unread_count: 4,
        });
      }
      for (const n of [1, 2, 3]) {
        seedConversation({
          conversationId: `conv-oneone-${n}`,
          participant_phone: `+1555024000${n}`,
          participant_display_name: `Solo ${n}`,
          status: 'open',
          last_activity_at: iso(-500_000 - n * 1_000),
          type: 'tenant_1to1',
          ai_mode: 'auto',
          created_at: iso(-900_000),
          unread_count: 1,
        });
      }

      const unrep = (await getItems()).filter((i) => i.group === 'unreplied');

      expect(unrep.map((i) => i.refId).sort()).toEqual([
        'conv-oneone-1',
        'conv-oneone-2',
        'conv-oneone-3',
      ]);
    });

    it('still writes emittedUnknownPhones, so the contacts-triage pass de-dupes the same person', async () => {
      // The unknown-triage branch moved into the second pass; the phone it
      // records is consumed by the LATER contacts-triage pass, so the pass
      // ORDER has to survive the split.
      const phone = '+15550250001';
      seedConversation({
        conversationId: 'conv-unknown-dedupe',
        participant_phone: phone,
        participants: [{ contactId: 'c-unknown-dedupe', phone }],
        status: 'open',
        last_activity_at: iso(-30_000),
        type: 'unknown_1to1',
        ai_mode: 'auto',
        created_at: iso(-60_000),
        unread_count: 1,
      });
      world.contacts.push({
        contactId: 'c-unknown-dedupe',
        type: 'unknown',
        status: 'needs_review',
        phone, // SAME phone - the triage pass must skip it
      });

      const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');

      const forPerson = needs.filter((i) => i.refId === 'c-unknown-dedupe');
      expect(forPerson).toHaveLength(1);
      expect(forPerson[0]).toMatchObject({ refType: 'contact', why: 'New unknown contact' });
    });

    it('WARNS when the scan budget expires before the pass fills, instead of a silent short block', async () => {
      // Budget seam (ApiRouterDeps.unreadWalkLimit): the walk stops after 2 raw
      // rows, so the block is short for a reason the operator cannot otherwise
      // see - neither capped nor exhausted.
      for (let n = 0; n < 5; n += 1) {
        seedConversation({
          conversationId: `conv-budget-${n}`,
          participant_phone: `+1555026000${n}`,
          status: 'open',
          last_activity_at: iso(-1_000 - n * 1_000),
          type: 'tenant_1to1',
          ai_mode: 'auto',
          created_at: iso(-900_000),
          unread_count: 1,
        });
      }
      const budgeted = makeWebhookHarness({ world, unreadWalkLimit: 2 });

      const res = await request(budgeted.app)
        .get('/api/today')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE);

      expect(res.status).toBe(200);
      const unrep = (res.body as TodayResponse).items.filter((i) => i.group === 'unreplied');
      expect(unrep).toHaveLength(2);
      const budgetWarns = budgeted.capture
        .atLevel(40)
        .filter((l) => l['event'] === 'today_unread_walk_truncated');
      expect(budgetWarns).toHaveLength(1);
      expect(budgetWarns[0]).toMatchObject({ scanned: 2, kept: 2, budget: 2 });
    });
  });
});
