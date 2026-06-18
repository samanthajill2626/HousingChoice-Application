import { describe, expect, it } from 'vitest';
import { buildTodayFromSources } from './buildToday.js';
import type { CaseItem, ConversationSummary } from '../../api/index.js';

// A fixed "now" in local time. Tests build deadlines/tours relative to it.
const NOW = new Date('2026-06-16T12:00:00');

function caseOf(partial: Partial<CaseItem> & Pick<CaseItem, 'caseId'>): CaseItem {
  return {
    tenantId: `t-${partial.caseId}`,
    unitId: `u-${partial.caseId}`,
    stage: 'touring',
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

describe('buildTodayFromSources', () => {
  it('puts a case with an upcoming deadline in needs_you_now with humanized urgency + tag', () => {
    const items = buildTodayFromSources(
      [caseOf({ caseId: 'k1', stage: 'touring', next_deadline_type: 'rta_window', next_deadline_at: at(2 * HOUR) })],
      [],
      NOW,
    );
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.group).toBe('needs_you_now');
    expect(item?.refType).toBe('case');
    expect(item?.refId).toBe('k1');
    expect(item?.urgency).toBe('2h left');
    expect(item?.tag).toBe('Case · Touring');
    expect(item?.why).toMatch(/RTA/i);
  });

  it('humanizes an overdue deadline and a multi-day deadline', () => {
    const items = buildTodayFromSources(
      [
        caseOf({ caseId: 'overdue', next_deadline_type: 'rta_window', next_deadline_at: at(-3 * HOUR) }),
        caseOf({ caseId: 'days', next_deadline_type: 'voucher_expiration', next_deadline_at: at(3 * DAY) }),
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
        caseOf({ caseId: 'later', next_deadline_type: 'rta_window', next_deadline_at: at(5 * DAY) }),
        caseOf({ caseId: 'soon', next_deadline_type: 'rta_window', next_deadline_at: at(1 * HOUR) }),
        caseOf({ caseId: 'past', next_deadline_type: 'rta_window', next_deadline_at: at(-1 * HOUR) }),
      ],
      [],
      NOW,
    );
    expect(items.map((i) => i.refId)).toEqual(['past', 'soon', 'later']);
  });

  it('flags an attention case in needs_you_now with attention:true (no deadline)', () => {
    const items = buildTodayFromSources(
      [
        caseOf({
          caseId: 'att',
          stage: 'applied',
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
    expect(items[0]?.tag).toBe('Case · Applied');
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
    expect(unk?.tag).toBe('Contact · Unknown');
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

  it('puts a case touring today in tours_today', () => {
    const items = buildTodayFromSources(
      [caseOf({ caseId: 'tour', stage: 'touring', tour_date: '2026-06-16' })],
      [],
      NOW,
    );
    const tour = items.find((i) => i.group === 'tours_today');
    expect(tour?.refId).toBe('tour');
    expect(tour?.why).toMatch(/Tour/);
    expect(tour?.tag).toBe('Case · Touring');
  });

  it('does not put a tour on a different day in tours_today', () => {
    const items = buildTodayFromSources(
      [caseOf({ caseId: 'tmrw', tour_date: '2026-06-17' })],
      [],
      NOW,
    );
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
    expect(u?.tag).toBe('Contact · Landlord');
  });

  it('does not put a read conversation anywhere', () => {
    const items = buildTodayFromSources(
      [],
      [convOf({ conversationId: 'read', unread_count: 0, participant_display_name: 'Quiet' })],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  it('puts a follow_up-deadline case in follow_ups (not needs_you_now)', () => {
    const items = buildTodayFromSources(
      [
        caseOf({
          caseId: 'fu',
          stage: 'applied',
          next_deadline_type: 'follow_up',
          next_deadline_at: at(2 * HOUR),
        }),
      ],
      [],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.group).toBe('follow_ups');
    expect(items[0]?.tag).toBe('Case · Applied');
  });

  it('puts a stuck_case in follow_ups', () => {
    const items = buildTodayFromSources(
      [caseOf({ caseId: 'stuck', stage: 'applied', next_deadline_type: 'stuck_case', next_deadline_at: at(-DAY) })],
      [],
      NOW,
    );
    const fu = items.find((i) => i.group === 'follow_ups');
    expect(fu?.refId).toBe('stuck');
    expect(fu?.why).toMatch(/stuck/i);
  });

  it('returns groups in canonical order regardless of input order', () => {
    const items = buildTodayFromSources(
      [
        caseOf({ caseId: 'fu', stage: 'applied', next_deadline_type: 'follow_up', next_deadline_at: at(DAY) }),
        caseOf({ caseId: 'tour', tour_date: '2026-06-16' }),
        caseOf({ caseId: 'need', next_deadline_type: 'rta_window', next_deadline_at: at(HOUR) }),
      ],
      [convOf({ conversationId: 'unrep', unread_count: 1, preview: 'hi', participant_display_name: 'X' })],
      NOW,
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
        caseOf({
          caseId: 'esc',
          stage: 'applied',
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
        caseOf({
          caseId: 'weird',
          // Flexible server doc: values outside the known enums.
          stage: 'archived' as CaseItem['stage'],
          next_deadline_type: 'mystery' as CaseItem['next_deadline_type'],
          next_deadline_at: at(HOUR),
        }),
      ],
      [],
      NOW,
    );
    expect(items[0]?.tag).toBe('Case · archived');
    expect(items[0]?.why).toBe('Deadline');
    expect(items[0]?.why).not.toContain('undefined');
    expect(items[0]?.tag).not.toContain('undefined');
  });

  it('does not crash on a malformed deadline instant (sorts after valid ones)', () => {
    const items = buildTodayFromSources(
      [
        caseOf({ caseId: 'good', next_deadline_type: 'rta_window', next_deadline_at: at(HOUR) }),
        caseOf({ caseId: 'bad', next_deadline_type: 'rta_window', next_deadline_at: 'not-a-date' }),
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
