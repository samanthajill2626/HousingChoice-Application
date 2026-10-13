// Unit tests for the one-time last_heard_from_at backfill (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1, 5.2 and 14.2), in two halves. No database.
//
// 1. The PLANNER. planThreadPage folds one newest-first page of a thread's
//    rows into the plan with lib/heardFrom.ts attributeInbound - the ONE rule
//    every live path uses. What is pinned here is what the backfill adds on
//    top of that rule: a 1:1 thread stops at its first ATTRIBUTED inbound, a
//    group thread is read to exhaustion, retry/outbound rows never count, and
//    the per-contact maximum is taken on NORMALIZED instants across threads.
// 2. The RUNNER, through a fake `doc` that models the inbound/non-retry
//    FilterExpression and paging, and a fake contacts repo that models the
//    forward-only conditional touch.
import { describe, expect, it } from 'vitest';
import { QueryCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  backfillLastHeardFrom,
  isPointerConversation,
  newPlan,
  planThreadPage,
  reportBackfillRun,
  type BackfillResult,
} from '../scripts/backfill-last-heard-from.js';
import type { HeardFromLookup, HeardFromThread } from '../src/lib/heardFrom.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

// ---------------------------------------------------------------------------
// Half 1 - the planner
// ---------------------------------------------------------------------------

const PHONES = new Map([
  ['+15550100007', 'c-z'],
  ['+15550100005', 'c-p'],
]);
const EMAILS = new Map([['e@x.test', 'c-e']]);

/** A SYNCHRONOUS fixture lookup (the rule accepts either kind). */
const lookup: HeardFromLookup = {
  byPhone: (e164) => {
    const contactId = PHONES.get(e164);
    return contactId === undefined ? undefined : { contactId };
  },
  byEmail: (address) => {
    const contactId = EMAILS.get(address);
    return contactId === undefined ? undefined : { contactId };
  },
};

const row = (tsMsgId: string, over: Partial<MessageItem> = {}) =>
  ({ conversationId: 'x', tsMsgId, direction: 'inbound', type: 'sms', ...over }) as MessageItem;

type PlannerThread = HeardFromThread & { conversationId: string };

const ONE_TO_ONE: PlannerThread = {
  conversationId: 'one',
  type: 'tenant_1to1',
  participants: [{ contactId: 'c-a', phone: '+15550100001' }],
};

describe('planThreadPage - the planner', () => {
  it('a 1:1 thread stops at its first ATTRIBUTED inbound', async () => {
    const plan = newPlan();
    const done = await planThreadPage(
      plan,
      ONE_TO_ONE,
      [row('2026-09-02T10:00:00.000Z#SM2'), row('2026-09-01T10:00:00.000Z#SM1')],
      lookup,
    );
    expect(done).toBe(true);
    expect(plan.latest.get('c-a')).toBe('2026-09-02T10:00:00.000Z');
    expect(plan.latest.size).toBe(1);
  });

  it('ignores retry and outbound rows - neither attributed nor counted as unattributed', async () => {
    const plan = newPlan();
    const relay: PlannerThread = {
      conversationId: 'grp',
      type: 'relay_group',
      participants: [{ contactId: 'c-a', phone: '+15550100001' }],
    };
    const done = await planThreadPage(
      plan,
      relay,
      [
        row('2026-09-05T10:00:00.000Z#R', {
          relay_sender_key: 'c-a',
          relay_retry_of: '2026-09-01T10:00:00.000Z#SM1',
        }),
        row('2026-09-04T10:00:00.000Z#O', { direction: 'outbound', relay_sender_key: 'team' }),
      ],
      lookup,
    );
    expect(done).toBe(false);
    expect(plan.latest.size).toBe(0);
    expect(plan.unattributed).toBe(0);
    expect(plan.unattributedSample).toEqual([]);
  });

  it('steps OVER an email from an unverified address instead of stopping on it', async () => {
    const plan = newPlan();
    const done = await planThreadPage(
      plan,
      ONE_TO_ONE,
      [
        row('2026-09-03T10:00:00.000Z#E1', { type: 'email', email_new_address: true }),
        row('2026-09-02T10:00:00.000Z#E2', { type: 'email' }),
      ],
      lookup,
    );
    expect(done).toBe(true);
    expect(plan.unattributed).toBe(1);
    expect(plan.unattributedSample).toEqual(['one']);
    expect(plan.latest.get('c-a')).toBe('2026-09-02T10:00:00.000Z');
  });

  it('an empty participant contactId falls through to the participant email', async () => {
    const plan = newPlan();
    await planThreadPage(
      plan,
      {
        conversationId: 'em',
        type: 'partner_1to1',
        participants: [{ contactId: '', phone: '' }],
        participant_email: 'e@x.test',
      },
      [row('2026-09-02T10:00:00.000Z#E')],
      lookup,
    );
    expect([...plan.latest.keys()]).toEqual(['c-e']);
  });

  it('with no participants, a phone MISS falls through to the email; a phone hit wins', async () => {
    const miss = newPlan();
    await planThreadPage(
      miss,
      {
        conversationId: 'np1',
        type: 'unknown_1to1',
        participant_phone: '+15550100999',
        participant_email: 'e@x.test',
      },
      [row('2026-09-02T10:00:00.000Z#M')],
      lookup,
    );
    expect([...miss.latest.keys()]).toEqual(['c-e']);

    const hit = newPlan();
    await planThreadPage(
      hit,
      {
        conversationId: 'np2',
        type: 'unknown_1to1',
        participant_phone: '+15550100005',
        participant_email: 'e@x.test',
      },
      [row('2026-09-02T10:00:00.000Z#H')],
      lookup,
    );
    expect([...hit.latest.keys()]).toEqual(['c-p']);
  });

  it('a GROUP thread is read to exhaustion through every branch of the rule', async () => {
    const plan = newPlan();
    const relay: PlannerThread = {
      conversationId: 'grp',
      type: 'relay_group',
      participants: [
        { contactId: 'c-a', phone: '+15550100001' },
        { contactId: '', phone: '+15550100005' },
      ],
    };
    const done = await planThreadPage(
      plan,
      relay,
      [
        // A member by contactId key (the newest row).
        row('2026-09-07T10:00:00.000Z#K1', { relay_sender_key: 'c-a' }),
        // A phone key whose roster entry has an EMPTY contactId -> lookup.
        row('2026-09-06T10:00:00.000Z#K2', { relay_sender_key: 'phone#+15550100005' }),
        // A phone key of a NON-member -> lookup.
        row('2026-09-05T10:00:00.000Z#K3', { relay_sender_key: 'phone#+15550100007' }),
        // Keyless, a refused caller with a resolved contactId.
        row('2026-09-04T10:00:00.000Z#C1', { type: 'call', relay_external_caller_contact_id: 'c-ext' }),
        // Keyless, a refused caller with only a phone -> lookup.
        row('2026-09-03T10:00:00.000Z#C2', { type: 'call', relay_external_caller_phone: '+15550100007' }),
        // Keyless with nothing (an imported group call) -> unattributed.
        row('2026-09-02T10:00:00.000Z#C3', { type: 'call' }),
        // The staff sentinel on an inbound row -> unattributed.
        row('2026-09-01T10:00:00.000Z#T', { relay_sender_key: 'team' }),
      ],
      lookup,
    );
    expect(done).toBe(false);
    // Five attributed rows name FOUR distinct contacts (c-z twice).
    expect(plan.latest.size).toBe(4);
    expect(plan.latest.get('c-a')).toBe('2026-09-07T10:00:00.000Z');
    expect(plan.latest.get('c-p')).toBe('2026-09-06T10:00:00.000Z');
    expect(plan.latest.get('c-z')).toBe('2026-09-05T10:00:00.000Z');
    expect(plan.latest.get('c-ext')).toBe('2026-09-04T10:00:00.000Z');
    expect(plan.unattributed).toBe(2);
    expect(plan.unattributedSample).toEqual(['grp']);
  });

  it('a group_text phone key whose roster entry HAS a contactId resolves to that id', async () => {
    const plan = newPlan();
    const done = await planThreadPage(
      plan,
      {
        conversationId: 'gt',
        type: 'group_text',
        // Not in PHONES: only the roster can name it.
        participants: [{ contactId: 'c-g', phone: '+15550100008' }],
      },
      [row('2026-09-02T10:00:00.000Z#G', { relay_sender_key: 'phone#+15550100008' })],
      lookup,
    );
    expect(done).toBe(false);
    expect([...plan.latest]).toEqual([['c-g', '2026-09-02T10:00:00.000Z']]);
  });

  it('keeps the MAX instant per contact across threads, whichever thread is planned first', async () => {
    const group: PlannerThread = {
      conversationId: 'grp',
      type: 'relay_group',
      participants: [{ contactId: 'c-a', phone: '+15550100001' }],
    };
    const oneRows = [row('2026-09-01T10:00:00.000Z#SM1')];
    const groupRows = [row('2026-09-03T10:00:00.000Z#G1', { relay_sender_key: 'c-a' })];

    const oneFirst = newPlan();
    await planThreadPage(oneFirst, ONE_TO_ONE, oneRows, lookup);
    await planThreadPage(oneFirst, group, groupRows, lookup);
    expect(oneFirst.latest.get('c-a')).toBe('2026-09-03T10:00:00.000Z');

    const groupFirst = newPlan();
    await planThreadPage(groupFirst, group, groupRows, lookup);
    await planThreadPage(groupFirst, ONE_TO_ONE, oneRows, lookup);
    expect(groupFirst.latest.get('c-a')).toBe('2026-09-03T10:00:00.000Z');
  });

  it('compares NORMALIZED instants (raw strings would pick the earlier one)', async () => {
    const plan = newPlan();
    await planThreadPage(plan, { ...ONE_TO_ONE, conversationId: 'a' }, [row('2026-09-01T10:00:00Z#a')], lookup);
    await planThreadPage(plan, { ...ONE_TO_ONE, conversationId: 'b' }, [row('2026-09-01T10:00:00.500Z#b')], lookup);
    expect(plan.latest.get('c-a')).toBe('2026-09-01T10:00:00.500Z');
  });

  it('counts an unparseable key prefix and plans nothing for it', async () => {
    const plan = newPlan();
    await planThreadPage(plan, ONE_TO_ONE, [row('garbage#SM')], lookup);
    expect(plan.unparseableInstants).toBe(1);
    expect(plan.latest.size).toBe(0);
  });

  it('recognizes every conversations claim-row prefix as a pointer, and nothing else', () => {
    expect(isPointerConversation('phone#+15550100001')).toBe(true);
    expect(isPointerConversation('email#a@x.test')).toBe(true);
    expect(isPointerConversation('token#abc')).toBe(true);
    expect(isPointerConversation('conv-0001')).toBe(false);
    expect(isPointerConversation(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Half 2 - the runner
// ---------------------------------------------------------------------------

function fakeDoc(conversations: Record<string, unknown>[], messages: Record<string, unknown>[], pageSize = 1000) {
  const queries: Record<string, any>[] = [];
  const doc = {
    async send(command: unknown) {
      if (command instanceof ScanCommand) return { Items: conversations };
      if (command instanceof QueryCommand) {
        const input = command.input as Record<string, any>;
        queries.push(input);
        // Models the FilterExpression (inbound, no relay_retry_of) and the
        // newest-first order (ScanIndexForward: false).
        const rows = messages
          .filter((m) => m['conversationId'] === input.ExpressionAttributeValues[':c'])
          .filter((m) => m['direction'] === 'inbound' && m['relay_retry_of'] === undefined)
          .sort((a, b) => (String(a['tsMsgId']) < String(b['tsMsgId']) ? 1 : -1));
        const start = input.ExclusiveStartKey === undefined ? 0 : Number(input.ExclusiveStartKey.idx);
        const next = start + pageSize < rows.length ? { idx: start + pageSize } : undefined;
        return { Items: rows.slice(start, start + pageSize), ...(next && { LastEvaluatedKey: next }) };
      }
      throw new Error('unexpected command');
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, queries };
}

/** Forward-only, like the real conditional writer. */
function fakeContacts(failFor?: string) {
  const stored = new Map<string, string>();
  const touches: { contactId: string; at: string }[] = [];
  const contacts = {
    async findByPhone(phone: string): Promise<ContactItem | undefined> {
      return phone === '+15550100004' ? ({ contactId: 'c-d' } as ContactItem) : undefined;
    },
    async findByEmail(): Promise<ContactItem | undefined> {
      return undefined;
    },
    async touchLastHeardFrom(contactId: string, at: string): Promise<'written' | 'skipped' | 'failed'> {
      touches.push({ contactId, at });
      if (contactId === failFor) return 'failed';
      const prior = stored.get(contactId);
      if (prior !== undefined && prior >= at) return 'skipped';
      stored.set(contactId, at);
      return 'written';
    },
  };
  return { contacts, stored, touches };
}

const CONVERSATIONS: Record<string, unknown>[] = [
  { conversationId: 'phone#+15550100001', ref_conversationId: 'one' },
  { conversationId: 'one', type: 'tenant_1to1', participants: [{ contactId: 'c-a', phone: '+15550100001' }] },
  {
    conversationId: 'grp',
    type: 'relay_group',
    participants: [
      { contactId: 'c-b', phone: '+15550100002' },
      { contactId: 'c-c', phone: '+15550100003' },
      { contactId: '', phone: '+15550100004' },
    ],
  },
];

const MESSAGES: Record<string, unknown>[] = [
  { conversationId: 'one', tsMsgId: '2026-09-01T10:00:00.000Z#SM1', direction: 'inbound', type: 'sms' },
  { conversationId: 'one', tsMsgId: '2026-09-02T10:00:00.000Z#SM2', direction: 'inbound', type: 'sms' },
  { conversationId: 'grp', tsMsgId: '2026-09-03T10:00:00.000Z#B', direction: 'inbound', type: 'sms', relay_sender_key: 'c-b' },
  { conversationId: 'grp', tsMsgId: '2026-09-04T10:00:00.000Z#C', direction: 'inbound', type: 'sms', relay_sender_key: 'c-c' },
  {
    conversationId: 'grp',
    tsMsgId: '2026-09-05T10:00:00.000Z#D',
    direction: 'inbound',
    type: 'sms',
    relay_sender_key: 'phone#+15550100004',
  },
  // Both filtered by the Query.
  { conversationId: 'grp', tsMsgId: '2026-09-06T10:00:00.000Z#O', direction: 'outbound', type: 'sms', relay_sender_key: 'team' },
  {
    conversationId: 'grp',
    tsMsgId: '2026-09-07T10:00:00.000Z#R',
    direction: 'inbound',
    type: 'sms',
    relay_sender_key: 'c-b',
    relay_retry_of: '2026-09-03T10:00:00.000Z#B',
  },
];

const ENV = { TABLE_PREFIX: 'hc-test-' } as NodeJS.ProcessEnv;

function capturedLogger() {
  const capture = createLogCapture();
  return { capture, logger: createLogger({ level: 'info', destination: capture.stream }) };
}

describe('backfillLastHeardFrom - the runner', () => {
  it('a dry run (the default) plans and writes nothing', async () => {
    const { doc, queries } = fakeDoc(CONVERSATIONS, MESSAGES);
    const { contacts, touches } = fakeContacts();
    const { logger } = capturedLogger();
    const result = await backfillLastHeardFrom({ doc, env: ENV, contacts, logger });
    expect(touches).toEqual([]);
    expect(result.planned).toBe(4);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.pointerRows).toBe(1);
    expect(result.conversationsWalked).toBe(2);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q['TableName']).toBe('hc-test-messages');
      expect(q['FilterExpression']).toBe('#dir = :inbound AND attribute_not_exists(#retryOf)');
      expect(q['ScanIndexForward']).toBe(false);
    }
  });

  it('an apply makes ONE touch per contact with its MAX instant, and a second apply writes nothing', async () => {
    const { doc } = fakeDoc(CONVERSATIONS, MESSAGES);
    const { contacts, touches } = fakeContacts();
    const { logger } = capturedLogger();
    const first = await backfillLastHeardFrom({ doc, env: ENV, contacts, logger, apply: true });
    expect(touches).toEqual([
      { contactId: 'c-a', at: '2026-09-02T10:00:00.000Z' },
      { contactId: 'c-b', at: '2026-09-03T10:00:00.000Z' },
      { contactId: 'c-c', at: '2026-09-04T10:00:00.000Z' },
      { contactId: 'c-d', at: '2026-09-05T10:00:00.000Z' },
    ]);
    expect(first.written).toBe(first.planned);
    expect(first.written).toBe(4);

    const second = await backfillLastHeardFrom({ doc, env: ENV, contacts, logger, apply: true });
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(second.planned);
    expect(second.skipped).toBe(4);
  });

  it('pages: a 1:1 thread is queried once, a group thread until LastEvaluatedKey is gone', async () => {
    const { doc, queries } = fakeDoc(CONVERSATIONS, MESSAGES, 1);
    const { contacts, touches } = fakeContacts();
    const { logger } = capturedLogger();
    await backfillLastHeardFrom({ doc, env: ENV, contacts, logger, apply: true });
    const byThread = (id: string) => queries.filter((q) => q['ExpressionAttributeValues'][':c'] === id).length;
    expect(byThread('one')).toBe(1);
    expect(byThread('grp')).toBe(3);
    expect(queries.length).toBe(4);
    expect(touches.find((t) => t.contactId === 'c-a')?.at).toBe('2026-09-02T10:00:00.000Z');
  });

  it('a FAILED touch aborts the run with a PARTIAL report and no later touch', async () => {
    const { doc } = fakeDoc(CONVERSATIONS, MESSAGES);
    const { contacts, touches } = fakeContacts('c-a');
    const { capture, logger } = capturedLogger();
    await expect(backfillLastHeardFrom({ doc, env: ENV, contacts, logger, apply: true })).rejects.toThrow(
      /touchLastHeardFrom failed for c-a/,
    );
    expect(touches.map((t) => t.contactId)).toEqual(['c-a']);
    const partial = capture.atLevel(50).find((l) => String(l['msg']).includes('PARTIAL result'));
    expect(partial).toBeDefined();
    expect(partial?.['failed']).toBe(1);
    expect(partial?.['apply']).toBe(true);
  });

  it('reportBackfillRun returns 0 and names a dry run in its done line', () => {
    const result: BackfillResult = {
      conversationsWalked: 2,
      pointerRows: 1,
      messagesRead: 4,
      unattributed: 0,
      unattributedSample: [],
      unparseableInstants: 0,
      planned: 4,
      written: 0,
      skipped: 0,
      failed: 0,
    };
    const dry = capturedLogger();
    expect(reportBackfillRun(result, false, dry.logger)).toBe(0);
    const dryDone = dry.capture.atLevel(30).at(-1);
    expect(dryDone?.['msg']).toBe('backfill-last-heard-from - done (DRY RUN - nothing written)');
    expect(dryDone?.['planned']).toBe(4);
    expect(dryDone?.['apply']).toBe(false);

    const live = capturedLogger();
    expect(reportBackfillRun(result, true, live.logger)).toBe(0);
    expect(live.capture.atLevel(30).at(-1)?.['msg']).toBe('backfill-last-heard-from - done');
  });
});
