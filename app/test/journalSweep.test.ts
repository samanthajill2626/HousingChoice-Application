// The sanctioned daily abandoned-journal sweep (log-hygiene spec section 9).
//
// What this file is really pinning is the LEVEL MAPPING, because the mission
// that added this duty is about log noise: a cap or page bound is routine rate
// limiting and logs INFO (a standing daily alarm nothing can clear is exactly
// the noise class being removed), while a claimed-then-failed run and a
// contact whose journals survive recovery are ERROR. A transient claim blip is
// WARN, because the next 30s poll retries it.
//
// The second thing pinned is the CURSOR POLICY: it always advances past pages
// the run has read and never rewinds - a rewind livelocks on a page of
// persistently-failing contacts - and it is cleared on exhaustion so the cycle
// wraps. Rows dropped because the cap filled are re-found on the wrap.
//
// All four deps are plain object fakes; the pages are ROWS-SPARSE like a real
// page (mostly tombstones and completed rows), except the cap test, whose page
// is deliberately dense.
import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../src/lib/events.js';
import { JOURNAL_SWEEP_LAST_RUN_AT_ID } from '../src/repos/settingsRepo.js';
import type { ActiveResolutionRow } from '../src/repos/suggestionResolutionRepo.js';
import {
  runJournalSweep,
  JOURNAL_SWEEP_MIN_AGE_MS,
  JOURNAL_SWEEP_PERIOD_MS,
  MAX_CONTACTS_PER_RUN,
  MAX_RECOVERY_CALLS_PER_RUN,
  MAX_SCAN_PAGES,
  SCAN_PAGE_LIMIT,
  SWEEP_MAX_ATTEMPTS_PER_CALL,
  type JournalSweepDeps,
} from '../src/jobs/journalSweep.js';

const NOW = '2026-08-25T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const hoursAgo = (hours: number): string => new Date(NOW_MS - hours * 3_600_000).toISOString();

type Page = { rows: ActiveResolutionRow[]; nextCursor?: string };
type Journal = { state: string; leaseExpiresAt?: string; claimedAt?: string };

/** A qualifying row by default: lease long expired, claimed well over a day ago. */
function row(over: Partial<ActiveResolutionRow> = {}): ActiveResolutionRow {
  return {
    contactId: 'contact-1',
    target: 'pets',
    leaseExpiresAt: hoursAgo(25),
    claimedAt: hoursAgo(25),
    ...over,
  };
}

interface SweepHarness {
  deps: JournalSweepDeps;
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  emit: ReturnType<typeof vi.fn>;
  claims: Array<{ id: string; at: string; notBefore: string }>;
  cursorPuts: Array<string | undefined>;
  pageCalls: Array<{ cursor?: string; limit: number }>;
  recoverCalls: Array<{ contactId: string; opts?: { maxAttempts?: number } }>;
  journalCalls: string[];
}

function harness(opts: {
  pages?: Page[];
  storedCursor?: string;
  claim?: (id: string, at: string, notBefore: string) => Promise<boolean>;
  recover?: (contactId: string) => Promise<{ recovered: number; stateChanged: boolean }>;
  journals?: (contactId: string) => Promise<Journal[]>;
  listRows?: (o: { cursor?: string; limit: number }) => Promise<Page>;
} = {}): SweepHarness {
  const pages = opts.pages ?? [{ rows: [row()] }];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const emit = vi.fn();
  const claims: SweepHarness['claims'] = [];
  const cursorPuts: Array<string | undefined> = [];
  const pageCalls: SweepHarness['pageCalls'] = [];
  const recoverCalls: SweepHarness['recoverCalls'] = [];
  const journalCalls: string[] = [];
  let storedCursor = opts.storedCursor;

  const deps: JournalSweepDeps = {
    settingsRepo: {
      async claimGroupPeriod(id, at, notBefore) {
        claims.push({ id, at, notBefore });
        return opts.claim === undefined ? true : opts.claim(id, at, notBefore);
      },
      async getJournalSweepCursor() {
        return storedCursor;
      },
      async putJournalSweepCursor(cursor) {
        cursorPuts.push(cursor);
        storedCursor = cursor;
      },
    },
    resolutionRepo: {
      async listActiveResolutionRows(o) {
        pageCalls.push({ ...(o.cursor !== undefined && { cursor: o.cursor }), limit: o.limit });
        if (opts.listRows !== undefined) return opts.listRows(o);
        const page = pages[pageCalls.length - 1];
        if (page === undefined) throw new Error('sweep read past the pages the test seeded');
        return page;
      },
      async listJournals(contactId) {
        journalCalls.push(contactId);
        const journals = opts.journals === undefined ? [] : await opts.journals(contactId);
        return journals as never;
      },
    },
    resolutionService: {
      async recoverAbandoned(contactId, recoverOpts) {
        recoverCalls.push({ contactId, ...(recoverOpts !== undefined && { opts: recoverOpts }) });
        return opts.recover === undefined
          ? { recovered: 0, stateChanged: false }
          : opts.recover(contactId);
      },
    },
    events: { emit, on: vi.fn(), off: vi.fn(), listenerCount: () => 0 } as unknown as EventBus,
    logger: log as never,
  };
  return { deps, log, emit, claims, cursorPuts, pageCalls, recoverCalls, journalCalls };
}

/** The deferral INFO line, isolated from the always-emitted run-complete INFO. */
const deferrals = (log: SweepHarness['log']): unknown[][] =>
  log.info.mock.calls.filter((call) => String(call[1]).includes('work deferred'));

describe('journal sweep: constants are the operator-approved values', () => {
  it('pins every cap the approval paragraph quotes', () => {
    expect(JOURNAL_SWEEP_PERIOD_MS).toBe(24 * 60 * 60 * 1000);
    expect(JOURNAL_SWEEP_MIN_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(MAX_CONTACTS_PER_RUN).toBe(25);
    expect(MAX_RECOVERY_CALLS_PER_RUN).toBe(100);
    expect(MAX_SCAN_PAGES).toBe(20);
    expect(SCAN_PAGE_LIMIT).toBe(200);
    expect(SWEEP_MAX_ATTEMPTS_PER_CALL).toBe(12);
  });
});

// --- 1. Cadence -----------------------------------------------------------
describe('journal sweep: cadence claim', () => {
  it('a lost claim runs NOTHING - the period belongs to whoever won it', async () => {
    const h = harness({ claim: async () => false });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.ran).toBe(false);
    expect(h.pageCalls).toEqual([]);
    expect(h.recoverCalls).toEqual([]);
    expect(h.cursorPuts).toEqual([]);
  });

  it('claims one period a day - notBefore is now minus the period', async () => {
    const h = harness();

    await runJournalSweep(NOW, h.deps);

    expect(h.claims).toEqual([
      {
        id: JOURNAL_SWEEP_LAST_RUN_AT_ID,
        at: NOW,
        notBefore: new Date(NOW_MS - JOURNAL_SWEEP_PERIOD_MS).toISOString(),
      },
    ]);
  });

  it('force sets notBefore = now, so a __dev tick cannot be no-opped by the worker', async () => {
    const h = harness();

    const outcome = await runJournalSweep(NOW, h.deps, { force: true });

    expect(h.claims[0]).toEqual({ id: JOURNAL_SWEEP_LAST_RUN_AT_ID, at: NOW, notBefore: NOW });
    expect(outcome.ran).toBe(true);
  });

  it('a THROWN claim is WARN, not ERROR - the next poll retries in 30s', async () => {
    const h = harness({
      claim: async () => {
        throw new Error('dynamodb blip');
      },
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.ran).toBe(false);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(String(h.log.warn.mock.calls[0]![1])).toContain('cadence claim failed');
    expect(h.log.error).not.toHaveBeenCalled();
    expect(h.pageCalls).toEqual([]);
  });
});

// --- 2. The app-side age gate --------------------------------------------
describe('journal sweep: the age gate is applied in the application', () => {
  it('a lease-expired journal claimed an hour ago does NOT qualify', async () => {
    const h = harness({
      pages: [{ rows: [row({ contactId: 'too-fresh', claimedAt: hoursAgo(1) })] }],
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(h.recoverCalls).toEqual([]);
    expect(outcome.contactsVisited).toBe(0);
  });

  it('a lease-expired journal claimed 25 hours ago DOES qualify', async () => {
    const h = harness({ pages: [{ rows: [row({ contactId: 'past-the-gate' })] }] });

    await runJournalSweep(NOW, h.deps);

    expect(h.recoverCalls.map((c) => c.contactId)).toEqual(['past-the-gate']);
  });

  it('an UNPARSEABLE claimedAt qualifies - fail toward the scrub', async () => {
    const h = harness({
      pages: [{ rows: [row({ contactId: 'garbage-stamp', claimedAt: 'garbage' })] }],
    });

    await runJournalSweep(NOW, h.deps);

    expect(h.recoverCalls.map((c) => c.contactId)).toEqual(['garbage-stamp']);
  });

  it('a LIVE lease never qualifies, however old the claim', async () => {
    const h = harness({
      pages: [
        {
          rows: [
            row({ contactId: 'still-working', leaseExpiresAt: hoursAgo(-1), claimedAt: hoursAgo(48) }),
          ],
        },
      ],
    });

    await runJournalSweep(NOW, h.deps);

    expect(h.recoverCalls).toEqual([]);
  });

  it('the gate is exactly 24h - a claim one minute past it qualifies, one minute short does not', async () => {
    const justPast = new Date(NOW_MS - JOURNAL_SWEEP_MIN_AGE_MS - 60_000).toISOString();
    const justShort = new Date(NOW_MS - JOURNAL_SWEEP_MIN_AGE_MS + 60_000).toISOString();
    const h = harness({
      pages: [
        {
          rows: [
            row({ contactId: 'just-past', claimedAt: justPast }),
            row({ contactId: 'just-short', claimedAt: justShort }),
          ],
        },
      ],
    });

    await runJournalSweep(NOW, h.deps);

    expect(h.recoverCalls.map((c) => c.contactId)).toEqual(['just-past']);
  });
});

// --- 3. Contact dedup -----------------------------------------------------
describe('journal sweep: contact dedup', () => {
  it('twelve rows for one contact are ONE visit - without this the 25-cap is a 2-contact cap', async () => {
    const targets = ['pets', 'phone', 'income', 'email', 'address', 'voucherSize'];
    const h = harness({
      pages: [
        {
          rows: [
            ...targets.map((target) => row({ contactId: 'busy', target })),
            ...targets.map((target) => row({ contactId: 'busy', target: `${target}-2` })),
          ],
        },
      ],
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.contactsVisited).toBe(1);
    expect(h.recoverCalls.map((c) => c.contactId)).toEqual(['busy']);
  });
});

// --- 4. The contact cap fills mid-page ------------------------------------
describe('journal sweep: the contact cap', () => {
  it('stops at the cap, defers at INFO, advances the cursor PAST the page, and reads no further page', async () => {
    // Deliberately DENSE, unlike every other page in this file: 26 distinct
    // qualifying contacts on one page is what makes the cap bind mid-page.
    const dense = Array.from({ length: MAX_CONTACTS_PER_RUN + 1 }, (_unused, i) =>
      row({ contactId: `dense-${i}` }),
    );
    const h = harness({
      pages: [
        { rows: dense, nextCursor: '{"itemId":"resolve#dense-25#pets"}' },
        { rows: [row({ contactId: 'never-read' })] },
      ],
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.contactsVisited).toBe(MAX_CONTACTS_PER_RUN);
    expect(h.recoverCalls.map((c) => c.contactId)).not.toContain('dense-25');
    // No read capacity burned collecting rows the cap cannot accept.
    expect(h.pageCalls).toHaveLength(1);
    // PAST the page, never a rewind: a rewind livelocks on a page of
    // persistently-failing contacts. dense-25 is re-found when the cursor wraps.
    expect(h.cursorPuts).toEqual(['{"itemId":"resolve#dense-25#pets"}']);
    expect(outcome.deferred).toBe(true);
    expect(deferrals(h.log)).toHaveLength(1);
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('the page bound defers the same way - INFO, cursor kept, never an alarm', async () => {
    const h = harness({
      // Every page yields one sparse non-qualifying row and always has a next,
      // so the run is stopped by MAX_SCAN_PAGES rather than by the contact cap.
      listRows: async () => ({
        rows: [row({ claimedAt: hoursAgo(1) })],
        nextCursor: '{"itemId":"resolve#somewhere#pets"}',
      }),
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(h.pageCalls).toHaveLength(MAX_SCAN_PAGES);
    expect(h.cursorPuts).toEqual(['{"itemId":"resolve#somewhere#pets"}']);
    expect(outcome.deferred).toBe(true);
    expect(deferrals(h.log)).toHaveLength(1);
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('resumes from the stored cursor and asks for a full page', async () => {
    const h = harness({ storedCursor: '{"itemId":"resolve#resume-here#pets"}' });

    await runJournalSweep(NOW, h.deps);

    expect(h.pageCalls).toEqual([
      { cursor: '{"itemId":"resolve#resume-here#pets"}', limit: SCAN_PAGE_LIMIT },
    ]);
  });
});

// --- 5. Clean exhaustion --------------------------------------------------
describe('journal sweep: exhaustion', () => {
  it('CLEARS the cursor when the table runs out, and does not log a deferral', async () => {
    const h = harness({
      pages: [
        { rows: [row({ contactId: 'first' })], nextCursor: '{"itemId":"resolve#first#pets"}' },
        { rows: [row({ contactId: 'second' })] },
      ],
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(h.pageCalls).toHaveLength(2);
    expect(h.cursorPuts).toEqual([undefined]);
    expect(outcome.deferred).toBe(false);
    expect(deferrals(h.log)).toEqual([]);
    // The run-complete summary still lands, at INFO.
    expect(h.log.info).toHaveBeenCalledTimes(1);
    expect(String(h.log.info.mock.calls[0]![1])).toContain('run complete');
  });
});

// --- 6. The recovery loop and its one SSE emit ----------------------------
describe('journal sweep: the recovery loop', () => {
  it('loops while work remains, passes the widened budget, and emits ONCE per contact', async () => {
    const results = [
      { recovered: 2, stateChanged: true },
      { recovered: 0, stateChanged: false },
    ];
    const h = harness({
      pages: [{ rows: [row({ contactId: 'looping' })] }],
      recover: async () => results.shift() ?? { recovered: 0, stateChanged: false },
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(h.recoverCalls).toEqual([
      { contactId: 'looping', opts: { maxAttempts: SWEEP_MAX_ATTEMPTS_PER_CALL } },
      { contactId: 'looping', opts: { maxAttempts: SWEEP_MAX_ATTEMPTS_PER_CALL } },
    ]);
    // The TERMINATING call always reports stateChanged false, so the emit has
    // to ride the OR across all calls - not the last one's flag.
    expect(h.emit.mock.calls).toEqual([['suggestion.updated', { contactId: 'looping' }]]);
    expect(outcome.recovered).toBe(2);
  });

  it('does not emit for a contact whose journals changed nothing', async () => {
    const h = harness({ pages: [{ rows: [row({ contactId: 'quiet' })] }] });

    await runJournalSweep(NOW, h.deps);

    expect(h.emit).not.toHaveBeenCalled();
  });
});

// --- 7. The recovery-call budget -----------------------------------------
describe('journal sweep: the recovery-call budget', () => {
  it('stops the whole run, defers at INFO, and raises NO persistent-actives alarm', async () => {
    const h = harness({
      pages: [{ rows: [row({ contactId: 'poison' }), row({ contactId: 'never-reached' })] }],
      // Never terminates on its own: every call claims to have recovered one.
      recover: async () => ({ recovered: 1, stateChanged: false }),
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(h.recoverCalls).toHaveLength(MAX_RECOVERY_CALLS_PER_RUN);
    expect(h.recoverCalls.every((c) => c.contactId === 'poison')).toBe(true);
    expect(outcome.contactsVisited).toBe(1);
    // A budget cut is a DEFERRAL, not a poison journal - the truth check is
    // skipped precisely so it cannot manufacture an alarm the caps caused.
    expect(h.journalCalls).toEqual([]);
    expect(h.log.error).not.toHaveBeenCalled();
    expect(outcome.persistentContacts).toBe(0);
    expect(outcome.deferred).toBe(true);
    expect(deferrals(h.log)).toHaveLength(1);
  });
});

// --- 8. The post-loop truth check ----------------------------------------
//
// The shape every journal in these cases wears is the POST-TAKEOVER one,
// because that is the only shape the truth check ever sees. recoverAbandoned's
// takeover unconditionally rewrites leaseExpiresAt to now + DEFAULT_LEASE_MS
// (30s) on success, so a journal the run just attempted ALWAYS re-reads with a
// live lease - `claimedAt`, which takeover never touches, is the only staleness
// signal left. A truth check that re-used the enumeration's lease-and-age gate
// could therefore never fire for the case it names, which is exactly what these
// cases exist to prevent regressing.
const TAKEN_OVER_LEASE = new Date(NOW_MS + 30_000).toISOString();

describe('journal sweep: the post-loop truth check', () => {
  it('ERRORs with counts when a journal is STILL active past the gate, even with the takeover lease live', async () => {
    const h = harness({
      pages: [{ rows: [row({ contactId: 'stuck' })] }],
      journals: async () => [
        { state: 'active', leaseExpiresAt: TAKEN_OVER_LEASE, claimedAt: hoursAgo(25) },
        { state: 'active', leaseExpiresAt: TAKEN_OVER_LEASE, claimedAt: hoursAgo(30) },
      ],
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.persistentContacts).toBe(1);
    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(h.log.error.mock.calls[0]![0]).toMatchObject({ contactId: 'stuck', remaining: 2 });
    expect(String(h.log.error.mock.calls[0]![1])).toContain('still active after recovery');
  });

  it('an UNPARSEABLE claimedAt counts as remaining - the same fail-toward-scrub rule as the gate', async () => {
    const h = harness({
      pages: [{ rows: [row({ contactId: 'garbage-claim' })] }],
      journals: async () => [
        { state: 'active', leaseExpiresAt: TAKEN_OVER_LEASE, claimedAt: 'garbage' },
      ],
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.persistentContacts).toBe(1);
    expect(h.log.error).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for completed journals and for one claimed only an hour ago', async () => {
    const h = harness({
      pages: [{ rows: [row({ contactId: 'healthy' })] }],
      journals: async () => [
        { state: 'completed' },
        // A live journal a human claimed an hour ago: inside the gate, so the
        // sweep says nothing about it however its lease reads.
        { state: 'active', leaseExpiresAt: TAKEN_OVER_LEASE, claimedAt: hoursAgo(1) },
        { state: 'active', leaseExpiresAt: hoursAgo(25), claimedAt: hoursAgo(1) },
      ],
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.persistentContacts).toBe(0);
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('a FAILED truth-check read is WARN - loud, but never a false poison alarm', async () => {
    const h = harness({
      pages: [{ rows: [row({ contactId: 'unreadable' })] }],
      journals: async () => {
        throw new Error('batchget failed');
      },
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(String(h.log.warn.mock.calls[0]![1])).toContain('truth-check read failed');
    expect(h.log.error).not.toHaveBeenCalled();
    expect(outcome.persistentContacts).toBe(0);
  });
});

// --- 9. Per-contact isolation --------------------------------------------
describe('journal sweep: one contact failing never abandons its siblings', () => {
  it('skips only the thrower, WARNs once, and closes the run with ONE counted ERROR', async () => {
    const h = harness({
      pages: [
        {
          rows: [
            row({ contactId: 'first' }),
            row({ contactId: 'second' }),
            row({ contactId: 'third' }),
          ],
        },
      ],
      recover: async (contactId) => {
        // recoverAbandoned reads the contact's 12 journals with a consistent
        // BatchGet that sits in its for-of HEADER, outside its per-journal
        // try, so a throttled read propagates out of the call exactly here.
        if (contactId === 'second') throw new Error('batchget throttled');
        return { recovered: 0, stateChanged: false };
      },
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(h.recoverCalls.map((c) => c.contactId)).toEqual(['first', 'second', 'third']);
    // The contacts either side of the thrower still reached their truth check:
    // before the per-contact try, everything after 'second' was abandoned for a
    // whole cursor cycle because the cursor had already advanced past them.
    expect(h.journalCalls).toEqual(['first', 'third']);
    expect(outcome.contactsVisited).toBe(3);
    expect(outcome.failedContacts).toBe(1);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn.mock.calls[0]![0]).toMatchObject({ contactId: 'second' });
    expect(String(h.log.warn.mock.calls[0]![1])).toContain('recovery threw for this contact');
    // ONE end-of-run ERROR carrying the count - the loud claimed-then-failed
    // contract survives, and this is NOT the run-level 'run failed' line.
    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(h.log.error.mock.calls[0]![0]).toMatchObject({ failedContacts: 1, contactsVisited: 3 });
    expect(String(h.log.error.mock.calls[0]![1])).toContain('retried on the next run');
  });

  it('still EMITS when an EARLIER call committed and a LATER one threw', async () => {
    // The first call really did commit this contact's abandoned decision -
    // contact/phone writes, permanent dism# tombstones, audit rows - and only
    // the second call's BatchGet was throttled. The throw rolls none of that
    // back, so the dashboard still has to hear about it: with the emit sitting
    // only after the inner loop, the unwind went straight past it and the
    // committed change showed as stale rows until something else touched the
    // contact.
    const results = [{ recovered: 2, stateChanged: true }];
    const h = harness({
      pages: [{ rows: [row({ contactId: 'partial' })] }],
      recover: async () => {
        const next = results.shift();
        if (next === undefined) throw new Error('batchget throttled');
        return next;
      },
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(h.recoverCalls).toHaveLength(2);
    expect(outcome.recovered).toBe(2);
    expect(outcome.failedContacts).toBe(1);
    // Exactly once, and for THIS contact - the catch must not double-emit what
    // the normal path already sent.
    expect(h.emit.mock.calls).toEqual([['suggestion.updated', { contactId: 'partial' }]]);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(String(h.log.warn.mock.calls[0]![1])).toContain('recovery threw for this contact');
    // The throw still costs the truth check - that half is unchanged.
    expect(h.journalCalls).toEqual([]);
  });
});

// --- 10. A failed body ----------------------------------------------------
describe('journal sweep: a failed run', () => {
  it('ERRORs and RESOLVES - the poll loop must never see a rejection', async () => {
    const h = harness({
      listRows: async () => {
        throw new Error('scan failed');
      },
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.ran).toBe(true); // the cadence record is already stamped
    expect(h.claims).toHaveLength(1);
    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(String(h.log.error.mock.calls[0]![1])).toContain('next natural retry is tomorrow');
    expect(h.log.warn).not.toHaveBeenCalled();
  });

  it('CLEARS the stored cursor, so a poisoned one cannot wedge the duty forever', async () => {
    // The enumeration never reaches the persist below the page loop, so
    // without this a cursor the Scan rejects stays stored and EVERY future run
    // dies on page 1 behind a daily ERROR that no waiting clears.
    const h = harness({
      storedCursor: '{"itemId":"resolve#gone#pets"}',
      listRows: async () => {
        throw new Error('ValidationException: the provided starting key is invalid');
      },
    });

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(h.cursorPuts).toEqual([undefined]);
    // Still exactly one ERROR: clearing is best-effort housekeeping, not a
    // second alarm, and it must not replace the run-failed line.
    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(String(h.log.error.mock.calls[0]![1])).toContain('next natural retry is tomorrow');
    expect(h.log.warn).not.toHaveBeenCalled();
    expect(outcome.ran).toBe(true);
  });

  it('a failed cursor persist is best-effort: the run still recovers, WARN not ERROR', async () => {
    // This bare await used to sit ahead of the recovery loop inside the
    // run-level try, so ONE throttled single-item settings write burned the
    // already-claimed period with ZERO contacts recovered - and the run-level
    // self-heal then cleared the cursor, discarding the scan progress too
    // (adversarial review, phase 6). A failed persist now costs only cursor
    // advance: tomorrow re-reads the same page; today's contacts recover.
    let recoverCallsForContact = 0;
    const h = harness({
      recover: async () => {
        recoverCallsForContact += 1;
        return recoverCallsForContact === 1
          ? { recovered: 1, stateChanged: true }
          : { recovered: 0, stateChanged: false };
      },
    });
    h.deps.settingsRepo = {
      ...(h.deps.settingsRepo as NonNullable<JournalSweepDeps['settingsRepo']>),
      async putJournalSweepCursor() {
        throw new Error('ProvisionedThroughputExceededException');
      },
    };

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.ran).toBe(true);
    expect(outcome.recovered).toBe(1); // the enumerated contact still recovered
    expect(h.recoverCalls.length).toBeGreaterThan(0);
    expect(h.emit).toHaveBeenCalledWith('suggestion.updated', { contactId: 'contact-1' });
    const warnMsgs = h.log.warn.mock.calls.map((c) => String(c[1]));
    expect(warnMsgs.some((m) => m.includes('persisting the scan cursor failed'))).toBe(true);
    // A run whose window did not persist must not report a clean wrap - this
    // was the CLEAR branch (single page, exhausted), where an unflagged
    // failure silently freezes the head window (re-review R-1).
    expect(outcome.deferred).toBe(true);
    // No run-level ERROR: this is a deferral, not a burned day.
    const errorMsgs = h.log.error.mock.calls.map((c) => String(c[1]));
    expect(errorMsgs.some((m) => m.includes('run failed'))).toBe(false);
  });

  it('a failed cursor SET still recovers and WARNs (re-review R-1, SET branch)', async () => {
    // The SET branch: pages never exhaust (every page returns a nextCursor),
    // so the persist writes a real cursor. NOTE the deferred assertion below
    // is NOT the R-1 pin on this branch - !exhausted already forces deferred
    // true here; the discriminating deferred pin is the CLEAR-branch test
    // above. This case earns its keep on the WARN and the recovery still
    // running.
    let recoverCallsForContact = 0;
    const h = harness({
      listRows: async () => ({ rows: [row()], nextCursor: '{"itemId":"resolve#next"}' }),
      recover: async () => {
        recoverCallsForContact += 1;
        return recoverCallsForContact === 1
          ? { recovered: 1, stateChanged: false }
          : { recovered: 0, stateChanged: false };
      },
    });
    h.deps.settingsRepo = {
      ...(h.deps.settingsRepo as NonNullable<JournalSweepDeps['settingsRepo']>),
      async putJournalSweepCursor() {
        throw new Error('ProvisionedThroughputExceededException');
      },
    };

    const outcome = await runJournalSweep(NOW, h.deps);

    expect(outcome.ran).toBe(true);
    expect(outcome.deferred).toBe(true);
    expect(outcome.recovered).toBe(1);
    const warnMsgs = h.log.warn.mock.calls.map((c) => String(c[1]));
    expect(warnMsgs.some((m) => m.includes('persisting the scan cursor failed'))).toBe(true);
    const errorMsgs = h.log.error.mock.calls.map((c) => String(c[1]));
    expect(errorMsgs.some((m) => m.includes('run failed'))).toBe(false);
  });
});
