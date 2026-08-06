// The read-path compose-failure tally (S2 from the planner's adversarial review).
//
// SCOPE OF THIS FILE, stated honestly: it pins the HELPER's contract - zero
// failures emit nothing, N failures emit exactly ONE line carrying the count and
// the first offender. It does NOT prove the three routers actually use it; that
// wiring is held by typecheck (the signatures changed) plus the existing
// uncomposable-read-path tests in tourRemindersApi/contactTimeline, which still
// assert the degraded bodies. A reviewer wanting end-to-end proof would need a
// logger injected into makeWebhookHarness, which does not exist today.
import { describe, expect, it } from 'vitest';
import {
  flushComposeFailTally,
  newComposeFailTally,
  recordComposeFail,
} from '../src/lib/composeFailTally.js';

interface Captured {
  fields: Record<string, unknown>;
  msg: string;
}

/** Minimal Logger stand-in: only warn is exercised. */
function capturingLogger(): { warns: Captured[]; log: Parameters<typeof flushComposeFailTally>[1] } {
  const warns: Captured[] = [];
  const log = {
    warn: (fields: Record<string, unknown>, msg: string) => {
      warns.push({ fields, msg });
    },
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Parameters<typeof flushComposeFailTally>[1];
  return { warns, log };
}

const row = (reminderId: string) => ({ reminderId, kind: 'morning_of' });
const tour = (tourId: string) => ({ tourId });

describe('composeFailTally', () => {
  it('emits NOTHING when nothing failed (the overwhelmingly common case)', () => {
    const { warns, log } = capturingLogger();
    flushComposeFailTally(newComposeFailTally(), log, 'tour_reminders_list');
    expect(warns).toHaveLength(0);
  });

  it('emits exactly ONE warn for a whole ladder, carrying the count', () => {
    // The defect this replaces: one warn PER RUNG on endpoints that refetch on
    // every SSE burst, so a four-rung ladder buried the log.
    const { warns, log } = capturingLogger();
    const tally = newComposeFailTally();
    for (const id of ['rem-1', 'rem-2', 'rem-3', 'rem-4']) {
      recordComposeFail(tally, row(id), tour('tour-a'));
    }
    flushComposeFailTally(tally, log, 'contact_timeline_upcoming');

    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields['count']).toBe(4);
    expect(warns[0]!.fields['surface']).toBe('contact_timeline_upcoming');
  });

  it('keeps only the FIRST offender, not every id', () => {
    const { warns, log } = capturingLogger();
    const tally = newComposeFailTally();
    recordComposeFail(tally, row('rem-first'), tour('tour-first'));
    recordComposeFail(tally, row('rem-second'), tour('tour-second'));
    flushComposeFailTally(tally, log, 'group_thread_scheduled');

    expect(warns[0]!.fields['reminderId']).toBe('rem-first');
    expect(warns[0]!.fields['tourId']).toBe('tour-first');
    expect(JSON.stringify(warns[0]!.fields)).not.toContain('rem-second');
  });

  it('logs IDs and counts only - never a body, phone, or name', () => {
    const { warns, log } = capturingLogger();
    const tally = newComposeFailTally();
    recordComposeFail(tally, row('rem-1'), tour('tour-a'));
    flushComposeFailTally(tally, log, 'tour_reminders_list');

    expect(Object.keys(warns[0]!.fields).sort()).toEqual(
      ['count', 'reminderId', 'surface', 'tourId'].sort(),
    );
  });
});
