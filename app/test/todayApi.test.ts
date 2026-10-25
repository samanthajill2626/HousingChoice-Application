// BE6/C7 — Today action-queue endpoint (GET /api/today → TodayResponse).
// Runs on the shared in-memory world (the harness placements/conversations/contacts
// fakes), authed via the real sealed session cookie next to the origin secret.
//
// Coverage: the groups (needs_you_now / identify / tours_to_book / tours_today /
// follow_ups / ai_suggestions - spec 2026-10-23-today-checklist-design.md; the
// Unreplied group is gone), quiet shares and the section-failure posture,
// urgency thresholds + most-urgent-first ordering, attention -> needs_you_now
// with attention:true, de-dupe across groups (a placement both attention AND
// due appears once), the UTC "today" date basis for tours_today, who/why
// hydration (incl. a missing contact degrading to the id, not a 500), a
// deterministic total order (same seed -> same order), and the empty envelope.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { TERMINAL_STAGES, type PlacementDeadlineType, type PlacementItem } from '../src/repos/placementsRepo.js';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import { PLACEMENT_STAGES } from '../src/lib/statusModel.js';
import { GROUP_TEXT_STATUS, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { unreadFlagFor } from './helpers/unreadIndexFake.js';
import {
  requestedUrgencyOf,
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
    // unread pass is index-fed, and the sparse byUnread index keys on
    // `unread_flag` - an unread fixture with no flag would make the Identify
    // rows from unread unknown threads silently EMPTY. An explicit
    // `unread_flag` on the fixture still wins.
    const item: ConversationItem = { ...unreadFlagFor(conv), ...conv };
    world.conversations.set(item.conversationId, item);
    return item;
  };
  // Today checklist (spec 2026-10-23 4, plan PR26): the unread pass reads ONLY
  // unknown_1to1 threads, so every unread-pass fixture is one. With no contact
  // item for `contactId` the owner is UNRESOLVED and keeps its row (spec 5.2) -
  // the vehicle for cases where the triage pass must not be able to rescue the
  // live row by itself.
  const seedUnknownThread = (o: {
    conversationId: string;
    contactId: string;
    phone: string;
    offset: number;
    displayName?: string;
  }): ConversationItem =>
    seedConversation({
      conversationId: o.conversationId,
      participant_phone: o.phone,
      ...(o.displayName !== undefined && { participant_display_name: o.displayName }),
      participants: [{ contactId: o.contactId, phone: o.phone }],
      status: 'open',
      last_activity_at: iso(o.offset),
      type: 'unknown_1to1',
      ai_mode: 'auto',
      created_at: iso(-900_000),
      unread_count: 1,
    } as ConversationItem);

  // ONE frozen base for every relative instant. This was `Date.now()` PER
  // CALL, which made looped fixtures nondeterministically collide: under
  // full-suite load the wall clock advances DURING the 250-row seeding loop,
  // so `iso(-1_000 - i)` and `iso(-1_001 - (i - 1))` can land on the same
  // millisecond - a last_activity_at TIE in a fixture that paginates across
  // it. The unread fake's tie-resume guard turned that silent hazard (a row
  // set diverging from DynamoDB's, see
  // docs/issues/unread-index-fake-tie-order-is-not-the-services.md) into a
  // loud 500 on its first full-suite run. Frozen, the offsets are the
  // timestamps, and no loop speed can create a tie.
  const isoBase = Date.now();
  const iso = (msFromNow: number): string => new Date(isoBase + msFromNow).toISOString();
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
    /** Default 'unit-1' - a unit no test seeds, so its label is the unitId. */
    unitId?: string;
    /** The harness create stamps now when absent (tours_to_book order/age). */
    createdAt?: string;
  }): Promise<void> => {
    await world.toursRepo.create({
      tourId: t.tourId,
      tenantId: t.tenantId,
      unitId: t.unitId ?? 'unit-1',
      tourType: 'self_guided',
      ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
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
    expect(body.toursToBook).toBe('ok');
    expect(body.quietShares).toEqual({ status: 'ok', properties: [], truncated: false });
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
      // memberNames: prefer name, else the phone in staff-facing display form.
      expect([...nag.memberNames].sort()).toEqual(['Alice', '(555) 010-0202'].sort());
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

  it('groups items into needs_you_now / tours_today / follow_ups with refType/refId and populated who/why; a known contact\'s unread thread is on none of them', async () => {
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
    // A KNOWN contact's unread tenant_1to1 thread: Inbox only since the Today
    // checklist (spec 2026-10-23 4) - it is no Today row.
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

    expect(items.some((i) => i.refId === 'ct-pat' || i.refId === 'conv-unreplied')).toBe(false);
    expect(items.map((i) => i.group)).toEqual(['needs_you_now', 'tours_today', 'follow_ups']);

    const follow = byGroup('follow_ups');
    expect(follow).toHaveLength(1);
    expect(follow[0]).toMatchObject({ refType: 'placement', refId: 'placement-follow', who: 'Sam Lee', why: 'Follow-up due' });
  });

  it('untriaged inbounds (unknown_1to1 unread + unknown/needs_review contact) land in identify, linking to the contact page', async () => {
    // unknown_1to1 conversation with unread -> an identify row linking to the
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
    // Today checklist (spec 2026-10-23 5.2): Identify, split from Needs you now.
    expect(items.filter((i) => i.group === 'needs_you_now')).toEqual([]);
    const needs = items.filter((i) => i.group === 'identify');
    // BOTH untriaged rows link to a contact page (never a dead conversation ref).
    expect(needs.every((i) => i.refType === 'contact')).toBe(true);
    const fromConv = needs.find((i) => i.refId === 'contact-from-conv');
    const fromContact = needs.find((i) => i.refId === 'contact-unknown');
    expect(fromConv).toMatchObject({ who: '(555) 010-9999', attention: true });
    expect(fromContact).toMatchObject({ who: '(555) 010-8888', attention: true });
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
    // Time-less (requested) tours are never Tours today; they are Tours to book
    // (spec 2026-10-23 5.4), a separate group.
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

  it('100 tours today trip NO tours_today cap WARN - the range read pages to completion', async () => {
    // The warning assumed a single-page read, where 100 rows could mean a
    // truncated answer. listByScheduledRange now walks every page (queryAll
    // warns on its own page cap), so a count of 100 is a busy day, not a cut.
    seedTenant('t-busy', 'Busy', 'Day');
    const base = Date.parse(`${todayYmd()}T10:00:00.000Z`);
    for (let i = 0; i < 100; i += 1) {
      await seedTour({
        tourId: `tour-busy-${String(i).padStart(3, '0')}`,
        tenantId: 't-busy',
        // Distinct minutes, 10:00 to 11:39 - inside the UTC-day fallback window.
        scheduledAt: new Date(base + i * 60_000).toISOString(),
      });
    }

    const tours = (await getItems()).filter((i) => i.group === 'tours_today');
    // Not vacuous: all 100 were read and shown.
    expect(tours).toHaveLength(100);
    const warned = harness.capture
      .atLevel(40)
      .filter((l) => String(l['msg'] ?? '').includes('hit the cap') && l['group'] === 'tours_today');
    expect(warned).toEqual([]);
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

  // --- A2, re-pointed by the Today checklist (spec 2026-10-23 4) --------------
  // partner_1to1 joined the Unreplied gate in A2. Unreplied is gone: a known
  // contact's unread thread - tenant, landlord or partner - feeds only the
  // Inbox (and its badge) and emits NO Today row.
  it('a partner_1to1 conversation with unread emits NO Today row (Inbox only)', async () => {
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
    expect(items.some((i) => i.refId === 'conv-partner')).toBe(false);
    expect(items).toEqual([]);
  });

  // --- ADVERSARIAL NEW-3: one contact, several unread threads, ONE row ---------
  // contactThreads.ts models exactly one conversation PER PARTICIPANT KEY, so a
  // person with a phone thread and an email thread reaches the unread pass
  // TWICE. Both emitted a row with the same refType/refId. (Re-expressed by the
  // Today checklist on an UNKNOWN contact's two threads - the only threads the
  // unread pass reads now - so the row is an identify row.)
  it('an unknown contact with an unread PHONE thread AND an unread EMAIL thread yields exactly ONE identify row', async () => {
    // No name on the contact, so `who` shows which thread represented the pair.
    world.contacts.push({ contactId: 'c-dupe', type: 'unknown', status: 'needs_review', phone: '+15550108888' });
    seedConversation({
      conversationId: 'conv-dupe-phone',
      participant_phone: '+15550108888',
      participant_display_name: 'Dee Dupe',
      status: 'open',
      last_activity_at: iso(-50_000),
      type: 'unknown_1to1',
      ai_mode: 'auto',
      created_at: iso(-200_000),
      unread_count: 1,
      participants: [{ contactId: 'c-dupe', phone: '+15550108888' }],
    } as ConversationItem);
    seedConversation({
      conversationId: 'conv-dupe-email',
      participant_email: 'dee@example.test',
      status: 'open',
      last_activity_at: iso(-60_000),
      type: 'unknown_1to1',
      ai_mode: 'auto',
      created_at: iso(-200_000),
      unread_count: 1,
      participants: [{ contactId: 'c-dupe', phone: '+15550108888' }],
    } as ConversationItem);

    const ident = (await getItems()).filter((i) => i.group === 'identify');

    expect(ident.filter((i) => i.refId === 'c-dupe')).toHaveLength(1);
    // The actual breakage: Today.tsx renders key={`${refType}:${refId}`} inside
    // ONE <ul> per group, so two rows for one contact are duplicate React keys.
    const keys = ident.map((i) => `${i.refType}:${i.refId}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Newest-activity-first, so the PHONE thread is the representative - which
    // is also why the surviving row carries a name rather than the email
    // thread's blank `who`.
    expect(ident.find((i) => i.refId === 'c-dupe')?.who).toBe('Dee Dupe');
  });

  // Fix wave 1 (FW1-2; code review R1A-1). The triage pass de-duped by PHONE
  // only, fed by the unread pass's kept thread - so when that thread is an
  // EMAIL thread (no participant_phone: it is the newest, or the only one) it
  // recorded nothing and the triage pass emitted the SAME contact again: two
  // rows under one React key, and "Show all N" counting the person twice. The
  // triage pass now also skips a contactId the unread pass emitted (spec 5.2:
  // one row per person). Email threads carry `phone: ''` in their roster, as
  // conversationsRepo.createOrGetByParticipantEmail writes it.
  it('an unknown contact whose NEWEST unread thread is its email thread is listed once', async () => {
    world.contacts.push({ contactId: 'c-dupe', type: 'unknown', status: 'needs_review', phone: '+15550108888' });
    seedConversation({
      conversationId: 'conv-dupe-phone',
      participant_phone: '+15550108888',
      participant_display_name: 'Dee Dupe',
      status: 'open',
      last_activity_at: iso(-60_000),
      type: 'unknown_1to1',
      ai_mode: 'auto',
      created_at: iso(-200_000),
      unread_count: 1,
      participants: [{ contactId: 'c-dupe', phone: '+15550108888' }],
    } as ConversationItem);
    seedConversation({
      conversationId: 'conv-dupe-email',
      participant_email: 'dee@example.test',
      status: 'open',
      last_activity_at: iso(-50_000), // NEWER than the phone thread
      type: 'unknown_1to1',
      ai_mode: 'auto',
      created_at: iso(-200_000),
      unread_count: 1,
      participants: [{ contactId: 'c-dupe', phone: '' }],
    } as ConversationItem);

    const ident = (await getItems()).filter((i) => i.group === 'identify');

    expect(ident.map((i) => `${i.refType}:${i.refId}`)).toEqual(['contact:c-dupe']);
  });

  it('an unknown contact with ONLY an unread email thread is listed once', async () => {
    world.contacts.push({ contactId: 'c-mail', type: 'unknown', status: 'needs_review', email: 'mae@example.test' });
    seedConversation({
      conversationId: 'conv-mail',
      participant_email: 'mae@example.test',
      status: 'open',
      last_activity_at: iso(-50_000),
      type: 'unknown_1to1',
      ai_mode: 'auto',
      created_at: iso(-200_000),
      unread_count: 1,
      participants: [{ contactId: 'c-mail', phone: '' }],
    } as ConversationItem);

    const ident = (await getItems()).filter((i) => i.group === 'identify');

    expect(ident.map((i) => `${i.refType}:${i.refId}`)).toEqual(['contact:c-mail']);
  });

  it('a duplicate thread does NOT consume one of the TODAY_UNREAD_CAP slots', async () => {
    // The cap is 100. Seed 99 single-thread contacts plus ONE contact owning two
    // unread threads: 101 index rows, 100 distinct people. Deduping only at emit
    // time would collect the duplicate into the cap and starve the oldest real
    // contact, leaving 99 rows - so this pins that the dedupe runs BEFORE the
    // cap is counted.
    // Unresolved owners (no contact items, spec 5.2): the triage pass adds
    // nothing, so every row below is the unread pass's own.
    for (let i = 0; i < 99; i += 1) {
      const id = `c-bulk-${String(i).padStart(3, '0')}`;
      seedUnknownThread({
        conversationId: `conv-bulk-${String(i).padStart(3, '0')}`,
        contactId: id,
        phone: `+1555020${String(i).padStart(4, '0')}`,
        displayName: `Bulk ${id}`,
        // Older than the duplicate pair below, so the pair is scanned first and
        // the starved contact is one of these.
        offset: -200_000 - i * 1_000,
      });
    }
    for (const [suffix, offset] of [
      ['phone', -10_000],
      ['email', -20_000],
    ] as const) {
      seedUnknownThread({
        conversationId: `conv-twin-${suffix}`,
        contactId: 'c-twin',
        phone: '+15550209999',
        displayName: 'Twin Threads',
        offset,
      });
    }

    const ident = (await getItems()).filter((i) => i.group === 'identify');
    const ids = ident.map((i) => i.refId);

    expect(new Set(ids).size).toBe(ids.length); // no duplicate React keys
    expect(ids).toHaveLength(100); // every distinct person fits
    expect(ids).toContain('c-twin');
    // The OLDEST real contact is the one a wasted slot would have pushed off.
    expect(ids).toContain('c-bulk-098');
  });

  it('a DELETED contact does NOT consume one of the TODAY_UNREAD_CAP slots', async () => {
    // ADVERSARIAL A9. The deleted-contact test used to run in the EMIT loop,
    // after the cap had already been spent - the same mistake the collect
    // loop's own comment argues against for group threads. It got worse with
    // the index source: the newest 100 UNREAD rows is exactly where resurfaced
    // deleted contacts live by construction (the product rule keeps them unread
    // indefinitely until someone reads them), where the newest 100 OPEN rows
    // held only a small fraction. A hundred of them at the head of the index
    // rendered the unread-fed block EMPTY, with warnIfCapped reporting
    // "capped" rather than "filtered to nothing". (Re-expressed by the Today
    // checklist on unknown_1to1 threads; the live owner is UNRESOLVED so only
    // the unread pass - never the triage pass - can deliver its row.)
    for (let i = 0; i < 100; i += 1) {
      const id = `c-gone-${String(i).padStart(3, '0')}`;
      const phone = `+1555030${String(i).padStart(4, '0')}`;
      world.contacts.push({ contactId: id, type: 'unknown', status: 'needs_review', phone, deleted_at: iso(-500_000) });
      // NEWEST, so they are scanned first and would fill the cap.
      seedUnknownThread({
        conversationId: `conv-gone-${String(i).padStart(3, '0')}`,
        contactId: id,
        phone,
        displayName: `Gone ${id}`,
        offset: -1_000 - i,
      });
    }
    seedUnknownThread({
      conversationId: 'conv-behind',
      contactId: 'c-behind',
      phone: '+15550309999',
      displayName: 'Behind Wall',
      offset: -400_000,
    });

    const ident = (await getItems()).filter((i) => i.group === 'identify');
    const ids = ident.map((i) => i.refId);

    // The live person behind the wall is reachable, and no deleted contact is
    // on the board.
    expect(ids).toEqual(['c-behind']);
  });

  it('applies the deleted-contact rule to EVERY walked item: 250 deleted ahead of 5 live shows exactly the 5', async () => {
    // ADVERSARIAL r3 FINDING 5 (fix wave 3). Fix wave 2 BROKE the pass past the
    // bound, which is the same "stop the walk" decision both reviewers called
    // BLOCKING for the inbox in round 2 - applied to the one surface with no
    // cursor, no `truncated` on the wire and no Load more, so there is no
    // forward path at all: every live unread thread behind the wall simply
    // vanishes from Unreplied and the untriaged block, permanently, with only a
    // server log line to say why.
    //
    // The bound now limits the LOOKUPS, not the walk: past it a 1:1 item is
    // treated as non-deleted (the declared cost - a deleted contact past the
    // bound can render) and the existing TODAY_UNREAD_CAP ends the pass.
    // (Re-expressed by the Today checklist on unknown_1to1 threads; the live
    // owners are UNRESOLVED so only the unread pass can deliver their rows.)
    for (let i = 0; i < 250; i += 1) {
      const id = `c-deep-${String(i).padStart(3, '0')}`;
      const phone = `+1555032${String(i).padStart(4, '0')}`;
      world.contacts.push({ contactId: id, type: 'unknown', status: 'needs_review', phone, deleted_at: iso(-500_000) });
      seedUnknownThread({
        conversationId: `conv-deep-${String(i).padStart(3, '0')}`,
        contactId: id,
        phone,
        displayName: `Deep ${id}`,
        offset: -1_000 - i,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      seedUnknownThread({
        conversationId: `conv-alive-${i}`,
        contactId: `c-alive-${i}`,
        phone: `+1555033${String(i).padStart(4, '0')}`,
        displayName: `Alive ${i}`,
        offset: -400_000 - i,
      });
    }

    const ids = (await getItems()).filter((i) => i.group === 'identify').map((i) => i.refId);

    // The live work the block exists to show is on the board.
    for (let i = 0; i < 5; i += 1) expect(ids).toContain(`c-alive-${i}`);
    // AND NO DELETED CONTACT LEAKS ONTO IT (adversarial r4 finding 1): the rule
    // is applied to every 1:1 item walked, not to a bounded prefix. At 250
    // deleted ahead of 5 live the old lookup bound rendered a FULL block of
    // deleted contacts and zero live work - the board inverted.
    expect(ids).toHaveLength(5);
    for (const id of ids) expect(id).toMatch(/^c-alive-/);
  });

  it('has NO deleted-contact lookup bound: 101 deleted ahead of 1 live shows exactly the 1, and announces the skips', async () => {
    // ADVERSARIAL r2 finding 6 / CONFORMANCE r2 finding 6. Moving the
    // deleted-contact test ahead of the cap is right, but it made the check run
    // on every 1:1 item the walk yields - bounded only by UNREAD_WALK_LIMIT
    // (2000) - and `getContact` memoizes PER CONTACT ID, so distinct contacts
    // each cost a real contacts.getById. The comment beside it claimed the move
    // "costs no extra read". On an index head thick with deleted residue - the
    // exact condition the fix exists for - /api/today could issue up to 2000
    // sequential contact Gets, on a route every connected dashboard refetches.
    //
    // 101 DISTINCT deleted contacts: one past the bound. The LOOKUPS stop
    // there (fix wave 3, adversarial r3 finding 5) - the walk does not - so the
    // 101st deleted contact is treated as non-deleted and can render, while the
    // live row behind the wall is still delivered. The WARN is what says the
    // rule went unenforced past that point.
    // (Re-expressed by the Today checklist on unknown_1to1 threads; the live
    // owner is UNRESOLVED so only the unread pass can deliver its row.)
    for (let i = 0; i < 101; i += 1) {
      const id = `c-wall-${String(i).padStart(3, '0')}`;
      const phone = `+1555031${String(i).padStart(4, '0')}`;
      world.contacts.push({ contactId: id, type: 'unknown', status: 'needs_review', phone, deleted_at: iso(-500_000) });
      seedUnknownThread({
        conversationId: `conv-wall-${String(i).padStart(3, '0')}`,
        contactId: id,
        phone,
        displayName: `Wall ${id}`,
        offset: -1_000 - i,
      });
    }
    seedUnknownThread({
      conversationId: 'conv-past-bound',
      contactId: 'c-past-bound',
      phone: '+15550319999',
      displayName: 'Past Bound',
      offset: -400_000,
    });

    const unrep = (await getItems()).filter((i) => i.group === 'identify');

    // The live row behind the wall IS shown, and NOTHING ELSE: there is no
    // lookup bound any more (adversarial r4 finding 1 showed every threshold
    // either hid live work or leaked deleted rows). The rule is applied to every
    // walked 1:1 item; the cost is one memoized getById per DISTINCT contact,
    // bounded by the walk budget - the same O(scanned) the badge pays, watched
    // by the scanned WARN, and remedied by the BatchGet follow-up.
    expect(unrep.map((i) => i.refId)).toEqual(['c-past-bound']);
    // The skip count is still announced under its own label so the operator can
    // tell "filtered by deleted residue" from "genuinely capped".
    const skipWarns = harness.capture
      .atLevel(40)
      .filter((l) => l['group'] === 'unread:deleted_skips');
    expect(skipWarns).toHaveLength(1);
  });

  // --- unknown-inactive D5 (AR8), as narrowed by the Today checklist ---------
  // (spec 2026-10-23 5.2, plan PR26): an unknown_1to1 thread emits an Identify
  // row only when its owner is a type-unknown contact that is not Inactive. An
  // Inactive unknown "just shows in the inbox" (Cameron 2026-10-23); a team
  // member's, tenant's or caseworker's thread - Active or not - emits NO Today
  // row (PR40 inverts the #30 pins that kept them); the owner test runs ahead
  // of the cap.
  describe('unknown-inactive D5: an Inactive contact\'s unknown_1to1 thread', () => {
    const unknownThread = (conversationId: string, contactId: string, phone: string, offset: number): ConversationItem =>
      seedConversation({
        conversationId,
        participant_phone: phone,
        participants: [{ contactId, phone }],
        status: 'open',
        last_activity_at: iso(offset),
        type: 'unknown_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 1,
      } as ConversationItem);
    const newUnknownRefIds = (items: TodayItem[]): string[] =>
      items
        .filter((i) => i.group === 'identify' && i.why === 'New unknown contact')
        .map((i) => i.refId)
        .sort();

    it('RED: an unread thread from an INACTIVE unknown contact is NOT an identify row (nor anywhere on Today)', async () => {
      world.contacts.push({ contactId: 'c-unk-off', type: 'unknown', status: 'inactive', phone: '+15550360001' });
      unknownThread('conv-unk-off', 'c-unk-off', '+15550360001', -30_000);

      const items = await getItems();
      expect(newUnknownRefIds(items)).toEqual([]);
      expect(items.map((i) => i.refId)).not.toContain('c-unk-off');
    });

    it('PIN: an unread thread from a NEEDS REVIEW unknown contact is in identify, once', async () => {
      world.contacts.push({ contactId: 'c-unk-nr', type: 'unknown', status: 'needs_review', phone: '+15550360002' });
      unknownThread('conv-unk-nr', 'c-unk-nr', '+15550360002', -30_000);

      const items = await getItems();
      expect(newUnknownRefIds(items)).toEqual(['c-unk-nr']);
    });

    // INVERTED by the Today checklist (spec 2026-10-23 5.2, plan PR40): this
    // pinned the #30 rule that an Active team member's unknown_1to1 thread
    // kept its row. Identify lists only type-unknown contacts, so the thread
    // emits NO Today row; it stays in the Inbox.
    it('an unread unknown_1to1 thread from an ACTIVE team member emits NO Today row (Inbox only)', async () => {
      world.contacts.push({ contactId: 'c-team-on', type: 'team_member', status: 'active', firstName: 'Tea', lastName: 'Mate', phone: '+15550360003' });
      unknownThread('conv-team-on', 'c-team-on', '+15550360003', -30_000);

      const items = await getItems();
      expect(newUnknownRefIds(items)).toEqual([]);
      expect(items.map((i) => i.refId)).not.toContain('c-team-on');
    });

    // OR-6 (build worklist): an Inactive team member's unknown_1to1 thread
    // emits no row (spec D5 "skip Inactive", Goal 4: Inactive means the same
    // thing for every type). Still true under the Today checklist's owner
    // rule (spec 2026-10-23 5.2), which drops a team member's thread whatever
    // its status.
    it('RED: an unread unknown_1to1 thread from an INACTIVE team member is NOT an identify row', async () => {
      world.contacts.push({ contactId: 'c-team-off', type: 'team_member', status: 'inactive', firstName: 'Tea', lastName: 'Gone', phone: '+15550360005' });
      unknownThread('conv-team-off', 'c-team-off', '+15550360005', -30_000);

      const items = await getItems();
      expect(newUnknownRefIds(items)).toEqual([]);
    });

    // Re-pointed by the Today checklist (spec 2026-10-23 4): Unreplied is gone,
    // so a tenant's typed thread - Inactive or not - is Inbox only.
    it('an INACTIVE TENANT\'s unread tenant_1to1 thread emits NO Today row (the Inbox has it)', async () => {
      world.contacts.push({ contactId: 'c-ten-off', type: 'tenant', status: 'inactive', firstName: 'Ina', lastName: 'Tenant', phone: '+15550360004' });
      seedConversation({
        conversationId: 'conv-ten-off',
        participant_phone: '+15550360004',
        participant_display_name: 'Ina Tenant',
        participants: [{ contactId: 'c-ten-off', phone: '+15550360004' }],
        status: 'open',
        last_activity_at: iso(-30_000),
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 1,
      } as ConversationItem);

      const items = await getItems();
      expect(items).toEqual([]);
    });

    it('RED: more than TODAY_UNREAD_CAP Inactive unknown threads ahead of live work do not hide it (the owner test runs BEFORE the cap)', async () => {
      // 101 Inactive unknown threads, all NEWER than the live rows, so without
      // a collect-loop owner test they spend all 100 slots. Behind them: an
      // unknown_1to1 thread whose owner cannot be resolved (no contact item) -
      // it has no second source, so the cap would hide it - and a Needs review
      // unknown (PIN only: the contacts-triage pass would rescue it by itself).
      // INVERTED (plan PR40): the Active team member's thread and the tenant's
      // thread behind them were the no-second-source rows under #30; neither is
      // a Today row any more.
      for (let i = 0; i < 101; i += 1) {
        const id = `c-off-${String(i).padStart(3, '0')}`;
        const phone = `+1555034${String(i).padStart(4, '0')}`;
        world.contacts.push({ contactId: id, type: 'unknown', status: 'inactive', phone });
        unknownThread(`conv-off-${String(i).padStart(3, '0')}`, id, phone, -1_000 - i);
      }
      unknownThread('conv-live-unres', 'c-live-unres', '+15550359004', -400_000);
      world.contacts.push({ contactId: 'c-live-team', type: 'team_member', status: 'active', firstName: 'Live', lastName: 'Team', phone: '+15550359001' });
      unknownThread('conv-live-team', 'c-live-team', '+15550359001', -400_001);
      world.contacts.push({ contactId: 'c-live-nr', type: 'unknown', status: 'needs_review', phone: '+15550359002' });
      unknownThread('conv-live-nr', 'c-live-nr', '+15550359002', -400_002);
      seedTenant('c-live-ten', 'Live', 'Tenant');
      seedConversation({
        conversationId: 'conv-live-ten',
        participant_phone: '+15550359003',
        participant_display_name: 'Live Tenant',
        participants: [{ contactId: 'c-live-ten', phone: '+15550359003' }],
        status: 'open',
        last_activity_at: iso(-400_003),
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 1,
      } as ConversationItem);

      const items = await getItems();
      expect(newUnknownRefIds(items)).toEqual(['c-live-nr', 'c-live-unres']);
      const refIds = items.map((i) => i.refId);
      expect(refIds).not.toContain('c-live-team');
      expect(refIds).not.toContain('c-live-ten');
    });

    // FW2-1 (code review R2-1), INVERTED by the Today checklist (spec
    // 2026-10-23 5.2, plan PR40). The contacts PATCH re-types only the primary
    // phone's and the email threads (routes/contacts.ts, the linked-thread
    // gather), so a tenant's or caseworker's SECOND number can keep an
    // unknown_1to1 thread. #30 kept that thread's "New unknown contact" row;
    // Identify now lists only type-unknown owners, so it emits NO Today row,
    // Active or Inactive - the Inbox still shows the unread text.
    const authedPatch = (path: string, body: object) =>
      request(app).patch(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);

    it('a re-typed TENANT\'s unread unknown_1to1 thread (a second number triage never re-typed) emits NO Today row, before or after Inactive', async () => {
      // The reviewer's probe flow, through the real routes: an unknown contact
      // with two numbers and a thread on each, the SECOND one unread.
      world.contacts.push({
        contactId: 'c-two',
        type: 'unknown',
        status: 'needs_review',
        phone: '+15550360101',
        phones: [
          { phone: '+15550360101', primary: true },
          { phone: '+15550360102', primary: false },
        ],
      });
      seedConversation({
        conversationId: 'conv-p1',
        participant_phone: '+15550360101',
        participants: [{ contactId: 'c-two', phone: '+15550360101' }],
        status: 'open',
        last_activity_at: iso(-60_000),
        type: 'unknown_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 0,
      } as ConversationItem);
      unknownThread('conv-p2', 'c-two', '+15550360102', -30_000);

      expect((await authedPatch('/api/contacts/c-two', { type: 'tenant' })).status).toBe(200);
      expect(world.conversations.get('conv-p1')?.type).toBe('tenant_1to1');
      expect(world.conversations.get('conv-p2')?.type).toBe('unknown_1to1');
      const before = (await getItems()).filter((i) => i.refId === 'c-two');
      expect(before).toEqual([]);

      const toInactive = await authedPatch('/api/contacts/c-two/tenant-status', {
        toStatus: 'inactive',
        source: 'manual',
        expectedType: 'tenant',
      });
      expect(toInactive.status).toBe(200);
      expect((await world.contactsRepo.getById('c-two'))?.status).toBe('inactive');

      // The status write changes nothing on Today for this thread either.
      const after = (await getItems()).filter((i) => i.refId === 'c-two');
      expect(after).toEqual([]);
    });

    // INVERTED by the Today checklist (spec 2026-10-23 5.2, plan PR40): a
    // caseworker's leftover unknown_1to1 thread emits NO Today row.
    it('an INACTIVE CASEWORKER\'s unread unknown_1to1 thread emits NO Today row (Identify is type-unknown owners only)', async () => {
      world.contacts.push({ contactId: 'c-cw-off', type: 'partner', status: 'inactive', firstName: 'Casey', lastName: 'Worker', phone: '+15550360201' });
      unknownThread('conv-cw-off', 'c-cw-off', '+15550360202', -30_000);

      const items = await getItems();
      expect(items).toEqual([]);
    });
  });

  // --- FIX B: relay_group threads never surface on Today ----------------------
  // (Re-pointed by the Today checklist, spec 2026-10-23 4: the tenant_1to1
  // control is Inbox only now too, so the page is empty.)
  it('a relay_group conversation with unread emits NO Today row (nor does a known tenant_1to1 - Inbox only)', async () => {
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
    expect(items.some((i) => i.refId === 'conv-relay')).toBe(false);
    expect(items.some((i) => i.refId === 'conv-tenant')).toBe(false);
    expect(items).toEqual([]);
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
      // What setRelayMemberOptedOut stamps in the same write: the row's ticket
      // into the sparse byRelayOptOut index Today reads (2026-08-18).
      relay_optout_flag: 'attention',
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

  it('formats a phone-only opted-out relay member for staff display', async () => {
    const memberContactId = 'c-optout-phone-only';
    const memberPhone = '+15550102222';
    world.contacts.push({
      contactId: memberContactId,
      type: 'tenant',
      status: 'active',
      phone: memberPhone,
      sms_opt_out: true,
    });
    seedConversation({
      conversationId: 'conv-relay-optout-phone-only',
      participant_phone: '+15550103333',
      status: 'open',
      last_activity_at: iso(-40_000),
      type: 'relay_group',
      ai_mode: 'manual',
      created_at: iso(-200_000),
      participants: [{ contactId: memberContactId, phone: memberPhone }],
      relay_opted_out_members: {
        // Legacy/stale annotations may omit their optional phone even though the
        // hydrated contact still has one.
        [memberContactId]: { contactId: memberContactId, at: iso(-20_000) },
      },
      relay_optout_flag: 'attention',
    } as ConversationItem);

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    const item = needs.find((i) => i.refType === 'contact' && i.refId === memberContactId);
    expect(item).toMatchObject({
      who: '(555) 010-2222',
      why: 'Opted out of a relay group - not receiving messages',
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
      relay_optout_flag: 'attention',
    } as ConversationItem);

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
    expect(needs.some((i) => i.refId === 'c-del')).toBe(false);
    expect(needs.some((i) => i.refId === 'phone#+15550100000')).toBe(false);
  });

  // Fix wave 1 (FW1-2; code review R1A-1): ONE row per opted-out member. A
  // member opted out of two open relay groups emitted a row per group - the
  // same contact twice in Needs you now under one React key, counted twice by
  // "Show all N" (the row is pre-existing on main; the 5-row list made it
  // visible). The pass now emits at most one row per member contactId.
  it('a member opted out of TWO open relay groups is listed once', async () => {
    world.contacts.push({
      contactId: 'c-opt',
      type: 'tenant',
      status: 'active',
      firstName: 'Opted',
      lastName: 'Twice',
      phone: '+15550102222',
      sms_opt_out: true,
    });
    for (const [conversationId, pool, offset] of [
      ['conv-relay-opt-a', '+15550103331', -40_000],
      ['conv-relay-opt-b', '+15550103332', -30_000],
    ] as const) {
      seedConversation({
        conversationId,
        participant_phone: pool, // synthetic pool number
        status: 'open',
        last_activity_at: iso(offset),
        type: 'relay_group',
        ai_mode: 'manual',
        created_at: iso(-200_000),
        participants: [{ contactId: 'c-opt', phone: '+15550102222', name: 'Opted Member' }],
        relay_opted_out_members: {
          'c-opt': { contactId: 'c-opt', phone: '+15550102222', name: 'Opted Member', at: iso(-20_000) },
        },
        relay_optout_flag: 'attention',
      } as ConversationItem);
    }

    const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');

    expect(needs.map((i) => `${i.refType}:${i.refId}`)).toEqual(['contact:c-opt']);
  });

  // THE DEFECT THESE PIN (prod, 2026-08-17/18: 233 WARNs in 24h). This pass
  // rode the byLastActivity `open` read, hard-capped at 100 rows, from the days
  // it also fed the unread items; once prod held 649 open threads it truncated
  // and WARNed on EVERY Today load to find the ~1 relay group that mattered.
  // It now reads the sparse byRelayOptOut index, which holds exactly the relay
  // groups whose opt-out map is non-empty.
  describe('the relay opt-out attention pass reads the sparse byRelayOptOut index (2026-08-18)', () => {
    it('does NOT touch the open partition, so 649 open 1:1 threads cost nothing and trip no cap WARN', async () => {
      for (let n = 0; n < 150; n += 1) {
        seedConversation({
          conversationId: `conv-open-${String(n).padStart(4, '0')}`,
          participant_phone: `+1555030${String(n).padStart(4, '0')}`,
          status: 'open',
          last_activity_at: iso(-1_000 - n * 1_000),
          type: 'tenant_1to1',
          ai_mode: 'manual',
          created_at: iso(-200_000),
        } as ConversationItem);
      }
      world.contacts.push({
        contactId: 'c-optout-idx',
        type: 'tenant',
        status: 'active',
        firstName: 'Opted',
        lastName: 'Indexed',
        phone: '+15550102222',
        sms_opt_out: true,
      });
      seedRelayWithOptOut('c-optout-idx', '+15550102222');

      const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
      expect(needs.some((i) => i.refType === 'contact' && i.refId === 'c-optout-idx')).toBe(true);
      // The old read logged group=conversations at the cap on every load with a
      // partition this size; the index read has nothing to truncate.
      const capWarns = harness.capture
        .atLevel(40)
        .filter((l) => String(l['msg'] ?? '').includes('hit the cap'));
      expect(capWarns.filter((l) => l['group'] === 'conversations')).toEqual([]);
      expect(capWarns.filter((l) => l['group'] === 'relay_optout')).toEqual([]);
    });

    it('a relay group whose map is non-empty but that carries NO flag (pre-backfill row) is invisible - the backfill is required', async () => {
      world.contacts.push({
        contactId: 'c-legacy',
        type: 'tenant',
        status: 'active',
        firstName: 'Legacy',
        lastName: 'Row',
        phone: '+15550102223',
        sms_opt_out: true,
      });
      seedConversation({
        conversationId: 'conv-relay-legacy',
        participant_phone: '+15550103334',
        status: 'open',
        last_activity_at: iso(-40_000),
        type: 'relay_group',
        ai_mode: 'manual',
        created_at: iso(-200_000),
        participants: [{ contactId: 'c-legacy', phone: '+15550102223', name: 'Legacy Row' }],
        relay_opted_out_members: {
          'c-legacy': { contactId: 'c-legacy', phone: '+15550102223', name: 'Legacy Row', at: iso(-20_000) },
        },
        // No relay_optout_flag: written by a build before the index existed.
      } as ConversationItem);

      const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
      expect(needs.some((i) => i.refId === 'c-legacy')).toBe(false);
    });

    it('a CLOSED relay group is off the index (the close write drops the flag) - even if the fake still shows it, the pass skips it', async () => {
      world.contacts.push({
        contactId: 'c-closedgrp',
        type: 'tenant',
        status: 'active',
        firstName: 'Closed',
        lastName: 'Group',
        phone: '+15550102224',
        sms_opt_out: true,
      });
      seedConversation({
        conversationId: 'conv-relay-closed-optout',
        participant_phone: '+15550103335',
        status: 'closed',
        last_activity_at: iso(-40_000),
        type: 'relay_group',
        ai_mode: 'manual',
        created_at: iso(-200_000),
        participants: [{ contactId: 'c-closedgrp', phone: '+15550102224' }],
        relay_opted_out_members: {
          'c-closedgrp': { contactId: 'c-closedgrp', phone: '+15550102224', at: iso(-20_000) },
        },
        relay_optout_flag: 'attention', // a lost race left it; the reader tolerates it
      } as ConversationItem);

      const needs = (await getItems()).filter((i) => i.group === 'needs_you_now');
      expect(needs.some((i) => i.refId === 'c-closedgrp')).toBe(false);
    });

    it('a FULL page of attention rows is the tripwire: WARNs with group=relay_optout at the cap', async () => {
      for (let n = 0; n < 100; n += 1) {
        const cid = `c-many-${String(n).padStart(3, '0')}`;
        world.contacts.push({ contactId: cid, type: 'tenant', status: 'active', firstName: 'M', lastName: String(n), phone: `+1555040${String(n).padStart(4, '0')}`, sms_opt_out: true });
        seedConversation({
          conversationId: `conv-relay-many-${String(n).padStart(3, '0')}`,
          participant_phone: `+1555041${String(n).padStart(4, '0')}`,
          status: 'open',
          last_activity_at: iso(-1_000 - n * 1_000),
          type: 'relay_group',
          ai_mode: 'manual',
          created_at: iso(-200_000),
          participants: [{ contactId: cid, phone: `+1555040${String(n).padStart(4, '0')}` }],
          relay_opted_out_members: { [cid]: { contactId: cid, at: iso(-20_000) } },
          relay_optout_flag: 'attention',
        } as ConversationItem);
      }
      await getItems();
      const warned = harness.capture
        .atLevel(40)
        .filter((l) => l['group'] === 'relay_optout' && String(l['msg'] ?? '').includes('hit the cap'));
      expect(warned).toHaveLength(1);
      expect(warned[0]!['count']).toBe(100);
    });
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
  it('an unknown inbound (unknown_1to1 unread + needs_review contact, same phone) yields ONE identify item linking to the contact', async () => {
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

    const needs = (await getItems()).filter((i) => i.group === 'identify');
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

    const needs = (await getItems()).filter((i) => i.group === 'identify');
    const contact = needs.find((i) => i.refType === 'contact' && i.refId === 'contact-only');
    expect(contact).toMatchObject({
      refId: 'contact-only',
      who: '(555) 010-4444',
      attention: true,
    });
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

  it('formats a phone-only AI-suggestion contact instead of exposing its id', async () => {
    const contactId = 't-sug-phone-only';
    world.contacts.push({
      contactId,
      type: 'tenant',
      status: 'active',
      phone: '+15550105555',
    });
    await world.extractionRepo.putSuggestion({
      ownerContactId: contactId,
      target: 'voucherSize',
      suggestedValue: '2',
      conversationId: 'conv-phone-only',
    });

    const items = await getItems();
    const suggestion = items.find(
      (item) => item.group === 'ai_suggestions' && item.refId === contactId,
    );

    expect(suggestion).toMatchObject({
      refType: 'contact',
      who: '(555) 010-5555',
      why: '1 suggestion(s)',
    });
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

  it('the envelope is { items, relayCloseNags, quietShares, toursToBook, generatedAt } with an ISO generatedAt when items exist', async () => {
    seedTenant('t-env', 'En', 'Velope');
    await seedTour({ tourId: 'tour-env', tenantId: 't-env', scheduledAt: todayNoonIso() });
    const res = await authedGet('/api/today');
    const body = res.body as TodayResponse;
    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'items', 'quietShares', 'relayCloseNags', 'toursToBook']);
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
      // The target is an unknown thread (the only kind the pass reads now) with
      // an unresolved owner, so only the unread pass can deliver it.
      seedUnknownThread({
        conversationId: 'conv-deep-unread',
        contactId: 'c-deep-unread',
        phone: '+15550209999',
        displayName: 'Deep Unread',
        offset: -500_000, // oldest of them all -> ~131st
      });

      const ident = (await getItems()).filter((i) => i.group === 'identify');

      expect(ident.map((i) => i.refId)).toEqual(['c-deep-unread']);
      expect(ident[0]).toMatchObject({ who: 'Deep Unread', why: 'New unknown contact' });
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
        relay_optout_flag: 'attention',
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
        // Unresolved owners: the triage pass adds nothing to the count.
        seedUnknownThread({
          conversationId: `conv-many-${String(n).padStart(4, '0')}`,
          contactId: `c-many-${String(n).padStart(4, '0')}`,
          phone: `+1555022${String(n).padStart(4, '0')}`,
          offset: -1_000 - n * 1_000,
        });
      }

      const unrep = (await getItems()).filter((i) => i.group === 'identify');

      expect(unrep).toHaveLength(100);
      const capWarns = harness.capture
        .atLevel(40)
        .filter((l) => l['group'] === 'unread' && String(l['msg'] ?? '').includes('hit the cap'));
      expect(capWarns).toHaveLength(1);
      // The LOGGED count is the unread cap, proving warnIfCapped now takes its
      // threshold as a parameter instead of hardcoding GROUP_FETCH_LIMIT.
      expect(capWarns[0]).toMatchObject({ group: 'unread', count: 100 });
    });

    it('FILTER-THEN-CAP: a burst of unread group threads cannot starve the Identify rows', async () => {
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
        seedUnknownThread({
          conversationId: `conv-oneone-${n}`,
          contactId: `c-solo-${n}`,
          phone: `+1555024000${n}`,
          displayName: `Solo ${n}`,
          offset: -500_000 - n * 1_000,
        });
      }

      const ident = (await getItems()).filter((i) => i.group === 'identify');

      expect(ident.map((i) => i.refId).sort()).toEqual(['c-solo-1', 'c-solo-2', 'c-solo-3']);
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

      const needs = (await getItems()).filter((i) => i.group === 'identify');

      const forPerson = needs.filter((i) => i.refId === 'c-unknown-dedupe');
      expect(forPerson).toHaveLength(1);
      expect(forPerson[0]).toMatchObject({ refType: 'contact', why: 'New unknown contact' });
    });

    it('WARNS when the scan budget expires before the pass fills, instead of a silent short block', async () => {
      // Budget seam (ApiRouterDeps.unreadWalkLimit): the walk stops after 2 raw
      // rows, so the block is short for a reason the operator cannot otherwise
      // see - neither capped nor exhausted.
      for (let n = 0; n < 5; n += 1) {
        seedUnknownThread({
          conversationId: `conv-budget-${n}`,
          contactId: `c-budget-${n}`,
          phone: `+1555026000${n}`,
          offset: -1_000 - n * 1_000,
        });
      }
      const budgeted = makeWebhookHarness({ world, unreadWalkLimit: 2 });

      const res = await request(budgeted.app)
        .get('/api/today')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE);

      expect(res.status).toBe(200);
      const ident = (res.body as TodayResponse).items.filter((i) => i.group === 'identify');
      expect(ident).toHaveLength(2);
      const budgetWarns = budgeted.capture
        .atLevel(40)
        .filter((l) => l['event'] === 'today_unread_walk_truncated');
      expect(budgetWarns).toHaveLength(1);
      expect(budgetWarns[0]).toMatchObject({ scanned: 2, kept: 2, budget: 2 });
    });
  });

  // Moved by the Today checklist (spec 2026-10-23 4, plan PR40): these cases
  // rode an Unreplied row, which is gone. whoOfConversation still names every
  // Identify row from an unread unknown thread, so the same rules are pinned
  // through that vehicle; the owner is an unknown contact (the only owner type
  // Identify keeps) on the thread's phone, so the triage pass de-dupes it.
  describe('participant names resolve on read (M1)', () => {
    const seedUnreadUnknownThread = (name: string | undefined, contactId = 'c-renamed') =>
      seedConversation({
        conversationId: 'conv-renamed',
        participant_phone: '+15550107777',
        participants: [{ contactId, phone: '+15550107777' }],
        status: 'open',
        last_activity_at: iso(-30_000),
        type: 'unknown_1to1',
        ai_mode: 'auto',
        created_at: iso(-60_000),
        unread_count: 1,
        ...(name !== undefined && { participant_display_name: name }),
      });
    const seedRenamedUnknown = (): void => {
      world.contacts.push({
        contactId: 'c-renamed',
        type: 'unknown',
        status: 'needs_review',
        firstName: 'Renata',
        lastName: 'New',
        phone: '+15550107777',
      });
    };

    it('RED: a stale participant_display_name loses to the contact name', async () => {
      seedRenamedUnknown();
      seedUnreadUnknownThread('Old Name');
      const row = (await getItems()).find((i) => i.refId === 'c-renamed');
      expect(row).toMatchObject({ group: 'identify', who: 'Renata New' });
    });

    it('RED: no stored name plus a named contact shows the contact', async () => {
      seedRenamedUnknown();
      seedUnreadUnknownThread(undefined);
      const row = (await getItems()).find((i) => i.refId === 'c-renamed');
      expect(row).toMatchObject({ group: 'identify', who: 'Renata New' });
    });

    it('PIN: an unreadable contact keeps the stored name', async () => {
      seedUnreadUnknownThread('Stored Name');
      const real = world.contactsRepo.getById.bind(world.contactsRepo);
      world.contactsRepo.getById = async (id) => {
        if (id === 'c-renamed') throw new Error('ProvisionedThroughputExceededException');
        return real(id);
      };
      const row = (await getItems()).find((i) => i.refId === 'c-renamed');
      expect(row).toMatchObject({ group: 'identify', who: 'Stored Name' });
    });

    it('PIN: an unlinked thread (no contactId) defers to the triage row, which renders the formatted phone', async () => {
      seedUnreadUnknownThread(undefined, '');
      world.contacts.push({ contactId: 'c-unlinked', type: 'unknown', status: 'needs_review', phone: '+15550107777' });
      const items = await getItems();
      expect(items.filter((i) => i.who === '(555) 010-7777')).toEqual([
        expect.objectContaining({ group: 'identify', refType: 'contact', refId: 'c-unlinked' }),
      ]);
      expect(items.some((i) => i.refId === 'conv-renamed')).toBe(false);
    });

    it('PIN: resolving names adds NO contact reads - the deleted-check already memoized them', async () => {
      seedRenamedUnknown();
      seedUnreadUnknownThread('Old Name');
      const real = world.contactsRepo.getById.bind(world.contactsRepo);
      const reads: string[] = [];
      world.contactsRepo.getById = async (id) => { reads.push(id); return real(id); };
      await getItems();
      // The deleted check, the owner test, the name and the created_at sort
      // key all read ONE memoized contact.
      expect(reads.filter((id) => id === 'c-renamed')).toHaveLength(1);
    });

    it('RED: relay close-nag member names come from the contacts', async () => {
      seedTenant('c-nag', 'Nadia', 'Nag');
      seedConversation({
        conversationId: 'relay-nag',
        participant_phone: '+15550190001',
        pool_number: '+15550190001',
        participants: [
          { contactId: 'c-nag', phone: '+15550100011', name: 'Old Nag' },
          { contactId: '', phone: '+15550100012' },
        ],
        status: 'open',
        // The harness's listRelayGroups filters on THIS field with THIS shape
        // (twilioWebhookHarness.ts:777-781) - the real byRelayStatus GSI hash.
        relay_status: 'relay_group#open',
        close_nag_next_at: iso(-1_000),
        last_activity_at: iso(-30_000),
        type: 'relay_group',
        ai_mode: 'manual',
        created_at: iso(-60_000),
      });
      const res = await authedGet('/api/today');
      const body = res.body as TodayResponse;
      const nag = body.relayCloseNags.find((n) => n.conversationId === 'relay-nag');
      expect(nag?.memberNames).toEqual(['Nadia Nag', '(555) 010-0012']);
    });
  });

  // --- Today checklist (spec 2026-10-23-today-checklist-design.md 2.4, 3;
  // plan PR25 / PR29): tour rows carry their time and their property --------
  describe('tour rows carry at and unitLabel (today-checklist)', () => {
    const OAK = { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' };
    const OAK_LABEL = '12 Oak St, Atlanta, GA 30303';
    const seedUnit = (unitId: string, over: Partial<UnitItem> = {}): void => {
      world.units.set(unitId, { unitId, landlordId: 'c-ll', status: 'available', ...over });
    };
    const labelWarns = () =>
      harness.capture.atLevel(40).filter((l) => String(l['msg'] ?? '').includes('unit label'));

    it('tours_today rows carry at = scheduledAt and the unit label, ordered by time, then tenant, then tourId', async () => {
      seedUnit('u-oak', { address: OAK });
      seedTenant('t-amy', 'Amy', 'Able');
      seedTenant('t-bea', 'Bea', 'Bold');
      const nine = `${todayYmd()}T09:00:00.000Z`;
      const three = `${todayYmd()}T15:00:00.000Z`;
      await seedTour({ tourId: 'tour-3', tenantId: 't-amy', unitId: 'u-oak', scheduledAt: three });
      await seedTour({ tourId: 'tour-2', tenantId: 't-bea', unitId: 'u-oak', scheduledAt: nine });
      await seedTour({ tourId: 'tour-5', tenantId: 't-amy', unitId: 'u-oak', scheduledAt: nine });
      await seedTour({ tourId: 'tour-4', tenantId: 't-amy', unitId: 'u-oak', scheduledAt: nine });

      const tours = (await getItems()).filter((i) => i.group === 'tours_today');

      // The old order was tenant name first (tour-3, tour-4, tour-5, tour-2).
      expect(tours.map((i) => i.refId)).toEqual(['tour-4', 'tour-5', 'tour-2', 'tour-3']);
      expect(tours[0]).toEqual({
        group: 'tours_today',
        refType: 'tour',
        refId: 'tour-4',
        who: 'Amy Able',
        why: 'Tour today',
        tag: 'Tour',
        at: nine,
        unitLabel: OAK_LABEL,
      });
      expect(tours[3]).toMatchObject({ at: three, unitLabel: OAK_LABEL });
    });

    // PR86: a soft-deleted unit is still a present item with its address -
    // the label is the address and nothing WARNs. Only an ABSENT unit (or a
    // throw, below) degrades to the unitId, with ONE WARN per unit per request.
    it('a soft-deleted unit still shows its address, with no WARN (PR86)', async () => {
      seedUnit('u-del', { address: OAK, deleted_at: '2026-10-01T00:00:00.000Z' });
      seedTenant('t-amy', 'Amy', 'Able');
      await seedTour({ tourId: 'tour-d', tenantId: 't-amy', unitId: 'u-del', scheduledAt: todayNoonIso() });

      const tours = (await getItems()).filter((i) => i.group === 'tours_today');

      expect(tours.map((i) => [i.refId, i.unitLabel])).toEqual([['tour-d', OAK_LABEL]]);
      expect(labelWarns()).toEqual([]);
    });

    it('an absent unit labels the row with its unitId and WARNs once per unit - never a 500 (PR86)', async () => {
      seedTenant('t-amy', 'Amy', 'Able');
      await seedTour({ tourId: 'tour-g1', tenantId: 't-amy', unitId: 'u-gone', scheduledAt: todayNoonIso() });
      await seedTour({ tourId: 'tour-g2', tenantId: 't-amy', unitId: 'u-gone', scheduledAt: todayNoonIso() });

      const tours = (await getItems()).filter((i) => i.group === 'tours_today');

      expect(tours.map((i) => [i.refId, i.unitLabel])).toEqual([
        ['tour-g1', 'u-gone'],
        ['tour-g2', 'u-gone'],
      ]);
      expect(labelWarns()).toHaveLength(1);
      expect(labelWarns()[0]).toMatchObject({ unitId: 'u-gone' });
      expect(JSON.stringify(labelWarns())).not.toContain('Amy');
    });

    it('a unit read that THROWS degrades to the unitId and WARNs with the unitId - the route still answers 200', async () => {
      seedUnit('u-oak', { address: OAK });
      seedTenant('t-amy', 'Amy', 'Able');
      await seedTour({ tourId: 'tour-oak', tenantId: 't-amy', unitId: 'u-oak', scheduledAt: todayNoonIso() });
      vi.spyOn(world.unitsRepo, 'getById').mockRejectedValue(new Error('throttled'));

      const res = await authedGet('/api/today');

      expect(res.status).toBe(200);
      const row = (res.body as TodayResponse).items.find((i) => i.refId === 'tour-oak');
      expect(row?.unitLabel).toBe('u-oak');
      expect(labelWarns()).toHaveLength(1);
      expect(labelWarns()[0]).toMatchObject({ unitId: 'u-oak' });
      expect(JSON.stringify(labelWarns())).not.toContain('Amy');
    });

    it('labels are memoized per request: one unit read per distinct unit', async () => {
      seedUnit('u-oak', { address: OAK });
      seedTenant('t-amy', 'Amy', 'Able');
      for (const tourId of ['tour-m1', 'tour-m2', 'tour-m3']) {
        await seedTour({ tourId, tenantId: 't-amy', unitId: 'u-oak', scheduledAt: todayNoonIso() });
      }
      const spy = vi.spyOn(world.unitsRepo, 'getById');

      await getItems();

      expect(spy.mock.calls.map((c) => c[0])).toEqual(['u-oak']);
    });
  });

  // --- Today checklist (spec 2026-10-23 5.2, plan PR27): Identify these
  // contacts - both unknown sources, oldest contact first --------------------
  describe('Identify these contacts (today-checklist 5.2)', () => {
    const unknownContact = (contactId: string, phone: string, createdAt?: string): void => {
      world.contacts.push({
        contactId,
        type: 'unknown',
        status: 'needs_review',
        phone,
        ...(createdAt !== undefined && { created_at: createdAt }),
      });
    };
    const unknownThread = (contactId: string, phone: string, offset: number): void => {
      seedConversation({
        conversationId: `conv-${contactId}`,
        participant_phone: phone,
        participants: [{ contactId, phone }],
        status: 'open',
        last_activity_at: iso(offset),
        type: 'unknown_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 1,
      } as ConversationItem);
    };

    it('rows from BOTH sources land in identify, not needs_you_now, with the row shape unchanged', async () => {
      unknownContact('c-unk-thread', '+15550370001');
      unknownThread('c-unk-thread', '+15550370001', -30_000);
      unknownContact('c-unk-triage', '+15550370002');

      const items = await getItems();

      expect(items.filter((i) => i.group === 'needs_you_now')).toEqual([]);
      expect(items.filter((i) => i.group === 'identify')).toEqual([
        { group: 'identify', refType: 'contact', refId: 'c-unk-thread', who: '(555) 037-0001', why: 'New unknown contact', attention: true },
        { group: 'identify', refType: 'contact', refId: 'c-unk-triage', who: '(555) 037-0002', why: 'New unknown contact', attention: true },
      ]);
    });

    it('orders oldest contact first by created_at across both sources; none or unparseable sorts last; ties by refId', async () => {
      // Thread-sourced rows, newest thread activity FIRST - so the activity
      // order the unread walk yields is NOT the identify order.
      unknownContact('c-u-new', '+15550370101', '2026-10-20T10:00:00.000Z');
      unknownThread('c-u-new', '+15550370101', -10_000);
      unknownContact('c-u-none', '+15550370102');
      unknownThread('c-u-none', '+15550370102', -20_000);
      // No contact item at all: an unresolved owner (sorts as no created_at).
      unknownThread('c-u-unresolved', '+15550370103', -30_000);
      // Triage-sourced rows (no unread thread).
      unknownContact('c-t-old', '+15550370104', '2026-10-01T10:00:00.000Z');
      unknownContact('c-t-mid', '+15550370105', '2026-10-10T10:00:00.000Z');
      unknownContact('c-t-tie', '+15550370106', '2026-10-10T10:00:00.000Z');
      unknownContact('c-t-none', '+15550370107');
      unknownContact('c-t-bad', '+15550370108', 'garbage');

      const ids = (await getItems()).filter((i) => i.group === 'identify').map((i) => i.refId);

      expect(ids).toEqual([
        'c-t-old',
        'c-t-mid',
        'c-t-tie',
        'c-u-new',
        'c-t-bad',
        'c-t-none',
        'c-u-none',
        'c-u-unresolved',
      ]);
    });

    it('identify follows needs_you_now in the response order', async () => {
      seedTenant('t-1', 'Keisha', 'Brown');
      seedPlacement({
        placementId: 'placement-needs',
        tenantId: 't-1',
        stage: 'awaiting_authority_approval',
        next_deadline_type: 'rta_window',
        next_deadline_at: iso(-3_600_000),
      });
      unknownContact('c-unk', '+15550370201');

      expect((await getItems()).map((i) => [i.group, i.refId])).toEqual([
        ['needs_you_now', 'placement-needs'],
        ['identify', 'c-unk'],
      ]);
    });
  });

  // --- Today checklist (spec 2026-10-23 4, 5.2; plan PR26): the unread pass
  // reads ONLY unknown_1to1 threads, and only a type-unknown owner emits -----
  describe('the unread pass: type filter first, then the owner rule (today-checklist PR26)', () => {
    it('the type filter runs FIRST: 150 known unread threads ahead cost no contact read and no cap slot', async () => {
      const KNOWN_TYPES = ['tenant_1to1', 'landlord_1to1', 'partner_1to1'] as const;
      for (let i = 0; i < 150; i += 1) {
        const id = `c-known-${String(i).padStart(3, '0')}`;
        const phone = `+1555050${String(i).padStart(4, '0')}`;
        seedTenant(id, 'Known', id);
        seedConversation({
          conversationId: `conv-known-${String(i).padStart(3, '0')}`,
          participant_phone: phone,
          participants: [{ contactId: id, phone }],
          status: 'open',
          // NEWEST, so a pass that filtered after the cap would fill it with these.
          last_activity_at: iso(-1_000 - i),
          type: KNOWN_TYPES[i % 3]!,
          ai_mode: 'auto',
          created_at: iso(-900_000),
          unread_count: 1,
        } as ConversationItem);
      }
      for (let i = 0; i < 100; i += 1) {
        seedUnknownThread({
          conversationId: `conv-new-${String(i).padStart(3, '0')}`,
          contactId: `c-new-${String(i).padStart(3, '0')}`,
          phone: `+1555051${String(i).padStart(4, '0')}`,
          offset: -200_000 - i,
        });
      }
      const real = world.contactsRepo.getById.bind(world.contactsRepo);
      const reads: string[] = [];
      world.contactsRepo.getById = async (id) => { reads.push(id); return real(id); };

      const items = await getItems();

      const ids = items.filter((i) => i.group === 'identify').map((i) => i.refId);
      // Every unknown row fits: the 150 known threads spent no cap slot ...
      expect(ids).toHaveLength(100);
      expect(ids).toContain('c-new-099');
      // ... and no contact read: the type test runs before the deleted check.
      expect(reads.filter((id) => id.startsWith('c-known-'))).toEqual([]);
      expect(items.some((i) => i.refId.startsWith('c-known-'))).toBe(false);
    });

    for (const [type, status] of [
      ['tenant', 'searching'],
      ['landlord', 'active'],
      ['partner', 'active'],
      ['team_member', 'active'],
    ] as const) {
      it(`an unknown_1to1 thread owned by an Active ${type} emits NO Today row (it stays in the Inbox)`, async () => {
        world.contacts.push({ contactId: 'c-owner', type, status, firstName: 'Own', lastName: 'Er', phone: '+15550380001' });
        seedUnknownThread({ conversationId: 'conv-owner', contactId: 'c-owner', phone: '+15550380001', offset: -30_000 });

        expect(await getItems()).toEqual([]);
      });
    }

    it('a type-unknown owner emits unless Inactive; a status-less unknown owner emits', async () => {
      world.contacts.push({ contactId: 'c-unk-nr', type: 'unknown', status: 'needs_review', phone: '+15550380011' });
      seedUnknownThread({ conversationId: 'conv-unk-nr', contactId: 'c-unk-nr', phone: '+15550380011', offset: -10_000 });
      world.contacts.push({ contactId: 'c-unk-bare', type: 'unknown', phone: '+15550380012' });
      seedUnknownThread({ conversationId: 'conv-unk-bare', contactId: 'c-unk-bare', phone: '+15550380012', offset: -20_000 });
      world.contacts.push({ contactId: 'c-unk-off', type: 'unknown', status: 'inactive', phone: '+15550380013' });
      seedUnknownThread({ conversationId: 'conv-unk-off', contactId: 'c-unk-off', phone: '+15550380013', offset: -30_000 });

      const ids = (await getItems()).filter((i) => i.group === 'identify').map((i) => i.refId);

      expect(ids).toEqual(['c-unk-bare', 'c-unk-nr']);
    });

    it('(PIN) an unresolved owner keeps today\'s behavior: a linked roster emits its row; an unlinked one defers to the triage pass', async () => {
      seedUnknownThread({
        conversationId: 'conv-unres',
        contactId: 'c-unres',
        phone: '+15550380101',
        displayName: 'Una Resolved',
        offset: -30_000,
      });
      seedConversation({
        conversationId: 'conv-unlinked',
        participant_phone: '+15550380102',
        status: 'open',
        last_activity_at: iso(-40_000),
        type: 'unknown_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 1,
      } as ConversationItem);
      world.contacts.push({ contactId: 'c-unlinked', type: 'unknown', status: 'needs_review', phone: '+15550380102' });

      const ident = (await getItems()).filter((i) => i.group === 'identify');

      expect(ident.map((i) => [i.refType, i.refId, i.who])).toEqual([
        ['contact', 'c-unlinked', '(555) 038-0102'],
        ['contact', 'c-unres', 'Una Resolved'],
      ]);
    });

    it('Unreplied is gone: no item carries the group, whatever is unread', async () => {
      seedTenant('c-ten', 'Tia', 'Tenant');
      seedConversation({
        conversationId: 'conv-ten',
        participant_phone: '+15550380201',
        participants: [{ contactId: 'c-ten', phone: '+15550380201' }],
        status: 'open',
        last_activity_at: iso(-30_000),
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: iso(-900_000),
        unread_count: 3,
      } as ConversationItem);
      world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550380202' });

      const groups = (await getItems()).map((i) => i.group as string);

      expect(groups).toEqual(['identify']);
      expect(groups).not.toContain('unreplied');
    });
  });

  // --- Today checklist (spec 2026-10-23 5.4, plan PR28): Tours to book -------
  describe('Tours to book (today-checklist 5.4)', () => {
    const DAY_MS = 86_400_000;
    const OAK_LABEL = '12 Oak St, Atlanta, GA 30303';
    const seedOak = (): void => {
      world.units.set('u-oak', {
        unitId: 'u-oak',
        landlordId: 'c-ll',
        status: 'available',
        address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
      });
    };

    it('lists every REQUESTED tour, oldest request first (ties by tourId), with at = createdAt, the unit label and the request age', async () => {
      seedOak();
      seedTenant('t-amy', 'Amy', 'Able');
      seedTenant('t-bea', 'Bea', 'Bold');
      seedTenant('t-cal', 'Cal', 'Cole');
      const now = Date.now();
      const oldest = new Date(now - 9 * DAY_MS - 3_600_000).toISOString();
      const yesterday = new Date(now - DAY_MS - 3_600_000).toISOString();
      const fresh = new Date(now - 3_600_000).toISOString();
      await seedTour({ tourId: 'tour-b', tenantId: 't-bea', unitId: 'u-oak', createdAt: yesterday });
      await seedTour({ tourId: 'tour-c', tenantId: 't-cal', unitId: 'u-gone', createdAt: fresh });
      await seedTour({ tourId: 'tour-a2', tenantId: 't-amy', unitId: 'u-oak', createdAt: oldest });
      await seedTour({ tourId: 'tour-a1', tenantId: 't-amy', unitId: 'u-oak', createdAt: oldest });
      // Not requested: a scheduled tour and a canceled request never appear.
      await seedTour({ tourId: 'tour-sched', tenantId: 't-amy', unitId: 'u-oak', scheduledAt: tomorrowNoonIso() });
      await seedTour({ tourId: 'tour-cxl', tenantId: 't-amy', unitId: 'u-oak', status: 'canceled', createdAt: oldest });

      const rows = (await getItems()).filter((i) => i.group === 'tours_to_book');

      const oak = { why: OAK_LABEL, unitLabel: OAK_LABEL };
      expect(rows).toEqual([
        { group: 'tours_to_book', refType: 'tour', refId: 'tour-a1', who: 'Amy Able', ...oak, urgency: 'Requested 9 days ago', at: oldest },
        { group: 'tours_to_book', refType: 'tour', refId: 'tour-a2', who: 'Amy Able', ...oak, urgency: 'Requested 9 days ago', at: oldest },
        { group: 'tours_to_book', refType: 'tour', refId: 'tour-b', who: 'Bea Bold', ...oak, urgency: 'Requested 1 day ago', at: yesterday },
        // A unit with no item: the label degrades to the unitId (spec 2.5) -
        // the section stays available.
        { group: 'tours_to_book', refType: 'tour', refId: 'tour-c', who: 'Cal Cole', why: 'u-gone', unitLabel: 'u-gone', urgency: 'Requested today', at: fresh },
      ]);
      for (const row of rows) expect(row).not.toHaveProperty('tag');
    });

    it('skips a deleted tenant; a tenant with no contact item keeps the row with the id as who', async () => {
      world.contacts.push({ contactId: 't-del', type: 'tenant', status: 'searching', firstName: 'Del', lastName: 'Eted', deleted_at: iso(-1_000) });
      await seedTour({ tourId: 'tour-del', tenantId: 't-del' });
      await seedTour({ tourId: 'tour-ghost', tenantId: 't-ghost' });

      const rows = (await getItems()).filter((i) => i.group === 'tours_to_book');

      expect(rows.map((r) => [r.refId, r.who])).toEqual([['tour-ghost', 't-ghost']]);
    });

    it('requestedUrgencyOf (pure): whole fixed 24h days - today, 1 day ago, N days ago', () => {
      const now = Date.parse('2026-10-24T12:00:00.000Z');
      const minus = (ms: number): string => new Date(now - ms).toISOString();
      expect(requestedUrgencyOf(minus(0), now)).toBe('Requested today');
      expect(requestedUrgencyOf(minus(DAY_MS - 1), now)).toBe('Requested today');
      expect(requestedUrgencyOf(minus(DAY_MS), now)).toBe('Requested 1 day ago');
      expect(requestedUrgencyOf(minus(2 * DAY_MS - 1), now)).toBe('Requested 1 day ago');
      expect(requestedUrgencyOf(minus(2 * DAY_MS), now)).toBe('Requested 2 days ago');
      expect(requestedUrgencyOf(minus(64 * DAY_MS), now)).toBe('Requested 64 days ago');
      // Not calendar days: 23h ago, across a midnight, is still today.
      expect(requestedUrgencyOf('2026-10-23T13:00:00.000Z', now)).toBe('Requested today');
      // Defensive: an unparseable or future createdAt reads as today.
      expect(requestedUrgencyOf('garbage', now)).toBe('Requested today');
      expect(requestedUrgencyOf('2026-10-25T12:00:00.000Z', now)).toBe('Requested today');
    });

    it('a failed tours read makes ONLY Tours to book unavailable: 200, no rows, a WARN without names; the rest intact', async () => {
      seedTenant('t-amy', 'Amy', 'Able');
      await seedTour({ tourId: 'tour-req', tenantId: 't-amy' });
      await seedTour({ tourId: 'tour-now', tenantId: 't-amy', scheduledAt: todayNoonIso() });
      world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550390001' });
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValue(new Error('throttled'));

      const res = await authedGet('/api/today');

      expect(res.status).toBe(200);
      const body = res.body as TodayResponse;
      expect(body.toursToBook).toBe('unavailable');
      expect(body.items.map((i) => [i.group, i.refId])).toEqual([
        ['identify', 'c-unk'],
        ['tours_today', 'tour-now'],
      ]);
      const warns = harness.capture.atLevel(40).filter((l) => l['section'] === 'tours_to_book');
      expect(warns).toHaveLength(1);
      expect(JSON.stringify(harness.capture.atLevel(40))).not.toContain('Amy');
    });

    it('items come in checklist order: needs_you_now, identify, tours_to_book, tours_today, follow_ups, ai_suggestions', async () => {
      seedTenant('t-1', 'Keisha', 'Brown');
      seedPlacement({
        placementId: 'placement-needs',
        tenantId: 't-1',
        stage: 'awaiting_authority_approval',
        next_deadline_type: 'rta_window',
        next_deadline_at: iso(-3_600_000),
      });
      world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550390101' });
      seedTenant('t-2', 'Maria', 'Lopez');
      await seedTour({ tourId: 'tour-req', tenantId: 't-2' });
      await seedTour({ tourId: 'tour-today', tenantId: 't-2', scheduledAt: todayNoonIso() });
      seedTenant('t-3', 'Sam', 'Lee');
      seedPlacement({
        placementId: 'placement-follow',
        tenantId: 't-3',
        stage: 'awaiting_approval',
        next_deadline_type: 'follow_up',
        next_deadline_at: iso(-60_000),
      });
      seedTenant('t-sug', 'Sug', 'Gest');
      await world.extractionRepo.putSuggestion({
        ownerContactId: 't-sug',
        target: 'voucherSize',
        suggestedValue: '3',
        conversationId: 'conv-a',
      });

      const groups = (await getItems()).map((i) => i.group);
      expect(groups).toEqual(['needs_you_now', 'identify', 'tours_to_book', 'tours_today', 'follow_ups', 'ai_suggestions']);
    });
  });

  // --- Today checklist (spec 2026-10-23 6, 2.5; plan PR30): Quiet shares ----
  describe('Quiet shares on Today (today-checklist 6)', () => {
    const DAY_MS = 86_400_000;
    const HOUR_MS = 3_600_000;
    const OAK = { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' };
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    const seedUnit = (unitId: string, over: Partial<UnitItem> = {}): void => {
      world.units.set(unitId, { unitId, landlordId: 'c-ll', status: 'available', ...over });
    };
    // Eligible by default (a phone, a live status); first name "Quinn" so a
    // WARN that leaked a name would be caught.
    const seedRecipient = (contactId: string, phone: string, over: Record<string, unknown> = {}): ContactItem => {
      const contact = { contactId, type: 'tenant', status: 'searching', firstName: 'Quinn', lastName: contactId, phone, ...over } as ContactItem;
      world.contacts.push(contact);
      return contact;
    };
    const seedSend = (unitId: string, contactId: string, sentAt: string, over: Partial<ListingSendItem> = {}): void => {
      world.listingSends.push({ unitId, contactId, sentAt, via: 'individual', counted: true, created_at: sentAt, updated_at: sentAt, ...over });
    };
    const contactOf = (contactId: string): ContactItem => world.contacts.find((c) => c.contactId === contactId)!;
    const getBody = async (): Promise<TodayResponse> => {
      const res = await authedGet('/api/today');
      expect(res.status).toBe(200);
      return res.body as TodayResponse;
    };
    const EMPTY = { status: 'ok', properties: [], truncated: false };

    it('quietShares groups by property in spec order; the contacts batch is read CONSISTENTLY', async () => {
      seedUnit('u-a', { address: OAK });
      seedUnit('u-b');
      const c1Sent = ago(6 * DAY_MS);
      const c2Heard = ago(3 * DAY_MS);
      const c4Sent = ago(7 * DAY_MS);
      seedRecipient('c-1', '+15550600001');
      seedSend('u-a', 'c-1', c1Sent);
      seedRecipient('c-2', '+15550600002', { last_heard_from_at: c2Heard });
      seedSend('u-a', 'c-2', ago(5 * DAY_MS));
      // Waiting on the Follow up tab (2 days, over its 24h) but not quiet here.
      seedRecipient('c-3', '+15550600003');
      seedSend('u-b', 'c-3', ago(2 * DAY_MS));
      seedRecipient('c-4', '+15550600004', { type: 'partner', status: 'active', role: 'Caseworker' });
      seedSend('u-b', 'c-4', c4Sent);

      const body = await getBody();

      expect(body.quietShares).toEqual({
        status: 'ok',
        truncated: false,
        properties: [
          {
            unitId: 'u-b',
            unitLabel: 'u-b',
            people: [{ contactId: 'c-4', name: 'Quinn c-4', type: 'partner', role: 'Caseworker', state: 'no_reply', quietSince: c4Sent }],
          },
          {
            unitId: 'u-a',
            unitLabel: '12 Oak St, Atlanta, GA 30303',
            people: [
              { contactId: 'c-2', name: 'Quinn c-2', type: 'tenant', state: 'replied', quietSince: c2Heard },
              { contactId: 'c-1', name: 'Quinn c-1', type: 'tenant', state: 'no_reply', quietSince: c1Sent },
            ],
          },
        ],
      });
      // Spec 6.1 / PR30: a refetch fired by a stamp's event must see the
      // stamp - the ONE contacts batch is consistent. Each recorded call is
      // { contactIds, opts? } (S1.3; PR60, PR82), so the options are read
      // off `.opts`.
      expect(world.recipientDisplayCalls).toHaveLength(1);
      expect(world.recipientDisplayCalls[0]?.opts).toMatchObject({ requireComplete: true, consistentRead: true });
    });

    it('staff outreach restarts the clock: last_reached_out_at later than the send holds the person back until the quiet resumes', async () => {
      seedUnit('u-a');
      seedRecipient('c-1', '+15550610001', { last_reached_out_at: ago(4 * DAY_MS) });
      seedSend('u-a', 'c-1', ago(10 * DAY_MS));
      expect((await getBody()).quietShares).toEqual(EMPTY);

      // Quiet continues past 5 days since that outreach (a fixture stands in
      // for the clock): the person is back, with the outreach as the clock and
      // the state still no_reply.
      const reached = ago(6 * DAY_MS);
      contactOf('c-1').last_reached_out_at = reached;
      expect((await getBody()).quietShares).toEqual({
        status: 'ok',
        truncated: false,
        properties: [
          { unitId: 'u-a', unitLabel: 'u-a', people: [{ contactId: 'c-1', name: 'Quinn c-1', type: 'tenant', state: 'no_reply', quietSince: reached }] },
        ],
      });
    });

    it('a second share does not restart the first: each property keeps its own clock; the person is listed once', async () => {
      seedUnit('u-a');
      seedUnit('u-b');
      seedRecipient('c-1', '+15550620001');
      seedSend('u-a', 'c-1', ago(6 * DAY_MS));
      seedSend('u-b', 'c-1', ago(1 * DAY_MS + HOUR_MS));

      const quiet = (await getBody()).quietShares;

      expect(quiet).toMatchObject({ status: 'ok', properties: [{ unitId: 'u-a', people: [{ contactId: 'c-1' }] }] });
      expect(quiet.status === 'ok' && quiet.properties.map((p) => p.unitId)).toEqual(['u-a']);
    });

    const dropOffs: Array<[string, () => void | Promise<void>]> = [
      ['they reply (last_heard_from_at moves)', () => { contactOf('c-1').last_heard_from_at = ago(HOUR_MS); }],
      ['staff reach out (last_reached_out_at moves)', () => { contactOf('c-1').last_reached_out_at = ago(HOUR_MS); }],
      ['a tour is created for them on that property', async () => {
        await world.toursRepo.create({ tenantId: 'c-1', unitId: 'u-a', tourType: 'self_guided' });
      }],
      ['staff mark them Not interested', () => { world.listingSends[0]!.declined = { at: ago(HOUR_MS), by: 'staff' }; }],
      ['the send passes 14 days old', () => { world.listingSends[0]!.sentAt = ago(15 * DAY_MS); }],
      ['they opt out', () => { contactOf('c-1').sms_opt_out = true; }],
      ['they are marked Inactive', () => { contactOf('c-1').status = 'inactive'; }],
      ['they are deleted', () => { contactOf('c-1').deleted_at = ago(HOUR_MS); }],
      ['the property stops being available', () => { world.units.get('u-a')!.status = 'on_hold'; }],
      // Fix wave 1 (FW1-4; code review R1SC-3): the three spec 6.1 drop-offs
      // the route table did not pin yet (the shared eligibility rule does).
      ['they become unreachable (sms_unreachable)', () => { contactOf('c-1').sms_unreachable = true; }],
      ['they are placed (a tenant whose status is placed)', () => { contactOf('c-1').status = 'placed'; }],
      ['they have no phone', () => { delete contactOf('c-1').phone; }],
    ];
    for (const [label, change] of dropOffs) {
      it(`a quiet person drops off when ${label}`, async () => {
        seedUnit('u-a');
        seedRecipient('c-1', '+15550630001');
        seedSend('u-a', 'c-1', ago(6 * DAY_MS));
        expect((await getBody()).quietShares).toMatchObject({ status: 'ok', properties: [{ unitId: 'u-a', people: [{ contactId: 'c-1' }] }] });

        await change();

        expect((await getBody()).quietShares).toEqual(EMPTY);
      });
    }

    it('more than 100 available properties sets truncated (the Follow up flag)', async () => {
      for (let i = 0; i <= 100; i += 1) seedUnit(`u-${String(i).padStart(3, '0')}`);
      expect((await getBody()).quietShares).toEqual({ ...EMPTY, truncated: true });
    });

    // Spec 2.5: ANY throw in the quiet-shares computation makes ONLY that
    // section unavailable; the route answers 200 and the WARN names no one.
    const seedWholePage = async (): Promise<void> => {
      seedUnit('u-a');
      seedRecipient('c-1', '+15550650001');
      seedSend('u-a', 'c-1', ago(6 * DAY_MS));
      seedTenant('t-req', 'Rita', 'Request');
      await seedTour({ tourId: 'tour-req', tenantId: 't-req', unitId: 'u-a' });
      world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550650002' });
    };
    const quietFailures: Array<[string, () => void]> = [
      ['the units walk', () => { vi.spyOn(world.unitsRepo, 'listByStatus').mockRejectedValue(new Error('throttled')); }],
      ['a listing-sends read', () => { vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValue(new Error('throttled')); }],
      ['a per-unit tours read', () => { vi.spyOn(world.toursRepo, 'listByUnit').mockRejectedValue(new Error('throttled')); }],
      ['the contacts batch', () => {
        vi.spyOn(world.contactsRepo, 'getRecipientDisplaysByIds').mockRejectedValue(new IncompleteBatchReadError(1, 1));
      }],
    ];
    for (const [label, breakIt] of quietFailures) {
      it(`a throw from ${label} makes ONLY Quiet shares unavailable: 200, the rest intact, a WARN without names`, async () => {
        await seedWholePage();
        breakIt();

        const body = await getBody();

        expect(body.quietShares).toEqual({ status: 'unavailable' });
        expect(body.toursToBook).toBe('ok');
        expect(body.items.map((i) => [i.group, i.refId])).toEqual([
          ['identify', 'c-unk'],
          ['tours_to_book', 'tour-req'],
        ]);
        expect(harness.capture.atLevel(40).filter((l) => l['section'] === 'quiet_shares')).toHaveLength(1);
        const warns = JSON.stringify(harness.capture.atLevel(40));
        expect(warns).not.toContain('Quinn');
        expect(warns).not.toContain('Rita');
      });
    }

    it('a throw from the tours read makes ONLY Tours to book unavailable; Quiet shares is still computed', async () => {
      await seedWholePage();
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValue(new Error('throttled'));

      const body = await getBody();

      expect(body.toursToBook).toBe('unavailable');
      expect(body.quietShares).toMatchObject({ status: 'ok', properties: [{ unitId: 'u-a', people: [{ contactId: 'c-1' }] }] });
      expect(body.items.map((i) => [i.group, i.refId])).toEqual([['identify', 'c-unk']]);
    });

    // WI7 (plan section 3): the read budget of ONE Today load in the harness,
    // recorded for the spec 6.5 cost note and the S7 docs/issues entry.
    it('WI7: the read budget of one Today load (three properties, two with recent shares, one requested and one today tour)', async () => {
      seedUnit('u-1');
      seedUnit('u-2');
      seedUnit('u-3');
      seedRecipient('c-1', '+15550640001');
      seedSend('u-1', 'c-1', ago(6 * DAY_MS));
      seedRecipient('c-2', '+15550640002');
      seedSend('u-2', 'c-2', ago(6 * DAY_MS));
      seedTenant('t-3', 'Tess', 'Tour');
      await seedTour({ tourId: 'tour-req', tenantId: 't-3', unitId: 'u-1' });
      await seedTour({ tourId: 'tour-now', tenantId: 't-3', unitId: 'u-1', scheduledAt: todayNoonIso() });
      const spies = {
        // Reads Today made before this mission.
        deadlinesDue: vi.spyOn(world.placementDeadlinesRepo, 'listDue'),
        placementsByStage: vi.spyOn(world.placementsRepo, 'listByStage'),
        toursByRange: vi.spyOn(world.toursRepo, 'listByScheduledRange'),
        relayOptOut: vi.spyOn(world.conversationsRepo, 'listRelayOptOutAttention'),
        unreadPages: vi.spyOn(world.conversationsRepo, 'queryUnreadPage'),
        triagePages: vi.spyOn(world.contactsRepo, 'listByType'),
        aiPending: vi.spyOn(world.extractionRepo, 'listPending'),
        relayGroups: vi.spyOn(world.conversationsRepo, 'listRelayGroups'),
        // New with the Today checklist (S4).
        toursRequested: vi.spyOn(world.toursRepo, 'listByStatus'),
        unitLabels: vi.spyOn(world.unitsRepo, 'getById'),
        unitsWalk: vi.spyOn(world.unitsRepo, 'listByStatus'),
        sendsByUnit: vi.spyOn(world.listingSendsRepo, 'listByUnit'),
        toursByUnit: vi.spyOn(world.toursRepo, 'listByUnit'),
        recipientBatch: vi.spyOn(world.contactsRepo, 'getRecipientDisplaysByIds'),
      };

      await getBody();

      const counts = Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]));
      expect(counts).toEqual({
        deadlinesDue: 1,
        placementsByStage: PLACEMENT_STAGES.filter((s) => !TERMINAL_STAGES.has(s)).length,
        toursByRange: 1,
        relayOptOut: 1,
        unreadPages: 1,
        triagePages: 1,
        aiPending: 1,
        relayGroups: 1,
        toursRequested: 1,
        // Both tours sit on u-1: one memoized label read.
        unitLabels: 1,
        unitsWalk: 1,
        // Every kept available property is read; only those with a recent
        // share pay the tours read.
        sendsByUnit: 3,
        toursByUnit: 2,
        recipientBatch: 1,
      });
    });
  });
});
