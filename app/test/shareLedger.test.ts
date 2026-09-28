// spec D7: order-independence, legacy seeding, the delivery-terminal rule, the attempt-instant clock, the bounded re-read.
import { describe, expect, it } from 'vitest';
import type { ListingSendItem, ShareMemoryWrite } from '../src/repos/listingSendsRepo.js';
import { SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import { LEGACY_ATTEMPT_KEY, rowlessAttemptKey } from '../src/lib/shareAttemptOrder.js';
import { applyShareLedgerEntry, ledgerEntryFor, ledgerEntryForSlot } from '../src/services/shareLedger.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const A1 = '2026-09-28T10:00:00.000Z#SM1';
const A2 = '2026-09-28T10:01:00.000Z#SM2';
function fakeLedger(seed?: Partial<ListingSendItem>, opts?: { loseFirst?: number }) {
  let row: ListingSendItem | undefined = seed === undefined ? undefined : ({ unitId: 'u', contactId: 'c', via: 'broadcast', created_at: 't0', updated_at: 't0', ...seed } as ListingSendItem);
  let losses = opts?.loseFirst ?? 0;
  let tick = 0;
  return {
    get row() { return row; },
    listingSends: {
      async getByKeyConsistent() { return row === undefined ? undefined : { ...row }; },
      async putShareMemory(_u: string, _c: string, next: ShareMemoryWrite, expect: { token: string | undefined }) {
        if (losses > 0) { losses -= 1; row = { ...(row ?? { unitId: 'u', contactId: 'c', via: 'broadcast', created_at: 'now', updated_at: 'now' } as ListingSendItem), shares_op: `bump${tick++}` }; return false; }
        if (row?.shares_op !== expect.token) return false;
        const base: ListingSendItem = row ?? ({ unitId: 'u', contactId: 'c', via: 'broadcast', created_at: 'now', updated_at: 'now' } as ListingSendItem);
        row = { ...base, shares: next.shares, counted: next.counted, shares_op: `tok${tick++}` };
        if (next.sentAt !== undefined) row.sentAt = next.sentAt; else delete row.sentAt;
        if (next.broadcastId !== undefined) row.broadcastId = next.broadcastId; else delete row.broadcastId;
        return true;
      },
    },
  };
}
const captured = () => { const capture = createLogCapture(); return { capture, log: createLogger({ level: 'info', destination: capture.stream }) }; };
const deps = (f: ReturnType<typeof fakeLedger>) => ({ listingSends: f.listingSends, log: captured().log });
const write = (f: ReturnType<typeof fakeLedger>, broadcastId: string, attempt: string, kind: 'accepted' | 'delivered' | 'pending' | 'failed' | 'unconfirmed') =>
  applyShareLedgerEntry(deps(f), { unitId: 'u', contactId: 'c', broadcastId, entry: ledgerEntryFor(attempt, 'conv', { kind }) });

describe('applyShareLedgerEntry', () => {
  it("creates the row on the first write (callback before the pass) and refuses the pass's later acceptance for the same attempt", async () => {
    const f = fakeLedger();
    expect(await write(f, 'b1', A1, 'failed')).toBe('written');
    expect(f.row?.counted).toBe(false);
    expect(await write(f, 'b1', A1, 'accepted')).toBe('refused');
  });
  it("a counted entry's sentAt is the ATTEMPT's provider instant, and a delivery of the same attempt does not move it", async () => {
    const f = fakeLedger();
    await write(f, 'b1', A1, 'accepted');
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-09-28T10:00:00.000Z', broadcastId: 'b1' });
    expect(await write(f, 'b1', A1, 'delivered')).toBe('written');
    expect(f.row?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'delivery', countedAt: '2026-09-28T10:00:00.000Z' });
    expect(f.row?.sentAt).toBe('2026-09-28T10:00:00.000Z');
    expect(await write(f, 'b1', A2, 'failed')).toBe('refused'); // delivery is terminal
  });
  it('pending -> failed moves forward; pending -> pending again is refused; nothing moves back', async () => {
    const g = fakeLedger();
    await write(g, 'b1', A1, 'pending');
    expect(g.row?.counted).toBe(false);
    expect(await write(g, 'b1', A1, 'failed')).toBe('written');
    expect(await write(g, 'b1', A1, 'pending')).toBe('refused');
  });
  it('the same attempt counted by acceptance may move to pending or failed, never to unconfirmed or back to an acceptance', async () => {
    const f = fakeLedger();
    await write(f, 'b1', A1, 'accepted');
    expect(await write(f, 'b1', A1, 'accepted')).toBe('refused');
    expect(await write(f, 'b1', A1, 'unconfirmed')).toBe('refused');
    expect(await write(f, 'b1', A1, 'pending')).toBe('written');
    expect(f.row).toMatchObject({ counted: false });
    expect(f.row?.sentAt).toBeUndefined();
    expect(f.row?.broadcastId).toBeUndefined();
  });
  it("a newer attempt replaces a failed entry and the pair counts again at the newer attempt's instant; an older attempt is refused unless it is a delivery", async () => {
    const f = fakeLedger();
    await write(f, 'b1', A1, 'failed');
    expect(await write(f, 'b1', A2, 'accepted')).toBe('written');
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-09-28T10:01:00.000Z' });
    expect(await write(f, 'b1', A1, 'failed')).toBe('refused');
    expect(await write(f, 'b1', A1, 'delivered')).toBe('written');
    expect(f.row?.shares?.['b1']).toMatchObject({ attempt: A1, by: 'delivery', countedAt: '2026-09-28T10:00:00.000Z' });
  });
  it("a legacy row seeds its own share as a counted entry at the row's own sentAt, which survives a newer share's failure", async () => {
    const f = fakeLedger({ sentAt: '2026-09-01T00:00:00.000Z', broadcastId: 'b-old' });
    await write(f, 'b-new', A1, 'failed');
    expect(f.row?.shares?.['b-old']).toMatchObject({ attempt: LEGACY_ATTEMPT_KEY, state: 'counted', countedAt: '2026-09-01T00:00:00.000Z' });
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-09-01T00:00:00.000Z', broadcastId: 'b-old' });
  });
  it('an individual-only legacy row seeds an `individual` entry; when a share also counts, sentAt and broadcastId follow the latest counted entry', async () => {
    const f = fakeLedger({ sentAt: '2026-07-01T00:00:00.000Z' });
    await write(f, 'b1', A1, 'accepted');
    expect(f.row?.shares?.['individual']).toMatchObject({ state: 'counted', countedAt: '2026-07-01T00:00:00.000Z' });
    expect(f.row).toMatchObject({ sentAt: '2026-09-28T10:00:00.000Z', broadcastId: 'b1' });
    await write(f, 'b1', A1, 'failed');
    expect(await write(f, 'b1', A2, 'failed')).toBe('written');
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-07-01T00:00:00.000Z' });
    expect(f.row?.broadcastId).toBeUndefined();
  });
  it('a lost condition re-reads and re-applies; past the bound it reports lost with one ERROR', async () => {
    const f = fakeLedger({ shares: {}, counted: false, shares_op: 't' }, { loseFirst: 2 });
    expect(await write(f, 'b1', A1, 'accepted')).toBe('written');
    const g = fakeLedger({ shares: {}, counted: false, shares_op: 't' }, { loseFirst: 10 });
    const { capture, log } = captured();
    expect(await applyShareLedgerEntry({ listingSends: g.listingSends, log }, { unitId: 'u', contactId: 'c', broadcastId: 'b1', entry: ledgerEntryFor(A1, 'conv', { kind: 'accepted' }) })).toBe('lost');
    expect(capture.atLevel(50).length).toBe(1);
  });
});

describe('ledgerEntryFor', () => {
  it("a counted entry carries the attempt's own provider instant; the others carry none; the conversation rides only when given", () => {
    expect(ledgerEntryFor(A1, 'conv', { kind: 'accepted' })).toStrictEqual({ attempt: A1, conversationId: 'conv', state: 'counted', by: 'acceptance', countedAt: '2026-09-28T10:00:00.000Z' });
    expect(ledgerEntryFor(A1, undefined, { kind: 'delivered' })).toStrictEqual({ attempt: A1, state: 'counted', by: 'delivery', countedAt: '2026-09-28T10:00:00.000Z' });
    expect(ledgerEntryFor(A1, 'conv', { kind: 'pending' })).toStrictEqual({ attempt: A1, conversationId: 'conv', state: 'pending' });
    expect(ledgerEntryFor(A1, 'conv', { kind: 'failed' })).toStrictEqual({ attempt: A1, conversationId: 'conv', state: 'failed' });
    expect(ledgerEntryFor(rowlessAttemptKey(A1), 'conv', { kind: 'unconfirmed' })).toStrictEqual({ attempt: rowlessAttemptKey(A1), conversationId: 'conv', state: 'unconfirmed' });
  });
});

describe('ledgerEntryForSlot (the entry a slot OWN state implies)', () => {
  const base = { conversationId: 'conv-1', tsMsgId: A1 };
  it('delivered -> counted by delivery; sent -> counted by acceptance; the newest attempt is the entry attempt', () => {
    expect(ledgerEntryForSlot({ ...base, status: 'delivered' }, 'conv-1', false)).toMatchObject({ attempt: A1, state: 'counted', by: 'delivery' });
    expect(ledgerEntryForSlot({ ...base, status: 'sent', latestAttempt: A2 }, 'conv-1', false)).toMatchObject({ attempt: A2, state: 'counted', by: 'acceptance', countedAt: '2026-09-28T10:01:00.000Z' });
  });
  it('failed: 30003 with a live promise -> pending; 30003 without -> failed; send_unconfirmed -> unconfirmed; any other code -> failed', () => {
    expect(ledgerEntryForSlot({ ...base, status: 'failed', errorCode: '30003' }, 'conv-1', true)?.state).toBe('pending');
    expect(ledgerEntryForSlot({ ...base, status: 'failed', errorCode: '30003' }, 'conv-1', false)?.state).toBe('failed');
    expect(ledgerEntryForSlot({ ...base, status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: rowlessAttemptKey(A1) }, 'conv-1', true)).toMatchObject({ attempt: rowlessAttemptKey(A1), state: 'unconfirmed' });
    expect(ledgerEntryForSlot({ ...base, status: 'failed', errorCode: '30007' }, 'conv-1', true)?.state).toBe('failed');
  });
  it('queued, skipped and a slot with no attempt imply no entry', () => {
    expect(ledgerEntryForSlot({ ...base, status: 'queued' }, 'conv-1', false)).toBeUndefined();
    expect(ledgerEntryForSlot({ ...base, status: 'skipped', errorCode: 'opted_out' }, 'conv-1', false)).toBeUndefined();
    expect(ledgerEntryForSlot({ status: 'failed', errorCode: 'no_contact' }, 'conv-1', false)).toBeUndefined();
  });
});
