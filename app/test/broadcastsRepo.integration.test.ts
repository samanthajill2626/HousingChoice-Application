// Integration tests against DynamoDB Local — the REAL UpdateExpression
// semantics for the nested-map repo writes that the in-memory fakes cannot
// validate. DynamoDB Local statically rejects an UpdateExpression that SETs
// BOTH a map and a child of that map ("Two document paths overlap"), and
// rejects unused ExpressionAttributeValues — neither of which the fakes model.
// These suites would have caught the broadcasts.setRecipient /
// messages.setRecipientDelivery overlap bug (enqueue_failed on a real send).
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createBroadcastsRepo, type BroadcastRecipient } from '../src/repos/broadcastsRepo.js';
import {
  buildTsMsgId,
  createMessagesRepo,
  type RelayRecipientDelivery,
} from '../src/repos/messagesRepo.js';
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
    `[broadcastsRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('broadcast + relay repo UpdateExpressions against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const broadcasts = createBroadcastsRepo(repoDeps);
  const messages = createMessagesRepo(repoDeps);

  const bases = ['broadcasts', 'messages'] as const;

  beforeAll(async () => {
    for (const base of bases) {
      await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
    }
  }, 120_000);

  afterAll(async () => {
    for (const base of bases) {
      await deleteTableIfExists(client, tableName(base, testEnv));
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  // --- broadcasts.setRecipient (the overlap-bug site the operator hit) ------

  it('broadcast lifecycle: create → markSending → setRecipient (blind + forward-only) → bumpStats — no ValidationException', async () => {
    const created = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'Hi [TenantName]',
    });

    // markSending seeds the FULL recipients map (the parent must exist before
    // any child-only setRecipient write).
    const recipients: Record<string, BroadcastRecipient> = {
      'c-1': { status: 'queued' },
      'phone#+15550100001': { status: 'queued' },
    };
    const sending = await broadcasts.markSending(created.broadcastId, recipients);
    expect(sending.status).toBe('sending');
    expect(sending.stats.audience).toBe(2);

    // Blind SET of a recipient slot (the send job's first per-recipient write).
    // On the OLD `SET recipients = if_not_exists(...), recipients.#ck = :rec`
    // this raised a ValidationException (overlapping document paths) on EVERY
    // call — the bug. The child-only SET must succeed.
    const setOk = await broadcasts.setRecipient(created.broadcastId, 'c-1', {
      status: 'sent',
      conversationId: 'conv-1',
      tsMsgId: 'ts#sm1',
    });
    expect(setOk).toBe(true);

    // A phone#-keyed slot exercises the aliased dotted-path name (`#` in key).
    const setPhoneOk = await broadcasts.setRecipient(created.broadcastId, 'phone#+15550100001', {
      status: 'sent',
    });
    expect(setPhoneOk).toBe(true);

    // Forward-only transition: an ALLOWED prior (sent → delivered) applies.
    const fwdOk = await broadcasts.setRecipient(
      created.broadcastId,
      'c-1',
      { status: 'delivered', conversationId: 'conv-1', tsMsgId: 'ts#sm1' },
      ['queued', 'sent'],
    );
    expect(fwdOk).toBe(true);

    // Forward-only transition: a DISALLOWED prior (now 'delivered', not in
    // ['queued','sent']) returns false (ConditionalCheckFailed → no-op), never
    // throws.
    const fwdBlocked = await broadcasts.setRecipient(
      created.broadcastId,
      'c-1',
      { status: 'delivered' },
      ['queued', 'sent'],
    );
    expect(fwdBlocked).toBe(false);

    await broadcasts.bumpStats(created.broadcastId, { sent: 2, delivered: 1, queued: -2 });

    const after = await broadcasts.getById(created.broadcastId);
    expect(after?.recipients['c-1']?.status).toBe('delivered');
    expect(after?.recipients['phone#+15550100001']?.status).toBe('sent');
    expect(after?.stats.sent).toBe(2);
    expect(after?.stats.delivered).toBe(1);
  });

  // --- messages relay delivery_recipients (latent overlap-bug site) ---------

  it('relay inbound source: seed delivery_recipients {} → setRecipientDelivery → updateRecipientDeliveryStatus forward-only — no ValidationException', async () => {
    const conversationId = `conv-relay-${randomUUID().slice(0, 8)}`;
    const providerTs = new Date().toISOString();
    const providerSid = `SM${randomUUID().slice(0, 12)}`;

    // The relay INBOUND path appends the source message with an EMPTY
    // delivery_recipients map so the fan-out's child-only setRecipientDelivery
    // has a parent to write into.
    const appended = await messages.append({
      conversationId,
      providerSid,
      providerTs,
      type: 'sms',
      direction: 'inbound',
      author: 'unknown',
      deliveryStatus: 'delivered',
      relaySenderKey: 'c-alice',
      deliveryRecipients: {},
      body: 'is the unit still available?',
    });
    expect(appended.deduped).toBe(false);
    expect(appended.tsMsgId).toBe(buildTsMsgId(providerTs, providerSid));

    // The fan-out's per-recipient write. On the OLD
    // `SET delivery_recipients = if_not_exists(...), delivery_recipients.#mk = :d`
    // this raised the overlap ValidationException. Child-only must succeed.
    const queued: RelayRecipientDelivery = { status: 'sent', sid: 'SMout-bob', sentAt: providerTs };
    await messages.setRecipientDelivery(conversationId, appended.tsMsgId, 'c-bob', queued);
    // A phone#-keyed member exercises the aliased dotted-path name.
    await messages.setRecipientDelivery(conversationId, appended.tsMsgId, 'phone#+15550100009', {
      status: 'sent',
    });

    // Forward-only callback transition on ONE slot (single SET path + a
    // ConditionExpression on a SUB-path of it — allowed, not an overlap).
    const advanced = await messages.updateRecipientDeliveryStatus(
      conversationId,
      appended.tsMsgId,
      'c-bob',
      'delivered',
    );
    expect(advanced).toBe(true);

    // A regressing transition (delivered → sent) is refused (no-op false).
    const regressed = await messages.updateRecipientDeliveryStatus(
      conversationId,
      appended.tsMsgId,
      'c-bob',
      'sent',
    );
    expect(regressed).toBe(false);

    const stored = await messages.listByConversation(conversationId, { limit: 5 });
    const source = stored.find((m) => m.tsMsgId === appended.tsMsgId);
    expect(source?.delivery_recipients?.['c-bob']?.status).toBe('delivered');
    expect(source?.delivery_recipients?.['c-bob']?.deliveredAt).toBeDefined();
    expect(source?.delivery_recipients?.['phone#+15550100009']?.status).toBe('sent');
  });

  it('relay team-send shape: seed per-member queued map at append → setRecipientDelivery overwrites a slot — no ValidationException', async () => {
    const conversationId = `conv-relay-${randomUUID().slice(0, 8)}`;
    const providerTs = new Date().toISOString();
    const providerSid = `team-${randomUUID()}`;

    // The team-send path seeds per-member 'queued' slots on the source message
    // at append time (a real, non-empty map).
    const appended = await messages.append({
      conversationId,
      providerSid,
      providerTs,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'queued',
      relaySenderKey: 'team',
      deliveryRecipients: { 'c-alice': { status: 'queued' }, 'c-bob': { status: 'queued' } },
      body: 'Showing is at 4pm',
    });

    // The fan-out overwrites a seeded slot with the send result (child-only SET).
    await messages.setRecipientDelivery(conversationId, appended.tsMsgId, 'c-alice', {
      status: 'sent',
      sid: 'SMout-alice',
      sentAt: providerTs,
    });

    const stored = await messages.listByConversation(conversationId, { limit: 5 });
    const source = stored.find((m) => m.tsMsgId === appended.tsMsgId);
    expect(source?.delivery_recipients?.['c-alice']?.status).toBe('sent');
    expect(source?.delivery_recipients?.['c-bob']?.status).toBe('queued'); // untouched seed
  });
});
