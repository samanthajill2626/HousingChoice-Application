// spec D1: one per-recipient state, two readings. Every row of the state
// table, both read bounds, and the safe direction on a failed read.
import { describe, expect, it } from 'vitest';
import type { BroadcastItem, BroadcastRecipient } from '../src/repos/broadcastsRepo.js';
import type { SendAttemptOwner } from '../src/repos/sendAttemptsRepo.js';
import { SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import { RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
import { rowlessAttemptKey } from '../src/lib/shareAttemptOrder.js';
import {
  RECORD_READ_BOUND_MS, RETRY_ROW_READ_BOUND_MS, classifyRecipient, hasReached, mayHaveReached,
  needsRecordRead, needsRowRead, priorRecipientKeys, reachedCount, resolveRecipientStates, retryPendingCount, unconfirmedByRow,
} from '../src/services/shareRecipientState.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const captured = () => { const capture = createLogCapture(); return { capture, log: createLogger({ level: 'info', destination: capture.stream }) }; };

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const ROOT = '2026-09-28T11:50:00.000Z#SM1'; // 10 min old
const share = (status: BroadcastItem['status'], createdAt = '2026-09-28T11:49:00.000Z') => ({ status, created_at: createdAt });
const slot = (s: Partial<BroadcastRecipient> & { status: BroadcastRecipient['status'] }): BroadcastRecipient => ({ conversationId: 'conv-1', tsMsgId: ROOT, ...s });

// The fakes the resolver tests share: the message rows by tsMsgId, the attempt
// records by contactKey, and a count of record reads.
const rows = new Map<string, { retry_due_at?: string; retry_outcome?: string }>();
const records = new Map<string, { state: string; outcome?: string } | undefined>();
let recordReadCount = 0;
const deps = (opts?: { rowThrows?: boolean; recordThrows?: boolean }) => {
  const { capture, log } = captured();
  return {
    capture,
    deps: {
      messages: {
        async getByTsMsgIdConsistent(_c: string, ts: string) {
          if (opts?.rowThrows) throw new Error('boom');
          const r = rows.get(ts);
          return r === undefined ? undefined : ({ tsMsgId: ts, ...r } as never);
        },
      },
      attempts: {
        async get(owner: SendAttemptOwner) {
          recordReadCount += 1;
          if (opts?.recordThrows) throw new Error('boom');
          return records.get(owner.kind === 'broadcast' ? owner.contactKey : '') as never;
        },
      },
      now: () => NOW,
      log,
    },
  };
};
const item = (status: BroadcastItem['status'], recipients: Record<string, BroadcastRecipient>): BroadcastItem =>
  ({ broadcastId: 'b1', unitId: 'unit-1', status, created_at: '2026-09-28T11:49:00.000Z', recipients, stats: {}, created_by: 'u', audience_filter: {}, body_template: 't' } as never);

describe('classifyRecipient - the state table', () => {
  it('skipped -> skipped; delivered / sent (confirmed or not) -> reached', () => {
    expect(classifyRecipient(share('sent'), slot({ status: 'skipped', errorCode: 'opted_out' }), {}, NOW)).toBe('skipped');
    expect(classifyRecipient(share('sent'), slot({ status: 'delivered' }), {}, NOW)).toBe('reached');
    expect(classifyRecipient(share('sent'), slot({ status: 'sent' }), {}, NOW)).toBe('reached');
    expect(classifyRecipient(share('sent'), slot({ status: 'sent', carrierSentAt: '2026-09-28T11:50:01.000Z' }), {}, NOW)).toBe('reached');
  });
  it('queued in a sending share is in flight, whatever the record says', () => {
    expect(classifyRecipient(share('sending'), slot({ status: 'queued' }), {}, NOW)).toBe('in_flight');
    expect(classifyRecipient(share('sending'), slot({ status: 'queued' }), { record: null }, NOW)).toBe('in_flight');
  });
  it('queued in a finished share: a record NOT ASKED is in flight (safe); expired (past the 30-day life) is stranded; read-and-absent or a never-went record is stranded; any other record is in flight; an unreadable record is in flight', () => {
    const q = slot({ status: 'queued' });
    expect(classifyRecipient(share('failed'), q, {}, NOW)).toBe('in_flight');
    expect(classifyRecipient(share('failed'), q, { record: 'expired' }, NOW)).toBe('stranded');
    expect(classifyRecipient(share('failed'), q, { record: null }, NOW)).toBe('stranded');
    for (const outcome of ['refused', 'rejected', 'enqueue_failed', 'redrive_refused'] as const) {
      expect(classifyRecipient(share('failed'), q, { record: { state: 'done', outcome } as never }, NOW)).toBe('stranded');
    }
    expect(classifyRecipient(share('failed'), q, { record: { state: 'attempting' } as never }, NOW)).toBe('in_flight');
    expect(classifyRecipient(share('failed'), q, { record: { state: 'done', outcome: 'unresolved' } as never }, NOW)).toBe('in_flight');
    expect(classifyRecipient(share('failed'), q, { record: { state: 'done', outcome: 'retryable' } as never }, NOW)).toBe('in_flight');
    expect(classifyRecipient(share('failed'), q, { record: 'unreadable' }, NOW)).toBe('in_flight');
  });
  it('failed send_unconfirmed is unconfirmed; failed with a live promise is pending; withdrawn, lapsed or absent is failed; an unresolved outcome is unconfirmed', () => {
    const f = slot({ status: 'failed', errorCode: '30003' });
    expect(classifyRecipient(share('sent'), slot({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE }), {}, NOW)).toBe('unconfirmed');
    expect(classifyRecipient(share('sent'), f, { row: { retryDueAt: '2026-09-28T12:05:00.000Z' } }, NOW)).toBe('pending');
    expect(classifyRecipient(share('sent'), f, { row: { retryDueAt: '2026-09-28T11:57:00.000Z' } }, NOW)).toBe('failed'); // lapsed: due + 2 min < now
    expect(classifyRecipient(share('sent'), f, { row: { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT } }, NOW)).toBe('failed');
    expect(classifyRecipient(share('sent'), f, { row: {} }, NOW)).toBe('failed');
    expect(classifyRecipient(share('sent'), f, { row: { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' } }, NOW)).toBe('unconfirmed');
    expect(classifyRecipient(share('sent'), f, { row: 'unreadable' }, NOW)).toBe('pending');
    expect(classifyRecipient(share('sent'), f, {}, NOW)).toBe('failed'); // outside the bound: no fact, the slot is authoritative
  });
  it('a failed slot with any other code is failed without a read', () => {
    expect(classifyRecipient(share('sent'), slot({ status: 'failed', errorCode: '30007' }), {}, NOW)).toBe('failed');
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30007' }), NOW)).toBe(false);
  });
});

describe('the two readings', () => {
  it('SAFE counts reached, pending, unconfirmed, in_flight; STRICT counts reached only', () => {
    expect(['reached', 'pending', 'unconfirmed', 'in_flight'].every((s) => mayHaveReached(s as never))).toBe(true);
    expect(['failed', 'skipped', 'stranded'].some((s) => mayHaveReached(s as never))).toBe(false);
    expect(hasReached('reached')).toBe(true);
    expect(['pending', 'unconfirmed', 'in_flight', 'failed', 'skipped', 'stranded'].some((s) => hasReached(s as never))).toBe(false);
  });
});

describe('the read bounds', () => {
  it('RETRY_ROW_READ_BOUND_MS is the constants sum: 15 + 4 + 2 + 2 + 1 minutes', () => {
    expect(RETRY_ROW_READ_BOUND_MS).toBe(24 * 60_000);
    expect(RECORD_READ_BOUND_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it('needsRowRead: a young failed-30003 slot reads; an old one does not; the newest attempt key decides the age', () => {
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30003' }), NOW)).toBe(true);
    const old = '2026-09-28T11:30:00.000Z#SM0'; // 30 min old
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30003', tsMsgId: old }), NOW)).toBe(false);
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30003', tsMsgId: old, latestAttempt: ROOT }), NOW)).toBe(true);
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30003', latestAttempt: rowlessAttemptKey(ROOT) }), NOW)).toBe(true);
  });
  it('needsRecordRead: queued in a finished share younger than 30 days reads; a sending share or an old share does not; the age is the last write, so an old draft sent recently still reads', () => {
    expect(needsRecordRead(share('failed'), slot({ status: 'queued' }), NOW)).toBe(true);
    expect(needsRecordRead(share('sending'), slot({ status: 'queued' }), NOW)).toBe(false);
    expect(needsRecordRead(share('failed', '2026-08-01T00:00:00.000Z'), slot({ status: 'queued' }), NOW)).toBe(false);
    expect(needsRecordRead({ ...share('failed', '2026-06-01T00:00:00.000Z'), updated_at: '2026-09-28T11:49:00.000Z' }, slot({ status: 'queued' }), NOW)).toBe(true);
  });
  it('with recordReads, a queued slot of a finished share past the 30-day life reads stranded WITHOUT a read; without recordReads it reads in flight', async () => {
    const { deps: d } = deps();
    const old = item('failed', { c3: slot({ status: 'queued' }) });
    (old as { created_at: string }).created_at = '2026-08-01T00:00:00.000Z';
    recordReadCount = 0;
    expect((await resolveRecipientStates(d, old, { recordReads: true })).get('c3')?.state).toBe('stranded');
    expect(recordReadCount).toBe(0);
    expect((await resolveRecipientStates(d, old)).get('c3')?.state).toBe('in_flight');
    // and the flag: an old route-failed share does NOT flag its audience (the round-2 HIGH)
    const broadcasts = { async listByUnit() { return { items: [old] }; } };
    expect((await priorRecipientKeys({ ...d, broadcasts: broadcasts as never }, 'unit-1')).size).toBe(0);
  });
});

describe('resolveRecipientStates and priorRecipientKeys', () => {
  it('reads a row only for young failed-30003 slots; reads a record only when asked (recordReads) and only for queued slots of a finished share; the map carries the facts', async () => {
    rows.set(ROOT, { retry_due_at: '2026-09-28T12:05:00.000Z' });
    records.set('c3', undefined);
    const { deps: d } = deps();
    const share1 = item('failed', {
      c1: slot({ status: 'failed', errorCode: '30003' }),
      c2: slot({ status: 'failed', errorCode: '30007' }),
      c3: slot({ status: 'queued' }),
      c4: slot({ status: 'delivered' }),
    });
    recordReadCount = 0;
    const noRecords = await resolveRecipientStates(d, share1);
    expect(recordReadCount).toBe(0);
    expect(noRecords.get('c3')?.state).toBe('in_flight');
    const states = await resolveRecipientStates(d, share1, { recordReads: true });
    expect(recordReadCount).toBe(1);
    expect(states.get('c1')).toMatchObject({ state: 'pending', retryDueAt: '2026-09-28T12:05:00.000Z' });
    expect(states.get('c2')?.state).toBe('failed');
    expect(states.get('c3')?.state).toBe('stranded');
    expect(states.get('c4')?.state).toBe('reached');
    expect(retryPendingCount(states)).toBe(1);
    expect(reachedCount(share1)).toBe(1);
  });
  it('a row-less newest attempt reads the RETRIED row, and the map carries the slot pointer', async () => {
    rows.set(ROOT, { retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    const { deps: d } = deps();
    const marker = rowlessAttemptKey(ROOT);
    const states = await resolveRecipientStates(d, item('sent', { c1: slot({ status: 'failed', errorCode: '30003', latestAttempt: marker }) }));
    expect(states.get('c1')).toStrictEqual({ state: 'unconfirmed', retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed', latestAttempt: marker });
  });
  it('unconfirmedByRow names a failed-30003 slot whose row says unresolved, never a send_unconfirmed slot', async () => {
    rows.set(ROOT, { retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    const { deps: d } = deps();
    const share1 = item('sent', { c1: slot({ status: 'failed', errorCode: '30003' }), c2: slot({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE }) });
    const states = await resolveRecipientStates(d, share1);
    expect([...unconfirmedByRow(states, share1)]).toEqual(['c1']);
  });
  it('a failed row read reads pending and is logged; a failed record read reads in flight', async () => {
    const { deps: d, capture } = deps({ rowThrows: true, recordThrows: true });
    const states = await resolveRecipientStates(d, item('failed', { c1: slot({ status: 'failed', errorCode: '30003' }), c3: slot({ status: 'queued' }) }), { recordReads: true });
    expect(states.get('c1')?.state).toBe('pending');
    expect(states.get('c3')?.state).toBe('in_flight');
    expect(capture.atLevel(40).length).toBe(2);
  });
  it('a failed record read of a PHONE-keyed slot logs the key redacted, never the phone', async () => {
    const { deps: d, capture } = deps({ recordThrows: true });
    const states = await resolveRecipientStates(d, item('failed', { 'phone#+15550001111': slot({ status: 'queued' }) }), { recordReads: true });
    expect(states.get('phone#+15550001111')?.state).toBe('in_flight');
    const warns = capture.atLevel(40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ broadcastId: 'b1', recipientKey: 'phone#redacted' });
    expect(JSON.stringify(warns[0])).not.toContain('5550001111');
  });
  it('reads run at most 8 at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps: d } = deps();
    const slow = {
      ...d,
      messages: {
        async getByTsMsgIdConsistent() {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return undefined;
        },
      },
    };
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, slot({ status: 'failed', errorCode: '30003' })]));
    const states = await resolveRecipientStates(slow, item('sent', many));
    expect(states.size).toBe(20);
    expect(peak).toBe(8);
  });
  it('priorRecipientKeys unions the SAFE reading over every share of the unit, whatever its stored status', async () => {
    const { deps: d } = deps();
    const broadcasts = { async listByUnit() { return { items: [
      item('failed', { c1: slot({ status: 'failed', errorCode: '30007' }), c2: slot({ status: 'sent' }) }),
      item('sent', { c3: slot({ status: 'skipped', errorCode: 'manual_mode' }), 'phone#+15550001111': slot({ status: 'delivered' }) }),
    ] }; } };
    const keys = await priorRecipientKeys({ ...d, broadcasts: broadcasts as never }, 'unit-1');
    expect([...keys].sort()).toEqual(['c2', 'phone#+15550001111']);
  });
  it('priorRecipientKeys walks every page of the unit on lastEvaluatedKey', async () => {
    const { deps: d } = deps();
    const pages = [
      { items: [item('sent', { c1: slot({ status: 'delivered' }) })], lastEvaluatedKey: { broadcastId: 'b1', unitId: 'unit-1' } },
      { items: [item('sent', { c2: slot({ status: 'sent' }) })] },
    ];
    const seen: Array<Record<string, unknown> | undefined> = [];
    const broadcasts = { async listByUnit(_u: string, opts?: { exclusiveStartKey?: Record<string, unknown> }) { seen.push(opts?.exclusiveStartKey); return pages[seen.length - 1]!; } };
    const keys = await priorRecipientKeys({ ...d, broadcasts: broadcasts as never }, 'unit-1');
    expect([...keys].sort()).toEqual(['c1', 'c2']);
    expect(seen).toEqual([undefined, { broadcastId: 'b1', unitId: 'unit-1' }]);
  });
  it('priorRecipientKeys never throws: a listByUnit failure logs WARN and returns what it has', async () => {
    const { deps: d, capture } = deps();
    const broadcasts = { async listByUnit() { throw new Error('index missing'); } };
    expect((await priorRecipientKeys({ ...d, broadcasts: broadcasts as never }, 'unit-1')).size).toBe(0);
    expect(capture.atLevel(40).length).toBe(1);
  });
});
