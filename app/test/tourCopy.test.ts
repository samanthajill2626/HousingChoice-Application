import { describe, expect, it } from 'vitest';
import {
  composeTourReminderBody,
  UncomposableReminderError,
} from '../src/messages/tourCopy.js';
import { MESSAGE_CATALOG } from '../src/messages/catalog.js';

const NY = 'America/New_York';
const AT = '2026-07-23T19:00:00.000Z'; // Jul 23 15:00 EDT

const base = { scheduledAt: AT, timezone: NY } as const;

describe('composeTourReminderBody (behavior-neutral stage)', () => {
  // Task 9 replaces these with the real interpolated strings. Until then the
  // composer must return today's catalog copy EXACTLY, so every existing test
  // and every e2e body assertion keeps passing while the call sites are rewired.
  it('returns the current catalog default for each armed kind', () => {
    for (const kind of ['confirmation', 'day_before', 'morning_of', 'en_route'] as const) {
      expect(composeTourReminderBody({ ...base, kind, address: '412 Oak St' }))
        .toBe(MESSAGE_CATALOG[`tour.${kind}`].default);
    }
  });

  it('returns the same body with no address', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of' }))
      .toBe(MESSAGE_CATALOG['tour.morning_of'].default);
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
