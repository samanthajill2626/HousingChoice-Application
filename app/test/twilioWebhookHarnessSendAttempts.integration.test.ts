// Does the harness's send-attempt FAKE agree with the real repo?
//
// WHY THIS EXISTS. The send sites (broadcast fan-out, relay fan-out, relay
// retry rung) and the send.reconcile job are unit-tested against
// `world.sendAttemptsRepo`, the in-memory twin of
// app/src/repos/sendAttemptsRepo.ts built in
// app/test/helpers/twilioWebhookHarness.ts. Every decision those sites make -
// send, defer, skip, take over, hand off - rests on what a claim or a fenced
// transition answers, so a fake that answers differently from DynamoDB would
// let every one of those tests pass against behavior production never has.
// The idiom is app/test/unreadIndexFakeMirror.integration.test.ts.
//
// THE SHAPE. Each case is a SCRIPT of repo calls. The script runs step by
// step through BOTH the real repo (against DynamoDB Local) and a fresh fake
// world, and after every step requires the same answer: the call's result
// (a boolean, a claim result, a record), every owner's `get()`, the
// recipient index as `listByRecipient` reads it, and the raw index items.
// Where a step also names what the answer should BE, that is asserted on the
// real answer, so a script cannot silently stop exercising its branch.
//
// Owners and recipient digests are unique per case: the table is created
// once per file and never reset.
import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { hashRecipientKey } from '../src/lib/sendFingerprint.js';
import { SEND_CLAIM_TTL_MS } from '../src/lib/sendOutcome.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  attemptKey,
  createSendAttemptsRepo,
  ownerKey,
  SEND_ATTEMPT_INDEX_PREFIX,
  SEND_ATTEMPT_PARTITION_PREFIX,
  type AttemptRef,
  type ClaimResult,
  type SendAttemptFacts,
  type SendAttemptOutcome,
  type SendAttemptOwner,
  type SendAttemptRecord,
  type SendAttemptsRepo,
} from '../src/repos/sendAttemptsRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(`[twilioWebhookHarnessSendAttempts] SKIPPED - no DynamoDB Local at ${endpoint}.`);
}

const T0 = '2026-09-26T12:00:00.000Z';
const SENDER = '+15550009999';
const EARLY = '2026-09-26T00:00:00.000Z';

/** `T0` plus `ms`, as an ISO string. */
function at(ms: number): string {
  return new Date(Date.parse(T0) + ms).toISOString();
}

/** One implementation's view of a running case. */
interface Ctx {
  owners: SendAttemptOwner[];
  facts: SendAttemptFacts;
  /** The most recent claim result, per implementation (takeOver reads it). */
  last?: ClaimResult;
  /** The attempt the site holds: the last claim's, replaced by each successful re-arm (FW1-1). */
  ref?: AttemptRef;
}

/** Which implementation a step is running against (a seed step writes each one's store directly). */
type Impl = { kind: 'real' } | { kind: 'fake'; world: FakeWorld };

interface Step {
  label: string;
  run: (repo: SendAttemptsRepo, ctx: Ctx, impl: Impl) => Promise<unknown>;
  /** What the REAL answer must be (toBe for a primitive, toMatchObject otherwise). */
  expect?: unknown;
}

interface Case {
  name: string;
  /** The case's owners; o[0] is the default target. `id` is unique to the case. */
  owners: (id: string) => SendAttemptOwner[];
  steps: Step[];
}

// ---- step builders -------------------------------------------------------

function lastRef(ctx: Ctx): AttemptRef {
  if (ctx.ref !== undefined) return ctx.ref;
  if (ctx.last === undefined) throw new Error('script error: no claim yet');
  return { attemptNo: ctx.last.record.attemptNo, attemptedAt: ctx.last.record.attemptedAt };
}

const claim = (nowIso: string, expectation?: unknown, opts: { o?: number; facts?: (f: SendAttemptFacts) => SendAttemptFacts } = {}): Step => ({
  label: `claim@${nowIso}${opts.o ? ` o${opts.o}` : ''}`,
  run: async (repo, ctx) => {
    const facts = opts.facts ? opts.facts(ctx.facts) : ctx.facts;
    const result = await repo.claim(ctx.owners[opts.o ?? 0]!, facts, nowIso);
    ctx.last = result;
    ctx.ref = { attemptNo: result.record.attemptNo, attemptedAt: result.record.attemptedAt };
    return result;
  },
  ...(expectation !== undefined && { expect: expectation }),
});

/** FW1-1: re-arm the held attempt (or an explicit ref) at `nowIso`; a successful re-arm replaces the held ref. */
const rearm = (ref: AttemptRef | 'last', nowIso: string, expectation: AttemptRef | 'refused', o = 0): Step => ({
  label: `rearm ${ref === 'last' ? 'last' : `${ref.attemptNo}@${ref.attemptedAt}`} at ${nowIso}`,
  run: async (repo, ctx) => {
    const result = await repo.rearm(ctx.owners[o]!, ref === 'last' ? lastRef(ctx) : ref, nowIso);
    if (result !== undefined) ctx.ref = result;
    return result ?? 'refused';
  },
  expect: expectation,
});

const finish = (
  ref: AttemptRef | 'last',
  result: { outcome: SendAttemptOutcome; sid?: string; cause?: string },
  expectation: boolean,
  o = 0,
): Step => ({
  label: `finishAttempt ${ref === 'last' ? 'last' : `${ref.attemptNo}@${ref.attemptedAt}`} ${result.outcome}`,
  run: (repo, ctx) => repo.finishAttempt(ctx.owners[o]!, ref === 'last' ? lastRef(ctx) : ref, result),
  expect: expectation,
});

const hand = (ref: AttemptRef | 'last', expectation: boolean, sid?: string, o = 0): Step => ({
  label: `handToReconcile ${ref === 'last' ? 'last' : `${ref.attemptNo}@${ref.attemptedAt}`}${sid ? ` sid ${sid}` : ''}`,
  run: (repo, ctx) => repo.handToReconcile(ctx.owners[o]!, ref === 'last' ? lastRef(ctx) : ref, sid),
  expect: expectation,
});

const takeOver = (expectation: boolean, patch: Partial<SendAttemptRecord> = {}, o = 0): Step => ({
  label: `takeOver last${Object.keys(patch).length > 0 ? ` patched ${JSON.stringify(patch)}` : ''}`,
  run: (repo, ctx) => {
    if (ctx.last === undefined) throw new Error('script error: no claim yet');
    return repo.takeOver(ctx.owners[o]!, { ...ctx.last.record, ...patch });
  },
  expect: expectation,
});

const check = (attemptedAt: string, checkNo: number, expectation: boolean, o = 0): Step => ({
  label: `recordCheck ${checkNo}@${attemptedAt}`,
  run: (repo, ctx) => repo.recordCheck(ctx.owners[o]!, attemptedAt, checkNo),
  expect: expectation,
});

const redrive = (attemptedAt: string, expectation: boolean, o = 0): Step => ({
  label: `markRedriven@${attemptedAt}`,
  run: (repo, ctx) => repo.markRedriven(ctx.owners[o]!, attemptedAt),
  expect: expectation,
});

const closeRec = (
  attemptedAt: string,
  result: { outcome: 'adopted' | 'unresolved' | 'enqueue_failed' | 'redrive_refused'; sid?: string; cause?: string },
  expectation: boolean,
  o = 0,
): Step => ({
  label: `closeFromReconcile@${attemptedAt} ${result.outcome}`,
  run: (repo, ctx) => repo.closeFromReconcile(ctx.owners[o]!, attemptedAt, result),
  expect: expectation,
});

const closeRed = (
  result: { outcome: 'refused' | 'redrive_refused' | 'enqueue_failed' | 'unresolved'; cause?: string },
  expectation: boolean,
  o = 0,
): Step => ({
  label: `closeRedriven ${result.outcome}`,
  run: (repo, ctx) => repo.closeRedriven(ctx.owners[o]!, result),
  expect: expectation,
});

/** A step that scribbles on the records a call handed back: the store must not change. */
const scribble = (): Step => ({
  label: 'scribble on returned records',
  run: async (repo, ctx) => {
    const got = await repo.get(ctx.owners[0]!);
    if (got !== undefined) {
      got.state = 'done';
      got.attemptNo = 99;
      (got.owner as { kind: string }).kind = 'scribbled';
    }
    const listed = await repo.listByRecipient(SENDER, ctx.facts.recipientDigest, EARLY);
    for (const row of listed) row.checkNo = 42;
    if (ctx.last !== undefined) ctx.last.record.redriveCount = 7;
    return 'scribbled';
  },
});

/**
 * Seed a state no API call produces, the way a downstream unit test seeds the
 * fake (`world.sendAttempts.set(attemptKey(owner), record)`), and the same
 * edit on the real item - so the fake is held to the real answers from a
 * SEEDED record too, not only from states the API reaches.
 */
const seed = (patch: { checkNo?: number; redriveCount?: number }, o = 0): Step => ({
  label: `seed ${JSON.stringify(patch)}`,
  run: async (_repo, ctx, impl) => {
    const owner = ctx.owners[o]!;
    if (impl.kind === 'fake') {
      const key = attemptKey(owner);
      const current = impl.world.sendAttempts.get(key);
      if (current === undefined) throw new Error('script error: nothing to seed');
      impl.world.sendAttempts.set(key, { ...current, ...patch });
      return 'seeded';
    }
    const sets: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    if (patch.checkNo !== undefined) {
      sets.push('#ck = :ck');
      names['#ck'] = 'check_no';
      values[':ck'] = patch.checkNo;
    }
    if (patch.redriveCount !== undefined) {
      sets.push('#rc = :rc');
      names['#rc'] = 'redrive_count';
      values[':rc'] = patch.redriveCount;
    }
    const recipientKey = owner.kind === 'broadcast' ? owner.contactKey : owner.memberKey;
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { conversationId: `${SEND_ATTEMPT_PARTITION_PREFIX}${ownerKey(owner)}`, tsMsgId: hashRecipientKey(recipientKey) },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(tsMsgId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return 'seeded';
  },
});

const noSender = (f: SendAttemptFacts): SendAttemptFacts => {
  const { sender: _sender, ...rest } = f;
  return rest;
};

// ---- the scripts ---------------------------------------------------------

const broadcastOwner = (id: string, contactKey = 'phone#+16175550100'): SendAttemptOwner => ({
  kind: 'broadcast',
  broadcastId: `b-${id}`,
  contactKey,
});

const CASES: Case[] = [
  {
    name: 'fresh claim; refused fresh inside the TTL and AT it; stale takeover; the late outcome refused; the reconcile checks and adopts',
    owners: (id) => [broadcastOwner(id)],
    steps: [
      claim(T0, { outcome: 'claimed', record: { state: 'attempting', attemptNo: 1, attemptedAt: T0 } }),
      claim(at(5_000), { outcome: 'refused', fresh: true }),
      claim(at(SEND_CLAIM_TTL_MS), { outcome: 'refused', fresh: true }),
      claim(at(SEND_CLAIM_TTL_MS + 1), { outcome: 'takeover', record: { state: 'attempting', attemptedAt: T0 } }),
      takeOver(true),
      takeOver(false),
      finish({ attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' }, false),
      claim(at(60_000), { outcome: 'refused', fresh: false, record: { state: 'reconciling' } }),
      check(T0, 0, true),
      check(T0, 1, true),
      check(T0, 1, true),
      check(T0, 3, false),
      check(at(5_000), 2, false),
      check(T0, 2, true),
      check(T0, 1, false),
      closeRec(T0, { outcome: 'adopted', sid: 'SM9' }, true),
      closeRec(T0, { outcome: 'unresolved', cause: 'x' }, false),
      claim(at(120_000), { outcome: 'refused', fresh: false, record: { state: 'done', outcome: 'adopted' } }),
    ],
  },
  {
    name: 'refused terminal: a sent record refuses every later claim',
    owners: (id) => [broadcastOwner(id, 'c-1')],
    steps: [
      claim(T0),
      finish('last', { outcome: 'sent', sid: 'SM1' }, true),
      finish('last', { outcome: 'sent', sid: 'SM1' }, false),
      claim(at(5_000), { outcome: 'refused', fresh: false, record: { state: 'done', outcome: 'sent', sid: 'SM1' } }),
      claim(at(3_600_000), { outcome: 'refused', fresh: false }),
      hand('last', false),
      redrive(T0, false),
      closeRed({ outcome: 'refused' }, false),
    ],
  },
  {
    name: 'the finishAttempt and handToReconcile fences; a known SID; a rejection with a cause',
    owners: (id) => [broadcastOwner(id), broadcastOwner(`${id}-2`, 'c-2')],
    steps: [
      claim(T0),
      finish({ attemptNo: 1, attemptedAt: at(5_000) }, { outcome: 'sent', sid: 'SM1' }, false),
      finish({ attemptNo: 2, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' }, false),
      hand({ attemptNo: 1, attemptedAt: at(5_000) }, false),
      hand({ attemptNo: 2, attemptedAt: T0 }, false),
      check(T0, 0, false),
      closeRec(T0, { outcome: 'unresolved' }, false),
      hand('last', true, 'SM7'),
      hand('last', false),
      finish('last', { outcome: 'sent', sid: 'SM7' }, false),
      closeRed({ outcome: 'refused' }, false),
      closeRec(T0, { outcome: 'adopted', sid: 'SM7' }, true),
      claim(T0, undefined, { o: 1 }),
      finish('last', { outcome: 'rejected', cause: '21211' }, true, 1),
      claim(at(5_000), { outcome: 'refused', fresh: false, record: { outcome: 'rejected', cause: '21211' } }, { o: 1 }),
    ],
  },
  {
    name: 're-claims after retryable, with new facts and without a sender, then list (build finding T5-5)',
    owners: (id) => [broadcastOwner(id)],
    steps: [
      claim(T0),
      finish('last', { outcome: 'retryable', cause: '20429' }, true),
      claim(at(10_000), { outcome: 'claimed', record: { attemptNo: 2, attemptedAt: at(10_000) } }, {
        facts: (f) => ({ ...noSender(f), bodyHash: 'e'.repeat(64), bodyShort: true, mediaCount: 2 }),
      }),
      finish('last', { outcome: 'retryable' }, true),
      claim(at(30_000), { outcome: 'claimed', record: { attemptNo: 3 } }),
      finish('last', { outcome: 'sent', sid: 'SM3' }, true),
    ],
  },
  {
    name: 'a same-instant re-claim rewrites its index item in place',
    owners: (id) => [broadcastOwner(id, 'c-9')],
    steps: [
      claim(T0),
      finish('last', { outcome: 'retryable', cause: '20429' }, true),
      claim(T0, { outcome: 'claimed', record: { attemptNo: 2, attemptedAt: T0 } }),
    ],
  },
  {
    name: 'the redriven claim and the one-re-drive rule',
    owners: (id) => [broadcastOwner(id)],
    steps: [
      claim(T0),
      hand('last', true),
      redrive(at(5_000), false),
      redrive(T0, true),
      redrive(T0, false),
      claim(at(10_000), { outcome: 'claimed', record: { attemptNo: 2, attemptedAt: at(10_000), redriveCount: 1 } }),
      hand('last', true),
      redrive(at(10_000), false),
      closeRec(at(10_000), { outcome: 'unresolved', cause: 'no_match' }, true),
      closeRec(at(10_000), { outcome: 'unresolved', cause: 'no_match' }, false),
      claim(at(20_000), { outcome: 'refused', fresh: false }),
    ],
  },
  {
    name: 'closeRedriven closes a redriven record once, with and without a cause',
    owners: (id) => [broadcastOwner(id, 'c-1'), broadcastOwner(id, 'c-2')],
    steps: [
      claim(T0),
      hand('last', true),
      closeRed({ outcome: 'enqueue_failed', cause: 'enqueue_failed' }, false),
      redrive(T0, true),
      closeRed({ outcome: 'enqueue_failed', cause: 'enqueue_failed' }, true),
      closeRed({ outcome: 'enqueue_failed', cause: 'enqueue_failed' }, false),
      claim(at(5_000), { outcome: 'refused', fresh: false }),
      claim(T0, undefined, { o: 1 }),
      hand('last', true, undefined, 1),
      redrive(T0, true, 1),
      closeRed({ outcome: 'refused' }, true, 1),
      claim(at(5_000), { outcome: 'refused', fresh: false, record: { outcome: 'refused' } }, { o: 1 }),
    ],
  },
  {
    name: 'a stale takeover of a re-claimed attempt keeps ITS attemptedAt; takeOver is fenced on the record handed in',
    owners: (id) => [broadcastOwner(id)],
    steps: [
      claim(T0),
      finish('last', { outcome: 'retryable' }, true),
      claim(at(5_000)),
      takeOver(false, { attemptNo: 1 }),
      takeOver(false, { attemptedAt: T0 }),
      claim(at(5_000 + SEND_CLAIM_TTL_MS + 1), { outcome: 'takeover', record: { attemptNo: 2, attemptedAt: at(5_000) } }),
      takeOver(true),
      hand({ attemptNo: 2, attemptedAt: at(5_000) }, false),
      closeRec(T0, { outcome: 'unresolved' }, false),
      closeRec(at(5_000), { outcome: 'unresolved', cause: 'provider_unreachable' }, true),
    ],
  },
  {
    name: 'siblings on one recipient: three owner kinds at the same instant, ordered by the index sort key',
    owners: (id) => [
      broadcastOwner(id),
      { kind: 'relay_leg', relayConversationId: `conv-${id}`, sourceTsMsgId: `2026-09-26T11:00:00.000Z#SM${id}`, memberKey: 'contact-9' },
      { kind: 'relay_rung', relayConversationId: `conv-${id}`, retryTsMsgId: `2026-09-26T11:05:00.000Z#SMr${id}`, memberKey: 'phone#+16175550100' },
    ],
    steps: [
      claim(T0),
      claim(T0, undefined, { o: 1 }),
      claim(T0, undefined, { o: 2 }),
      finish('last', { outcome: 'sent', sid: 'SMr' }, true, 2),
      claim(at(1_000), { outcome: 'refused', fresh: true }, { o: 1 }),
    ],
  },
  {
    name: 'every transition on an absent record is refused',
    owners: (id) => [broadcastOwner(id)],
    steps: [
      finish({ attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' }, false),
      hand({ attemptNo: 1, attemptedAt: T0 }, false, 'SM1'),
      {
        label: 'takeOver a record that does not exist',
        run: (repo, ctx) =>
          repo.takeOver(ctx.owners[0]!, { owner: ctx.owners[0]!, state: 'attempting', attemptNo: 1, attemptedAt: T0, redriveCount: 0, checkNo: 0, ...ctx.facts }),
        expect: false,
      },
      check(T0, 0, false),
      redrive(T0, false),
      closeRec(T0, { outcome: 'unresolved' }, false),
      closeRed({ outcome: 'refused' }, false),
    ],
  },
  {
    name: 'from a SEEDED record: a takeover and a hand-off both restart the check count; a seeded re-drive blocks another',
    owners: (id) => [broadcastOwner(id, 'c-1'), broadcastOwner(id, 'c-2')],
    steps: [
      claim(T0),
      seed({ checkNo: 2 }),
      claim(at(SEND_CLAIM_TTL_MS + 1), { outcome: 'takeover', record: { checkNo: 2 } }),
      takeOver(true),
      check(T0, 1, true),
      claim(T0, undefined, { o: 1 }),
      seed({ checkNo: 2, redriveCount: 1 }, 1),
      hand('last', true, undefined, 1),
      check(T0, 1, true, 1),
      redrive(T0, false, 1),
    ],
  },
  {
    name: 'returned records are snapshots: scribbling on them changes nothing stored',
    owners: (id) => [broadcastOwner(id)],
    steps: [claim(T0), scribble(), hand('last', true), scribble(), redrive(T0, true), scribble()],
  },
  {
    name: 're-arm of the own attempt; a stale ref; the index item for the re-armed time; a takeover measured from the re-arm; a re-arm after the takeover refused (FW1-1)',
    owners: (id) => [broadcastOwner(id)],
    steps: [
      claim(T0),
      rearm({ attemptNo: 1, attemptedAt: at(5_000) }, at(9_000), 'refused'),
      rearm({ attemptNo: 2, attemptedAt: T0 }, at(9_000), 'refused'),
      rearm('last', at(20_000), { attemptNo: 1, attemptedAt: at(20_000) }),
      rearm({ attemptNo: 1, attemptedAt: T0 }, at(21_000), 'refused'),
      claim(at(SEND_CLAIM_TTL_MS + 1), { outcome: 'refused', fresh: true, record: { attemptedAt: at(20_000) } }),
      claim(at(20_000 + SEND_CLAIM_TTL_MS), { outcome: 'refused', fresh: true }),
      claim(at(20_000 + SEND_CLAIM_TTL_MS + 1), { outcome: 'takeover', record: { attemptNo: 1, attemptedAt: at(20_000) } }),
      takeOver(true),
      rearm({ attemptNo: 1, attemptedAt: at(20_000) }, at(240_000), 'refused'),
      finish({ attemptNo: 1, attemptedAt: at(20_000) }, { outcome: 'sent', sid: 'SM1' }, false),
      closeRec(at(20_000), { outcome: 'adopted', sid: 'SM9' }, true),
    ],
  },
  {
    name: 're-arm without a sender; a re-arm at the claim\'s own instant rewrites its index item in place; no re-arm once handed off (FW1-1)',
    owners: (id) => [broadcastOwner(id, 'c-5')],
    steps: [
      claim(T0, undefined, { facts: noSender }),
      rearm('last', T0, { attemptNo: 1, attemptedAt: T0 }),
      rearm('last', at(3_000), { attemptNo: 1, attemptedAt: at(3_000) }),
      hand('last', true),
      rearm('last', at(4_000), 'refused'),
      check(at(3_000), 0, true),
    ],
  },
  {
    name: 're-arm of a re-claimed attempt and of a re-drive; an absent or a done record refuses (FW1-1)',
    owners: (id) => [broadcastOwner(id)],
    steps: [
      rearm({ attemptNo: 1, attemptedAt: T0 }, at(1_000), 'refused'),
      claim(T0),
      finish('last', { outcome: 'retryable', cause: '20429' }, true),
      claim(at(10_000), { outcome: 'claimed', record: { attemptNo: 2 } }),
      rearm('last', at(12_000), { attemptNo: 2, attemptedAt: at(12_000) }),
      hand('last', true),
      redrive(at(12_000), true),
      claim(at(40_000), { outcome: 'claimed', record: { attemptNo: 3, redriveCount: 1 } }),
      rearm('last', at(41_000), { attemptNo: 3, attemptedAt: at(41_000) }),
      finish('last', { outcome: 'sent', sid: 'SM3' }, true),
      rearm('last', at(42_000), 'refused'),
    ],
  },
];

// ---- the harness ---------------------------------------------------------

const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const testEnv = { TABLE_PREFIX: `hc-test-sendattemptmirror-${randomUUID().slice(0, 8)}-` };
const table = tableName('messages', testEnv);
const real = createSendAttemptsRepo({ doc, env: testEnv });

/** The real index items of one partition, in the fake's shape, sorted for comparison. */
async function realIndex(partition: string): Promise<FakeWorld['sendAttemptIndex']> {
  const { Items } = await doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'conversationId = :p',
      ExpressionAttributeValues: { ':p': partition },
      ConsistentRead: true,
    }),
  );
  return (Items ?? [])
    .map((item) => ({ partition: String(item['conversationId']), sortKey: String(item['tsMsgId']), owner: item['owner'] as SendAttemptOwner }))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

function fakeIndex(world: FakeWorld, partition: string): FakeWorld['sendAttemptIndex'] {
  return world.sendAttemptIndex
    .filter((entry) => entry.partition === partition)
    .map((entry) => ({ partition: entry.partition, sortKey: entry.sortKey, owner: entry.owner }))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

/** The real record's op token (FW1-5): `last_op`, which no read method returns. */
async function realOp(owner: SendAttemptOwner): Promise<unknown> {
  const recipientKey = owner.kind === 'broadcast' ? owner.contactKey : owner.memberKey;
  const { Item } = await doc.send(
    new GetCommand({
      TableName: table,
      Key: { conversationId: `${SEND_ATTEMPT_PARTITION_PREFIX}${ownerKey(owner)}`, tsMsgId: hashRecipientKey(recipientKey) },
      ConsistentRead: true,
    }),
  );
  return Item?.['last_op'];
}

/** Each implementation's op token per owner, as of the previous step. */
interface OpMemory {
  real: unknown[];
  fake: unknown[];
}

/** Both implementations' observable state must agree after every step. */
async function stateAgrees(
  world: FakeWorld,
  owners: SendAttemptOwner[],
  facts: SendAttemptFacts,
  where: string,
  ops: OpMemory,
): Promise<void> {
  const fake = world.sendAttemptsRepo;
  for (const [i, owner] of owners.entries()) {
    const realRecord = await real.get(owner);
    expect(await fake.get(owner), `${where}: get(o${i})`).toStrictEqual(realRecord);
    // The world map is keyed by attemptKey(owner) and holds exactly what get() returns.
    expect(world.sendAttempts.get(attemptKey(owner)), `${where}: world.sendAttempts[o${i}]`).toStrictEqual(realRecord);
    // FW1-5: the tokens are random, so the fake is held to WHEN a token is written - by the same steps as the real one.
    const realNow = await realOp(owner);
    const fakeNow = world.sendAttemptOps.get(attemptKey(owner));
    expect(fakeNow === undefined, `${where}: op token present (o${i})`).toBe(realNow === undefined);
    expect(fakeNow !== ops.fake[i], `${where}: a fresh op token written this step (o${i})`).toBe(realNow !== ops.real[i]);
    ops.real[i] = realNow;
    ops.fake[i] = fakeNow;
  }
  for (const sender of [SENDER, '-']) {
    for (const since of [EARLY, at(1)]) {
      expect(
        await fake.listByRecipient(sender, facts.recipientDigest, since),
        `${where}: listByRecipient(${sender}, since ${since})`,
      ).toStrictEqual(await real.listByRecipient(sender, facts.recipientDigest, since));
    }
    const partition = `${SEND_ATTEMPT_INDEX_PREFIX}${sender}#${facts.recipientDigest}`;
    expect(fakeIndex(world, partition), `${where}: index items in ${partition}`).toStrictEqual(await realIndex(partition));
  }
}

describe.skipIf(!reachable)('the harness send-attempt fake mirrors the real repo on DynamoDB Local', () => {
  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  for (const [caseNo, c] of CASES.entries()) {
    it(c.name, async () => {
      const id = `${caseNo}-${randomUUID().slice(0, 8)}`;
      const owners = c.owners(id);
      const facts: SendAttemptFacts = {
        recipientDigest: `dg${id}`.replace(/[^0-9a-z]/g, '').padEnd(32, '0').slice(0, 32),
        sender: SENDER,
        bodyHash: 'h'.repeat(64),
        bodyShort: false,
        mediaCount: 0,
      };
      const world = createFakeWorld();
      const realCtx: Ctx = { owners, facts };
      const fakeCtx: Ctx = { owners, facts };
      const ops: OpMemory = { real: [], fake: [] };
      await stateAgrees(world, owners, facts, `${c.name} / before any step`, ops);
      for (const [stepNo, step] of c.steps.entries()) {
        const where = `${c.name} / step ${stepNo} ${step.label}`;
        const realAnswer = await step.run(real, realCtx, { kind: 'real' });
        const fakeAnswer = await step.run(world.sendAttemptsRepo, fakeCtx, { kind: 'fake', world });
        expect(fakeAnswer, `${where}: result`).toStrictEqual(realAnswer);
        if (step.expect !== undefined) {
          if (typeof step.expect === 'object' && step.expect !== null) {
            expect(realAnswer, `${where}: the script's expectation`).toMatchObject(step.expect as Record<string, unknown>);
          } else {
            expect(realAnswer, `${where}: the script's expectation`).toBe(step.expect);
          }
        }
        await stateAgrees(world, owners, facts, where, ops);
      }
    }, 60_000);
  }
});
