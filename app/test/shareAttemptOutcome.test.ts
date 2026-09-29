// spec D2: one attempt-ordered transition, every refusal, every allowed move,
// the lost-condition re-apply, the delivered-at-any-age exception, the stats
// delta, the ledger call and the emit - through all outcome kinds.
import { describe, expect, it, vi } from 'vitest';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import { rowlessAttemptKey } from '../src/lib/shareAttemptOrder.js';
import {
  applyLaterAttempt,
  applyLaterAttemptBounded,
  originalRowLedgerWrite,
  pairContactId,
  projectSlot,
  wouldApply,
} from '../src/services/shareAttemptOutcome.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import type { BroadcastItem, BroadcastRecipient } from '../src/repos/broadcastsRepo.js';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const ROOT = '2026-09-28T11:50:00.000Z#SM1';
const RETRY = '2026-09-28T11:51:00.000Z#SM2';
const LATER = '2026-09-28T11:52:00.000Z#SM3';
const baseShare = { broadcastId: 'b1', unitId: 'unit-1', status: 'sent', created_at: '2026-09-28T11:49:00.000Z', created_by: 'user-1', audience_filter: {}, body_template: 'hi',
  stats: { audience: 1, queued: 0, sent: 0, delivered: 0, failed: 1, skipped_opted_out: 0, skipped_no_consent: 0 } } as unknown as BroadcastItem;

function world(slot: Partial<BroadcastRecipient>, contactKey = 'c1', share: Partial<BroadcastItem> = {}) {
  const w = createFakeWorld();
  w.broadcasts.set('b1', { ...baseShare, ...share, stats: { ...baseShare.stats }, recipients: { [contactKey]: { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: ROOT, ...slot } } });
  const capture = createLogCapture();
  const log = createLogger({ level: 'info', destination: capture.stream });
  const emitted: Array<{ broadcastId: string; stats: { retry_pending?: number } }> = [];
  w.events.on('broadcast.updated', (e) => emitted.push(e as never));
  const deps = { broadcasts: w.broadcastsRepo, ledger: { listingSends: w.listingSendsRepo, log }, events: w.events, log, now: () => NOW };
  return { w, deps, capture, emitted, slot: () => w.broadcasts.get('b1')!.recipients[contactKey]!, share: () => w.broadcasts.get('b1')!, ledger: (c = 'c1') => w.listingSendsRepo.getByKeyConsistent('unit-1', c) };
}
const base = { broadcastId: 'b1', conversationId: 'conv-1', retryRoot: ROOT };

describe('applyLaterAttempt', () => {
  it("a newer attempt delivered: the slot leaves failed with the NEW carrier instant, stats move failed -> delivered in one write, the ledger counts by delivery at the attempt's instant, the emit carries no retry_pending", async () => {
    const x = world({ carrierSentAt: '2026-09-28T11:50:01.000Z' });
    const writes = vi.spyOn(x.deps.broadcasts, 'applyAttemptOutcome');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered', carrierSentAt: '2026-09-28T11:51:01.000Z' } })).toBe('applied');
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![4]).toEqual({ failed: -1, delivered: 1 });
    expect(x.slot()).toMatchObject({ status: 'delivered', latestAttempt: RETRY, tsMsgId: ROOT, carrierSentAt: '2026-09-28T11:51:01.000Z' });
    expect(x.share().stats).toMatchObject({ failed: 0, delivered: 1 });
    expect((await x.ledger())?.shares?.['b1']).toMatchObject({ attempt: RETRY, state: 'counted', by: 'delivery', conversationId: 'conv-1', countedAt: '2026-09-28T11:51:00.000Z' });
    expect(x.emitted.length).toBe(1);
    expect(x.emitted[0]).toMatchObject({ broadcastId: 'b1' });
    expect(x.emitted[0]?.stats.retry_pending).toBeUndefined();
  });
  it("a newer attempt delivered WITHOUT a carrier instant drops the old attempt's", async () => {
    const x = world({ carrierSentAt: '2026-09-28T11:50:01.000Z' });
    await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } });
    expect(x.slot().carrierSentAt).toBeUndefined();
  });
  it('a newer attempt failed 30003 with a live promise: failed stays failed, the ledger entry is pending, the emit carries retry_pending 1', async () => {
    const x = world({});
    const writes = vi.spyOn(x.deps.broadcasts, 'applyAttemptOutcome');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30003', retryDueAt: '2026-09-28T12:05:00.000Z' } })).toBe('applied');
    expect(writes.mock.calls[0]![4]).toEqual({});
    expect(x.slot()).toMatchObject({ status: 'failed', errorCode: '30003', latestAttempt: RETRY });
    expect(x.share().stats).toMatchObject({ failed: 1 });
    expect((await x.ledger())?.shares?.['b1']?.state).toBe('pending');
    expect(x.emitted[0]?.stats.retry_pending).toBe(1);
  });
  it('a newer attempt failed 30003 whose promise already lapsed: the ledger entry is failed and the emit leaves the count unset', async () => {
    const x = world({});
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30003', retryDueAt: '2026-09-28T11:40:00.000Z' } })).toBe('applied');
    expect((await x.ledger())?.shares?.['b1']?.state).toBe('failed');
    expect(x.emitted[0]?.stats.retry_pending).toBeUndefined();
  });
  it('a row-less unresolved end: send_unconfirmed, the unconfirmed bucket, the ledger entry unconfirmed; re-applied it is an idempotent no-op (no write); a LATER real attempt (an adoption) supersedes it', async () => {
    const x = world({});
    const marker = rowlessAttemptKey(ROOT);
    const writes = vi.spyOn(x.deps.broadcasts, 'applyAttemptOutcome');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: marker, outcome: { kind: 'unresolved' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: marker });
    expect(x.share().stats).toMatchObject({ failed: 0, unconfirmed: 1 });
    expect((await x.ledger())?.shares?.['b1']?.state).toBe('unconfirmed');
    expect(writes).toHaveBeenCalledTimes(1);
    // deviation 15: the slot already records this write's own next, so the call
    // reads as applied WITHOUT writing - the stats do not move twice.
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: marker, outcome: { kind: 'unresolved' } })).toBe('applied');
    expect(writes).toHaveBeenCalledTimes(1);
    expect(x.share().stats).toMatchObject({ failed: 0, unconfirmed: 1 });
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent', carrierSentAt: '2026-09-28T11:51:01.000Z' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'sent', latestAttempt: RETRY });
    expect(x.slot().errorCode).toBeUndefined();
    expect(x.share().stats).toMatchObject({ unconfirmed: 0, sent: 1 });
    expect((await x.ledger())?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'acceptance' });
  });
  it('refusals: queued, delivered and skipped never move; an older attempt never applies; a same-attempt late sent after failed is refused - none writes, none emits', async () => {
    const q = world({ status: 'queued', errorCode: undefined });
    expect(await applyLaterAttempt(q.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('refused');
    const d = world({ status: 'delivered', errorCode: undefined, latestAttempt: RETRY });
    expect(await applyLaterAttempt(d.deps, { ...base, attemptKey: LATER, outcome: { kind: 'failed', errorCode: '30007' } })).toBe('refused');
    const s = world({ status: 'skipped', errorCode: 'manual_mode' });
    expect(await applyLaterAttempt(s.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('refused');
    const o = world({ latestAttempt: LATER });
    expect(await applyLaterAttempt(o.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30007' } })).toBe('refused');
    const f = world({ latestAttempt: RETRY });
    expect(await applyLaterAttempt(f.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent' } })).toBe('refused');
    for (const x of [q, d, s, o, f]) {
      expect(x.emitted.length).toBe(0);
      expect(await x.ledger()).toBeUndefined();
    }
    expect(o.slot()).toMatchObject({ status: 'failed', errorCode: '30003', latestAttempt: LATER });
  });
  it("the delivered-at-any-age exception: an older attempt's delivery applies over a newer failure and the slot records the delivered attempt", async () => {
    const x = world({ latestAttempt: LATER, errorCode: '30007' });
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'delivered', latestAttempt: RETRY });
  });
  it("a move on the ORIGINAL's own key leaves NO latestAttempt - the pointer is absent while the original is the attempt the slot records (code review G2 / ADV-11) - the condition still names the recorded attempt, and a re-apply reads as already applied", async () => {
    const x = world({ status: 'sent', errorCode: undefined });
    const writes = vi.spyOn(x.deps.broadcasts, 'applyAttemptOutcome');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: ROOT, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(x.slot()).toEqual({ status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![2]).toEqual({ status: 'sent', latestAttempt: undefined });
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: ROOT, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(writes).toHaveBeenCalledTimes(1);
    expect(x.capture.atLevel(30).some((l) => String(l.msg).includes('already applied'))).toBe(true);
    expect(x.share().stats).toMatchObject({ delivered: 1 });
    // The original's delivery over a NEWER failed retry: the slot records the original again - no pointer - and the
    // condition names the retry it replaced.
    const y = world({ latestAttempt: RETRY, errorCode: '30007' });
    const yWrites = vi.spyOn(y.deps.broadcasts, 'applyAttemptOutcome');
    expect(await applyLaterAttempt(y.deps, { ...base, attemptKey: ROOT, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(y.slot()).toEqual({ status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT });
    expect(yWrites.mock.calls[0]![2]).toEqual({ status: 'failed', latestAttempt: RETRY });
    expect(projectSlot({ status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT }, { attemptKey: ROOT, outcome: { kind: 'delivered' } })).not.toHaveProperty('latestAttempt');
  });
  it("pairContactId: the slot key when it is a contact id; the row's send-time holder for a phone-keyed slot; else none", () => {
    expect(pairContactId('c1', 'c-other')).toBe('c1');
    expect(pairContactId('phone#+15550002222', 'c-held')).toBe('c-held');
    expect(pairContactId('phone#+15550002222', undefined)).toBeUndefined();
  });
  it('from sent (a lost original rollup): a newer attempt applies, and the same attempt moves sent -> sent-with-carrier -> delivered keeping its carrier instant', async () => {
    const x = world({ status: 'sent', errorCode: undefined });
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent' } })).toBe('applied');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent', carrierSentAt: '2026-09-28T11:51:05.000Z' } })).toBe('applied');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'delivered', carrierSentAt: '2026-09-28T11:51:05.000Z' });
  });
  it("a phone-keyed slot moves by conversation + root; its ledger entry lands on the row's recipient contact, none is written without one, and no line carries the phone", async () => {
    const x = world({}, 'phone#+15550002222');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent', carrierSentAt: '2026-09-28T11:51:01.000Z' } })).toBe('applied');
    expect(await x.ledger('c-held')).toBeUndefined();
    expect(x.capture.atLevel(30).some((l) => String(l.msg).includes('no ledger entry'))).toBe(true);
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' }, recipientContactId: 'c-held' })).toBe('applied');
    expect((await x.ledger('c-held'))?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'delivery' });
    expect(x.capture.lines.length).toBeGreaterThan(0);
    expect(x.capture.lines.every((l) => !JSON.stringify(l).includes('+15550002222'))).toBe(true);
  });
  it('a contact-keyed slot ignores a differing row recipient (the send-time contact is the slot key)', async () => {
    const x = world({});
    await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' }, recipientContactId: 'c-other' });
    expect(await x.ledger('c1')).toBeDefined();
    expect(await x.ledger('c-other')).toBeUndefined();
  });
  it('a share with no unitId moves the slot and writes no ledger entry', async () => {
    const x = world({}, 'c1', { unitId: undefined });
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(x.slot().status).toBe('delivered');
    expect(await x.ledger()).toBeUndefined();
    expect(x.emitted.length).toBe(1);
  });
  it("a lost condition re-reads and re-applies: the retry's failed that loses to its own sent wins on the second pass", async () => {
    const x = world({});
    let raced = false;
    const real = x.deps.broadcasts.applyAttemptOutcome.bind(x.deps.broadcasts);
    x.deps.broadcasts = { ...x.deps.broadcasts, async applyAttemptOutcome(id, key, exp, next, delta) {
      if (!raced) { raced = true; await real(id, key, exp, { status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY }, { failed: -1, sent: 1 }); }
      return real(id, key, exp, next, delta);
    } };
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30007' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'failed', errorCode: '30007', latestAttempt: RETRY });
    expect(x.share().stats).toMatchObject({ failed: 1, sent: 0 });
  });
  it('a condition that keeps losing past the re-read bound is lost with ONE WARN carrying the ids', async () => {
    const x = world({});
    let calls = 0;
    x.deps.broadcasts = { ...x.deps.broadcasts, async applyAttemptOutcome() { calls += 1; return { applied: false }; } };
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('lost');
    expect(calls).toBe(4);
    const warns = x.capture.atLevel(40).filter((l) => String(l.msg).includes('lost its condition'));
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatchObject({ broadcastId: 'b1', conversationId: 'conv-1', retryRoot: ROOT, attempt: RETRY });
    expect(x.slot()).toMatchObject({ status: 'failed', errorCode: '30003' });
    expect(x.emitted.length).toBe(0);
  });
  it('a committed write whose response was lost (the replay finds the slot already equal to next) reads as applied and still writes the ledger and emits', async () => {
    const x = world({});
    const real = x.deps.broadcasts.applyAttemptOutcome.bind(x.deps.broadcasts);
    let first = true;
    x.deps.broadcasts = { ...x.deps.broadcasts, async applyAttemptOutcome(id, key, exp, next, delta) {
      const res = await real(id, key, exp, next, delta);
      if (first) { first = false; throw new Error('socket hang up'); }   // committed, response lost
      return res;
    } };
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } }).catch(() => 'threw')).toBe('threw');
    // the caller's bounded retry replays the same input as a FRESH call: the slot already records it, the order rule
    // would refuse it, and the top-of-loop check answers applied and runs the side effects instead
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(x.share().stats).toMatchObject({ failed: 0, delivered: 1 });   // not double-counted
    expect((await x.ledger())?.shares?.['b1']?.state).toBe('counted');
    expect(x.emitted.length).toBe(1);
    expect(x.capture.atLevel(30).some((l) => String(l.msg).includes('already applied'))).toBe(true);
  });
  it("the SDK's own replay of a committed write (the condition refuses it) is told by the re-read and reads as applied", async () => {
    const x = world({});
    const real = x.deps.broadcasts.applyAttemptOutcome.bind(x.deps.broadcasts);
    x.deps.broadcasts = { ...x.deps.broadcasts, async applyAttemptOutcome(id, key, exp, next, delta) {
      await real(id, key, exp, next, delta);   // the first SDK attempt commits
      return real(id, key, exp, next, delta);  // its replay fails the condition
    } };
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(x.share().stats).toMatchObject({ failed: 0, delivered: 1 });
    expect((await x.ledger())?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'delivery' });
    expect(x.emitted.length).toBe(1);
  });
  it("a replayed failed-30003 outcome WITHOUT a promise never downgrades the winner's pending ledger entry", async () => {
    const x = world({});
    await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30003', retryDueAt: '2026-09-28T12:05:00.000Z' } });
    expect((await x.ledger())?.shares?.['b1']?.state).toBe('pending');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30003' } })).toBe('applied');   // the same slot state, replayed without the promise
    expect((await x.ledger())?.shares?.['b1']?.state).toBe('pending');
  });
  it('no slot and no broadcast are reported, never thrown', async () => {
    const x = world({});
    expect(await applyLaterAttempt(x.deps, { ...base, conversationId: 'conv-other', attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('no_slot');
    expect(await applyLaterAttempt(x.deps, { ...base, broadcastId: 'nope', attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('no_broadcast');
    expect(x.capture.atLevel(40).filter((l) => String(l.msg).includes('broadcast not found')).length).toBe(1);
    expect(x.emitted.length).toBe(0);
  });
  it("a miss tells its two causes apart (planner fix wave, adversarial 2): 'slot_unmatched' when the share holds a slot for the row's conversation whose original pointer differs (a wrong or unstamped root) or is absent, or the retry's recipient's own queued slot with no pointer yet (the fan-out's record phase pending); 'no_slot' only when nothing of the share ties to the row; nothing is written either way", async () => {
    const wrongRoot = world({});
    expect(await applyLaterAttempt(wrongRoot.deps, { ...base, retryRoot: 'other', attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('slot_unmatched');
    expect(wrongRoot.slot()).toMatchObject({ status: 'failed', errorCode: '30003', tsMsgId: ROOT });
    expect(wrongRoot.slot().latestAttempt).toBeUndefined();

    const noPointer = world({});
    noPointer.w.broadcasts.get('b1')!.recipients['c1'] = { status: 'failed', errorCode: '30003', conversationId: 'conv-1' };
    expect(await applyLaterAttempt(noPointer.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('slot_unmatched');

    const recordPending = world({});
    recordPending.w.broadcasts.get('b1')!.recipients['c1'] = { status: 'queued' };
    expect(await applyLaterAttempt(recordPending.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' }, recipientContactId: 'c1' })).toBe('slot_unmatched');
    // Nothing ties the row to that queued slot: no recipient named, or another recipient's.
    expect(await applyLaterAttempt(recordPending.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('no_slot');
    expect(await applyLaterAttempt(recordPending.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' }, recipientContactId: 'c2' })).toBe('no_slot');
    expect(recordPending.slot()).toStrictEqual({ status: 'queued' });

    for (const x of [wrongRoot, noPointer, recordPending]) expect(x.emitted.length).toBe(0);
    expect((await wrongRoot.ledger())).toBeUndefined();
  });
});

describe('applyLaterAttemptBounded', () => {
  it('a transient throw is retried and the slot lands', async () => {
    const x = world({});
    const real = x.deps.broadcasts.applyAttemptOutcome.bind(x.deps.broadcasts);
    let calls = 0;
    x.deps.broadcasts = { ...x.deps.broadcasts, async applyAttemptOutcome(...a) { calls += 1; if (calls === 1) throw new Error('dynamo blip'); return real(...a); } };
    expect(await applyLaterAttemptBounded(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(x.slot().status).toBe('delivered');
    expect(x.capture.atLevel(50).length).toBe(0);
  });
  it("a permanent throw is tried three times in all, then ONE ERROR with the ids and 'threw' - never propagated", async () => {
    const x = world({});
    let calls = 0;
    x.deps.broadcasts = { ...x.deps.broadcasts, async applyAttemptOutcome() { calls += 1; throw new Error('Item size has exceeded the maximum allowed size'); } };
    expect(await applyLaterAttemptBounded(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('threw');
    expect(calls).toBe(3);
    const errors = x.capture.atLevel(50);
    expect(errors.length).toBe(1);
    expect(String(errors[0]!.msg)).toContain('share slot write failed');
    expect(errors[0]).toMatchObject({ broadcastId: 'b1', conversationId: 'conv-1', retryRoot: ROOT, attempt: RETRY });
  });
  it('a non-throwing answer passes through unchanged', async () => {
    const x = world({ status: 'queued', errorCode: undefined });
    expect(await applyLaterAttemptBounded(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('refused');
  });
});

describe('wouldApply and projectSlot (the D2 rule alone, no reads)', () => {
  const failed: BroadcastRecipient = { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: ROOT };
  it('answers the order rule', () => {
    expect(wouldApply(failed, { attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30007' } })).toBe(true);
    expect(wouldApply({ ...failed, latestAttempt: LATER }, { attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30007' } })).toBe(false);
    expect(wouldApply({ ...failed, latestAttempt: LATER }, { attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe(true);
    expect(wouldApply({ ...failed, status: 'delivered', errorCode: undefined }, { attemptKey: LATER, outcome: { kind: 'delivered' } })).toBe(false);
    expect(wouldApply({ ...failed, status: 'queued', errorCode: undefined }, { attemptKey: RETRY, outcome: { kind: 'sent' } })).toBe(false);
    expect(wouldApply({ ...failed, latestAttempt: RETRY }, { attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30007' } })).toBe(false);
    expect(wouldApply({ status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY }, { attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30007' } })).toBe(true);
    expect(wouldApply({ status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY, carrierSentAt: 'x' }, { attemptKey: RETRY, outcome: { kind: 'sent', carrierSentAt: 'y' } })).toBe(false);
  });
  it('projects the slot as the write would leave it: the original pointer kept, the carrier instant replaced by a newer attempt and kept by the same one', () => {
    expect(projectSlot({ ...failed, carrierSentAt: 'old' }, { attemptKey: RETRY, outcome: { kind: 'delivered' } })).toEqual({ status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY });
    expect(projectSlot({ status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY, carrierSentAt: 'kept' }, { attemptKey: RETRY, outcome: { kind: 'delivered' } }))
      .toEqual({ status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY, carrierSentAt: 'kept' });
    expect(projectSlot(failed, { attemptKey: rowlessAttemptKey(ROOT), outcome: { kind: 'unresolved' } }))
      .toEqual({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: rowlessAttemptKey(ROOT) });
  });
});

describe('originalRowLedgerWrite', () => {
  it('a failed 30003 with a live promise is pending; a delivered row (a different share) counts by delivery at its instant; a failed 30007 is failed; no contact writes nothing', async () => {
    const x = world({});
    const row = { tsMsgId: ROOT, conversationId: 'conv-1', recipient_contact_id: 'c1' };
    await originalRowLedgerWrite(x.deps, { share: x.share(), contactKey: 'c1', row, outcome: { kind: 'failed', errorCode: '30003', retryDueAt: '2026-09-28T12:05:00.000Z' } });
    expect((await x.ledger())?.shares?.['b1']).toMatchObject({ attempt: ROOT, state: 'pending' });
    const y = world({ status: 'sent', errorCode: undefined });
    await originalRowLedgerWrite(y.deps, { share: y.share(), contactKey: 'c1', row, outcome: { kind: 'delivered' } });
    expect((await y.ledger())?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'delivery', countedAt: '2026-09-28T11:50:00.000Z' });
    const v = world({});
    await originalRowLedgerWrite(v.deps, { share: v.share(), contactKey: 'c1', row, outcome: { kind: 'failed', errorCode: '30007' } });
    expect((await v.ledger())?.shares?.['b1']).toMatchObject({ attempt: ROOT, state: 'failed' });
    const z = world({}, 'phone#+15550003333');
    await originalRowLedgerWrite(z.deps, { share: z.share(), contactKey: 'phone#+15550003333', row: { tsMsgId: ROOT, conversationId: 'conv-1' }, outcome: { kind: 'failed', errorCode: '30007' } });
    expect(await z.ledger('c1')).toBeUndefined();
    expect(z.capture.atLevel(30).some((l) => String(l.msg).includes('share ledger: no contact for the pair - no ledger entry'))).toBe(true);
  });
  it('a phone-keyed slot writes on the row recipient contact; a ledger write that throws is ONE ERROR, never propagated', async () => {
    const x = world({}, 'phone#+15550004444');
    await originalRowLedgerWrite(x.deps, { share: x.share(), contactKey: 'phone#+15550004444', row: { tsMsgId: ROOT, conversationId: 'conv-1', recipient_contact_id: 'c-held' }, outcome: { kind: 'delivered' } });
    expect((await x.ledger('c-held'))?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'delivery' });
    const y = world({});
    y.deps.ledger = { ...y.deps.ledger, listingSends: { ...y.w.listingSendsRepo, async putShareMemory() { throw new Error('dynamo down'); } } };
    await expect(originalRowLedgerWrite(y.deps, { share: y.share(), contactKey: 'c1', row: { tsMsgId: ROOT, conversationId: 'conv-1' }, outcome: { kind: 'delivered' } })).resolves.toBeUndefined();
    expect(y.capture.atLevel(50).filter((l) => String(l.msg).includes('share ledger: entry write failed')).length).toBe(1);
  });
});
