import { describe, expect, it } from 'vitest';
import {
  composeTourReminderBody,
  UncomposableReminderError,
} from '../src/messages/tourCopy.js';
import { analyzeSms } from '../src/lib/smsEncoding.js';
import type { Address } from '../src/lib/address.js';

const NY = 'America/New_York';
const AT = '2026-07-23T19:00:00.000Z'; // Jul 23 15:00 EDT

const base = { scheduledAt: AT, timezone: NY } as const;

describe('composeTourReminderBody: rendered copy', () => {
  const addr = '412 Oak St Apt 2';

  // Copy rewritten 2026-08-18 to the founder's voice (see catalog.ts). The
  // token contract is the part worth guarding here: confirmation carries the
  // full {when} because it can arrive weeks out, while day_before/morning_of
  // say "tomorrow"/"today" in the copy and so must render the BARE time - a
  // regression to {when} there reads "tomorrow at Thu, Jul 23 at 3:00 PM".
  it('confirmation names the address and the full date-time', () => {
    expect(composeTourReminderBody({ ...base, kind: 'confirmation', address: addr }))
      .toBe('Hey, your tour is set for Thu, Jul 23 at 3:00 PM at 412 Oak St Apt 2.');
  });

  it('day_before says tomorrow and the BARE time (never the full date)', () => {
    const body = composeTourReminderBody({ ...base, kind: 'day_before', address: addr });
    expect(body).toBe('Hey, confirming your tour tomorrow at 3:00 PM. Looking forward to having you tour!');
    expect(body, 'the date would double up with "tomorrow"').not.toContain('Jul 23');
  });

  it('morning_of uses the bare time', () => {
    const body = composeTourReminderBody({ ...base, kind: 'morning_of', address: addr });
    expect(body).toBe(
      'Good morning, excited for you to see 412 Oak St Apt 2 today at 3:00 PM. Let me know if your timing changes.',
    );
    expect(body, 'the date would double up with "today"').not.toContain('Jul 23');
  });

  it('en_route keeps its tenant-facing closing line', () => {
    expect(composeTourReminderBody({ ...base, kind: 'en_route', address: addr }))
      .toBe("Hey, see you soon at 412 Oak St Apt 2. Please let me know when you're on the way.");
  });

  it('no_show_checkin is token-free', () => {
    expect(composeTourReminderBody({ ...base, kind: 'no_show_checkin', address: addr }))
      .toBe('Hi! Do you need to reschedule?');
  });
});

describe('composeTourReminderBody: the no-address variants', () => {
  it('drops the address clause cleanly - no double spaces, no stray {where}', () => {
    expect(composeTourReminderBody({ ...base, kind: 'confirmation' }))
      .toBe('Hey, your tour is set for Thu, Jul 23 at 3:00 PM.');
    expect(composeTourReminderBody({ ...base, kind: 'day_before' }))
      .toBe('Hey, confirming your tour tomorrow at 3:00 PM. Looking forward to having you tour!');
    expect(composeTourReminderBody({ ...base, kind: 'morning_of' }))
      .toBe('Good morning, excited for you to see the home today at 3:00 PM. Let me know if your timing changes.');
    expect(composeTourReminderBody({ ...base, kind: 'en_route' }))
      .toBe("Hey, see you soon. Please let me know when you're on the way.");
  });

  // The addressless morning_of says "the home" - the TENANT-facing noun. Never
  // "property", which is the landlord/staff word (documentation/GLOSSARY.md).
  it('the addressless morning_of uses the tenant-facing noun, never "property"', () => {
    const body = composeTourReminderBody({ ...base, kind: 'morning_of' });
    expect(body).toContain('the home');
    expect(body).not.toContain('property');
  });

  it('an all-empty structured address takes the no-address path', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of', address: {} }))
      .toBe('Good morning, excited for you to see the home today at 3:00 PM. Let me know if your timing changes.');
  });

  it('a NULL address composes the _no_address variant instead of throwing', () => {
    // `address: null` is reachable at runtime even though the type says
    // optional: the seeds write unit items with a RAW PutCommand around
    // unitsRepo (which strips nulls). A TypeError here is NOT an
    // UncomposableReminderError, so no caller's containment block would catch it.
    expect(() => composeTourReminderBody({
      ...base, kind: 'morning_of', address: null as unknown as Address,
    })).not.toThrow();
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', address: null as unknown as Address,
    })).toBe('Good morning, excited for you to see the home today at 3:00 PM. Let me know if your timing changes.');
  });

  it('a structured address contributes street only', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of',
      address: { line1: '412 Oak St', line2: 'Apt 2', city: 'Atlanta', state: 'GA', zip: '30312' },
    })).toBe(
      'Good morning, excited for you to see 412 Oak St Apt 2 today at 3:00 PM. Let me know if your timing changes.',
    );
  });

  it('a legacy string address passes through whole (D5 - what every seed looks like)', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', address: '350 Boulevard SE, Atlanta, GA 30312',
    })).toBe(
      'Good morning, excited for you to see 350 Boulevard SE, Atlanta, GA 30312 today at 3:00 PM. Let me know if your timing changes.',
    );
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
