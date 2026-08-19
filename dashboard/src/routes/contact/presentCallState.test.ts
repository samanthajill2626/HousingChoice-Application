import { describe, it, expect } from 'vitest';
import type { CallOutcome, CallStatus, MessageDirection } from '../../api/index.js';
import {
  presentCallState,
  IN_PROGRESS_STALE_MS,
  RINGING_STALE_MS,
  type CallStatePresentation,
  type CallTone,
} from './presentCallState.js';

// The evaluation instant every case is written against. `at` is always derived
// from it so a case says its AGE, which is what the clauses actually key on.
const NOW = Date.parse('2026-08-18T15:00:00.000Z');
/** Younger than both windows (90s ringing, 15min in-progress). */
const FRESH_AGE_MS = 10_000;
/** Older than both windows. */
const STALE_AGE_MS = 20 * 60_000;

const DIRECTIONS: MessageDirection[] = ['inbound', 'outbound'];

/** One matrix cell: the label/tone expected, plus which stale window (if any)
 *  the returned `staleAt` must come from. */
interface Expect {
  label?: string;
  tone?: CallTone;
  stale?: 'ring' | 'prog';
}

const NONE: Expect = {};
const VOICEMAIL: Expect = { label: 'Voicemail', tone: 'warning' };
const NOT_COMPLETED: Expect = { label: 'Not completed', tone: 'neutral' };
const RINGING: Expect = { label: 'Ringing...', tone: 'neutral', stale: 'ring' };
const NO_TEAM_ANSWER: Expect = { label: 'No team answer', tone: 'danger' };
const IN_PROGRESS: Expect = { label: 'In progress', tone: 'neutral', stale: 'prog' };
const OUTCOME_UNKNOWN: Expect = { label: 'Outcome unknown', tone: 'neutral' };
const ANSWERED: Expect = { label: 'Answered', tone: 'success' };
const MISSED: Expect = { label: 'Missed', tone: 'danger' };
const CONNECTED: Expect = { label: 'Connected', tone: 'success' };
const NO_ANSWER: Expect = { label: 'No answer', tone: 'danger' };

interface MatrixRow {
  status: CallStatus | undefined;
  outcome: CallOutcome | undefined;
  fresh: boolean;
  inbound: Expect;
  outbound: Expect;
}

// The FULL matrix from spec section 9: both directions x every callStatus
// (including absent) x every callOutcome (including absent) x fresh/stale.
// Written out literally rather than derived, so a re-implementation of the
// clause order in the test cannot agree with a broken implementation.
const MATRIX: MatrixRow[] = [
  // --- no status: only the outcome clauses can fire ---
  { status: undefined, outcome: undefined, fresh: true, inbound: NONE, outbound: NONE },
  { status: undefined, outcome: undefined, fresh: false, inbound: NONE, outbound: NONE },
  { status: undefined, outcome: 'answered', fresh: true, inbound: ANSWERED, outbound: CONNECTED },
  { status: undefined, outcome: 'answered', fresh: false, inbound: ANSWERED, outbound: CONNECTED },
  { status: undefined, outcome: 'missed', fresh: true, inbound: MISSED, outbound: NO_ANSWER },
  { status: undefined, outcome: 'missed', fresh: false, inbound: MISSED, outbound: NO_ANSWER },
  { status: undefined, outcome: 'voicemail', fresh: true, inbound: VOICEMAIL, outbound: VOICEMAIL },
  { status: undefined, outcome: 'voicemail', fresh: false, inbound: VOICEMAIL, outbound: VOICEMAIL },

  // --- ringing: age-bounded, then direction-split ---
  { status: 'ringing', outcome: undefined, fresh: true, inbound: RINGING, outbound: RINGING },
  { status: 'ringing', outcome: undefined, fresh: false, inbound: MISSED, outbound: NO_TEAM_ANSWER },
  { status: 'ringing', outcome: 'answered', fresh: true, inbound: RINGING, outbound: RINGING },
  { status: 'ringing', outcome: 'answered', fresh: false, inbound: MISSED, outbound: NO_TEAM_ANSWER },
  { status: 'ringing', outcome: 'missed', fresh: true, inbound: RINGING, outbound: RINGING },
  { status: 'ringing', outcome: 'missed', fresh: false, inbound: MISSED, outbound: NO_TEAM_ANSWER },
  { status: 'ringing', outcome: 'voicemail', fresh: true, inbound: VOICEMAIL, outbound: VOICEMAIL },
  { status: 'ringing', outcome: 'voicemail', fresh: false, inbound: VOICEMAIL, outbound: VOICEMAIL },

  // --- in-progress: age-bounded, then the I1 asymmetry - but the STALE arm
  //     defers to a stored outcome, because `in-progress` + an outcome really
  //     co-exist (the server folds Twilio's `answered` onto `in-progress` while
  //     the same handler stamps `call_outcome: 'answered'`). The FRESH arm does
  //     NOT defer: a live call reads "In progress" whatever is on the row.
  { status: 'in-progress', outcome: undefined, fresh: true, inbound: IN_PROGRESS, outbound: IN_PROGRESS },
  { status: 'in-progress', outcome: undefined, fresh: false, inbound: ANSWERED, outbound: OUTCOME_UNKNOWN },
  { status: 'in-progress', outcome: 'answered', fresh: true, inbound: IN_PROGRESS, outbound: IN_PROGRESS },
  { status: 'in-progress', outcome: 'answered', fresh: false, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'in-progress', outcome: 'missed', fresh: true, inbound: IN_PROGRESS, outbound: IN_PROGRESS },
  { status: 'in-progress', outcome: 'missed', fresh: false, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'in-progress', outcome: 'voicemail', fresh: true, inbound: VOICEMAIL, outbound: VOICEMAIL },
  { status: 'in-progress', outcome: 'voicemail', fresh: false, inbound: VOICEMAIL, outbound: VOICEMAIL },

  // --- completed: terminal, but NOT clause 2 (the dev transcript seam) ---
  { status: 'completed', outcome: undefined, fresh: true, inbound: NONE, outbound: NONE },
  { status: 'completed', outcome: undefined, fresh: false, inbound: NONE, outbound: NONE },
  { status: 'completed', outcome: 'answered', fresh: true, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'completed', outcome: 'answered', fresh: false, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'completed', outcome: 'missed', fresh: true, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'completed', outcome: 'missed', fresh: false, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'completed', outcome: 'voicemail', fresh: true, inbound: VOICEMAIL, outbound: VOICEMAIL },
  { status: 'completed', outcome: 'voicemail', fresh: false, inbound: VOICEMAIL, outbound: VOICEMAIL },

  // --- no-answer ---
  { status: 'no-answer', outcome: undefined, fresh: true, inbound: NONE, outbound: NONE },
  { status: 'no-answer', outcome: undefined, fresh: false, inbound: NONE, outbound: NONE },
  { status: 'no-answer', outcome: 'answered', fresh: true, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'no-answer', outcome: 'answered', fresh: false, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'no-answer', outcome: 'missed', fresh: true, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'no-answer', outcome: 'missed', fresh: false, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'no-answer', outcome: 'voicemail', fresh: true, inbound: VOICEMAIL, outbound: VOICEMAIL },
  { status: 'no-answer', outcome: 'voicemail', fresh: false, inbound: VOICEMAIL, outbound: VOICEMAIL },

  // --- busy ---
  { status: 'busy', outcome: undefined, fresh: true, inbound: NONE, outbound: NONE },
  { status: 'busy', outcome: undefined, fresh: false, inbound: NONE, outbound: NONE },
  { status: 'busy', outcome: 'answered', fresh: true, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'busy', outcome: 'answered', fresh: false, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'busy', outcome: 'missed', fresh: true, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'busy', outcome: 'missed', fresh: false, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'busy', outcome: 'voicemail', fresh: true, inbound: VOICEMAIL, outbound: VOICEMAIL },
  { status: 'busy', outcome: 'voicemail', fresh: false, inbound: VOICEMAIL, outbound: VOICEMAIL },

  // --- failed ---
  { status: 'failed', outcome: undefined, fresh: true, inbound: NONE, outbound: NONE },
  { status: 'failed', outcome: undefined, fresh: false, inbound: NONE, outbound: NONE },
  { status: 'failed', outcome: 'answered', fresh: true, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'failed', outcome: 'answered', fresh: false, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'failed', outcome: 'missed', fresh: true, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'failed', outcome: 'missed', fresh: false, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'failed', outcome: 'voicemail', fresh: true, inbound: VOICEMAIL, outbound: VOICEMAIL },
  { status: 'failed', outcome: 'voicemail', fresh: false, inbound: VOICEMAIL, outbound: VOICEMAIL },

  // --- canceled: clause 2 ONLY when no outcome came with it (D12 signature) ---
  { status: 'canceled', outcome: undefined, fresh: true, inbound: NOT_COMPLETED, outbound: NOT_COMPLETED },
  { status: 'canceled', outcome: undefined, fresh: false, inbound: NOT_COMPLETED, outbound: NOT_COMPLETED },
  { status: 'canceled', outcome: 'answered', fresh: true, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'canceled', outcome: 'answered', fresh: false, inbound: ANSWERED, outbound: CONNECTED },
  { status: 'canceled', outcome: 'missed', fresh: true, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'canceled', outcome: 'missed', fresh: false, inbound: MISSED, outbound: NO_ANSWER },
  { status: 'canceled', outcome: 'voicemail', fresh: true, inbound: VOICEMAIL, outbound: VOICEMAIL },
  { status: 'canceled', outcome: 'voicemail', fresh: false, inbound: VOICEMAIL, outbound: VOICEMAIL },
];

function startedMsFor(fresh: boolean): number {
  return NOW - (fresh ? FRESH_AGE_MS : STALE_AGE_MS);
}

function wanted(e: Expect, startedMs: number): CallStatePresentation {
  return {
    ...(e.label !== undefined && { label: e.label, tone: e.tone }),
    ...(e.stale !== undefined && {
      staleAt: startedMs + (e.stale === 'ring' ? RINGING_STALE_MS : IN_PROGRESS_STALE_MS),
    }),
  };
}

function callFor(row: MatrixRow, direction: MessageDirection): CallStatePresentation {
  const startedMs = startedMsFor(row.fresh);
  return presentCallState({
    direction,
    ...(row.status !== undefined && { callStatus: row.status }),
    ...(row.outcome !== undefined && { callOutcome: row.outcome }),
    at: new Date(startedMs).toISOString(),
    now: NOW,
  });
}

describe('presentCallState - the full direction x status x outcome x age matrix', () => {
  for (const row of MATRIX) {
    const name = `status=${row.status ?? 'absent'} outcome=${row.outcome ?? 'absent'} ${
      row.fresh ? 'fresh' : 'stale'
    }`;
    it(name, () => {
      const startedMs = startedMsFor(row.fresh);
      expect(callFor(row, 'inbound')).toEqual(wanted(row.inbound, startedMs));
      expect(callFor(row, 'outbound')).toEqual(wanted(row.outbound, startedMs));
    });
  }
});

describe('presentCallState - staleAt discipline', () => {
  it('never returns a staleAt at or before the `now` it was given', () => {
    let seen = 0;
    for (const row of MATRIX) {
      for (const direction of DIRECTIONS) {
        const { staleAt } = callFor(row, direction);
        if (staleAt !== undefined) {
          seen += 1;
          expect(staleAt).toBeGreaterThan(NOW);
        }
      }
    }
    // Guard the guard: if the presenter stopped returning staleAt entirely, the
    // loop above would pass vacuously.
    expect(seen).toBeGreaterThan(0);
  });

  it('returns a staleAt ONLY from the fresh arms of the ringing / in-progress clauses', () => {
    const startedMs = startedMsFor(true);
    const at = new Date(startedMs).toISOString();
    expect(
      presentCallState({ direction: 'outbound', callStatus: 'ringing', at, now: NOW }).staleAt,
    ).toBe(startedMs + RINGING_STALE_MS);
    expect(
      presentCallState({ direction: 'outbound', callStatus: 'in-progress', at, now: NOW }).staleAt,
    ).toBe(startedMs + IN_PROGRESS_STALE_MS);
    // Terminal / outcome-driven clauses schedule nothing.
    expect(
      presentCallState({
        direction: 'outbound',
        callStatus: 'completed',
        callOutcome: 'answered',
        at,
        now: NOW,
      }).staleAt,
    ).toBeUndefined();
    expect(
      presentCallState({ direction: 'inbound', callStatus: 'canceled', at, now: NOW }).staleAt,
    ).toBeUndefined();
  });

  it('uses 90s for ringing and 15min for in-progress', () => {
    expect(RINGING_STALE_MS).toBe(90_000);
    expect(IN_PROGRESS_STALE_MS).toBe(900_000);
  });
});

describe('presentCallState - the cases the matrix axes do not cover', () => {
  it('makes NO age-based claim when `at` does not parse (a ringing row goes blank)', () => {
    for (const direction of DIRECTIONS) {
      const res = presentCallState({
        direction,
        callStatus: 'ringing',
        at: '',
        now: NOW,
      });
      expect(res).toEqual({});
      expect(res.label).toBeUndefined();
      expect(res.tone).toBeUndefined();
      expect(res.staleAt).toBeUndefined();
    }
  });

  it('falls THROUGH clauses 3 and 4 to the outcome clauses on an unparseable `at`', () => {
    expect(
      presentCallState({
        direction: 'outbound',
        callStatus: 'in-progress',
        callOutcome: 'missed',
        at: 'not-a-timestamp',
        now: NOW,
      }),
    ).toEqual({ label: 'No answer', tone: 'danger' });
  });

  it('never relabels a row that already reached `answered` (I3 - forward-only)', () => {
    // The human's own case: answered at 30 seconds, looked at 200 seconds later.
    const startedMs = NOW - 30_000;
    const at = new Date(startedMs).toISOString();
    const later = startedMs + 200_000;
    expect(
      presentCallState({
        direction: 'outbound',
        callStatus: 'completed',
        callOutcome: 'answered',
        at,
        now: later,
      }),
    ).toEqual({ label: 'Connected', tone: 'success' });
    expect(
      presentCallState({
        direction: 'inbound',
        callStatus: 'completed',
        callOutcome: 'answered',
        at,
        now: later,
      }),
    ).toEqual({ label: 'Answered', tone: 'success' });
  });

  it('does NOT read a terminal `completed` with no outcome as "Not completed" (dev transcript seam)', () => {
    for (const direction of DIRECTIONS) {
      const res = presentCallState({
        direction,
        callStatus: 'completed',
        at: new Date(startedMsFor(false)).toISOString(),
        now: NOW,
      });
      expect(res.label).toBeUndefined();
      expect(res).toEqual({});
    }
  });

  it('does NOT read a `canceled` row that DOES carry an outcome as "Not completed"', () => {
    const at = new Date(startedMsFor(false)).toISOString();
    expect(
      presentCallState({ direction: 'outbound', callStatus: 'canceled', callOutcome: 'missed', at, now: NOW }),
    ).toEqual({ label: 'No answer', tone: 'danger' });
    expect(
      presentCallState({ direction: 'inbound', callStatus: 'canceled', callOutcome: 'answered', at, now: NOW }),
    ).toEqual({ label: 'Answered', tone: 'success' });
    expect(
      presentCallState({ direction: 'outbound', callStatus: 'canceled', callOutcome: 'voicemail', at, now: NOW }),
    ).toEqual({ label: 'Voicemail', tone: 'warning' });
  });

  it('says "Outcome unknown" on a stale OUTBOUND in-progress row with NO outcome - never "Connected" (I1)', () => {
    const res = presentCallState({
      direction: 'outbound',
      callStatus: 'in-progress',
      at: new Date(startedMsFor(false)).toISOString(),
      now: NOW,
    });
    expect(res).toEqual({ label: 'Outcome unknown', tone: 'neutral' });
    expect(res.label).not.toBe('Connected');
    expect(res.label).not.toBe('Answered');
  });

  it('holds the fresh label right up to the window edge and flips one ms later', () => {
    const startedMs = NOW - RINGING_STALE_MS;
    const at = new Date(startedMs).toISOString();
    // age === 90s exactly is already STALE (the window is `age < 90s`).
    expect(presentCallState({ direction: 'outbound', callStatus: 'ringing', at, now: NOW })).toEqual({
      label: 'No team answer',
      tone: 'danger',
    });
    expect(
      presentCallState({ direction: 'outbound', callStatus: 'ringing', at, now: NOW - 1 }),
    ).toEqual({ label: 'Ringing...', tone: 'neutral', staleAt: startedMs + RINGING_STALE_MS });
  });

  it('lets a voicemail outcome win over a live-looking status (clause 1 is first)', () => {
    const at = new Date(startedMsFor(true)).toISOString();
    expect(
      presentCallState({
        direction: 'inbound',
        callStatus: 'in-progress',
        callOutcome: 'voicemail',
        at,
        now: NOW,
      }),
    ).toEqual({ label: 'Voicemail', tone: 'warning' });
  });
});

// `mapCallStatus` folds Twilio's `DialCallStatus: 'answered'` onto
// `call_status: 'in-progress'` while the SAME handler stamps
// `call_outcome: 'answered'`, so a row genuinely carries both at once. Clause 4
// keys on the STATUS, so without a deferral its stale arm returned before clause
// 5 could read the OUTCOME - stranding a call whose result we DID learn on
// "Outcome unknown", the label that exists to say we never learned it.
describe('presentCallState - clause 4 defers to a stored outcome once stale', () => {
  const staleAtIso = new Date(startedMsFor(false)).toISOString();
  const freshAtIso = new Date(startedMsFor(true)).toISOString();

  it('renders "Connected" on a stale OUTBOUND in-progress row that stored `answered`', () => {
    expect(
      presentCallState({
        direction: 'outbound',
        callStatus: 'in-progress',
        callOutcome: 'answered',
        at: staleAtIso,
        now: NOW,
      }),
    ).toEqual({ label: 'Connected', tone: 'success' });
  });

  it('renders "Answered" on a stale INBOUND in-progress row that stored `answered`', () => {
    expect(
      presentCallState({
        direction: 'inbound',
        callStatus: 'in-progress',
        callOutcome: 'answered',
        at: staleAtIso,
        now: NOW,
      }),
    ).toEqual({ label: 'Answered', tone: 'success' });
  });

  it('still says "Outcome unknown" on a stale OUTBOUND in-progress row with NO outcome (I1 guard)', () => {
    const res = presentCallState({
      direction: 'outbound',
      callStatus: 'in-progress',
      at: staleAtIso,
      now: NOW,
    });
    expect(res).toEqual({ label: 'Outcome unknown', tone: 'neutral' });
    // The deferral must not weaken I1: press-1 on an originate is the
    // navigator's OWN leg, so with no stored outcome we know nothing about the
    // target and must never claim a connection.
    expect(res.label).not.toBe('Connected');
  });

  it('leaves the FRESH arm alone - a live call reads "In progress" even with an outcome stored', () => {
    const startedMs = startedMsFor(true);
    for (const direction of DIRECTIONS) {
      for (const outcome of ['answered', 'missed'] as const) {
        expect(
          presentCallState({
            direction,
            callStatus: 'in-progress',
            callOutcome: outcome,
            at: freshAtIso,
            now: NOW,
          }),
        ).toEqual({
          label: 'In progress',
          tone: 'neutral',
          staleAt: startedMs + IN_PROGRESS_STALE_MS,
        });
      }
    }
  });
});

// The sort keys in this codebase are `<ISO>#<collision suffix>` - a shape
// `Date.parse` cannot read. The projection's `atOf` strips the suffix before it
// reaches this surface today, so this is a consistency guard: a future producer
// handing over a raw sort key must not silently disable the age-based clauses.
describe('presentCallState - `<ISO>#<suffix>` sort keys normalise like their ISO prefix', () => {
  it('treats a sort key exactly as its clean ISO prefix (fresh and stale, both clauses)', () => {
    for (const fresh of [true, false]) {
      const startedMs = startedMsFor(fresh);
      const iso = new Date(startedMs).toISOString();
      const sortKey = `${iso}#0001`;
      for (const direction of DIRECTIONS) {
        for (const status of ['ringing', 'in-progress'] as const) {
          expect(presentCallState({ direction, callStatus: status, at: sortKey, now: NOW })).toEqual(
            presentCallState({ direction, callStatus: status, at: iso, now: NOW }),
          );
        }
      }
    }
  });

  it('reads a sort key as a live "Ringing..." rather than falling through to no chip', () => {
    const startedMs = startedMsFor(true);
    expect(
      presentCallState({
        direction: 'inbound',
        callStatus: 'ringing',
        at: `${new Date(startedMs).toISOString()}#0001`,
        now: NOW,
      }),
    ).toEqual({ label: 'Ringing...', tone: 'neutral', staleAt: startedMs + RINGING_STALE_MS });
  });
});
