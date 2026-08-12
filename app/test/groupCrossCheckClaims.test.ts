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

const env = { TABLE_PREFIX: 'hc-unit-' };

describe('cross-check pair state is moved by ONE atomic counter', () => {
  it('the event half issues a single conditional ADD, never a read-then-write', async () => {
    const { doc, sent } = fakeDoc([() => ({ Attributes: { balance: 0 } })]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    const landed = await repo.bumpCrossCheckEvent(PAIR, NOT_BEFORE, NOW, EXPIRES);

    expect(landed).toBe('credit'); // balance <= 0 means it landed on a credit
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe('UpdateCommand');
    expect(sent[0]!.input['Key']).toEqual({
      conversationId: PAIR,
      tsMsgId: GROUP_CROSSCHECK_STATE_SORT_KEY,
    });
    expect(String(sent[0]!.input['UpdateExpression'])).toContain('ADD');
    // The freshness bound is IN the condition, so a stale credit can never be
    // consumed by a racing writer between a read and a write.
    expect(String(sent[0]!.input['ConditionExpression'])).toContain(':notBefore');
    expect(sent[0]!.input['ReturnValues']).toBe('UPDATED_NEW');
  });

  it('a positive new balance means PENDING, not matched', async () => {
    const { doc } = fakeDoc([() => ({ Attributes: { balance: 1 } })]);
    const repo = createMessagesRepo({ doc: doc as never, env });
    expect(await repo.bumpCrossCheckEvent(PAIR, NOT_BEFORE, NOW, EXPIRES)).toBe('pending');
  });

  it('STALE credits are discarded, not consumed - the event goes pending', async () => {
    const ccfe = new ConditionalCheckFailedException({ message: 'stale', $metadata: {} });
    const { doc, sent } = fakeDoc([
      () => {
        throw ccfe;
      },
      () => ({}),
    ]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.bumpCrossCheckEvent(PAIR, NOT_BEFORE, NOW, EXPIRES)).toBe('pending');
    expect(sent).toHaveLength(2);
    // The reset REMOVEs the oldest-credit stamp so the next filing re-stamps it.
    expect(String(sent[1]!.input['UpdateExpression'])).toContain('REMOVE');
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
            tsMsgId: 'evt#2026-08-11T12:05:00.000Z#IM1',
            message_sid: 'IM1',
            deadline_at: '2026-08-11T12:05:00.000Z',
            conversation_sid: 'CH1',
            author: '+15551110001',
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
            tsMsgId: 'evt#2026-08-11T12:05:00.000Z#IM1',
            message_sid: 'IM1',
            deadline_at: '2026-08-11T12:05:00.000Z',
            conversation_sid: 'CH1',
            author: '+15551110001',
          },
          {
            tsMsgId: 'evt#2026-08-11T12:06:00.000Z#IM2',
            message_sid: 'IM2',
            deadline_at: '2026-08-11T12:06:00.000Z',
            conversation_sid: 'CH1',
            author: '+15551110001',
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

  it('an empty pending range returns undefined without deleting anything', async () => {
    const { doc, sent } = fakeDoc([() => ({ Items: [] })]);
    const repo = createMessagesRepo({ doc: doc as never, env });

    expect(await repo.claimOldestCrossCheckPending(PAIR)).toBeUndefined();
    expect(sent).toHaveLength(1);
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
