// Unit tests for the listing-send OUTCOME rules (last-heard-from spec 5.4,
// 5.6, D11; section 14). Pure - no I/O (the listingSendTour.test.ts style).
import { describe, expect, it } from 'vitest';
import {
  deriveListingSendOutcome,
  effectiveDecline,
  FOLLOW_UP_LOOKBACK_MS,
  FOLLOW_UP_QUIET_MS,
  interestedModeFor,
  isEligibleRecipient,
  isWaiting,
  waitingSince,
  wireDecline,
  type DeclineRecord,
} from '../src/lib/listingSendOutcome.js';
import { deriveTourActivityAt, deriveTourSignal } from '../src/lib/listingSendTour.js';
import type { TourItem } from '../src/repos/toursRepo.js';

const SENT = '2026-10-01T12:00:00.000Z';
const BEFORE = '2026-09-30T12:00:00.000Z';
const AFTER = '2026-10-02T12:00:00.000Z';
const LATER = '2026-10-03T12:00:00.000Z';
const staff = (at: string): DeclineRecord => ({ at, by: 'staff', staffId: 'usr_x' });
const TOUR = { tourId: 't-1', state: 'requested' as const };

describe('constants', () => {
  it('quiet is 24 hours and lookback 14 days, in ms', () => {
    expect(FOLLOW_UP_QUIET_MS).toBe(86_400_000);
    expect(FOLLOW_UP_LOOKBACK_MS).toBe(14 * 86_400_000);
  });
});

describe('effectiveDecline (D11)', () => {
  it('no record -> false', () => {
    expect(effectiveDecline({ sentAt: SENT }, undefined)).toBe(false);
  });
  it('a decline at or after the send, no tour activity -> true (equal counts)', () => {
    expect(effectiveDecline({ sentAt: SENT, declined: staff(AFTER) }, undefined)).toBe(true);
    expect(effectiveDecline({ sentAt: SENT, declined: staff(SENT) }, undefined)).toBe(true);
  });
  it('a LATER counted share supersedes it (sentAt after declined.at) -> false', () => {
    expect(effectiveDecline({ sentAt: AFTER, declined: staff(SENT) }, undefined)).toBe(false);
  });
  it('no sentAt (never projected, but total) -> the send clause passes', () => {
    expect(effectiveDecline({ declined: staff(SENT) }, undefined)).toBe(true);
  });
  it('LATER tour activity supersedes it; equal activity does not', () => {
    expect(effectiveDecline({ sentAt: SENT, declined: staff(AFTER) }, LATER)).toBe(false);
    expect(effectiveDecline({ sentAt: SENT, declined: staff(AFTER) }, AFTER)).toBe(true);
    expect(effectiveDecline({ sentAt: SENT, declined: staff(AFTER) }, BEFORE)).toBe(true);
  });
  it('compares instants, not strings (a stored value without millis)', () => {
    expect(effectiveDecline({ sentAt: '2026-10-01T12:00:00Z', declined: staff('2026-10-01T12:00:00.000Z') }, undefined)).toBe(true);
    expect(effectiveDecline({ sentAt: '2026-10-01T12:00:00.500Z', declined: staff('2026-10-01T12:00:00Z') }, undefined)).toBe(false);
  });
  it('an unparseable declined.at never counts', () => {
    expect(effectiveDecline({ sentAt: SENT, declined: staff('not-a-date') }, undefined)).toBe(false);
  });
});

describe('deriveListingSendOutcome - precedence not_interested > interested > replied > no_reply', () => {
  const row = { sentAt: SENT };
  it('nothing heard, no tour -> no_reply', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: undefined, tour: undefined, tourActivityAt: undefined })).toBe('no_reply');
  });
  it('heard EXACTLY at the send -> no_reply (strictly after)', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: SENT, tour: undefined, tourActivityAt: undefined })).toBe('no_reply');
  });
  it('heard before the send -> no_reply', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: BEFORE, tour: undefined, tourActivityAt: undefined })).toBe('no_reply');
  });
  it('heard after the send -> replied', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: AFTER, tour: undefined, tourActivityAt: undefined })).toBe('replied');
  });
  it('a tenant with a qualifying tour -> interested, even after a reply', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: AFTER, tour: TOUR, tourActivityAt: SENT })).toBe('interested');
  });
  it('an effective decline beats the tour and the reply -> not_interested', () => {
    expect(deriveListingSendOutcome({ row: { sentAt: SENT, declined: staff(LATER) }, recipientType: 'tenant', lastHeardFromAt: AFTER, tour: TOUR, tourActivityAt: AFTER })).toBe('not_interested');
  });
  it('tour activity after the decline supersedes it -> interested', () => {
    expect(deriveListingSendOutcome({ row: { sentAt: SENT, declined: staff(AFTER) }, recipientType: 'tenant', lastHeardFromAt: undefined, tour: TOUR, tourActivityAt: LATER })).toBe('interested');
  });
  it('a later share supersedes the decline -> falls through to replied / no_reply', () => {
    expect(deriveListingSendOutcome({ row: { sentAt: AFTER, declined: staff(SENT) }, recipientType: 'tenant', lastHeardFromAt: LATER, tour: undefined, tourActivityAt: undefined })).toBe('replied');
    expect(deriveListingSendOutcome({ row: { sentAt: AFTER, declined: staff(SENT) }, recipientType: 'tenant', lastHeardFromAt: undefined, tour: undefined, tourActivityAt: undefined })).toBe('no_reply');
  });
  it('a PARTNER never reads a tour: the signal is ignored -> replied', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'partner', lastHeardFromAt: AFTER, tour: TOUR, tourActivityAt: AFTER })).toBe('replied');
  });
  it('a PARTNER decline is not superseded by tour activity it never reads -> not_interested', () => {
    expect(deriveListingSendOutcome({ row: { sentAt: SENT, declined: staff(AFTER) }, recipientType: 'partner', lastHeardFromAt: undefined, tour: TOUR, tourActivityAt: LATER })).toBe('not_interested');
  });
  it('an unknown recipient type (a missing contact) reads no tour -> no_reply', () => {
    expect(deriveListingSendOutcome({ row, recipientType: undefined, lastHeardFromAt: undefined, tour: TOUR, tourActivityAt: AFTER })).toBe('no_reply');
  });
});

// (PIN - spec 14.7, code review round 2 A R2-1) Tour supersession of a decline
// is DURABLE. KNOWING REWRITE of the round-1 "ADV-1 PIN", which pinned the
// opposite (a decline superseded only by a tour came back once that tour was
// canceled / no-show / closed not a fit) - that made the outcome depend on WHICH
// path created the tour (the Interested route deletes the record, POST
// /api/tours does not). Now a tour CREATED after the decline keeps it superseded
// whatever became of the tour, and a cancel / no-show / not-a-fit MARK never
// supersedes on its own. Raised for Cameron as reversible (one function).
// KNOWN LIMIT (spec 14.7, review round 3 A R3-1): only a tour's CREATION is
// durable. A qualifying tour created BEFORE the decline and rescheduled or
// reopened AFTER it supersedes the decline while it qualifies, but
// `lastMarkedAt` is one field, so a later cancel / no-show / not-a-fit mark
// overwrites the reschedule and the decline is effective again (the last
// case below). A durable revival would need the tours PATCH to clear the
// decline - a product call, not this function's.
describe('tour supersession of a decline is durable (spec 14.7 PIN - replaces the round-1 ADV-1 PIN)', () => {
  const BEFORE_DECLINE = '2026-06-30T18:00:00.000Z'; // T0 < T1
  const DECLINED = '2026-07-01T12:00:00.000Z'; // T1
  const CREATED = '2026-07-02T12:00:00.000Z'; // T2 > T1
  const MARKED = '2026-07-05T12:00:00.000Z'; // the later cancel / no-show / close
  const SENT_AT = '2026-06-30T12:00:00.000Z';
  const row = { sentAt: SENT_AT, declined: staff(DECLINED) };
  const pairTour = (over: Partial<TourItem>): TourItem =>
    ({ tourId: 't-1', tenantId: 'c-1', unitId: 'u-1', _schedPartition: 'tours', tourType: 'self_guided', status: 'requested', createdAt: CREATED, updatedAt: CREATED, ...over }) as TourItem;
  const outcomeWith = (tours: TourItem[], lastHeardFromAt?: string) =>
    deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt, tour: deriveTourSignal(tours), tourActivityAt: deriveTourActivityAt(tours) });
  const MARKS = [
    ['canceled', { status: 'canceled' }],
    ['no_show', { status: 'no_show' }],
    ['closed not a fit', { status: 'closed', outcome: 'not_a_fit' }],
  ] as const;

  it('decline T1, then a tour created T2 > T1 -> interested (the tour supersedes the decline)', () => {
    const tours = [pairTour({})];
    expect(effectiveDecline(row, deriveTourActivityAt(tours))).toBe(false);
    expect(outcomeWith(tours)).toBe('interested');
  });

  it.each(MARKS)('the same tour (created T2 > T1) later %s -> NOT not_interested (no_reply, or replied)', (_label, change) => {
    const tours = [pairTour({ ...change, lastMarkedAt: MARKED, updatedAt: MARKED })];
    expect(deriveTourSignal(tours)).toBeUndefined();
    expect(effectiveDecline(row, deriveTourActivityAt(tours))).toBe(false);
    expect(outcomeWith(tours)).toBe('no_reply');
    expect(outcomeWith(tours, '2026-07-03T12:00:00.000Z')).toBe('replied');
  });

  it.each(MARKS)('a tour created T0 < T1 and %s at T3 > T1 -> still not_interested (a MARK never supersedes)', (_label, change) => {
    const tours = [pairTour({ ...change, createdAt: BEFORE_DECLINE, lastMarkedAt: MARKED, updatedAt: MARKED })];
    expect(effectiveDecline(row, deriveTourActivityAt(tours))).toBe(true);
    expect(outcomeWith(tours)).toBe('not_interested');
  });

  it('contrast: a QUALIFYING tour created T0 < T1 and rescheduled at T3 > T1 supersedes (its mark counts)', () => {
    const tours = [pairTour({ status: 'scheduled', createdAt: BEFORE_DECLINE, lastMarkedAt: MARKED, updatedAt: MARKED })];
    expect(effectiveDecline(row, deriveTourActivityAt(tours))).toBe(false);
    expect(outcomeWith(tours)).toBe('interested');
  });

  it('known limit (A R3-1): a tour created T0 < T1, rescheduled after T1 -> interested; then canceled -> not_interested (the cancel overwrites the one lastMarkedAt)', () => {
    const RESCHEDULED = '2026-07-03T12:00:00.000Z'; // > T1
    const rescheduled = [pairTour({ status: 'scheduled', createdAt: BEFORE_DECLINE, lastMarkedAt: RESCHEDULED, updatedAt: RESCHEDULED })];
    expect(effectiveDecline(row, deriveTourActivityAt(rescheduled))).toBe(false);
    expect(outcomeWith(rescheduled)).toBe('interested');
    const canceled = [pairTour({ status: 'canceled', createdAt: BEFORE_DECLINE, lastMarkedAt: MARKED, updatedAt: MARKED })];
    expect(effectiveDecline(row, deriveTourActivityAt(canceled))).toBe(true);
    expect(outcomeWith(canceled)).toBe('not_interested');
  });
});

describe('wireDecline', () => {
  it('present only when the outcome is not_interested; never carries staffId', () => {
    expect(wireDecline({ declined: staff(AFTER) }, 'not_interested')).toEqual({ at: AFTER, by: 'staff' });
    expect(wireDecline({ declined: staff(AFTER) }, 'replied')).toBeUndefined();
    expect(wireDecline({}, 'not_interested')).toBeUndefined();
  });
});

describe('isEligibleRecipient (B6 - one rule, has-a-phone included)', () => {
  const base = { type: 'tenant', status: 'searching', phone: '+14045550100' };
  it('a reachable searching tenant is eligible', () => {
    expect(isEligibleRecipient(base)).toBe(true);
  });
  it.each([
    ['soft-deleted', { deleted_at: '2026-10-01T00:00:00.000Z' }],
    ['opted out', { sms_opt_out: true }],
    ['unreachable', { sms_unreachable: true }],
    ['no phone', { phone: undefined }],
    ['an empty phone', { phone: '' }],
    ['an inactive tenant', { status: 'inactive' }],
    ['a placed tenant', { status: 'placed' }],
  ])('%s is NOT eligible', (_label, over) => {
    expect(isEligibleRecipient({ ...base, ...over })).toBe(false);
  });
  it('an empty deleted_at is not deleted; false flags are not set', () => {
    expect(isEligibleRecipient({ ...base, deleted_at: '', sms_opt_out: false, sms_unreachable: false })).toBe(true);
  });
  it('the status clause is TENANT-only: a partner marked inactive/placed stays eligible', () => {
    expect(isEligibleRecipient({ type: 'partner', status: 'inactive', phone: '+14045550101' })).toBe(true);
    expect(isEligibleRecipient({ type: 'partner', status: 'placed', phone: '+14045550101' })).toBe(true);
  });
  it('a tenant with no status is eligible', () => {
    expect(isEligibleRecipient({ type: 'tenant', phone: '+14045550102' })).toBe(true);
  });
});

describe('interestedModeFor', () => {
  it("'route' with a structured tour_type, else 'form'", () => {
    expect(interestedModeFor({ tour_type: 'landlord_led' })).toBe('route');
    expect(interestedModeFor({})).toBe('form');
    expect(interestedModeFor({ tour_type: '' })).toBe('form');
  });
});

describe('isWaiting - all five clauses', () => {
  const sent = Date.parse('2026-10-01T12:00:00.000Z');
  const sentAt = '2026-10-01T12:00:00.000Z';
  const base = { outcome: 'no_reply' as const, eligible: true, sentAt };
  it('1. only no_reply / replied wait', () => {
    expect(isWaiting({ ...base, now: sent + 2 * 86_400_000 })).toBe(true);
    expect(isWaiting({ ...base, outcome: 'replied', lastHeardFromAt: '2026-10-01T13:00:00.000Z', now: sent + 3 * 86_400_000 })).toBe(true);
    expect(isWaiting({ ...base, outcome: 'interested', now: sent + 2 * 86_400_000 })).toBe(false);
    expect(isWaiting({ ...base, outcome: 'not_interested', now: sent + 2 * 86_400_000 })).toBe(false);
  });
  it('2. an ineligible recipient never waits', () => {
    expect(isWaiting({ ...base, eligible: false, now: sent + 2 * 86_400_000 })).toBe(false);
  });
  it('3. lookback: at exactly 14 days still waits, past it does not', () => {
    expect(isWaiting({ ...base, now: sent + FOLLOW_UP_LOOKBACK_MS })).toBe(true);
    expect(isWaiting({ ...base, now: sent + FOLLOW_UP_LOOKBACK_MS + 1 })).toBe(false);
  });
  it('4. quiet: at exactly 24 hours waits, before it does not', () => {
    expect(isWaiting({ ...base, now: sent + FOLLOW_UP_QUIET_MS })).toBe(true);
    expect(isWaiting({ ...base, now: sent + FOLLOW_UP_QUIET_MS - 1 })).toBe(false);
  });
  it('5. a reply after the send restarts the quiet window (max(sentAt, lastHeardFromAt))', () => {
    const heard = '2026-10-03T10:00:00.000Z';
    expect(isWaiting({ ...base, outcome: 'replied', lastHeardFromAt: heard, now: Date.parse(heard) + 2 * 3_600_000 })).toBe(false);
    expect(isWaiting({ ...base, outcome: 'replied', lastHeardFromAt: heard, now: Date.parse(heard) + FOLLOW_UP_QUIET_MS })).toBe(true);
    // A last-heard BEFORE the send does not move the window.
    expect(isWaiting({ ...base, lastHeardFromAt: '2026-09-20T00:00:00.000Z', now: sent + FOLLOW_UP_QUIET_MS })).toBe(true);
  });
});

describe('waitingSince', () => {
  it('the later of sentAt and lastHeardFromAt (sentAt when absent)', () => {
    expect(waitingSince(SENT)).toBe(SENT);
    expect(waitingSince(SENT, BEFORE)).toBe(SENT);
    expect(waitingSince(SENT, AFTER)).toBe(AFTER);
    expect(waitingSince(SENT, 'garbage')).toBe(SENT);
  });
});
