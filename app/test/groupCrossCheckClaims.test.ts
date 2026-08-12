// The cross-check ledger's CLAIM PRIMITIVES, at the wire level (fix wave 5,
// adversarial findings 3 and 9).
//
// WHY A WIRE-LEVEL SUITE. The integration suite next door proves the ledger's
// BEHAVIOUR against DynamoDB Local - but DynamoDB Local answers every read
// consistently, so it structurally cannot fail when a Query forgets
// `ConsistentRead`. Read lag is exactly half of the defect: the event half
// Queried for a `credit#` row and the classic half Queried for an `evt#` row,
// both eventually consistent, so a reader could miss a row written tens of
// milliseconds earlier with NO true interleave at all - and the sweep then
// logged `group_crosscheck_inbound_missing` at ERROR on healthy traffic.
//
// So these assert the SHAPE of the commands the repo issues: strongly
// consistent reads on the pair state, an atomic counter rather than
// check-then-act, and a CONDITIONAL delete whose result is inspected.
import { describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  createMessagesRepo,
  groupCrossCheckPairKey,
  GROUP_CROSSCHECK_STATE_SORT_KEY,
} from '../src/repos/messagesRepo.js';

const PAIR = groupCrossCheckPairKey('CH00000000000000000000000000000001', 'phone#+15551110001');
const NOW = '2026-08-11T12:00:00.000Z';
const NOT_BEFORE = '2026-08-11T11:45:00.000Z';
const EXPIRES = 1_800_000_000;

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/**
 * A doc client that records every command and answers from a script. Commands
 * are identified by constructor name, which is what the AWS SDK v3 gives us
 * without reaching into private fields.
 */
function fakeDoc(script: Array<(input: Record<string, unknown>) => unknown>): {
  doc: { send: (cmd: unknown) => Promise<unknown> };
  sent: Sent[];
} {
  const sent: Sent[] = [];
  let step = 0;
  return {
    sent,
    doc: {
      async send(cmd: unknown): Promise<unknown> {
        const command = cmd as { constructor: { name: string }; input: Record<string, unknown> };
        sent.push({ name: command.constructor.name, input: command.input });
        const next = script[step];
        step += 1;
        if (next === undefined) return {};
        return next(command.input);
      },
    },
  };
}

/**
 * A doc client backed by a MODELLED pair-state item, so a discard can be walked
 * against a balance that MOVES under it - which is the whole of the defect the
 * scripted fake above cannot express. Condition expressions are evaluated for
 * the two forms the repo issues, because "which reading is the write pinned to"
 * is exactly what decides whether a fresh credit survives.
 */
function ledgerDoc(
  state: { balance: number; since?: string },
  hooks: { beforeSettle?: () => void } = {},
): { doc: { send: (cmd: unknown) => Promise<unknown> }; sent: Sent[] } {
  const sent: Sent[] = [];
  const refused = new ConditionalCheckFailedException({ message: 'refused', $metadata: {} });
  let sawTheAdd = false;
  return {
    sent,
    doc: {
      async send(cmd: unknown): Promise<unknown> {
        const command = cmd as { constructor: { name: string }; input: Record<string, unknown> };
        sent.push({ name: command.constructor.name, input: command.input });
        const input = command.input;
        const onState =
          (input['Key'] as { tsMsgId?: string } | undefined)?.tsMsgId ===
          GROUP_CROSSCHECK_STATE_SORT_KEY;
        if (!onState) return {};
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              balance: state.balance,
              ...(state.since !== undefined && { credit_since: state.since }),
            },
          };
        }
        if (command.constructor.name !== 'UpdateCommand') return {};
        if (!sawTheAdd) {
          // The conditional ADD: the pair is in credit and the oldest of those
          // credits is stale, so DynamoDB refuses it and the discard begins.
          sawTheAdd = true;
          throw refused;
        }
        hooks.beforeSettle?.();
        const values = input['ExpressionAttributeValues'] as Record<string, unknown>;
        const condition = String(input['ConditionExpression'] ?? '');
        const observed = Number(values[':observed']);
        if (condition.includes('#b = :observed') && state.balance !== observed) throw refused;
        if (condition.includes('#b <= :observed') && !(state.balance <= observed)) throw refused;
        if (condition.includes('#cs = :since') && state.since !== values[':since']) throw refused;
        state.balance += Number(values[':delta']);
        if (String(input['UpdateExpression']).includes('REMOVE')) delete state.since;
        return { Attributes: { balance: state.balance } };
      },
    },
  };
}

/**
 * A doc client that answers a Query the way DynamoDB does: `Limit` is applied to
 * the rows READ, and a `FilterExpression` runs after that, so a filtered page
 * can come back empty with a `LastEvaluatedKey` still pointing at more rows.
 * The repo's only filter is `counted = true`, so that is what is modelled.
 */
function queryDoc(rows: Array<Record<string, unknown>>): {
  doc: { send: (cmd: unknown) => Promise<unknown> };
  sent: Sent[];
} {
  const sent: Sent[] = [];
  return {
    sent,
    doc: {
      async send(cmd: unknown): Promise<unknown> {
        const command = cmd as { constructor: { name: string }; input: Record<string, unknown> };
        sent.push({ name: command.constructor.name, input: command.input });
        if (command.constructor.name !== 'QueryCommand') return {};
        const input = command.input;
        const startKey = input['ExclusiveStartKey'] as { tsMsgId?: string } | undefined;
        const start =
          startKey === undefined
            ? 0
            : rows.findIndex((row) => row['tsMsgId'] === startKey.tsMsgId) + 1;
        const limit = Number(input['Limit'] ?? rows.length);
        const page = rows.slice(start, start + limit);
        const filtered =
          input['FilterExpression'] === undefined
            ? page
            : page.filter((row) => row['counted'] === true);
        const more = start + page.length < rows.length;
        const last = page[page.length - 1];
        return {
          Items: filtered,
          ...(more &&
            last !== undefined && {
              LastEvaluatedKey: { conversationId: PAIR, tsMsgId: last['tsMsgId'] },
            }),
        };
      },
    },
  };
}

const env = { TABLE_PREFIX: 'hc-unit-' };

describe('cross-check pair state is moved by ONE atomic counter', () => {
  const EVENT = {
    pairKey: PAIR,
    messageSid: 'IMevent0001',
    conversationSid: 'CH00000000000000000000000000000001',
    author: '+15551110001',
    deadlineAt: '2026-08-11T12:05:00.000Z',
  };
  const BOUNDS = { notBeforeIso: NOT_BEFORE, nowIso: NOW, expiresAt: EXPIRES };

  it('the event half issues a single conditional ADD, never a read-then-write', async () => {
    const { doc, sent } = fakeDoc([
      () => ({}), // pair row
      () => ({}), // due row
      () => ({ Attributes: { balance: 0 } }), // the ADD
      () => ({}), // rows retracted (this one matched a credit)
      () => ({}),
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    const landed = await repo.recordCrossCheckEvent(EVENT, BOUNDS);

    expect(landed).toBe('credit'); // balance <= 0 means it landed on a credit
    const add = sent[2]!;
    expect(add.name).toBe('UpdateCommand');
    expect(add.input['Key']).toEqual({
      conversationId: PAIR,
      tsMsgId: GROUP_CROSSCHECK_STATE_SORT_KEY,
    });
    expect(String(add.input['UpdateExpression'])).toContain('ADD');
    // The freshness bound is IN the condition, so a stale credit can never be
    // consumed by a racing writer between a read and a write - and the common
    // path takes no read at all, so a hot pair never has to retry.
    expect(String(add.input['ConditionExpression'])).toContain(':notBefore');
    expect(add.input['ReturnValues']).toBe('UPDATED_NEW');
  });

  it('a PENDING event marks its row COUNTED, and a row is never counted before its bump lands', async () => {
    // THE DEFECT (fix wave 2, adversarial 11): the row and the balance are two
    // writes, so a throw between them left rows the balance did not account for
    // - and the sweep's bare pair-scoped release then took a DIFFERENT event's
    // slot, making THAT one alarm falsely and banking a spurious credit able to
    // absorb a later real miss. The row now carries its own accounting: written
    // uncounted, marked counted only once the bump has landed, and both
    // consumers (the claim and the sweep's release) skip an uncounted row.
    const { doc, sent } = fakeDoc([
      () => ({}), // pair row
      () => ({}), // due row
      () => ({ Attributes: { balance: 1 } }), // the ADD
      () => ({}), // the counted mark
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.recordCrossCheckEvent(EVENT, BOUNDS)).toBe('pending');
    expect(sent.map((s) => s.name)).toEqual([
      'PutCommand',
      'PutCommand',
      'UpdateCommand',
      'UpdateCommand',
    ]);
    // The row goes down WITHOUT `counted`...
    expect(sent[0]!.input['Item']).not.toHaveProperty('counted');
    // ...and is marked only after the balance accounts for it.
    expect(String(sent[3]!.input['UpdateExpression'])).toContain('counted');
    expect(sent[3]!.input['Key']).toMatchObject({ conversationId: PAIR });
  });

  it('STALE credits are discarded by a DELTA, so a concurrently banked credit survives', async () => {
    // THE DEFECT (fix wave 2, adversarial 8 / conformance F9): the stale path was
    // `SET balance = 1`, which destroyed the WHOLE credit stack - including a
    // fresh credit banked microseconds earlier by a classic filing that really
    // did arrive. That filing's own event then alarmed for a message that was
    // matched. Recomputing by delta keeps the concurrent writer's contribution
    // in the arithmetic, and the condition makes the read-decide-write safe.
    const ccfe = new ConditionalCheckFailedException({ message: 'stale', $metadata: {} });
    const { doc, sent } = fakeDoc([
      () => ({}), // pair row
      () => ({}), // due row
      () => {
        throw ccfe; // the ADD refuses: in credit, and the oldest is stale
      },
      () => ({ Item: { balance: -5, credit_since: '2026-08-11T10:00:00.000Z' } }),
      () => ({ Attributes: { balance: 1 } }),
      () => ({}), // the counted mark
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.recordCrossCheckEvent(EVENT, BOUNDS)).toBe('pending');
    // The decision is made on a STRONGLY CONSISTENT read...
    expect(sent[3]!.name).toBe('GetCommand');
    expect(sent[3]!.input['ConsistentRead']).toBe(true);
    const settle = sent[4]!;
    expect(String(settle.input['UpdateExpression'])).toContain('ADD');
    // ...and moved by a DELTA off that reading, never by an overwrite.
    expect((settle.input['ExpressionAttributeValues'] as Record<string, unknown>)[':delta']).toBe(6);
    // The reset REMOVEs the oldest-credit stamp so the next filing re-stamps it.
    expect(String(settle.input['UpdateExpression'])).toContain('REMOVE');
    // Pinned to exactly the reading it was computed from.
    expect(String(settle.input['ConditionExpression'])).toContain('#cs = :since');
  });

  it('re-reads and re-decides when the pair moved out of the stale shape under it', async () => {
    const ccfe = new ConditionalCheckFailedException({ message: 'moved', $metadata: {} });
    const { doc, sent } = fakeDoc([
      () => ({}), // pair row
      () => ({}), // due row
      () => {
        throw ccfe; // the ADD refuses
      },
      // ...but by the time we look, the credits are gone: a plain bump is the
      // truthful answer now, and it must NOT remove a credit anchor it did not
      // decide against.
      () => ({ Item: { balance: 0 } }),
      () => ({ Attributes: { balance: 1 } }),
      () => ({}),
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.recordCrossCheckEvent(EVENT, BOUNDS)).toBe('pending');
    expect(String(sent[4]!.input['UpdateExpression'])).not.toContain('REMOVE');
  });

  it('a credit banked CONCURRENTLY with the discard SURVIVES it', async () => {
    // THE DEFECT (fix wave 3, adversarial 1). Discarding by `1 - observed` under
    // a condition pinned to `#b = :observed` lands the balance on exactly 1 for
    // EVERY reading, which is arithmetically the `SET balance = 1` it replaced:
    // a concurrent credit makes the pinned write refuse, the retry re-reads the
    // LOWER balance, and the fresh credit is discarded with the stale ones. Its
    // own event then alarms `group_crosscheck_inbound_missing` for a message
    // whose classic filing arrived. The discard must remove the credits it
    // DECIDED were stale - no more.
    const state = { balance: -5, since: '2026-08-11T10:00:00.000Z' };
    let banked = false;
    const { doc } = ledgerDoc(state, {
      beforeSettle: () => {
        if (banked) return;
        banked = true;
        // A classic filing for a message that really did arrive banks a FRESH
        // credit between the discard's read and its write.
        state.balance -= 1;
      },
    });
    const repo = createMessagesRepo({ doc: doc as never, env });

    // Five stale credits go; the sixth is fresh and claimable, so this event
    // MATCHES it instead of going pending and alarming.
    expect(await repo.recordCrossCheckEvent(EVENT, BOUNDS)).toBe('credit');
    expect(state.balance).toBe(0);
  });

  it('a discard that ran under it forces a re-read rather than double-discarding', async () => {
    // Two events discard the same stale stack. The first REMOVEs the anchor, so
    // the second's write refuses and it re-decides against the post-discard
    // balance - it must not subtract the same five credits twice.
    const state: { balance: number; since?: string } = {
      balance: -5,
      since: '2026-08-11T10:00:00.000Z',
    };
    let discarded = false;
    const { doc } = ledgerDoc(state, {
      beforeSettle: () => {
        if (discarded) return;
        discarded = true;
        state.balance = 1; // the other event's discard landed first
        delete state.since;
      },
    });
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.recordCrossCheckEvent(EVENT, BOUNDS)).toBe('pending');
    expect(state.balance).toBe(2); // two pending events, not eight
  });

  it('the classic half stamps the OLDEST credit only when it opens a credit run', async () => {
    const { doc, sent } = fakeDoc([() => ({ Attributes: { balance: -1 } })]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.bumpCrossCheckClassic(PAIR, NOW, EXPIRES)).toBe('credit');
    expect(String(sent[0]!.input['UpdateExpression'])).toContain('#cs = :now');
    expect(sent[0]!.input['ExpressionAttributeNames']).toMatchObject({ '#cs': 'credit_since' });
    expect(String(sent[0]!.input['ConditionExpression'])).toContain('>= :zero');
  });

  it('a classic filing onto a positive balance reports MATCHED', async () => {
    const { doc } = fakeDoc([() => ({ Attributes: { balance: 0 } })]);
    const repo = createMessagesRepo({ doc: doc as never, env });
    expect(await repo.bumpCrossCheckClassic(PAIR, NOW, EXPIRES)).toBe('matched');
  });

  it('stacking a SECOND credit keeps the first one as the window anchor', async () => {
    const ccfe = new ConditionalCheckFailedException({ message: 'already in credit', $metadata: {} });
    const { doc, sent } = fakeDoc([
      () => {
        throw ccfe;
      },
      () => ({ Attributes: { balance: -2 } }),
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.bumpCrossCheckClassic(PAIR, NOW, EXPIRES)).toBe('credit');
    expect(String(sent[1]!.input['UpdateExpression'])).not.toContain('#cs');
  });
});

describe('claiming a pending row is strongly consistent AND conditional', () => {
  it('reads the pending range with ConsistentRead - read lag alone caused false alarms', async () => {
    const { doc, sent } = fakeDoc([
      () => ({
        Items: [
          {
            tsMsgId: 'evt2#2026-08-11T12:05:00.000Z#IM1',
            message_sid: 'IM1',
            deadline_at: '2026-08-11T12:05:00.000Z',
            conversation_sid: 'CH1',
            author: '+15551110001',
            // COUNTED: the balance accounts for this row, so it is claimable.
            counted: true,
          },
        ],
      }),
      () => ({}), // conditional delete of the pair row
      () => ({}), // delete of the due row
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    const claimed = await repo.claimOldestCrossCheckPending(PAIR);

    expect(claimed?.messageSid).toBe('IM1');
    expect(sent[0]!.name).toBe('QueryCommand');
    expect(sent[0]!.input['ConsistentRead']).toBe(true);
    expect(sent[0]!.input['ScanIndexForward']).toBe(true); // oldest first
    // THE CLAIM: conditional, so two consumers cannot both take one row.
    expect(sent[1]!.name).toBe('DeleteCommand');
    expect(String(sent[1]!.input['ConditionExpression'])).toContain('attribute_exists');
  });

  it('a LOST claim moves on to the next-oldest row rather than reporting a match', async () => {
    const ccfe = new ConditionalCheckFailedException({ message: 'lost', $metadata: {} });
    const { doc, sent } = fakeDoc([
      () => ({
        Items: [
          {
            tsMsgId: 'evt2#2026-08-11T12:05:00.000Z#IM1',
            message_sid: 'IM1',
            deadline_at: '2026-08-11T12:05:00.000Z',
            conversation_sid: 'CH1',
            author: '+15551110001',
            // COUNTED: the balance accounts for this row, so it is claimable.
            counted: true,
          },
          {
            tsMsgId: 'evt2#2026-08-11T12:06:00.000Z#IM2',
            message_sid: 'IM2',
            deadline_at: '2026-08-11T12:06:00.000Z',
            conversation_sid: 'CH1',
            author: '+15551110001',
            counted: true,
          },
        ],
      }),
      () => {
        throw ccfe; // another consumer took IM1 first
      },
      () => ({}), // IM2's conditional delete succeeds
      () => ({}), // IM2's due row
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    const claimed = await repo.claimOldestCrossCheckPending(PAIR);

    expect(claimed?.messageSid).toBe('IM2');
    expect(sent).toHaveLength(4);
  });

  it('UNCOUNTED rows do not SHADOW a claimable one - the filter is not applied after the Limit', async () => {
    // THE DEFECT (fix wave 3, adversarial 2). `Limit` is applied at the index
    // and the `counted` filter ran in JS afterwards, so the three oldest rows
    // were all the claim ever saw. Uncounted rows are by definition OLDER than
    // the counted rows written after them, so on a pair carrying any of them the
    // claim returned `undefined`, the filing logged
    // `group_crosscheck_pending_row_missing`, and the counted row it should have
    // consumed alarmed at its deadline. Re-issuing the identical Query cannot
    // help: it returns the identical rows.
    const { doc, sent } = queryDoc([
      { tsMsgId: 'evt2#2026-08-11T12:01:00.000Z#IM1', message_sid: 'IM1', deadline_at: '2026-08-11T12:01:00.000Z' },
      { tsMsgId: 'evt2#2026-08-11T12:02:00.000Z#IM2', message_sid: 'IM2', deadline_at: '2026-08-11T12:02:00.000Z' },
      { tsMsgId: 'evt2#2026-08-11T12:03:00.000Z#IM3', message_sid: 'IM3', deadline_at: '2026-08-11T12:03:00.000Z' },
      {
        tsMsgId: 'evt2#2026-08-11T12:04:00.000Z#IM4',
        message_sid: 'IM4',
        deadline_at: '2026-08-11T12:04:00.000Z',
        conversation_sid: 'CH1',
        author: '+15551110001',
        counted: true,
      },
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect((await repo.claimOldestCrossCheckPending(PAIR))?.messageSid).toBe('IM4');
    // The filter rides the QUERY, so DynamoDB - not the caller - decides which
    // rows the page budget is spent on.
    expect(sent[0]!.input['FilterExpression']).toBeDefined();
  });

  it('PAGES past a long run of uncounted rows rather than giving up on the first empty page', async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30; i += 1) {
      const at = `2026-08-11T12:${String(i).padStart(2, '0')}:00.000Z`;
      rows.push({ tsMsgId: `evt2#${at}#IMu${i}`, message_sid: `IMu${i}`, deadline_at: at });
    }
    rows.push({
      tsMsgId: 'evt2#2026-08-11T13:00:00.000Z#IMc',
      message_sid: 'IMc',
      deadline_at: '2026-08-11T13:00:00.000Z',
      conversation_sid: 'CH1',
      author: '+15551110001',
      counted: true,
    });
    const { doc, sent } = queryDoc(rows);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect((await repo.claimOldestCrossCheckPending(PAIR))?.messageSid).toBe('IMc');
    // A filtered page can come back EMPTY with more rows behind it, so the claim
    // follows the LastEvaluatedKey instead of reading the emptiness as "nothing
    // claimable".
    const queries = sent.filter((s) => s.name === 'QueryCommand');
    expect(queries.length).toBeGreaterThan(1);
    expect(queries[1]!.input['ExclusiveStartKey']).toBeDefined();
  });

  it('an empty pending range returns undefined without deleting anything', async () => {
    const { doc, sent } = fakeDoc([() => ({ Items: [] })]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.claimOldestCrossCheckPending(PAIR)).toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});

describe('resolving an alarmed pending row', () => {
  const PAIR_SORT = 'evt2#2026-08-11T12:05:00.000Z#IM1';
  const DUE_SORT = '2026-08-11T12:05:00.000Z#IM1';

  it('reports the removal of an UNCOUNTED row too, so its stranded slot is freed', async () => {
    // THE DEFECT (fix wave 3, conformance 1). A throw between the balance ADD
    // and the `SET counted` leaves a +1 on the pair with an UNCOUNTED row under
    // it. Reporting only counted removals stranded that +1 permanently: the next
    // classic filing was absorbed by the phantom slot, banked no credit, and its
    // OWN event then alarmed. The sweep's release is conditional on a positive
    // balance, so reporting the removal is safe by construction - if the bump
    // never landed there is no positive balance to take.
    const { doc } = fakeDoc([
      () => ({ Attributes: { conversationId: PAIR, tsMsgId: PAIR_SORT } }), // no `counted`
      () => ({}), // the due row
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.resolveCrossCheckPending(PAIR, PAIR_SORT, DUE_SORT)).toBe(true);
  });

  it('reports NOTHING removed when a classic filing claimed the row first', async () => {
    const ccfe = new ConditionalCheckFailedException({ message: 'claimed', $metadata: {} });
    const { doc, sent } = fakeDoc([
      () => {
        throw ccfe;
      },
      () => ({}), // the due row goes either way - the alarm has fired
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.resolveCrossCheckPending(PAIR, PAIR_SORT, DUE_SORT)).toBe(false);
    expect(sent).toHaveLength(2);
  });
});

describe('releasing an alarmed pending slot', () => {
  it('decrements only a POSITIVE balance and swallows the race', async () => {
    const ccfe = new ConditionalCheckFailedException({ message: 'square', $metadata: {} });
    const { doc, sent } = fakeDoc([
      () => {
        throw ccfe;
      },
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    await expect(repo.releaseCrossCheckPending(PAIR)).resolves.toBeUndefined();
    expect(String(sent[0]!.input['ConditionExpression'])).toContain('> :zero');
  });
});
