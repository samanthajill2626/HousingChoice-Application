// retry-send-adoption R3: the two promise writes on the RETRIED ROW, over the
// harness fake (its annotateRetryPromise mirrors the real condition; the parity
// suite holds it there) and a captured logger.
//
// REFRESH moves `retry_due_at` from the value the caller read; a lost
// condition means a newer promise stands and is dropped (INFO). WITHDRAW writes
// the sentinel AND retry_outcome 'unconfirmed' in one write, is retried ONCE
// from a fresh consistent read, and is a no-op on a row that already holds
// both. Neither throws: a failed write is one ERROR and the attempt record
// decides.
//
// The fake's reads return the LIVE stored object (build worklist item 11), so
// a case that needs a caller holding a STALE read passes a copy.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import {
  refreshRetryPromise,
  withdrawRetryPromise,
  type RetryPromiseDeps,
} from '../src/services/retryPromiseWrites.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const CONV = 'conv-promise';
const SID = 'SMretried';
const SENT_AT = '2026-09-27T12:00:00.000Z';
const DUE_1 = '2026-09-27T12:01:00.000Z';
const DUE_2 = '2026-09-27T12:05:00.000Z';
const DUE_3 = '2026-09-27T12:09:00.000Z';
const CTX = { conversationId: CONV, retryRoot: `${SENT_AT}#SMroot`, retriedTsMsgId: `${SENT_AT}#${SID}`, attempt: 1 };
const WITHDRAWN = { retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' };

const INFO = 30;
const ERROR = 50;
const DROPPED = 'retry promise refresh dropped - a newer promise stands';
const FAILED = 'failure-arm write failed (best-effort); the attempt record decides';

/** A failed one-to-one row carrying a live promise (DUE_1), as the 30003 webhook leaves it; the LIVE stored row. */
async function setup() {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const deps: RetryPromiseDeps = {
    messages: world.messagesRepo,
    events: world.events,
    log: createLogger({ level: 'info', destination: capture.stream }),
  };
  await world.messagesRepo.append({
    conversationId: CONV,
    providerSid: SID,
    providerTs: SENT_AT,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    body: 'hello',
    deliveryStatus: 'sent',
  });
  await world.messagesRepo.updateDeliveryStatus(SID, 'undelivered', '30003', { retryDueAt: DUE_1 });
  const row = await world.messagesRepo.getByProviderSid(SID);
  if (row === undefined) throw new Error('test setup: the retried row was not stored');
  return { world, capture, deps, row };
}

const persisted = (world: ReturnType<typeof createFakeWorld>) =>
  world.emitted.filter((e) => e.event === 'message.persisted').map((e) => e.payload);

const lines = (capture: ReturnType<typeof createLogCapture>, level: number, msg: string) =>
  capture.atLevel(level).filter((l) => l['msg'] === msg);

describe('refreshRetryPromise (R3 REFRESH)', () => {
  it('over the value it read: writes, and emits ONE message.persisted for the retried row', async () => {
    const { world, capture, deps, row } = await setup();
    expect(await refreshRetryPromise(deps, row, DUE_2, CTX)).toBe(true);
    expect((await world.messagesRepo.getByProviderSid(SID))?.retry_due_at).toBe(DUE_2);
    expect(persisted(world)).toStrictEqual([
      { conversationId: CONV, tsMsgId: row.tsMsgId, direction: 'outbound', deliveryStatus: 'undelivered' },
    ]);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  it('over a MOVED value: false, nothing written, nothing emitted, one INFO', async () => {
    const { world, capture, deps, row } = await setup();
    const stale: MessageItem = { ...row };
    await world.messagesRepo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: DUE_1 });
    expect(await refreshRetryPromise(deps, stale, DUE_3, CTX)).toBe(false);
    expect((await world.messagesRepo.getByProviderSid(SID))?.retry_due_at).toBe(DUE_2);
    expect(persisted(world)).toStrictEqual([]);
    expect(lines(capture, INFO, DROPPED)).toStrictEqual([expect.objectContaining({ ...CTX, retryDueAt: DUE_3 })]);
  });

  it('a throwing write: false, one ERROR under the wired err key, nothing emitted', async () => {
    const { world, capture, deps, row } = await setup();
    vi.spyOn(world.messagesRepo, 'annotateRetryPromise').mockRejectedValueOnce(new Error('dynamo down'));
    expect(await refreshRetryPromise(deps, row, DUE_2, CTX)).toBe(false);
    expect(capture.atLevel(ERROR)).toStrictEqual([
      expect.objectContaining({ ...CTX, retryDueAt: DUE_2, label: 'refreshRetryPromise', msg: FAILED, err: expect.anything() }),
    ]);
    expect(persisted(world)).toStrictEqual([]);
    expect((await world.messagesRepo.getByProviderSid(SID))?.retry_due_at).toBe(DUE_1);
  });
});

describe('withdrawRetryPromise (R3 WITHDRAW, the Q1 ruling)', () => {
  it("over the value it read: 'written' - the sentinel and the outcome in one write - and one emit", async () => {
    const { world, capture, deps, row } = await setup();
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    expect(await withdrawRetryPromise(deps, row, CTX)).toBe('written');
    expect(annotate).toHaveBeenCalledTimes(1);
    expect(await world.messagesRepo.getByProviderSid(SID)).toMatchObject(WITHDRAWN);
    expect(persisted(world)).toStrictEqual([
      { conversationId: CONV, tsMsgId: row.tsMsgId, direction: 'outbound', deliveryStatus: 'undelivered' },
    ]);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  it("a STALE input row (the stored promise moved once): 'written' after one fresh read, two annotates, one emit", async () => {
    const { world, deps, row } = await setup();
    const stale: MessageItem = { ...row };
    await world.messagesRepo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: DUE_1 });
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    const reread = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent');
    expect(await withdrawRetryPromise(deps, stale, CTX)).toBe('written');
    expect(annotate.mock.calls.map((call) => call[3])).toStrictEqual([{ retryDueAt: DUE_1 }, { retryDueAt: DUE_2 }]);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(await world.messagesRepo.getByProviderSid(SID)).toMatchObject(WITHDRAWN);
    expect(persisted(world)).toHaveLength(1);
  });

  it("the CURRENT row already withdrawn (the superseded exit's re-apply): 'already', no write, no emit", async () => {
    const { world, deps, row } = await setup();
    await world.messagesRepo.annotateRetryPromise(
      CONV,
      row.tsMsgId,
      { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' },
      { retryDueAt: DUE_1 },
    );
    const current = await world.messagesRepo.getByTsMsgIdConsistent(CONV, row.tsMsgId);
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    expect(await withdrawRetryPromise(deps, current!, CTX)).toBe('already');
    expect(annotate).not.toHaveBeenCalled();
    expect(persisted(world)).toStrictEqual([]);
  });

  it("a STALE input row whose stored twin is already withdrawn: 'already' after one lost annotate, no emit", async () => {
    const { world, capture, deps, row } = await setup();
    const stale: MessageItem = { ...row };
    await world.messagesRepo.annotateRetryPromise(
      CONV,
      row.tsMsgId,
      { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' },
      { retryDueAt: DUE_1 },
    );
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    expect(await withdrawRetryPromise(deps, stale, CTX)).toBe('already');
    expect(annotate).toHaveBeenCalledTimes(1);
    expect(persisted(world)).toStrictEqual([]);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  it("the sentinel ALONE (RSW's enqueue-failure withdrawal) is not 'already': the WITHDRAW adds the outcome", async () => {
    const { world, deps, row } = await setup();
    await world.messagesRepo.annotateMessage(CONV, row.tsMsgId, { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT });
    const current = await world.messagesRepo.getByTsMsgIdConsistent(CONV, row.tsMsgId);
    expect(current).not.toHaveProperty('retry_outcome');
    expect(await withdrawRetryPromise(deps, { ...current! }, CTX)).toBe('written');
    expect(await world.messagesRepo.getByProviderSid(SID)).toMatchObject(WITHDRAWN);
  });

  it("a writer that moves the promise between both attempts: 'lost', one ERROR, no emit", async () => {
    const { world, capture, deps, row } = await setup();
    vi.spyOn(world.messagesRepo, 'annotateRetryPromise').mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    expect(await withdrawRetryPromise(deps, row, CTX)).toBe('lost');
    expect(capture.atLevel(ERROR)).toStrictEqual([
      expect.objectContaining({ ...CTX, msg: 'retry promise withdrawal lost twice - a concurrent writer keeps moving the promise' }),
    ]);
    expect(persisted(world)).toStrictEqual([]);
    expect((await world.messagesRepo.getByProviderSid(SID))?.retry_due_at).toBe(DUE_1);
  });

  it("a missing row: 'failed', one ERROR naming it", async () => {
    const { world, capture, deps, row } = await setup();
    const ghost: MessageItem = { ...row, tsMsgId: `${SENT_AT}#SMghost`, provider_sid: 'SMghost' };
    expect(await withdrawRetryPromise(deps, ghost, CTX)).toBe('failed');
    expect(capture.atLevel(ERROR)).toStrictEqual([
      expect.objectContaining({ ...CTX, msg: 'retry promise withdrawal failed - the retried row is missing' }),
    ]);
    expect(persisted(world)).toStrictEqual([]);
  });

  it("a throwing write or re-read: 'failed', one ERROR under the wired err key, never a throw", async () => {
    const { world, capture, deps, row } = await setup();
    vi.spyOn(world.messagesRepo, 'annotateRetryPromise').mockRejectedValueOnce(new Error('dynamo down'));
    expect(await withdrawRetryPromise(deps, row, CTX)).toBe('failed');
    const stale: MessageItem = { ...row, retry_due_at: DUE_3 };
    vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent').mockRejectedValueOnce(new Error('dynamo down'));
    expect(await withdrawRetryPromise(deps, stale, CTX)).toBe('failed');
    expect(capture.atLevel(ERROR)).toStrictEqual([
      expect.objectContaining({ ...CTX, label: 'withdrawRetryPromise', msg: FAILED, err: expect.anything() }),
      expect.objectContaining({ ...CTX, label: 'withdrawRetryPromise', msg: FAILED, err: expect.anything() }),
    ]);
    expect(persisted(world)).toStrictEqual([]);
    expect((await world.messagesRepo.getByProviderSid(SID))?.retry_due_at).toBe(DUE_1);
  });
});
