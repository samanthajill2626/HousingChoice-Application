// app/test/sendAttemptsRepo.integration.test.ts
// The per-recipient SEND-ATTEMPT RECORD and its recipient index (spec D8a,
// D11) against DynamoDB Local. Every transition is a conditional write fenced
// on the attempt; every case below also runs each method's expression for
// real, so an unused alias or value (a ValidationException - see
// aiRunsRepo.integration.test.ts:302-316) fails the case that uses it.
//
// ONE owner and ONE index partition PER CASE: the table is created once per
// file and never reset between cases, so a shared owner would carry state
// from case to case (a done/sent record refuses every later claim).
//
// The first describe needs no DynamoDB: it drives the claim's cancellation
// attribution (build finding T5-4) through a stub document client.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  SEND_ATTEMPT_CLEANUP_MS,
  SEND_ATTEMPT_INDEX_PREFIX,
  SEND_ATTEMPT_PARTITION_PREFIX,
  type SendAttemptFacts,
  type SendAttemptOwner,
} from '../src/repos/sendAttemptsRepo.js';

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
  console.warn(
    `[sendAttemptsRepo.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const T0 = '2026-09-26T12:00:00.000Z';
const T1 = '2026-09-26T12:00:05.000Z';
const SENDER = '+15550009999';
const PHONE_KEY = 'phone#+16175550100';

/** `base` plus `ms`, as an ISO string. */
function plus(base: string, ms: number): string {
  return new Date(Date.parse(base) + ms).toISOString();
}

describe('sendAttemptsRepo keys (spec D8a, D12)', () => {
  it('ownerKey is the owner WITHOUT the recipient, per owner kind', () => {
    expect(ownerKey({ kind: 'broadcast', broadcastId: 'b-9', contactKey: 'c-1' })).toBe('broadcast#b-9');
    expect(
      ownerKey({ kind: 'relay_leg', relayConversationId: 'conv-r', sourceTsMsgId: '2026-09-26T11:00:00.000Z#SMx', memberKey: 'contact-9' }),
    ).toBe('relay#conv-r#2026-09-26T11:00:00.000Z#SMx');
    expect(
      ownerKey({ kind: 'relay_rung', relayConversationId: 'conv-r', retryTsMsgId: '2026-09-26T11:05:00.000Z#SMr', memberKey: 'contact-9' }),
    ).toBe('rung#conv-r#2026-09-26T11:05:00.000Z#SMr');
  });

  it('attemptKey is the RECORD identity: owner AND hashed recipient, never a phone', () => {
    const a: SendAttemptOwner = { kind: 'broadcast', broadcastId: 'b-9', contactKey: PHONE_KEY };
    const b: SendAttemptOwner = { kind: 'broadcast', broadcastId: 'b-9', contactKey: 'c-1' };
    expect(attemptKey(a)).toBe(`broadcast#b-9|${hashRecipientKey(PHONE_KEY)}`);
    expect(attemptKey(a)).not.toContain('+1617');
    expect(attemptKey(b)).toBe('broadcast#b-9|c-1');
    // Two contacts in one broadcast share the owner but are two records.
    expect(ownerKey(a)).toBe(ownerKey(b));
    expect(attemptKey(a)).not.toBe(attemptKey(b));
  });

  it('retry_send (retry-send-adoption R1): the owner key is the RETRIED ROW and the attempt; the chain root is a fact on the owner, never part of any key', () => {
    const owner: Extract<SendAttemptOwner, { kind: 'retry_send' }> = {
      kind: 'retry_send',
      conversationId: 'conv-1',
      retriedTsMsgId: 'T#SMa',
      attempt: 2,
      recipientKey: 'c-1',
      retryRoot: 'T0#SMroot',
    };
    expect(ownerKey(owner)).toBe('retry#conv-1#T#SMa#2');
    expect(attemptKey(owner)).toBe('retry#conv-1#T#SMa#2|c-1');
    // A phone-keyed attempt (no recorded recipient): the key carries only the hash.
    const phoneKeyed = { ...owner, recipientKey: 'phone#+15550100001' };
    expect(attemptKey(phoneKeyed)).toBe(`retry#conv-1#T#SMa#2|${hashRecipientKey('phone#+15550100001')}`);
    expect(attemptKey(phoneKeyed)).not.toContain('+1555');
    // Two owners differing ONLY in their root are ONE record: the root is not the identity.
    expect(ownerKey({ ...owner, retryRoot: 'T9#SMother' })).toBe(ownerKey(owner));
    expect(attemptKey({ ...owner, retryRoot: 'T9#SMother' })).toBe(attemptKey(owner));
    // Another attempt number, or another retried row (a manual Retry row's own chain), is another record.
    expect(attemptKey({ ...owner, attempt: 3 })).not.toBe(attemptKey(owner));
    expect(attemptKey({ ...owner, retriedTsMsgId: 'T#SMb' })).not.toBe(attemptKey(owner));
  });
});

describe('sendAttemptsRepo claim - cancellation attribution (build finding T5-4; stub document client)', () => {
  const owner: SendAttemptOwner = { kind: 'broadcast', broadcastId: 'b-stub', contactKey: 'c-1' };
  const facts: SendAttemptFacts = { recipientDigest: 'd'.repeat(32), sender: SENDER, bodyHash: 'h'.repeat(64), bodyShort: false, mediaCount: 0 };
  const storedRecord = {
    conversationId: 'sendattempt#broadcast#b-stub',
    tsMsgId: 'c-1',
    owner,
    attempt_state: 'attempting',
    attempt_no: 1,
    attempted_at: T0,
    redrive_count: 0,
    check_no: 0,
    recipient_digest: facts.recipientDigest,
    sender: SENDER,
    body_hash: facts.bodyHash,
    body_short: false,
    media_count: 0,
  };

  function stubRepo(onTransact: () => void, readBack: Record<string, unknown> | undefined) {
    const calls = { transacts: 0, gets: 0 };
    const doc = {
      async send(cmd: unknown) {
        if (cmd instanceof TransactWriteCommand) {
          calls.transacts += 1;
          onTransact();
          return {};
        }
        if (cmd instanceof GetCommand) {
          calls.gets += 1;
          return readBack === undefined ? {} : { Item: readBack };
        }
        throw new Error('stub document client: unexpected command');
      },
    };
    const repo = createSendAttemptsRepo({ doc: doc as unknown as DynamoDBDocumentClient, env: { TABLE_PREFIX: 'hc-stub-' } });
    return { repo, calls };
  }

  function cancelled(codes: string[] | undefined): TransactionCanceledException {
    return new TransactionCanceledException({
      message: 'Transaction cancelled',
      $metadata: {},
      ...(codes !== undefined && { CancellationReasons: codes.map((Code) => ({ Code })) }),
    });
  }

  it('a TransactionConflict on the record is rethrown, never read as a lost condition', async () => {
    const conflict = cancelled(['TransactionConflict', 'None']);
    const { repo, calls } = stubRepo(() => {
      throw conflict;
    }, storedRecord);
    await expect(repo.claim(owner, facts, T1)).rejects.toBe(conflict);
    expect(calls).toEqual({ transacts: 1, gets: 0 });
  });

  it('a cancellation that carries no reasons is rethrown', async () => {
    const bare = cancelled(undefined);
    const { repo } = stubRepo(() => {
      throw bare;
    }, storedRecord);
    await expect(repo.claim(owner, facts, T1)).rejects.toBe(bare);
  });

  it('a condition failure on the INDEX item (index 1) is not the record\'s answer: rethrown', async () => {
    const indexFailed = cancelled(['None', 'ConditionalCheckFailed']);
    const { repo } = stubRepo(() => {
      throw indexFailed;
    }, storedRecord);
    await expect(repo.claim(owner, facts, T1)).rejects.toBe(indexFailed);
  });

  it('the record\'s own condition failure is decided from a consistent re-read of the record', async () => {
    const { repo, calls } = stubRepo(() => {
      throw cancelled(['ConditionalCheckFailed', 'None']);
    }, storedRecord);
    expect(await repo.claim(owner, facts, T1)).toMatchObject({ outcome: 'refused', fresh: true, record: { state: 'attempting', attemptedAt: T0 } });
    expect(calls).toEqual({ transacts: 1, gets: 1 });
  });

  it('a lost record condition whose re-read finds NO record throws - claim never returns an undefined record', async () => {
    const { repo } = stubRepo(() => {
      throw cancelled(['ConditionalCheckFailed', 'None']);
    }, undefined);
    await expect(repo.claim(owner, facts, T1)).rejects.toThrow(/found no record/);
  });

  it('a written claim whose read-back finds NO record throws as well', async () => {
    const { repo } = stubRepo(() => undefined, undefined);
    await expect(repo.claim(owner, facts, T1)).rejects.toThrow(/found no record/);
  });

  // FW1-1 (ADV-1): the re-arm is the claim's transaction shape, so it takes
  // the claim's attribution - only index 0's condition is "taken over".
  const R = '2026-09-26T12:00:20.000Z';
  const ref = { attemptNo: 1, attemptedAt: T0 };

  function rearmStub(onTransact: () => void, reads: Array<Record<string, unknown> | undefined>) {
    const calls = { transacts: 0, gets: 0 };
    const doc = {
      async send(cmd: unknown) {
        if (cmd instanceof TransactWriteCommand) {
          calls.transacts += 1;
          onTransact();
          return {};
        }
        if (cmd instanceof GetCommand) {
          const item = reads[calls.gets];
          calls.gets += 1;
          return item === undefined ? {} : { Item: item };
        }
        throw new Error('stub document client: unexpected command');
      },
    };
    return { repo: createSendAttemptsRepo({ doc: doc as unknown as DynamoDBDocumentClient, env: { TABLE_PREFIX: 'hc-stub-' } }), calls };
  }

  it('rearm: a TransactionConflict or a condition failure on the INDEX item is rethrown, never read as a takeover (FW1-1)', async () => {
    for (const codes of [['TransactionConflict', 'None'], ['None', 'ConditionalCheckFailed']]) {
      const cancel = cancelled(codes);
      const { repo, calls } = rearmStub(() => {
        throw cancel;
      }, [storedRecord]);
      await expect(repo.rearm(owner, ref, R)).rejects.toBe(cancel);
      expect(calls).toEqual({ transacts: 1, gets: 1 });
    }
  });

  it('rearm: the record\'s own condition failure is a takeover (undefined) - unless the consistent re-read shows THIS re-arm, which committed on an earlier SDK attempt (FW1-1, ADV-3)', async () => {
    const lost = rearmStub(() => {
      throw cancelled(['ConditionalCheckFailed', 'None']);
    }, [storedRecord, { ...storedRecord, attempt_state: 'reconciling' }]);
    expect(await lost.repo.rearm(owner, ref, R)).toBeUndefined();
    expect(lost.calls).toEqual({ transacts: 1, gets: 2 });
    const replayed = rearmStub(() => {
      throw cancelled(['ConditionalCheckFailed', 'None']);
    }, [storedRecord, { ...storedRecord, attempted_at: R }]);
    expect(await replayed.repo.rearm(owner, ref, R)).toStrictEqual({ attemptNo: 1, attemptedAt: R });
    // Another attempt number at the re-armed instant is not this re-arm.
    const other = rearmStub(() => {
      throw cancelled(['ConditionalCheckFailed', 'None']);
    }, [storedRecord, { ...storedRecord, attempted_at: R, attempt_no: 2 }]);
    expect(await other.repo.rearm(owner, ref, R)).toBeUndefined();
    // Nor is this attempt at any other instant.
    const elsewhen = rearmStub(() => {
      throw cancelled(['ConditionalCheckFailed', 'None']);
    }, [storedRecord, { ...storedRecord, attempted_at: '2026-09-26T12:00:21.000Z' }]);
    expect(await elsewhen.repo.rearm(owner, ref, R)).toBeUndefined();
  });

  it('rearm of an absent record writes nothing and is refused (FW1-1)', async () => {
    const { repo, calls } = rearmStub(() => undefined, [undefined]);
    expect(await repo.rearm(owner, ref, R)).toBeUndefined();
    expect(calls).toEqual({ transacts: 0, gets: 1 });
  });
});

describe.skipIf(!reachable)('sendAttemptsRepo on DynamoDB Local (spec D8a/D11)', () => {
  const testEnv = { TABLE_PREFIX: `hc-sendattempts-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const table = tableName('messages', testEnv);
  const repo = createSendAttemptsRepo({ doc, env: testEnv });

  let seq = 0;
  let owner: SendAttemptOwner;
  let facts: SendAttemptFacts;

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  beforeEach(() => {
    seq += 1;
    owner = { kind: 'broadcast', broadcastId: `b-${seq}`, contactKey: PHONE_KEY };
    facts = { recipientDigest: `d${seq}`.padEnd(32, 'd'), sender: SENDER, bodyHash: 'h'.repeat(64), bodyShort: false, mediaCount: 0 };
  });

  async function rawRecord(o: SendAttemptOwner): Promise<Record<string, unknown> | undefined> {
    const recipientKey = o.kind === 'broadcast' ? o.contactKey : o.kind === 'retry_send' ? o.recipientKey : o.memberKey;
    const { Item } = await doc.send(
      new GetCommand({
        TableName: table,
        Key: { conversationId: `${SEND_ATTEMPT_PARTITION_PREFIX}${ownerKey(o)}`, tsMsgId: hashRecipientKey(recipientKey) },
        ConsistentRead: true,
      }),
    );
    return Item;
  }

  async function rawIndex(partition: string): Promise<Record<string, unknown>[]> {
    const { Items } = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'conversationId = :p',
        ExpressionAttributeValues: { ':p': partition },
        ConsistentRead: true,
      }),
    );
    return Items ?? [];
  }

  it('creates and claims an absent record; a second claim inside the TTL is refused fresh', async () => {
    expect(await repo.claim(owner, facts, T0)).toStrictEqual({
      outcome: 'claimed',
      record: { owner, state: 'attempting', attemptNo: 1, attemptedAt: T0, redriveCount: 0, checkNo: 0, ...facts },
    });
    expect(await repo.claim(owner, facts, T1)).toMatchObject({ outcome: 'refused', fresh: true, record: { state: 'attempting', attemptedAt: T0 } });
  });

  it('hashes a phone-bearing recipient key into the sort key; the state attribute is attempt_state', async () => {
    await repo.claim(owner, facts, T0);
    const raw = await doc.send(
      new GetCommand({ TableName: table, Key: { conversationId: `sendattempt#${ownerKey(owner)}`, tsMsgId: 'phone#+16175550100' } }),
    );
    expect(raw.Item).toBeUndefined();
    const hashed = await rawRecord(owner);
    expect(hashed).toMatchObject({
      conversationId: `sendattempt#broadcast#b-${seq}`,
      tsMsgId: hashRecipientKey(PHONE_KEY),
      attempt_state: 'attempting',
      attempt_no: 1,
      attempted_at: T0,
      redrive_count: 0,
      check_no: 0,
      recipient_digest: facts.recipientDigest,
      sender: SENDER,
      body_hash: facts.bodyHash,
      body_short: false,
      media_count: 0,
      owner,
      expires_at: Math.floor((Date.parse(T0) + SEND_ATTEMPT_CLEANUP_MS) / 1000),
    });
    expect(hashed).not.toHaveProperty('state');
    // The KEY never carries the phone (D8a). The owner map keeps the raw
    // recipient key on purpose: the reconcile addresses the slot with it.
    expect(String(hashed!['tsMsgId'])).not.toContain('6175550100');
  });

  it('a non-phone recipient key is stored as is (relay rung owner)', async () => {
    const rung: SendAttemptOwner = { kind: 'relay_rung', relayConversationId: `conv-${seq}`, retryTsMsgId: `${T0}#SMr${seq}`, memberKey: 'contact-9' };
    await repo.claim(rung, facts, T0);
    expect(await rawRecord(rung)).toMatchObject({ conversationId: `sendattempt#rung#conv-${seq}#${T0}#SMr${seq}`, tsMsgId: 'contact-9' });
    expect(await repo.get(rung)).toMatchObject({ owner: rung, state: 'attempting' });
  });

  it('a retry_send owner (retry-send-adoption R1) claims, re-arms and hands off like any owner; its hashed phone key is the sort key; it lists beside a broadcast attempt to the same number; the stored owner map carries all six fields', async () => {
    const retry: Extract<SendAttemptOwner, { kind: 'retry_send' }> = {
      kind: 'retry_send',
      conversationId: `conv-${seq}`,
      retriedTsMsgId: `${T0}#SMretried${seq}`,
      attempt: 2,
      recipientKey: PHONE_KEY,
      retryRoot: `2026-09-26T11:50:00.000Z#SMroot${seq}`,
    };
    expect(await repo.claim(retry, facts, T0)).toStrictEqual({
      outcome: 'claimed',
      record: { owner: retry, state: 'attempting', attemptNo: 1, attemptedAt: T0, redriveCount: 0, checkNo: 0, ...facts },
    });
    const R = plus(T0, 2_000);
    expect(await repo.rearm(retry, { attemptNo: 1, attemptedAt: T0 }, R)).toStrictEqual({ attemptNo: 1, attemptedAt: R });
    expect(await repo.handToReconcile(retry, { attemptNo: 1, attemptedAt: R }, 'SMretry-sid')).toBe(true);
    expect(await repo.get(retry)).toMatchObject({ owner: retry, state: 'reconciling', attemptNo: 1, attemptedAt: R, sid: 'SMretry-sid' });
    // This case's broadcast owner: the SAME number from the same sender, a little later.
    await repo.claim(owner, facts, T1);
    const rows = await repo.listByRecipient(SENDER, facts.recipientDigest, T0);
    expect(rows.map((r) => [r.owner.kind, r.attemptedAt])).toEqual([
      ['broadcast', T1],
      ['retry_send', R],
    ]);
    const raw = await rawRecord(retry);
    expect(raw).toMatchObject({
      conversationId: `sendattempt#retry#conv-${seq}#${T0}#SMretried${seq}#2`,
      tsMsgId: hashRecipientKey(PHONE_KEY),
      attempt_state: 'reconciling',
      attempted_at: R,
      sid: 'SMretry-sid',
    });
    // The owner map keeps the raw recipient key (the reconcile re-derives and compares it) - the KEYS never do.
    expect(raw!['owner']).toStrictEqual(retry);
    expect(Object.keys(raw!['owner'] as Record<string, unknown>).sort()).toEqual([
      'attempt',
      'conversationId',
      'kind',
      'recipientKey',
      'retriedTsMsgId',
      'retryRoot',
    ]);
    expect(String(raw!['conversationId'])).not.toContain('6175550100');
    expect(String(raw!['tsMsgId'])).not.toContain('6175550100');
  });

  it('the index item is written in the claim transaction, keyed by sender and digest, sorted by attempt start', async () => {
    const partition = `${SEND_ATTEMPT_INDEX_PREFIX}${SENDER}#${facts.recipientDigest}`;
    await repo.claim(owner, facts, T0);
    const items = await rawIndex(partition);
    expect(items).toHaveLength(1);
    expect(items[0]).toStrictEqual({
      conversationId: partition,
      tsMsgId: `${T0}#${ownerKey(owner)}#${hashRecipientKey(PHONE_KEY)}`,
      owner,
      attempted_at: T0,
      body_hash: facts.bodyHash,
      body_short: false,
      media_count: 0,
      expires_at: Math.floor((Date.parse(T0) + SEND_ATTEMPT_CLEANUP_MS) / 1000),
    });
    // A refused claim writes nothing: the transaction is all or nothing.
    expect(await repo.claim(owner, facts, T1)).toMatchObject({ outcome: 'refused' });
    expect(await rawIndex(partition)).toHaveLength(1);
  });

  it('finishAttempt is fenced on attemptNo AND attemptedAt, and only from attempting', async () => {
    await repo.claim(owner, facts, T0);
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T1 }, { outcome: 'sent', sid: 'SM1' })).toBe(false);
    expect(await repo.finishAttempt(owner, { attemptNo: 2, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' })).toBe(false);
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' })).toBe(true);
    expect(await repo.get(owner)).toMatchObject({ state: 'done', outcome: 'sent', sid: 'SM1' });
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'rejected', cause: '21211' })).toBe(false);
    expect(await repo.get(owner)).not.toHaveProperty('cause');
  });

  it('a record holding a SID refuses every later claim, whatever the slot says', async () => {
    await repo.claim(owner, facts, T0);
    await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' });
    expect(await repo.claim(owner, facts, T1)).toMatchObject({ outcome: 'refused', fresh: false, record: { state: 'done', outcome: 'sent', sid: 'SM1' } });
    expect(await repo.claim(owner, facts, plus(T0, 3_600_000))).toMatchObject({ outcome: 'refused', fresh: false });
  });

  it('done/retryable and redriven are claimable; attemptNo advances; redriveCount is untouched', async () => {
    await repo.claim(owner, facts, T0);
    await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'retryable', cause: '20429' });
    expect(await repo.get(owner)).toMatchObject({ state: 'done', outcome: 'retryable', cause: '20429' });
    const again = await repo.claim(owner, facts, T1);
    expect(again).toMatchObject({ outcome: 'claimed', record: { state: 'attempting', attemptNo: 2, attemptedAt: T1, redriveCount: 0, checkNo: 0 } });
    // The claim clears the previous attempt's outcome and cause.
    expect(again.record).not.toHaveProperty('outcome');
    expect(again.record).not.toHaveProperty('cause');
    await repo.handToReconcile(owner, { attemptNo: 2, attemptedAt: T1 });
    expect(await repo.markRedriven(owner, T1)).toBe(true);
    expect(await repo.markRedriven(owner, T1)).toBe(false);
    expect(await repo.get(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
    expect(await repo.claim(owner, facts, '2026-09-26T12:01:00.000Z')).toMatchObject({
      outcome: 'claimed',
      record: { state: 'attempting', attemptNo: 3, attemptedAt: '2026-09-26T12:01:00.000Z', redriveCount: 1, checkNo: 0 },
    });
  });

  it('one re-drive per recipient: a re-driven attempt that goes unknown again cannot be marked redriven', async () => {
    await repo.claim(owner, facts, T0);
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    expect(await repo.markRedriven(owner, T0)).toBe(true);
    expect(await repo.claim(owner, facts, T1)).toMatchObject({ outcome: 'claimed', record: { attemptNo: 2, redriveCount: 1 } });
    expect(await repo.handToReconcile(owner, { attemptNo: 2, attemptedAt: T1 })).toBe(true);
    expect(await repo.markRedriven(owner, T1)).toBe(false);
    expect(await repo.get(owner)).toMatchObject({ state: 'reconciling', attemptNo: 2, redriveCount: 1 });
    expect(await repo.closeFromReconcile(owner, T1, { outcome: 'unresolved', cause: 'no_match' })).toBe(true);
  });

  it('a claim\'s re-drive marker must match the attempt: markRedriven is fenced on attemptedAt and on reconciling', async () => {
    await repo.claim(owner, facts, T0);
    expect(await repo.markRedriven(owner, T0)).toBe(false);   // still attempting
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    expect(await repo.markRedriven(owner, T1)).toBe(false);   // another attempt
    expect(await repo.markRedriven(owner, T0)).toBe(true);
  });

  it('a stale attempting record (older than the TTL) is a takeover, not a send; the late outcome write is refused', async () => {
    await repo.claim(owner, facts, T0);
    const late = await repo.claim(owner, facts, '2026-09-26T12:00:31.000Z');
    expect(late).toMatchObject({ outcome: 'takeover', record: { state: 'attempting', attemptedAt: T0 } });
    if (late.outcome !== 'takeover') throw new Error('expected takeover');
    expect(await repo.takeOver(owner, late.record)).toBe(true);
    expect(await repo.get(owner)).toMatchObject({ state: 'reconciling', attemptedAt: T0, checkNo: 0 });
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' })).toBe(false);
    expect(await repo.takeOver(owner, late.record)).toBe(false);   // idempotent: already reconciling
  });

  it('the TTL boundary: exactly SEND_CLAIM_TTL_MS old is still fresh; one millisecond more is a takeover; deciding writes nothing', async () => {
    await repo.claim(owner, facts, T0);
    expect(await repo.claim(owner, facts, plus(T0, SEND_CLAIM_TTL_MS))).toMatchObject({ outcome: 'refused', fresh: true, record: { attemptedAt: T0 } });
    expect(await repo.claim(owner, facts, plus(T0, SEND_CLAIM_TTL_MS + 1))).toMatchObject({ outcome: 'takeover', record: { attemptNo: 1, attemptedAt: T0 } });
    expect(await repo.get(owner)).toMatchObject({ state: 'attempting', attemptNo: 1, attemptedAt: T0 });
  });

  it('takeOver is fenced on the record it was handed', async () => {
    await repo.claim(owner, facts, T0);
    const current = await repo.get(owner);
    if (current === undefined) throw new Error('expected a record');
    expect(await repo.takeOver(owner, { ...current, attemptNo: 2 })).toBe(false);
    expect(await repo.takeOver(owner, { ...current, attemptedAt: T1 })).toBe(false);
    expect(await repo.takeOver(owner, current)).toBe(true);
  });

  it('handToReconcile is fenced on the attempt and keeps a known SID; a reconciling record refuses a claim, not fresh', async () => {
    await repo.claim(owner, facts, T0);
    expect(await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T1 })).toBe(false);
    expect(await repo.handToReconcile(owner, { attemptNo: 2, attemptedAt: T0 })).toBe(false);
    expect(await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 }, 'SM7')).toBe(true);
    expect(await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 })).toBe(false);   // no longer attempting
    expect(await repo.get(owner)).toMatchObject({ state: 'reconciling', sid: 'SM7', checkNo: 0, attemptedAt: T0 });
    expect(await repo.claim(owner, facts, plus(T0, 60_000))).toMatchObject({ outcome: 'refused', fresh: false, record: { state: 'reconciling' } });
  });

  it('recordCheck tolerates its own duplicate and refuses a skip, a step back or another attempt', async () => {
    await repo.claim(owner, facts, T0);
    expect(await repo.recordCheck(owner, T0, 1)).toBe(false);   // still attempting: not the job's yet
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    expect(await repo.recordCheck(owner, T0, 0)).toBe(true);
    expect(await repo.recordCheck(owner, T0, 1)).toBe(true);
    expect(await repo.recordCheck(owner, T0, 1)).toBe(true);
    expect(await repo.recordCheck(owner, T0, 3)).toBe(false);
    expect(await repo.recordCheck(owner, T1, 2)).toBe(false);
    expect(await repo.recordCheck(owner, T0, 2)).toBe(true);
    expect(await repo.recordCheck(owner, T0, 1)).toBe(false);
    expect(await repo.get(owner)).toMatchObject({ state: 'reconciling', checkNo: 2 });
  });

  it('closeFromReconcile is forward-only and idempotent', async () => {
    await repo.claim(owner, facts, T0);
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    expect(await repo.closeFromReconcile(owner, T1, { outcome: 'unresolved', cause: 'provider_unreachable' })).toBe(false);
    expect(await repo.closeFromReconcile(owner, T0, { outcome: 'unresolved', cause: 'provider_unreachable' })).toBe(true);
    expect(await repo.closeFromReconcile(owner, T0, { outcome: 'adopted', sid: 'SM9' })).toBe(false);
    expect(await repo.get(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
    expect(await repo.get(owner)).not.toHaveProperty('sid');
  });

  it('closeFromReconcile adopts with the SID', async () => {
    await repo.claim(owner, facts, T0);
    expect(await repo.closeFromReconcile(owner, T0, { outcome: 'adopted', sid: 'SM9' })).toBe(false);   // still attempting
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    expect(await repo.closeFromReconcile(owner, T0, { outcome: 'adopted', sid: 'SM9' })).toBe(true);
    const record = await repo.get(owner);
    expect(record).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SM9', attemptedAt: T0 });
    expect(record).not.toHaveProperty('cause');
  });

  it('closeRedriven accepts refused, redrive_refused, enqueue_failed and unresolved, once', async () => {
    for (const outcome of ['refused', 'redrive_refused', 'enqueue_failed', 'unresolved'] as const) {
      const o: SendAttemptOwner = { kind: 'broadcast', broadcastId: `b-${seq}-${outcome}`, contactKey: 'c-1' };
      await repo.claim(o, facts, T0);
      await repo.handToReconcile(o, { attemptNo: 1, attemptedAt: T0 });
      expect(await repo.closeRedriven(o, { outcome, cause: 'x' })).toBe(false);   // reconciling, not redriven
      await repo.markRedriven(o, T0);
      expect(await repo.closeRedriven(o, { outcome, cause: 'x' })).toBe(true);
      expect(await repo.closeRedriven(o, { outcome, cause: 'x' })).toBe(false);
      expect(await repo.get(o)).toMatchObject({ state: 'done', outcome, cause: 'x' });
    }
  });

  it('closeRedriven without a cause', async () => {
    await repo.claim(owner, facts, T0);
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    await repo.markRedriven(owner, T0);
    expect(await repo.closeRedriven(owner, { outcome: 'refused' })).toBe(true);
    const record = await repo.get(owner);
    expect(record).toMatchObject({ state: 'done', outcome: 'refused', redriveCount: 1 });
    expect(record).not.toHaveProperty('cause');
  });

  it('every transition on an absent record is refused and creates nothing', async () => {
    const ref = { attemptNo: 1, attemptedAt: T0 };
    const ghost = { owner, state: 'attempting' as const, attemptNo: 1, attemptedAt: T0, redriveCount: 0, checkNo: 0, ...facts };
    expect(await repo.finishAttempt(owner, ref, { outcome: 'sent', sid: 'SM1' })).toBe(false);
    expect(await repo.handToReconcile(owner, ref, 'SM1')).toBe(false);
    expect(await repo.takeOver(owner, ghost)).toBe(false);
    expect(await repo.recordCheck(owner, T0, 0)).toBe(false);
    expect(await repo.markRedriven(owner, T0)).toBe(false);
    expect(await repo.closeFromReconcile(owner, T0, { outcome: 'unresolved' })).toBe(false);
    expect(await repo.closeRedriven(owner, { outcome: 'refused' })).toBe(false);
    expect(await repo.get(owner)).toBeUndefined();
    expect(await rawRecord(owner)).toBeUndefined();
    expect(await repo.listByRecipient(SENDER, facts.recipientDigest, T0)).toEqual([]);
  });

  it('listByRecipient reads the index partition consistently, newest first, since a bound', async () => {
    const other: SendAttemptOwner = { kind: 'relay_leg', relayConversationId: `conv-r${seq}`, sourceTsMsgId: '2026-09-26T11:00:00.000Z#SMx', memberKey: 'contact-9' };
    await repo.claim(owner, facts, T0);
    await repo.claim(other, facts, T1);
    const rows = await repo.listByRecipient(SENDER, facts.recipientDigest, '2026-09-26T11:59:00.000Z');
    expect(rows.map((r) => r.attemptedAt)).toEqual([T1, T0]);
    expect(rows.map((r) => r.owner.kind)).toEqual(['relay_leg', 'broadcast']);
    expect(await repo.listByRecipient(SENDER, facts.recipientDigest, '2026-09-26T12:00:01.000Z')).toHaveLength(1);
    expect(await repo.listByRecipient(SENDER, facts.recipientDigest, T0)).toHaveLength(2);   // the bound is inclusive
    expect(await repo.listByRecipient('+15550001111', facts.recipientDigest, T0)).toHaveLength(0);
  });

  it('listByRecipient returns a re-claimed record ONCE, at its newest attempt, with its LIVE state (build finding T5-5)', async () => {
    await repo.claim(owner, facts, T0);
    await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'retryable', cause: '20429' });
    await repo.claim(owner, facts, T1);
    expect(await rawIndex(`${SEND_ATTEMPT_INDEX_PREFIX}${SENDER}#${facts.recipientDigest}`)).toHaveLength(2);
    const rows = await repo.listByRecipient(SENDER, facts.recipientDigest, T0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'attempting', attemptNo: 2, attemptedAt: T1 });
    await repo.finishAttempt(owner, { attemptNo: 2, attemptedAt: T1 }, { outcome: 'sent', sid: 'SM2' });
    expect(await repo.listByRecipient(SENDER, facts.recipientDigest, T0)).toStrictEqual([await repo.get(owner)]);
  });

  it('a sender-less record indexes under the "-" partition and reads back with no sender', async () => {
    const { sender: _s, ...noSender } = facts;
    await repo.claim(owner, noSender, T0);
    expect(await repo.listByRecipient('-', facts.recipientDigest, T0)).toHaveLength(1);
    expect(await rawRecord(owner)).toMatchObject({ sender: null });
    const record = await repo.get(owner);
    expect(record).toStrictEqual({ owner, state: 'attempting', attemptNo: 1, attemptedAt: T0, redriveCount: 0, checkNo: 0, ...noSender });
  });

  it('a re-claim writes THIS attempt\'s facts (sender, body, media) and indexes under its own sender', async () => {
    await repo.claim(owner, facts, T0);
    await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'retryable' });
    const next: SendAttemptFacts = { recipientDigest: facts.recipientDigest, bodyHash: 'e'.repeat(64), bodyShort: true, mediaCount: 2 };
    const again = await repo.claim(owner, next, T1);
    expect(again).toStrictEqual({
      outcome: 'claimed',
      record: { owner, state: 'attempting', attemptNo: 2, attemptedAt: T1, redriveCount: 0, checkNo: 0, ...next },
    });
    expect(await repo.listByRecipient('-', facts.recipientDigest, T0)).toStrictEqual([again.record]);
    // The first attempt's index item still points at the (live) record.
    expect(await repo.listByRecipient(SENDER, facts.recipientDigest, T0)).toStrictEqual([again.record]);
  });

  it('listByRecipient pages past the Query limit, newest first, one row per record', async () => {
    // This case's OWN facts and ids, bound once: on a loaded DynamoDB Local an
    // overrun keeps claiming after vitest has moved on, and through the shared
    // `facts` it would write into the NEXT case's index partition.
    const own = facts;
    const id = seq;
    const count = 101;
    const owners: SendAttemptOwner[] = Array.from({ length: count }, (_, i) => ({ kind: 'broadcast', broadcastId: `b-${id}-p${i}`, contactKey: `c-${i}` }));
    for (let i = 0; i < count; i += 10) {
      await Promise.all(owners.slice(i, i + 10).map((o, j) => repo.claim(o, own, plus(T0, (i + j) * 1000))));
    }
    const rows = await repo.listByRecipient(SENDER, own.recipientDigest, T0);
    expect(rows).toHaveLength(count);
    expect(rows[0]!.attemptedAt).toBe(plus(T0, (count - 1) * 1000));
    expect(rows[count - 1]!.attemptedAt).toBe(T0);
    expect(new Set(rows.map((r) => attemptKey(r.owner))).size).toBe(count);
  }, 120_000);

  // ---- FW1-1 (ADV-1): the re-arm immediately before the provider call ----

  it('rearm re-arms THIS attempt in ONE transaction: attempted_at and expires_at move to now and a NEW index item is written for now; the returned ref fences every later write (FW1-1)', async () => {
    await repo.claim(owner, facts, T0);
    const R = plus(T0, 20_000);
    expect(await repo.rearm(owner, { attemptNo: 1, attemptedAt: T0 }, R)).toStrictEqual({ attemptNo: 1, attemptedAt: R });
    expect(await repo.get(owner)).toStrictEqual({ owner, state: 'attempting', attemptNo: 1, attemptedAt: R, redriveCount: 0, checkNo: 0, ...facts });
    expect(await rawRecord(owner)).toMatchObject({ attempted_at: R, expires_at: Math.floor((Date.parse(R) + SEND_ATTEMPT_CLEANUP_MS) / 1000) });
    const partition = `${SEND_ATTEMPT_INDEX_PREFIX}${SENDER}#${facts.recipientDigest}`;
    const suffix = `#${ownerKey(owner)}#${hashRecipientKey(PHONE_KEY)}`;
    const items = await rawIndex(partition);
    expect(items.map((i) => i['tsMsgId'])).toEqual([`${T0}${suffix}`, `${R}${suffix}`]);
    // The claim's index-item shape, for the re-armed instant.
    expect(items[1]).toStrictEqual({
      conversationId: partition,
      tsMsgId: `${R}${suffix}`,
      owner,
      attempted_at: R,
      body_hash: facts.bodyHash,
      body_short: false,
      media_count: 0,
      expires_at: Math.floor((Date.parse(R) + SEND_ATTEMPT_CLEANUP_MS) / 1000),
    });
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' })).toBe(false);
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: R }, { outcome: 'sent', sid: 'SM1' })).toBe(true);
  });

  it('rearm refuses a ref that is not the live attempt - another attemptedAt, another attemptNo, a record no longer attempting - and writes nothing (FW1-1)', async () => {
    const partition = `${SEND_ATTEMPT_INDEX_PREFIX}${SENDER}#${facts.recipientDigest}`;
    await repo.claim(owner, facts, T0);
    expect(await repo.rearm(owner, { attemptNo: 1, attemptedAt: T1 }, plus(T0, 9_000))).toBeUndefined();
    expect(await repo.rearm(owner, { attemptNo: 2, attemptedAt: T0 }, plus(T0, 9_000))).toBeUndefined();
    expect(await rawIndex(partition)).toHaveLength(1);
    expect(await repo.get(owner)).toMatchObject({ state: 'attempting', attemptNo: 1, attemptedAt: T0 });
    // A re-arm moves the attempt; the ref it replaced is stale from then on.
    expect(await repo.rearm(owner, { attemptNo: 1, attemptedAt: T0 }, plus(T0, 10_000))).toStrictEqual({ attemptNo: 1, attemptedAt: plus(T0, 10_000) });
    expect(await repo.rearm(owner, { attemptNo: 1, attemptedAt: T0 }, plus(T0, 11_000))).toBeUndefined();
    expect(await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: plus(T0, 10_000) })).toBe(true);
    expect(await repo.rearm(owner, { attemptNo: 1, attemptedAt: plus(T0, 10_000) }, plus(T0, 12_000))).toBeUndefined();
    expect(await rawIndex(partition)).toHaveLength(2);
    expect(await repo.get(owner)).toMatchObject({ state: 'reconciling', attemptedAt: plus(T0, 10_000) });
    // A done record is no attempt to re-arm.
    const done: SendAttemptOwner = { kind: 'broadcast', broadcastId: `b-${seq}-done`, contactKey: 'c-1' };
    await repo.claim(done, facts, T0);
    await repo.finishAttempt(done, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' });
    expect(await repo.rearm(done, { attemptNo: 1, attemptedAt: T0 }, T1)).toBeUndefined();
    expect(await repo.get(done)).toMatchObject({ state: 'done', attemptedAt: T0 });
    expect(await repo.rearm({ kind: 'broadcast', broadcastId: `b-${seq}-absent`, contactKey: 'c-1' }, { attemptNo: 1, attemptedAt: T0 }, T1)).toBeUndefined();
  });

  it('rearm after a takeover is refused: the stalled pass learns it lost the attempt and must not send (FW1-1, the zz-adv-6 interleaving at the repo)', async () => {
    await repo.claim(owner, facts, T0);
    const late = await repo.claim(owner, facts, plus(T0, SEND_CLAIM_TTL_MS + 1));
    if (late.outcome !== 'takeover') throw new Error('expected a takeover');
    expect(await repo.takeOver(owner, late.record)).toBe(true);
    expect(await repo.rearm(owner, { attemptNo: 1, attemptedAt: T0 }, plus(T0, 240_000))).toBeUndefined();
    expect(await repo.get(owner)).toMatchObject({ state: 'reconciling', attemptNo: 1, attemptedAt: T0 });
    expect(await rawIndex(`${SEND_ATTEMPT_INDEX_PREFIX}${SENDER}#${facts.recipientDigest}`)).toHaveLength(1);
  });

  it('the claim TTL is measured from the attempt\'s LAST re-arm, and listByRecipient finds the attempt by its re-armed time (FW1-1)', async () => {
    await repo.claim(owner, facts, T0);
    const R = plus(T0, 20_000);
    await repo.rearm(owner, { attemptNo: 1, attemptedAt: T0 }, R);
    expect(await repo.claim(owner, facts, plus(T0, SEND_CLAIM_TTL_MS + 1))).toMatchObject({ outcome: 'refused', fresh: true, record: { attemptedAt: R } });
    expect(await repo.claim(owner, facts, plus(R, SEND_CLAIM_TTL_MS))).toMatchObject({ outcome: 'refused', fresh: true });
    expect(await repo.claim(owner, facts, plus(R, SEND_CLAIM_TTL_MS + 1))).toMatchObject({ outcome: 'takeover', record: { attemptNo: 1, attemptedAt: R } });
    // A bound between the claim and the re-arm sees the attempt through its re-armed item only; one row per record.
    expect(await repo.listByRecipient(SENDER, facts.recipientDigest, plus(T0, 10_000))).toStrictEqual([await repo.get(owner)]);
    expect(await repo.listByRecipient(SENDER, facts.recipientDigest, T0)).toHaveLength(1);
    expect(await repo.listByRecipient(SENDER, facts.recipientDigest, plus(R, 1))).toHaveLength(0);
  });

  // ---- FW1-5 (ADV-3): every fenced transition is safe against the SDK's own replay ----

  /**
   * zz-adv-5's method: a document client whose next UpdateCommand COMMITS and
   * then fails with the condition error the SDK's replay of it would meet (the
   * first response was lost; the retry finds its own write).
   */
  function replaying(): { doc: DynamoDBDocumentClient; replayNextUpdate: () => void; replays: () => number } {
    let armed = 0;
    let replays = 0;
    const send = doc.send.bind(doc) as unknown as (cmd: unknown) => Promise<unknown>;
    const client = {
      async send(cmd: unknown) {
        const out = await send(cmd);
        if (armed > 0 && cmd instanceof UpdateCommand) {
          armed -= 1;
          replays += 1;
          throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
        }
        return out;
      },
    };
    return { doc: client as unknown as DynamoDBDocumentClient, replayNextUpdate: () => void (armed += 1), replays: () => replays };
  }

  it('a transition whose write committed on an earlier SDK attempt reports success when the replay fails its own condition - every fenced transition (FW1-5, ADV-3)', async () => {
    const r = replaying();
    const retried = createSendAttemptsRepo({ doc: r.doc, env: testEnv });
    const o = (name: string): SendAttemptOwner => ({ kind: 'broadcast', broadcastId: `b-${seq}-${name}`, contactKey: 'c-1' });
    const ref = { attemptNo: 1, attemptedAt: T0 };

    await repo.claim(o('finish'), facts, T0);
    r.replayNextUpdate();
    expect(await retried.finishAttempt(o('finish'), ref, { outcome: 'sent', sid: 'SM1' })).toBe(true);
    expect(await repo.get(o('finish'))).toMatchObject({ state: 'done', outcome: 'sent', sid: 'SM1' });

    await repo.claim(o('hand'), facts, T0);
    r.replayNextUpdate();
    expect(await retried.handToReconcile(o('hand'), ref)).toBe(true);
    expect(await repo.get(o('hand'))).toMatchObject({ state: 'reconciling' });

    await repo.claim(o('take'), facts, T0);
    const stale = await repo.claim(o('take'), facts, plus(T0, SEND_CLAIM_TTL_MS + 1));
    r.replayNextUpdate();
    expect(await retried.takeOver(o('take'), stale.record)).toBe(true);
    expect(await repo.get(o('take'))).toMatchObject({ state: 'reconciling' });

    await repo.claim(o('check'), facts, T0);
    await repo.handToReconcile(o('check'), ref);
    r.replayNextUpdate();
    expect(await retried.recordCheck(o('check'), T0, 1)).toBe(true);
    expect(await repo.get(o('check'))).toMatchObject({ checkNo: 1 });

    await repo.claim(o('redrive'), facts, T0);
    await repo.handToReconcile(o('redrive'), ref);
    r.replayNextUpdate();
    expect(await retried.markRedriven(o('redrive'), T0)).toBe(true);
    expect(await repo.get(o('redrive'))).toMatchObject({ state: 'redriven', redriveCount: 1 });

    await repo.claim(o('close'), facts, T0);
    await repo.handToReconcile(o('close'), ref);
    r.replayNextUpdate();
    expect(await retried.closeFromReconcile(o('close'), T0, { outcome: 'unresolved', cause: 'provider_unreachable' })).toBe(true);
    expect(await repo.get(o('close'))).toMatchObject({ state: 'done', outcome: 'unresolved' });

    await repo.claim(o('closeRedriven'), facts, T0);
    await repo.handToReconcile(o('closeRedriven'), ref);
    await repo.markRedriven(o('closeRedriven'), T0);
    r.replayNextUpdate();
    expect(await retried.closeRedriven(o('closeRedriven'), { outcome: 'refused', cause: 'x' })).toBe(true);
    expect(await repo.get(o('closeRedriven'))).toMatchObject({ state: 'done', outcome: 'refused' });

    expect(r.replays()).toBe(7);
    // A genuinely lost fence is still lost: the stored token is the other writer's, never this call's.
    expect(await retried.finishAttempt(o('finish'), ref, { outcome: 'sent', sid: 'SM1' })).toBe(false);
    expect(await retried.handToReconcile(o('hand'), ref)).toBe(false);
    expect(await retried.closeRedriven(o('closeRedriven'), { outcome: 'refused' })).toBe(false);
  });

  it('every fenced transition writes a FRESH op token (last_op); a refused one writes nothing (FW1-5)', async () => {
    await repo.claim(owner, facts, T0);
    expect(await rawRecord(owner)).not.toHaveProperty('last_op');
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    const first = (await rawRecord(owner))!['last_op'];
    expect(typeof first).toBe('string');
    await repo.recordCheck(owner, T0, 1);
    const second = (await rawRecord(owner))!['last_op'];
    expect(typeof second).toBe('string');
    expect(second).not.toBe(first);
    expect(await repo.markRedriven(owner, T1)).toBe(false);
    expect((await rawRecord(owner))!['last_op']).toBe(second);
  });
});
