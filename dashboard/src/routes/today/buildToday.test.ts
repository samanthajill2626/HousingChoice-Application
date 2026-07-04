import { describe, expect, it } from 'vitest';
import { buildTodayFromSources } from './buildToday.js';
import type { PlacementItem, ConversationSummary, Tour } from '../../api/index.js';

// A fixed "now" in local time. Tests build deadlines/tours relative to it.
const NOW = new Date('2026-06-16T12:00:00');

function placementOf(partial: Partial<PlacementItem> & Pick<PlacementItem, 'placementId'>): PlacementItem {
  return {
    tenantId: `t-${partial.placementId}`,
    unitId: `u-${partial.placementId}`,
    stage: 'schedule_inspection',
    ...partial,
  };
}

function convOf(
  partial: Partial<ConversationSummary> & Pick<ConversationSummary, 'conversationId'>,
): ConversationSummary {
  return {
    type: 'tenant_1to1',
    participant_phone: '+14040100007',
    participants: [],
    preview: null,
    last_activity_at: NOW.toISOString(),
    unread_count: 0,
    assignment: null,
    sms_opt_out: false,
    participant_display_name: null,
    ...partial,
  };
}

/** ISO string for `now + ms`. */
function at(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** tours_today source: Tour ENTITIES (placement.tour_date is retired). NOW is
 *  local noon, so `at(2 * HOUR)` = 2pm on NOW's local day in any test TZ. */
function tourOf(partial: Partial<Tour> & Pick<Tour, 'tourId'>): Tour {
  return {
    tenantId: `t-${partial.tourId}`,
    unitId: `u-${partial.tourId}`,
    tourType: 'self_guided',
    status: 'scheduled',
    ...partial,
  } as Tour;
}

describe('buildTodayFromSources', () => {
  it('puts a placement with an upcoming deadline in needs_you_now with humanized urgency + tag', () => {
    const items = buildTodayFromSources(
      [placementOf({ placementId: 'k1', stage: 'schedule_inspection', next_deadline_type: 'rta_window', next_deadline_at: at(2 * HOUR) })],
      [],
      NOW,
    );
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.group).toBe('needs_you_now');
    expect(item?.refType).toBe('placement');
    expect(item?.refId).toBe('k1');
    expect(item?.urgency).toBe('2h left');
    expect(item?.tag).toBe('Placement - Schedule inspection');
    expect(item?.why).toMatch(/RTA/i);
  });

  it('humanizes an overdue deadline and a multi-day deadline', () => {
    const items = buildTodayFromSources(
      [
        placementOf({ placementId: 'overdue', next_deadline_type: 'rta_window', next_deadline_at: at(-3 * HOUR) }),
        placementOf({ placementId: 'days', next_deadline_type: 'voucher_expiration', next_deadline_at: at(3 * DAY) }),
      ],
      [],
      NOW,
    );
    const byId = Object.fromEntries(items.map((i) => [i.refId, i]));
    expect(byId['overdue']?.urgency).toBe('overdue');
    expect(byId['days']?.urgency).toBe('3 days');
  });

  it('orders needs_you_now most-urgent first (soonest/overdue deadline before later)', () => {
    const items = buildTodayFromSources(
      [
        placementOf({ placementId: 'later', next_deadline_type: 'rta_window', next_deadline_at: at(5 * DAY) }),
        placementOf({ placementId: 'soon', next_deadline_type: 'rta_window', next_deadline_at: at(1 * HOUR) }),
        placementOf({ placementId: 'past', next_deadline_type: 'rta_window', next_deadline_at: at(-1 * HOUR) }),
      ],
      [],
      NOW,
    );
    expect(items.map((i) => i.refId)).toEqual(['past', 'soon', 'later']);
  });

  it('flags an attention placement in needs_you_now with attention:true (no deadline)', () => {
    const items = buildTodayFromSources(
      [
        placementOf({
          placementId: 'att',
          stage: 'awaiting_approval',
          attention: { reason: 'Send failed — needs a call', at: NOW.toISOString() },
        }),
      ],
      [],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.group).toBe('needs_you_now');
    expect(items[0]?.attention).toBe(true);
    expect(items[0]?.why).toMatch(/Send failed/);
    expect(items[0]?.tag).toBe('Placement - Awaiting approval');
  });

  it('treats an untriaged unknown_1to1 as needs_you_now, linking to the contact page', () => {
    const items = buildTodayFromSources(
      [],
      [
        convOf({
          conversationId: 'unk',
          type: 'unknown_1to1',
          participant_phone: '+14040100007',
          participants: [{ contactId: 'ct-unknown-1', phone: '+14040100007' }],
          unread_count: 1,
          preview: 'hi',
        }),
      ],
      NOW,
    );
    const unk = items.find((i) => i.group === 'needs_you_now');
    // Links to the unknown CONTACT's detail page — NOT /conversations/:id (dead).
    expect(unk?.refType).toBe('contact');
    expect(unk?.refId).toBe('ct-unknown-1');
    expect(unk?.attention).toBe(true);
    expect(unk?.tag).toBe('Contact - Unknown');
    // Falls back to a formatted phone when there's no display name.
    expect(unk?.who).toBe('(404) 010-0007');
    expect(unk?.why).toMatch(/untriaged/i);
  });

  it('falls back to the Unknown list (by phone) when an untriaged inbound has no resolvable contact id', () => {
    const items = buildTodayFromSources(
      [],
      [
        convOf({
          conversationId: 'unk2',
          type: 'unknown_1to1',
          participant_phone: '+14040100007',
          participants: [],
          unread_count: 1,
        }),
      ],
      NOW,
    );
    const unk = items.find((i) => i.group === 'needs_you_now');
    expect(unk?.refType).toBe('contact');
    // → /contacts/unknown?phone=%2B14040100007 (mirrors the Inbox; never dead-ends).
    expect(unk?.refId).toBe('unknown?phone=%2B14040100007');
  });

  it('puts a Tour entity scheduled today in tours_today (linking the tour, not a placement)', () => {
    const items = buildTodayFromSources([], [], NOW, [
      tourOf({ tourId: 'tour-1', scheduledAt: at(2 * HOUR) }),
    ]);
    const tour = items.find((i) => i.group === 'tours_today');
    expect(tour?.refType).toBe('tour');
    expect(tour?.refId).toBe('tour-1');
    expect(tour?.why).toMatch(/Tour/);
    expect(tour?.tag).toBe('Tour');
  });

  it('RETIRED: a placement with today\'s tour_date no longer yields a tours_today item', () => {
    const items = buildTodayFromSources(
      [placementOf({ placementId: 'legacy', stage: 'schedule_inspection', tour_date: '2026-06-16' })],
      [],
      NOW,
    );
    expect(items.filter((i) => i.group === 'tours_today')).toEqual([]);
  });

  it('excludes a requested (time-less) tour and a canceled tour from tours_today', () => {
    const items = buildTodayFromSources([], [], NOW, [
      tourOf({ tourId: 'tour-requested', status: 'requested' }), // no scheduledAt
      tourOf({ tourId: 'tour-canceled', status: 'canceled', scheduledAt: at(2 * HOUR) }),
      tourOf({ tourId: 'tour-confirmed', status: 'confirmed', scheduledAt: at(3 * HOUR) }),
    ]);
    expect(items.filter((i) => i.group === 'tours_today').map((i) => i.refId)).toEqual([
      'tour-confirmed',
    ]);
  });

  it('does not put a tour on a different day in tours_today', () => {
    const items = buildTodayFromSources([], [], NOW, [
      tourOf({ tourId: 'tmrw', scheduledAt: at(DAY + 2 * HOUR) }),
    ]);
    expect(items.find((i) => i.group === 'tours_today')).toBeUndefined();
  });

  it('puts an unread triaged 1:1 in unreplied, linking to the contact page', () => {
    const items = buildTodayFromSources(
      [],
      [
        convOf({
          conversationId: 'unrep',
          type: 'landlord_1to1',
          participant_phone: '+14042220190',
          participants: [{ contactId: 'L1', phone: '+14042220190' }],
          unread_count: 2,
          participant_display_name: 'James Porter',
          preview: 'Is the 2BR still open?',
        }),
      ],
      NOW,
    );
    const u = items.find((i) => i.group === 'unreplied');
    expect(u?.refType).toBe('contact');
    expect(u?.refId).toBe('L1'); // → /contacts/L1
    expect(u?.who).toBe('James Porter');
    expect(u?.why).toBe('Is the 2BR still open?');
    expect(u?.tag).toBe('Contact - Landlord');
  });

  it('does not put a read conversation anywhere', () => {
    const items = buildTodayFromSources(
      [],
      [convOf({ conversationId: 'read', unread_count: 0, participant_display_name: 'Quiet' })],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  it('puts a follow_up-deadline placement in follow_ups (not needs_you_now)', () => {
    const items = buildTodayFromSources(
      [
        placementOf({
          placementId: 'fu',
          stage: 'awaiting_approval',
          next_deadline_type: 'follow_up',
          next_deadline_at: at(2 * HOUR),
        }),
      ],
      [],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.group).toBe('follow_ups');
    expect(items[0]?.tag).toBe('Placement - Awaiting approval');
  });

  it('DEFERS derived-stuck to the server: a stale placement with no deadline yields no rows', () => {
    // Stuck is no longer a next_deadline_type value — the backend derives it from
    // time-in-stage (STAGE_STUCK_THRESHOLDS) and folds a "Stuck — needs a check"
    // row into follow_ups on the authoritative /api/today. This FALLBACK omits the
    // derivation (no importable threshold source here), so a long-stale placement
    // carrying no deadline and no attention flag produces nothing.
    const items = buildTodayFromSources(
      [
        placementOf({
          placementId: 'stale',
          stage: 'awaiting_approval',
          stage_entered_at: at(-30 * DAY),
        }),
      ],
      [],
      NOW,
    );
    expect(items).toEqual([]);
  });

  it('returns groups in canonical order regardless of input order', () => {
    const items = buildTodayFromSources(
      [
        placementOf({ placementId: 'fu', stage: 'awaiting_approval', next_deadline_type: 'follow_up', next_deadline_at: at(DAY) }),
        placementOf({ placementId: 'need', next_deadline_type: 'rta_window', next_deadline_at: at(HOUR) }),
      ],
      [convOf({ conversationId: 'unrep', unread_count: 1, preview: 'hi', participant_display_name: 'X' })],
      NOW,
      [tourOf({ tourId: 'tour', scheduledAt: at(2 * HOUR) })],
    );
    expect(items.map((i) => i.group)).toEqual([
      'needs_you_now',
      'tours_today',
      'unreplied',
      'follow_ups',
    ]);
  });

  it('attention takes precedence over a follow-up deadline (needs_you_now only, not duplicated)', () => {
    const items = buildTodayFromSources(
      [
        placementOf({
          placementId: 'esc',
          stage: 'awaiting_approval',
          next_deadline_type: 'follow_up',
          next_deadline_at: at(DAY),
          attention: { reason: 'Send failed — needs a call', at: NOW.toISOString() },
        }),
      ],
      [],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.group).toBe('needs_you_now');
    expect(items[0]?.attention).toBe(true);
    expect(items[0]?.why).toMatch(/send failed/i);
    expect(items.some((i) => i.group === 'follow_ups')).toBe(false);
  });

  it('renders an unknown stage / deadline type literally rather than "undefined"', () => {
    const items = buildTodayFromSources(
      [
        placementOf({
          placementId: 'weird',
          // Flexible server doc: values outside the known enums.
          stage: 'archived' as PlacementItem['stage'],
          next_deadline_type: 'mystery' as PlacementItem['next_deadline_type'],
          next_deadline_at: at(HOUR),
        }),
      ],
      [],
      NOW,
    );
    expect(items[0]?.tag).toBe('Placement - archived');
    expect(items[0]?.why).toBe('Deadline');
    expect(items[0]?.why).not.toContain('undefined');
    expect(items[0]?.tag).not.toContain('undefined');
  });

  it('does not crash on a malformed deadline instant (sorts after valid ones)', () => {
    const items = buildTodayFromSources(
      [
        placementOf({ placementId: 'good', next_deadline_type: 'rta_window', next_deadline_at: at(HOUR) }),
        placementOf({ placementId: 'bad', next_deadline_type: 'rta_window', next_deadline_at: 'not-a-date' }),
      ],
      [],
      NOW,
    );
    expect(items).toHaveLength(2);
    // The valid-deadline row sorts before the malformed (null-sort) one.
    expect(items[0]?.refId).toBe('good');
    expect(items[1]?.refId).toBe('bad');
    expect(items[1]?.urgency).toBe('');
  });
});
