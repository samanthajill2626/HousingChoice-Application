// The SHARED preview core (spec 6.1). These tests pin the rules the tour,
// placement, and standalone open previews must all obey - above all the count
// rule, whose de-dupe-then-filter order is easy to invert silently.
import { describe, expect, it } from 'vitest';
import {
  buildOpenPreviewFromParts,
  type OpenPreviewParts,
} from '../src/services/rosterEdits.js';
import type { QuietHoursWindow } from '../src/lib/quietHours.js';

/** 21:00 -> 08:00 America/New_York, the org default shape. */
const WINDOW: QuietHoursWindow = {
  enabled: true,
  start: '21:00',
  end: '08:00',
  timezone: 'America/New_York',
};

/** 18:00Z = 14:00 New York - comfortably outside the window. */
const QUIET_OFF = { nowIso: '2026-08-17T18:00:00.000Z', window: WINDOW };

describe('buildOpenPreviewFromParts', () => {
  it('counts a de-duplicated phone ONCE and by the FIRST member on it', () => {
    // Ada and Bo share a number; Ada is first and opted out. The phone is NOT
    // reachable just because Bo (later, same number) is - the de-dupe happens
    // BEFORE the reachable filter (spec 2.6). Guarding a silent behavior change
    // to the tour and placement previews.
    const parts: OpenPreviewParts = {
      bodyMembers: [{ name: 'Ada', memberKey: 'c-ada' }],
      recipients: [
        { name: 'Ada', memberKey: 'c-ada', reachability: 'opted_out' },
        { name: 'Bo', memberKey: 'c-bo', reachability: 'reachable' },
      ],
    };
    const preview = buildOpenPreviewFromParts(parts, QUIET_OFF);
    expect(preview.recipientCount).toBe(0);
    expect(preview.recipients).toHaveLength(2);
    expect(preview.deferred).toBe(false);
  });

  it('names only the body members in the intro, and lists every recipient', () => {
    const parts: OpenPreviewParts = {
      bodyMembers: [
        { name: 'Ada', memberKey: 'c-ada' },
        { name: 'Cy', memberKey: 'c-cy' },
      ],
      recipients: [
        { name: 'Ada Backfilled', memberKey: 'c-ada', reachability: 'reachable' },
        { name: 'Cy Backfilled', memberKey: 'c-cy', reachability: 'reachable' },
        { memberKey: 'phone:+15550100009', reachability: 'no_phone' },
      ],
    };
    const preview = buildOpenPreviewFromParts(parts, QUIET_OFF);
    expect(preview.body).toContain('Ada');
    expect(preview.body).toContain('Cy');
    expect(preview.body).not.toContain('Backfilled');
    expect(preview.recipients).toHaveLength(3);
    expect(preview.recipientCount).toBe(2);
  });

  it('never leaks a member key (or the phone inside one) into the recipients', () => {
    // toRecipient copies name + reachability ONLY. memberKey is an internal
    // join key and for a bare-phone member it IS the full E.164, so letting it
    // through would put a phone number in the confirm dialog.
    const preview = buildOpenPreviewFromParts(
      {
        bodyMembers: [{ memberKey: 'phone:+15550100009' }],
        recipients: [{ memberKey: 'phone:+15550100009', reachability: 'reachable' }],
      },
      QUIET_OFF,
    );
    expect(preview.recipients).toEqual([{ reachability: 'reachable' }]);
    expect(JSON.stringify(preview)).not.toContain('+15550100009');
  });

  it('reports quiet hours with the clamped end instant', () => {
    const preview = buildOpenPreviewFromParts(
      {
        bodyMembers: [{ name: 'Ada', memberKey: 'c-ada' }],
        recipients: [{ name: 'Ada', memberKey: 'c-ada', reachability: 'reachable' }],
      },
      // 03:00Z = 23:00 the previous evening in New York - inside the window.
      { nowIso: '2026-08-17T03:00:00.000Z', window: WINDOW },
    );
    expect(preview.deferred).toBe(true);
    expect(preview.quietEndsAt).toBeDefined();
  });
});
