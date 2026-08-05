import { describe, expect, it } from 'vitest';
import {
  composeTourReminderBody,
  UncomposableReminderError,
} from '../src/messages/tourCopy.js';
import { analyzeSms } from '../src/lib/smsEncoding.js';

const NY = 'America/New_York';
const AT = '2026-07-23T19:00:00.000Z'; // Jul 23 15:00 EDT

const base = { scheduledAt: AT, timezone: NY } as const;

describe('composeTourReminderBody: rendered copy', () => {
  const addr = '412 Oak St Apt 2';

  it('confirmation names the address and the full date-time', () => {
    expect(composeTourReminderBody({ ...base, kind: 'confirmation', address: addr }))
      .toBe("Tour confirmed at 412 Oak St Apt 2 for Thu, Jul 23 at 3:00 PM. We'll text reminders as it gets closer.");
  });

  it('day_before says tomorrow AND the explicit date', () => {
    expect(composeTourReminderBody({ ...base, kind: 'day_before', address: addr }))
      .toBe('Reminder: tour at 412 Oak St Apt 2 is tomorrow, Thu, Jul 23 at 3:00 PM.');
  });

  it('morning_of uses the bare time', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of', address: addr }))
      .toBe('Good morning! Tour at 412 Oak St Apt 2 is today at 3:00 PM.');
  });

  it('en_route keeps its tenant-facing closing line', () => {
    expect(composeTourReminderBody({ ...base, kind: 'en_route', address: addr }))
      .toBe("Tour at 412 Oak St Apt 2 starts at 3:00 PM. Text us when you're on the way!");
  });

  it('no_show_checkin is untouched and token-free', () => {
    expect(composeTourReminderBody({ ...base, kind: 'no_show_checkin', address: addr }))
      .toBe('Hi! We noticed you may have missed your tour. Want to reschedule?');
  });
});

describe('composeTourReminderBody: the no-address variants', () => {
  it('drops the address clause cleanly - no double spaces, no stray {where}', () => {
    expect(composeTourReminderBody({ ...base, kind: 'confirmation' }))
      .toBe("Tour confirmed for Thu, Jul 23 at 3:00 PM. We'll text reminders as it gets closer.");
    expect(composeTourReminderBody({ ...base, kind: 'day_before' }))
      .toBe('Reminder: tour is tomorrow, Thu, Jul 23 at 3:00 PM.');
    expect(composeTourReminderBody({ ...base, kind: 'morning_of' }))
      .toBe('Good morning! Tour is today at 3:00 PM.');
    expect(composeTourReminderBody({ ...base, kind: 'en_route' }))
      .toBe("Tour starts at 3:00 PM. Text us when you're on the way!");
  });

  it('an all-empty structured address takes the no-address path', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of', address: {} }))
      .toBe('Good morning! Tour is today at 3:00 PM.');
  });

  it('a structured address contributes street only', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of',
      address: { line1: '412 Oak St', line2: 'Apt 2', city: 'Atlanta', state: 'GA', zip: '30312' },
    })).toBe('Good morning! Tour at 412 Oak St Apt 2 is today at 3:00 PM.');
  });

  it('a legacy string address passes through whole (D5 - what every seed looks like)', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', address: '350 Boulevard SE, Atlanta, GA 30312',
    })).toBe('Good morning! Tour at 350 Boulevard SE, Atlanta, GA 30312 is today at 3:00 PM.');
  });
});

describe('the ASCII boundary, pinned from BOTH sides (spec D6)', () => {
  it('OUR copy is ASCII and single-segment with the seeded address', () => {
    const NON_ASCII = /[^\x20-\x7e]/;
    for (const kind of ['confirmation', 'day_before', 'morning_of', 'en_route'] as const) {
      const body = composeTourReminderBody({
        ...base, kind, address: '350 Boulevard SE, Atlanta, GA 30312',
      });
      expect(body).not.toMatch(NON_ASCII);
      expect(analyzeSms(body).segments).toBe(1);
    }
  });

  it("THEIR data is NEVER sanitized - a non-ASCII address survives UNCHANGED", () => {
    // This is an anti-regression test against a future "helpful" normalizer.
    // Rewriting a landlord's address is the same category of mistake as stripping
    // the accent from a tenant named Jose. We accept the UCS-2 cost instead.
    const street = "O\u2019Brien Court caf\u00E9";
    const body = composeTourReminderBody({ ...base, kind: 'morning_of', address: street });
    expect(body).toContain(street);
    expect(analyzeSms(body).encoding).toBe('UCS-2');
  });
});

describe('composeTourReminderBody: scheduledAt is a precondition', () => {
  it('throws UncomposableReminderError on an unparseable instant', () => {
    expect(() => composeTourReminderBody({ ...base, kind: 'morning_of', scheduledAt: 'nope' }))
      .toThrow(UncomposableReminderError);
  });

  it('throws UncomposableReminderError on an empty instant', () => {
    expect(() => composeTourReminderBody({ ...base, kind: 'morning_of', scheduledAt: '' }))
      .toThrow(UncomposableReminderError);
  });

  it('the error names the tour-copy origin, not a bare RangeError', () => {
    try {
      composeTourReminderBody({ ...base, kind: 'morning_of', scheduledAt: 'nope' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UncomposableReminderError);
      expect((err as Error).name).toBe('UncomposableReminderError');
    }
  });
});
