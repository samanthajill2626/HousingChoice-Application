// Unit tests for the unread-flag backfill (design 2026-08-16 section 7.2), in
// two halves.
//
// 1. The PURE planner. No database: every rule, and the precedence BETWEEN
//    rules, is decided by planUnreadBackfill alone. The precedence is the
//    contract, not an implementation detail: rules 2 and 3 (the retroactive
//    close/delete resets) deliberately outrank rule 4 (stamp), so legacy
//    invisible residents are cleaned rather than suddenly surfaced into the
//    badge.
// 2. The RUNNER's conditional writes, through the script's own `doc` seam
//    against a fake that MODELS CONDITIONAL WRITES. These are race tests, not
//    happy-path tests: the whole point of a ConditionExpression is what happens
//    when the row moves between the planner's read and the runner's write, and
//    that window is long here - the runner awaits a write (and, for a
//    deleted-contact row, a listByConversation probe) for every row of a Scan
//    page, so the tail of a page is written many seconds after it was read.
//    This script is scheduled against LIVE PROD at the M1.11 cutover.
import { describe, it, expect } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  NO_CONTACT_KEYS,
  backfillUnreadFlag,
  deletedAtForItem,
  planUnreadBackfill,
  resolveProbe,
  type ContactKeyIndex,
} from '../scripts/backfill-unread-flag.js';
import { UNREAD_FLAG_VALUE } from '../src/repos/conversationsRepo.js';

const DELETED_PHONE = '+15550100999';
const DELETED_EMAIL = 'gone@example.test';
const LIVE_PHONE = '+15550100888';
const DELETED_AT = '2026-08-10T00:00:00.000Z';

const DELETED: ContactKeyIndex = {
  phones: new Set([DELETED_PHONE]),
  emails: new Set([DELETED_EMAIL]),
  deletedAtByKey: new Map([
    [DELETED_PHONE, DELETED_AT],
    [DELETED_EMAIL, DELETED_AT],
  ]),
};

/** A plain 1:1 conversation row as a Scan returns it (raw, untyped document). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: 'conv-0001',
    type: 'tenant_1to1',
    status: 'open',
    participant_phone: '+15550100001',
    last_activity_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('planUnreadBackfill', () => {
  describe('rule 1 - pointer/claim partitions', () => {
    it.each(['phone#+15550100001', 'email#someone@example.test', 'token#abc123'])(
      'skips %s (key-only rows that can never enter the index)',
      (conversationId) => {
        // Deliberately give it unread-looking attributes: the prefix alone must
        // decide, because a pointer row is not a conversation.
        expect(
          planUnreadBackfill(
            { conversationId, ref_conversationId: 'conv-0001', unread_count: 5 },
            DELETED,
          ),
        ).toEqual({ kind: 'skip' });
      },
    );
  });

  describe('rule 2 - relay group closed while unread', () => {
    it('resets a CLOSED relay_group carrying unread', () => {
      expect(
        planUnreadBackfill(
          row({ type: 'relay_group', status: 'closed', unread_count: 3 }),
          NO_CONTACT_KEYS,
        ),
      ).toEqual({ kind: 'reset' });
    });

    it('resets it even when it is already flagged (the flag is not the point)', () => {
      expect(
        planUnreadBackfill(
          row({
            type: 'relay_group',
            status: 'closed',
            unread_count: 3,
            unread_flag: UNREAD_FLAG_VALUE,
          }),
          NO_CONTACT_KEYS,
        ),
      ).toEqual({ kind: 'reset' });
    });

    it('OUTRANKS the stamp rule - a closed unread relay is never surfaced', () => {
      // Precedence proof: this row satisfies rule 4 too (unread > 0, no flag).
      const closedUnread = row({ type: 'relay_group', status: 'closed', unread_count: 3 });
      expect(planUnreadBackfill(closedUnread, NO_CONTACT_KEYS).kind).not.toBe('stamp');
    });

    it('leaves an OPEN relay group alone - it stamps like any unread thread', () => {
      expect(
        planUnreadBackfill(
          row({ type: 'relay_group', status: 'open', unread_count: 3 }),
          NO_CONTACT_KEYS,
        ),
      ).toEqual({ kind: 'stamp' });
    });

    it('a closed relay with NO unread just drops a stray flag', () => {
      expect(
        planUnreadBackfill(
          row({
            type: 'relay_group',
            status: 'closed',
            unread_count: 0,
            unread_flag: UNREAD_FLAG_VALUE,
          }),
          NO_CONTACT_KEYS,
        ),
      ).toEqual({ kind: 'remove' });
    });
  });

  describe('rule 3 - soft-deleted contact threads', () => {
    it('probes an unread thread whose participant PHONE belongs to a deleted contact', () => {
      expect(
        planUnreadBackfill(row({ participant_phone: DELETED_PHONE, unread_count: 2 }), DELETED),
      ).toEqual({ kind: 'probe' });
    });

    it('probes an unread thread matched by participant EMAIL', () => {
      expect(
        planUnreadBackfill(
          row({ participant_phone: undefined, participant_email: DELETED_EMAIL, unread_count: 2 }),
          DELETED,
        ),
      ).toEqual({ kind: 'probe' });
    });

    it('OUTRANKS the stamp rule, so a deleted contact never surfaces unprobed', () => {
      const deletedUnread = row({ participant_phone: DELETED_PHONE, unread_count: 2 });
      expect(planUnreadBackfill(deletedUnread, DELETED).kind).not.toBe('stamp');
      // ...and the SAME row against a live contact stamps, which is what makes
      // this a precedence test rather than a restatement of rule 4.
      expect(planUnreadBackfill(deletedUnread, NO_CONTACT_KEYS)).toEqual({ kind: 'stamp' });
    });

    it('a closed relay whose participant is deleted still takes the CLOSE rule (2 before 3)', () => {
      expect(
        planUnreadBackfill(
          row({
            type: 'relay_group',
            status: 'closed',
            participant_phone: DELETED_PHONE,
            unread_count: 2,
          }),
          DELETED,
        ),
      ).toEqual({ kind: 'reset' });
    });

    it('does not probe a READ thread of a deleted contact - it just drops the flag', () => {
      expect(
        planUnreadBackfill(
          row({
            participant_phone: DELETED_PHONE,
            unread_count: 0,
            unread_flag: UNREAD_FLAG_VALUE,
          }),
          DELETED,
        ),
      ).toEqual({ kind: 'remove' });
    });
  });

  describe('rule 4 - stamp', () => {
    it('stamps an unread row with no flag (the migration proper)', () => {
      expect(planUnreadBackfill(row({ unread_count: 1 }), NO_CONTACT_KEYS)).toEqual({
        kind: 'stamp',
      });
    });

    it('is idempotent: an already-flagged unread row is skipped, not re-stamped', () => {
      expect(
        planUnreadBackfill(
          row({ unread_count: 1, unread_flag: UNREAD_FLAG_VALUE }),
          NO_CONTACT_KEYS,
        ),
      ).toEqual({ kind: 'skip' });
    });

    it('stamps a legacy row with no `type` at all', () => {
      // ConversationItem.type is REQUIRED in the type system, but the rows this
      // script exists for are RAW legacy documents that predate it - the planner
      // takes Record<string, unknown> precisely so it can decide about them.
      const legacy: Record<string, unknown> = {
        conversationId: 'conv-legacy',
        status: 'open',
        participant_phone: '+15550100002',
        unread_count: 4,
      };
      expect(planUnreadBackfill(legacy, NO_CONTACT_KEYS)).toEqual({ kind: 'stamp' });
    });
  });

  describe('rule 5 - remove a stale flag', () => {
    it('removes the flag when the count is 0', () => {
      expect(
        planUnreadBackfill(
          row({ unread_count: 0, unread_flag: UNREAD_FLAG_VALUE }),
          NO_CONTACT_KEYS,
        ),
      ).toEqual({ kind: 'remove' });
    });

    it('removes the flag when the count attribute is ABSENT entirely', () => {
      expect(
        planUnreadBackfill(row({ unread_flag: UNREAD_FLAG_VALUE }), NO_CONTACT_KEYS),
      ).toEqual({ kind: 'remove' });
    });
  });

  describe('rule 6 - already correct', () => {
    it('skips a read row with no flag', () => {
      expect(planUnreadBackfill(row({ unread_count: 0 }), NO_CONTACT_KEYS)).toEqual({
        kind: 'skip',
      });
    });

    it('skips a freshly imported row that carries no unread attributes at all', () => {
      expect(planUnreadBackfill(row(), NO_CONTACT_KEYS)).toEqual({ kind: 'skip' });
    });

    it('treats a non-numeric unread_count as zero rather than throwing', () => {
      expect(
        planUnreadBackfill(row({ unread_count: 'two' }), NO_CONTACT_KEYS),
      ).toEqual({ kind: 'skip' });
    });
  });
});

describe('deletedAtForItem', () => {
  it('resolves by phone FIRST, matching the runtime hydration order', () => {
    const keys: ContactKeyIndex = {
      phones: new Set([DELETED_PHONE]),
      emails: new Set([DELETED_EMAIL]),
      deletedAtByKey: new Map([
        [DELETED_PHONE, '2026-08-01T00:00:00.000Z'],
        [DELETED_EMAIL, '2026-08-20T00:00:00.000Z'],
      ]),
    };
    expect(
      deletedAtForItem(
        row({ participant_phone: DELETED_PHONE, participant_email: DELETED_EMAIL }),
        keys,
      ),
    ).toBe('2026-08-01T00:00:00.000Z');
  });

  it('falls back to email when the phone is not a deleted key', () => {
    expect(
      deletedAtForItem(row({ participant_email: DELETED_EMAIL }), DELETED),
    ).toBe(DELETED_AT);
  });

  it('is undefined for a live contact', () => {
    expect(deletedAtForItem(row(), DELETED)).toBeUndefined();
  });

  it('DECIDES FROM THE PHONE ALONE when it belongs to ANY contact, live or deleted', () => {
    // Adversarial A5. The runtime resolves findByPhone FIRST and, if it returns
    // a contact - live or deleted - never consults findByEmail. So a key index
    // that only knows DELETED phones makes the backfill fall through to an
    // email owned by someone else entirely, and decide "deleted thread" about a
    // LIVE contact's unread. The index therefore carries EVERY contact's keys;
    // `deletedAtByKey` is what distinguishes them.
    const keys: ContactKeyIndex = {
      phones: new Set([LIVE_PHONE, DELETED_PHONE]),
      emails: new Set([DELETED_EMAIL]),
      deletedAtByKey: new Map([
        [DELETED_PHONE, DELETED_AT],
        [DELETED_EMAIL, DELETED_AT],
      ]),
    };
    const mixed = row({ participant_phone: LIVE_PHONE, participant_email: DELETED_EMAIL });
    expect(deletedAtForItem(mixed, keys)).toBeUndefined();
    expect(planUnreadBackfill({ ...mixed, unread_count: 3 }, keys)).toEqual({ kind: 'stamp' });
  });
});

describe('resolveProbe (the runtime resurfacing predicate)', () => {
  it('probe -> STAMP when the newest message is inbound AFTER the delete', () => {
    expect(
      resolveProbe({ direction: 'inbound', created_at: '2026-08-11T00:00:00.000Z' }, DELETED_AT),
    ).toEqual({ kind: 'stamp' });
  });

  it('probe -> RESET when the newest inbound predates the delete', () => {
    expect(
      resolveProbe({ direction: 'inbound', created_at: '2026-08-09T00:00:00.000Z' }, DELETED_AT),
    ).toEqual({ kind: 'reset' });
  });

  it('probe -> RESET when the newest message is OUTBOUND, however recent', () => {
    // Outbound never resurfaces a deleted contact - only THEY can.
    expect(
      resolveProbe({ direction: 'outbound', created_at: '2026-09-01T00:00:00.000Z' }, DELETED_AT),
    ).toEqual({ kind: 'reset' });
  });

  it('probe -> RESET when the thread has no messages at all', () => {
    expect(resolveProbe(undefined, DELETED_AT)).toEqual({ kind: 'reset' });
  });

  it('probe -> RESET when created_at is missing (absent never counts as new)', () => {
    expect(resolveProbe({ direction: 'inbound' }, DELETED_AT)).toEqual({ kind: 'reset' });
  });

  it('an inbound EXACTLY at the delete instant does not resurface (strict >)', () => {
    expect(resolveProbe({ direction: 'inbound', created_at: DELETED_AT }, DELETED_AT)).toEqual({
      kind: 'reset',
    });
  });
});

// --- The runner's conditional writes, and the races they exist for -----------
//
// A fake DynamoDBDocumentClient that MODELS the two facts that matter here: a
// Scan hands back a point-in-time COPY of each item, and an UpdateCommand
// evaluates its ConditionExpression against the LIVE stored row at write time.
// The gap between those two is the race window the conditions defend.

type Row = Record<string, unknown>;

const CONVERSATIONS_TABLE = 'test-conversations';
const CONTACTS_TABLE = 'test-contacts';
const TEST_ENV: NodeJS.ProcessEnv = { TABLE_PREFIX: 'test-' };

function conditionalCheckFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: 'The conditional request failed',
    $metadata: {},
  });
}

/** `:v` resolves to the supplied value; `#n` to the aliased attribute; anything
 *  else is a bare attribute name. */
function operandOf(token: string, row: Row, names: Record<string, string>, values: Row): unknown {
  if (token.startsWith(':')) return values[token];
  return row[token.startsWith('#') ? (names[token] ?? token) : token];
}

/**
 * Evaluate the small ConditionExpression grammar this script uses: terms joined
 * by AND, each one attribute_exists(x), attribute_not_exists(x), or a
 * comparison against a placeholder. Anything else THROWS rather than silently
 * passing - a fake that quietly approves an expression it does not understand
 * would make every test below vacuous.
 */
function evaluateCondition(
  expression: string,
  row: Row,
  names: Record<string, string>,
  values: Row,
): boolean {
  return expression.split(' AND ').every((raw) => {
    const term = raw.trim();
    const exists = /^attribute_exists\((.+)\)$/.exec(term);
    if (exists) return exists[1]! in row;
    const notExists = /^attribute_not_exists\((.+)\)$/.exec(term);
    if (notExists) return !(notExists[1]! in row);
    const compare = /^(\S+)\s*(=|>)\s*(\S+)$/.exec(term);
    if (!compare) throw new Error(`fake doc: unsupported condition term "${term}"`);
    const left = operandOf(compare[1]!, row, names, values);
    const right = operandOf(compare[3]!, row, names, values);
    if (compare[2] === '=') return left === right;
    // DynamoDB's > against a missing or non-numeric attribute is FALSE, never an
    // error - the same posture as the real service.
    return typeof left === 'number' && typeof right === 'number' && left > right;
  });
}

/** Apply the small UpdateExpression grammar this script uses (SET / REMOVE). */
function applyUpdate(row: Row, expression: string, names: Record<string, string>, values: Row): void {
  const setClause = /\bSET\s+(.+?)(?=\s+REMOVE\b|$)/.exec(expression);
  const removeClause = /\bREMOVE\s+(.+?)(?=\s+SET\b|$)/.exec(expression);
  for (const assignment of setClause?.[1]?.split(',') ?? []) {
    const [lhs, rhs] = assignment.split('=').map((s) => s.trim());
    const attribute = lhs!.startsWith('#') ? (names[lhs!] ?? lhs!) : lhs!;
    row[attribute] = values[rhs!];
  }
  for (const raw of removeClause?.[1]?.split(',') ?? []) {
    const name = raw.trim();
    delete row[name.startsWith('#') ? (names[name] ?? name) : name];
  }
}

interface FakeDoc {
  doc: DynamoDBDocumentClient;
  /** Every UpdateCommand the runner issued, and whether its condition held. */
  writes: Array<{ conversationId: string; applied: boolean }>;
}

function fakeDoc(
  tables: Record<string, Row[]>,
  hooks: { beforeWrite?: (conversationId: string) => void } = {},
): FakeDoc {
  const writes: FakeDoc['writes'] = [];
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof ScanCommand) {
      const table = String(command.input.TableName);
      // COPIES, deliberately: the planner decides from a point-in-time image, so
      // a later mutation of the store is invisible to it. That gap IS the
      // finding.
      return { Items: (tables[table] ?? []).map((r) => ({ ...r })) };
    }
    if (command instanceof UpdateCommand) {
      const table = String(command.input.TableName);
      const conversationId = String((command.input.Key as Row)['conversationId']);
      // THE RACE: a concurrent writer lands here - after the Scan read (and
      // after any probe), immediately before this write is evaluated.
      hooks.beforeWrite?.(conversationId);
      const row = (tables[table] ?? []).find((r) => r['conversationId'] === conversationId);
      if (row === undefined) throw conditionalCheckFailed();
      const names = command.input.ExpressionAttributeNames ?? {};
      const values = (command.input.ExpressionAttributeValues ?? {}) as Row;
      const applied = evaluateCondition(String(command.input.ConditionExpression), row, names, values);
      writes.push({ conversationId, applied });
      if (!applied) throw conditionalCheckFailed();
      applyUpdate(row, String(command.input.UpdateExpression), names, values);
      return {};
    }
    throw new Error('fake doc: unexpected command');
  };
  return { doc: { send } as unknown as DynamoDBDocumentClient, writes };
}

/** A messages repo whose probe returns `latest`, optionally firing a hook AFTER
 *  it answers - which is exactly "an inbound landed right after the probe". */
function fakeMessages(latest: Row | undefined, afterProbe?: () => void): never {
  return {
    listByConversation: async (): Promise<Row[]> => {
      const page = latest === undefined ? [] : [latest];
      afterProbe?.();
      return page;
    },
  } as unknown as never;
}

describe('backfillUnreadFlag runner - conditional writes under concurrency', () => {
  /** The design invariant every assertion below is really about: the flag exists
   *  IFF the row's unread is meant to be > 0 (spec 4.2). */
  const flagMatchesCount = (row: Row): boolean =>
    'unread_flag' in row === (typeof row['unread_count'] === 'number' && row['unread_count'] > 0);

  const deletedContactRow = (): Row => ({
    contactId: 'c-gone',
    type: 'tenant',
    status: 'active',
    phone: DELETED_PHONE,
    deleted_at: DELETED_AT,
  });

  describe('stamp (rule 4) - adversarial NEW-1', () => {
    it('does NOT stamp a row a concurrent mark-read zeroed between the Scan and the write', async () => {
      // A pre-migration row: unread, no flag -> the planner says `stamp`.
      const legacy: Row = {
        conversationId: 'conv-legacy',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: '+15550100002',
        unread_count: 4,
      };
      let raced = false;
      const fake = fakeDoc(
        { [CONVERSATIONS_TABLE]: [legacy], [CONTACTS_TABLE]: [] },
        {
          beforeWrite: () => {
            if (raced) return;
            raced = true;
            // A VA marks the thread read inside the runner's window. resetUnread
            // leaves count 0 with the flag STILL absent - so the flag-only
            // condition passed and the migration stamped a READ row.
            legacy['unread_count'] = 0;
            delete legacy['unread_flag'];
          },
        },
      );

      const result = await backfillUnreadFlag({
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: fakeMessages(undefined),
      });

      expect(raced).toBe(true);
      // The condition must have LOST. Without `unread_count > :zero` it wins and
      // manufactures {unread_count: 0, unread_flag: 'unread'} - a member of the
      // sparse GSI that isUnreadVisible rejects forever and no runtime path ever
      // removes (resetUnread is the only REMOVE, and it will not run again for
      // an already-read thread). A permanent invisible resident created BY the
      // migration, burning scan budget on every nav-badge request.
      expect(fake.writes).toEqual([{ conversationId: 'conv-legacy', applied: false }]);
      expect('unread_flag' in legacy).toBe(false);
      expect(flagMatchesCount(legacy)).toBe(true);
      // ...and the run report SAYS so (adversarial A8): the applied counter does
      // not claim a write that lost its condition.
      expect(result.stamped).toBe(0);
      expect(result.skippedOnCondition.stamp).toBe(1);
    });

    it('still stamps when nothing races (the migration proper)', async () => {
      const legacy: Row = {
        conversationId: 'conv-legacy',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: '+15550100002',
        unread_count: 4,
      };
      const fake = fakeDoc({ [CONVERSATIONS_TABLE]: [legacy], [CONTACTS_TABLE]: [] });

      const result = await backfillUnreadFlag({
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: fakeMessages(undefined),
      });

      expect(fake.writes).toEqual([{ conversationId: 'conv-legacy', applied: true }]);
      expect(legacy['unread_flag']).toBe(UNREAD_FLAG_VALUE);
      expect(flagMatchesCount(legacy)).toBe(true);
      expect(result.stamped).toBe(1);
    });
  });

  describe('reset (rules 2 and 3) - adversarial NEW-2', () => {
    it('does NOT zero a deleted-contact thread a post-deletion inbound resurfaced after the probe', async () => {
      const thread: Row = {
        conversationId: 'conv-resurfaced',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: DELETED_PHONE,
        unread_count: 1,
        unread_flag: UNREAD_FLAG_VALUE,
      };
      let raced = false;
      const fake = fakeDoc({
        [CONVERSATIONS_TABLE]: [thread],
        [CONTACTS_TABLE]: [deletedContactRow()],
      });
      // The probe reads a PRE-deletion inbound, so resolveProbe says `reset`...
      const messages = fakeMessages(
        { direction: 'inbound', created_at: '2026-08-09T00:00:00.000Z' },
        () => {
          // ...and THEN the person actually writes back. incrementUnread bumps
          // the counter and (re)stamps the flag in one write. This is precisely
          // the event the resurfacing rule exists to surface.
          raced = true;
          thread['unread_count'] = 2;
          thread['unread_flag'] = UNREAD_FLAG_VALUE;
        },
      );

      const result = await backfillUnreadFlag({
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: messages,
      });

      expect(raced).toBe(true);
      // `unread_count > :zero` was satisfied by the NEW inbound, so the old
      // condition zeroed it: the message survived in the thread but the contact
      // never resurfaced in the inbox and never reached the badge - the operator
      // was never told the person wrote back.
      expect(fake.writes).toEqual([{ conversationId: 'conv-resurfaced', applied: false }]);
      expect(thread['unread_count']).toBe(2);
      expect(thread['unread_flag']).toBe(UNREAD_FLAG_VALUE);
      expect(flagMatchesCount(thread)).toBe(true);
      expect(result.deletedReset).toBe(0);
      expect(result.skippedOnCondition.deletedReset).toBe(1);
      // The probe happened either way - it is a READ, not a write.
      expect(result.probed).toBe(1);
    });

    it('still zeroes a deleted-contact thread that did NOT resurface', async () => {
      const thread: Row = {
        conversationId: 'conv-stable-no',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: DELETED_PHONE,
        unread_count: 1,
        unread_flag: UNREAD_FLAG_VALUE,
      };
      const fake = fakeDoc({
        [CONVERSATIONS_TABLE]: [thread],
        [CONTACTS_TABLE]: [deletedContactRow()],
      });

      const result = await backfillUnreadFlag({
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: fakeMessages({
          direction: 'inbound',
          created_at: '2026-08-09T00:00:00.000Z',
        }),
      });

      expect(fake.writes).toEqual([{ conversationId: 'conv-stable-no', applied: true }]);
      expect(thread['unread_count']).toBe(0);
      expect('unread_flag' in thread).toBe(false);
      expect(flagMatchesCount(thread)).toBe(true);
      expect(result.deletedReset).toBe(1);
    });

    it('does NOT zero a closed relay group an inbound reopened between the Scan and the write', async () => {
      const group: Row = {
        conversationId: 'conv-relay-closed',
        type: 'relay_group',
        status: 'closed',
        participant_phone: '+15550100777',
        unread_count: 3,
        unread_flag: UNREAD_FLAG_VALUE,
      };
      let raced = false;
      const fake = fakeDoc(
        { [CONVERSATIONS_TABLE]: [group], [CONTACTS_TABLE]: [] },
        {
          beforeWrite: () => {
            if (raced) return;
            raced = true;
            // An inbound on the group: incrementUnread bumps the counter and
            // touchLastActivity writes status 'open' - it is no longer the
            // CLOSED row rule 2 selected.
            group['unread_count'] = 4;
            group['status'] = 'open';
          },
        },
      );

      const result = await backfillUnreadFlag({
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: fakeMessages(undefined),
      });

      expect(raced).toBe(true);
      expect(fake.writes).toEqual([{ conversationId: 'conv-relay-closed', applied: false }]);
      // A now-OPEN group carrying real unread. `unread_count > :zero` alone
      // zeroed it, silently, on a group staff had just been talking in.
      expect(group['unread_count']).toBe(4);
      expect(group['status']).toBe('open');
      expect(flagMatchesCount(group)).toBe(true);
      expect(result.closedReset).toBe(0);
      expect(result.skippedOnCondition.closedReset).toBe(1);
    });

    it('still zeroes a relay group still closed and still at the observed count', async () => {
      const group: Row = {
        conversationId: 'conv-relay-closed',
        type: 'relay_group',
        status: 'closed',
        participant_phone: '+15550100777',
        unread_count: 3,
        unread_flag: UNREAD_FLAG_VALUE,
      };
      const fake = fakeDoc({ [CONVERSATIONS_TABLE]: [group], [CONTACTS_TABLE]: [] });

      const result = await backfillUnreadFlag({
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: fakeMessages(undefined),
      });

      expect(fake.writes).toEqual([{ conversationId: 'conv-relay-closed', applied: true }]);
      expect(group['unread_count']).toBe(0);
      expect('unread_flag' in group).toBe(false);
      expect(flagMatchesCount(group)).toBe(true);
      expect(result.closedReset).toBe(1);
    });
  });

  describe('the contact-key pre-pass (adversarial A5)', () => {
    it('does NOT reset a LIVE contact thread whose participant_email belongs to a deleted one', async () => {
      // participant_email is a LAST-WRITER HINT (conversationsRepo's own note on
      // attachEmailToConversation), so a thread can carry a phone owned by a
      // live contact and an email owned by a soft-deleted one. The runtime stops
      // at findByPhone and says "live contact, keep the unread"; a pre-pass that
      // only knew DELETED phones fell through to the email and reset - a silent,
      // irreversible zero on a live person's thread, and the `reset` condition
      // guards the observed COUNT, not the contact identity, so nothing caught
      // it.
      const thread: Row = {
        conversationId: 'conv-live-with-stale-email',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: LIVE_PHONE,
        participant_email: DELETED_EMAIL,
        unread_count: 3,
      };
      const fake = fakeDoc({
        [CONVERSATIONS_TABLE]: [thread],
        [CONTACTS_TABLE]: [
          { contactId: 'c-live', type: 'tenant', status: 'searching', phone: LIVE_PHONE },
          {
            contactId: 'c-gone-mail',
            type: 'tenant',
            status: 'active',
            email: DELETED_EMAIL,
            deleted_at: DELETED_AT,
          },
        ],
      });

      const result = await backfillUnreadFlag({
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: fakeMessages(undefined),
      });

      // STAMPED, not probed and not reset.
      expect(result.probed).toBe(0);
      expect(result.deletedReset).toBe(0);
      expect(result.stamped).toBe(1);
      expect(thread['unread_count']).toBe(3);
      expect(thread['unread_flag']).toBe(UNREAD_FLAG_VALUE);
      expect(flagMatchesCount(thread)).toBe(true);
    });

    it('still probes when the phone belongs to nobody and the EMAIL is the deleted contact', async () => {
      // The fall-through is not removed, only demoted: it applies exactly when
      // the phone resolves to no contact at all, which is the runtime's order.
      const thread: Row = {
        conversationId: 'conv-email-only',
        type: 'tenant_1to1',
        status: 'open',
        participant_email: DELETED_EMAIL,
        unread_count: 1,
        unread_flag: UNREAD_FLAG_VALUE,
      };
      const fake = fakeDoc({
        [CONVERSATIONS_TABLE]: [thread],
        [CONTACTS_TABLE]: [
          {
            contactId: 'c-gone-mail',
            type: 'tenant',
            status: 'active',
            email: DELETED_EMAIL,
            deleted_at: DELETED_AT,
          },
        ],
      });

      const result = await backfillUnreadFlag({
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: fakeMessages({ direction: 'outbound', created_at: '2026-08-20T00:00:00.000Z' }),
      });

      expect(result.probed).toBe(1);
      expect(result.deletedReset).toBe(1);
      expect(thread['unread_count']).toBe(0);
      expect('unread_flag' in thread).toBe(false);
    });
  });

  describe('the run report counts OUTCOMES, not attempts (adversarial A8)', () => {
    it('splits a lost conditional write out of the applied counter', async () => {
      // The run report is the operator's only feedback on a ONE-SHOT prod
      // migration, and the RUNBOOK tells them to dry-run first and compare.
      // Counting attempts made a live run in which most conditions LOST look
      // exactly like a clean one - and a lost `stamp` is precisely the case the
      // guard exists for.
      const legacy: Row = {
        conversationId: 'conv-legacy',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: '+15550100002',
        unread_count: 4,
      };
      let raced = false;
      const fake = fakeDoc(
        { [CONVERSATIONS_TABLE]: [legacy], [CONTACTS_TABLE]: [] },
        {
          beforeWrite: () => {
            if (raced) return;
            raced = true;
            legacy['unread_count'] = 0;
          },
        },
      );

      const result = await backfillUnreadFlag({
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: fakeMessages(undefined),
      });

      expect(raced).toBe(true);
      expect(fake.writes).toEqual([{ conversationId: 'conv-legacy', applied: false }]);
      expect(result.stamped).toBe(0);
      expect(result.skippedOnCondition).toEqual({
        stamp: 1,
        remove: 0,
        closedReset: 0,
        deletedReset: 0,
      });
    });

    it('a DRY RUN still reports the PLAN, with nothing skipped', async () => {
      // Nothing is written, so nothing can lose a condition: the dry run's job
      // is to say what WOULD happen, and comparing it against the live run's
      // applied counts is how the operator sees a race-heavy run.
      const legacy: Row = {
        conversationId: 'conv-legacy',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: '+15550100002',
        unread_count: 4,
      };
      const fake = fakeDoc({ [CONVERSATIONS_TABLE]: [legacy], [CONTACTS_TABLE]: [] });

      const result = await backfillUnreadFlag({
        dryRun: true,
        doc: fake.doc,
        env: TEST_ENV,
        messagesRepo: fakeMessages(undefined),
      });

      expect(fake.writes).toEqual([]);
      expect(result.stamped).toBe(1);
      expect(result.skippedOnCondition).toEqual({
        stamp: 0,
        remove: 0,
        closedReset: 0,
        deletedReset: 0,
      });
      expect('unread_flag' in legacy).toBe(false);
    });
  });
});
