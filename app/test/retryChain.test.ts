// retry-send-adoption: the chain helpers (spec section 0, R1, R2 step 3, R4).
//
// Rows are appended through the harness fake's `append` with real lineage
// (retry_of, retry_attempt, retry_root), and every walk reads through the
// same consistent point-get production uses, spied to count the reads.
import { describe, expect, it, vi } from 'vitest';
import type { ConversationType } from '../src/repos/conversationsRepo.js';
import type { MessageItem, NewMessage } from '../src/repos/messagesRepo.js';
import {
  automaticAncestry,
  conversationRetryDecline,
  resolveRetryRoot,
  retryRecipientKey,
} from '../src/services/retryChain.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const CONV = 'conv-chain';
const PHONE = '+15550100001';

function ts(minute: number): string {
  return `2026-09-27T12:${String(minute).padStart(2, '0')}:00.000Z`;
}

/** One outbound one-to-one row in CONV, appended through the fake with its lineage; the stored row. */
async function row(world: FakeWorld, sid: string, minute: number, lineage: Partial<NewMessage> = {}): Promise<MessageItem> {
  const res = await world.messagesRepo.append({
    conversationId: CONV,
    providerSid: sid,
    providerTs: ts(minute),
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    body: 'hello',
    deliveryStatus: 'undelivered',
    errorCode: '30003',
    ...lineage,
  });
  const stored = await world.messagesRepo.getByTsMsgIdConsistent(CONV, res.tsMsgId);
  if (stored === undefined) throw new Error(`test setup: row ${sid} was not stored`);
  return stored;
}

/** An automatic rung-`attempt` retry of `parent` (pre-deploy when `root` is omitted: no retry_root). */
function auto(parent: MessageItem, attempt: number, root?: MessageItem): Partial<NewMessage> {
  return { retryOf: parent.tsMsgId, retryAttempt: attempt, ...(root !== undefined && { retryRoot: root.tsMsgId }) };
}

describe('resolveRetryRoot (spec section 0)', () => {
  it('a row carrying retry_root answers it with no read', async () => {
    const world = createFakeWorld();
    const root = await row(world, 'SMroot', 0);
    const r1 = await row(world, 'SMr1', 1, auto(root, 1, root));
    const r2 = await row(world, 'SMr2', 2, auto(r1, 2, root));
    const reads = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent');
    expect(await resolveRetryRoot(world.messagesRepo, r2)).toBe(root.tsMsgId);
    expect(reads).not.toHaveBeenCalled();
  });

  it('a row with no retry_of is its own root, with no read', async () => {
    const world = createFakeWorld();
    const root = await row(world, 'SMroot', 0);
    const reads = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent');
    expect(await resolveRetryRoot(world.messagesRepo, root)).toBe(root.tsMsgId);
    expect(reads).not.toHaveBeenCalled();
  });

  it('a pre-deploy attempt-2 row walks retry_of to the root in two consistent reads', async () => {
    const world = createFakeWorld();
    const root = await row(world, 'SMroot', 0);
    const r1 = await row(world, 'SMr1', 1, auto(root, 1));
    const r2 = await row(world, 'SMr2', 2, auto(r1, 2));
    const reads = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent');
    expect(await resolveRetryRoot(world.messagesRepo, r2)).toBe(root.tsMsgId);
    expect(reads.mock.calls).toStrictEqual([
      [CONV, r1.tsMsgId],
      [CONV, root.tsMsgId],
    ]);
  });

  it('a pre-deploy row over a row that carries retry_root stops there (a chain straddling the deploy)', async () => {
    const world = createFakeWorld();
    const root = await row(world, 'SMroot', 0);
    const r1 = await row(world, 'SMr1', 1, auto(root, 1, root));
    const manual = await row(world, 'SMmanual', 2, { retryOf: r1.tsMsgId });
    const reads = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent');
    expect(await resolveRetryRoot(world.messagesRepo, manual)).toBe(root.tsMsgId);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('a broken link stops at the last row read', async () => {
    const world = createFakeWorld();
    const r1 = await row(world, 'SMr1', 1, { retryOf: `${ts(0)}#SMgone`, retryAttempt: 1 });
    const r2 = await row(world, 'SMr2', 2, auto(r1, 2));
    expect(await resolveRetryRoot(world.messagesRepo, r2)).toBe(r1.tsMsgId);
    // ...and a row whose own parent is gone is its own answer.
    expect(await resolveRetryRoot(world.messagesRepo, r1)).toBe(r1.tsMsgId);
  });

  it('stops after MAX_SEND_RETRY_ATTEMPTS (3) hops on a deeper pre-deploy chain', async () => {
    const world = createFakeWorld();
    const root = await row(world, 'SMroot', 0);
    const r1 = await row(world, 'SMr1', 1, auto(root, 1));
    const r2 = await row(world, 'SMr2', 2, auto(r1, 2));
    const r3 = await row(world, 'SMr3', 3, auto(r2, 3));
    const manual = await row(world, 'SMmanual', 4, { retryOf: r3.tsMsgId });
    const reads = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent');
    // Three hops from the manual row reach r1; the root is a fourth hop away.
    expect(await resolveRetryRoot(world.messagesRepo, manual)).toBe(r1.tsMsgId);
    expect(reads).toHaveBeenCalledTimes(3);
  });
});

describe('automaticAncestry (R4: the predecessors of an attempt)', () => {
  it('a root has no automatic ancestry, with no read', async () => {
    const world = createFakeWorld();
    const root = await row(world, 'SMroot', 0);
    const reads = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent');
    expect(await automaticAncestry(world.messagesRepo, root)).toStrictEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it('a manual row has no automatic ancestry', async () => {
    const world = createFakeWorld();
    const root = await row(world, 'SMroot', 0);
    const manual = await row(world, 'SMmanual', 1, { retryOf: root.tsMsgId, retryRoot: root.tsMsgId });
    expect(await automaticAncestry(world.messagesRepo, manual)).toStrictEqual([]);
  });

  it('an automatic attempt-2 row over attempt 1 over the root: both automatic rows, the retried row first', async () => {
    const world = createFakeWorld();
    const root = await row(world, 'SMroot', 0);
    const r1 = await row(world, 'SMr1', 1, auto(root, 1, root));
    const r2 = await row(world, 'SMr2', 2, auto(r1, 2, root));
    const walked = await automaticAncestry(world.messagesRepo, r2);
    expect(walked.map((m) => m.tsMsgId)).toStrictEqual([r2.tsMsgId, r1.tsMsgId]);
  });

  it('stops at a MANUAL row: a chain restarted by a manual Retry walks only its own automatic rows', async () => {
    const world = createFakeWorld();
    const root = await row(world, 'SMroot', 0);
    const r1 = await row(world, 'SMr1', 1, auto(root, 1, root));
    const manual = await row(world, 'SMmanual', 2, { retryOf: r1.tsMsgId, retryRoot: root.tsMsgId });
    const m1 = await row(world, 'SMm1', 3, auto(manual, 1, root));
    const walked = await automaticAncestry(world.messagesRepo, m1);
    expect(walked.map((m) => m.tsMsgId)).toStrictEqual([m1.tsMsgId]);
  });

  it('a broken link returns the rows read so far', async () => {
    const world = createFakeWorld();
    const r1 = await row(world, 'SMr1', 1, { retryOf: `${ts(0)}#SMgone`, retryAttempt: 1 });
    const r2 = await row(world, 'SMr2', 2, auto(r1, 2));
    const walked = await automaticAncestry(world.messagesRepo, r2);
    expect(walked.map((m) => m.tsMsgId)).toStrictEqual([r2.tsMsgId, r1.tsMsgId]);
  });
});

describe('retryRecipientKey (R1: from immutable data)', () => {
  it('the recorded recipient contact wins', () => {
    expect(retryRecipientKey({ recipient_contact_id: 'c-1' }, { participant_phone: PHONE })).toBe('c-1');
  });

  it("falls back to the thread's number", () => {
    expect(retryRecipientKey({}, { participant_phone: PHONE })).toBe(`phone#${PHONE}`);
    expect(retryRecipientKey({ recipient_contact_id: '' }, { participant_phone: PHONE })).toBe(`phone#${PHONE}`);
  });

  it('neither: undefined (the attempt is unaddressable)', () => {
    expect(retryRecipientKey({}, undefined)).toBeUndefined();
    expect(retryRecipientKey({}, {})).toBeUndefined();
    expect(retryRecipientKey({ recipient_contact_id: '' }, { participant_phone: '' })).toBeUndefined();
  });
});

describe('conversationRetryDecline (R2 step 3: the webhook decision vocabulary)', () => {
  it.each<ConversationType>(['tenant_1to1', 'landlord_1to1', 'partner_1to1', 'unknown_1to1'])(
    'a %s thread with a phone is retryable',
    (type) => {
      expect(conversationRetryDecline({ type, participant_phone: PHONE })).toBeUndefined();
    },
  );

  it('a group text declines group_text', () => {
    expect(conversationRetryDecline({ type: 'group_text', participant_phone: PHONE })).toBe('group_text');
  });

  it('a relay group declines not_one_to_one, even though it carries a (pool) phone', () => {
    expect(conversationRetryDecline({ type: 'relay_group', participant_phone: PHONE })).toBe('not_one_to_one');
  });

  it('a one-to-one thread with no phone (an email thread) declines not_one_to_one', () => {
    expect(conversationRetryDecline({ type: 'tenant_1to1' })).toBe('not_one_to_one');
    expect(conversationRetryDecline({ type: 'tenant_1to1', participant_phone: '' })).toBe('not_one_to_one');
  });

  it('a missing conversation declines conversation_missing', () => {
    expect(conversationRetryDecline(undefined)).toBe('conversation_missing');
  });
});
