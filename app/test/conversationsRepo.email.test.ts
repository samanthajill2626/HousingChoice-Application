// Email-channel A4 integration tests against DynamoDB Local - the conversations
// repo's EMAIL CLAIM ARBITER + reply-token primitives (the exact analog of the
// phone claim in createOrGetByParticipantPhone). The email#<addr> claim item is
// the SINGLE arbiter of which conversation owns an address; BOTH writers
// (attachEmailToConversation + createOrGetByParticipantEmail) go through it and
// RESOLVE to the already-claimed conversation on conflict (never error, never
// orphan). Covered: claim win/resolve, attach-elsewhere, the RACE (a concurrent
// attach + create-or-get for ONE address converge on ONE conversationId),
// create-or-get self-heal (claim exists, row missing -> row recreated under the
// claimed id), reply-token mint idempotence + findByReplyToken, and
// findByParticipantEmail (array, mirrors findByParticipantPhone).
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

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
    `[conversationsRepo.email.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

// Unique addresses per test (the table is shared; reusing an address collides on
// its email#<addr> claim item).
let emailSeq = 200;
const nextEmail = (): string => `party${++emailSeq}@example.com`;

describe.skipIf(!reachable)('conversationsRepo email claim arbiter against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const conversations = createConversationsRepo({ doc, env: testEnv, logger });
  const table = tableName('conversations', testEnv);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('conversations'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('createOrGetByParticipantEmail creates an open email thread (participant_email, no participant_phone) and is idempotent', async () => {
    const email = nextEmail();
    const created = await conversations.createOrGetByParticipantEmail(email, 'tenant_1to1');
    expect(created.participant_email).toBe(email);
    expect(created.status).toBe('open');
    expect(created.type).toBe('tenant_1to1');
    expect(created.ai_mode).toBe('auto');
    // Brief: the row carries participant_email, NOT participant_phone.
    expect(created.participant_phone).toBeUndefined();

    // Second call resolves the SAME conversation (GSI fast path / claim resolve).
    const again = await conversations.createOrGetByParticipantEmail(email, 'tenant_1to1');
    expect(again.conversationId).toBe(created.conversationId);
  });

  it('createOrGetByParticipantEmail sets participants + display name from opts (ADJ-9 channel-agnostic readers)', async () => {
    const email = nextEmail();
    const created = await conversations.createOrGetByParticipantEmail(email, 'landlord_1to1', {
      contactId: 'contact-abc',
      displayName: 'Marcus Bell',
    });
    expect(created.participant_display_name).toBe('Marcus Bell');
    expect(created.participants?.[0]?.contactId).toBe('contact-abc');
  });

  it('claimEmailForConversation: first claim wins; a second claim for the same address RESOLVES to the first', async () => {
    const email = nextEmail();
    const first = await conversations.claimEmailForConversation(email, 'conv-A');
    expect(first.conversationId).toBe('conv-A');
    // A different conversation trying to claim the SAME address resolves to A.
    const second = await conversations.claimEmailForConversation(email, 'conv-B');
    expect(second.conversationId).toBe('conv-A');
  });

  it('attachEmailToConversation sets participant_email on the winning conversation; a second attach returns the elsewhere-claimed id', async () => {
    const email = nextEmail();
    const convA = await conversations.createOrGetByParticipantPhone('+15550000201', 'tenant_1to1');
    const convB = await conversations.createOrGetByParticipantPhone('+15550000202', 'tenant_1to1');

    const attached = await conversations.attachEmailToConversation(convA.conversationId, email);
    expect(attached.conversationId).toBe(convA.conversationId);
    const freshA = await conversations.getById(convA.conversationId);
    expect(freshA?.participant_email).toBe(email);

    // Attaching the SAME address to convB returns convA (the claim owner) and
    // does NOT stamp participant_email onto convB.
    const attachedB = await conversations.attachEmailToConversation(convB.conversationId, email);
    expect(attachedB.conversationId).toBe(convA.conversationId);
    const freshB = await conversations.getById(convB.conversationId);
    expect(freshB?.participant_email).toBeUndefined();
  });

  it('RACE: a concurrent attachEmailToConversation + createOrGetByParticipantEmail for the SAME address converge on ONE conversation', async () => {
    const email = nextEmail();
    const preexisting = await conversations.createOrGetByParticipantPhone('+15550000210', 'tenant_1to1');

    const [attachRes, createRes] = await Promise.all([
      conversations.attachEmailToConversation(preexisting.conversationId, email),
      conversations.createOrGetByParticipantEmail(email, 'tenant_1to1'),
    ]);
    // Whichever won the email# claim, BOTH resolve to the same conversationId.
    expect(attachRes.conversationId).toBe(createRes.conversationId);

    // Exactly ONE conversation ends up owning the address (carries participant_email).
    const owners = await conversations.findByParticipantEmail(email);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.conversationId).toBe(attachRes.conversationId);
  });

  it('createOrGetByParticipantEmail self-heals a claim whose conversation row is missing (crash between claim and create)', async () => {
    const email = nextEmail();
    const orphanId = `conv-${randomUUID()}`;
    // Simulate a crash: the email# claim exists but its conversation row never got
    // written (exactly the phone-claim self-heal path).
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: { conversationId: `email#${email}`, ref_conversationId: orphanId },
        ConditionExpression: 'attribute_not_exists(conversationId)',
      }),
    );
    const healed = await conversations.createOrGetByParticipantEmail(email, 'unknown_1to1');
    expect(healed.conversationId).toBe(orphanId);
    expect(healed.participant_email).toBe(email);
  });

  it('getReplyToken mints once (idempotent, no new token on re-call) and findByReplyToken resolves the conversation', async () => {
    const conv = await conversations.createOrGetByParticipantEmail(nextEmail(), 'tenant_1to1');
    const token = await conversations.getReplyToken(conv.conversationId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    // Idempotent: the same token comes back (persisted on the row).
    const again = await conversations.getReplyToken(conv.conversationId);
    expect(again).toBe(token);

    const resolved = await conversations.findByReplyToken(token);
    expect(resolved?.conversationId).toBe(conv.conversationId);
    // A bogus token resolves to nothing.
    expect(await conversations.findByReplyToken('nope-not-a-token')).toBeUndefined();
  });

  it('findByParticipantEmail returns [] for an unknown address', async () => {
    expect(await conversations.findByParticipantEmail(nextEmail())).toEqual([]);
  });
});
