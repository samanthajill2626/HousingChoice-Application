// Quiet shares builder (spec 2026-10-23-today-checklist-design.md 6, plan
// PR23): the quiet clock (sentAt, heard if later, reached if later), both
// thresholds and both boundaries, each row's own clock, grouping by property
// and ordering (PR103: no distinct-people count). Pure - the rows are
// WaitingFollowUp values built by hand, shaped as collectWaitingFollowUps
// returns them.
import { describe, expect, it } from 'vitest';
import type { ListingSendOutcome } from '../src/lib/listingSendOutcome.js';
import type { RecipientDisplay } from '../src/repos/contactsRepo.js';
import type { WaitingFollowUp } from '../src/services/followUps.js';
import { buildQuietShares, QUIET_NO_REPLY_MS, QUIET_REPLIED_MS } from '../src/services/quietShares.js';

const NOW = Date.parse('2026-10-24T15:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

interface RowSpec {
  contactId: string;
  outcome: ListingSendOutcome;
  sentAt: string;
  unitId?: string;
  unitLabel?: string;
  name?: string;
  type?: string;
  role?: string;
  heard?: string;
  reached?: string;
}

/** One core row: the Follow up item plus the recipient it was judged on. */
function row(o: RowSpec): WaitingFollowUp {
  const unitId = o.unitId ?? 'u1';
  const type = o.type ?? 'tenant';
  return {
    item: {
      unitId,
      unitLabel: o.unitLabel ?? `${unitId} label`,
      contactId: o.contactId,
      name: o.name ?? `Name ${o.contactId}`,
      type,
      ...(o.role !== undefined && { role: o.role }),
      sentAt: o.sentAt,
      ...(o.heard !== undefined && { lastHeardFromAt: o.heard }),
      outcome: o.outcome,
      interestedSupported: type === 'tenant',
      interestedMode: 'form',
      waitingSince: o.heard ?? o.sentAt,
    },
    recipient: {
      contactId: o.contactId,
      type: type as RecipientDisplay['type'],
      ...(o.heard !== undefined && { last_heard_from_at: o.heard }),
      ...(o.reached !== undefined && { last_reached_out_at: o.reached }),
    },
  };
}

/** [unitId, contactId, quietSince] per listed person, in output order. */
function listed(out: ReturnType<typeof buildQuietShares>): Array<[string, string, string]> {
  return out.properties.flatMap((p) =>
    p.people.map((person): [string, string, string] => [p.unitId, person.contactId, person.quietSince]),
  );
}

describe('buildQuietShares (spec 6.1-6.3)', () => {
  it('the thresholds are fixed durations: 48h after a reply, 120h with no reply', () => {
    expect(QUIET_REPLIED_MS).toBe(48 * HOUR);
    expect(QUIET_NO_REPLY_MS).toBe(120 * HOUR);
  });

  it('no_reply: shown at EXACTLY 120h since the send; hidden 1 ms before', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-at', outcome: 'no_reply', sentAt: ago(120 * HOUR) }),
        row({ contactId: 'c-before', outcome: 'no_reply', sentAt: ago(120 * HOUR - 1) }),
      ],
      NOW,
    );
    expect(listed(out)).toEqual([['u1', 'c-at', ago(120 * HOUR)]]);
  });

  it('replied: shown at EXACTLY 48h since the reply; hidden 1 ms before', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-at', outcome: 'replied', sentAt: ago(6 * DAY), heard: ago(48 * HOUR) }),
        row({ contactId: 'c-before', outcome: 'replied', sentAt: ago(6 * DAY), heard: ago(48 * HOUR - 1) }),
      ],
      NOW,
    );
    expect(listed(out)).toEqual([['u1', 'c-at', ago(48 * HOUR)]]);
  });

  it('each state uses its own threshold: 72h quiet lists a replied row, not a no_reply one', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-nr', outcome: 'no_reply', sentAt: ago(3 * DAY) }),
        row({ contactId: 'c-rep', outcome: 'replied', sentAt: ago(6 * DAY), heard: ago(3 * DAY) }),
      ],
      NOW,
    );
    expect(listed(out).map(([, id]) => id)).toEqual(['c-rep']);
  });

  it('heard LATER than sent restarts the clock; heard EARLIER than sent is ignored', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-late', outcome: 'replied', sentAt: ago(9 * DAY), heard: ago(1 * DAY) }),
        row({ contactId: 'c-early', outcome: 'no_reply', sentAt: ago(6 * DAY), heard: ago(8 * DAY) }),
      ],
      NOW,
    );
    expect(listed(out)).toEqual([['u1', 'c-early', ago(6 * DAY)]]);
  });

  it('reached LATER than sent restarts the clock without changing the state; reached EARLIER than sent is ignored', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-recent', outcome: 'no_reply', sentAt: ago(10 * DAY), reached: ago(4 * DAY) }),
        row({ contactId: 'c-old', outcome: 'no_reply', sentAt: ago(10 * DAY), reached: ago(6 * DAY) }),
        row({ contactId: 'c-before', outcome: 'no_reply', sentAt: ago(6 * DAY), reached: ago(7 * DAY) }),
        row({ contactId: 'c-rep', outcome: 'replied', sentAt: ago(9 * DAY), heard: ago(8 * DAY), reached: ago(3 * DAY) }),
      ],
      NOW,
    );
    // c-recent: 4 days since the outreach, under 5. c-old and c-before tie at
    // 6 days (outreach vs send) - ties by contactId. c-rep: the outreach is
    // later than the reply, so it is the clock.
    expect(listed(out)).toEqual([
      ['u1', 'c-rep', ago(3 * DAY)],
      ['u1', 'c-before', ago(6 * DAY)],
      ['u1', 'c-old', ago(6 * DAY)],
    ]);
    expect(out.properties[0]!.people.find((p) => p.contactId === 'c-old')!.state).toBe('no_reply');
  });

  it('an unparseable heard / reached value is ignored; an unparseable sentAt is never listed', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-x', outcome: 'no_reply', sentAt: ago(6 * DAY), heard: 'garbage', reached: 'not-a-date' }),
        row({ contactId: 'c-bad', outcome: 'no_reply', sentAt: 'garbage' }),
      ],
      NOW,
    );
    expect(listed(out)).toEqual([['u1', 'c-x', ago(6 * DAY)]]);
  });

  it('each share keeps its OWN clock: a second share to the same person does not restart the first', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-1', unitId: 'u-first', outcome: 'no_reply', sentAt: ago(6 * DAY) }),
        row({ contactId: 'c-1', unitId: 'u-second', outcome: 'no_reply', sentAt: ago(1 * DAY) }),
      ],
      NOW,
    );
    expect(listed(out)).toEqual([['u-first', 'c-1', ago(6 * DAY)]]);
  });

  it('inside a property: replied first, then no_reply; within each the longest quiet first; ties by contactId', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-nr-new', outcome: 'no_reply', sentAt: ago(6 * DAY) }),
        row({ contactId: 'c-rep-new', outcome: 'replied', sentAt: ago(9 * DAY), heard: ago(3 * DAY) }),
        row({ contactId: 'c-nr-old', outcome: 'no_reply', sentAt: ago(12 * DAY) }),
        row({ contactId: 'c-rep-old', outcome: 'replied', sentAt: ago(9 * DAY), heard: ago(5 * DAY) }),
        row({ contactId: 'c-nr-tie-b', outcome: 'no_reply', sentAt: ago(8 * DAY) }),
        row({ contactId: 'c-nr-tie-a', outcome: 'no_reply', sentAt: ago(8 * DAY) }),
      ],
      NOW,
    );
    expect(out.properties).toHaveLength(1);
    expect(out.properties[0]!.people.map((p) => p.contactId)).toEqual([
      'c-rep-old',
      'c-rep-new',
      'c-nr-old',
      'c-nr-tie-a',
      'c-nr-tie-b',
      'c-nr-new',
    ]);
  });

  it('properties are ordered by their longest-quiet person (oldest quietSince first, any state); ties by unitId', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-1', unitId: 'u-b', outcome: 'no_reply', sentAt: ago(6 * DAY) }),
        row({ contactId: 'c-2', unitId: 'u-c', outcome: 'replied', sentAt: ago(13 * DAY), heard: ago(10 * DAY) }),
        row({ contactId: 'c-3', unitId: 'u-a', outcome: 'no_reply', sentAt: ago(6 * DAY) }),
        row({ contactId: 'c-4', unitId: 'u-b', outcome: 'no_reply', sentAt: ago(11 * DAY) }),
        row({ contactId: 'c-5', unitId: 'u-d', outcome: 'no_reply', sentAt: ago(11 * DAY) }),
      ],
      NOW,
    );
    expect(out.properties.map((p) => p.unitId)).toEqual(['u-b', 'u-d', 'u-c', 'u-a']);
  });

  // PR103: no distinct-people count is built; the person still has a row
  // under each property, and the result carries nothing but `properties`.
  it('a person waiting on two properties has a row under each; the result holds properties only (PR103)', () => {
    const out = buildQuietShares(
      [
        row({ contactId: 'c-both', unitId: 'u-a', outcome: 'no_reply', sentAt: ago(7 * DAY) }),
        row({ contactId: 'c-both', unitId: 'u-b', outcome: 'no_reply', sentAt: ago(6 * DAY) }),
        row({ contactId: 'c-solo', unitId: 'u-b', outcome: 'no_reply', sentAt: ago(6 * DAY) }),
      ],
      NOW,
    );
    expect(Object.keys(out)).toEqual(['properties']);
    expect(listed(out)).toEqual([
      ['u-a', 'c-both', ago(7 * DAY)],
      ['u-b', 'c-both', ago(6 * DAY)],
      ['u-b', 'c-solo', ago(6 * DAY)],
    ]);
  });

  it('outcomes other than replied / no_reply are never listed, however quiet', () => {
    const out = buildQuietShares(
      (['interested', 'not_interested', 'signed_up'] as const).map((outcome) =>
        row({ contactId: `c-${outcome}`, outcome, sentAt: ago(13 * DAY) }),
      ),
      NOW,
    );
    expect(out).toEqual({ properties: [] });
  });

  it('the wire rows: the property keeps the Follow up unitLabel; a person carries name, type, role only when set, state and quietSince', () => {
    const label = '12 Oak St, Atlanta, GA 30303';
    const out = buildQuietShares(
      [
        row({ contactId: 'c-cw', unitLabel: label, name: 'Casey Worker', type: 'partner', role: 'Caseworker', outcome: 'replied', sentAt: ago(9 * DAY), heard: ago(4 * DAY) }),
        row({ contactId: 'c-ten', unitLabel: label, name: 'Tia Tenant', outcome: 'no_reply', sentAt: ago(6 * DAY) }),
      ],
      NOW,
    );
    expect(out).toEqual({
      properties: [
        {
          unitId: 'u1',
          unitLabel: label,
          people: [
            { contactId: 'c-cw', name: 'Casey Worker', type: 'partner', role: 'Caseworker', state: 'replied', quietSince: ago(4 * DAY) },
            { contactId: 'c-ten', name: 'Tia Tenant', type: 'tenant', state: 'no_reply', quietSince: ago(6 * DAY) },
          ],
        },
      ],
    });
    expect(out.properties[0]!.people[1]).not.toHaveProperty('role');
  });

  it('no rows: no properties', () => {
    expect(buildQuietShares([], NOW)).toEqual({ properties: [] });
  });
});
