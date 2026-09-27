// Do the harness's messages and broadcasts FAKES agree with the real repos on
// the SOR Task 6 additions?
//
// WHY THIS EXISTS. The send sites (broadcast fan-out, relay fan-out, relay
// retry rung) and the send.reconcile job are unit-tested against
// `world.messagesRepo` and `world.broadcastsRepo`, the in-memory twins built in
// app/test/helpers/twilioWebhookHarness.ts. Every decision those sites make -
// close or skip a recipient, adopt a found message, bump a bucket, finalize a
// share - rests on what these methods answer, so a fake that answers
// differently from DynamoDB would let every one of those tests pass against
// behavior production never has. The idiom is
// app/test/twilioWebhookHarnessSendAttempts.integration.test.ts.
//
// THE SHAPE. Each case is a SCRIPT of repo calls. The script runs step by
// step through BOTH the real repos (against DynamoDB Local) and a fresh fake
// world, and after every step requires the same answer: the call's result,
// the watched rows' `delivery_recipients` maps, the watched relay SID
// pointers, and (broadcast cases) the whole broadcast item minus its clocks.
// Where a step also names what the answer should BE, that is asserted on the
// real answer, so a script cannot silently stop exercising its branch.
//
// Row keys, SIDs and broadcast ids are unique per case: the tables are
// created once per file and never reset.
import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createBroadcastsRepo,
  type BroadcastItem,
  type BroadcastRecipient,
  type BroadcastsRepo,
  type BroadcastStats,
} from '../src/repos/broadcastsRepo.js';
import {
  allowedPriorStatuses,
  createMessagesRepo,
  type DeliveryStatus,
  type MessagesRepo,
  type NewMessage,
  type RelayRecipientDelivery,
} from '../src/repos/messagesRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
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
  console.warn(`[twilioWebhookHarnessRepoAdditions] SKIPPED - no DynamoDB Local at ${endpoint}.`);
}

const T0 = '2026-09-26T12:00:00.000Z';
const T1 = '2026-09-26T12:00:05.000Z';

/** Which implementation a step is running against. */
type Impl = { kind: 'real' } | { kind: 'fake'; world: FakeWorld };

// ===========================================================================
// messagesRepo: the relay slot writes, the reporting SID claim, the append
// result and the consistent twins
// ===========================================================================

/** The row shapes a relay slot write can meet. */
type RowShape = 'legacy' | 'versioned' | 'mapless';

interface MsgCtx {
  id: string;
  /** Rows by script name; a name never appended addresses a MISSING row. */
  rows: Map<string, { conversationId: string; tsMsgId: string }>;
  /** Relay SID pointers the state check reads. */
  sids: Set<string>;
}

interface MsgStep {
  label: string;
  run: (repo: MessagesRepo, ctx: MsgCtx, impl: Impl) => Promise<unknown>;
  /** What the REAL answer must be (toBe for a primitive, toMatchObject otherwise). */
  expect?: unknown;
}

interface MsgCase {
  name: string;
  steps: MsgStep[];
}

function rowRef(ctx: MsgCtx, name: string): { conversationId: string; tsMsgId: string } {
  return ctx.rows.get(name) ?? { conversationId: `conv-${ctx.id}-${name}`, tsMsgId: `${T0}#SMnope${ctx.id}` };
}

/** The NewMessage a shape appends - built fresh per call (the fake stores the map by reference). */
function sourceMessage(
  ctx: MsgCtx,
  name: string,
  shape: RowShape,
  slots: Record<string, RelayRecipientDelivery>,
): NewMessage {
  return {
    conversationId: `conv-${ctx.id}-${name}`,
    providerSid: `SM${ctx.id}-${name}`,
    providerTs: T0,
    type: 'sms',
    direction: 'inbound',
    author: 'unknown',
    deliveryStatus: 'delivered',
    relaySenderKey: 'c-alice',
    body: 'is the unit still available?',
    ...(shape === 'versioned' && { transportSchemaVersion: 1 as const }),
    ...(shape !== 'mapless' && { deliveryRecipients: structuredClone(slots) }),
  };
}

const appendRow = (name: string, shape: RowShape, slots: Record<string, RelayRecipientDelivery> = {}): MsgStep => ({
  label: `append ${shape} row ${name}`,
  run: async (repo, ctx) => {
    const message = sourceMessage(ctx, name, shape, slots);
    const result = await repo.append(message);
    ctx.rows.set(name, { conversationId: result.conversationId, tsMsgId: result.tsMsgId });
    return result;
  },
  expect: { deduped: false },
});

const setSlot = (name: string, memberKey: string, delivery: RelayRecipientDelivery): MsgStep => ({
  label: `setRecipientDelivery ${name}/${memberKey} ${JSON.stringify(delivery)}`,
  run: async (repo, ctx) => {
    const row = rowRef(ctx, name);
    await repo.setRecipientDelivery(row.conversationId, row.tsMsgId, memberKey, { ...delivery });
    return 'set';
  },
});

const close = (
  name: string,
  memberKey: string,
  expectation: 'closed' | 'skipped_sent' | 'missing',
  errorCode = 'transient_cap',
): MsgStep => ({
  label: `closeRelayRecipientIfUnsent ${name}/${memberKey} ${errorCode}`,
  run: (repo, ctx) => {
    const row = rowRef(ctx, name);
    return repo.closeRelayRecipientIfUnsent(row.conversationId, row.tsMsgId, memberKey, {
      status: 'failed',
      errorCode,
    });
  },
  expect: expectation,
});

const adopt = (
  name: string,
  memberKey: string,
  patch: { status: DeliveryStatus; sid: string; sentAt: string; errorCode?: string },
  expectation: 'adopted' | 'skipped' | 'missing',
): MsgStep => ({
  label: `adoptRelayRecipientIfUnsent ${name}/${memberKey} ${JSON.stringify(patch)}`,
  run: (repo, ctx) => {
    const row = rowRef(ctx, name);
    return repo.adoptRelayRecipientIfUnsent(row.conversationId, row.tsMsgId, memberKey, { ...patch });
  },
  expect: expectation,
});

const stamp = (name: string, memberKey: string, at: string): MsgStep => ({
  label: `setRelayRecipientAttemptedAt ${name}/${memberKey} ${at}`,
  run: async (repo, ctx) => {
    const row = rowRef(ctx, name);
    const result = await repo.setRelayRecipientAttemptedAt(row.conversationId, row.tsMsgId, memberKey, at);
    return result === undefined ? 'resolved' : result;
  },
  expect: 'resolved',
});

const receipt = (name: string, memberKey: string, status: DeliveryStatus, expectation: boolean): MsgStep => ({
  label: `updateRecipientDeliveryStatus ${name}/${memberKey} ${status}`,
  run: (repo, ctx) => {
    const row = rowRef(ctx, name);
    return repo.updateRecipientDeliveryStatus(row.conversationId, row.tsMsgId, memberKey, status);
  },
  expect: expectation,
});

const claimPtr = (
  sidName: string,
  ref: { row: string; memberKey: string; conversationId?: string; tsMsgId?: string },
  expectation: 'created' | 'mine' | 'other',
): MsgStep => ({
  label: `claimRelaySidPointer ${sidName} ${JSON.stringify(ref)}`,
  run: (repo, ctx) => {
    const sid = `SM${ctx.id}-${sidName}`;
    ctx.sids.add(sid);
    const row = rowRef(ctx, ref.row);
    return repo.claimRelaySidPointer(sid, {
      conversationId: ref.conversationId ?? row.conversationId,
      tsMsgId: ref.tsMsgId ?? row.tsMsgId,
      memberKey: ref.memberKey,
    });
  },
  expect: expectation,
});

const putPtr = (sidName: string, row: string, memberKey: string): MsgStep => ({
  label: `putRelaySidPointer ${sidName}`,
  run: async (repo, ctx) => {
    const sid = `SM${ctx.id}-${sidName}`;
    ctx.sids.add(sid);
    const ref = rowRef(ctx, row);
    await repo.putRelaySidPointer(sid, { conversationId: ref.conversationId, tsMsgId: ref.tsMsgId, memberKey });
    return 'put';
  },
});

const STATUSES: DeliveryStatus[] = ['queued_pending', 'queued', 'sent', 'delivered', 'undelivered', 'failed'];
const ADOPTED_STATUSES: DeliveryStatus[] = ['queued', 'sent', 'delivered', 'undelivered', 'failed'];

/** The legacy forward-only rule, written independently of the code under test. */
function legacyAdopts(prior: DeliveryStatus, next: DeliveryStatus): boolean {
  return prior === next || allowedPriorStatuses(next).includes(prior);
}

const MSG_CASES: MsgCase[] = [
  {
    name: 'claimRelaySidPointer: created, mine, other on each ref field; a pointer the plain put wrote is mine',
    steps: [
      appendRow('src', 'legacy'),
      claimPtr('p1', { row: 'src', memberKey: 'c-1' }, 'created'),
      claimPtr('p1', { row: 'src', memberKey: 'c-1' }, 'mine'),
      claimPtr('p1', { row: 'src', memberKey: 'c-2' }, 'other'),
      claimPtr('p1', { row: 'src', memberKey: 'c-1', tsMsgId: `${T1}#SMelse` }, 'other'),
      claimPtr('p1', { row: 'src', memberKey: 'c-1', conversationId: 'conv-else' }, 'other'),
      putPtr('p2', 'src', 'c-3'),
      claimPtr('p2', { row: 'src', memberKey: 'c-3' }, 'mine'),
      claimPtr('p2', { row: 'src', memberKey: 'c-4' }, 'other'),
    ],
  },
  {
    name: 'closeRelayRecipientIfUnsent on a LEGACY row: absent slot, queued no-sid (keeps attemptedAt), queued with sid, terminal, re-close; a missing row',
    steps: [
      appendRow('src', 'legacy'),
      close('src', 'c-absent', 'closed'),
      stamp('src', 'c-clock', T0),
      close('src', 'c-clock', 'closed'),
      setSlot('src', 'c-sid', { status: 'queued', sid: 'SM7', sentAt: T0 }),
      close('src', 'c-sid', 'skipped_sent'),
      setSlot('src', 'c-sent', { status: 'sent', sid: 'SM8', sentAt: T0 }),
      close('src', 'c-sent', 'skipped_sent'),
      close('src', 'c-absent', 'skipped_sent', 'other'),
      close('nope', 'c-1', 'missing'),
    ],
  },
  {
    name: 'closeRelayRecipientIfUnsent over every status, with and without a sid: only a queued sid-less slot closes',
    steps: [
      appendRow('src', 'legacy'),
      ...STATUSES.flatMap((status) =>
        [false, true].flatMap((withSid) => {
          const mk = `m-${status}-${withSid ? 'sid' : 'nosid'}`;
          return [
            setSlot('src', mk, { status, ...(withSid && { sid: `SM-${mk}` }) }),
            close('src', mk, status === 'queued' && !withSid ? 'closed' : 'skipped_sent'),
          ];
        }),
      ),
    ],
  },
  {
    name: 'closeRelayRecipientIfUnsent on a VERSIONED row: the queued slot keeps requestedTransport; the re-close is skipped_sent',
    steps: [
      appendRow('src', 'versioned', {
        'c-1': { status: 'queued', requestedTransport: 'sms', transportAggregationState: 'planned' },
      }),
      close('src', 'c-1', 'closed'),
      close('src', 'c-1', 'skipped_sent', 'other'),
      close('src', 'c-new', 'closed'),
    ],
  },
  {
    name: 'adoptRelayRecipientIfUnsent on a LEGACY row: seed-then-adopt, first-write-wins, same-status idempotence, regressions refused; a missing row',
    steps: [
      appendRow('src', 'legacy'),
      adopt('src', 'c-9', { status: 'queued', sid: 'SM9', sentAt: T0 }, 'adopted'),
      adopt('src', 'c-9', { status: 'sent', sid: 'SM9', sentAt: T1 }, 'adopted'),
      adopt('src', 'c-9', { status: 'queued', sid: 'SM9', sentAt: T1 }, 'skipped'),
      adopt('src', 'c-9', { status: 'sent', sid: 'SM9', sentAt: T1 }, 'adopted'),
      receipt('src', 'c-9', 'delivered', true),
      adopt('src', 'c-9', { status: 'sent', sid: 'SM9', sentAt: T1 }, 'skipped'),
      stamp('src', 'c-8', T0),
      adopt('src', 'c-8', { status: 'failed', sid: 'SMnew', sentAt: T1, errorCode: '30007' }, 'adopted'),
      setSlot('src', 'c-7', { status: 'queued', sid: 'SMold', sentAt: T0 }),
      adopt('src', 'c-7', { status: 'sent', sid: 'SMnew', sentAt: T1 }, 'adopted'),
      // The seed persists even when the move is then refused (queued_pending
      // accepts no prior but itself).
      adopt('src', 'c-pending', { status: 'queued_pending', sid: 'SMp', sentAt: T0 }, 'skipped'),
      adopt('nope', 'c-9', { status: 'sent', sid: 'SM9', sentAt: T1 }, 'missing'),
    ],
  },
  {
    name: 'adoptRelayRecipientIfUnsent on a LEGACY row is forward-only per allowedPriorStatuses, over every prior and every adopted status',
    steps: [
      appendRow('src', 'legacy'),
      ...STATUSES.flatMap((prior) =>
        ADOPTED_STATUSES.flatMap((next) => {
          const mk = `m-${prior}-${next}`;
          return [
            setSlot('src', mk, { status: prior }),
            adopt('src', mk, { status: next, sid: `SM-${mk}`, sentAt: T1 }, legacyAdopts(prior, next) ? 'adopted' : 'skipped'),
          ];
        }),
      ),
    ],
  },
  {
    name: 'adoptRelayRecipientIfUnsent on a VERSIONED row: adopt then skip; a slot holding a sid moves only forward; no slot is missing',
    steps: [
      appendRow('src', 'versioned', {
        'c-1': { status: 'queued', requestedTransport: 'sms', transportAggregationState: 'planned' },
        ...Object.fromEntries(
          STATUSES.map((status): [string, RelayRecipientDelivery] => [
            `m-${status}`,
            { status, requestedTransport: 'sms', transportAggregationState: 'attempted', sid: 'SMv', sentAt: T0 },
          ]),
        ),
      }),
      adopt('src', 'c-1', { status: 'sent', sid: 'SM1', sentAt: T0 }, 'adopted'),
      adopt('src', 'c-1', { status: 'sent', sid: 'SM1', sentAt: T0 }, 'skipped'),
      adopt('src', 'c-1', { status: 'queued', sid: 'SM1', sentAt: T0 }, 'skipped'),
      ...STATUSES.map((prior) =>
        adopt('src', `m-${prior}`, { status: 'delivered', sid: 'SMv', sentAt: T0 }, allowedPriorStatuses('delivered').includes(prior) ? 'adopted' : 'skipped'),
      ),
      adopt('src', 'c-absent', { status: 'sent', sid: 'SM2', sentAt: T0 }, 'missing'),
      adopt('nope', 'c-1', { status: 'sent', sid: 'SM1', sentAt: T0 }, 'missing'),
    ],
  },
  {
    name: 'setRelayRecipientAttemptedAt: seeds an absent slot; never touches an existing slot\'s other fields; a missing row resolves',
    steps: [
      appendRow('src', 'legacy'),
      appendRow('ver', 'versioned', {
        'c-1': { status: 'queued', requestedTransport: 'sms', transportAggregationState: 'planned' },
      }),
      stamp('src', 'c-3', T0),
      setSlot('src', 'c-2', { status: 'queued', sid: 'SM7', sentAt: T0 }),
      stamp('src', 'c-2', T1),
      stamp('src', 'c-3', T1),
      setSlot('src', 'c-4', { status: 'delivered', sid: 'SM4', sentAt: T0, deliveredAt: T1 }),
      stamp('src', 'c-4', T1),
      stamp('ver', 'c-1', T0),
      stamp('nope', 'c-1', T0),
    ],
  },
  {
    name: 'a row with NO delivery map: close and adopt answer missing, the attempt clock resolves, nothing is written',
    steps: [
      appendRow('bare', 'mapless'),
      close('bare', 'c-1', 'missing'),
      adopt('bare', 'c-1', { status: 'sent', sid: 'SM1', sentAt: T0 }, 'missing'),
      stamp('bare', 'c-1', T0),
    ],
  },
  {
    name: 'append reports the STORED row\'s conversation on a dedupe; the consistent twins answer as the eventual reads',
    steps: [
      appendRow('src', 'legacy'),
      {
        label: 'append the same provider SID under another conversation',
        run: async (repo, ctx) => {
          const message = sourceMessage(ctx, 'src', 'legacy', {});
          const result = await repo.append({ ...message, conversationId: `conv-${ctx.id}-other`, providerTs: T1 });
          const first = rowRef(ctx, 'src');
          return {
            ...result,
            firstKey: result.tsMsgId === first.tsMsgId,
            firstConversation: result.conversationId === first.conversationId,
          };
        },
        expect: { deduped: true, firstKey: true, firstConversation: true },
      },
      {
        label: 'getByProviderSidConsistent / getByProviderSid resolve the same row',
        run: async (repo, ctx) => {
          const sid = `SM${ctx.id}-src`;
          const consistent = await repo.getByProviderSidConsistent(sid);
          const eventual = await repo.getByProviderSid(sid);
          const absent = await repo.getByProviderSidConsistent(`SM${ctx.id}-absent`);
          return {
            consistent: consistent && [consistent.conversationId, consistent.tsMsgId],
            eventual: eventual && [eventual.conversationId, eventual.tsMsgId],
            absent: absent ?? null,
          };
        },
      },
      {
        label: 'listByConversationConsistent / listByConversation list the same keys',
        run: async (repo, ctx) => {
          const row = rowRef(ctx, 'src');
          const keys = (rows: { tsMsgId: string }[]): string[] => rows.map((r) => r.tsMsgId);
          return {
            consistent: keys(await repo.listByConversationConsistent(row.conversationId, { limit: 5 })),
            eventual: keys(await repo.listByConversation(row.conversationId, { limit: 5 })),
            before: keys(await repo.listByConversationConsistent(row.conversationId, { before: row.tsMsgId })),
          };
        },
      },
      {
        label: 'getSystemSidMarkerConsistent / getSystemSidMarker read the same marker',
        run: async (repo, ctx) => {
          const sid = `SM${ctx.id}-sys`;
          const before = await repo.getSystemSidMarkerConsistent(sid);
          await repo.putSystemSidMarker(sid, 'cell_verification');
          return {
            before: before ?? null,
            consistent: await repo.getSystemSidMarkerConsistent(sid),
            eventual: await repo.getSystemSidMarker(sid),
          };
        },
      },
      claimPtr('p1', { row: 'src', memberKey: 'c-1' }, 'created'),
      {
        label: 'getRelaySidPointerConsistent / getRelaySidPointer read the same pointer',
        run: async (repo, ctx) => {
          const sid = `SM${ctx.id}-p1`;
          return {
            consistent: await repo.getRelaySidPointerConsistent(sid),
            eventual: await repo.getRelaySidPointer(sid),
            absent: (await repo.getRelaySidPointerConsistent(`SM${ctx.id}-absent`)) ?? null,
          };
        },
      },
    ],
  },
];

// ===========================================================================
// broadcastsRepo: the one-write recipient outcome, the queued close, the
// finalize flip and the consistent read
// ===========================================================================

interface BcCtx {
  id: string;
}

interface BcStep {
  label: string;
  run: (repo: BroadcastsRepo, ctx: BcCtx, impl: Impl) => Promise<unknown>;
  /** What the REAL answer must be (toBe for a primitive, toMatchObject otherwise). */
  expect?: unknown;
}

interface BcCase {
  name: string;
  /** The broadcasts the state check reads after every step. */
  watch: string[];
  steps: BcStep[];
}

const FILTER = { contact_type: 'tenant' as const, excludeOptedOut: true, excludeUnreachable: true };

function bid(ctx: BcCtx, name: string): string {
  return `b-${ctx.id}-${name}`;
}

/** An item without its wall clocks, deep-copied so a later write cannot reach it. */
function normalize(item: BroadcastItem | undefined): Record<string, unknown> | undefined {
  if (item === undefined) return undefined;
  const { created_at: _created, updated_at: _updated, ...rest } = item;
  return structuredClone(rest);
}

function normalizeOutcome(result: { moved: boolean; item?: BroadcastItem }): Record<string, unknown> {
  return { moved: result.moved, ...(result.item !== undefined && { item: normalize(result.item) }) };
}

/** A rejection, reduced to what both implementations must agree on. */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { resolved: await run() };
  } catch (err) {
    return { rejected: err instanceof TypeError ? 'TypeError' : 'Error', message: (err as Error).message };
  }
}

const createB = (name: string): BcStep => ({
  label: `create ${name}`,
  run: async (repo, ctx) =>
    normalize(await repo.create({ broadcastId: bid(ctx, name), created_by: 'usr_test', audience_filter: FILTER, body_template: 'Hi [TenantName]' })),
});

const sendingB = (name: string, keys: string[]): BcStep => ({
  label: `markSending ${name} ${keys.join(',')}`,
  run: async (repo, ctx) =>
    normalize(
      await repo.markSending(
        bid(ctx, name),
        Object.fromEntries(keys.map((k): [string, BroadcastRecipient] => [k, { status: 'queued' }])),
      ),
    ),
});

const record = (
  name: string,
  contactKey: string,
  recipient: BroadcastRecipient,
  delta: Partial<BroadcastStats>,
  priors: BroadcastRecipient['status'][],
  moved: boolean,
): BcStep => ({
  label: `recordRecipientOutcome ${name}/${contactKey} ${JSON.stringify(recipient)} ${JSON.stringify(delta)} from ${priors.join('|')}`,
  run: async (repo, ctx) =>
    normalizeOutcome(await repo.recordRecipientOutcome(bid(ctx, name), contactKey, { ...recipient }, { ...delta }, [...priors])),
  expect: { moved },
});

const closeQueued = (name: string, contactKey: string, errorCode: string, bucket: 'failed' | 'unconfirmed', moved: boolean): BcStep => ({
  label: `closeRecipientIfQueued ${name}/${contactKey} ${errorCode} -> ${bucket}`,
  run: async (repo, ctx) => normalizeOutcome(await repo.closeRecipientIfQueued(bid(ctx, name), contactKey, errorCode, bucket)),
  expect: { moved },
});

const finalize = (name: string, status: 'sent' | 'failed', won: boolean, lastError?: string): BcStep => ({
  label: `finalizeStatus ${name} ${status}${lastError !== undefined ? ` (${lastError})` : ''}`,
  run: async (repo, ctx) => {
    const result = await repo.finalizeStatus(bid(ctx, name), status, lastError);
    return { won: result.won, item: normalize(result.item) };
  },
  expect: { won },
});

/** Plant a stats map that predates a bucket - the raw edit on the real item, the same edit on the fake's. */
const dropBucket = (name: string, bucket: keyof BroadcastStats): BcStep => ({
  label: `REMOVE stats.${bucket} on ${name}`,
  run: async (_repo, ctx, impl) => {
    if (impl.kind === 'fake') {
      const item = impl.world.broadcasts.get(bid(ctx, name));
      if (item === undefined) throw new Error('script error: no broadcast to edit');
      delete (item.stats as unknown as Record<string, unknown>)[bucket];
      return 'dropped';
    }
    await doc.send(
      new UpdateCommand({
        TableName: tableName('broadcasts', testEnv),
        Key: { broadcastId: bid(ctx, name) },
        UpdateExpression: 'REMOVE stats.#b',
        ExpressionAttributeNames: { '#b': bucket },
      }),
    );
    return 'dropped';
  },
});

/** Scribble on a returned item: nothing stored may change. */
const scribble = (name: string, contactKey: string): BcStep => ({
  label: `scribble on the item returned for ${name}/${contactKey}`,
  run: async (repo, ctx) => {
    const r = await repo.recordRecipientOutcome(bid(ctx, name), contactKey, { status: 'queued' }, {}, ['queued']);
    const f = await repo.finalizeStatus(bid(ctx, name), 'sent').catch(() => undefined);
    for (const item of [r.item, f?.item]) {
      if (item === undefined) continue;
      item.stats.sent = 999;
      item.recipients[contactKey] = { status: 'skipped' };
      item.status = 'draft';
    }
    return { moved: r.moved, won: f?.won ?? null };
  },
});

const BC_STATUSES: BroadcastRecipient['status'][] = ['queued', 'sent', 'delivered', 'failed', 'skipped'];
const PRIOR_SETS: BroadcastRecipient['status'][][] = [['queued'], ['sent'], ['queued', 'sent'], ['delivered', 'failed', 'skipped']];

const BC_CASES: BcCase[] = [
  {
    name: 'recordRecipientOutcome: single- and multi-bucket deltas, an EMPTY delta writes the slot only, a zero delta is skipped; priors, a missing slot and a missing broadcast refuse; an empty prior list throws',
    watch: ['b1'],
    steps: [
      createB('b1'),
      sendingB('b1', ['c-1', 'c-2', 'c-3', 'c-4']),
      record('b1', 'c-1', { status: 'skipped', errorCode: 'opted_out' }, { skipped_opted_out: 1 }, ['queued'], true),
      record('b1', 'c-2', { status: 'sent', conversationId: 'conv-2', tsMsgId: 'ts-2' }, { sent: 1, queued: -1 }, ['queued'], true),
      record('b1', 'c-2', { status: 'failed', errorCode: 'x' }, { failed: 1, queued: -1 }, ['queued'], false),
      record('b1', 'c-3', { status: 'queued', errorCode: 'send_retryable' }, {}, ['queued'], true),
      record('b1', 'c-3', { status: 'queued', errorCode: 'send_retryable' }, {}, ['sent'], false),
      record('b1', 'c-4', { status: 'sent' }, { sent: 1, failed: 0, queued: -1 }, ['queued'], true),
      record('b1', 'c-absent', { status: 'sent' }, { sent: 1, queued: -1 }, ['queued'], false),
      record('b-missing', 'c-1', { status: 'sent' }, { sent: 1 }, ['queued'], false),
      {
        label: 'recordRecipientOutcome with an empty prior list',
        run: (repo, ctx) => rejection(() => repo.recordRecipientOutcome(bid(ctx, 'b1'), 'c-3', { status: 'sent' }, { sent: 1 }, [])),
        expect: { rejected: 'TypeError' },
      },
    ],
  },
  {
    name: 'recordRecipientOutcome moves a slot only from an allowed prior, over every status and several prior sets',
    watch: ['mx'],
    steps: [
      createB('mx'),
      sendingB(
        'mx',
        BC_STATUSES.flatMap((status) => PRIOR_SETS.map((_, j) => `c-${status}-${j}`)),
      ),
      ...BC_STATUSES.flatMap((status) =>
        PRIOR_SETS.flatMap((priors, j) => [
          ...(status === 'queued'
            ? []
            : [record('mx', `c-${status}-${j}`, { status }, {}, ['queued'], true)]),
          record('mx', `c-${status}-${j}`, { status: 'failed', errorCode: 'probe' }, { failed: 1 }, priors, priors.includes(status)),
        ]),
      ),
    ],
  },
  {
    name: 'closeRecipientIfQueued: the unconfirmed and failed buckets; a legacy stats map without the bucket; a second close refused',
    watch: ['b1', 'b2'],
    steps: [
      createB('b1'),
      sendingB('b1', ['c-1', 'c-2', 'c-3']),
      dropBucket('b1', 'unconfirmed'),
      closeQueued('b1', 'c-1', 'send_unconfirmed', 'unconfirmed', true),
      closeQueued('b1', 'c-1', 'send_unconfirmed', 'unconfirmed', false),
      closeQueued('b1', 'c-2', 'transient_cap', 'failed', true),
      record('b1', 'c-3', { status: 'sent' }, { sent: 1, queued: -1 }, ['queued'], true),
      closeQueued('b1', 'c-3', 'enqueue_failed', 'failed', false),
      createB('b2'),
      sendingB('b2', ['c-1']),
      closeQueued('b2', 'c-1', 'send_unconfirmed', 'unconfirmed', true),
      closeQueued('b2', 'c-absent', 'send_unconfirmed', 'unconfirmed', false),
    ],
  },
  {
    name: 'finalizeStatus: wins once from sending; a second call gets won:false and the item; a draft never flips; a missing broadcast throws',
    watch: ['b1', 'b2', 'draft'],
    steps: [
      createB('b1'),
      sendingB('b1', ['c-1']),
      finalize('b1', 'sent', true),
      finalize('b1', 'failed', false, 'late'),
      createB('b2'),
      sendingB('b2', ['c-1']),
      finalize('b2', 'failed', true, "Couldn't confirm any text went out"),
      finalize('b2', 'failed', false, 'all recipients failed'),
      createB('draft'),
      finalize('draft', 'sent', false),
      {
        label: 'finalizeStatus on a missing broadcast',
        run: (repo, ctx) => rejection(() => repo.finalizeStatus(bid(ctx, 'nope'), 'sent')),
        expect: { rejected: 'Error' },
      },
    ],
  },
  {
    name: 'returned items are snapshots: scribbling on them changes nothing stored',
    watch: ['b1'],
    steps: [createB('b1'), sendingB('b1', ['c-1']), scribble('b1', 'c-1')],
  },
];

// ---- the harness -----------------------------------------------------------

const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const testEnv = { TABLE_PREFIX: `hc-test-repoaddmirror-${randomUUID().slice(0, 8)}-` };
const logger = createLogger({ level: 'info', destination: createLogCapture().stream });
const realMessages = createMessagesRepo({ doc, env: testEnv, logger });
const realBroadcasts = createBroadcastsRepo({ doc, env: testEnv, logger });

/** Both implementations' watched broadcasts must agree after every step. */
async function broadcastsAgree(world: FakeWorld, ctx: BcCtx, watch: string[], where: string): Promise<void> {
  for (const name of watch) {
    const id = bid(ctx, name);
    expect(normalize(await world.broadcastsRepo.getByIdConsistent(id)), `${where}: broadcast ${name}`).toStrictEqual(
      normalize(await realBroadcasts.getByIdConsistent(id)),
    );
  }
}

/**
 * A slot map with its wall-clock stamp reduced to presence: a delivered
 * receipt stamps `deliveredAt` from each implementation's own clock.
 */
function withoutClocks(
  map: Record<string, RelayRecipientDelivery> | undefined,
): Record<string, RelayRecipientDelivery> | undefined {
  if (map === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(map).map(([key, slot]) => [
      key,
      slot.deliveredAt === undefined ? slot : { ...slot, deliveredAt: '<clock>' },
    ]),
  );
}

/** Both implementations' watched message state must agree after every step. */
async function messagesAgree(world: FakeWorld, realCtx: MsgCtx, fakeCtx: MsgCtx, where: string): Promise<void> {
  const fake = world.messagesRepo;
  const names = new Set([...realCtx.rows.keys(), ...fakeCtx.rows.keys(), 'nope']);
  for (const name of names) {
    const realRef = rowRef(realCtx, name);
    const fakeRef = rowRef(fakeCtx, name);
    expect(fakeRef, `${where}: row key ${name}`).toStrictEqual(realRef);
    const realRow = await realMessages.getByTsMsgIdConsistent(realRef.conversationId, realRef.tsMsgId);
    const fakeRow = await fake.getByTsMsgIdConsistent(fakeRef.conversationId, fakeRef.tsMsgId);
    expect(fakeRow === undefined, `${where}: row ${name} exists`).toBe(realRow === undefined);
    expect(withoutClocks(fakeRow?.delivery_recipients), `${where}: row ${name} delivery_recipients`).toStrictEqual(
      withoutClocks(realRow?.delivery_recipients),
    );
  }
  for (const sid of new Set([...realCtx.sids, ...fakeCtx.sids])) {
    expect(await fake.getRelaySidPointerConsistent(sid), `${where}: pointer ${sid}`).toStrictEqual(
      await realMessages.getRelaySidPointerConsistent(sid),
    );
  }
}

function expectScripted(realAnswer: unknown, expectation: unknown, where: string): void {
  if (expectation === undefined) return;
  if (typeof expectation === 'object' && expectation !== null) {
    expect(realAnswer, `${where}: the script's expectation`).toMatchObject(expectation as Record<string, unknown>);
  } else {
    expect(realAnswer, `${where}: the script's expectation`).toBe(expectation);
  }
}

// Fake-only (no DynamoDB): the consistent twins delegate THROUGH THE OBJECT
// PROPERTY (build finding T8-3), so a test that spies the eventual read -
// relayFanOut.test.ts's source-read order pin - keeps observing a caller that
// moved to the consistent one. The parity cases above cannot see this.
describe('the harness consistent twins delegate through the object property', () => {
  it('a spy on each eventual read observes its consistent twin, with the same arguments', async () => {
    const world = createFakeWorld();
    const list = vi.spyOn(world.messagesRepo, 'listByConversation');
    await world.messagesRepo.listByConversationConsistent('conv-x', { limit: 5 });
    expect(list).toHaveBeenCalledWith('conv-x', { limit: 5 });
    const bySid = vi.spyOn(world.messagesRepo, 'getByProviderSid');
    await world.messagesRepo.getByProviderSidConsistent('SMx');
    expect(bySid).toHaveBeenCalledWith('SMx');
    const ptr = vi.spyOn(world.messagesRepo, 'getRelaySidPointer');
    await world.messagesRepo.getRelaySidPointerConsistent('SMy');
    expect(ptr).toHaveBeenCalledWith('SMy');
    const marker = vi.spyOn(world.messagesRepo, 'getSystemSidMarker');
    await world.messagesRepo.getSystemSidMarkerConsistent('SMz');
    expect(marker).toHaveBeenCalledWith('SMz');
    const byId = vi.spyOn(world.broadcastsRepo, 'getById');
    await world.broadcastsRepo.getByIdConsistent('b-x');
    expect(byId).toHaveBeenCalledWith('b-x');
  });
});

describe.skipIf(!reachable)('the harness messages and broadcasts fakes mirror the real repos on the SOR additions (DynamoDB Local)', () => {
  beforeAll(async () => {
    for (const base of ['messages', 'broadcasts'] as const) {
      await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
    }
  }, 120_000);

  afterAll(async () => {
    for (const base of ['messages', 'broadcasts'] as const) {
      await deleteTableIfExists(client, tableName(base, testEnv));
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  describe('messagesRepo', () => {
    for (const [caseNo, c] of MSG_CASES.entries()) {
      it(c.name, async () => {
        const id = `${caseNo}-${randomUUID().slice(0, 8)}`;
        const world = createFakeWorld();
        const realCtx: MsgCtx = { id, rows: new Map(), sids: new Set() };
        const fakeCtx: MsgCtx = { id, rows: new Map(), sids: new Set() };
        for (const [stepNo, step] of c.steps.entries()) {
          const where = `${c.name} / step ${stepNo} ${step.label}`;
          const realAnswer = await step.run(realMessages, realCtx, { kind: 'real' });
          const fakeAnswer = await step.run(world.messagesRepo, fakeCtx, { kind: 'fake', world });
          expect(fakeAnswer, `${where}: result`).toStrictEqual(realAnswer);
          expectScripted(realAnswer, step.expect, where);
          await messagesAgree(world, realCtx, fakeCtx, where);
        }
      }, 60_000);
    }
  });

  describe('broadcastsRepo', () => {
    for (const [caseNo, c] of BC_CASES.entries()) {
      it(c.name, async () => {
        const ctx: BcCtx = { id: `${caseNo}-${randomUUID().slice(0, 8)}` };
        const world = createFakeWorld();
        for (const [stepNo, step] of c.steps.entries()) {
          const where = `${c.name} / step ${stepNo} ${step.label}`;
          const realAnswer = await step.run(realBroadcasts, ctx, { kind: 'real' });
          const fakeAnswer = await step.run(world.broadcastsRepo, ctx, { kind: 'fake', world });
          expect(fakeAnswer, `${where}: result`).toStrictEqual(realAnswer);
          expectScripted(realAnswer, step.expect, where);
          await broadcastsAgree(world, ctx, c.watch, where);
        }
      }, 60_000);
    }
  });
});
